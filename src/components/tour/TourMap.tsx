"use client";

import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { clean, useIsDark } from "./atoms";

export type MapCity = { id: string; name: string; lat: number; lng: number; affinity: number };
export type MapStop = { id: string; order: number; name: string; lat: number; lng: number };
/** A place a scout answer talks about: dashed "ghost" pin that jumps to its answer card. */
export type MapGhost = { key: string; name: string; lat: number; lng: number; affinity: number; target: string };

/** Leaflet needs to be told when its container resizes (the mobile map shrinks on scroll). */
function Resize() {
  const map = useMap();
  useEffect(() => {
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);
  return null;
}

// OpenStreetMap's standard tiles need no key; the dark theme re-inks them with a CSS filter (globals.css).
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Keeps every city in view; refits only when the set of points changes, not on every render. */
function FitTo({ points }: { points: [number, number][] }) {
  const map = useMap();
  const key = points.map((p) => p.join()).join("|");
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) map.flyTo(points[0], 11, { duration: 0.8 });
    else map.flyToBounds(L.latLngBounds(points), { padding: [36, 36], duration: 0.8, maxZoom: 11 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refit only when the point set changes
  }, [key]);
  return null;
}

function FlyToActive({ stop }: { stop?: MapStop }) {
  const map = useMap();
  useEffect(() => {
    if (stop) map.flyTo([stop.lat, stop.lng], Math.max(map.getZoom(), 9), { duration: 0.7 });
  }, [stop, map]);
  return null;
}

/** The route draws itself from stop 1 to N whenever the stop sequence changes. */
function Route({ stops }: { stops: MapStop[] }) {
  const ref = useRef<L.Polyline | null>(null);
  const positions = useMemo(() => stops.map((s) => [s.lat, s.lng] as [number, number]), [stops]);
  const key = stops.map((s) => s.id).join("-");
  useEffect(() => {
    const path = ref.current?.getElement() as SVGPathElement | undefined;
    if (!path) return;
    path.style.setProperty("--len", String(Math.ceil(path.getTotalLength())));
    path.classList.remove("drawing");
    void path.getBoundingClientRect(); // restart the animation
    path.classList.add("drawing");
  }, [key]);
  if (stops.length < 2) return null;
  return <Polyline key={key} ref={ref} positions={positions} pathOptions={{ className: "route-line", weight: 3, opacity: 0.95, lineCap: "round", color: "#ff2e88" }} />;
}

/**
 * `activeId` only highlights a pin (it follows the scroll); `focusId` is set when the user picks a
 * stop and is the only thing that moves the camera, so the whole route stays in view otherwise.
 */
const RADIUS = (affinity: number) => 7 + affinity * 13;

// Icons are cached so re-renders (e.g. while the scout streams) don't replace pin elements,
// which would restart their pop-in animation and make them flicker.
const icons = new Map<string, L.DivIcon>();
function pinIcon(order: number, active: boolean): L.DivIcon {
  const key = `${order}:${active}`;
  let icon = icons.get(key);
  if (!icon) {
    icon = L.divIcon({ className: "", html: `<div class="stop-pin${active ? " active" : ""}">${order}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
    icons.set(key, icon);
  }
  return icon;
}

export default function TourMap({ cities, stops, ghosts = [], activeId, focusId, onSelect }: { cities: MapCity[]; stops: MapStop[]; ghosts?: MapGhost[]; activeId?: string; focusId?: string; onSelect?: (id: string) => void }) {
  const dark = useIsDark();
  const points = useMemo(() => (stops.length ? stops : cities).map((p) => [p.lat, p.lng] as [number, number]), [stops, cities]);
  const focus = stops.find((s) => s.id === focusId);
  return (
    <MapContainer center={[39.5, -98.35]} zoom={4} zoomControl={false} scrollWheelZoom={false} attributionControl className={`h-full w-full ${dark ? "map-dark" : ""}`}>
      <TileLayer url={TILES} attribution={ATTRIBUTION} maxZoom={19} />
      <FitTo points={points} />
      <Resize />
      <FlyToActive stop={focus} />
      {cities.map((c) => {
        // Cities Qloo ranked but the route skips stay faint, with a tooltip saying so.
        const onRoute = !stops.length || stops.some((s) => s.name === c.name);
        return (
          <CircleMarker key={`g-${c.id}`} center={[c.lat, c.lng]} radius={RADIUS(c.affinity)}
            pathOptions={{ stroke: false, fillColor: "#ff6b1a", fillOpacity: onRoute ? 0.3 + c.affinity * 0.4 : 0.12, className: "glow-circle" }} />
        );
      })}
      {cities.filter((c) => stops.length && !stops.some((s) => s.name === c.name)).map((c) => (
        <CircleMarker key={`d-${c.id}`} center={[c.lat, c.lng]} radius={4} pathOptions={{ color: "#ffd2b0", weight: 1, opacity: 0.5, fillOpacity: 0 }}>
          <Tooltip direction="top" offset={[0, -6]}>{clean(c.name)} · {Math.round(c.affinity * 100)} · not on this route</Tooltip>
        </CircleMarker>
      ))}
      {ghosts.map((g) => (
        <CircleMarker key={`ghost-${g.key}`} center={[g.lat, g.lng]} radius={11}
          pathOptions={{ color: "#ff2e88", weight: 2, dashArray: "4 4", fillColor: "#ff2e88", fillOpacity: 0.12 }}
          eventHandlers={{ click: () => document.getElementById(g.target)?.scrollIntoView({ behavior: "smooth", block: "start" }) }}>
          <Tooltip direction="top" offset={[0, -10]}>{clean(g.name)} · {Math.round(g.affinity * 100)} · from the scout</Tooltip>
        </CircleMarker>
      ))}
      <Route stops={stops} />
      {stops.map((s) => (
        <Marker
          key={`p-${s.id}`}
          position={[s.lat, s.lng]}
          eventHandlers={{ click: () => onSelect?.(s.id) }}
          keyboard
          title={`Stop ${s.order}: ${clean(s.name)}`}
          icon={pinIcon(s.order, s.id === activeId)}
        >
          {/* A permanent name, so a pin is never read as the nearest basemap label. */}
          <Tooltip permanent direction="right" offset={[16, 0]} className="stop-label">{clean(s.name)}</Tooltip>
        </Marker>
      ))}
    </MapContainer>
  );
}
