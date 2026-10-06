"""Scripted, repeatable screen takes for the demo video, with layout QA on every take.

Usage: python3 scripts/video/takes.py <build_dir> [base_url]      (FINAL=1 makes QA issues fatal)

Frames are 1920x990: the app in its presentation scale (?video=1, the layout at 125%, rendered natively
at 1920 px so text stays crisp); the assembled video adds a 90 px
caption band below, so captions never cover the app. Every narrated action is shown with a visible
cursor and a click ripple.

Only the "live" take calls an API: it types an act, starts a live tour and leaves after ~2 s of the
call log, which aborts the run before any model call. Every other take replays the Big Thief preset
(its recorded scout exchange, and an Apply that makes no Qloo or model call). Nothing on screen
shows credentials or personal data.

Writes <build_dir>/takes/<scene>.(webm|png), captions/<scene>_<i>.png, takes.json, facts.json and
qa/layout.json."""
import json, os, pathlib, re, subprocess, sys, time
from urllib.parse import quote, urlencode
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
BUILD = pathlib.Path(sys.argv[1])
BASE = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:4518"
FINAL = os.environ.get("FINAL") == "1"
CARDS = (ROOT / "scripts/video/cards.html").as_uri()
CONFIG = json.load(open(ROOT / "scripts/video/config.json"))
SCENES = json.load(open(ROOT / "video/scenes.json"))["scenes"]
GAP, LEAD, TAIL = 0.25, 0.15, 0.3   # must match assemble.py
FRAME = {"width": 1920, "height": 990}
VIDEO = "video=1"          # the app's presentation scale (see src/app/page.tsx)
DEMO = f"/?demo=us-indie-band&{VIDEO}"
ACT = {"name": "Big Thief", "stops": "5", "cap": ("300", "900")}
for d in ("takes", "captions", "raw", "qa"):
    (BUILD / d).mkdir(parents=True, exist_ok=True)
QA: dict[str, list[str]] = {}

# A visible cursor and a click ripple, drawn in the page (outside the zoomed root so sizes stay fixed).
CURSOR_JS = """
(() => {
  // React hydration can drop injected nodes, so the cursor is re-added by a watcher. It lives outside
  // the app's zoomed root, so mouse coordinates map 1:1.
  const z = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  let pos = { x: -100, y: -100 };
  const ensure = () => {
    const head = document.head || document.documentElement;
    if (!document.getElementById('__ripple')) { const st = document.createElement('style'); st.id = '__ripple';
      st.textContent = '@keyframes __ripple{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}'; head.appendChild(st); }
    if (document.body && !document.getElementById('__cursor')) {
      const c = document.createElement('div'); c.id = '__cursor';
      c.style.cssText = 'position:fixed;width:30px;height:30px;z-index:2147483647;pointer-events:none';
      c.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2l15 9-6.5 1.5L9 19z" fill="#fff" stroke="#0b0b0f" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      document.body.appendChild(c); place();
    }
  };
  const place = () => { const c = document.getElementById('__cursor'); if (c) { c.style.left = (pos.x / z() - 3) + 'px'; c.style.top = (pos.y / z() - 2) + 'px'; } };
  // Mouse events report device pixels; fixed elements inside the zoomed root use CSS pixels.
  addEventListener('mousemove', (e) => { pos = { x: e.clientX, y: e.clientY }; ensure(); place(); }, true);
  addEventListener('mousedown', (e) => {
    const r = document.createElement('div'); const x = e.clientX / z(), y = e.clientY / z();
    r.style.cssText = `position:fixed;left:${x - 24}px;top:${y - 24}px;width:48px;height:48px;border-radius:999px;border:3px solid #ff2e88;z-index:2147483646;pointer-events:none;animation:__ripple .6s ease-out forwards`;
    document.body.appendChild(r); setTimeout(() => r.remove(), 700);
  }, true);
  ensure();
  setInterval(ensure, 40);
})();
"""


def dur(wav):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(wav)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def scene_seconds(sc):
    # Voice lengths after silence trimming (assemble.py trims the same way and writes the trimmed files).
    lines = [dur(BUILD / "audio-trim" / f"{sc['id']}_{i}.wav") for i in range(len(sc["lines"]))]
    return max(LEAD + sum(lines) + GAP * (len(lines) - 1) + TAIL, sc.get("minSeconds", 0))


