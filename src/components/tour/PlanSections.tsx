"use client";

import type { Insight, Withheld } from "@/lib/guard";
import type { Source } from "@/lib/evidence";
import type { Coverage, FanProfile } from "@/lib/tour/types";
import { Chip, Cites, InsightText, Section, Writing, clean, isSample } from "./atoms";

const AGE: Record<string, string> = {
  "24_and_younger": "≤24", "25_to_29": "25–29", "30_to_34": "30–34", "35_to_44": "35–44", "45_to_54": "45–54", "55_and_older": "55+",
};

function IndexBar({ label, value }: { label: string; value: number }) {
  const pct = Math.min(Math.abs(value), 1) * 50;
  return (
    <div className="grid grid-cols-[52px_1fr_48px] items-center gap-2 text-xs">
      <span className="font-mono text-muted">{label}</span>
      <div className="relative h-2.5 rounded-full bg-surface-2">
        <div className="absolute inset-y-0 left-1/2 w-px bg-line" />
        <div className={`absolute inset-y-0 rounded-full ${value >= 0 ? "bg-accent" : "bg-muted/60"}`} style={value >= 0 ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }} />
      </div>
      <span className="text-right font-mono text-muted">{value > 0 ? "+" : ""}{value.toFixed(2)}</span>
    </div>
  );
}

/** The fan profile as a festival line-up: bigger type means stronger affinity. */
export function FanLineup({ fan, proxyOf }: { fan?: FanProfile; proxyOf?: string[] }) {
  if (!fan || (!fan.tags.length && !fan.demographics && !fan.alsoLikes.length)) {
    return <Section title="The fans" id="fans"><div className="space-y-2"><div className="skeleton h-10" /><div className="skeleton h-24" /></div></Section>;
  }
  const max = Math.max(...fan.tags.map((t) => t.affinity ?? 0.5), 0.01);
  const sample = fan.tags.some((t) => isSample(t.name));
  return (
    <Section title="The fans" id="fans" kicker={<span className="flex items-center gap-1.5"><Chip kind={sample ? "sample" : "qloo"} /><Cites ids={fan.tags[0] ? [fan.tags[0].evidence] : []} /></span>}>
      <div className="rounded-2xl border border-line bg-surface p-5 text-center sm:p-8">
        {proxyOf?.length ? <p className="mb-3 font-mono text-[11px] uppercase tracking-wider text-muted">Based on fans of {proxyOf.map(clean).join(", ")}</p> : null}
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-accent">Their taste, headlining</p>
        {fan.tags.length < 3 && (
          <p className="mx-auto mt-2 max-w-md text-xs text-muted">Limited data: Qloo returned {fan.tags.length ? "only a few" : "no"} taste tags for this audience (identity, place and business tags are never shown).</p>
        )}
        <div className="mt-3 flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1">
          {fan.tags.map((t, i) => (
            <span key={t.id} className="font-display uppercase leading-none" style={{ fontSize: `${1.1 + 1.6 * ((t.affinity ?? 0.5) / max)}rem`, opacity: 0.55 + 0.45 * ((t.affinity ?? 0.5) / max) }}>
              {clean(t.name)}{i < fan.tags.length - 1 && <span className="ml-3 text-accent">·</span>}
            </span>
          ))}
        </div>
        {fan.alsoLikes.map((group) => (
          <div key={group.domain} className="mt-5">
            <p className="flex items-center justify-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">
              Also into · {group.domain === "movie" ? "films" : group.domain === "brand" ? "brands" : "TV"} <Cites ids={[group.evidence]} />
            </p>
            <p className="mt-1 text-sm sm:text-base">{group.items.map((x) => clean(x.name)).join("  ·  ")}</p>
          </div>
        ))}
        {fan.demographics && Object.keys(fan.demographics.age).length > 0 && (
          <div className="mx-auto mt-6 max-w-md text-left">
            <p className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Age affinity <Cites ids={[fan.demographics.evidence]} /></p>
            <div className="mt-2 space-y-1.5">{Object.entries(fan.demographics.age).map(([k, v]) => <IndexBar key={k} label={AGE[k] ?? k} value={v} />)}</div>
            <p className="mt-2 text-xs text-muted">Over- or under-index versus Qloo&apos;s baseline for this audience in aggregate. Not a headcount, and not about any one fan.</p>
          </div>
        )}
      </div>
    </Section>
  );
}

function IdeaList({ title, items, writing }: { title: string; items: Insight[]; writing: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <h3 className="font-display text-xl uppercase tracking-wide">{title}</h3>
      {items.length ? <ul className="mt-3 space-y-4">{items.map((t, i) => <li key={i}><InsightText item={t} /></li>)}</ul>
        : writing ? <div className="mt-3"><Writing /></div> : <p className="mt-3 text-sm text-muted">Nothing the data could support here.</p>}
    </div>
  );
}

export function ShowIdeas({ theme, merch, risks, writing }: { theme: Insight[]; merch: Insight[]; risks: Insight[]; writing: boolean }) {
  return (
    <Section title="The show" id="show">
      <div className="grid gap-4 md:grid-cols-3">
        <IdeaList title="Theme" items={theme} writing={writing} />
        <IdeaList title="Merch" items={merch} writing={writing} />
        <IdeaList title="Before you book" items={risks} writing={writing} />
      </div>
    </Section>
  );
}

