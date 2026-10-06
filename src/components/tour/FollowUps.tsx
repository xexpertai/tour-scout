"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { FollowUp } from "@/lib/tour/types";
import { Chip, Cites, InsightText, clean } from "./atoms";
import type { ScoutCheck } from "./useTourRun";

/** The agent's trace: numbered steps, a spinner on the one in progress, the Qloo result under each. */
function Trace({ checks, busy }: { checks: ScoutCheck[]; busy: boolean }) {
  return (
    <ol aria-live="polite" aria-label="What the scout is doing" className="space-y-2">
      {checks.map((c, i) => (
        <li key={i} className="slide-in flex items-start gap-3">
          <span aria-hidden className={`grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-xs font-bold ${
            c.status === "running" ? "animate-spin border-2 border-accent border-t-transparent" : c.status === "failed" ? "bg-danger text-bg" : "bg-accent text-accent-ink"}`}>
            {c.status === "running" ? "" : i + 1}
          </span>
          <span className="min-w-0 pt-0.5">
            <span className={`block text-sm ${c.status === "running" ? "text-ink" : "text-muted"}`}>
              <span className="sr-only">Step {i + 1}{c.status === "running" ? ", in progress" : ""}: </span>{c.label}
            </span>
            {c.detail && <span className="block text-xs text-muted">{clean(c.detail)}</span>}
          </span>
        </li>
      ))}
      {busy && !checks.some((c) => c.status === "running") && (
        <li className="flex items-center gap-3 text-sm text-ink"><span aria-hidden className="h-6 w-6 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />thinking…</li>
      )}
    </ol>
  );
}

function AnswerCard({ f, index, busy, replayed, onApply }: { f: FollowUp; index: number; busy: boolean; replayed: boolean; onApply: (i: number) => Promise<string | undefined> }) {
  const [error, setError] = useState<string>();
  const label = f.kind === "quick" ? "Quick check · no AI" : f.by === "claude" ? (replayed ? "AI scout · recorded answer" : "AI scout") : "Templated scout · no AI";
  return (
    <article id={`ask-${index}`} className="slide-in scroll-mt-28 rounded-xl border border-line bg-bg p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm text-muted">“{f.question}”</p>
        <span className="text-xs text-muted">{label}</span>
      </div>
      {f.kind === "quick" && f.city && f.rank !== undefined && (
        <div className="mt-2 flex flex-wrap items-baseline gap-2">
          <h3 className="font-display text-2xl uppercase">{clean(f.city)}</h3>
          <span className="flex items-center gap-1.5 text-sm"><b className="font-display text-2xl">{Math.round((f.affinity ?? 0) * 100)}</b> · #{f.rank} of {f.of} <Chip kind="qloo" /> <Cites ids={[f.sources[0].id]} /></span>
        </div>
      )}
      <InsightText item={f.answer} className="mt-2" />
      {f.proposal && (
        <div className="mt-3 rounded-lg border border-dashed border-neon/70 p-3">
          <p className="text-sm text-muted">Proposed change <span className="text-xs">(previewed on the map)</span></p>
          <p className="mt-0.5 font-display text-xl uppercase">{f.proposal.summary}</p>
          {f.appliedAs ? (
            <p className="mt-2 text-sm text-qloo">Applied ✓</p>
          ) : (
            <button type="button" disabled={busy} onClick={async () => setError(await onApply(index))}
              className="mt-2 min-h-11 rounded-lg bg-neon px-5 font-display text-lg uppercase text-white disabled:opacity-50">
              Apply to my tour
            </button>
          )}
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
  useEffect(() => { body.current?.scrollTo({ top: 0, behavior: "smooth" }); }, [count]);
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

  const panel = (
    <section id="ask" aria-label="Ask the scout"
      className={variant === "dock"
        ? "no-print -mx-4 border-t border-line bg-surface/95 px-4 pb-4 pt-3 shadow-[0_-12px_30px_-12px_rgba(0,0,0,.6)] backdrop-blur sm:-mx-6 sm:px-6"
        : "slide-in max-h-[85dvh] w-full overflow-hidden rounded-t-2xl border border-line bg-surface p-4"}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-2xl uppercase">Ask the scout</h2>
        {variant === "dock" ? (
          showBody || count ? (
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="min-h-11 px-2 text-sm text-muted hover:text-ink">{open ? "Hide answers" : `Answers (${count})`}</button>
          ) : <span className="text-xs text-muted">An agent that runs Qloo tools and proposes changes</span>
        ) : (
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full text-xl text-muted hover:text-ink">×</button>
        )}
      </div>
      {showBody && (
        <div ref={body} className={`mt-2 space-y-3 overflow-y-auto pr-1 ${variant === "dock" ? "max-h-[42vh]" : "max-h-[50dvh]"}`}>
          {(p.scout.busy || p.scout.checks.length > 0) && <Trace checks={p.scout.checks} busy={p.scout.busy} />}
          {latest.map(({ f, i }) => <AnswerCard key={`${f.askedAt}-${i}`} f={f} index={i} busy={p.scout.busy} replayed={p.replayed.includes(i)} onApply={p.onApply} />)}
        </div>
      )}
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <label htmlFor={`ask-${variant}`} className="sr-only">Ask the scout about this tour</label>
        <input id={`ask-${variant}`} value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} disabled={p.scout.busy}
          placeholder={p.placeholder} className="min-h-12 w-full min-w-0 rounded-xl border border-line bg-bg px-4 text-base outline-none placeholder:text-muted focus:border-accent disabled:opacity-60" />
        <button disabled={p.scout.busy || !q.trim()}
          className="min-h-12 shrink-0 rounded-xl bg-accent px-5 font-display text-lg uppercase text-accent-ink disabled:bg-surface-2 disabled:text-muted">
          {p.scout.busy ? "…" : "Ask"}
        </button>
      </form>
      <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
        {p.suggestions.map((s) => (
          <button key={s.text} type="button" disabled={p.scout.busy} onClick={() => send(s.text)}
            className="min-h-11 shrink-0 rounded-full border border-line px-3 text-left text-sm text-muted hover:border-accent hover:text-ink disabled:opacity-50">
            {s.text}{s.recorded && <span className="ml-1.5 text-xs text-qloo">· instant</span>}
          </button>
        ))}
      </div>
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
