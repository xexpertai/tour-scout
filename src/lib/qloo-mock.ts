/**
 * Sample data for running without a Qloo credential. Every name carries "(sample)" and every call
 * reports surface "mock", so the UI can never present it as Qloo data.
 * QLOO_MOCK_DELAY_MS adds latency per call to make streaming behave like a live run.
 */
import geohash from "ngeohash";
import type { AreaScore, Demographics, InsightsType, QEntity, QlooCall, Resolution, Tag } from "./qloo.ts";

const CITIES: Record<string, { name: string; lat: number; lng: number }[]> = {
  us: [
    { name: "Austin", lat: 30.2672, lng: -97.7431 }, { name: "Chicago", lat: 41.8781, lng: -87.6298 },
    { name: "Brooklyn", lat: 40.6782, lng: -73.9442 }, { name: "Los Angeles", lat: 34.0522, lng: -118.2437 },
    { name: "Seattle", lat: 47.6062, lng: -122.3321 }, { name: "Nashville", lat: 36.1627, lng: -86.7816 },
    { name: "Denver", lat: 39.7392, lng: -104.9903 }, { name: "Atlanta", lat: 33.749, lng: -84.388 },
  ],
  in: [
    { name: "Mumbai", lat: 19.076, lng: 72.8777 }, { name: "Bengaluru", lat: 12.9716, lng: 77.5946 },
    { name: "Pune", lat: 18.5204, lng: 73.8567 }, { name: "Delhi", lat: 28.6139, lng: 77.209 },
    { name: "Hyderabad", lat: 17.385, lng: 78.4867 }, { name: "Goa", lat: 15.4909, lng: 73.8278 },
    { name: "Kolkata", lat: 22.5726, lng: 88.3639 }, { name: "Chennai", lat: 13.0827, lng: 80.2707 },
  ],
  uk: [
    { name: "London", lat: 51.5072, lng: -0.1276 }, { name: "Manchester", lat: 53.4808, lng: -2.2426 },
    { name: "Glasgow", lat: 55.8642, lng: -4.2518 }, { name: "Bristol", lat: 51.4545, lng: -2.5879 },
    { name: "Leeds", lat: 53.8008, lng: -1.5491 }, { name: "Brighton", lat: 50.8225, lng: -0.1372 },
  ],
};
const ALL_CITIES = Object.values(CITIES).flat();
const FAMOUS = /taylor swift|coldplay|beyonc|cedric the entertainer|ed sheeran|drake|arijit singh/i;

function regionOf(location = ""): keyof typeof CITIES {
  const l = location.toLowerCase();
  if (/india|mumbai|bengaluru|bangalore|pune|delhi|hyderabad|goa|kolkata|chennai/.test(l)) return "in";
  if (/united kingdom|\buk\b|england|scotland|london|manchester|glasgow|bristol|leeds|brighton/.test(l)) return "uk";
  return "us";
}
const cityIn = (location = "") => ALL_CITIES.find((c) => location.toLowerCase().includes(c.name.toLowerCase()));

function seeded(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507)) >>> 0) / 4294967296;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const slug = (s: string) => s.toLowerCase().replace(/\W+/g, "_");
const sample = (name: string) => `${name} (sample)`;

async function delayed<T>(value: T): Promise<T> {
  const ms = Number(process.env.QLOO_MOCK_DELAY_MS) || 0;
  if (ms) await new Promise((r) => setTimeout(r, ms * (0.5 + Math.random())));
  return value;
}
const call = (workflow: string, resultCount: number): QlooCall => ({ workflow, surface: "mock", status: "ok", summary: "Sample data (no Qloo credential configured)", requests: [], resultCount });

const NAMES: Partial<Record<InsightsType, string[]>> = {
  artist: ["Phoebe Bridgers", "Japanese Breakfast", "Bon Iver", "Mitski", "Big Thief", "Prateek Kuhad", "Khruangbin", "Men I Trust"],
  person: ["John Mulaney", "Ali Wong", "Hasan Minhaj", "Taylor Tomlinson", "Zakir Khan", "Bo Burnham"],
  brand: ["Patagonia", "Fujifilm", "Aesop", "Carhartt WIP", "Moleskine", "Polaroid"],
  movie: ["Lost in Translation", "Before Sunrise", "Frances Ha", "Her", "Lady Bird"],
  tv_show: ["The Bear", "Fleabag", "Atlanta", "Abbott Elementary"],
  book: ["Norwegian Wood", "Just Kids", "Normal People"],
  podcast: ["Song Exploder", "Comedy Bang! Bang!"],
};
const VENUES = ["The Echo Room", "Lantern Hall", "Basement Social", "The Velvet Note", "Corner Stage", "Sidecar Club"];

