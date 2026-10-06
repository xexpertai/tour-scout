"use client";

import { useEffect, useState, type FormEvent } from "react";
import { PRESETS, type CapturedRun, type Preset } from "@/lib/tour/presets";
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
  { card: "bg-[#ff6b1a] text-[#0b0b0f] -rotate-[1.5deg]", accent: "text-[#0b0b0f]/70" },
  { card: "bg-[#ff2e88] text-[#0b0b0f] rotate-[1deg]", accent: "text-[#0b0b0f]/70" },
  { card: "bg-[#f4f1ea] text-[#0b0b0f] -rotate-[0.6deg] tape", accent: "text-[#0b0b0f]/60" },
  { card: "bg-[#14141b] text-[#f4f1ea] rotate-[1.2deg] ring-1 ring-inset ring-[#3a3a48]", accent: "text-[#a7a2b0]" },
];

function Flyer({ preset, index, onPlay }: { preset: Preset; index: number; onPlay: (slug: string) => void }) {
  const look = POSTER[index % POSTER.length];
  return (
    <button type="button" onClick={() => onPlay(preset.slug)} aria-label={`Open the ${preset.flyer.headline} demo: ${preset.flyer.sub}`}
      className={`poster group relative flex h-72 w-52 shrink-0 snap-start flex-col overflow-hidden rounded-md p-4 text-left shadow-[0_18px_40px_-18px_rgba(0,0,0,.8)] transition-transform hover:rotate-0 hover:-translate-y-1 focus-visible:rotate-0 sm:w-56 ${look.card}`}>
      {preset.stressTest && <span className="stamp absolute right-3 top-3 rotate-[8deg] rounded border-2 border-current px-1.5 font-display text-sm uppercase">Stress test</span>}
      <span className={`text-xs font-semibold ${look.accent}`}>Live Qloo data</span>
      <span className="mt-3 font-display uppercase leading-[0.9] [container-type:inline-size]"><span className="block" style={fitDisplay(preset.flyer.headline, "3rem")}>{preset.flyer.headline}</span></span>
      {preset.bill?.length ? (
        <span className="mt-auto block font-display text-[15px] uppercase leading-tight">{preset.bill.map((c, i) => <span key={c}>{c}{i < preset.bill!.length - 1 && <span className={look.accent}> · </span>}</span>)}</span>
      ) : <span className="mt-auto" />}
      <span className={`mt-2 block border-t border-current/30 pt-2 text-xs font-medium ${look.accent}`}>{preset.flyer.sub}</span>
    </button>
  );
}

type Pt = { x: number; y: number };
/**
 * The landing's moving picture: the real Big Thief capture, looping. Fan heat blooms, the stops
 * pop in, the route draws, then it rests and starts again. Reduced motion shows the final frame.
 */
