/* eslint-disable @typescript-eslint/no-explicit-any -- raw harness JSON is narrowed into typed shapes at this boundary */
/**
 * Qloo client built on the official @qloo/qloo-harness CLI, the event's supported surface.
 *
 * - Validated workflows (find_tags, describe, entity_tags, recommend, rank, where_popular,
 *   audience_demographics, compare_audiences) run through `qloo exec <workflow>`, which returns the
 *   harness's normalized envelope and request provenance.
 * - Signal heatmaps with tags or several entities have no workflow (where_popular takes one entity),
 *   so they run through `qloo api insights` with the documented heatmap parameters.
 *
 * The credential never passes through this module: the harness reads QLOO_API_KEY from the server
 * environment or from its private config written by `qloo setup --qloo`.
 * Without a usable credential the client runs in mock mode with clearly labelled sample data.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import geohash from "ngeohash";
import { mock } from "./qloo-mock.ts";

export const QLOO_BASE_URL = process.env.QLOO_BASE_URL?.trim() || "https://hackathon.api.qloo.com";
const QLOO_BIN = process.env.QLOO_BIN?.trim() || "qloo";
const TIMEOUT_MS = 45_000;
const MAX_CONCURRENT = Math.max(1, Number(process.env.QLOO_CONCURRENCY) || 4);
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
async function cached<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; ms: number; cached: boolean }> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { value: hit.value as T, ms: 0, cached: true };
  const started = Date.now();
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return { value, ms: Date.now() - started, cached: false };
}

/** Runs one validated workflow through `qloo exec`; returns the harness envelope and timing. */
async function execWorkflow(operation: string, input: Record<string, unknown>) {
  return cached(`exec:${operation}:${JSON.stringify(input)}`, async () => {
    const envelope = JSON.parse(await run(["exec", operation], JSON.stringify(input)));
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

/** entity_tags: the tags most associated with the audience of the given entities. */
export async function entityTags(entityIds: string[], limit = 10): Promise<{ tags: Tag[]; call: QlooCall }> {
  if (await isMock()) return mock.entityTags(entityIds);
  const r = await execWorkflow("entity_tags", { entities: entityIds, limit });
  const tags: Tag[] = (r.value.results ?? []).filter((t: any) => t?.id).map((t: any) => ({ id: t.id, name: t.name, type: t.type, affinity: num(t.affinity) }));
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
  if (p.demographic) input.demographic = p.demographic;
  const r = await execWorkflow("recommend", input);
  const entities = (r.value.results ?? []).filter((e: any) => e?.entity_id).map(toEntity);
  return { entities, call: callFrom("recommend", r, entities.length) };
}

/** rank: order a user-supplied shortlist (e.g. candidate cities) by affinity for the signals. */
export async function rankOptions(p: { options: string[]; optionType: InsightsType; signals: string[] }): Promise<{ entities: QEntity[]; call: QlooCall }> {
  if (await isMock()) return mock.rank(p);
  const r = await execWorkflow("rank", { options: p.options, option_type: p.optionType, signals: p.signals });
  if (r.value.status === "needs_input") {
    const names = (r.value.resolution?.issues ?? []).map((i: any) => i.input).join(", ");
    throw new QlooError(`Qloo could not resolve: ${names}`, "QLOO_NEEDS_INPUT");
  }
  const entities = (r.value.results ?? []).filter((e: any) => e?.entity_id).map(toEntity);
  return { entities, call: callFrom("rank", r, entities.length) };
}

/** where_popular: where the audience of one entity is concentrated within a location. */
export async function wherePopular(entityId: string, within: string, limit = 15): Promise<{ cells: AreaScore[]; call: QlooCall }> {
  if (await isMock()) return mock.heatmap(`${within}:${entityId}`, "where_popular");
  const r = await execWorkflow("where_popular", { entity: entityId, within, limit });
  const cells = (r.value.results ?? []).map(toAreaScore).filter(Boolean) as AreaScore[];
  return { cells, call: callFrom("where_popular", r, cells.length) };
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
 * compare_audiences: how two audiences' tastes overlap. The response shape is verified in M0;
 * until then the adapter collects named items from the result tolerantly.
 */
export async function compareAudiences(groupA: string[], groupB: string[], limit = 8): Promise<{ shared: string[]; call: QlooCall }> {
  if (await isMock()) return mock.compare();
  const r = await execWorkflow("compare_audiences", { group_a: groupA, group_b: groupB, limit });
  const results = r.value.results;
  const list: any[] = Array.isArray(results) ? results : Object.values(results ?? {}).find(Array.isArray) ?? [];
  const shared = list.map((x) => x?.name).filter((n): n is string => typeof n === "string").slice(0, limit);
  return { shared, call: callFrom("compare_audiences", r, list.length) };
}

/** Signal heatmap for a location from tags and/or several entities (raw /v2/insights via `qloo api`). */
export async function signalHeatmap(p: { location: string; tagIds?: string[]; entityIds?: string[]; age?: string }): Promise<{ cells: AreaScore[]; call: QlooCall }> {
  if (await isMock()) return mock.heatmap(`${p.location}:${(p.entityIds ?? p.tagIds ?? []).join(",")}`, "heatmap");
  const params: Record<string, string | number> = { "filter.type": "urn:heatmap", "filter.location.query": p.location, take: 50 };
  if (p.tagIds?.length) params["signal.interests.tags"] = p.tagIds.join(",");
  if (p.entityIds?.length) params["signal.interests.entities"] = p.entityIds.join(",");
  if (p.age) params["signal.demographics.age"] = p.age;
  const r = await cached(`heatmap:${JSON.stringify(params)}`, async () => {
    // -t is required by the CLI; filter.type in --params overrides it with urn:heatmap.
    const data = JSON.parse(await run(["api", "insights", "-t", "place", "--params", JSON.stringify(params), "--json"]));
    if (data.error) {
      // The legacy CLI reports HTTP failures as API_ERROR with the status in the message.
      const message = String(data.message ?? data.code ?? "unknown error");
      const code = /\b40[13]\b/.test(message) ? "QLOO_AUTH" : /\b429\b/.test(message) ? "QLOO_RATE_LIMIT" : data.code ?? "QLOO_ERROR";
      throw new QlooError(`Qloo heatmap failed: ${message}`, code, /\b(429|5\d\d)\b/.test(message));
    }
    return data;
  });
  const raw = Array.isArray(r.value.results) ? r.value.results : r.value.results?.heatmap ?? [];
  const cells = raw.map(toAreaScore).filter(Boolean) as AreaScore[];
  return {
    cells,
    call: { workflow: "heatmap (signals)", surface: "qloo api", status: cells.length ? "ok" : "empty", requests: [{ method: "GET", path: "/v2/insights", query: params }], resultCount: cells.length, ms: r.ms, cached: r.cached },
  };
}

/** Tag-signal heatmap of a city (used by the café advisor). */
export const tasteHeatmap = (city: string, tagIds: string[], age?: string) => signalHeatmap({ location: city, tagIds, age });
