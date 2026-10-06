/**
 * The plain-language note on how a plan's cities were found. A pure function (no JSX) so tests can
 * check every preset's sentence for empty clauses, stray spaces and doubled punctuation.
 */
import type { Coverage } from "./types.ts";

const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function coverageText(c: Coverage, region = "the region"): string {
  const parts: string[] = [];
  if (c.basis === "hotspots") {
    parts.push(`Qloo's fan map of ${region} found ${s(c.hotspotCells, "hotspot", "hotspots")}${c.remoteCells > 0 ? ` (${c.remoteCells} far from any touring city)` : ""}.`);
    if (c.roomFallback) parts.push(`They pointed to only ${s(c.hotspotMarkets, "touring city", "touring cities")}, so cities whose rooms this audience favours were added.`);
    parts.push("Each nearby city is scored by its best-matching live room.");
  } else {
    parts.push("Your cities, each scored by its best-matching live room.");
  }
  if (c.droppedRooms) parts.push(`${s(c.droppedRooms, "unlikely room", "unlikely rooms")} (out of town or not a venue) ${c.droppedRooms === 1 ? "was" : "were"} left out.`);
  if (c.unscored.length) parts.push(`No matching rooms in ${c.unscored.join(", ")}.`);
  return parts.join(" ");
}
