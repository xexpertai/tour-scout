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
  // Stops are fan-hotspot cities first, filled with nearby touring markets so the run stays drivable.
  const hot = plan.stops.filter((s: any) => s.city.hotspot);
  assert.ok(hot.length >= 2 && hot.every((s: any) => ids.has(s.city.hotspot.evidence)), "the tour is built on fan hotspots");
  assert.ok(plan.coverage.regional && plan.coverage.regional.longestLegKm <= plan.coverage.regional.maxLegKm, "no leg over the limit");
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
  // A withheld why or pitch is replaced by the code-written one (labelled TEMPLATE), never left blank.
  assert.equal(s1.why?.kind, "template");
  assert.doesNotMatch(s1.why?.text ?? "", /sell out/);
  // A withheld pitch is replaced by the code-written one (labelled TEMPLATE), never left blank.
  assert.equal(s1.pitch?.kind, "template");
  assert.doesNotMatch(s1.pitch?.text ?? "", /affluent/);
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

test("the README and Devpost request excerpts match the stored lead-demo capture (regenerate with npm run docs:excerpt)", async () => {
  const { readFileSync } = await import("node:fs");
  const { requestExcerpt, EXCERPT_START, EXCERPT_END } = await import("../src/lib/tour/excerpt.ts");
  const excerpt = requestExcerpt(JSON.parse(readFileSync(new URL("../public/presets/us-emerging.json", import.meta.url), "utf8")));
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
  const missing = coverageText({ basis: "hotspots", heatmap: "missing", hotspotCells: 0, remoteCells: 0, hotspotMarkets: 0, roomFallback: true, scored: 6, unscored: [], limited: true }, "United States");
  assert.match(missing, /didn't answer in time/);
  assert.match(coverageText({ basis: "hotspots", hotspotCells: 20, remoteCells: 20, hotspotMarkets: 0, roomFallback: true, scored: 6, unscored: [], limited: true }, "United States"), /rooms-led plan/);
  assert.doesNotMatch(missing, /found 0 hotspots|only 0/);
  assert.match(coverageText({ basis: "hotspots", heatmap: "saved", heatmapSavedAt: "2026-10-05T10:00:00Z", hotspotCells: 20, remoteCells: 0, hotspotMarkets: 7, roomFallback: false, scored: 6, unscored: [], limited: false }, "United States"), /saved on 2026-10-05/);
});

test("source line stays precise after a scout change: a captured plan is never relabelled as live data", async () => {
  const { editedOrigin, sourceLabel, baseOrigin } = await import("../src/lib/tour/source-label.ts");
  const d = () => "Oct 6";
  const preset = { kind: "preset" as const, slug: "us-emerging", capturedAt: "2026-10-06T00:00:00Z" };
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

test("routes are regional: no leg over the limit, the densest hotspot region, fewer stops rather than a zig-zag", async () => {
  const { pickStops, chooseRegion, bestOrder, legs, MAX_LEG_KM } = await import("../src/lib/tour/region.ts");
  const { MARKETS } = await import("../src/lib/markets.ts");
  const mk = (n: string) => MARKETS.find((m) => m.name === n)!;
  // The judge's live run: hotspots scattered over Salt Lake City, Austin, Madison and New England.
  const hot = ["Salt Lake City", "Austin", "Madison", "Northampton", "Burlington", "Boston", "Albany"].map((n) => ({ market: mk(n), cells: 1 }));
  const region = chooseRegion(hot);
  assert.ok(["Northampton", "Albany", "Boston", "Burlington"].includes(region.seed.name), region.seed.name);
  assert.deepEqual(region.elsewhere.map((h) => h.market.name).sort(), ["Austin", "Madison", "Salt Lake City"]);
  // Mark Normand's old route (Denver → Austin → Providence → Burlington) cannot be picked.
  const cities = ["Denver", "Austin", "Providence", "Burlington", "Boston", "Albany"].map((n, i) => ({ ...mk(n), name: n, affinity: 0.9 - i * 0.003 }));
  const { picked, longestLegKm } = pickStops(cities, 4);
  assert.deepEqual(picked.map((c) => c.name).sort(), ["Albany", "Boston", "Burlington", "Providence"]);
  assert.ok(longestLegKm <= MAX_LEG_KM);
  const pts = picked.map((c) => ({ lat: c.lat!, lng: c.lng! }));
  assert.ok(Math.max(...legs(pts, bestOrder(pts))) <= MAX_LEG_KM);
  // Only two cities within reach: two stops, not four across the country.
  const scattered = ["Seattle", "Denver", "Austin", "Atlanta", "Boston", "Providence"].filter((n) => mk(n)).map((n, i) => ({ ...mk(n), name: n, affinity: 0.9 - i * 0.01 }));
  assert.deepEqual(pickStops(scattered, 4).picked.map((c) => c.name).sort(), ["Boston", "Providence"]);
});

test("the route says where it stays, how far the longest drive is, and where else fans are", async () => {
  const { coverageText } = await import("../src/lib/tour/coverage-text.ts");
  const base = { basis: "hotspots" as const, hotspotCells: 20, remoteCells: 0, hotspotMarkets: 7, roomFallback: false, scored: 6, unscored: [], limited: false };
  const text = coverageText({ ...base, regional: { around: "Northampton", maxLegKm: 400, longestLegKm: 280, stops: 3, asked: 4, elsewhere: ["Austin", "Madison"] } }, "United States");
  assert.match(text, /stays around Northampton: the longest drive between stops is about 350 km \(4 h\)/);
  assert.match(text, /Only 3 strong cities sit within a day's drive/);
  assert.match(text, /Fans also concentrate around Austin and Madison: a second run\./);
  assert.match(coverageText({ ...base, anchorsAbsent: ["New York", "Los Angeles"] }, "United States"), /New York and Los Angeles are not among these fans' hotspots, so this run is built on the secondary markets where they are/);
  const { routeOrder } = await import("../src/lib/tour/plan.ts");
  const stop = (name: string, lat: number, lng: number, affinity: number) => ({ stopId: name, city: { entityId: name, name, affinity, lat, lng, evidence: "Q1" }, venues: [] }) as never;
  const order = routeOrder([stop("Boston", 42.36, -71.06, 0.9), stop("Albany", 42.65, -73.76, 0.8), stop("Northampton", 42.33, -72.64, 0.85)], { lat: 42.65, lng: -73.9 });
  assert.equal((order[0] as { city: { name: string } }).city.name, "Albany", "the route starts nearest the start city");
});

test("route check geometry: Providence can replace Portland, ME on a Burlington–Philadelphia run (shorter drive)", async () => {
  const { swapFits } = await import("../src/lib/tour/region.ts");
  const { MARKETS } = await import("../src/lib/markets.ts");
  const pt = (n: string) => { const m = MARKETS.find((x) => x.name === n)!; return { lat: m.lat, lng: m.lng }; };
  const stops = ["Burlington", "Portland, ME", "Boston", "New York", "Philadelphia"].map(pt);
  const r = swapFits(stops, 1, pt("Providence"));
  assert.ok(r.fits && r.extraKm < 0, JSON.stringify(r));
  assert.equal(swapFits(stops, 1, pt("Chicago")).fits, false, "a far city breaks the run");
});

test("the AI state is reported as it really is (no key means template)", async () => {
  const { llmStatus } = await import("../src/lib/llm.ts");
  const saved = { p: process.env.LLM_PROVIDER, c: process.env.CLAUDE_API_KEY, g: process.env.GEMINI_API_KEY };
  process.env.LLM_PROVIDER = "claude"; delete process.env.CLAUDE_API_KEY; delete process.env.GEMINI_API_KEY;
  try {
    assert.deepEqual(llmStatus(), { provider: "claude", available: false, reason: "CLAUDE_API_KEY is not set" });
  } finally {
    for (const [k, v] of [["LLM_PROVIDER", saved.p], ["CLAUDE_API_KEY", saved.c], ["GEMINI_API_KEY", saved.g]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("openers a booker would not pitch are skipped: supergroups, and actor-first people for a comedian", async () => {
  const { unlikelyOpener } = await import("../src/lib/tour/pipeline.ts");
  assert.equal(unlikelyOpener("An American country supergroup formed to amplify women's voices in country music.", false), true);
  assert.equal(unlikelyOpener("Canadian actor and comedian", true), true);
  assert.equal(unlikelyOpener("American actress, comedian, author and television personality", true), true);
  assert.equal(unlikelyOpener("American comedian and actor", true), false);
  assert.equal(unlikelyOpener("American actor and stand-up comedian", true), false);
  assert.equal(unlikelyOpener("American singer-songwriter and actress known for indie music.", false), false);
});

test("a comedian's rooms lead with comedy clubs", async () => {
  const { COMEDY_ROOM } = await import("../src/lib/tour/cities.ts");
  for (const n of ["Comedy Cellar", "Laugh Boston", "Helium Comedy Club", "Stand Up NY", "Punch Line Philly", "Improv Asylum"]) assert.match(n, COMEDY_ROOM);
  for (const n of ["Littlefield", "Union Hall", "The Bell House", "Parkside Lounge"]) assert.doesNotMatch(n, COMEDY_ROOM);
});

test("a strong city left off the route says why: outside this run, with the distance (every preset)", async () => {
  const { readFileSync } = await import("node:fs");
  const { PRESETS } = await import("../src/lib/tour/presets.ts");
  const { offRouteCities, offRouteText } = await import("../src/lib/tour/coverage-text.ts");
  const found: Record<string, string[]> = {};
  for (const p of PRESETS) {
    const run = JSON.parse(readFileSync(new URL(`../public/presets/${p.slug}.json`, import.meta.url), "utf8"));
    const cities = run.events.filter((e: any) => e.event.type === "cities").at(-1).event.cities;
    const plan = run.events.find((e: any) => e.event.type === "plan").event.plan;
    const stops = new Set(plan.stops.map((s: any) => s.city.name));
    const off = offRouteCities(cities, (c) => stops.has(c.name));
    found[p.slug] = off.map((o) => o.name);
    for (const o of off) assert.ok(o.roadKm > 400 && !stops.has(o.name), JSON.stringify(o));
    if (off.length) assert.doesNotMatch(offRouteText(off), /\s[.,;:)]|\(\s|\s{2,}|\.\./);
  }
  // Joe List: Austin ranks #2 by room affinity but is a ~2,800 km drive from the New York run.
  assert.deepEqual(found["us-comedian"], ["Austin"]);
  assert.match(offRouteText([{ name: "Austin", roadKm: 2800, nearest: "Washington, DC" }]), /^Austin \(about 2,800 km by road from Washington, DC\) scores well but is too far from this route to drive between shows, so it is left for a separate run\.$/);
});

test("the proposed change reads as words: swap, add or drop", async () => {
  const { changeText } = await import("../src/lib/tour/source-label.ts");
  assert.equal(changeText("+ Washington, DC (92.1) · − Albany (88.7)"), "Swap Albany (88.7) → Washington, DC (92.1)");
  assert.equal(changeText("+ Charlotte (92.0)"), "Add Charlotte (92.0)");
  assert.equal(changeText("− Albany (88.7)"), "Drop Albany (88.7)");
  assert.equal(changeText("opener → Hop Along"), "Opener → Hop Along");
  const { slimChange } = await import("../src/lib/tour/source-label.ts");
  assert.equal(slimChange("Swap Albany (88.7) → Providence (91.3)"), "Albany → Providence (91.3)", "one line names both cities");
  assert.equal(slimChange("Swap Indianapolis (89.0) → Charlotte (92.0); support slot with → Tomberlin"), "Indianapolis → Charlotte (92.0); support slot with → Tomberlin");
  assert.equal(changeText("+ Charlotte (92.0) · − Indianapolis (89.0) · support slot with → Tomberlin"), "Swap Indianapolis (89.0) → Charlotte (92.0); support slot with → Tomberlin");
});

test("who chose the route check's Qloo calls matches Credits: server pre-check vs agent", async () => {
  const { readFileSync } = await import("node:fs");
  const { agentCallsNote } = await import("../src/lib/tour/source-label.ts");
  const run = JSON.parse(readFileSync(new URL("../public/presets/us-emerging.json", import.meta.url), "utf8"));
  const f = run.scout.events.find((e: any) => e.event.type === "answer").event.followUp;
  assert.equal(f.sources.length, 15);
  assert.equal(agentCallsNote(f), "The server ran 7 standard checks first (the nearby cities' rooms); the agent chose 8 more Qloo requests. The verdict sentence is written by code from their numbers, so it can’t overstate them.");
  assert.equal(agentCallsNote({ sources: [1, 2], answer: { kind: "interpretation" } }), "The agent chose these 2 Qloo requests.");
});

test("the route check answers the opener half: which stops it looked up, and that the size flags stay", async () => {
  const { readFileSync } = await import("node:fs");
  const run = JSON.parse(readFileSync(new URL("../public/presets/us-comedian.json", import.meta.url), "utf8"));
  const f = run.scout.events.find((e: any) => e.event.type === "answer").event.followUp;
  assert.ok(f.checks.some((c: any) => /^Feature acts: the check looked up Qloo's similar acts for Washington, DC, Providence, Philadelphia, Boston and New York and proposes no change, so the "above your size fit" flags on Washington, DC, Philadelphia, Providence, Boston stay\.$/.test(c.text)));
  const { openerCheckLine } = await import("../src/lib/tour/scout.ts");
  const plan = run.events.find((e: any) => e.event.type === "plan").event.plan;
  const providence = plan.stops.find((s: any) => s.city.name === "Providence");
  assert.match(openerCheckLine(plan, [{ city: "Providence", evidence: "Q46", smallerFound: false }], false)!.text, /no other act within Joe List's size fit there/);
  assert.equal(openerCheckLine(plan, [{ city: "Providence", evidence: "Q46" }], true), undefined, "an opener change is described by the answer itself");
  assert.equal(openerCheckLine(plan, [{ city: "Providence", evidence: "Q46" }], false, { add: [], remove: [providence.stopId] }), undefined, "a dropped stop's opener is not reported");
});

test("the guard withholds implied venue partnerships", async () => {
  const { planClaims } = await import("../src/lib/guard.ts");
  assert.match(planClaims("Boston why", "O'Briens Pub and partner venues suit introspective indie folk.", {})!, /partnership/);
  assert.match(planClaims("Burlington why", "Monkey House and partner rooms draw indie folk fans.", {})!, /partnership/);
  assert.equal(planClaims("risks", "Confirm availability with each venue before announcing partnerships.", {}), undefined, "advice about partnerships is fine");
});

test("a higher-scoring city left off a drivable route says why (S.G. Goodman: St. Louis)", async () => {
  const { readFileSync } = await import("node:fs");
  const { skippedCityText } = await import("../src/lib/tour/coverage-text.ts");
  const texts: Record<string, string> = {};
  for (const slug of ["us-emerging", "us-comedian", "us-americana"]) {
    const run = JSON.parse(readFileSync(new URL(`../public/presets/${slug}.json`, import.meta.url), "utf8"));
    const cities = run.events.filter((e: any) => e.event.type === "cities").at(-1).event.cities;
    const plan = run.events.find((e: any) => e.event.type === "plan").event.plan;
    const stops = new Set(plan.stops.map((s: any) => s.city.name));
    texts[slug] = skippedCityText(cities, (c) => stops.has(c.name));
  }
  assert.equal(texts["us-americana"], "St. Louis (89.9) scores above Indianapolis (89.0), but swapping it in would put a leg over a day's drive, and the two are effectively tied.");
  assert.equal(texts["us-comedian"], "", "Austin is explained as outside the run instead");
});

test("after Apply, kept AI text is checked against the new plan: a stale summary becomes code-written", async () => {
  const { readFileSync } = await import("node:fs");
  const { recheckKeptText } = await import("../src/lib/tour/apply.ts");
  const run = JSON.parse(readFileSync(new URL("../public/presets/us-emerging.json", import.meta.url), "utf8"));
  const plan = run.events.find((e: any) => e.event.type === "plan").event.plan;
  const albany = plan.stops.find((s: any) => s.city.name === "Albany");
  // Providence joins in Albany's place: not near a fan hotspot, and the route now starts in Burlington.
  const providence = { ...albany, stopId: "s9", city: { ...albany.city, name: "Providence", affinity: 0.913, hotspot: undefined, lat: 41.824, lng: -71.4128 }, why: undefined, pitch: undefined };
  const order = ["Burlington", "Boston", "Providence", "New York", "Philadelphia"];
  const stops = [...plan.stops.filter((s: any) => s !== albany), providence].map((s: any) => ({ ...s, order: order.indexOf(s.city.name) + 1 }));
  const stale = { text: "This tour charts five cities from Boston to Philadelphia, all near Qloo fan hotspots.", evidence: ["Q6"], kind: "interpretation" };
  const next = recheckKeptText({ ...plan, stops, candidates: [...plan.candidates, providence.city], summary: stale }, "+ Providence (91.3) · − Albany (88.7)");
  assert.equal(next.summary!.kind, "template");
  assert.match(next.summary!.text, /^Route updated by the scout \(\+ Providence/);
  const fine = { text: "Maya is a new act aimed at fans of Joanna Sternberg.", evidence: ["Q6"], kind: "interpretation" };
  assert.equal(recheckKeptText({ ...plan, stops, candidates: [...plan.candidates, providence.city], summary: fine }, "x").summary!.text, fine.text, "a summary that still holds is kept");
});

test("the route-check verdict quotes the same driving number as the agent's tool (same source, same rounding)", async () => {
  const { readFileSync } = await import("node:fs");
  const { routeVerdict } = await import("../src/lib/tour/scout.ts");
  const { swapFits, ROAD_FACTOR } = await import("../src/lib/tour/region.ts");
  const run = JSON.parse(readFileSync(new URL("../public/presets/us-emerging.json", import.meta.url), "utf8"));
  const plan = run.events.find((e: any) => e.event.type === "plan").event.plan;
  const f = run.scout.events.find((e: any) => e.event.type === "answer").event.followUp;
  const st = plan.stops.filter((s: any) => s.city.lat !== undefined);
  const added = f.proposal.add[0], removed = st.findIndex((s: any) => s.stopId === f.proposal.remove[0]);
  const tool = Math.round((swapFits(st.map((s: any) => ({ lat: s.city.lat, lng: s.city.lng })), removed, { lat: added.lat, lng: added.lng }).extraKm * ROAD_FACTOR) / 10) * 10;
  const verdict = routeVerdict(plan, f.pins, f.proposal).text;
  assert.match(verdict, new RegExp(`≈ ${Math.abs(tool)} km ${tool < 0 ? "less" : "more"} driving`), verdict);
  assert.equal(tool, -130, "Maya: Providence for Albany");
});

test("a stored plan's source line comes from the plan, so every visitor of a share link reads the same line", async () => {
  const { planOrigin, sourceLabel, editedOrigin } = await import("../src/lib/tour/source-label.ts");
  const d = () => "Oct 7";
  const demo = { createdAt: "2026-10-08T00:00:00Z", demo: { capturedAt: "2026-10-07T00:00:00Z" } };
  assert.equal(sourceLabel(planOrigin(demo), d), "Shared demo plan, captured from live Qloo data on Oct 7");
  // A plan made by Apply keeps "scout change" for everyone; "from live Qloo data" only when that Apply made Qloo calls.
  assert.equal(sourceLabel(planOrigin({ ...demo, parentId: "p", appliedLive: true }), d), "Shared demo plan, captured from live Qloo data on Oct 7 · scout change from live Qloo data");
  assert.equal(sourceLabel(planOrigin({ ...demo, parentId: "p" }), d), "Shared demo plan, captured from live Qloo data on Oct 7 · scout change applied");
  // A question alone (a copy with an answer) is not called a change, in the session or on reload.
  const preset = { kind: "preset" as const, slug: "us-emerging", capturedAt: "2026-10-07T00:00:00Z" };
  const asked = editedOrigin(preset, false, true);
  assert.equal(sourceLabel(asked, d), "Captured from live Qloo data on Oct 7");
  assert.equal(asked.kind, "edited"); // later questions go to the copy, not the demo
  // Applying after a question is a change.
  assert.equal(sourceLabel(editedOrigin(asked, true), d), "Captured from live Qloo data on Oct 7 · scout change from live Qloo data");
});

test("the route check's trace splits into the server's standard check, the agent's own requests and the verdict, from the recording", async () => {
  const { readFileSync } = await import("node:fs");
  const { addCheck, settle, verdictCheck, traceGroups } = await import("../src/lib/tour/trace.ts");
  for (const [slug, server, agent, verdict] of [["us-emerging", 7, 8, "proposed: Swap Albany (88.7) → Providence (91.3)"], ["us-comedian", 7, 5, "no change proposed"]] as const) {
    const run = JSON.parse(readFileSync(new URL(`../public/presets/${slug}.json`, import.meta.url), "utf8"));
    let checks: any[] = [], seen = 0, f: any;
    for (const { event: e } of run.scout.events) {
      if (e.type === "checking" || e.type === "step") checks = addCheck(checks, e, seen);
      else if (e.type === "source") seen++;
      else if (e.type === "answer") { f = e.followUp; checks = [...settle(checks), verdictCheck(f)]; }
    }
    const g = traceGroups(checks, f)!;
    assert.equal(g.server.requests, server, slug);
    assert.equal(g.agent.requests, agent, slug);
    assert.equal(g.server.checks.length, server, `${slug}: one line per server request`);
    assert.ok(g.server.checks[0].label.startsWith("ranking the cities near your route"), slug);
    assert.ok(g.agent.checks.every((c: any) => !/rooms scored|no rooms found/.test(c.label)), `${slug}: no server step among the agent's`);
    assert.equal(g.verdict.check.label, verdict);
    assert.equal(g.verdict.codeWritten, true);
  }
  // While the scout works, or for a quick question, there are no groups.
  assert.equal(traceGroups([{ label: "x", status: "running" }], { kind: "agent", sources: [], answer: { text: "", evidence: [], kind: "template" } } as any), undefined);
});

test("every image the README and the Devpost text (docs/SUBMISSION.md) list exists in the repo", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const root = new URL("../", import.meta.url);
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const submission = readFileSync(new URL("docs/SUBMISSION.md", root), "utf8");
  const refs = [...readme.matchAll(/\]\(((?:docs\/)?screenshots\/[^)\s]+|docs\/[^)\s]+\.(?:png|gif|jpg))\)/g)].map((m) => m[1]);
  const gallery = [...submission.matchAll(/`([\w-]+\.(?:png|gif|jpg))`/g)].map((m) => `docs/screenshots/${m[1]}`);
  assert.ok(refs.length >= 8 && gallery.length >= 8, `found ${refs.length} README and ${gallery.length} gallery images`);
  for (const path of [...refs, ...gallery]) assert.ok(existsSync(new URL(path, root)), `missing ${path}`);
});

test("while a plan streams, no city on the final route is called skipped (Maya: Boston arrives last)", async () => {
  const { readFileSync } = await import("node:fs");
  const { routeNotes } = await import("../src/lib/tour/coverage-text.ts");
  for (const slug of ["us-emerging", "us-comedian", "us-americana"]) {
    const run = JSON.parse(readFileSync(new URL(`../public/presets/${slug}.json`, import.meta.url), "utf8"));
    const finalStops = new Set<string>(run.events.find((e: any) => e.event.type === "plan").event.plan.stops.map((s: any) => s.city.name));
    let cities: any[] = [];
    const arrived = new Set<string>();
    let complete = false;
    let ungatedFalse = 0;
    for (const { event } of run.events) {
      if (event.type === "cities") cities = event.cities;
      if (event.type === "stop") arrived.add(event.stop.city.name);
      if (event.type === "plan") complete = true;
      if (!cities.length) continue;
      const isStop = (c: any) => arrived.has(c.name);
      const notes = routeNotes(cities, isStop, complete);
      const text = `${notes.skipped} ${notes.offText}`;
      for (const name of finalStops) {
        if (!complete) assert.ok(!text.includes(name), `${slug}: "${name}" is on the final route but a streaming note names it: ${text}`);
      }
      if (!complete) assert.equal(notes.cut, 0, "no cut line until the route is final");
      // Without the gate, the bug the judges saw: a final stop named as skipped mid-stream.
      const raw = routeNotes(cities, isStop, true);
      if (!complete && [...finalStops].some((n) => !arrived.has(n) && `${raw.skipped} ${raw.offText}`.includes(`${n} (`))) ungatedFalse++;
    }
    assert.ok(complete);
    if (slug === "us-emerging") assert.ok(ungatedFalse > 0, "the Maya replay does stream Boston last (guards against a vacuous test)");
  }
});
