/**
 * Applies a scout proposal to a stored plan, producing a new plan (the original stays shareable).
 * Added cities get the same per-stop scouting as a full run; the route is re-optimised; new stops
 * get templated text. Model-written text of unchanged stops is kept as it was.
 */
import { randomUUID } from "node:crypto";
import { EvidenceLedger } from "../evidence.ts";
import { insightGuard } from "../guard.ts";
import { scriptedProvider } from "../llm.ts";
import { QlooError } from "../qloo.ts";
import { clean, possessive } from "../text.ts";
import { makeStepper, scoutStop, venueTagFor, type StepSink } from "./pipeline.ts";
import { routeOrder, synthesisInput } from "./plan.ts";
import type { StopData, TourPlan, TourStop } from "./types.ts";

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
    popularity: plan.artist.proxyOf?.length ? undefined : plan.artist.popularity, usedOpeners: new Set(plan.stops.map((s) => s.opener?.entityId).filter((x): x is string => Boolean(x))),
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
  const fakePhaseA = { fan: plan.fan, cities: [], stops: needText, ledger };
  const text = await scriptedProvider.synthesize(synthesisInput({ artist: null, emerging: { name: plan.artist.name, proxies: [] }, stops: needText.length, capacity: plan.inputs.capacity }, fakePhaseA, plan.artist.arenaScale));
  const textFor = (id: string) => text.stops?.find((x) => x.stop_id === id);
  if (rewritten) {
    const t = textFor(rewritten.stopId);
    kept.splice(kept.findIndex((s) => s.stopId === rewritten!.stopId), 1, { ...(rewritten as TourStop), why: guard("why", t?.why), pitch: guard("pitch", t?.pitch) });
  }
  const newStops: TourStop[] = added.map((s) => {
    const t = textFor(s.stopId);
    return { ...s, order: 0, why: guard("why", t?.why), pitch: guard("pitch", t?.pitch) };
  });

  const ordered = routeOrder([...kept, ...newStops].sort((a, b) => b.city.affinity - a.city.affinity)) as TourStop[];
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
    sources: [...plan.sources, ...(plan.followUps ?? []).flatMap((f) => f.sources), ...ledger.sources],
    followUps: (plan.followUps ?? []).map((f, i) => (i === followUpIndex ? { ...f, appliedAs: id } : f)),
    // The earlier summary may name stops that are gone, so the derived plan gets a templated one.
    summary: {
      text: `Route updated by the scout (${diff.summary}). Stops in order: ${ordered.map((s) => `${clean(s.city.name)} (${(Math.round(s.city.affinity * 1000) / 10).toFixed(1)})`).join(", ")}.`,
      evidence: [...new Set(ordered.map((s) => s.city.evidence))],
      kind: "template",
    },
  };
}

/** One-line label for the stream while applying. */
export const applyingLabel = (plan: TourPlan, summary: string) => `Rebuilding ${possessive(plan.artist.name)} route: ${summary}`;
