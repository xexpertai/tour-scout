import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame } from "remotion";
import { C, display, ease, mono, PIC_H, sans } from "../theme";
import { CONFIG, FPS, HITS, SECTIONS, line, wordAt } from "../data";
import { US_H, US_PATH, US_W, project } from "../usOutline";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
/** 0..1 progress of an eased transition starting at `at` (absolute s) over `dur`. */
const prog = (t: number, at: number, dur = 0.45) => ease(Math.min(1, Math.max(0, (t - at) / dur)));
const useT = (start: number) => useCurrentFrame() / FPS + start;

/** Near-black poster backdrop with a fixed film grain (inside the picture area only). */
export const Backdrop = ({ children, glow = 0.35 }: { children?: React.ReactNode; glow?: number }) => (
  <AbsoluteFill style={{ height: PIC_H, background: C.bg, overflow: "hidden" }}>
    <AbsoluteFill style={{ background: `radial-gradient(1200px 700px at 70% 30%, rgba(255,107,26,${0.10 * glow}), transparent 60%), radial-gradient(900px 600px at 15% 85%, rgba(255,46,136,${0.08 * glow}), transparent 60%)` }} />
    {children}
    <svg width="1920" height={PIC_H} style={{ position: "absolute", inset: 0, opacity: 0.07, mixBlendMode: "screen" }}>
      <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" /><feColorMatrix type="saturate" values="0" /></filter>
      <rect width="100%" height="100%" filter="url(#grain)" />
    </svg>
  </AbsoluteFill>
);

/** Words of a voice line that punch in as they are spoken. */
const Spoken = ({ id, t, style, accentFrom, accent = C.neon, breakAfter }: { id: string; t: number; style: React.CSSProperties; accentFrom?: number; accent?: string; breakAfter?: number }) => {
  const words = line(id).text.toUpperCase().split(" ");
  return (
    <div style={style}>
      {words.map((w, i) => {
        const at = wordAt(id, i) - 0.04;
        const p = prog(t, at, 0.22);
        return (
          <React.Fragment key={i}>
            <span style={{ display: "inline-block", opacity: p, transform: `translateY(${(1 - p) * 26}px) scale(${1.12 - 0.12 * p})`, marginRight: "0.22em",
              color: accentFrom !== undefined && i >= accentFrom ? accent : undefined }}>{w}</span>
            {i === breakAfter && <br />}
          </React.Fragment>
        );
      })}
    </div>
  );
};

// ------------------------------------------------------------------ 1. hook
const Seat = ({ x, y, person, lit }: { x: number; y: number; person: number; lit: number }) => (
  <g transform={`translate(${x} ${y})`}>
    <rect x={-22} y={-6} width={44} height={34} rx={8} fill={C.surface2} stroke={C.line} strokeWidth={2} />
    <rect x={-26} y={22} width={52} height={14} rx={5} fill={C.surface} stroke={C.line} strokeWidth={2} />
    {person > 0.01 && (
      <g opacity={person} transform={`translate(0 ${(1 - person) * 10})`}>
        <circle cx={0} cy={-24} r={13} fill={C.accent} opacity={0.35 + 0.65 * lit} />
        <path d="M-20 4 Q0 -14 20 4 L20 10 L-20 10 Z" fill={C.accent} opacity={0.35 + 0.65 * lit} />
      </g>
    )}
  </g>
);

export const Hook = ({ start }: { start: number }) => {
  const t = useT(start);
  const rows = 3, cols = 12;
  const order = Array.from({ length: rows * cols }, (_, i) => (i * 17 + 5) % (rows * cols)); // fixed shuffle
  const nobody = line("hook2").at;
  return (
    <Backdrop glow={interpolate(t, [0, nobody, nobody + 1], [0.6, 0.6, 0.15], clamp)}>
      <Spoken id="hook1" t={t} style={{ position: "absolute", top: 120, width: "100%", textAlign: "center", fontFamily: display, fontSize: 132, color: C.ink, letterSpacing: 1 }} />
      <div style={{ position: "absolute", top: 280, width: "100%", textAlign: "center", fontFamily: display, fontSize: 176, color: C.neon,
        opacity: prog(t, nobody - 0.03, 0.12), transform: `scale(${1.35 - 0.35 * spring({ frame: Math.max(0, (t - nobody) * FPS), fps: FPS, config: { damping: 14, stiffness: 180 } })})` }}>
        NOBODY CAME.
      </div>
      <svg width="1920" height={PIC_H} style={{ position: "absolute", inset: 0 }}>
        {Array.from({ length: rows * cols }, (_, i) => {
          const r = Math.floor(i / cols), c = i % cols;
          const leave = 0.5 + (order[i] / (rows * cols)) * (nobody - 0.5);
          const person = interpolate(t, [leave - 0.25, leave], [1, 0], clamp);
          return <Seat key={i} x={960 + (c - (cols - 1) / 2) * 100} y={590 + r * 110} person={person} lit={1} />;
        })}
      </svg>
    </Backdrop>
  );
};

