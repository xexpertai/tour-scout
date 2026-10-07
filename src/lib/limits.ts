/**
 * Quota protection for live judging: per-client sliding-window limits, a global daily cap on live
 * runs, and a 24-hour cache of identical runs. The hourly limits are in memory (per instance); the
 * daily cap is also saved under DATA_DIR, so a restart or scale-to-zero cannot reset it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const HOUR = 60 * 60 * 1000;

export const LIMITS = {
  /** Live tour runs (each ≈25 Qloo requests and one model call). */
  tour: { max: Number(process.env.TOUR_RUNS_PER_HOUR) || 4, windowMs: HOUR },
  /** Artist search (one Qloo request each). */
  resolve: { max: Number(process.env.RESOLVES_PER_HOUR) || 40, windowMs: HOUR },
  /** "Why not <city>?" (two Qloo requests each). */
  followup: { max: Number(process.env.FOLLOWUPS_PER_HOUR) || 15, windowMs: HOUR },
} as const;
const DAILY_RUN_CAP = Number(process.env.TOUR_DAILY_CAP) || 150;

const hits = new Map<string, number[]>();
let day: { date: string; runs: number } | undefined;
const dayFile = () => (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "tour-usage.json") : undefined);

/**
 * The client address as seen by the host's proxy. Hosts like Fly.io and Railway set
 * x-forwarded-for; the first entry is the client.
 */
export function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || "local";
}

export type LimitResult = { ok: true } | { ok: false; retryAfterSec: number; message: string };

/** Records one request for `key` under `kind` and says whether it is allowed. */
export function take(kind: keyof typeof LIMITS, key: string, now = Date.now()): LimitResult {
  const { max, windowMs } = LIMITS[kind];
  const id = `${kind}:${key}`;
  const recent = (hits.get(id) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(id, recent);
    const retryAfterSec = Math.ceil((windowMs - (now - recent[0])) / 1000);
    return { ok: false, retryAfterSec, message: `You've reached ${max} ${kind === "tour" ? "live tours" : "requests"} per hour. Try again in about ${Math.ceil(retryAfterSec / 60)} minutes, or open one of the demo tours.` };
  }
  recent.push(now);
  hits.set(id, recent);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => now - t < HOUR)) hits.delete(k);
  return { ok: true };
}

/** Counts one live run against the server-wide daily cap. */
export function takeDailyRun(now = new Date()): LimitResult {
  const date = now.toISOString().slice(0, 10);
  const file = dayFile();
  if (!day && file) {
    try { day = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")); } catch { /* first run */ }
  }
  if (!day || day.date !== date) day = { date, runs: 0 };
  if (day.runs >= DAILY_RUN_CAP) {
    return { ok: false, retryAfterSec: 3600, message: "Tour Scout has used today's live-data budget. The demo tours still work, and live tours resume tomorrow (UTC)." };
  }
  day.runs++;
  if (file) {
    try {
      mkdirSync(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
      writeFileSync(/*turbopackIgnore: true*/ file, JSON.stringify(day));
    } catch { /* the cap still works in memory */ }
  }
  return { ok: true };
}

const recentRuns = new Map<string, { planId: string; at: number }>();

/** Identical runs within 24 hours reuse the stored plan instead of spending quota again. */
export const runCache = {
  get(key: string, now = Date.now()) {
    const hit = recentRuns.get(key);
    return hit && now - hit.at < 24 * HOUR ? hit.planId : undefined;
  },
  set(key: string, planId: string, now = Date.now()) {
    recentRuns.set(key, { planId, at: now });
    if (recentRuns.size > 2_000) recentRuns.delete(recentRuns.keys().next().value!);
  },
};

export function limitedResponse(r: Extract<LimitResult, { ok: false }>, code = "RATE_LIMITED") {
  return Response.json({ error: r.message, code }, { status: 429, headers: { "Retry-After": String(r.retryAfterSec) } });
}
