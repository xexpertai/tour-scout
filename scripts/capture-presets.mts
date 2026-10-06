/**
 * Captures each demo preset as a replayable event stream in public/presets/<slug>.json, plus one
 * recorded "Ask the scout" exchange, so tapping that suggestion on a preset costs nothing.
 *
 *   npm run presets:capture [slug…]               full capture (tour + scout)
 *   npm run presets:capture -- --scout-only [slug…]  re-record only the scout exchange
 *
 * Uses whatever is configured: live Qloo when a credential is present (else labelled sample data),
 * and LLM_PROVIDER for the text (default scripted, so no model credit is spent unless chosen).
 * A live capture costs ~25 Qloo requests and one model call per preset, plus 2–4 model calls and a
 * few Qloo requests for the scout exchange.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const { PRESETS, presetScoutQuestion } = await import("../src/lib/tour/presets.ts");
const { planTour } = await import("../src/lib/tour/plan.ts");
const { describeEntity } = await import("../src/lib/qloo.ts");
const { runScout, claudeAgentModel, scriptedAgentModel } = await import("../src/lib/tour/scout.ts");

async function resolve(name: string, kind: "artist" | "person") {
  const r = await describeEntity(name, kind);
  const e = r.status === "resolved" ? r.entity : r.status === "ambiguous" ? r.candidates[0] : undefined;
  if (!e) throw new Error(`Qloo has no entity for "${name}"`);
  return { id: e.id, name: e.name, type: kind, popularity: e.popularity };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- captured events are replayed as-is
type Plan = any;

/** Runs the scout once on the captured plan and records its events with arrival offsets. */
async function recordScout(plan: Plan) {
  const question = presetScoutQuestion(plan);
  const events: { at: number; event: { type: string } & Record<string, unknown> }[] = [];
  const started = Date.now();
  const sink = { push: (event: { type: string } & Record<string, unknown>) => events.push({ at: Date.now() - started, event }) };
  const useClaude = process.env.LLM_PROVIDER === "claude" && Boolean(process.env.CLAUDE_API_KEY);
  const followUp = await runScout({ ...plan, followUps: [] }, question, useClaude ? claudeAgentModel : scriptedAgentModel(plan, question), sink);
  events.push({ at: Date.now() - started, event: { type: "answer", followUp } });
  return { question, recordedAt: new Date().toISOString(), events };
}

const args = process.argv.slice(2);
const scoutOnly = args.includes("--scout-only");
const keepScout = args.includes("--keep-scout"); // recapture the tour but keep the recorded scout exchange
const only = args.filter((a) => !a.startsWith("--"));
mkdirSync("public/presets", { recursive: true });
for (const p of PRESETS.filter((x) => !only.length || only.includes(x.slug))) {
  const file = `public/presets/${p.slug}.json`;
  if (scoutOnly) {
    const run = JSON.parse(readFileSync(file, "utf8"));
    const plan = run.events.find((e: { event: { type: string } }) => e.event.type === "plan").event.plan;
    run.scout = await recordScout(plan);
    writeFileSync(file, JSON.stringify(run));
    console.log(`✓ ${p.slug}: scout "${run.scout.question}" → ${run.scout.events.at(-1).event.followUp.proposal?.summary ?? "no change proposed"}`);
    continue;
  }
  const input = p.soundsLike
    ? { artist: null, emerging: { name: p.artist, proxies: await Promise.all(p.soundsLike.map((n) => resolve(n, p.kind))) }, region: p.region, stops: p.stops, capacity: p.capacity }
    : { artist: await resolve(p.artist, p.kind), region: p.region, stops: p.stops, capacity: p.capacity };
  const started = Date.now();
  const events: { at: number; event: { type: string } & Record<string, unknown> }[] = [];
  for await (const event of planTour(input)) events.push({ at: Date.now() - started, event });
  const mode = events.find((e) => e.event.type === "mode")?.event as { qloo: "live" | "mock" } | undefined;
  const planEvent = events.find((e) => e.event.type === "plan")?.event as { plan: Plan } | undefined;
  if (!planEvent) {
    console.error(`✗ ${p.slug}: no plan (${JSON.stringify(events.find((e) => e.event.type === "error")?.event)})`);
    continue;
  }
  const previous = keepScout ? JSON.parse(readFileSync(file, "utf8")).scout : undefined;
  const scout = previous ?? await recordScout(planEvent.plan);
  const run = { slug: p.slug, capturedAt: new Date().toISOString(), qloo: mode?.qloo ?? "mock", llm: planEvent.plan.mode.llm, events, scout };
  writeFileSync(file, JSON.stringify(run));
  console.log(`✓ ${p.slug}: ${events.length} events, ${run.qloo} Qloo, ${run.llm} text, ${Date.now() - started} ms; scout → ${scout.events.at(-1)!.event.followUp && (scout.events.at(-1)!.event.followUp as { proposal?: { summary: string } }).proposal?.summary || "no change proposed"}`);
}
