#!/usr/bin/env python3
"""
Headless smoke test for ScrollPeek.

Loads the extension into a throwaway Firefox profile as a temporary add-on,
drives it over a real page with Marionette, and asserts the things that are
easy to get wrong: that the rail mounts, that our map actually painted the
page's own colours, that the hover preview appears, and that clicking the
strip scrolls the page.

Run it:
    python3 -m http.server 8765 --directory test/fixtures &
    python3 test/smoke.py

Exits non-zero if any check fails. This is deliberately a smoke test, not a
suite: it proves the extension runs, not that it is correct on every page.
"""
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import (  # noqa: E402
    ARTICLE, SRC, fixture_server, launch_firefox, stop_firefox,
)


INSPECT = r"""
const done = arguments[arguments.length - 1];
const checks = {};
const ok = (n, c, d) => { checks[n] = {pass: !!c, detail: d === undefined ? null : d}; };
const q = (s) => document.querySelector(s);

ok("rail_mounted", !!q(".vugluscr .scrollbar"));
ok("strip_present", !!q(".vugluscr .minimap"));
ok("viewport_thumb", !!q(".vugluscr .minimap .thumb"));
// Kate replaces the scrollbar outright, so the native one must be gone.
ok("native_scrollbar_suppressed",
   document.documentElement.classList.contains("vugluscr_active"));

const map = q(".scrollpeak-map");
ok("our_canvas", !!map, map ? map.width + "x" + map.height : null);

// vugluscr's own block map must be switched off, not merely covered: its
// per-element getBoundingClientRect sweep is pure waste once we draw our own.
const svg = q(".vugluscr .minimap svg");
ok("vugluscr_map_disabled", !!svg && svg.childElementCount === 0,
   svg ? svg.childElementCount : null);

// The svg must remain hit-testable -- it carries the strip's click-to-jump.
const r = q(".vugluscr .minimap").getBoundingClientRect();
const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height * 0.5);
ok("strip_hit_testable", !!hit && hit.tagName.toLowerCase() === "svg",
   hit ? hit.tagName : null);

let painted = 0, colors = new Set(), rows = new Set(), buckets = new Set();
const bucket = map ? Math.max(2, Math.floor(map.width / 10)) : 8;
const bucketCount = map ? Math.ceil(map.width / bucket) : 10;
if (map) {
  const d = map.getContext("2d").getImageData(0, 0, map.width, map.height).data;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const i = (y * map.width + x) * 4;
      if (d[i + 3] > 0) {
        painted++;
        rows.add(y);
        // Bucket width derived from the map width: Kate's default strip is
        // 40px, and a fixed bucket size would make the assertion meaningless.
        buckets.add(Math.floor(x / bucket));
        if (colors.size < 16) colors.add(`${d[i]},${d[i+1]},${d[i+2]}`);
      }
    }
  }
}
ok("map_painted", painted > 2000, "px=" + painted);
ok("map_uses_page_colours", colors.size >= 3, "colours=" + colors.size);
ok("map_spans_document", rows.size > 40, "rows=" + rows.size);
ok("map_spans_width", buckets.size >= bucketCount - 1,
   buckets.size + "/" + bucketCount);

done({checks, docHeight: document.scrollingElement.scrollHeight,
      viewport: window.innerHeight, painted, colors: colors.size});
"""

HOVER = r"""
const done = arguments[arguments.length - 1];
const strip = document.querySelector(".vugluscr .minimap");
const r = strip.getBoundingClientRect();
strip.dispatchEvent(new PointerEvent("pointermove", {
  clientX: r.left + r.width / 2, clientY: r.top + r.height * 0.62,
  bubbles: true, cancelable: true, pointerId: 1, isPrimary: true
}));
// Kate debounces the preview by 250ms; wait past it.
setTimeout(() => {
  const pop = document.querySelector(".scrollpeak-magnifier");
  const out = {exists: !!pop};
  if (pop) {
    const rect = pop.getBoundingClientRect();
    out.open = pop.classList.contains("is-open");
    out.placed_left_of_strip = rect.right <= r.left + 2;
    out.fully_on_screen = rect.left >= 0 && rect.top >= 0 &&
      rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
    // Kate sizes the preview at half the view's width by a fifth of its
    // height. getBoundingClientRect includes the 1px border on each side, so
    // compare the content box.
    const cs = getComputedStyle(pop);
    const bw = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    const bh = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    out.contentWidth = Math.round(rect.width - bw);
    out.contentHeight = Math.round(rect.height - bh);
    out.expectedWidth = Math.round(window.innerWidth / 2);
    out.expectedHeight = Math.round(window.innerHeight / 5);
    out.size = out.contentWidth + "x" + out.contentHeight;
    // The preview is DOM, not a canvas: cloned page elements positioned in a
    // stage. Checked by what is in it, which also proves it is not empty.
    const stage = pop.querySelector(".scrollpeak-magnifier__stage");
    out.hasStage = !!stage;
    out.text_lines = stage ? stage.querySelectorAll(".scrollpeak-magnifier__line").length : 0;
    out.items = pop.dataset.items ? Number(pop.dataset.items) : 0;
  }
  done(out);
}, 800);
"""