// ------------------------------------------------------------------ 2+3. persona and the turn
const MAP_X = 800, MAP_Y = 310, MAP_S = 0.98; // where the US outline sits during the persona
const GUESSES: [number, number][] = [[-104.9, 39.7], [-87.6, 41.9], [-86.8, 36.2], [-97.7, 30.3], [-122.3, 47.6]];
const FANS: [number, number, number][] = [[-73.2, 44.5, 1], [-71.1, 42.4, 0.9], [-122.7, 45.5, 0.8], [-106, 35.7, 0.6], [-73.8, 42.7, 0.85], [-84.4, 33.8, 0.5]];

/** Maya: a flat illustration (fictional), drawn here; no photo, no real person. */
const Maya = () => (
  <svg width="520" height="700" viewBox="0 0 520 700">
    <circle cx="250" cy="360" r="235" fill={C.accent} opacity="0.13" />
    <circle cx="250" cy="360" r="165" fill={C.accent} opacity="0.10" />
    {/* guitar case, standing behind her shoulder */}
    <g fill="#5d3b2d">
      <rect x="374" y="150" width="48" height="250" rx="18" />
      <circle cx="398" cy="430" r="72" />
      <circle cx="398" cy="575" r="100" />
    </g>
    <rect x="384" y="165" width="28" height="210" rx="12" fill="#704a39" />
    <rect x="378" y="505" width="40" height="16" rx="8" fill="#2c1c15" />
    {/* long hair, behind */}
    <path d="M168 330 Q160 205 255 196 Q352 205 344 330 L352 560 Q300 600 255 596 Q206 600 160 560 Z" fill="#2a1b17" />
    {/* shoulders: a pink sweater */}
    <path d="M96 700 Q98 548 255 528 Q412 548 414 700 Z" fill={C.neon} />
    <path d="M214 536 Q255 566 296 536 L288 516 Q255 532 222 516 Z" fill="#c9186a" />
    <rect x="232" y="452" width="46" height="72" rx="18" fill="#d6956c" />
    {/* face */}
    <ellipse cx="255" cy="352" rx="74" ry="90" fill="#e9b08a" />
    <path d="M181 336 Q178 236 257 230 Q338 234 333 330 Q306 282 252 286 Q206 292 181 336 Z" fill="#2a1b17" />
    <ellipse cx="227" cy="360" rx="7" ry="8" fill="#2a1b17" />
    <ellipse cx="283" cy="360" rx="7" ry="8" fill="#2a1b17" />
    <circle cx="214" cy="392" r="11" fill="#f08f86" opacity="0.45" />
    <circle cx="296" cy="392" r="11" fill="#f08f86" opacity="0.45" />
    <path d="M236 402 Q255 418 274 402" stroke="#9c4f3a" strokeWidth="6" fill="none" strokeLinecap="round" />
    <circle cx="182" cy="382" r="6" fill={C.accent} />
    <circle cx="328" cy="382" r="6" fill={C.accent} />
  </svg>
);

const Pin = ({ x, y, p, wobble, children, hot = 0 }: { x: number; y: number; p: number; wobble: number; children?: React.ReactNode; hot?: number }) => (
  <g transform={`translate(${x} ${y}) scale(${p}) rotate(${wobble})`} opacity={Math.min(1, p * 1.4)}>
    <path d="M0 0 C-22 -26 -26 -40 -26 -52 a26 26 0 0 1 52 0 c0 12 -4 26 -26 52 z" fill={C.surface2} stroke={hot > 0 ? C.neon : C.muted} strokeWidth={3 + 2 * hot} />
    {children ?? <text x={0} y={-41} textAnchor="middle" fontFamily={display} fontSize={30} fill={C.ink}>?</text>}
  </g>
);

