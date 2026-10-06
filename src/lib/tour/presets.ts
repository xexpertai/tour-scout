/** Demo presets: shown as gig flyers on the landing page and replayed from captured runs (no API calls). */
import type { ArtistKind } from "./types.ts";

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
};

export const PRESETS: Preset[] = [
  { slug: "us-indie-band", artist: "Big Thief", kind: "artist", region: "United States", stops: 5, capacity: [300, 900], flyer: { headline: "Big Thief", sub: "Indie band · 5 US stops" } },
  { slug: "us-comedian", artist: "Cedric the Entertainer", kind: "person", region: "United States", stops: 4, flyer: { headline: "Cedric the Entertainer", sub: "Stand-up · 4 US stops" } },
  { slug: "india-indie", artist: "Prateek Kuhad", kind: "artist", region: "India", stops: 4, capacity: [200, 600], flyer: { headline: "Prateek Kuhad", sub: "Indie singer-songwriter · 4 India stops" } },
  { slug: "uk-emerging", artist: "Night Swim", kind: "artist", soundsLike: ["Mitski", "Men I Trust"], region: "United Kingdom", stops: 3, capacity: [80, 250], flyer: { headline: "Night Swim", sub: "Emerging act · sounds like Mitski, Men I Trust" } },
];

/** A captured run: the event stream with arrival offsets, replayed by the UI. */
export type CapturedRun = {
  slug: string;
  capturedAt: string;
  qloo: "live" | "mock";
  llm: string;
  events: { at: number; event: unknown }[];
};
