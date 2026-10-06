/**
 * M0 data spike for Tour Scout: does Qloo cover the artists and places the product needs?
 *
 *   npm run qloo:verify-tour
 *
 * About 16 small Qloo requests. Prints coverage and per-call latency; raw responses go to
 * .cache/qloo-verify-tour/ (git-ignored) for checking adapter shapes. Prints no credentials.
 */
process.env.QLOO_DEBUG_DIR ??= ".cache/qloo-verify-tour";
const q = await import("../src/lib/qloo.ts");

const mode = await q.qlooMode();
console.log(`Qloo ${q.QLOO_BASE_URL} · ${mode.mock ? "MOCK" : "live"} (${mode.reason})`);
if (mode.mock) {
  console.error("No usable Qloo credential. Run `npm run qloo:key` or `qloo setup --qloo` first.");
  process.exit(1);
}

const timings: number[] = [];
async function probe<T extends { call: { ms?: number } }>(label: string, fn: () => Promise<T>, describe: (v: T) => string) {
  try {
    const v = await fn();
    if (v.call.ms) timings.push(v.call.ms);
    console.log(`  ✓ ${label} (${v.call.ms ?? 0} ms): ${describe(v)}`);
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

const cases = [
  { name: "Phoebe Bridgers", kind: "artist" as const, region: "United States", city: "Chicago" },
  { name: "Cedric the Entertainer", kind: "person" as const, region: "United States", city: "Atlanta" },
  { name: "Taylor Swift", kind: "artist" as const, region: "United States", city: "Nashville" },
  { name: "Prateek Kuhad", kind: "artist" as const, region: "India", city: "Mumbai" },
];
let firstPlace: string | undefined, firstArtist: string | undefined, secondArtist: string | undefined;
for (const c of cases) {
  console.log(`\n${c.name} (${c.kind})`);
  const r = await probe("describe", () => q.describeEntity(c.name, c.kind), (v) =>
    v.status === "resolved" ? `${v.entity.name} · popularity ${v.entity.popularity}` : v.status === "ambiguous" ? `ambiguous: ${v.candidates.map((x) => x.name).join(" | ")}` : "not found");
  const id = r?.status === "resolved" ? r.entity.id : r?.status === "ambiguous" ? r.candidates[0].id : undefined;
  if (!id) continue;
  if (c.kind === "artist") { if (!firstArtist) firstArtist = id; else secondArtist ??= id; }
  await probe(`cities in ${c.region}`, () => q.recommend({ targetType: "locality", signals: [id], filterLocation: c.region, limit: 8 }),
    (v) => v.entities.map((e) => `${e.name}${e.lat !== undefined ? "" : " (no geocode)"} ${e.affinity?.toFixed(2) ?? "?"}`).join(", ") || "none");
  await probe(`where_popular in ${c.city}`, () => q.wherePopular(id, c.city, 15),
    (v) => `${v.cells.length} cells spanning ~${km(v.cells)} km (neighbourhood-level if several cells within a city)`);
  const places = await probe(`venues in ${c.city}`, () => q.recommend({ targetType: "place", signals: [id], filterLocation: c.city, limit: 4 }),
    (v) => v.entities.map((e) => e.name).join(", ") || "none");
  firstPlace ??= places?.entities[0]?.id;
}

console.log("\nVenue type tags");
for (const query of ["live music venue", "comedy club"]) {
  await probe(`find_tags "${query}"`, () => q.findTags(query, 3), (v) => v.tags.map((t) => `${t.name} (${t.id})`).join(", ") || "none");
}
if (firstArtist && secondArtist) {
  console.log("\nAudience overlap");
  await probe("compare_audiences", () => q.compareAudiences([firstArtist!], [secondArtist!], 6), (v) => v.shared.join(", ") || "no named items parsed: inspect the raw dump");
}
if (timings.length) {
  const sorted = [...timings].sort((a, b) => a - b);
  console.log(`\nLatency per call (incl. ~0.5 s harness start): median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted[sorted.length - 1]} ms over ${sorted.length} calls`);
}
console.log(`Raw responses: ${process.env.QLOO_DEBUG_DIR}`);
