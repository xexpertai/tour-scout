/**
 * Captures each demo preset as a replayable event stream in public/presets/<slug>.json.
 *
 *   npm run presets:capture [slug…]
 *
 * Uses whatever is configured: live Qloo when a credential is present (else labelled sample data),
 * and LLM_PROVIDER for the text (default scripted, so no model credit is spent unless chosen).
 * Live capture costs ~25 Qloo requests and one model call per preset.
 */
import { mkdirSync, writeFileSync } from "node:fs";

const { PRESETS } = await import("../src/lib/tour/presets.ts");
const { planTour } = await import("../src/lib/tour/plan.ts");
const { describeEntity } = await import("../src/lib/qloo.ts");

async function resolve(name: string, kind: "artist" | "person") {
  const r = await describeEntity(name, kind);
  const e = r.status === "resolved" ? r.entity : r.status === "ambiguous" ? r.candidates[0] : undefined;
  if (!e) throw new Error(`Qloo has no entity for "${name}"`);
  return { id: e.id, name: e.name, type: kind, popularity: e.popularity };
}

const only = process.argv.slice(2);
mkdirSync("public/presets", { recursive: true });
for (const p of PRESETS.filter((x) => !only.length || only.includes(x.slug))) {
  const input = p.soundsLike
    ? { artist: null, emerging: { name: p.artist, proxies: await Promise.all(p.soundsLike.map((n) => resolve(n, p.kind))) }, region: p.region, stops: p.stops, capacity: p.capacity }
    : { artist: await resolve(p.artist, p.kind), region: p.region, stops: p.stops, capacity: p.capacity };
  const started = Date.now();
  const events: { at: number; event: { type: string } & Record<string, unknown> }[] = [];
  for await (const event of planTour(input)) events.push({ at: Date.now() - started, event });
  const mode = events.find((e) => e.event.type === "mode")?.event as { qloo: "live" | "mock" } | undefined;
  const plan = events.find((e) => e.event.type === "plan")?.event as { plan: { mode: { llm: string } } } | undefined;
  if (!plan) {
    console.error(`✗ ${p.slug}: no plan (${JSON.stringify(events.find((e) => e.event.type === "error")?.event)})`);
    continue;
  }
  const run = { slug: p.slug, capturedAt: new Date().toISOString(), qloo: mode?.qloo ?? "mock", llm: plan.plan.mode.llm, events };
  writeFileSync(`public/presets/${p.slug}.json`, JSON.stringify(run));
  console.log(`✓ ${p.slug}: ${events.length} events, ${run.qloo} Qloo, ${run.llm} text, ${Date.now() - started} ms`);
}
