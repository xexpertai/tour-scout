/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely typed NDJSON-style events */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.QLOO_MOCK = "1";
process.env.GEO_OFFLINE = "1";
const { planTour, routeOrder } = await import("../src/lib/tour/plan.ts");
const { scriptedProvider, LlmError } = await import("../src/lib/llm.ts");
type Events = Awaited<ReturnType<typeof collect>>;

const artist = { id: "sample-artist-phoebe_bridgers", name: "Phoebe Bridgers (sample)", type: "artist" as const, popularity: 0.82 };

async function collect(gen: AsyncGenerator<{ type: string } & Record<string, any>>) {
  const events: ({ type: string } & Record<string, any>)[] = [];
  for await (const e of gen) events.push(e);
  return events;
}
const planOf = (events: Events) => events.find((e) => e.type === "plan")!.plan;

test("a run streams cities and every stop, then a plan whose citations all exist", async () => {
  const events = await collect(planTour({ artist, region: "United States", stops: 4 }, undefined, scriptedProvider));
  assert.equal(events[0].type, "mode");
  assert.ok(events.some((e) => e.type === "cities"));
  assert.equal(events.filter((e) => e.type === "stop").length, 4);
  assert.ok(events.findIndex((e) => e.type === "stop") < events.findIndex((e) => e.type === "plan"), "stops stream before the plan");

  const plan = planOf(events);
  assert.equal(plan.stops.length, 4);
  assert.deepEqual(plan.stops.map((s: any) => s.order), [1, 2, 3, 4]);
  const ids = new Set(plan.sources.map((s: any) => s.id));
  const cited = [plan.summary, ...plan.theme, ...plan.merch, ...plan.risks, ...plan.stops.flatMap((s: any) => [s.why, s.pitch])]
    .filter(Boolean).flatMap((i: any) => i.evidence);
  assert.ok(cited.length > 0);
  for (const id of cited) assert.ok(ids.has(id), `cited ${id} exists`);
  for (const s of plan.stops) {
    assert.ok(ids.has(s.city.evidence));
    assert.ok(s.venues.length > 0, "venues found");
    assert.ok(s.opener && s.opener.entityId !== artist.id, "opener is not the artist");
  }
  assert.ok(plan.fan.tags.length && plan.fan.demographics && plan.fan.alsoLikes.length === 2);
  assert.equal(plan.artist.arenaScale, false);
});

test("model text that cites fake evidence or makes unsupported claims is relabelled or withheld", async () => {
  const provider = {
    name: "claude" as const,
    async synthesize() {
      return {
        summary: { text: "Strong fan affinity in these cities.", evidence: ["Q999"] },
        stops: [{ stop_id: "s1", why: { text: "This show will sell out.", evidence: ["Q1"] }, pitch: { text: "Fans here are affluent.", evidence: ["Q1"] } }],
        theme: [{ text: "Lean into dream-pop visuals.", evidence: ["Q1"] }],
        merch: [], risks: [],
      };
    },
  };
  const plan = planOf(await collect(planTour({ artist, region: "United States", stops: 2 }, undefined, provider)));
  assert.equal(plan.summary.kind, "general", "fake evidence id dropped");
  assert.equal(plan.theme[0].kind, "interpretation");
  assert.equal(plan.withheld.length, 2);
  const s1 = plan.stops.find((s: any) => s.stopId === "s1");
  assert.equal(s1.why, undefined);
  assert.equal(s1.pitch, undefined);
});

test("a failing model falls back to scripted text and says so", async () => {
  const failing = { name: "claude" as const, async synthesize(): Promise<never> { throw new LlmError("quota", "LLM_QUOTA"); } };
  const events = await collect(planTour({ artist, region: "India", stops: 3 }, undefined, failing));
  assert.ok(events.some((e) => e.type === "llm_fallback"));
  assert.match(planOf(events).mode.llm, /fallback from claude/);
});

test("emerging-artist mode scouts with proxy artists and arena-scale artists are flagged", async () => {
  const proxies = [{ id: "sample-artist-mitski", name: "Mitski (sample)", type: "artist" as const }];
  const emergingPlan = planOf(await collect(planTour({ artist: null, emerging: { name: "Night Swim", proxies }, region: "United Kingdom", stops: 3 }, undefined, scriptedProvider)));
  assert.equal(emergingPlan.artist.name, "Night Swim");
  assert.deepEqual(emergingPlan.artist.proxyOf, ["Mitski (sample)"]);
  assert.equal(emergingPlan.stops.length, 3);

  const arena = { ...artist, name: "Coldplay (sample)", popularity: 0.995 };
  const arenaPlan = planOf(await collect(planTour({ artist: arena, region: "United States", stops: 2 }, undefined, scriptedProvider)));
  assert.equal(arenaPlan.artist.arenaScale, true);
  assert.match(arenaPlan.summary.text, /arena-scale/);
});

