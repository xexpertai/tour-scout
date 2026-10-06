"""Assembles the 1920x1080 video: per scene, the take (trimmed to its voiceover) with a slow 2% push-in,
the trimmed voice lines with short gaps, and the caption in a 90 px band below the 1920x990 frame
(PNG overlays, no libass needed); then concatenates and normalises loudness to -14 LUFS, true peak
-1.5 dBTP (two-pass loudnorm). Also writes captions.srt and fails if the cut exceeds maxSeconds.

Usage: python3 scripts/video/assemble.py <build_dir> <output.mp4>"""
import json, pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
BUILD = pathlib.Path(sys.argv[1])
OUT = pathlib.Path(sys.argv[2])
META_SCENES = json.load(open(ROOT / "video/scenes.json"))
SCENES, MAX = META_SCENES["scenes"], META_SCENES["_meta"].get("maxSeconds", 150)
META = json.load(open(BUILD / "takes.json"))
GAP, LEAD, TAIL = 0.25, 0.15, 0.3   # must match takes.py
W, H, APP_H, FPS = 1920, 1080, 990, 30
BAND = "0x050507"
PUSH = 0.02


def run(args, capture=False):
    return subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "info" if capture else "error", "-y", *args], check=True, capture_output=capture, text=True)


def dur(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def ts(t):
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


parts, srt, clock, n = [], [], 0.0, 1
for sc in SCENES:
    sid = sc["id"]
    m = META[sid]
    wavs = [BUILD / "audio-trim" / f"{sid}_{i}.wav" for i in range(len(sc["lines"]))]
    lens = [dur(w) for w in wavs]
    total = max(LEAD + sum(lens) + GAP * (len(lens) - 1) + TAIL, sc.get("minSeconds", 0))
    windows, t = [], LEAD
    for i, L in enumerate(lens):
        end = t + L + (GAP if i < len(lens) - 1 else TAIL)
        windows.append((t, min(end, total)))
        srt.append(f"{n}\n{ts(clock + t)} --> {ts(clock + t + L)}\n{sc['lines'][i]}\n")
        n += 1
        t += L + GAP
    inputs = []
    if m["kind"] == "still":
        inputs += ["-loop", "1", "-t", f"{total:.3f}", "-i", str(BUILD / m["file"])]
        base = f"[0:v]scale={W}:{APP_H},fps={FPS}"
    else:
        start = max(0.0, m["lead"] - 0.05)
        inputs += ["-ss", f"{start:.2f}", "-t", f"{total:.3f}", "-i", str(BUILD / m["file"])]
        base = f"[0:v]scale={W}:{APP_H},fps={FPS},tpad=stop_mode=clone:stop_duration={total:.3f},trim=duration={total:.3f}"
    # Slow push-in (2% over the scene) so no frame is static; centred crop keeps the edges' content.
    vf = (base + f",scale=w='2*trunc({W}*(1+{PUSH}*t/{total:.3f})/2)':h=-2:eval=frame,crop={W}:{APP_H},"
          f"pad={W}:{H}:0:0:color={BAND},setsar=1")
    for w in wavs:
        inputs += ["-i", str(w)]
    for i in range(len(wavs)):
        inputs += ["-loop", "1", "-t", f"{total:.3f}", "-i", str(BUILD / "captions" / f"{sid}_{i}.png")]
    na = len(wavs)
    filt, last = [vf + "[v0]"], "v0"
    for i, (a, b) in enumerate(windows):
        filt.append(f"[{last}][{1 + na + i}:v]overlay=0:{APP_H}:enable='between(t,{a:.3f},{b:.3f})'[v{i + 1}]")
        last = f"v{i + 1}"
    t = LEAD
    for i, L in enumerate(lens):
        ms = int(t * 1000)
        filt.append(f"[{1 + i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={ms}|{ms}[a{i}]")
        t += L + GAP
    filt.append("".join(f"[a{i}]" for i in range(na)) + f"amix=inputs={na}:normalize=0,apad=whole_dur={total:.3f}[aout]")
    part = BUILD / f"part_{len(parts):02d}_{sid}.mp4"
    run([*inputs, "-filter_complex", ";".join(filt), "-map", f"[{last}]", "-map", "[aout]", "-t", f"{total:.3f}",
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS), "-c:a", "pcm_s16le", str(part.with_suffix(".mkv"))])
    parts.append(part.with_suffix(".mkv"))
    clock += total
    print(f"{sid}: {total:.1f}s")

lst = BUILD / "parts.txt"
lst.write_text("".join(f"file '{p}'\n" for p in parts))
joined = BUILD / "joined.mkv"
run(["-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(joined)])
# Two-pass loudness normalisation to -14 LUFS integrated, -1.5 dBTP true peak.
target = "I=-14:TP=-1.5:LRA=11"
first = run(["-i", str(joined), "-af", f"loudnorm={target}:print_format=json", "-f", "null", "-"], capture=True).stderr
mjs = json.loads(re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", first)[-1])
second = f"loudnorm={target}:measured_I={mjs['input_i']}:measured_TP={mjs['input_tp']}:measured_LRA={mjs['input_lra']}:measured_thresh={mjs['input_thresh']}:offset={mjs['target_offset']}:linear=true"
OUT.parent.mkdir(parents=True, exist_ok=True)
run(["-i", str(joined), "-af", second + ",aresample=48000", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(OUT)])
OUT.with_suffix(".srt").write_text("\n".join(srt))
length = dur(OUT)
print(f"video: {OUT} ({length:.1f}s)")
if length >= MAX:
    sys.exit(f"too long: {length:.1f}s >= {MAX}s")
