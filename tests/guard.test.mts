import assert from "node:assert/strict";
import { test } from "node:test";
import { toInsight, unsupportedClaim } from "../src/lib/guard.ts";

test("withholds financial-status, sensitive-trait and certainty claims", () => {
  for (const text of [
    "Aundh has high disposable income residents",
    "An affluent crowd lives here",
    "Target high-earning young professionals",
    "Strong middle-class neighbourhood",
    "Popular with a particular religious community",
    "Customers will definitely love vinyl nights",
  ]) assert.ok(unsupportedClaim(text), text);
});

test("withholds attendance forecasts and individual-fan claims", () => {
  for (const text of [
    "This show will sell out the Fillmore",
    "Expect 500 fans will attend in Austin",
    "Expected turnout is high in Denver",
    "This fan lives near the venue",
  ]) assert.ok(unsupportedClaim(text), text);
});

test("withholds capacity-fit claims, demographic targeting and 'confirmed' demand", () => {
  for (const text of [
    "The Iron Horse matches the 300–900 capacity (artist target).",
    "Hudson Park venues match the 300–900 capacity range",
    "Perfect fit for your programming and venue capacity needs (200–600, artist's target).",
    "Frame the show for the older-skewing audience (45+).",
    "A simple, wearable item appeals to older fans.",
    "Ages 30–44 dominate here.",
    "Room affinity 89 and a nearby Qloo fan hotspot confirm audience depth.",
    "Burlington is a confirmed hotspot.",
    "Three stops target venues near fan hotspots, calibrated for our 80–250 capacity target.",
    "A key market with high-capacity venues suited to the act's national draw.",
    "Approachable comedy that connects with audiences who skew slightly male and older.",
    "The audience skews male and older (45–54 index +0.53), drawn to his commentary.",
    "A male-leaning crowd that loves bold comedy.",
    "Fans are mostly women in their twenties.",
  ]) assert.ok(unsupportedClaim(text), text);
  for (const text of [
    "We're looking at rooms of 300–900 (our own target).",
    "Room affinity 88, near a Qloo fan hotspot.",
    "The audience over-indexes at ages 30–34 in aggregate.",
    "Ages 45–54 over-index (+0.53, Qloo aggregate).",
    "Affinity reflects room fit, not confirmed demand or turnout.",
  ]) assert.equal(unsupportedClaim(text), undefined, text);
});

test("room sizes must be the user's own: invented or altered ranges are withheld", async () => {
  const { inventedCapacity } = await import("../src/lib/guard.ts");
  assert.ok(inventedCapacity("We're looking at rooms of 1,500–3,000 (our own target).", undefined));
  assert.ok(inventedCapacity("We're looking for a room of 100–250 (our target).", [300, 900]));
  assert.equal(inventedCapacity("We're looking at rooms of 300–900 (our own target).", [300, 900]), undefined);
  assert.equal(inventedCapacity("Ages 25–34 over-index; stops 2–5 are in New England.", undefined), undefined);
  assert.equal(inventedCapacity("Comedy rooms with room affinity 84–92 across four cities.", undefined), undefined);
});

test("stop text that names a city off the route is withheld", async () => {
  const { insightGuard } = await import("../src/lib/guard.ts");
  const { guard, withheld } = insightGuard(new Set(["Q1"]), false, { offRoute: ["Chicago", "Montreal"] });
  assert.equal(guard("summary", { text: "Four stops led by Austin and Chicago.", evidence: ["Q1"] }), undefined);
  assert.ok(guard("summary", { text: "Four stops led by Austin and Denver.", evidence: ["Q1"] }));
  assert.ok(guard("theme", { text: "Chicago-style deep-dish merch night.", evidence: ["Q1"] }), "themes may mention other places");
  assert.match(withheld[0].reason, /Chicago/);
});

test("allows ordinary product and taste language", () => {
  for (const text of [
    "Strong affinity for indie folk suggests acoustic evenings",
    "Offer premium single-origin pour-overs",
    "Host Formula 1 race screenings",
    "Rich chocolate desserts pair well with filter coffee",
    "Fans of this artist show strong affinity for Chicago",
    "Pitch a 300-capacity room to the booker",
    "Open with an act that fans like Norah Jones would enjoy",
  ]) assert.equal(unsupportedClaim(text), undefined, text);
});

test("keeps only real evidence ids and labels the item by provenance", () => {
  const valid = new Set(["Q1", "Q2"]);
  assert.deepEqual(toInsight({ text: "x", evidence: ["Q1", "Q9", "Q1"] }, valid), { text: "x", evidence: ["Q1"], kind: "interpretation" });
  assert.equal(toInsight({ text: "y", evidence: ["Q9"] }, valid)?.kind, "general");
  assert.equal(toInsight({ text: "   ", evidence: ["Q1"] }, valid), undefined);
});

