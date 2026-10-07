/**
 * Applies a scout proposal to a stored plan, producing a new plan (the original stays shareable).
 * Added cities get the same per-stop scouting as a full run; the route is re-optimised; new stops
 * get templated text. Model-written text of unchanged stops is kept as it was.
 */
import { randomUUID } from "node:crypto";
import { EvidenceLedger } from "../evidence.ts";
import { insightGuard, type Insight } from "../guard.ts";
import { scriptedProvider } from "../llm.ts";
import { QlooError } from "../qloo.ts";
import { clean, possessive } from "../text.ts";
import { distanceKm } from "../markets.ts";
import { SMALL_ROOM_POPULARITY, makeStepper, scoutStop, venueTagFor, type StepSink } from "./pipeline.ts";
import { rankIn, routeOrder, synthesisInput } from "./plan.ts";
import type { StopData, TourInput, TourPlan, TourStop } from "./types.ts";

const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function applyProposal(plan: TourPlan, followUpIndex: number, out: StepSink): Promise<TourPlan> {
  const followUp = plan.followUps?.[followUpIndex];
  const diff = followUp?.proposal;
  if (!followUp || !diff) throw new QlooError("There is no change to apply.", "APPLY_NOTHING");
  if (followUp.appliedAs) throw new QlooError("This change was already applied.", "APPLY_DONE");

  const usedIds = [...plan.sources, ...(plan.followUps ?? []).flatMap((f) => f.sources)].map((s) => Number(s.id.slice(1)));
  const ledger = new EvidenceLedger(Math.max(0, ...usedIds));
  const step = makeStepper(ledger, out);
  const who = plan.artist.proxyOf?.length ? `artists like ${plan.artist.proxyOf.map(clean).join(", ")}` : plan.artist.name;
  const ctx = { signals: plan.signals, who, artistType: plan.artist.type, isArtistMode: !plan.artist.proxyOf?.length, venueTag: diff.add.length ? await venueTagFor(plan.artist.type, step) : undefined,
    // The same size rule as a full run (pipeline.ts): an emerging act's support slot is capped at
    // SMALL_ROOM_POPULARITY; an established act's opener at its own popularity.
    popularity: plan.artist.proxyOf?.length ? SMALL_ROOM_POPULARITY : plan.artist.popularity, usedOpeners: new Set(plan.stops.map((s) => s.opener?.entityId).filter((x): x is string => Boolean(x))),
    names: plan.artist.proxyOf?.length ? plan.artist.proxyOf : [plan.artist.name] };

  const kept: TourStop[] = plan.stops.filter((s) => !diff.remove.includes(s.stopId));
  const nextIndex = Math.max(0, ...plan.stops.map((s) => Number(s.stopId.slice(1))));
  const added: StopData[] = await Promise.all(diff.add.map((city, i) => scoutStop(city, nextIndex + i, ctx, step)));
  // A stop whose opener changes keeps no model text that names the old opener.
  let rewritten: StopData | undefined;
  if (diff.opener) {
    const target = kept.find((s) => s.stopId === diff.opener!.stopId);
    if (target) {
      rewritten = { ...target, opener: diff.opener.opener };
      kept.splice(kept.indexOf(target), 1, rewritten as TourStop);
    }
  }

  // Templated text (no model call, labelled as template) for new stops and the stop with a new opener.
  const validIds = new Set([...plan.sources, ...(plan.followUps ?? []).flatMap((f) => f.sources), ...ledger.sources].map((s) => s.id));
  const { guard } = insightGuard(validIds, true, { capacity: plan.inputs.capacity });
  const needText = [...added, ...(rewritten ? [rewritten] : [])];
  // Ranks are among every scored city, including the added ones (the badges use the same list).
  const allCities = [...(plan.candidates ?? plan.stops.map((s) => s.city)), ...added.map((s) => s.city)]
    .filter((c, i, xs) => xs.findIndex((x) => clean(x.name) === clean(c.name)) === i);
  const fakePhaseA = { fan: plan.fan, cities: allCities, stops: needText, ledger };
  // The template keeps the plan's mode: an emerging act's added stop is a support-slot request too.
  const input = (plan.artist.proxyOf?.length
    ? { artist: null, emerging: { name: plan.artist.name, proxies: plan.artist.proxyOf.map((name) => ({ name })) } }
    : { artist: { name: plan.artist.name } }) as unknown as TourInput;
  const text = await scriptedProvider.synthesize(synthesisInput({ ...input, stops: needText.length, capacity: plan.inputs.capacity }, fakePhaseA, plan.artist.arenaScale));
  const textFor = (id: string) => text.stops?.find((x) => x.stop_id === id);
  if (rewritten) {
    const t = textFor(rewritten.stopId);
    kept.splice(kept.findIndex((s) => s.stopId === rewritten!.stopId), 1, { ...(rewritten as TourStop), why: guard("why", t?.why), pitch: guard("pitch", t?.pitch) });
  }
  const newStops: TourStop[] = added.map((s) => {
    const t = textFor(s.stopId);
    return { ...s, order: 0, why: guard("why", t?.why), pitch: guard("pitch", t?.pitch) };
  });

  const gone = [...plan.stops.filter((x) => diff.remove.includes(x.stopId)).map((x) => clean(x.city.name)),
    ...(diff.opener ? [plan.stops.find((x) => x.stopId === diff.opener!.stopId)?.opener?.name].filter((n): n is string => Boolean(n)).map(clean) : [])];
  const stale = (text: string) => gone.some((n) => text.toLowerCase().includes(n.toLowerCase()));
  // Kept text that states a city's rank is updated to its rank in the new list (no stale "#3" beside a "#4" badge).
  const reRank = (i: Insight | undefined, city: string): Insight | undefined => {
    if (!i) return i;
    const { rank } = rankIn({ cities: allCities, stops: [] }, city);
    if (!rank) return i;
    let text = i.text.replace(new RegExp(`(${escape(clean(city))} ranks )#\\d+`, "g"), `$1#${rank}`);
    if (rank > 3) {
      const c = escape(clean(city));
      text = text.replace(new RegExp(`ranks ${c} among the strongest cities for`, "g"), `shows a strong fit in ${clean(city)} for`)
        .replace(new RegExp(`${c} ranks among the strongest cities for this audience`, "g"), `${clean(city)} is a strong fit for this audience`);
    }
    return text === i.text ? i : { ...i, text };
  };
  const reRanked = kept.map((s) => (s === rewritten ? s : { ...s, why: reRank(s.why, s.city.name), pitch: reRank(s.pitch, s.city.name) }));
  const ordered = routeOrder([...reRanked, ...newStops].sort((a, b) => b.city.affinity - a.city.affinity)) as TourStop[];
  const legKm = ordered.slice(1).map((s, i) => (s.city.lat !== undefined && ordered[i].city.lat !== undefined
    ? distanceKm({ lat: ordered[i].city.lat!, lng: ordered[i].city.lng! }, { lat: s.city.lat, lng: s.city.lng! }) : 0));
  const id = randomUUID();
  return {
    ...plan,
    id,
    parentId: plan.id,
    createdAt: new Date().toISOString(),
    stops: ordered.map((s, i) => ({ ...s, order: i + 1, rank: i + 1 })),
    // Added cities join the ranked list, so every stop still shows its rank among scored cities.
    candidates: plan.candidates && [...plan.candidates, ...added.map((s) => ({ ...s.city, rooms: undefined })).filter((c) => !plan.candidates!.some((x) => x.name === c.name))],
    inputs: { ...plan.inputs, stops: ordered.length },
    // The coverage note's "longest drive" describes the new route.
    coverage: plan.coverage && {
      ...plan.coverage,
      regional: plan.coverage.regional && { ...plan.coverage.regional, stops: ordered.length, asked: Math.max(plan.coverage.regional.asked, ordered.length), longestLegKm: Math.max(0, ...legKm) },
    },
    sources: [...plan.sources, ...(plan.followUps ?? []).flatMap((f) => f.sources), ...ledger.sources],
    followUps: (plan.followUps ?? []).map((f, i) => (i === followUpIndex ? { ...f, appliedAs: id } : f)),
    // Text that names a removed stop or the replaced act is stale: the summary is templated, and idea
    // lines that name them are dropped. An opener-only change keeps a summary that does not name them.
    summary: plan.summary && !stale(plan.summary.text) ? plan.summary : {
      text: `Route updated by the scout (${diff.summary}). Stops in order: ${ordered.map((s) => `${clean(s.city.name)} (${(Math.round(s.city.affinity * 1000) / 10).toFixed(1)})`).join(", ")}.`,
      evidence: [...new Set(ordered.map((s) => s.city.evidence))],
      kind: "template",
    },
    theme: plan.theme?.filter((i) => !stale(i.text)),
    merch: plan.merch?.filter((i) => !stale(i.text)),
    risks: plan.risks?.filter((i) => !stale(i.text)),
  };
}

/** One-line label for the stream while applying. */
export const applyingLabel = (plan: TourPlan, summary: string) => `Rebuilding ${possessive(plan.artist.name)} route: ${summary}`;
