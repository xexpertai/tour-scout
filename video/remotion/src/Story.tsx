import React from "react";
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from "remotion";
import { C, ease, PIC_H, sans } from "./theme";
import { END, f, FPS, SECTIONS, TAKES, wordAt } from "./data";
import { around, CalloutSpec, Footage, full, Key, Spot } from "./components/Footage";
import { Captions } from "./components/Captions";
import { Close, Hook, How, PersonaTurn } from "./scenes/Graphics";
import { Split } from "./scenes/Split";

type Shot = { start: number; end: number; take: string; from: number; rate?: number; keys: Key[]; callouts?: CalloutSpec[]; tag?: string; spot?: Spot };

const S = SECTIONS;
const R = (take: string) => TAKES[take].rects;
const M = (take: string) => TAKES[take].marks;
/** Shot-relative time (s) at which a take's moment shows, for a shot that plays `from` at `rate`. */
const when = (take: string, mark: number, from: number, rate = 1) => (mark - from) / rate;

function shots(): Shot[] {
  const out: Shot[] = [];
  // Type an act -> "Did you mean" at real speed, then the form (5 stops, 300-900 rooms, as in the
  // captured run) a little faster, ending on the press of "Scout the tour".
  {
    const landing = { x: 330, y: 120, w: 1900 };   // between the header and the demo posters
    const confirmV = { x: 310, y: 260, w: 1940 };  // the whole confirm card, form and button
    const aFrom = 1.1, split = M("type").confirm + 0.85;
    const mid = S.type + (split - aFrom);
    out.push({
      start: S.type, end: mid, take: "type", from: aFrom,
      keys: [{ t: 0, view: landing }, { t: when("type", M("type").confirm, aFrom) - 0.1, view: confirmV, dur: 0.8 }],
    });
    const bEnd = M("type").scoutClick + 0.45, bRate = (bEnd - split) / (S.hero - mid);
    out.push({
      start: mid, end: S.hero, take: "type", from: split, rate: bRate,
      keys: [{ t: 0, view: confirmV }],
      callouts: [{ text: "Confirmed on Qloo", target: R("type").candidate, at: 0.0, until: when("type", M("type").scoutClick, split, bRate) - 0.5, side: "right" }],
    });
  }
  // Hero: the fan map lights up, full frame, slowed slightly (captured at ~50 fps).
  {
    // From just before the hotspots appear to just before the camera leaves for the route.
    const from = M("map").markers - 0.1, until = M("map").route - 0.45, len = S.strip - S.hero;
    out.push({ start: S.hero, end: S.strip, take: "map", from, rate: (until - from) / len, keys: [{ t: 0, view: full("map") }], tag: "Live Qloo data · fan hotspots across the US" });
  }
  // The ranked strip and its cut line.
  {
    const from = M("app").settled - 1.0, rate = 1;
    const strip = R("app").strip, cut = R("app").cut;
    const cutBox = { x: cut.x - 18, y: cut.y - 6, width: 36, height: cut.height + 12 };
    const top5 = wordAt("strip", "top") - S.strip;
    out.push({
      start: S.strip, end: S.route, take: "app", from, rate,
      // Framed from the gap above "The route" to the end of the pane: no row cut at an edge.
      // Inside the plan pane only (no map fragments), from the gap above "Demo using..." to the gap under the chips.
      keys: [{ t: 0, view: full("app") }, { t: 1.0, view: { x: 1164, y: 493, w: 1396 }, dur: 1.1 }],
      callouts: [
        { text: "Ranked by the room these fans like best", target: strip, at: 2.4, until: top5 - 0.1, side: "top", line: false, pill: { x: 1640, y: 604 } },
        { text: "The top five make the cut", target: cutBox, at: top5, side: "bottom" },
      ],
    });
  }
  // The route draws itself.
  out.push({ start: S.route, end: S.ticket, take: "map", from: M("map").route - 0.4, keys: [{ t: 0, view: full("map") }] });
  // A stop ticket: real venues, an opener with shared taste.
  {
    const from = M("ticket").scroll - (S.pitch - S.ticket);  // ends as the pane starts to scroll: the scroll is never on screen
    const tv = { x: 1164, y: 112, w: 1396 };  // inside the plan pane: the ticket from its top to the pitch button
    out.push({
      start: S.ticket, end: S.pitch, take: "ticket", from,
      keys: [{ t: 0, view: full("ticket") }, { t: 0.5, view: tv, dur: 1.0 }],
      callouts: [
        // Both leave before the pane scrolls to the pitch button.
        { text: "Real venues", target: R("ticket").rooms, at: wordAt("ticket", "real") - S.ticket, until: when("ticket", M("ticket").scroll, from), side: "right", pill: { x: 1890, y: 650 } },
        { text: "Opener with shared taste", target: R("ticket").opener, at: wordAt("ticket", "opener") - S.ticket, until: when("ticket", M("ticket").scroll, from), side: "top" },
      ],
    });
  }
  // The pitch email.
  {
    const from = 8.6;
    out.push({
      start: S.pitch, end: S.scout, take: "ticket", from,
      keys: [{ t: 0, view: full("ticket") }, { t: when("ticket", M("ticket").pitch, from) - 0.2, view: around("ticket", R("ticket").dialog, 60, 1920 / 990, 1900), dur: 0.9 }],
      spot: { rect: R("ticket").dialog, at: when("ticket", M("ticket").pitch, from) - 0.1, pad: 0 },
      callouts: [{ text: "Cites Qloo evidence", target: R("ticket").dialog, at: when("ticket", M("ticket").pitch, from) + 0.9, side: "top", box: false }],
    });
  }
  // Ask the scout -> the trace (sped up), cut just before the answer lands; resume once the proposal has
  // scrolled fully into view (Apply is never seen clipped); Apply -> "Applied"; then a cut to the ticket
  // after the pane's scroll has settled (no scroll and no half-hidden heading on screen).
  {
    const aFrom = 0.6, aTo = M("scout").answer - 0.25, bFrom = M("scout").applyReady;  // aTo: still "thinking"
    // B ends on the click (its ripple has started): the page re-lays out as it applies.
    const a = S.scout, b = 69.2, c = b + (M("scout").apply - bFrom), end = S.split;
    out.push({
      start: a, end: b, take: "scout", from: aFrom, rate: (aTo - aFrom) / (b - a),
      keys: [{ t: 0, view: full("scout") }],
      callouts: [{ text: "An agent runs Qloo tools", target: R("scout").dock, at: wordAt("scout", "agent") - a, side: "left", box: false, line: false }],
    });
    out.push({
      start: b, end: c, take: "scout", from: bFrom,
      keys: [{ t: 0, view: full("scout") }],
      // Leaves on the click: the proposal block changes shape once applied.
      callouts: [{ text: "Server-checked change", target: R("scout").apply, at: 0.1, until: when("scout", M("scout").apply, bFrom) - 0.05, side: "left" }],
    });
    const cFrom = M("scout").swapped - 0.5;  // the pane's scroll has settled by then
    out.push({
      start: c, end, take: "scout", from: cFrom,
      keys: [{ t: 0, view: { x: 1203, y: 112, w: 1317 } }],  // inside the ticket card, above its pitch button
      callouts: [{ text: "Opener swapped", target: R("scout").opener, at: 0.5, side: "top" }],
    });
  }
  return out;
}