test("a pitch is sendable: addressed to the room and its town, plain words, a clear ask, placeholders; jargon is withheld", async () => {
  const { templatePitch } = await import("../src/lib/llm.ts");
  const { pitchJargon, insightGuard } = await import("../src/lib/guard.ts");
  const { venueTown } = await import("../src/lib/text.ts");
  assert.equal(venueTown({ address: "30 Main St Winooski, VT 05404", town: "Burlington" }), "Winooski");
  assert.equal(venueTown({ address: "1 Broadway New York, NY 10004" }), undefined, "no guess without a street word");
  const input = { artist: { name: "Act", arenaScale: false }, capacity: [200, 400] as [number, number], fan: { tags: [], alsoLikes: [] }, stops: [] } as never;
  const stop = { stop_id: "s1", city: "Burlington", affinity: 88.4, evidence: "Q7", cluster: "Old North End", venues: ["Monkey House"], pitchTo: { venue: "Monkey House", town: "Winooski" }, opener: "Julia Jacklin", shared: ["Melodic"] };
  const text = templatePitch(input, stop, "Act");
  assert.match(text, /^Subject: Act at Monkey House, \[dates\]/);
  assert.match(text, /Hi Monkey House team,/);
  assert.match(text, /a date at Monkey House in Winooski/);
  assert.match(text, /fans concentrated around Old North End/);
  for (const p of ["[dates]", "[draw / last play in the area]", "[ticket price]", "[links]"]) assert.ok(text.includes(p), p);
  assert.match(text, /Do you have a hold around \[dates\]\?/);
  assert.equal(pitchJargon(text), undefined);
  assert.ok(pitchJargon("Room affinity 88.4 in Old North End venues."));
  assert.ok(pitchJargon("Strong numbers (Q7)."));
  const { guard } = insightGuard(new Set(["Q7"]));
  assert.equal(guard("Burlington pitch", { text: "Room affinity 88.4 here.", evidence: ["Q7"] }), undefined, "withheld");
  assert.ok(guard("Burlington why", { text: "Room affinity 88.4 here.", evidence: ["Q7"] }), "the why may quote the score");
});

test("plan claims the data cannot back are withheld: he/she for the act, a new act's own music, hotspots that aren't there", async () => {
  const { planClaims, insightGuard } = await import("../src/lib/guard.ts");
  const o = { actName: "Maya", emerging: true, hotspotCities: ["Burlington"] };
  assert.ok(planClaims("risks", "Her own audience may differ.", o));
  assert.ok(planClaims("Boston pitch", "Maya's honest, introspective songwriting connects here.", o));
  assert.ok(planClaims("Boston pitch", "Maya brings confessional songs to Boston.", o));
  assert.equal(planClaims("Boston pitch", "Subject: Maya at O'Briens Pub", o), undefined);
  assert.match(planClaims("Boston pitch", "Maya is a new act whose audience lines up with yours: Qloo's taste data shows fans of Joanna Sternberg here favour indie-folk.", o)!, /audience for the new act/, "a new act has no audience of its own");
  assert.equal(planClaims("Boston pitch", "Maya is a new act aimed at fans of Joanna Sternberg: Qloo's taste data ranks Boston among the strongest cities for those fans.", o), undefined, "the skeleton's own line passes");
  assert.ok(planClaims("Boston pitch", "We'd love a slot with Tomberlin, whose audience shares tastes with ours.", o));
  assert.ok(planClaims("answer", "Tomberlin, already booked for New York, fits.", o));
  assert.ok(planClaims("Providence why", "Darlington is near a Qloo fan hotspot.", o), "no hotspot near Providence");
  assert.equal(planClaims("Burlington why", "Burlington sits near a Qloo fan hotspot.", o), undefined);
  assert.ok(planClaims("summary", "Five fan hotspots.", { hotspotCities: [] }));
  // Templated text is the fallback and is never withheld by these checks.
  const { guard } = insightGuard(new Set(["Q1"]), false, o);
  assert.equal(guard("risks", { text: "Her own audience may differ once touring.", evidence: [] }), undefined);
});

test("the guard withholds 'optimized' and unmeasured 'match well' claims", async () => {
  const { planClaims } = await import("../src/lib/guard.ts");
  assert.ok(planClaims("answer", "Route is optimized.", {}));
  assert.ok(planClaims("answer", "Current openers match fan tastes well.", {}));
  assert.ok(planClaims("answer", "Current openers are well-matched. No change needed—the lineup is strong.", {}));
  assert.equal(planClaims("answer", "Route holds: Providence is the weakest stop.", {}), undefined);
});

test("a summary may call only top-three cities 'among the strongest'", async () => {
  const { planClaims } = await import("../src/lib/guard.ts");
  const o = { cityRanks: { "New York": 1, "Washington DC": 3, Providence: 7 } };
  assert.ok(planClaims("summary", "Qloo's data ranks New York, Washington DC and Providence among the strongest cities.", o));
  assert.equal(planClaims("summary", "Qloo's data ranks New York and Washington DC among the strongest cities.", o), undefined);
});

test("a rank among the scored cities is not a national rank", async () => {
  const { planClaims } = await import("../src/lib/guard.ts");
  assert.ok(planClaims("Burlington why", "Burlington ranks #2 nationally for this audience.", {}));
  assert.equal(planClaims("Burlington why", "Burlington ranks #2 of the scored cities.", {}), undefined);
});

