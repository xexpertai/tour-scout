"""Assemble the draft video: per scene, the take (trimmed to its voiceover), the Kokoro voice lines
with short pauses, and burned-in captions (PNG overlays, so no libass/freetype is needed); then
concatenate. Also writes captions.srt (for YouTube CC) and fails if the cut is 150 s or longer
(the hackathon asks for a short demo; the brief is under 2:30).

Usage: python3 scripts/video/assemble.py <build_dir> <output.mp4>"""
import json, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
BUILD = pathlib.Path(sys.argv[1])
OUT = pathlib.Path(sys.argv[2])
SCENES = json.load(open(ROOT / "video/scenes.json"))["scenes"]
META = json.load(open(BUILD / "takes.json"))
GAP, TAIL, LEAD_IN = 0.35, 0.6, 0.25
W, H, FPS = 1366, 768, 30
BG = "0x0b0b0f"


def run(args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


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
    wavs = [BUILD / "audio" / f"{sid}_{i}.wav" for i in range(len(sc["lines"]))]
    lens = [dur(w) for w in wavs]
    total = max(LEAD_IN + sum(lens) + GAP * (len(lens) - 1) + TAIL, sc.get("minSeconds", 0))

    # caption windows (scene-local) and global SRT
    windows, t = [], LEAD_IN
    for i, L in enumerate(lens):
        windows.append((t, t + L + (GAP if i < len(lens) - 1 else TAIL * 0.6)))
        srt.append(f"{n}\n{ts(clock + t)} --> {ts(clock + t + L)}\n{sc['lines'][i]}\n")
        n += 1
        t += L + GAP

    inputs, vf = [], ""
    if m["kind"] == "still":
        inputs += ["-loop", "1", "-t", f"{total:.3f}", "-i", str(BUILD / m["file"])]
        vf = f"[0:v]scale={W}:{H},fps={FPS},setsar=1"
    else:
        start = max(0.0, m["lead"] - 0.1)
        inputs += ["-ss", f"{start:.2f}", "-t", f"{total:.3f}", "-i", str(BUILD / m["file"])]
        if m["kind"] == "phone":
            vf = f"[0:v]scale=-2:{H - 40},pad={W}:{H}:(ow-iw)/2:20:color={BG},fps={FPS},setsar=1"
        else:
            vf = f"[0:v]scale={W}:{H},fps={FPS},setsar=1"
        vf += f",tpad=stop_mode=clone:stop_duration={total:.3f},trim=duration={total:.3f}"
    # audio: lead-in silence, lines with gaps, tail
    for w in wavs:
        inputs += ["-i", str(w)]
    caps = [BUILD / "captions" / f"{sid}_{i}.png" for i in range(len(wavs))]
    for c in caps:
        inputs += ["-loop", "1", "-t", f"{total:.3f}", "-i", str(c)]
    na = len(wavs)
    filt = [vf + "[v0]"]
    last = "v0"
    for i, (a, b) in enumerate(windows):
        idx = 1 + na + i
        filt.append(f"[{last}][{idx}:v]overlay=0:0:enable='between(t,{a:.3f},{b:.3f})'[v{i + 1}]")
        last = f"v{i + 1}"
    t = LEAD_IN
    for i, L in enumerate(lens):
        ms = int(t * 1000)
        filt.append(f"[{1 + i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={ms}|{ms}[a{i}]")
        t += L + GAP
    filt.append("".join(f"[a{i}]" for i in range(na)) + f"amix=inputs={na}:normalize=0,apad=whole_dur={total:.3f}[aout]")
    part = BUILD / f"part_{len(parts):02d}_{sid}.mp4"
    run([*inputs, "-filter_complex", ";".join(filt), "-map", f"[{last}]", "-map", "[aout]", "-t", f"{total:.3f}",
         "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", str(FPS), "-c:a", "aac", "-b:a", "160k", str(part)])
    parts.append(part)
    clock += total
    print(f"{sid}: {total:.1f}s")

lst = BUILD / "parts.txt"
lst.write_text("".join(f"file '{p}'\n" for p in parts))
OUT.parent.mkdir(parents=True, exist_ok=True)
run(["-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", "-movflags", "+faststart", str(OUT)])
(OUT.with_suffix(".srt")).write_text("\n".join(srt))
length = dur(OUT)
print(f"draft video: {OUT} ({length:.1f}s)")
if length >= 150:
    sys.exit(f"too long: {length:.1f}s >= 150s")
