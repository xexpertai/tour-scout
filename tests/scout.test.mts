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
const { runScout, scriptedAgentModel } = await import("../src/lib/tour/scout.ts");
const { applyProposal } = await import("../src/lib/tour/apply.ts");
type Msg = { role: string; results?: { content: string }[] };

async function makePlan(stops = 4) {
  for await (const e of planTour({ artist: { id: "sample-artist-big_thief", name: "Big Thief (sample)", type: "artist" }, region: "United States", stops }, undefined, scriptedProvider)) {
    if (e.type === "plan") return e.plan;
  }
  throw new Error("no plan");
}
const sink = () => { const events: any[] = []; return { events, push: (e: any) => events.push(e) }; };
const lastResults = (h: Msg[]) => (h.filter((m) => m.role === "tool_results").at(-1)?.results ?? []).map((r) => JSON.parse(r.content));

/** A fake model that chains three tool rounds the way Claude would, then proposes a swap. */
function fakeClaude(plan: any) {
  const weakest = [...plan.stops].sort((a: any, b: any) => a.city.affinity - b.city.affinity)[0];
  return {
    name: "claude" as const,
    rounds: 0,
    async next(_s: string, history: Msg[]) {
      this.rounds++;
      if (this.rounds === 1) return { calls: [{ id: "a", name: "find_cities", input: { region: "United States" } }], text: "" };
      if (this.rounds === 2) {
        const offRoute = lastResults(history)[0].cities.filter((c: any) => !c.on_route).slice(0, 2).map((c: any) => c.city);
        return { calls: [{ id: "b", name: "rank_cities", input: { cities: offRoute } }, { id: "c", name: "fan_cluster", input: { city: offRoute[0] } }], text: "" };
      }
      const [ranked] = lastResults(history);
      const best = ranked.ranking.find((r: any) => !r.on_route);
      return { calls: [{ id: "d", name: "propose_change", input: {
        answer: { text: `${best.city} scores ${best.score}; swap it in.`, evidence: [ranked.evidence_id, "Q999"] },
        add_cities: [best.city, "Atlantis"],
        remove_stop_ids: [weakest.stopId, "s99"],
      } }], text: "" };
    },
  };
}

test("the scout chains tools, cites real evidence, and proposes only what it saw", async () => {
  const plan = await makePlan();
  const out = sink();
  const model = fakeClaude(plan);
  const f = await runScout(plan, "Swap the weakest stop for somewhere stronger", model, out);
  assert.equal(model.rounds, 3);
  assert.equal(f.kind, "agent");
  assert.equal(f.answer.kind, "interpretation");
  assert.ok(!f.answer.evidence.includes("Q999"), "fake evidence dropped");
  assert.equal(f.proposal?.add.length, 1, "unseen city (Atlantis) rejected");
  assert.deepEqual(f.proposal?.remove.length, 1, "unknown stop id rejected");
  assert.ok(out.events.some((e) => e.type === "checking" && /ranking/.test(e.label)), "live 'Scout is …' steps were streamed");
  const planIds = new Set(plan.sources.map((s: any) => s.id));
  assert.ok(f.sources.length >= 3 && f.sources.every((s: any) => !planIds.has(s.id)), "new Q-ids continue the plan's numbering");
  assert.ok(f.pins.length > 0, "ghost pins for the cities it looked at");
});

test("applying a proposal rebuilds the stop, keeps the count and never crosses the route", async () => {
  const plan = await makePlan(5);
  const f = await runScout(plan, "Swap the weakest stop", fakeClaude(plan), sink());
  plan.followUps = [f];
  const next = await applyProposal(plan, 0, sink());
  assert.notEqual(next.id, plan.id);
  assert.equal(next.parentId, plan.id);
  assert.equal(next.stops.length, 5);
  const added = next.stops.find((s: any) => s.city.name === f.proposal!.add[0].name);
  assert.ok(added && added.venues.length > 0 && added.why?.kind === "template", "new stop scouted with templated text");
  assert.equal(next.followUps![0].appliedAs, next.id);
  assert.deepEqual(next.stops.map((s: any) => s.order), [1, 2, 3, 4, 5]);
  const p = next.stops.map((s: any) => ({ x: s.city.lng, y: s.city.lat }));
  const o = (a: any, b: any, c: any) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  for (let i = 0; i < p.length - 1; i++) for (let j = i + 2; j < p.length - 1; j++) {
    assert.ok(!(o(p[i], p[i + 1], p[j]) !== o(p[i], p[i + 1], p[j + 1]) && o(p[j], p[j + 1], p[i]) !== o(p[j], p[j + 1], p[i + 1])), "no crossing");
  }
  await assert.rejects(applyProposal(next, 0, sink()), /already applied/);
});

test("the templated scout works without a model and is labelled as template", async () => {
  const plan = await makePlan(4);
  const f = await runScout(plan, "Make it a 3-stop run", scriptedAgentModel(plan, "Make it a 3-stop run"), sink());
  assert.equal(f.answer.kind, "template");
  assert.equal(f.proposal?.remove.length, 1);
  const g = await runScout(plan, "Who's a good opener in Brooklyn?", scriptedAgentModel(plan, "Who's a good opener in Brooklyn?"), sink());
  assert.ok(g.proposal?.opener || g.answer.text.length > 0);
});

test("the proposal's scores match the comparison the answer quotes", async () => {
  const plan = await makePlan(5);
  const f = await runScout(plan, "Swap the weakest stop", fakeClaude(plan), sink());
  const quoted = Number(f.answer.text.match(/scores (\d+)/)![1]);
  assert.match(f.proposal!.summary, new RegExp(`\\+ [^(]+\\(${quoted}\\)`));
});

test("a malformed answer is cleaned, cites the Q-ids in its text, and openers never land on removed stops", async () => {
  const plan = await makePlan(4);
  const model = {
    name: "claude" as const,
    turn: 0,
    async next(_s: string, history: Msg[]) {
      if (this.turn++ === 0) return { calls: [{ id: "x", name: "find_openers", input: { city: "Chicago" } }], text: "" };
      const [r] = lastResults(history);
      return { calls: [{ id: "y", name: "propose_change", input: {
        answer: `<parameter name="text">${r.openers[0].name} is the best fit (${r.evidence_id}).`,
        remove_stop_ids: ["s1"], set_opener: { stop_id: "s1", entity_id: r.openers[0].entity_id },
      } }], text: "" };
    },
  };
  const f = await runScout(plan, "Opener in Chicago?", model, sink());
  assert.doesNotMatch(f.answer.text, /parameter/);
  assert.equal(f.answer.kind, "interpretation");
  assert.equal(f.proposal?.opener, undefined, "opener on a removed stop is dropped");
});
