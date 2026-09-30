// ScrollPeak — the page clone, shared by the rail thumb and the hover preview.
//
// The clone is the page's own content, laid out by the browser, in a
// sandboxed same-origin iframe. It is the only universal representation of a
// page this extension has: whatever the site is, the browser has already
// rendered it, so nothing here tries to interpret it. The rail scales it into
// the strip; the preview translates and scales it under the pointer. Both grow
// from one snapshot, so a page is walked once per revision no matter how many
// views are mounted.
//
// Why a frame and not an insertion into this document: a clone put in the page
// is live. Web components upgrade on connection, their connectedCallback runs,
// and a page's own components re-render themselves from state the clone does
// not have. On YouTube's watch page that wiped 94% of the clone (4,650 nodes
// to 303) and left the preview blank. A frame has an empty custom element
// registry and runs no page scripts, so cloned components stay inert.
//
// The frame's own document is written only after its initial navigation has
// loaded: on Firefox 146 a pending about:blank navigation replaces early
// writes. See createInstance().fill().

(function () {
  // Kate: m_textPreview->setScaleFactor(0.75). The preview's scale, and the
  // number both the preview and the rail derive their layout width from.
  const SCALE = 0.75;

  // The popup's border and padding, both sides: 1px of each in content.css,
  // with box-sizing: border-box. The clone's viewport width is the stage's
  // own width over SCALE, and the stage is the popup's content box, so the
  // chrome has to come off before the division.
  const POPUP_CHROME = 4;

  // Viewport width the clone is laid out at, from the preview-size setting.
  // The rail and the preview must agree on it, or the two views would show
  // different layouts and the fixed-element indices below would not transfer.
  function previewWidth(settings) {
    const percent = clamp(
      Number(settings?.magnifierWidth) || 30, 20, 90);
    const popupW = Math.round(window.innerWidth * percent / 100);
    return Math.max(1, Math.round((popupW - POPUP_CHROME) / SCALE));
  }

  /**
   * Read the live page once, into a snapshot any number of frames can mount.
   *
   * Returns null when the page cannot be cloned at all (a body-less document,
   * or a tree cloneNode refuses); callers fall back to the raster map.
   */
  function snapshotPage() {
    let fragment;
    try {
      fragment = document.body.cloneNode(true);
    } catch {
      return null;
    }

    // Our own UI is not part of the page. Removed before the styles are read,
    // so nothing below has to know about it again.
    for (const el of fragment.querySelectorAll(
      ".vugluscr, .scrollpeak-magnifier, .scrollpeak-thumb, .scrollpeak-map",
    )) {
      el.remove();
    }

    // And neither is the room the rail reserves. vugluscr sets an inline
    // `padding-right` on the page's body; left in the clone, the map is a
    // rail's width narrower than the page really is, and at preview widths
    // that can even take a different breakpoint than the same page rendered
    // clean. Removing the inline value restores whatever the page's CSS says.
    try {
      fragment.style.removeProperty("padding-right");
    } catch {
      // A body-less fragment; nothing to strip.
    }

    return {
      fragment,
      styles: readStyles(),
      // The live elements whose runtime state cloneNode does not carry. Kept
      // as live references, and paired by tag order at each mount, because
      // neither this snapshot nor the live page contains any of these tags
      // inside our own UI.
      state: Array.from(
        document.body.querySelectorAll("canvas, input, textarea, select")),
      nodes: fragment.querySelectorAll("*").length,
    };
  }

  /**
   * The page's cascade as style text, in the order the page declares it.
   *
   * A frame does not inherit stylesheets, so without this the clone is
   * unstyled -- and grey boxes where icons were, because `currentColor`
   * resolves against whatever cascade it lands in. Rules are read through the
   * CSSOM so they are present synchronously; a cross-origin sheet cannot be
   * read, so its <link> is re-linked and allowed to load.
   */
  function readStyles() {
    const out = [];
    for (const sheet of document.styleSheets) {
      let text = null;
      try {
        text = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
      } catch {
        // Cross-origin: unreadable, and handled by href below.
      }
      if (text) out.push({ text });
      else if (sheet.href) out.push({ href: sheet.href });
    }
    return out;
  }

  /**
   * A mountable frame for one snapshot.
   *
   * The frame is appended to `container` immediately, but its document is not
   * written until the initial load has fired. fill() returns
   * `{ ok: false, reason: "loading" }` before then; `onReady` is called once
   * the frame is writable, and the consumer fills then.
   */
  function createInstance(container, opts = {}) {
    const frame = document.createElement("iframe");
    // allow-same-origin so the parent can reach the clone at all; no
    // allow-scripts, so nothing in the frame can run. The page's own scripts
    // are not parser-inserted into it and cannot run either way.
    frame.setAttribute("sandbox", "allow-same-origin");
    if (opts.frameClass) frame.className = opts.frameClass;
    frame.setAttribute("aria-hidden", "true");
    const pageClass = opts.pageClass || "";

    let doc = null;
    let win = null;
    let loaded = false;
    let disposed = false;
    let wrap = null;
    let cloneHeight = 1;
    let frameDoc = null;
    let frameWin = null;

    function onLoad() {
      if (disposed) return;
      doc = frame.contentDocument;
      win = frame.contentWindow;
      // A second load means the frame navigated underneath us, which replaces
      // the document and the clone with it. The consumer's fill() rebuilds it.
      const reconnected = loaded;
      loaded = true;
      if (reconnected) wrap = null;
      if (opts.onReady) opts.onReady();
    }
    frame.addEventListener("load", onLoad);
    container.appendChild(frame);
    // The about:blank document exists synchronously, but writes made now can
    // be discarded by the pending navigation; the load event above sets loaded.
    doc = frame.contentDocument;
    win = frame.contentWindow;

    /**
     * Write a snapshot into the frame.
     *
     * Synchronous once the frame has loaded. Returns `{ ok, fixedIndices,
     * cloneHeight }`, or `{ ok: false, reason }`.
     */
    function fill(snapshot, options = {}) {
      if (!snapshot) return { ok: false, reason: "no-snapshot" };
      if (!loaded || !doc || !win) return { ok: false, reason: "loading" };

      const width = Math.max(1, Math.round(options.width || 1));
      const t0 = performance.now();

      frame.style.width = `${width}px`;
      // The frame's viewport width is the clone's, so media queries, `vw` and
      // percentage layouts resolve the way they would in a window this size.
      // Its height stays the page's viewport, so `vh` units and full-height
      // sections keep the shape they have on the page.
      frame.style.height = `${window.innerHeight}px`;

      // Rebuild the frame's document: the page's <html> attributes, its
      // stylesheets, then the clone.
      for (const attr of [...doc.documentElement.attributes]) {
        doc.documentElement.removeAttribute(attr.name);
      }
      for (const attr of document.documentElement.attributes) {
        try {
          doc.documentElement.setAttribute(attr.name, attr.value);
        } catch {
          // An attribute name invalid in another namespace; never in HTML.
        }
      }
      // vugluscr's own class is our chrome, and so are the rail-state classes
      // the rail puts on <html>; the clone holds none of that.
      doc.documentElement.classList.remove(
        "vugluscr_active", "vugluscr_embedded",
        "scrollpeak-minimap-only", "scrollpeak-peek", "scrollpeak-visible");
      doc.documentElement.style.overflow = "hidden";

      const head = doc.head;
      head.replaceChildren();
      const base = doc.createElement("base");
      base.href = location.href;
      head.appendChild(base);
      for (const sheet of snapshot.styles) {
        if (sheet.text != null) {
          const style = doc.createElement("style");
          style.textContent = sheet.text;
          head.appendChild(style);
        } else if (sheet.href) {
          const link = doc.createElement("link");
          link.rel = "stylesheet";
          link.href = sheet.href;
          head.appendChild(link);
        }
      }
      // A snapshot is a picture, not a running page: CSS animations and
      // transitions would repaint forever for no information. Frozen after
      // the copied styles so it wins; !important for rules that marked their
      // animations important. Scripts never run here, so rAF and timers are
      // already dead, and pauseMedia() handles the video and audio elements.
      const freeze = doc.createElement("style");
      freeze.textContent =
        "*, *::before, *::after {" +
        " animation-play-state: paused !important;" +
        " transition: none !important; }";
      head.appendChild(freeze);

      doc.body.replaceChildren();
      doc.body.style.margin = "0";

      const imported = doc.importNode(snapshot.fragment, true);
      wrap = doc.createElement("div");
      if (pageClass) wrap.className = pageClass;
      // Inline, because content.css is not part of document.styleSheets --
      // content-script CSS is injected as an agent sheet -- so no rule here
      // reaches the frame. Without transform-origin the scale composes about
      // the wrap's centre instead of its top-left, which moves the clone by
      // (1 - SCALE) * half the document height: on Wikipedia about 8,900px.
      wrap.style.transformOrigin = "0 0";
      wrap.style.background = "#fff";
      // Absolute at the frame's origin. The frame's body is subject to the
      // page's own `body` rules -- the copied cascade styles it as if it were
      // the page's body -- so a static wrap is pushed by that padding: on
      // article.html, 16px right and 32px down.
      wrap.style.position = "absolute";
      wrap.style.left = "0";
      wrap.style.top = "0";
      // And a `body > div` rule can still reach the wrap; these keep the box
      // exactly the geometry the transform assumes.
      wrap.style.margin = "0";
      wrap.style.padding = "0";
      wrap.style.border = "0";
      wrap.style.display = "block";
      wrap.style.width = `${width}px`;
      wrap.appendChild(imported);
      doc.body.appendChild(wrap);

      copyState(snapshot.state, doc.body);
      pauseMedia(imported);

      // Ids stay. They used to be stripped, on the theory that a clone
      // duplicating the page's ids would make the page's own getElementById
      // start matching the preview -- which cannot happen through a frame.
      // It is not harmless: a site whose cascade keys off an id loses those
      // rules in the clone. On Wikipedia the Vector skin sets `grid-area` with
      // `#content > .vector-body`, and without it the article body was
      // auto-placed into the wrong grid cell: the clone's content moved
      // 9,000px down the page.

      // A viewport-pinned overlay has no document position: it is not anywhere
      // in the document, it is wherever the viewport is. Left in, a cookie
      // banner or a sticky toolbar would appear pinned to the top of every
      // view. The first mount sweeps and reports the indices; later mounts
      // apply the same indices instead of reading a computed style for every
      // element again. The DOM order of two mounts of one snapshot is
      // identical, so the indices mean the same nodes.
      let fixedIndices = options.fixedIndices || null;
      if (fixedIndices) {
        applyFixed(wrap, fixedIndices);
      } else {
        fixedIndices = sweepFixed(wrap, win);
      }

      cloneHeight = measure(wrap);
      frameDoc = doc;
      frameWin = win;

      // The frame's fonts load asynchronously, so the first layout used the
      // fallback metrics -- which also means the height was measured with
      // them. Re-measure and let the consumer redraw once they are ready.
      try {
        doc.fonts?.ready.then(() => {
          if (disposed || !wrap || frameDoc !== doc) return;
          cloneHeight = measure(wrap);
          if (options.onFonts) options.onFonts();
        }).catch(() => {});
      } catch {
        // No fonts API in this frame; the first measurement stands.
      }

      return {
        ok: true,
        fixedIndices,
        cloneHeight,
        buildMs: Math.round(performance.now() - t0),
      };
    }

    /**
     * How tall the clone's own layout is.
     *
     * Not `scrollHeight` while the wrap has a height: pages can pin an
     * absolutely positioned decorative element to the document's exact bottom
     * (Wikipedia's `.vector-body`), and that pins the clone's scrollHeight to
     * the page's height, hiding a reflow that is genuinely shorter. With the
     * wrap at auto height the measurement is the in-flow content -- absolute
     * boxes whose containing block is the viewport do not count -- and the
     * wrap is then given the page's height back, so `height: 100%` inside the
     * clone still has a document to resolve against.
     */
    function measure(el) {
      const scroller = document.scrollingElement || document.documentElement;
      el.style.height = "auto";
      const measured = Math.max(1, el.scrollHeight);
      el.style.height = `${Math.max(1, scroller.scrollHeight)}px`;
      return measured;
    }

    function dispose() {
      disposed = true;
      frame.removeEventListener("load", onLoad);
      frame.remove();
      wrap = null;
      frameDoc = null;
      frameWin = null;
      doc = null;
      win = null;
    }

    return {
      frame,
      get wrap() { return wrap; },
      get frameDoc() { return frameDoc; },
      get frameWin() { return frameWin; },
      get ready() { return loaded; },
      measureHeight: () => (wrap ? measure(wrap) : cloneHeight),
      fill,
      dispose,
    };
  }

  /** Every descendant's display:none for the fixed ones, by DOM index. */
  function sweepFixed(wrap, frameWindow) {
    const all = wrap.querySelectorAll("*");
    const fixed = [];
    for (let i = 0; i < all.length; i++) {
      if (frameWindow.getComputedStyle(all[i]).position === "fixed") {
        all[i].style.display = "none";
        fixed.push(i);
      }
    }
    return fixed;
  }

  function applyFixed(wrap, indices) {
    const all = wrap.querySelectorAll("*");
    for (const i of indices) {
      if (all[i]) all[i].style.display = "none";
    }
  }

  /**
   * Copy what cloneNode does not carry.
   *
   * A cloned <canvas> is blank, and a cloned input shows its markup's value
   * rather than what the user has typed into it. The two trees are paired by
   * tag order over the state-bearing elements rather than over every element:
   * our own UI has none of these tags, so the pairing survives it being
   * stripped from the clone, and a page that grows an unrelated <div> between
   * snapshot and mount cannot shift it.
   */
  function copyState(sources, body) {
    const dests = body.querySelectorAll("canvas, input, textarea, select");
    const n = Math.min(sources.length, dests.length);
    for (let i = 0; i < n; i++) {
      const src = sources[i];
      const dst = dests[i];
      if (!src || !dst || src.tagName !== dst.tagName) continue;
      const tag = src.tagName;
      if (tag === "CANVAS") {
        try {
          const g = dst.getContext("2d");
          if (g) g.drawImage(src, 0, 0);
        } catch {
          // A cross-origin image drawn into the page's canvas taints it, and
          // a tainted canvas cannot be read back. The clone keeps its blank
          // canvas rather than the whole view failing.
        }
      } else if (tag === "INPUT") {
        if (src.type === "checkbox" || src.type === "radio") dst.checked = src.checked;
        else dst.value = src.value;
      } else if (tag === "TEXTAREA" || tag === "SELECT") {
        dst.value = src.value;
      }
    }
  }

  /** A static picture does not play. Paused before the first paint is seen. */
  function pauseMedia(root) {
    for (const el of root.querySelectorAll("video, audio")) {
      try {
        el.pause();
        el.autoplay = false;
        el.removeAttribute("autoplay");
      } catch {
        // A media element the element type does not implement; harmless.
      }
    }
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  globalThis.ScrollPeakClone = { SCALE, previewWidth, snapshotPage, createInstance };
})();
