/**
 * One small live call per Qloo workflow the app uses, checked against the app's own adapters.
 *
 *   npm run qloo:verify [city]
 *
 * Raw harness output is saved to .cache/qloo-verify/ (git-ignored) so adapter mismatches can be
 * diagnosed against the real response shape. Makes about 8 Qloo requests; prints no credentials.
 */
process.env.QLOO_DEBUG_DIR ??= ".cache/qloo-verify";
const { audienceDemographics, findTags, qlooMode, QLOO_BASE_URL, recommend, tasteHeatmap, wherePopular } = await import("../src/lib/qloo.ts");

const city = process.argv[2] ?? "Pune";
const mode = await qlooMode();
console.log(`Qloo base URL: ${QLOO_BASE_URL} · mode: ${mode.mock ? "MOCK" : "live"} (${mode.reason})`);
if (mode.mock) {
  console.error("No usable Qloo credential. Run `npm run qloo:key` or `qloo setup --qloo` first.");
  process.exit(1);
}

let failures = 0;
async function check<T>(name: string, fn: () => Promise<T>, assert: (v: T) => string | undefined): Promise<T | undefined> {
  try {
    const value = await fn();
    const problem = assert(value);
    console.log(`${problem ? "✗" : "✓"} ${name}${problem ? ` — ${problem}` : ""}`);
    if (problem) failures++;
    return value;
  } catch (e) {
    failures++;
    console.log(`✗ ${name} — ${(e as Error).message}`);
    return undefined;
  }
}
const isScore = (n: unknown) => typeof n === "number" && Number.isFinite(n);

const tags = await check("find_tags", () => findTags("specialty coffee", 5),
  ({ tags }) => (tags.length ? (tags.every((t) => t.id.startsWith("urn:tag:")) ? undefined : "tag ids are not urn:tag:…") : "no tags returned"));
const tagIds = tags?.tags.slice(0, 2).map((t) => t.id) ?? [];
console.log(`  using tags: ${tags?.tags.slice(0, 2).map((t) => `${t.name} (${t.id})`).join(", ")}`);

await check("heatmap (qloo api insights)", () => tasteHeatmap(city, tagIds),
  ({ cells }) => (!cells.length ? "no cells parsed" : cells.every((c) => isScore(c.lat) && isScore(c.lng) && isScore(c.affinity)) ? undefined : "cells missing lat/lng/affinity"));

const venues = await check("recommend (places)", () => recommend({ targetType: "place", tagIds, filterLocation: city, limit: 5 }),
  ({ entities }) => (entities.length ? (entities.every((e) => e.id && e.name) ? undefined : "entities missing id/name") : "no venues returned"));

await check("recommend (artists)", () => recommend({ targetType: "artist", tagIds, signalLocation: city, limit: 5 }),
  ({ entities }) => (entities.length ? undefined : "no artists returned"));

const anchor = venues?.entities[0];
if (anchor) {
  console.log(`  anchor venue: ${anchor.name}`);
  await check("where_popular", () => wherePopular(anchor.id, city, 10),
    ({ cells }) => (cells.length ? undefined : "no cells parsed (check result shape in .cache/qloo-verify)"));
  await check("audience_demographics", () => audienceDemographics(anchor.id),
    ({ demographics }) => (Object.keys(demographics.age).length ? undefined : "no age buckets parsed (check result shape in .cache/qloo-verify)"));
}

console.log(failures ? `\n${failures} check(s) failed. Raw output: ${process.env.QLOO_DEBUG_DIR}` : `\nAll adapters match the live responses. Raw output: ${process.env.QLOO_DEBUG_DIR}`);
process.exit(failures ? 1 : 0);
