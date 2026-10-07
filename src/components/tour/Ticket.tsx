"use client";

import { tidyTag, venueTown } from "@/lib/text";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Insight } from "@/lib/guard";
import { AffinityScore, Chip, Cites, InsightText, Writing, clean, fitDisplay, isSample } from "./atoms";
import type { StopView } from "./useTourRun";

const pad = (n: number) => String(n).padStart(2, "0");
const isCoordinate = (name: string) => /^-?\d+(\.\d+)?,\s*-?\d/.test(name);

/** The pitch email as a draft: subject line, body, copy button and the "check every claim" note. */
export function PitchLetter({ pitch, city, to }: { pitch: Insight; city: string; to?: { name: string; town?: string } }) {
  const [copied, setCopied] = useState(false);
  const [subjectLine, ...rest] = pitch.text.split("\n");
  const hasSubject = /^subject:/i.test(subjectLine);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pitch.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard unavailable: the text stays selectable */ }
  };
  return (
    <div className="rounded-xl border border-line bg-bg p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3 text-sm text-muted">
        <span>To: {to ? <><b className="font-semibold text-ink">{clean(to.name)}</b>{/team or agent$/.test(to.name) ? "" : " booking"}{to.town ? `, ${to.town}` : ""}</> : `the booker, ${clean(city)}`}</span>
        <button type="button" onClick={copy} className="no-print min-h-11 rounded-lg border border-line px-4 text-sm hover:border-accent">{copied ? "Copied ✓" : "Copy"}</button>
      </div>
      {hasSubject && <p className="mt-3 text-lg font-semibold">{subjectLine.replace(/^subject:\s*/i, "")}</p>}
      <p className="mt-2 whitespace-pre-line text-[18px] leading-relaxed">{(hasSubject ? rest.join("\n") : pitch.text).trim()}</p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <Chip kind={pitch.kind === "interpretation" ? "ai" : pitch.kind} /> <Cites ids={pitch.evidence} />
        <span>Draft: check every claim before you send it.</span>
      </div>
    </div>
  );
}

/** A modal sheet (bottom sheet on phones) for one stop's pitch email. */
function PitchSheet({ pitch, city, to, onClose }: { pitch: Insight; city: string; to?: { name: string; town?: string }; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Portalled to <body>: the ticket's mask and animation would otherwise trap a fixed overlay inside it.
  return createPortal(
    <div className="no-print fixed inset-0 z-[1100] flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`Pitch email for ${clean(city)}`} onClick={(e) => e.stopPropagation()}
        className="slide-in max-h-[calc(var(--app-h,100dvh)*0.9)] w-full max-w-3xl overflow-y-auto rounded-t-2xl border border-line bg-surface p-4 sm:rounded-2xl sm:p-7">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-2xl uppercase">Pitch · {clean(city)}</h3>
          <button ref={close} type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full text-xl text-muted hover:text-ink">×</button>
        </div>
        <PitchLetter pitch={pitch} city={city} to={to} />
      </div>
    </div>,
    document.getElementById("app-root") ?? document.body,
  );
}

const Flame = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden className="shrink-0 text-neon"><path fill="currentColor" d="M12 2c1 3.5-1.6 5.3-2.6 7.4-.8 1.6-.5 3.4.7 4.2-.3-1.6.5-3 1.9-3.9.2 2 1.9 2.9 2.4 4.5.4 1.3 0 2.8-1 3.7 2.9-.6 4.6-3.1 4.6-5.9 0-4.3-3.6-6.5-6-10zM7.2 12.3C6.4 13.6 6 15 6 16.2 6 19.4 8.7 22 12 22c-2.1-.9-3.3-2.8-3-4.9-1.3-.9-2-2.6-1.8-4.8z" /></svg>
);

/**
 * One stop as a ticket stub: number, city and score up top; a short "why"; rooms and the opener
 * side by side; the pitch in its own sheet. Arena-scale acts get no room or pitch suggestions.
 */
