"""Word timings for the story captions on Linux/WSL: the CPU twin of align.py (faster-whisper small.en),
same output (words.json). Audio goes in as 16 kHz mono float32 (PyAV 19 breaks faster-whisper file decoding).
Usage: ~/workspace/.video-venv/bin/python scripts/video/align-fw.py <build_dir> <story.json> id[,id...]"""
import json, sys
import numpy as np, soundfile as sf
from scipy.signal import resample_poly
from math import gcd
from faster_whisper import WhisperModel
B, story, ids = sys.argv[1], json.load(open(sys.argv[2])), sys.argv[3].split(",")
model = WhisperModel("small.en", device="cpu", compute_type="int8")
out = json.load(open(f"{B}/words.json"))
for ln in story["lines"]:
    if ln["id"] not in ids: continue
    a, sr = sf.read(f"{B}/audio-trim/{ln['id']}.wav", dtype="float32")
    if a.ndim > 1: a = a.mean(axis=1)
    g = gcd(sr, 16000); a = resample_poly(a, 16000 // g, sr // g).astype(np.float32)
    segs, _ = model.transcribe(a, word_timestamps=True, language="en")
    ws = [(w.word.strip(), round(w.start, 3), round(w.end, 3)) for s in segs for w in s.words]
    m = []
    for w in ws:
        if m and w[0].startswith("-"): m[-1] = (m[-1][0] + w[0], m[-1][1], w[2])
        else: m.append(w)
    ws = m; script = ln["text"].split(); ok = len(ws) == len(script)
    out[ln["id"]] = {"words": [{"w": script[i], "s": ws[i][1], "e": ws[i][2]} for i in range(len(script))] if ok else None, "heard": " ".join(w for w, _, _ in ws)}
    print(ln["id"], "OK" if ok else "MISMATCH", len(ws), len(script), "|", out[ln["id"]]["heard"])
# keep story order
order = [l["id"] for l in story["lines"]]
json.dump({k: out[k] for k in order if k in out}, open(f"{B}/words.json", "w"), indent=1)
