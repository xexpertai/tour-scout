"""Collects what the Remotion story needs into video/remotion: src/gen/data.json (video/story.json,
caption word timings, footage metadata, end-card config) and public/footage/*.mp4.
Usage: python3 scripts/video/story-data.py <build_dir>"""
import json, pathlib, shutil, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
BUILD = pathlib.Path(sys.argv[1])
RM = ROOT / "video/remotion"
(RM / "src/gen").mkdir(parents=True, exist_ok=True)
(RM / "public/footage").mkdir(parents=True, exist_ok=True)
footage = json.load(open(BUILD / "footage/footage.json"))
for take in footage.values():
    shutil.copy2(BUILD / "footage" / take["file"], RM / "public/footage" / take["file"])
words = json.load(open(BUILD / "words.json"))
missing = [k for k, v in words.items() if not v["words"]]
if missing:
    sys.exit(f"caption timing missing for: {missing}")
config = json.load(open(ROOT / "scripts/video/config.json"))
json.dump({"story": json.load(open(ROOT / "video/story.json")), "words": words, "footage": footage,
           "config": {k: config.get(k, "") for k in ("builtBy", "demoUrl", "repoUrl")}}, open(RM / "src/gen/data.json", "w"), indent=1)
print("story data ->", RM / "src/gen/data.json")
