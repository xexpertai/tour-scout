"""Scripted, repeatable screen takes for the demo video. Re-shoot any time the UI or data changes:
`scripts/video/make-draft.sh <out_dir>`. Needs the app running at BASE with DATA_DIR=<build>/data.

The "live" take makes the only paid calls: one live tour (about 29 Qloo requests, one Claude Haiku
call); "scout" asks one question (two to four Haiku calls). Every later take opens that run's stored
plan at /t/<id>, which costs nothing. Nothing on screen shows credentials or personal data.

Usage: python3 scripts/video/takes.py <build_dir> [base_url]
Writes <build_dir>/takes/<scene>.(webm|png), <build_dir>/captions/<scene>_<i>.png, takes.json and
facts.json (the live run's stops, rooms and openers, to check the script's lines against)."""
import json, os, pathlib, re, subprocess, sys, time
from urllib.parse import quote
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
BUILD = pathlib.Path(sys.argv[1])
BASE = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:4518"
PLANS = BUILD / "data" / "plans"
CARDS = (ROOT / "scripts/video/cards.html").as_uri()
SCENES = json.load(open(ROOT / "video/scenes.json"))["scenes"]
GAP, TAIL = 0.35, 0.6
ACT = {"name": "Big Thief", "stops": "5", "cap": ("300", "900")}
for d in ("takes", "captions", "raw"):
    (BUILD / d).mkdir(parents=True, exist_ok=True)
state = {}


def dur(wav):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(wav)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def scene_seconds(sc):
    lines = [dur(BUILD / "audio" / f"{sc['id']}_{i}.wav") for i in range(len(sc["lines"]))]
    return max(sum(lines) + GAP * (len(lines) - 1) + TAIL, sc.get("minSeconds", 0))


def smooth_to(page, selector, offset=90):
    page.evaluate("([s, o]) => { const el = document.querySelector(s); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - o, behavior: 'smooth' }); }", [selector, offset])


def slow_scroll(page, total_px, seconds, steps=30):
    for _ in range(steps):
        page.mouse.wheel(0, total_px / steps)
        page.wait_for_timeout(int(seconds * 1000 / steps))


def newest_plan():
    files = sorted(PLANS.glob("*.json"), key=lambda f: f.stat().st_mtime)
    return files[-1].stem if files else None


def open_plan(page, settle=2500):
    page.goto(f"{BASE}/t/{state['plan']}", wait_until="networkidle")
    page.wait_for_timeout(settle)  # map fit and route draw


def live_prepare(page):
    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(600)


def live_act(page, s):
    t0 = time.monotonic()
    page.locator("#artist-search").click()
    page.keyboard.type(ACT["name"], delay=110)
    page.wait_for_timeout(400)
    page.get_by_role("button", name="Scout", exact=True).click()
    page.wait_for_selector("text=Did you mean", timeout=30000)
    page.wait_for_timeout(1300)
    page.locator("input[type=range]").fill(ACT["stops"])
    page.get_by_label("Minimum capacity").fill(ACT["cap"][0])
    page.get_by_label("Maximum capacity").fill(ACT["cap"][1])
    page.wait_for_timeout(500)
    page.get_by_role("button", name="Scout the tour").click()
    left = s - (time.monotonic() - t0)
    page.wait_for_timeout(int(max(left, 1) * 1000))
    # Not filmed (trimmed): let the run finish so later takes can open its stored plan.
    page.get_by_role("button", name="Share").wait_for(timeout=180000)
    page.wait_for_timeout(1500)
    state["plan"] = newest_plan()
    print("live plan", state["plan"])


def scout_prepare(page):
    open_plan(page)
    smooth_to(page, "#ask", 80)
    page.wait_for_timeout(900)


def scout_act(page, s):
    page.get_by_role("button", name=re.compile("good opener")).first.click()
    page.wait_for_timeout(int(s * 1000))
    # Not filmed: wait for the answer so the proposal take can show it.
    page.locator("text=AI scout").or_(page.locator("text=Templated scout")).first.wait_for(timeout=150000)
    page.wait_for_timeout(1500)


def proposal_prepare(page):
    open_plan(page)
    target = "#ask"
    smooth_to(page, target, 80)
    page.wait_for_timeout(700)
    apply = page.get_by_role("button", name=re.compile("Apply to my tour"))
    if apply.count():
        apply.first.scroll_into_view_if_needed()
        page.evaluate("window.scrollBy(0, -170)")  # keep the scout's answer text in frame above the button
    page.wait_for_timeout(700)


def proposal_act(page, s):
    page.wait_for_timeout(int(s * 450))
    apply = page.get_by_role("button", name=re.compile("Apply to my tour"))
    if apply.count():
        apply.first.hover()  # hover only: applying would spend Qloo quota and change the plan
    page.wait_for_timeout(int(s * 550))


def sources_prepare(page):
    open_plan(page)
    smooth_to(page, "[data-stop]", 70)
    page.wait_for_timeout(900)


