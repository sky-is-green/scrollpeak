// ScrollPeek — the hover preview.
//
// A port of Kate's KateTextPreview (ktexteditor, src/view/katetextpreview.cpp).
// Being precise about what Kate's "magnifier" is matters, because it is not a
// zoom of the minimap:
//
//   * A frameless tooltip window (Qt::ToolTip | FramelessWindowHint |
//     BypassWindowManagerHint) -- no chrome, it does not take focus.
//   * Half the view's width by a fifth of its height, centred on the hovered
//     line, clamped so it stays on screen, placed left of the scrollbar.
//   * Debounced 250ms on first appearance only, so sweeping the pointer past
//     the scrollbar does not flash a window; repaints on every move after.
//   * The real text of the hovered region, in the document's own font, at 0.75
//     scale -- that is, smaller than the editor's normal text. A readable
//     preview, not a magnification.
//
// One deliberate difference. Kate's preview calls paintTextLine, which draws
// text lines, because in a text editor text is the entire content. A web page
// is not text, and a 16px icon beside a label is often the only thing that
// says what a row is. So this also shows the page's graphics.
//
// They are drawn as DOM, not onto a canvas. Cloning an inline <svg> into this
// document keeps it in the same cascade, so `fill: currentColor` and the
// page's own icon classes still apply -- which is how most icon systems colour
// themselves. Serialising an <svg> to a data URL and rasterising it loses all
// of that, and additionally depends on an image load that a content script
// cannot rely on settling. Images, canvas and CSS background images are
// handled the same way, so they keep their real styling too.