test("partnership rule: room/venue partnership claims are withheld, advice about people is not", async () => {
  const { planClaims } = await import("../src/lib/guard.ts");
  const o = { actName: "Maya", emerging: true, venues: ["Bowery Ballroom", "O'Briens Pub"] };
  const room = "implied a partnership between rooms that the data does not show";
  // Withheld: rooms or venues presented as partners.
  for (const t of [
    "Book the partner venues in Boston and Cambridge.",
    "Its sister rooms in Brooklyn draw the same crowd.",
    "The two rooms are partnered, so one hold covers both.",
    "There is a partnership between the venues on this run.",
    "Bowery Ballroom has partnered with a local club for years.",
    "The promoter partnered with the Bowery Ballroom last spring.",
    "Partner with the venue next door for a double bill.",
    "We are in partnership with O'Briens Pub here.",
  ]) assert.equal(planClaims("New York why", t, o), room, t);
  // A suggested act presented as booked is a booking claim.
  assert.equal(planClaims("New York why", "Maya is already partnered with Tomberlin here.", o), "presented a suggestion as a booking");
  // Allowed: plain advice about people.
  for (const t of [
    "Partner with a local act for the support slot to reach these fans.",
    "Partnering with Tomberlin for a support slot puts Maya in front of this audience.",
    "Consider partnering with a local promoter who knows the scene.",
    "Partner with a local act and pitch a show at Bowery Ballroom.",
  ]) assert.equal(planClaims("New York why", t, o), undefined, t);
});

test("round 7 guard rules: weak stops called strong, absolutes about the world, the route's span, fans in every stop", async () => {
  const { planClaims } = await import("../src/lib/guard.ts");
  const o = { cityRanks: { Albany: 5, Boston: 2, Philadelphia: 4 }, rankOf: 7, weakest: "Albany", routeEnds: ["Washington, DC", "Boston"] as [string, string], stopNames: ["Washington, DC", "Philadelphia", "New York", "Providence", "Boston"], hotspotCities: ["New York", "Boston"] };
  assert.match(planClaims("Albany why", "Albany is a strong fit on this route.", o)!, /weakest stop strong/);
  assert.equal(planClaims("Philadelphia why", "Philadelphia is a strong fit on this route.", o), undefined, "#4 of 7 is not the bottom third");
  assert.match(planClaims("Philadelphia why", "Philadelphia is a strong fit.", { ...o, cityRanks: { Philadelphia: 6 } })!, /bottom third/);
  assert.equal(planClaims("Boston why", "Boston is a strong fit on this route.", o), undefined, "a top-three stop may be called strong");
  assert.match(planClaims("answer", "The route holds. No stronger cities exist within a day's drive of Providence.", {})!, /absolute/);
  assert.equal(planClaims("answer", "No stronger city came up in the cities the check scored.", {}), undefined);
  assert.match(planClaims("summary", "This Northeast corridor route (New York through Providence) hits comedy rooms.", o)!, /span/);
  assert.equal(planClaims("summary", "The run goes from Washington, DC to Boston.", o), undefined, "the real ends pass");
  assert.match(planClaims("summary", "Five cities, each hosting fans who share core tastes in folk.", o)!, /only 2 of 5 stops/);
});

test("a superlative about the route's markets as a group needs every stop in the top third", async () => {
  const { planClaims } = await import("../src/lib/guard.ts");
  const o = { cityRanks: { "New York": 1, "Washington, DC": 3, Philadelphia: 4, Boston: 5, Providence: 6 }, rankOf: 8,
    stopNames: ["Washington, DC", "Philadelphia", "New York", "Providence", "Boston"], routeEnds: ["Washington, DC", "Boston"] as [string, string] };
  assert.match(planClaims("summary", "The route targets intimate rooms across the Northeast's strongest comedy markets.", o)!, /below the top third/);
  assert.match(planClaims("summary", "Five of the best cities for this audience.", o)!, /Philadelphia, Providence, Boston rank below/);
  const top = { ...o, cityRanks: { "Washington, DC": 1, Philadelphia: 2, "New York": 3, Providence: 2, Boston: 1 } };
  assert.equal(planClaims("summary", "The route takes in the strongest comedy markets the check scored.", top), undefined, "all stops in the top third");
  assert.equal(planClaims("Boston why", "Boston ranks among the strongest cities for this audience.", { cityRanks: { Boston: 2 } }), undefined, "per-stop lines keep their own rule");
});

test("the fan cluster is credited to the fan heatmap, not room data", async () => {
  const { planClaims } = await import("../src/lib/guard.ts");
  assert.match(planClaims("Boston why", "Qloo's room data shows Church Green concentrates fans of Joanna Sternberg.", {})!, /fan heatmap/);
  assert.equal(planClaims("Boston why", "Qloo's fan heatmap puts fans around Church Green; O'Briens Pub leads on room affinity.", {}), undefined);
});

