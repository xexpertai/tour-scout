import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.QLOO_MOCK = "1";
process.env.GEO_OFFLINE = "1";

const { evaluationMarkdown, evaluatePlan, evaluateCheck, evaluateGuard, loadRun, EVAL_START, EVAL_END } = await import("../scripts/evaluate.mts");
const { PRESETS } = await import("../src/lib/tour/presets.ts");

test("docs/EVALUATION.md shows exactly what npm run eval prints (regenerate with npm run eval -- --write)", () => {
  const doc = readFileSync(new URL("../docs/EVALUATION.md", import.meta.url), "utf8");
  const block = doc.slice(doc.indexOf(EVAL_START) + EVAL_START.length, doc.indexOf(EVAL_END)).trim();
  assert.equal(block, evaluationMarkdown());
});

test("every demo plan: all Qloo values and AI text cite real requests, legs are drivable, openers fit or are flagged", () => {
  for (const p of PRESETS) {
    const r = evaluatePlan(loadRun(p.slug).plan);
    assert.equal(r.cited, r.values, `${p.slug} cited`);
    assert.equal(r.aiCited, r.ai, `${p.slug} AI text`);
    assert.equal(r.legsOk, r.legs, `${p.slug} legs`);
    assert.equal(r.openersUnflaggedOver, 0, `${p.slug} openers`);
  }
});

test("every recorded route check passes the independent re-check", () => {
  for (const p of PRESETS) {
    const { plan, check } = loadRun(p.slug);
    assert.ok(check, `${p.slug} has a recorded route check`);
    for (const c of evaluateCheck(plan, check!).checks) assert.ok(c.ok, `${p.slug}: ${c.name}`);
  }
});

test("the guard still handles every sentence of the first red-team set (regression)", () => {
  const { cases } = JSON.parse(readFileSync(new URL("../docs/eval/guard-cases.json", import.meta.url), "utf8"));
  const g = evaluateGuard(cases);
  assert.deepEqual(g.missed.map((m) => m.text), []);
  assert.deepEqual(g.wronglyWithheld.map((m) => m.text), []);
});
