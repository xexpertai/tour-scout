"use client";

import { useState } from "react";
import type { Insight } from "@/lib/guard";
import { AffinityScore, Chip, Cites, InsightText, Writing, clean, fitDisplay, isSample } from "./atoms";
import type { StopView } from "./useTourRun";

const pad = (n: number) => String(n).padStart(2, "0");
const isCoordinate = (name: string) => /^-?\d+(\.\d+)?,\s*-?\d/.test(name);

export function PitchLetter({ pitch, city }: { pitch: Insight; city: string }) {
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
    <div className="rounded-lg border border-line bg-surface-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted">
          <span>To: booker, {clean(city)}</span>
          <Chip kind={pitch.kind === "interpretation" ? "ai" : pitch.kind} />
          {pitch.evidence.length > 0 && <>cites <Cites ids={pitch.evidence} /></>}
        </div>
        <button type="button" onClick={copy} className="no-print min-h-10 rounded-lg border border-line px-3 font-mono text-xs uppercase tracking-wider hover:border-accent">
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      {hasSubject && <p className="mt-3 text-sm font-semibold">{subjectLine.replace(/^subject:\s*/i, "")}</p>}
      <p className="mt-2 whitespace-pre-line text-sm leading-relaxed">{(hasSubject ? rest.join("\n") : pitch.text).trim()}</p>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-muted">Draft — check every claim before you send it</p>
    </div>
  );
}

export function StopTicket({ stop, active, writing }: { stop: StopView; active: boolean; writing: boolean }) {
  const n = stop.order ?? stop.rank;
  const sample = isSample(stop.city.name);
  return (
    <article id={`stop-${stop.stopId}`} data-stop={stop.stopId} aria-label={`Stop ${n}: ${clean(stop.city.name)}`}
      className={`ticket slide-in scroll-mt-28 overflow-hidden rounded-2xl border bg-surface ${active ? "border-accent" : "border-line"}`}>
      <header className="flex h-[112px] items-center justify-between gap-3 px-5">
        <div className="min-w-0 flex-1 [container-type:inline-size]">
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Stop {pad(n)}</div>
          <h3 className="font-display uppercase leading-none" style={fitDisplay(stop.city.name, "3rem")}>{clean(stop.city.name)}</h3>
        </div>
        <AffinityScore value={stop.city.affinity} sample={sample} evidence={stop.city.evidence} />
      </header>
      <div className="tear-line mx-5" />

      <div className="space-y-5 p-5">
        {stop.cluster && (
          <p className="flex flex-wrap items-center gap-1.5 text-sm">
            {isCoordinate(stop.cluster.name) ? (
              <span className="text-muted">Fans concentrate in one part of the city (no local area name found)</span>
            ) : (
              <><span className="text-muted">Fans cluster around</span><b>{clean(stop.cluster.name)}</b><Chip kind="osm" /></>
            )}
            <Cites ids={[stop.cluster.evidence]} />
          </p>
        )}

        {stop.why ? <InsightText item={stop.why} /> : writing && !stop.textDone ? <Writing label="Writing why this stop…" /> : null}

        <div>
          <h4 className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            Rooms near the fans {stop.venues[0] && <Chip kind={sample ? "sample" : "qloo"} />}{stop.venues[0] && <Cites ids={[stop.venues[0].evidence]} />}
          </h4>
          {stop.venues.length ? (
            <ul className="mt-2 divide-y divide-line">
              {stop.venues.map((v) => (
                <li key={v.entityId} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{clean(v.name)}</div>
                    {v.address && <div className="truncate text-xs text-muted">{v.address}</div>}
                  </div>
                  {v.affinity !== undefined && <span className="shrink-0 font-mono text-sm text-muted" title="Qloo affinity, 0–100">{Math.round(v.affinity * 100)}</span>}
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-sm text-muted">Qloo found no matching rooms here.</p>}
        </div>

        {stop.opener && (
          <div>
            <h4 className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
              Opener idea <Chip kind={sample ? "sample" : "qloo"} /><Cites ids={[stop.opener.evidence]} />
            </h4>
            <p className="mt-1 font-display text-2xl uppercase">{clean(stop.opener.name)}</p>
            {stop.opener.overlap && stop.opener.overlap.shared.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted">Shared tastes:</span>
                {stop.opener.overlap.shared.map((t) => <span key={t} className="rounded-full border border-line px-2.5 py-1 text-xs">{clean(t)}</span>)}
                <Cites ids={[stop.opener.overlap.evidence]} />
              </div>
            )}
          </div>
        )}

        {stop.pitch ? (
          <details className="group" open={active}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between font-mono text-[11px] uppercase tracking-[0.2em] text-muted hover:text-ink">
              Pitch email to the booker <span className="transition-transform group-open:rotate-180" aria-hidden>▾</span>
            </summary>
            <div className="mt-2"><PitchLetter pitch={stop.pitch} city={stop.city.name} /></div>
          </details>
        ) : writing && !stop.textDone ? <Writing label="Writing the pitch…" /> : null}
      </div>
    </article>
  );
}
