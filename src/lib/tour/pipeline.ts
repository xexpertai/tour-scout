/**
 * Phase A of a Tour Scout run: deterministic Qloo calls, no model involved.
 *
 * Dependency graph (independent branches run concurrently, bounded by the qloo runner):
 *   fingerprint (entity_tags, audience_demographics) ─┐
 *   cross-domain (recommend brand, movie)            ─┤
 *   cities (recommend locality | rank) ─► per stop: cluster (where_popular | heatmap),
 *                                                   venues (recommend place), openers (recommend) ─► overlap (compare)
 * Every call is recorded in the evidence ledger and streamed as soon as it lands.
 */
import { Channel, EvidenceLedger, type Source } from "../evidence.ts";
import { areaName, geocodeCity } from "../geo.ts";
import {
  QlooError, audienceDemographics, compareAudiences, entityTags, findTags, rankOptions, recommend, signalHeatmap, wherePopular,
  type QEntity, type QlooCall,
} from "../qloo.ts";
import { clean, possessive } from "../text.ts";
import type { ArtistKind, City, FanProfile, StopData, TourEvent, TourInput } from "./types.ts";

/** Qloo popularity is a 0–1 percentile; above this an artist plays arenas, not clubs. */
export const ARENA_POPULARITY = 0.97;
const FATAL = new Set(["QLOO_AUTH", "QLOO_NOT_INSTALLED", "QLOO_RATE_LIMIT"]);

export type PhaseAResult = { fan: FanProfile; cities: City[]; stops: StopData[]; ledger: EvidenceLedger };
/** Whatever a stream consumer accepts: a source landed, or a human-readable step happened. */
export type StepSink = { push(event: Extract<TourEvent, { type: "source" | "step" }>): void };
export type Stepper = <T>(label: (value: T) => string, fn: () => Promise<T & { call: QlooCall }>, sourceLabel: string) => Promise<(T & { source: Source }) | undefined>;

export function signalsOf(input: TourInput): string[] {
  return input.artist ? [input.artist.id] : (input.emerging?.proxies ?? []).map((p) => p.id);
}

/**
 * Runs one Qloo step: records its evidence, reports it, and turns non-fatal failures into a failed
 * step with an undefined result. Fatal failures (credential, quota) are rethrown.
 */
export function makeStepper(ledger: EvidenceLedger, out: StepSink, signal?: AbortSignal): Stepper {
  return async (label, fn, sourceLabel) => {
    if (signal?.aborted) return undefined;
    try {
      const value = await fn();
      const source = ledger.record(sourceLabel, value.call);
      out.push({ type: "source", source });
      out.push({ type: "step", label: label(value), evidence: [source.id] });
      return { ...value, source };
    } catch (e) {
      if (e instanceof QlooError && FATAL.has(e.code)) throw e;
      out.push({ type: "step", label: `${sourceLabel}: ${(e as Error).message}`, failed: true });
      return undefined;
    }
  };
}

export type StopContext = { signals: string[]; who: string; artistType: ArtistKind; isArtistMode: boolean; venueTag?: string };

/** Looks up the venue-type tag once per run ("live music venue" or "comedy club"). */
export async function venueTagFor(artistType: ArtistKind, step: Stepper): Promise<string | undefined> {
  const query = artistType === "person" ? "comedy club" : "live music venue";
  return (await step((v) => `Venue type tag: ${v.tags[0] ? clean(v.tags[0].name) : "none found"}`, () => findTags(query, 3), `Qloo tag for "${query}"`))?.tags[0]?.id;
}

/** Everything one stop needs: where fans cluster, rooms near them, and an opener with shared tastes. */
export async function scoutStop(city: City, index: number, ctx: StopContext, step: Stepper): Promise<StopData> {
  const { signals, who, artistType } = ctx;
  const cityName = clean(city.name);
  const stop: StopData = { stopId: `s${index + 1}`, rank: index + 1, city, venues: [] };

  const clusterTask = step((v) => `${cityName}: fans cluster in ${v.cells.length} map cells`,
    () => (ctx.isArtistMode ? wherePopular(signals[0], cityName, 10) : signalHeatmap({ location: cityName, entityIds: signals })),
    `Where ${possessive(who)} fans concentrate in ${cityName}`).then(async (r) => {
    const top = r?.cells.slice().sort((a, b) => b.affinity - a.affinity)[0];
    if (!r || !top) return;
    const name = await areaName(top.lat, top.lng);
    // A cluster named like the city itself says nothing; keep it unnamed (coordinates) instead.
    const unnamed = clean(name).toLowerCase() === cityName.toLowerCase();
    stop.cluster = { name: unnamed ? `${top.lat.toFixed(3)},${top.lng.toFixed(3)}` : name, lat: top.lat, lng: top.lng, affinity: top.affinity, evidence: r.source.id };
  });

  const openerTask = step((v) => `${cityName}: possible openers ${v.entities.slice(0, 2).map((e) => clean(e.name)).join(", ")}`,
    () => recommend({ targetType: artistType, signals, signalLocation: cityName, limit: 5 }),
    `Similar ${artistType === "person" ? "comedians" : "artists"} with affinity in ${cityName}`).then(async (r) => {
    const pick = r?.entities.find((e) => !signals.includes(e.id));
    if (!r || !pick) return;
    stop.opener = { entityId: pick.id, name: pick.name, affinity: pick.affinity, evidence: r.source.id };
    const overlap = await step((v) => `${cityName}: ${v.shared.length} shared tastes with ${possessive(pick.name)} audience`,
      () => compareAudiences(signals, [pick.id], 6), `Audience overlap between ${clean(who)} and ${clean(pick.name)}`);
    if (overlap) stop.opener.overlap = { shared: overlap.shared, evidence: overlap.source.id };
  });

  // Venues wait for the cluster so they can be searched near it; fall back to the whole city.
  await clusterTask;
  const near = stop.cluster && !/^-?\d/.test(stop.cluster.name) ? `${stop.cluster.name}, ${cityName}` : cityName;
  const includeTags = ctx.venueTag ? [ctx.venueTag] : undefined;
  let venues = await step((v) => `${cityName}: ${v.entities.length} venues near ${near}`,
    () => recommend({ targetType: "place", signals, includeTags, filterLocation: near, limit: 4 }),
    `Venues near ${near} with affinity for ${clean(who)}`);
  if (venues && !venues.entities.length && near !== cityName) {
    venues = await step((v) => `${cityName}: ${v.entities.length} venues city-wide`,
      () => recommend({ targetType: "place", signals, includeTags, filterLocation: cityName, limit: 4 }),
      `Venues in ${cityName} with affinity for ${clean(who)}`);
  }
  stop.venues = (venues?.entities ?? []).map((e) => ({ entityId: e.id, name: e.name, address: e.address, affinity: e.affinity, lat: e.lat, lng: e.lng, evidence: venues!.source.id }));

  await openerTask;
  return stop;
}

