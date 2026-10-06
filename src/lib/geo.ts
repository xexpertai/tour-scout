/**
 * Reverse geocoding via OpenStreetMap Nominatim, so area names come from map data rather than the model.
 * Follows the Nominatim usage policy: at most one request per second, an identifying User-Agent,
 * and results cached (in memory and on disk) so repeated demos do not re-query.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// DATA_DIR is the writable volume in the container; locally the cache lives in .cache/.
const CACHE_FILE = path.join(process.env.DATA_DIR || path.join(process.cwd(), ".cache"), "nominatim.json");
const USER_AGENT = process.env.NOMINATIM_USER_AGENT || "neighbourhood-taste-advisor/0.1 (Qloo hackathon project)";
const MIN_INTERVAL_MS = 1100;

let cache: Map<string, string> | undefined;
async function loadCache(): Promise<Map<string, string>> {
  if (!cache) {
    try {
      cache = new Map(Object.entries(JSON.parse(await readFile(CACHE_FILE, "utf8"))));
    } catch {
      cache = new Map();
    }
  }
  return cache;
}
async function saveCache(map: Map<string, string>) {
  try {
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // The cache is an optimisation; a read-only filesystem must not break the request.
  }
}

// Serialises every outbound request so concurrent agent runs still respect the 1 req/s limit.
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  queue = next.catch(() => undefined);
  return next;
}

const offline = () => process.env.GEO_OFFLINE === "1";
// Bumped when the naming rules change, so cached names from older rules are looked up again.
const NAME_VERSION = "v2";
/** Administrative labels people don't use for an area ("Brooklyn Community District 17", "H/W Ward"). */
const ADMIN_NAME = /\b(community district|district \d+|ward|zone \d+|census|precinct|borough \d+)\b/i;

/** Picks the name locals use: neighbourhood → suburb → quarter → village/town, admin districts last. */
export function pickAreaName(address: Record<string, string | undefined>, fallback: string): string {
  const candidates = [address.neighbourhood, address.suburb, address.quarter, address.village, address.town, address.city_district]
    .filter((n): n is string => Boolean(n && n.trim()));
  return candidates.find((n) => !ADMIN_NAME.test(n)) ?? candidates[0] ?? fallback;
}

/** Neighbourhood name for a point; falls back to rounded coordinates when Nominatim has no answer. */
export async function areaName(lat: number, lng: number): Promise<string> {
  const coords = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (offline()) return coords;
  const key = `${NAME_VERSION}:${coords}`;
  const map = await loadCache();
  const hit = map.get(key);
  if (hit) return hit;
  try {
    const data = await throttled(async () => {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=15&lat=${lat}&lon=${lng}`, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Nominatim ${res.status}`);
      return res.json();
    });
    const name = pickAreaName(data.address ?? {}, data.name || coords);
    map.set(key, name);
    await saveCache(map);
    return name;
  } catch {
    return coords;
  }
}

/** Coordinates for a city name, for Qloo localities that come back without a geocode. */
export async function geocodeCity(name: string): Promise<{ lat: number; lng: number } | undefined> {
  if (offline()) return undefined;
  const key = `city:${name.toLowerCase()}`;
  const map = await loadCache();
  const hit = map.get(key);
  if (hit) {
    const [lat, lng] = hit.split(",").map(Number);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
  }
  try {
    const data = await throttled(async () => {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(name)}`, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Nominatim ${res.status}`);
      return res.json();
    });
    const first = Array.isArray(data) ? data[0] : undefined;
    if (!first) return undefined;
    const point = { lat: Number(first.lat), lng: Number(first.lon) };
    map.set(key, `${point.lat},${point.lng}`);
    await saveCache(map);
    return point;
  } catch {
    return undefined;
  }
}
