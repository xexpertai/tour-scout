/* eslint-disable @typescript-eslint/no-explicit-any -- raw harness JSON is narrowed into typed shapes at this boundary */
/**
 * Qloo client built on the official @qloo/qloo-harness CLI, the event's supported surface.
 *
 * Every call runs a validated workflow (find_tags, describe, entity_tags, recommend, where_popular,
 * audience_demographics, compare_audiences) through `qloo exec <workflow>`, which returns the
 * harness's normalized envelope and request provenance.
 *
 * Verified against the hackathon API (M0, 6 Oct 2026):
 * - `recommend`/`rank` accept no `locality` target, so cities come from a country-wide
 *   `where_popular` heatmap (see tour/cities.ts), not from locality recommendations.
 * - `qloo api insights` prints only `results.entities`, so heatmaps cannot go through it; several
 *   signals (emerging-act mode) use one `where_popular` per signal, merged per map cell.
 * - Place results carry `properties.geocode` (city, neighbourhood) and an address but no coordinates.
 *
 * The credential never passes through this module: the harness reads QLOO_API_KEY from the server
 * environment or from its private config written by `qloo setup --qloo`.
 * Without a usable credential the client runs in mock mode with clearly labelled sample data.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import geohash from "ngeohash";
import { mock } from "./qloo-mock.ts";

export const QLOO_BASE_URL = process.env.QLOO_BASE_URL?.trim() || "https://hackathon.api.qloo.com";
const QLOO_BIN = process.env.QLOO_BIN?.trim() || "qloo";
const TIMEOUT_MS = 45_000;
// 3 parallel harness processes: at 4 the event key hit 429s during back-to-back tours (M0).
const MAX_CONCURRENT = Math.max(1, Number(process.env.QLOO_CONCURRENCY) || 3);
/** After the harness's own 429 retries (3 attempts, Retry-After up to 30 s), wait this long and retry once. */
const RATE_LIMIT_RETRY_MS = Number(process.env.QLOO_RATE_LIMIT_RETRY_MS ?? 8000);
const CACHE_TTL_MS = 60 * 60 * 1000;

export type QlooRequest = { method: string; path: string; query: Record<string, unknown> };
/** One Qloo call as shown to the user: what was asked, through which surface, and what came back. */
export type QlooCall = {
  workflow: string;
  surface: "qloo exec" | "qloo api" | "mock";
  status: string;
  summary?: string;
  requests: QlooRequest[];
  resultCount: number;
  ms?: number;
  cached?: boolean;
};
export type Tag = { id: string; name: string; type?: string; affinity?: number };
export type AreaScore = { geohash: string; lat: number; lng: number; affinity: number; popularity?: number };
/** Any Qloo entity (artist, person, place, locality, brand, …) narrowed to the fields the app uses. */
export type QEntity = {
  id: string; name: string; type?: string; affinity?: number; popularity?: number;
  address?: string; lat?: number; lng?: number; rating?: number; description?: string;
  /** Places only: Qloo's geocode labels (no coordinates on the hackathon API). */
  city?: string; area?: string;
};
export type Venue = QEntity;
export type Entity = QEntity;
/** Relative affinity per demographic bucket (Qloo returns over/under-index scores, not population shares). */
export type Demographics = { age: Record<string, number>; gender: Record<string, number> };
export type InsightsType = "artist" | "person" | "place" | "locality" | "brand" | "movie" | "tv_show" | "book" | "podcast";

export class QlooError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly recovery?: string;
  constructor(message: string, code: string, retryable = false, recovery?: string) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.recovery = recovery;
  }
}

// ---------------------------------------------------------------- mode detection
let modeCache: { mock: boolean; reason: string; at: number } | undefined;

/** Live when the harness reports a usable credential; otherwise mock. QLOO_MOCK=1 forces mock. */
export async function qlooMode(): Promise<{ mock: boolean; reason: string }> {
  if (process.env.QLOO_MOCK === "1") return { mock: true, reason: "QLOO_MOCK=1" };
  if (modeCache && Date.now() - modeCache.at < 60_000) return modeCache;
  let next: { mock: boolean; reason: string };
  try {
    const status = JSON.parse(await run(["setup", "--status", "--json"]));
    next = status.qloo?.ready ? { mock: false, reason: `credential from ${status.qloo.source}` } : { mock: true, reason: "no Qloo credential configured" };
  } catch (e) {
    // With a key configured, a broken harness must surface as an error, never as quiet sample data.
    next = process.env.QLOO_API_KEY
      ? { mock: false, reason: "credential set, but the qloo harness is unavailable" }
      : { mock: true, reason: e instanceof QlooError ? e.message : "qloo harness unavailable" };
  }
  modeCache = { ...next, at: Date.now() };
  return next;
}
const isMock = async () => (await qlooMode()).mock;

