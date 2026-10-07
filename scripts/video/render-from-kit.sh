#!/usr/bin/env bash
# Re-renders the story video from a saved kit, with no voice, caption-timing or footage step (those
# need Apple Silicon: mlx-audio, mlx-whisper). Use it for end-card link changes on any OS (WSL too).
#
#   scripts/video/render-from-kit.sh <kit_dir> [out_dir]
#
# <kit_dir> holds what make-story.sh built: footage/ (takes + footage.json + footage-qa.json),
# words.json (caption timings) and mix.wav (voice + score). The end-card links come from
# scripts/video/config.json; FINAL=1 refuses to render unless demoUrl and repoUrl are both set.
# Needs: node/npm, python3, ffmpeg (Remotion downloads its own headless Chrome).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
KIT=$(cd "$1" && pwd)
OUT=${2:-$ROOT/video/out/story}
mkdir -p "$OUT"
cd "$ROOT"
for f in footage/footage.json footage/footage-qa.json words.json mix.wav; do [[ -e "$KIT/$f" ]] || { echo "kit is missing $f" >&2; exit 1; }; done
if [[ "${FINAL:-}" == "1" ]]; then
  python3 -c "import json,sys; c=json.load(open('scripts/video/config.json')); sys.exit(0 if c.get('demoUrl') and c.get('repoUrl') else 'FINAL render refused: set demoUrl and repoUrl in scripts/video/config.json')"
fi
python3 scripts/video/story-data.py "$KIT"
(cd video/remotion && npm ci --silent --no-audit --no-fund && npx tsc -p . && npx remotion render src/index.ts Story "$OUT/story-silent.mp4" --codec h264 --crf 16 --muted --log=error)
ffmpeg -hide_banner -loglevel error -y -i "$OUT/story-silent.mp4" -i "$KIT/mix.wav" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 256k -ar 48000 -shortest -movflags +faststart "$OUT/tour-scout-story.mp4"
STORY=1 python3 scripts/video/qa.py "$OUT/tour-scout-story.mp4" "$KIT" "$OUT/qa"
echo "video -> $OUT/tour-scout-story.mp4 (frames to review: $OUT/qa/sheet-*.png)"
