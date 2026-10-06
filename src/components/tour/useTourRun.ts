"use client";

import { useCallback, useRef, useState } from "react";
import type { Insight } from "@/lib/guard";
import type { Source } from "@/lib/evidence";
import type { CapturedRun } from "@/lib/tour/presets";
import { editedOrigin, type RunOrigin } from "@/lib/tour/source-label";
import type { AskEvent, City, Coverage, FanProfile, FollowUp, StopData, TourEvent, TourInput, TourPlan } from "@/lib/tour/types";

export type StopView = StopData & { order?: number; why?: Insight; pitch?: Insight; textDone?: boolean };
export type { RunOrigin };

export type RunState = {
  status: "idle" | "running" | "writing" | "done" | "error";
  origin?: RunOrigin;
  qloo?: "live" | "mock";
  llm?: string;
  steps: { label: string; evidence?: string[]; failed?: boolean }[];
  sources: Source[];
  fan?: FanProfile;
  cities: City[];
  coverage?: Coverage;
  stops: StopView[];
  summary?: Insight;
  plan?: TourPlan;
  fallback?: string;
  error?: { message: string; code?: string; retryable?: boolean };
  followUps: FollowUp[];
  /** A preset's recorded scout exchange: tapping its question replays it at no cost. */
  recordedScout?: NonNullable<CapturedRun["scout"]>;
  /** Indexes of follow-ups that came from a recorded exchange (applied through the preset). */
  replayedAnswers?: number[];
  /** The scout's live progress while answering a question or applying a change. */
  scout: { busy: boolean; checks: ScoutCheck[] };
};

export type ScoutCheck = { label: string; detail?: string; status: "running" | "done" | "failed" };

/** "checking" opens a running step; the next Qloo result closes the oldest open one. */
function addCheck(checks: ScoutCheck[], e: { type: "checking" | "step"; label: string; failed?: boolean }): ScoutCheck[] {
  if (e.type === "checking") return [...checks, { label: e.label.replace(/^Scout is /, "").replace(/…$/, ""), status: "running" }];
  const open = checks.findIndex((c) => c.status === "running");
  if (open < 0) return [...checks, { label: e.label, status: e.failed ? "failed" : "done" }];
  return checks.map((c, i) => (i === open ? { ...c, detail: e.label, status: e.failed ? "failed" : "done" } : c));
}
const settle = (checks: ScoutCheck[]): ScoutCheck[] => checks.map((c) => (c.status === "running" ? { ...c, status: "done" } : c));

const initial: RunState = { status: "idle", steps: [], sources: [], cities: [], stops: [], followUps: [], scout: { busy: false, checks: [] } };

/** The state of a finished run, rebuilt from a stored plan (share links). */
function fromPlan(plan: TourPlan): RunState {
  return {
    ...initial,
    status: "done",
    origin: { kind: "shared", createdAt: plan.createdAt },
    qloo: plan.mode.qloo === "cached" ? "live" : plan.mode.qloo,
    llm: plan.mode.llm,
    plan,
    summary: plan.summary,
    fan: plan.fan,
    sources: plan.sources,
    cities: plan.candidates ?? plan.stops.map((s) => s.city),
    coverage: plan.coverage,
    stops: plan.stops.map((s) => ({ ...s, textDone: true })),
    followUps: plan.followUps ?? [],
  };
}

function reduce(state: RunState, event: TourEvent): RunState {
  switch (event.type) {
    case "mode":
      return { ...state, qloo: event.qloo, llm: event.llm };
    case "reused":
      return { ...state, origin: { kind: "reused", createdAt: event.createdAt } };
    case "source":
      return { ...state, sources: [...state.sources, event.source] };
    case "step":
      return { ...state, steps: [...state.steps, event] };
    case "fan":
      return { ...state, fan: event.fan };
    case "cities":
      return { ...state, cities: event.cities, coverage: event.coverage };
    case "stop":
      return { ...state, stops: [...state.stops.filter((s) => s.stopId !== event.stop.stopId), event.stop].sort((a, b) => a.rank - b.rank) };
    case "writing":
      return { ...state, status: "writing", llm: event.llm };
    case "summary":
      return { ...state, summary: event.summary };
    case "stop_text":
      return { ...state, stops: state.stops.map((s) => (s.stopId === event.stopId ? { ...s, why: event.why, pitch: event.pitch, textDone: true } : s)) };
    case "llm_fallback":
      return { ...state, fallback: event.reason };
    case "plan":
      return {
        ...state,
        status: "done",
        plan: event.plan,
        summary: event.plan.summary,
        fan: event.plan.fan,
        coverage: event.plan.coverage ?? state.coverage,
        sources: event.plan.sources,
        stops: event.plan.stops.map((s) => ({ ...s, textDone: true })),
      };
    case "error":
      return { ...state, status: "error", error: event };
  }
}

