/** Loads a plan the server may act on: a stored plan, or a bundled preset forked into storage. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadPlan, savePlan } from "../store.ts";
import { PRESETS, type CapturedRun } from "./presets.ts";
import type { FollowUp, TourPlan } from "./types.ts";

async function presetRun(slug: string): Promise<CapturedRun | undefined> {
  if (!PRESETS.some((p) => p.slug === slug)) return undefined;
  return JSON.parse(await readFile(path.join(process.cwd(), "public", "presets", `${slug}.json`), "utf8")) as CapturedRun;
}

async function presetPlan(slug: string): Promise<TourPlan | undefined> {
  const run = await presetRun(slug);
  return (run?.events.find((e) => (e.event as { type: string }).type === "plan")?.event as { plan: TourPlan } | undefined)?.plan;
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
    if (plan) return { plan, forked: false };
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
