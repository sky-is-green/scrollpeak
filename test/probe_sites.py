#!/usr/bin/env python3
"""
Probe ScrollPeak against real-world sites.

The fixture page is a polite static article. Real sites are not: SPAs, fixed
headers, lazily-mounted content, custom scrollbars, huge DOMs. This runs the
extension over a list of live URLs and reports what actually happened, plus any
errors the page or the extension raised.

Edit SITES at the top. Needs internet; every other test here does not.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import SRC, launch_firefox, stop_firefox  # noqa: E402

SITES = [
    # (label, url, expectation). "native" would mean the page is left to the
    # browser's own scrollbar; nothing is any more -- media-heavy pages now
    # get the block renderer, so "rail" is what every page here expects.
    ("GitHub (SPA)", "https://github.com/mozilla/firefox", "rail"),
    ("Wikipedia", "https://en.wikipedia.org/wiki/Firefox", "rail"),
    ("YouTube watch (media)", "https://www.youtube.com/watch?v=jNQXAC9IVRw", "rail"),
    ("w3.org spec (20k nodes)", "https://www.w3.org/TR/CSS-color-4/", "rail"),
    ("MDN reference", "https://developer.mozilla.org/en-US/docs/Web/CSS/color-mix", "rail"),
    ("Hacker News (short)", "https://news.ycombinator.com/", "rail"),
    ("Reddit front (media)", "https://www.reddit.com/", "rail"),
]

SETTLE = int(os.environ.get("SETTLE", "9"))

SCRIPT = r"""
const done = arguments[arguments.length - 1];
const out = { errors: [] };
window.addEventListener("error", e => out.errors.push("window: " + e.message));

const q = s => document.querySelector(s);
out.rail = !!q(".vugluscr .scrollbar");
out.active = document.documentElement.classList.contains("vugluscr_active");

const map = q(".scrollpeak-map");
out.map = !!map;
out.mode = map ? map.dataset.mode : null;
if (map) {
  let painted = 0; const colors = new Set();
  try {
    const W = map.width, H = map.height;
    const d = map.getContext("2d").getImageData(0, 0, W, H).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0) {
        painted++;
        if (colors.size < 20) colors.add(d[i] + "," + d[i + 1] + "," + d[i + 2]);
      }
    }
  } catch (e) { out.canvasErr = String(e); }
  out.painted = painted;
  out.colors = colors.size;
  out.mapWidth = map.width;
}
out.docHeight = document.scrollingElement.scrollHeight;
out.viewport = window.innerHeight;
out.ratio = out.docHeight && out.viewport
  ? +(out.docHeight / out.viewport).toFixed(1) : null;
out.bodyPadRight = getComputedStyle(document.body).paddingRight;
out.hOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
out.domNodes = document.querySelectorAll("*").length;
done(out);
"""


def main():
    proc, m = launch_firefox(SRC)
    try:
        for label, url, expect in SITES:
            t0 = time.time()
            try:
                m.cmd("WebDriver:Navigate", {"url": url})
            except Exception as e:
                print(f"  [SKIP] {label:24} navigation failed: {str(e)[:80]}", flush=True)
                continue
            time.sleep(SETTLE)
            try:
                r = m.cmd("WebDriver:ExecuteAsyncScript",
                          {"script": SCRIPT, "args": [], "scriptTimeout": 40000})
                d = r.get("value", r)
            except Exception as e:
                print(f"  [SKIP] {label:24} probe failed: {str(e)[:80]}", flush=True)
                continue

            if expect == "native":
                # Media pages are left alone; what "ok" means there is the
                # absence of the rail, not a painted map.
                ok = not d.get("rail") and not d.get("active")
                detail = f"rail={d.get('rail')} active={d.get('active')}"
            else:
                ok = (d.get("rail") and d.get("painted", 0) > 500
                      and not d.get("hOverflow"))
                detail = (f"{d.get('ratio')}x  map={d.get('mapWidth')}px "
                          f"painted={d.get('painted')} colours={d.get('colors')} "
                          f"mode={d.get('mode')} dom={d.get('domNodes')} "
                          f"padR={d.get('bodyPadRight')} hOver={d.get('hOverflow')}")
            mark = "ok " if ok else "BAD"
            print(
                f"  [{mark}] {label:24} {detail} "
                f"errs={d.get('errors')} ({time.time() - t0:.0f}s)",
                flush=True,
            )
    finally:
        err = stop_firefox(proc)
        rel = [l for l in err.splitlines()
               if "ScrollPeak" in l or "JavaScript error" in l]
        rel = [l for l in rel if "Invalid pointer id" not in l]
        if rel:
            print("\nextension/page errors:")
            for line in rel[:20]:
                print("  " + line)


if __name__ == "__main__":
    main()