// ---------------------------------------------------------------- process runner
let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function run(args: string[], stdin?: string): Promise<string> {
  return withSlot(() => new Promise((resolve, reject) => {
    // The binary path is runtime config; the ignore comment stops the bundler tracing the whole project.
    const child = spawn(/*turbopackIgnore: true*/ QLOO_BIN, args, {
      // The harness only trusts a non-production base URL when QLOO_TRUSTED_BASE_URL matches it.
      env: { ...process.env, QLOO_BASE_URL, QLOO_TRUSTED_BASE_URL: process.env.QLOO_TRUSTED_BASE_URL?.trim() || QLOO_BASE_URL, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new QlooError("Qloo request timed out", "QLOO_TIMEOUT", true)); }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === "ENOENT"
        ? new QlooError("The qloo harness is not installed on this server", "QLOO_NOT_INSTALLED", false, "npm install --global @qloo/qloo-harness")
        : e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      // Both CLIs print a JSON body (result or error) on stdout; a non-zero exit is decided by that body.
      if (out.trim()) {
        dumpRaw(args, stdin, out);
        resolve(out);
      } else reject(new QlooError(`qloo ${args[0]} produced no output: ${err.trim().slice(0, 200)}`, "QLOO_NO_OUTPUT", true));
    });
    child.stdin.end(stdin ?? "");
  }));
}

/** With QLOO_DEBUG_DIR set, raw harness output is saved so the adapters can be checked against real responses. */
let dumpCount = 0;
function dumpRaw(args: string[], stdin: string | undefined, out: string) {
  const dir = process.env.QLOO_DEBUG_DIR;
  if (!dir || args[0] === "setup") return;
  try {
    mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
    const name = `${String(++dumpCount).padStart(2, "0")}-${args.slice(0, 2).join("-")}.json`;
    writeFileSync(/*turbopackIgnore: true*/ `${dir}/${name}`, JSON.stringify({ args, input: stdin ? JSON.parse(stdin) : undefined, output: JSON.parse(out) }, null, 2));
  } catch {
    // Debug output only; never fail a request because of it.
  }
}

const cache = new Map<string, { at: number; value: unknown }>();
/**
 * Optional on-disk cache for scripts (verification, preset capture) so repeated runs during
 * development do not spend event quota. Enabled only when QLOO_CACHE_DIR is set; entries expire
 * after QLOO_CACHE_TTL_H hours (default 24). Stores Qloo responses only, never credentials.
 */
const DISK_DIR = process.env.QLOO_CACHE_DIR?.trim();
const DISK_TTL_MS = (Number(process.env.QLOO_CACHE_TTL_H) || 24) * 3600_000;
const diskPath = (key: string) => `${DISK_DIR}/${createHash("sha1").update(key).digest("hex")}.json`;
function diskGet(key: string): { at: number; value: unknown } | undefined {
  if (!DISK_DIR) return undefined;
  try {
    const hit = JSON.parse(readFileSync(/*turbopackIgnore: true*/ diskPath(key), "utf8"));
    return Date.now() - hit.at < DISK_TTL_MS ? hit : undefined;
  } catch {
    return undefined;
  }
}
function diskSet(key: string, entry: { at: number; value: unknown }) {
  if (!DISK_DIR) return;
  try {
    mkdirSync(/*turbopackIgnore: true*/ DISK_DIR, { recursive: true });
    writeFileSync(/*turbopackIgnore: true*/ diskPath(key), JSON.stringify(entry));
  } catch {
    // An optimisation only.
  }
}
async function cached<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; ms: number; cached: boolean }> {
  const hit = cache.get(key) ?? diskGet(key);
  if (hit && Date.now() - hit.at < Math.max(CACHE_TTL_MS, DISK_DIR ? DISK_TTL_MS : 0)) return { value: hit.value as T, ms: 0, cached: true };
  const started = Date.now();
  const value = await fn();
  const entry = { at: Date.now(), value };
  cache.set(key, entry);
  diskSet(key, entry);
  return { value, ms: Date.now() - started, cached: false };
}

