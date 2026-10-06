/**
 * "Why not <city>?": ranks the city against the plan's stops with Qloo `rank`, finds where the fans
 * cluster there, and answers with templated text that cites those calls. No model call is made.
 */
import { EvidenceLedger } from "../evidence.ts";
import { areaName, geocodeCity } from "../geo.ts";
import { QlooError, rankOptions, signalHeatmap, wherePopular } from "../qloo.ts";
import { possessive } from "../text.ts";
import type { FollowUp, TourPlan } from "./types.ts";

export const MAX_FOLLOW_UPS = 5;
const clean = (s: string) => s.replace(/\s*\(sample\)$/, "");
const score = (n?: number) => (n === undefined ? "n/a" : String(Math.round(n * 100)));
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
  const stopCities = plan.stops.map((s) => clean(s.city.name));
  const options = [city, ...stopCities.filter((c) => !sameCity(c, city))];

  const ranked = await rankOptions({ options, optionType: "locality", signals: plan.signals });
  const rankSource = ledger.record(`${city} ranked against your stops for ${who}`, ranked.call);
  const position = ranked.entities.findIndex((e) => sameCity(e.name, city));
  const mine = position >= 0 ? ranked.entities[position] : undefined;

  const heat = await (plan.signals.length === 1 ? wherePopular(plan.signals[0], city, 10) : signalHeatmap({ location: city, entityIds: plan.signals }))
    .catch(() => undefined);
  let cluster: FollowUp["cluster"];
  if (heat) {
    const source = ledger.record(`Where ${who} concentrate in ${city}`, heat.call);
    const top = heat.cells.slice().sort((a, b) => b.affinity - a.affinity)[0];
    if (top) cluster = { name: await areaName(top.lat, top.lng), affinity: top.affinity, evidence: source.id };
  }

  const ahead = ranked.entities.slice(0, Math.max(0, position)).map((e) => `${clean(e.name)} (${score(e.affinity)})`);
  const weakest = ranked.entities.filter((e) => !sameCity(e.name, city)).at(-1);
  const clusterNote = cluster && !/^-?\d/.test(cluster.name) ? ` Fans there concentrate around ${cluster.name}.` : "";
  const text = !mine
    ? `Qloo could not score ${city} for ${who}; check the spelling or try a nearby larger city.`
    : `Qloo scores ${city} ${score(mine.affinity)} out of 100 for ${who}, #${position + 1} of ${ranked.entities.length} next to your stops${ahead.length ? `, behind ${ahead.join(", ")}` : ""}.${clusterNote} ${
      position < stopCities.length && weakest && !sameCity(weakest.name, city)
        ? `It would score above ${clean(weakest.name)} (${score(weakest.affinity)}) if you want to swap a stop.`
        : "Your current stops all score at least as high."
    }`;
  const point = mine && (mine.lat !== undefined && mine.lng !== undefined ? { lat: mine.lat, lng: mine.lng } : await geocodeCity(city));
  return {
    kind: "quick",
    question,
    city,
    pins: mine && point ? [{ name: city, lat: point.lat, lng: point.lng, affinity: mine.affinity ?? 0, evidence: rankSource.id }] : [],
    rank: mine ? position + 1 : undefined,
    of: ranked.entities.length,
    affinity: mine?.affinity,
    cluster,
    answer: { text, evidence: [rankSource.id, ...(cluster ? [cluster.evidence] : [])], kind: "template" },
    sources: ledger.sources,
    askedAt: new Date().toISOString(),
  };
}