def sources_act(page, s):
    page.wait_for_timeout(int(s * 250))
    page.locator("[data-stop] a[href^='#source-']").first.click()
    page.wait_for_timeout(int(s * 750))


def presets_prepare(page):
    # The comedian replay finishes before filming starts, so the scene opens on a drawn route.
    page.goto(BASE + "/?demo=us-comedian", wait_until="networkidle")
    page.wait_for_selector("text=Credits", timeout=30000)
    page.wait_for_timeout(8500)


def presets_act(page, s):
    page.wait_for_timeout(int(s * 520))
    page.goto(BASE + "/?demo=uk-emerging", wait_until="domcontentloaded")
    page.wait_for_timeout(int(s * 480))


TAKES = {
    "live": (live_prepare, live_act),
    "route": (open_plan, lambda p, s: (p.wait_for_timeout(int(s * 450)), p.evaluate("window.scrollTo({top: 330, behavior: 'smooth'})"), p.wait_for_timeout(int(s * 550)))),
    "ticket": (lambda p: (open_plan(p), smooth_to(p, "[data-stop]", 70), p.wait_for_timeout(900)), lambda p, s: slow_scroll(p, 420, s * 0.85)),
    "pitch": (lambda p: (open_plan(p), smooth_to(p, "[data-stop]", 70), p.wait_for_timeout(800)),
              lambda p, s: (p.wait_for_timeout(int(s * 200)), p.evaluate("() => { const el = [...document.querySelectorAll('[data-stop] p')].find((x) => x.textContent.startsWith('To: booker')) || document.querySelector('[data-stop] details'); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 120, behavior: 'smooth' }); }"), p.wait_for_timeout(int(s * 800)))),
    "scout": (scout_prepare, scout_act),
    "proposal": (proposal_prepare, proposal_act),
    "sources": (sources_prepare, sources_act),
    "presets": (presets_prepare, presets_act),
}


def caption_pngs(browser):
    page = browser.new_page(viewport={"width": 1366, "height": 768})
    for sc in SCENES:
        for i, line in enumerate(sc["lines"]):
            page.goto(f"{CARDS}?card=caption&text={quote(line)}")
            page.wait_for_timeout(150)
            page.screenshot(path=str(BUILD / "captions" / f"{sc['id']}_{i}.png"), omit_background=True)
    page.close()


def card_png(browser, name, path):
    page = browser.new_page(viewport={"width": 1366, "height": 768}, device_scale_factor=1)
    page.goto(f"{CARDS}?card={name}", wait_until="networkidle")
    page.wait_for_timeout(600)
    page.screenshot(path=str(path))
    page.close()


def facts():
    plan = json.load(open(PLANS / f"{state['plan']}.json"))
    out = {
        "plan": plan["id"], "llm": plan["mode"]["llm"], "withheld": plan["withheld"],
        "stops": [{"city": s["city"]["name"], "score": round(s["city"]["affinity"] * 100), "cluster": (s.get("cluster") or {}).get("name"),
                   "rooms": [v["name"] for v in s["venues"]], "opener": (s.get("opener") or {}).get("name")} for s in plan["stops"]],
        "followUps": [{"q": f["question"], "a": f["answer"]["text"], "proposal": (f.get("proposal") or {}).get("summary")} for f in plan.get("followUps", [])],
    }
    json.dump(out, open(BUILD / "facts.json", "w"), indent=2)
    print(json.dumps(out, indent=2))


def main():
    # TAKES_ONLY=a,b re-shoots just those takes against the last run's stored plan (no new live run).
    only = set(filter(None, os.environ.get("TAKES_ONLY", "").split(",")))
    meta = json.load(open(BUILD / "takes.json")) if only else {}
    if only:
        state["plan"] = json.load(open(BUILD / "facts.json"))["plan"]
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
            size = {"width": 1366, "height": 768}
            raw = BUILD / "raw" / sc["id"]
            raw.mkdir(exist_ok=True)
            for f in raw.glob("*.webm"):
                f.unlink()
            ctx = browser.new_context(viewport=size, record_video_dir=str(raw), record_video_size=size, color_scheme="dark", reduced_motion="no-preference")
            started = time.monotonic()
            page = ctx.new_page()
            prepare, act = TAKES[take]
            prepare(page)
            lead = time.monotonic() - started
            act(page, seconds)
            page.wait_for_timeout(400)
            video = page.video.path()
            ctx.close()
            dest = BUILD / "takes" / f"{sc['id']}.webm"
            os.replace(video, dest)
            meta[sc["id"]] = {"kind": "screen", "file": f"takes/{sc['id']}.webm", "lead": round(lead, 2), "seconds": seconds}
            print("take", sc["id"], f"{seconds:.1f}s lead {lead:.1f}s")
        browser.close()
    json.dump(meta, open(BUILD / "takes.json", "w"), indent=2)
    facts()


main()
