#!/usr/bin/env python3
"""
Check that the preview is the page rendered at the preview's own viewport.

The preview is a clone of the page's content in a sandboxed iframe, scaled by
0.75. The frame's *width* is the width the stage can show at that scale, not
the page's width: the page's own responsive CSS reflows to it, exactly as the
browser would if the window were that wide. That is what stops a narrow
preview from cropping a wide layout, and it means "the preview is the page"
has to be checked against the page rendered at the same width -- a reference
iframe the test opens for itself -- rather than against the page's own
(likely different) layout.

What must still hold against the page is the content: the same elements, once
each, with the page's own relative spacing and sizes whenever the content
column is narrower than both viewports.

It also checks the two things relative offsets cannot see, both of which were
real Wikipedia bugs: absolute document placement (a transform origin other
than the top-left keeps every offset exact and still shows the wrong part of
the page) and the clone's ids (sites place layout with id-keyed rules, and
stripping them reflows the clone). A fixture with a media-query breakpoint
between the page's width and the preview's proves the reflow itself.

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
  const wrap = idoc.querySelector(".scrollpeak-magnifier__page");
  const tm = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(wrap.style.transform);
  const tx = tm ? -parseFloat(tm[1]) : 0;
  const ty = tm ? -parseFloat(tm[2]) : 0;
  const pairs = [];
  // Offsets, not positions: the frame is laid out at a different width from
  // the page, so absolute positions legitimately differ whenever the content
  // reflows. What must hold -- for content narrower than both viewports, as
  // the fixtures' is -- is that the *distances* between elements are the
  // page's, scaled by 0.75.
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

  // The stage's own width is the claim the frame must meet: at 0.75 scale,
  // stageW pixels of screen show stageW / SCALE document pixels, and the
  // frame's viewport is that width.
  const stage = pop.querySelector(".scrollpeak-magnifier__stage");
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const expectedWidth = Math.round(sw / SCALE_ARG);

  // The text lines that actually fall inside the stage, for the centring
  // check. With the frame laid out at its own width there is no panning; the
  // gaps are the page's own margins.
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

  // The reference: the same URL in an iframe with the clone's exact viewport.
  // Both are the page at the same width, so their elements must land on each
  // other -- this is the strongest form of "the preview is the page" the new
  // model allows, and it is what would catch the frame being laid out at the
  // wrong width. Fixed, so it takes no room in this page or the clone (the
  // clone hides fixed elements).
  const ref = document.createElement("iframe");
  ref.setAttribute("aria-hidden", "true");
  ref.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;" +
    "border:0;" +
    "width:" + frame.clientWidth + "px;height:" + frame.clientHeight + "px;";
  ref.addEventListener("load", () => setTimeout(() => finish(ref), 500), { once: true });
  ref.src = location.href;
  document.body.appendChild(ref);

  function finish(ref2) {
    const rdoc = ref2.contentDocument;
    // No scrollbar in the reference either: the clone's frame has none, and a
    // classic scrollbar would take 12px of its layout width and shift every
    // line of the comparison.
    rdoc.documentElement.style.overflow = "hidden";
    const refs = [...rdoc.querySelectorAll(SEL)];
    const clones = [...idoc.querySelectorAll(SEL)];
    let refPairs = 0, refWorst = 0, refWorstOf = "";
    for (let i = 0; i < Math.min(refs.length, clones.length); i++) {
      const a = refs[i].getBoundingClientRect();
      const b = clones[i].getBoundingClientRect();
      if (a.width < 1 || b.width < 1) continue;
      refPairs++;
      // The clone is scaled by SCALE and translated; the reference is not.
      // Undo the transform, then compare document geometry.
      const bl = b.left / SCALE_ARG + tx;
      const bt = b.top / SCALE_ARG + ty;
      const bw = b.width / SCALE_ARG;
      const bh = b.height / SCALE_ARG;
      const err = Math.max(
        Math.abs(bl - a.left), Math.abs(bt - a.top),
        Math.abs(bw - a.width), Math.abs(bh - a.height));
      if (err > refWorst) {
        refWorst = err;
        refWorstOf = refs[i].tagName + " " +
          (refs[i].textContent || "").trim().slice(0, 22);
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
      frameWidth: frame.clientWidth, frameHeight: frame.clientHeight,
      expectedWidth,
      pageWidth: window.innerWidth,
      refPairs, refWorst: +refWorst.toFixed(2), refWorstOf,
      leftGap: inStage ? Math.round(minL) : null,
      rightGap: inStage ? Math.round(sw - maxR) : null,
      inStage,
    });
  }
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

# A page whose layout changes at a breakpoint between the page's width and the
# preview's. The clone must take the narrow branch and the page the wide one.
RESPONSIVE_PROBE = r"""
const done = arguments[arguments.length - 1];
const strip = document.querySelector(".vugluscr .minimap");
const sr = strip.getBoundingClientRect();
function move() {
  strip.dispatchEvent(new PointerEvent("pointermove", {
    clientX: sr.left + sr.width / 2, clientY: sr.top + sr.height * 0.5,
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }));
}
move();
setTimeout(() => { move(); setTimeout(report, 700); }, 600);

