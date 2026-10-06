/** Where the plan on screen comes from, stated precisely (the line under the act's name). */
export type BaseOrigin =
  | { kind: "live" }
  | { kind: "reused"; createdAt: string }
  | { kind: "preset"; slug: string; capturedAt: string }
  | { kind: "shared"; createdAt: string };
/** A captured, shared or reused plan changed by the scout. `live`: the change itself used live Qloo calls. */
export type RunOrigin = BaseOrigin | { kind: "edited"; base: Exclude<BaseOrigin, { kind: "live" }>; live: boolean };

export const baseOrigin = (o: RunOrigin | undefined): BaseOrigin | undefined => (o?.kind === "edited" ? o.base : o);

/** The origin after a scout change: a live run stays live; anything else keeps its base and says it was changed. */
export function editedOrigin(o: RunOrigin | undefined, live: boolean): RunOrigin {
  if (!o || o.kind === "live") return { kind: "live" };
  if (o.kind === "edited") return { ...o, live: o.live || live };
  return { kind: "edited", base: o, live };
}

export function sourceLabel(o: RunOrigin | undefined, date: (iso: string) => string): string {
  const b = baseOrigin(o);
  const base = b?.kind === "preset" ? `Captured from live Qloo data on ${date(b.capturedAt)}`
    : b?.kind === "shared" ? `Shared plan from live Qloo data, ${date(b.createdAt)}`
    : b?.kind === "reused" ? `Same tour planned earlier (${date(b.createdAt)}), live Qloo data`
    : "Live Qloo data";
  if (o?.kind !== "edited") return base;
  return `${base} · ${o.live ? "scout change from live Qloo data" : "scout change applied"}`;
}