# ---------------------------------------------------------------- page helpers
def to(page, selector, offset=16, smooth=True):
    """Scrolls the plan pane (or the page) so the element's top lands `offset` px below the pane's top."""
    page.evaluate("""([s, o, smooth]) => { const el = document.querySelector(s); if (!el) return;
      el.style.scrollMarginTop = o + 'px'; el.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'instant' }); }""", [selector, offset, smooth])


def click(page, locator, pause=250):
    """Moves the visible cursor to the element, then clicks (a ripple shows the click)."""
    locator.scroll_into_view_if_needed()
    box = locator.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y, steps=18)
    page.wait_for_timeout(pause)
    page.mouse.down()
    page.wait_for_timeout(90)
    page.mouse.up()
    return x, y


def highlight(page, selector, on=True):
    page.evaluate("""([s, on]) => { const el = document.querySelector(s); if (!el) return;
      el.style.transition = 'box-shadow .35s ease, background .35s ease';
      el.style.boxShadow = on ? '0 0 0 3px #ff2e88' : ''; el.style.borderRadius = on ? '10px' : ''; }""", [selector, on])


# ---------------------------------------------------------------- layout QA
LAYOUT_JS = (ROOT / "scripts/video/layout-qa.js").read_text().split("\n", 2)[2]


def qa(page, scene, moment, need=None):
    issues = page.evaluate(LAYOUT_JS, need or [])
    if issues:
        QA.setdefault(scene, []).extend(f"{moment}: {i}" for i in dict.fromkeys(issues))


# ---------------------------------------------------------------- takes
def demo_done(page, slug="us-indie-band"):
    page.goto(f"{BASE}/?demo={slug}&{VIDEO}", wait_until="networkidle")
    page.wait_for_selector("text=Credits", timeout=30000)
    page.wait_for_timeout(11000)
    page.mouse.move(1700, 600)


def live_prepare(page):
    page.request.post(f"{BASE}/api/tour/resolve", data={"name": ACT["name"], "kind": "artist"})  # warm cache: no loading frame
    page.goto(f"{BASE}/?{VIDEO}", wait_until="networkidle")
    page.mouse.move(1500, 700)
    page.wait_for_timeout(400)


def live_act(page, s):
    t0 = time.monotonic()
    click(page, page.locator("#artist-search"), 150)
    page.keyboard.type(ACT["name"], delay=150)          # ~1.4 s of typing on screen
    page.wait_for_timeout(450)
    qa(page, "live", "typed", ["#artist-search"])
    click(page, page.get_by_role("button", name="Scout", exact=True), 150)
    page.wait_for_selector("text=Did you mean", timeout=30000)
    page.wait_for_timeout(900)                           # the confirm card holds ~1.8 s with the moves below
    qa(page, "live", "confirm", ["text:Did you mean"])
    page.locator("input[type=range]").fill(ACT["stops"])
    click(page, page.get_by_role("button", name="Scout the tour"), 200)
    page.wait_for_selector("text=Scouting live", timeout=15000)
    page.evaluate("""() => { const a = [...document.querySelectorAll('[aria-live=polite]')].find((x) => x.textContent.includes('Scouting live'));
      if (a) { a.style.transition = 'font-size .4s ease, box-shadow .4s ease'; a.style.fontSize = '1.25em'; a.style.boxShadow = '0 0 0 3px #ff2e88'; } }""")
    left = s - (time.monotonic() - t0)
    page.wait_for_timeout(int(max(left, 1.5) * 1000))
    qa(page, "live", "log", ["text:Scouting live"])
    # Leaving now aborts the run on the server before its single model call.


def map_prepare(page):
    demo_done(page)  # not filmed: caches the map style and tiles so the filmed load is instant
    page.goto(f"{BASE}/?{VIDEO}", wait_until="networkidle")


def map_act(page, s):
    page.goto(BASE + DEMO, wait_until="domcontentloaded")
    page.mouse.move(1700, 600)
    page.wait_for_timeout(int(s * 1000) - 300)
    qa(page, "map", "end", [".maplibregl-marker.stop.on"])


def strip_prepare(page):
    demo_done(page)
    to(page, "#plan-scroll section", 8, smooth=False)  # "The route" heading at the top of the pane
    page.wait_for_timeout(600)


