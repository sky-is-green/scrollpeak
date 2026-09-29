#!/usr/bin/env python3
"""
Capture the listing images for addons.mozilla.org.

AMO wants 1-5 screenshots, 1280x800, PNG or JPEG. These are taken from a
headless Firefox with the extension loaded as a temporary add-on, over the
article fixture, so they show the real thing rather than a mock-up: the rail
with the map, and the hover preview open on a section.

    python3 scripts/amo-screenshots.py

Writes assets/amo/*.png and copies the 128px icon there too. The browser
chrome (address bar, toolbar) is not in frame -- headless has none. If a
listing image wants the browser around it, take that one by hand from
`python3 scripts/dev-launch.py`.

The output is a screenshot, so it drifts as the UI changes; re-run this script
rather than editing images over an old one.
"""
import base64
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "test"))
from harness import SRC, fixture_server, launch_firefox, stop_firefox  # noqa: E402

OUT = os.path.join(ROOT, "assets", "amo")
WIDTH, HEIGHT = 1280, 800

# Which document offset each shot's preview should be centred on, as a
# fraction of the page. The strip maps its own height onto the document, so
# hovering at the same fraction of the strip shows that region. The preview is
# most legible in a picture when it is showing *other* content than the page
# behind it -- a preview of what is off-screen is the point of the feature.
SHOTS = [
    ("01-the-map.png", 0.0, None),       # the whole page in the strip
    ("02-the-preview.png", 0.0, 0.62),   # page at the top, preview of what is below
    ("03-lower-down.png", 0.55, 0.18),   # page scrolled, preview of what is above
]

MOVE = r"""
const cb = arguments[arguments.length - 1];
const frac = arguments[0];
const strip = document.querySelector(".vugluscr .minimap");
if (!strip) { cb({err: "no rail"}); return; }
const r = strip.getBoundingClientRect();
strip.dispatchEvent(new PointerEvent("pointermove", {
  clientX: r.left + r.width / 2,
  clientY: r.top + (r.height - 40) * frac + 20,
  bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
}));
cb({x: r.left + r.width / 2, y: r.top + (r.height - 40) * frac + 20});
"""


def screenshot(m, path):
    r = m.cmd("WebDriver:TakeScreenshot", {"hash": False, "full": False})
    data = r.get("value", r)
    if isinstance(data, dict):
        data = data.get("value")
    with open(path, "wb") as f:
        f.write(base64.b64decode(data))


def fit_window(m):
    """AMO wants exactly 1280x800, and that is the *viewport*, not the window.

    Headless Firefox still quotes a window with some notional chrome in it, so
    setting the window to 1280x800 yields a 1280x714 screenshot. Measure what
    the page actually gets and correct the window by the difference.
    """
    window_w, window_h = WIDTH, HEIGHT
    for _ in range(4):
        m.cmd("WebDriver:SetWindowRect", {"width": window_w, "height": window_h})
        time.sleep(0.3)
        size = m.cmd("WebDriver:ExecuteScript", {
            "script": "return [window.innerWidth, window.innerHeight];", "args": [],
        })
        w, h = size.get("value", size)
        if (w, h) == (WIDTH, HEIGHT):
            return
        # Grow the window by the shortfall and try again. The window is not
        # reset in between, or the correction would be undone every pass.
        window_w += WIDTH - w
        window_h += HEIGHT - h
    raise SystemExit(f"could not get a {WIDTH}x{HEIGHT} viewport; "
                     f"last measured {w}x{h}")


def main():
    os.makedirs(OUT, exist_ok=True)
    # Headless Firefox's window cannot grow past its virtual screen. The
    # default screen is the size of the window we want, which leaves no room
    # for the notional chrome between the two. Give it a taller screen.
    os.environ.setdefault("MOZ_HEADLESS_WIDTH", str(WIDTH))
    os.environ.setdefault("MOZ_HEADLESS_HEIGHT", str(HEIGHT + 200))

    with fixture_server() as server:
        proc, m = launch_firefox()
        try:
            m.cmd("Addon:Install", {"path": SRC, "temporary": True})
            time.sleep(2)
            fit_window(m)
            m.cmd("WebDriver:Navigate", {"url": server.fixtures + "/article.html"})
            time.sleep(3)

            for name, scroll_frac, hover_frac in SHOTS:
                m.cmd("WebDriver:ExecuteScript", {
                    "script": "window.scrollTo(0, (document.scrollingElement.scrollHeight"
                              " - window.innerHeight) * arguments[0]);",
                    "args": [scroll_frac],
                })
                time.sleep(0.4)
                if hover_frac is not None:
                    # Move the pointer onto the strip. A synthetic event is
                    # enough here -- the preview is already open in the other
                    # shots, so this is about the picture, not the timing.
                    m.cmd("WebDriver:ExecuteAsyncScript", {
                        "script": MOVE, "args": [hover_frac], "scriptTimeout": 5000,
                    })
                    # Past Kate's 250ms first-appearance delay.
                    time.sleep(0.8)
                path = os.path.join(OUT, name)
                screenshot(m, path)
                print(f"wrote {path}")

            shutil.copyfile(os.path.join(SRC, "icons", "scrollpeak-128.png"),
                            os.path.join(OUT, "icon-128.png"))
            print(f"wrote {os.path.join(OUT, 'icon-128.png')}")
        finally:
            stop_firefox(proc)

    return 0


if __name__ == "__main__":
    sys.exit(main())
