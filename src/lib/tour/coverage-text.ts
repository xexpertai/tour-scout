/**
 * The plain-language note on how a plan's cities were found. A pure function (no JSX) so tests can
 * check every preset's sentence for empty clauses, stray spaces and doubled punctuation.
 */
import { distanceKm } from "../markets.ts";
import { MAX_LEG_KM, ROAD_FACTOR, TIE, bestOrder, driveHours, legs, swapFits } from "./region.ts";
import type { City, Coverage } from "./types.ts";

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function coverageText(c: Coverage, region = "the region"): string {
  const parts: string[] = [];
  if (c.basis === "hotspots" && c.heatmap === "missing") {
    parts.push(`Qloo's fan map of ${region} didn't answer in time, so cities were found from the rooms this audience favours.`);
    parts.push("Each city is scored by its best-matching live room.");
  } else if (c.basis === "hotspots") {
    if (c.heatmap === "saved" && c.heatmapSavedAt) parts.push(`The live fan map timed out, so this uses Qloo's fan map saved on ${c.heatmapSavedAt.slice(0, 10)}.`);
    if (!c.hotspotCells) parts.push(`Qloo's fan map of ${region} returned no hotspots for this audience, so cities were found from the rooms it favours.`);
    else {
      parts.push(`Qloo's fan map of ${region} found ${s(c.hotspotCells, "hotspot", "hotspots")}${c.remoteCells > 0 ? ` (${c.remoteCells} far from any touring city)` : ""}.`);
      if (c.roomFallback) parts.push(c.hotspotMarkets
        ? `They pointed to only ${s(c.hotspotMarkets, "touring city", "touring cities")}, so cities whose rooms this audience favours were added.`
        : "None is near a touring city, so this is a rooms-led plan: the cities come from the live rooms this audience favours.");
    }
    parts.push("Each nearby city is scored by its best-matching live room.");
  } else {
    parts.push("Your cities, each scored by its best-matching live room.");
  }
  if (c.anchorsAbsent?.length) parts.push(`${list(c.anchorsAbsent)} ${c.anchorsAbsent.length === 1 ? "is" : "are"} not among these fans' hotspots, so this run is built on the secondary markets where they are; the route check still tests the big cities nearby by their rooms.`);
  const r = c.regional;
  if (r && r.stops > 1) {
    const where = r.start ? `from ${r.start.name}` : r.around ? `around ${r.around}` : "in one region";
    parts.push(`The route stays ${where}: the longest drive between stops is about ${Math.round((r.longestLegKm * ROAD_FACTOR) / 10) * 10} km (${Math.max(1, Math.round(driveHours(r.longestLegKm)))} h).`);
    if (r.stops < r.asked) parts.push(`Only ${r.stops} strong cities sit within a day's drive of each other there.`);
    if (r.elsewhere.length) parts.push(`Fans also concentrate around ${list(r.elsewhere)}: a second run.`);
  }
  if (c.droppedRooms) parts.push(`${s(c.droppedRooms, "unlikely room", "unlikely rooms")} (out of town or not a venue) ${c.droppedRooms === 1 ? "was" : "were"} left out.`);
  if (c.unscored.length) parts.push(`No matching rooms in ${c.unscored.join(", ")}.`);
  return parts.join(" ");
}

/**
 * Scored cities left off the route because they are too far from it: no stop is within a day's drive
 * (MAX_LEG_KM straight-line). Shown beside the ranking, so a strong city that is not on the route
 * says why ("Austin 93.0 · outside this run").
 */
export type OffRoute = { name: string; roadKm: number; nearest: string };
export function offRouteCities(cities: City[], isStop: (c: City) => boolean): OffRoute[] {
  const stops = cities.filter((c) => isStop(c) && c.lat !== undefined && c.lng !== undefined);
  if (!stops.length) return [];
  const out: OffRoute[] = [];
  for (const c of cities) {
    if (isStop(c) || c.lat === undefined || c.lng === undefined) continue;
    const near = stops.map((s) => ({ s, km: distanceKm({ lat: c.lat!, lng: c.lng! }, { lat: s.lat!, lng: s.lng! }) })).sort((a, b) => a.km - b.km)[0];
    if (near.km > MAX_LEG_KM) out.push({ name: c.name, roadKm: Math.round((near.km * ROAD_FACTOR) / 100) * 100, nearest: near.s.name });
  }
  return out;
}

