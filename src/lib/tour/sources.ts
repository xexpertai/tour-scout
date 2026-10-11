/** Loads a plan the server may act on: a stored plan, or a bundled preset forked into storage. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadPlan, savePlan } from "../store.ts";
import { owns, type Owner } from "../owner.ts";
import { PRESETS, type CapturedRun } from "./presets.ts";
import type { FollowUp, TourPlan } from "./types.ts";

async function presetRun(slug: string): Promise<CapturedRun | undefined> {
  if (!PRESETS.some((p) => p.slug === slug)) return undefined;
  return JSON.parse(await readFile(path.join(process.cwd(), "public", "presets", `${slug}.json`), "utf8")) as CapturedRun;
}

async function presetPlan(slug: string): Promise<TourPlan | undefined> {
  const run = await presetRun(slug);
  const plan = (run?.events.find((e) => (e.event as { type: string }).type === "plan")?.event as { plan: TourPlan } | undefined)?.plan;
  return plan && run ? { ...plan, demo: { slug, capturedAt: run.capturedAt } } : undefined;
}

/**
 * A stored plan that came from a demo keeps the demo's labels. Plans forked before the `demo` field
 * existed are recognised by the demo plan they were copied from (same act, same run timings and
 * the same first request), so their share links get the fictional / not-affiliated label too.
 */
/** Earlier captures of a demo that was later recaptured: share links forked from them are demos too. */
const PRIOR_CAPTURES = [
  { slug: "us-americana", capturedAt: "2026-10-07T06:07:53.857Z", artist: "S.G. Goodman", totalMs: 19533 },
];

export async function withDemoFlag(plan: TourPlan): Promise<TourPlan> {
  if (plan.demo) return plan;
  const prior = PRIOR_CAPTURES.find((p) => p.artist === plan.artist.name && p.totalMs === plan.timings.totalMs && plan.mode.llm === "claude");
  if (prior) return { ...plan, demo: { slug: prior.slug, capturedAt: prior.capturedAt } };
  for (const p of PRESETS) {
    const preset = await presetPlan(p.slug);
    if (preset && preset.artist.name === plan.artist.name && preset.timings.totalMs === plan.timings.totalMs
      && JSON.stringify(preset.sources[0]) === JSON.stringify(plan.sources[0])) return { ...plan, demo: preset.demo };
  }
  return plan;
}

/** The recorded scout answer bundled with a preset (server-side copy; never taken from a request). */
export async function presetScoutAnswer(slug: string, question: string): Promise<FollowUp | undefined> {
  const run = await presetRun(slug);
  if (!run?.scout || run.scout.question !== question) return undefined;
  return (run.scout.events.find((e) => (e.event as { type: string }).type === "answer")?.event as { followUp: FollowUp } | undefined)?.followUp;
}

/**
 * Plans come only from server storage or the bundled presets, never from a request body. A preset
 * is copied into storage on first use so questions and applied changes have a plan to belong to.
 */
export async function planForRequest(body: { planId?: unknown; preset?: unknown }): Promise<{ plan: TourPlan; forked: boolean } | undefined> {
  if (typeof body.planId === "string") {
    const plan = await loadPlan(body.planId);
    if (plan) return { plan: await withDemoFlag(plan), forked: false };
  }
  if (typeof body.preset === "string") {
    const preset = await presetPlan(body.preset);
    if (!preset) return undefined;
    const plan = { ...preset, id: randomUUID(), createdAt: new Date().toISOString(), followUps: [] };
    await savePlan(plan);
    return { plan, forked: true };
  }
  return undefined;
}

/**
 * The plan a question is added to: the visitor's own plan, or else a copy they own (a share link is
 * never changed by someone else's question). A preset copy is already new; it just gets its owner.
 */
export async function ownedCopy(found: { plan: TourPlan; forked: boolean }, owner: Owner): Promise<{ plan: TourPlan; forked: boolean }> {
  if (found.forked) { const plan = { ...found.plan, owner: owner.hash }; await savePlan(plan); return { plan, forked: true }; }
  if (owns(found.plan, owner)) return found;
  const plan = { ...found.plan, id: randomUUID(), createdAt: new Date().toISOString(), owner: owner.hash, forkedFrom: found.plan.id };
  await savePlan(plan);
  return { plan, forked: true };
}

