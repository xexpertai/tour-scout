"use client";

/**
 * The tour map (MapLibre GL + OpenFreeMap vector tiles: free, no key, public use allowed).
 *
 * Signature moment, driven by the data as it arrives (and replayed once for a finished plan):
 *   1. hotspots  — Qloo's country-wide fan cells bloom as heat ("20 fan hotspots found")
 *   2. scoring   — candidate cities appear with their room-affinity score ticking up
 *   3. route     — the winners lock in as numbered pins, the camera eases to them, the route draws
 * Each phase holds for a minimum time so the story reads even when all the data is already there.
 * prefers-reduced-motion jumps straight to the final frame.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { clean, useIsDark } from "./atoms";

export type MapCity = { id: string; name: string; lat: number; lng: number; affinity: number };
export type MapStop = { id: string; order: number; name: string; lat: number; lng: number };
export type MapCell = { lat: number; lng: number; affinity: number };
/** A place a scout answer talks about: dashed "ghost" pin that jumps to its answer card. */
export type MapGhost = { key: string; name: string; lat: number; lng: number; affinity: number; target: string };
/** An unapplied scout proposal, previewed on the map: stops it removes fade, cities it adds pulse. */
export type MapProposal = { add: { name: string; lat: number; lng: number }[]; remove: string[] };

const STYLES = { dark: "https://tiles.openfreemap.org/styles/dark", light: "https://tiles.openfreemap.org/styles/positron" };
const NEON = "#ff2e88";
const HOLD = { hotspots: 1500, scoring: 1700 };
type Phase = "idle" | "hotspots" | "scoring" | "route";
const ORDER: Phase[] = ["idle", "hotspots", "scoring", "route"];

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isNarrow = () => typeof window !== "undefined" && window.innerWidth < 1024;
const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
const line = (pts: [number, number][]): GeoJSON.Feature => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } });

function boundsOf(points: { lat: number; lng: number }[]): maplibregl.LngLatBounds | undefined {
  if (!points.length) return undefined;
  const b = new maplibregl.LngLatBounds([points[0].lng, points[0].lat], [points[0].lng, points[0].lat]);
  for (const p of points) b.extend([p.lng, p.lat]);
  return b;
}

