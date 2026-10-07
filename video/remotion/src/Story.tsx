import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { C, ease, PIC_H, sans } from "./theme";
import { END, f, FPS, SECTIONS, TAKES, wordAt } from "./data";
import { around, CalloutSpec, Footage, full, Key, Spot } from "./components/Footage";
import { Captions } from "./components/Captions";
import { Close, Hook, How, Persona, WhyNot } from "./scenes/Graphics";

type Shot = { start: number; end: number; take: string; from: number; rate?: number; keys: Key[]; callouts?: CalloutSpec[]; tag?: string; spot?: Spot };

const S = SECTIONS;
const R = (take: string) => TAKES[take].rects;
const M = (take: string) => TAKES[take].marks;
/** Shot-relative time (s) at which a take's moment shows, for a shot that plays `from` at `rate`. */
const when = (take: string, mark: number, from: number, rate = 1) => (mark - from) / rate;
const PANE = { x: 1164, y: 93, w: 1396 };      // the plan pane, below the app header
const TICKET = { x: 1164, y: 112, w: 1396 };   // the first ticket, inside the pane
/** A slow push-in towards a view's centre, so a held shot is never a still frame. */
const push = (v: { x: number; y: number; w: number }, k = 0.94) => ({ x: v.x + (v.w * (1 - k)) / 2, y: v.y + ((v.w / (1920 / 990)) * (1 - k)) / 2, w: v.w * k });

function shots(): Shot[] {
  const out: Shot[] = [];
  // Emerging-act mode in ~2.4 s: "Not this Maya" → emerging-act mode → sounds like Joanna Sternberg.
  {
    const panel = { x: 470, y: 150, w: 1620 };
    const from = M("type").confirm - 0.3, to = M("type").proxy + 0.5, rate = (to - from) / (S.hero - S.type);
    out.push({
      start: S.type, end: S.hero, take: "type", from, rate, keys: [{ t: 0, view: panel }],
      callouts: [{ text: "Sounds like: Joanna Sternberg", target: R("type").soundsLike, at: when("type", M("type").proxy, from, rate) - 0.1, side: "right", box: false, line: false, pill: { x: 1330, y: 300 } }],
    });
  }
  // Hero: the fan map lights up (captured slowed); starts with the heat visible, slow push.
  {
    const from = M("map").markers + 0.7, until = M("map").route - 0.45, len = S.route - S.hero;
    out.push({ start: S.hero, end: S.route, take: "map", from, rate: (until - from) / len, keys: [{ t: 0, view: full("map") }, { t: 0.05, view: push(full("map"), 0.92), dur: len }], tag: "Live Qloo data · fans of Joanna Sternberg" });
  }
  // The route draws, then the ranking.
  {
    const mid = S.route + 3.0;
    out.push({ start: S.route, end: mid, take: "map", from: M("map").route - 0.4, keys: [{ t: 0, view: full("map") }], tag: "Every leg within a day's drive" });
    const from = M("app").settled - 0.6;
    out.push({
      start: mid, end: S.ticket, take: "app", from,
      keys: [{ t: 0, view: full("app") }, { t: 0.5, view: { x: 1164, y: Math.min(R("app").coverage.y - 120, 1320 - 1396 / (1920 / 990)), w: 1396 }, dur: 0.9 }],
      callouts: [{ text: "Ranked by the room these fans like best", target: R("app").strip, at: 1.2, side: "top", box: true }],
    });
  }
  // A stop: real rooms, a support slot sized to the act; it ends as the pane starts to scroll.
  {
    const from = M("ticket").scroll - (S.pitch - S.ticket);
    out.push({
      start: S.ticket, end: S.pitch, take: "ticket", from,
      keys: [{ t: 0, view: full("ticket") }, { t: 0.5, view: TICKET, dur: 1.0 }, { t: 1.6, view: push(TICKET), dur: 5.6 }],
      callouts: [
        { text: "Real rooms", target: R("ticket").rooms, at: wordAt("ticket", "real") - S.ticket, until: when("ticket", M("ticket").scroll, from), side: "right", pill: { x: 1890, y: 650 } },
        { text: "Support slot, sized to the act", target: R("ticket").opener, at: wordAt("ticket", "support") - S.ticket, until: when("ticket", M("ticket").scroll, from), side: "top" },
      ],
    });
  }
  // The request, addressed to the headliner's team.
  {
    const from = M("ticket").pitch - 0.6;
    const v = around("ticket", R("ticket").dialog, 40, 1920 / 990, 1600);
    out.push({
      start: S.pitch, end: S.agent, take: "ticket", from,
      keys: [{ t: 0, view: v }, { t: 0.1, view: push(v, 0.92), dur: 4.3 }],
      spot: { rect: R("ticket").dialog, at: 0, pad: 0 },
    });
  }
  // The agent route check: trace → "a stronger city that still drives" → Apply → the route redraws.
  {
    const c = M("check");
    const a = S.agent, b = wordAt("agent", "finds") - 0.15, d = wordAt("agent", "Apply") - 0.1, e = d + 1.4;
    const aFrom = c.trace + 0.9, aRate = (c.answer - 0.3 - aFrom) / (b - a);
    // The answered dock (verdict and Apply), framed from its recorded position.
    const DOCK = { x: 1197, y: Math.min(1320 - (1330 * 990) / 1920, R("check").answer.y - 230), w: 1330 };
    out.push({
      start: a, end: b, take: "check", from: aFrom, rate: aRate, keys: [{ t: 0, view: full("check") }],
      callouts: [{ text: "An agent runs Qloo tools", target: R("check").dock, at: 0.4, side: "left", box: false, line: false, pill: { x: 1700, y: 1040 } }],
    });
    const bFrom = c.answer + 0.2, bRate = (c.applyReady - bFrom) / (d - b);
    out.push({
      start: b, end: d, take: "check", from: bFrom, rate: bRate, keys: [{ t: 0, view: DOCK }, { t: 0.1, view: { ...DOCK, y: DOCK.y + 24 }, dur: d - b }],
      callouts: [{ text: "Stronger, still drivable", target: R("check").answer, at: 0.3, side: "left", box: false, line: false, pill: { x: 1900, y: R("check").answer.y - 70 } }],
    });
    out.push({
      start: d, end: e, take: "check", from: c.applyReady, rate: (c.apply + 0.04 - c.applyReady) / (e - d), keys: [{ t: 0, view: DOCK }],
      callouts: [{ text: "Checked by the server", target: R("check").apply, at: 0.1, side: "right", pill: { x: R("check").apply.x - 150, y: R("check").apply.y + R("check").apply.height + 60 } }],
    });
    out.push({
      start: e, end: S.holds, take: "check", from: c.applied - 0.1, rate: Math.max(1, (c.redrawn + 1.5 - c.applied) / (S.holds - e)),
      keys: [{ t: 0, view: full("check") }], tag: "Route redrawn: Washington, DC in, Albany out",
    });
  }
  // Joe List: the route check holds, and says why.
  {
    const h = M("holds");
    out.push({
      start: S.holds, end: S.phone, take: "holds", from: h.answer - 1.6, keys: [{ t: 0, view: full("holds") }],
      callouts: [{ text: "Route holds: no change for show", target: R("holds").answer, at: 1.4, side: "top", box: false, line: false, pill: { x: 1700, y: R("holds").answer.y - 62 } }],
    });
  }
  // Receipts: the toggle, then the exact Qloo request.
  {
    const r = M("receipts"), from = r.toggle - 0.5, rate = (r.request + 0.6 - from) / (S.how - S.receipts);
    const reqView = { x: 1270, y: 93, w: 1250 };
    out.push({
      start: S.receipts, end: S.how, take: "receipts", from, rate,
      keys: [{ t: 0, view: PANE }, { t: when("receipts", r.expand, from, rate) - 0.2, view: reqView, dur: 0.8 }],
      callouts: [{ text: "The exact Qloo request", target: R("receipts").request, at: when("receipts", r.request, from, rate) - 0.2, side: "bottom" }],
    });
  }
  return out;
}

