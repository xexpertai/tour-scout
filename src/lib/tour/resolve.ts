/** Step 1 of the flow: turn a typed name into a confirmed Qloo entity, or candidates for the user to pick. */
import { describeEntity, type QEntity, type QlooCall } from "../qloo.ts";
import { ARENA_POPULARITY } from "./pipeline.ts";
import type { ArtistKind } from "./types.ts";

export type Candidate = QEntity & { arenaScale: boolean };
export type ResolveResult =
  | { status: "resolved"; candidates: Candidate[]; call: QlooCall }
  | { status: "ambiguous"; candidates: Candidate[]; call: QlooCall }
  | { status: "not_found"; candidates: []; call: QlooCall };

const withScale = (e: QEntity): Candidate => ({ ...e, arenaScale: (e.popularity ?? 0) >= ARENA_POPULARITY });

/**
 * Even a single match is returned as a candidate: the UI always asks "Did you mean X?" before
 * scouting, because the entity choice changes every later result.
 */
export async function resolveArtist(name: string, kind: ArtistKind): Promise<ResolveResult> {
  const r = await describeEntity(name, kind);
  if (r.status === "resolved") return { status: "resolved", candidates: [withScale(r.entity)], call: r.call };
  if (r.status === "ambiguous") return { status: "ambiguous", candidates: r.candidates.map(withScale), call: r.call };
  return { status: "not_found", candidates: [], call: r.call };
}
