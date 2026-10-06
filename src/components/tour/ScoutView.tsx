"use client";

import { baseOrigin, sourceLabel } from "@/lib/tour/source-label";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { InsightText, ProvenanceLegend, ReceiptsContext, ReceiptsToggle, Section, Writing, clean, fitDisplay, shortDate } from "./atoms";
import { downloadCsv } from "./exportCsv";
import { ScoutDock } from "./FollowUps";
import { Activity, CoverageNote, CreditsRoll, FanLineup, ShowIdeas, WithheldNote } from "./PlanSections";
import { StopTicket } from "./Ticket";
import { distanceKm } from "@/lib/markets";
import type { RunState } from "./useTourRun";
import type { MapCity, MapGhost, MapProposal, MapStop } from "./TourMap";

// The map paints its own basemap colour at once (no grey skeleton); MapLibre fills it in moments later.
const TourMap = dynamic(() => import("./TourMap"), { ssr: false, loading: () => <div className="map-box h-full w-full" /> });

const ERROR_TITLES: Record<string, string> = {
  QLOO_RATE_LIMIT: "Qloo is rate-limiting us",
  RATE_LIMITED: "Easy, tour manager",
  DAILY_CAP: "Today's live budget is used up",
  QLOO_AUTH: "Qloo rejected the server's credential",
  QLOO_NOT_INSTALLED: "The Qloo connection isn't set up on this server",
  QLOO_TIMEOUT: "Qloo took too long to answer",
  TOUR_NO_CITIES: "Qloo found no cities with matching rooms for this act and region",
};

export type Heading = { name: string; sub: string; proxyOf?: string[]; arenaScale?: boolean; expectedStops?: number };

const llmLabel = (llm?: string) =>
  !llm ? undefined : llm.startsWith("scripted") ? (llm.includes("fallback") ? "templated text (AI unavailable)" : "templated text, no AI") : `text by ${llm === "claude" ? "Claude" : llm === "gemini" ? "Gemini" : llm}`;

