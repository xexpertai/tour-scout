"""Product footage for the story video (video/remotion), captured from the real app.

Usage: python3 scripts/video/footage.py <out_dir> [base_url]      (TAKES=a,b to re-shoot some takes)

Every take is captured with Chrome's screencast at 2560x1320 (the app at ?video=1.6667: the same layout
as 1920x990 at 125%), at the browser's own frame rate (~50 fps), then resampled to constant 30 fps
H.264. The extra resolution leaves headroom for zooms up to ~133% in the 1920x990 picture area.

Map tiles are pre-warmed in each take's browser context (the demo is loaded once, unfilmed), so the
filmed load has no tile pop. Each take records event marks (seconds from the take start) and element
rectangles (in take pixels) to <out_dir>/footage.json for the editor's zooms and callouts, and runs the
layout QA (scripts/video/layout-qa.js) at its key moments.

Only the "type" take calls an API: it resolves the act on Qloo (one cached lookup). It ends on a press of
"Scout the tour" (mouse down, so the ripple shows) without releasing, so no live run starts at all.
Everything else replays the Big Thief preset (captured from live Qloo data), its recorded scout exchange,
and a $0 apply."""
import base64, json, os, pathlib, re, shutil, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(sys.argv[1])
BASE = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:4518"
W, H = 2560, 1320
SCALE = "1.6667"
DEMO = f"{BASE}/?demo=us-emerging&video={SCALE}&check=0"        # the lead demo, no automatic route check
demo_url = lambda slug, check=False: f"{BASE}/?demo={slug}&video={SCALE}" + ("" if check else "&check=0")
FPS = 30
# SLOW=<rate> films every take in slow motion (the page's clocks run at <rate>, waits, typing and cursor
# moves are stretched by 1/<rate>), then plays it back at real speed. Use it on machines whose software
# renderer captures too few frames per second (WSL/llvmpipe: SLOW=0.25, MAP_RATE=0.06). Default 1: unchanged.
SLOW = float(os.environ.get("SLOW", "1"))
LAYOUT_JS = (ROOT / "scripts/video/layout-qa.js").read_text().split("\n", 2)[2]
OUT.mkdir(parents=True, exist_ok=True)
META_PATH = OUT / "footage.json"
META = json.loads(META_PATH.read_text()) if META_PATH.exists() else {}
QA: dict[str, list[str]] = {}

# A visible cursor and click ripple, drawn outside the app's zoomed root (sizes in capture pixels).
CURSOR_JS = """
(() => {
  let pos = { x: -100, y: -100 };
  const ensure = () => {
    const head = document.head || document.documentElement;
    if (!head) return;  // init scripts run before the document exists
    if (!document.getElementById('__ripple')) { const st = document.createElement('style'); st.id = '__ripple';
      st.textContent = '@keyframes __ripple{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}'; head.appendChild(st); }
    if (document.body && !document.getElementById('__cursor')) {
      const c = document.createElement('div'); c.id = '__cursor';
      c.style.cssText = 'position:fixed;width:44px;height:44px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))';
      c.innerHTML = '<svg width="44" height="44" viewBox="0 0 24 24"><path d="M4 2l15 9-6.5 1.5L9 19z" fill="#fff" stroke="#0b0b0f" stroke-width="1.5" stroke-linejoin="round"/></svg>';
      document.body.appendChild(c); place();
    }
  };
  const place = () => { const c = document.getElementById('__cursor'); if (c) { c.style.left = (pos.x - 7) + 'px'; c.style.top = (pos.y - 4) + 'px'; } };
  addEventListener('mousemove', (e) => { pos = { x: e.clientX, y: e.clientY }; ensure(); place(); }, true);
  addEventListener('mousedown', (e) => {
    const r = document.createElement('div');
    r.style.cssText = `position:fixed;left:${e.clientX - 36}px;top:${e.clientY - 36}px;width:72px;height:72px;border-radius:999px;border:4px solid #ff2e88;z-index:2147483646;pointer-events:none;animation:__ripple .65s ease-out forwards`;
    document.body.appendChild(r); setTimeout(() => r.remove(), 700);
  }, true);
  ensure();
  setInterval(ensure, 40);
})();
"""

