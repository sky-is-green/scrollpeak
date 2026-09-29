#!/usr/bin/env python3
"""
Check that media-heavy pages get the block renderer, and keep the rail.

Both of the map's renderers used to give up on a page of pictures: ScrollPeak
never mounted and the browser's own scrollbar stayed. That is gone. A player,
or a field of pictures, now selects the block renderer (#isMediaPage() in
textmap.js), and the rail mounts everywhere, so a player that arrives late
cannot hand the page back to the browser. This pins down which fixtures are
read as media, that they keep the rail and its block map, and that a fixed
overlay -- a lightbox, Wikipedia's media viewer -- is not mistaken for one:
only the page's own flow counts.

    python3 test/verify_media.py [extension-dir]
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import SRC, fixture_server, launch_firefox, stop_firefox  # noqa: E402

MEDIA = "/media.html"        # a 480x270 player and four pictures: blocks
GALLERY = "/gallery.html"    # sixteen large pictures, no video: blocks
SMALL = "/small-media.html"  # a 250x141 video: a thumbnail, not a player
LATE = "/late-media.html"    # a long article that grows a player later
LIGHTBOX = "/lightbox.html"  # a long article that opens a fixed media overlay
ARTICLE = "/article.html"    # text, expected to keep its block map
LONG = "/long.html"          # text, expected to keep its raster

STATE = r"""
const map = document.querySelector(".scrollpeak-map");
const rail = document.querySelector(".vugluscr .scrollbar");
const root = document.documentElement;
const out = {
  rail: !!rail,
  map: !!map,
  active: root.classList.contains("vugluscr_active"),
  mode: map ? map.dataset.mode : null,
  blocks: null,
  padRight: getComputedStyle(document.body).paddingRight,
  scrollbarWidth: getComputedStyle(root).scrollbarWidth,
  docHeight: document.scrollingElement.scrollHeight,
  viewport: window.innerHeight,
};
try {
  out.blocks = map && map.dataset.blocks ? JSON.parse(map.dataset.blocks) : null;
} catch (e) { out.blocksErr = String(e); }
return out;
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
                r = m.cmd("WebDriver:ExecuteScript",
                          {"script": STATE, "args": []})
                return r.get("value", r)

            def page(path):
                m.cmd("WebDriver:Navigate", {"url": server.fixtures + path})
                time.sleep(3)
                return read()

            print("a page with a player is mapped as blocks")
            d = page(MEDIA)
            check("the rail is mounted", d["rail"] and d["map"],
                  f"rail={d['rail']} map={d['map']}")
            check("the map is the block renderer", d["mode"] == "blocks",
                  str(d["mode"]))
            check("the player and the pictures are blocks",
                  d["blocks"] and d["blocks"]["image"] >= 5,
                  json.dumps(d["blocks"]))
            check("the native scrollbar stays suppressed",
                  d["active"] and d["scrollbarWidth"] == "none",
                  f"active={d['active']} scrollbar={d['scrollbarWidth']}")

            print("\na wall of pictures is mapped as blocks")
            d = page(GALLERY)
            check("the rail is mounted", d["rail"] and d["map"])
            check("the map is the block renderer", d["mode"] == "blocks",
                  str(d["mode"]))
            check("every picture is a block",
                  d["blocks"] and d["blocks"]["image"] >= 12,
                  json.dumps(d["blocks"]))
            check("the native scrollbar stays suppressed",
                  d["active"] and d["scrollbarWidth"] == "none",
                  f"active={d['active']} scrollbar={d['scrollbarWidth']}")

            print("\na thumbnail-sized video is not a player")
            d = page(SMALL)
            check("the rail is mounted", d["rail"] and d["map"],
                  f"rail={d['rail']} map={d['map']}")
            check("the map has a renderer", d["mode"] in ("text", "blocks"),
                  str(d["mode"]))
            check("the native scrollbar is suppressed by the rail",
                  d["active"] and d["scrollbarWidth"] == "none",
                  f"active={d['active']} scrollbar={d['scrollbarWidth']}")

            print("\ntext pages keep their maps")
            d = page(ARTICLE)
            check("the short article is still mapped", d["rail"] and d["map"])
            d = page(LONG)
            check("the long article is still mapped", d["rail"] and d["map"])
            check("and it is still Kate's raster", d["mode"] == "text",
                  str(d["mode"]))

            print("\na player that arrives later switches renderer, not scrollbar")
            d = page(LATE)
            check("the long article starts on the raster", d["mode"] == "text",
                  str(d["mode"]))
            m.cmd("WebDriver:ExecuteScript",
                  {"script": "window.__addPlayer(); return 1;", "args": []})
            time.sleep(1.6)
            d = read()
            check("the rail is still mounted", d["rail"] and d["map"],
                  f"rail={d['rail']} map={d['map']}")
            check("the map switched to blocks", d["mode"] == "blocks",
                  str(d["mode"]))
            check("the native scrollbar is still suppressed",
                  d["active"] and d["scrollbarWidth"] == "none",
                  f"active={d['active']} scrollbar={d['scrollbarWidth']}")

            print("\na lightbox does not change the renderer")
            d = page(LIGHTBOX)
            check("the article starts on the raster", d["mode"] == "text",
                  str(d["mode"]))
            m.cmd("WebDriver:ExecuteScript",
                  {"script": "window.__openLightbox(); return 1;", "args": []})
            time.sleep(1.6)
            d = read()
            check("the rail is still mounted", d["rail"] and d["map"],
                  f"rail={d['rail']} map={d['map']}")
            check("the renderer is unchanged", d["mode"] == "text",
                  str(d["mode"]))
            check("the native scrollbar is still suppressed",
                  d["active"] and d["scrollbarWidth"] == "none",
                  f"active={d['active']} scrollbar={d['scrollbarWidth']}")
        finally:
            stop_firefox(proc)

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("media pages get blocks; the rail stays; lightboxes change nothing")
    return 0


if __name__ == "__main__":
    sys.exit(main())