(function () {
  // Kate: m_delayTextPreviewTimer.setInterval(250)
  const SHOW_DELAY_MS = 250;

  // Kate: m_textPreview->resize(view->width() / 2, view->height() / 5)
  const WIDTH_FRACTION = 0.5;
  const HEIGHT_FRACTION = 0.2;

  // Kate: m_textPreview->setScaleFactor(0.75)
  const SCALE = 0.75;

  function mount(ctx) {
    if (!ctx.settings.showMagnifier) return null;

    const popup = document.createElement("div");
    popup.className = "scrollpeak-magnifier";
    popup.setAttribute("role", "tooltip");
    popup.setAttribute("aria-hidden", "true");
    // The preview must never intercept a click meant for the page beneath.
    popup.style.pointerEvents = "none";
    document.body.appendChild(popup);

    const stage = document.createElement("div");
    stage.className = "scrollpeak-magnifier__stage";
    popup.appendChild(stage);

    let timer = null;
    let visible = false;
    // Whether the preview has been created. Mirrors Kate's m_textPreview,
    // which is allocated on first show and then reused.
    let created = false;
    let latestY = 0;

    function hide() {
      clearTimeout(timer);
      timer = null;
      if (!visible) return;
      visible = false;
      popup.classList.remove("is-open");
      popup.setAttribute("aria-hidden", "true");
    }

    /** Rebuild the preview for the document offset under the cursor. */
    function paint(docY) {
      const width = Math.round(window.innerWidth * WIDTH_FRACTION);
      const height = Math.round(window.innerHeight * HEIGHT_FRACTION);
      popup.style.width = `${width}px`;
      popup.style.height = `${height}px`;

      // Kate centres the hovered line. He can use the renderer's own line
      // height; we derive one, because a page's line boxes vary and a
      // hardcoded guess mis-centres the preview on any site that does not use
      // the browser default.
      const lineHeight = ctx.map.medianLineHeight() || 18;
      const rows = Math.max(1, Math.floor(height / (lineHeight * SCALE)));
      const centre = docY - (rows / 2) * lineHeight;
      const left = ctx.map.contentLeftOf();

      // Text and graphics, interleaved in document order so that stacking
      // matches the page. With real coordinates this also removes the need
      // for the declutter a canvas needed: two elements side by side in a
      // flex row have non-overlapping x, so they simply do not collide.
      const items = [];
      const lines = ctx.map.lines;
      const firstLine = ctx.map.indexAtY(centre - 2 * lineHeight);
      for (let i = firstLine; i < lines.length; i++) {
        const line = lines[i];
        const top = (line.y - centre) * SCALE;
        if (top > height) break;
        if (top + line.height * SCALE < 0) continue;
        items.push({ y: line.y, x: line.x, make: () => textNode(line, left, centre) });
      }
      const boxes = ctx.map.boxes;
      if (boxes.length) {
        const firstBox = lowerBound(boxes, centre - 2 * lineHeight, (b) => b.y);
        for (let i = firstBox; i < boxes.length; i++) {
          const box = boxes[i];
          const top = (box.y - centre) * SCALE;
          if (top > height) break;
          if (top + box.height * SCALE < 0) continue;
          items.push({ y: box.y, x: box.x, make: () => graphicNode(box, left, centre) });
        }
      }
      items.sort((a, b) => a.y - b.y || a.x - b.x);

      const frag = document.createDocumentFragment();
      for (const item of items) {
        const el = item.make();
        if (el) frag.appendChild(el);
      }
      stage.style.background = ctx.map.background;
      stage.replaceChildren(frag);
      popup.dataset.items = String(items.length);
      // Published for the hover-tracking and alignment tests, and for
      // debugging a site that previews oddly.
      popup.dataset.dbg = JSON.stringify({
        docY: Math.round(docY),
        centre: Math.round(centre),
        lineHeight: Math.round(lineHeight * 10) / 10,
        rows,
        items: items.length,
        lines: ctx.map.lines.length,
        boxes: ctx.map.boxes.length,
        docHeight: Math.round(ctx.map.docHeight),
      });
    }

    /** One line of text, positioned and styled as it is on the page. */
    function textNode(line, left, centre) {
      const el = document.createElement("span");
      el.className = "scrollpeak-magnifier__line";
      el.textContent = line.text;
      // Every axis scaled by the same factor. Kate scales the whole render,
      // so the font, the positions and the spacing all move together; scaling
      // only the font leaves the line rhythm at 1/0.75 of where it should be
      // and the preview reads as broken spacing.
      // No width and no height: a run is one line box, so it sizes itself, and
      // forcing a box would clip a slice that turned out to wrap rather than
      // showing it.
      place(el, (line.x - left) * SCALE, (line.y - centre) * SCALE, 0, 0);
      el.style.color = line.color;
      el.style.fontFamily = line.family;
      el.style.fontSize = `${Math.max(1, Math.round(line.fontSize * SCALE))}px`;
      // The page's own line box, so the text sits in the middle of it exactly
      // as it does on the page rather than hanging from the top.
      el.style.lineHeight = `${Math.max(1, Math.round(line.height * SCALE))}px`;
      if (line.bold) el.style.fontWeight = "600";
      if (line.italic) el.style.fontStyle = "italic";
      return el;
    }

    /**
     * One graphic.
     *
     * Everything is cloned rather than reconstructed, so an image keeps its
     * src, its attributes and its page styling, and a background-image element
     * keeps the class its background comes from. Cloning an <svg> into this
     * document is the point: it stays in the page's cascade, so
     * `fill: currentColor` and the site's own icon classes still apply.
     *
     * A cloned <canvas> is blank, so its pixels are copied across. Images are
     * left to the browser: the clone reuses the cached resource, so this costs
     * a node rather than a fetch.
     */
    function graphicNode(box, left, centre) {
      const el = box.el;
      const w = box.width * SCALE;
      const h = box.height * SCALE;
      if (w <= 0 || h <= 0) return null;

      let node;
      try {
        node = el.cloneNode(true);
      } catch {
        return null;
      }
      if (!node) return null;

      if (el.tagName === "CANVAS") {
        const g = node.getContext("2d");
        if (!g) return null;
        try {
          g.drawImage(el, 0, 0);
        } catch {
          return null;
        }
      }
      if (el.tagName === "IMG") {
        const src = el.currentSrc || el.src;
        if (!src) return null;
        // currentSrc is the picture-selected source, which can differ from the
        // attribute; prefer it when the clone did not inherit it.
        if (!node.currentSrc && !node.src) node.src = src;
        node.alt = "";
      }

      // A clone in the same document must not duplicate the page's ids, or the
      // page's own getElementById and querySelectorAll start matching the
      // preview.
      node.removeAttribute("id");
      node.removeAttribute("name");
      for (const el2 of node.querySelectorAll("[id]")) el2.removeAttribute("id");

      place(node, (box.x - left) * SCALE, (box.y - centre) * SCALE, w, h);
      return node;
    }

    function place(el, x, y, w, h) {
      el.style.position = "absolute";
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      if (w) el.style.width = `${w}px`;
      if (h) el.style.height = `${h}px`;
      el.style.margin = "0";
      el.style.maxWidth = "none";
      el.setAttribute("aria-hidden", "true");
      el.style.pointerEvents = "none";
    }

    function position(docY) {
      const stripRect = ctx.strip.getBoundingClientRect();
      // Kate places the preview immediately left of the scrollbar and clamps
      // it vertically so it never leaves the widget.
      const left = stripRect.left - popup.offsetWidth;
      popup.style.left = `${Math.max(8, left)}px`;

      const onStrip = stripRect.top + (docY / ctx.map.docHeight) * stripRect.height;
      const top = onStrip - popup.offsetHeight / 2;
      const maxTop = Math.max(stripRect.top, stripRect.bottom - popup.offsetHeight);
      popup.style.top = `${clamp(top, stripRect.top, maxTop)}px`;
    }

    function show(clientY) {
      const rect = ctx.strip.getBoundingClientRect();
      const docY = ctx.map.documentOffsetAt(clientY, rect);
      paint(docY);
      position(docY);
      popup.setAttribute("aria-hidden", "false");
      popup.classList.add("is-open");
      visible = true;
      // Kate's m_textPreview: once the widget exists it is reused for the
      // rest of the session, so this only ever latches on.
      created = true;
    }

    /**
     * Kate's showTextPreviewDelayed().
     *
     * The 250ms timer guards the *first* appearance only, so that sweeping
     * the pointer past the scrollbar does not flash a window. Once the preview
     * exists, Kate calls showTextPreview() directly on every mouseMoveEvent --
     * and note it does not restart the timer either, so the first hover fires
     * 250ms after it *began*, not after it settled.
     *
     * Debouncing every move instead means the timer is reset continuously
     * while the pointer is moving and only fires once it stops, so the preview
     * visibly lags and then jumps.
     */
    function schedule(clientY) {
      latestY = clientY;
      if (created) {
        show(clientY);
        return;
      }
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          show(latestY);
        }, SHOW_DELAY_MS);
      }
    }

    // Listen on the whole rail, not just the minimap pane.
    //
    // In Kate the map *is* the scrollbar, so there is no other place for the
    // pointer to be. vugluscr's rail is the map plus a separate track beside
    // it, and both stretch to the same height, so hovering the track used to
    // fire pointerleave on the map and kill the preview.
    const rail = ctx.rail.rail.domNode;
    rail.addEventListener("pointermove", (e) => schedule(e.clientY));
    rail.addEventListener("pointerleave", hide);
    // Kate hides the preview on WindowDeactivate; losing focus is the browser
    // equivalent, and also when a stale preview would be most misleading.
    window.addEventListener("blur", hide);
    // Committing to a jump: get it out of the way immediately.
    // Note the double `rail`: Scrollbar.rail is the ScrollRail, and ScrollRail
    // is what exposes domNode. Scrollbar itself has no domNode.
    rail.addEventListener("pointerdown", hide);

    return {
      el: popup,
      hide,
      repaint: () => {
        if (visible) show(latestY);
      },
      teardown() {
        hide();
        window.removeEventListener("blur", hide);
        popup.remove();
      },
    };
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  /** First index whose y is at or below `y`. Sorted by y. */
  function lowerBound(sorted, y, key) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (key(sorted[mid]) < y) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  }

  globalThis.ScrollPeekMagnifier = { mount };
})();