/** The phone shot: the 390 px layout in a simple device frame, beside a caption. */
const PhoneShot = ({ start }: { start: number }) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const p = ease(Math.min(1, t / 0.5));
  const W = 400, Hh = 866;
  return (
    <AbsoluteFill style={{ height: PIC_H, background: C.bg }}>
      <div style={{ position: "absolute", left: 660, top: (PIC_H - Hh - 24) / 2, width: W + 24, height: Hh + 24, borderRadius: 52, background: "#000", border: `2px solid ${C.line}`,
        boxShadow: "0 30px 80px rgba(0,0,0,.6)", padding: 12, opacity: p, transform: `translateY(${(1 - p) * 30}px)` }}>
        <div style={{ width: W, height: Hh, borderRadius: 40, overflow: "hidden", position: "relative" }}>
          <Footage take="phone" from={M("phone").sheet - 0.4} width={W} height={Hh} keys={[{ t: 0, view: { x: 0, y: 0, w: 780 } }]} />
        </div>
      </div>
      <div style={{ position: "absolute", left: 1150, top: 380, width: 600, fontFamily: sans, fontWeight: 700, fontSize: 40, color: C.ink, lineHeight: 1.25, opacity: ease(Math.min(1, Math.max(0, (t - 0.4) / 0.5))) }}>
        On a phone, the route check<br /><span style={{ color: C.neon }}>opens by itself.</span>
      </div>
      <span style={{ display: "none" }}>{start}</span>
    </AbsoluteFill>
  );
};

const ShotView = ({ s }: { s: Shot }) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const tagP = s.tag ? ease(Math.min(1, Math.max(0, (t - 0.8) / 0.5))) : 0;
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
  const seq = (start: number, end: number, node: React.ReactNode, key: string) => (
    <Sequence key={key} from={f(start)} durationInFrames={f(end) - f(start)}>{node}</Sequence>
  );
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {seq(0, S.persona, <Hook start={0} />, "hook")}
      {seq(S.persona, S.type, <Persona start={S.persona} />, "persona")}
      {shots().map((s, i) => seq(s.start, s.end, <ShotView s={s} />, `shot${i}`))}
      {seq(S.phone, S.whynot, <PhoneShot start={S.phone} />, "phone")}
      {seq(S.whynot, S.receipts, (
        <WhyNot start={S.whynot}>
          <Footage take="sponsor" from={M("sponsor").sponsor - 1.2} width={960} height={780}
            keys={[{ t: 0, view: around("sponsor", R("sponsor").sponsor, 120, 960 / 780, 1300) }]}
            callouts={[{ text: "", target: R("sponsor").sponsor, at: wordAt("whynot", "sponsors") - S.whynot, side: "top", box: true }]} />
        </WhyNot>
      ), "whynot")}
      {seq(S.how, S.close, <How start={S.how} />, "how")}
      {/* The end card holds to the last frame: the video never ends on black. */}
      {seq(S.close, END, <Close start={S.close} />, "close")}
      <Captions />
    </AbsoluteFill>
  );
};
