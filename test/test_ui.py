#!/usr/bin/env python3
"""
Test the popup and options page.

How, and what it does not cover
-------------------------------
Firefox will not open a moz-extension:// URL at startup, and WebDriver refuses
to navigate to one, so the real pages cannot be driven directly under
automation. This works around that by serving the *actual* popup.html,
options.html, popup.css, options.css, popup.js and options.js over http and
loading them with a stubbed `browser` API injected ahead of the page's own
scripts.

So the markup, the CSS, the control wiring, the event handlers and the
settings each control are all genuinely exercised. What is stubbed is the
WebExtension API surface itself: the real `browser.runtime.sendMessage`,
`browser.tabs`, and `browser.storage` are replaced by an in-memory stand-in.
The contract between the pages and those APIs is checked separately, in
test_settings.py, which verifies that every setting key the pages write
actually changes browser behaviour.

This test exists because the popup had a live bug -- a reference to a control
that no longer existed -- that nothing was checking, and it broke the popup on
every open.

    python3 test/test_ui.py
"""
import json
import os
import re
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import SRC, fixture_server, launch_firefox  # noqa: E402

REPO = os.path.dirname(SRC)

STUB = """
/* Stand-in for the WebExtension APIs. Records what the page asked for so the
   test can assert on it, and keeps settings in memory. */
(function () {
  const defaults = %(defaults)s;
  let settings = Object.assign({}, defaults);
  const calls = { openOptionsPage: 0, tabsCreated: [], writes: [] };
  window.__stub = { calls, get: () => Object.assign({}, settings) };

  window.browser = {
    runtime: {
      sendMessage(msg) {
        if (msg.type === "scrollpeak:getSettings") {
          return Promise.resolve(Object.assign({}, settings));
        }
        if (msg.type === "scrollpeak:setSetting") {
          settings = Object.assign({}, settings, msg.patch);
          calls.writes.push(msg.patch);
          return Promise.resolve(Object.assign({}, settings));
        }
        return Promise.resolve(undefined);
      },
      openOptionsPage() { calls.openOptionsPage++; return Promise.resolve(); },
    },
    tabs: {
      query() {
        return Promise.resolve([{ id: 1, url: %(url)s }]);
      },
      create(info) { calls.tabsCreated.push(info.url); return Promise.resolve(); },
    },
  };

  window.__errors = [];
  window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
  window.addEventListener("unhandledrejection",
    (e) => window.__errors.push("unhandledrejection: " + String(e.reason)));
})();
"""


def read_defaults():
    bg = open(os.path.join(SRC, "background.js")).read()
    block = bg[bg.index("const DEFAULT_SETTINGS = {"):]
    block = block[block.index("{") + 1:block.index("};")]
    out = {}
    for key, value in re.findall(r"^\s{2}(\w+): (.+?),\s*$", block, re.M):
        try:
            out[key] = json.loads(value)
        except json.JSONDecodeError:
            out[key] = value.strip('"')
    return out


def patched_copy(html_rel, out_name, stub_js):
    """A copy of the real page with the stub injected before its own script.

    Built from the real file on every run, so it cannot drift out of sync with
    it. It lives beside the original so its relative URLs (../icons, ../options)
    still resolve.
    """
    src_path = os.path.join(SRC, html_rel)
    html = open(src_path).read()
    tag = '<script src="browser-stub.js"></script>\n    '
    html, n = re.subn(r"(\s*)<script src=\"(popup|options)\.js\">", r"\1" + tag + r'<script src="\2.js">', html, count=1)
    if n != 1:
        raise SystemExit(f"could not find the page script in {html_rel}")
    out_path = os.path.join(os.path.dirname(src_path), out_name)
    open(out_path, "w").write(html)
    stub_path = os.path.join(os.path.dirname(src_path), "browser-stub.js")
    open(stub_path, "w").write(stub_js)
    return out_path, stub_path


