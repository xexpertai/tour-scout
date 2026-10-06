"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { Candidate } from "@/lib/tour/resolve";
import type { ArtistKind, ArtistRef, TourInput } from "@/lib/tour/types";
import { Chip, clean, isSample } from "./atoms";

type Resolved = { status: "resolved" | "ambiguous" | "not_found"; candidates: Candidate[] };
const REGIONS = ["United States", "United Kingdom", "Canada", "Australia", "Germany", "India"];

async function resolveName(name: string, kind: ArtistKind): Promise<Resolved> {
  const res = await fetch("/api/tour/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, kind }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Search failed (${res.status})`);
  return body as Resolved;
}
const toRef = (c: Candidate, kind: ArtistKind): ArtistRef => ({ id: c.id, name: c.name, type: kind, popularity: c.popularity });

function CandidateRow({ c, selected, onSelect }: { c: Candidate; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected}
      className={`flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left ${selected ? "border-accent bg-surface-2" : "border-line hover:border-muted"}`}>
      <span className="min-w-0">
        <span className="block font-display text-xl uppercase leading-tight [overflow-wrap:normal]">{clean(c.name)}</span>
        {c.description && <span className="block truncate text-xs text-muted">{c.description}</span>}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {c.popularity !== undefined && <span className="font-mono text-xs text-muted">popularity {Math.round(c.popularity * 100)}</span>}
        <span className="flex gap-1">{isSample(c.name) ? <Chip kind="sample" /> : <Chip kind="qloo" />}{c.arenaScale && <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] font-bold text-accent-ink">ARENA</span>}</span>
      </span>
    </button>
  );
}

function TripOptions({ onSubmit, label }: { onSubmit: (o: Pick<TourInput, "region" | "candidateCities" | "stops" | "capacity">) => void; label: string }) {
  const [mode, setMode] = useState<"region" | "cities">("region");
  const [region, setRegion] = useState(REGIONS[0]);
  const [cities, setCities] = useState("");
  const [stops, setStops] = useState(4);
  const [cap, setCap] = useState({ min: "", max: "" });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const list = cities.split(/[,\n]/).map((c) => c.trim()).filter(Boolean);
    const min = Number(cap.min), max = Number(cap.max);
    onSubmit({
      region: mode === "region" ? region : undefined,
      candidateCities: mode === "cities" && list.length ? list : undefined,
      stops,
      capacity: min > 0 && max > 0 ? [Math.min(min, max), Math.max(min, max)] : undefined,
    });
  };
  const field = "min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-base text-ink outline-none focus:border-accent";
  return (
    <form onSubmit={submit} className="mt-5 space-y-4 border-t border-line pt-5">
      <div className="flex gap-2 font-mono text-xs">
        {(["region", "cities"] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
            className={`min-h-10 rounded-full border px-4 uppercase tracking-wider ${mode === m ? "border-ink bg-ink text-bg" : "border-line text-muted"}`}>
            {m === "region" ? "Scout a country" : "Rank my cities"}
          </button>
        ))}
      </div>
      {mode === "region" ? (
        <label className="block text-sm">Country
          <input list="regions" value={region} onChange={(e) => setRegion(e.target.value)} className={`${field} mt-1`} />
          <datalist id="regions">{REGIONS.map((r) => <option key={r} value={r} />)}</datalist>
        </label>
      ) : (
        <label className="block text-sm">Cities you&apos;re considering <span className="text-muted">(comma-separated)</span>
          <textarea value={cities} onChange={(e) => setCities(e.target.value)} rows={2} placeholder="Chicago, Austin, Denver, Seattle" className={`${field} mt-1 py-2`} />
        </label>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">Stops: <span className="font-mono text-accent">{stops}</span>
          <input type="range" min={2} max={6} value={stops} onChange={(e) => setStops(Number(e.target.value))} className="mt-3 w-full accent-[var(--accent)]" />
        </label>
        <fieldset className="text-sm">
          <legend>Room size <span className="text-muted">(optional, your target)</span></legend>
          <div className="mt-1 flex items-center gap-2">
            <input inputMode="numeric" aria-label="Minimum capacity" placeholder="200" value={cap.min} onChange={(e) => setCap({ ...cap, min: e.target.value.replace(/\D/g, "") })} className={field} />
            <span className="text-muted">–</span>
            <input inputMode="numeric" aria-label="Maximum capacity" placeholder="600" value={cap.max} onChange={(e) => setCap({ ...cap, max: e.target.value.replace(/\D/g, "") })} className={field} />
          </div>
        </fieldset>
      </div>
      <p className="text-xs text-muted">Qloo has no venue capacities: your room size is only used in the pitch text, labelled as your target.</p>
      <button className="min-h-12 w-full rounded-xl bg-accent font-display text-xl uppercase tracking-wide text-accent-ink sm:w-auto sm:px-8">{label}</button>
    </form>
  );
}