# Map-only framing for the hero shots: the map pane fills the frame (no header, no plan pane).
MAP_ONLY_CSS = """
#app-root > header { display: none !important; }
#app-root main > div { grid-template-columns: 1fr !important; height: var(--app-h) !important; }
#app-root main > div > div:nth-child(2) { display: none !important; }
#app-root .print-map { height: var(--app-h) !important; border: 0 !important; }
"""


# Slow motion for the map takes: the page's clocks (performance.now, Date.now, rAF timestamps, timers)
# and its CSS animations run at RATE, so the WebGL map is captured at several times its effective
# frame rate; the encoder then plays the take back at real speed (frame timing is exact, not blended).
SLOW_JS = """
(() => {
  const R = __RATE__;
  const pn = performance.now.bind(performance), dn = Date.now, t0 = pn(), d0 = dn();
  performance.now = () => t0 + (pn() - t0) * R;
  Date.now = () => Math.round(d0 + (dn() - d0) * R);
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf(() => cb(performance.now()));
  const st = window.setTimeout.bind(window), si = window.setInterval.bind(window);
  window.setTimeout = (f, ms, ...a) => st(f, (ms || 0) / R, ...a);
  window.setInterval = (f, ms, ...a) => si(f, (ms || 0) / R, ...a);
})();
"""


def slow_page(page, rate):
    """Stretches the script's own waits, typing and cursor moves by 1/rate, so a take filmed with the
    page's clocks at `rate` keeps its real-speed pacing on playback."""
    if rate == 1.0:
        return page
    wait, move_, type_ = page.wait_for_timeout, page.mouse.move, page.keyboard.type
    pos = {"x": 0.0, "y": 0.0}
    def mv(x, y, steps=1):
        x0, y0 = pos["x"], pos["y"]
        for k in range(1, steps + 1):
            move_(x0 + (x - x0) * k / steps, y0 + (y - y0) * k / steps)
            wait(8 / rate)
        pos["x"], pos["y"] = x, y
    page.wait_for_timeout = lambda ms: wait(ms / rate)
    page.mouse.move = mv
    page.keyboard.type = lambda text, delay=0: type_(text, delay=delay / rate)
    goto = page.goto
    def go(url, wait_until=None, **kw):  # a slowed page may never go network-idle (stretched timers keep it busy)
        r = goto(url, wait_until="load" if wait_until == "networkidle" else wait_until, **kw)
        if wait_until == "networkidle":
            wait(2500 / rate)
        return r
    page.goto = go
    wfs = page.wait_for_selector
    page.wait_for_selector = lambda sel, timeout=None, **kw: wfs(sel, timeout=None if timeout is None else timeout / rate, **kw)
    page._rate = rate
    page.set_default_timeout(30000 / rate)
    return page


