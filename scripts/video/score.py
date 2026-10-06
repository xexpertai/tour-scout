"""Original score for the story video: synthesised from code, dedicated to the public domain (CC0 1.0)
by its author (see docs/MUSIC_LICENSE.md). No samples, loops or third-party audio of any kind.

~100 BPM in C major / A minor: a warm detuned pad, a soft FM electric-piano motif, a muted 8th-note pulse,
sub bass, a light kit, risers and impacts. The arrangement follows video/story.json's timeline: a sparse
intro under the hook and persona, a riser into a hit on the logo reveal, a build into the hero map, a
breakdown under the before/after, and a final hit on the closing line with a ring-out.

Usage (needs numpy, scipy, pedalboard; run through uv):
  uv run --python 3.12 --with numpy --with scipy --with pedalboard python scripts/video/score.py <out.wav> [from_s to_s]
"""
import json, pathlib, sys

import numpy as np
from pedalboard import Chorus, Compressor, Delay, HighpassFilter, HighShelfFilter, Limiter, LowpassFilter, LowShelfFilter, Pedalboard, Reverb
from scipy.io import wavfile
from scipy.signal import butter, sosfilt

ROOT = pathlib.Path(__file__).resolve().parents[2]
TL = json.load(open(ROOT / "video/story.json"))["timeline"]
SR = 48000
BPM = TL["bpm"]
BEAT = 60 / BPM
BAR = 4 * BEAT
END = TL["end"]
HIT = TL["hits"]
N = int(END * SR) + SR
rng = np.random.default_rng(7)  # fixed seed: the same score every render


def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
def bar_t(b): return b * BAR
def at(t): return int(round(t * SR))


def stereo(): return np.zeros((2, N))


def add(buf, sig, t, pan=0.0, gain=1.0):
    """Adds a mono or stereo signal at time t with constant-power pan."""
    i = at(t)
    if i >= N:
        return
    if sig.ndim == 1:
        a = (pan + 1) * np.pi / 4
        sig = np.vstack([sig * np.cos(a), sig * np.sin(a)]) * np.sqrt(2)
    n = min(sig.shape[1], N - i)
    buf[:, i:i + n] += gain * sig[:, :n]


def env(n, a, d, s, r, sustain_n):
    """ADSR envelope in samples; sustain_n = samples held before release."""
    e = np.zeros(n)
    A, D, R = max(1, int(a * SR)), max(1, int(d * SR)), max(1, int(r * SR))
    seg = [np.linspace(0, 1, A, endpoint=False), np.linspace(1, s, D, endpoint=False)]
    hold = max(0, sustain_n - A - D)
    seg += [np.full(hold, s), np.linspace(s, 0, R)]
    full = np.concatenate(seg)[:n]
    e[:len(full)] = full
    return e


def saw(f, n, phase=0.0):
    """Band-limited sawtooth (additive, harmonics below 14 kHz): no aliasing harshness."""
    t = np.arange(n) / SR
    out = np.zeros(n)
    k = 1
    while k * f < 14000 and k <= 60:
        out += np.sin(2 * np.pi * k * f * t + k * phase) / k
        k += 1
    return out * (2 / np.pi)


def lp(x, fc, order=2):
    return sosfilt(butter(order, fc, "low", fs=SR, output="sos"), x)


