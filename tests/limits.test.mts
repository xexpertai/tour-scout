import assert from "node:assert/strict";
import { test } from "node:test";

process.env.TOUR_RUNS_PER_HOUR = "2";
process.env.TOUR_DAILY_CAP = "3";
const { take, takeDailyRun, runCache } = await import("../src/lib/limits.ts");

test("per-client limits slide over an hour and are independent per client", () => {
  const t0 = 1_000_000;
  assert.equal(take("tour", "a", t0).ok, true);
  assert.equal(take("tour", "a", t0 + 1).ok, true);
  const blocked = take("tour", "a", t0 + 2);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.retryAfterSec > 3500 && blocked.message.includes("demo"));
  assert.equal(take("tour", "b", t0 + 2).ok, true, "another client is unaffected");
  assert.equal(take("tour", "a", t0 + 60 * 60 * 1000 + 5).ok, true, "allowed again after the window");
});

test("the daily cap resets on a new UTC day", () => {
  const d = new Date("2026-10-20T10:00:00Z");
  for (let i = 0; i < 3; i++) assert.equal(takeDailyRun(d).ok, true);
  assert.equal(takeDailyRun(d).ok, false);
  assert.equal(takeDailyRun(new Date("2026-10-21T00:00:01Z")).ok, true);
});

test("identical runs are reused for 24 hours", () => {
  runCache.set("k", "plan-1", 0);
  assert.equal(runCache.get("k", 23 * 3600_000), "plan-1");
  assert.equal(runCache.get("k", 25 * 3600_000), undefined);
});

test("the README's limits match the code defaults and the hosted-demo values in deploy/cloudrun.env.yaml", async () => {
  const { readFileSync } = await import("node:fs");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const yaml = readFileSync(new URL("../deploy/cloudrun.env.yaml", import.meta.url), "utf8");
  const limits = readFileSync(new URL("../src/lib/limits.ts", import.meta.url), "utf8");
  const llm = readFileSync(new URL("../src/lib/llm.ts", import.meta.url), "utf8");
  const hosted = (key: string) => yaml.match(new RegExp(`^${key}: "(\\d+)"`, "m"))?.[1];
  const dflt = (key: string) => (limits.match(new RegExp(`env\\.${key}\\) \\|\\| (\\d+)`)) ?? llm.match(new RegExp(`env\\.${key} \\?\\? (\\d+)`)))?.[1];
  const keys = ["TOUR_RUNS_PER_HOUR", "RESOLVES_PER_HOUR", "FOLLOWUPS_PER_HOUR", "TOUR_DAILY_CAP"];
  const row = `| \`${keys.join("`, `")}\` | \`${keys.map(dflt).join("`, `")}\` (hosted demo: \`${keys.map(hosted).join("`, `")}\`) |`;
  assert.ok(readme.includes(row), `README limits row should be: ${row}`);
  assert.ok(readme.includes(`| \`LLM_DAILY_CAP\` | \`${dflt("LLM_DAILY_CAP")}\` (hosted demo: \`${hosted("LLM_DAILY_CAP")}\`) |`), "LLM cap row");
});