/** Runs one validated workflow through `qloo exec`; returns the harness envelope and timing. */
async function execWorkflow(operation: string, input: Record<string, unknown>) {
  return cached(`exec:${operation}:${JSON.stringify(input)}`, async () => {
    let envelope = JSON.parse(await run(["exec", operation], JSON.stringify(input)));
    // The harness's recovery advice for a rate limit is to wait for the window and retry once.
    if (envelope.error?.code === "QLOO_RATE_LIMIT" && RATE_LIMIT_RETRY_MS > 0) {
      await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS * (0.75 + Math.random() / 2)));
      envelope = JSON.parse(await run(["exec", operation], JSON.stringify(input)));
    }
    if (envelope.error && !envelope.status) {
      const { code = "QLOO_ERROR", retryable = false, recovery } = envelope.error;
      throw new QlooError(`Qloo ${operation} failed (${code})`, code, retryable, recovery);
    }
    if (envelope.status === "error") {
      const { code = "QLOO_ERROR", retryable = false, recovery } = envelope.error ?? {};
      throw new QlooError(envelope.summary || `Qloo ${operation} failed (${code})`, code, retryable, recovery);
    }
    return envelope as any;
  });
}

const callFrom = (workflow: string, run: { value: any; ms: number; cached: boolean }, resultCount: number): QlooCall => ({
  workflow,
  surface: "qloo exec",
  status: run.value.status,
  summary: run.value.summary,
  requests: (run.value.provenance?.requests ?? []).map((r: any) => ({ method: r.method ?? "GET", path: r.path, query: r.query ?? {} })),
  resultCount,
  ms: run.ms,
  cached: run.cached,
});

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function toAreaScore(h: any): AreaScore | undefined {
  const loc = h?.location ?? {};
  const gh: string | undefined = loc.geohash ?? h?.geohash;
  let lat = num(loc.latitude) ?? num(loc.lat), lng = num(loc.longitude) ?? num(loc.lon) ?? num(loc.lng);
  if ((lat === undefined || lng === undefined) && gh) ({ latitude: lat, longitude: lng } = geohash.decode(gh));
  if (lat === undefined || lng === undefined) return undefined;
  return { geohash: gh ?? geohash.encode(lat, lng, 6), lat, lng, affinity: num(h?.query?.affinity) ?? 0, popularity: num(h?.query?.popularity) };
}

function toEntity(e: any): QEntity {
  const props = e.properties ?? {};
  const geo = props.geocode ?? e.location ?? {};
  return {
    id: e.entity_id ?? e.id, name: e.name, type: e.type ?? e.subtype,
    affinity: num(e.affinity) ?? num(e.query?.affinity), popularity: num(e.popularity),
    address: typeof props.address === "string" ? props.address : undefined,
    lat: num(geo.latitude) ?? num(geo.lat), lng: num(geo.longitude) ?? num(geo.lon) ?? num(geo.lng),
    rating: num(props.business_rating),
    city: typeof geo.city === "string" ? geo.city : undefined, area: typeof geo.name === "string" ? geo.name : undefined,
    description: typeof props.short_description === "string" ? props.short_description : typeof props.description === "string" ? props.description : undefined,
  };
}

// ---------------------------------------------------------------- workflows

/** find_tags: map a free-text concept to candidate Qloo tags (semantic search). */
export async function findTags(query: string, limit = 6): Promise<{ tags: Tag[]; call: QlooCall }> {
  if (await isMock()) return mock.findTags(query);
  const r = await execWorkflow("find_tags", { query, limit });
  const tags: Tag[] = (r.value.results ?? []).filter((t: any) => t?.id).map((t: any) => ({ id: t.id, name: t.name, type: t.type }));
  return { tags, call: callFrom("find_tags", r, tags.length) };
}

export type Resolution =
  | { status: "resolved"; entity: QEntity; call: QlooCall }
  | { status: "ambiguous"; candidates: QEntity[]; call: QlooCall }
  | { status: "not_found"; call: QlooCall };

