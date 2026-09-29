#!/usr/bin/env python3
"""
Regression tests for two alignment bugs, both found by using the thing.

1. The map was compressed into the top of the strip. Kate computes
   docHeight = min(grooveHeight, pixmapHeight * 2) - 2, so a document with few
   line boxes gets a short map. A 2200px article has about 60 line boxes, so
   the map was squeezed into 124px of a 682px groove while the thumb, the fade
   band and the preview's document offset all used the full 682. Four
   coordinate systems in one 60px widget. On a text file Kate's clamp rarely
   bites; on the web it always does.

2. The preview died on the scrollbar's track. vugluscr's rail is the minimap
   plus a separate track beside it; the preview only listened on the minimap,
   so pointerleave killed it on the part of the rail a user thinks of as "the
   scrollbar". In Kate the map *is* the scrollbar, so this cannot arise.

    python3 test/verify_alignment.py
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import (  # noqa: E402
    ARTICLE, SRC, fixture_server, launch_firefox, stop_firefox,
)

PROBE = r"""
const done = arguments[arguments.length - 1];
const q = s => document.querySelector(s);
const strip = q(".vugluscr .minimap");
const rail = q(".vugluscr .scrollbar");
const track = q(".vugluscr .track");
const thumb = q(".vugluscr .minimap .thumb");
const map = q(".scrollpeak-map");
if (!strip || !map) { done({err: "no rail"}); return; }

const sr = strip.getBoundingClientRect();
const out = {
  stripH: Math.round(sr.height),
  stripW: Math.round(sr.width),
  railH: Math.round(rail.getBoundingClientRect().height),
  trackW: track ? Math.round(track.getBoundingClientRect().width) : 0,
  docHeight: document.scrollingElement.scrollHeight,
  viewport: window.innerHeight,
  scrollY: Math.round(window.scrollY),
};

// Where the map was actually drawn. Reading the canvas cannot answer this:
// it is filled with the page background across the full height first, so
// every pixel has alpha 255 whether or not the map reached it.
out.docRect = map.dataset.docRect ? JSON.parse(map.dataset.docRect) : null;

// The band paint() drew, against the thumb's real position.
out.band = map.dataset.band ? JSON.parse(map.dataset.band) : null;
if (thumb) {
  const tr = thumb.getBoundingClientRect();
  out.thumb = {
    top: Math.round(tr.top - sr.top),
    height: Math.round(tr.height),
  };
}

async function hover(el, frac) {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent("pointermove", {
    clientX: r.left + r.width / 2, clientY: sr.top + sr.height * frac,
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true
  }));
  await new Promise(r => setTimeout(r, 60));
  const pop = q(".scrollpeak-magnifier");
  if (!pop) return { open: false, docY: null };
  const dbg = pop.dataset.dbg ? JSON.parse(pop.dataset.dbg) : null;
  return { open: pop.classList.contains("is-open"), docY: dbg ? dbg.docY : null };
}

(async () => {
  // Past Kate's 250ms first-show delay before measuring anything.
  strip.dispatchEvent(new PointerEvent("pointermove", {
    clientX: sr.left + sr.width / 2, clientY: sr.top + 10,
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true
  }));
  await new Promise(r => setTimeout(r, 400));

  out.onMap = await hover(strip, 0.62);
  out.onTrack = await hover(track, 0.62);
  // Leaving the rail entirely should still hide it.
  rail.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
  await new Promise(r => setTimeout(r, 250));
  const pop = q(".scrollpeak-magnifier");
  out.hiddenAfterLeaving = pop ? !pop.classList.contains("is-open") : true;
  done(out);
})();
"""


def main():
    failures = []

    def check(name, cond, detail=""):
        print(f"  [{'PASS' if cond else 'FAIL'}] {name:48} {detail}")
        if not cond:
            failures.append(name)

    with fixture_server() as server:
        proc, m = launch_firefox(SRC)
        try:
            m.cmd("WebDriver:Navigate", {"url": server.fixtures + ARTICLE})
            time.sleep(4)

            for scroll in (0, 700, 1400):
                m.cmd("WebDriver:ExecuteScript",
                      {"script": f"window.scrollTo(0,{scroll});", "args": []})
                time.sleep(1)
                r = m.cmd("WebDriver:ExecuteAsyncScript",
                          {"script": PROBE, "args": [], "scriptTimeout": 40000})
                d = r.get("value", r)
                if "err" in d:
                    check(f"probe at scrollY={scroll}", False, d["err"])
                    continue

                print(f"\nscrollY={d['scrollY']} of "
                      f"{d['docHeight'] - d['viewport']}")

                # 1. the map must be drawn over the full strip
                if d.get("docRect"):
                    frac = d["docRect"]["height"] / d["stripH"]
                    check("map is drawn over the full strip height", frac > 0.95,
                          f"drawn {d['docRect']['height']}px of {d['stripH']}px "
                          f"({frac * 100:.0f}%)")
                else:
                    check("map reports where it drew", False)

                # 2. the band must sit on the thumb
                if d.get("band") and d.get("thumb"):
                    dt = abs(d["band"]["top"] - d["thumb"]["top"])
                    dh = abs(d["band"]["height"] - d["thumb"]["height"])
                    check("viewport band lines up with the thumb", dt <= 3 and dh <= 3,
                          f"band {d['band']['top']}+{d['band']['height']} "
                          f"vs thumb {d['thumb']['top']}+{d['thumb']['height']}")
                else:
                    check("band and thumb both measurable", False,
                          f"band={d.get('band')} thumb={d.get('thumb')}")

                # 3. the preview must work on the map and on the track
                check("preview follows the cursor on the map",
                      d["onMap"]["open"] and d["onMap"]["docY"] is not None,
                      f"docY={d['onMap']['docY']}")
                check("preview follows the cursor on the track",
                      d["onTrack"]["open"] and d["onTrack"]["docY"] is not None,
                      f"docY={d['onTrack']['docY']}")
                check("both give the same document offset",
                      d["onMap"]["docY"] == d["onTrack"]["docY"],
                      f"map={d['onMap']['docY']} track={d['onTrack']['docY']}")
                check("preview hides when the pointer leaves the rail",
                      d["hiddenAfterLeaving"])

                # 4. the preview must agree with where a click would land
                frac, doc = 0.62, d["docHeight"]
                expected = frac * doc
                check("preview offset matches the cursor position",
                      abs(d["onMap"]["docY"] - expected) < doc * 0.02,
                      f"docY={d['onMap']['docY']} expected ~{expected:.0f}")
        finally:
            stop_firefox(proc)

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("map, band, thumb and preview all agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