export function WithheldNote({ withheld }: { withheld: Withheld[] }) {
  if (!withheld.length) return null;
  return (
    <div className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm">
      <b>{withheld.length} AI statement{withheld.length > 1 ? "s" : ""} withheld by the safe-use guard.</b>
      <ul className="mt-1 list-disc pl-5 text-xs text-muted">{withheld.map((w, i) => <li key={i}>{w.field}: {w.reason}</li>)}</ul>
    </div>
  );
}

export function Activity({ steps, running }: { steps: { label: string; evidence?: string[]; failed?: boolean }[]; running: boolean }) {
  const recent = steps.slice(-4);
  return (
    <div aria-live="polite" className="rounded-xl border border-line bg-surface px-4 py-3 font-mono text-xs">
      <div className="flex items-center justify-between text-muted">
        <span className="uppercase tracking-[0.2em]">{running ? "Scouting live" : "Scouted"}</span>
        <span>{steps.length} Qloo calls</span>
      </div>
      <ol className="mt-2 space-y-1">
        {recent.map((s, i) => (
          <li key={steps.length - recent.length + i} className={`slide-in flex items-start gap-2 ${s.failed ? "text-danger" : ""}`}>
            <span aria-hidden className={s.failed ? "" : "text-qloo"}>{s.failed ? "!" : "✓"}</span>
            <span className="min-w-0 break-words">{clean(s.label)} {s.evidence && <Cites ids={s.evidence} />}</span>
          </li>
        ))}
        {running && <li className="flex items-center gap-2 text-muted"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> querying Qloo…</li>}
      </ol>
    </div>
  );
}

/** Every Qloo request behind the plan, rolled like film credits. */
export function CreditsRoll({ sources }: { sources: Source[] }) {
  return (
    <Section title="Credits" id="credits" kicker={<span className="font-mono text-[11px] text-muted">{sources.length} Qloo requests · no credentials shown</span>}>
      <ol className="rounded-2xl border border-line bg-surface p-5 font-mono text-xs sm:p-8">
        {sources.map((s) => (
          <li id={`source-${s.id}`} key={s.id} className="scroll-mt-28 border-b border-line py-3 last:border-0 target:bg-surface-2">
            <div className="grid grid-cols-[3rem_1fr] gap-2">
              <span className="text-accent">{s.id}</span>
              <div className="min-w-0">
                <div className="text-sm text-ink [font-family:var(--font-sans)]">{clean(s.label)}</div>
                <div className="mt-0.5 text-muted">
                  {s.call.surface === "mock" ? "sample data" : `${s.call.surface} ${s.call.workflow}`} · {s.call.status} · {s.call.resultCount} result{s.call.resultCount === 1 ? "" : "s"}
                  {s.call.ms ? ` · ${s.call.ms} ms` : ""}{s.call.cached ? " · cached" : ""}
                </div>
                {s.call.requests.length > 0 && (
                  <details className="mt-1">
                    <summary className="min-h-9 cursor-pointer text-muted hover:text-ink">request</summary>
                    <pre className="mt-1 overflow-x-auto rounded-lg bg-bg p-3 text-[11px] leading-relaxed">{s.call.requests.map((r) => `${r.method} ${r.path}\n${JSON.stringify(r.query, null, 2)}`).join("\n\n")}</pre>
                  </details>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-center text-xs text-muted">Taste data: Qloo · Neighbourhood names: OpenStreetMap · Map: OpenStreetMap</p>
    </Section>
  );
}

/** How the cities were found, and an honest note when the data behind them is thin. */
export function CoverageNote({ coverage, region }: { coverage?: Coverage; region?: string }) {
  if (!coverage) return null;
  // Cities without matching rooms are simply skipped; data is "limited" only when hotspots fall short.
  const limited = coverage.limited || coverage.roomFallback;
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${limited ? "border-sample/60" : "border-line"} bg-surface`}>
      {limited && <p className="mb-1 font-mono text-[11px] font-bold uppercase tracking-wider text-sample">Limited data</p>}
      <p className="text-muted">
        {coverage.basis === "hotspots" ? (
          <>Cities come from Qloo&apos;s fan map of {region ?? "the region"} ({coverage.hotspotCells} hotspot cells{coverage.evidence && <> <Cites ids={[coverage.evidence]} /></>}) snapped to touring markets
            {coverage.remoteCells > 0 && <>; {coverage.remoteCells} hotspot{coverage.remoteCells === 1 ? " lies" : "s lie"} far from any touring city and {coverage.remoteCells === 1 ? "was" : "were"} skipped</>}.
            {coverage.roomFallback && <> Hotspots pointed to only {coverage.hotspotMarkets} touring {coverage.hotspotMarkets === 1 ? "city" : "cities"}, so cities whose rooms this audience favours were added.</>}
            {" "}Each city is scored by room affinity.</>
        ) : <>Your cities, each scored by room affinity.</>}
        {coverage.unscored.length > 0 && <> No matching rooms found in {coverage.unscored.join(", ")}.</>}
      </p>
    </div>
  );
}

