/**
 * Phase A of a Tour Scout run: deterministic Qloo calls, no model involved.
 *
 * Dependency graph (independent branches run concurrently, bounded by the qloo runner):
 *   fingerprint (entity_tags, audience_demographics) ─┐
 *   cross-domain (recommend brand, movie)            ─┤
 *   venue tag (find_tags) ─► cities (country-wide where_popular ─► room affinity per city, see cities.ts)
 *                            ─► per stop: cluster (where_popular in the city), opener (recommend) ─► overlap (compare)
 * Every call is recorded in the evidence ledger and streamed as soon as it lands.
 */
import { Channel, EvidenceLedger, type Source } from "../evidence.ts";
import { areaName } from "../geo.ts";
import { QlooError, audienceDemographics, compareAudiences, entityTags, fanHeatmap, findTags, recommend, type QlooCall } from "../qloo.ts";
import { clean, possessive } from "../text.ts";
import { discoverCities, rankShortlist, scoreCity } from "./cities.ts";
import type { ArtistKind, City, Coverage, FanProfile, StopData, TourEvent, TourInput } from "./types.ts";

export { ARENA_POPULARITY } from "./scale.ts";

const FATAL = new Set(["QLOO_AUTH", "QLOO_NOT_INSTALLED", "QLOO_RATE_LIMIT"]);

export type PhaseAResult = { fan: FanProfile; cities: City[]; stops: StopData[]; ledger: EvidenceLedger; coverage?: Coverage };

/**
 * Qloo tags that mark a person as a comedian (found with find_tags in M0). Without them, `person`
 * recommendations for a comedian return actors; with them (union) they return stand-ups.
 */
export const COMEDIAN_TAGS = ["urn:tag:genre:person:comedian", "urn:tag:occupation:wikidata:stand_up_comedian", "urn:tag:occupation:qloo:comedian"];
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

