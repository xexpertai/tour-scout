"""App layout QA for the product shots: walks the states the demo video films, at 1920x990 in the app's
presentation scale (?video=1), runs scripts/video/layout-qa.js in each, and saves full-size shots.

Checks per state: header fully in frame, no text cut by the frame or a pane edge, nothing under the
scout dock, no map label/pin collisions, the state's key element visible and uncovered, no skeletons,
mid-sentence ellipses, placeholders or stray spaces.

Usage: python3 scripts/video/app-qa.py <base_url> <out_dir>      (exit 1 if any issue)"""
import json, pathlib, re, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
BASE, OUT = sys.argv[1], pathlib.Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
JS = (ROOT / "scripts/video/layout-qa.js").read_text().split("\n", 2)[2]
issues: dict[str, list[str]] = {}


def check(page, name, need):
    found = page.evaluate(JS, need)
    if found:
        issues[name] = found
    page.screenshot(path=str(OUT / f"{name}.png"))
    print(("✗ " if found else "✓ ") + name + ("" if not found else ": " + "; ".join(found[:4])))


def demo(page, slug="us-indie-band"):
    page.goto(f"{BASE}/?demo={slug}&video=1", wait_until="networkidle")
    page.wait_for_selector("text=Credits", timeout=30000)
    page.wait_for_timeout(11000)


def to(page, selector, offset=8):
    page.evaluate("""([s, o]) => { const el = document.querySelector(s); if (el) { el.style.scrollMarginTop = o + 'px'; el.scrollIntoView({ block: 'start' }); } }""", [selector, offset])
    page.wait_for_timeout(400)


with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_page(viewport={"width": 1920, "height": 990}, color_scheme="dark")
    pg.goto(f"{BASE}/?video=1", wait_until="networkidle")
    pg.wait_for_timeout(5000)
    check(pg, "01-landing", ["h1"])
    pg.locator("#artist-search").fill("Big Thief")
    pg.get_by_role("button", name="Scout", exact=True).click()
    pg.wait_for_selector("text=Did you mean", timeout=30000)
    pg.wait_for_timeout(500)
    check(pg, "02-confirm", ["text:Did you mean"])
    demo(pg)
    check(pg, "03-route", [".maplibregl-marker.stop.on", "ol[aria-label='Every city scored, best first']"])
    to(pg, "[data-stop]")
    check(pg, "04-ticket", ["[data-stop]", "[data-stop] p.font-display"])
    pg.get_by_role("button", name="Pitch email to the booker").first.click()
    pg.wait_for_timeout(600)
    check(pg, "05-pitch", ["[role=dialog]"])
    pg.keyboard.press("Escape")
    pg.locator("button:has-text('instant')").first.click()
    pg.wait_for_selector("text=Apply to my tour", timeout=30000)
    pg.wait_for_timeout(600)
    check(pg, "06-scout-answer", ["text:Apply to my tour"])
    pg.get_by_role("button", name=re.compile("Apply to my tour")).first.click()
    pg.wait_for_selector("text=Applied", timeout=20000)
    pg.get_by_role("button", name="Hide answers").click()
    to(pg, "[data-stop]")
    check(pg, "07-applied", ["[data-stop] p.font-display"])
    demo(pg)
    pg.get_by_role("switch", name="Show receipts").click()
    pg.wait_for_timeout(400)
    check(pg, "08-receipts-on", ["a[href='#source-Q6']"])
    pg.locator("a[href='#source-Q6']").first.click()
    to(pg, "#source-Q6")
    pg.locator("#source-Q6 summary").first.click()
    to(pg, "#source-Q6")
    check(pg, "09-request", ["#source-Q6 pre"])
    for slug in ("us-comedian", "uk-emerging"):
        demo(pg, slug)
        check(pg, f"10-{slug}", [".maplibregl-marker.stop.on"])
    # Live run: the badge must not claim AI text before any is written.
    pg.goto(f"{BASE}/?video=1", wait_until="networkidle")
    pg.locator("#artist-search").fill("Big Thief")
    pg.get_by_role("button", name="Scout", exact=True).click()
    pg.wait_for_selector("text=Did you mean", timeout=30000)
    pg.get_by_role("button", name="Scout the tour").click()
    pg.wait_for_selector("text=Scouting live", timeout=15000)
    pg.wait_for_timeout(1500)
    badge = pg.locator("text=Live Qloo data").first.inner_text()
    if "Claude" in badge:
        issues["11-live-badge"] = [f"badge claims AI text during Phase A: {badge}"]
    check(pg, "11-live", ["text:Scouting live"])
    b.close()

(OUT / "app-qa.json").write_text(json.dumps(issues, indent=2))
print("APP QA " + ("PASS" if not issues else f"FAIL ({sum(len(v) for v in issues.values())} issues)"))
sys.exit(1 if issues else 0)
