/** The scout's trace: steps from the streamed events, and who did what once it has answered. */
import { changeText } from "./source-label.ts";
import type { FollowUp } from "./types.ts";

/**
 * One line of the scout's trace. `at`: how many of this answer's Qloo requests came before it (from the
 * recorded event order), so a finished trace can be split where the server's standard checks end and
 * the agent's own requests begin. `verdict`: the closing line (the proposed change or "answered").
 */
export type ScoutCheck = { label: string; detail?: string; status: "running" | "done" | "failed"; at?: number; verdict?: boolean };

/** "checking" opens a running step; the next Qloo result closes the oldest open one. */
export function addCheck(checks: ScoutCheck[], e: { type: "checking" | "step"; label: string; failed?: boolean }, seen = 0): ScoutCheck[] {
  if (e.type === "checking") return [...checks, { label: e.label.replace(/^Scout is /, "").replace(/…$/, ""), status: "running", at: seen }];
  // Tool results arrive out of order when the agent runs tools in parallel: pair a result with the
  // running check that names the same place ("looking for openers in Boston" ↔ "Boston: openers …").
  const place = e.label.split(":")[0].trim().toLowerCase();
  const named = checks.findIndex((c) => c.status === "running" && place.length > 2 && c.label.toLowerCase().includes(place));
  const open = named >= 0 ? named : checks.findIndex((c) => c.status === "running");
  // A result with no open step is its own line; its Qloo request arrived just before it.
  if (open < 0) return [...checks, { label: e.label, status: e.failed ? "failed" : "done", at: Math.max(0, seen - 1) }];
  return checks.map((c, i) => (i === open ? { ...c, detail: e.label, status: e.failed ? "failed" : "done" } : c));
}
export const verdictCheck = (f: FollowUp): ScoutCheck => ({ label: f.proposal ? `proposed: ${changeText(f.proposal.summary)}` : f.kind === "agent" ? "no change proposed" : "answered", status: "done", verdict: true });
export const settle = (checks: ScoutCheck[]): ScoutCheck[] => checks.map((c) => (c.status === "running" ? { ...c, status: "done" } : c));

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A finished trace split into who did what, from the recorded run only: the server's standard checks
 * (the first `serverChecks` Qloo requests), the requests the agent chose, and the closing verdict.
 * Undefined while the scout is working, or when the trace isn't an agent answer.
 */
export function traceGroups(checks: ScoutCheck[], f?: Pick<FollowUp, "kind" | "serverChecks" | "sources" | "proposedBy" | "answer" | "by">) {
  const verdict = checks.at(-1)?.verdict ? checks.at(-1) : undefined;
  if (!verdict || !f || f.kind !== "agent") return undefined;
  const body = checks.slice(0, -1);
  const server = Math.min(f.serverChecks ?? 0, f.sources.length);
  // A step belongs to the server's check when fewer than `server` requests had arrived before it.
  const split = server ? body.findIndex((c) => (c.at ?? 0) >= server) : 0;
  const cut = split < 0 ? body.length : split;
  return {
    server: { checks: body.slice(0, cut), requests: server },
    agent: { checks: body.slice(cut), requests: f.sources.length - server },
    verdict: { check: verdict, codeWritten: f.answer.kind === "template", proposedBy: f.proposedBy, agentName: f.by === "claude" ? "the agent" : "the scripted scout (no AI)" },
  };
}

