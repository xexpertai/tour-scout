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
  { slug: "us-comedian", artist: "Mark Normand", kind: "person", region: "United States", stops: 4, flyer: { headline: "Mark Normand", sub: "Stand-up · 4 US stops" } },
  { slug: "uk-emerging", artist: "Night Swim", kind: "artist", soundsLike: ["Mitski", "Men I Trust"], region: "United Kingdom", stops: 3, capacity: [80, 250], flyer: { headline: "Night Swim", sub: "Emerging act · sounds like Mitski, Men I Trust" } },
  { slug: "us-arena", artist: "Taylor Swift", kind: "artist", region: "United States", stops: 5, flyer: { headline: "Taylor Swift", sub: "Arena-scale test · where the fans are" } },
];

/** A captured run: the event stream with arrival offsets, replayed by the UI. */
export type CapturedRun = {
  slug: string;
  capturedAt: string;
  qloo: "live" | "mock";
  llm: string;
  events: { at: number; event: unknown }[];
};
