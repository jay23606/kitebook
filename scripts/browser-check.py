# Smoke helper: load a Kitebook server page in headless Chromium and fail on any page JS error (uncaught exception or console.error).
# A syntax slip in the inline page script (e.g. a // comment that swallows the next statement) breaks the page while every
# curl/grep check still passes; only a real browser sees it.
#   python3 scripts/browser-check.py <url> [--jar curl-cookie-jar] [--expect "text"]... [--wait-gone "Loading…"] [--click "css selector"]...
#     [--max "css=N"]... (at most N visible matches before the clicks) [--count "css=N"]... (exactly N visible after them) [--wait seconds]
# --expect-tab: text a tab the page opened must show (the consent page hands the app's callback to a new tab and stays on Connected).
# --click: after the page settles, click each selector in order (e.g. a radio, a checkbox, a Save button), then the --expect texts
# are waited for (up to 10 s), so a flow that signs and saves in the browser is checked end to end. --before: text that must show
# before the clicks (what the page said first).
# --fill "css=value" / --select "css=value": type into a field / pick an option, in order with the --clicks (one ordered list of steps).
# --profile DIR: a persistent browser profile (cookies + IndexedDB survive between runs: the owner's browser key, its sign-in).
# --shot file.png [--viewport phone|desktop] [--dark]: a full-page screenshot at the end (phone 390x844, desktop 1280x900; system dark mode).
# --linger N: stay N seconds after the checks (let a page finish background work, e.g. registering its key).
# Env: KITEBOOK_PW_PY (Playwright for Python dir), KITEBOOK_CHROMIUM (chromium binary), KITEBOOK_CHROMIUM_LIBS (extra lib dir). Exit 0 ok, 1 page errors / missing text, 3 no browser.
import sys, os, argparse
class Step(argparse.Action):  # --click / --fill / --select keep their order
    def __call__(self, parser, ns, value, opt=None): ns.steps = (getattr(ns, "steps", None) or []) + [(self.dest, value)]
ap = argparse.ArgumentParser(); ap.add_argument("url"); ap.add_argument("--jar"); ap.add_argument("--expect", action="append", default=[]); ap.add_argument("--wait-gone"); ap.add_argument("--click", action=Step); ap.add_argument("--fill", action=Step); ap.add_argument("--select", action=Step)
ap.add_argument("--profile"); ap.add_argument("--shot"); ap.add_argument("--viewport", default="desktop"); ap.add_argument("--dark", action="store_true"); ap.add_argument("--linger", type=float, default=0); ap.add_argument("--before", action="append", default=[]); ap.add_argument("--max", action="append", default=[]); ap.add_argument("--count", action="append", default=[]); ap.add_argument("--wait", type=float, default=10); ap.add_argument("--expect-tab", action="append", default=[])
a = ap.parse_args(); a.steps = getattr(a, "steps", None) or []; a.click = [v for k, v in a.steps if k == "click"]
# Where Playwright and Chromium come from, first hit wins: KITEBOOK_PW_PY / KITEBOOK_CHROMIUM, then a normal `pip install playwright` +
# `python -m playwright install chromium` (Playwright's own Chromium, what CI uses), then the unpacked copies of the dev sandbox.
pw_py = os.environ.get("KITEBOOK_PW_PY") or ("/workspace/work/pwtool/py" if os.path.isdir("/workspace/work/pwtool/py") else None)
try:
    from playwright.sync_api import sync_playwright
except Exception:
    if pw_py: sys.path.insert(0, pw_py)
    try: from playwright.sync_api import sync_playwright
    except Exception: print("no playwright (pip install playwright && python -m playwright install --with-deps chromium)"); sys.exit(3)
SANDBOX_EXE = "/workspace/work/pwtool/chroot/usr/lib/chromium/chromium"
exe = os.environ.get("KITEBOOK_CHROMIUM") or None  # None = Playwright's bundled Chromium
if exe and not os.path.exists(exe): print("no chromium at KITEBOOK_CHROMIUM=" + exe); sys.exit(3)
cookies = []
if a.jar and os.path.exists(a.jar):  # curl's Netscape jar; HttpOnly lines start with #HttpOnly_
    for line in open(a.jar):
        line = line.rstrip("\n")
        if line.startswith("#HttpOnly_"): line = line[len("#HttpOnly_"):]
        elif not line or line.startswith("#"): continue
        f = line.split("\t")
        if len(f) == 7: cookies.append({"name": f[5], "value": f[6], "domain": f[0], "path": f[2], "httpOnly": True})
