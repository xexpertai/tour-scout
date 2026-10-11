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
  assert.match(csv, /Room affinity 0-100 \(Qloo\)/);
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

test("Qloo calls run in-process through the installed harness's own entry points, with spawning as the fallback", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/harness-`);
  // A stand-in harness package laid out like a global install: bin/qloo -> lib/.../dist/bin.js.
  const dist = `${dir}/lib/@qloo/qloo-harness/dist`;
  mkdirSync(dist, { recursive: true });
  mkdirSync(`${dir}/bin`);
  writeFileSync(`${dir}/lib/@qloo/qloo-harness/package.json`, JSON.stringify({ name: "@qloo/qloo-harness", type: "module" }));
  const envelope = (via: string) => JSON.stringify({ status: "ok", summary: via, results: [{ id: "urn:tag:x", name: via }] });
  writeFileSync(`${dist}/bin.js`, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "setup") { console.log(JSON.stringify({ qloo: { ready: true, source: "spawned" } })); process.exit(0); }
process.stdin.resume(); process.stdin.on("end", () => console.log(${JSON.stringify(envelope("spawned"))}));`);
  chmodSync(`${dist}/bin.js`, 0o755);
  symlinkSync(`${dist}/bin.js`, `${dir}/bin/qloo`);
  writeFileSync(`${dist}/exec.js`, `export async function runQlooExec(argv, o) {
  const input = JSON.parse(argv[argv.indexOf("--input") + 1]);
  if (input.query === "hang") return new Promise(() => {});
  o.writeOut(JSON.stringify({ status: "ok", summary: "in-process " + argv[0] + " " + input.query + " " + o.env.QLOO_TRUSTED_BASE_URL, results: [{ id: "urn:tag:x", name: "in-process" }] }) + "\\n");
  return 0;
}`);
  writeFileSync(`${dist}/setup.js`, `export async function runQlooSetup(argv, o) { o.writeOut(JSON.stringify({ qloo: { ready: Boolean(o.paths), source: "in-process" } })); return 0; }`);
  writeFileSync(`${dist}/paths.js`, `export function resolveQlooPaths() { return {}; }`);
  const run = (extra: Record<string, string>) => {
    const script = `const q=await import(${JSON.stringify(new URL("../src/lib/qloo.ts", import.meta.url).href)});const m=await q.qlooMode();const t=await q.findTags("jazz");let hang="";try{await q.findTags("hang")}catch(e){hang=e.code}console.log(JSON.stringify({reason:m.reason,transport:await q.qlooTransport(),summary:t.call.summary,surface:t.call.surface,hang}))`;
    return JSON.parse(execFileSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", script],
      { env: { ...process.env, QLOO_MOCK: "", QLOO_CACHE_DIR: "", QLOO_BIN: "qloo", PATH: `${dir}/bin${path.delimiter}${process.env.PATH}`, QLOO_API_KEY: "dummy", QLOO_TRUSTED_BASE_URL: "", QLOO_TIMEOUT_MS: "800", ...extra } }).toString());
  };
  const inproc = run({});
  assert.equal(inproc.reason, "credential from in-process");
  assert.equal(inproc.transport, "in-process");
  assert.equal(inproc.surface, "qloo exec");
  assert.match(inproc.summary, /^in-process find_tags jazz https:\/\/hackathon\.api\.qloo\.com$/, "same workflow, input and trusted base URL as the CLI");
  assert.equal(inproc.hang, "QLOO_TIMEOUT", "an in-process call that never answers still times out");
  const spawned = run({ QLOO_INPROCESS: "0" });
  assert.deepEqual([spawned.reason, spawned.transport, spawned.summary], ["credential from spawned", "process", "spawned"]);
});

