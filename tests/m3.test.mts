/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely typed plan JSON */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.QLOO_MOCK = "1";
process.env.GEO_OFFLINE = "1";
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "tour-scout-"));
const { planTour } = await import("../src/lib/tour/plan.ts");
const { scriptedProvider } = await import("../src/lib/llm.ts");
const { askCity, cityFromQuestion } = await import("../src/lib/tour/followup.ts");
const { savePlan, loadPlan, isPlanId } = await import("../src/lib/store.ts");
const { planToCsv } = await import("../src/components/tour/exportCsv.ts");

async function makePlan() {
  for await (const e of planTour({ artist: { id: "sample-artist-big_thief", name: "Big Thief (sample)", type: "artist" }, region: "United States", stops: 3 }, undefined, scriptedProvider)) {
    if (e.type === "plan") return e.plan;
  }
  throw new Error("no plan");
}

test("follow-up questions name a city and are answered with new, non-overlapping evidence", async () => {
  assert.equal(cityFromQuestion("Why not Chicago?"), "Chicago");
  assert.equal(cityFromQuestion("what about  Denver"), "Denver");
  const plan = await makePlan();
  const f = await askCity(plan, "Why not Denver?");
  assert.equal(f.city, "Denver");
  assert.equal(f.of, plan.stops.length + 1);
  assert.ok(f.rank !== undefined && f.rank >= 1);
  assert.equal(f.answer.kind, "template");
  const planIds = new Set(plan.sources.map((s: any) => s.id));
  for (const s of f.sources) assert.ok(!planIds.has(s.id), `${s.id} is new`);
  for (const id of f.answer.evidence) assert.ok(f.sources.some((s: any) => s.id === id));
  await assert.rejects(askCity(plan, "?"), /Name a city/);
});

test("plans round-trip through the store and ids cannot escape the plans folder", async () => {
  const plan = await makePlan();
  await savePlan(plan);
  assert.equal((await loadPlan(plan.id))?.id, plan.id);
  assert.equal(isPlanId("../../etc/passwd"), false);
  assert.equal(await loadPlan("../../etc/passwd"), undefined);
});

test("CSV export labels provenance and neutralises spreadsheet formulas", async () => {
  const plan = await makePlan();
  plan.stops[0].venues[0].name = "=HYPERLINK(\"http://evil\")";
  const csv = planToCsv(plan);
  assert.match(csv, /Fan affinity 0-100 \(Qloo\)/);
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil""\)/);
  assert.equal(csv.split("\r\n").length, 2 + plan.stops.length);
});

test("area names prefer what locals call a place over administrative districts", async () => {
  const { pickAreaName } = await import("../src/lib/geo.ts");
  assert.equal(pickAreaName({ suburb: "Brooklyn Community District 17", quarter: "East Flatbush" }, "x"), "East Flatbush");
  assert.equal(pickAreaName({ neighbourhood: "Alta Vista", suburb: "Austin" }, "x"), "Alta Vista");
  assert.equal(pickAreaName({ city_district: "H/W Ward" }, "x"), "H/W Ward", "an admin name is still better than nothing");
  assert.equal(pickAreaName({}, "18.52,73.86"), "18.52,73.86");
});

test("a configured key with a broken harness is an error, not quiet sample data", async () => {
  const { execFileSync } = await import("node:child_process");
  const script = `process.env.QLOO_BIN="/nonexistent/qloo";process.env.QLOO_API_KEY="dummy";const q=await import(${JSON.stringify(new URL("../src/lib/qloo.ts", import.meta.url).href)});const m=await q.qlooMode();let code="";try{await q.findTags("jazz")}catch(e){code=e.code}console.log(JSON.stringify({mock:m.mock,code}))`;
  const out = execFileSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", script], { env: { ...process.env, QLOO_MOCK: "" } }).toString();
  assert.deepEqual(JSON.parse(out), { mock: false, code: "QLOO_NOT_INSTALLED" });
});
