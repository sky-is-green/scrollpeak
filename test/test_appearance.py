#!/usr/bin/env python3
"""
Test the three rail-appearance features:

  1. a strip background that defaults to a darker shade of the page's, with the
     marks forced to contrast against it, and a user override
  2. minimap-only, which drops the track so the rail is just the map
  3. peek, which parks the rail off-screen until you scroll or approach it

Contrast is measured the way WCAG defines it, from the pixels the browser
actually painted, rather than from the arithmetic in the source -- so this
checks the result rather than the intent.

    python3 test/test_appearance.py
"""
import json
import os
import re
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import (  # noqa: E402
    SRC, fixture_server, launch_firefox, stop_firefox,
)


def variant(patch):
    """A copy of src/ with different DEFAULT_SETTINGS."""
    tmp = tempfile.mkdtemp(prefix="scrollpeak-appearance-")
    dst = os.path.join(tmp, "ext")
    shutil.copytree(SRC, dst)
    path = os.path.join(dst, "background.js")
    text = open(path).read()
    for key, value in patch.items():
        text, n = re.subn(
            rf"(\n  {key}: )[^,\n]+,",
            lambda m: m.group(1) + json.dumps(value) + ",",
            text, count=1)
        if n != 1:
            raise SystemExit(f"could not patch {key}")
    open(path, "w").write(text)
    return dst


# Reports the strip's own background, the extremes of what is painted in it,
# and the contrast between them.
PROBE = r"""
const done = arguments[arguments.length - 1];
const q = s => document.querySelector(s);
const root = document.documentElement;
const out = {
  classes: root.className,
  hasTrack: !!q(".vugluscr .track"),
  trackVisible: (() => {
    const t = q(".vugluscr .track");
    if (!t) return false;
    const cs = getComputedStyle(t);
    return cs.display !== "none" && t.getBoundingClientRect().width > 0;
  })(),
  railWidth: 0,
  railRight: 0,
  padRight: getComputedStyle(document.body).paddingRight,
  pageBg: getComputedStyle(document.body).backgroundColor,
};

const rail = q(".vugluscr .scrollbar");
if (rail) {
  const r = rail.getBoundingClientRect();
  out.railWidth = Math.round(r.width);
  out.railRight = Math.round(r.right);
  out.railOnScreen = r.left < window.innerWidth;
}

const map = q(".scrollpeak-map");
if (map) {
  const W = map.width, H = map.height;
  const d = map.getContext("2d").getImageData(0, 0, W, H).data;
  // The most common opaque colour is the strip background; the marks are
  // whatever differs from it.
  const counts = new Map();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i+3] < 250) continue;
    const k = d[i] + "," + d[i+1] + "," + d[i+2];
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let bgKey = null, bgCount = 0;
  for (const [k, n] of counts) if (n > bgCount) { bgCount = n; bgKey = k; }
  out.stripBg = bgKey;
  out.stripBgShare = bgCount / (W * H);

  // Darkest and lightest mark, by luminance, among pixels that are not the
  // background and not the faded overlay.
  const rgb = bgKey ? bgKey.split(",").map(Number) : [0, 0, 0];
  const lum = ([r, g, b]) => {
    const f = v => { const c = v/255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
    return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b);
  };
  const L = lum(rgb);
  let minL = 2, maxL = -1;
  const seen = new Set();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i+3] < 250) continue;
    const k = d[i] + "," + d[i+1] + "," + d[i+2];
    if (k === bgKey || seen.has(k)) continue;
    seen.add(k);
    const l = lum([d[i], d[i+1], d[i+2]]);
    if (l < minL) minL = l;
    if (l > maxL) maxL = l;
  }
  out.markLums = [minL, maxL];
  out.markColours = seen.size;
  // WCAG contrast between the background and whichever extreme is further.
  const ratio = (a, b) => (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05);
  out.contrastVsBg = {
    vsDarkest: ratio(L, minL),
    vsLightest: ratio(L, maxL),
  };
}
done(out);
"""


