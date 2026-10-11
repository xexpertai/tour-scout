/** Where the plan on screen comes from, stated precisely (the line under the act's name). */
export type BaseOrigin =
  | { kind: "live" }
  | { kind: "reused"; createdAt: string }
  | { kind: "preset"; slug: string; capturedAt: string }
  | { kind: "shared"; createdAt: string; demoCapturedAt?: string };
/**
 * A captured, shared or reused plan the scout worked on. `live`: an applied change used live Qloo calls.
 * `answersOnly`: only questions were added (no change applied), which the line does not call a change.
 */
export type RunOrigin = BaseOrigin | { kind: "edited"; base: Exclude<BaseOrigin, { kind: "live" }>; live: boolean; answersOnly?: boolean };

export const baseOrigin = (o: RunOrigin | undefined): BaseOrigin | undefined => (o?.kind === "edited" ? o.base : o);

/** The origin after a scout change (or, with `answersOnly`, a question): a live run stays live; anything else keeps its base. */
export function editedOrigin(o: RunOrigin | undefined, live: boolean, answersOnly = false): RunOrigin {
  if (!o || o.kind === "live") return { kind: "live" };
  if (o.kind === "edited") return { ...o, live: o.live || live, answersOnly: Boolean(o.answersOnly && answersOnly) };
  return answersOnly ? { kind: "edited", base: o, live: false, answersOnly: true } : { kind: "edited", base: o, live };
}

/**
 * A stored plan's origin, from the plan itself, so every visitor of a share link reads the same line:
 * a plan made by Apply (`parentId`) says so, with "from live Qloo data" when that Apply made Qloo calls
 * (`appliedLive`; plans stored before the flag existed only say the change was applied).
 */
export function planOrigin(plan: { createdAt: string; demo?: { capturedAt: string }; parentId?: string; appliedLive?: boolean }): RunOrigin {
  const base: BaseOrigin = { kind: "shared", createdAt: plan.createdAt, demoCapturedAt: plan.demo?.capturedAt };
  return plan.parentId ? { kind: "edited", base, live: Boolean(plan.appliedLive) } : base;
}

export function sourceLabel(o: RunOrigin | undefined, date: (iso: string) => string): string {
  const b = baseOrigin(o);
  const base = b?.kind === "preset" ? `Captured from live Qloo data on ${date(b.capturedAt)}`
    : b?.kind === "shared" ? (b.demoCapturedAt ? `Shared demo plan, captured from live Qloo data on ${date(b.demoCapturedAt)}` : `Shared plan from live Qloo data, ${date(b.createdAt)}`)
    : b?.kind === "reused" ? `Same tour planned earlier (${date(b.createdAt)}), live Qloo data`
    : "Live Qloo data";
  if (o?.kind !== "edited" || o.answersOnly) return base;
  return `${base} · ${o.live ? "scout change from live Qloo data" : "scout change applied"}`;
}

/** "40 Qloo requests (29 for the plan, 11 for the scout's checks)": the same split everywhere it is counted. */
export function requestCount(total: number, forPlan?: number): string {
  const n = `${total} Qloo request${total === 1 ? "" : "s"}`;
  return forPlan === undefined || forPlan >= total ? n : `${n} (${forPlan} for the plan, ${total - forPlan} for the scout's checks)`;
}

/**
 * The scout's proposed change in words: "+ Charlotte (92.0) · − Indianapolis (89.0)" (the stored
 * summary) reads "Swap Indianapolis (89.0) → Charlotte (92.0)"; a lone add or drop says so. Other parts
 * (an opener change) are kept as they are.
 */
export function changeText(summary: string): string {
  const parts = summary.split(" · ").map((p) => p.trim()).filter(Boolean);
  const adds = parts.filter((p) => p.startsWith("+ ")).map((p) => p.slice(2));
  const drops = parts.filter((p) => /^[−-] /.test(p)).map((p) => p.slice(2));
  const rest = parts.filter((p) => !p.startsWith("+ ") && !/^[−-] /.test(p));
  const route = adds.length === 1 && drops.length === 1 ? [`Swap ${drops[0]} → ${adds[0]}`]
    : [...(adds.length ? [`Add ${adds.join(", ")}`] : []), ...(drops.length ? [`Drop ${drops.join(", ")}`] : [])];
  const out = [...route, ...rest].join("; ");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * Who chose which Qloo calls, in the same numbers as Credits: the route check's standard pre-check is
 * run by the server; the agent chooses the rest. A code-written verdict says so.
 */
export function agentCallsNote(f: { sources: unknown[]; serverChecks?: number; answer: { kind: string } }): string {
  const total = f.sources.length, server = Math.min(f.serverChecks ?? 0, total), agent = total - server;
  const calls = server
    ? `The server ran ${server} standard check${server === 1 ? "" : "s"} first (the nearby cities' rooms); the agent chose ${agent} more Qloo request${agent === 1 ? "" : "s"}.`
    : `The agent chose these ${total} Qloo request${total === 1 ? "" : "s"}.`;
  return f.answer.kind === "template" ? `${calls} The verdict sentence is written by code from their numbers, so it can’t overstate them.` : calls;
}

/** One line names both cities: "Swap Albany (88.7) → Providence (91.3)" becomes "Albany → Providence (91.3)". */
export function slimChange(text: string): string {
  const [first, ...rest] = text.split("; ");
  const m = /^Swap (.+?) \([\d.]+\) → (.+)$/.exec(first);
  return [m ? `${m[1]} → ${m[2]}` : first, ...rest].join("; ");
}