/** One quiet line saying where the data came from: captured, shared or live; Qloo or sample; who wrote the text. */
function SourceLine({ state }: { state: RunState }) {
  const sample = state.qloo === "mock";
  const when = sourceLabel(state.origin, shortDate);
  return (
    <p className="text-sm text-muted">
      {sample ? <span className="font-semibold text-sample">Sample data, no Qloo key</span> : <><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-qloo align-middle" />{when}</>}
      {/* Who wrote the text is stated only once text exists (a run can stop before any is written). */}
      {llmLabel(state.llm) && (state.status === "writing" || state.status === "done") && <> · {llmLabel(state.llm)}</>}
    </p>
  );
}

/** Share, CSV and print under one menu, so three outlined buttons don't sit above the fold. */
function ExportMenu({ state }: { state: RunState }) {
  const [shared, setShared] = useState<string>();
  const plan = state.plan!;
  const link = () => (state.origin?.kind === "preset" ? `${window.location.origin}/?demo=${state.origin.slug}` : `${window.location.origin}/t/${plan.id}`);
  const share = async () => {
    const url = link();
    const title = `${clean(plan.artist.name)} · Tour Scout`;
    try {
      if (navigator.share) await navigator.share({ title, url });
      else { await navigator.clipboard.writeText(url); setShared("Link copied"); setTimeout(() => setShared(undefined), 2000); }
    } catch { /* the visitor cancelled the share sheet */ }
  };
  const item = "block min-h-11 w-full px-4 py-2.5 text-left text-sm hover:bg-surface-2";
  return (
    <details className="no-print relative">
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full border border-line px-4 text-sm hover:border-accent">{shared ?? "Share & export"} <span aria-hidden>▾</span></summary>
      <div className="absolute left-0 z-30 mt-1 w-52 overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
        <button type="button" onClick={share} className={item}>Copy share link</button>
        <button type="button" onClick={() => downloadCsv(plan)} className={item}>Download CSV</button>
        <button type="button" onClick={() => window.print()} className={item}>Print / PDF</button>
      </div>
    </details>
  );
}

export function ScoutView({ state, heading, onRetry, onRerunLive, onAsk, onApply, onHome }: {
  state: RunState; heading: Heading; onRetry: () => void; onRerunLive?: () => void;
  onAsk: (q: string) => Promise<string | undefined>; onApply: (i: number) => Promise<string | undefined>; onHome: () => void;
}) {
  const running = state.status === "running" || state.status === "writing";
  const writing = state.status === "writing";
  const [activeId, setActiveId] = useState<string>();
  const [focusId, setFocusId] = useState<string>();
  // Mobile: the sticky map shrinks once the visitor scrolls into the plan; "Expand" brings it back.
  const [compact, setCompact] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [receipts, setReceipts] = useState(false);
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    const onScroll = () => setCompact(window.scrollY > 160);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const ordered = useMemo(() => [...state.stops].sort((a, b) => (a.order ?? a.rank) - (b.order ?? b.rank)), [state.stops]);
  const mapStops: MapStop[] = useMemo(() => ordered.filter((s) => s.city.lat !== undefined && s.city.lng !== undefined)
    .map((s) => ({ id: s.stopId, order: s.order ?? s.rank, name: s.city.name, lat: s.city.lat!, lng: s.city.lng! })), [ordered]);
  const mapCities: MapCity[] = useMemo(() => state.cities.filter((c) => c.lat !== undefined && c.lng !== undefined)
    .map((c) => ({ id: c.entityId, name: c.name, lat: c.lat!, lng: c.lng!, affinity: c.affinity })), [state.cities]);

  const ghosts: MapGhost[] = useMemo(() => state.followUps.flatMap((f, i) => f.pins.map((p) => ({ key: `${i}-${p.name}`, name: p.name, lat: p.lat, lng: p.lng, affinity: p.affinity, target: `ask-${i}` }))), [state.followUps]);
  // The newest unapplied proposal is previewed on the map: removed stops fade, added cities pulse.
  const pending = [...state.followUps].reverse().find((f) => f.proposal && !f.appliedAs)?.proposal;
  const proposal: MapProposal | undefined = useMemo(() => pending && {
    add: pending.add.filter((c) => c.lat !== undefined && c.lng !== undefined).map((c) => ({ name: c.name, lat: c.lat!, lng: c.lng! })),
    remove: pending.remove,
  }, [pending]);
  const ranked = useMemo(() => [...state.cities].sort((a, b) => b.affinity - a.affinity).map((c) => clean(c.name)), [state.cities]);
  const rankOf = (name: string) => { const i = ranked.indexOf(clean(name)); return i >= 0 ? i + 1 : undefined; };
  const onRoute = (name: string) => ordered.some((s) => clean(s.city.name).toLowerCase() === clean(name).toLowerCase());
  const offRoute = [...state.cities].sort((a, b) => b.affinity - a.affinity).find((c) => !onRoute(c.name));
  const weakest = [...ordered].sort((a, b) => a.city.affinity - b.city.affinity)[0];
  const recordedQ = state.origin?.kind === "preset" ? state.recordedScout?.question : undefined;
  const suggestions = [
    ...(recordedQ ? [{ text: recordedQ, recorded: true }] : []),
    ...[
      "Swap the weakest stop for a stronger city",
      ordered[0] && !heading.arenaScale ? `Who's a good opener in ${clean(ordered[0].city.name)} with crossover fans?` : "",
      ordered.length > 3 ? `Make it a ${ordered.length - 1}-stop run` : "",
    ].filter((t) => t && t !== recordedQ).map((text) => ({ text })),
  ];
  const placeholder = offRoute ? `Why not ${clean(offRoute.name)}?` : weakest ? `Find something stronger than ${clean(weakest.city.name)}` : "Ask about another city";

  // Highlight the ticket in view so the map and the switcher follow the scroll.
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>("[data-stop]");
    if (!els.length) return;
    const io = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) setActiveId((visible.target as HTMLElement).dataset.stop);
    }, { rootMargin: "-45% 0px -45% 0px", threshold: [0, 0.25, 0.5] });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ordered.length]);

  // Desktop plan view is exactly one screen with its own scrolling panes; clip the document so a
  // scrollIntoView (a pin click, a Q-id link) can never shift the whole page under the header.
  useEffect(() => {
    document.documentElement.classList.add("plan-view");
    return () => document.documentElement.classList.remove("plan-view");
  }, []);

  // Printing (button or Ctrl+P) shows every pitch email: collapsed <details> do not print their content.
  useEffect(() => {
    const open = () => document.querySelectorAll("details").forEach((d) => { d.open = true; });
    window.addEventListener("beforeprint", open);
    return () => window.removeEventListener("beforeprint", open);
  }, []);

  const goTo = (id: string) => {
    setActiveId(id);
    setFocusId(id);
    document.getElementById(`stop-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const origin = state.origin;

  const located = ordered.filter((s) => s.city.lat !== undefined && s.city.lng !== undefined);
  const routeKm = located.slice(1).reduce((sum, s, i) => sum + distanceKm({ lat: located[i].city.lat!, lng: located[i].city.lng! }, { lat: s.city.lat!, lng: s.city.lng! }), 0);
  const dock = { followUps: state.followUps, scout: state.scout, onAsk, onApply, suggestions, placeholder, replayed: state.replayedAnswers ?? [] };
  const stopNames = ordered.map((s) => clean(s.city.name));

  return (
    <ReceiptsContext.Provider value={{ on: receipts, toggle: () => setReceipts((r) => !r) }}>
    {/* Desktop: exactly one screen tall; the map and the plan pane scroll on their own, never the window. */}
    <div className="lg:grid lg:h-[calc(var(--app-h,100dvh)-3.5rem)] lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:overflow-clip print:h-auto print:overflow-visible">
      <div className={`print-map sticky top-14 z-10 border-b border-line transition-[height] duration-300 lg:static lg:h-[calc(var(--app-h,100dvh)-3.5rem)] lg:border-b-0 lg:border-r ${expanded ? "h-[60vh]" : compact ? "h-[30vh]" : "h-[46vh]"}`}>
        <TourMap cities={mapCities} stops={mapStops} cells={state.coverage?.cells} ghosts={ghosts} proposal={proposal} activeId={activeId} focusId={focusId} onSelect={goTo}
          routeFinal={Boolean(state.plan)} />
        <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
          className="no-print absolute right-2 top-2 z-[5] min-h-11 rounded-full border border-line bg-bg/90 px-3 text-sm lg:hidden">
          {expanded ? "Shrink map" : "Expand map"}
        </button>
      </div>

      {/* Desktop: the plan scrolls in its own pane and the scout dock sits below it, so nothing is ever underneath the dock. */}
      <div className="min-w-0 lg:flex lg:h-[calc(var(--app-h,100dvh)-3.5rem)] lg:flex-col print:h-auto">
      <div id="plan-scroll" className="min-w-0 space-y-10 px-4 pt-6 sm:px-6 lg:min-h-0 lg:flex-1 lg:overflow-y-auto print:overflow-visible">
        <header className="space-y-3 [container-type:inline-size]">
          <p className="text-sm text-muted">{heading.sub}</p>
          <h1 className="font-display uppercase leading-[0.9]" style={fitDisplay(heading.name, "4.5rem")}>{clean(heading.name)}</h1>
          {heading.proxyOf?.length ? <p className="text-sm text-muted">Emerging act, planned from the fans of {heading.proxyOf.map(clean).join(" and ")}.</p> : null}
          {heading.arenaScale && <p className="rounded-lg border border-line bg-surface px-3 py-2 text-sm"><b>Stress test: what if the act is huge?</b> <span className="text-muted">The plan shows where the fans cluster. Qloo&apos;s room data is club and theatre scale, so no rooms or pitches are suggested.</span></p>}
          <SourceLine state={state} />
          <div className="flex flex-wrap items-center gap-2">
            <ReceiptsToggle />
            {state.plan && <ExportMenu state={state} />}
            {origin?.kind === "preset" && onRerunLive && !running && (
              <button type="button" onClick={onRerunLive} className="no-print min-h-11 px-2 text-sm text-muted underline underline-offset-4 hover:text-ink">Re-run this live</button>
            )}
          </div>
          <ProvenanceLegend />
          {baseOrigin(origin)?.kind === "preset" && (
            <p className="text-xs text-muted">Demo using a public {heading.proxyOf?.length ? "artist comparison" : "name"} and aggregate Qloo data. Not affiliated with or endorsed by {heading.proxyOf?.length ? heading.proxyOf.map(clean).join(" or ") : clean(heading.name)}; pitch emails are sample drafts.</p>
          )}
        </header>
        {state.error && (
          <div role="alert" className="rounded-xl border border-danger/50 bg-surface px-4 py-3 text-sm">
            <b className="text-danger">{ERROR_TITLES[state.error.code ?? ""] ?? "Something went wrong"}</b>
            <p className="mt-1 text-muted">{state.error.message}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {state.error.retryable !== false && !["RATE_LIMITED", "DAILY_CAP"].includes(state.error.code ?? "") && (
                <button type="button" onClick={onRetry} className="min-h-11 rounded-lg border border-line px-4 font-mono text-xs uppercase">Try again</button>
              )}
              {["RATE_LIMITED", "DAILY_CAP", "QLOO_RATE_LIMIT"].includes(state.error.code ?? "") && (
                <button type="button" onClick={onHome} className="min-h-11 rounded-lg bg-accent px-4 font-mono text-xs uppercase text-accent-ink">Open a demo tour</button>
              )}
            </div>
          </div>
        )}
        {state.fallback && <p className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">AI writing was unavailable ({state.fallback}). The Qloo data is complete; the text below is templated.</p>}

        {(running || state.steps.length > 0) && state.status !== "done" && <Activity steps={state.steps} running={running} replay={origin?.kind === "preset"} />}

        <Section title="The route">
          <div className="mb-5"><CoverageNote coverage={state.coverage} region={state.coverage?.region} cities={state.cities} stopNames={stopNames} /></div>
          {state.plan && located.length > 1 && (
            <p className="mb-3 text-sm text-muted">{located.length} stops · ≈ {Math.round(routeKm / 10) * 10 >= 1000 ? (Math.round(routeKm / 100) * 100).toLocaleString("en") : Math.round(routeKm / 10) * 10} km between stops in this order (straight line). Fan hotspots drive the cities; check drive times before booking.</p>
          )}
          {state.summary ? <InsightText item={state.summary} className="mb-5" /> : writing ? <div className="mb-5"><Writing label="Writing the summary…" /></div> : null}
          <div className="space-y-4">
            {ordered.map((s) => <StopTicket key={s.stopId} stop={s} active={s.stopId === activeId} writing={running} emerging={Boolean(heading.proxyOf?.length)}
              arena={Boolean(heading.arenaScale)} rank={rankOf(s.city.name)} of={ranked.length || undefined} />)}
            {running && ordered.length === 0 && <p className="text-sm text-muted">Stops appear here as Qloo scores each city.</p>}
          </div>
        </Section>

        <FanLineup fan={state.fan} proxyOf={heading.proxyOf} />
        {(state.plan || writing) && <ShowIdeas theme={state.plan?.theme ?? []} merch={state.plan?.merch ?? []} risks={state.plan?.risks ?? []} writing={!state.plan} />}
        {state.plan && <WithheldNote withheld={state.plan.withheld} />}
        {state.sources.length > 0 && <CreditsRoll sources={state.sources} />}
        <div className="h-24 lg:h-8" aria-hidden />
      </div>
        {state.plan && <div className="hidden px-6 lg:block lg:shrink-0"><ScoutDock variant="dock" {...dock} /></div>}
      </div>
      {sheet && state.plan && <ScoutDock variant="sheet" onClose={() => setSheet(false)} {...dock} />}

      {ordered.length > 0 && (
        <nav aria-label="Stops" className="no-print fixed inset-x-0 bottom-0 z-[1001] border-t border-line bg-bg/95 px-3 py-2 backdrop-blur lg:hidden">
          <div className="no-scrollbar flex gap-2 overflow-x-auto">
            {ordered.map((s) => (
              <button key={s.stopId} type="button" onClick={() => goTo(s.stopId)} aria-current={s.stopId === activeId}
                className={`min-h-11 shrink-0 rounded-full border px-4 text-sm ${s.stopId === activeId ? "border-accent bg-accent text-accent-ink" : "border-line"}`}>
                {s.order ?? s.rank} · {clean(s.city.name)}
              </button>
            ))}
            {state.plan && <button type="button" onClick={() => setSheet(true)} className="grid min-h-11 shrink-0 place-items-center rounded-full bg-neon px-4 text-sm font-semibold text-white">Ask the scout</button>}
            <a href="#fans" className="grid min-h-11 shrink-0 place-items-center rounded-full border border-line px-4 text-sm">Fans</a>
          </div>
        </nav>
      )}
    </div>
    </ReceiptsContext.Provider>
  );
}