const ShotView = ({ s }: { s: Shot }) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const tagP = s.tag ? ease(Math.min(1, Math.max(0, (t - 1.6) / 0.5))) : 0;
  return (
    <AbsoluteFill style={{ height: PIC_H }}>
      <Footage take={s.take} from={s.from} rate={s.rate} keys={s.keys} callouts={s.callouts} spot={s.spot} />
      {s.tag && (
        <div style={{ position: "absolute", left: 40, bottom: 34, opacity: tagP, transform: `translateY(${(1 - tagP) * 16}px)`, padding: "10px 22px", borderRadius: 999,
          background: "rgba(11,11,15,.85)", border: `2px solid ${C.qloo}`, color: C.ink, fontFamily: sans, fontWeight: 700, fontSize: 25 }}>
          <span style={{ color: C.qloo }}>●</span> {s.tag}
        </div>
      )}
    </AbsoluteFill>
  );
};

export const Story = () => {
  const frame = useCurrentFrame();
  const fadeOut = interpolate(frame, [f(END) - 15, f(END)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const seq = (start: number, end: number, node: React.ReactNode, key: string) => (
    <Sequence key={key} from={f(start)} durationInFrames={f(end) - f(start)}>{node}</Sequence>
  );
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {seq(0, S.persona, <Hook start={0} />, "hook")}
      {seq(S.persona, S.type, <PersonaTurn start={S.persona} />, "persona")}
      {shots().map((s, i) => seq(s.start, s.end, <ShotView s={s} />, `shot${i}`))}
      {seq(S.split, S.how, <Split start={S.split} />, "split")}
      {seq(S.how, S.close, <How start={S.how} />, "how")}
      {seq(S.close, END, <Close start={S.close} />, "close")}
      <Captions />
      <AbsoluteFill style={{ background: "#000", opacity: fadeOut }} />
    </AbsoluteFill>
  );
};