export function StopTicket({ stop, active, writing, emerging = false, arena = false, comedian = false, rank, of }: {
  stop: StopView; active: boolean; writing: boolean; emerging?: boolean; arena?: boolean; comedian?: boolean; rank?: number; of?: number;
}) {
  const n = stop.order ?? stop.rank;
  const [more, setMore] = useState(false);
  const [sheet, setSheet] = useState(false);
  // Sample runs mark Qloo-derived names "(sample)"; city names are reference geography, so check the data too.
  const sample = isSample(stop.city.name) || stop.venues.some((v) => isSample(v.name)) || isSample(stop.opener?.name ?? "");
  const rooms = more ? stop.venues : stop.venues.slice(0, 2);
  // A support slot is granted by the headliner's team; the room's booker is the alternative contact.
  const pitchTo = emerging && stop.opener
    ? { name: `${clean(stop.opener.name)}'s team or agent`, town: stop.venues[0] ? `or ${clean(stop.venues[0].name)} booking` : undefined }
    : stop.venues[0] ? { name: stop.venues[0].name, town: venueTown(stop.venues[0]) } : undefined;
  const shared = stop.opener?.overlap?.shared.slice(0, 3) ?? [];
  return (
    <article id={`stop-${stop.stopId}`} data-stop={stop.stopId} aria-label={`Stop ${n}: ${clean(stop.city.name)}`}
      className={`ticket slide-in scroll-mt-28 overflow-hidden rounded-2xl border bg-surface transition-colors ${active ? "border-neon" : "border-line"}`}>
      <header className="flex h-[104px] items-center justify-between gap-3 px-5">
        <div className="min-w-0 flex-1 [container-type:inline-size]">
          <div className="text-sm text-muted">Stop {pad(n)}{stop.city.hotspot ? <span className="text-neon"> · fan hotspot</span> : null}</div>
          <h3 className="flex items-center gap-2 font-display uppercase leading-none" style={fitDisplay(stop.city.name, "2.75rem")}>
            {clean(stop.city.name)}{stop.city.hotspot && <span title="Qloo's country-wide fan map has a hotspot near this city"><Flame /></span>}
          </h3>
        </div>
        <AffinityScore value={stop.city.affinity} sample={sample} evidence={stop.city.evidence} rank={rank} of={of} />
      </header>
      <div className="tear-line mx-5" />

      <div className="space-y-4 p-5">
        {stop.why ? <InsightText item={stop.why} brief /> : writing && !stop.textDone ? <Writing label="Writing why this stop…" /> : null}
        {stop.cluster && (
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
            {isCoordinate(stop.cluster.name) ? "Fans concentrate in one part of the city" : <>Fans cluster around <b className="text-ink">{clean(stop.cluster.name)}</b></>}
            {!isCoordinate(stop.cluster.name) && <Chip kind="osm" />}<Cites ids={[stop.cluster.evidence]} />
          </p>
        )}

        <div className={`grid gap-4 ${arena ? "" : "sm:grid-cols-2"}`}>
          {arena ? (
            <p className="rounded-lg bg-surface-2 p-3 text-sm text-muted">Arena-scale act: Qloo&apos;s room data is club and theatre scale, so no rooms are suggested. The score shows where the fans cluster.</p>
          ) : (
            <div>
              <h4 className="flex items-center gap-1.5 text-sm font-semibold">Rooms they favour {stop.venues[0] && <Chip kind={sample ? "sample" : "qloo"} />}<Cites ids={stop.venues[0] ? [stop.venues[0].evidence] : []} /></h4>
              {stop.venues.length ? (
                <ul className="mt-1.5 space-y-1.5">
                  {rooms.map((v) => (
                    <li key={v.entityId} className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block break-words font-medium">{clean(v.name)}</span>
                        {(v.address || v.area) && <span className="block break-words text-xs text-muted">{v.address ?? v.area}</span>}
                      </span>
                      {v.affinity !== undefined && <span className="shrink-0 font-display text-lg tabular-nums text-muted" title="Qloo affinity, 0–100">{Math.round(v.affinity * 100)}</span>}
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-1.5 text-sm text-muted">Qloo found no matching rooms here.</p>}
              {stop.venues.length > 2 && (
                <button type="button" onClick={() => setMore(!more)} className="no-print mt-1 min-h-11 text-sm text-muted underline underline-offset-4 hover:text-ink">
                  {more ? "Show fewer" : `+${stop.venues.length - 2} more`}
                </button>
              )}
            </div>
          )}
          {stop.opener && (
            <div>
              <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                {emerging ? "Support slot to pitch for" : arena ? "Fans here also like" : comedian ? "Feature act idea" : "Opener idea"} <Chip kind={sample ? "sample" : "qloo"} /><Cites ids={[stop.opener.evidence]} />
              </h4>
              <p className="mt-1 font-display text-3xl uppercase leading-none">{clean(stop.opener.name)}</p>
              {stop.opener.oversize && (
                <p role="note" className="mt-2 rounded-md border border-sample/60 px-2 py-1 text-xs text-sample">
                  Above your size fit{stop.opener.popularity !== undefined && stop.opener.sizeCap !== undefined ? ` (Qloo popularity ${stop.opener.popularity.toFixed(2)} vs ${stop.opener.sizeCap.toFixed(2)})` : ""}: no smaller act with affinity here, so this is the closest match. The route check looks for a better one.
                </p>
              )}
              {shared.length > 0 && (
                <p className="mt-2 text-sm text-muted">
                  Shared tastes: <span className="text-ink">{shared.map((x) => tidyTag(clean(x))).join(", ")}</span> <Cites ids={[stop.opener.overlap!.evidence]} />
                </p>
              )}
            </div>
          )}
        </div>

        {!arena && stop.pitch && (
          <>
            <button type="button" onClick={() => setSheet(true)}
              className="no-print inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-4 text-sm font-semibold hover:border-accent">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
              {emerging ? "Support-slot request email" : "Pitch email to the booker"}
            </button>
            {sheet && <PitchSheet pitch={stop.pitch} city={stop.city.name} to={pitchTo} onClose={() => setSheet(false)} />}
            <div className="hidden print:block"><PitchLetter pitch={stop.pitch} city={stop.city.name} to={pitchTo} /></div>
          </>
        )}
        {!arena && !stop.pitch && writing && !stop.textDone && <Writing label="Drafting the pitch…" />}
      </div>
    </article>
  );
}
