#!/bin/zsh
# The story video (docs/VIDEO_STORYBOARD.md), end to end:  scripts/video/make-story.sh [out_dir]
#   1) Kokoro af_heart voice lines (video/story.json)      2) word timings for the captions (mlx-whisper)
#   3) the original score (scripts/video/score.py, CC0)   4) voice + ducked score, -14 LUFS / -1.5 dBTP
#   5) product footage from a local production build      6) Remotion render (video/remotion)
#   7) mux, then QA: frames every 2 s, loudness, true peak, silence, length, fps, layout
# Everything runs locally and free. FINAL=1 refuses to render without the demo and repo links.
# API use: the "type" take resolves the act on Qloo (one cached lookup); no live run and no model call.
# Everything else replays the captured Big Thief preset.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:-$ROOT/video/out/story}
B=$OUT/build
PORT=${PORT:-4519}
mkdir -p "$B"
cd "$ROOT"
if [[ "$FINAL" == "1" ]]; then
  python3 -c "import json,sys; c=json.load(open('scripts/video/config.json')); sys.exit(0 if c.get('demoUrl') and c.get('repoUrl') else 'FINAL render refused: set demoUrl and repoUrl in scripts/video/config.json')"
fi
echo "== voice"
uv run --quiet --python 3.12 --with mlx-audio --with "misaki[en]" --with num2words --with spacy python scripts/video/tts.py "$B" video/story.json
python3 scripts/video/trim.py "$B"
echo "== caption timings"
uv run --quiet --python 3.12 --with mlx-whisper python scripts/video/align.py "$B" video/story.json
echo "== score"
uv run --quiet --python 3.12 --with numpy --with scipy --with pedalboard python scripts/video/score.py "$B/music.wav"
uv run --quiet --python 3.12 --with numpy --with scipy --with pedalboard python scripts/video/score.py "$OUT/music-preview-14-34s.wav" 14 34
echo "== mix"
uv run --quiet --python 3.12 --with numpy --with scipy --with pyloudnorm python scripts/video/mix.py "$B"
echo "== footage (app on :$PORT, fresh DATA_DIR)"
rm -rf "$B/data" && mkdir -p "$B/data"
cp .cache/nominatim.json "$B/data/" 2>/dev/null || true
npx next build > "$B/build.log" 2>&1
DATA_DIR="$B/data" LLM_PROVIDER=claude npx next start -p "$PORT" > "$B/server.log" 2>&1 &
STARTED=$!
for i in {1..40}; do curl -s -o /dev/null "http://localhost:$PORT/api/health" && break; sleep 1; done
python3 scripts/video/footage.py "$B/footage" "http://localhost:$PORT" || { kill $STARTED; exit 1; }
kill $STARTED
grep -E '"event":"llm_(usage|error|bad_output)"' "$B/server.log" || echo "model calls: none"
echo "== render"
python3 scripts/video/story-data.py "$B"
(cd video/remotion && npm ci --silent --no-audit --no-fund && npx remotion render src/index.ts Story "$B/story-silent.mp4" --codec h264 --crf 16 --muted --log=error)
ffmpeg -hide_banner -loglevel error -y -i "$B/story-silent.mp4" -i "$B/mix.wav" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 256k -ar 48000 -shortest -movflags +faststart "$OUT/tour-scout-story.mp4"
echo "== qa"
STORY=1 python3 scripts/video/qa.py "$OUT/tour-scout-story.mp4" "$B" "$OUT/qa"
