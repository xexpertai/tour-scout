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

test("a slow fan map falls back fast: the last good map (labelled with its date), else a quick timeout", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/heat-`);
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/where-popular-us-big-thief.json", import.meta.url), "utf8")).output;
  writeFileSync(`${dir}/out.json`, JSON.stringify(fixture));
  // A stand-in harness: ready, and where_popular either answers or hangs (SLOW=1).
  const bin = `${dir}/qloo`;
  writeFileSync(bin, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "setup") { console.log(JSON.stringify({ qloo: { ready: true, source: "environment" } })); process.exit(0); }
process.stdin.resume(); process.stdin.on("end", () => {
  if (process.env.SLOW === "1") setTimeout(() => {}, 60000);
  else console.log(require("fs").readFileSync(${JSON.stringify(`${dir}/out.json`)}, "utf8"));
});`);
  chmodSync(bin, 0o755);
  const run = (dataDir: string, slow: boolean) => {
    const script = `const q=await import(${JSON.stringify(new URL("../src/lib/qloo.ts", import.meta.url).href)});const t=Date.now();let r;try{const h=await q.fanHeatmap(["X"],"United States",20);r={cells:h.cells.length,savedAt:Boolean(h.savedAt),status:h.call.status}}catch(e){r={code:e.code}}r.ms=Date.now()-t;console.log(JSON.stringify(r))`;
    return JSON.parse(execFileSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", script],
      { env: { ...process.env, QLOO_MOCK: "", QLOO_CACHE_DIR: "", QLOO_BIN: bin, QLOO_API_KEY: "dummy", DATA_DIR: dataDir, SLOW: slow ? "1" : "", QLOO_HEATMAP_TIMEOUT_MS: "800" } }).toString());
  };
  const live = run(`${dir}/a`, false);
  assert.ok(live.cells > 0 && !live.savedAt, JSON.stringify(live));
  const saved = run(`${dir}/a`, true);
  assert.deepEqual([saved.savedAt, saved.status, saved.cells], [true, "saved", live.cells]);
  assert.ok(saved.ms < 5000, `fell back in ${saved.ms} ms`);
  const none = run(`${dir}/b`, true);
  assert.equal(none.code, "QLOO_TIMEOUT");
  assert.ok(none.ms < 5000, `timed out in ${none.ms} ms`);
});

test("model spend has a persisted hard ceiling per budget period; past it, calls are refused (templated text)", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/spend-`);
  const step = (code: string, period = "judging") => JSON.parse(execFileSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e",
    `const l=await import(${JSON.stringify(new URL("../src/lib/llm.ts", import.meta.url).href)});console.info=()=>{};let r;try{${code};r="ok"}catch(e){r=e.code+": "+e.message}console.log(JSON.stringify(r))`],
    { env: { ...process.env, DATA_DIR: dir, LLM_SPEND_CAP_USD: "0.2", LLM_DAILY_CAP: "100", LLM_BUDGET_PERIOD: period } }).toString());
  assert.equal(step(`l.takeDailyBudget();l.logUsage("claude","m",{input:20000,output:30000})`), "ok"); // $0.17: with the $0.05 reserve, over $0.20
  assert.match(step(`l.takeDailyBudget()`), /^LLM_QUOTA: AI text paused/, "a restart does not reset the spend");
  assert.equal(step(`l.takeDailyBudget()`, "next-period"), "ok", "a new budget period starts at $0");
});

test("no Qloo key in production: live runs are refused with a clear message; a dead key fails fast with the same message", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/nokey-`);
  // A stand-in harness: no credential configured, or a credential Qloo rejects.
  const bin = `${dir}/qloo`;
  writeFileSync(bin, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "setup") { console.log(JSON.stringify({ qloo: { ready: process.env.DEAD === "1", source: "environment" } })); process.exit(0); }
process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({ error: { code: "QLOO_AUTH", retryable: false }, operation: a[1] })));`);
  chmodSync(bin, 0o755);
  const run = (dead: boolean) => JSON.parse(execFileSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e",
    `const q=await import(${JSON.stringify(new URL("../src/lib/qloo.ts", import.meta.url).href)});const t=Date.now();let code="";try{await q.describeEntity("Big Thief","artist")}catch(e){code=e.code+": "+e.message}console.log(JSON.stringify({off:await q.liveUnavailable(),code,ms:Date.now()-t}))`],
    { env: { ...process.env, NODE_ENV: "production", QLOO_MOCK: "", QLOO_CACHE_DIR: "", QLOO_BIN: bin, QLOO_API_KEY: dead ? "dead" : "", DEAD: dead ? "1" : "" } }).toString());
  const none = run(false);
  assert.match(none.off ?? "", /isn't available.*demo tours still work/);
  const dead = run(true);
  assert.equal(dead.off, undefined, "a configured key counts as live until Qloo rejects it");
  assert.match(dead.code, /^QLOO_AUTH: Live Qloo data isn't available.*demo tours still work/);
  assert.ok(dead.ms < 5000);
  // The demo tours and share links never call Qloo: a preset loads with no key and no harness.
  const preset = JSON.parse(execFileSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e",
    `const s=await import(${JSON.stringify(new URL("../src/lib/tour/sources.ts", import.meta.url).href)});const r=await s.planForRequest({preset:"us-emerging"});console.log(JSON.stringify(r?.plan.stops.length??0))`],
    { env: { ...process.env, NODE_ENV: "production", QLOO_BIN: "/nonexistent/qloo", QLOO_API_KEY: "", DATA_DIR: dir } }).toString());
  assert.ok(preset > 0);
});
