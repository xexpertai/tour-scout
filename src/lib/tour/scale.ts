/**
 * Qloo popularity is a 0–1 percentile across all entities of the type; above this an artist plays
 * arenas, not clubs. Calibrated on live data (M0, 6 Oct 2026): Taylor Swift 0.9998, Mitski 0.997,
 * Phoebe Bridgers 0.994, Big Thief 0.991 (theatres), Mark Normand 0.860 (clubs).
 * Client-safe (no Node imports), so the UI and the server share one threshold.
 */
export const ARENA_POPULARITY = 0.999;