function report() {
  const pop = document.querySelector(".scrollpeak-magnifier");
  const frame = pop.querySelector(".scrollpeak-magnifier__frame");
  const iwin = frame.contentWindow;
  function branch(doc, win) {
    const wide = doc.querySelector("#wide");
    const narrow = doc.querySelector("#narrow");
    return {
      wide: wide ? win.getComputedStyle(wide).display !== "none" : null,
      narrow: narrow ? win.getComputedStyle(narrow).display !== "none" : null,
    };
  }
  const dbg = pop.dataset.dbg ? JSON.parse(pop.dataset.dbg) : null;
  done({
    open: pop.classList.contains("is-open"),
    page: branch(document, window),
    clone: branch(frame.contentDocument, iwin),
    pageWidth: window.innerWidth,
    frameWidth: dbg ? dbg.frameWidth : null,
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
            # The fixture's breakpoints and the preview's width are derived
            # from the window, so pin it: 1280 wide makes the preview 848.
            m.cmd("WebDriver:SetWindowRect", {"width": 1280, "height": 800})
            m.cmd("Addon:Install", {"path": ext, "temporary": True})
            time.sleep(2)

            def probe(path, script, args=None, timeout=40000):
                m.cmd("WebDriver:Navigate", {"url": server.fixtures + path})
                time.sleep(4)
                r = m.cmd("WebDriver:ExecuteAsyncScript",
                          {"script": script, "args": args or [], "scriptTimeout": timeout})
                return r.get("value", r)

            d = probe("/article.html", PROBE, [SCALE, SELECTOR])
            d_grid = None
            d_resp = None
            try:
                d_grid = probe("/grid-ids.html", GRID_PROBE)
            except Exception:
                pass
            try:
                d_resp = probe("/responsive.html", RESPONSIVE_PROBE)
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

    # The new model, and the two halves of the old Wikipedia report. Relative
    # offsets alone cannot see any of it: a wrong transform origin keeps every
    # *distance* exact while showing the wrong part of the page, and a frame
    # laid out at the page's width keeps every offset exact while cropping.
    print("\nthe frame is the preview's own viewport")
    check("the frame width is the width the stage shows",
          abs(d["frameWidth"] - d["expectedWidth"]) <= 1,
          f"frame={d['frameWidth']}px expected={d['expectedWidth']}px")
    check("and it really is narrower than the page",
          d["frameWidth"] < d["pageWidth"],
          f"frame={d['frameWidth']}px page={d['pageWidth']}px")
    check("the clone scales from its own top-left corner",
          d["transformOrigin"] in ("0px 0px", "0 0"),
          f"transform-origin {d['transformOrigin']}")

    print("\nthe clone is the page at that viewport")
    check("a reference render at the same width lands on it",
          d["refPairs"] >= 8 and d["refWorst"] <= 1.5,
          f"worst {d['refWorst']}px over {d['refPairs']} pairs ({d['refWorstOf']})")

    # The gaps are the page's own margins now: the frame is laid out at its
    # own width, so nothing is panned and no slack is invented.
    check("the content sits in the frame, not off one side",
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

    print("\na narrow preview gets the page's narrow layout")
    if d_resp is None:
        check("the responsive page could be probed", False)
    else:
        check("the preview opened there too", d_resp["open"])
        check("the page itself uses its wide branch",
              d_resp["page"]["wide"] and not d_resp["page"]["narrow"],
              str(d_resp["page"]))
        check("the clone uses its narrow branch",
              d_resp["clone"]["narrow"] and not d_resp["clone"]["wide"],
              f"frame={d_resp['frameWidth']}px of page {d_resp['pageWidth']}px, "
              f"{d_resp['clone']}")

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("the preview is the page, rendered at the preview's viewport")
    return 0


if __name__ == "__main__":
    sys.exit(main())