/** "Austin is about 2,800 km by road from New York, too far to drive between shows on this run; plan it as a separate run." */
export function offRouteText(off: OffRoute[], clean: (s: string) => string = (s) => s): string {
  if (!off.length) return "";
  const each = off.map((o) => `${clean(o.name)} (about ${o.roadKm.toLocaleString("en-US")} km by road from ${clean(o.nearest)})`);
  return `${list(each)} ${off.length === 1 ? "scores well but is" : "score well but are"} too far from this route to drive between shows, so ${off.length === 1 ? "it is" : "they are"} left for a separate run.`;
}

/**
 * A city that scores above the route's weakest stop but is not on the route, and why, from the route
 * geometry (code-written): swapping it in would break the drivable run, or it is effectively tied.
 * Cities outside the run (offRouteCities) are explained there instead.
 */
export function skippedCityText(cities: City[], isStop: (c: City) => boolean, clean: (s: string) => string = (s) => s): string {
  const stops = cities.filter((c) => isStop(c) && c.lat !== undefined && c.lng !== undefined);
  if (stops.length < 2) return "";
  const weakest = [...stops].sort((a, b) => a.affinity - b.affinity)[0];
  const far = new Set(offRouteCities(cities, isStop).map((o) => o.name));
  const pts = stops.map((c) => ({ lat: c.lat!, lng: c.lng! }));
  const s1 = (n: number) => (Math.round(n * 1000) / 10).toFixed(1);
  // The same limit swapFits uses: a day's drive, or the plan's own longest leg if that is longer.
  const limit = Math.max(MAX_LEG_KM, ...legs(pts, bestOrder(pts)));
  const out: string[] = [];
  for (const c of cities) {
    if (isStop(c) || far.has(c.name) || c.lat === undefined || c.lng === undefined || c.affinity <= weakest.affinity) continue;
    const swap = swapFits(pts, stops.indexOf(weakest), { lat: c.lat, lng: c.lng });
    const tied = c.affinity - weakest.affinity <= TIE;
    if (!swap.fits) {
      const why = swap.longestLegKm > limit + 1 ? "would put a leg over a day's drive" : `would add about ${(Math.round((swap.extraKm * ROAD_FACTOR) / 10) * 10).toLocaleString("en-US")} km of driving`;
      out.push(`${clean(c.name)} (${s1(c.affinity)}) scores above ${clean(weakest.name)} (${s1(weakest.affinity)}), but swapping it in ${why}${tied ? ", and the two are effectively tied" : ""}.`);
    } else if (tied) {
      out.push(`${clean(c.name)} (${s1(c.affinity)}) and ${clean(weakest.name)} (${s1(weakest.affinity)}) are effectively tied (within 1 point); either fits the route.`);
    }
  }
  return out.join(" ");
}

/**
 * The notes beside the city ranking: the cut line, cities outside the run and higher-scoring cities left
 * off. They describe the finished route, so while a plan streams (stops arrive one by one, in any order)
 * they stay empty: a stop that has not arrived yet must never read as "skipped".
 */
export function routeNotes(cities: City[], isStop: (c: City) => boolean, complete: boolean, clean: (s: string) => string = (s) => s): { cut: number; off: OffRoute[]; offText: string; skipped: string } {
  if (!complete) return { cut: 0, off: [], offText: "", skipped: "" };
  const ranked = [...cities].sort((a, b) => b.affinity - a.affinity);
  // The cut line is drawn only when the route is exactly the top of the ranking (a regional route may skip a stronger, farther city).
  const k = ranked.filter(isStop).length;
  const cut = ranked.slice(0, k).every(isStop) ? k : 0;
  const off = offRouteCities(ranked, isStop);
  return { cut, off, offText: offRouteText(off, clean), skipped: skippedCityText(ranked, isStop, clean) };
}
