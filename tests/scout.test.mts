/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely typed plan JSON */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.QLOO_MOCK = "1";
process.env.GEO_OFFLINE = "1";
process.env.TOUR_MAX_LEG_KM = "600"; // the mock sample cities sit far apart; the drivable rule itself is tested in tour.test
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
        // Nearby touring cities as well as the hotspots (the mock route runs through the Midwest).
        const offRoute = [...lastResults(history)[0].cities.filter((c: any) => !c.on_route).slice(0, 2).map((c: any) => c.city), "Louisville", "Columbus", "St. Louis"]
          .filter((c: string) => !plan.stops.some((x: any) => x.city.name === c));
        return { calls: [{ id: "b", name: "rank_cities", input: { cities: offRoute } }, { id: "c", name: "fan_cluster", input: { city: offRoute[0] } }], text: "" };
      }
      const [ranked] = lastResults(history);
      // A real agent picks a city the route check says keeps the run drivable.
      const ok = new Set((ranked.route_check ?? []).filter((c: any) => c.swap_keeps_route_drivable).map((c: any) => c.city));
      const best = ranked.ranking.find((r: any) => !r.on_route && ok.has(r.city)) ?? ranked.ranking.find((r: any) => !r.on_route);
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
  const quoted = Number(f.answer.text.match(/scores (\d+(?:\.\d+)?)/)![1]);
  assert.match(f.proposal!.summary, new RegExp(`\\+ [^(]+\\(${quoted.toFixed(1).replace(".", "\\.")}\\)`));
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

test("leaked evidence lists and quotes are stripped from the scout's answer", async () => {
  const { cleanAnswer } = await import("../src/lib/tour/scout.ts");
  assert.equal(cleanAnswer('Alvvays or Andy Shauf would fit. Either enhances the lineup.",\n["Q30", "Q32", "Q31"]'), "Alvvays or Andy Shauf would fit. Either enhances the lineup.");
  assert.equal(cleanAnswer("Keep the route as is (Q12)."), "Keep the route as is.", "inline ids move to the evidence chips");
});

test("applying a new opener rewrites that stop's text, so nothing still names the old opener", async () => {
  const plan: any = await makePlan(3);
  const stop = plan.stops[0];
  const old = stop.opener.name;
  // The model's text for this stop names the old opener (as Claude's did in the Big Thief demo).
  stop.why = { text: `Strong fit. ${old} as suggested opener shares melodic tastes.`, evidence: [stop.city.evidence], kind: "interpretation" };
  plan.followUps = [{ kind: "agent", question: "opener?", answer: { text: "Try someone else.", evidence: [], kind: "general" }, pins: [], sources: [], askedAt: "",
    proposal: { add: [], remove: [], opener: { stopId: stop.stopId, opener: { entityId: "sample-x", name: "New Opener (sample)", evidence: stop.city.evidence } }, summary: "opener → New Opener" } }];
  const next = await applyProposal(plan, 0, sink());
  const changed = next.stops.find((s: any) => s.stopId === stop.stopId)!;
  assert.equal(changed.opener!.name, "New Opener (sample)");
  assert.ok(!`${changed.why?.text} ${changed.pitch?.text}`.includes(old), "no text names the old opener");
  assert.equal(changed.why?.kind, "template");
});

test("cleanAnswer drops echoed tool-field names", async () => {
  const { cleanAnswer } = await import("../src/lib/tour/scout.ts");
  assert.equal(cleanAnswer("Jessica Kirson is well-matched (fits_the_act: true). Keep the plan."), "Jessica Kirson is well-matched. Keep the plan.");
});

test("cleanAnswer drops raw score lists", async () => {
  const { cleanAnswer } = await import("../src/lib/tour/scout.ts");
  assert.equal(cleanAnswer("Tomberlin, with high affinity (97, 96.9, 97) and overlap."), "Tomberlin, with high affinity and overlap.");
  assert.equal(cleanAnswer("Portland, ME (89.8) is weaker."), "Portland, ME (89.8) is weaker.", "a single score stays");
});

test("the server enforces the route check and opener rules the agent's own tools report", async () => {
  const plan = await makePlan();
  // A model that looks at the cities, then claims the route holds and proposes the stop's current opener.
  const holds = {
    name: "claude" as const, rounds: 0,
    async next(_s: string, history: Msg[]) {
      this.rounds++;
      if (this.rounds === 1) return { calls: [{ id: "a", name: "find_cities", input: { region: "United States" } }, { id: "o", name: "find_openers", input: { city: plan.stops[0].city.name } }], text: "" };
      const [found] = lastResults(history);
      const checks = found.route_check ?? [];
      (holds as any).sawStronger = checks.some((c: any) => c.vs_weakest === "stronger" && c.swap_keeps_route_drivable);
      return { calls: [{ id: "d", name: "propose_change", input: { answer: "Route holds.", evidence: [], set_opener: { stop_id: plan.stops[0].stopId, entity_id: plan.stops[0].opener!.entityId } } }], text: "" };
    },
  } as any;
  const f = await runScout(plan, "Check this route: is there a stronger city within a day's drive, or a better opener?", holds, sink());
  assert.ok(!f.proposal?.opener, "the stop's current opener is never proposed (no-op)");
  // The server's pre-check ranks the cities near the route; a stronger drivable one is swapped in although
  // the model said the route holds, and the answer says why (TEMPLATE).
  assert.equal(f.proposal?.add.length, 1, "a stronger drivable city is swapped in");
  assert.equal(f.answer.kind, "template");
  assert.match(f.answer.text, /^Route check: /);
  // The templated scout never proposes the opener a stop already has.
  const t = await runScout(plan, `Who's a good opener in ${plan.stops[0].city.name} with crossover fans?`, scriptedAgentModel(plan, `Who's a good opener in ${plan.stops[0].city.name}?`), sink());
  assert.notEqual(t.proposal?.opener?.opener.entityId, plan.stops[0].opener?.entityId);
});

