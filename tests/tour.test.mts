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
  // Cities come from the country-wide fan heatmap, snapped to touring markets.
  assert.equal(plan.coverage.basis, "hotspots");
  assert.ok(plan.coverage.hotspotCells > 0 && plan.coverage.hotspotMarkets >= 4);
  assert.ok(plan.stops.every((s: any) => s.city.hotspot && ids.has(s.city.hotspot.evidence)), "every stop is near a fan hotspot");
  assert.equal(new Set(plan.stops.map((s: any) => s.opener.entityId)).size, plan.stops.length, "each stop suggests a different opener");
});

test("entity_tags and compare_audiences keep taste tags and drop place, business, region and identity tags", async () => {
  const { isAudienceTag } = await import("../src/lib/qloo.ts");
  const fixture = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("./fixtures/entity-tags-big-thief.json", import.meta.url), "utf8"));
  const kept = fixture.output.results.filter(isAudienceTag).map((t: any) => t.name);
  assert.deepEqual(kept, ["Intimacy", "Sensitive", "Vulnerability"]);
  const comedian = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("./fixtures/entity-tags-comedian.json", import.meta.url), "utf8"));
  const comedianKept = comedian.output.results.filter(isAudienceTag).map((t: any) => t.name.toLowerCase());
  assert.ok(!comedianKept.some((n: string) => /african|black|american|protagonist/.test(n)), `no identity tags: ${comedianKept}`);
  const compare = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("./fixtures/compare-audiences.json", import.meta.url), "utf8"));
  const shared = compare.output.results.tags.filter((t: any) => isAudienceTag({ id: t.tag_id, type: t.subtype, name: t.name })).map((t: any) => t.name);
  assert.ok(shared.includes("Folk") && !shared.includes("United States"));
});

test("an opener whose Qloo description names the act (a member or side project) is skipped", async () => {
  const { isRelatedAct } = await import("../src/lib/tour/pipeline.ts");
  assert.equal(isRelatedAct("best known as the lead vocalist and guitarist of the indie folk band Big Thief.", ["Big Thief"]), true);
  assert.equal(isRelatedAct("Australian singer-songwriter known for intimate indie rock.", ["Big Thief"]), false);
  assert.equal(isRelatedAct(undefined, ["Big Thief"]), false);
});

test("a real country-wide heatmap snaps hotspot cells to touring markets and counts remote ones", async () => {
  const { nearestMarket } = await import("../src/lib/markets.ts");
  const fixture = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("./fixtures/where-popular-us-big-thief.json", import.meta.url), "utf8"));
  const cells = fixture.output.results.map((r: any) => ({ lat: r.location.latitude, lng: r.location.longitude }));
  const markets = new Set(cells.map((c: any) => nearestMarket(c)?.name).filter(Boolean));
  for (const m of ["Northampton", "Burlington", "Portland, OR", "Austin"]) assert.ok(markets.has(m), m);
  assert.ok(cells.some((c: any) => !nearestMarket(c)), "remote hotspots (e.g. far West Texas) are not forced into a market");
  // A US cell near the border must not snap to a city abroad.
  const niagara = { lat: 43.2, lng: -79.0 };
  assert.equal(nearestMarket(niagara)?.name, "Toronto");
  assert.equal(nearestMarket(niagara, 75, "United States"), undefined);
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
  const sizeProvider = { name: "claude" as const, async synthesize() { return { summary: { text: "Book rooms of 1,500–3,000 in each city.", evidence: ["Q1"] }, stops: [], theme: [], merch: [], risks: [] }; } };
  const sized = planOf(await collect(planTour({ artist, region: "United States", stops: 2 }, undefined, sizeProvider)));
  assert.equal(sized.summary.kind, "template", "a withheld summary falls back to the templated one");
  assert.ok(sized.withheld.some((w: any) => w.field === "summary"));
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

  const arena = { ...artist, name: "Coldplay (sample)", popularity: 0.9995 };
  const arenaPlan = planOf(await collect(planTour({ artist: arena, region: "United States", stops: 2 }, undefined, scriptedProvider)));
  assert.equal(arenaPlan.artist.arenaScale, true);
  assert.match(arenaPlan.summary.text, /arena-scale/);
});

