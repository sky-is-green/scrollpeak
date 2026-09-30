#!/usr/bin/env python3
"""
Check the rail's clone thumb: the map is the page's own rendering.

The base map in clone mode is a snapshot of the page mounted into the strip and
scaled to fit — no vocabulary, no renderer selection, no per-site rules. This
suite pins the mounted thumb, the shared layout width with the preview (both
mount the same snapshot), the freeze (animations paused, media paused), and the
raster fallback still working when mapMode is switched.

    python3 test/verify_thumb.py [extension-dir]
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import (  # noqa: E402
    SRC, fixture_server, launch_firefox, stop_firefox, variant,
)

ARTICLE = "/article.html"
LONG = "/long.html"
MEDIA = "/media.html"
GALLERY = "/gallery.html"
ANIMATED = "/animated.html"

PROBE = r"""
const done = arguments[arguments.length - 1];
const q = s => document.querySelector(s);
const out = {};
try {
  const map = q(".scrollpeak-map");
  out.mode = map ? map.dataset.mode : null;
  const thumb = q(".scrollpeak-thumb");
  out.thumb = !!thumb;
  const tf = q(".scrollpeak-thumb__frame");
  out.thumbFrame = !!tf;
  out.thumbWidth = tf ? tf.clientWidth : null;
  const td = tf ? tf.contentDocument : null;
  const tw = td ? td.querySelector(".scrollpeak-thumb__page") : null;
  out.thumbNodes = tw ? tw.querySelectorAll("*").length : null;
  out.thumbTransform = tw ? tw.style.transform : null;
  out.thumbText = tw ? tw.textContent.slice(0, 40) : null;
  if (td) {
    const sp = td.querySelector("#spinner");
    out.animPlayState = sp
      ? td.defaultView.getComputedStyle(sp).animationPlayState : null;
    const vid = td.querySelector("video");
    out.videoPaused = vid ? vid.paused : null;
    out.videoAutoplay = vid ? vid.hasAttribute("autoplay") : null;
  }
  const strip = q(".vugluscr .minimap");
  if (strip) {
    const sr = strip.getBoundingClientRect();
    strip.dispatchEvent(new PointerEvent("pointermove", {
      clientX: sr.left + sr.width / 2, clientY: sr.top + sr.height * 0.4,
      bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }));
  }
  setTimeout(() => {
    const pop = q(".scrollpeak-magnifier");
    out.popOpen = pop ? pop.classList.contains("is-open") : null;
    const pf = q(".scrollpeak-magnifier__frame");
    out.popWidth = pf ? pf.clientWidth : null;
    out.popNodes = pf && pf.contentDocument
      ? (pf.contentDocument.querySelector(".scrollpeak-magnifier__page") ||
         { querySelectorAll: () => [] }).querySelectorAll("*").length
      : null;
    out.sperr = document.documentElement.dataset.sperr || null;
    out.stripWidth = strip ? Math.round(strip.getBoundingClientRect().width) : null;
    done(out);
  }, 1200);
} catch (e) { out.thrown = String((e && e.stack) || e); done(out); }
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
            m.cmd("WebDriver:SetWindowRect", {"width": 1280, "height": 800})
            m.cmd("Addon:Install", {"path": SRC, "temporary": True})
            time.sleep(2)

            def probe(path, wait=3):
                m.cmd("WebDriver:Navigate", {"url": server.fixtures + path})
                time.sleep(wait)
                r = m.cmd("WebDriver:ExecuteAsyncScript",
                          {"script": PROBE, "args": [], "scriptTimeout": 20000})
                return r.get("value", r)

            print("the shipped default is the clone base")
            d = probe(ARTICLE)
            check("no probe error", "thrown" not in d, d.get("thrown", ""))
            check("the strip reports the clone renderer", d.get("mode") == "clone",
                  str(d.get("mode")))
            check("the thumb is mounted", d.get("thumb") and d.get("thumbFrame"))
            check("it holds the page, not a placeholder",
                  (d.get("thumbNodes") or 0) > 10, f"{d.get('thumbNodes')} nodes")
            check("it is scaled to fit the strip", bool(d.get("thumbTransform")),
                  str(d.get("thumbTransform")))
            check("no mount error was recorded", not d.get("sperr"),
                  str(d.get("sperr")))

            # Both views mount the same snapshot: same layout width.
            check("thumb and preview share one layout width",
                  d.get("thumbWidth") and d.get("popWidth") and
                  d.get("thumbWidth") == d.get("popWidth"),
                  f"thumb={d.get('thumbWidth')} preview={d.get('popWidth')}")
            check("the preview opened on the same page",
                  d.get("popOpen") is True and (d.get("popNodes") or 0) > 10,
                  f"open={d.get('popOpen')} nodes={d.get('popNodes')}")

            # scale(sx, sy): sx is strip width over the clone's layout width.
            mnt = re.match(r"scale\(([\d.]+),\s*([\d.]+)\)", d.get("thumbTransform") or "")
            if mnt and d.get("thumbWidth") and d.get("stripWidth"):
                sx = float(mnt.group(1))
                expected = d["stripWidth"] / d["thumbWidth"]
                check("the horizontal scale fits the strip",
                      abs(sx - expected) <= 0.01,
                      f"{sx:.4f} vs {expected:.4f}")
            else:
                check("the horizontal scale fits the strip", False,
                      str(d.get("thumbTransform")))

            print("\nthe clone is a picture: it does not animate or play")
            d = probe(ANIMATED)
            check("the cloned spinner is paused",
                  d.get("animPlayState") == "paused", str(d.get("animPlayState")))
            check("the cloned video is paused", d.get("videoPaused") is True,
                  str(d.get("videoPaused")))
            check("and its autoplay is gone", d.get("videoAutoplay") is False,
                  str(d.get("videoAutoplay")))

            print("\na long and a media page both map with the clone")
            for path in (LONG, MEDIA, GALLERY):
                d = probe(path)
                check(f"{path} is clone-mapped",
                      d.get("mode") == "clone" and (d.get("thumbNodes") or 0) > 5,
                      f"mode={d.get('mode')} nodes={d.get('thumbNodes')}")

            print("\nthe raster stays as the fallback")
            m.cmd("Addon:Install", {"path": variant({"mapMode": "raster"}),
                                    "temporary": True})
            time.sleep(2)
            d = probe(ARTICLE)
            check("no thumb is mounted in raster mode", not d.get("thumb"))
            check("the strip reports a raster renderer",
                  d.get("mode") in ("text", "blocks"), str(d.get("mode")))
            check("and the preview still opens",
                  d.get("popOpen") is True and (d.get("popNodes") or 0) > 10,
                  f"open={d.get('popOpen')} nodes={d.get('popNodes')}")
        finally:
            stop_firefox(proc)

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("the clone is the map; the raster is the fallback")
    return 0


if __name__ == "__main__":
    sys.exit(main())
