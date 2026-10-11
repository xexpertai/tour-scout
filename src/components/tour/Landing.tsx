"use client";

import dynamic from "next/dynamic";
import { useEffect, useState, type FormEvent } from "react";
import type { MapCity, MapStop } from "./TourMap";
import { LEAD_PRESET, PRESETS, type CapturedRun, type Preset } from "@/lib/tour/presets";
import { possessive } from "@/lib/text";
import type { ArtistKind, TourPlan } from "@/lib/tour/types";
import { fitDisplay } from "./atoms";

export function SearchBox({ onSubmit, compact = false, busy = false }: { onSubmit: (name: string, kind: ArtistKind) => void; compact?: boolean; busy?: boolean }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ArtistKind>("artist");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit(name.trim(), kind);
  };
  return (
    <form onSubmit={submit} className={`w-full ${compact ? "" : "max-w-2xl"}`} role="search">
      <div role="radiogroup" aria-label="Who is touring?" className="mb-2 inline-flex rounded-full border border-line bg-surface p-1">
        {(["artist", "person"] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
            className={`min-h-10 rounded-full px-4 text-sm ${kind === k ? "bg-ink text-bg" : "text-muted hover:text-ink"}`}>
            {k === "artist" ? "Musician" : "Comedian"}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <label className="sr-only" htmlFor="artist-search">Artist or comedian name</label>
        <input id="artist-search" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off"
          placeholder="Try any artist or comedian…"
          className="min-h-12 w-full min-w-0 rounded-xl border border-line bg-surface px-4 text-base text-ink outline-none placeholder:text-muted focus:border-accent" />
        <button disabled={busy || !name.trim()}
          className="min-h-12 shrink-0 rounded-xl border-2 border-accent bg-accent px-5 font-display text-lg uppercase tracking-wide text-accent-ink transition-colors disabled:border-line disabled:bg-transparent disabled:text-muted">
          {busy ? "…" : "Scout"}
        </button>
      </div>
    </form>
  );
}

/** Poster looks: each demo is set like a different gig poster, not a template card. */
const POSTER = [
  { card: "bg-[#ff6b1a] text-[#0b0b0f] -rotate-[1.5deg]", accent: "text-[#0b0b0f]/90" },
  { card: "bg-[#ff2e88] text-[#0b0b0f] rotate-[1deg]", accent: "text-[#0b0b0f]/90" },
  { card: "bg-[#f4f1ea] text-[#0b0b0f] -rotate-[0.6deg] tape", accent: "text-[#0b0b0f]/60" },
  { card: "bg-[#14141b] text-[#f4f1ea] rotate-[1.2deg] ring-1 ring-inset ring-[#3a3a48]", accent: "text-[#a7a2b0]" },
];

function Flyer({ preset, index, onPlay }: { preset: Preset; index: number; onPlay: (slug: string) => void }) {
  const look = POSTER[index % POSTER.length];
  return (
    <button type="button" onClick={() => onPlay(preset.slug)} aria-label={`Open the ${preset.flyer.headline} demo: ${preset.flyer.sub}`}
      className={`poster group relative flex h-72 w-52 shrink-0 snap-start flex-col overflow-hidden rounded-md p-4 text-left shadow-[0_18px_40px_-18px_rgba(0,0,0,.8)] transition-transform hover:rotate-0 hover:-translate-y-1 focus-visible:rotate-0 sm:w-56 ${look.card}`}>
      {preset.stressTest && <span className="stamp absolute right-3 top-3 rotate-[8deg] rounded border-2 border-current px-1.5 font-display text-sm uppercase">Stress test</span>}
      <span className={`text-xs font-semibold ${look.accent}`}>Captured from live Qloo data</span>
      <span className="mt-3 font-display uppercase leading-[0.9] [container-type:inline-size]"><span className="block" style={fitDisplay(preset.flyer.headline, "3rem")}>{preset.flyer.headline}</span></span>
      {preset.bill?.length ? (
        <span className="mt-auto block font-display text-[15px] uppercase leading-tight">{preset.bill.map((c, i) => <span key={c}>{c}{i < preset.bill!.length - 1 && <span className={look.accent}> · </span>}</span>)}</span>
      ) : <span className="mt-auto" />}
      <span className={`mt-2 block border-t border-current/30 pt-2 text-xs font-medium ${look.accent}`}>{preset.flyer.sub}</span>
    </button>
  );
}

const TourMap = dynamic(() => import("./TourMap"), { ssr: false, loading: () => <div className="map-box h-full w-full" /> });

/**
 * The landing's moving picture: the lead demo's real capture on the real map, looping. Fan heat
 * blooms, the scored cities appear, the route draws, it rests, then starts again. Not interactive:
 * a tap opens the demo. Reduced motion shows the finished route.
 */
function RoutePreview({ onOpen }: { onOpen: () => void }) {
  const [plan, setPlan] = useState<TourPlan>();
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch(`/presets/${LEAD_PRESET}.json`).then((r) => r.json()).then((run: CapturedRun) => {
      const e = run.events.find((x) => (x.event as { type: string }).type === "plan")?.event as { plan: TourPlan } | undefined;
      if (alive && e) setPlan(e.plan);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const [reduce] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (!plan || reduce) return;
    // 0 heat → 1 cities scored → 2 route, hold, repeat. The map holds each phase for a minimum time
    // itself (TourMap HOLD), so each step here is a little longer than that hold and the cities stay
    // in until the route is drawn; otherwise the scoring step is skipped and the route shows briefly.
    const steps = [1800, 2000, 6500];
    const t = setTimeout(() => setPhase((p) => (p + 1) % 3), steps[phase]);
    return () => clearTimeout(t);
  }, [plan, phase, reduce]);
  if (reduce && phase !== 2) setPhase(2);
  const stops = plan ? [...plan.stops].sort((a, b) => a.order - b.order) : [];
  const cities: MapCity[] = phase >= 1 && plan ? (plan.candidates ?? plan.stops.map((x) => x.city)).filter((c) => c.lat !== undefined && c.lng !== undefined)
    .map((c) => ({ id: c.entityId, name: c.name, lat: c.lat!, lng: c.lng!, affinity: c.affinity })) : [];
  const mapStops: MapStop[] = phase === 2 ? stops.filter((x) => x.city.lat !== undefined).map((x) => ({ id: x.stopId, order: x.order, name: x.city.name, lat: x.city.lat!, lng: x.city.lng! })) : [];
  return (
    <figure className="relative">
      <button type="button" onClick={onOpen} aria-label={plan ? `Open the ${plan.artist.name} demo: ${stops.map((x) => x.city.name).join(", ")}` : "Open the lead demo"}
        className="map-box relative block h-[300px] w-full overflow-hidden rounded-2xl border border-line text-left sm:h-[380px]">
        {/* The preview is a picture inside one button: inert, so its pins are neither focusable nor read out as controls. */}
        {plan && <div inert className="pointer-events-none absolute inset-0"><TourMap cities={cities} stops={mapStops} cells={plan.coverage?.cells} routeFinal={phase === 2} /></div>}
        <span className="absolute bottom-3 left-3 rounded-full bg-bg/85 px-3 py-1.5 text-xs font-semibold text-ink">▶ Open this demo</span>
      </button>
      <figcaption className="mt-2 text-sm text-muted">{plan ? `${possessive(plan.artist.name)} demo (a fictional act, fans of ${plan.artist.proxyOf?.join(", ") ?? plan.artist.name}), from live Qloo data: fan hotspots, then the ${stops.length}-stop route.` : "Loading the demo…"}</figcaption>
    </figure>
  );
}

export function Landing({ onSearch, onPreset, busy }: { onSearch: (name: string, kind: ArtistKind) => void; onPreset: (slug: string) => void; busy: boolean }) {
  return (
    <div className="relative">
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-8 pt-10 sm:px-6 sm:pt-14 lg:grid-cols-[1.15fr_0.85fr]">
        <div>
          <p className="text-sm text-muted">Tour planning for indie musicians and comedians</p>
          <h1 className="mt-3 font-display text-[2.9rem] uppercase leading-[0.92] sm:text-7xl lg:text-[5.4rem]">
            Find your fans before you <span className="text-neon">book the room.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base font-semibold text-ink sm:text-lg">
            Plan a tour before you have listeners there.
          </p>
          <p className="mt-2 max-w-xl text-base text-muted sm:text-lg">
            Tour Scout reads Qloo&apos;s taste graph to find where people who would like an act are, even from the artists it sounds like, then picks the cities, rooms and openers, and drafts the pitch. Then the <b className="text-ink">route-check agent</b> tests the plan with Qloo tools and proposes at most one change you can apply with a tap.
          </p>
          <div className="mt-7"><SearchBox onSubmit={onSearch} busy={busy} /></div>
          {/* Phones: the demos sit below the fold, so offer the lead one right here. */}
          <button type="button" onClick={() => onPreset(LEAD_PRESET)}
            className="mt-4 min-h-12 w-full rounded-xl border-2 border-neon px-5 font-display text-lg uppercase tracking-wide text-ink sm:hidden">
            ▶ See a demo tour <span className="font-sans text-sm normal-case text-muted">· no sign-up</span>
          </button>
        </div>
        <RoutePreview onOpen={() => onPreset(LEAD_PRESET)} />
      </section>

      <section aria-labelledby="demos" className="pb-14">
        <div className="mx-auto flex max-w-6xl items-baseline justify-between px-4 sm:px-6">
          <h2 id="demos" className="font-display text-2xl uppercase">Tonight&apos;s demos</h2>
          <span className="text-sm text-muted">Open instantly, no sign-up</span>
        </div>
        <div className="no-scrollbar mx-auto mt-4 flex max-w-6xl snap-x gap-5 overflow-x-auto px-6 pb-6 pt-2 sm:px-8">
          {PRESETS.map((p, i) => <Flyer key={p.slug} preset={p} index={i} onPlay={onPreset} />)}
        </div>
        <p className="mx-auto mt-2 max-w-6xl px-4 text-sm text-muted sm:px-6">
          <b className="text-ink">Why Qloo:</b> its taste graph links artists, comedians, places, brands and films by real-world audience affinity, so a fan base can be located instead of guessed. Audiences are described in aggregate, never as individual fans.
        </p>
      </section>
    </div>
  );
}
