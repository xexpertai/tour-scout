"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { InsightText, Section, Writing, clean, fitDisplay, shortDate } from "./atoms";
import { downloadCsv } from "./exportCsv";
import { ScoutPanel } from "./FollowUps";
import { Activity, CreditsRoll, FanLineup, ShowIdeas, WithheldNote } from "./PlanSections";
import { StopTicket } from "./Ticket";
import type { RunState } from "./useTourRun";
import type { MapCity, MapGhost, MapStop } from "./TourMap";

const TourMap = dynamic(() => import("./TourMap"), { ssr: false, loading: () => <div className="skeleton h-full w-full rounded-none" /> });

const ERROR_TITLES: Record<string, string> = {
  QLOO_RATE_LIMIT: "Qloo is rate-limiting us",
  RATE_LIMITED: "Easy, tour manager",
  DAILY_CAP: "Today's live budget is used up",
  QLOO_AUTH: "Qloo rejected the server's credential",
  QLOO_NOT_INSTALLED: "The Qloo connection isn't set up on this server",
  QLOO_TIMEOUT: "Qloo took too long to answer",
  TOUR_NO_CITIES: "Qloo found no cities for this artist and region",
};

export type Heading = { name: string; sub: string; proxyOf?: string[]; arenaScale?: boolean };

