#!/usr/bin/env python3
"""
Launch Firefox with ScrollPeek installed, for testing.

Why this exists
---------------
This is a Release build of Firefox, and Release refuses to install unsigned
extensions. `xpinstall.signatures.required=false` is silently ignored outside
Nightly, Developer Edition and ESR. That leaves exactly one option that needs
no Mozilla account: a *temporary* add-on, which Firefox accepts unsigned.

There are two ways to do that. The manual one is about:debugging -> This
Firefox -> Load Temporary Add-on, which is fine but is four clicks every time
you change the code. This script does it for you over Marionette, and leaves
the browser running so you can go and use it.

    python3 scripts/dev-launch.py                  # opens a blank tab
    python3 scripts/dev-launch.py <url>           # opens that page
    python3 scripts/dev-launch.py --keep-open     # do not auto-close

It uses a dedicated profile under test-profile/ so your real Firefox session,
bookmarks and extensions are untouched. Your existing Firefox keeps running;
this is a second, separate instance.

Temporary add-ons do not survive a browser restart. Re-run this script after
you restart Firefox.

To install it permanently instead, submit to addons.mozilla.org: a listed
version goes through review, an unlisted one is signed for personal use.
"""
import json
import os
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXT = os.path.join(ROOT, "src")
PROFILE = os.path.join(ROOT, "test-profile")
MARIONETTE_PORT = 2871

PREFS = """
// Marionette, so we can install the add-on over the wire.
user_pref("marionette.port", {port});
user_pref("marionette.enabled", true);

// Do not let a fresh profile get in the way of testing an extension.
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("app.update.enabled", false);
user_pref("extensions.update.enabled", false);

// ScrollPeek replaces the scrollbar, so give the page room and keep the
// native bar from being re-enabled by anything.
user_pref("layout.css.scrollbar-width.content.enabled", true);
"""


class Marionette:
    def __init__(self, sock):
        self.sock, self.buf, self.n = sock, b"", 0
        self.hello = self._frame()

    def _raw(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise RuntimeError("marionette closed the connection")
        return chunk

    def _frame(self):
        while b":" not in self.buf:
            self.buf += self._raw()
        head, rest = self.buf.split(b":", 1)
        length = int(head)
        while len(rest) < length:
            rest += self._raw()
        self.buf = rest[length:]
        return json.loads(rest[:length])

    def cmd(self, name, params=None):
        self.n += 1
        payload = json.dumps([0, self.n, name, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._frame()
            if isinstance(msg, list) and msg and msg[0] == 1:
                if len(msg) > 2 and msg[2]:
                    raise RuntimeError(f"{name} failed: {msg[2]}")
                return msg[3] if len(msg) > 3 else None


def find_firefox():
    for path in ("firefox", "firefox-esr", "firefox-developer-edition"):
        found = subprocess.run(["which", path], capture_output=True, text=True)
        if found.returncode == 0:
            return found.stdout.strip()
    for path in ("/usr/lib/firefox/firefox", "/usr/bin/firefox",
                 "/Applications/Firefox.app/Contents/MacOS/firefox"):
        if os.path.exists(path):
            return path
    sys.exit("Could not find Firefox on PATH.")


def main():
    url = "about:blank"
    for arg in sys.argv[1:]:
        if not arg.startswith("-"):
            url = arg
    keep_open = "--keep-open" in sys.argv

    if not os.path.isfile(os.path.join(EXT, "manifest.json")):
        sys.exit(f"No extension at {EXT}")

    os.makedirs(PROFILE, exist_ok=True)
    with open(os.path.join(PROFILE, "user.js"), "w") as f:
        f.write(PREFS.format(port=MARIONETTE_PORT))

    binary = find_firefox()
    proc = subprocess.Popen(
        [binary, "--profile", PROFILE, "--marionette", "--no-remote", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    sock = None
    for _ in range(60):
        if proc.poll() is not None:
            sys.exit("Firefox exited before we could install the add-on.")
        try:
            sock = socket.create_connection(("127.0.0.1", MARIONETTE_PORT), timeout=3)
            break
        except OSError:
            time.sleep(1)
    if sock is None:
        proc.terminate()
        sys.exit("Could not reach Firefox's Marionette port.")

    m = Marionette(sock)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    addon = m.cmd("Addon:Install", {"path": EXT, "temporary": True})
    print(f"Installed {addon}")

    if url != "about:blank":
        m.cmd("WebDriver:Navigate", {"url": url})

    print()
    print("ScrollPeek is loaded and Firefox is open. Go and use it.")
    print()
    print("  Try it on:  a long article, an MDN reference page, a Wikipedia")
    print("              article, a docs site. The rail replaces the")
    print("              scrollbar, so the page gets ~102px wider on the right.")
    print()
    print("  Hover the strip  -> preview of the text under the cursor")
    print("  Click the strip  -> jump there")
    print("  Drag the strip   -> scroll continuously")
    print("  Arrow keys       -> work as normal")
    print()
    print("  Toggle per site: click the ScrollPeek toolbar icon.")
    print("  Settings:        right-click the icon -> Options, or the")
    print("                   'All settings' link in the popup.")
    print()
    print("  Seeing nothing? The page must be at least 1.5 screens tall.")
    print("  (Option: uncheck 'Hide the rail when the page is barely")
    print("  scrollable' to see it on everything.)")
    print()
    print("  Close this window when you are done. If you restart Firefox you")
    print("  must run this script again -- temporary add-ons do not persist.")
    print()

    if keep_open:
        proc.wait()
    else:
        try:
            proc.wait()
        except KeyboardInterrupt:
            proc.terminate()


if __name__ == "__main__":
    main()
