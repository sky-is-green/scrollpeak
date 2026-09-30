#!/usr/bin/env python3
"""
Check that media-heavy pages keep the rail, under the clone map.

The block renderer existed because the text raster could not read a page of
pictures. The clone does: it is the page's own rendering, so a player, a
gallery, a parked <video> and a thumbnail all map as themselves. What still
needs pinning is the old rule this replaced -- the rail must not disappear
because a player arrived late, and a fixed overlay (a lightbox) must not change
or remove it.

    python3 test/verify_media.py [extension-dir]
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import SRC, fixture_server, launch_firefox, stop_firefox  # noqa: E402

MEDIA = "/media.html"           # a player and four pictures
GALLERY = "/gallery.html"       # sixteen large pictures, no video
PARKED = "/parked-player.html"  # the player's video sits above the page
SMALL = "/small-media.html"     # a thumbnail-sized video
LATE = "/late-media.html"       # a long article that grows a player later
LIGHTBOX = "/lightbox.html"     # a long article that opens a fixed overlay

STATE = r"""
const map = document.querySelector(".scrollpeak-map");
const rail = document.querySelector(".vugluscr .scrollbar");
const tf = document.querySelector(".scrollpeak-thumb__frame");
const tw = tf && tf.contentDocument
  ? tf.contentDocument.querySelector(".scrollpeak-thumb__page") : null;
return {
  rail: !!rail,
  map: !!map,
  thumb: !!document.querySelector(".scrollpeak-thumb"),
  thumbNodes: tw ? tw.querySelectorAll("*").length : 0,
  mode: map ? map.dataset.mode : null,
  active: document.documentElement.classList.contains("vugluscr_active"),
  scrollbarWidth: getComputedStyle(document.documentElement).scrollbarWidth,
  previewOpen: (() => {
    const pop = document.querySelector(".scrollpeak-magnifier");
    return pop ? pop.classList.contains("is-open") : null;
  })(),
  sperr: document.documentElement.dataset.sperr || null,
};
"""


def main():
    failures = []

    def check(name, cond, detail=""):
        print(f"  [{'PASS' if cond else 'FAIL'}] {name:46} {detail}")
        if not cond:
            failures.append(name)

    ext = sys.argv[1] if len(sys.argv) > 1 else SRC

    with fixture_server() as server:
        proc, m = launch_firefox(ext)
        try:
            def read():
                r = m.cmd("WebDriver:ExecuteScript", {"script": STATE, "args": []})
                return r.get("value", r)

            def page(path, settle=3):
                m.cmd("WebDriver:Navigate", {"url": server.fixtures + path})
                time.sleep(settle)
                return read()

            def hover(frac=0.4):
                m.cmd("WebDriver:ExecuteAsyncScript", {"script": r"""
                    const done = arguments[arguments.length - 1];
                    const frac = arguments[0];
                    const strip = document.querySelector(".vugluscr .minimap");
                    if (!strip) { done({err: "no rail"}); return; }
                    const r = strip.getBoundingClientRect();
                    strip.dispatchEvent(new PointerEvent("pointermove", {
                      clientX: r.left + r.width / 2, clientY: r.top + r.height * frac,
                      bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }));
                    setTimeout(done, 900);
                """, "args": [frac], "scriptTimeout": 20000})
                return read()

            print("a page with a player is mapped, and the rail stays")
            for path in (MEDIA, GALLERY, PARKED, SMALL):
                d = page(path)
                check(f"{path} keeps the rail", d["rail"] and d["map"], str(d))
                check(f"{path} maps with the clone",
                      d["mode"] == "clone" and d["thumbNodes"] > 3,
                      f"mode={d['mode']} nodes={d['thumbNodes']}")
                check(f"{path} suppresses the native scrollbar",
                      d["active"] and d["scrollbarWidth"] == "none",
                      f"active={d['active']} scrollbar={d['scrollbarWidth']}")
            d = hover()
            check("hovering the map opens the preview",
                  d["previewOpen"] is True, f"previewOpen={d['previewOpen']}")

            print("\na player that arrives later does not take the rail away")
            d = page(LATE)
            check("the article starts on the clone", d["mode"] == "clone",
                  str(d["mode"]))
            m.cmd("WebDriver:ExecuteScript",
                  {"script": "window.__addPlayer(); return 1;", "args": []})
            time.sleep(2.0)
            d = read()
            check("the rail is still mounted", d["rail"] and d["map"], str(d))
            check("it is still the clone", d["mode"] == "clone"
                  and d["thumbNodes"] > 3,
                  f"mode={d['mode']} nodes={d['thumbNodes']}")
            check("the native scrollbar is still suppressed",
                  d["active"] and d["scrollbarWidth"] == "none",
                  f"active={d['active']} scrollbar={d['scrollbarWidth']}")

            print("\na lightbox does not disturb the rail")
            d = page(LIGHTBOX)
            check("the article starts on the clone", d["mode"] == "clone",
                  str(d["mode"]))
            m.cmd("WebDriver:ExecuteScript",
                  {"script": "window.__openLightbox(); return 1;", "args": []})
            time.sleep(2.0)
            d = read()
            check("the rail is still mounted", d["rail"] and d["map"], str(d))
            check("and the map is unchanged", d["mode"] == "clone"
                  and d["thumbNodes"] > 3,
                  f"mode={d['mode']} nodes={d['thumbNodes']}")
        finally:
            stop_firefox(proc)

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("media pages keep the clone map; late players and lightboxes change nothing")
    return 0


if __name__ == "__main__":
    sys.exit(main())