class Take:
    def __init__(self, ctx, page, name, rate=None):
        rate = getattr(page, "_rate", 1.0) if rate is None else rate
        self.rate = rate
        self.ctx, self.page, self.name = ctx, page, name
        self.dir = OUT / "frames" / name
        shutil.rmtree(self.dir, ignore_errors=True)
        self.dir.mkdir(parents=True)
        self.frames: list[tuple[float, str]] = []
        self.marks: dict[str, float] = {}
        self.rects: dict[str, dict] = {}
        self.cdp = ctx.new_cdp_session(page)
        self.cdp.on("Page.screencastFrame", self._frame)
        self.t0 = None

    def _frame(self, f):
        p = self.dir / f"{len(self.frames):06d}.jpg"
        p.write_bytes(base64.b64decode(f["data"]))
        self.frames.append((f["metadata"]["timestamp"], p.name))
        try:
            self.cdp.send("Page.screencastFrameAck", {"sessionId": f["sessionId"]})
        except Exception:
            pass

    def start(self):
        if self.rate != 1.0:
            self.cdp.send("Animation.enable")
            self.cdp.send("Animation.setPlaybackRate", {"playbackRate": self.rate})
        vp = self.page.viewport_size or {"width": W, "height": H}
        self.size = (vp["width"], vp["height"])
        self.cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 92, "maxWidth": vp["width"], "maxHeight": vp["height"], "everyNthFrame": 1})
        self.t0 = time.time()

    def mark(self, key):
        self.marks[key] = round((time.time() - self.t0) * self.rate, 3)

    def rect(self, key, locator):
        b = locator.first.bounding_box()
        if b:
            self.rects[key] = {k: round(v, 1) for k, v in b.items()}

    def qa(self, moment, need=None):
        issues = self.page.evaluate(LAYOUT_JS, need or [])
        if issues:
            QA.setdefault(self.name, []).extend(f"{moment}: {i}" for i in dict.fromkeys(issues))

    def stop(self):
        self.page.wait_for_timeout(250)
        self.cdp.send("Page.stopScreencast")
        end = time.time()
        frames = sorted(self.frames)
        # Resample to constant 30 fps: each output frame shows the latest captured frame at that time.
        start = self.t0
        n = int((end - start) * self.rate * FPS)
        lines, j = [], 0
        for k in range(n):
            t = start + k / FPS / self.rate
            while j + 1 < len(frames) and frames[j + 1][0] <= t:
                j += 1
            lines.append(f"file '{frames[j][1]}'\nduration {1 / FPS:.6f}")
        # Largest gap between captured frames during the take (a stall would show as a hitch).
        ts = [start + (f[0] - start) * self.rate for f in frames if f[0] >= start]  # in playback time
        gaps = max((b - a for a, b in zip(ts, ts[1:])), default=0)
        (self.dir / "times.json").write_text(json.dumps([round(t - start, 4) for t in ts]))
        (self.dir / "list.txt").write_text("\n".join(lines) + f"\nfile '{frames[j][1]}'\n")
        mp4 = OUT / f"{self.name}.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(self.dir / "list.txt"),
                        "-vf", f"fps={FPS},format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-movflags", "+faststart", str(mp4)], check=True)
        for jpg in self.dir.glob("*.jpg"):  # encoded: drop the raw frames (they run to hundreds of MB)
            jpg.unlink()
        META[self.name] = {"file": mp4.name, "seconds": round(n / FPS, 3), "width": self.size[0], "height": self.size[1], "marks": self.marks, "rects": self.rects,
                           "captured_fps": round(len(ts) / max(1e-6, ts[-1] - ts[0]), 1) if len(ts) > 1 else 0, "max_frame_gap": round(gaps, 3)}
        print(f"take {self.name}: {n / FPS:.1f}s, {META[self.name]['captured_fps']} fps captured, max gap {gaps * 1000:.0f} ms")
        META_PATH.write_text(json.dumps(META, indent=2))


# ---------------------------------------------------------------- helpers
def move(page, x, y, steps=22, pause=120):
    page.mouse.move(x, y, steps=steps)
    page.wait_for_timeout(pause)


def click(page, locator, pause=260):
    box = locator.first.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    move(page, x, y, 24, pause)
    page.mouse.down()
    page.wait_for_timeout(90)
    page.mouse.up()


def scroll_pane_to(page, selector, offset=24, smooth=True):
    """Scrolls the plan pane so the element's top sits `offset` capture px under the pane's top."""
    page.evaluate("""([s, o, smooth]) => { const pane = document.getElementById('plan-scroll'); const el = document.querySelector(s);
      if (!pane || !el) return; const z = Number(document.getElementById('app-root').dataset.present) || 1;
      // Rects are in viewport px; scrollTop is in the zoomed root's own px.
      const dy = (el.getBoundingClientRect().top - pane.getBoundingClientRect().top - o) / z;
      pane.scrollTo({ top: pane.scrollTop + dy, behavior: smooth ? 'smooth' : 'instant' }); }""", [selector, offset, smooth])


def context(browser, map_only=False, rate=None):
    """rate=None: the SLOW default, with the script's waits stretched to match (slow_page)."""
    stretch = rate is None
    rate = SLOW if rate is None else rate
    ctx = browser.new_context(viewport={"width": W, "height": H}, color_scheme="dark", reduced_motion="no-preference")
    ctx.add_init_script(CURSOR_JS)
    if rate != 1.0:
        ctx.add_init_script(SLOW_JS.replace("__RATE__", str(rate)))
    if map_only:
        ctx.add_init_script(f"""(() => {{ const css = {json.dumps(MAP_ONLY_CSS)}; const add = () => {{ if (document.getElementById('__maponly')) return;
          const s = document.createElement('style'); s.id = '__maponly'; s.textContent = css; const h = document.head || document.documentElement; if (h) h.appendChild(s); }};
          add(); document.addEventListener('DOMContentLoaded', add); setInterval(add, 100); }})();""")
    page = ctx.new_page()
    return ctx, (slow_page(page, rate) if stretch else page)


