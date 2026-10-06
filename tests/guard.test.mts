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
