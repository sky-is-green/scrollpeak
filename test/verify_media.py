#!/usr/bin/env python3
"""
Check the media renderer, and when it is chosen.

The text raster and the semantic block map both model a page as text. On a
page that is mostly pictures -- a video player, a card grid -- that model
draws the labels and badges and misses the content, so media pages get a
third renderer whose vocabulary is geometry: replaced elements above a floor
size, drawn as boxes, with headings for orientation. This pins down when that
renderer is chosen, what it draws, and that it does not take over the text
pages the other two are for.

    python3 test/verify_media.py [extension-dir]
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import SRC, fixture_server, launch_firefox, stop_firefox  # noqa: E402

MEDIA = "/media.html"      # a big <video> and four pictures
GALLERY = "/gallery.html"  # sixteen pictures, no video
ARTICLE = "/article.html"  # text, expected to stay on the block map
LONG = "/long.html"        # text, expected to stay on the raster

PROBE = r"""
const map = document.querySelector(".scrollpeak-map");
if (!map) { return {err: "no map"}; }

const out = {
  mode: map.dataset.mode || null,
  media: map.dataset.media ? JSON.parse(map.dataset.media) : null,
  span: map.dataset.mediaSpan ? JSON.parse(map.dataset.mediaSpan) : null,
  blocks: map.dataset.blocks ? JSON.parse(map.dataset.blocks) : null,
  blockSpan: map.dataset.blockSpan ? JSON.parse(map.dataset.blockSpan) : null,
  width: map.width, height: map.height,
  docHeight: document.scrollingElement.scrollHeight,
  docRect: map.dataset.docRect ? JSON.parse(map.dataset.docRect) : null,
  strip: getComputedStyle(document.documentElement).getPropertyValue("--sp-strip").trim(),
  ink: getComputedStyle(document.documentElement).getPropertyValue("--sp-ink").trim(),
  accent: getComputedStyle(document.documentElement).getPropertyValue("--sp-accent").trim(),
};

const d = map.getContext("2d").getImageData(0, 0, map.width, map.height).data;
function pixel(x, y) {
  const px = Math.max(0, Math.min(map.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(map.height - 1, Math.round(y)));
  const i = (py * map.width + px) * 4;
  return [d[i], d[i+1], d[i+2], d[i+3]];
}
// The projection #paintMedia uses: the media's own extent across the strip,
// the document height down it.
function project(docX, docY) {
  const x = 1 + ((docX - out.span.left) /
    Math.max(1, out.span.right - out.span.left)) * (map.width - 2);
  const y = out.docRect.top + (docY / out.docHeight) * out.docRect.height;
  return [x, y];
}

const video = document.querySelector("video[data-id='player']");
if (video) {
  const r = video.getBoundingClientRect();
  out.video = {left: r.left + scrollX, top: r.top + scrollY, w: r.width, h: r.height};
}
const img = document.querySelector("img");
if (img) {
  const r = img.getBoundingClientRect();
  out.image = {left: r.left + scrollX, top: r.top + scrollY, w: r.width, h: r.height};
}

out.samples = {};
if (out.video && out.span && out.docRect) {
  const [cx, cy] = project(out.video.left + out.video.w / 2,
                           out.video.top + out.video.h / 2);
  const [ex, ey] = project(out.video.left, out.video.top + out.video.h / 2);
  out.samples.videoCentre = pixel(cx, cy);
  out.samples.videoEdgeRow = [-2, -1, 0, 1, 2, 3].map(i => pixel(ex + i, ey));
}
if (out.image && out.span && out.docRect) {
  const [ix, iy] = project(out.image.left + out.image.w / 2,
                           out.image.top + out.image.h / 2);
  const [ex, ey] = project(out.image.left, out.image.top + out.image.h / 2);
  out.samples.imageCentre = pixel(ix, iy);
  out.samples.imageEdgeRow = [-2, -1, 0, 1, 2, 3].map(i => pixel(ex + i, ey));
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

            print("a page with a player uses the media renderer")
            d = page(MEDIA)
            check("renderer is media", d["mode"] == "media", str(d["mode"]))
            check("the video is collected", d["media"]["video"] == 1,
                  json.dumps(d["media"]))
            check("the pictures are collected", d["media"]["media"] == 4,
                  json.dumps(d["media"]))
            check("the headings come along", d["media"]["heading"] >= 2,
                  json.dumps(d["media"]))
            # The text is what a media map loses first: the cards are the
            # structure, but the description and the comments are still the
            # way you find where you are on the page.
            check("the page's text is kept as bars", d["media"]["text"] >= 2,
                  json.dumps(d["media"]))
            check("the media span is published",
                  bool(d["span"]) and d["span"]["right"] > d["span"]["left"],
                  json.dumps(d["span"]))
            check("the text block renderer is stood down",
                  d["blocks"] is None and d["blockSpan"] is None,
                  f"blocks={d['blocks']}")

            strip = rgb(d["strip"])
            accent = rgb(d["accent"])
            centre = d["samples"]["videoCentre"]
            check("the player is drawn as a filled block",
                  any(abs(centre[i] - strip[i]) > 12 for i in range(3)),
                  f"{centre} vs strip {strip}")
            # The accent is the theme's or the default blue, forced to
            # contrast; the video's fill is a tint of it.
            check("its fill is the accent, not the page's black",
                  centre[2] > centre[0] and centre[2] >= accent[2] - 80,
                  f"centre {centre}, accent {accent}")
            edge = max(d["samples"]["videoEdgeRow"], key=lum)
            check("and it is outlined", lum(edge) > lum(strip) + 0.1,
                  f"edge {edge} vs strip {strip}")

            centre = d["samples"]["imageCentre"]
            check("a picture is drawn hollow",
                  all(abs(centre[i] - strip[i]) <= 3 for i in range(3)),
                  f"{centre} vs strip {strip}")
            edge = max(d["samples"]["imageEdgeRow"], key=lum)
            check("with an outline", lum(edge) > lum(strip) + 0.15,
                  f"edge {edge} vs strip {strip}")

            print("\na wall of pictures is a media page without a video")
            d = page(GALLERY)
            check("renderer is media", d["mode"] == "media", str(d["mode"]))
            check("no video is needed", d["media"]["video"] == 0,
                  json.dumps(d["media"]))
            check("the pictures carry it", d["media"]["media"] >= 12,
                  json.dumps(d["media"]))
            check("and its one caption is kept", d["media"]["text"] >= 1,
                  json.dumps(d["media"]))

            print("\ntext pages keep their own renderers")
            d = page(ARTICLE)
            check("the short article is still blocks", d["mode"] == "blocks",
                  str(d["mode"]))
            d = page(LONG)
            check("the long article is still the raster", d["mode"] == "text",
                  str(d["mode"]))
        finally:
            stop_firefox(proc)

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("media pages get the media renderer, text pages do not")
    return 0


if __name__ == "__main__":
    sys.exit(main())