export const PersonaTurn = ({ start }: { start: number }) => {
  const t = useT(start);
  const m2 = line("maya2").at;
  const turn = SECTIONS.turn;
  const logo = HITS.logo;
  // Maya slides left as the map arrives, and leaves for the turn.
  const toMap = prog(t, m2 - 0.2, 0.8);
  const mayaOut = prog(t, turn, 0.6);
  const mapIn = prog(t, m2, 0.7);
  const center = prog(t, turn, 0.9);           // the map moves to the centre for the turn
  const mapX = MAP_X + (460 - MAP_X) * center, mapY = MAP_Y + (300 - MAP_Y) * center, mapS = MAP_S + (1.0 - MAP_S) * center;
  const logoP = prog(t, logo, 0.5);
  const flash = interpolate(t, [logo - 0.02, logo + 0.03, logo + 0.35], [0, 0.85, 0], clamp);
  const seatAt = m2 + 3.0;
  return (
    <Backdrop glow={0.5}>
      {/* persona tag: visible for the whole persona section */}
      <div style={{ position: "absolute", left: 96, top: 72, opacity: (1 - mayaOut) * prog(t, SECTIONS.persona, 0.3), padding: "10px 22px", borderRadius: 999,
        border: `2px solid ${C.sample}`, color: C.sample, fontFamily: sans, fontWeight: 700, fontSize: 26, letterSpacing: 3 }}>FICTIONAL EXAMPLE</div>
      <div style={{ position: "absolute", left: 140 - 90 * toMap, top: PIC_H - 700, transform: `scale(${1 - 0.3 * toMap})`, transformOrigin: "left bottom",
        opacity: prog(t, SECTIONS.persona, 0.5) * (1 - mayaOut) }}>
        <Maya />
      </div>
      <div style={{ position: "absolute", left: 760, top: 300, opacity: prog(t, line("maya1").at - 0.1, 0.4) * (1 - prog(t, m2 - 0.3, 0.4)) }}>
        <div style={{ fontFamily: display, fontSize: 180, color: C.ink, lineHeight: 1 }}>MEET MAYA</div>
        <div style={{ fontFamily: sans, fontSize: 46, color: C.muted, marginTop: 24 }}>Folk singer · planning her first five-city tour</div>
      </div>
      {/* the map of guesses */}
      <div style={{ position: "absolute", left: mapX, top: mapY, transform: `scale(${mapS})`, transformOrigin: "left top", opacity: mapIn * (1 - prog(t, logo - 0.05, 0.1) * 0.75) }}>
        <svg width={US_W} height={US_H} style={{ overflow: "visible" }}>
          <defs>
            <radialGradient id="glow"><stop offset="0" stopColor="#ffd2b0" /><stop offset="0.25" stopColor={C.accent} /><stop offset="0.6" stopColor={C.neon} stopOpacity="0.45" /><stop offset="1" stopColor={C.neon} stopOpacity="0" /></radialGradient>
          </defs>
          <path d={US_PATH} fill={C.surface} stroke="#3a3a48" strokeWidth={3} />
          {FANS.map(([lo, la, s], i) => {
            const [x, y] = project(lo, la);
            const g = prog(t, turn + 0.5 + i * 0.22, 1.0);
            return <circle key={i} cx={x} cy={y} r={70 * s * g} fill="url(#glow)" opacity={0.9 * g} />;
          })}
          {GUESSES.map(([lo, la], i) => {
            const [x, y] = project(lo, la);
            const p = spring({ frame: Math.max(0, (t - (m2 + 0.3 + i * 0.35)) * FPS), fps: FPS, config: { damping: 9, stiffness: 160 } });
            const gone = prog(t, turn + 0.3 + i * 0.12, 0.5);
            const wob = Math.sin((t - m2) * 5 + i) * 6 * (1 - gone);
            const empty = i === 2 ? prog(t, seatAt, 0.35) : 0;
            return (
              <g key={i} opacity={1 - gone}>
                <Pin x={x} y={y} p={p * (1 - 0.4 * gone) * (1 + 0.35 * empty)} wobble={wob} hot={empty}>
                  {empty > 0 ? (
                    <g opacity={empty} transform="translate(0 -60) scale(0.62)">
                      <rect x={-22} y={-6} width={44} height={34} rx={8} fill={C.surface2} stroke={C.neon} strokeWidth={4} />
                      <rect x={-26} y={22} width={52} height={14} rx={5} fill={C.surface} stroke={C.neon} strokeWidth={4} />
                    </g>
                  ) : undefined}
                </Pin>
              </g>
            );
          })}
        </svg>
      </div>
      <div style={{ position: "absolute", left: 800, top: 120, fontFamily: display, fontSize: 92, color: C.ink, opacity: prog(t, m2 + 0.4, 0.4) * (1 - prog(t, turn - 0.3, 0.3)) }}>
        GUT FEEL <span style={{ color: C.neon }}>×</span> 5 CITIES
      </div>
      {/* the turn: the question, then the logo */}
      <div style={{ opacity: 1 - prog(t, logo - 0.15, 0.12) }}>
        <Spoken id="turn1" t={t} breakAfter={4} style={{ position: "absolute", top: 40, left: 80, right: 80, textAlign: "center", fontFamily: display, fontSize: 96, color: C.ink, lineHeight: 1.05 }} accentFrom={7} accent={C.accent} />
      </div>
      {t >= logo - 0.05 && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
          <div style={{ fontFamily: display, fontSize: 250, color: C.ink, letterSpacing: 4, transform: `scale(${1.25 - 0.25 * spring({ frame: Math.max(0, (t - logo) * FPS), fps: FPS, config: { damping: 13, stiffness: 170 } })})`, opacity: logoP }}>
            TOUR<span style={{ color: C.accent }}>·</span>SCOUT
          </div>
          <div style={{ height: 10, width: 980 * prog(t, logo + 0.2, 0.5), background: C.neon, borderRadius: 6, marginTop: -6, boxShadow: "0 0 24px rgba(255,46,136,.6)" }} />
          <div style={{ marginTop: 44, fontFamily: display, fontSize: 64, color: C.ink, opacity: prog(t, logo + 0.75, 0.4), letterSpacing: 1 }}>
            FIND YOUR FANS BEFORE YOU <span style={{ color: C.neon }}>BOOK THE ROOM.</span>
          </div>
        </AbsoluteFill>
      )}
      <AbsoluteFill style={{ background: "#fff", opacity: flash }} />
    </Backdrop>
  );
};

