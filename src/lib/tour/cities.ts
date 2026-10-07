/**
 * Finding and scoring tour cities from Qloo data.
 *
 * The hackathon API cannot recommend or rank localities, so cities are found in two Qloo steps:
 *
 * 1. Fan hotspots: one country-wide `where_popular` heatmap (20 cells of roughly 30 km). Each cell
 *    is snapped to the nearest touring market (markets.ts); cells far from every market are
 *    counted as remote. If hotspots yield too few markets, a country-wide room search
 *    (`recommend` place + venue tag) adds the cities whose rooms this audience favours most.
 * 2. Room affinity: each candidate city is scored by `recommend` place with the venue-type tag
 *    filtered to that city. The city's score is its best room's Qloo affinity. Because it is the
 *    same signal scored against places, the score compares cities directly, so a user's own
 *    shortlist, "why not Denver?" and the scout's tools all use this one measure.
 */
import { geocodeCity } from "../geo.ts";
import { MARKETS, SNAP_KM, countryOf, distanceKm, findMarket, marketSlug, nearestMarket, type Market } from "../markets.ts";
import { MAX_LEG_KM, chooseRegion, pickStops, regionFillers } from "./region.ts";
import { fanHeatmap, recommend, type QEntity } from "../qloo.ts";
import { clean, possessive } from "../text.ts";
import type { Stepper } from "./pipeline.ts";
import type { City, Coverage, VenueRef } from "./types.ts";

/** `comedy`: a comedian's run, so comedy clubs lead each city's room list (and get the pitch). */
export type CityContext = { signals: string[]; who: string; venueTag?: string; comedy?: boolean };

/** A room whose name says it is a comedy club (Qloo's comedy-club tag also matches music bars that host comedy nights). */
export const COMEDY_ROOM = /\b(comedy|laughs?|laughing|improv|funny|stand[- ]?up|punch ?line|helium|zanies|giggles|chuckles|comix|comedians?)\b/i;
type Place = { name: string; query: string; lat?: number; lng?: number };

/**
 * A typed city name as a place: a known market keeps its coordinates and Qloo query. Other names
 * are geocoded and snapped to a market within `snapKm` (25 km for typed cities, so "Brooklyn" is
 * New York; wider for Qloo's own metro labels such as "National Capital Region").
 */
export async function placeFor(name: string, snapKm = 25, within?: string): Promise<Place> {
  const market = findMarket(name);
  if (market) return market;
  // Scope the lookup to the region when known: "National Capital Region" alone geocodes to Manila.
  const point = await geocodeCity(within ? `${name}, ${within}` : name);
  const near = point && nearestMarket(point, snapKm);
  return near ?? { name: name.trim(), query: name.trim(), lat: point?.lat, lng: point?.lng };
}

export const toVenue = (e: QEntity, evidence: string): VenueRef =>
  ({ entityId: e.id, name: e.name, address: e.address, area: e.area, town: e.city, affinity: e.affinity, evidence });

/**
 * Places Qloo tags as live-music venues that a booker would not call a room (M0: Albany's top
 * "venue" was a farm 20 km out of town). Checked against the name only.
 */
const NOT_A_ROOM = /\b(farms?|railroad|railway|museum|chapel|church|cathedral|cemetery|winery|vineyard|campground|state park|national park|school|library|hospital|airport|zoo|golf|stadium|arena|amphitheat(?:er|re)|fairgrounds?|resort|hotel|marina|studios?|records|ed sullivan)\b/i;
/** Restaurants are rooms only when the name says they host music or comedy. */
const RESTAURANT = /\b(restaurant|bistro|diner|pizzeria|steakhouse|kitchen)\b/i;
const HOSTS_SHOWS = /\b(music|venue|hall|club|live|theat(?:er|re)|comedy|stage)\b/i;
/** Islands reachable only by ferry (a "Portland" room on Peaks Island) are not a tour stop's room. */
const ISLAND = /\bisland\b/i;
/** Rooms further than this from the city centre are not "in" the city for a tour stop. */
export const ROOM_MAX_KM = 18;

