import { clientKey, limitedResponse, runCache, take, takeDailyRun } from "@/lib/limits";
import { NDJSON_HEADERS, ndjsonStream } from "@/lib/ndjson";
import { loadPlan, savePlan } from "@/lib/store";
import { planTour } from "@/lib/tour/plan";
import type { ArtistRef, TourEvent, TourInput, TourPlan } from "@/lib/tour/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max).trim() : "");
function artistRef(v: unknown): ArtistRef | null {
  const o = (v ?? {}) as Record<string, unknown>;
  const id = str(o.id, 100), name = str(o.name, 120);
  if (!id || !name) return null;
  return { id, name, type: o.type === "person" ? "person" : "artist", popularity: typeof o.popularity === "number" ? o.popularity : undefined };
}

/** Validates the request into a TourInput; entity ids must come from a prior /api/tour/resolve. */
function parse(body: Record<string, unknown>): TourInput | string {
  const artist = artistRef(body.artist);
  const emergingRaw = (body.emerging ?? undefined) as { name?: unknown; proxies?: unknown[] } | undefined;
  const proxies = (Array.isArray(emergingRaw?.proxies) ? emergingRaw.proxies : []).map(artistRef).filter((p): p is ArtistRef => Boolean(p)).slice(0, 3);
  const emerging = emergingRaw && proxies.length ? { name: str(emergingRaw.name, 120) || "Your act", proxies } : undefined;
  if (!artist && !emerging) return "Confirm an artist, or pick 1–3 artists you sound like.";
  const candidateCities = (Array.isArray(body.candidateCities) ? body.candidateCities : []).map((c) => str(c, 80)).filter(Boolean).slice(0, 10);
  const stops = Math.min(6, Math.max(2, Number(body.stops) || 4));
  const cap = Array.isArray(body.capacity) ? body.capacity.map(Number) : [];
  return {
    artist,
    emerging,
    region: str(body.region, 80) || undefined,
    candidateCities: candidateCities.length ? candidateCities : undefined,
    stops: candidateCities.length ? Math.min(stops, candidateCities.length) : stops,
    capacity: cap.length === 2 && cap.every((n) => Number.isFinite(n) && n > 0) ? [Math.min(cap[0], cap[1]), Math.max(cap[0], cap[1])] : undefined,
  };
}

/** Same artist, signals, places and stops → same plan; used to reuse recent runs. */
const cacheKey = (i: TourInput) => JSON.stringify([
  i.artist?.id ?? null, i.emerging?.proxies.map((p) => p.id).sort() ?? null, i.emerging?.name ?? null,
  i.region?.toLowerCase() ?? null, i.candidateCities?.map((c) => c.toLowerCase()).sort() ?? null, i.stops, i.capacity ?? null,
]);

/** The events of a stored plan, so a reused run renders exactly like a live one. */
function* replayPlan(plan: TourPlan): Generator<TourEvent> {
  yield { type: "mode", qloo: plan.mode.qloo === "mock" ? "mock" : "live", llm: plan.mode.llm, reason: "reused" };
  yield { type: "reused", createdAt: plan.createdAt };
  yield { type: "cities", cities: plan.stops.map((s) => s.city) };
  for (const s of plan.stops) yield { type: "stop", stop: s };
  yield { type: "plan", plan };
}

const HEADERS = NDJSON_HEADERS;

/** Streams a Tour Scout run as NDJSON: one TourEvent per line. */
export async function POST(req: Request) {
  const input = parse(await req.json().catch(() => ({})));
  if (typeof input === "string") return Response.json({ error: input }, { status: 400 });

  // A recent identical run costs nothing and does not count against the limits.
  const key = cacheKey(input);
  const cachedId = runCache.get(key);
  const cached = cachedId ? await loadPlan(cachedId) : undefined;
  if (cached) return new Response(ndjsonStream(replayPlan(cached)), { headers: HEADERS });

  const perClient = take("tour", clientKey(req));
  if (!perClient.ok) return limitedResponse(perClient);
  const daily = takeDailyRun();
  if (!daily.ok) return limitedResponse(daily, "DAILY_CAP");

  // Only plans this server generated are stored for share links.
  const store = async (plan: TourPlan) => { await savePlan(plan); runCache.set(key, plan.id); };
  return new Response(ndjsonStream(planTour(input, req.signal), async (e) => { if (e.type === "plan") await store(e.plan); }), { headers: HEADERS });
}