READ = r"""
const cb = arguments[arguments.length - 1];
const $ = id => document.getElementById(id);
cb(JSON.stringify({
  href: location.pathname,
  errors: window.__errors || [],
  mode: (document.querySelector('input[name="scrollbarMode"]:checked') || {}).value,
  modeCount: document.querySelectorAll('input[name="scrollbarMode"]').length,
  enabled: $("enabled") ? $("enabled").checked : null,
  showMagnifier: $("showMagnifier") ? $("showMagnifier").checked : null,
  minimapWidth: $("minimapWidth") ? $("minimapWidth").value : null,
  widthLabel: $("minimapWidth-out") ? $("minimapWidth-out").textContent : null,
  sites: [...document.querySelectorAll("#site-list li span")].map(s => s.textContent),
  hasAddForm: !!$("addsite"),
  siteError: $("site-error") ? $("site-error").textContent : null,
  siteErrorShown: $("site-error") ? !$("site-error").hidden : null,
  hasLinks: document.querySelectorAll("[data-url]").length,
  bodyWidth: getComputedStyle(document.body).width,
  writes: window.__stub.calls.writes,
  openOptionsPage: window.__stub.calls.openOptionsPage,
  tabsCreated: window.__stub.calls.tabsCreated,
}));
"""

ACT = r"""
const cb = arguments[arguments.length - 1];
const [kind, arg] = arguments;
const $ = id => document.getElementById(id);
setTimeout(() => {
  if (kind === "check") {
    const el = $(arg); el.checked = !el.checked;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (kind === "radio") {
    const el = document.querySelector(`input[name="scrollbarMode"][value="${arg}"]`);
    el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (kind === "range") {
    const el = $("minimapWidth"); el.value = String(arg);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (kind === "addsite") {
    $("site-input").value = arg;
    $("addsite").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  } else if (kind === "click") {
    document.querySelector(arg).click();
  }
  setTimeout(() => cb("ok"), 250);
}, 80);
"""