export type StopContext = {
  signals: string[]; who: string; artistType: ArtistKind; isArtistMode: boolean; venueTag?: string;
  /** The act's Qloo popularity (0–1); openers are picked at or below it when known. */
  popularity?: number;
  /** Openers already chosen for other stops, so each stop suggests someone different when possible. */
  usedOpeners?: Set<string>;
  /** Names of the act (or its proxies); a candidate whose Qloo description names them is a member or side project, not an opener. */
  names?: string[];
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** True when Qloo's description of a candidate mentions the act by name ("lead vocalist of Big Thief"). */
export const isRelatedAct = (description: string | undefined, names: string[] = []) =>
  Boolean(description) && names.some((n) => clean(n).length > 2 && new RegExp(`\\b${escapeRe(clean(n))}\\b`, "i").test(description!));

/** Looks up the venue-type tag once per run ("live music venue" or "comedy club"). */
export async function venueTagFor(artistType: ArtistKind, step: Stepper): Promise<string | undefined> {
  const query = artistType === "person" ? "comedy club" : "live music venue";
  return (await step((v) => `Venue type tag: ${v.tags[0] ? clean(v.tags[0].name) : "none found"}`, () => findTags(query, 3), `Qloo tag for "${query}"`))?.tags[0]?.id;
}

/** Everything one stop needs: where fans cluster, the rooms behind the city's score, and an opener with shared tastes. */
export async function scoutStop(city: City, index: number, ctx: StopContext, step: Stepper): Promise<StopData> {
  const { signals, who, artistType } = ctx;
  const cityName = clean(city.name);
  const where = city.query ?? cityName;
  const stop: StopData = { stopId: `s${index + 1}`, rank: index + 1, city: { ...city, rooms: undefined }, venues: [] };

  const clusterTask = step((v) => `${cityName}: fans cluster in ${v.cells.length} map cells`,
    () => fanHeatmap(signals, where, 10), `Where ${possessive(who)} fans concentrate in ${cityName}`).then(async (r) => {
    const top = r?.cells.slice().sort((a, b) => b.affinity - a.affinity)[0];
    if (!r || !top) return;
    const name = await areaName(top.lat, top.lng);
    // A cluster named like the city itself says nothing; keep it unnamed (coordinates) instead.
    const unnamed = clean(name).toLowerCase() === cityName.toLowerCase();
    stop.cluster = { name: unnamed ? `${top.lat.toFixed(3)},${top.lng.toFixed(3)}` : name, lat: top.lat, lng: top.lng, affinity: top.affinity, evidence: r.source.id };
  });

  const comedian = artistType === "person";
  const openerTask = step((v) => `${cityName}: possible openers ${v.entities.slice(0, 2).map((e) => clean(e.name)).join(", ")}`,
    () => recommend({ targetType: artistType, signals, signalLocation: where, includeTags: comedian ? COMEDIAN_TAGS : undefined, includeTagsOperator: comedian ? "union" : undefined, limit: 8 }),
    `Similar ${comedian ? "comedians" : "artists"} with affinity in ${cityName}`).then(async (r) => {
    // An opener should not outdraw the act: prefer candidates at or below its popularity, then unused ones.
    const others = (r?.entities ?? []).filter((e) => !signals.includes(e.id) && !isRelatedAct(e.description, ctx.names));
    const fits = others.filter((e) => ctx.popularity === undefined || (e.popularity ?? 0) <= ctx.popularity);
    const pool = fits.length ? fits : others;
    const pick = pool.find((e) => !ctx.usedOpeners?.has(e.id)) ?? pool[0];
    if (!r || !pick) return;
    ctx.usedOpeners?.add(pick.id);
    stop.opener = { entityId: pick.id, name: pick.name, affinity: pick.affinity, evidence: r.source.id };
    const overlap = await step((v) => `${cityName}: ${v.shared.length} shared tastes with ${possessive(pick.name)} audience`,
      () => compareAudiences(signals, [pick.id], 6), `Audience overlap between ${clean(who)} and ${clean(pick.name)}`);
    if (overlap) stop.opener.overlap = { shared: overlap.shared, evidence: overlap.source.id };
  });

  // The rooms that gave the city its score; cities added later (scout proposals) are scored here.
  const scored = city.rooms ? city : await scoreCity({ name: cityName, query: where, lat: city.lat, lng: city.lng }, ctx, step, city.hotspot);
  stop.venues = scored?.rooms ?? [];
  if (scored && !city.rooms) stop.city = { ...stop.city, affinity: scored.affinity, evidence: scored.evidence };

  await Promise.all([clusterTask, openerTask]);
  return stop;
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
  const venueTag = await venueTagFor(artistType, step);
  const cityCtx = { signals, who, venueTag };
  const found = input.candidateCities?.length
    ? await rankShortlist(input.candidateCities, cityCtx, step)
    : await discoverCities(input.region || "United States", input.stops, cityCtx, step);
  if (!found.cities.length) throw new QlooError("Qloo found no cities with matching rooms for this act and region", "TOUR_NO_CITIES", true);
  const cities = found.cities;
  out.push({ type: "step", label: `Strongest cities: ${cities.slice(0, 3).map((c) => `${clean(c.name)} (${Math.round(c.affinity * 100)})`).join(", ")}`, evidence: [...new Set(cities.slice(0, 3).map((c) => c.evidence))] });
  out.push({ type: "cities", cities: cities.map((c) => ({ ...c, rooms: undefined })), coverage: found.coverage });

  // In emerging mode the "opener" is a support-slot idea: an established act the new act could open for,
  // so no popularity cap applies (Qloo's similar acts for well-known proxies are all well known).
  const popularity = input.artist?.popularity;
  const names = input.artist ? [input.artist.name] : (input.emerging?.proxies ?? []).map((p) => p.name);
  const ctx: StopContext = { signals, who, artistType, isArtistMode: Boolean(input.artist), venueTag, popularity, usedOpeners: new Set(), names };
  const stops = await Promise.all(cities.slice(0, input.stops).map(async (city, i) => {
    const stop = await scoutStop(city, i, ctx, step);
    out.push({ type: "stop", stop: structuredClone(stop) });
    return stop;
  }));

  await Promise.all([fingerprint, crossDomain]);
  return { fan, cities: cities.map((c) => ({ ...c, rooms: undefined })), stops, ledger, coverage: found.coverage };
}
