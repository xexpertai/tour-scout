/** Demo presets: shown as gig flyers on the landing page and replayed from captured runs (no API calls). */
import type { ArtistKind, TourPlan } from "./types.ts";

export type Preset = {
  slug: string;
  /** The act as typed into search; emerging presets name their own act and use `soundsLike` as proxies. */
  artist: string;
  kind: ArtistKind;
  soundsLike?: string[];
  region: string;
  stops: number;
  capacity?: [number, number];
  flyer: { headline: string; sub: string };
  /** Poster line of the captured route's cities, in route order (kept in sync by a test). */
  bill?: string[];
  /** Styled apart on the landing page: a stress test, not a recommendation. */
  stressTest?: boolean;
};

export const PRESETS: Preset[] = [
  { slug: "us-indie-band", artist: "Big Thief", kind: "artist", region: "United States", stops: 5, capacity: [300, 900], bill: ["Burlington", "Albany", "Northampton", "Boston", "Portland ME"], flyer: { headline: "Big Thief", sub: "Indie band · 5 US stops" } },
  { slug: "us-comedian", artist: "Mark Normand", kind: "person", region: "United States", stops: 4, bill: ["Denver", "Austin", "Providence", "Burlington"], flyer: { headline: "Mark Normand", sub: "Stand-up · 4 US stops" } },
  { slug: "uk-emerging", artist: "Night Swim", kind: "artist", soundsLike: ["Mitski", "Men I Trust"], region: "United Kingdom", stops: 3, capacity: [80, 250], bill: ["London", "Oxford", "Manchester"], flyer: { headline: "Night Swim", sub: "Emerging act · sounds like Mitski, Men I Trust" } },
];

/** A captured run: the event stream with arrival offsets, replayed by the UI. */
export type CapturedRun = {
  slug: string;
  capturedAt: string;
  qloo: "live" | "mock";
  llm: string;
  events: { at: number; event: unknown }[];
  /** One recorded "Ask the scout" exchange, replayed at no cost when its suggestion is tapped. */
  scout?: { question: string; recordedAt: string; events: { at: number; event: unknown }[] };
};

const firstStop = (plan: Pick<TourPlan, "stops">) => [...plan.stops].sort((a, b) => a.order - b.order)[0]?.city.name.replace(/\s*\(sample\)$/, "");
/** The suggestion recorded for each preset; the UI offers the same text as its first suggestion. */
export const presetScoutQuestion = (plan: Pick<TourPlan, "stops" | "artist">) =>
  plan.artist.arenaScale || !firstStop(plan) ? "Swap the weakest stop for a stronger city" : `Who's a good opener in ${firstStop(plan)} with crossover fans?`;
