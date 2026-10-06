"use client";

import { createContext, useContext, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { Insight } from "@/lib/guard";

export const clean = (s: string) => s.replace(/\s*\(sample\)$/, "");
/** Same output on server and client (fixed locale and UTC), so dates never cause hydration mismatches. */
const DAY = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" });
export const shortDate = (iso: string) => DAY.format(new Date(iso));

export const isSample = (s: string) => /\(sample\)$/.test(s);

/**
 * "Show receipts": provenance is always present, but by default it is a coloured dot (with a
 * screen-reader label); with receipts on, every value shows its label and the Q-ids of the Qloo
 * requests behind it.
 */
export const ReceiptsContext = createContext<{ on: boolean; toggle: () => void }>({ on: true, toggle: () => {} });
export const useReceipts = () => useContext(ReceiptsContext);

export function ReceiptsToggle() {
  const { on, toggle } = useReceipts();
  return (
    <button type="button" role="switch" aria-checked={on} onClick={toggle}
      className="no-print inline-flex min-h-11 items-center gap-2.5 rounded-full border border-line px-3.5 text-sm hover:border-qloo">
      <span aria-hidden className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-qloo" : "bg-surface-2"}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-ink transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
      </span>
      Show receipts
    </button>
  );
}

/** One line explaining the dots, shown under the plan header. */
export function ProvenanceLegend() {
  const dot = (cls: string) => <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${cls}`} />;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <span className="flex items-center gap-1.5">{dot("bg-qloo")} Qloo data</span>
      <span className="flex items-center gap-1.5">{dot("bg-ai")} AI text citing Qloo</span>
      <span className="flex items-center gap-1.5">{dot("bg-general")} template or general</span>
    </p>
  );
}

/**
 * Display-type size that fits the longest word on one line of its container (needs a parent with
 * `container-type: inline-size`). Words never break mid-word; long names just get smaller.
 */
export function fitDisplay(text: string, max: string): CSSProperties {
  const longest = Math.max(...clean(text).split(/\s+/).map((w) => w.length), 4);
  return { fontSize: `min(${max}, calc(100cqw / ${(longest * 0.5).toFixed(2)}))`, overflowWrap: "normal", hyphens: "none" };
}

/**
 * A city's room affinity (0–100) with its rank among every city Qloo scored for this run, so
 * close scores (88 vs 89) read as a ranking, not a percentage. The explainer works without hover.
 */
export function AffinityScore({ value, sample, evidence, rank, of }: { value: number; sample: boolean; evidence: string; rank?: number; of?: number }) {
  const [open, setOpen] = useState(false);
  const score = Math.round(value * 100);
  return (
    <div className="relative shrink-0 text-right">
      <div className="flex items-start justify-end gap-1">
        <span className="font-display text-5xl leading-none tabular-nums">{score}</span>
        <button type="button" aria-expanded={open} aria-label="What is room affinity?" onClick={() => setOpen(!open)}
          className="no-print -mr-2 -mt-2 grid h-11 w-11 place-items-center rounded-full text-muted hover:text-ink">
          <span aria-hidden className="grid h-6 w-6 place-items-center rounded-full border border-line text-xs">?</span>
        </button>
      </div>
      <div className="mt-1 flex items-center justify-end gap-1.5 text-xs text-muted">
        {rank && of ? <span>#{rank} of {of} cities</span> : <span>room affinity</span>}
        <Chip kind={sample ? "sample" : "qloo"} /> <Cites ids={[evidence]} />
      </div>
      {open && (
        <p role="note" className="absolute right-0 top-full z-20 mt-2 w-72 rounded-lg border border-line bg-surface-2 p-3 text-left text-xs leading-relaxed text-ink shadow-xl">
          Room affinity: Qloo&apos;s affinity (0–100) between the act&apos;s audience, in aggregate, and the best-matching live room in this city.
          Every city is scored the same way, so it ranks cities against each other{rank && of ? ` (this one is #${rank} of ${of})` : ""}.
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

const DOT: Record<keyof typeof CHIP, string> = { qloo: "bg-qloo", ai: "bg-ai", general: "bg-general", template: "bg-general", osm: "bg-general", sample: "bg-sample", user: "bg-general" };

/**
 * Provenance: a labelled pill with receipts on; otherwise a small coloured dot that still has a
 * label for screen readers and a tooltip. Sample data always shows its full label.
 */
export function Chip({ kind }: { kind: keyof typeof CHIP }) {
  const { on } = useReceipts();
  const c = CHIP[kind];
  if (!on && kind !== "sample") {
    return <span title={c.title} className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full align-middle ${DOT[kind]}`}><span className="sr-only">{c.title}</span></span>;
  }
  return <span title={c.title} className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[11px] font-bold tracking-wide ${c.cls}`}>{c.label}</span>;
}

/** The credits list is folded by default; a Q-id link unfolds it before the browser jumps to the row. */
const openCredits = () => document.querySelector<HTMLDetailsElement>("#credits details")?.setAttribute("open", "");

/** Evidence ids that jump to the request in the credits roll. */
export function Cites({ ids }: { ids: string[] }) {
  const { on } = useReceipts();
  if (!ids.length || !on) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 font-mono text-[11px]">
      {ids.map((id) => (
        <a key={id} href={`#source-${id}`} onClick={openCredits} className="rounded border border-line px-1 py-0.5 text-muted hover:border-qloo hover:text-qloo">{id}</a>
      ))}
    </span>
  );
}

export function InsightText({ item, className = "", clamp = false }: { item: Insight; className?: string; clamp?: boolean }) {
  const { on } = useReceipts();
  const chip = <Chip kind={item.kind === "interpretation" ? "ai" : item.kind} />;
  return (
    <div className={className}>
      <p className={`whitespace-pre-line text-[15px] leading-relaxed ${clamp ? "line-clamp-2" : ""}`}>{!on && <span className="mr-2 inline-flex align-middle">{chip}</span>}{item.text}</p>
      {on && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {chip}
          <Cites ids={item.evidence} />
        </div>
      )}
    </div>
  );
}

export function Writing({ label = "Writing…" }: { label?: string }) {
  return (
    <div aria-label={label} className="space-y-2">
      <div className="skeleton h-3 w-11/12" />
      <div className="skeleton h-3 w-9/12" />
      <p className="text-xs text-muted">{label}</p>
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
