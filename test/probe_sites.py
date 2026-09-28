#!/usr/bin/env python3
"""Probe ScrollPeek against real-world sites.

The fixture page is a polite static article. Real sites are not: SPAs, fixed
headers, lazily-mounted content, custom scrollbars, huge DOMs. This runs the
extension over a list of live URLs and reports what actually happened, plus any
errors the page or the extension raised.
"""
import json, os, socket, subprocess, sys, tempfile, time

EXT = "/tmp/scrollpeak-build/src"
PORT = 2861

import os as _os
SITES = [
    ("GitHub (SPA)", "https://github.com/mozilla/firefox"),
    ("Wikipedia", "https://en.wikipedia.org/wiki/Firefox"),
    ("w3.org spec (20k nodes)", "https://www.w3.org/TR/CSS-color-4/"),
]
SETTLE = int(_os.environ.get("SETTLE", "8"))

SCRIPT = r"""
const done = arguments[arguments.length - 1];
const out = { errors: [] };
window.addEventListener("error", e => out.errors.push("window: " + e.message), {once:false});

const q = s => document.querySelector(s);
const rail = q(".vugluscr .scrollbar");
out.rail = !!rail;
out.active = document.documentElement.classList.contains("vugluscr_active");

const map = q(".scrollpeak-map");
out.readyState = document.readyState;
out.url = location.href;
out.title = (document.title||"").slice(0,50);
out.scrollingEl = document.scrollingElement ? document.scrollingElement.tagName : null;
out.docH = document.scrollingElement ? document.scrollingElement.scrollHeight : null;
out.viewH = window.innerHeight;
out.hasVugluscr = typeof Vugluscr;
if (!map) {
  out.map = "missing";
  out.diag = {
    railPresent: !!q(".vugluscr"),
    scrollbarPresent: !!q(".vugluscr .scrollbar"),
    navClass: q(".vugluscr") ? q(".vugluscr").className : null,
    bodyExists: !!document.body,
  };
  done(out); return;
}

let painted = 0, colors = new Set(), rows = 0, lastRow = -1;
try {
  const W = map.width, H = map.height;
  const d = map.getContext("2d").getImageData(0, 0, W, H).data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (d[i+3] > 0) { painted++; if (colors.size < 20) colors.add(d[i]+","+d[i+1]+","+d[i+2]); }
  }
} catch (e) { out.canvasErr = String(e); }

out.painted = painted;
out.colors = colors.size;
out.docHeight = document.scrollingElement.scrollHeight;
out.viewport = window.innerHeight;
out.ratio = +(out.docHeight / out.viewport).toFixed(1);
out.qualified = out.ratio > 1.5;
// Did the page's own layout get disturbed? vugluscr sets padding-right on body.
const b = document.body;
out.bodyPadRight = getComputedStyle(b).paddingRight;
out.hOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
out.domNodes = document.querySelectorAll("*").length;
done(out);
"""


class M:
    def __init__(self, s):
        self.s, self.buf, self.n = s, b"", 0
        self.hello = self._f()
    def _raw(self):
        c = self.s.recv(65536)
        if not c: raise RuntimeError("closed")
        return c
    def _f(self):
        while b":" not in self.buf: self.buf += self._raw()
        h, r = self.buf.split(b":", 1); n = int(h)
        while len(r) < n: r += self._raw()
        self.buf = r[n:]
        return json.loads(r[:n])
    def cmd(self, name, params=None):
        self.n += 1
        p = json.dumps([0, self.n, name, params or {}]).encode()
        self.s.sendall(str(len(p)).encode() + b":" + p)
        while True:
            m = self._f()
            if isinstance(m, list) and m and m[0] == 1:
                if len(m) > 2 and m[2]: raise RuntimeError(f"{name}: {m[2]}")
                return m[3] if len(m) > 3 else None


prof = tempfile.mkdtemp(prefix="sp-probe-")
open(os.path.join(prof, "user.js"), "w").write(
    f'user_pref("marionette.port", {PORT});\nuser_pref("marionette.enabled", true);\n'
    'user_pref("extensions.autoDisableScopes", 0);\nuser_pref("browser.shell.checkDefaultBrowser", false);\n'
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);\n'
    'user_pref("browser.aboutwelcome.enabled", false);\nuser_pref("browser.startup.homepage_override.mstone", "ignore");\n'
    'user_pref("browser.region.network.url", "");\nuser_pref("network.captive-portal-service.enabled", false);\n'
    'user_pref("browser.safebrowsing.malware.enabled", false);\nuser_pref("browser.safebrowsing.phishing.enabled", false);\n'
)
proc = subprocess.Popen(["firefox", "--profile", prof, "--headless", "--marionette", "--no-remote", "about:blank"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                        env=dict(os.environ, MOZ_HEADLESS="1"))
try:
    s = None
    for _ in range(60):
        try: s = socket.create_connection(("127.0.0.1", PORT), timeout=3); break
        except OSError: time.sleep(1)
    m = M(s)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("Addon:Install", {"path": EXT, "temporary": True})
    time.sleep(3)

    for label, url in SITES:
        t0 = time.time()
        try:
            m.cmd("WebDriver:Navigate", {"url": url})
        except Exception as e:
            print(f"{label:28} NAVIGATE FAILED: {e}", flush=True); continue
        time.sleep(SETTLE)
        try:
            r = m.cmd("WebDriver:ExecuteAsyncScript", {"script": SCRIPT, "args": [], "scriptTimeout": 30000})
            d = r.get("value", r)
        except Exception as e:
            print(f"{label:28} PROBE FAILED: {e}", flush=True); continue
        dt = time.time() - t0
        flag = "ok " if d.get("rail") and d.get("painted", 0) > 500 else "BAD"
        if flag == "BAD":
            print("   DIAG: title=%r ready=%s docH=%s viewH=%s rail=%s active=%s" % (
                d.get("title"), d.get("readyState"), d.get("docH") or d.get("docHeight"),
                d.get("viewH") or d.get("viewport"), d.get("rail"), d.get("active")), flush=True)
        print(f"[{flag}] {label:26} {d.get('ratio')}x  painted={d.get('painted')} "
              f"colours={d.get('colors')} dom={d.get('domNodes')} "
              f"padR={d.get('bodyPadRight')} hOver={d.get('hOverflow')} "
              f"errs={d.get('errors')} canvasErr={d.get('canvasErr')} ({dt:.0f}s)", flush=True)
finally:
    proc.terminate()
    try: proc.wait(timeout=10)
    except Exception: proc.kill()
    err = proc.stderr.read().decode("utf-8", "replace")
    rel = [l for l in err.splitlines() if "ScrollPeek" in l or "JavaScript error" in l]
    rel = [l for l in rel if "Invalid pointer id" not in l]
    if rel:
        print("\nextension/page errors:")
        for l in rel[:20]: print("  " + l)