def demo_done(page, settle=11000, wait_until="networkidle", url=None):
    page.goto(url or DEMO, wait_until=wait_until)
    page.wait_for_selector("text=Credits", state="attached", timeout=30000)
    page.wait_for_timeout(settle)


def prewarm(page):
    """Loads the demo once (unfilmed) so the style, fonts and every tile the camera passes are cached."""
    demo_done(page, 9000)


# ---------------------------------------------------------------- takes
def take_type(browser):
    """Emerging-act mode: "Maya" is not the Maya on Qloo, so plan from the fans of an artist Maya sounds like."""
    ctx, page = context(browser)
    for n in ("Maya", "Joanna Sternberg"):  # cached lookups: no loading frames on film
        page.request.post(f"{BASE}/api/tour/resolve", data={"name": n, "kind": "artist"})
    page.goto(f"{BASE}/?video={SCALE}", wait_until="networkidle")
    page.wait_for_timeout(1500)
    page.mouse.move(1900, 1000)
    tk = Take(ctx, page, "type")
    tk.start()
    page.wait_for_timeout(400)
    tk.rect("search", page.locator("#artist-search"))
    click(page, page.locator("#artist-search"), 200)
    tk.mark("typing")
    page.keyboard.type("Maya", delay=220)
    tk.mark("typed")
    page.wait_for_timeout(400)
    click(page, page.get_by_role("button", name="Scout", exact=True), 180)
    page.wait_for_selector("text=Did you mean", timeout=30000)
    tk.mark("confirm")
    page.wait_for_timeout(300)
    tk.rect("candidate", page.locator("button:has-text('popularity')"))
    tk.rect("none", page.get_by_role("button", name=re.compile("None of these")))
    tk.qa("confirm", ["text:Did you mean"])
    page.wait_for_timeout(1300)
    click(page, page.get_by_role("button", name=re.compile("None of these")), 250)
    page.wait_for_selector("text=Emerging-act mode", timeout=10000)
    tk.mark("emerging")
    page.wait_for_timeout(700)
    box = page.get_by_label("Artist you sound like")
    tk.rect("soundsLike", box)
    click(page, box, 150)
    page.keyboard.type("Joanna Sternberg", delay=90)
    click(page, page.get_by_role("button", name="Find"), 150)
    row = page.locator("button:has-text('popularity')").first
    row.wait_for(timeout=30000)
    page.wait_for_timeout(500)
    click(page, row, 250)
    tk.mark("proxy")
    page.wait_for_timeout(600)
    rng = page.locator("input[type=range]").first
    rng.scroll_into_view_if_needed()
    lo, hi = page.evaluate("(el) => [Number(el.min), Number(el.max)]", rng.element_handle())
    rb = rng.bounding_box()
    move(page, rb["x"] + rb["width"] * (5 - lo) / (hi - lo), rb["y"] + rb["height"] / 2, 16, 120)
    page.mouse.down(); rng.fill("5"); page.mouse.up()
    for label, value in (("Minimum capacity", "100"), ("Maximum capacity", "300")):  # as the captured demo
        click(page, page.get_by_label(label), 120)
        page.keyboard.type(value, delay=110)
    tk.mark("filled")
    page.wait_for_timeout(400)
    btn = page.get_by_role("button", name="Scout with these fans")
    btn.scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    tk.rect("scoutFans", btn)
    tk.qa("filled", ["text:Scout with these fans"])
    b = btn.bounding_box()
    move(page, b["x"] + b["width"] / 2, b["y"] + b["height"] / 2, 22, 300)
    page.mouse.down()  # the press (and its ripple) is filmed; no release, so no live run starts
    tk.mark("scoutClick")
    page.wait_for_timeout(700)
    tk.stop()
    ctx.close()


