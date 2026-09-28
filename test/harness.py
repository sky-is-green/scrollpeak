"""Shared helpers for the Marionette-driven tests.

Firefox's Marionette frames every message as ASCII "<byte-length>:<json>" --
the opening handshake included. Decoding that first packet as bare JSON
silently parses the length prefix as a number, which is a genuinely confusing
way to lose an afternoon.
"""
import functools
import http.server
import json
import os
import socket
import socketserver
import subprocess
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src")
FIXTURES = os.path.join(HERE, "fixtures")
ARTICLE = "/article.html"   # ~2200px, scrolls
SHORT = "/short.html"       # fits on one screen


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class QuietServer(socketserver.TCPServer):
    allow_reuse_address = True

    def handle_error(self, *args):
        pass


class fixture_server:
    """Serve the fixtures, so a test needs nothing running beforehand."""

    def __init__(self):
        handler = functools.partial(QuietHandler, directory=FIXTURES)
        self.httpd = QuietServer(("127.0.0.1", 0), handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def __enter__(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


class Marionette:
    def __init__(self, sock):
        self.sock, self.buf, self.n = sock, b"", 0
        self.hello = self._frame()

    def _raw(self):
        c = self.sock.recv(65536)
        if not c:
            raise RuntimeError("marionette closed")
        return c

    def _frame(self):
        while b":" not in self.buf:
            self.buf += self._raw()
        head, rest = self.buf.split(b":", 1)
        n = int(head)
        while len(rest) < n:
            rest += self._raw()
        self.buf = rest[n:]
        return json.loads(rest[:n])

    def cmd(self, name, params=None):
        self.n += 1
        p = json.dumps([0, self.n, name, params or {}]).encode()
        self.sock.sendall(str(len(p)).encode() + b":" + p)
        while True:
            m = self._frame()
            if isinstance(m, list) and m and m[0] == 1:
                if len(m) > 2 and m[2]:
                    raise RuntimeError(f"{name}: {m[2]}")
                return m[3] if len(m) > 3 else None


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def launch_firefox(extension=None, url="about:blank", extra_prefs=""):
    """Start a headless Firefox on a throwaway profile with Marionette on.

    Returns (process, marionette). The extension is installed once the session
    exists, so the profile does not have to know about it beforehand.
    """
    port = free_port()
    profile = tempfile.mkdtemp(prefix="scrollpeak-test-")
    with open(os.path.join(profile, "user.js"), "w") as f:
        f.write(
            f'user_pref("marionette.port", {port});\n'
            'user_pref("marionette.enabled", true);\n'
            'user_pref("extensions.autoDisableScopes", 0);\n'
            'user_pref("browser.shell.checkDefaultBrowser", false);\n'
            'user_pref("browser.aboutwelcome.enabled", false);\n'
            'user_pref("datareporting.policy.dataSubmissionEnabled", false);\n'
            'user_pref("toolkit.telemetry.enabled", false);\n'
            'user_pref("browser.safebrowsing.malware.enabled", false);\n'
            'user_pref("browser.safebrowsing.phishing.enabled", false);\n'
            'user_pref("network.captive-portal-service.enabled", false);\n'
            + extra_prefs
        )
    proc = subprocess.Popen(
        ["firefox", "--profile", profile, "--headless", "--marionette",
         "--no-remote", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        env=dict(os.environ, MOZ_HEADLESS="1"))

    sock = None
    for _ in range(60):
        if proc.poll() is not None:
            raise RuntimeError("Firefox exited during startup")
        try:
            sock = socket.create_connection(("127.0.0.1", port), timeout=3)
            break
        except OSError:
            time.sleep(1)
    if sock is None:
        proc.terminate()
        raise RuntimeError("could not reach Marionette")

    m = Marionette(sock)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    if extension:
        m.cmd("Addon:Install", {"path": extension, "temporary": True})
        time.sleep(2)
    return proc, m


def stop_firefox(proc):
    """Terminate Firefox and return whatever it wrote to stderr.

    Order matters: reading stderr before the process exits blocks forever,
    because the pipe stays open until every writer has gone.
    """
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
    if proc.stderr is None:
        return ""
    try:
        return proc.stderr.read().decode("utf-8", "replace")
    except Exception:
        return ""
