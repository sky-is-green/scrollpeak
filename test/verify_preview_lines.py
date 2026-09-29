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

It also checks the two things relative offsets cannot see, both of which were
real Wikipedia bugs: absolute document placement (a transform origin other
than the top-left keeps every offset exact and still shows the wrong part of
the page) and the clone's ids (sites place layout with id-keyed rules, and
stripping them reflows the clone). A second fixture, grid-ids.html, has its
columns positioned only by id-keyed rules.

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
  // The wrap's transform says where the clone is drawn. Parsing it is how
  // this test tells the two coordinate systems apart: the clone's rects are
  // scaled and translated, the page's are neither.
  const wrap = idoc.querySelector(".scrollpeak-magnifier__page");
  const tm = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(wrap.style.transform);
  const tx = tm ? -parseFloat(tm[1]) : 0;
  const ty = tm ? -parseFloat(tm[2]) : 0;
  const pairs = [];
  // Offsets, not positions: the transform translates to put the hovered region
  // in view, so absolute positions are expected to differ. What must hold is
  // that the *distance* between two elements is the page's, scaled by 0.75 --
  // and the page's rects are unscaled while the clone's are already scaled, so
  // the scale goes on one side of the comparison, not both.
  const ra = page[0].getBoundingClientRect();
  const rb = clone[0].getBoundingClientRect();
  // And absolute placement, the other half of the claim: the clone element
  // must be the page element's document position, scaled and translated. A
  // transform origin other than 0 0 keeps every relative offset exact and
  // still puts the wrong part of the page in the window; this is the check
  // that catches it.
  let worstAbs = 0, worstAbsOf = "";
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
      ax: a.left + scrollX, ay: a.top + scrollY,
      bx: b.left / SCALE_ARG + tx, by: b.top / SCALE_ARG + ty,
    });
    const absErr = Math.max(
      Math.abs(pairs[pairs.length - 1].bx - pairs[pairs.length - 1].ax),
      Math.abs(pairs[pairs.length - 1].by - pairs[pairs.length - 1].ay));
    if (absErr > worstAbs) {
      worstAbs = absErr;
      worstAbsOf = page[i].tagName + " " +
        (page[i].textContent || "").trim().slice(0, 22);
    }
  }

  // Horizontal centring: the gap the stage leaves on each side of the
  // clone's *text lines* -- the same population contentSpanNear centres on.
  // Block rects would not do, because a paragraph is as wide as its column
  // while its last line is not. The old preview anchored the window's left
  // edge to the hovered line, which put all the slack on one side and
  // clipped the other.
  const stage = pop.querySelector(".scrollpeak-magnifier__stage");
  const sw = stage.clientWidth, sh = stage.clientHeight;
  let minL = Infinity, maxR = -Infinity, inStage = 0;
  const walker = idoc.createTreeWalker(idoc.body, NodeFilter.SHOW_TEXT, null);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    const range = idoc.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      if (r.width < 4 || r.height < 4) continue;
      if (r.bottom < 0 || r.top > sh || r.right < 0 || r.left > sw) continue;
      inStage++;
      if (r.left < minL) minL = r.left;
      if (r.right > maxR) maxR = r.right;
    }
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
    transformOrigin: getComputedStyle(wrap).transformOrigin,
    worstAbs: +worstAbs.toFixed(2), worstAbsOf,
    leftGap: inStage ? Math.round(minL) : null,
    rightGap: inStage ? Math.round(sw - maxR) : null,
    inStage,
  });
}
"""

# The same transformation, on a page whose grid is placed by id-keyed rules.
# Stripping ids from the clone (which buildPage() used to do) leaves the
# columns to auto-placement, which swaps them. Wikipedia's Vector skin does
# exactly this with `#content > .vector-body`, and the clone's whole article
# reflowed into the wrong grid cell.
GRID_PROBE = r"""
const done = arguments[arguments.length - 1];
const strip = document.querySelector(".vugluscr .minimap");
const sr = strip.getBoundingClientRect();
function move() {
  strip.dispatchEvent(new PointerEvent("pointermove", {
    clientX: sr.left + sr.width / 2, clientY: sr.top + sr.height * 0.5,
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }));
}
move();
setTimeout(() => { move(); setTimeout(report, 700); }, 500);