// ------------------------------------------------------------------ 6. how it works
const NODES = [
  { k: "Qloo's", title: "QLOO", sub: "official harness", code: "where_popular · recommend · compare_audiences", color: C.qloo },
  { k: "finds", title: "THE PLAN", sub: "cities, rooms and openers, built in code", code: "streamed live", color: C.accent },
  { k: "Claude", title: "CLAUDE HAIKU 4.5", sub: "writes the why and the pitches", code: "cites Qloo evidence", color: C.ai },
  { k: "server", title: "SERVER CHECKS", sub: "citations · safe-use guard · scout proposals", code: "before anything shows", color: C.neon },
  { k: "you", title: "YOU", sub: "a tour plan with receipts", code: "", color: C.ink },
];

export const How = ({ start }: { start: number }) => {
  const t = useT(start);
  const W = 300, G = 44, y = 380, H = 340;
  const ats = NODES.map((n) => wordAt("how", n.k) - 0.1);
  // The row stays centred as it grows: its width follows how many cards have (partly) arrived.
  const shown = ats.reduce((n, at) => n + prog(t, at - 0.05, 0.5), 0);
  const x0 = (1920 - (Math.max(1, shown) * W + Math.max(0, shown - 1) * G)) / 2;
  return (
    <Backdrop glow={0.4}>
      <div style={{ position: "absolute", top: 150, width: "100%", textAlign: "center", fontFamily: display, fontSize: 110, color: C.ink, opacity: prog(t, start, 0.4),
        transform: `translateY(${(1 - prog(t, start, 0.5)) * 20}px)` }}>UNDER THE HOOD</div>
      <svg width="1920" height={PIC_H} style={{ position: "absolute", inset: 0 }}>
        {NODES.slice(1).map((_, i) => {
          const a = x0 + (i + 1) * W + i * G, b = a + G, cy = y + H / 2;
          const p = prog(t, ats[i + 1] - 0.15, 0.35);
          const dot = ((t * 0.9 + i * 0.3) % 1);
          return (
            <g key={i} opacity={p}>
              <line x1={a + 4} y1={cy} x2={a + 4 + (G - 8) * p} y2={cy} stroke={C.line} strokeWidth={4} />
              <path d={`M${b - 14} ${cy - 9} L${b - 4} ${cy} L${b - 14} ${cy + 9}`} stroke={C.muted} strokeWidth={4} fill="none" />
              {p >= 1 && <circle cx={a + 4 + (G - 8) * dot} cy={cy} r={5} fill={NODES[i].color} />}
            </g>
          );
        })}
      </svg>
      {NODES.map((n, i) => {
        const p = prog(t, ats[i], 0.4);
        return (
          <div key={i} style={{ position: "absolute", left: x0 + i * (W + G), top: y, width: W, height: H, opacity: p, transform: `translateY(${(1 - p) * 30}px)`,
            background: C.surface, border: `2px solid ${C.line}`, borderTop: `6px solid ${n.color}`, borderRadius: 18, padding: "26px 24px", boxSizing: "border-box" }}>
            <div style={{ fontFamily: mono, fontSize: 22, color: C.muted }}>0{i + 1}</div>
            <div style={{ fontFamily: display, fontSize: 46, color: C.ink, marginTop: 8, lineHeight: 1.05 }}>{n.title}</div>
            <div style={{ fontFamily: sans, fontSize: 27, color: C.ink, marginTop: 12, lineHeight: 1.25 }}>{n.sub}</div>
            {n.code && <div style={{ fontFamily: mono, fontSize: 19, color: n.color, marginTop: 14, lineHeight: 1.35 }}>{n.code}</div>}
          </div>
        );
      })}
    </Backdrop>
  );
};

