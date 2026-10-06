"""Voiceover: one WAV per scripted line with Kokoro-82M af_heart (local, Apache-2.0, free).
Run through scripts/video/make-draft.sh (it provides the uv environment). Skips lines whose WAV
already exists for the same text, so re-runs only re-voice what changed.

Usage: tts.py <build_dir> [script.json]   (default video/scenes.json; video/story.json has a flat "lines" list)"""
import hashlib, json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(sys.argv[1], "audio")
os.makedirs(OUT, exist_ok=True)
scenes = json.load(open(sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "video", "scenes.json")))
voice = scenes["_meta"]["voice"]
items = [(f"{sc['id']}_{i}", line) for sc in scenes.get("scenes", []) for i, line in enumerate(sc["lines"])]
items += [(ln["id"], ln.get("say", ln["text"])) for ln in scenes.get("lines", [])]  # "say": pronunciation spelling
for name, line in items:
    key = hashlib.sha1(f"{voice}|{line}".encode()).hexdigest()[:10]
    target = os.path.join(OUT, f"{name}.wav")
    stamp = target + ".key"
    if os.path.exists(target) and os.path.exists(stamp) and open(stamp).read() == key:
        continue
    prefix = os.path.join(OUT, f"{name}_tmp")
    subprocess.run([sys.executable, "-m", "mlx_audio.tts.generate", "--model", "mlx-community/Kokoro-82M-bf16", "--text", line,
                    "--voice", voice, "--speed", "1.0", "--file_prefix", prefix, "--audio_format", "wav"], check=True, capture_output=True)
    os.replace(prefix + "_000.wav", target)
    open(stamp, "w").write(key)
    print("voiced", name)
print("tts done")
