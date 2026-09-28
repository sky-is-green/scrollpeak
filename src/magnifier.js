// ScrollPeek — the hover preview.
//
// A port of Kate's KateTextPreview (ktexteditor, src/view/katetextpreview.cpp).
// Being precise about what Kate's "magnifier" is matters, because it is not a
// zoom of the minimap:
//
//   * A frameless tooltip window (Qt::ToolTip | FramelessWindowHint |
//     BypassWindowManagerHint) -- no chrome, it does not take focus.
//   * It renders the REAL text of the hovered region through the real text
//     renderer, in the document's own font, at setScaleFactor(0.75) -- that
//     is, SMALLER than the editor's normal text. It is a readable preview, not
//     a magnification.
//   * Half the view's width by a fifth of its height, centred on the hovered
//     line, clamped so it stays on screen, placed left of the scrollbar.
//   * Debounced by 250ms (m_delayTextPreviewTimer) so sweeping the mouse
//     across the scrollbar does not strobe it.
//
// All of that is reproduced. Kate can hand the preview its line numbers and
// let the renderer lay the text out; here the lines come from TextMap with
// their own measured geometry and computed font, so the preview draws them at
// the same size and position they occupy on the page, scaled by 0.75.

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

    const canvas = document.createElement("canvas");
    canvas.className = "scrollpeak-magnifier__canvas";
    canvas.setAttribute("aria-hidden", "true");
    popup.appendChild(canvas);

    let timer = null;
    let visible = false;
    // Whether the preview has been created. Mirrors Kate's m_textPreview,
    // which is allocated on first show and then reused.
    let created = false;
    let latestY = 0;

    // Kate: hideTextPreview(), and the WindowDeactivate event filter.
    function hide() {
      clearTimeout(timer);
      timer = null;
      if (!visible) return;
      visible = false;
      popup.classList.remove("is-open");
      popup.setAttribute("aria-hidden", "true");
    }

    function paint(docY) {
      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(window.innerWidth * WIDTH_FRACTION);
      const height = Math.round(window.innerHeight * HEIGHT_FRACTION);

      popup.style.width = `${width}px`;
      popup.style.height = `${height}px`;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const g = canvas.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = ctx.map.background;
      g.fillRect(0, 0, width, height);

      // Kate centres the hovered line, then shifts the preview so that line
      // stays under the cursor as the window scrolls.
      const lineHeight = ctx.map.medianLineHeight() || 18;
      const rows = Math.max(1, Math.floor(height / (lineHeight * SCALE)));
      const centre = docY - (rows / 2) * lineHeight;

      g.textBaseline = "top";

      // The lines that fall inside the preview's slice of the document.
      //
      // A page is not linear text the way a document is: a grid or flex
      // layout puts a caption and a link side by side on the same row, and
      // drawing both at their own x overdraws them. Kate cannot hit this,
      // because he lays out a linear buffer. So the visible lines are grouped
      // into rows by their own y, each row is sorted left to right, and a line
      // that would collide with one already placed in its row is dropped.
      const left = ctx.map.contentLeftOf();
      const lines = ctx.map.lines;
      // Start from a binary search rather than the top of the document: this
      // runs on every pointermove, and scanning 8,000 lines each time to
      // reach the middle of the page is most of the hover cost.
      const visible = [];
      const first = Math.max(0, ctx.map.indexAtY(centre - 4 * lineHeight));
      for (let i = first; i < lines.length; i++) {
        const line = lines[i];
        const top = (line.y - centre) * SCALE;
        if (top > height) break; // lines are sorted by y
        if (top + line.height * SCALE < 0) continue;
        visible.push({ line, top });
      }

      let drawn = 0;
      let rowTop = null;
      let rowRight = -Infinity;
      for (let i = 0; i < visible.length; i++) {
        // Start a new row whenever the next line sits clearly below the one
        // that opened this row. The tolerance is a fraction of that line's own
        // height, so a single tall element cannot merge the whole page.
        const current = visible[i];
        if (rowTop === null || current.top - rowTop > current.line.height * SCALE * 0.6) {
          rowTop = current.top;
          rowRight = -Infinity;
          // Order this row left to right before placing anything in it.
          let j = i;
          const row = [];
          while (j < visible.length &&
                 visible[j].top - rowTop <= current.line.height * SCALE * 0.6) {
            row.push(visible[j]);
            j++;
          }
          row.sort((a, b) => a.line.x - b.line.x);
          for (const item of row) {
            const x = (item.line.x - left) * SCALE;
            if (x < rowRight) continue; // would overdraw a neighbour
            g.fillStyle = item.line.color;
            g.font = withWeight(item.line.font, item.line.bold, item.line.italic);
            g.fillText(item.line.text, x, item.top);
            rowRight = Math.max(rowRight, x + g.measureText(item.line.text).width);
            drawn++;
          }
          i = j - 1;
          continue;
        }
      }
      // Surfaced for the smoke test and for anyone debugging a site that
      // renders oddly; costs nothing when nobody is looking.
      popup.dataset.drawn = String(drawn);
      popup.dataset.visible = String(visible.length);
      popup.dataset.dbg = JSON.stringify({
        docY: Math.round(docY),
        centre: Math.round(centre),
        lineHeight: Math.round(lineHeight * 10) / 10,
        rows,
        total: ctx.map.lines.length,
        docHeight: Math.round(ctx.map.docHeight),
        firstY: ctx.map.lines.length ? Math.round(ctx.map.lines[0].y) : null,
        lastY: ctx.map.lines.length ? Math.round(ctx.map.lines[ctx.map.lines.length - 1].y) : null,
      });
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
     * the pointer past the scrollbar does not flash a window. Once the
     * preview exists, Kate calls showTextPreview() directly on every
     * mouseMoveEvent -- and note it does not restart the timer either, so the
     * first hover fires 250ms after it *began*, not after it settled.
     *
     * Debouncing every move instead means the timer is reset continuously
     * while the pointer is moving and only fires once it stops, so the preview
     * visibly lags and then jumps. That is what this used to do.
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

    const strip = ctx.strip;
    strip.addEventListener("pointermove", (e) => schedule(e.clientY));
    strip.addEventListener("pointerleave", hide);
    // Kate hides the preview on WindowDeactivate; losing focus is the browser
    // equivalent, and also when a stale preview would be most misleading.
    window.addEventListener("blur", hide);
    // Committing to a jump: get it out of the way immediately.
    // Note the double `rail`: Scrollbar.rail is the ScrollRail, and ScrollRail
    // is what exposes domNode. Scrollbar itself has no domNode.
    ctx.rail.rail.domNode.addEventListener("pointerdown", hide);

    return {
      el: popup,
      hide,
      repaint: () => {
        if (visible) {
          const rect = ctx.strip.getBoundingClientRect();
          const docY = ctx.map.documentOffsetAt(rect.top + rect.height / 2, rect);
          paint(docY);
          position(docY);
        }
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

  /** Re-apply weight and slant to a computed `font` shorthand. */
  function withWeight(font, bold, italic) {
    let out = font;
    if (bold && !/\bbold\b|\d{3}(?:00|50)/.test(out)) out = `bold ${out}`;
    if (italic && !/\bitalic\b|\boblique\b/.test(out)) out = `italic ${out}`;
    return out;
  }

  globalThis.ScrollPeekMagnifier = { mount };
})();