def main():
    defaults = read_defaults()
    page_url = "https://news.example.com/story"
    created = []
    failures = []

    def check(name, cond, detail=""):
        print(f"  [{'PASS' if cond else 'FAIL'}] {name:46} {detail}")
        if not cond:
            failures.append(name)

    stub = STUB % {"defaults": json.dumps(defaults), "url": json.dumps(page_url)}

    with fixture_server() as server:
        # Serve the repository, so src/popup/popup.html is reachable as-is.
        proc, m = launch_firefox()
        try:
            m.cmd("WebDriver:Navigate", {"url": f"{server.base}/src/popup/popup.html"})
            time.sleep(1)

            popup_html, stub_js = patched_copy(
                "popup/popup.html", ".ui-popup.html", stub)
            created += [popup_html, stub_js]
            m.cmd("WebDriver:Navigate",
                  {"url": f"{server.base}/src/popup/.ui-popup.html"})
            time.sleep(1)
            r = m.cmd("WebDriver:ExecuteAsyncScript",
                      {"script": READ, "args": [], "scriptTimeout": 20000})
            d = json.loads(r.get("value", r))

            print("popup")
            check("loads with no uncaught errors", not d["errors"], str(d["errors"]))
            check("two scrollbar modes", d["modeCount"] == 2,
                  f"n={d['modeCount']}")
            check("defaults are the shipped ones", d["mode"] == "whenNeeded"
                  and d["minimapWidth"] == str(defaults["minimapWidth"])
                  and d["widthLabel"] == f'{defaults["minimapWidth"]}px',
                  f"mode={d['mode']} width={d['minimapWidth']} ({d['widthLabel']})")
            check("preview on by default", d["showMagnifier"] is True,
                  f"preview={d['showMagnifier']}")
            # MDN, "Popups": set the popup width on <body>; Firefox computes the
            # popup's preferred width from the body and ignores :root.
            check("popup width set on body, not root",
                  d["bodyWidth"] not in ("auto", "0px"), d["bodyWidth"])
            check("source links present", d["hasLinks"] >= 3, f"n={d['hasLinks']}")

            print("\npopup controls write through")
            m.cmd("WebDriver:ExecuteAsyncScript",
                  {"script": ACT, "args": ["radio", "always"], "scriptTimeout": 20000})
            m.cmd("WebDriver:ExecuteAsyncScript",
                  {"script": ACT, "args": ["range", 120], "scriptTimeout": 20000})
            r = m.cmd("WebDriver:ExecuteAsyncScript",
                      {"script": READ, "args": [], "scriptTimeout": 20000})
            d = json.loads(r.get("value", r))
            written = {k: v for patch in d["writes"] for k, v in patch.items()}
            check("mode and width both written",
                  written.get("scrollbarMode") == "always"
                  and written.get("minimapWidth") == 120,
                  f"writes={d['writes'][-2:]}")
            check("no errors after interaction", not d["errors"], str(d["errors"]))

            print("\npopup actions")
            m.cmd("WebDriver:ExecuteAsyncScript",
                  {"script": ACT, "args": ["click", "#open-options"], "scriptTimeout": 20000})
            r = m.cmd("WebDriver:ExecuteAsyncScript",
                      {"script": READ, "args": [], "scriptTimeout": 20000})
            d = json.loads(r.get("value", r))
            check("'All settings' calls openOptionsPage", d["openOptionsPage"] == 1,
                  f"n={d['openOptionsPage']}")
            m.cmd("WebDriver:ExecuteAsyncScript",
                  {"script": ACT, "args": ["click", '[data-url]'], "scriptTimeout": 20000})
            r = m.cmd("WebDriver:ExecuteAsyncScript",
                      {"script": READ, "args": [], "scriptTimeout": 20000})
            d = json.loads(r.get("value", r))
            check("a link opens a tab", len(d["tabsCreated"]) == 1,
                  str(d["tabsCreated"]))

            print("\noptions page")
            opts_html, stub_js2 = patched_copy(
                "options/options.html", ".ui-options.html", stub)
            created += [opts_html, stub_js2]
            m.cmd("WebDriver:Navigate",
                  {"url": f"{server.base}/src/options/.ui-options.html"})
            time.sleep(1)
            r = m.cmd("WebDriver:ExecuteAsyncScript",
                      {"script": READ, "args": [], "scriptTimeout": 20000})
            d = json.loads(r.get("value", r))
            check("loads with no uncaught errors", not d["errors"], str(d["errors"]))
            check("site add-form present", d["hasAddForm"])
            check("links present", d["hasLinks"] >= 4, f"n={d['hasLinks']}")

            # The point of the settings page: a real ScrollPeak on it, so a
            # change can be seen landing without leaving. Checked by moving a
            # control and looking for the bar to move with it.
            print("\nlive ScrollPeak on the settings page")
            r = m.cmd("WebDriver:ExecuteScript", {"script": r"""
                const rail = document.querySelector(".vugluscr .minimap");
                return {mounted: !!rail,
                        width: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
                        hasMap: !!document.querySelector(".scrollpeak-map")};
            """, "args": []})
            live = r.get("value", r)
            check("a real rail is mounted here", live["mounted"], str(live))
            check("and it has a minimap, not just a track", live["hasMap"])
            check("it is using the default width", live["width"] == 70,
                  f"{live['width']}px")

            m.cmd("WebDriver:ExecuteAsyncScript", {"script": r"""
                const done = arguments[arguments.length - 1];
                const el = document.getElementById("minimapWidth");
                el.value = "120";
                el.dispatchEvent(new Event("change", {bubbles: true}));
                setTimeout(done, 300);
            """, "args": [], "scriptTimeout": 20000})
            r = m.cmd("WebDriver:ExecuteScript", {"script": r"""
                const rail = document.querySelector(".vugluscr .minimap");
                return rail ? Math.round(rail.getBoundingClientRect().width) : 0;
            """, "args": []})
            moved = r.get("value", r)
            check("the bar moves when the setting does", moved == 120,
                  f"{live['width']}px -> {moved}px")

            m.cmd("WebDriver:ExecuteAsyncScript",
                  {"script": ACT,
                   "args": ["addsite", "https://Example.COM/some/path?x=1"],
                   "scriptTimeout": 20000})
            r = m.cmd("WebDriver:ExecuteAsyncScript",
                      {"script": READ, "args": [], "scriptTimeout": 20000})
            d = json.loads(r.get("value", r))
            check("pasted URL normalised to a bare hostname",
                  d["sites"] == ["example.com"], str(d["sites"]))

            m.cmd("WebDriver:ExecuteAsyncScript",
                  {"script": ACT, "args": ["addsite", "example.com"], "scriptTimeout": 20000})
            r = m.cmd("WebDriver:ExecuteAsyncScript",
                      {"script": READ, "args": [], "scriptTimeout": 20000})
            d = json.loads(r.get("value", r))
            check("duplicate rejected, not added twice", d["sites"] == ["example.com"],
                  str(d["sites"]))
            check("rejection is explained to the user", bool(d["siteErrorShown"]),
                  str(d["siteError"]))
        finally:
            import harness
            harness.stop_firefox(proc)
            for path in created:
                try:
                    os.remove(path)
                except OSError:
                    pass

    print()
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("popup and options page both work")
    return 0


if __name__ == "__main__":
    sys.exit(main())
