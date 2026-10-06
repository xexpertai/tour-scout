"""Scripted, repeatable screen takes for the demo video. Re-shoot any time the UI or data changes:
`scripts/video/make-draft.sh <out_dir>`. Needs the app running at BASE with DATA_DIR=<build>/data.

The "live" take is the only one that calls an API: it starts one live tour (about 29 Qloo requests;
run the server with LLM_PROVIDER=scripted to spend nothing on Claude, since its text is never filmed).
Every other take replays the Big Thief preset and its recorded scout exchange, which cost nothing.
Nothing on screen shows credentials or personal data.

Usage: python3 scripts/video/takes.py <build_dir> [base_url]
Writes <build_dir>/takes/<scene>.(webm|png), <build_dir>/captions/<scene>_<i>.png, takes.json and
facts.json (the live run's stops, rooms and openers, to check the script's lines against)."""
import json, os, pathlib, re, subprocess, sys, time
from urllib.parse import quote
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
BUILD = pathlib.Path(sys.argv[1])
BASE = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:4518"
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


DEMO = "/?demo=us-indie-band"


def demo_done(page, settle=11500):
    """Opens the Big Thief preset and waits until its replay and map choreography have finished."""
    page.goto(BASE + DEMO, wait_until="networkidle")
    page.wait_for_selector("text=Credits", timeout=30000)
    page.wait_for_timeout(settle)


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


def route_act(page, s):
    # Filmed from the first frame: hotspots bloom, scores tick, the camera eases in, the route draws.
    page.goto(BASE + DEMO, wait_until="domcontentloaded")
    page.wait_for_timeout(int(s * 1000))


def scout_prepare(page):
    demo_done(page)
    page.wait_for_timeout(500)


def scout_act(page, s):
    page.get_by_role("button", name=re.compile("good opener")).first.click()
    page.wait_for_timeout(int(s * 1000))


def proposal_prepare(page):
    demo_done(page)
    page.get_by_role("button", name=re.compile("good opener")).first.click()
    page.wait_for_selector("text=Apply to my tour", timeout=30000)
    page.wait_for_timeout(800)
    page.get_by_role("button", name=re.compile("Apply to my tour")).first.scroll_into_view_if_needed()
    page.wait_for_timeout(500)


def proposal_act(page, s):
    page.wait_for_timeout(int(s * 450))
    page.get_by_role("button", name=re.compile("Apply to my tour")).first.hover()  # hover only: applying spends Qloo quota
    page.wait_for_timeout(int(s * 550))


def sources_prepare(page):
    demo_done(page)
    smooth_to(page, "[data-stop]", 70)
    page.wait_for_timeout(900)


def sources_act(page, s):
    page.wait_for_timeout(int(s * 200))
    page.get_by_role("switch", name="Show receipts").click()
    page.wait_for_timeout(int(s * 350))
    page.locator("[data-stop] a[href^='#source-']").first.click()
    page.wait_for_timeout(int(s * 450))


def presets_prepare(page):
    # The comedian replay finishes before filming starts, so the scene opens on a drawn route.
    page.goto(BASE + "/?demo=us-comedian", wait_until="networkidle")
    page.wait_for_selector("text=Credits", timeout=30000)
    page.wait_for_timeout(11000)


def presets_act(page, s):
    page.wait_for_timeout(int(s * 520))
    page.goto(BASE + "/?demo=uk-emerging", wait_until="domcontentloaded")
    page.wait_for_timeout(int(s * 480))


TAKES = {
    "live": (live_prepare, live_act),
    "route": (lambda p: (p.goto(BASE + "/", wait_until="networkidle"), p.wait_for_timeout(400)), route_act),
    "ticket": (lambda p: (demo_done(p), smooth_to(p, "[data-stop]", 70), p.wait_for_timeout(900)), lambda p, s: slow_scroll(p, 380, s * 0.85)),
    "pitch": (lambda p: (demo_done(p), smooth_to(p, "[data-stop]", 70), p.wait_for_timeout(800)),
              lambda p, s: (p.wait_for_timeout(int(s * 250)), p.get_by_role("button", name="Pitch email to the booker").first.click(), p.wait_for_timeout(int(s * 750)))),
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
    """What the filmed preset shows, to check the script's lines against."""
    run = json.load(open(ROOT / "public/presets/us-indie-band.json"))
    plan = next(e["event"]["plan"] for e in run["events"] if e["event"]["type"] == "plan")
    answer = next(e["event"]["followUp"] for e in run["scout"]["events"] if e["event"]["type"] == "answer")
    out = {"stops": [{"city": s["city"]["name"], "score": round(s["city"]["affinity"] * 100), "rooms": [v["name"] for v in s["venues"]], "opener": (s.get("opener") or {}).get("name")}
                     for s in sorted(plan["stops"], key=lambda s: s["order"])],
           "scout": {"q": run["scout"]["question"], "a": answer["answer"]["text"], "proposal": (answer.get("proposal") or {}).get("summary")}}
    json.dump(out, open(BUILD / "facts.json", "w"), indent=2)
    print(json.dumps(out, indent=2))


def main():
    # TAKES_ONLY=a,b re-shoots just those takes against the last run's stored plan (no new live run).
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
