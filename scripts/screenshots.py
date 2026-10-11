"""README and Devpost screenshots from the demo presets (replays only: no API calls).
Usage: python3 scripts/screenshots.py [base_url]     writes docs/screenshots/*.png"""
import pathlib, re, sys
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3899"
OUT = pathlib.Path(__file__).resolve().parents[1] / "docs/screenshots"
OUT.mkdir(parents=True, exist_ok=True)


def demo(page, slug, settle=9500):
    page.goto(f"{BASE}/?demo={slug}", wait_until="networkidle")
    page.wait_for_selector("text=Credits", state="attached", timeout=30000)
    page.wait_for_timeout(settle)


def stop_check(page):
    """Waits for the automatic agent route check to finish replaying, then hides its answers."""
    page.wait_for_selector("#ask article[data-latest]", timeout=30000)
    page.wait_for_timeout(1500)


with sync_playwright() as p:
    # Headless Linux Chromium hints glyph advances to whole pixels, which spreads small Barlow text
    # unevenly ("comparis on"); real phones and desktops don't. Turn hinting off for true spacing.
    b = p.chromium.launch(args=["--font-render-hinting=none"])
    d = b.new_page(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    d.goto(f"{BASE}/", wait_until="networkidle"); d.wait_for_timeout(8000)
    d.screenshot(path=str(OUT / "landing.png"))
    # The fan map while cities are scored (mid-replay).
    d.goto(f"{BASE}/?demo=us-emerging", wait_until="domcontentloaded"); d.wait_for_timeout(2600)
    d.screenshot(path=str(OUT / "fan-map.png"))
    # The agent route check runs by itself once the route is drawn: its trace, then its answer.
    d.goto(f"{BASE}/?demo=us-emerging", wait_until="domcontentloaded")
    d.wait_for_selector("#ask ol li", timeout=60000); d.wait_for_timeout(2200)
    d.screenshot(path=str(OUT / "scout-working.png"))
    stop_check(d)
    d.screenshot(path=str(OUT / "scout-answer.png"))
    d.get_by_role("button", name="Hide", exact=True).click(); d.wait_for_timeout(500)
    d.screenshot(path=str(OUT / "route.png"))
    d.get_by_role("switch", name="Show receipts").click(); d.wait_for_timeout(600)
    d.screenshot(path=str(OUT / "receipts.png"))
    d.get_by_role("switch", name="Show receipts").click()
    d.evaluate("document.querySelector('[data-stop]').scrollIntoView({block:'start'})"); d.wait_for_timeout(400)
    d.get_by_role("button", name=re.compile("Pitch email to the booker|Support-slot request email")).first.click(); d.wait_for_timeout(700)
    d.screenshot(path=str(OUT / "pitch.png"))
    d.keyboard.press("Escape")
    demo(d, "us-comedian"); stop_check(d)
    d.screenshot(path=str(OUT / "route-comedian.png"))
    demo(d, "us-americana"); stop_check(d)
    d.get_by_role("button", name="Hide", exact=True).click(); d.wait_for_timeout(500)
    d.screenshot(path=str(OUT / "route-americana.png"))
    m = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme="dark")
    demo(m, "us-emerging")
    # The route check arrives as a peek above the stop chips (the map stays in view); tapping it opens the sheet.
    m.wait_for_selector("[role=region][aria-label='Agent route check']", timeout=30000)
    m.wait_for_timeout(1200)
    m.screenshot(path=str(OUT / "mobile-route.png"))
    m.get_by_role("button", name="Open the scout's answer").click(); m.wait_for_timeout(1200)
    m.screenshot(path=str(OUT / "mobile-check.png"))
    m.get_by_role("button", name="Close").click(); m.wait_for_timeout(500)
    m.evaluate("document.querySelector('[data-stop]').scrollIntoView({block:'center'})"); m.wait_for_timeout(800)
    m.screenshot(path=str(OUT / "mobile-ticket.png"))
    b.close()
print("screenshots ->", OUT)
