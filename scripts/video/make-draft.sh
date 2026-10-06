#!/bin/zsh
# One command for the whole video draft:  scripts/video/make-draft.sh [out_dir]
# 1) Kokoro af_heart voiceover per line (local, free)  2) scripted Playwright takes against a local
# production build  3) ffmpeg assembly with burned-in captions + .srt.
# Paid calls: the "live" take runs one live tour (~29 Qloo requests, 1 Claude Haiku call) and the
# "scout" take asks one question (2-4 Haiku calls). Everything else replays that run's stored plan.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:-$ROOT/video/out}
PORT=${PORT:-4518}
mkdir -p "$OUT/build"
cd "$ROOT"
echo "== voiceover"
uv run --quiet --python 3.12 --with mlx-audio --with "misaki[en]" --with num2words --with spacy python scripts/video/tts.py "$OUT/build"
echo "== app on :$PORT (fresh DATA_DIR, so the live run is not a reused one)"
rm -rf "$OUT/build/data"
npx next build > "$OUT/build/build.log" 2>&1
DATA_DIR="$OUT/build/data" LLM_PROVIDER=claude npx next start -p "$PORT" > "$OUT/build/server.log" 2>&1 &
STARTED=$!
for i in {1..40}; do curl -s -o /dev/null "http://localhost:$PORT/api/health" && break; sleep 1; done
echo "== takes"
python3 scripts/video/takes.py "$OUT/build" "http://localhost:$PORT" || { kill $STARTED; exit 1; }
kill $STARTED
grep -E '"event":"llm_(usage|error|bad_output)"' "$OUT/build/server.log" || true
echo "== assemble"
python3 scripts/video/assemble.py "$OUT/build" "$OUT/tour-scout-draft.mp4"