test("a starting server preloads the harness in the background, without delaying readiness", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/preload-`);
  const dist = `${dir}/lib/@qloo/qloo-harness/dist`;
  mkdirSync(dist, { recursive: true });
  mkdirSync(`${dir}/bin`);
  writeFileSync(`${dir}/lib/@qloo/qloo-harness/package.json`, JSON.stringify({ name: "@qloo/qloo-harness", type: "module" }));
  writeFileSync(`${dist}/bin.js`, "#!/usr/bin/env node\n");
  chmodSync(`${dist}/bin.js`, 0o755);
  symlinkSync(`${dist}/bin.js`, `${dir}/bin/qloo`);
  // A slow-loading package: the load finishes ~1 s after it starts and leaves a marker.
  writeFileSync(`${dist}/exec.js`, `await new Promise((r) => setTimeout(r, 1000));
(await import("node:fs")).writeFileSync(${JSON.stringify(`${dir}/loaded`)}, String(Date.now()));
export async function runQlooExec() { return 0; }`);
  writeFileSync(`${dist}/setup.js`, `export async function runQlooSetup(argv, o) { o.writeOut(JSON.stringify({ qloo: { ready: true, source: "environment" } })); return 0; }`);
  writeFileSync(`${dist}/paths.js`, `export function resolveQlooPaths() { return {}; }`);
  const script = `const fs=await import("node:fs");const i=await import(${JSON.stringify(new URL("../src/instrumentation.ts", import.meta.url).href)});const t=Date.now();await i.register();const registerMs=Date.now()-t;const loadedAtRegister=fs.existsSync(${JSON.stringify(`${dir}/loaded`)});const until=Date.now()+5000;while(!fs.existsSync(${JSON.stringify(`${dir}/loaded`)})&&Date.now()<until)await new Promise(r=>setTimeout(r,50));console.log(JSON.stringify({registerMs,loadedAtRegister,loaded:fs.existsSync(${JSON.stringify(`${dir}/loaded`)})}))`;
  const out = JSON.parse(execFileSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", script],
    { env: { ...process.env, NEXT_RUNTIME: "nodejs", QLOO_MOCK: "", QLOO_BIN: "qloo", PATH: `${dir}/bin${path.delimiter}${process.env.PATH}`, QLOO_API_KEY: "dummy" } }).toString());
  assert.equal(out.loadedAtRegister, false, "register() returns before the harness has loaded");
  assert.ok(out.registerMs < 900, `register took ${out.registerMs} ms`);
  assert.equal(out.loaded, true, "the harness was loaded in the background");
});

test("quick questions with a 'City, ST' name take the no-model path (the app's own suggestion included)", async () => {
  const { isQuickQuestion } = await import("../src/lib/tour/followup.ts");
  const { findMarket } = await import("../src/lib/markets.ts");
  for (const q of ["Why not Portland, ME?", "Why not Washington, DC?", "why not Portland ME", "how about portland, maine?",
    "What about St. Louis?", "Why not Denver?", "what about  Albany", "Why not Coeur d'Alene, Idaho?"]) {
    assert.ok(isQuickQuestion(q), q);
  }
  for (const q of ["Swap the weakest stop for somewhere in the South", "Why not drop Albany, then add Boston, and move Burlington later?",
    "Which opener fits Boston best?", "Why not 3 stops?"]) {
    assert.ok(!isQuickQuestion(q), q);
  }
  assert.equal(cityFromQuestion("Why not Portland, ME?"), "Portland, ME");
  for (const name of ["Portland, ME", "Portland ME", "portland, maine", "Portland, Maine"]) assert.equal(findMarket(name)?.name, "Portland, ME", name);
  assert.equal(findMarket("Washington DC")?.name, "Washington, DC");
  assert.equal(findMarket("St Louis")?.name, findMarket("St. Louis")?.name);
});

test("occupation tags ('Actors') are never shown as a shared taste, in stored plans too", async () => {
  const { isTasteName } = await import("../src/lib/text.ts");
  assert.deepEqual(["Engaging", "Actors", "Humorous", "Comedians", "actress"].filter(isTasteName), ["Engaging", "Humorous", "Comedians"]);
  const plan = await makePlan();
  const stop = plan.stops.find((s: any) => s.opener) as any;
  stop.opener.overlap = { shared: ["Engaging", "Actors", "Humorous"], evidence: stop.opener.evidence };
  const csv = planToCsv(plan);
  assert.ok(csv.includes("Engaging; Humorous") && !/Actors/.test(csv), "CSV drops the occupation tag");
});

test("a demo forked into a share link keeps its demo labels (fictional / not affiliated), old forks too", async () => {
  const { planForRequest, withDemoFlag } = await import("../src/lib/tour/sources.ts");
  const { sourceLabel } = await import("../src/lib/tour/source-label.ts");
  const forked = await planForRequest({ preset: "us-emerging" });
  assert.ok(forked?.forked);
  assert.equal(forked!.plan.demo?.slug, "us-emerging");
  assert.match(forked!.plan.demo!.capturedAt, /^2026-/);
  const again = await planForRequest({ planId: forked!.plan.id });
  assert.equal(again?.plan.demo?.slug, "us-emerging", "the stored fork carries the flag");
  // A fork saved before the flag existed is recognised from the demo it was copied from.
  const old = { ...forked!.plan, demo: undefined };
  assert.equal((await withDemoFlag(old)).demo?.slug, "us-emerging");
  // A live plan is never mistaken for a demo.
  assert.equal((await withDemoFlag(await makePlan())).demo, undefined);
  assert.match(sourceLabel({ kind: "shared", createdAt: "2026-10-08T00:00:00Z", demoCapturedAt: "2026-10-07T09:00:00Z" }, (d) => d.slice(0, 10)), /^Shared demo plan, captured from live Qloo data on 2026-10-07$/);
});

test("share links forked from an earlier capture of a recaptured demo keep the demo label", async () => {
  const { withDemoFlag } = await import("../src/lib/tour/sources.ts");
  const plan = await makePlan();
  const old = { ...plan, artist: { ...plan.artist, name: "S.G. Goodman" }, timings: { phaseAMs: 18, synthesisMs: 19515, totalMs: 19533 }, mode: { ...plan.mode, llm: "claude" } };
  assert.equal((await withDemoFlag(old)).demo?.slug, "us-americana");
  assert.equal((await withDemoFlag({ ...old, timings: { ...old.timings, totalMs: 40000 } })).demo, undefined, "a live S.G. Goodman tour is not a demo");
});
