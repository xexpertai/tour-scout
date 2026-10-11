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

/**
 * The dark basemap is near-black with land, water and borders a few shades apart; lift them so the
 * geography reads behind the route (land and water apart, state and country lines and major roads visible).
 */
function brightenDark(map: maplibregl.Map) {
  const set = (id: string, prop: string, value: unknown) => { if (map.getLayer(id)) map.setPaintProperty(id, prop, value); };
  set("background", "background-color", "#17171c");
  set("water", "fill-color", "#0a1220");
  set("waterway", "line-color", "#0a1220");
  set("boundary_state", "line-color", "hsl(0,0%,36%)");
  set("boundary_country_z0-4", "line-color", "hsl(0,0%,44%)");
  set("boundary_country_z5-", "line-color", "hsl(0,0%,44%)");
  for (const id of ["highway_major_subtle", "highway_motorway_subtle"]) set(id, "line-color", "#34343c");
}

/** A labelled HTML marker; the element is kept so classes can change without re-creating it. */
function el(html: string, cls: string, a11y?: { role: "img" | "button" | "none"; label?: string }): HTMLDivElement {
  // MapLibre owns the root element's inline transform and opacity, so all styling and animation
  // lives on an inner wrapper (.mk); state classes go on the root.
  const d = document.createElement("div");
  d.className = cls;
  d.innerHTML = `<div class="mk">${html}</div>`;
  // MapLibre names every marker root "Map marker" with role=button unless it already has a role and a
  // name: each marker says what it is (a scored city, a clickable answer pin), and a stop's root steps
  // aside for the real button inside it (no nested controls).
  if (a11y) {
    d.setAttribute("role", a11y.role);
    d.setAttribute("aria-label", a11y.label ?? "");
    if (a11y.role === "button") d.tabIndex = 0;
  }
  return d;
}

/** After MapLibre has added the marker: a root with role "none" must not carry a name. */
function settleA11y(node: HTMLElement) {
  if (node.getAttribute("role") === "none") node.removeAttribute("aria-label");
}

