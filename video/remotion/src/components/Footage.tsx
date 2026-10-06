import { AbsoluteFill, interpolate, OffthreadVideo, staticFile, useCurrentFrame } from "remotion";
import { C, ease, sans } from "../theme";
import { FPS, Rect, TAKES } from "../data";

/** A camera view onto the take: the top-left corner and width in take pixels (height follows the frame). */
export type View = { x: number; y: number; w: number };
/** Move to `view` starting at `t` (s from shot start) over `dur` seconds. */
export type Key = { t: number; view: View; dur?: number };
export type CalloutSpec = { text: string; target: Rect; at: number; until?: number; side: "left" | "right" | "top" | "bottom"; box?: boolean; line?: boolean; pill?: { x: number; y: number } };
/** Dims everything outside `rect` (take px) from `at` (s), to focus on one element. */
export type Spot = { rect: Rect; at: number; pad?: number };

/** A view centred on a rect with padding, at the frame's aspect ratio, clamped to the take. */
export function around(take: string, r: Rect, pad = 80, aspect = 1920 / 990, minW = 1440): View {
  const T = TAKES[take];
  let w = Math.max(r.width + 2 * pad, (r.height + 2 * pad) * aspect, minW);
  w = Math.min(w, T.width);
  const h = w / aspect;
  const x = Math.min(Math.max(r.x + r.width / 2 - w / 2, 0), T.width - w);
  const y = Math.min(Math.max(r.y + r.height / 2 - h / 2, 0), Math.max(0, T.height - h));
  return { x, y, w };
}

export const full = (take: string): View => ({ x: 0, y: 0, w: TAKES[take].width });

function viewAt(keys: Key[], t: number): View {
  let v = keys[0].view;
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i];
    const d = k.dur ?? 0.9;
    if (t <= k.t) break;
    const p = ease(Math.min(1, (t - k.t) / d));
    v = { x: v.x + (k.view.x - v.x) * p, y: v.y + (k.view.y - v.y) * p, w: v.w + (k.view.w - v.w) * p };
  }
  return v;
}

export const Footage = ({ take, from, rate = 1, keys, callouts = [], width = 1920, height = 990, dim = 0, spot }: {
  take: string; from: number; rate?: number; keys: Key[]; callouts?: CalloutSpec[]; width?: number; height?: number; dim?: number; spot?: Spot;
}) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const T = TAKES[take];
  const v = viewAt(keys, t);
  const s = width / v.w;
  const toFrame = (r: Rect) => ({ x: (r.x - v.x) * s, y: (r.y - v.y) * s, width: r.width * s, height: r.height * s });
  return (
    <AbsoluteFill style={{ width, height, overflow: "hidden", background: C.bg }}>
      <div style={{ position: "absolute", left: -v.x * s, top: -v.y * s, width: T.width * s, height: T.height * s }}>
        <OffthreadVideo src={staticFile(`footage/${T.file}`)} startFrom={Math.round(from * FPS)} playbackRate={rate} muted
          style={{ width: "100%", height: "100%" }} />
      </div>
      {dim > 0 && <AbsoluteFill style={{ background: `rgba(11,11,15,${dim})` }} />}
      {spot && (() => {
        const r = toFrame(spot.rect), p = spot.pad ?? 12, o = 0.62 * ease(Math.min(1, Math.max(0, (t - spot.at) / 0.5)));
        return (
          <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
            <path fillRule="evenodd" fill={`rgba(11,11,15,${o})`}
              d={`M0 0H${width}V${height}H0Z M${r.x - p} ${r.y - p}h${r.width + 2 * p}v${r.height + 2 * p}h${-(r.width + 2 * p)}Z`} />
          </svg>
        );
      })()}
      {callouts.map((c, i) => <Callout key={i} spec={c} rect={toFrame(c.target)} t={t} frameW={width} frameH={height} />)}
    </AbsoluteFill>
  );
};

/** A pink outline on the target and a label pill beside it, joined by a short leader line. */
function Callout({ spec, rect, t, frameW, frameH }: { spec: CalloutSpec; rect: Rect; t: number; frameW: number; frameH: number }) {
  const inP = ease(Math.min(1, Math.max(0, (t - spec.at) / 0.45)));
  const out = spec.until === undefined ? 1 : interpolate(t, [spec.until - 0.25, spec.until], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const op = inP * out;
  if (op <= 0) return null;
  const pad = 10;
  const box = { x: rect.x - pad, y: rect.y - pad, w: rect.width + 2 * pad, h: rect.height + 2 * pad };
  const gap = 46;
  const pillH = 64;
  const pillW = spec.text.length * 17 + 56;
  let px = 0, py = 0, lx1 = 0, ly1 = 0, lx2 = 0, ly2 = 0;
  if (spec.side === "right") { px = box.x + box.w + gap; py = box.y + box.h / 2 - pillH / 2; lx1 = box.x + box.w; ly1 = box.y + box.h / 2; lx2 = px; ly2 = ly1; }
  if (spec.side === "left") { px = box.x - gap - pillW; py = box.y + box.h / 2 - pillH / 2; lx1 = box.x; ly1 = box.y + box.h / 2; lx2 = px + pillW; ly2 = ly1; }
  if (spec.side === "top") { px = box.x; py = box.y - gap - pillH; lx1 = box.x + 40; ly1 = box.y; lx2 = lx1; ly2 = py + pillH; }
  if (spec.side === "bottom") { px = box.x; py = box.y + box.h + gap; lx1 = box.x + 40; ly1 = box.y + box.h; lx2 = lx1; ly2 = py; }
  if (spec.pill) {
    // A fixed pill position (take px); the leader runs from the box edge to the pill's nearest side.
    const k = rect.width / Math.max(1, spec.target.width);
    px = rect.x + (spec.pill.x - spec.target.x) * k; py = rect.y + (spec.pill.y - spec.target.y) * k;
    lx2 = px > box.x + box.w ? px : px + pillW; ly2 = py + pillH / 2;
    lx1 = px > box.x + box.w ? box.x + box.w : box.x; ly1 = Math.min(Math.max(ly2, box.y + 12), box.y + box.h - 12);
  }
  px = Math.min(Math.max(px, 24), frameW - pillW - 24);
  py = Math.min(Math.max(py, 24), frameH - pillH - 24);
  const slide = (1 - inP) * (spec.side === "left" ? -24 : spec.side === "right" ? 24 : 0);
  return (
    <AbsoluteFill style={{ opacity: op, pointerEvents: "none" }}>
      <svg width={frameW} height={frameH} style={{ position: "absolute", inset: 0 }}>
        {spec.box !== false && (
          <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={14} fill="none" stroke={C.neon} strokeWidth={4}
            style={{ filter: "drop-shadow(0 0 12px rgba(255,46,136,.55))" }} strokeDasharray={2 * (box.w + box.h)} strokeDashoffset={(1 - inP) * 2 * (box.w + box.h)} />
        )}
        {spec.line !== false && spec.text && <line x1={lx1} y1={ly1} x2={lx1 + (lx2 - lx1) * inP} y2={ly1 + (ly2 - ly1) * inP} stroke={C.neon} strokeWidth={4} />}
      </svg>
      {spec.text && <div style={{ position: "absolute", left: px + slide, top: py, height: pillH, padding: "0 28px", borderRadius: 999, background: C.neon, color: "#fff",
        fontFamily: sans, fontWeight: 700, fontSize: 30, display: "flex", alignItems: "center", whiteSpace: "nowrap", boxShadow: "0 10px 30px rgba(0,0,0,.45)" }}>
        {spec.text}
      </div>}
    </AbsoluteFill>
  );
}
