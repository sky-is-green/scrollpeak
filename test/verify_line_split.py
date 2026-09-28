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

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(HERE, "..", "src")
URL = "http://127.0.0.1:8765/article.html"
PORT = 2881

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


def main():
    profile = tempfile.mkdtemp(prefix="scrollpeak-split-")
    with open(os.path.join(profile, "user.js"), "w") as f:
        f.write(
            f'user_pref("marionette.port", {PORT});\n'
            'user_pref("marionette.enabled", true);\n'
            'user_pref("extensions.autoDisableScopes", 0);\n'
            'user_pref("browser.shell.checkDefaultBrowser", false);\n'
            'user_pref("datareporting.policy.dataSubmissionEnabled", false);\n'
        )
    proc = subprocess.Popen(
        ["firefox", "--profile", profile, "--headless", "--marionette",
         "--no-remote", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env=dict(os.environ, MOZ_HEADLESS="1"))
    try:
        sock = None
        for _ in range(60):
            try:
                sock = socket.create_connection(("127.0.0.1", PORT), timeout=3)
                break
            except OSError:
                time.sleep(1)
        m = Marionette(sock)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Addon:Install", {"path": EXT, "temporary": True})
        time.sleep(2)
        m.cmd("WebDriver:Navigate", {"url": URL})
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
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
