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
