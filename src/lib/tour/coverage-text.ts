/**
 * The plain-language note on how a plan's cities were found. A pure function (no JSX) so tests can
 * check every preset's sentence for empty clauses, stray spaces and doubled punctuation.
 */
import { ROAD_FACTOR, driveHours } from "./region.ts";
import type { Coverage } from "./types.ts";

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function coverageText(c: Coverage, region = "the region"): string {
  const parts: string[] = [];
  if (c.basis === "hotspots" && c.heatmap === "missing") {
    parts.push(`Qloo's fan map of ${region} didn't answer in time, so cities were found from the rooms this audience favours.`);
    parts.push("Each city is scored by its best-matching live room.");
  } else if (c.basis === "hotspots") {
    if (c.heatmap === "saved" && c.heatmapSavedAt) parts.push(`The live fan map timed out, so this uses Qloo's fan map saved on ${c.heatmapSavedAt.slice(0, 10)}.`);
    if (!c.hotspotCells) parts.push(`Qloo's fan map of ${region} returned no hotspots for this audience, so cities were found from the rooms it favours.`);
    else {
      parts.push(`Qloo's fan map of ${region} found ${s(c.hotspotCells, "hotspot", "hotspots")}${c.remoteCells > 0 ? ` (${c.remoteCells} far from any touring city)` : ""}.`);
      if (c.roomFallback) parts.push(c.hotspotMarkets
        ? `They pointed to only ${s(c.hotspotMarkets, "touring city", "touring cities")}, so cities whose rooms this audience favours were added.`
        : "None is near a touring city, so this is a rooms-led plan: the cities come from the live rooms this audience favours.");
    }
    parts.push("Each nearby city is scored by its best-matching live room.");
  } else {
    parts.push("Your cities, each scored by its best-matching live room.");
  }
  if (c.anchorsAbsent?.length) parts.push(`${list(c.anchorsAbsent)} ${c.anchorsAbsent.length === 1 ? "is" : "are"} not among these fans' hotspots, so this run is built on the secondary markets where they are; the route check still tests the big cities nearby by their rooms.`);
  const r = c.regional;
  if (r && r.stops > 1) {
    const where = r.start ? `from ${r.start.name}` : r.around ? `around ${r.around}` : "in one region";
    parts.push(`The route stays ${where}: the longest drive between stops is about ${Math.round((r.longestLegKm * ROAD_FACTOR) / 10) * 10} km (${Math.max(1, Math.round(driveHours(r.longestLegKm)))} h).`);
    if (r.stops < r.asked) parts.push(`Only ${r.stops} strong cities sit within a day's drive of each other there.`);
    if (r.elsewhere.length) parts.push(`Fans also concentrate around ${list(r.elsewhere)}: a second run.`);
  }
  if (c.droppedRooms) parts.push(`${s(c.droppedRooms, "unlikely room", "unlikely rooms")} (out of town or not a venue) ${c.droppedRooms === 1 ? "was" : "were"} left out.`);
  if (c.unscored.length) parts.push(`No matching rooms in ${c.unscored.join(", ")}.`);
  return parts.join(" ");
}
