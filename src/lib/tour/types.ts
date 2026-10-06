/**
 * Tour Scout domain types. Qloo-derived values are filled by the server from the evidence ledger;
 * the model contributes only `Insight` text (see guard.ts for the provenance labels).
 */
import type { Insight, Withheld } from "../guard.ts";
import type { Source } from "../evidence.ts";
import type { Demographics } from "../qloo.ts";

export type ArtistKind = "artist" | "person";
export type ArtistRef = { id: string; name: string; type: ArtistKind; popularity?: number };

export type TourInput = {
  /** The confirmed Qloo entity, or null in emerging-artist mode. */
  artist: ArtistRef | null;
  /** Emerging-artist mode: the artist's own name plus 1–3 confirmed "sounds like" proxies. */
  emerging?: { name: string; proxies: ArtistRef[] };
  /** Country or region to scout, e.g. "United States". Ignored when candidateCities is set. */
  region?: string;
  /** User-supplied shortlist of cities, ranked with Qloo `rank` instead of discovered. */
  candidateCities?: string[];
  stops: number;
  /** User-provided context only: Qloo has no venue capacity data. */
  capacity?: [number, number];
};

/**
 * A candidate stop. `affinity` is the city's best room affinity: Qloo's affinity (0–1) between the
 * audience and the best-matching live room in that city, comparable across cities because it is
 * the same signal scored against places. `hotspot` is set when the country-wide fan heatmap has a
 * hotspot cell within reach of the city. `rooms` are the rooms behind the score.
 */
export type City = {
  entityId: string; name: string; affinity: number; lat?: number; lng?: number; evidence: string;
  /** Qloo location query used for this city's calls, e.g. "Portland, Oregon". */
  query?: string;
  hotspot?: { affinity: number; cells: number; evidence: string };
  rooms?: VenueRef[];
  /** How many of Qloo's rooms were dropped as unlikely venues or outside the city. */
  droppedRooms?: number;
};
export type Cluster = { name: string; lat: number; lng: number; affinity: number; evidence: string };
export type VenueRef = { entityId: string; name: string; address?: string; area?: string; affinity?: number; lat?: number; lng?: number; evidence: string };
export type Opener = { entityId: string; name: string; affinity?: number; evidence: string; overlap?: { shared: string[]; evidence: string } };

/** Qloo data for one stop, streamed as soon as its calls finish. */
export type StopData = {
  stopId: string;
  rank: number;
  city: City;
  cluster?: Cluster;
  venues: VenueRef[];
  opener?: Opener;
};

export type FanProfile = {
  tags: { id: string; name: string; affinity?: number; evidence: string }[];
  demographics?: Demographics & { evidence: string };
  alsoLikes: { domain: "brand" | "movie" | "tv_show"; items: { name: string; affinity?: number }[]; evidence: string }[];
};

/**
 * How the cities were found, so the UI can say when data is thin. `hotspotCells` counts the
 * country-wide heatmap cells, `remoteCells` those far from any touring market, and
 * `roomFallback` is true when markets were added from room affinity because hotspots were too few.
 */
export type Coverage = { basis: "hotspots" | "shortlist"; region?: string;
  /** The country-wide hotspot cells themselves (for the map's fan heat), strongest first. */
  cells?: { lat: number; lng: number; affinity: number }[];
  /** Rooms dropped as unlikely venues or outside the city (e.g. a farm 20 km away), per city. */
  droppedRooms?: number; hotspotCells: number; remoteCells: number; hotspotMarkets: number; roomFallback: boolean; scored: number; unscored: string[]; evidence?: string; limited: boolean };

export type TourStop = StopData & { order: number; why?: Insight; pitch?: Insight };

export type TourPlan = {
  id: string;
  createdAt: string;
  mode: { qloo: "live" | "mock" | "cached"; llm: string };
  artist: { name: string; entityId?: string; type: ArtistKind; popularity?: number; arenaScale: boolean; proxyOf?: string[] };
  /** Qloo entity ids used as the taste signal (the artist, or the proxies in emerging mode). */
  signals: string[];
  inputs: { region?: string; candidateCities?: string[]; stops: number; capacity?: [number, number] };
  fan: FanProfile;
  stops: TourStop[];
  /** Every city Qloo scored for this run (stops and runners-up), best first, without rooms. */
  candidates?: City[];
  coverage?: Coverage;
  summary?: Insight;
  theme: Insight[];
  merch: Insight[];
  risks: Insight[];
  sources: Source[];
  withheld: Withheld[];
  timings: { phaseAMs: number; synthesisMs: number; totalMs: number };
  followUps?: FollowUp[];
  /** The plan this one was derived from by applying a scout proposal. */
  parentId?: string;
};

/** A city the answer is about, drawn on the map as a dashed "ghost" pin. */
export type GhostPin = { name: string; lat: number; lng: number; affinity: number; evidence: string };

/** A change the scout proposes; nothing changes until the user applies it. */
export type PlanDiff = {
  add: City[];
  remove: string[];
  opener?: { stopId: string; opener: Opener };
  /** Human summary like "+ Nashville (78) · − Los Angeles (58)". */
  summary: string;
};

/**
 * A question about the plan, answered with fresh Qloo calls and appended to it:
 * "quick" is the deterministic "why not <city>?" path; "agent" is the tool-using scout.
 */
export type FollowUp = {
  kind: "quick" | "agent";
  question: string;
  city?: string;
  rank?: number;
  of?: number;
  affinity?: number;
  cluster?: { name: string; affinity: number; evidence: string };
  answer: Insight;
  pins: GhostPin[];
  proposal?: PlanDiff;
  /** Set once applied: the id of the plan the change produced. */
  appliedAs?: string;
  sources: Source[];
  askedAt: string;
  /** Which model ran the agent, e.g. "claude" or "scripted". */
  by?: string;
};

export type AskEvent =
  | { type: "forked"; planId: string }
  | { type: "checking"; label: string }
  | Extract<TourEvent, { type: "source" | "step" }>
  | { type: "answer"; followUp: FollowUp }
  | { type: "error"; message: string; code?: string };

export type TourEvent =
  | { type: "mode"; qloo: "live" | "mock"; llm: string; reason: string }
  | { type: "reused"; createdAt: string }
  | { type: "source"; source: Source }
  | { type: "step"; label: string; evidence?: string[]; failed?: boolean }
  | { type: "fan"; fan: FanProfile }
  | { type: "cities"; cities: City[]; coverage?: Coverage }
  | { type: "stop"; stop: StopData }
  | { type: "writing"; llm: string }
  | { type: "summary"; summary: Insight }
  | { type: "stop_text"; stopId: string; why?: Insight; pitch?: Insight }
  | { type: "llm_fallback"; from: string; reason: string }
  | { type: "plan"; plan: TourPlan }
  | { type: "error"; message: string; code?: string; retryable?: boolean };