export default function TourMap({ cities, stops, cells = [], ghosts = [], proposal, activeId, focusId, onSelect, routeFinal = true }: {
  cities: MapCity[]; stops: MapStop[]; cells?: MapCell[]; ghosts?: MapGhost[]; proposal?: MapProposal;
  activeId?: string; focusId?: string; onSelect?: (id: string) => void; routeFinal?: boolean;
}) {
  const dark = useIsDark();
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(0); // bumps on every style load
  const darkRef = useRef(dark);
  useEffect(() => { darkRef.current = dark; }, [dark]);
  const [stepped, setPhase] = useState<Phase>("idle");
  const markers = useRef(new Map<string, { marker: maplibregl.Marker; node: HTMLDivElement }>());
  const declutterRef = useRef<() => void>(() => {});
  /** The drawn route, in order, so labels can avoid sitting on it. */
  const routeRef = useRef<[number, number][]>([]);
  const fitRef = useRef<{ bounds: maplibregl.LngLatBounds; padding: () => maplibregl.PaddingOptions } | null>(null);
  // Cities a proposal adds: every refit (including on a pane resize) keeps them in view.
  const extraRef = useRef<[number, number][]>([]);
  const withExtra = (b: maplibregl.LngLatBounds) => {
    if (!extraRef.current.length) return b;
    const out = new maplibregl.LngLatBounds(b.getSouthWest(), b.getNorthEast());
    extraRef.current.forEach((p) => out.extend(p));
    return out;
  };

  // ---- create the map once
  useEffect(() => {
    if (!box.current) return;
    // In presentation scale the map is zoomed too: render its canvas at that scale so it stays crisp.
    const present = Number(document.getElementById("app-root")?.dataset.present) || 1;
    const map = new maplibregl.Map({
      pixelRatio: (window.devicePixelRatio || 1) * present,
      container: box.current, style: dark ? STYLES.dark : STYLES.light, center: [-96, 39], zoom: isNarrow() ? 2.2 : 2.9,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, cooperativeGestures: true, fadeDuration: 0,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    // Start collapsed to the "i" button (the full credit is one tap away and in the credits line).
    map.once("load", () => map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show"));
    map.on("style.load", () => { if (darkRef.current) brightenDark(map); addLayers(map); setReady((n) => n + 1); });
    // Label layout: every pin and dot is anchored exactly on its city; its label goes right, left, above
    // or below, whichever stays inside the pane and clears every pin and every label already placed.
    // Stops are placed first; a candidate label that fits nowhere is hidden (its dot stays).
    const declutter = () => {
      const W = map.getContainer().clientWidth, H = map.getContainer().clientHeight;
      type Box = { x: number; y: number; w: number; h: number };
      const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      const inside = (b: Box) => b.x >= 4 && b.y >= 4 && b.x + b.w <= W - 4 && b.y + b.h <= H - 4;
      const entries = [...markers.current.entries()];
      // A ghost pin whose ring or label would be cut by the pane's edge is hidden until the view includes it
      // (a clipped "…ore · 91.5" reads as a glitch); its answer card still lists it.
      for (const [k, m] of entries) {
        if (!k.startsWith("ghost:")) continue;
        const p = map.project(m.marker.getLngLat());
        const lw = m.node.querySelector<HTMLElement>(".cand-name")?.offsetWidth ?? 0;
        m.node.style.visibility = p.x >= 10 && p.y >= 10 && p.y <= H - 10 && p.x + 14 + lw <= W - 6 ? "" : "hidden";
      }
      const isGhost = (k: string) => k.startsWith("ghost:") || k.startsWith("new:");
      const visible = (k: string, m: { node: HTMLDivElement }) => (k.startsWith("stop:") ? m.node.classList.contains("on") : isGhost(k) ? m.node.style.visibility !== "hidden" : k.startsWith("cand:") && m.node.classList.contains("on") && !m.node.classList.contains("won"));
      const live = entries.filter(([k, m]) => visible(k, m));
      const pinR = (k: string) => (k.startsWith("stop:") ? 19 : isGhost(k) ? 11 : 7);
      // Overlapping stop pins (two cities close together at a wide zoom) are nudged apart just enough
      // that both numbers read; labels are then placed around the nudged positions.
      const stopsLive = live.filter(([k]) => k.startsWith("stop:"));
      const shift = new Map<string, { x: number; y: number }>(stopsLive.map(([k]) => [k, { x: 0, y: 0 }]));
      const at = (k: string, m: { marker: maplibregl.Marker }) => { const p = map.project(m.marker.getLngLat()); const o = shift.get(k) ?? { x: 0, y: 0 }; return { x: p.x + o.x, y: p.y + o.y }; };
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < stopsLive.length; i++) for (let j = i + 1; j < stopsLive.length; j++) {
          const [ki, mi] = stopsLive[i], [kj, mj] = stopsLive[j];
          const a = at(ki, mi), b = at(kj, mj), d = Math.hypot(b.x - a.x, b.y - a.y), need = 40;
          if (d >= need) continue;
          const ux = d ? (b.x - a.x) / d : 1, uy = d ? (b.y - a.y) / d : 0, push = (need - d) / 2;
          shift.get(ki)!.x -= ux * push; shift.get(ki)!.y -= uy * push;
          shift.get(kj)!.x += ux * push; shift.get(kj)!.y += uy * push;
        }
      }
      for (const [k, m] of stopsLive) { const o = shift.get(k)!; m.marker.setOffset([o.x, o.y]); }
      // A ghost ring (a proposal's added city, a city an answer names) never sits on a stop pin: it steps
      // away from the pin just enough to read (a close city at a wide zoom, e.g. Providence next to Boston).
      for (const [k, m] of live.filter(([g]) => isGhost(g))) {
        const o = { x: 0, y: 0 };
        shift.set(k, o);
        for (let pass = 0; pass < 3; pass++) for (const [ks, ms] of stopsLive) {
          const a = at(ks, ms), b = at(k, m), d = Math.hypot(b.x - a.x, b.y - a.y), need = pinR(ks) + pinR(k) + 4;
          if (d >= need) continue;
          const ux = d ? (b.x - a.x) / d : 0.6, uy = d ? (b.y - a.y) / d : 0.8;
          o.x += ux * (need - d); o.y += uy * (need - d);
        }
        m.marker.setOffset([o.x, o.y]);
      }
      const route = routeRef.current.map((p) => map.project(p));
      // A box crosses the route if any point along a leg (every 4 px) falls inside it.
      const onRoute = (b: Box) => route.slice(1).some((q, i) => {
        const a = route[i], n = Math.max(1, Math.ceil(Math.hypot(q.x - a.x, q.y - a.y) / 4));
        for (let t = 0; t <= n; t++) { const x = a.x + ((q.x - a.x) * t) / n, y = a.y + ((q.y - a.y) * t) / n; if (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) return true; }
        return false;
      });
      const taken: Box[] = live.map(([k, m]) => { const p = at(k, m); const r = pinR(k); return { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r }; });
      // The mobile "Expand map" button and the map's own controls are taken space too, so no label slides under them.
      const frame = map.getContainer().getBoundingClientRect();
      const overlays = [...(map.getContainer().closest(".print-map")?.querySelectorAll<HTMLElement>("[data-map-overlay]") ?? []), ...map.getContainer().querySelectorAll<HTMLElement>(".maplibregl-ctrl")];
      for (const b of overlays) {
        const r = b.getBoundingClientRect();
        if (r.width) taken.push({ x: r.left - frame.left - 4, y: r.top - frame.top - 4, w: r.width + 8, h: r.height + 8 });
      }
      // Labels are placed in priority order: stops, then the proposal's added city, then the cities an
      // answer names, then candidates (best score first).
      const rank = (k: string) => (k.startsWith("stop:") ? 0 : k.startsWith("new:") ? 1 : k.startsWith("ghost:") ? 2 : 3);
      const order = [...live].sort(([a, ma], [b, mb]) => rank(a) - rank(b) || Number(mb.node.dataset.score ?? 0) - Number(ma.node.dataset.score ?? 0));
      for (const [k, m] of order) {
        const label = m.node.querySelector<HTMLElement>(".lbl");
        if (!label) continue;
        m.node.classList.remove("crowded"); // a hidden label measures 0 wide; measure it shown
        const p = at(k, m), r = pinR(k) + 6, w = label.offsetWidth, h = label.offsetHeight;
        const sides: [string, Box][] = [
          ["right", { x: p.x + r, y: p.y - h / 2, w, h }],
          ["left", { x: p.x - r - w, y: p.y - h / 2, w, h }],
          // Candidates may also go above or below, as a way off the route line.
          ["top", { x: p.x - w / 2, y: p.y - r - h, w, h }], ["bottom", { x: p.x - w / 2, y: p.y + r, w, h }],
        ];
        // Prefer a side that also keeps the label off the route line (a label on the line reads as if the route ran through it).
        const free = sides.filter(([, b]) => inside(b) && !taken.some((t) => hit(t, b)));
        const pick = free.find(([, b]) => !onRoute(b)) ?? free[0];
        for (const side of ["right", "left", "top", "bottom"]) m.node.classList.toggle(`at-${side}`, (pick?.[0] ?? (rank(k) <= 1 ? sides.find(([, b]) => inside(b))?.[0] ?? "right" : "")) === side);
        // No free side: the label steps aside (the numbered pin stays; the stop list names every stop).
        m.node.classList.toggle("crowded", !pick && rank(k) > 1);
        if (pick) taken.push(pick[1]);
      }
    };
    map.on("moveend", declutter);
    declutterRef.current = declutter;
    mapRef.current = map;
    // When the pane resizes (the mobile map shrinks on scroll), refit the route and re-place labels.
    const ro = new ResizeObserver(() => {
      map.resize();
      const f = fitRef.current;
      if (f) map.fitBounds(withExtra(f.bounds), { padding: f.padding(), maxZoom: 8.5, duration: 0 });
      requestAnimationFrame(() => declutterRef.current());
    });
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
  // Pins and the route wait for the final route order (it is decided when the plan is assembled), so a
  // pin is never shown with a number that changes a moment later.
  const target: Phase = stops.length && routeFinal ? "route" : cities.length ? "scoring" : cells.length ? "hotspots" : "idle";
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

  // ---- basemap place names: once the app labels its own cities, the basemap's city and town names
  // would sit under or beside them ("INDIANAPOLIS" over "Dayton", a clipped "Chicago"); hide them then.
  // State names go too (a "+ Providence" pill sat on "RHODE ISLAND"); countries and water names stay.
  const ownLabels = cities.length > 0 || stops.length > 0;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const l of map.getStyle().layers ?? []) {
      if (l.type !== "symbol" || (l as { "source-layer"?: string })["source-layer"] !== "place") continue;
      if (!/city|town|village|suburb|other|state/.test(l.id) || /country/.test(l.id)) continue;
      map.setLayoutProperty(l.id, "visibility", ownLabels ? "none" : "visible");
    }
  }, [ready, ownLabels]);

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
      const score = Math.round(c.affinity * 1000) / 10;
      if (!m) {
        const node = el(`<span class="cand-dot"></span><span class="lbl"><span class="cand-score">0.0</span><span class="cand-name">${clean(c.name)}</span></span>`, "cand",
          { role: "img", label: `${clean(c.name)}, room affinity ${score.toFixed(1)}` });
        node.dataset.score = String(score);
        node.style.setProperty("--delay", `${i * 110}ms`);
        m = { marker: new maplibregl.Marker({ element: node, anchor: "center" }).setLngLat([c.lng, c.lat]).addTo(map), node };
        markers.current.set(key, m);
      }
      const scoreEl = m.node.querySelector(".cand-score") as HTMLSpanElement;
      if (show && !m.node.classList.contains("on")) {
        m.node.classList.add("on");
        if (reducedMotion()) scoreEl.textContent = score.toFixed(1);
        else {
          const t0 = performance.now() + i * 110;
          const tick = (now: number) => {
            const k = Math.min(1, Math.max(0, (now - t0) / 750));
            scoreEl.textContent = (score * (1 - Math.pow(1 - k, 3))).toFixed(1);
            if (k < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      }
      if (!show) { m.node.classList.remove("on"); scoreEl.textContent = "0.0"; }
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
    stops.forEach((s, i) => {
      const key = `stop:${s.id}`;
      live.add(key);
      let m = markers.current.get(key);
      if (!m) {
        const node = el(`<button type="button" class="stop-pin" aria-label="Stop ${s.order}: ${clean(s.name)}">${s.order}</button><span aria-hidden="true" class="lbl stop-name">${clean(s.name)}</span>`, "stop", { role: "none" });
        node.querySelector("button")!.addEventListener("click", () => onSelect?.(s.id));
        m = { marker: new maplibregl.Marker({ element: node, anchor: "center" }).setLngLat([s.lng, s.lat]).addTo(map), node };
        settleA11y(node);
        markers.current.set(key, m);
      }
      m.marker.setLngLat([s.lng, s.lat]);
      // The number and the accessible name are updated together (the route order is final only at the end).
      const pin = m.node.querySelector(".stop-pin") as HTMLElement;
      pin.textContent = String(s.order);
      pin.setAttribute("aria-label", `Stop ${s.order}: ${clean(s.name)}`);
      m.node.classList.toggle("on", show);
      m.node.style.setProperty("--delay", `${150 + i * 120}ms`);
    });
    for (const [key, m] of markers.current) if (key.startsWith("stop:") && !live.has(key)) { m.marker.remove(); markers.current.delete(key); }
    if (!show || !map.getSource("route")) { routeRef.current = []; fitRef.current = null; (map.getSource("route") as GeoJSONSource | undefined)?.setData(fc([])); return; }

    const pts = stops.map((s) => [s.lng, s.lat] as [number, number]);
    routeRef.current = pts;
    const b = boundsOf(stops);
    // Room for the city names around the pins; scaled down when the pane is short (the compact mobile map).
    const paddingFor = () => {
      const h = map.getContainer().clientHeight, k = Math.min(1, h / 400);
      return isNarrow() ? { top: 44 * k + 8, bottom: 40 * k + 8, left: 92, right: 112 } : { top: 80, bottom: 70, left: 130, right: 150 };
    };
    const padding = paddingFor();
    const reduce = reducedMotion();
    if (b) { fitRef.current = { bounds: b, padding: paddingFor }; map.fitBounds(b, { padding, maxZoom: 8.5, duration: reduce ? 0 : 1500, essential: false }); }
    requestAnimationFrame(() => declutterRef.current());
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
    const add = (key: string, lng: number, lat: number, html: string, cls: string, label: string, onClick?: () => void) => {
      live.add(key);
      if (markers.current.has(key)) return;
      const node = el(html, cls, { role: onClick ? "button" : "img", label });
      if (onClick) {
        node.addEventListener("click", onClick);
        node.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } });
      }
      markers.current.set(key, { marker: new maplibregl.Marker({ element: node, anchor: "center" }).setLngLat([lng, lat]).addTo(map), node });
    };
    ghosts.forEach((g) => add(`ghost:${g.key}`, g.lng, g.lat, `<span class="ghost-ring"></span><span class="lbl"><span class="cand-name">${clean(g.name)} · ${(Math.round(g.affinity * 1000) / 10).toFixed(1)}</span></span>`, "ghost",
      `${clean(g.name)} ${(Math.round(g.affinity * 1000) / 10).toFixed(1)}: go to the scout's answer`,
      () => document.getElementById(g.target)?.scrollIntoView({ behavior: "smooth", block: "start" })));
    proposal?.add.forEach((c) => add(`new:${c.name}`, c.lng, c.lat, `<span class="ghost-ring new"></span><span class="lbl"><span class="cand-name">+ ${clean(c.name)}</span></span>`, "ghost new", `Proposed stop: ${clean(c.name)}`));
    for (const [key, m] of markers.current) if ((key.startsWith("ghost:") || key.startsWith("new:")) && !live.has(key)) { m.marker.remove(); markers.current.delete(key); }
    for (const [key, m] of markers.current) if (key.startsWith("stop:")) m.node.classList.toggle("removed", Boolean(proposal?.remove.includes(key.slice(5))));
    // Stop and candidate labels make room for the ghost pins just placed.
    requestAnimationFrame(() => declutterRef.current());
    // Dashed preview of the changed route: removed stops dropped, added cities joined to the nearest remaining stop.
    const src = map.getSource("preview") as GeoJSONSource | undefined;
    if (!src) return;
    if (!proposal || (!proposal.add.length && !proposal.remove.length)) { extraRef.current = []; src.setData(fc([])); return; }
    const kept = stops.filter((s) => !proposal.remove.includes(s.id));
    const legs = proposal.add.map((c) => {
      const near = kept.slice().sort((a, b) => Math.hypot(a.lat - c.lat, a.lng - c.lng) - Math.hypot(b.lat - c.lat, b.lng - c.lng))[0];
      return near ? line([[near.lng, near.lat], [c.lng, c.lat]]) : undefined;
    }).filter(Boolean) as GeoJSON.Feature[];
    src.setData(fc(legs));
    // Bring a proposed city into view (it may lie outside the route's frame).
    const fit = fitRef.current;
    extraRef.current = proposal.add.map((c) => [c.lng, c.lat]);
    if (proposal.add.length && fit) map.fitBounds(withExtra(fit.bounds), { padding: fit.padding(), maxZoom: 8.5, duration: reducedMotion() ? 0 : 900 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on ghosts and proposal
  }, [ghostKey, ready, stopKey]);

  const caption = phase === "hotspots" ? `${cells.length} fan hotspots found` : phase === "scoring" && cities.length ? `Scoring ${cities.length} cities` : phase === "route" && stops.length ? `Your ${stops.length}-stop run` : "";
  return (
    <div className="relative h-full w-full">
      <div ref={box} className="map-box h-full w-full" />
      {caption && !reduce && <p key={caption} aria-live="polite" className={`map-caption pointer-events-none ${phase === "route" ? "short" : ""}`}>{caption}</p>}
    </div>
  );
}