export const mock = {
  async findTags(q: string): Promise<{ tags: Tag[]; call: QlooCall }> {
    const tags = q.split(/[,+&/]| and | with /).map((w) => w.trim()).filter(Boolean).slice(0, 4)
      .map((w) => ({ id: `urn:tag:sample:${slug(w)}`, name: sample(w), type: "sample" }));
    return delayed({ tags, call: call("find_tags", tags.length) });
  },

  async describe(name: string, type?: string): Promise<Resolution> {
    if (/^(unknown|my band|not on qloo)/i.test(name)) return delayed({ status: "not_found" as const, call: call("describe", 0) });
    if (/^genesis$/i.test(name.trim())) {
      return delayed({
        status: "ambiguous" as const,
        candidates: [
          { id: "sample-artist-genesis-band", name: sample("Genesis"), type: "urn:entity:artist", popularity: 0.95, description: "English rock band (sample)" },
          { id: "sample-artist-genesis-owusu", name: sample("Genesis Owusu"), type: "urn:entity:artist", popularity: 0.71, description: "Australian musician (sample)" },
        ],
        call: call("describe", 2),
      });
    }
    const rnd = seeded(name);
    const entity: QEntity = {
      id: `sample-${type ?? "artist"}-${slug(name)}`, name: sample(name), type: `urn:entity:${type ?? "artist"}`,
      popularity: FAMOUS.test(name) ? 0.995 : round2(0.6 + rnd() * 0.3), description: "Sample entity (no Qloo credential configured)",
    };
    return delayed({ status: "resolved" as const, entity, call: call("describe", 1) });
  },

  async entityTags(ids: string[]): Promise<{ tags: Tag[]; call: QlooCall }> {
    const rnd = seeded(ids.join());
    const tags = ["Indie folk", "Dream pop", "Singer-songwriter", "Lo-fi", "Alternative"].map((n, i) => ({
      id: `urn:tag:sample:${slug(n)}`, name: sample(n), type: "genre", affinity: round2(0.95 - i * 0.08 - rnd() * 0.03),
    }));
    return delayed({ tags, call: call("entity_tags", tags.length) });
  },

  async recommend(p: { targetType: InsightsType; signals?: string[]; tagIds?: string[]; filterLocation?: string; signalLocation?: string; limit?: number }) {
    const rnd = seeded(`${p.targetType}:${p.filterLocation ?? ""}:${p.signalLocation ?? ""}:${(p.signals ?? p.tagIds ?? []).join()}`);
    const limit = p.limit ?? 8;
    let entities: QEntity[];
    if (p.targetType === "locality") {
      entities = CITIES[regionOf(p.filterLocation)].map((c, i) => ({
        id: `sample-locality-${slug(c.name)}`, name: sample(c.name), type: "urn:entity:locality",
        lat: c.lat, lng: c.lng, affinity: round2(0.96 - i * 0.06 - rnd() * 0.03),
      }));
    } else if (p.targetType === "place") {
      const center = cityIn(p.filterLocation) ?? CITIES.us[0];
      entities = VENUES.map((v, i) => ({
        id: `sample-place-${slug(center.name)}-${i}`, name: sample(v), type: "urn:entity:place",
        lat: center.lat + (rnd() - 0.5) * 0.04, lng: center.lng + (rnd() - 0.5) * 0.04,
        address: `${center.name} (sample address)`, affinity: round2(0.9 - i * 0.07 - rnd() * 0.03), rating: round2(4 + rnd()),
      }));
    } else {
      const pool = NAMES[p.targetType] ?? NAMES.artist!;
      const offset = Math.floor(rnd() * pool.length);
      entities = pool.map((_, i) => pool[(i + offset) % pool.length]).map((n, i) => ({
        id: `sample-${p.targetType}-${slug(n)}`, name: sample(n), type: `urn:entity:${p.targetType}`, affinity: round2(0.92 - i * 0.06 - rnd() * 0.03),
      }));
    }
    return delayed({ entities: entities.slice(0, limit), call: call("recommend", Math.min(limit, entities.length)) });
  },

  async rank(p: { options: string[]; optionType: InsightsType; signals: string[] }) {
    const rnd = seeded(`${p.options.join()}:${p.signals.join()}`);
    const entities = p.options.map((name) => {
      const c = cityIn(name);
      return { id: `sample-${p.optionType}-${slug(name)}`, name: sample(name), type: `urn:entity:${p.optionType}`, lat: c?.lat, lng: c?.lng, affinity: round2(0.5 + rnd() * 0.45) };
    }).sort((a, b) => b.affinity - a.affinity);
    return delayed({ entities, call: call("rank", entities.length) });
  },

  async heatmap(key: string, workflow: string): Promise<{ cells: AreaScore[]; call: QlooCall }> {
    const center = cityIn(key) ?? CITIES.us[0];
    const rnd = seeded(key);
    const cells = Array.from({ length: 25 }, (_, i) => {
      const lat = center.lat + (Math.floor(i / 5) - 2) * 0.02, lng = center.lng + ((i % 5) - 2) * 0.02;
      return { geohash: geohash.encode(lat, lng, 6), lat, lng, affinity: round2(rnd()), popularity: round2(rnd()) };
    });
    return delayed({ cells, call: call(workflow, cells.length) });
  },

  async demographics(): Promise<{ demographics: Demographics; call: QlooCall }> {
    return delayed({
      demographics: { age: { "24_and_younger": 0.21, "25_to_29": 0.34, "30_to_34": 0.12, "35_to_44": -0.08, "45_to_54": -0.26, "55_and_older": -0.4 }, gender: { male: -0.03, female: 0.03 } },
      call: call("audience_demographics", 1),
    });
  },

  async compare(): Promise<{ shared: string[]; call: QlooCall }> {
    const shared = ["Indie folk", "Bedroom pop", "Vinyl collecting", "Small-venue gigs"].map(sample);
    return delayed({ shared, call: call("compare_audiences", shared.length) });
  },
};