// ------------------------------------------------------------------ 7. close
export const Close = ({ start }: { start: number }) => {
  const t = useT(start);
  const hit = HITS.final;
  const flash = interpolate(t, [hit - 0.02, hit + 0.03, hit + 0.4], [0, 0.6, 0], clamp);
  const pulse = 1 + 0.06 * Math.exp(-Math.max(0, t - hit) * 6) * (t >= hit ? 1 : 0);
  const rows = [CONFIG.demoUrl && `Try it  ${CONFIG.demoUrl}`, CONFIG.repoUrl && `Code  ${CONFIG.repoUrl}`].filter(Boolean) as string[];
  const drift = 1 + 0.035 * Math.max(0, t - hit) / 6; // a slow push on the end card: never a static hold
  return (
    <Backdrop glow={1}>
     <AbsoluteFill style={{ transform: `scale(${drift})` }}>
      <div style={{ position: "absolute", top: 110, width: "100%", textAlign: "center", fontFamily: display, fontSize: 70, color: C.ink, letterSpacing: 3, opacity: prog(t, start, 0.4) }}>
        TOUR<span style={{ color: C.accent }}>·</span>SCOUT
      </div>
      <div style={{ position: "absolute", top: 260, width: "100%", textAlign: "center", fontFamily: display, fontSize: 150, lineHeight: 1.0, color: C.ink, transform: `scale(${pulse})` }}>
        {["FIND", "YOUR", "FANS", "BEFORE", "YOU"].map((w, i) => {
          const p = prog(t, wordAt("close", i + 2) - 0.05, 0.2);
          return <span key={w} style={{ display: "inline-block", opacity: p, transform: `translateY(${(1 - p) * 24}px)`, marginRight: "0.22em" }}>{w}</span>;
        })}
        <br />
        {["BOOK", "THE", "ROOM."].map((w, i) => {
          const p = prog(t, wordAt("close", i + 7) - 0.05, 0.16);
          return <span key={w} style={{ display: "inline-block", color: C.neon, opacity: p, transform: `translateY(${(1 - p) * 24}px)`, marginRight: "0.22em" }}>{w}</span>;
        })}
      </div>
      <div style={{ position: "absolute", top: 640, width: "100%", textAlign: "center", fontFamily: sans, fontSize: 40, color: C.ink, lineHeight: 1.6 }}>
        {rows.map((r, i) => <div key={r} style={{ opacity: prog(t, hit + 0.5 + i * 0.25, 0.4) }}>{r}</div>)}
        <div style={{ opacity: prog(t, hit + 0.6 + rows.length * 0.25, 0.4), color: C.muted, marginTop: 10 }}>Built by {CONFIG.builtBy}</div>
      </div>
     </AbsoluteFill>
      <AbsoluteFill style={{ background: "#fff", opacity: flash }} />
    </Backdrop>
  );
};
