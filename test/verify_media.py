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
PARKED = "/parked-player.html"  # the player's video sits above the page
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
  railRect: null,
  bar: null, strip: null, ink: null, barScreenY: null,
  previewOpen: null,
};
try {
  out.blocks = map && map.dataset.blocks ? JSON.parse(map.dataset.blocks) : null;
} catch (e) { out.blocksErr = String(e); }
if (rail) {
  const rr = rail.getBoundingClientRect();
  out.railRect = [Math.round(rr.left), Math.round(rr.top),
                  Math.round(rr.width), Math.round(rr.height)];
}
const cs = getComputedStyle(root);
out.strip = cs.getPropertyValue("--sp-strip").trim();
out.ink = cs.getPropertyValue("--sp-ink").trim();
// The solid bar a picture or player is drawn as: project the element's
// centre the same way #paintBlocks() does and read the map pixel there. A
// fixture can point at the visible container with data-bar-check when the
// media element itself is parked outside the document (YouTube's player).
const barEl = document.querySelector("[data-bar-check]") ||
              document.querySelector("video[data-id]");
if (map && barEl && map.dataset.blockSpan && map.dataset.docRect &&
    map.dataset.docHeight) {
  const span = JSON.parse(map.dataset.blockSpan);
  const rect = JSON.parse(map.dataset.docRect);
  const docH = Number(map.dataset.docHeight);
  const r = barEl.getBoundingClientRect();
  const docX = r.left + scrollX + r.width / 2;
  const docY = r.top + scrollY + r.height / 2;
  const x = 1 + ((docX - span.left) /
    Math.max(1, span.right - span.left)) * (map.width - 2);
  const y = rect.top + (docY / docH) * rect.height;
  const px = Math.max(0, Math.min(map.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(map.height - 1, Math.round(y)));
  const d = map.getContext("2d").getImageData(px, py, 1, 1).data;
  out.bar = [d[0], d[1], d[2], d[3]];
  out.barScreenY = Math.round(y);
}
const pop = document.querySelector(".scrollpeak-magnifier");
out.previewOpen = pop ? pop.classList.contains("is-open") : null;
return out;
"""


def rgb(value):
    return [int(v) for v in value[4:-1].split(",")]


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
            ink = rgb(d["ink"]) if d["ink"] else None
            check("the player is a solid bar in the strip's ink",
                  d["bar"] and ink and
                  all(abs(d["bar"][i] - ink[i]) <= 8 for i in range(3)),
                  f"bar={d['bar']} ink={ink}")
            check("the native scrollbar stays suppressed",
                  d["active"] and d["scrollbarWidth"] == "none",
                  f"active={d['active']} scrollbar={d['scrollbarWidth']}")

            # A bar is not a dead region: the whole strip stays hoverable, so
            # pointing at the player's bar must open the preview there.
            x = d["railRect"][0] + d["railRect"][2] // 2
            y = d["railRect"][1] + (d["barScreenY"]
                                    if d["barScreenY"] is not None
                                    else d["railRect"][3] // 2)
            m.cmd("WebDriver:PerformActions", {"actions": [{
                "type": "pointer", "id": "mouse",
                "parameters": {"pointerType": "mouse"},
                "actions": [{"type": "pointerMove", "duration": 16,
                             "origin": "viewport", "x": x, "y": y}],
            }]})
            time.sleep(0.9)
            d2 = read()
            check("hovering the bar opens the preview",
                  d2["previewOpen"] is True, f"previewOpen={d2['previewOpen']}")

            print("\na player parked above the page still leaves a bar")
            d = page(PARKED)
            check("the rail is mounted", d["rail"] and d["map"],
                  f"rail={d['rail']} map={d['map']}")
            check("the map is the block renderer", d["mode"] == "blocks",
                  str(d["mode"]))
            check("the parked player is a block",
                  d["blocks"] and d["blocks"]["image"] >= 1,
                  json.dumps(d["blocks"]))
            ink = rgb(d["ink"]) if d["ink"] else None
            check("the bar is drawn where the container is",
                  d["bar"] and ink and
                  all(abs(d["bar"][i] - ink[i]) <= 8 for i in range(3)),
                  f"bar={d['bar']} ink={ink}")

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