/** Reads an NDJSON response, calling `onEvent` per line; returns an error message, if any. */
async function readStream<E>(res: Response, onEvent: (e: E) => void): Promise<string | undefined> {
  if (!res.ok || !res.body) return (await res.json().catch(() => ({}))).error ?? `Request failed (${res.status})`;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return undefined;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as E);
  }
}

/** Drives one run: live from /api/tour, replayed from a captured preset, or a stored shared plan. */
export function useTourRun(sharedPlan?: TourPlan) {
  const [state, setState] = useState<RunState>(() => (sharedPlan ? fromPlan(sharedPlan) : initial));
  const abortRef = useRef<AbortController | null>(null);

  const apply = useCallback((event: TourEvent) => setState((s) => reduce(s, event)), []);

  const start = useCallback(async (input: TourInput) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ ...initial, status: "running", origin: { kind: "live" } });
    try {
      const res = await fetch("/api/tour", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: controller.signal });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        setState((s) => ({ ...s, status: "error", error: { message: body.error ?? `Request failed (${res.status})`, code: body.code, retryable: res.status !== 400 } }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) apply(JSON.parse(line) as TourEvent);
      }
      setState((s) => (s.status === "running" || s.status === "writing" ? { ...s, status: "error", error: { message: "The connection closed before the plan was finished.", retryable: true } } : s));
    } catch (err) {
      if (controller.signal.aborted) return;
      setState((s) => ({ ...s, status: "error", error: { message: err instanceof Error ? err.message : String(err), retryable: true } }));
    }
  }, [apply]);

  /** Replays a captured run in about 7 seconds, so the map choreography reads as one gesture. */
  const replay = useCallback(async (slug: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ ...initial, status: "running" });
    try {
      const res = await fetch(`/presets/${slug}.json`, { signal: controller.signal });
      if (!res.ok) throw new Error("This demo isn't available right now.");
      const run = (await res.json()) as CapturedRun;
      setState((s) => ({ ...s, origin: { kind: "preset", slug, capturedAt: run.capturedAt }, recordedScout: run.scout }));
      // Pacing: the fan-profile steps before the cities arrive are compressed into ~1 s, so the map
      // lights up almost at once; the rest (stops, then text) is compressed to ~5 s.
      const last = run.events.at(-1)?.at || 1;
      const citiesAt = run.events.find((e) => (e.event as { type: string }).type === "cities")?.at ?? 0;
      const head = 1000, rest = Math.min(1, 4800 / Math.max(1, last - citiesAt));
      const timeOf = (at: number) => (at <= citiesAt ? (citiesAt ? (at / citiesAt) * head : 0) : head + (at - citiesAt) * rest);
      let clock = 0;
      for (const { at, event } of run.events) {
        const wait = Math.max(0, timeOf(at) - clock);
        if (wait > 15) await new Promise((r) => setTimeout(r, wait));
        clock += wait;
        if (controller.signal.aborted) return;
        apply(event as TourEvent);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setState((s) => ({ ...s, status: "error", error: { message: err instanceof Error ? err.message : String(err), retryable: true } }));
    }
  }, [apply]);

  /** Asks the scout about the current plan; streams its checks and appends the answer. */
  const ask = useCallback(async (question: string): Promise<string | undefined> => {
    const plan = state.plan;
    if (!plan) return "The plan isn't finished yet.";
    const recorded = state.origin?.kind === "preset" && state.recordedScout?.question === question ? state.recordedScout : undefined;
    if (recorded) {
      // Replays the captured exchange (compressed to ~4.5 s): same steps, same answer, no API call.
      setState((s) => ({ ...s, scout: { busy: true, checks: [] } }));
      const last = recorded.events.at(-1)?.at || 1;
      const scale = Math.min(1, 4500 / last);
      let clock = 0;
      for (const { at, event } of recorded.events) {
        const wait = Math.max(0, at * scale - clock);
        if (wait > 15) await new Promise((r) => setTimeout(r, wait));
        clock += wait;
        const e = event as AskEvent;
        setState((s) => {
          if (e.type === "checking" || e.type === "step") return { ...s, scout: { busy: true, checks: addCheck(s.scout.checks, e) } };
          if (e.type === "source") return { ...s, sources: [...s.sources, e.source] };
          if (e.type === "answer") {
            return {
              ...s,
              followUps: [...s.followUps, e.followUp],
              replayedAnswers: [...(s.replayedAnswers ?? []), s.followUps.length],
              scout: { busy: true, checks: [...settle(s.scout.checks), { label: e.followUp.proposal ? `proposed: ${e.followUp.proposal.summary}` : "answered", status: "done" }] },
            };
          }
          return s;
        });
      }
      setState((s) => ({ ...s, scout: { busy: false, checks: settle(s.scout.checks) } }));
      return undefined;
    }
    const body = state.origin?.kind === "preset" ? { preset: state.origin.slug, question } : { planId: plan.id, question };
    setState((s) => ({ ...s, scout: { busy: true, checks: [] } }));
    let error: string | undefined;
    try {
      const res = await fetch("/api/tour/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      error = await readStream<AskEvent>(res, (e) => setState((s) => {
        switch (e.type) {
          case "forked":
            // The demo was copied into storage so its answers can be applied and shared; the scout runs live.
            return { ...s, origin: editedOrigin(s.origin, true), plan: s.plan && { ...s.plan, id: e.planId } };
          case "checking":
          case "step":
            return { ...s, scout: { busy: true, checks: addCheck(s.scout.checks, e) } };
          case "source":
            return { ...s, sources: [...s.sources, e.source] };
          case "answer":
            return {
              ...s,
              followUps: [...s.followUps, e.followUp],
              scout: { busy: true, checks: [...settle(s.scout.checks), { label: e.followUp.proposal ? `proposed: ${e.followUp.proposal.summary}` : "answered", status: "done" }] },
            };
          case "error":
            error = e.message;
            return s;
        }
      }));
    } catch (e) {
      error = (e as Error).message;
    }
    setState((s) => ({ ...s, scout: { busy: false, checks: settle(s.scout.checks) } }));
    return error;
  }, [state.plan, state.origin, state.recordedScout]);

  /** Applies a scout proposal: the server rebuilds the plan and the route redraws. */
  const applyChange = useCallback(async (index: number): Promise<string | undefined> => {
    const plan = state.plan;
    if (!plan) return "No plan to change.";
    setState((s) => ({ ...s, scout: { busy: true, checks: [] } }));
    let error: string | undefined;
    let liveSources = 0; // new Qloo evidence while applying means the change made live calls
    try {
      // A recorded preset answer is applied through the preset (the server holds the same recording).
      const replayed = state.origin?.kind === "preset" && state.replayedAnswers?.includes(index);
      const body = replayed && state.origin?.kind === "preset" ? { preset: state.origin.slug, question: state.followUps[index]?.question } : { planId: plan.id, index };
      const res = await fetch("/api/tour/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      error = await readStream<TourEvent>(res, (e) => setState((s) => {
        if (e.type === "step") return { ...s, scout: { busy: true, checks: addCheck(s.scout.checks, e) } };
        if (e.type === "source") { liveSources++; return { ...s, sources: [...s.sources, e.source] }; }
        // A captured plan stays labelled as captured, with the scout change stated (not "live data").
        if (e.type === "plan") return { ...fromPlan(e.plan), origin: editedOrigin(s.origin, liveSources > 0), scout: { busy: false, checks: [] } };
        if (e.type === "error") error = e.message;
        return s;
      }));
    } catch (e) {
      error = (e as Error).message;
    }
    setState((s) => ({ ...s, scout: { busy: false, checks: settle(s.scout.checks) } }));
    return error;
  }, [state.plan, state.origin, state.replayedAnswers, state.followUps]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(initial);
  }, []);

  return { state, start, replay, reset, ask, applyChange };
}