test("candidate cities are ranked, and the route visits nearest stops in turn", async () => {
  const plan = planOf(await collect(planTour({ artist, candidateCities: ["Chicago", "Austin", "Seattle"], stops: 3 }, undefined, scriptedProvider)));
  assert.equal(plan.stops.length, 3);
  assert.equal(plan.coverage.basis, "shortlist");
  // Each city is scored by room affinity (a place recommendation filtered to that city), best first.
  for (const city of ["Chicago", "Austin", "Seattle"]) assert.ok(plan.sources.some((s: any) => s.label.startsWith(`Rooms in ${city}`)), city);
  const byScore = [...plan.stops].sort((a: any, b: any) => a.rank - b.rank).map((s: any) => s.city.affinity);
  assert.deepEqual(byScore, [...byScore].sort((a, b) => b - a));

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
      const why = (id: string) => ({ stop_id: id, why: { text: `Why ${id} is a strong stop for this act.`, evidence: ["Q1"] }, pitch: { text: `Pitch ${id} to the booker, citing the data.`, evidence: ["Q1"] } });
      onPartial?.({ summary: { text: "Summ", evidence: [] } });
      onPartial?.({ summary: { text: "Summary of the whole tour in one line.", evidence: ["Q1"] }, stops: [why("s1")] });
      onPartial?.({ summary: { text: "Summary of the whole tour in one line.", evidence: ["Q1"] }, stops: [why("s1"), why("s2")] });
      const done = { summary: { text: "Summary of the whole tour in one line.", evidence: ["Q1"] }, stops: [why("s1"), why("s2")], theme: [], merch: [], risks: [] };
      onPartial?.(done);
      return done;
    },
  };
  const events = await collect(planTour({ artist, region: "United States", stops: 2 }, undefined, provider));
  const texts = events.filter((e) => e.type === "stop_text");
  assert.deepEqual(texts.map((e) => e.stopId), ["s1", "s2"]);
  assert.equal(texts[0].pitch.text, "Pitch s1 to the booker, citing the data.");
  assert.equal(events.filter((e) => e.type === "summary").length, 1);
  assert.ok(events.findIndex((e) => e.type === "stop_text") < events.findIndex((e) => e.type === "plan"));
});