errs = []
with sync_playwright() as p:
    libs = os.environ.get("KITEBOOK_CHROMIUM_LIBS", "/workspace/work/pwtool/libdeb/root/usr/lib/aarch64-linux-gnu")  # extra shared libs for an unpacked Chromium
    env = {**os.environ, **({"LD_LIBRARY_PATH": libs + ":" + os.environ.get("LD_LIBRARY_PATH", "")} if os.path.isdir(libs) else {})}
    vp = {"width": 390, "height": 844} if a.viewport == "phone" else {"width": 1100, "height": 300} if a.viewport == "term" else {"width": 1280, "height": 900}
    opts = {"viewport": vp, "color_scheme": "dark" if a.dark else "light", **({"device_scale_factor": 2, "is_mobile": True, "has_touch": True} if a.viewport == "phone" else {})}
    if not exe and not os.path.exists(p.chromium.executable_path) and os.path.exists(SANDBOX_EXE): exe = SANDBOX_EXE
    if not exe and not os.path.exists(p.chromium.executable_path): print("no chromium (python -m playwright install --with-deps chromium)"); sys.exit(3)
    try:
        if a.profile: b = ctx = p.chromium.launch_persistent_context(a.profile, executable_path=exe, args=["--no-sandbox", "--disable-gpu", "--no-proxy-server"], env=env, **opts)
        else: b = p.chromium.launch(executable_path=exe, args=["--no-sandbox", "--disable-gpu", "--no-proxy-server"], env=env); ctx = b.new_context(**opts)
    except Exception as e: print("chromium did not start: " + str(e).split("\n")[0][:300]); sys.exit(3)
    ctx.add_cookies(cookies) if cookies else None
    pg = ctx.new_page(); tabs = []; ctx.on("page", lambda t: tabs.append(t))
    pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
    pg.on("console", lambda m: errs.append("console.error: " + m.text) if m.type == "error" and "favicon" not in (m.location or {}).get("url", "") else None)  # the browser's own favicon probe isn't the page's fault
    pg.on("dialog", lambda d: d.dismiss())
    pg.goto(a.url); pg.wait_for_load_state("networkidle")
    if a.wait_gone:
        for _ in range(40):
            if a.wait_gone not in pg.inner_text("body"): break
            pg.wait_for_timeout(250)
        else: errs.append(f"still showing {a.wait_gone!r}: the page script never finished")
    first = pg.inner_text("body")
    for t in a.before:
        if t not in first: errs.append(f"missing text before the clicks {t!r}")
    # visible = what a person sees: fields inside a closed <details> still have layout boxes in Chromium (content-visibility), so ask checkVisibility
    vis = lambda sel: pg.eval_on_selector_all(sel, "els=>els.filter(e=>e.checkVisibility?e.checkVisibility({visibilityProperty:true}):!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)).length")
    for m in a.max:
        sel, n = m.rsplit("=", 1)
        if vis(sel) > int(n): errs.append(f"{vis(sel)} visible {sel!r} before the clicks, at most {n} wanted")
    for kind, v in a.steps:
        try:
            if kind == "click": pg.click(v, timeout=5000)
            else:
                sel, val = v.rsplit("=", 1)
                if kind == "fill": pg.fill(sel, val, timeout=5000)
                else: pg.select_option(sel, val, timeout=5000)
            pg.wait_for_timeout(200)
        except Exception as e: errs.append(f"{kind} {v!r}: " + str(e).split("\n")[0][:200])
    for m in a.count:
        sel, n = m.rsplit("=", 1)
        if vis(sel) != int(n): errs.append(f"{vis(sel)} visible {sel!r} after the clicks, {n} wanted")
    for _ in range(int(a.wait * 4) if a.steps else 1):
        body = pg.inner_text("body")
        if all(t in body for t in a.expect): break
        pg.wait_for_timeout(250)
    for t in a.expect:
        if t not in body: errs.append(f"missing text {t!r}")
    if a.expect_tab:
        tb = ""
        for _ in range(int(a.wait * 4)):
            tb = ""
            for t in tabs:
                try: t.wait_for_load_state("domcontentloaded", timeout=2000); tb += "\n" + t.inner_text("body")
                except Exception: pass
            if all(x in tb for x in a.expect_tab): break
            pg.wait_for_timeout(250)
        for x in a.expect_tab:
            if x not in tb: errs.append(f"missing text in the opened tab {x!r} ({len(tabs)} tab(s) opened)")
    if a.linger: pg.wait_for_timeout(int(a.linger * 1000))
    if a.shot:
        try: pg.screenshot(path=a.shot, full_page=True)
        except Exception as e: errs.append("screenshot: " + str(e).split("\n")[0][:200])
    b.close()
if errs: print("\n".join(errs)); print("--- page text ---"); print(body[:6000]); sys.exit(1)
print("ok")
