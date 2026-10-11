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
import { QlooError, audienceDemographics, compareAudiences, describeEntity, entityTags, fanHeatmap, findTags, recommend, type QEntity, type QlooCall } from "../qloo.ts";
import { clean, possessive } from "../text.ts";
import { discoverCities, rankShortlist, scoreCity } from "./cities.ts";
import type { ArtistKind, City, Coverage, FanProfile, StopData, TourEvent, TourInput } from "./types.ts";
import { isKnownSupergroup } from "./realism.ts";

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
/**
 * Qloo popularity above which an act is no longer a small-room support-slot target. From the demo data:
 * acts touring 100-500-capacity rooms sit at about 0.56-0.90 (Joanna Sternberg 0.56, Mikaela Davis 0.77,
 * Tomberlin 0.90), theatre-level acts at 0.96+ (Better Oblivion Community Center 0.96, Big Thief 0.99).
 */
export const SMALL_ROOM_POPULARITY = 0.92;

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
/**
 * Candidates a booker would not pitch as an opener: a supergroup (a band of established names draws
 * like a headliner), and, for a comedian, a person Qloo describes first as an actor with no stand-up
 * ("Canadian actor and comedian"), as opposed to a stand-up who also acts ("American comedian and actor").
 */
export const unlikelyOpener = (description: string | undefined, comedian: boolean, name?: string) => {
  const d = description ?? "";
  if (/\bsupergroup\b/i.test(d) || (name !== undefined && isKnownSupergroup(name))) return true;
  return comedian && /^(?:[A-Z][\w-]*\s+){0,3}(?:actor|actress)\b/.test(d.trim()) && !/stand[- ]?up/i.test(d);
};

/**
 * Qloo's recommend results carry no description, so the candidate about to be picked is looked up
 * (describe, receipted) and skipped if it is an unlikely opener; at most `MAX_VETS` lookups per stop.
 */
const MAX_VETS = 3;
export async function describedAs(e: QEntity, kind: ArtistKind, step: Stepper): Promise<string | undefined> {
  const r = await step((v) => `${clean(e.name)}: ${v.description ?? "no description"}`, async () => {
    const d = await describeEntity(e.name, kind === "person" ? "person" : "artist");
    const m = d.status === "resolved" ? (d.entity.id === e.id ? d.entity : undefined) : d.status === "ambiguous" ? d.candidates.find((c) => c.id === e.id) : undefined;
    return { description: m?.description, call: d.call };
  }, `Who ${clean(e.name)} is`);
  return r?.description;
}

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
    const others = (r?.entities ?? []).filter((e) => !signals.includes(e.id) && !isRelatedAct(e.description, ctx.names) && !unlikelyOpener(e.description, comedian, e.name));
    // Order: candidates at or below the act's popularity (Qloo's order), then the rest least popular first,
    // so a small act is never paired with a far bigger one while a closer fit exists. Unused ones win.
    const fitsAct = (e: QEntity) => ctx.popularity === undefined || (e.popularity !== undefined && e.popularity <= ctx.popularity);
    const pool = [...others.filter(fitsAct), ...others.filter((e) => !fitsAct(e)).sort((a, b) => (a.popularity ?? 1) - (b.popularity ?? 1))];
    // Never the same act at two stops: an unused candidate, else none (a repeat is not a suggestion).
    // Each candidate is reserved before it is looked up, so parallel stops never pick the same act.
    let pick: QEntity | undefined;
    let vets = 0;
    for (const e of pool) {
      if (ctx.usedOpeners?.has(e.id)) continue;
      ctx.usedOpeners?.add(e.id);
      if (vets++ >= MAX_VETS) { pick = e; break; }
      if (!unlikelyOpener(e.description ?? await describedAs(e, artistType, step), comedian, e.name)) { pick = e; break; }
    }
    if (!r || !pick) return;
    stop.opener = { entityId: pick.id, name: pick.name, affinity: pick.affinity, evidence: r.source.id,
      popularity: pick.popularity, sizeCap: ctx.popularity, oversize: !fitsAct(pick) || undefined };
    const overlap = await step((v) => `${cityName}: ${v.shared.length} shared tastes with ${possessive(pick.name)} audience`,
      () => compareAudiences(signals, [pick.id], 6), `Audience overlap between ${clean(who)} and ${clean(pick.name)}`);
    if (overlap) stop.opener.overlap = { shared: overlap.shared, evidence: overlap.source.id };
  });

  // The rooms that gave the city its score; cities added later (scout proposals) are scored here.
  const scored = city.rooms ? city : await scoreCity({ name: cityName, query: where, lat: city.lat, lng: city.lng }, { ...ctx, comedy: comedian }, step, city.hotspot);
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
  const cityCtx = { signals, who, venueTag, comedy: artistType === "person" };
  const found = input.candidateCities?.length
    ? await rankShortlist(input.candidateCities, cityCtx, step)
    : await discoverCities(input.region || "United States", input.stops, cityCtx, step, undefined, input.startFrom);
  if (!found.cities.length) throw new QlooError("Qloo found no cities with matching rooms for this act and region", "TOUR_NO_CITIES", true);
  const cities = found.cities;
  out.push({ type: "step", label: `Strongest cities: ${cities.slice(0, 3).map((c) => `${clean(c.name)} (${Math.round(c.affinity * 100)})`).join(", ")}`, evidence: [...new Set(cities.slice(0, 3).map((c) => c.evidence))] });
  out.push({ type: "cities", cities: cities.map((c) => ({ ...c, rooms: undefined })), coverage: found.coverage });

  // In emerging mode the "opener" is a support-slot idea: an act the new act could open for. Capped at
  // the "sounds like" artists' popularity, so a first-tour act is not pointed at headliners far above it.
  // A new act pitches for a support slot on another act's show, so that act can be bigger, but not a
  // headliner far beyond small rooms: capped at SMALL_ROOM_POPULARITY (see the README).
  const popularity = input.artist?.popularity ?? (input.emerging ? SMALL_ROOM_POPULARITY : undefined);
  const names = input.artist ? [input.artist.name] : (input.emerging?.proxies ?? []).map((p) => p.name);
  const ctx: StopContext = { signals, who, artistType, isArtistMode: Boolean(input.artist), venueTag, popularity, usedOpeners: new Set(), names };
  // Discovery may return fewer drivable stops than asked (stated in the coverage note); a shortlist uses all.
  const stopCount = found.coverage.regional?.stops ?? input.stops;
  const stops = await Promise.all(cities.slice(0, stopCount).map(async (city, i) => {
    const stop = await scoutStop(city, i, ctx, step);
    out.push({ type: "stop", stop: structuredClone(stop) });
    return stop;
  }));

  await Promise.all([fingerprint, crossDomain]);
  return { fan, cities: cities.map((c) => ({ ...c, rooms: undefined })), stops, ledger, coverage: found.coverage };
}
