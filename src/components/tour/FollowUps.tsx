"use client";

import { isRouteCheck } from "@/lib/tour/presets";
import { agentCallsNote, changeText, slimChange } from "@/lib/tour/source-label";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { FollowUp } from "@/lib/tour/types";
import type { Insight } from "@/lib/guard";
import { Chip, Cites, InsightText, clean } from "./atoms";
import { plural, traceGroups, type ScoutCheck } from "@/lib/tour/trace";

function TraceStep({ c, n }: { c: ScoutCheck; n: number }) {
  return (
    <li className="slide-in flex items-start gap-3">
      <span aria-hidden className={`grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-xs font-bold ${
        c.status === "running" ? "animate-spin border-2 border-accent border-t-transparent" : c.status === "failed" ? "bg-danger text-bg" : "bg-accent text-accent-ink"}`}>
        {c.status === "running" ? "" : n}
      </span>
      <span className="min-w-0 pt-0.5">
        <span className={`block text-sm ${c.status === "running" ? "text-ink" : "text-muted"}`}>
          <span className="sr-only">Step {n}{c.status === "running" ? ", in progress" : ""}: </span>{c.label}
        </span>
        {c.detail && <span className="block text-xs text-muted">{clean(c.detail)}</span>}
      </span>
    </li>
  );
}

/** The agent's trace: numbered steps, a spinner on the one in progress, the Qloo result under each. */
function Trace({ checks, busy, f }: { checks: ScoutCheck[]; busy: boolean; f?: FollowUp }) {
  // Once the agent has answered, its trace folds to one line so the verdict is in view.
  const [show, setShow] = useState(false);
  const groups = busy ? undefined : traceGroups(checks, f);
  if (!busy && checks.length > 3 && !show) {
    const calls = f?.sources.length;
    return (
      <button type="button" onClick={() => setShow(true)} className="flex min-h-11 items-center gap-3 text-left text-sm text-muted hover:text-ink">
        <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent font-mono text-xs font-bold text-accent-ink">{checks.length}</span>
        <span>
          {groups
            ? <>{groups.server.requests ? <>Server: {plural(groups.server.requests, "standard check")} · </> : null}<b className="font-semibold text-ai">agent: {plural(groups.agent.requests, "Qloo request")} it chose</b> · verdict {groups.verdict.codeWritten ? "by code" : "by the agent"}</>
            : <>{checks.length} steps{calls !== undefined ? `, ${calls} Qloo requests` : ""}</>}
          {" "}· show the trace
        </span>
      </button>
    );
  }
  if (groups) {
    const { server, agent, verdict } = groups;
    const steps = (list: ScoutCheck[], from: number) => list.map((c, i) => <TraceStep key={from + i} c={c} n={from + i} />);
    const head = "mb-1.5 text-xs uppercase tracking-wide";
    return (
      <div aria-label="What the scout did" className="space-y-3">
        {server.checks.length > 0 && (
          <section className="rounded-lg border-l-2 border-line pl-3">
            <p className={`${head} text-muted`}>1 · Server’s standard check · {plural(server.requests, "Qloo request")}</p>
            <p className="mb-2 text-xs text-muted">Run before the agent starts, the same for every plan: the rooms in the nearby cities.</p>
            <ol className="space-y-2">{steps(server.checks, 1)}</ol>
          </section>
        )}
        <section className="rounded-lg border-l-2 border-ai pl-3">
          <p className={`${head} text-ai`}>{server.checks.length ? "2" : "1"} · Chosen by {verdict.agentName} · {plural(agent.requests, "Qloo request")}</p>
          <p className="mb-2 text-xs text-muted">Which tools to call, for which cities and acts, was {verdict.agentName === "the agent" ? "the agent’s own choice" : "decided by the scripted scout"}.</p>
          {agent.checks.length ? <ol className="space-y-2">{steps(agent.checks, server.checks.length + 1)}</ol> : <p className="text-sm text-muted">No further requests.</p>}
        </section>
        <section className="rounded-lg border-l-2 border-neon pl-3">
          <p className={`${head} text-ink`}>{server.checks.length ? "3" : "2"} · Verdict</p>
          <ol className="space-y-2">{steps([verdict.check], server.checks.length + agent.checks.length + 1)}</ol>
          <p className="mt-1 text-xs text-muted">
            {verdict.check.label.startsWith("proposed") && verdict.proposedBy ? (verdict.proposedBy === "agent" ? `The change was proposed by ${verdict.agentName}. ` : "The change came from the server’s check, not the agent. ") : ""}
            {verdict.codeWritten ? "The verdict sentence is written by code from the numbers above." : "The answer is the agent’s own text, checked by the safe-use guard."}
          </p>
        </section>
      </div>
    );
  }
  return (
    <ol aria-live="polite" aria-label="What the scout is doing" className="space-y-2">
      {checks.map((c, i) => <TraceStep key={i} c={c} n={i + 1} />)}
      {busy && !checks.some((c) => c.status === "running") && (
        <li className="flex items-center gap-3 text-sm text-ink"><span aria-hidden className="h-6 w-6 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />thinking…</li>
      )}
    </ol>
  );
}