/** Drops unlikely venues and rooms outside the city; towns are geocoded once and cached. */
export async function sanitizeRooms(rooms: QEntity[], place: Place): Promise<{ kept: QEntity[]; dropped: number }> {
  const kept: QEntity[] = [];
  for (const room of rooms) {
    if (NOT_A_ROOM.test(room.name)) continue;
    if (RESTAURANT.test(room.name) && !HOSTS_SHOWS.test(room.name)) continue;
    if (ISLAND.test(room.address ?? "") && !ISLAND.test(place.name)) continue;
    const town = room.city?.trim();
    if (town && place.lat !== undefined && place.lng !== undefined && town.toLowerCase() !== place.name.split(",")[0].toLowerCase()) {
      const point = await geocodeCity(room.region ? `${town}, ${room.region}` : town);
      if (point && distanceKm(point, { lat: place.lat, lng: place.lng }) > ROOM_MAX_KM) continue;
    }
    kept.push(room);
  }
  return { kept, dropped: rooms.length - kept.length };
}

/** Scores one city by its best room affinity. Undefined when Qloo finds no rooms there. */
export async function scoreCity(place: Place, ctx: CityContext, step: Stepper, hotspot?: City["hotspot"]): Promise<City | undefined> {
  // The label is shown before the rooms are checked (not-a-venue, out of town), so it names none.
  const r = await step((v) => `${place.name}: ${v.entities.length ? "rooms scored" : "no rooms found"}`,
    () => recommend({ targetType: "place", signals: ctx.signals, includeTags: ctx.venueTag ? [ctx.venueTag] : undefined, filterLocation: place.query, limit: ctx.comedy ? 12 : 6 }),
    `Rooms in ${place.name} with affinity for ${clean(ctx.who)}`);
  if (!r?.entities.length) return undefined;
  const { kept, dropped } = await sanitizeRooms(r.entities, place);
  if (!kept.length) return undefined;
  // A comedian's list leads with real comedy clubs (best first), then the other rooms; the city's
  // score is still its best-matching room among those shown.
  const ordered = ctx.comedy ? [...kept.filter((e) => COMEDY_ROOM.test(e.name)), ...kept.filter((e) => !COMEDY_ROOM.test(e.name))] : kept;
  const rooms = ordered.slice(0, 4);
  const best = Math.max(...rooms.map((e) => e.affinity ?? 0));
  return {
    entityId: marketSlug(place.name), name: place.name, query: place.query, affinity: best, lat: place.lat, lng: place.lng,
    evidence: r.source.id, hotspot, rooms: rooms.map((e) => toVenue(e, r.source.id)), droppedRooms: dropped || undefined,
  };
}

/**
 * Scores several cities concurrently (bounded by the Qloo runner) and sorts them by score. Cities in
 * `known` (e.g. a plan's current stops, already scored by the same measure) are reused, not re-queried.
 */
export async function scoreCities(places: (Place & { hotspot?: City["hotspot"] })[], ctx: CityContext, step: Stepper, known?: Map<string, City>): Promise<{ cities: City[]; unscored: string[] }> {
  const scored = await Promise.all(places.map((p) => {
    const hit = known?.get(p.name.toLowerCase());
    return hit ? { ...hit, hotspot: p.hotspot ?? hit.hotspot } : scoreCity(p, ctx, step, p.hotspot);
  }));
  return {
    cities: scored.filter((c): c is City => Boolean(c)).sort((a, b) => b.affinity - a.affinity),
    unscored: places.filter((_, i) => !scored[i]).map((p) => p.name),
  };
}

/**
 * Finds up to `want` scored cities in a region. Candidates are hotspot markets first (strongest
 * cell first); room-led cities are added only if hotspots give fewer than `want + 2` markets.
 */
