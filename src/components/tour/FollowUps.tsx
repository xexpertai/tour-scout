"use client";

import { useState, type FormEvent } from "react";
import type { FollowUp } from "@/lib/tour/types";
import { Chip, Cites, InsightText, Section, clean } from "./atoms";
import type { ScoutCheck } from "./useTourRun";

/** The agent's trace: numbered steps, a spinner on the one in progress, the Qloo result under each. */
function Trace({ checks, busy }: { checks: ScoutCheck[]; busy: boolean }) {
  return (
    <ol aria-live="polite" aria-label="What the scout is doing" className="mt-3 space-y-2 rounded-xl border border-line bg-surface px-4 py-3">
      {checks.map((c, i) => (
        <li key={i} className="slide-in flex items-start gap-3">
          <span aria-hidden className={`grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-[11px] font-bold ${
            c.status === "running" ? "border-2 border-accent border-t-transparent animate-spin" : c.status === "failed" ? "bg-danger text-bg" : "bg-accent text-accent-ink"}`}>
            {c.status === "running" ? "" : i + 1}
          </span>
          <span className="min-w-0 pt-0.5">
            <span className={`block text-sm ${c.status === "running" ? "text-ink" : "text-muted"}`}>
              <span className="sr-only">Step {i + 1}{c.status === "running" ? ", in progress" : ""}: </span>{c.label}
            </span>
            {c.detail && <span className="block font-mono text-[11px] text-muted">{clean(c.detail)}</span>}
          </span>
        </li>
      ))}
      {busy && !checks.some((c) => c.status === "running") && (
        <li className="flex items-center gap-3 text-sm text-ink"><span aria-hidden className="h-6 w-6 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />thinking…</li>
      )}
    </ol>
  );
}

function AnswerCard({ f, index, busy, onApply }: { f: FollowUp; index: number; busy: boolean; onApply: (i: number) => Promise<string | undefined> }) {
  const [error, setError] = useState<string>();
  const label = f.kind === "quick" ? "Quick check · no AI" : f.by === "claude" ? "AI scout" : "Templated scout · no AI";
  return (
    <article id={`ask-${index}`} className="slide-in scroll-mt-28 rounded-2xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 font-mono text-xs text-muted">“{f.question}”</p>
        <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">{label}</span>
      </div>
      {f.kind === "quick" && f.city && f.rank !== undefined && (
        <div className="mt-2 flex flex-wrap items-baseline gap-2">
          <h3 className="font-display text-2xl uppercase">{clean(f.city)}</h3>
          <span className="flex items-center gap-1.5 font-mono text-sm"><b className="text-xl">{Math.round((f.affinity ?? 0) * 100)}</b> · #{f.rank} of {f.of} <Chip kind="qloo" /> <Cites ids={[f.sources[0].id]} /></span>
        </div>
      )}
      <InsightText item={f.answer} className="mt-3" />
      {f.proposal && (
        <div className="mt-4 rounded-xl border border-dashed border-accent/60 p-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">Proposed change</p>
          <p className="mt-1 font-mono text-sm">{f.proposal.summary}</p>
          {f.appliedAs ? (
            <p className="mt-2 font-mono text-xs text-qloo">Applied ✓</p>
          ) : (
            <button type="button" disabled={busy} onClick={async () => setError(await onApply(index))}
              className="mt-3 min-h-11 rounded-xl bg-accent px-5 font-display text-lg uppercase text-accent-ink disabled:opacity-50">
              Apply to my tour
            </button>
          )}
          {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        </div>
      )}
    </article>
  );
}

export function ScoutPanel({ followUps, scout, onAsk, onApply, suggestions, placeholder }: {
  followUps: FollowUp[];
  scout: { busy: boolean; checks: ScoutCheck[] };
  onAsk: (q: string) => Promise<string | undefined>;
  onApply: (i: number) => Promise<string | undefined>;
  suggestions: string[];
  placeholder: string;
}) {
  const [q, setQ] = useState("");
  const [error, setError] = useState<string>();
  const send = async (question: string) => {
    if (!question.trim() || scout.busy) return;
    setError(undefined);
    const err = await onAsk(question.trim());
    if (err) setError(err);
    else setQ("");
  };
  const submit = (e: FormEvent) => { e.preventDefault(); send(q); };
  return (
    <Section title="Ask the scout" id="ask">
      <form onSubmit={submit} className="flex gap-2">
        <label htmlFor="ask-city" className="sr-only">Ask the scout about this tour</label>
        <input id="ask-city" value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} disabled={scout.busy}
          placeholder={placeholder} className="min-h-12 w-full min-w-0 rounded-xl border border-line bg-surface px-4 text-base outline-none placeholder:text-muted focus:border-accent disabled:opacity-60" />
        <button disabled={scout.busy || !q.trim()}
          className="min-h-12 shrink-0 rounded-xl border-2 border-accent bg-accent px-5 font-display text-lg uppercase text-accent-ink disabled:border-line disabled:bg-transparent disabled:text-muted">
          {scout.busy ? "…" : "Ask"}
        </button>
      </form>
      <div className="mt-2 flex flex-wrap gap-2">
        {suggestions.map((s) => (
          <button key={s} type="button" disabled={scout.busy} onClick={() => send(s)}
            className="min-h-10 rounded-full border border-line px-3 text-left text-xs text-muted hover:border-accent hover:text-ink disabled:opacity-50">{s}</button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">The scout picks Qloo tools, runs them, and proposes a change you can apply. Every claim links to its Qloo request.</p>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      {(scout.busy || scout.checks.length > 0) && <Trace checks={scout.checks} busy={scout.busy} />}
      <div className="mt-4 space-y-3">
        {followUps.map((f, i) => ({ f, i })).reverse().map(({ f, i }) => <AnswerCard key={`${f.askedAt}-${i}`} f={f} index={i} busy={scout.busy} onApply={onApply} />)}
      </div>
    </Section>
  );
}
