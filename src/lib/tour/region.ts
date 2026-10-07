/**
 * Regional tours: a run of club dates is a drivable loop, not a zig-zag across a country. Pure
 * geometry (no Qloo calls), so it is tested directly.
 *
 * 1. chooseRegion: from the fan-hotspot markets (Qloo), pick the region where most of them sit
 *    within reach of each other: for each hotspot market as a seed, count the hotspots within
 *    REGION_KM, weighting stronger hotspots more. Hotspots outside it are reported as other regions.
 * 2. pickStops: from the scored cities in that region, choose the N with the best Qloo room
 *    affinity such that, in the best driving order, no leg is longer than MAX_LEG_KM.
 *
 * Distances are straight-line; road distance is about 1.25 × that, and drive time assumes 80 km/h.
 */
import { distanceKm, type Market } from "../markets.ts";

type Pt = { lat: number; lng: number };

/** Longest straight-line leg allowed between consecutive stops (≈ 500 km, ≈ 6 h by road). */
export const MAX_LEG_KM = Number(process.env.TOUR_MAX_LEG_KM) || 400;
/** A region is everything within this distance of its seed market. */
export const REGION_KM = Number(process.env.TOUR_REGION_KM) || 650;
export const ROAD_FACTOR = 1.25;
export const driveHours = (straightKm: number) => (straightKm * ROAD_FACTOR) / 80;

export type HotspotMarket = { market: Market; cells: number };

/**
 * The best region for the tour: the seed whose surroundings hold the most hotspot weight. `hotspots`
 * arrive strongest first; earlier ones weigh more. With `start`, the region is the one around it.
 */
export function chooseRegion(hotspots: HotspotMarket[], start?: Pt & { name?: string }): { seed: Pt & { name: string }; inRegion: HotspotMarket[]; elsewhere: HotspotMarket[] } {
  const weight = (i: number, h: HotspotMarket) => h.cells * (1 - (0.5 * i) / Math.max(1, hotspots.length));
  let seed: Pt & { name: string } = start ? { lat: start.lat, lng: start.lng, name: start.name ?? "your start" } : { ...hotspots[0]?.market, name: hotspots[0]?.market.name ?? "" };
  if (!start) {
    let best = -1;
    for (const s of hotspots) {
      const w = hotspots.reduce((sum, h, i) => sum + (distanceKm(s.market, h.market) <= REGION_KM ? weight(i, h) : 0), 0);
      if (w > best + 1e-9) { best = w; seed = { ...s.market, name: s.market.name }; }
    }
  }
  const near = (h: HotspotMarket) => distanceKm(seed, h.market) <= REGION_KM;
  return { seed, inRegion: hotspots.filter(near), elsewhere: hotspots.filter((h) => !near(h)) };
}

/** Markets of the same country inside the region that are not hotspots, nearest to the seed first. */
export function regionFillers(seed: Pt, all: Market[], country: string | undefined, exclude: Set<string>): Market[] {
  return all
    .filter((m) => (!country || m.country === country) && !exclude.has(m.name) && distanceKm(seed, m) <= REGION_KM)
    .sort((a, b) => distanceKm(seed, a) - distanceKm(seed, b));
}

/** Shortest open path through the points (exact for ≤ 8), as an index order. */
export function bestOrder(pts: Pt[]): number[] {
  const idx = pts.map((_, i) => i);
  if (pts.length < 3) return idx;
  let best = idx, bestLen = Infinity;
  const perm = (rest: number[], acc: number[]) => {
    if (!rest.length) {
      if (acc[0] > acc[acc.length - 1]) return;
      const len = legs(pts, acc).reduce((a, b) => a + b, 0);
      if (len < bestLen) { bestLen = len; best = acc; }
      return;
    }
    for (let i = 0; i < rest.length; i++) perm([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
  };
  perm(idx, []);
  return best;
}

export const legs = (pts: Pt[], order: number[]) => order.slice(1).map((j, i) => distanceKm(pts[order[i]], pts[j]));

/**
 * The N cities with the highest total score whose best driving order has no leg over `maxLegKm`.
 * If no N-city set fits, the largest set that does (never fewer than 2 if two fit), so the caller
 * can say the region holds fewer strong cities than asked. Cities without coordinates are skipped.
 */
export function pickStops<T extends { affinity: number; lat?: number; lng?: number }>(cities: T[], n: number, maxLegKm = MAX_LEG_KM, weight: (c: T) => number = (c) => c.affinity): { picked: T[]; longestLegKm: number } {
  const located = cities.filter((c) => c.lat !== undefined && c.lng !== undefined).slice(0, 12);
  for (let k = Math.min(n, located.length); k >= 1; k--) {
    let best: { set: T[]; score: number; length: number; longest: number } | undefined;
    for (const set of combinations(located, k)) {
      const pts = set.map((c) => ({ lat: c.lat!, lng: c.lng! }));
      const ls = legs(pts, bestOrder(pts));
      const longest = Math.max(0, ...ls);
      if (longest > maxLegKm) continue;
      const score = set.reduce((s, c) => s + weight(c), 0), length = ls.reduce((a, b) => a + b, 0);
      if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && length < best.length)) best = { set, score, length, longest };
    }
    if (best) return { picked: [...best.set].sort((a, b) => b.affinity - a.affinity), longestLegKm: best.longest };
  }
  return { picked: located.slice(0, 1), longestLegKm: 0 };
}

function* combinations<T>(items: T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) { yield acc; return; }
  for (let i = start; i <= items.length - (k - acc.length); i++) yield* combinations(items, k, i + 1, [...acc, items[i]]);
}

/** Two scores this close (0–1 scale; 1 point on screen) are a tie for routing decisions. */
export const TIE = 0.01;

/**
 * Whether `candidate` can replace `weakest` and keep the run drivable: in the best order of the new set
 * no leg is over MAX_LEG_KM, and the total drive grows by at most `maxExtraKm` (a detour, not a new tour).
 */
export function swapFits(stops: Pt[], weakestIndex: number, candidate: Pt, maxExtraKm = 150): { fits: boolean; extraKm: number; longestLegKm: number } {
  const before = stops.length > 1 ? legs(stops, bestOrder(stops)).reduce((a, b) => a + b, 0) : 0;
  const next = stops.map((p, i) => (i === weakestIndex ? candidate : p));
  const ls = legs(next, bestOrder(next));
  const after = ls.reduce((a, b) => a + b, 0), longest = Math.max(0, ...ls);
  // Drivable means no leg over the limit, or at least no worse than the plan's own longest leg.
  const limit = Math.max(MAX_LEG_KM, stops.length > 1 ? Math.max(...legs(stops, bestOrder(stops))) : 0);
  return { fits: longest <= limit + 1 && after - before <= maxExtraKm, extraKm: Math.round(after - before), longestLegKm: Math.round(longest) };
}
