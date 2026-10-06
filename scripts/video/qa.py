"""Video QA. Fails (exit 1) unless every check passes:
  - resolution is 1920x1080;
  - integrated loudness is -14 ±1 LUFS and true peak ≤ -1 dBTP;
  - no silence longer than 0.6 s between the first and last narrated line;
  - the per-take layout QA from takes.py is clean (header in frame, no clipped text, nothing under
    the dock, no map label collisions, narrated elements visible, no placeholders).
Also writes full-size frames (1920 px, every 2 s) and overview contact sheets.

Story mode (STORY=1, for the Remotion story video): the narration range comes from video/story.json,
silence is checked over the whole video except the final fade, the layout QA is the footage capture's
(footage/footage-qa.json), and it also checks 30 fps and a length of at most 1:50.

Usage: python3 scripts/video/qa.py <video.mp4> <build_dir> <qa_out_dir>        (STORY=1 for the story video)"""
import json, os, pathlib, re, shutil, subprocess, sys
from PIL import Image, ImageDraw

VIDEO, BUILD, OUT = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
OUT.mkdir(parents=True, exist_ok=True)
fails, notes = [], []
STORY = os.environ.get("STORY") == "1"
ROOT = pathlib.Path(__file__).resolve().parents[2]

w, h = map(int, subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(VIDEO)], capture_output=True, text=True, check=True).stdout.strip().split(",")[:2])
(fails if (w, h) != (1920, 1080) else notes).append(f"resolution {w}x{h}")

ln = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(VIDEO), "-af", "loudnorm=I=-14:TP=-1.5:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
m = json.loads(re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", ln)[-1])
li, tp = float(m["input_i"]), float(m["input_tp"])
(fails if not (-15 <= li <= -13) else notes).append(f"loudness {li:.1f} LUFS")
(fails if tp > -1.0 else notes).append(f"true peak {tp:.1f} dBTP")

if STORY:
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate:format=duration", "-of", "json", str(VIDEO)], capture_output=True, text=True, check=True).stdout
    pj = json.loads(probe)
    fps = eval(pj["streams"][0]["r_frame_rate"])  # e.g. "30/1"
    dur = float(pj["format"]["duration"])
    (fails if abs(fps - 30) > 0.01 else notes).append(f"frame rate {fps:g} fps")
    (fails if dur > 110 else notes).append(f"length {int(dur // 60)}:{dur % 60:04.1f}")
    first, last = 0.0, dur - 1.0  # the whole video, except the final fade
    # No static hold over 3 s in the picture area (the caption band is excluded).
    fz = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(VIDEO), "-vf", "crop=1920:990:0:0,freezedetect=n=0.001:d=3", "-an", "-f", "null", "-"], capture_output=True, text=True).stderr
    holds = [float(x) for x in re.findall(r"freeze_start: ([\d.]+)", fz)]
    (fails if holds else notes).append(f"static holds > 3 s: {len(holds)}" + (f" at {', '.join(f'{h:.1f}s' for h in holds)}" if holds else ""))
else:
    srt = (VIDEO.with_suffix(".srt")).read_text()
    times = [tuple(sum(float(x) * k for x, k in zip(re.split("[:,]", t)[:3], (3600, 60, 1))) + int(re.split("[:,]", t)[3]) / 1000 for t in pair) for pair in re.findall(r"(\S+) --> (\S+)", srt)]
    first, last = times[0][0], times[-1][1]
sd = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(VIDEO), "-af", "silencedetect=n=-45dB:d=0.6", "-f", "null", "-"], capture_output=True, text=True).stderr
starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", sd)]
ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", sd)]
long = [(s, e) for s, e in zip(starts, ends + [9e9][: len(starts) - len(ends)]) if e > first and s < last]
(fails if long else notes).append(f"silences > 0.6 s inside narration: {len(long)}" + (f" at {', '.join(f'{s:.1f}-{e:.1f}s' for s, e in long)}" if long else ""))

lj = BUILD / ("footage/footage-qa.json" if STORY else "qa/layout.json")
layout = json.loads(lj.read_text()) if lj.exists() else {}
count = sum(len(v) for v in layout.values())
(fails if count or not lj.exists() else notes).append(f"layout issues: {count}" + ("" if lj.exists() else " (no layout QA file)"))
if lj.exists():
    shutil.copy(lj, OUT / "layout.json")

frames = OUT / "frames"
shutil.rmtree(frames, ignore_errors=True)
frames.mkdir()
# Exactly t = 0, 2, 4 ... s (every 60th frame at 30 fps), so each file name is its true timestamp.
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(VIDEO), "-vf", "select='not(mod(n\\,60))'", "-fps_mode", "vfr", "-q:v", "2", str(frames / "t%03d.jpg")], check=True)
files = sorted(frames.glob("t*.jpg"))
for i, f in enumerate(files):  # name by timestamp
    t = i * 2
    f.rename(frames / f"{t // 60}m{t % 60:02d}s.jpg")
files = sorted(frames.glob("*.jpg"), key=lambda p: int(p.stem.split("m")[0]) * 60 + int(p.stem.split("m")[1][:-1]))
for old in OUT.glob("sheet-*.png"):
    old.unlink()
per = 12
for k in range(0, len(files), per):
    batch = files[k:k + per]
    tw, th = 640, 360
    sheet = Image.new("RGB", (tw * 3, (th + 28) * ((len(batch) + 2) // 3)), "#111")
    d = ImageDraw.Draw(sheet)
    for i, f in enumerate(batch):
        x, y = (i % 3) * tw, (i // 3) * (th + 28)
        sheet.paste(Image.open(f).resize((tw, th)), (x, y + 28))
        d.text((x + 8, y + 7), f.stem.replace("m", ":").rstrip("s"), fill="#fff")
    sheet.save(OUT / f"sheet-{k // per + 1:02d}.png")
report = {"pass": not fails, "fails": fails, "checks": notes, "frames": str(frames), "count": len(files)}
(OUT / "report.json").write_text(json.dumps(report, indent=2))
print("QA " + ("PASS" if not fails else "FAIL") + "\n  " + "\n  ".join(notes + [f"FAIL: {x}" for x in fails]) + f"\n  {len(files)} full-size frames in {frames}")
sys.exit(1 if fails else 0)
