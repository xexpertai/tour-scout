import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, PIC_H, sans } from "../theme";
import { FPS, LINES, WORDS } from "../data";

const MAX_CHARS = 62;

/** Splits a line into display chunks (at sentence/clause breaks when possible) of at most MAX_CHARS. */
function chunks(words: string[]) {
  const out: number[][] = [];
  let cur: number[] = [];
  let len = 0;
  words.forEach((w, i) => {
    if (cur.length && len + w.length + 1 > MAX_CHARS) {
      // Prefer to break after punctuation inside the current chunk.
      const cut = [...cur].reverse().find((k) => /[.,:;]$/.test(words[k]) && k !== cur[cur.length - 1]);
      if (cut !== undefined && cut - cur[0] > 2) {
        const rest = cur.filter((k) => k > cut);
        out.push(cur.filter((k) => k <= cut));
        cur = rest;
        len = rest.reduce((n, k) => n + words[k].length + 1, 0);
      } else {
        out.push(cur);
        cur = [];
        len = 0;
      }
    }
    cur.push(i);
    len += w.length + 1;
  });
  if (cur.length) out.push(cur);
  return out;
}

/** The caption band: always below the picture (never over the app), word-by-word highlight. */
export const Captions = () => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const idx = LINES.findIndex((l, i) => {
    const words = WORDS[l.id]?.words;
    const end = l.at + (words ? words[words.length - 1].e : 3) + 0.5;
    const next = LINES[i + 1]?.at ?? Infinity;
    return t >= l.at - 0.12 && t < Math.min(end, next - 0.05);
  });
  let body = null;
  if (idx >= 0) {
    const l = LINES[idx];
    const timed = WORDS[l.id]?.words;
    const words = l.text.split(" ");
    const starts = words.map((_, i) => l.at + (timed ? timed[i].s : (i / words.length) * 3));
    const groups = chunks(words);
    const g = groups.findIndex((grp, k) => k === groups.length - 1 || t < starts[groups[k + 1][0]] - 0.05);
    const group = groups[Math.max(0, g)];
    const shownAt = Math.max(l.at - 0.12, starts[group[0]] - 0.12);
    const op = interpolate(t, [shownAt, shownAt + 0.12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const lift = interpolate(t, [shownAt, shownAt + 0.18], [8, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    body = (
      <div style={{ opacity: op, transform: `translateY(${lift}px)`, fontFamily: sans, fontWeight: 600, fontSize: 36, letterSpacing: 0.2, whiteSpace: "nowrap" }}>
        {group.map((k) => {
          const spoken = t >= starts[k] - 0.02;
          return (
            <span key={k} style={{ color: spoken ? C.ink : "#6f6a7a", transition: "none" }}>
              {words[k]}{" "}
            </span>
          );
        })}
      </div>
    );
  }
  return (
    <AbsoluteFill style={{ top: PIC_H, height: 1080 - PIC_H, background: C.bg, borderTop: `1px solid ${C.line}`, alignItems: "center", justifyContent: "center" }}>
      {body}
    </AbsoluteFill>
  );
};
