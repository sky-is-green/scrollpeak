#!/usr/bin/env python3
"""
Test that the settings actually change the rail.

Settings that do nothing are worse than settings that do not exist, so each
case here installs a copy of the extension with different defaults and checks
what a real page ends up with. Defaults live in one place -- DEFAULT_SETTINGS
in background.js -- which is what makes them safe to patch.

The options page itself is checked statically (test_options_wiring below and in
test_check_options.py) because WebDriver will not navigate to a
moz-extension:// URL and Firefox would not open one as a startup page.

    python3 -m http.server 8765 --directory test/fixtures &
    python3 test/test_settings.py
"""
import json
import os
import re
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import (  # noqa: E402
    ARTICLE, SHORT, SRC, fixture_server, launch_firefox, stop_firefox,
)

INSPECT = r"""
const done = arguments[arguments.length - 1];
const q = s => document.querySelector(s);
const rail = q(".vugluscr .scrollbar");
const map = q(".scrollpeak-map");
let width = null;
if (rail) width = Math.round(rail.getBoundingClientRect().width);
let mapW = null;
if (map) mapW = map.width;
done({
  rail: !!rail,
  mapWidth: mapW,
  railWidth: width,
  scrolls: document.scrollingElement.scrollHeight > window.innerHeight,
  padRight: getComputedStyle(document.body).paddingRight,
});
"""

# Hover the rail and report the preview's real size against the window, so a
# setting can be checked against what a person would see.
MAGNIFY = r"""
const done = arguments[arguments.length - 1];
const strip = document.querySelector(".vugluscr .minimap");
if (!strip) { done({err: "no rail"}); return; }
const sr = strip.getBoundingClientRect();
function move() {
  strip.dispatchEvent(new PointerEvent("pointermove", {
    clientX: sr.left + sr.width / 2, clientY: sr.top + sr.height * 0.5,
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }));
}
move();
setTimeout(() => {
  const pop = document.querySelector(".scrollpeak-magnifier");
  if (!pop) { done({err: "no preview"}); return; }
  const r = pop.getBoundingClientRect();
  done({
    open: pop.classList.contains("is-open"),
    width: Math.round(r.width), height: Math.round(r.height),
    innerW: window.innerWidth, innerH: window.innerHeight,
  });
}, 800);
"""


def variant(patch):
    """A copy of src/ with different defaults.

    Defaults live in one place -- DEFAULT_SETTINGS in background.js -- which is
    what makes them safe to patch for a test.
    """
    tmp = tempfile.mkdtemp(prefix="scrollpeak-variant-")
    dst = os.path.join(tmp, "ext")
    shutil.copytree(SRC, dst)
    path = os.path.join(dst, "background.js")
    text = open(path).read()
    for key, value in patch.items():
        text, n = re.subn(
            rf"(\n  {key}: )[^,\n]+,",
            lambda m: m.group(1) + json.dumps(value) + ",",
            text,
            count=1,
        )
        if n != 1:
            raise SystemExit(f"could not patch default for {key}")
    open(path, "w").write(text)
    return dst


