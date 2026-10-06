/**
 * M0 data spike for Tour Scout: does Qloo cover the artists and places the product needs?
 *
 *   npm run qloo:verify-tour
 *
 * About 30 small Qloo requests (fewer on a re-run within 24 h: responses are cached on disk in
 * .cache/qloo-disk). Prints coverage and per-call latency; raw responses go to .cache/qloo-verify/
 * (git-ignored) for checking adapter shapes. Prints no credentials.
 */
process.env.QLOO_DEBUG_DIR ??= ".cache/qloo-verify";
process.env.QLOO_CACHE_DIR ??= ".cache/qloo-disk";
const q = await import("../src/lib/qloo.ts");
const { nearestMarket } = await import("../src/lib/markets.ts");
const { COMEDIAN_TAGS } = await import("../src/lib/tour/pipeline.ts");

const mode = await q.qlooMode();
console.log(`Qloo ${q.QLOO_BASE_URL} · ${mode.mock ? "MOCK" : "live"} (${mode.reason})`);
if (mode.mock) {
  console.error("No usable Qloo credential. Run `npm run qloo:key` or `qloo setup --qloo` first.");
  process.exit(1);
}

const timings: number[] = [];
const runStarted = Date.now();
async function probe<T extends { call: { ms?: number; cached?: boolean } }>(label: string, fn: () => Promise<T>, describe: (v: T) => string) {
  try {
    const v = await fn();
    if (v.call.ms && !v.call.cached) timings.push(v.call.ms);
    console.log(`  ✓ ${label} (${v.call.cached ? "cached" : `${v.call.ms ?? 0} ms`}): ${describe(v)}`);
    return v;
  } catch (e) {
    console.log(`  ✗ ${label}: ${(e as Error).message}`);
    return undefined;
  }
}
const km = (cells: { lat: number; lng: number }[]) => {
  if (cells.length < 2) return 0;
  const lats = cells.map((c) => c.lat), lngs = cells.map((c) => c.lng);
  return Math.round(Math.hypot(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs)) * 111);
};

const venueTag = { artist: "urn:tag:category:place:live_music_venue", person: "urn:tag:category:place:comedy_club" };
const cases = [
  { name: "Big Thief", kind: "artist" as const, region: "United States", city: "Chicago" },
  { name: "Mark Normand", kind: "person" as const, region: "United States", city: "Austin, Texas" },
  { name: "Mitski", kind: "artist" as const, region: "United Kingdom", city: "London, England" },
];
const ids: string[] = [];
for (const c of cases) {
  console.log(`\n${c.name} (${c.kind})`);
  const r = await probe("describe", () => q.describeEntity(c.name, c.kind), (v) =>
    v.status === "resolved" ? `${v.entity.name} · popularity ${v.entity.popularity?.toFixed(3)}` : v.status === "ambiguous" ? `ambiguous: ${v.candidates.map((x) => x.name).join(" | ")}` : "not found");
  const id = r?.status === "resolved" ? r.entity.id : r?.status === "ambiguous" ? r.candidates[0].id : undefined;
  if (!id) continue;
  ids.push(id);
  await probe(`fan hotspots across ${c.region}`, () => q.wherePopular(id, c.region, 20), (v) => {
    const markets = new Map<string, number>();
    let remote = 0;
    for (const cell of v.cells) {
      const m = nearestMarket(cell);
      if (m) markets.set(m.name, (markets.get(m.name) ?? 0) + 1); else remote++;
    }
    return `${v.cells.length} cells → markets ${[...markets.keys()].join(", ") || "none"}; ${remote} remote`;
  });
  await probe(`rooms in ${c.city} (venue tag)`, () => q.recommend({ targetType: "place", signals: [id], includeTags: [venueTag[c.kind]], filterLocation: c.city, limit: 4 }),
    (v) => v.entities.map((e) => `${e.name} ${Math.round((e.affinity ?? 0) * 100)}`).join(", ") || "none");
  await probe(`where_popular in ${c.city}`, () => q.wherePopular(id, c.city, 10),
    (v) => `${v.cells.length} cells spanning ~${km(v.cells)} km (neighbourhood-level)`);
  await probe(`openers in ${c.city}`, () => q.recommend({ targetType: c.kind, signals: [id], signalLocation: c.city, limit: 5, ...(c.kind === "person" ? { includeTags: COMEDIAN_TAGS, includeTagsOperator: "union" as const } : {}) }),
    (v) => v.entities.map((e) => `${e.name} (pop ${e.popularity?.toFixed(2)})`).join(", ") || "none");
  await probe("entity_tags (taste tags only)", () => q.entityTags([id], 8), (v) => v.tags.map((t) => t.name).join(", ") || "none");
}

console.log("\nVenue type tags");
for (const query of ["live music venue", "comedy club"]) {
  await probe(`find_tags "${query}"`, () => q.findTags(query, 3), (v) => v.tags.map((t) => `${t.name} (${t.id})`).join(", ") || "none");
}
if (ids.length) {
  console.log("\nAudience");
  await probe("audience_demographics", () => q.audienceDemographics(ids[0]), (v) => `age ${Object.keys(v.demographics.age).length} buckets, gender ${Object.keys(v.demographics.gender).length}`);
  if (ids.length > 2) await probe("compare_audiences", () => q.compareAudiences([ids[0]], [ids[2]], 6), (v) => v.shared.join(", ") || "none");
}
if (timings.length) {
  const sorted = [...timings].sort((a, b) => a - b);
  console.log(`\nLatency per uncached call (incl. ~0.5 s harness start): median ${sorted[Math.floor(sorted.length / 2)]} ms, p90 ${sorted[Math.floor(sorted.length * 0.9)]} ms, max ${sorted[sorted.length - 1]} ms over ${sorted.length} calls`);
}
console.log(`Total run time: ${Math.round((Date.now() - runStarted) / 1000)} s (sequential). Raw responses: ${process.env.QLOO_DEBUG_DIR}`);