def hp(x, fc, order=2):
    return sosfilt(butter(order, fc, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


# ---------------------------------------------------------------- harmony (bar index -> chord)
# Voicings: (bass midi, [pad midis]). Intro chords last two bars; the groove moves one chord a bar.
CH = {
    "Am9":   (45, [57, 60, 64, 67, 71]),
    "Fmaj9": (41, [57, 60, 64, 67]),
    "Cadd9": (48, [55, 60, 62, 64]),
    "G6":    (43, [55, 59, 62, 64]),
    "Gsus":  (43, [55, 60, 62, 67]),
    "Fmaj7": (41, [53, 57, 60, 64]),
    "G":     (43, [55, 59, 62, 67]),
    "Am7":   (45, [55, 60, 64, 67]),
    "C":     (48, [55, 60, 64, 67]),
}
LOOP = ["Cadd9", "Fmaj7", "G", "Am7"]
FINAL_BAR = round(HIT["final"] / BAR)
LOGO_BAR = round(HIT["logo"] / BAR)
TOTAL_BARS = int(np.ceil(END / BAR))


def chord_at(b):
    if b < LOGO_BAR - 1:
        return ["Am9", "Am9", "Fmaj9", "Fmaj9", "Cadd9", "Cadd9", "G6", "G6"][min(b, 7)]
    if b == LOGO_BAR - 1:
        return "Gsus"
    if b == FINAL_BAR - 1:
        return "Gsus"
    if b >= FINAL_BAR:
        return "Cadd9"
    return LOOP[(b - LOGO_BAR) % 4]


# Section energy by time (seconds), used to switch layers on and off.
def section(t):
    s = None
    for name, start in TL["sections"]:
        if t + 1e-6 >= start:
            s = name
    return s


GROOVE = {"hero", "strip", "route", "ticket", "pitch", "scout", "how"}

# ---------------------------------------------------------------- instruments
def pad_note(m, dur, bright):
    n = int((dur + 2.5) * SR)
    voices = np.zeros(n)
    for d in (-9, -4, 0, 4, 9):  # cents
        voices += saw(hz(m) * 2 ** (d / 1200), n, phase=rng.uniform(0, 6.28))
    voices /= 5
    x = lp(voices, 450 + 2600 * bright, 2)
    return x * env(n, 0.9, 0.6, 0.85, 2.2, int(dur * SR))


def ep_note(m, vel=1.0, dur=2.5):
    """FM electric piano (Rhodes-like): bell attack that mellows; a soft tine partial."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(m)
    idx = 2.2 * np.exp(-t * 4) + 0.25
    x = np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * t))
    x += 0.08 * np.exp(-t * 18) * np.sin(2 * np.pi * f * 13.9 * t)
    a = np.minimum(1, t / 0.004) * np.exp(-t * 1.1)
    return lp(x * a * vel, 3800)


def pluck(m, vel=1.0, decay=7.0, cutoff=1400, dur=0.5):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = saw(hz(m), n) * np.minimum(1, t / 0.003) * np.exp(-t * decay)
    return lp(x, cutoff) * vel


def sub(m, dur):
    n = int((dur + 0.3) * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * hz(m) * t) + 0.18 * np.sin(4 * np.pi * hz(m) * t)
    return np.tanh(1.4 * x) * env(n, 0.02, 0.1, 0.9, 0.25, int(dur * SR))


def kick(vel=1.0):
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    f = 46 + 95 * np.exp(-t * 32)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 6.5)
    click = hp(rng.standard_normal(n), 2500) * np.exp(-t * 400) * 0.25
    return np.tanh(1.6 * (body + click)) * vel


def clap(vel=1.0):
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    nz = bp(rng.standard_normal(n), 900, 3200)
    e = np.zeros(n)
    for k, off in enumerate((0, 0.011, 0.022)):
        i = at(off)
        e[i:] += np.exp(-(t[: n - i]) * 90) * (0.7 if k < 2 else 1.0)
    e += np.exp(-t * 14) * 0.35
    return nz * e * 0.5 * vel


def hat(vel=1.0, open_=False):
    n = int((0.35 if open_ else 0.08) * SR)
    t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 7500, 4) * np.exp(-t * (12 if open_ else 70)) * 0.22 * vel


def crash(vel=1.0, length=3.5):
    n = int(length * SR)
    t = np.arange(n) / SR
    x = hp(rng.standard_normal(n), 3500, 2) * np.exp(-t * 1.6)
    return lp(x, 11000) * 0.35 * vel


def boom(vel=1.0):
    n = int(2.2 * SR)
    t = np.arange(n) / SR
    f = 34 + 40 * np.exp(-t * 5)
    return np.tanh(1.3 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.9)) * vel


def riser(length):
    """Filtered-noise swell that opens and rises in level, ending exactly at its target."""
    n = int(length * SR)
    t = np.arange(n) / SR
    nz = rng.standard_normal(n)
    out = np.zeros(n)
    bands = [(300, 900), (700, 2000), (1500, 4500), (3000, 9000)]
    pos = (t / length) * (len(bands) - 1)
    for k, (lo, hi) in enumerate(bands):
        w = np.clip(1 - np.abs(pos - k), 0, 1)
        out += bp(nz, lo, hi) * w
    return out * (t / length) ** 2.2 * 0.5


def snare_roll(length, vel=0.6):
    """Accelerating snare hits across the last bar of a build."""
    out = np.zeros(int(length * SR) + SR)
    steps = [0.5, 0.5, 0.25, 0.25, 0.25, 0.25, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125]
    t, k = 0.0, 0
    while t < length - 0.02 and k < 40:
        g = vel * (0.35 + 0.65 * t / length)
        c = clap(g)
        i = at(t)
        out[i:i + len(c)] += c[: len(out) - i]
        t += steps[min(k, len(steps) - 1)] * BEAT
        k += 1
    return out[: int(length * SR)]


# ---------------------------------------------------------------- arrangement
pad, ep, pulse, bass, drums, fx, arp = (stereo() for _ in range(7))

# Pad: one chord per bar (re-triggered softly), brightness follows the story.
for b in range(TOTAL_BARS):
    t0 = bar_t(b)
    name = chord_at(b)
    if b > 0 and chord_at(b - 1) == name and b < LOGO_BAR:
        continue
    span = 2 if (b < LOGO_BAR - 1 and chord_at(b + 1) == name) else 1
    if b >= FINAL_BAR:
        span = (END - t0) / BAR
    sec = section(t0)
    bright = {"hook": 0.12, "persona": 0.22, "turn": 0.5, "split": 0.32}.get(sec, 0.55)
    if b == LOGO_BAR - 1 or b == FINAL_BAR - 1:
        bright = 0.75
    if b >= FINAL_BAR:
        bright = 0.7
    dur = span * BAR - (0.32 if b in (LOGO_BAR - 1, FINAL_BAR - 1) else 0.05)  # a breath before each hit
    for i, m in enumerate(CH[name][1]):
        add(pad, pad_note(m, dur, bright), t0, pan=(i - 2) * 0.28, gain=0.16 * (0.55 if sec in ("hook", "persona") else 1.0))

# EP motif: intro and the breakdown (a simple descending-then-lifting phrase per chord).
MOTIF = {"Am9": [76, 72, 71], "Fmaj9": [72, 69, 67], "Cadd9": [74, 72, 67], "G6": [71, 67, 74], "Gsus": [72, 74, 79],
         "Fmaj7": [72, 69, 65], "G": [71, 67, 74], "Am7": [72, 67, 69], "C": [72, 67, 76]}
for b in range(TOTAL_BARS):
    t0, sec = bar_t(b), section(bar_t(b))
    if sec in ("hook", "persona") or (sec == "turn" and b < LOGO_BAR - 1) or sec == "split":
        if sec == "hook" and b == 0:
            add(ep, ep_note(76, 0.55, 3.5), t0 + 0.05, pan=-0.2)
            add(ep, ep_note(69, 0.5, 3.5), t0 + 2.65, pan=0.15)  # under "Nobody came": a lone low note
            continue
        notes = MOTIF[chord_at(b)]
        for k, m in enumerate(notes):
            add(ep, ep_note(m, 0.45 - 0.08 * k, 2.6), t0 + k * 1.5 * BEAT, pan=0.25 - 0.25 * k)

# Muted 8th-note pulse: from the persona's second line, through the groove and the breakdown.
pulse_start = 9.6
for b in range(TOTAL_BARS):
    t0 = bar_t(b)
    if t0 < pulse_start - 0.01 or b >= FINAL_BAR:
        continue
    root = CH[chord_at(b)][0] + 12
    for k in range(8):
        t = t0 + k * BEAT / 2
        if b in (LOGO_BAR - 1, FINAL_BAR - 1) and k >= 6:
            break
        vel = (0.9 if k % 2 == 0 else 0.6) * (0.55 if section(t0) in ("persona", "turn") else 1.0)
        m = root + (7 if k in (3, 7) else 0)
        add(pulse, pluck(m, vel, decay=9, cutoff=900 + 500 * (section(t0) in GROOVE)), t, pan=0.0, gain=0.2)

# Sub bass: groove only.
for b in range(TOTAL_BARS):
    t0, sec = bar_t(b), section(bar_t(b))
    if b >= LOGO_BAR and b < FINAL_BAR - 1 and (sec in GROOVE or sec == "type"):
        add(bass, sub(CH[chord_at(b)][0] - 12, BAR - 0.08), t0, gain=0.18)

# Drums.
kicks = []
for b in range(TOTAL_BARS):
    t0, sec = bar_t(b), section(bar_t(b))
    build_hero = abs(bar_t(b + 1) - HIT["heroLand"]) < 0.01
    if b >= LOGO_BAR and b < FINAL_BAR - 1 and (sec in GROOVE or sec == "type"):
        half = sec == "type" and not build_hero
        for k in range(4):
            if half and k % 2:
                continue
            kicks.append(t0 + k * BEAT)
            add(drums, kick(0.85), t0 + k * BEAT, gain=0.5)
        for k in range(4):
            add(drums, hat(0.9), t0 + k * BEAT + BEAT / 2, pan=0.3)
            if sec in GROOVE and sec != "how":
                add(drums, hat(0.35), t0 + k * BEAT + BEAT / 4, pan=-0.25)
                add(drums, hat(0.3), t0 + k * BEAT + 3 * BEAT / 4, pan=-0.25)
        if sec in GROOVE:
            for k in (1, 3):
                add(drums, clap(0.75), t0 + k * BEAT, pan=0.05, gain=0.75)
    if build_hero:
        add(drums, snare_roll(BAR), t0, gain=0.55)
    if abs(bar_t(b + 1) - HIT["howLand"]) < 0.01:
        add(drums, snare_roll(BAR, 0.45), t0, gain=0.5)

# Sidechain pump on pad/pulse/bass (gentle, groove only).
duck = np.ones(N)
for t in kicks:
    i = at(t)
    n = min(at(0.32), N - i)
    duck[i:i + n] *= 1 - 0.38 * np.exp(-np.arange(n) / SR * 11)
for buf in (pad, pulse, bass):
    buf *= duck

# Arp: soft FM bell 8ths with ping-pong delay, from the hero map through the groove.
for b in range(TOTAL_BARS):
    t0, sec = bar_t(b), section(bar_t(b))
    if sec in GROOVE and sec != "how" and b < FINAL_BAR - 1:
        tones = sorted(CH[chord_at(b)][1])
        pattern = [0, 2, 1, 3, 2, 1, 3, 2]
        for k, p in enumerate(pattern):
            m = tones[p % len(tones)] + 12
            add(arp, ep_note(m, 0.32 if k % 2 == 0 else 0.22, 1.2), t0 + k * BEAT / 2, pan=(-0.35 if k % 2 else 0.35))

# FX: risers into the hits, impacts on them.
for target, length in ((HIT["logo"], BAR), (HIT["heroLand"], BAR), (HIT["howLand"], BAR), (HIT["final"], BAR)):
    add(fx, riser(length - 0.3), target - length, gain=0.5 if target in (HIT["logo"], HIT["final"]) else 0.3)
for target, big in ((HIT["logo"], True), (HIT["heroLand"], False), (HIT["howLand"], False), (HIT["final"], True)):
    add(fx, crash(1.0 if big else 0.6, 4.5 if big else 3.0), target, gain=0.8)
    add(drums, kick(1.0), target, gain=0.75)
    if big:
        add(fx, boom(1.0), target, gain=0.55)
        # Chord stab: full, open pad + EP octave on the hit.
        for i, m in enumerate(CH["Cadd9"][1]):
            add(fx, pad_note(m + 12, 1.2, 1.0), target, pan=(i - 1.5) * 0.4, gain=0.07)
        add(fx, ep_note(72, 0.6, 4.0) + ep_note(79, 0.4, 4.0), target, gain=0.6)


# ---------------------------------------------------------------- mix and master
def process(board, buf):
    return board(buf.astype(np.float32), SR)


hall = Reverb(room_size=0.82, damping=0.55, wet_level=0.32, dry_level=0.75, width=1.0)
room = Reverb(room_size=0.35, damping=0.6, wet_level=0.12, dry_level=0.9, width=0.8)
stems = {
    "pad": process(Pedalboard([Chorus(rate_hz=0.3, depth=0.25, mix=0.35), Reverb(room_size=0.9, damping=0.6, wet_level=0.38, dry_level=0.7, width=1.0)]), pad),
    "ep": process(Pedalboard([Chorus(rate_hz=0.6, depth=0.15, mix=0.25), hall]), ep),
    "pulse": process(Pedalboard([room]), pulse),
    "bass": process(Pedalboard([LowpassFilter(cutoff_frequency_hz=220)]), bass),
    "drums": process(Pedalboard([room]), drums),
    "arp": process(Pedalboard([Delay(delay_seconds=BEAT * 0.75, feedback=0.32, mix=0.28), hall, HighpassFilter(cutoff_frequency_hz=300)]), arp),
    "fx": process(Pedalboard([Reverb(room_size=0.95, damping=0.5, wet_level=0.35, dry_level=0.8, width=1.0)]), fx),
}
gains = {"pad": 1.0, "ep": 0.9, "pulse": 0.9, "bass": 1.0, "drums": 1.0, "arp": 0.55, "fx": 0.9}
mix = sum(stems[k] * g for k, g in gains.items())

# Fader rides: the intro sits back (it's under a quiet hook), the turn swells into the logo hit, the
# breakdown dips a little. Gains in dB at times (s); linear in dB between points.
RIDE = [(0, -5), (TL["sections"][2][1], -5), (HIT["logo"] - 0.05, -1), (HIT["logo"], 0),
        (dict(TL["sections"])["split"], 0), (dict(TL["sections"])["split"] + 1, -2.5), (HIT["howLand"] - 2.4, -2.5), (HIT["howLand"], 0)]
tt = np.arange(mix.shape[1]) / SR
mix *= 10 ** (np.interp(tt, [p[0] for p in RIDE], [p[1] for p in RIDE]) / 20)

# Fade the ring-out to silence at the end of the video.
t = np.arange(mix.shape[1]) / SR
fade = np.clip((END - t) / 3.2, 0, 1) ** 1.5
fade[t < HIT["final"] + 1.0] = 1
mix *= fade
mix = mix[:, : int(END * SR)]

master = Pedalboard([
    HighpassFilter(cutoff_frequency_hz=34),
    LowShelfFilter(cutoff_frequency_hz=120, gain_db=1.0),
    HighShelfFilter(cutoff_frequency_hz=9000, gain_db=-2.0),  # tame air/fizz: no harshness
    Compressor(threshold_db=-20, ratio=2.0, attack_ms=25, release_ms=220),
    Limiter(threshold_db=-1.5, release_ms=120),
])
peak = np.max(np.abs(mix))
mix = mix / peak * 0.6
out = master(mix.astype(np.float32), SR)

frm, to = (float(sys.argv[2]), float(sys.argv[3])) if len(sys.argv) > 3 else (0.0, END)
seg = out[:, int(frm * SR): int(to * SR)]
if frm > 0 or to < END:  # preview: short fades so it doesn't click
    f = np.minimum(1, np.arange(seg.shape[1]) / (0.02 * SR))
    seg = seg * f * f[::-1]
wavfile.write(sys.argv[1], SR, (np.clip(seg.T, -1, 1) * 32767).astype(np.int16))
print(f"score: {sys.argv[1]} {seg.shape[1] / SR:.1f}s")
