#!/usr/bin/env python3
"""
Check that the hover preview reproduces the page's line boxes exactly.

Three separate things went wrong here, all of them invisible in a screenshot
unless you already know what the preview is supposed to look like, so each is
asserted against the page's own geometry:

  1. A run must be one line box. A text node's raw source slice keeps the
     newlines from the HTML source, and the preview draws with
     white-space: pre, so a surviving newline became a real line break and the
     run spilled onto a second line, on top of the run below it.
  2. Every axis must be scaled by the same 0.75. Scaling only the font size
     left the line pitch at 1/0.75 of the page's, which reads as broken
     spacing.
  3. A run must carry no width or height of its own, so a slice that did wrap
     is visible rather than silently clipped.

The reference is the page itself, measured with the same Range technique the
map uses, rather than a number written down here.

    python3 test/verify_preview_lines.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import SRC, fixture_server, launch_firefox, stop_firefox  # noqa: E402

# Kate: m_textPreview->setScaleFactor(0.75)
SCALE = 0.75

PROBE = r"""
const done = arguments[arguments.length - 1];
const strip = document.querySelector(".vugluscr .minimap");
const sr = strip.getBoundingClientRect();
function move() {
  strip.dispatchEvent(new PointerEvent("pointermove", {
    clientX: sr.left + sr.width / 2, clientY: sr.top + sr.height * 0.45,
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }));
}
move();
setTimeout(() => { move(); setTimeout(report, 400); }, 500);

function report() {
  const stage = document.querySelector(".scrollpeak-magnifier__stage");
  const runs = [...stage.children].map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize);
    return {
      tag: el.tagName,
      text: el.textContent,
      hasNewline: /[\n\r\t]/.test(el.textContent),
      hasDoubleSpace: /  /.test(el.textContent),
      edge: (el.textContent !== el.textContent.trim()),
      lineBoxes: r.height / lh,
      left: r.left - s.left,
      top: r.top - s.top,
      w: Math.round(r.width), h: Math.round(r.height),
      fs: parseFloat(cs.fontSize),
      inlineWidth: el.style.width, inlineHeight: el.style.height,
    };
  });

  // The page's own line pitch for the same paragraph, measured the way the map
  // measures it: one rect per line box.
  const p = [...document.querySelectorAll("p")].find((e) => /Colour is doing/.test(e.textContent));
  const range = document.createRange();
  range.selectNodeContents(p.firstChild);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const pagePitch = rects.length > 1 ? rects[1].top - rects[0].top : null;
  const pageFont = parseFloat(getComputedStyle(p).fontSize);

  // The preview's pitch: the most common gap between runs. Taking the mode
  // rather than the mean keeps one heading's much larger gap from dragging the
  // average off the paragraph's own rhythm.
  const ys = runs.map((r) => r.top).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] > 4) gaps.push(ys[i] - ys[i - 1]);
  const tally = new Map();
  for (const g of gaps) {
    const k = g.toFixed(1);
    tally.set(k, (tally.get(k) || 0) + 1);
  }
  let previewPitch = null, best = -1;
  for (const [k, n] of tally) if (n > best) { best = n; previewPitch = Number(k); }

  done({ runs, pagePitch, pageFont, previewPitch, pitchGaps: gaps });
}
"""


def main():
    failures = []

    def check(name, cond, detail=""):
        print(f"  [{'PASS' if cond else 'FAIL'}] {name:52} {detail}")
        if not cond:
            failures.append(name)

    # Overridable so a deliberate bug can be reinstated in a copy and this same
    # test run against it, to prove the assertions above actually bite.
    ext = sys.argv[1] if len(sys.argv) > 1 else SRC

    with fixture_server() as server:
        proc, m = launch_firefox()
        try:
            m.cmd("Addon:Install", {"path": ext, "temporary": True})
            time.sleep(2)
            m.cmd("WebDriver:Navigate", {"url": server.fixtures + "/article.html"})
            time.sleep(4)
            r = m.cmd("WebDriver:ExecuteAsyncScript",
                      {"script": PROBE, "args": [SCALE], "scriptTimeout": 30000})
            d = r.get("value", r)
        finally:
            stop_firefox(proc)

    runs = d["runs"]
    check("the preview drew something", len(runs) >= 4, f"{len(runs)} runs")

    # 1. one run is one line box
    multiline = [r for r in runs if r["lineBoxes"] > 1.5]
    check("every run is exactly one line box", not multiline,
          "; ".join(f"{r['lineBoxes']:.1f} boxes: {r['text'][:28]!r}" for r in multiline)
          or f"{len(runs)} runs, all 1 box")

    # 1b. and the cause: no raw whitespace survived from the source
    withws = [r for r in runs if r["hasNewline"]]
    check("no run carries a raw newline or tab", not withws,
          "; ".join(repr(r["text"][:34]) for r in withws) or "none")

    doubles = [r for r in runs if r["hasDoubleSpace"]]
    check("no run carries a collapsed double space", not doubles,
          "; ".join(repr(r["text"][:34]) for r in doubles) or "none")

    edges = [r for r in runs if r["edge"]]
    check("no run is indented or trailing-spaced", not edges,
          "; ".join(repr(r["text"][:34]) for r in edges) or "none")

    # 2. the font is scaled
    check("the font is scaled by 0.75",
          abs(runs[0]["fs"] - round(d["pageFont"] * SCALE)) <= 1,
          f"preview {runs[0]['fs']}px vs page {d['pageFont']}px -> "
          f"expected {round(d['pageFont'] * SCALE)}px")

    # 3. the pitch is scaled, which is what the unscaled-y bug broke
    check("the line pitch is scaled by 0.75",
          d["previewPitch"] and abs(d["previewPitch"] - d["pagePitch"] * SCALE) <= 1.5,
          f"gaps {d['pitchGaps']}, mode {d['previewPitch']}px; "
          f"page {d['pagePitch']:.2f}px -> expected {d['pagePitch'] * SCALE:.1f}px")

    # 4. no forced box, so a wrap would be visible
    forced = [r for r in runs if r["inlineWidth"] or r["inlineHeight"]]
    check("no run has a width or height forced on it", not forced,
          "; ".join(f"{r['inlineWidth']}/{r['inlineHeight']}" for r in forced) or "none")

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("the preview reproduces the page's line boxes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