/** describe: resolve a name to one Qloo entity, or return the candidates when the name is ambiguous. */
export async function describeEntity(name: string, type?: "artist" | "person" | "place" | "locality"): Promise<Resolution> {
  if (await isMock()) return mock.describe(name, type);
  const r = await execWorkflow("describe", type ? { entity: name, type } : { entity: name });
  const env = r.value;
  if (env.status === "needs_input") {
    const issue = env.resolution?.issues?.[0] ?? {};
    const candidates: QEntity[] = (issue.candidates ?? []).map((c: any) => ({ id: c.id, name: c.name, type: c.type, popularity: num(c.popularity), description: c.description }));
    return candidates.length
      ? { status: "ambiguous", candidates, call: callFrom("describe", r, candidates.length) }
      : { status: "not_found", call: callFrom("describe", r, 0) };
  }
  const first = (env.results ?? [])[0];
  if (!first) return { status: "not_found", call: callFrom("describe", r, 0) };
  return { status: "resolved", entity: toEntity(first), call: callFrom("describe", r, 1) };
}

/**
 * Which tags may describe an audience. entity_tags has no tag-type filter and, for an act, returns a
 * mix of place/business tags (payment cards, hotel stars, dishes), media keywords, and identity tags
 * (ethnicity, sexuality). Only taste families are kept: Qloo's theme, artist, style, audience and
 * category tags, and any music tag family. Identity terms are dropped even inside those families,
 * so the app never describes fans by sensitive traits (SAFE_USE).
 */
const TASTE_TAG_TYPE = /^urn:tag:(theme|artist|style|audience|category):qloo$|^urn:tag:[a-z_]+:music$/;
const SENSITIVE_TERM = /\b(ethnic\w*|african|black|white|asian|latin[ao]?|hispanic|indigenous|lesbian|gay|queer|lgbt\w*|trans\w*|religio\w*|muslim|hindu|christian|jewish|sikh|caste|politic\w*|conservative|liberal|disab\w*|health|income|wealth\w*|affluent|low.income)\b/i;
export const isAudienceTag = (t: { id?: string; type?: string; name?: string }) => {
  const type = t.type ?? t.id?.split(":").slice(0, 4).join(":") ?? "";
  return TASTE_TAG_TYPE.test(type) && !SENSITIVE_TERM.test(t.name ?? "");
};

/** entity_tags: the tags most associated with the audience of the given entities (taste tags only). */
export async function entityTags(entityIds: string[], limit = 10): Promise<{ tags: Tag[]; call: QlooCall }> {
  if (await isMock()) return mock.entityTags(entityIds);
  // Ask for the maximum and filter, since place and business tags crowd the top of the list.
  const r = await execWorkflow("entity_tags", { entities: entityIds, limit: 20 });
  const seen = new Set<string>();
  const tags: Tag[] = (r.value.results ?? []).filter((t: any) => t?.id && typeof t.name === "string" && t.name.trim() && isAudienceTag(t))
    .map((t: any) => ({ id: t.id, name: t.name.trim(), type: t.type, affinity: num(t.affinity) }))
    // Different tag families can carry the same name ("Smooth" as style and as artist trait).
    .filter((t: Tag) => !seen.has(t.name.toLowerCase()) && Boolean(seen.add(t.name.toLowerCase()))).slice(0, limit);
  return { tags, call: callFrom("entity_tags", r, tags.length) };
}

/** recommend: entities of target_type with the strongest affinity for the given signals. */
export async function recommend(p: {
  targetType: InsightsType;
  signals?: string[];
  tagIds?: string[];
  signalLocation?: string;
  filterLocation?: string;
  includeTags?: string[];
  /** How several include_tags combine; Qloo's default is intersection. */
  includeTagsOperator?: "union" | "intersection";
  demographic?: string;
  limit?: number;
}): Promise<{ entities: QEntity[]; call: QlooCall }> {
  if (await isMock()) return mock.recommend(p);
  const input: Record<string, unknown> = { target_type: p.targetType, limit: p.limit ?? 8, explain: false };
  if (p.signals?.length) input.signals = p.signals;
  if (p.tagIds?.length) {
    input.signal_tags = p.tagIds;
    // Union: any of the concept's tags is a valid signal; intersection of 3+ tags is often empty.
    input.signal_tags_operator = "union";
  }
  if (p.signalLocation) input.signal_location = p.signalLocation;
  if (p.filterLocation) input.filter_location = p.filterLocation;
  if (p.includeTags?.length) input.include_tags = p.includeTags;
  if (p.includeTags?.length && p.includeTagsOperator) input.include_tags_operator = p.includeTagsOperator;
  if (p.demographic) input.demographic = p.demographic;
  const r = await execWorkflow("recommend", input);
  const entities = (r.value.results ?? []).filter((e: any) => e?.entity_id).map(toEntity);
  return { entities, call: callFrom("recommend", r, entities.length) };
}