def strip_act(page, s):
    page.wait_for_timeout(int(s * 120))
    page.evaluate("""() => { const el = document.querySelector("ol[aria-label='Every city scored, best first']");
      el.style.transition = 'font-size .5s ease, box-shadow .5s ease'; el.style.fontSize = '1.3em';
      el.style.boxShadow = '0 0 0 3px #ff2e88'; el.style.borderRadius = '10px'; el.style.padding = '8px'; el.style.background = 'var(--surface)'; }""")
    page.wait_for_timeout(int(s * 880) - 300)
    qa(page, "strip", "end", ["ol[aria-label='Every city scored, best first']"])


def ticket_prepare(page):
    demo_done(page)
    to(page, "[data-stop]", 12, smooth=False)
    page.wait_for_timeout(600)


def ticket_act(page, s):
    # Walk the narration: cluster, rooms, opener (each highlighted in turn).
    parts = ["[data-stop] p.flex", "[data-stop] h4 + ul", "[data-stop] p.font-display"]
    for i, sel in enumerate(parts):
        highlight(page, sel, True)
        page.wait_for_timeout(int(s * 1000 / len(parts)) - 120)
        if i == len(parts) - 1:
            qa(page, "ticket", "end", ["[data-stop]"])
        highlight(page, sel, False)


def pitch_act(page, s):
    click(page, page.get_by_role("button", name="Pitch email to the booker").first, 150)
    page.wait_for_timeout(int(s * 1000) - 900)
    qa(page, "pitch", "end", ["[role=dialog]"])


def scout_act(page, s):
    click(page, page.locator("button:has-text('instant')").first, 150)
    page.wait_for_timeout(int(s * 1000) - 800)
    qa(page, "scout", "end", ["#ask ol"])


def apply_prepare(page):
    demo_done(page)
    page.locator("button:has-text('instant')").first.click()
    page.wait_for_selector("text=Apply to my tour", timeout=30000)
    page.wait_for_timeout(500)
    page.get_by_role("button", name=re.compile("Apply to my tour")).first.scroll_into_view_if_needed()
    page.mouse.move(1500, 500)
    page.wait_for_timeout(300)


def apply_act(page, s):
    t0 = time.monotonic()
    click(page, page.get_by_role("button", name=re.compile("Apply to my tour")).first, 200)
    page.wait_for_selector("text=Applied", timeout=20000)
    page.wait_for_timeout(400)
    page.get_by_role("button", name="Hide answers").click()
    to(page, "[data-stop]", 12)
    page.wait_for_timeout(500)
    highlight(page, "[data-stop] p.font-display", True)
    page.wait_for_timeout(int(max(s - (time.monotonic() - t0), 1.2) * 1000))
    qa(page, "apply", "end", ["[data-stop] p.font-display"])


def receipts_prepare(page):
    demo_done(page)
    page.evaluate("document.getElementById('plan-scroll').scrollTo(0, 0)")
    page.wait_for_timeout(400)


def receipts_act(page, s):
    click(page, page.get_by_role("switch", name="Show receipts"), 120)
    page.wait_for_timeout(int(s * 280))
    click(page, page.locator("a[href='#source-Q6']").first, 150)
    page.wait_for_timeout(500)
    to(page, "#source-Q6", 12)
    page.wait_for_timeout(500)
    click(page, page.locator("#source-Q6 summary").first, 120)
    to(page, "#source-Q6", 12)
    page.wait_for_timeout(int(s * 1000 * 0.72) - 2300)
    qa(page, "receipts", "end", ["#source-Q6 pre"])


def preset_done(slug):
    return lambda page: demo_done(page, slug)


def hold_check(scene):
    def act(page, s):
        page.wait_for_timeout(int(s * 1000) - 200)
        qa(page, scene, "end", [".maplibregl-marker.stop.on"])
    return act


TAKES = {
    "live": (live_prepare, live_act),
    "map": (map_prepare, map_act),
    "strip": (strip_prepare, strip_act),
    "ticket": (ticket_prepare, ticket_act),
    "pitch": (ticket_prepare, pitch_act),
    "scout": (demo_done, scout_act),
    "apply": (apply_prepare, apply_act),
    "receipts": (receipts_prepare, receipts_act),
    "comedian": (preset_done("us-comedian"), hold_check("comedian")),
    "emerging": (preset_done("uk-emerging"), hold_check("emerging")),
}


