"""Trims leading and trailing silence from every voiced line (audio/ → audio-trim/), so pauses between
lines are set only by the script's gaps. Usage: python3 scripts/video/trim.py <build_dir>"""
import pathlib, subprocess, sys

BUILD = pathlib.Path(sys.argv[1])
out = BUILD / "audio-trim"
out.mkdir(exist_ok=True)
SIL = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.06,areverse"
for wav in sorted((BUILD / "audio").glob("*.wav")):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav), "-af", SIL, str(out / wav.name)], check=True)
print(f"trimmed {len(list(out.glob('*.wav')))} lines")