test("a degenerate model payload is recognised as unusable", async () => {
  const { usableSynthesis } = await import("../src/lib/llm.ts");
  const long = (t: string) => ({ text: `${t} with enough words to be a real sentence.`, evidence: ["Q1"] });
  assert.equal(usableSynthesis({ summary: { text: "text", evidence: [] }, stops: [] }, ["s1", "s2"]), false);
  assert.equal(usableSynthesis({ summary: long("Summary"), stops: [{ stop_id: "s1", why: long("Why"), pitch: long("Pitch") }] }, ["s1", "s2"]), true);
  assert.equal(usableSynthesis({ summary: long("Summary"), stops: [] }, ["s1", "s2"]), false);
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

test("each demo poster lists its captured route's cities in order, and has a recorded scout exchange", async () => {
  const { readFileSync } = await import("node:fs");
  const { PRESETS } = await import("../src/lib/tour/presets.ts");
  for (const p of PRESETS) {
    const run = JSON.parse(readFileSync(new URL(`../public/presets/${p.slug}.json`, import.meta.url), "utf8"));
    const plan = run.events.find((e: any) => e.event.type === "plan").event.plan;
    const cities = [...plan.stops].sort((a: any, b: any) => a.order - b.order).map((s: any) => s.city.name.replace(", ME", " ME"));
    assert.deepEqual(p.bill, cities, p.slug);
    assert.ok(plan.coverage?.cells?.length, `${p.slug} has hotspot cells for the map`);
    assert.ok(run.scout?.events.some((e: any) => e.event.type === "answer"), `${p.slug} has a recorded scout answer`);
  }
});

test("rooms that are not venues (a farm, a heritage railway) are dropped before a city is scored", async () => {
  const { sanitizeRooms } = await import("../src/lib/tour/cities.ts");
  const room = (name: string) => ({ id: name, name, affinity: 0.88 });
  const { kept, dropped } = await sanitizeRooms([room("Magic Forest Farm"), room("Catskill Mountain Railroad"), room("Fuze Box"), room("The Iron Horse")], { name: "Albany", query: "Albany, New York" });
  assert.deepEqual(kept.map((r) => r.name), ["Fuze Box", "The Iron Horse"]);
  assert.equal(dropped, 2);
});

test("the README and Devpost request excerpts match the stored Big Thief capture (regenerate with npm run docs:excerpt)", async () => {
  const { readFileSync } = await import("node:fs");
  const { requestExcerpt, EXCERPT_START, EXCERPT_END } = await import("../src/lib/tour/excerpt.ts");
  const excerpt = requestExcerpt(JSON.parse(readFileSync(new URL("../public/presets/us-indie-band.json", import.meta.url), "utf8")));
  for (const file of ["../README.md", "../docs/SUBMISSION.md"]) {
    const doc = readFileSync(new URL(file, import.meta.url), "utf8");
    const block = doc.slice(doc.indexOf(EXCERPT_START) + EXCERPT_START.length, doc.indexOf(EXCERPT_END)).trim();
    assert.equal(block, excerpt, `${file} excerpt is stale`);
  }
});

test("plain-language notes have no empty clauses, stray spaces or doubled punctuation (every preset)", async () => {
  const { readFileSync } = await import("node:fs");
  const { PRESETS } = await import("../src/lib/tour/presets.ts");
  const { coverageText } = await import("../src/lib/tour/coverage-text.ts");
  const bad = /\s[.,;:)]|\(\s|\s{2,}|\.\.|,,|\(\)/;
  for (const p of PRESETS) {
    const run = JSON.parse(readFileSync(new URL(`../public/presets/${p.slug}.json`, import.meta.url), "utf8"));
    const plan = run.events.find((e: any) => e.event.type === "plan").event.plan;
    const text = coverageText(plan.coverage, plan.coverage.region);
    assert.doesNotMatch(text, bad, `${p.slug}: "${text}"`);
    for (const t of [plan.summary, ...plan.stops.flatMap((s: any) => [s.why, s.pitch])].filter(Boolean)) assert.doesNotMatch(t.text.replace(/\n/g, " "), /\s[.,]|\s{3,}/, `${p.slug}: "${t.text}"`);
  }
  // An empty or zero clause never leaves a gap.
  assert.doesNotMatch(coverageText({ basis: "hotspots", hotspotCells: 20, remoteCells: 0, hotspotMarkets: 7, roomFallback: false, scored: 6, unscored: [], limited: false }, "United Kingdom"), bad);
});

test("source line stays precise after a scout change: a captured plan is never relabelled as live data", async () => {
  const { editedOrigin, sourceLabel, baseOrigin } = await import("../src/lib/tour/source-label.ts");
  const d = () => "Oct 6";
  const preset = { kind: "preset" as const, slug: "us-indie-band", capturedAt: "2026-10-06T00:00:00Z" };
  assert.equal(sourceLabel(preset, d), "Captured from live Qloo data on Oct 6");
  // A recorded scout answer applied (no new Qloo calls).
  const applied = editedOrigin(preset, false);
  assert.equal(sourceLabel(applied, d), "Captured from live Qloo data on Oct 6 · scout change applied");
  assert.equal(baseOrigin(applied)?.kind, "preset"); // so the "not affiliated" note stays
  // A live scout question or a change that made live Qloo calls says so; it stays live once live.
  assert.equal(sourceLabel(editedOrigin(applied, true), d), "Captured from live Qloo data on Oct 6 · scout change from live Qloo data");
  assert.equal(sourceLabel(editedOrigin(editedOrigin(preset, true), false), d), "Captured from live Qloo data on Oct 6 · scout change from live Qloo data");
  // A live run stays a live run.
  assert.equal(sourceLabel(editedOrigin({ kind: "live" }, false), d), "Live Qloo data");
});
