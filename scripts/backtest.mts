/**
 * Back-test (no Qloo or model calls): do a demo plan's cities match where the act (or, for an
 * emerging act, its comparison artist) actually played? Reads a public, cited show list and the
 * recorded preset, and reports the overlap next to a random baseline from the same candidate pool.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/backtest.mts <slug> docs/backtest/<slug>.json
 *
 * Show list format (every show cites its source; nothing is typed in from memory):
 *   { "act": "Joe List", "window": "2024-01..2026-10",
 *     "sources": [{ "url": "...", "retrieved": "2026-10-07", "note": "..." }],
 *     "shows": [{ "date": "2025-03-14", "city": "Boston", "venue": "Laugh Boston", "lat": 42.35, "lng": -71.06, "source": 0 }] }
 * `lat`/`lng` are optional when `city` names a touring market; otherwise the show is snapped to the
 * nearest market within SNAP_KM, and shows near no market are counted as "elsewhere".
 *
 * Reported, for the plan's region (the scored candidates):
 *   - stops hit: how many of the plan's stops are markets the act played;
 *   - candidates hit: the same for every scored candidate, and the mean rank of played vs not-played ones;
 *   - baselines: the chance that k random candidates (k = stop count), and k random touring markets
 *     within 800 km of the route's centre, hit at least as many played markets (10,000 seeded draws each). A small number of acts makes this a sanity check, not validation.
 */
import { readFileSync } from "node:fs";
import { MARKETS, SNAP_KM, distanceKm, findMarket, nearestMarket } from "../src/lib/markets.ts";
import { clean } from "../src/lib/text.ts";
import type { TourPlan } from "../src/lib/tour/types.ts";

type Show = { date: string; city: string; venue?: string; lat?: number; lng?: number; source: number };
type ShowList = { act: string; window?: string; sources: { url: string; retrieved: string; note?: string }[]; shows: Show[] };

const [slug, listFile] = process.argv.slice(2);
if (!slug || !listFile) throw new Error("usage: backtest.mts <slug> <show-list.json>");
const run = JSON.parse(readFileSync(`public/presets/${slug}.json`, "utf8"));
const plan = run.events.find((e: { event: { type: string } }) => e.event.type === "plan").event.plan as TourPlan;
const list = JSON.parse(readFileSync(listFile, "utf8")) as ShowList;
for (const s of list.shows) if (!list.sources[s.source]) throw new Error(`show ${s.date} ${s.city} cites no source`);

const marketOf = (s: Show) => findMarket(s.city) ?? (s.lat !== undefined && s.lng !== undefined ? nearestMarket({ lat: s.lat, lng: s.lng }, SNAP_KM) : undefined);
const played = new Map<string, Show[]>();
let elsewhere = 0;
for (const s of list.shows) {
  const m = marketOf(s);
  if (!m) { elsewhere++; continue; }
  played.set(m.name, [...(played.get(m.name) ?? []), s]);
}

const name = (n: string) => clean(n);
const stops = plan.stops.map((s) => name(s.city.name));
const candidates = [...(plan.candidates ?? plan.stops.map((s) => s.city))].sort((a, b) => b.affinity - a.affinity).map((c) => name(c.name));
const isPlayed = (c: string) => played.has(c) || played.has(findMarket(c)?.name ?? "");
const stopHits = stops.filter(isPlayed);
const candHits = candidates.filter(isPlayed);
const meanRank = (xs: string[]) => (xs.length ? xs.reduce((a, c) => a + candidates.indexOf(c) + 1, 0) / xs.length : NaN);

// Seeded random draws of k candidates (mulberry32), so the number is reproducible.
let seed = 20261007;
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const k = stops.length, draws = 10_000;
let atLeast = 0;
for (let i = 0; i < draws; i++) {
  const pool = [...candidates];
  for (let j = pool.length - 1; j > 0; j--) { const r = Math.floor(rand() * (j + 1)); [pool[j], pool[r]] = [pool[r], pool[j]]; }
  if (pool.slice(0, k).filter(isPlayed).length >= stopHits.length) atLeast++;
}

// A wider baseline: k random touring markets within REGION_KM of the route's centre (the plan only
// scored a handful of candidates, so drawing from them alone barely differs from the plan).
const REGION_KM = 800;
const located = plan.stops.filter((x) => x.city.lat !== undefined && x.city.lng !== undefined);
const centre = { lat: located.reduce((a, x) => a + x.city.lat!, 0) / located.length, lng: located.reduce((a, x) => a + x.city.lng!, 0) / located.length };
const regional = MARKETS.filter((m) => m.country === "United States" && distanceKm(centre, m) <= REGION_KM).map((m) => m.name);
let atLeastRegion = 0;
for (let i = 0; i < draws; i++) {
  const pool = [...regional];
  for (let j = pool.length - 1; j > 0; j--) { const r = Math.floor(rand() * (j + 1)); [pool[j], pool[r]] = [pool[r], pool[j]]; }
  if (pool.slice(0, k).filter(isPlayed).length >= stopHits.length) atLeastRegion++;
}
const inRegion = [...played.keys()].filter((m) => candidates.includes(m));
// Ceiling (test power): the most hits any k-stop route could score from each pool. When the plan
// already scores the ceiling, the test cannot separate a good route from a random one.
const regionalPlayed = regional.filter(isPlayed);
console.log(JSON.stringify({
  slug, act: list.act, window: list.window, shows: list.shows.length, sources: list.sources.map((s) => s.url),
  playedMarkets: [...played.entries()].map(([m, s]) => `${m} (${s.length})`), showsNearNoMarket: elsewhere,
  playedMarketsAmongCandidates: inRegion,
  stops, stopsHit: `${stopHits.length} of ${k}`, stopHits,
  candidates: candidates.length, candidatesHit: candHits.length,
  ceilingCandidates: `${Math.min(k, candHits.length)} of ${k}`,
  ceilingRegional: `${Math.min(k, regionalPlayed.length)} of ${k}`, regionalPlayed,
  meanRankPlayed: +meanRank(candHits).toFixed(2), meanRankNotPlayed: +meanRank(candidates.filter((c) => !isPlayed(c))).toFixed(2),
  baseline: `P(random ${k} of the ${candidates.length} candidates hit ≥ ${stopHits.length}) = ${(atLeast / draws).toFixed(3)}`,
  regionalBaseline: `P(random ${k} of the ${regional.length} touring markets within ${REGION_KM} km of the route's centre hit ≥ ${stopHits.length}) = ${(atLeastRegion / draws).toFixed(3)}`,
  note: candidates.length <= k + 1 ? "few candidates: the baseline has little room to differ from the plan" : undefined,
  marketsKnown: MARKETS.length,
}, null, 2));
