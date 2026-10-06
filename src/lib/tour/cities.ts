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
import { SNAP_KM, countryOf, distanceKm, findMarket, marketSlug, nearestMarket, type Market } from "../markets.ts";
import { fanHeatmap, recommend, type QEntity } from "../qloo.ts";
import { clean, possessive } from "../text.ts";
import type { Stepper } from "./pipeline.ts";
import type { City, Coverage, VenueRef } from "./types.ts";

export type CityContext = { signals: string[]; who: string; venueTag?: string };
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
  ({ entityId: e.id, name: e.name, address: e.address, area: e.area, affinity: e.affinity, evidence });

/**
 * Places Qloo tags as live-music venues that a booker would not call a room (M0: Albany's top
 * "venue" was a farm 20 km out of town). Checked against the name only.
 */
const NOT_A_ROOM = /\b(farms?|railroad|railway|museum|chapel|church|cathedral|cemetery|winery|vineyard|campground|state park|national park|school|library|hospital|airport|zoo|golf|stadium|amphitheat(?:er|re)|fairgrounds?|resort|hotel|marina)\b/i;
/** Rooms further than this from the city centre are not "in" the city for a tour stop. */
export const ROOM_MAX_KM = 18;

/** Drops unlikely venues and rooms outside the city; towns are geocoded once and cached. */
export async function sanitizeRooms(rooms: QEntity[], place: Place): Promise<{ kept: QEntity[]; dropped: number }> {
  const kept: QEntity[] = [];
  for (const room of rooms) {
    if (NOT_A_ROOM.test(room.name)) continue;
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
  const r = await step((v) => `${place.name}: best room ${v.entities[0] ? `${clean(v.entities[0].name)} (${Math.round((v.entities[0].affinity ?? 0) * 100)})` : "none found"}`,
    () => recommend({ targetType: "place", signals: ctx.signals, includeTags: ctx.venueTag ? [ctx.venueTag] : undefined, filterLocation: place.query, limit: 6 }),
    `Rooms in ${place.name} with affinity for ${clean(ctx.who)}`);
  if (!r?.entities.length) return undefined;
  const { kept, dropped } = await sanitizeRooms(r.entities, place);
  if (!kept.length) return undefined;
  const rooms = kept.slice(0, 4);
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
export async function discoverCities(region: string, want: number, ctx: CityContext, step: Stepper, known?: Map<string, City>): Promise<{ cities: City[]; coverage: Coverage }> {
  const pool = want + 3;
  const heat = await step((v) => `Fan hotspots in ${region}: ${v.cells.length} map cells`,
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
  const candidates: (Place & { hotspot?: City["hotspot"] })[] = hotspotMarkets.slice(0, pool)
    .map((h) => ({ ...h.market, hotspot: { affinity: h.affinity, cells: h.cells, evidence: heat!.source.id } }));

  let roomFallback = false;
  if (candidates.length < want + 2) {
    roomFallback = true;
    const rooms = await step((v) => `Rooms across ${region} that this audience favours: ${v.entities.length}`,
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

  const { cities, unscored } = await scoreCities(candidates, ctx, step, known);
  return {
    cities,
    coverage: {
      cells: (heat?.cells ?? []).map((c) => ({ lat: +c.lat.toFixed(3), lng: +c.lng.toFixed(3), affinity: +c.affinity.toFixed(4) })),
      droppedRooms: cities.reduce((n, c) => n + (c.droppedRooms ?? 0), 0) || undefined,
      basis: "hotspots", region, hotspotCells: heat?.cells.length ?? 0, remoteCells, hotspotMarkets: hotspotMarkets.length, roomFallback,
      scored: cities.length, unscored, evidence: heat?.source.id, limited: cities.length < want || !heat?.cells.length,
    },
  };
}

/** Scores a user's own shortlist of cities. */
export async function rankShortlist(names: string[], ctx: CityContext, step: Stepper): Promise<{ cities: City[]; coverage: Coverage }> {
  const places = await Promise.all(names.slice(0, 8).map((n) => placeFor(n)));
  const { cities, unscored } = await scoreCities(places, ctx, step);
  return { cities, coverage: { basis: "shortlist", hotspotCells: 0, remoteCells: 0, hotspotMarkets: 0, roomFallback: false, scored: cities.length, unscored, limited: cities.length < names.length } };
}
