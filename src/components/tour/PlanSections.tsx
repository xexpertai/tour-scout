"use client";

import type { Insight, Withheld } from "@/lib/guard";
import type { Source } from "@/lib/evidence";
import { coverageText } from "@/lib/tour/coverage-text";
import type { City, Coverage, FanProfile } from "@/lib/tour/types";
import { Chip, Cites, InsightText, Section, Writing, clean, isSample, score1 } from "./atoms";

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
    return null; // appears with the first fan data; no placeholder blocks
  }
  const max = Math.max(...fan.tags.map((t) => t.affinity ?? 0.5), 0.01);
  const sample = fan.tags.some((t) => isSample(t.name));
  return (
    <Section title="The fans" id="fans" kicker={<span className="flex items-center gap-1.5"><Chip kind={sample ? "sample" : "qloo"} /><Cites ids={fan.tags[0] ? [fan.tags[0].evidence] : []} /></span>}>
      <div className="rounded-2xl border border-line bg-surface p-5 text-center sm:p-8">
        {proxyOf?.length ? <p className="mb-3 text-sm text-muted">Based on fans of {proxyOf.map(clean).join(", ")}</p> : null}
        <p className="font-display text-lg uppercase tracking-wide text-neon">Their taste, headlining</p>
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
            <p className="flex items-center justify-center gap-1.5 text-sm text-muted">
              Also into {group.domain === "movie" ? "these films" : group.domain === "brand" ? "these brands" : "these shows"} <Cites ids={[group.evidence]} />
            </p>
            <p className="mt-1 text-sm sm:text-base">{group.items.map((x) => clean(x.name)).join("  ·  ")}</p>
          </div>
        ))}
        {fan.demographics && Object.keys(fan.demographics.age).length > 0 && (
          <div className="mx-auto mt-6 max-w-md text-left">
            <p className="flex items-center gap-1.5 text-sm text-muted">Age affinity <Cites ids={[fan.demographics.evidence]} /></p>
            <div className="mt-2 space-y-1.5">{Object.entries(fan.demographics.age).map(([k, v]) => <IndexBar key={k} label={AGE[k] ?? k} value={v} />)}</div>
            <p className="mt-2 text-xs text-muted">Over- or under-index versus Qloo&apos;s baseline for this audience in aggregate. Not a headcount, and not about any one fan.</p>
          </div>
        )}
      </div>
    </Section>
  );
}

function IdeaRow({ title, items, writing }: { title: string; items: Insight[]; writing: boolean }) {
  return (
    <div className="grid gap-2 border-t border-line py-4 sm:grid-cols-[9rem_1fr]">
      <h3 className="font-display text-xl uppercase leading-tight">{title}</h3>
      {items.length ? <ol className="space-y-3">{items.map((t, i) => <li key={i}><InsightText item={t} /></li>)}</ol>
        : writing ? <Writing /> : <p className="text-sm text-muted">Nothing the data could support here.</p>}
    </div>
  );
}

/** Theme, merch and pre-booking checks as labelled rows (one reading direction, no card grid). */
export function ShowIdeas({ theme, merch, risks, writing }: { theme: Insight[]; merch: Insight[]; risks: Insight[]; writing: boolean }) {
  return (
    <Section title="The show" id="show">
      <div className="border-b border-line">
        <IdeaRow title="Theme" items={theme} writing={writing} />
        <IdeaRow title="Merch" items={merch} writing={writing} />
        <IdeaRow title="Before you book" items={risks} writing={writing} />
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

export function Activity({ steps, running, replay = false }: { steps: { label: string; evidence?: string[]; failed?: boolean }[]; running: boolean; replay?: boolean }) {
  const recent = steps.slice(-4);
  return (
    <div aria-live="polite" className="rounded-xl border border-line bg-surface px-4 py-3 text-sm">
      <div className="flex items-center justify-between text-muted">
        <span className="font-semibold text-ink">{replay ? (running ? "Replaying a captured run" : "Captured run") : running ? "Scouting live" : "Scouted"}</span>
        <span>{steps.length} Qloo {replay ? "results" : "calls"}</span>
      </div>
      <ol className="mt-2 space-y-1">
        {recent.map((s, i) => (
          <li key={steps.length - recent.length + i} className={`slide-in flex items-start gap-2 ${s.failed ? "text-danger" : "text-muted"}`}>
            <span aria-hidden className={s.failed ? "" : "text-qloo"}>{s.failed ? "!" : "✓"}</span>
            <span className="min-w-0 break-words">{clean(s.label)} {s.evidence && <Cites ids={s.evidence} />}</span>
          </li>
        ))}
        {running && <li className="flex items-center gap-2 text-muted"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> {replay ? "replaying recorded Qloo results…" : "querying Qloo…"}</li>}
      </ol>
    </div>
  );
}

/** Every Qloo request behind the plan, folded into one line until asked for. */
export function CreditsRoll({ sources }: { sources: Source[] }) {
  return (
    <section id="credits" className="scroll-mt-24">
      <details className="group rounded-2xl border border-line bg-surface">
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3">
          <span><b className="font-display text-xl uppercase">Credits</b> <span className="text-sm text-muted">· {sources.length} Qloo requests behind this plan, no credentials shown</span></span>
          <span className="text-sm text-muted group-open:hidden">View all</span><span className="hidden text-sm text-muted group-open:inline">Hide</span>
        </summary>
        <ol className="border-t border-line px-5 pb-4 font-mono text-xs">
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
      </details>
      <p className="mt-3 text-center text-xs text-muted">Taste data: Qloo · Neighbourhood names: OpenStreetMap (Nominatim) · Map: OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors</p>
    </section>
  );
}

/** How the cities were found, the ranking that picked the stops, and a note when data is thin. */
export function CoverageNote({ coverage, region, cities = [], stopNames = [] }: { coverage?: Coverage; region?: string; cities?: City[]; stopNames?: string[] }) {
  if (!coverage) return null;
  // Cities without matching rooms are simply skipped; data is "limited" only when hotspots fall short.
  const limited = coverage.limited || coverage.roomFallback;
  const ranked = [...cities].sort((a, b) => b.affinity - a.affinity);
  const onRoute = (c: City) => stopNames.includes(clean(c.name));
  const cut = ranked.filter(onRoute).length;
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${limited ? "border-sample/60" : "border-line"} bg-surface`}>
      {limited && <p className="mb-1 font-semibold text-sample">Limited data</p>}
      <p className="text-muted">{coverageText(coverage, region)}{coverage.evidence && <> <Cites ids={[coverage.evidence]} /></>}</p>
      {ranked.length > 1 && (
        <ol aria-label="Every city scored, best first" className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-1.5">
          {ranked.map((c, i) => (
            <li key={c.entityId} className="flex items-center">
              {i === cut && cut > 0 && cut < ranked.length && <span aria-label="cut line" className="mx-2 h-6 w-px bg-neon" />}
              <span className={`rounded-md px-2 py-1 ${onRoute(c) ? "bg-surface-2 text-ink" : "text-muted"}`}>
                {clean(c.name)} <b className="font-display text-base tabular-nums">{score1(c.affinity)}</b>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