def main():
  with fixture_server() as server:
      # ARTICLE/SHORT are paths under test/fixtures; the server also serves the repo.
      article = server.fixtures + ARTICLE
      short = server.fixtures + SHORT
      proc, m = launch_firefox()
      time.sleep(1)

      failures = []

      def check(name, cond, detail=""):
          print(f"  [{'PASS' if cond else 'FAIL'}] {name:44} {detail}")
          if not cond:
              failures.append(name)

      try:
          def install(patch):
              """Install a fresh variant. Temporary add-ons replace each other."""
              path = variant(patch) if patch else SRC
              m.cmd("Addon:Install", {"path": path, "temporary": True})
              time.sleep(2)

          def page(url):
              m.cmd("WebDriver:Navigate", {"url": url})
              time.sleep(3)
              r = m.cmd("WebDriver:ExecuteAsyncScript",
                        {"script": INSPECT, "args": [], "scriptTimeout": 20000})
              return r.get("value", r)

          def magnified(url):
              m.cmd("WebDriver:Navigate", {"url": url})
              time.sleep(3)
              r = m.cmd("WebDriver:ExecuteAsyncScript",
                        {"script": MAGNIFY, "args": [], "scriptTimeout": 20000})
              return r.get("value", r)

          print("Kate's defaults")
          install({})
          p = page(article)
          # The fixture has its own 1rem padding, so "layout untouched" cannot
          # mean 0px. It means the rail's reservation is gone. Remember what
          # the rail reserves so the no-rail cases can be compared to it.
          rail_pad = p["padRight"]
          check("always: rail on a scrolling page", p["rail"], f"w={p['railWidth']}")
          check("default map width is Kate's 60", p["mapWidth"] == 60,
                f"map={p['mapWidth']}px rail={p['railWidth']}px")
          check("defaults reserve room for the rail", rail_pad not in ("0px", ""),
                f"body padding-right={rail_pad}")

          def no_rail(patch, label):
              install(patch)
              got = page(article)
              check(f"{label}: no rail", not got["rail"])
              check(f"{label}: rail's padding reservation released",
                    got["padRight"] != rail_pad,
                    f"padding-right={got['padRight']} vs {rail_pad} with the rail")
              return got

          print("\nscrollbarMode = never")
          no_rail({"scrollbarMode": "never"}, "never")

          print("\nscrollbarMode = whenNeeded")
          install({"scrollbarMode": "whenNeeded"})
          check("whenNeeded: rail on a scrolling page", page(article)["rail"])
          check("whenNeeded: no rail on a page that fits", not page(short)["rail"])

          print("\nscrollbarMode = always")
          install({"scrollbarMode": "always"})
          check("always: rail even on a page that fits", page(short)["rail"])

          print("\nminimapWidth")
          install({"minimapWidth": 24})
          p = page(article)
          check("narrow map is honoured", p["mapWidth"] == 24, f"map={p['mapWidth']}px")
          install({"minimapWidth": 140})
          p = page(article)
          check("wide map is honoured", p["mapWidth"] == 140, f"map={p['mapWidth']}px")

          print("\nmagnifier size")
          install({"magnifierWidth": 80, "magnifierHeight": 40})
          d = magnified(article)
          check("the preview is the configured fraction of the window",
                d.get("open") and
                abs(d["width"] - d["innerW"] * 0.80) <= 2 and
                abs(d["height"] - d["innerH"] * 0.40) <= 2,
                f"{d.get('width')}x{d.get('height')} of "
                f"{d.get('innerW')}x{d.get('innerH')}")
          # The options sliders cannot leave the range, but a hand-edited or
          # older profile can, and the magnification should not.
          install({"magnifierWidth": 1000, "magnifierHeight": 1})
          d = magnified(article)
          check("out-of-range sizes are clamped",
                d.get("open") and
                abs(d["width"] - d["innerW"]) <= 2 and
                abs(d["height"] - d["innerH"] * 0.05) <= 2,
                f"{d.get('width')}x{d.get('height')} of "
                f"{d.get('innerW')}x{d.get('innerH')}")

          print("\nglobal switch")
          install({"enabled": False})
          check("enabled=false: no rail anywhere", not page(article)["rail"])
          install({"enabled": True})
          check("enabled=true: rail returns", page(article)["rail"])

          print("\nsite exclusion")
          no_rail({"disabledSites": ["127.0.0.1"]}, "excluded host")

          print("\noptions page wiring (static)")
          html = open(os.path.join(SRC, "options", "options.html")).read()
          js = open(os.path.join(SRC, "options", "options.js")).read()
          bg = open(os.path.join(SRC, "background.js")).read()
          defaults = set(re.findall(r"^\s{2}(\w+):", bg[bg.index("DEFAULT_SETTINGS"):bg.index("async function getSettings")], re.M))
          controls = set(re.findall(r'id="([\w-]+)"', html))
          written = set(re.findall(r'"(\w+)":', js)) | set(re.findall(r"persist\(\{ (\w+)", js))
          read_back = set(re.findall(r"settings\.(\w+)", js))
          unknown = (read_back | written) - defaults - {"patch", "settings"}
          check("every setting the options page touches exists", not unknown,
                f"unknown={sorted(unknown)}" if unknown else f"{len(defaults)} defaults")
          # disabledSites is list-managed: options.js renders it into
          # #site-list rather than a single control, so check the container.
          LIST_MANAGED = {"disabledSites": "site-list"}
          missing_ids = [
              c for c in read_back
              if c not in controls and c != "scrollbarMode"
              and LIST_MANAGED.get(c) not in controls
          ]
          check("every setting the options page reads has a control",
                not missing_ids, f"missing={missing_ids}" if missing_ids else "")
          modes = re.findall(r'name="scrollbarMode" value="(\w+)"', html)
          check("three modes, matching Kate's ScrollbarMode",
                modes == ["always", "whenNeeded", "never"], ",".join(modes))
      finally:
          stop_firefox(proc)

      print()
      if failures:
          print("FAILED: " + ", ".join(failures))
          return 1
      print("all settings behave")
      return 0


if __name__ == "__main__":
    sys.exit(main())