MAP_RATE = float(os.environ.get("MAP_RATE", "0.25"))
MAP_WAIT = int(22500 / MAP_RATE)  # 90 s at the default rate


def take_map(browser):
    ctx, page = context(browser, map_only=True, rate=MAP_RATE)
    page.set_default_timeout(MAP_WAIT)
    demo_done(page, int(9000 / MAP_RATE), "load")  # pre-warm (unfilmed); the slowed page may never go network-idle
    page.goto(f"{BASE}/?video={SCALE}", wait_until="load")
    page.wait_for_timeout(3000)
    page.mouse.move(-50, -50)
    tk = Take(ctx, page, "map", MAP_RATE)
    tk.start()
    page.goto(DEMO, wait_until="domcontentloaded")
    tk.mark("load")
    page.wait_for_function("document.querySelectorAll('.maplibregl-marker').length > 0", timeout=MAP_WAIT)
    tk.mark("markers")
    page.wait_for_function("document.querySelectorAll('.maplibregl-marker.stop').length > 0", timeout=MAP_WAIT)
    tk.mark("stops")
    page.wait_for_selector("text=Credits", state="attached", timeout=MAP_WAIT)
    tk.mark("planDone")
    page.wait_for_selector(".maplibregl-marker.stop.on", timeout=MAP_WAIT)
    tk.mark("route")
    page.wait_for_timeout(int(5000 / MAP_RATE))
    tk.qa("end", [".maplibregl-marker.stop.on"])
    tk.stop()
    ctx.close()


def take_app(browser):
    """The full app during the replay: the ranked strip arrives in the plan pane."""
    ctx, page = context(browser)
    prewarm(page)
    page.goto(f"{BASE}/?video={SCALE}", wait_until="networkidle")
    page.mouse.move(2500, 1300)
    tk = Take(ctx, page, "app")
    tk.start()
    page.goto(DEMO, wait_until="domcontentloaded")
    strip = "ol[aria-label='Every city scored, best first']"
    page.wait_for_selector(strip, timeout=30000)
    tk.mark("strip")
    page.wait_for_selector("text=Credits", state="attached", timeout=30000)
    tk.mark("planDone")
    # The replay log collapses when the run finishes; rectangles are measured on the settled layout.
    page.wait_for_selector("text=Replaying a captured run", state="detached", timeout=30000)
    tk.mark("settled")
    page.wait_for_timeout(700)
    tk.rect("strip", page.locator(strip))
    tk.rect("coverage", page.locator(strip).locator("xpath=.."))
    cut = page.locator(f"{strip} [aria-label='cut line']")
    if cut.count():
        tk.rect("cut", cut)
    tk.rect("map", page.locator(".map-box"))
    tk.qa("end", [strip])
    page.wait_for_timeout(6500)
    tk.stop()
    ctx.close()


def take_ticket(browser):
    ctx, page = context(browser)
    demo_done(page)
    page.mouse.move(2400, 1250)
    tk = Take(ctx, page, "ticket")
    tk.start()
    page.wait_for_timeout(300)
    scroll_pane_to(page, "[data-stop]", 24)
    page.wait_for_timeout(1100)
    tk.mark("ticket")
    tk.rect("ticket", page.locator("[data-stop]"))
    tk.rect("rooms", page.locator("[data-stop] h4 + ul"))
    tk.rect("roomsHead", page.locator("[data-stop] h4"))
    tk.rect("opener", page.locator("[data-stop] p.font-display"))
    tk.rect("pitchBtn", page.get_by_role("button", name=re.compile("Pitch email to the booker|Support-slot request email")))
    tk.qa("ticket", ["[data-stop]", "[data-stop] p.font-display"])
    r = tk.rects["rooms"]
    move(page, r["x"] + r["width"] * 0.55, r["y"] + r["height"] * 0.35, 30, 200)
    tk.mark("rooms")
    page.wait_for_timeout(2300)
    o = tk.rects["opener"]
    move(page, o["x"] + o["width"] - 60, o["y"] + o["height"] * 0.55, 30, 200)  # beside the name, inside the frame
    tk.mark("opener")
    page.wait_for_timeout(2400)
    tk.mark("scroll")
    page.wait_for_timeout(900)  # the pitch button is already in view: no scroll (a scroll would cut the ticket)
    click(page, page.get_by_role("button", name=re.compile("Pitch email to the booker|Support-slot request email")), 300)
    tk.mark("pitchClick")
    page.wait_for_selector("[role=dialog]", timeout=10000)
    page.wait_for_timeout(700)
    tk.mark("pitch")
    tk.rect("dialog", page.locator("[role=dialog]"))
    tk.qa("pitch", ["[role=dialog]"])
    page.mouse.move(2500, 1250, steps=20)
    page.wait_for_timeout(4200)
    tk.stop()
    ctx.close()