/** Custom sources and layers; re-added whenever the base style changes (theme switch). */
function addLayers(map: MLMap) {
  if (map.getSource("heat")) return;
  map.addSource("heat", { type: "geojson", data: fc([]) });
  map.addLayer({
    id: "heat", type: "heatmap", source: "heat",
    paint: {
      "heatmap-weight": ["interpolate", ["linear"], ["get", "w"], 0.9, 0.55, 1, 1],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 2, 1.8, 5, 1.4, 8, 0.9],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 2, 38, 4, 56, 7, 80],
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(255,107,26,0)", 0.25, "rgba(255,107,26,0.35)", 0.55, "rgba(255,46,136,0.6)", 0.85, "rgba(255,107,26,0.8)", 1, "rgba(255,190,140,0.9)"],
      "heatmap-opacity": 0,
      "heatmap-opacity-transition": { duration: 1400, delay: 0 },
    },
  });
  map.addSource("route", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "route-glow", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": NEON, "line-width": 10, "line-blur": 8, "line-opacity": 0.45 } });
  map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": NEON, "line-width": 3.2 } });
  map.addSource("preview", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "preview", type: "line", source: "preview", layout: { "line-cap": "round" }, paint: { "line-color": "#ffd2b0", "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.9 } });
}

/** A labelled HTML marker; the element is kept so classes can change without re-creating it. */
function el(html: string, cls: string): HTMLDivElement {
  // MapLibre owns the root element's inline transform and opacity, so all styling and animation
  // lives on an inner wrapper (.mk); state classes go on the root.
  const d = document.createElement("div");
  d.className = cls;
  d.innerHTML = `<div class="mk">${html}</div>`;
  return d;
}

export default function TourMap({ cities, stops, cells = [], ghosts = [], proposal, activeId, focusId, onSelect, stopsWanted, compactPadding = false }: {
  cities: MapCity[]; stops: MapStop[]; cells?: MapCell[]; ghosts?: MapGhost[]; proposal?: MapProposal;
  activeId?: string; focusId?: string; onSelect?: (id: string) => void; stopsWanted?: number; compactPadding?: boolean;
}) {
  const dark = useIsDark();
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(0); // bumps on every style load
  const [stepped, setPhase] = useState<Phase>("idle");
  const markers = useRef(new Map<string, { marker: maplibregl.Marker; node: HTMLDivElement }>());
  const declutterRef = useRef<() => void>(() => {});

  // ---- create the map once
  useEffect(() => {
    if (!box.current) return;
    const map = new maplibregl.Map({
      container: box.current, style: dark ? STYLES.dark : STYLES.light, center: [-96, 39], zoom: isNarrow() ? 2.2 : 2.9,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, cooperativeGestures: true, fadeDuration: 0,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("style.load", () => { addLayers(map); setReady((n) => n + 1); });
    // Candidate labels: strongest first; a label that would overlap one already placed shows its dot only.
    const declutter = () => {
      const placed: { x: number; y: number }[] = [];
      const cands = [...markers.current.entries()].filter(([k]) => k.startsWith("cand:")).map(([, m]) => m)
        .sort((a, b) => Number(b.node.dataset.score) - Number(a.node.dataset.score));
      for (const m of cands) {
        const p = map.project(m.marker.getLngLat());
        const crowded = placed.some((q) => Math.abs(q.x - p.x) < 120 && Math.abs(q.y - p.y) < 26);
        m.node.classList.toggle("crowded", crowded);
        if (!crowded) placed.push(p);
      }
    };
    map.on("moveend", declutter);
    declutterRef.current = declutter;
    mapRef.current = map;
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(box.current);
    const nodes = markers.current;
    return () => { ro.disconnect(); nodes.forEach((m) => m.marker.remove()); nodes.clear(); map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the theme effect below swaps styles
  }, []);

  // ---- theme: swap the base style; layers come back through style.load
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    mapRef.current?.setStyle(dark ? STYLES.dark : STYLES.light);
  }, [dark]);

  // ---- phase machine: advance one phase at a time, never faster than the minimum hold
  const target: Phase = stops.length && (stops.length >= (stopsWanted ?? 1)) ? "route" : cities.length ? "scoring" : cells.length ? "hotspots" : "idle";
  const reduce = reducedMotion();
  // Never ahead of the data: a new run (less data) shows its own earlier phase at once.
  const phase: Phase = reduce || ORDER.indexOf(target) < ORDER.indexOf(stepped) ? target : stepped;
  useEffect(() => {
    if (reduce) return;
    const at = ORDER.indexOf(stepped), want = ORDER.indexOf(target);
    if (want === at) return;
    const next = want < at ? target : ORDER[at + 1];
    const hold = want < at ? 0 : stepped === "hotspots" ? (cells.length ? HOLD.hotspots : 0) : stepped === "scoring" ? HOLD.scoring : 0;
    const t = setTimeout(() => setPhase(next), hold);
    return () => clearTimeout(t);
  }, [stepped, target, cells.length, reduce]);

  // ---- heat
  const cellKey = cells.map((c) => `${c.lat},${c.lng}`).join("|");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getSource("heat")) return;
    (map.getSource("heat") as GeoJSONSource).setData(fc(cells.map((c) => ({ type: "Feature", properties: { w: c.affinity }, geometry: { type: "Point", coordinates: [c.lng, c.lat] } }))));
    const shown = ORDER.indexOf(phase) >= 1;
    map.setPaintProperty("heat", "heatmap-opacity", shown ? (phase === "route" ? 0.55 : 0.95) : 0);
    // Frame the country's hotspots before they bloom, and the candidates when they arrive.
    if (phase === "hotspots" || (phase === "scoring" && !cells.length)) {
      const b = boundsOf([...cells, ...cities]);
      if (b) map.fitBounds(b, { padding: 50, maxZoom: 5.2, duration: reducedMotion() ? 0 : 900 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the cell set
  }, [cellKey, ready, phase]);

  // ---- candidate cities with ticking scores (scoring phase); they fade once the route locks in
  const stopNames = useMemo(() => new Set(stops.map((s) => clean(s.name))), [stops]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const live = new Set<string>();
    const show = ORDER.indexOf(phase) >= 2;
    cities.forEach((c, i) => {
      const key = `cand:${c.id}`;
      live.add(key);
      let m = markers.current.get(key);
      const score = Math.round(c.affinity * 100);
      if (!m) {
        const node = el(`<span class="cand-dot"></span><span class="cand-score">0</span><span class="cand-name">${clean(c.name)}</span>`, "cand");
        node.dataset.score = String(score);
        node.style.setProperty("--delay", `${i * 110}ms`);
        m = { marker: new maplibregl.Marker({ element: node, anchor: "left", offset: [-6, 0] }).setLngLat([c.lng, c.lat]).addTo(map), node };
        markers.current.set(key, m);
      }
      const scoreEl = m.node.querySelector(".cand-score") as HTMLSpanElement;
      if (show && !m.node.classList.contains("on")) {
        m.node.classList.add("on");
        if (reducedMotion()) scoreEl.textContent = String(score);
        else {
          const t0 = performance.now() + i * 110;
          const tick = (now: number) => {
            const k = Math.min(1, Math.max(0, (now - t0) / 750));
            scoreEl.textContent = String(Math.round(score * (1 - Math.pow(1 - k, 3))));
            if (k < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      }
      if (!show) { m.node.classList.remove("on"); scoreEl.textContent = "0"; }
      m.node.classList.toggle("won", phase === "route" && stopNames.has(clean(c.name)));
      m.node.classList.toggle("lost", phase === "route" && !stopNames.has(clean(c.name)));
    });
    for (const [key, m] of markers.current) if (key.startsWith("cand:") && !live.has(key)) { m.marker.remove(); markers.current.delete(key); }
    declutterRef.current();
  }, [cities, phase, ready, stopNames]);

  // ---- route phase: pins, one camera move, the line draws
  const stopKey = stops.map((s) => `${s.id}@${s.lat},${s.lng}`).join("|");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const live = new Set<string>();
    const show = phase === "route";
    // Label side: the western one of two close pins puts its name on the left, so names never collide.
    const px = stops.map((s) => map.project([s.lng, s.lat]));
    stops.forEach((s, i) => {
      const key = `stop:${s.id}`;
      live.add(key);
      const crowdedEast = stops.some((o, j) => j !== i && Math.hypot(px[j].x - px[i].x, px[j].y - px[i].y) < 140 && px[j].x > px[i].x);
      let m = markers.current.get(key);
      if (!m) {
        const node = el(`<button type="button" class="stop-pin" aria-label="Stop ${s.order}: ${clean(s.name)}">${s.order}</button><span class="stop-name">${clean(s.name)}</span>`, "stop");
        node.querySelector("button")!.addEventListener("click", () => onSelect?.(s.id));
        m = { marker: new maplibregl.Marker({ element: node, anchor: "center" }).setLngLat([s.lng, s.lat]).addTo(map), node };
        markers.current.set(key, m);
      }
      m.marker.setLngLat([s.lng, s.lat]);
      (m.node.querySelector(".stop-pin") as HTMLElement).textContent = String(s.order);
      m.node.classList.toggle("on", show);
      m.node.classList.toggle("left", crowdedEast);
      m.node.style.setProperty("--delay", `${i * 120}ms`);
    });
    for (const [key, m] of markers.current) if (key.startsWith("stop:") && !live.has(key)) { m.marker.remove(); markers.current.delete(key); }
    if (!show || !map.getSource("route")) { (map.getSource("route") as GeoJSONSource | undefined)?.setData(fc([])); return; }

    const pts = stops.map((s) => [s.lng, s.lat] as [number, number]);
    const b = boundsOf(stops);
    // Room for the city names beside the pins (names go left or right of a pin).
    const padding = isNarrow() ? { top: 52, bottom: compactPadding ? 40 : 34, left: 92, right: 112 } : { top: 80, bottom: 70, left: 130, right: 150 };
    const reduce = reducedMotion();
    if (b) map.fitBounds(b, { padding, maxZoom: 8.5, duration: reduce ? 0 : 1500, essential: false });
    const src = map.getSource("route") as GeoJSONSource;
    if (reduce || pts.length < 2) { src.setData(fc(pts.length > 1 ? [line(pts)] : [])); return; }
    // Draw the line along its length after the camera settles.
    const seg = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    const total = seg.reduce((a, b2) => a + b2, 0);
    let raf = 0;
    const startAt = performance.now() + 1300;
    const draw = (now: number) => {
      const k = Math.min(1, Math.max(0, (now - startAt) / 1400));
      let left = total * (1 - Math.pow(1 - k, 2));
      const out: [number, number][] = [pts[0]];
      for (let i = 0; i < seg.length; i++) {
        if (left >= seg[i]) { out.push(pts[i + 1]); left -= seg[i]; continue; }
        const f = seg[i] ? left / seg[i] : 0;
        out.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]);
        break;
      }
      src.setData(fc(out.length > 1 ? [line(out)] : []));
      if (k < 1) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stop sequence
  }, [stopKey, phase, ready]);

  // ---- active pin (follows the scroll) and focus (a stop the visitor picked)
  useEffect(() => {
    for (const [key, m] of markers.current) if (key.startsWith("stop:")) m.node.classList.toggle("active", key === `stop:${activeId}`);
  }, [activeId, stopKey]);
  useEffect(() => {
    const s = stops.find((x) => x.id === focusId);
    if (s && mapRef.current) mapRef.current.flyTo({ center: [s.lng, s.lat], zoom: Math.max(mapRef.current.getZoom(), 8), duration: reducedMotion() ? 0 : 900 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the visitor picks a stop
  }, [focusId]);

  // ---- scout: ghost pins and the proposal preview
  const ghostKey = ghosts.map((g) => g.key).join("|") + JSON.stringify(proposal ?? null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const live = new Set<string>();
    const add = (key: string, lng: number, lat: number, html: string, cls: string, onClick?: () => void) => {
      live.add(key);
      if (markers.current.has(key)) return;
      const node = el(html, cls);
      if (onClick) node.addEventListener("click", onClick);
      markers.current.set(key, { marker: new maplibregl.Marker({ element: node }).setLngLat([lng, lat]).addTo(map), node });
    };
    ghosts.forEach((g) => add(`ghost:${g.key}`, g.lng, g.lat, `<span class="ghost-ring"></span><span class="cand-name">${clean(g.name)} · ${Math.round(g.affinity * 100)}</span>`, "ghost",
      () => document.getElementById(g.target)?.scrollIntoView({ behavior: "smooth", block: "start" })));
    proposal?.add.forEach((c) => add(`new:${c.name}`, c.lng, c.lat, `<span class="ghost-ring new"></span><span class="cand-name">+ ${clean(c.name)}</span>`, "ghost new"));
    for (const [key, m] of markers.current) if ((key.startsWith("ghost:") || key.startsWith("new:")) && !live.has(key)) { m.marker.remove(); markers.current.delete(key); }
    for (const [key, m] of markers.current) if (key.startsWith("stop:")) m.node.classList.toggle("removed", Boolean(proposal?.remove.includes(key.slice(5))));
    // Dashed preview of the changed route: removed stops dropped, added cities joined to the nearest remaining stop.
    const src = map.getSource("preview") as GeoJSONSource | undefined;
    if (!src) return;
    if (!proposal || (!proposal.add.length && !proposal.remove.length)) { src.setData(fc([])); return; }
    const kept = stops.filter((s) => !proposal.remove.includes(s.id));
    const legs = proposal.add.map((c) => {
      const near = kept.slice().sort((a, b) => Math.hypot(a.lat - c.lat, a.lng - c.lng) - Math.hypot(b.lat - c.lat, b.lng - c.lng))[0];
      return near ? line([[near.lng, near.lat], [c.lng, c.lat]]) : undefined;
    }).filter(Boolean) as GeoJSON.Feature[];
    src.setData(fc(legs));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on ghosts and proposal
  }, [ghostKey, ready, stopKey]);

  const caption = phase === "hotspots" ? `${cells.length} fan hotspots found` : phase === "scoring" ? `Scoring ${cities.length} cities` : phase === "route" && stops.length ? `Your ${stops.length}-stop run` : "";
  return (
    <div className="relative h-full w-full">
      <div ref={box} className="map-box h-full w-full" />
      {caption && !reduce && <p key={caption} aria-live="polite" className={`map-caption pointer-events-none ${phase === "route" ? "short" : ""}`}>{caption}</p>}
    </div>
  );
}