def main():
    failures = []

    def check(name, cond, detail=""):
        print(f"  [{'PASS' if cond else 'FAIL'}] {name:48} {detail}")
        if not cond:
            failures.append(name)

    with fixture_server() as server:
        proc, m = launch_firefox()
        try:
            def run(patch, label):
                path = variant(patch) if patch else SRC
                m.cmd("Addon:Install", {"path": path, "temporary": True})
                time.sleep(2)
                m.cmd("WebDriver:Navigate", {"url": server.fixtures + "/article.html"})
                time.sleep(4)
                r = m.cmd("WebDriver:ExecuteAsyncScript",
                          {"script": PROBE, "args": [], "scriptTimeout": 30000})
                d = r.get("value", r)
                print(f"\n{label}")
                return d

            d = run({}, "default: darker shade of the page, marks contrasted")
            check("strip background is not the page background",
                  d["stripBg"] and d["stripBg"] != d["pageBg"],
                  f"strip={d['stripBg']} page={d['pageBg']}")
            # The fixture's page background is #fdfdfc, so a darker shade must
            # be markedly darker.
            def lum(k):
                nums = [int(x) for x in re.findall(r"\d+", k)]
                r, g, b = nums[:3]
                f = lambda v: (v/255) / 12.92 if v/255 <= 0.03928 else (((v/255) + 0.055) / 1.055) ** 2.4
                return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b)
            check("it is darker than the page's",
                  lum(d["stripBg"]) < lum(d["pageBg"]) * 0.2,
                  f"strip lum {lum(d['stripBg']):.4f} vs page {lum(d['pageBg']):.4f}")
            check("marks keep the page's colours, not one flat colour",
                  d["markColours"] >= 3, f"{d['markColours']} distinct")
            best = max(d["contrastVsBg"]["vsDarkest"], d["contrastVsBg"]["vsLightest"])
            check("marks contrast with the strip", best >= 3,
                  f"best {best:.1f}:1 (darkest {d['contrastVsBg']['vsDarkest']:.1f}, "
                  f"lightest {d['contrastVsBg']['vsLightest']:.1f})")

            d = run({"mapBackground": "rgb(255, 255, 255)"}, "override: white strip")
            check("user colour is used", d["stripBg"] == "255,255,255", str(d["stripBg"]))
            # On a white strip, the page's dark text has to be kept dark.
            check("marks are still pushed to contrast on a light strip",
                  max(d["contrastVsBg"]["vsDarkest"],
                      d["contrastVsBg"]["vsLightest"]) >= 3,
                  f"best {max(d['contrastVsBg']['vsDarkest'], d['contrastVsBg']['vsLightest']):.1f}:1")

            d = run({"hideTrack": True}, "minimap only")
            check("track is not laid out", not d["trackVisible"],
                  f"visible={d['trackVisible']} classes={d['classes']}")
            check("rail is narrower than with a track", d["railWidth"] <= 62,
                  f"rail={d['railWidth']}px")
            check("the page's gutter shrinks with it",
                  d["padRight"] not in ("0px", "") and int(d["padRight"].rstrip("px")) <= 62,
                  f"padding-right={d['padRight']}")

            # Peek is off by default, so it has to be asked for explicitly.
            d = run({"hideWhenIdle": True},
                    "peek: rail parked until you scroll or approach")
            check("peek class is applied",
                  "scrollpeak-peek" in d["classes"], d["classes"])
            check("rail is off-screen", not d["railOnScreen"],
                  f"railRight={d['railRight']} width={d['railWidth']}")
            check("page keeps its gutter while hidden",
                  d["padRight"] not in ("0px", ""), f"padding-right={d['padRight']}")

            r = m.cmd("WebDriver:ExecuteScript", {"script": r"""
                window.dispatchEvent(new Event("scroll", {bubbles: true}));
                return true;
            """, "args": []})
            time.sleep(1)
            r = m.cmd("WebDriver:ExecuteScript", {"script": r"""
                const rail = document.querySelector(".vugluscr .scrollbar");
                const rect = rail.getBoundingClientRect();
                return {onScreen: rect.left < window.innerWidth - 2,
                        visible: document.documentElement.classList.contains("scrollpeak-visible")};
            """, "args": []})
            v = r.get("value", r)
            check("scrolling brings it back", v["onScreen"] and v["visible"], str(v))
        finally:
            stop_firefox(proc)

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("background, contrast, minimap-only and peek all behave")
    return 0


if __name__ == "__main__":
    sys.exit(main())