/** Proxy picker for emerging-artist mode: each "sounds like" name is resolved and confirmed. */
function SoundsLike({ kind, value, onChange }: { kind: ArtistKind; value: ArtistRef[]; onChange: (v: ArtistRef[]) => void }) {
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const search = async () => {
    if (!q.trim()) return;
    setBusy(true); setError(undefined); setOptions([]);
    try {
      const r = await resolveName(q.trim(), kind);
      if (r.status === "not_found") setError(`Qloo doesn't know "${q.trim()}" either.`);
      else setOptions(r.candidates);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {value.map((p) => (
          <span key={p.id} className="inline-flex min-h-9 items-center gap-2 rounded-full bg-surface-2 pl-3 pr-1 text-sm">
            {clean(p.name)}
            <button type="button" aria-label={`Remove ${clean(p.name)}`} onClick={() => onChange(value.filter((v) => v.id !== p.id))} className="grid h-8 w-8 place-items-center rounded-full text-muted hover:text-ink">×</button>
          </span>
        ))}
      </div>
      {value.length < 3 && (
        <div className="flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }}
            placeholder={value.length ? "Add another (optional)" : "An artist you sound like"} aria-label="Artist you sound like"
            className="min-h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 text-base outline-none focus:border-accent" />
          <button type="button" onClick={search} disabled={busy} className="min-h-11 shrink-0 rounded-lg border border-line px-4 font-mono text-xs uppercase">{busy ? "…" : "Find"}</button>
        </div>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      {options.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted">Did you mean:</p>
          {options.map((c) => <CandidateRow key={c.id} c={c} selected={false} onSelect={() => { onChange([...value, toRef(c, kind)]); setOptions([]); setQ(""); }} />)}
        </div>
      )}
    </div>
  );
}

export function ResolvePanel({ query, onStart, onCancel }: { query: { name: string; kind: ArtistKind }; onStart: (input: TourInput) => void; onCancel: () => void }) {
  const [result, setResult] = useState<Resolved>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState(0);
  const [emerging, setEmerging] = useState(false);
  const [proxies, setProxies] = useState<ArtistRef[]>([]);
  const [actName, setActName] = useState(query.name);

  useEffect(() => {
    // The parent keys this panel by query, so state starts fresh for every search.
    let live = true;
    resolveName(query.name, query.kind).then((r) => { if (live) { setResult(r); setEmerging(r.status === "not_found"); } }).catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [query]);

  const who = query.kind === "person" ? "comedian" : "artist";
  return (
    <section className="mx-auto max-w-2xl px-4 py-8 sm:px-6" aria-live="polite">
      <button type="button" onClick={onCancel} className="mb-4 min-h-11 font-mono text-xs uppercase tracking-wider text-muted hover:text-ink">← Back</button>
      <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        {error ? (
          <div role="alert">
            <h2 className="font-display text-2xl uppercase">Search didn&apos;t work</h2>
            <p className="mt-2 text-sm text-muted">{error}</p>
          </div>
        ) : !result ? (
          <div className="space-y-3" aria-label="Searching Qloo">
            <p className="font-mono text-xs uppercase tracking-wider text-muted">Searching Qloo for “{query.name}”…</p>
            <div className="skeleton h-14" /><div className="skeleton h-14" />
          </div>
        ) : !emerging ? (
          <>
            <p className="font-mono text-xs uppercase tracking-wider text-accent">Confirm the {who}</p>
            <h2 className="mt-1 font-display text-3xl uppercase">Did you mean…</h2>
            <div className="mt-4 space-y-2">
              {result.candidates.map((c, i) => <CandidateRow key={c.id} c={c} selected={i === selected} onSelect={() => setSelected(i)} />)}
            </div>
            {result.candidates[selected]?.arenaScale && (
              <p className="mt-3 text-sm text-muted">Arena-scale act: the plan shows where the fans are, but the rooms are the club and theatre rooms this audience favours, not arenas.</p>
            )}
            <button type="button" onClick={() => setEmerging(true)} className="mt-3 min-h-11 text-sm text-muted underline underline-offset-4 hover:text-ink">
              None of these — plan as an emerging act
            </button>
            <TripOptions label="Scout the tour" onSubmit={(o) => onStart({ artist: toRef(result.candidates[selected], query.kind), ...o })} />
          </>
        ) : (
          <>
            <p className="font-mono text-xs uppercase tracking-wider text-accent">Emerging-act mode</p>
            <h2 className="mt-1 font-display text-3xl uppercase">{result.status === "not_found" ? "Not on Qloo yet?" : "Plan as an emerging act"}</h2>
            <p className="mt-2 text-sm text-muted">
              Pick 1–3 {who}s you sound like. Tour Scout uses their fans as a proxy for yours, and every screen says so.
            </p>
            <label className="mt-4 block text-sm">Your act&apos;s name
              <input value={actName} onChange={(e) => setActName(e.target.value)} maxLength={120} className="mt-1 min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-base outline-none focus:border-accent" />
            </label>
            <div className="mt-4"><SoundsLike kind={query.kind} value={proxies} onChange={setProxies} /></div>
            {proxies.length > 0 && (
              <TripOptions label="Scout with these fans" onSubmit={(o) => onStart({ artist: null, emerging: { name: actName.trim() || "Your act", proxies }, ...o })} />
            )}
          </>
        )}
      </div>
    </section>
  );
}
