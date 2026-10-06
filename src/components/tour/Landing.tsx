"use client";

import { useState, type FormEvent } from "react";
import { PRESETS, type Preset } from "@/lib/tour/presets";
import type { ArtistKind } from "@/lib/tour/types";
import { fitDisplay } from "./atoms";

const FLYER_STYLES = [
  "bg-[#ff6b1a] text-[#0b0b0f]",
  "bg-[#ff2e88] text-[#0b0b0f]",
  "bg-[#f4f1ea] text-[#0b0b0f]",
  "bg-[#1f1f29] text-[#f4f1ea] ring-1 ring-inset ring-[#ff6b1a]",
];

export function SearchBox({ onSubmit, compact = false, busy = false }: { onSubmit: (name: string, kind: ArtistKind) => void; compact?: boolean; busy?: boolean }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ArtistKind>("artist");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit(name.trim(), kind);
  };
  return (
    <form onSubmit={submit} className={`w-full ${compact ? "" : "max-w-2xl"}`} role="search">
      <div role="radiogroup" aria-label="Who is touring?" className="mb-2 inline-flex rounded-full border border-line bg-surface p-1 font-mono text-xs">
        {(["artist", "person"] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
            className={`min-h-9 rounded-full px-4 uppercase tracking-wider ${kind === k ? "bg-ink text-bg" : "text-muted hover:text-ink"}`}>
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

function Flyer({ preset, index, onPlay }: { preset: Preset; index: number; onPlay: (slug: string) => void }) {
  return (
    <button type="button" onClick={() => onPlay(preset.slug)}
      className={`group relative flex h-56 w-44 shrink-0 snap-start flex-col justify-between overflow-hidden rounded-lg p-4 text-left transition-transform hover:-translate-y-1 focus-visible:-translate-y-1 sm:w-52 ${FLYER_STYLES[index % FLYER_STYLES.length]}`}>
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] opacity-80">Demo tour · live Qloo data</span>
      <span className="font-display uppercase leading-[0.95] [container-type:inline-size]"><span className="block" style={fitDisplay(preset.flyer.headline, "2.25rem")}>{preset.flyer.headline}</span></span>
      <span className="space-y-1">
        <span className="block text-xs font-medium opacity-90">{preset.flyer.sub}</span>
        <span className="block font-mono text-[10px] font-bold uppercase tracking-widest">▶ Tap to see the tour</span>
      </span>
    </button>
  );
}

export function Landing({ onSearch, onPreset, busy }: { onSearch: (name: string, kind: ArtistKind) => void; onPreset: (slug: string) => void; busy: boolean }) {
  return (
    <div className="relative">
      <section className="mx-auto max-w-6xl px-4 pb-8 pt-10 sm:px-6 sm:pt-16">
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-accent">Tour planning for indie musicians & comedians</p>
        <h1 className="mt-3 max-w-4xl font-display text-[2.9rem] uppercase leading-[0.92] sm:text-7xl lg:text-8xl">
          Find your fans before you book the room.
        </h1>
        <p className="mt-5 max-w-2xl text-base text-muted sm:text-lg">
          Tour Scout reads Qloo&apos;s taste graph to show where an artist&apos;s audience actually is — then plans the stops, venues, openers and the pitch.
        </p>
        <div className="mt-7"><SearchBox onSubmit={onSearch} busy={busy} /></div>
      </section>

      <section aria-labelledby="demos" className="pb-12">
        <div className="mx-auto flex max-w-6xl items-baseline justify-between px-4 sm:px-6">
          <h2 id="demos" className="font-display text-xl uppercase tracking-wide">Tonight&apos;s demos</h2>
          <span className="font-mono text-[11px] text-muted">Opens instantly · no sign-up</span>
        </div>
        <div className="no-scrollbar mx-auto mt-3 flex max-w-6xl snap-x gap-3 overflow-x-auto px-4 pb-2 sm:px-6">
          {PRESETS.map((p, i) => <Flyer key={p.slug} preset={p} index={i} onPlay={onPreset} />)}
        </div>
      </section>

      <section aria-labelledby="how" className="border-t border-line">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <h2 id="how" className="font-display text-xl uppercase tracking-wide">How it works</h2>
          <ol className="mt-4 grid gap-4 sm:grid-cols-3">
            {[
              ["1", "Pick an artist", "Type any musician or comedian and confirm the match — or describe an emerging act by who it sounds like."],
              ["2", "Qloo maps the fans", "Qloo's fan map finds the hotspots across a country; each nearby city is scored by how strongly the audience favours its live rooms, then Qloo locates the neighbourhood and an opener that fit."],
              ["3", "Get the tour + pitch", "A routed set of stops, a fan profile and a booker email per stop — every claim linked to the Qloo request behind it."],
            ].map(([n, t, d]) => (
              <li key={n} className="flex gap-3 rounded-xl border border-line bg-surface p-4">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent font-mono text-sm font-bold text-accent-ink">{n}</span>
                <span>
                  <span className="block font-display text-xl uppercase">{t}</span>
                  <span className="mt-1 block text-sm text-muted">{d}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-5 max-w-3xl text-sm text-muted">
            <b className="text-ink">Why Qloo:</b> its taste graph covers 250M+ entities across music, film, dining, fashion and more (per Qloo),
            linked by real-world audience affinity, so a fan base can be located instead of guessed. Results describe audiences in aggregate, never individual fans.
          </p>
        </div>
      </section>
    </div>
  );
}
