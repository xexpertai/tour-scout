/**
 * Re-applies the server's current answer rules to the recorded route checks in public/presets, with
 * no model call: the guard (a model answer it now withholds is replaced), the code-written verdict
 * for withheld or templated answers, and the tie note (dropped when the proposal removes that stop).
 * The model's own words are never edited: an answer is either kept as recorded or replaced by TEMPLATE.
 *
 *   npm run presets:recheck
 */
import { readFileSync, writeFileSync } from "node:fs";
import { insightGuard } from "../src/lib/guard.ts";
import { clean } from "../src/lib/text.ts";
import { diffSummary, routeVerdict } from "../src/lib/tour/scout.ts";
import type { City, FollowUp, TourPlan } from "../src/lib/tour/types.ts";

for (const slug of ["us-emerging", "us-americana", "us-comedian"]) {
  const file = `public/presets/${slug}.json`;
  const run = JSON.parse(readFileSync(file, "utf8"));
  const plan = run.events.find((e: { event: { type: string } }) => e.event.type === "plan")?.event.plan as TourPlan;
  const answerEvent = run.scout?.events.find((e: { event: { type: string } }) => e.event.type === "answer")?.event as { followUp: FollowUp } | undefined;
  if (!plan || !answerEvent) continue;
  const f = answerEvent.followUp;
  const notes: string[] = [];
  const valid = new Set([...plan.sources, ...f.sources].map((s) => s.id));
  const { guard, withheld } = insightGuard(valid, false, {
    capacity: plan.inputs.capacity, actName: plan.artist.name, emerging: Boolean(plan.artist.proxyOf?.length),
    hotspotCities: plan.stops.filter((s) => s.city.hotspot).map((s) => clean(s.city.name)),
  });
  const routeQuestion = /^Check this route:/.test(f.question);
  const kept = f.answer.kind === "template" ? undefined : guard("answer", f.answer);
  if (f.answer.kind !== "template" && !kept) notes.push(`model answer withheld now (${withheld.map((w) => w.reason).join("; ")})`);
  if (!kept && routeQuestion) {
    const seen = f.pins.map((p) => ({ ...p, rooms: undefined }) as unknown as City);
    const verdict = routeVerdict(plan, [...seen, ...(f.proposal?.add ?? [])], f.proposal);
    if (verdict.text !== f.answer.text) { f.answer = verdict; notes.push("answer: code-written verdict"); }
  }
  if (f.proposal) {
    const rest = f.proposal.summary.split(" · ").filter((x) => !/^[+−] /.test(x));
    const summary = [...diffSummary(plan, f.proposal.add, f.proposal.remove), ...rest].join(" · ");
    if (summary !== f.proposal.summary) { f.proposal.summary = summary; notes.push("proposal summary: one-decimal scores"); }
  }
  const removed = (f.proposal?.remove ?? []).map((id) => clean(plan.stops.find((s) => s.stopId === id)?.city.name ?? ""));
  const checks = (f.checks ?? []).filter((c) => !(/effectively tied/.test(c.text) && removed.some((r) => r && c.text.includes(`${r} (`))));
  if (checks.length !== (f.checks ?? []).length) notes.push("tie note about a removed stop dropped");
  f.checks = checks.length ? checks : undefined;
  writeFileSync(file, JSON.stringify(run));
  console.log(`${slug}: ${notes.join("; ") || "unchanged"}\n  ${f.answer.kind}: ${f.answer.text}`);
}
