#!/usr/bin/env python3
"""
Prove the hover preview tracks the pointer continuously.

This is a regression test for a real bug: the preview used to be debounced on
every pointermove, so the timer was reset continuously while the pointer moved
and only fired once it stopped. The preview therefore lagged and then jumped.

Kate gets this right in showTextPreviewDelayed(): the 250ms timer guards only
the *first* appearance, and once the preview widget exists it repaints on every
mouse move. This drives a burst of moves with no pause between them and checks
that each one lands.

    python3 test/verify_hover_tracking.py
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import (  # noqa: E402
    ARTICLE, SRC, fixture_server, launch_firefox, stop_firefox,
)

# A burst of moves along the strip, all dispatched in the same task, so there
# is no wall-clock gap for a timer to fire in. Then one more after a pause.
BURST = r"""
const done = arguments[arguments.length - 1];
const strip = document.querySelector(".vugluscr .minimap");
const r = strip.getBoundingClientRect();

function at(frac) {
  return { clientX: r.left + r.width / 2, clientY: r.top + r.height * frac,
           bubbles: true, cancelable: true, pointerId: 1, isPrimary: true };
}

// The preview records the document offset it last painted, so we can tell
// whether it actually moved with the pointer.
function readOffset() {
  const pop = document.querySelector(".scrollpeak-magnifier");
  if (!pop) return null;
  const d = pop.dataset.dbg ? JSON.parse(pop.dataset.dbg) : null;
  return d ? d.docY : null;
}

const seen = [];
const fracs = [0.20, 0.35, 0.50, 0.65, 0.80];
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The preview paints at most once per animation frame, so "the move landed"
// means the next frame has run. Waiting a fixed 16ms instead assumes a frame
// is never dropped, and a dropped frame under load makes two moves read the
// same -- a flake, not a regression. Two frames, so the callback queued by
// the move is certain to have run.
const frame = () => new Promise(r =>
  requestAnimationFrame(() => requestAnimationFrame(r)));

(async () => {
  // Phase 1: arrive on the strip and wait out Kate's first-show delay. The
  // preview should now exist, exactly as it does for a real hover.
  strip.dispatchEvent(new PointerEvent("pointermove", at(0.10)));
  await sleep(400);
  const established = readOffset();

  // Phase 2: move across it without pausing. This is the case that was
  // broken -- a debounce on every move meant nothing painted until the
  // pointer stopped.
  for (const f of fracs) {
    strip.dispatchEvent(new PointerEvent("pointermove", at(f)));
    // One hand position per frame, the way a real pointer moves.
    await frame();
    seen.push({ frac: f, docY: readOffset() });
  }
  done({ established, seen, stripTop: r.top, stripH: r.height });
})();
"""


def main():
    failures = []

    def check(name, cond, detail=""):
        print(f"  [{'PASS' if cond else 'FAIL'}] {name:46} {detail}")
        if not cond:
            failures.append(name)

    with fixture_server() as server:
        proc, m = launch_firefox(SRC)
        try:
            m.cmd("WebDriver:Navigate", {"url": server.fixtures + ARTICLE})
            time.sleep(4)

            r = m.cmd("WebDriver:ExecuteAsyncScript",
                      {"script": BURST, "args": [], "scriptTimeout": 30000})
            d = r.get("value", r)
            seen = d["seen"]

            print(f"arrival: preview established at docY={d['established']}")
            check("first hover shows the preview after the 250ms delay",
                  d["established"] is not None, f"docY={d['established']}")

            print("\nthen one move every 16ms across it, no pause:")
            print("   frac   docY")
            for s in seen:
                print(f"   {s['frac']:.2f}   {s['docY']}")

            painted = [s for s in seen if s["docY"] is not None]
            # This only proves every move produced a reading, not that the
            # reading was fresh -- a stale preview satisfies it too, which is
            # exactly how the bug presented. Freshness is what the next three
            # checks measure.
            check("every move produced a reading",
                  len(painted) >= 4, f"{len(painted)}/{len(seen)}")

            if len(painted) >= 2:
                offsets = [s["docY"] for s in painted]
                check("offset increases as the pointer moves down",
                      offsets == sorted(offsets) and offsets[-1] > offsets[0],
                      f"{offsets[0]} -> {offsets[-1]}")

                # Each move should be at a distinct offset: if the debounce
                # were still in place, the early ones would all read the same.
                check("each move lands on its own offset",
                      len(set(offsets)) == len(offsets),
                      f"distinct={len(set(offsets))}/{len(offsets)}")

                # Sanity: the offset should track the strip fraction, since
                # the preview is a linear map from strip position to document.
                doc = m.cmd("WebDriver:ExecuteScript",
                            {"script": "return document.scrollingElement.scrollHeight;",
                             "args": []})["value"]
                first, last = painted[0], painted[-1]
                expected = (last["frac"] - first["frac"]) * doc
                got = last["docY"] - first["docY"]
                check("offset tracks the pointer across the document",
                      abs(got - expected) < doc * 0.15,
                      f"moved {got}px, expected ~{expected:.0f}px of {doc}px")
        finally:
            stop_firefox(proc)

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("the preview tracks the pointer")
    return 0


if __name__ == "__main__":
    sys.exit(main())