def take_check(browser):
    """The agent route check runs by itself on the Maya demo: numbered trace, verdict, Apply, the ticket updates."""
    ctx, page = context(browser)
    prewarm(page)
    page.goto(f"{BASE}/?video={SCALE}", wait_until="networkidle")
    page.mouse.move(2500, 1300)
    tk = Take(ctx, page, "check")
    tk.start()
    page.goto(demo_url("us-emerging", check=True), wait_until="domcontentloaded")
    page.wait_for_selector("text=Credits", state="attached", timeout=30000)
    tk.mark("planDone")
    page.wait_for_selector("#ask ol li", timeout=30000)
    tk.mark("trace")
    page.wait_for_selector("#ask article[data-latest]", timeout=30000)
    tk.mark("answer")
    page.wait_for_timeout(900)
    tk.rect("dock", page.locator("#ask"))
    tk.rect("answer", page.locator("#ask article[data-latest]"))
    apply = page.get_by_role("button", name=re.compile("Apply to my tour"))
    tk.rect("apply", apply)
    tk.qa("answer", ["text:Apply to my tour"])
    page.wait_for_timeout(1200)
    tk.mark("applyReady")
    click(page, apply, 300)
    tk.mark("apply")
    page.wait_for_selector("text=Applied", timeout=20000)
    tk.mark("applied")
    notice = page.locator("[role=status]:has-text('This is your copy')")
    try:
        notice.wait_for(timeout=15000)
        tk.mark("copy")
    except Exception:
        pass
    page.wait_for_timeout(700)
    page.get_by_role("button", name=re.compile("^Hide( answers)?$")).first.click()
    page.wait_for_timeout(2600)  # the map redraws the changed route
    tk.mark("redrawn")
    if notice.count():
        tk.rect("copy", notice)
    tk.qa("redrawn", [".maplibregl-marker.stop.on"])
    page.wait_for_timeout(2400)
    tk.stop()
    ctx.close()


def take_phone(browser):
    """A phone (390 px layout, captured at 2x): the demo replays and the route check opens in the bottom sheet."""
    ctx = browser.new_context(viewport={"width": 780, "height": 1688}, color_scheme="dark", reduced_motion="no-preference", has_touch=True)
    ctx.add_init_script(CURSOR_JS)
    if SLOW != 1.0:
        ctx.add_init_script(SLOW_JS.replace("__RATE__", str(SLOW)))
    page = slow_page(ctx.new_page(), SLOW)
    url = f"{BASE}/?demo=us-emerging&video=2"
    page.goto(url, wait_until="networkidle"); page.wait_for_timeout(9000)  # pre-warm (unfilmed)
    page.goto(f"{BASE}/?video=2", wait_until="networkidle")
    tk = Take(ctx, page, "phone")
    tk.start()
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_selector("[role=region][aria-label='Agent route check'], [role=dialog][aria-label='Ask the scout'] article[data-latest]", timeout=60000)
    tk.mark("sheet")
    page.wait_for_timeout(3500)
    tk.qa("sheet", ["[aria-label='Agent route check']"])
    tk.stop()
    ctx.close()