def caption_pngs(browser):
    page = browser.new_page(viewport={"width": 1920, "height": 90})
    for sc in SCENES:
        for i, line in enumerate(sc["lines"]):
            page.goto(f"{CARDS}?card=caption&text={quote(line)}")
            page.wait_for_timeout(120)
            page.screenshot(path=str(BUILD / "captions" / f"{sc['id']}_{i}.png"))
    page.close()


def card_png(browser, name, path):
    page = browser.new_page(viewport=FRAME)
    params = {"card": name, "by": CONFIG.get("builtBy", ""), "demo": CONFIG.get("demoUrl", ""), "repo": CONFIG.get("repoUrl", "")}
    page.goto(f"{CARDS}?{urlencode(params)}", wait_until="networkidle")
    page.evaluate(f"document.documentElement.style.zoom = '{1920 / 1366}'")
    page.wait_for_timeout(600)
    qa(page, f"card:{name}", "still")
    page.screenshot(path=str(path))
    page.close()


def facts():
    run = json.load(open(ROOT / "public/presets/us-indie-band.json"))
    plan = next(e["event"]["plan"] for e in run["events"] if e["event"]["type"] == "plan")
    answer = next(e["event"]["followUp"] for e in run["scout"]["events"] if e["event"]["type"] == "answer")
    out = {"stops": [{"city": s["city"]["name"], "score": round(s["city"]["affinity"] * 100, 1), "opener": (s.get("opener") or {}).get("name")} for s in sorted(plan["stops"], key=lambda s: s["order"])],
           "scout": {"q": run["scout"]["question"], "proposal": (answer.get("proposal") or {}).get("summary")}}
    json.dump(out, open(BUILD / "facts.json", "w"), indent=2)
    return out


def main():
    if FINAL and not (CONFIG.get("demoUrl") and CONFIG.get("repoUrl")):
        sys.exit("FINAL render refused: set demoUrl and repoUrl in scripts/video/config.json")
    only = set(filter(None, os.environ.get("TAKES_ONLY", "").split(",")))
    meta = json.load(open(BUILD / "takes.json")) if only else {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        if not only:
            caption_pngs(browser)
        for sc in SCENES:
            if only and sc["id"] not in only:
                continue
            seconds = scene_seconds(sc)
            take = sc["take"]
            if take.startswith("card:"):
                card_png(browser, take[5:], BUILD / "takes" / f"{sc['id']}.png")
                meta[sc["id"]] = {"kind": "still", "file": f"takes/{sc['id']}.png", "seconds": seconds}
                continue
            raw = BUILD / "raw" / sc["id"]
            raw.mkdir(exist_ok=True)
            for f in raw.glob("*.webm"):
                f.unlink()
            ctx = browser.new_context(viewport=FRAME, record_video_dir=str(raw), record_video_size=FRAME, color_scheme="dark", reduced_motion="no-preference")
            ctx.add_init_script(CURSOR_JS)
            started = time.monotonic()
            page = ctx.new_page()
            prepare, act = TAKES[take]
            prepare(page)
            lead = time.monotonic() - started
            act(page, seconds)
            page.wait_for_timeout(300)
            video = page.video.path()
            ctx.close()
            dest = BUILD / "takes" / f"{sc['id']}.webm"
            os.replace(video, dest)
            meta[sc["id"]] = {"kind": "screen", "file": f"takes/{sc['id']}.webm", "lead": round(lead, 2), "seconds": seconds}
            print("take", sc["id"], f"{seconds:.1f}s lead {lead:.1f}s")
        browser.close()
    json.dump(meta, open(BUILD / "takes.json", "w"), indent=2)
    json.dump(QA, open(BUILD / "qa" / "layout.json", "w"), indent=2)
    print("facts", json.dumps(facts()))
    if QA:
        print("LAYOUT QA ISSUES:\n" + "\n".join(f"  {k}: {v}" for k, vs in QA.items() for v in vs))
        if FINAL:
            sys.exit("FINAL render refused: layout QA issues (see qa/layout.json)")
    else:
        print("layout QA: clean")


main()
