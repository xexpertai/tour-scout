#!/usr/bin/env bash
# Smoke test of the production server with NO Qloo key and no harness (the state after the event key
# stops working): demo tours, their scout replay and Apply, and share links must work; live searches
# and tours must be refused at once with a clear message. Needs a build (npm run build).
#   scripts/smoke-nokey.sh            (port 3911 by default)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-3911}
RUN=$(mktemp -d)
trap 'kill "${PID:-0}" 2>/dev/null || true; [[ -n "${KEEP:-}" ]] && echo "server log: $RUN/server.log" || rm -rf "$RUN"' EXIT
cp -R .next/standalone/. "$RUN/"; rm -rf "$RUN/.cache"; mkdir -p "$RUN/.next" "$RUN/data"; cp -R .next/static "$RUN/.next/static"
# A clean environment: no keys, no .env files, no harness on PATH.
(cd "$RUN" && exec env -i PATH="/usr/bin:/bin:$(dirname "$(command -v node)")" HOME="$RUN" NODE_ENV=production PORT="$PORT" HOSTNAME=127.0.0.1 \
  DATA_DIR="$RUN/data" QLOO_BIN=/nonexistent/qloo LLM_PROVIDER=claude node server.js > "$RUN/server.log" 2>&1) & PID=$!
for _ in $(seq 1 40); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/health" && break; sleep 0.5; done
python3 - "$PORT" <<'PY'
import json, sys, time, urllib.request, urllib.error
base = f"http://127.0.0.1:{sys.argv[1]}"
def post(path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    t = time.time()
    try:
        with urllib.request.urlopen(req) as r: return r.status, r.read().decode(), time.time() - t
    except urllib.error.HTTPError as e: return e.code, e.read().decode(), time.time() - t
ok = True
def check(name, cond, detail=""):
    global ok
    ok &= bool(cond); print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail else ""))
health = json.load(urllib.request.urlopen(base + "/api/health"))
check("health answers without a key", health.get("ok") and health.get("qloo") == "mock", health.get("qlooReason"))
for slug in ("us-emerging", "us-comedian", "us-americana"):
    check(f"demo page {slug}", urllib.request.urlopen(f"{base}/?demo={slug}").status == 200)
    check(f"preset data {slug}", urllib.request.urlopen(f"{base}/presets/{slug}.json").status == 200)
# The lead demo's recorded route check proposes a change.
preset = json.load(urllib.request.urlopen(base + "/presets/us-emerging.json"))
status, body, _ = post("/api/tour/apply", {"preset": "us-emerging", "question": preset["scout"]["question"]})
plan = next((json.loads(l)["plan"] for l in body.splitlines() if l.strip() and json.loads(l).get("type") == "plan"), None)
check("recorded scout answer applies with no key", status == 200 and plan, f"HTTP {status}")
if plan:
    check("share link opens", urllib.request.urlopen(f"{base}/t/{plan['id']}").status == 200)
status, body, secs = post("/api/tour/resolve", {"name": "Big Thief", "kind": "artist"})
check("live search refused clearly and fast", status == 503 and "demo tours still work" in body and secs < 3, f"HTTP {status} in {secs:.1f}s")
status, body, secs = post("/api/tour", {"artist": {"id": "x", "name": "x", "type": "artist"}, "region": "United States", "stops": 5})
check("live tour refused clearly and fast", status in (400, 503) and secs < 3, f"HTTP {status} in {secs:.1f}s")
print("NO-KEY SMOKE " + ("PASS" if ok else "FAIL")); sys.exit(0 if ok else 1)
PY