def take_holds(browser):
    """Joe List's route check: the trace, then "the route holds" and why."""
    ctx, page = context(browser)
    demo_done(page, 9000, url=demo_url("us-comedian"))
    page.goto(f"{BASE}/?video={SCALE}", wait_until="networkidle")
    page.mouse.move(2500, 1300)
    tk = Take(ctx, page, "holds")
    tk.start()
    page.goto(demo_url("us-comedian", check=True), wait_until="domcontentloaded")
    page.wait_for_selector("text=Credits", state="attached", timeout=30000)
    tk.mark("planDone")
    page.wait_for_selector("#ask ol li", timeout=30000)
    tk.mark("trace")
    page.wait_for_selector("#ask article[data-latest]", timeout=30000)
    tk.mark("answer")
    page.wait_for_timeout(1200)
    tk.rect("answer", page.locator("#ask article[data-latest]"))
    tk.qa("answer", ["#ask article[data-latest]"])
    page.wait_for_timeout(4000)
    tk.stop()
    ctx.close()


def take_sponsor(browser):
    """The sponsor match from Qloo's brand graph (why-not-a-streaming-dashboard beat)."""
    ctx, page = context(browser)
    demo_done(page)
    page.mouse.move(2500, 1300)
    # No third-party trademarks on film: the brand names and film titles are blurred (the labels stay readable).
    page.evaluate("""() => { const st = document.createElement('style'); st.textContent = '.__tm{filter:blur(9px)}'; document.head.appendChild(st);
      const card = [...document.querySelectorAll('p')].find((p) => /^Sponsor match/i.test(p.textContent.trim()));
      card?.nextElementSibling?.classList.add('__tm');
      [...document.querySelectorAll('p')].filter((p) => /^Also into/.test(p.textContent.trim())).forEach((p) => p.nextElementSibling?.classList.add('__tm')); }""")
    tk = Take(ctx, page, "sponsor")
    tk.start()
    page.wait_for_timeout(400)
    scroll_pane_to(page, "#fans", 24)
    page.wait_for_timeout(1500)
    card = page.locator("text=Sponsor match").first.locator("xpath=ancestor::div[1]")
    card.scroll_into_view_if_needed()
    page.wait_for_timeout(900)
    tk.mark("sponsor")
    tk.rect("sponsor", card)
    tk.qa("sponsor", ["#fans"])
    page.wait_for_timeout(5000)
    tk.stop()
    ctx.close()


def take_receipts(browser):
    ctx, page = context(browser)
    demo_done(page)
    page.evaluate("document.getElementById('plan-scroll').scrollTo(0, 0)")
    page.mouse.move(2400, 1000)
    tk = Take(ctx, page, "receipts")
    tk.start()
    page.wait_for_timeout(500)
    tk.rect("toggle", page.get_by_role("switch", name="Show receipts"))
    click(page, page.get_by_role("switch", name="Show receipts"), 220)
    tk.mark("toggle")
    page.wait_for_timeout(1600)
    tk.rect("chip", page.locator("a[href='#source-Q6']"))
    click(page, page.locator("a[href='#source-Q6']"), 220)
    tk.mark("chip")
    page.wait_for_timeout(300)
    scroll_pane_to(page, "#source-Q6", 2)
    page.wait_for_timeout(900)
    click(page, page.locator("#source-Q6 summary"), 200)
    tk.mark("expand")
    page.wait_for_timeout(250)
    scroll_pane_to(page, "#source-Q6", 2)
    page.wait_for_timeout(900)
    tk.rect("row", page.locator("#source-Q6"))
    tk.rect("request", page.locator("#source-Q6 pre"))
    tk.mark("request")
    tk.qa("request", ["#source-Q6 pre"])
    page.mouse.move(2500, 1250, steps=20)
    page.wait_for_timeout(5000)
    tk.stop()
    ctx.close()


TAKES = {"type": take_type, "map": take_map, "app": take_app, "ticket": take_ticket, "check": take_check, "holds": take_holds, "phone": take_phone, "sponsor": take_sponsor, "receipts": take_receipts}

if __name__ == "__main__":
    only = [t for t in os.environ.get("TAKES", "").split(",") if t] or list(TAKES)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--enable-gpu-rasterization", "--ignore-gpu-blocklist"])
        for name in only:
            TAKES[name](browser)
        browser.close()
    META_PATH.write_text(json.dumps(META, indent=2))
    (OUT / "footage-qa.json").write_text(json.dumps(QA, indent=2))
    if QA:
        print("LAYOUT QA ISSUES:\n" + "\n".join(f"  {k}: {v}" for k, vs in QA.items() for v in vs))
        sys.exit(1)
    print("footage layout QA: clean")