function report() {
  const pop = document.querySelector(".scrollpeak-magnifier");
  const idoc = pop.querySelector(".scrollpeak-magnifier__frame").contentDocument;
  const wrap = idoc.querySelector(".scrollpeak-magnifier__page");
  const tm = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(wrap.style.transform);
  const tx = tm ? -parseFloat(tm[1]) : 0;
  const ty = tm ? -parseFloat(tm[2]) : 0;
  function err(sel) {
    const a = document.querySelector(sel);
    const b = idoc.querySelector(sel);
    if (!a || !b) return null;
    const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
    return {
      dx: Math.round((br.left / 0.75 + tx) - (ar.left + scrollX)),
      dy: Math.round((br.top / 0.75 + ty) - (ar.top + scrollY)),
    };
  }
  done({
    open: pop.classList.contains("is-open"),
    idsInPage: document.querySelectorAll("[id]").length,
    idsInClone: idoc.querySelectorAll("[id]").length,
    hasFirstHeading: !!idoc.querySelector("#firstHeading"),
    main: err("#main"), side: err("#side"), heading: err("#firstHeading"),
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
            d_grid = None
            try:
                m.cmd("WebDriver:Navigate", {"url": server.fixtures + "/grid-ids.html"})
                time.sleep(4)
                r = m.cmd("WebDriver:ExecuteAsyncScript",
                          {"script": GRID_PROBE, "args": [], "scriptTimeout": 30000})
                d_grid = r.get("value", r)
            except Exception:
                pass
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

    # The two halves of the Wikipedia report. Relative offsets alone cannot
    # see either: a wrong transform origin keeps every *distance* exact while
    # showing the wrong part of the page, and stripping ids keeps every
    # relative offset exact on a page whose columns are placed by id.
    print("\nabsolute placement and centring")
    check("the clone scales from its own top-left corner",
          d["transformOrigin"] in ("0px 0px", "0 0"),
          f"transform-origin {d['transformOrigin']}")
    check("clone elements sit at the page's document coordinates",
          d["pairs"] and d["worstAbs"] <= 1.0,
          f"worst {d['worstAbs']}px ({d['worstAbsOf']})")
    # The gaps are measured on the lines that happen to fall inside the
    # stage, while the map centres the column around the hovered offset, so a
    # few pixels of asymmetry are expected. The old preview left-anchored the
    # window and put ~130px of slack on this fixture's right-hand side.
    check("the visible content is centred, not left-anchored",
          d["inStage"] >= 4 and abs(d["leftGap"] - d["rightGap"]) <= 24,
          f"left {d['leftGap']}px right {d['rightGap']}px over {d['inStage']} lines")

    print("\nthe clone keeps the page's ids")
    if d_grid is None:
        check("the id-grid page could be probed", False)
    else:
        check("the preview opened there too", d_grid["open"])
        check("ids survive into the clone",
              d_grid["idsInPage"] > 0 and
              d_grid["idsInClone"] >= d_grid["idsInPage"] * 0.9,
              f"{d_grid['idsInClone']} of {d_grid['idsInPage']}")
        check("#firstHeading is in the clone", d_grid["hasFirstHeading"])
        for sel in ("main", "side", "heading"):
            e = d_grid[sel]
            err = max(abs(e["dx"]), abs(e["dy"])) if e else 999
            check(f"#{sel} sits where the page puts it", e and err <= 1.5,
                  f"dx={e['dx']} dy={e['dy']}" if e else "missing")

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("the preview is the page, translated and scaled")
    return 0


if __name__ == "__main__":
    sys.exit(main())