/** A Qloo locality as a City, geocoded through OpenStreetMap when Qloo has no coordinates. */
export async function toCity(e: QEntity, evidence: string): Promise<City> {
  const point = e.lat !== undefined && e.lng !== undefined ? { lat: e.lat, lng: e.lng } : await geocodeCity(clean(e.name));
  return { entityId: e.id, name: e.name, affinity: e.affinity ?? 0, lat: point?.lat, lng: point?.lng, evidence };
}

export const whoOf = (input: TourInput) =>
  input.artist?.name ?? `artists like ${(input.emerging?.proxies ?? []).map((p) => clean(p.name)).join(", ")}`;

/** Runs Phase A, pushing events into `out`. Throws only for failures that make the whole run impossible. */
export async function runPhaseA(input: TourInput, out: Channel<TourEvent>, signal?: AbortSignal): Promise<PhaseAResult> {
  const ledger = new EvidenceLedger();
  const signals = signalsOf(input);
  if (!signals.length) throw new QlooError("No confirmed artist or proxy artists to scout with", "TOUR_NO_SIGNALS");
  const artistType = input.artist?.type ?? input.emerging?.proxies[0]?.type ?? "artist";
  const who = whoOf(input);
  const step = makeStepper(ledger, out, signal);

  const fan: FanProfile = { tags: [], alsoLikes: [] };
  const emitFan = () => out.push({ type: "fan", fan: structuredClone(fan) });

  const fingerprint = Promise.all([
    step((v) => `Fan fingerprint: ${v.tags.slice(0, 3).map((t) => clean(t.name)).join(", ")}`,
      () => entityTags(signals, 8), `Taste tags of ${possessive(who)} audience`).then((r) => {
      if (r) { fan.tags = r.tags.map((t) => ({ ...t, evidence: r.source.id })); emitFan(); }
    }),
    step(() => "Aggregate age and gender affinity of the audience",
      () => audienceDemographics(signals[0]), `Audience demographics of ${clean(input.artist?.name ?? input.emerging?.proxies[0]?.name ?? who)}`).then((r) => {
      if (r) { fan.demographics = { ...r.demographics, evidence: r.source.id }; emitFan(); }
    }),
  ]);

  const crossDomain = Promise.all((["brand", "movie"] as const).map((domain) =>
    step((v) => `Fans also like (${domain}): ${v.entities.slice(0, 3).map((e) => clean(e.name)).join(", ")}`,
      () => recommend({ targetType: domain, signals, signalLocation: input.candidateCities ? undefined : input.region, limit: 6 }),
      `${domain} affinity of ${possessive(who)} audience`).then((r) => {
      if (r) { fan.alsoLikes.push({ domain, items: r.entities.map((e) => ({ name: e.name, affinity: e.affinity })), evidence: r.source.id }); emitFan(); }
    })));

  // Cities are the backbone of the plan: without them there is nothing to schedule.
  const ranked = input.candidateCities?.length
    ? await step((v) => `Ranked your ${v.entities.length} cities by fan affinity`,
      () => rankOptions({ options: input.candidateCities!, optionType: "locality", signals }), `Your candidate cities ranked for ${possessive(who)} fans`)
    : await step((v) => `Strongest fan affinity: ${v.entities.slice(0, 3).map((e) => clean(e.name)).join(", ")}`,
      () => recommend({ targetType: "locality", signals, filterLocation: input.region, limit: Math.max(input.stops * 2, 8) }),
      `Cities${input.region ? ` in ${input.region}` : ""} ranked by ${possessive(who)} fan affinity`);
  if (!ranked?.entities.length) throw new QlooError("Qloo returned no cities for this artist and region", "TOUR_NO_CITIES", true);

  const cities = await Promise.all(ranked.entities.map((e) => toCity(e, ranked.source.id)));
  out.push({ type: "cities", cities });

  const ctx: StopContext = { signals, who, artistType, isArtistMode: Boolean(input.artist), venueTag: await venueTagFor(artistType, step) };
  const stops = await Promise.all(cities.slice(0, input.stops).map(async (city, i) => {
    const stop = await scoutStop(city, i, ctx, step);
    out.push({ type: "stop", stop: structuredClone(stop) });
    return stop;
  }));

  await Promise.all([fingerprint, crossDomain]);
  return { fan, cities, stops, ledger };
}
