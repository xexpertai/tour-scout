/**
 * Re-applies the server's current answer rules to the recorded route checks in public/presets, with
 * no model call: the guard (a model answer it now withholds is replaced), the code-written verdict
 * for withheld or templated answers, and the tie note (dropped when the proposal removes that stop).
 * The model's own words are never edited: an answer is either kept as recorded or replaced by TEMPLATE.
 *
 *   npm run presets:recheck
 */
import { readFileSync, writeFileSync } from "node:fs";
import { insightGuard, planClaims, unsupportedClaim } from "../src/lib/guard.ts";
import { scriptedProvider } from "../src/lib/llm.ts";
import { clean } from "../src/lib/text.ts";
import { rankIn, routeFacts, synthesisInput, venueNames, weakestName } from "../src/lib/tour/plan.ts";
import { agentOneLine, diffSummary, openerCheckLine, openerLookupsFrom, routeVerdict } from "../src/lib/tour/scout.ts";
import type { City, FollowUp, TourInput, TourPlan } from "../src/lib/tour/types.ts";

for (const slug of ["us-emerging", "us-americana", "us-comedian"]) {
  const file = `public/presets/${slug}.json`;
  const run = JSON.parse(readFileSync(file, "utf8"));
  const plan = run.events.find((e: { event: { type: string } }) => e.event.type === "plan")?.event.plan as TourPlan;
  const answerEvent = run.scout?.events.find((e: { event: { type: string } }) => e.event.type === "answer")?.event as { followUp: FollowUp } | undefined;
  if (!plan || !answerEvent) continue;
  const f = answerEvent.followUp;
  const notes: string[] = [];
  // Text from the model is re-checked with today's guard (the same options as a live run). A stop's why or
  // pitch it now withholds is replaced by the code-written one (TEMPLATE) and counted as withheld; a withheld
  // summary falls back to the code-written summary; withheld list items are dropped. Code-written stop text
  // is rebuilt from today's templates. The model's words are never edited.
  const ordered = [...plan.stops].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const cities = plan.candidates ?? plan.stops.map((s) => s.city);
  const guardOpts = { capacity: plan.inputs.capacity, actName: plan.artist.name, emerging: Boolean(plan.artist.proxyOf?.length),
    hotspotCities: plan.stops.filter((s) => s.city.hotspot).map((s) => clean(s.city.name)), venues: venueNames(plan.stops),
    cityRanks: Object.fromEntries(plan.stops.map((s) => [clean(s.city.name), rankIn({ cities, stops: [] }, s.city.name).rank ?? 0])),
    ...routeFacts(ordered), rankOf: cities.length, weakest: weakestName(plan.stops) };
  const input = (plan.artist.proxyOf?.length
    ? { artist: null, emerging: { name: plan.artist.name, proxies: plan.artist.proxyOf.map((name) => ({ name })) } }
    : { artist: { name: plan.artist.name } }) as unknown as TourInput;
  const template = await scriptedProvider.synthesize(synthesisInput({ ...input, stops: plan.stops.length, capacity: plan.inputs.capacity },
    { fan: plan.fan, cities, stops: plan.stops } as never, plan.artist.arenaScale));
  const ids = new Set(plan.sources.map((x) => x.id));
  const tGuard = insightGuard(ids, true, guardOpts).guard;
  const check = (field: string, item: { text: string; kind: string }) => (item.kind === "template" ? undefined : unsupportedClaim(item.text) ?? planClaims(field, item.text, guardOpts));
  for (const stop of plan.stops) {
    const city = clean(stop.city.name);
    const t = template.stops?.find((x) => x.stop_id === stop.stopId);
    for (const key of ["why", "pitch"] as const) {
      const item = stop[key];
      const reason = item ? check(`${city} ${key}`, item) : undefined;
      if (item && item.kind !== "template" && !reason) continue;
      const fresh = tGuard(`${city} ${key}`, t?.[key]);
      if (!fresh || (item && fresh.text === item.text)) continue;
      stop[key] = fresh;
      for (const e of run.events) if (e.event.type === "stop_text" && e.event.stopId === stop.stopId) e.event[key] = fresh;
      if (reason) { plan.withheld = [...plan.withheld, { field: `${city} ${key}`, reason }]; notes.push(`${city} ${key}: withheld now (${reason}), code-written instead`); }
      else notes.push(`${city} ${key}: code-written text rebuilt`);
    }
  }
  if (plan.summary) {
    const reason = check("summary", plan.summary);
    const fresh = reason ? tGuard("summary", template.summary) : undefined;
    if (reason && fresh) {
      plan.summary = fresh;
      for (const e of run.events) if (e.event.type === "summary") e.event.summary = fresh;
      plan.withheld = [...plan.withheld, { field: "summary", reason }];
      notes.push(`summary: withheld now (${reason}), code-written instead`);
    }
  }
  for (const key of ["risks", "theme", "merch"] as const) {
    const items = plan[key] ?? [];
    const keep = items.filter((x) => { const r = check(key, x); if (r) { plan.withheld = [...plan.withheld, { field: key, reason: r }]; notes.push(`${key}: one item withheld now (${r})`); } return !r; });
    if (keep.length !== items.length) plan[key] = keep;
  }
  const valid = new Set([...plan.sources, ...f.sources].map((s) => s.id));
  const { guard, withheld } = insightGuard(valid, false, {
    capacity: plan.inputs.capacity, actName: plan.artist.name, emerging: Boolean(plan.artist.proxyOf?.length),
    hotspotCities: plan.stops.filter((s) => s.city.hotspot).map((s) => clean(s.city.name)),
    venues: venueNames(plan.stops),
  });
  // The agent's own one-line reason is re-checked too; a line the guard now withholds is dropped and its reason kept.
  if (f.agentNote && f.agentNote.kind !== "template" && !guard("agent note", f.agentNote)) {
    f.agentNoteWithheld = withheld.at(-1)?.reason;
    delete f.agentNote;
    notes.push(`agent note withheld now (${f.agentNoteWithheld})`);
  }
  const routeQuestion = /^Check this route:/.test(f.question);
  let kept = f.answer.kind === "template" ? undefined : guard("answer", f.answer);
  // A route check's verdict is code-written; a recorded model answer there becomes the agent's own note.
  if (kept && /^Check this route:/.test(f.question) && f.by === "claude" && !f.agentNote) {
    const note = agentOneLine(kept, guard);
    if (note) f.agentNote = note;
    notes.push(`model answer moved to the agent's note${note ? "" : " (withheld)"}`);
    kept = undefined;
  }
  if (f.answer.kind !== "template" && !kept && !f.agentNote) notes.push(`model answer withheld now (${withheld.map((w) => w.reason).join("; ")})`);
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
  const OPENER_LINE = /^(Openers|Feature acts|Support-slot ideas): the check looked up/;
  const checks = (f.checks ?? []).filter((c) => !(/effectively tied/.test(c.text) && removed.some((r) => r && c.text.includes(`${r} (`))));
  if (checks.length !== (f.checks ?? []).length) notes.push("tie note about a removed stop dropped");
  // The opener half of the route check, code-written from its recorded lookups (no model call).
  const before = checks.find((c) => OPENER_LINE.test(c.text))?.text;
  const opener = routeQuestion ? openerCheckLine(plan, openerLookupsFrom(f), Boolean(f.proposal?.opener), f.proposal) : undefined;
  checks.splice(0, checks.length, ...checks.filter((c) => !OPENER_LINE.test(c.text)), ...(opener ? [opener] : []));
  if (opener?.text !== before) notes.push("opener check line");
  // Which receipts the server's pre-check made (the venue tag and the nearby cities it ranked) before the agent's first turn.
  const preLabel: string = run.scout.events.find((e: { event: { type: string; label?: string } }) => e.event.type === "checking" && /near your route:/.test(e.event.label ?? ""))?.event.label ?? "";
  const preCities = preLabel.replace(/^.*near your route: /, "").replace(/…$/, "");
  if (routeQuestion && preCities) {
    let n = /^Qloo tag for/.test(f.sources[0]?.label ?? "") ? 1 : 0;
    const roomsCity = (label: string) => /^Rooms in (.+?) with affinity/.exec(label)?.[1];
    while (n < f.sources.length && roomsCity(f.sources[n].label) && `, ${preCities}, `.includes(`, ${roomsCity(f.sources[n].label)}, `)) n++;
    if (f.serverChecks !== n) { f.serverChecks = n; notes.push(`server pre-check: ${n} receipts`); }
  }
  f.checks = checks.length ? checks : undefined;
  writeFileSync(file, JSON.stringify(run));
  console.log(`${slug}: ${notes.join("; ") || "unchanged"}\n  ${f.answer.kind}: ${f.answer.text}`);
}