/** where_popular: where the audience of one entity is concentrated within a location. */
export async function wherePopular(entityId: string, within: string, limit = 15): Promise<{ cells: AreaScore[]; call: QlooCall }> {
  if (await isMock()) return mock.heatmap(`${within}:${entityId}`, "where_popular");
  const r = await execWorkflow("where_popular", { entity: entityId, within, limit });
  const cells = (r.value.results ?? []).map(toAreaScore).filter(Boolean) as AreaScore[];
  return { cells, call: callFrom("where_popular", r, cells.length) };
}

/**
 * Where the audience of one or more entities concentrates. where_popular takes one entity, so
 * several signals (emerging-act proxies, at most 3) run one call each and are merged per map cell,
 * keeping each cell's strongest affinity. The merged call lists every request.
 */
export async function fanHeatmap(entityIds: string[], within: string, limit = 15): Promise<{ cells: AreaScore[]; call: QlooCall }> {
  const ids = entityIds.slice(0, 3);
  if (ids.length <= 1) return wherePopular(ids[0], within, limit);
  const runs = await Promise.all(ids.map((id) => wherePopular(id, within, limit)));
  const merged = new Map<string, AreaScore>();
  for (const cell of runs.flatMap((x) => x.cells)) {
    const known = merged.get(cell.geohash);
    if (!known || cell.affinity > known.affinity) merged.set(cell.geohash, cell);
  }
  const cells = [...merged.values()].sort((a, b) => b.affinity - a.affinity).slice(0, limit);
  return {
    cells,
    call: {
      workflow: `where_popular ×${runs.length}`, surface: runs[0].call.surface, status: cells.length ? "ok" : "empty",
      summary: `Merged heatmaps of ${runs.length} signals`, requests: runs.flatMap((x) => x.call.requests), resultCount: cells.length,
      ms: Math.max(...runs.map((x) => x.call.ms ?? 0)), cached: runs.every((x) => x.call.cached),
    },
  };
}

/** audience_demographics: aggregate age/gender affinity of one entity's audience. */
export async function audienceDemographics(entityId: string): Promise<{ demographics: Demographics; call: QlooCall }> {
  if (await isMock()) return mock.demographics();
  const r = await execWorkflow("audience_demographics", { entity: entityId });
  const first = (r.value.results ?? [])[0] ?? {};
  const q = first.query ?? first;
  const pick = (o: any) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => typeof v === "number")) as Record<string, number>;
  return { demographics: { age: pick(q.age), gender: pick(q.gender) }, call: callFrom("audience_demographics", r, (r.value.results ?? []).length) };
}

/**
 * compare_audiences: the taste tags two audiences share (verified shape: `results.tags[]` with a
 * `query.score` each). Only taste tag families are kept (see isAudienceTag); region tags are dropped.
 */
export async function compareAudiences(groupA: string[], groupB: string[], limit = 8): Promise<{ shared: string[]; call: QlooCall }> {
  if (await isMock()) return mock.compare();
  const r = await execWorkflow("compare_audiences", { group_a: groupA, group_b: groupB, limit: Math.min(20, limit + 4) });
  const results = r.value.results;
  const list: any[] = Array.isArray(results?.tags) ? results.tags : Array.isArray(results) ? results : Object.values(results ?? {}).find(Array.isArray) ?? [];
  const shared = list.filter((x) => typeof x?.name === "string" && isAudienceTag({ id: x.tag_id ?? x.id, type: x.subtype, name: x.name }))
    .map((x) => x.name as string).slice(0, limit);
  return { shared, call: callFrom("compare_audiences", r, list.length) };
}
