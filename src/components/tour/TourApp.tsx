"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Landing } from "@/components/tour/Landing";
import { ResolvePanel } from "@/components/tour/ResolvePanel";
import { ScoutView, type Heading } from "@/components/tour/ScoutView";
import { ThemeToggle } from "@/components/tour/atoms";
import { useTourRun } from "@/components/tour/useTourRun";
import { PRESETS } from "@/lib/tour/presets";
import type { ArtistKind, TourInput, TourPlan } from "@/lib/tour/types";

type View =
  | { name: "landing" }
  | { name: "resolve"; query: { name: string; kind: ArtistKind } }
  | { name: "run"; heading: Heading; input?: TourInput; preset?: string };

const headingFor = (input: TourInput): Heading => ({
  name: input.artist?.name ?? input.emerging?.name ?? "Your tour",
  sub: `${input.stops} stops · ${input.candidateCities?.length ? "your cities" : input.region ?? ""}`,
  proxyOf: input.emerging?.proxies.map((p) => p.name),
  arenaScale: (input.artist?.popularity ?? 0) >= 0.97,
});

const presetView = (slug?: string): View | undefined => {
  const p = PRESETS.find((x) => x.slug === slug);
  return p && { name: "run", preset: p.slug, heading: { name: p.artist, sub: `${p.stops} stops · ${p.region}`, proxyOf: p.soundsLike } };
};

/** The whole app: landing → confirm artist → live scouting or a replayed demo. */
export function TourApp({ initialDemo, sharedPlan }: { initialDemo?: string; sharedPlan?: TourPlan }) {
  const { state, start, replay, reset, ask, applyChange } = useTourRun(sharedPlan);
  const router = useRouter();
  const [view, setView] = useState<View>(() =>
    sharedPlan
      ? { name: "run", heading: { name: sharedPlan.artist.name, sub: `${sharedPlan.stops.length} stops · ${sharedPlan.inputs.candidateCities?.length ? "your cities" : sharedPlan.inputs.region ?? ""}`, proxyOf: sharedPlan.artist.proxyOf, arenaScale: sharedPlan.artist.arenaScale } }
      : presetView(initialDemo) ?? { name: "landing" });

  const setUrl = (demo?: string) => {
    const url = new URL(window.location.href);
    if (demo) url.searchParams.set("demo", demo);
    else url.searchParams.delete("demo");
    window.history.replaceState(null, "", url);
  };

  const playPreset = (slug: string) => {
    const next = presetView(slug);
    if (!next) return;
    setView(next);
    setUrl(slug);
    window.scrollTo({ top: 0 });
    replay(slug);
  };

  // A shared link like /?demo=us-comedian opens straight into that demo (the view is set from the prop).
  useEffect(() => {
    if (presetView(initialDemo)) replay(initialDemo!);
  }, [initialDemo, replay]);

  const startLive = (input: TourInput) => {
    setView({ name: "run", heading: headingFor(input), input });
    setUrl();
    window.scrollTo({ top: 0 });
    start(input);
  };
  const home = () => {
    // A shared plan lives at /t/<id>; going home leaves that page.
    if (sharedPlan) { router.push("/"); return; }
    reset(); setUrl(); setView({ name: "landing" });
  };

  // The plan's own artist record (popularity, proxies) is authoritative once it arrives.
  const heading = view.name === "run" && state.plan
    ? { ...view.heading, name: state.plan.artist.name, arenaScale: state.plan.artist.arenaScale, proxyOf: state.plan.artist.proxyOf }
    : view.name === "run" ? view.heading : undefined;

  return (
    <div className="grain min-h-dvh">
      <header className="no-print sticky top-0 z-[1002] h-14 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-full max-w-[1600px] items-center justify-between gap-3 px-4 sm:px-6">
          <button type="button" onClick={home} className="font-display text-2xl uppercase tracking-wide">Tour<span className="text-accent">·</span>Scout</button>
          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-[11px] text-muted sm:inline">Powered by Qloo&apos;s taste graph</span>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="relative">
        {view.name === "landing" && <Landing onSearch={(name, kind) => setView({ name: "resolve", query: { name, kind } })} onPreset={playPreset} busy={false} />}
        {view.name === "resolve" && <ResolvePanel key={`${view.query.kind}:${view.query.name}`} query={view.query} onStart={startLive} onCancel={home} />}
        {view.name === "run" && heading && (
          <ScoutView
            state={state}
            heading={heading}
            onAsk={ask}
            onApply={applyChange}
            onHome={home}
            onRetry={() => (view.preset ? replay(view.preset) : view.input && start(view.input))}
            onRerunLive={view.preset ? () => {
              const p = PRESETS.find((x) => x.slug === view.preset);
              if (p) setView({ name: "resolve", query: { name: p.soundsLike ? p.soundsLike[0] : p.artist, kind: p.kind } });
            } : undefined}
          />
        )}
      </main>

      {view.name !== "run" && (
        <footer className="border-t border-line px-4 py-6 text-center font-mono text-[11px] text-muted">
          Taste data: Qloo · Aggregate audiences only, never individual fans · Map: © OpenStreetMap contributors
        </footer>
      )}
    </div>
  );
}
