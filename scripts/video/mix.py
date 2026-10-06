"""Audio for the story video: voice lines placed on the timeline, the score ducked under the voice,
then a two-pass loudness normalisation to -14 LUFS / -1.5 dBTP.

Usage (run through uv with numpy, scipy, pyloudnorm):
  mix.py <build_dir>      reads <build_dir>/audio-trim/<id>.wav and <build_dir>/music.wav; writes <build_dir>/mix.wav"""
import json, pathlib, re, subprocess, sys

import numpy as np
import pyloudnorm as pyln
from scipy.io import wavfile
from scipy.signal import resample_poly

ROOT = pathlib.Path(__file__).resolve().parents[2]
BUILD = pathlib.Path(sys.argv[1])
STORY = json.load(open(ROOT / "video/story.json"))
SR = 48000
END = STORY["timeline"]["end"]
N = int(END * SR)
MUSIC_UNDER_VOICE_DB = -10.0   # how far the score ducks while the voice speaks
MUSIC_BED_DB = -5.0            # the score's loudness relative to the voice when nobody speaks


def load(path):
    sr, x = wavfile.read(path)
    x = x.astype(np.float64) / (32768.0 if x.dtype == np.int16 else 1.0)
    if x.ndim == 1:
        x = np.vstack([x, x])
    else:
        x = x.T
    if sr != SR:
        x = np.vstack([resample_poly(c, SR, sr) for c in x])
    return x


voice = np.zeros((2, N))
active = np.zeros(N)
for ln in STORY["lines"]:
    x = load(BUILD / "audio-trim" / f"{ln['id']}.wav")
    i = int(ln["at"] * SR)
    n = min(x.shape[1], N - i)
    voice[:, i:i + n] += x[:, :n]
    active[i:i + n] = 1

music = load(BUILD / "music.wav")[:, :N]
music = np.pad(music, ((0, 0), (0, N - music.shape[1])))

meter = pyln.Meter(SR)
v_lufs = meter.integrated_loudness(voice[:, active > 0].T)
m_lufs = meter.integrated_loudness(music.T)
music *= 10 ** ((v_lufs + MUSIC_BED_DB - m_lufs) / 20)

# Ducking envelope: ramps down 150 ms before a line, holds, and recovers over 450 ms after it.
pre, rel = int(0.15 * SR), int(0.45 * SR)
gate = active.copy()
edges = np.flatnonzero(np.diff(np.r_[0, active, 0]))
starts, ends = edges[0::2], edges[1::2]
duck_db = np.zeros(N)
for s, e in zip(starts, ends):
    a = max(0, s - pre)
    duck_db[a:s] = np.minimum(duck_db[a:s], np.linspace(0, MUSIC_UNDER_VOICE_DB, s - a))
    duck_db[s:e] = MUSIC_UNDER_VOICE_DB
    r = min(N, e + rel)
    duck_db[e:r] = np.minimum(duck_db[e:r], np.linspace(MUSIC_UNDER_VOICE_DB, 0, r - e))
# Hits stay punchy: the duck lifts briefly on each musical hit, even under a line.
for name, t in STORY["timeline"]["hits"].items():
    i = int(t * SR)
    w = int(0.35 * SR)
    duck_db[i:i + w] = np.maximum(duck_db[i:i + w], MUSIC_UNDER_VOICE_DB / 2)
mix = voice + music * 10 ** (duck_db / 20)

pre_path = BUILD / "mix-pre.wav"
wavfile.write(pre_path, SR, (np.clip(mix.T / max(1.0, np.abs(mix).max()), -1, 1) * 32767).astype(np.int16))

# Two-pass loudnorm (linear) to -14 LUFS, true peak -1.5 dBTP.
first = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(pre_path), "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
m = json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", first, re.S).group(0))
af = (f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
      f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(pre_path), "-af", af, "-ar", str(SR), str(BUILD / "mix.wav")], check=True)
print(f"mix: voice {v_lufs:.1f} LUFS, score bed {MUSIC_BED_DB} dB vs voice, ducks {MUSIC_UNDER_VOICE_DB} dB -> {BUILD / 'mix.wav'}")
