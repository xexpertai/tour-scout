/**
 * "Why not <city>?": scores the city by room affinity (the same measure as the plan's stops, so
 * the numbers compare directly), finds where the fans cluster there, and answers with templated
 * text that cites those calls. No model call is made.
 */
import { EvidenceLedger } from "../evidence.ts";
import { areaName } from "../geo.ts";
import { QlooError, fanHeatmap } from "../qloo.ts";
import { possessive } from "../text.ts";
import { placeFor, scoreCity } from "./cities.ts";
import { makeStepper, venueTagFor } from "./pipeline.ts";
import type { FollowUp, TourPlan } from "./types.ts";

export const MAX_FOLLOW_UPS = 5;
const clean = (s: string) => s.replace(/\s*\(sample\)$/, "");
// One decimal, as the UI shows city scores (88.4 vs 88.8 would otherwise both read "88").
const score = (n?: number) => (n === undefined ? "n/a" : (Math.round(n * 1000) / 10).toFixed(1));
const sameCity = (a: string, b: string) => clean(a).toLowerCase() === clean(b).toLowerCase();

/** Pulls the city out of phrasings like "why not Chicago?" or "what about Austin". */
export function cityFromQuestion(question: string): string {
  return question
    .replace(/[?!.]+$/g, "")
    .replace(/^\s*(why\s+not|what\s+about|how\s+about|add|swap\s+in|compare|and)\s+/i, "")
    .trim()
    .slice(0, 80);
}

export async function askCity(plan: TourPlan, question: string): Promise<FollowUp> {
  const city = cityFromQuestion(question);
  if (!city) throw new QlooError("Name a city to compare, e.g. “Why not Chicago?”", "FOLLOWUP_NO_CITY");
  if ((plan.followUps?.length ?? 0) >= MAX_FOLLOW_UPS) throw new QlooError(`This plan already has ${MAX_FOLLOW_UPS} follow-ups.`, "FOLLOWUP_LIMIT");
  const usedIds = [...plan.sources, ...(plan.followUps ?? []).flatMap((f) => f.sources)].map((s) => Number(s.id.slice(1)));
  const ledger = new EvidenceLedger(Math.max(0, ...usedIds));
  const who = plan.artist.proxyOf?.length ? `fans of ${plan.artist.proxyOf.map(clean).join(", ")}` : `${possessive(plan.artist.name)} fans`;
  const step = makeStepper(ledger, { push() {} });
  const place = await placeFor(city);
  const venueTag = await venueTagFor(plan.artist.type, step);
  const mine = await scoreCity(place, { signals: plan.signals, who, venueTag, comedy: plan.artist.type === "person" }, step);

  const heat = await step(() => "", () => fanHeatmap(plan.signals, place.query, 10), `Where ${who} concentrate in ${place.name}`);
  let cluster: FollowUp["cluster"];
  const top = heat?.cells.slice().sort((a, b) => b.affinity - a.affinity)[0];
  if (heat && top) cluster = { name: await areaName(top.lat, top.lng), affinity: top.affinity, evidence: heat.source.id };

  const others = plan.stops.map((s) => s.city).filter((c) => !sameCity(c.name, place.name));
  const ranked = [...(mine ? [mine] : []), ...others].sort((a, b) => b.affinity - a.affinity);
  const position = mine ? ranked.indexOf(mine) : -1;
  const ahead = ranked.slice(0, Math.max(0, position)).map((e) => `${clean(e.name)} (${score(e.affinity)})`);
  const weakest = others.slice().sort((a, b) => a.affinity - b.affinity)[0];
  const clusterNote = cluster && !/^-?\d/.test(cluster.name) && !sameCity(cluster.name, place.name) ? ` Fans there concentrate around ${cluster.name}.` : "";
  const text = !mine
    ? `Qloo found no ${plan.artist.type === "person" ? "comedy rooms" : "live-music rooms"} in ${place.name} with affinity for ${who}, so it can't be scored; check the spelling or try a nearby larger city.`
    : `${place.name} scores ${score(mine.affinity)} out of 100 on room affinity for ${who} (its best match: ${clean(mine.rooms?.[0]?.name ?? "n/a")}), #${position + 1} of ${ranked.length} next to your stops${ahead.length ? `, behind ${ahead.join(", ")}` : ""}.${clusterNote} ${
      weakest && mine.affinity > weakest.affinity
        ? `It would score above ${clean(weakest.name)} (${score(weakest.affinity)}) if you want to swap a stop.`
        : "Your current stops all score at least as high."
    }`;
  const evidence = [...(mine ? [mine.evidence] : []), ...(cluster ? [cluster.evidence] : [])];
  return {
    kind: "quick",
    question,
    city: place.name,
    pins: mine && mine.lat !== undefined && mine.lng !== undefined ? [{ name: place.name, lat: mine.lat, lng: mine.lng, affinity: mine.affinity, evidence: mine.evidence }] : [],
    rank: mine ? position + 1 : undefined,
    of: ranked.length,
    affinity: mine?.affinity,
    cluster,
    answer: { text, evidence, kind: "template" },
    sources: ledger.sources,
    askedAt: new Date().toISOString(),
  };
}
