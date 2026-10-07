/**
 * A full Tour Scout run: Phase A (deterministic Qloo calls, streamed), then Phase B (one synthesis
 * call), then assembly. Qloo values in the plan come from Phase A only; model text is guarded.
 */
import { venueTown } from "../text.ts";
import { randomUUID } from "node:crypto";
import { Channel } from "../evidence.ts";
import { insightGuard } from "../guard.ts";
import { MARKETS } from "../markets.ts";
import { LlmError, llmStatus, scriptedProvider, synthesisProvider, type RawSynthesis, type SynthesisInput, type SynthesisProvider } from "../llm.ts";
import { QlooError, qlooMode } from "../qloo.ts";
import { ARENA_POPULARITY, runPhaseA, signalsOf, type PhaseAResult } from "./pipeline.ts";
import type { StopData, TourEvent, TourInput, TourPlan, TourStop } from "./types.ts";

const clean = (s: string) => s.replace(/\s*\(sample\)$/, "");
/**
 * Touring-city names that are not stops of this run, so stop text naming one is withheld. Names that
 * occur inside Qloo data (a venue, opener, neighbourhood or brand such as "Jackson …") are skipped.
 */
const offRouteOf = (a: PhaseAResult) => {
  const stops = a.stops.map((s) => clean(s.city.name).toLowerCase());
  const data = [
    ...a.stops.flatMap((s) => [s.cluster?.name, s.opener?.name, ...s.venues.map((v) => `${v.name} ${v.address ?? ""}`)]),
    ...a.fan.alsoLikes.flatMap((x) => x.items.map((i) => i.name)), ...a.fan.tags.map((t) => t.name),
  ].filter(Boolean).join(" | ").toLowerCase();
  // "Portland, OR" vs "Portland, ME": compare on the part before the comma.
  const base = (n: string) => n.toLowerCase().split(",")[0];
  return MARKETS.map((m) => m.name).filter((n) => !stops.some((s) => base(s) === base(n)) && !data.includes(base(n)));
};
const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v.toFixed(2)}`).join(", ");

type Point = { x: number; y: number };
/** Equirectangular projection around the stops' mean latitude: fine for comparing route lengths. */
function project(stops: StopData[]): Point[] {
  const meanLat = stops.reduce((sum, s) => sum + s.city.lat!, 0) / stops.length;
  const k = Math.cos((meanLat * Math.PI) / 180);
  return stops.map((s) => ({ x: s.city.lng! * k, y: s.city.lat! }));
}
const pathLength = (pts: Point[], order: number[]) =>
  order.slice(1).reduce((sum, idx, i) => sum + Math.hypot(pts[idx].x - pts[order[i]].x, pts[idx].y - pts[order[i]].y), 0);

function* permutations(items: number[]): Generator<number[]> {
  if (items.length <= 1) { yield items; return; }
  for (let i = 0; i < items.length; i++) {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i], ...rest];
  }
}

/** Improves an open path by reversing segments while that shortens it (removes crossings). */
function twoOpt(pts: Point[], order: number[]): number[] {
  let best = order, improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        if (pathLength(pts, candidate) + 1e-9 < pathLength(pts, best)) { best = candidate; improved = true; }
      }
    }
  }
  return best;
}

/**
 * Orders stops as one sweep across the map: the shortest open path through them (exact for up to
 * 8 stops, 2-opt beyond), which never crosses itself and so starts and ends at the extremes. The
 * path starts at whichever end has the stronger fan affinity.
 */
export function routeOrder(stops: StopData[], start?: { lat: number; lng: number }): StopData[] {
  const located = stops.filter((s) => s.city.lat !== undefined && s.city.lng !== undefined);
  if (located.length < 3) return stops;
  const pts = project(located);
  const indices = located.map((_, i) => i);
  let best = indices;
  if (located.length <= 8) {
    let bestLength = Infinity;
    for (const order of permutations(indices)) {
      if (order[0] > order[order.length - 1]) continue; // each path and its reverse are the same route
      const length = pathLength(pts, order);
      if (length < bestLength) { bestLength = length; best = order; }
    }
  } else {
    best = twoOpt(pts, indices);
  }
  // Start nearest the home base when given, else at the stronger end.
  const d = (s: StopData) => (start ? Math.hypot(s.city.lat! - start.lat, s.city.lng! - start.lng) : 0);
  if (start ? d(located[best[best.length - 1]]) < d(located[best[0]]) : located[best[best.length - 1]].city.affinity > located[best[0]].city.affinity) best = [...best].reverse();
  return [...best.map((i) => located[i]), ...stops.filter((s) => !located.includes(s))];
}

export function synthesisInput(input: TourInput, a: PhaseAResult, arenaScale: boolean): SynthesisInput {
  const tagsEvidence = a.fan.tags[0]?.evidence;
  return {
    artist: { name: input.artist?.name ?? input.emerging!.name, arenaScale, proxyOf: input.emerging?.proxies.map((p) => p.name) },
    capacity: input.capacity,
    fan: {
      tags: a.fan.tags.map((t) => t.name),
      tagsEvidence,
      demographics: a.fan.demographics ? `relative affinity (not shares) by age: ${fmt(a.fan.demographics.age)}; gender: ${fmt(a.fan.demographics.gender)}` : undefined,
      demographicsEvidence: a.fan.demographics?.evidence,
      alsoLikes: a.fan.alsoLikes.map((x) => ({ domain: x.domain, items: x.items.map((i) => i.name), evidence: x.evidence })),
    },
    stops: a.stops.map((s) => ({
      stop_id: s.stopId, city: s.city.name, affinity: Math.round(s.city.affinity * 1000) / 10, evidence: s.city.evidence,
      fanHotspot: s.city.hotspot ? true : undefined, hotspotEvidence: s.city.hotspot?.evidence,
      cluster: s.cluster && !/^-?\d/.test(s.cluster.name) ? s.cluster.name : undefined, clusterEvidence: s.cluster?.evidence,
      venues: s.venues.map((v) => v.name), venuesEvidence: s.venues[0]?.evidence,
      pitchTo: s.venues[0] ? { venue: s.venues[0].name, town: venueTown(s.venues[0]) } : undefined,
      ...rankIn(a, s.city.name),
      opener: s.opener?.name, openerEvidence: s.opener?.evidence,
      shared: s.opener?.overlap?.shared, sharedEvidence: s.opener?.overlap?.evidence,
    })),
  };
}

/**
 * @param templateSummary code-written summary used when the model's summary is withheld by the guard,
 *   so the plan never opens without one (it is labelled TEMPLATE, never AI).
 */
/** A city's rank among every scored city of the run (1 = best). */
export function rankIn(a: { cities?: { name: string; affinity: number }[]; stops: { city: { name: string; affinity: number } }[] }, city: string): { rank?: number; of?: number } {
  const pool = a.cities?.length ? a.cities : a.stops.map((s) => s.city);
  const sorted = [...pool].sort((x, y) => y.affinity - x.affinity);
  const i = sorted.findIndex((c) => clean(c.name) === clean(city));
  return i >= 0 ? { rank: i + 1, of: sorted.length } : {};
}

/** What the guard needs to know about this plan (see guard.ts planClaims). */
export const guardOptsOf = (input: TourInput, a: Pick<PhaseAResult, "stops" | "cities"> & { coverage?: PhaseAResult["coverage"] }) => ({
  capacity: input.capacity, offRoute: offRouteOf(a as PhaseAResult),
  actName: input.artist?.name ?? input.emerging?.name, emerging: !input.artist,
  hotspotCities: a.stops.filter((s) => s.city.hotspot).map((s) => clean(s.city.name)),
  cityRanks: Object.fromEntries(a.stops.map((s) => [clean(s.city.name), rankIn(a as never, s.city.name).rank ?? 0])),
});

export function assemblePlan(input: TourInput, a: PhaseAResult, raw: RawSynthesis, meta: { qloo: "live" | "mock"; llm: string; arenaScale: boolean; phaseAMs: number; synthesisMs: number; totalMs: number }, template?: RawSynthesis): TourPlan {
  const templateSummary = template?.summary;
  // A withheld model pitch falls back to the code-written one (labelled TEMPLATE), so every stop keeps a sendable email.
  const tGuard = insightGuard(a.ledger.ids(), true, guardOptsOf(input, a)).guard;
  const templateText = (id: string, field: "why" | "pitch", label: string) => tGuard(label, template?.stops?.find((s) => String(s?.stop_id) === id)?.[field]);
  const templatePitch = (id: string, label: string) => templateText(id, "pitch", label);
  const { guard, list, withheld } = insightGuard(a.ledger.ids(), meta.llm.startsWith("scripted"), guardOptsOf(input, a));
  const text = new Map((raw.stops ?? []).map((s) => [String(s?.stop_id), s]));
  const stops: TourStop[] = routeOrder(a.stops, a.coverage?.regional?.start).map((s, i) => ({
    ...s,
    order: i + 1,
    why: guard(`${clean(s.city.name)} why`, text.get(s.stopId)?.why) ?? templateText(s.stopId, "why", `${clean(s.city.name)} why`),
    pitch: guard(`${clean(s.city.name)} pitch`, text.get(s.stopId)?.pitch) ?? templatePitch(s.stopId, `${clean(s.city.name)} pitch`),
  }));
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    mode: { qloo: meta.qloo, llm: meta.llm },
    artist: {
      name: input.artist?.name ?? input.emerging!.name,
      entityId: input.artist?.id,
      type: input.artist?.type ?? input.emerging?.proxies[0]?.type ?? "artist",
      popularity: input.artist?.popularity,
      arenaScale: meta.arenaScale,
      proxyOf: input.emerging?.proxies.map((p) => p.name),
      proxyPopularity: input.emerging ? Math.max(0, ...input.emerging.proxies.map((p) => p.popularity ?? 0)) || undefined : undefined,
    },
    signals: signalsOf(input),
    inputs: { region: input.region, candidateCities: input.candidateCities, stops: input.stops, capacity: input.capacity },
    fan: a.fan,
    stops,
    candidates: a.cities,
    coverage: a.coverage,
    summary: guard("summary", raw.summary) ?? insightGuard(a.ledger.ids(), true, guardOptsOf(input, a)).guard("summary", templateSummary),
    theme: list("theme", raw.theme, 4),
    merch: list("merch", raw.merch, 4),
    risks: list("risks", raw.risks, 4),
    sources: a.ledger.sources,
    withheld,
    timings: { phaseAMs: meta.phaseAMs, synthesisMs: meta.synthesisMs, totalMs: meta.totalMs },
  };
}

function errorEvent(e: unknown): TourEvent {
  if (e instanceof QlooError) return { type: "error", message: e.recovery ? `${e.message}. ${e.recovery}` : e.message, code: e.code, retryable: e.retryable };
  return { type: "error", message: e instanceof Error ? e.message : String(e), code: "INTERNAL", retryable: true };
}

export async function* planTour(input: TourInput, signal?: AbortSignal, provider: SynthesisProvider = synthesisProvider()): AsyncGenerator<TourEvent> {
  const started = Date.now();
  const mode = await qlooMode();
  // When no model call can be made (no key, budget or daily cap used up), every label says template.
  const status = provider.name === "scripted" ? undefined : llmStatus();
  const llmName = status && !status.available ? `scripted (fallback from ${provider.name})` : provider.name;
  yield { type: "mode", qloo: mode.mock ? "mock" : "live", llm: llmName, reason: mode.reason };

  const events = new Channel<TourEvent>();
  const phaseA = runPhaseA(input, events, signal).finally(() => events.close());
  phaseA.catch(() => undefined); // surfaced below, after the streamed events
  for await (const event of events) {
    if (signal?.aborted) return;
    yield event;
  }
  let a: PhaseAResult;
  try {
    a = await phaseA;
  } catch (e) {
    yield errorEvent(e);
    return;
  }
  const phaseAMs = Date.now() - started;
  const arenaScale = (input.artist?.popularity ?? 0) >= ARENA_POPULARITY;

  const synthStarted = Date.now();
  const sInput = synthesisInput(input, a, arenaScale);
  yield { type: "writing", llm: llmName };

  // Stream finished pieces of the model's text: an entry is complete once the next one has started.
  const textEvents = new Channel<TourEvent>();
  const { guard } = insightGuard(a.ledger.ids(), provider.name === "scripted", guardOptsOf(input, a));
  const sent = new Set<string>();
  const onPartial = (snap: RawSynthesis) => {
    const real = (i?: { text?: unknown }) => typeof i?.text === "string" && i.text.trim().length >= 25;
    if (!sent.has("summary") && real(snap.summary) && snap.stops) {
      sent.add("summary");
      const summary = guard("summary", snap.summary);
      if (summary) textEvents.push({ type: "summary", summary });
    }
    const stops = Array.isArray(snap.stops) ? snap.stops : [];
    const complete = snap.theme ? stops.length : stops.length - 1;
    for (const entry of stops.slice(0, Math.max(0, complete))) {
      const id = String(entry?.stop_id);
      if (sent.has(id) || !a.stops.some((s) => s.stopId === id) || !real(entry?.why) || !real(entry?.pitch)) continue;
      sent.add(id);
      const city = clean(a.stops.find((s) => s.stopId === id)!.city.name);
      textEvents.push({ type: "stop_text", stopId: id, why: guard(`${city} why`, entry.why), pitch: guard(`${city} pitch`, entry.pitch) });
    }
  };

  let raw: RawSynthesis | undefined;
  let llm: string = provider.name;
  const synthesis = provider.synthesize(sInput, onPartial)
    .then((r) => { raw = r; })
    .catch(async (e) => {
      // The Qloo data is still valid: fall back to templated text and say so.
      textEvents.push({ type: "llm_fallback", from: provider.name, reason: e instanceof LlmError ? e.message : "The AI model failed" });
      raw = await scriptedProvider.synthesize(sInput);
      llm = `scripted (fallback from ${provider.name})`;
    })
    .finally(() => textEvents.close());
  for await (const event of textEvents) {
    if (signal?.aborted) return;
    yield event;
  }
  await synthesis;
  const synthesisMs = Date.now() - synthStarted;
  yield {
    type: "plan",
    plan: assemblePlan(input, a, raw!, { qloo: mode.mock ? "mock" : "live", llm, arenaScale, phaseAMs, synthesisMs, totalMs: Date.now() - started },
      await scriptedProvider.synthesize(sInput)),
  };
}
