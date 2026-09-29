#!/usr/bin/env python3
"""
Check that media-heavy pages keep the browser's own scrollbar.

Both map renderers model a page as text. On a page that is mostly pictures --
a video player, a card grid -- that model draws labels and badges and misses
the content, and the preview cannot make up for a useless map. Rather than
ship a second map that never read well, ScrollPeak leaves those pages alone:
it does not mount, so the native scrollbar stays. This pins down when that
happens, that the native scrollbar really is left in place, and that the
near-misses (a small thumbnail video, an ordinary article, a long document)
still get their map.

    python3 test/verify_media.py [extension-dir]
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import SRC, fixture_server, launch_firefox, stop_firefox  # noqa: E402

MEDIA = "/media.html"       # a 480x270 player and four pictures: fall back
GALLERY = "/gallery.html"   # sixteen large pictures, no video: fall back
SMALL = "/small-media.html"  # a 250x141 video: not a player, keep the map
LATE = "/late-media.html"   # starts plain, grows a player later: fall back
ARTICLE = "/article.html"   # text, expected to keep its block map
LONG = "/long.html"         # text, expected to keep its raster

STATE = r"""
const map = document.querySelector(".scrollpeak-map");
const rail = document.querySelector(".vugluscr .scrollbar");
const root = document.documentElement;
return {
  rail: !!rail,
  map: !!map,
  active: root.classList.contains("vugluscr_active"),
  mode: map ? map.dataset.mode : null,
  padRight: getComputedStyle(document.body).paddingRight,
  scrollbarWidth: getComputedStyle(root).scrollbarWidth,
  innerWidth: window.innerWidth,
  clientWidth: root.clientWidth,
  docHeight: document.scrollingElement.scrollHeight,
  viewport: window.innerHeight,
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
            def state(path):
                m.cmd("WebDriver:Navigate", {"url": server.fixtures + path})
                time.sleep(3)
                r = m.cmd("WebDriver:ExecuteScript",
                          {"script": STATE, "args": []})
                return r.get("value", r)

            def fell_back(d):
                # Not mounted, no vugluscr class, and the browser's own
                # scrollbar mode is back to auto. On this fixture the page
                # scrolls, so "no rail" cannot be the whenNeeded path.
                return (not d["rail"] and not d["map"] and not d["active"]
                        and d["scrollbarWidth"] == "auto"
                        and d["docHeight"] > d["viewport"])

            print("a page with a player falls back to the native scrollbar")
            d = state(MEDIA)
            check("no rail and no map", not d["rail"] and not d["map"],
                  f"rail={d['rail']} map={d['map']}")
            check("vugluscr is not active", not d["active"])
            check("the native scrollbar is not suppressed",
                  d["scrollbarWidth"] == "auto", d["scrollbarWidth"])
            check("the rail reserved no page padding", d["padRight"] == "0px",
                  d["padRight"])
            check("the page does scroll, so the map was not skipped for size",
                  d["docHeight"] > d["viewport"],
                  f"{d['docHeight']}px of document, {d['viewport']}px viewport")

            print("\na wall of pictures falls back too")
            d = state(GALLERY)
            check("no rail and no map", not d["rail"] and not d["map"],
                  f"rail={d['rail']} map={d['map']}")
            check("vugluscr is not active", not d["active"])
            check("the native scrollbar is not suppressed",
                  d["scrollbarWidth"] == "auto", d["scrollbarWidth"])

            print("\na thumbnail-sized video is not a player")
            d = state(SMALL)
            check("the rail is mounted", d["rail"] and d["map"],
                  f"rail={d['rail']} map={d['map']}")
            check("the map has a renderer", d["mode"] in ("text", "blocks"),
                  str(d["mode"]))
            check("the native scrollbar is suppressed by the rail",
                  d["active"] and d["scrollbarWidth"] == "none",
                  f"active={d['active']} scrollbar={d['scrollbarWidth']}")

            print("\ntext pages keep their maps")
            d = state(ARTICLE)
            check("the short article is still mapped", d["rail"] and d["map"])
            d = state(LONG)
            check("the long article is still mapped", d["rail"] and d["map"])

            print("\na player that arrives later takes the rail with it")
            d = state(LATE)
            check("the rail is up before the player exists",
                  d["rail"] and d["map"], f"rail={d['rail']}")
            m.cmd("WebDriver:ExecuteScript",
                  {"script": "window.__addPlayer(); return 1;", "args": []})
            time.sleep(1.6)
            r = m.cmd("WebDriver:ExecuteScript", {"script": STATE, "args": []})
            d = r.get("value", r)
            check("the rail is gone after the player appears", fell_back(d),
                  f"rail={d['rail']} active={d['active']} "
                  f"scrollbar={d['scrollbarWidth']}")
        finally:
            stop_firefox(proc)

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("media pages keep the native scrollbar; text pages keep their maps")
    return 0


if __name__ == "__main__":
    sys.exit(main())