CLICK = r"""
const done = arguments[arguments.length - 1];
const before = window.scrollY;
const r = document.querySelector(".vugluscr .minimap").getBoundingClientRect();
const cx = r.left + r.width / 2, cy = r.top + r.height * 0.75;
const target = document.elementFromPoint(cx, cy);
const opts = {clientX: cx, clientY: cy, bubbles: true, cancelable: true,
              button: 0, pointerId: 1, isPrimary: true};
target.dispatchEvent(new PointerEvent("pointerdown", opts));
window.dispatchEvent(new PointerEvent("pointerup", opts));
setTimeout(() => done({before, after: window.scrollY,
  maxScroll: document.scrollingElement.scrollHeight - window.innerHeight}), 800);
"""


def main():
    failures = []
    with fixture_server() as server:
      proc, m = launch_firefox(SRC)
      try:
        time.sleep(2)
        m.cmd("WebDriver:Navigate", {"url": server.fixtures + ARTICLE})
        time.sleep(4)

        res = m.cmd("WebDriver:ExecuteAsyncScript",
                    {"script": INSPECT, "args": [], "scriptTimeout": 30000})
        data = res.get("value", res)
        print(f"document {data['docHeight']}px in a {data['viewport']}px viewport\n")
        for name, v in data["checks"].items():
            mark = "PASS" if v["pass"] else "FAIL"
            print(f"  [{mark}] {name:28} {v['detail']}")
            if not v["pass"]:
                failures.append(name)

        hover = m.cmd("WebDriver:ExecuteAsyncScript",
                      {"script": HOVER, "args": [], "scriptTimeout": 30000})
        hover = hover.get("value", hover)
        print("\nhover preview")
        for k, v in hover.items():
            ok = (k in ("exists", "open", "placed_left_of_strip",
                        "fully_on_screen") and v) or \
                 (k == "hasStage" and v) or \
                 (k == "text_lines" and v > 0) or \
                 (k == "items" and v > 0) or \
                 (k == "contentWidth" and abs(v - hover["expectedWidth"]) <= 2) or \
                 (k == "contentHeight" and abs(v - hover["expectedHeight"]) <= 2) or \
                 k == "expectedWidth" or k == "expectedHeight" or k == "size"
            print(f"  [{'PASS' if ok else 'FAIL'}] {k:24} {v}")
            if not ok:
                failures.append("hover." + k)

        click = m.cmd("WebDriver:ExecuteAsyncScript",
                      {"script": CLICK, "args": [], "scriptTimeout": 30000})
        click = click.get("value", click)
        moved = abs(click["after"] - click["before"]) > 50
        print("\nclick to jump")
        print(f"  [{'PASS' if moved else 'FAIL'}] scrollY {click['before']} -> {click['after']} "
              f"(max {click['maxScroll']})")
        if not moved:
            failures.append("click_to_jump")
      finally:
        err = stop_firefox(proc)
        noisy = [l for l in err.splitlines()
                 if "ScrollPeek" in l or "JavaScript error" in l]
        # setPointerCapture on a synthetic pointer id is a test artefact, not
        # a product fault: a real pointer has a real id.
        noisy = [l for l in noisy if "Invalid pointer id" not in l]
        if noisy:
            print("\nfirefox reported:")
            for line in noisy[:15]:
                print("  " + line)

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
