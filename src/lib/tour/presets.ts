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

/**
 * Order is the landing's poster order. The lead is emerging-act mode: a fictional first-tour act
 * planned from the fans of a real, small artist it sounds like (the video's "Maya").
 */
export const PRESETS: Preset[] = [
  { slug: "us-emerging", artist: "Maya", kind: "artist", soundsLike: ["Joanna Sternberg"], region: "United States", stops: 5, capacity: [100, 300], bill: ["Boston", "Burlington", "Albany", "New York", "Philadelphia"], flyer: { headline: "Maya", sub: "Fictional first-tour act · sounds like Joanna Sternberg" } },
  { slug: "us-comedian", artist: "Joe List", kind: "person", region: "United States", stops: 5, capacity: [150, 400], bill: ["Washington, DC", "Philadelphia", "New York", "Providence", "Boston"], flyer: { headline: "Joe List", sub: "Stand-up · comedy clubs" } },
  { slug: "us-americana", artist: "S.G. Goodman", kind: "artist", region: "United States", stops: 5, capacity: [200, 500], bill: ["Asheville", "Nashville", "Louisville", "Cincinnati", "Indianapolis"], flyer: { headline: "S.G. Goodman", sub: "Americana · club run" } },
];
/** The preset the landing preview, the docs excerpt and the video use. */
export const LEAD_PRESET = "us-emerging";

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
/**
 * The agent route check: run automatically when a plan is finished (the deterministic plan, then an
 * agent that uses Qloo tools to test it and propose a revision). Recorded for each preset.
 */
export const routeCheckQuestion = (plan: Pick<TourPlan, "artist">) =>
  `Check this route: is there a stronger city within a day's drive, or a better ${plan.artist.proxyOf?.length ? "support act" : "opener"}?`;
export const isRouteCheck = (q?: string) => Boolean(q?.startsWith("Check this route:"));
/** The question recorded for each preset (the route check); kept for older callers. */
export const presetScoutQuestion = (plan: Pick<TourPlan, "stops" | "artist">) => (firstStop(plan) ? routeCheckQuestion(plan) : "Swap the weakest stop for a stronger city");