function RoutePreview() {
  const [plan, setPlan] = useState<TourPlan>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch("/presets/us-indie-band.json").then((r) => r.json()).then((run: CapturedRun) => {
      const e = run.events.find((x) => (x.event as { type: string }).type === "plan")?.event as { plan: TourPlan } | undefined;
      if (alive && e) setPlan(e.plan);
    }).catch(() => undefined);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = reduce ? undefined : setInterval(() => setTick((n) => n + 1), 9000);
    return () => { alive = false; if (t) clearInterval(t); };
  }, []);
  const W = 560, H = 440, P = 70;
  const stops = plan ? [...plan.stops].sort((a, b) => a.order - b.order).filter((s) => s.city.lat !== undefined) : [];
  if (!stops.length) return <div className="h-[340px] rounded-2xl border border-line bg-[var(--map-bg)] sm:h-[440px]" aria-hidden />;
  const lats = stops.map((s) => s.city.lat!), lngs = stops.map((s) => s.city.lng!);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats) - 1.2, Math.max(...lats) + 1.2, Math.min(...lngs) - 1.6, Math.max(...lngs) + 1.6];
  const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const sx = (W - 2 * P) / ((maxLng - minLng) * k), sy = (H - 2 * P) / (maxLat - minLat), sc = Math.min(sx, sy);
  const proj = (lat: number, lng: number): Pt => ({ x: P + (lng - minLng) * k * sc + ((W - 2 * P) - (maxLng - minLng) * k * sc) / 2, y: P + (maxLat - lat) * sc + ((H - 2 * P) - (maxLat - minLat) * sc) / 2 });
  const cells = (plan?.coverage?.cells ?? []).filter((c) => c.lat > minLat && c.lat < maxLat && c.lng > minLng && c.lng < maxLng);
  const pts = stops.map((s) => proj(s.city.lat!, s.city.lng!));
  // Greedy label placement: right, left, below, above, whichever overlaps no pin and no placed label.
  type Box = { x: number; y: number; w: number; h: number };
  const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const taken: Box[] = pts.map((p) => ({ x: p.x - 15, y: p.y - 15, w: 30, h: 30 }));
  const labels = pts.map((p, i) => {
    const w = (stops[i].city.name.length + 3) * 10.5, h = 20;
    const options = [
      { box: { x: p.x + 20, y: p.y - 10, w, h }, x: p.x + 20, y: p.y + 6, anchor: "start" },
      { box: { x: p.x - 20 - w, y: p.y - 10, w, h }, x: p.x - 20, y: p.y + 6, anchor: "end" },
      { box: { x: p.x - w / 2, y: p.y + 18, w, h }, x: p.x, y: p.y + 34, anchor: "middle" },
      { box: { x: p.x - w / 2, y: p.y - 38, w, h }, x: p.x, y: p.y - 22, anchor: "middle" },
    ];
    const pick = options.find((o) => o.box.x > 4 && o.box.x + o.box.w < W - 4 && !taken.some((t) => hit(t, o.box))) ?? options[0];
    taken.push(pick.box);
    return pick;
  });
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return (
    <figure className="relative">
      <svg key={tick} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Big Thief's captured route: ${stops.map((s) => s.city.name).join(", ")}`}
        className="preview h-auto w-full rounded-2xl border border-line bg-[var(--map-bg)]">
        <defs>
          <radialGradient id="heat"><stop offset="0" stopColor="#ffe3cc" stopOpacity=".95" /><stop offset=".35" stopColor="#ff2e88" stopOpacity=".55" /><stop offset="1" stopColor="#ff6b1a" stopOpacity="0" /></radialGradient>
          <pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.1" fill="currentColor" opacity=".16" /></pattern>
        </defs>
        <rect width={W} height={H} fill="url(#dots)" className="text-ink" />
        {cells.map((c, i) => { const p = proj(c.lat, c.lng); return <circle key={i} className="pv-heat" style={{ animationDelay: `${0.15 * i}s` }} cx={p.x} cy={p.y} r={70} fill="url(#heat)" />; })}
        <path className="pv-route" d={d} fill="none" stroke="var(--neon)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
        {pts.map((p, i) => (
          <g key={i} className="pv-stop" style={{ animationDelay: `${1.6 + i * 0.25}s` }}>
            <circle cx={p.x} cy={p.y} r="13" fill="var(--accent)" stroke="var(--map-bg)" strokeWidth="3" />
            <text x={p.x} y={p.y + 4.5} textAnchor="middle" fontSize="13" fontWeight="700" fill="var(--accent-ink)" fontFamily="var(--font-mono)">{i + 1}</text>
            <text x={labels[i].x} y={labels[i].y} textAnchor={labels[i].anchor as "start" | "end" | "middle"} fontSize="19" fill="var(--ink)" fontFamily="var(--font-display)" style={{ textTransform: "uppercase", paintOrder: "stroke", stroke: "var(--map-bg)", strokeWidth: 5 }}>
              {stops[i].city.name} <tspan fill="var(--accent)">{Math.round(stops[i].city.affinity * 100)}</tspan>
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="mt-2 text-sm text-muted">The Big Thief demo, from live Qloo data: fan hotspots, then the {stops.length}-stop route.</figcaption>
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
          <p className="mt-5 max-w-xl text-base text-muted sm:text-lg">
            Tour Scout reads Qloo&apos;s taste graph to find where an act&apos;s audience actually is, then picks the cities, rooms and openers, and drafts the pitch.
          </p>
          <div className="mt-7"><SearchBox onSubmit={onSearch} busy={busy} /></div>
        </div>
        <RoutePreview />
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