function Badge({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "sample" | "live" }) {
  const cls = { plain: "border-line text-muted", sample: "border-sample text-sample", live: "border-qloo text-qloo" }[tone];
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider ${cls}`}>{children}</span>;
}

const llmLabel = (llm?: string) =>
  !llm ? undefined : llm.startsWith("scripted") ? (llm.includes("fallback") ? "Text: templated (AI unavailable)" : "Text: templated, no AI") : `Text: ${llm === "claude" ? "Claude" : llm === "gemini" ? "Gemini" : llm}`;

function Toolbar({ state }: { state: RunState }) {
  const [shared, setShared] = useState<string>();
  const plan = state.plan!;
  const link = () => {
    if (state.origin?.kind === "preset") return `${window.location.origin}/?demo=${state.origin.slug}`;
    return `${window.location.origin}/t/${plan.id}`;
  };
  const share = async () => {
    const url = link();
    const title = `${clean(plan.artist.name)} · Tour Scout`;
    try {
      if (navigator.share) await navigator.share({ title, url });
      else { await navigator.clipboard.writeText(url); setShared("Link copied"); setTimeout(() => setShared(undefined), 2000); }
    } catch { /* the visitor cancelled the share sheet */ }
  };
  const btn = "min-h-11 rounded-full border border-line px-4 font-mono text-xs uppercase tracking-wider hover:border-accent";
  return (
    <div className="no-print flex flex-wrap gap-2">
      <button type="button" onClick={share} className={btn}>{shared ?? "Share"}</button>
      <button type="button" onClick={() => downloadCsv(plan)} className={btn}>CSV</button>
      <button type="button" onClick={() => window.print()} className={btn}>Print / PDF</button>
    </div>
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
  const onRoute = (name: string) => ordered.some((s) => clean(s.city.name).toLowerCase() === clean(name).toLowerCase());
  const offRoute = [...state.cities].sort((a, b) => b.affinity - a.affinity).find((c) => !onRoute(c.name));
  const weakest = [...ordered].sort((a, b) => a.city.affinity - b.city.affinity)[0];
  const suggestions = [
    "Swap the weakest stop for a stronger city",
    ordered[0] ? `Who's a good opener in ${clean(ordered[0].city.name)} with crossover fans?` : "",
    ordered.length > 3 ? `Make it a ${ordered.length - 1}-stop run` : "",
  ].filter(Boolean);
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
  const sample = state.qloo === "mock";
  const origin = state.origin;

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className={`print-map sticky top-14 z-10 border-b border-line transition-[height] duration-300 lg:h-[calc(100dvh-3.5rem)] lg:border-b-0 lg:border-r ${expanded ? "h-[60vh]" : compact ? "h-[28vh]" : "h-[45vh]"}`}>
        <TourMap cities={mapCities} stops={mapStops} ghosts={ghosts} activeId={activeId} focusId={focusId} onSelect={goTo} />
        <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
          className="no-print absolute bottom-6 left-2 z-[1000] min-h-10 rounded-full border border-line bg-bg/90 px-3 font-mono text-[11px] uppercase tracking-wider lg:hidden">
          {expanded ? "Shrink map" : "Expand map"}
        </button>
      </div>

      <div className="min-w-0 space-y-10 px-4 pb-28 pt-6 sm:px-6 lg:pb-16">
        <header className="[container-type:inline-size]">
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-accent">{heading.sub}</p>
          <h1 className="mt-1 font-display uppercase leading-[0.9]" style={fitDisplay(heading.name, "4.5rem")}>{clean(heading.name)}</h1>
          {heading.proxyOf?.length ? <p className="mt-2 text-sm text-muted">Emerging act — planned from the fans of {heading.proxyOf.map(clean).join(", ")}.</p> : null}
          {heading.arenaScale && <p className="mt-2 text-sm text-muted">Arena-scale act: the plan still works, but venue suggestions may skew large.</p>}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {origin?.kind === "preset" && <Badge>Cached run · {shortDate(origin.capturedAt)}</Badge>}
            {origin?.kind === "shared" && <Badge>Shared plan · {shortDate(origin.createdAt)}</Badge>}
            {origin?.kind === "reused" && <Badge>Same tour planned earlier · {shortDate(origin.createdAt)}</Badge>}
            {state.qloo && <Badge tone={sample ? "sample" : "live"}>{sample ? "Sample data — no Qloo key" : "Live Qloo data"}</Badge>}
            {llmLabel(state.llm) && <Badge>{llmLabel(state.llm)}</Badge>}
          </div>
          {state.plan && <div className="mt-4"><Toolbar state={state} /></div>}
          {origin?.kind === "preset" && onRerunLive && !running && (
            <button type="button" onClick={onRerunLive} className="no-print mt-2 min-h-11 font-mono text-xs uppercase tracking-wider text-muted underline underline-offset-4 hover:text-ink">Re-run this live</button>
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

        {(running || state.steps.length > 0) && state.status !== "done" && <Activity steps={state.steps} running={running} />}

        <Section title="The route">
          {state.summary ? <InsightText item={state.summary} className="mb-5" /> : writing ? <div className="mb-5"><Writing label="Writing the summary…" /></div> : null}
          <div className="space-y-5">
            {ordered.map((s) => <StopTicket key={s.stopId} stop={s} active={s.stopId === activeId} writing={running} />)}
            {running && ordered.length === 0 && [0, 1].map((i) => <div key={i} className="skeleton h-64 rounded-2xl" />)}
          </div>
        </Section>

        {state.plan && (
          <div className="no-print">
            <ScoutPanel followUps={state.followUps} scout={state.scout} onAsk={onAsk} onApply={onApply} suggestions={suggestions} placeholder={placeholder} />
          </div>
        )}
        <FanLineup fan={state.fan} proxyOf={heading.proxyOf} />
        {(state.plan || writing) && <ShowIdeas theme={state.plan?.theme ?? []} merch={state.plan?.merch ?? []} risks={state.plan?.risks ?? []} writing={!state.plan} />}
        {state.plan && <WithheldNote withheld={state.plan.withheld} />}
        {state.sources.length > 0 && <CreditsRoll sources={state.sources} />}
      </div>

      {ordered.length > 0 && (
        <nav aria-label="Stops" className="no-print fixed inset-x-0 bottom-0 z-[1001] border-t border-line bg-bg/95 px-3 py-2 backdrop-blur lg:hidden">
          <div className="no-scrollbar flex gap-2 overflow-x-auto">
            {ordered.map((s) => (
              <button key={s.stopId} type="button" onClick={() => goTo(s.stopId)} aria-current={s.stopId === activeId}
                className={`min-h-11 shrink-0 rounded-full border px-4 font-mono text-xs ${s.stopId === activeId ? "border-accent bg-accent text-accent-ink" : "border-line"}`}>
                {s.order ?? s.rank} · {clean(s.city.name)}
              </button>
            ))}
            <a href="#fans" className="grid min-h-11 shrink-0 place-items-center rounded-full border border-line px-4 font-mono text-xs">Fans</a>
            <a href="#credits" className="grid min-h-11 shrink-0 place-items-center rounded-full border border-line px-4 font-mono text-xs">Credits</a>
          </div>
        </nav>
      )}
    </div>
  );
}
