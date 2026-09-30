#!/usr/bin/env python3
"""
Check that the map keeps up with a page that changes as you scroll.

The clone is a snapshot, so freshness is an event-driven policy rather than a
live mirror: a mutation raises a flag, scroll settle is when the work happens,
and a page that recycles its content stops being fully rebuilt and gets band
patches instead. Four fixtures: growth (infinite scroll), recycling (a virtual
list), late content, and constant churn.

    python3 test/verify_freshness.py
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import (  # noqa: E402
    fixture_server, launch_firefox, stop_firefox, variant,
)

GROWING = "/growing.html"
RECYCLING = "/recycling.html"
LAZY = "/lazy.html"
CHURN = "/churn.html"

READ = r"""
const map = document.querySelector(".scrollpeak-map");
const f = document.querySelector(".scrollpeak-thumb__frame");
const d = f ? f.contentDocument : null;
const w = d ? d.querySelector(".scrollpeak-thumb__page") : null;
return {
  engine: map && map.dataset.engine ? JSON.parse(map.dataset.engine) : null,
  mode: map ? map.dataset.mode : null,
  docHeight: document.scrollingElement.scrollHeight,
  mapDocHeight: map ? Number(map.dataset.docHeight || 0) : 0,
  cloneText: w ? w.textContent : null,
  pageText: document.body.textContent,
  sperr: document.documentElement.dataset.sperr || null,
};
"""


def main():
    failures = []

    def check(name, cond, detail=""):
        print(f"  [{'PASS' if cond else 'FAIL'}] {name:48} {detail}")
        if not cond:
            failures.append(name)

    ext = variant({"mapMode": "clone"})

    with fixture_server() as server:
        proc, m = launch_firefox(ext)
        try:
            m.cmd("WebDriver:SetWindowRect", {"width": 1280, "height": 800})

            def go(path):
                m.cmd("WebDriver:Navigate", {"url": server.fixtures + path})
                time.sleep(3)

            def read():
                r = m.cmd("WebDriver:ExecuteScript", {"script": READ, "args": []})
                return r.get("value", r)

            def scroll(y):
                m.cmd("WebDriver:ExecuteScript",
                      {"script": f"window.scrollTo(0, {y}); return 1;", "args": []})

            print("a growing document remaps and rebuilds")
            go(GROWING)
            d0 = read()
            for i in range(4):
                m.cmd("WebDriver:ExecuteScript",
                      {"script": "window.scrollTo(0, document.scrollingElement.scrollHeight); return 1;",
                       "args": []})
                time.sleep(0.9)
            d1 = read()
            check("the page itself grew", d1["docHeight"] > d0["docHeight"],
                  f"{d0['docHeight']} -> {d1['docHeight']}")
            check("the map was rebuilt at least twice",
                  (d1.get("engine") or {}).get("rebuilds", 0) >= 2,
                  json.dumps(d1.get("engine")))
            check("the map's document height followed the growth",
                  abs(d1["mapDocHeight"] - d1["docHeight"]) <= 40,
                  f"map={d1['mapDocHeight']} page={d1['docHeight']}")
            check("no freshness error was recorded", not d1.get("sperr"),
                  str(d1.get("sperr")))

            print("\na recycling list stops being fully rebuilt")
            go(RECYCLING)
            for i in range(6):
                scroll((i + 1) * 1700)
                time.sleep(0.9)
            d = read()
            engine = d.get("engine") or {}
            check("the settle ran on each scroll",
                  engine.get("bands", 0) >= 4, json.dumps(engine))
            check("the page was recognised as recycling",
                  engine.get("bandOnly") is True, json.dumps(engine))
            check("and the map still covers the document",
                  d["mapDocHeight"] > 0, str(d["mapDocHeight"]))

            print("\nlate content reaches the clone")
            go(LAZY)
            time.sleep(2.5)
            d = read()
            check("the page filled its block",
                  "Late content has arrived" in (d.get("pageText") or ""))
            check("the clone of it did too",
                  "Late content has arrived" in (d.get("cloneText") or ""))
            check("no freshness error was recorded", not d.get("sperr"),
                  str(d.get("sperr")))

            print("\nconstant churn stays under the rebuild budget")
            go(CHURN)
            time.sleep(7)
            d = read()
            engine = d.get("engine") or {}
            # 250ms of mutations for ~7s, one rebuild per second at most.
            check("few full rebuilds in seven seconds",
                  engine.get("rebuilds", 99) <= 10, json.dumps(engine))
            check("the map is still the clone", d.get("mode") == "clone",
                  str(d.get("mode")))
            check("no freshness error was recorded", not d.get("sperr"),
                  str(d.get("sperr")))
        finally:
            stop_firefox(proc)

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("the map keeps up without chasing every mutation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