test("candidate cities are ranked, and the route visits nearest stops in turn", async () => {
  const plan = planOf(await collect(planTour({ artist, candidateCities: ["Chicago", "Austin", "Seattle"], stops: 3 }, undefined, scriptedProvider)));
  assert.equal(plan.stops.length, 3);
  assert.ok(plan.sources.some((s: any) => s.call.workflow === "rank"));

});

const stop = (name: string, lat: number, lng: number, affinity = 0.5) => ({ stopId: name, rank: 0, city: { entityId: name, name, affinity, lat, lng, evidence: "Q1" }, venues: [] });
function crosses(route: any[]) {
  const p = route.map((s) => ({ x: s.city.lng, y: s.city.lat }));
  const orient = (a: any, b: any, c: any) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  for (let i = 0; i < p.length - 1; i++) {
    for (let j = i + 2; j < p.length - 1; j++) {
      if (orient(p[i], p[i + 1], p[j]) !== orient(p[i], p[i + 1], p[j + 1]) && orient(p[j], p[j + 1], p[i]) !== orient(p[j], p[j + 1], p[i + 1])) return true;
    }
  }
  return false;
}

test("the route sweeps in one direction without crossing itself, starting at the stronger end", () => {
  // The M2 demo's cities, which nearest-neighbour from Austin routed across itself.
  const us = [stop("Austin", 30.27, -97.74, 0.94), stop("Chicago", 41.88, -87.63, 0.9), stop("Brooklyn", 40.68, -73.94, 0.85), stop("Los Angeles", 34.05, -118.24, 0.8), stop("Seattle", 47.61, -122.33, 0.75)];
  const order = routeOrder(us);
  assert.equal(crosses(order), false);
  assert.deepEqual(order.map((s: any) => s.stopId), ["Brooklyn", "Chicago", "Austin", "Los Angeles", "Seattle"]);

  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let trial = 0; trial < 50; trial++) {
    const n = 3 + Math.floor(rnd() * 6);
    const pts = Array.from({ length: n }, (_, i) => stop(`c${i}`, 25 + rnd() * 20, -120 + rnd() * 45, rnd()));
    const route = routeOrder(pts);
    assert.equal(route.length, n);
    assert.equal(crosses(route), false, `trial ${trial}`);
    assert.ok(route[0].city.affinity >= route[n - 1].city.affinity);
  }
});

test("streamed model text reaches each stop as soon as that stop's entry is complete", async () => {
  const provider = {
    name: "claude" as const,
    async synthesize(_input: unknown, onPartial?: (s: any) => void) {
      const why = (id: string) => ({ stop_id: id, why: { text: `Why ${id}`, evidence: ["Q1"] }, pitch: { text: `Pitch ${id}`, evidence: ["Q1"] } });
      onPartial?.({ summary: { text: "Summ", evidence: [] } });
      onPartial?.({ summary: { text: "Summary.", evidence: ["Q1"] }, stops: [why("s1")] });
      onPartial?.({ summary: { text: "Summary.", evidence: ["Q1"] }, stops: [why("s1"), why("s2")] });
      const done = { summary: { text: "Summary.", evidence: ["Q1"] }, stops: [why("s1"), why("s2")], theme: [], merch: [], risks: [] };
      onPartial?.(done);
      return done;
    },
  };
  const events = await collect(planTour({ artist, region: "United States", stops: 2 }, undefined, provider));
  const texts = events.filter((e) => e.type === "stop_text");
  assert.deepEqual(texts.map((e) => e.stopId), ["s1", "s2"]);
  assert.equal(texts[0].pitch.text, "Pitch s1");
  assert.equal(events.filter((e) => e.type === "summary").length, 1);
  assert.ok(events.findIndex((e) => e.type === "stop_text") < events.findIndex((e) => e.type === "plan"));
});

test("templated text is never labelled as AI", async () => {
  const fallbackEvents = await collect(planTour({ artist, region: "United States", stops: 3 }, undefined,
    { name: "claude" as const, async synthesize(): Promise<never> { throw new LlmError("quota", "LLM_QUOTA"); } }));
  for (const plan of [planOf(await collect(planTour({ artist, region: "United States", stops: 3 }, undefined, scriptedProvider))), planOf(fallbackEvents)]) {
    const items = [plan.summary, ...plan.theme, ...plan.merch, ...plan.risks, ...plan.stops.flatMap((s: any) => [s.why, s.pitch])].filter(Boolean);
    assert.ok(items.length > 0);
    for (const item of items) assert.equal(item.kind, "template", item.text);
  }
});
