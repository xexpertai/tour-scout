"use client";

import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { Insight } from "@/lib/guard";

export const clean = (s: string) => s.replace(/\s*\(sample\)$/, "");
/** Same output on server and client (fixed locale and UTC), so dates never cause hydration mismatches. */
const DAY = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" });
export const shortDate = (iso: string) => DAY.format(new Date(iso));

export const isSample = (s: string) => /\(sample\)$/.test(s);

/**
 * Display-type size that fits the longest word on one line of its container (needs a parent with
 * `container-type: inline-size`). Words never break mid-word; long names just get smaller.
 */
export function fitDisplay(text: string, max: string): CSSProperties {
  const longest = Math.max(...clean(text).split(/\s+/).map((w) => w.length), 4);
  return { fontSize: `min(${max}, calc(100cqw / ${(longest * 0.5).toFixed(2)}))`, overflowWrap: "normal", hyphens: "none" };
}

/** Qloo affinity shown as 0–100 with a bar and an explainer that works without hover. */
export function AffinityScore({ value, sample, evidence }: { value: number; sample: boolean; evidence: string }) {
  const [open, setOpen] = useState(false);
  const score = Math.round(value * 100);
  return (
    <div className="relative w-28 shrink-0 text-right">
      <div className="flex items-center justify-end gap-1.5">
        <span className="font-mono text-3xl font-bold leading-none">{score}</span>
        <button type="button" aria-expanded={open} aria-label="What is room affinity?" onClick={() => setOpen(!open)}
          className="no-print grid h-7 w-7 place-items-center rounded-full border border-line font-mono text-xs text-muted hover:text-ink">?</button>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent" style={{ width: `${score}%` }} /></div>
      <div className="mt-1 flex items-center justify-end gap-1 font-mono text-[10px] uppercase tracking-wider text-muted">
        room affinity <Chip kind={sample ? "sample" : "qloo"} /> <Cites ids={[evidence]} />
      </div>
      {open && (
        <p role="note" className="absolute right-0 top-full z-20 mt-2 w-64 rounded-lg border border-line bg-surface-2 p-3 text-left text-xs leading-relaxed text-ink shadow-xl">
          Qloo&apos;s affinity (0–100) between the act&apos;s audience, in aggregate, and the best-matching live room in this city. The same measure for every city, so it ranks cities against each other.
          It is not a ticket, attendance or sales forecast.
        </p>
      )}
    </div>
  );
}

const CHIP = {
  qloo: { label: "QLOO", cls: "bg-qloo-bg text-qloo", title: "Value returned by Qloo" },
  ai: { label: "AI", cls: "bg-ai-bg text-ai", title: "AI interpretation that cites Qloo evidence" },
  general: { label: "GENERAL", cls: "bg-general-bg text-general", title: "AI text with no Qloo evidence behind it" },
  template: { label: "TEMPLATE", cls: "bg-general-bg text-general", title: "Text filled in by code from the Qloo values it cites; no AI wrote it" },
  osm: { label: "OSM", cls: "bg-general-bg text-general", title: "Place name from OpenStreetMap" },
  sample: { label: "SAMPLE", cls: "bg-sample-bg text-sample", title: "Sample data, not from Qloo" },
  user: { label: "YOURS", cls: "bg-general-bg text-general", title: "Your own input, not Qloo data" },
} as const;

/** Provenance label that reads without hover: short mono pill, colour plus text. */
export function Chip({ kind }: { kind: keyof typeof CHIP }) {
  const c = CHIP[kind];
  return <span title={c.title} className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider ${c.cls}`}>{c.label}</span>;
}

/** Evidence ids that jump to the request in the credits roll. */
export function Cites({ ids }: { ids: string[] }) {
  if (!ids.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 font-mono text-[11px]">
      {ids.map((id) => (
        <a key={id} href={`#source-${id}`} className="rounded border border-line px-1 py-0.5 text-muted hover:border-qloo hover:text-qloo">{id}</a>
      ))}
    </span>
  );
}

export function InsightText({ item, className = "" }: { item: Insight; className?: string }) {
  return (
    <div className={className}>
      <p className="whitespace-pre-line text-sm leading-relaxed">{item.text}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Chip kind={item.kind === "interpretation" ? "ai" : item.kind} />
        <Cites ids={item.evidence} />
      </div>
    </div>
  );
}

export function Writing({ label = "Writing…" }: { label?: string }) {
  return (
    <div aria-label={label} className="space-y-2">
      <div className="skeleton h-3 w-11/12" />
      <div className="skeleton h-3 w-9/12" />
      <p className="font-mono text-[11px] text-muted">{label}</p>
    </div>
  );
}

export function Section({ title, kicker, children, id }: { title: string; kicker?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="scroll-mt-24">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h2 className="font-display text-2xl uppercase tracking-wide sm:text-3xl">{title}</h2>
        {kicker}
      </div>
      {children}
    </section>
  );
}

type Theme = "light" | "dark";
const THEME_EVENT = "themechange";
function subscribeTheme(onChange: () => void) {
  window.addEventListener(THEME_EVENT, onChange);
  return () => window.removeEventListener(THEME_EVENT, onChange);
}
// Dark is the brand default; light only when the visitor chose it.
const readTheme = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

/** The resolved theme: the visitor's saved choice, else dark. Null during server rendering. */
export function useTheme(): Theme | null {
  return useSyncExternalStore(subscribeTheme, readTheme, () => null);
}
export const useIsDark = () => useTheme() !== "light";

export function ThemeToggle() {
  const theme = useTheme();
  if (!theme) return <span className="h-11 w-11" />;
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem("theme", next); } catch { /* preference is optional */ }
        window.dispatchEvent(new Event(THEME_EVENT));
      }}
      className="grid h-11 w-11 place-items-center rounded-full border border-line text-muted hover:text-ink"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        {theme === "dark" ? <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>}
      </svg>
    </button>
  );
}