async function makeEmergingPlan(stops = 4) {
  const proxies = [{ id: "sample-artist-big_thief", name: "Big Thief (sample)", type: "artist" as const }];
  for await (const e of planTour({ artist: null, emerging: { name: "Maya", proxies }, region: "United States", stops }, undefined, scriptedProvider)) {
    if (e.type === "plan") return e.plan;
  }
  throw new Error("no plan");
}

test("Apply keeps an emerging act's rules: support slots sized ≤ 0.92 (or flagged) and pitched to the headliner", async () => {
  const { SMALL_ROOM_POPULARITY } = await import("../src/lib/tour/pipeline.ts");
  const plan = await makeEmergingPlan(4);
  const f = await runScout(plan, "Swap the weakest stop", fakeClaude(plan), sink());
  assert.ok(f.proposal?.add.length, "a swap to apply");
  plan.followUps = [f];
  const next = await applyProposal(plan, 0, sink());
  const added = next.stops.find((s: any) => s.city.name === f.proposal!.add[0].name)!;
  const o = added.opener;
  assert.ok(o, "the added stop has a support-slot idea");
  {
    assert.equal(o.sizeCap, SMALL_ROOM_POPULARITY, "the emerging size cap is applied on Apply");
    assert.ok((o.popularity !== undefined && o.popularity <= SMALL_ROOM_POPULARITY) || o.oversize, "a support slot within the cap, or a visible size flag");
    assert.match(added.pitch!.text, /^Subject: Support slot request: Maya with /, "the added stop keeps the support-slot pitch");
    assert.doesNotMatch(added.pitch!.text, /I'm booking Maya/);
  }
  assert.equal(next.coverage?.regional?.stops ?? next.stops.length, next.stops.length);
});

test("Apply updates kept text that states a city's rank, and the coverage note's longest drive", async () => {
  const plan = await makePlan(5);
  const f = await runScout(plan, "Swap the weakest stop", fakeClaude(plan), sink());
  const kept = plan.stops.find((s: any) => !f.proposal!.remove.includes(s.stopId))!;
  kept.why = { text: `${kept.city.name} ranks #9 for this audience.`, evidence: [kept.city.evidence], kind: "interpretation" };
  plan.followUps = [f];
  const next = await applyProposal(plan, 0, sink());
  const after = next.stops.find((s: any) => s.stopId === kept.stopId)!;
  const ranked = [...next.candidates!].sort((a: any, b: any) => b.affinity - a.affinity).findIndex((c: any) => c.name === kept.city.name) + 1;
  assert.equal(after.why!.text, `${kept.city.name} ranks #${ranked} for this audience.`);
});

test("the no-AI route check only claims the change it proposes, and skips a tie note for a removed stop", async () => {
  const plan = await makePlan(4);
  const q = "Check this route: is there a stronger city within a day's drive, or a better support act?";
  const f = await runScout(plan, q, scriptedAgentModel(plan, q), sink());
  assert.equal(f.answer.kind, "template");
  const named = [...f.answer.text.matchAll(/([A-Z][\w.' ]+?) (?:scores|\()/g)].map((m) => m[1].trim());
  if (f.proposal?.add.length) {
    assert.match(f.answer.text, /^Route check: /);
    assert.ok(f.answer.text.includes(f.proposal.add[0].name), "the text names the city the proposal adds");
    const removed = plan.stops.find((s: any) => s.stopId === f.proposal!.remove[0])!;
    assert.ok(f.answer.text.includes(removed.city.name), "and the stop it removes");
    assert.ok(!(f.checks ?? []).some((c: any) => c.text.includes(`${removed.city.name} (`) && /tied/.test(c.text)), "no tie note about the removed stop");
  } else {
    assert.match(f.answer.text, /^Route holds: /);
    assert.doesNotMatch(f.answer.text, /swapping it in/);
  }
  assert.ok(named.length > 0);
  assert.doesNotMatch(f.answer.text, /optimi[sz]ed/);
});

test("the route verdict explains a swap with numbers and road km", async () => {
  const { routeVerdict } = await import("../src/lib/tour/scout.ts");
  const plan = await makePlan(4);
  const weakest = [...plan.stops].sort((a: any, b: any) => a.city.affinity - b.city.affinity)[0];
  const city = { ...plan.stops[0].city, name: "Testville", affinity: 0.99, lat: weakest.city.lat! + 0.2, lng: weakest.city.lng! + 0.2 };
  const v = routeVerdict(plan, [city], { add: [city], remove: [weakest.stopId] });
  assert.match(v.text, new RegExp(`^Route check: Testville scores 99\\.0, above ${weakest.city.name} \\(\\d+\\.\\d\\), the weakest stop, and the changed route keeps every leg within a day's drive \\((about the same driving|≈ [\\d,]+ km (more|less) driving by road)\\)\\. Proposed: swap it in\\.$`));
  const holds = routeVerdict(plan, [{ ...city, affinity: 0.01 }]);
  assert.match(holds.text, /^Route holds: .+ is the weakest stop, and no stronger city the check scored is within a day's drive\. Testville \(1\.0\) scores lower\.$/);
});

test("cleanAnswer drops inline evidence ids", async () => {
  const { cleanAnswer } = await import("../src/lib/tour/scout.ts");
  assert.equal(cleanAnswer("Route holds: no stronger city (Q37, Q34). Done (Q40)."), "Route holds: no stronger city. Done.");
});
