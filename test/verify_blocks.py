#!/usr/bin/env python3
"""
Check the map's two renderers, and when each is used.

Kate's map is a text raster, and on a long document it stays one. On a short
one the raster is stretched until every line is a band of blobs, so the map
switches to semantic blocks: text areas filled black or white (whichever
contrasts with the strip), links in the page's own link colour, images as
hollow 1px outlines. That switch and that vocabulary are what this pins down.

    python3 test/verify_blocks.py [extension-dir]
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import SRC, fixture_server, launch_firefox, stop_firefox  # noqa: E402

SHORT = "/article.html"    # ~60 lines: blocks
LONG = "/long.html"        # ~400 lines: Kate's raster
GRAPHICS = "/graphics.html"  # short, with images
BLOCKS = "/blocks.html"    # short, with one big image and a link

PROBE = r"""
const map = document.querySelector(".scrollpeak-map");
if (!map) { return {err: "no map"}; }

const out = {
  mode: map.dataset.mode || null,
  blocks: map.dataset.blocks ? JSON.parse(map.dataset.blocks) : null,
  span: map.dataset.blockSpan ? JSON.parse(map.dataset.blockSpan) : null,
  width: map.width, height: map.height,
  docHeight: document.scrollingElement.scrollHeight,
  docRect: map.dataset.docRect ? JSON.parse(map.dataset.docRect) : null,
  strip: getComputedStyle(document.documentElement).getPropertyValue("--sp-strip").trim(),
  ink: getComputedStyle(document.documentElement).getPropertyValue("--sp-ink").trim(),
};

const d = map.getContext("2d").getImageData(0, 0, map.width, map.height).data;
const counts = new Map();
let saturated = 0;
for (let i = 0; i < d.length; i += 4) {
  if (d[i+3] < 250) continue;
  const k = d[i] + "," + d[i+1] + "," + d[i+2];
  counts.set(k, (counts.get(k) || 0) + 1);
  const hi = Math.max(d[i], d[i+1], d[i+2]);
  const lo = Math.min(d[i], d[i+1], d[i+2]);
  if (hi - lo > 40) saturated++;
}
out.painted = [...counts.values()].reduce((a, b) => a + b, 0);
out.colours = counts.size;
out.saturated = saturated;

function pixel(x, y) {
  const px = Math.max(0, Math.min(map.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(map.height - 1, Math.round(y)));
  const i = (py * map.width + px) * 4;
  return [d[i], d[i+1], d[i+2], d[i+3]];
}

// The same projection paintBlocks() uses: the block span across the strip,
// the document height down it.
function project(docX, docY) {
  const x = 1 + ((docX - out.span.left) /
    Math.max(1, out.span.right - out.span.left)) * (map.width - 2);
  const y = out.docRect.top + (docY / out.docHeight) * out.docRect.height;
  return [x, y];
}

const img = document.querySelector("img[data-id='hero']");
if (img) {
  const r = img.getBoundingClientRect();
  out.image = { left: r.left + scrollX, top: r.top + scrollY,
                w: r.width, h: r.height };
}
const a = document.querySelector("a[href]");
if (a) {
  const r = a.getClientRects()[0];
  out.link = { left: r.left + scrollX, top: r.top + scrollY,
               w: r.width, h: r.height };
}

out.samples = {};
const projected = out.span && out.docRect;
if (out.image && projected) {
  const [cx, cy] = project(out.image.left + out.image.w / 2,
                           out.image.top + out.image.h / 2);
  const [ex, ey] = project(out.image.left, out.image.top + out.image.h / 2);
  out.samples.imageCentre = pixel(cx, cy);
  out.samples.imageEdgeRow = [-2, -1, 0, 1, 2, 3].map(i => pixel(ex + i, ey));
}
if (out.link && projected) {
  const [lx, ly] = project(out.link.left + out.link.w / 2,
                           out.link.top + out.link.h / 2);
  out.samples.link = pixel(lx, ly);
}
return out;
"""


def main():
    failures = []

    def check(name, cond, detail=""):
        print(f"  [{'PASS' if cond else 'FAIL'}] {name:46} {detail}")
        if not cond:
            failures.append(name)

    def rgb(value):
        return [int(v) for v in value[4:-1].split(",")]

    def lum(c):
        def f(v):
            v /= 255
            return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])

    ext = sys.argv[1] if len(sys.argv) > 1 else SRC

    with fixture_server() as server:
        proc, m = launch_firefox(ext)
        try:
            def page(path):
                m.cmd("WebDriver:Navigate", {"url": server.fixtures + path})
                time.sleep(3)
                r = m.cmd("WebDriver:ExecuteScript",
                          {"script": PROBE, "args": []})
                return r.get("value", r)

            print("a long document keeps Kate's text raster")
            d = page(LONG)
            check("renderer is the raster", d["mode"] == "text", str(d["mode"]))
            check("it painted the page's colours", d["colours"] >= 3,
                  f"{d['colours']} colours, {d['painted']}px")

            print("\na short document switches to blocks")
            d = page(SHORT)
            check("renderer is blocks", d["mode"] == "blocks", str(d["mode"]))
            check("text areas are blocks", d["blocks"]["text"] >= 10,
                  json.dumps(d["blocks"]))
            check("the two links are blocks", d["blocks"]["link"] == 2,
                  json.dumps(d["blocks"]))
            ink = rgb(d["ink"])
            # The page's own link colour, forced to contrast, is not the ink.
            check("a link is drawn in its own colour",
                  d["samples"]["link"] != ink and d["samples"]["link"] != rgb(d["strip"]),
                  str(d["samples"]["link"]))
            check("and it is still link-red",
                  d["samples"]["link"][0] > d["samples"]["link"][2],
                  str(d["samples"]["link"]))

            print("\nimages are blocks, drawn hollow")
            d = page(BLOCKS)
            check("renderer is blocks", d["mode"] == "blocks", str(d["mode"]))
            check("the image is a block", d["blocks"]["image"] == 1,
                  json.dumps(d["blocks"]))
            strip, ink = rgb(d["strip"]), rgb(d["ink"])
            centre = d["samples"]["imageCentre"]
            check("the image's inside is the strip",
                  all(abs(centre[i] - strip[i]) <= 3 for i in range(3)),
                  f"{centre} vs strip {strip}")
            edge = max(d["samples"]["imageEdgeRow"], key=lum)
            check("its outline is drawn",
                  lum(edge) > lum(strip) + 0.15,
                  f"edge {edge} vs strip {strip}")

            print("\nimages do not bring their own colours")
            d = page(GRAPHICS)
            check("renderer is blocks", d["mode"] == "blocks", str(d["mode"]))
            check("images are blocks", d["blocks"]["image"] == 3,
                  json.dumps(d["blocks"]))
            check("the images' own colours never appear",
                  d["saturated"] == 0,
                  f"{d['saturated']} saturated pixels of {d['painted']} painted")
        finally:
            stop_firefox(proc)

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("the map renders text when long and blocks when zoomed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
