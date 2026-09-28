#!/usr/bin/env python3
"""
Verify that line splitting is exact rather than approximate.

Kate asks its buffer for line N and gets line N. Here the text is laid out by
the browser, so the text belonging to each line box has to be recovered from
the text node it came from. The production code binary searches for each
boundary; this test checks that against an oracle.

The oracle walks a text node one character at a time with a Range and groups
characters by the line box they land in. That is O(n) and far too slow to ship
-- which is precisely why the production code binary searches -- but it makes
an exact reference to compare against.

    python3 -m http.server 8765 --directory test/fixtures &
    python3 test/verify_line_split.py
"""
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

ORACLE = r"""
const done = arguments[arguments.length - 1];
const out = {nodes: 0, exact: 0, wrong: 0, chars: 0, examples: []};
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
  acceptNode(n) {
    if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
    const p = n.parentElement;
    if (!p) return NodeFilter.FILTER_REJECT;
    if (SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
    if (p.closest(".vugluscr, .scrollpeak-map, .scrollpeak-magnifier")) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  }
});
const r = document.createRange();
const nr = document.createRange();

for (let node = walker.nextNode(); node; node = walker.nextNode()) {
  const text = node.nodeValue;
  nr.selectNodeContents(node);
  const boxes = [...nr.getClientRects()].filter(b => b.width > 0 && b.height > 0);
  if (boxes.length < 2) continue;   // only wrapped nodes can go wrong
  out.nodes++;

  // Oracle: character -> line index, by which line box it sits in.
  const truth = [];
  for (let i = 0; i < text.length; i++) {
    r.setStart(node, i);
    r.setEnd(node, i + 1);
    const b = r.getBoundingClientRect();
    if (b.height === 0) continue;
    let li = 0;
    for (let k = 0; k < boxes.length; k++) if (b.top > boxes[k].top + 0.5) li = k + 1;
    truth.push(li);
  }
  const truthBounds = [0];
  for (let i = 1; i < truth.length; i++) if (truth[i] !== truth[i - 1]) truthBounds.push(i);
  truthBounds.push(text.length);

  // Production algorithm: binary search for each boundary.
  const bounds = [0];
  for (let i = 1; i < boxes.length; i++) {
    const above = boxes[i - 1].top;
    let lo = bounds[i - 1], hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      r.setStart(node, mid);
      r.setEnd(node, Math.min(text.length, mid + 1));
      const bb = r.getBoundingClientRect();
      if (bb.height === 0 || bb.top > above) hi = mid; else lo = mid + 1;
    }
    bounds[i] = lo;
  }
  bounds[boxes.length] = text.length;

  out.chars += text.length;
  if (JSON.stringify(bounds) === JSON.stringify(truthBounds)) {
    out.exact++;
  } else {
    out.wrong++;
    if (out.examples.length < 3) {
      out.examples.push({got: bounds, want: truthBounds, head: text.slice(0, 70)});
    }
  }
}
done(out);
"""


def main():
    with fixture_server() as server:
      proc, m = launch_firefox(SRC)
      try:
        m.cmd("WebDriver:Navigate", {"url": server.base + ARTICLE})
        time.sleep(4)
        r = m.cmd("WebDriver:ExecuteAsyncScript",
                  {"script": ORACLE, "args": [], "scriptTimeout": 60000})
        d = r.get("value", r)
        print(f"wrapped text nodes : {d['nodes']}")
        print(f"exact boundaries   : {d['exact']}")
        print(f"mismatched         : {d['wrong']}")
        print(f"characters covered : {d['chars']}")
        for e in d.get("examples", [])[:3]:
            print("  MISMATCH " + json.dumps(e)[:300])
        return 0 if d["wrong"] == 0 else 1
      finally:
        stop_firefox(proc)


if __name__ == "__main__":
    sys.exit(main())
