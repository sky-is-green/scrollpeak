#!/usr/bin/env python3
"""
Check that the preview is the page, translated and scaled.

The preview is a clone of the page's content moved into the magnifier with a
CSS transform. The claim that makes that worth doing is a strong one and is
what this tests: every element sits exactly where the page puts it, relative to
every other element, scaled by 0.75 -- because it is the page's own layout,
laid out by the same engine, not a reconstruction of it.

That is a much better claim than the old test could make. The preview used to
be assembled from measured text runs and cloned graphics, and the test could
only check that the measurements were self-consistent. This checks them against
the page.

Offsets rather than absolute positions, because the transform deliberately
translates the content to put the hovered region in view; what must not change
is the relationships.

    python3 test/verify_preview_lines.py [extension-dir]
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import SRC, fixture_server, launch_firefox, stop_firefox  # noqa: E402

SCALE = 0.75

# Elements the fixture has plenty of, in the order both trees yield them, so
# the page's and the clone's can be paired by index without ids.
SELECTOR = "h1, h2, h3, p, li, a, code, blockquote"

PROBE = r"""
const done = arguments[arguments.length - 1];
const SCALE_ARG = arguments[0];
const SEL = arguments[1];
const strip = document.querySelector(".vugluscr .minimap");
const sr = strip.getBoundingClientRect();
function move() {
  strip.dispatchEvent(new PointerEvent("pointermove", {
    clientX: sr.left + sr.width / 2, clientY: sr.top + sr.height * 0.45,
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }));
}
move();
setTimeout(() => { move(); setTimeout(report, 500); }, 600);

function report() {
  const pop = document.querySelector(".scrollpeak-magnifier");
  const frame = pop.querySelector(".scrollpeak-magnifier__frame");
  const idoc = frame.contentDocument;
  // The clone lives in the preview's frame, so querying this document for
  // SEL returns only the page's own copy -- which is what the pairs want.
  const page = [...document.querySelectorAll(SEL)];
  const clone = [...idoc.querySelectorAll(SEL)];
  const n = Math.min(page.length, clone.length);
  const pairs = [];
  // Offsets, not positions: the transform translates to put the hovered region
  // in view, so absolute positions are expected to differ. What must hold is
  // that the *distance* between two elements is the page's, scaled by 0.75 --
  // and the page's rects are unscaled while the clone's are already scaled, so
  // the scale goes on one side of the comparison, not both.
  const ra = page[0].getBoundingClientRect();
  const rb = clone[0].getBoundingClientRect();
  for (let i = 0; i < n; i++) {
    const a = page[i].getBoundingClientRect();
    const b = clone[i].getBoundingClientRect();
    if (a.width < 1 || b.width < 1) continue;
    pairs.push({
      tag: page[i].tagName,
      text: (page[i].textContent || "").trim().slice(0, 22),
      dx: (b.left - rb.left) - (a.left - ra.left) * SCALE_ARG,
      dy: (b.top - rb.top) - (a.top - ra.top) * SCALE_ARG,
      pw: a.width, cw: b.width, ph: a.height, ch: b.height,
    });
  }
  done({
    open: pop.classList.contains("is-open"),
    pageCount: page.length, cloneCount: clone.length, pairs,
    stageText: idoc.body.textContent,
    // Does the preview contain a second copy of a string the page has once?
    dupes: ["Colour as structure", "Colour is doing most of the work here",
            "reusing those is cheaper", "signal the page was already giving us for free"]
      .map((s) => ({ s, n: idoc.body.textContent.split(s).length - 1 })),
    nodeCount: idoc.querySelectorAll(".scrollpeak-magnifier__page *").length,
    dbg: pop.dataset.dbg,
  });
}
"""


def main():
    failures = []

    def check(name, cond, detail=""):
        print(f"  [{'PASS' if cond else 'FAIL'}] {name:46} {detail}")
        if not cond:
            failures.append(name)

    ext = sys.argv[1] if len(sys.argv) > 1 else SRC

    with fixture_server() as server:
        proc, m = launch_firefox()
        try:
            m.cmd("Addon:Install", {"path": ext, "temporary": True})
            time.sleep(2)
            m.cmd("WebDriver:Navigate", {"url": server.fixtures + "/article.html"})
            time.sleep(4)
            r = m.cmd("WebDriver:ExecuteAsyncScript",
                      {"script": PROBE, "args": [SCALE, SELECTOR], "scriptTimeout": 30000})
            d = r.get("value", r)
        finally:
            stop_firefox(proc)

    check("the preview opened", d["open"])
    # The clone is the whole content subtree, so it holds every one of them --
    # 0.95 rather than exactly 1 because a page can have an element the
    # browser does not lay out at the size we filter on.
    check("it holds the page's elements, not a subset",
          d["cloneCount"] >= d["pageCount"] * 0.95,
          f"{d['cloneCount']} of {d['pageCount']}")

    # The strongest form of "nothing overlaps": nothing is drawn twice either.
    # The old preview emitted a text run and a cloned graphic for the same
    # content and they landed on top of each other; this is the check that
    # would have caught it directly.
    bad = [x for x in d["dupes"] if x["n"] != 1]
    check("every string appears exactly once", not bad,
          "; ".join(f"{x['s'][:22]!r} x{x['n']}" for x in bad) or
          f"{len(d['dupes'])} sampled, all 1")

    pairs = d["pairs"]
    check("there are elements to compare", len(pairs) >= 8, f"{len(pairs)} pairs")

    # Offsets between elements are the page's, scaled. This is the claim: the
    # preview is the page's layout, not a reconstruction of it.
    worst = 0.0
    worst_of = ""
    for p in pairs:
        sx = max(abs(p["dx"]), abs(p["dy"]))
        if sx > worst:
            worst, worst_of = sx, f"{p['tag']} {p['text']!r}"
    # The pair subtracted is itself measured, so both sides carry the same
    # sub-pixel rounding; anything above a pixel is a real disagreement.
    check("element offsets are the page's, scaled by 0.75", worst <= 1.0,
          f"worst {worst:.2f}px of stage error ({worst_of})")

    sizerr = max(
        (abs(p["cw"] - p["pw"] * SCALE) + abs(p["ch"] - p["ph"] * SCALE) for p in pairs),
        default=0.0,
    )
    check("element sizes are the page's, scaled by 0.75", sizerr <= 1.0,
          f"worst {sizerr:.2f}px")

    check("the clone is one subtree, not many pieces", d["nodeCount"] > 20,
          f"{d['nodeCount']} nodes")

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("the preview is the page, translated and scaled")
    return 0


if __name__ == "__main__":
    sys.exit(main())