/** The largest touring metros: a run mostly through these is not "the secondary markets". */
const BIG_METROS: Record<string, string[]> = {
  "United States": ["New York", "Los Angeles", "Chicago", "Boston", "Philadelphia", "Washington, DC", "San Francisco", "Seattle", "Atlanta", "Houston", "Dallas", "Miami"],
  "United Kingdom": ["London", "Manchester", "Birmingham", "Glasgow"], Canada: ["Toronto", "Montreal", "Vancouver"], Australia: ["Sydney", "Melbourne"],
};
const ANCHORS: Record<string, string[]> = {
  "United States": ["New York", "Los Angeles", "Chicago"], "United Kingdom": ["London", "Manchester"],
  Canada: ["Toronto", "Montreal"], Australia: ["Sydney", "Melbourne"],
};

export async function discoverCities(region: string, want: number, ctx: CityContext, step: Stepper, known?: Map<string, City>, startFrom?: string): Promise<{ cities: City[]; coverage: Coverage }> {
  const pool = want + 3;
  const heat = await step((v) => v.savedAt
      ? `Fan map timed out; using the one saved ${v.savedAt.slice(0, 10)}: ${v.cells.length} map cells`
      : `Fan hotspots in ${region}: ${v.cells.length} map cells`,
    () => fanHeatmap(ctx.signals, region, 20), `Where ${possessive(clean(ctx.who))} fans concentrate across ${region}`);

  const byMarket = new Map<string, { market: Market; affinity: number; cells: number }>();
  let remoteCells = 0;
  // A cell near a border must not become a stop abroad (a Buffalo-area cell is not Toronto).
  const country = countryOf(region);
  for (const cell of heat?.cells ?? []) {
    const market = nearestMarket(cell, SNAP_KM, country);
    if (!market) { remoteCells++; continue; }
    const known = byMarket.get(market.name);
    if (known) { known.cells++; known.affinity = Math.max(known.affinity, cell.affinity); } else byMarket.set(market.name, { market, affinity: cell.affinity, cells: 1 });
  }
  const hotspotMarkets = [...byMarket.values()].sort((a, b) => b.affinity - a.affinity || b.cells - a.cells);
  // A tour is a drivable run: work in the region where most hotspots sit (or around the start city),
  // and fill it with nearby touring markets so the stops can be a day's drive apart.
  const start = startFrom ? await placeFor(startFrom, 25, region) : undefined;
  const startPt = start?.lat !== undefined && start.lng !== undefined ? { lat: start.lat, lng: start.lng, name: start.name } : undefined;
  const chosen = hotspotMarkets.length || startPt ? chooseRegion(hotspotMarkets, startPt) : undefined;
  const inRegion = chosen ? hotspotMarkets.filter((h) => chosen.inRegion.some((r) => r.market.name === h.market.name)) : hotspotMarkets;
  const candidates: (Place & { hotspot?: City["hotspot"] })[] = inRegion.slice(0, pool)
    .map((h) => ({ ...h.market, hotspot: { affinity: h.affinity, cells: h.cells, evidence: heat!.source.id } }));
  if (chosen) {
    for (const m of regionFillers(chosen.seed, MARKETS, country, new Set(candidates.map((c) => c.name)))) {
      if (candidates.length >= pool) break;
      candidates.push(m);
    }
  }

  let roomFallback = false;
  if (candidates.length < want + 2) {
    roomFallback = true;
    const rooms = await step((v) => `${heat ? "" : "No fan map in time, so finding cities by room: "}Rooms across ${region} that this audience favours: ${v.entities.length}`,
      () => recommend({ targetType: "place", signals: ctx.signals, includeTags: ctx.venueTag ? [ctx.venueTag] : undefined, filterLocation: region, limit: 20 }),
      `Rooms across ${region} with affinity for ${clean(ctx.who)}`);
    // Rooms arrive best first, so the first room seen in a city decides that city's place in line.
    for (const room of rooms?.entities ?? []) {
      if (candidates.length >= pool) break;
      if (!room.city) continue;
      const place = await placeFor(room.city, SNAP_KM, region);
      if (!candidates.some((c) => c.name === place.name)) candidates.push(place);
    }
  }

  // No hotspot region (an empty or missing fan map): build the region around the strongest room city
  // found country-wide, so the tour is still a drivable run rather than one or two far-apart cities.
  let filled = chosen;
  if (!chosen && candidates.length) {
    const first = candidates.find((c) => c.lat !== undefined && c.lng !== undefined);
    if (first) {
      filled = chooseRegion([], { lat: first.lat!, lng: first.lng!, name: first.name });
      for (const m of regionFillers(filled.seed, MARKETS, country, new Set(candidates.map((c) => c.name)))) {
        if (candidates.length >= pool + 2) break;
        candidates.push(m);
      }
    }
  }
  const { cities: scored, unscored } = await scoreCities(candidates, ctx, step, known);
  // The stops: the strongest cities that can be routed with no leg over MAX_LEG_KM; the rest stay ranked below.
  // A fan-hotspot city always beats a filler; among equals, the higher room affinity wins.
  const weight = (c: City) => c.affinity + (c.hotspot ? 1 : 0);
  let { picked, longestLegKm } = pickStops(scored, want, MAX_LEG_KM, weight);
  // Never a one-city "tour": if no two strong cities are within a day's drive, allow longer legs (and say how long).
  if (picked.length < Math.min(2, want)) ({ picked, longestLegKm } = pickStops(scored, want, MAX_LEG_KM * 1.5, weight));
  const cities = [...picked, ...scored.filter((c) => !picked.includes(c))];
  return {
    cities,
    coverage: {
      cells: (heat?.cells ?? []).map((c) => ({ lat: +c.lat.toFixed(3), lng: +c.lng.toFixed(3), affinity: +c.affinity.toFixed(4) })),
      droppedRooms: cities.reduce((n, c) => n + (c.droppedRooms ?? 0), 0) || undefined,
      basis: "hotspots", region, heatmap: !heat ? "missing" : heat.savedAt ? "saved" : "live", heatmapSavedAt: heat?.savedAt, hotspotCells: heat?.cells.length ?? 0, remoteCells, hotspotMarkets: hotspotMarkets.length, roomFallback,
      scored: cities.length, unscored, evidence: heat?.source.id, limited: cities.length < want || !heat?.cells.length,
      // The big anchor markets a booker plays anyway: when the fan map skips them, say so (it's the point).
      // Only meaningful when the fan map points at touring cities at all.
      // ...and only when most stops really are secondary markets (not New York, Boston, Philadelphia...).
      anchorsAbsent: hotspotMarkets.length >= 3 && picked.filter((c) => !(BIG_METROS[country ?? ""] ?? []).includes(c.name)).length * 2 > picked.length
        ? (ANCHORS[country ?? ""] ?? []).filter((a) => !byMarket.has(a)) : undefined,
      regional: {
        around: picked[0]?.name ?? filled?.seed.name, start: startPt, maxLegKm: MAX_LEG_KM, longestLegKm: Math.round(longestLegKm), stops: picked.length, asked: want,
        elsewhere: (chosen?.elsewhere ?? []).slice(0, 4).map((h) => h.market.name),
      },
    },
  };
}

/** Scores a user's own shortlist of cities. */
export async function rankShortlist(names: string[], ctx: CityContext, step: Stepper): Promise<{ cities: City[]; coverage: Coverage }> {
  const places = await Promise.all(names.slice(0, 8).map((n) => placeFor(n)));
  const { cities, unscored } = await scoreCities(places, ctx, step);
  return { cities, coverage: { basis: "shortlist", hotspotCells: 0, remoteCells: 0, hotspotMarkets: 0, roomFallback: false, scored: cities.length, unscored, limited: cities.length < names.length } };
}
