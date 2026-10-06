import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, display, ease, sans } from "../theme";
import { FPS, TAKES, line, wordAt } from "../data";
import { Footage, View } from "../components/Footage";
import { Backdrop } from "./Graphics";

const prog = (t: number, at: number, dur = 0.45) => ease(Math.min(1, Math.max(0, (t - at) / dur)));

/** Illustrative "before": grey sticky notes, a question-mark sheet and a phone. Not data. */
const Guesswork = ({ t, start }: { t: number; start: number }) => {
  const notes = [
    { x: 40, y: 40, r: -6, text: "Denver??" },
    { x: 330, y: 20, r: 5, text: "ask around" },
    { x: 190, y: 250, r: -3, text: "which room?" },
  ];
  return (
    <div style={{ position: "relative", width: 780, height: 640, filter: "grayscale(1)", opacity: 0.9 }}>
      {/* a spreadsheet of guesses */}
      <div style={{ position: "absolute", left: 60, top: 330, width: 640, height: 280, background: "#e9e6df", borderRadius: 10, transform: "rotate(2deg)", opacity: prog(t, start + 0.2) }}>
        {Array.from({ length: 4 }, (_, r) => (
          <div key={r} style={{ display: "flex", borderBottom: "2px solid #b9b5ad", height: 70 }}>
            {Array.from({ length: 4 }, (_, c) => (
              <div key={c} style={{ flex: 1, borderRight: "2px solid #b9b5ad", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: sans, fontSize: 30, color: "#55524c", fontWeight: 600 }}>
                {r === 0 ? ["City", "Room", "Fans?", "Draw?"][c] : c >= 2 ? "?" : c === 0 ? ["A", "B", "C"][r - 1] : "…"}
              </div>
            ))}
          </div>
        ))}
      </div>
      {notes.map((n, i) => (
        <div key={i} style={{ position: "absolute", left: n.x, top: n.y, width: 250, height: 200, background: "#d9d4c4", boxShadow: "0 12px 24px rgba(0,0,0,.4)",
          transform: `rotate(${n.r + Math.sin(t * 0.9 + i * 2) * 1.2}deg) translateY(${Math.sin(t * 0.7 + i) * 4}px) scale(${0.9 + 0.1 * prog(t, start + 0.1 + i * 0.15)})`, opacity: prog(t, start + 0.1 + i * 0.15),
          display: "flex", alignItems: "center", justifyContent: "center", fontFamily: sans, fontStyle: "italic", fontWeight: 600, fontSize: 38, color: "#3d3a35" }}>{n.text}</div>
      ))}
      {/* a phone, calling around */}
      <div style={{ position: "absolute", left: 600, top: 60, width: 130, height: 230, borderRadius: 26, border: "8px solid #bdb9b0", background: "#2b2b30", opacity: prog(t, start + 0.5),
        display: "flex", alignItems: "center", justifyContent: "center", fontFamily: display, fontSize: 70, color: "#bdb9b0" }}>?</div>
    </div>
  );
};

export const Split = ({ start }: { start: number }) => {
  const frame = useCurrentFrame();
  const t = frame / FPS + start;
  const T = TAKES.receipts;
  const PW = 900, PH = 576;
  // Right panel camera: the plan pane, then in on the expanded Qloo request.
  // Framed so the panel's bottom edge falls between rows (no half-cut text at the panel edges).
  const pane: View = { x: 1190, y: 93, w: 1330 };
  const req = T.rects.request;
  // Below the app header, ending in the gap between two request rows.
  const reqView: View = { x: 1270, y: 93, w: 1250 };
  const fromS = 0.6;
  const rel = (abs: number) => abs - start;
  const s2 = line("split2").at;
  const reqAt = rel(start + (T.marks.request - fromS)) - 0.2;
  const headerP = prog(t, start, 0.5);
  return (
    <Backdrop glow={0.35}>
      {/* left: illustrative */}
      <div style={{ position: "absolute", left: 60, top: 60, width: 840 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20, opacity: headerP }}>
          <div style={{ fontFamily: display, fontSize: 84, color: "#8d8995" }}>GUESSWORK</div>
          <div style={{ padding: "6px 16px", borderRadius: 999, border: `2px solid ${C.sample}`, color: C.sample, fontFamily: sans, fontWeight: 700, fontSize: 22, letterSpacing: 2 }}>ILLUSTRATIVE</div>
        </div>
        <div style={{ fontFamily: sans, fontSize: 36, color: "#8d8995", marginTop: 4, opacity: headerP }}>Spreadsheets and hunches</div>
        <div style={{ marginTop: 40 }}><Guesswork t={t} start={start} /></div>
      </div>
      <div style={{ position: "absolute", left: 958, top: 70, width: 4, height: 850, background: C.line }} />
      {/* right: the real app, receipts on */}
      <div style={{ position: "absolute", left: 1000, top: 60, width: PW }}>
        <div style={{ fontFamily: display, fontSize: 84, color: C.ink, opacity: headerP }}>TOUR SCOUT</div>
        <div style={{ fontFamily: sans, fontSize: 36, color: C.accent, marginTop: 4, opacity: prog(t, wordAt("split1", "under") - 0.1, 0.3) }}>A live plan in under a minute</div>
        <div style={{ position: "relative", marginTop: 40, width: PW, height: PH, borderRadius: 16, overflow: "hidden", border: `2px solid ${C.line}` }}>
          {/* Outline only on the request: the banner below names it (a pill would cover the next row). */}
          <Footage take="receipts" from={fromS} width={PW} height={PH}
            keys={[{ t: 0, view: pane }, { t: reqAt, view: reqView, dur: 1.0 }, { t: reqAt + 1.2, view: { x: 1285, y: 96, w: 1225 }, dur: 4.5 }]}
            callouts={[{ text: "", target: req, at: reqAt + 1.0, side: "bottom", box: true }]} />
        </div>
      </div>
      <div style={{ position: "absolute", left: 1000, width: PW, top: 902, textAlign: "center", opacity: prog(t, s2 + 0.1, 0.4), transform: `translateY(${(1 - prog(t, s2 + 0.1, 0.5)) * 20}px)` }}>
        <span style={{ fontFamily: display, fontSize: 58, color: C.ink, padding: "0 26px" }}>EVERY CLAIM HAS A <span style={{ color: C.qloo }}>RECEIPT</span></span>
      </div>
      <AbsoluteFill style={{ pointerEvents: "none" }} />
    </Backdrop>
  );
};