function AnswerCard({ f, index, latest = false, busy, replayed, onApply, compact = false, onExpand }: { f: FollowUp; index: number; latest?: boolean; busy: boolean; replayed: boolean; onApply: (i: number) => Promise<string | undefined>; compact?: boolean; onExpand?: () => void }) {
  const [error, setError] = useState<string>();
  const who = isRouteCheck(f.question) ? "Agent route check" : "AI scout";
  const label = f.kind === "quick" ? "Quick check · no AI" : f.by === "claude" ? (replayed ? `${who} · recorded answer` : who) : `${isRouteCheck(f.question) ? "Route check" : "Templated scout"} · no AI`;
  const agentName = f.by === "claude" ? "the agent" : "the scripted scout (no AI)";
  // Who made the city change, from the recorded run; older recordings don't say, so nothing is claimed.
  const proposer = f.proposal && f.proposedBy ? (f.proposedBy === "server" ? `Proposed by the server check: ${agentName} did not propose this swap, but a stronger city within a day's drive was in its own results.` : `Proposed by ${agentName}.`) : undefined;
  const proposerShort = f.proposal && f.proposedBy ? (f.proposedBy === "server" ? " · server proposed" : f.by === "claude" ? " · agent proposed" : " · proposed") : f.proposal ? " · proposed" : "";
  const apply = f.proposal && (f.appliedAs ? (
    <p className="text-sm text-qloo">Applied ✓</p>
  ) : (
    <button type="button" disabled={busy} onClick={async () => setError(await onApply(index))}
      className="min-h-11 shrink-0 rounded-lg bg-neon px-5 font-display text-lg uppercase text-neon-ink disabled:opacity-50">
      Apply to my tour
    </button>
  ));
  // Desktop verdict: the proposed change and Apply on one row, then the agent's note and the verdict's
  // first full sentence (never cut mid-word); "Read more" and "Details" open the rest.
  if (compact) {
    return (
      <article id={`ask-${index}`} data-latest={latest || undefined} data-compact className={`slide-in rounded-xl border bg-bg px-4 py-2 ${f.proposal && !f.appliedAs ? "border-neon/70" : "border-line"}`}>
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-sm">
            <span className="text-xs text-muted">{label}{proposerShort}</span>
            {f.proposal && <span className="block truncate text-base font-semibold">{changeText(f.proposal.summary)}</span>}
          </p>
          {apply}
          <button type="button" onClick={onExpand} className="min-h-11 shrink-0 px-1 text-sm text-muted underline underline-offset-4 hover:text-ink">Details</button>
        </div>
        {f.agentNote && <AgentNote item={f.agentNote} compact />}
        {/* Whole sentences only: the verdict's first sentence, and "Read more" opens the rest in place. */}
        <InsightText item={f.answer} brief className="min-w-0 [&_p]:text-sm [&_p]:leading-snug" />
        {error && <p role="alert" className="mt-1 text-sm text-danger">{error}</p>}
      </article>
    );
  }
  return (
    <article id={`ask-${index}`} data-latest={latest || undefined} className="slide-in scroll-mt-28 rounded-xl border border-line bg-bg p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm text-muted">“{f.question}”</p>
        <span className="text-xs text-muted">{label}</span>
      </div>
      {f.kind === "quick" && f.city && f.rank !== undefined && (
        <div className="mt-2 flex flex-wrap items-baseline gap-2">
          <h3 className="font-display text-2xl uppercase">{clean(f.city)}</h3>
          <span className="flex items-center gap-1.5 text-sm"><b className="font-display text-2xl">{(Math.round((f.affinity ?? 0) * 1000) / 10).toFixed(1)}</b> · #{f.rank} of {f.of} <Chip kind="qloo" /> <Cites ids={[f.sources[0].id]} /></span>
        </div>
      )}
      {f.agentNote && <AgentNote item={f.agentNote} />}
      {f.agentNoteWithheld && <p className="mt-2 text-xs text-muted">The agent’s own answer was withheld by the safe-use guard: it {f.agentNoteWithheld}.</p>}
      <InsightText item={f.answer} className="mt-2" />
      {proposer && <p className="mt-1 text-xs text-muted">{proposer}</p>}
      {f.kind !== "quick" && f.by === "claude" && f.sources.length > 0 && (
        <p className="mt-1 text-xs text-muted">{agentCallsNote(f)}</p>
      )}
      {f.checks?.map((c, k) => <InsightText key={k} item={c} className="mt-1" />)}
      {f.proposal && (
        <div className="mt-3 rounded-lg border border-dashed border-neon/70 p-3">
          <p className="text-sm text-muted">Proposed change <span className="text-xs">(previewed on the map)</span></p>
          <p className="mt-0.5 text-lg font-semibold">{changeText(f.proposal.summary)}</p>
          <div className="mt-2">{apply}</div>
          {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        </div>
      )}
    </article>
  );
}

export type ScoutDockProps = {
  followUps: FollowUp[];
  scout: { busy: boolean; checks: ScoutCheck[] };
  onAsk: (q: string) => Promise<string | undefined>;
  onApply: (i: number) => Promise<string | undefined>;
  suggestions: { text: string; recorded?: boolean }[];
  placeholder: string;
  replayed: number[];
};

/**
 * "Ask the scout", always within reach: a dock pinned to the bottom of the plan column on desktop,
 * a bottom sheet on phones. It opens up when the scout is working or has answered.
 */
export function ScoutDock({ variant, onClose, ...p }: ScoutDockProps & { variant: "dock" | "sheet"; onClose?: () => void }) {
  const [q, setQ] = useState("");
  const [error, setError] = useState<string>();
  const body = useRef<HTMLDivElement>(null);
  const count = p.followUps.length;
  // Opens by itself while the scout works or after a new answer; "Hide" holds until the next answer.
  const [manual, setManual] = useState<{ count: number; open: boolean }>();
  const open = variant === "sheet" || p.scout.busy || (manual?.count === count ? manual.open : count > 0);
  const setOpen = (o: boolean) => setManual({ count, open: o });
  // A new answer: scroll the answers so the newest card (and its Apply button) is fully in view.
  // Not on opening: the sheet then starts at the top of the answer (the question stays readable).
  const seen = useRef(count);
  useEffect(() => {
    if (count <= seen.current) return;
    seen.current = count;
    const box = body.current, card = box?.querySelector<HTMLElement>("article[data-latest]");
    if (!box || !card) return;
    const t = setTimeout(() => {
      const delta = card.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom + 8;
      if (delta > 0) box.scrollTo({ top: box.scrollTop + delta, behavior: "smooth" });
    }, 350); // after the card's slide-in
    return () => clearTimeout(t);
  }, [count]);
  // Desktop dock idles as one line (title, question, Ask, ideas) so the plan keeps the screen.
  const [ideas, setIdeas] = useState(false);
  const send = async (question: string) => {
    if (!question.trim() || p.scout.busy) return;
    setError(undefined);
    const err = await p.onAsk(question.trim());
    if (err) setError(err);
    else setQ("");
  };
  const submit = (e: FormEvent) => { e.preventDefault(); send(q); };
  const latest = p.followUps.map((f, i) => ({ f, i })).reverse();
  const showBody = open && (p.scout.busy || p.scout.checks.length > 0 || count > 0);
  // Desktop: once the scout has answered, the dock shows only the verdict (so the stop tickets stay in
  // view); "Details" opens the trace and every answer. A new answer folds it back to the verdict.
  const [details, setDetails] = useState<number>();
  const compact = variant === "dock" && !p.scout.busy && count > 0 && details !== count;

  const form = (
    <form onSubmit={submit} className="flex min-w-0 flex-1 gap-2">
      <label htmlFor={`ask-${variant}`} className="sr-only">Ask the scout about this tour</label>
      <input id={`ask-${variant}`} value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} disabled={p.scout.busy}
        placeholder={p.placeholder} className="min-h-12 w-full min-w-0 rounded-xl border border-line bg-bg px-4 text-base outline-none placeholder:text-muted focus:border-accent disabled:opacity-60" />
      <button disabled={p.scout.busy || !q.trim()}
        className="min-h-12 shrink-0 rounded-xl bg-accent px-5 font-display text-lg uppercase text-accent-ink disabled:bg-surface-2 disabled:text-muted">
        {p.scout.busy ? "…" : "Ask"}
      </button>
    </form>
  );
  const chips = (
    <div className="mt-2 flex flex-wrap gap-2">
      {p.suggestions.map((s) => (
        <button key={s.text} type="button" disabled={p.scout.busy} onClick={() => send(s.text)}
          className="min-h-11 rounded-full border border-line px-3 text-left text-sm text-muted hover:border-accent hover:text-ink disabled:opacity-50">
          {s.text}{s.recorded && <span className="ml-1.5 text-xs text-qloo">· instant</span>}
        </button>
      ))}
    </div>
  );

  // Idle desktop dock: one line, so the plan keeps the screen; the ideas open below on demand.
  if (variant === "dock" && !showBody) {
    return (
      <section id="ask" aria-label="Ask the scout" className="no-print -mx-6 border-t border-line bg-surface px-6 py-3">
        <div className="flex items-center gap-3">
          <h2 className="shrink-0 font-display text-xl uppercase" title="An agent that runs Qloo tools and proposes changes">Ask the scout</h2>
          {form}
          {count > 0 && (
            <button type="button" onClick={() => setOpen(true)} className="min-h-12 shrink-0 rounded-xl border border-line px-3 text-sm text-muted hover:border-accent hover:text-ink">Answers ({count})</button>
          )}
          <button type="button" onClick={() => setIdeas(!ideas)} aria-expanded={ideas}
            className="min-h-12 shrink-0 rounded-xl border border-line px-3 text-sm text-muted hover:border-accent hover:text-ink">
            Ideas{p.suggestions.some((x) => x.recorded) && <span className="ml-1 text-xs text-qloo">· instant</span>} <span aria-hidden>{ideas ? "▴" : "▾"}</span>
          </button>
        </div>
        {ideas && chips}
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      </section>
    );
  }

  // Desktop dock after an answer: the verdict card plus the one-line ask row (about 200 px), so the
  // plan above keeps most of the column; "Details" opens the trace and every answer.
  if (variant === "dock" && compact) {
    return (
      <section id="ask" aria-label="Ask the scout" className="no-print relative z-10 -mx-6 border-t border-line bg-surface px-6 pb-3 pt-3 shadow-[0_-14px_28px_-14px_rgb(0_0_0/0.55)]">
        <AnswerCard f={latest[0].f} index={latest[0].i} latest busy={p.scout.busy} replayed={p.replayed.includes(latest[0].i)} onApply={p.onApply} compact onExpand={() => setDetails(count)} />
        <div className="mt-2 flex items-center gap-3">
          <h2 className="shrink-0 font-display text-xl uppercase" title="An agent that runs Qloo tools and proposes changes">Ask the scout</h2>
          {form}
          <button type="button" onClick={() => setIdeas(!ideas)} aria-expanded={ideas}
            className="min-h-12 shrink-0 rounded-xl border border-line px-3 text-sm text-muted hover:border-accent hover:text-ink">
            Ideas <span aria-hidden>{ideas ? "▴" : "▾"}</span>
          </button>
          <button type="button" onClick={() => setOpen(false)} className="min-h-12 shrink-0 px-1 text-sm text-muted underline underline-offset-4 hover:text-ink">Hide</button>
        </div>
        {ideas && chips}
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      </section>
    );
  }

  const panel = (
    <section id="ask" aria-label="Ask the scout"
      className={variant === "dock"
        ? "no-print relative z-10 -mx-6 border-t border-line bg-surface px-6 pb-3 pt-3 shadow-[0_-14px_28px_-14px_rgb(0_0_0/0.55)]"
        : "slide-in max-h-[85dvh] w-full overflow-hidden rounded-t-2xl border border-line bg-surface p-4"}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-2xl uppercase">Ask the scout</h2>
        {variant === "dock" ? (
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="min-h-11 px-2 text-sm text-muted hover:text-ink">{open ? "Hide answers" : `Answers (${count})`}</button>
        ) : (
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full text-xl text-muted hover:text-ink">×</button>
        )}
      </div>
      {showBody && (
        <div ref={body} className={`mt-2 space-y-3 overflow-y-auto pr-1 ${variant === "dock" ? "max-h-[calc(var(--app-h,100dvh)*0.34)]" : "max-h-[50dvh]"}`}>
          {compact ? (
            <AnswerCard f={latest[0].f} index={latest[0].i} latest busy={p.scout.busy} replayed={p.replayed.includes(latest[0].i)} onApply={p.onApply} compact onExpand={() => setDetails(count)} />
          ) : (
            <>
              {(p.scout.busy || p.scout.checks.length > 0) && <Trace checks={p.scout.checks} busy={p.scout.busy} f={p.scout.busy ? undefined : latest[0]?.f} />}
              {latest.map(({ f, i }, k) => <AnswerCard key={`${f.askedAt}-${i}`} f={f} index={i} latest={k === 0} busy={p.scout.busy} replayed={p.replayed.includes(i)} onApply={p.onApply} />)}
            </>
          )}
        </div>
      )}
      {/* Desktop: Ideas sits on the ask row, so the open panel leaves the plan header (receipts, share) in view. */}
      <div className="mt-3 flex items-center gap-3">
        {form}
        {variant === "dock" && (
          <button type="button" onClick={() => setIdeas(!ideas)} aria-expanded={ideas}
            className="min-h-12 shrink-0 rounded-xl border border-line px-3 text-sm text-muted hover:border-accent hover:text-ink">
            Ideas <span aria-hidden>{ideas ? "▴" : "▾"}</span>
          </button>
        )}
      </div>
      {(variant === "sheet" || ideas) && chips}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
  if (variant === "dock") return panel;
  return (
    <div className="no-print fixed inset-0 z-[1100] flex items-end bg-black/50 lg:hidden" onClick={onClose}>
      <div className="w-full" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Ask the scout">{panel}</div>
    </div>
  );
}

/**
 * Phones: the agent's route check arrives as a peek above the stop chips (a handle, the proposed change,
 * Apply), so the route map stays in view. Tapping it opens the full sheet; × dismisses it.
 */
export function ScoutPeek({ f, index, busy, onApply, onOpen, onClose, slim = false }: { f: FollowUp; index: number; busy: boolean; onApply: (i: number) => Promise<string | undefined>; onOpen: () => void; onClose: () => void; slim?: boolean }) {
  const [error, setError] = useState<string>();
  const by = f.proposal ? (f.proposedBy === "server" ? " · server proposed" : f.proposedBy === "agent" ? " · agent proposed" : " · proposed") : "";
  // Slim once the visitor scrolls into the tickets: one line, no handle, so the plan keeps most of the screen.
  return (
    <div role="region" aria-label="Agent route check" className={`no-print slide-in fixed inset-x-2 bottom-[64px] z-[1050] rounded-2xl border border-neon/70 bg-surface px-4 shadow-2xl lg:hidden ${slim ? "py-1" : "pb-3 pt-1"}`}>
      {!slim && (
        <button type="button" onClick={onOpen} aria-label="Open the scout's answer" className="mx-auto mb-1 flex h-6 w-full items-center justify-center">
          <span aria-hidden className="h-1.5 w-12 rounded-full bg-line" />
        </button>
      )}
      <div className="flex items-center gap-3">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          {!slim && <span className="block text-xs text-muted">Agent route check{by}</span>}
          <span className={`${slim ? "line-clamp-1" : "line-clamp-2"} text-sm font-semibold leading-snug`}>{f.proposal ? (slim ? slimChange(changeText(f.proposal.summary)) : changeText(f.proposal.summary)) : f.answer.text}</span>
        </button>
        {f.proposal && !f.appliedAs && (
          <button type="button" disabled={busy} onClick={async () => setError(await onApply(index))}
            className="min-h-11 shrink-0 rounded-lg bg-neon px-4 font-display text-base uppercase text-neon-ink disabled:opacity-50">Apply</button>
        )}
        <button type="button" onClick={onClose} aria-label="Dismiss" className="grid h-11 w-9 shrink-0 place-items-center text-xl text-muted hover:text-ink">×</button>
      </div>
      {error && <p role="alert" className="mt-1 text-sm text-danger">{error}</p>}
    </div>
  );
}

/** The agent's own one-line reason, labelled as AI by its chip, set apart from the code-written verdict. */
function AgentNote({ item, compact = false }: { item: Insight; compact?: boolean }) {
  return (
    <div className={compact ? "mt-1" : "mt-2 rounded-lg border-l-2 border-ai pl-3"}>
      {!compact && <p className="text-xs uppercase tracking-wide text-muted">The agent’s reasoning, in its own words</p>}
      <InsightText item={item} className={compact ? "min-w-0 [&_p]:text-sm [&_p]:leading-snug" : "mt-0.5"} />
    </div>
  );
}

