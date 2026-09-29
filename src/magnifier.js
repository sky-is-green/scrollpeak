// ScrollPeak — the hover preview.
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
//   * The real content of the hovered region, at 0.75 scale -- smaller than
//     the editor's normal text. A readable preview, not a magnification.
//
// HOW IT SHOWS THE CONTENT is the part worth being careful about, because the
// obvious reading of Kate is wrong here.
//
// Kate's preview calls paintTextLine for each line in the range. It does not
// lay the text out itself; it asks the renderer to draw the line, and the
// renderer is the thing that knows where every character goes, what colour it
// is, and how the lines relate. In a text editor that is a complete answer,
// because a text editor's document IS text: there are no columns, no floats,
// no images and nothing overlaps.
//
// This used to decompose the page the same way -- collect each text run, each
// image, each canvas, and re-emit them at their measured coordinates. That is
// the wrong analogue. A web page is laid out by a layout engine, and the parts
// do not stand alone: a table cell's colour comes from its row, an icon's fill
// comes from currentColor, text flows around a float, a container clips its
// children. Re-emitting the parts loses every one of those relationships, and
// no amount of patching individual cases gets them back. Each fix made the
// next symptom visible, which is the surest sign the decomposition itself is
// the bug.
//
// The right analogue of "ask the renderer" on the web is to let the browser
// render it. So the preview is a clone of the page's own content, translated so
// the hovered region is in view and scaled by 0.75 with a CSS transform. The
// browser lays it out exactly as it lays out the page, because it is the same
// markup, the same stylesheet and the same layout engine. Nothing is measured,
// nothing is reconstructed, and there is no way for the preview to disagree
// with the page. The clone is rendered in a sandboxed iframe so the page's web
// components cannot upgrade and re-render it away; buildPage() says why.
//
// The transform is what makes it affordable: `transform` does not reflow, so
// once built, moving the preview to follow the pointer is a compositor
// operation and not a layout one.

(function () {
  // Kate: m_delayTextPreviewTimer.setInterval(250)
  const SHOW_DELAY_MS = 250;

  // Kate: m_textPreview->resize(view->width() / 2, view->height() / 5)
  //
  // Percentages of the window, and the defaults. The settings can move them;
  // the clamps keep a slider from making the preview bigger than the window
  // or too small to read.
  const DEFAULT_WIDTH_PERCENT = 50;
  const DEFAULT_HEIGHT_PERCENT = 20;
  const MIN_WIDTH_PERCENT = 20;
  // 90, not 100: the popup is placed just left of the rail with an 8px
  // margin, so a full-width preview would have its right edge off-screen.
  const MAX_WIDTH_PERCENT = 90;
  const MIN_HEIGHT_PERCENT = 5;
  const MAX_HEIGHT_PERCENT = 60;

  // Kate: m_textPreview->setScaleFactor(0.75)
  const SCALE = 0.75;

  // How long the pointer must be still before the clone is rebuilt.
  //
  // Rebuilding it is the expensive half of the preview: it is the whole page,
  // and the sweep that takes viewport-pinned overlays out reads a computed
  // style for every element. Measured on the Firefox article -- 13,500 nodes --
  // a rebuild costs about 130ms. On the rail's 300ms timer that lands in the
  // middle of a drag, and at speed the pointer is moving for most of it: frame
  // times went p95 133ms with ten of 107 frames dropped, against p95 17ms and
  // two dropped when the clone is not rebuilt at all.
  //
  // So it is not rebuilt while the pointer is moving. A stale clone is a
  // slightly out-of-date page, which is a much smaller lie than a preview that
  // cannot keep up with the cursor.
  const SETTLE_MS = 180;

  // A hairline between the frame and the page's own edge. Small on purpose:
  // this is a window onto the page, and each pixel here is a pixel of the page
  // that is not shown. The page supplies its own margins.
  const BUFFER = 1;

  function mount(ctx, settings) {
    if (!settings.showMagnifier) return null;

    // The user's chosen size, or Kate's. A stored value outside the clamps
    // (an old profile, a hand-edited setting) is brought back into range
    // rather than trusted.
    const widthPercent = clamp(
      Number(settings.magnifierWidth) || DEFAULT_WIDTH_PERCENT,
      MIN_WIDTH_PERCENT, MAX_WIDTH_PERCENT);
    const heightPercent = clamp(
      Number(settings.magnifierHeight) || DEFAULT_HEIGHT_PERCENT,
      MIN_HEIGHT_PERCENT, MAX_HEIGHT_PERCENT);

    const popup = document.createElement("div");
    popup.className = "scrollpeak-magnifier";
    popup.setAttribute("role", "tooltip");
    popup.setAttribute("aria-hidden", "true");
    // The preview must never intercept a click meant for the page beneath.
    popup.style.pointerEvents = "none";
    // Anchored at the viewport's origin and moved by transform; see position().
    popup.style.left = "0";
    popup.style.top = "0";
    document.body.appendChild(popup);

    const stage = document.createElement("div");
    stage.className = "scrollpeak-magnifier__stage";
    popup.appendChild(stage);

    let timer = null;
    let frame = null;
    let visible = false;
    // Whether the preview has been created. Mirrors Kate's m_textPreview,
    // which is allocated on first show and then reused.
    let created = false;
    let latestY = 0;

    // The cloned page, and the map revision it was built from. Rebuilt only
    // when the map is, which is where the page's own changes are picked up.
    let page = null;
    let builtAt = -1;
    let buildMs = 0;
    let nodeCount = 0;
    // The sandboxed same-origin frame the clone lives in, and its windows.
    // See buildPage() for why it is a frame at all. frameReady is false until
    // its initial document has finished loading: on Firefox 146 a pending
    // about:blank navigation replaces anything written before that.
    let frameEl = null;
    let frameDoc = null;
    let frameWin = null;
    let frameReady = false;
    let settleTimer = null;

    // The frame's size and the stage's, measured when they change rather than
    // when the pointer moves. Reading clientWidth after writing the popup's
    // width forces the browser to lay the whole popup out again -- and the
    // popup holds the clone, which is the entire page. Doing that on every
    // pointer event is what made the preview lag behind a fast cursor.
    let popupW = 0;
    let popupH = 0;
    let stageW = 0;
    let stageH = 0;
    // The clone's own document height, measured when it is built. A narrower
    // viewport reflows the page and changes how tall it is, so the offset the
    // map points at is mapped onto the clone by fraction (see paint()).
    let cloneHeight = 0;

    function measure() {
      popupW = Math.round(window.innerWidth * widthPercent / 100);
      popupH = Math.round(window.innerHeight * heightPercent / 100);
      popup.style.width = `${popupW}px`;
      popup.style.height = `${popupH}px`;
      // One read, once, for both of them.
      stageW = stage.clientWidth || popupW;
      stageH = stage.clientHeight || popupH;
    }
    measure();
    window.addEventListener("resize", measure);

    function hide() {
      clearTimeout(timer);
      timer = null;
      if (!visible) return;
      visible = false;
      popup.classList.remove("is-open");
      popup.setAttribute("aria-hidden", "true");
    }

    /**
     * Clone the page.
     *
     * Expensive -- it is the whole document -- so it happens on the same 300ms
     * timer that rebuilds the map rather than on every pointer move. Everything
     * after this is a transform, which is cheap enough to run per frame.
     *
     * The clone lives in a sandboxed same-origin iframe, not in this document.
     * A clone inserted here is live: its custom elements upgrade and their
     * connectedCallback runs, and a page's own components then re-render
     * themselves from state the clone does not have. On YouTube that wiped 94%
     * of the clone (4,650 nodes to 303) and left the preview blank. A frame
     * has a custom element registry of its own, and no page scripts run in it
     * to define anything, so the cloned web components stay inert.
     *
     * The frame's viewport is set to the page's, so vh units and media queries
     * resolve as they do on the page, and the page's stylesheets are copied in
     * because a frame does not inherit the parent's cascade.
     */
    function buildPage() {
      const doc = document.scrollingElement || document.documentElement;
      // The clone's viewport is the preview's own width, not the page's. This
      // is what makes the page's responsive CSS do the work: a narrower
      // viewport reflows the page exactly as the browser would if the window
      // were that wide, instead of cropping the wide layout. `stageW / SCALE`
      // is the document width the stage can show, so the frame is sized to
      // it and nothing is cropped horizontally.
      const layoutWidth = Math.max(1, Math.round(stageW / SCALE));

      let clone;
      try {
        clone = document.body.cloneNode(true);
      } catch {
        return false;
      }

      // Our own UI is not part of the page. The rail and the preview would
      // otherwise be cloned into themselves.
      for (const el of clone.querySelectorAll(
        ".vugluscr, .scrollpeak-magnifier, .scrollpeak-map",
      )) {
        el.remove();
      }
      // And neither is the room the rail reserves. vugluscr sets an inline
      // `padding-right` on the page's body; left in the clone, the preview is
      // a rail's width narrower than the page really is, and at preview
      // widths that can even take a different breakpoint than the same page
      // rendered clean. Removing the inline value restores whatever the
      // page's own CSS says.
      clone.style.removeProperty("padding-right");

      // Ids stay. They used to be stripped, on the theory that a clone
      // duplicating the page's ids would make the page's own getElementById
      // start matching the preview -- which cannot happen through a frame,
      // but the stripping was kept anyway. It is not harmless: a site whose
      // cascade keys off an id loses those rules in the clone. On Wikipedia
      // the Vector skin sets `grid-area` with `#content > .vector-body`, and
      // without it the article body was auto-placed into the wrong grid cell:
      // the clone's content moved 9,000px down the page, which is what the
      // preview was showing. Keep every id.

      const t0 = performance.now();

      if (!frameEl) {
        frameEl = document.createElement("iframe");
        // allow-same-origin so the parent can reach the clone at all; no
        // allow-scripts, so nothing in the frame can run. The page's own
        // scripts are not parser-inserted into it and cannot run either way.
        frameEl.setAttribute("sandbox", "allow-same-origin");
        frameEl.className = "scrollpeak-magnifier__frame";
        frameEl.setAttribute("aria-hidden", "true");
        // Nothing may be written into the frame until its initial document has
        // loaded: on Firefox 146 that navigation is still pending when the
        // element is appended, and it replaces whatever is there when it
        // finishes. On 156 the write happens to survive; waiting costs
        // nothing either way, because the first build is 250ms away.
        frameEl.addEventListener("load", onFrameLoad);
        stage.appendChild(frameEl);
        frameDoc = frameEl.contentDocument;
        frameWin = frameEl.contentWindow;
      }
      if (!frameReady) return false;
      // The frame's viewport width is the preview's, so media queries, `vw`
      // and percentage layouts resolve the way they would in a window this
      // size. Its height stays the page's, so `vh` units and full-height
      // sections keep the shape they have on the page.
      frameEl.style.width = `${layoutWidth}px`;
      frameEl.style.height = `${window.innerHeight}px`;

      // Rebuild the frame's document: the page's <html> attributes, its
      // stylesheets, then the clone.
      for (const attr of [...frameDoc.documentElement.attributes]) {
        frameDoc.documentElement.removeAttribute(attr.name);
      }
      for (const attr of document.documentElement.attributes) {
        try {
          frameDoc.documentElement.setAttribute(attr.name, attr.value);
        } catch {
          // An attribute name invalid in another namespace; never in HTML.
        }
      }
      // vugluscr's own class is our chrome too; the clone holds no rail for
      // it to describe.
      frameDoc.documentElement.classList.remove("vugluscr_active", "vugluscr_embedded");
      frameDoc.documentElement.style.overflow = "hidden";
      const head = frameDoc.head;
      head.replaceChildren();
      const base = frameDoc.createElement("base");
      base.href = location.href;
      head.appendChild(base);
      copyStyles(head);
      frameDoc.body.replaceChildren();
      frameDoc.body.style.margin = "0";

      const imported = frameDoc.importNode(clone, true);
      const wrap = frameDoc.createElement("div");
      wrap.className = "scrollpeak-magnifier__page";
      // Inline, because content.css is not part of document.styleSheets --
      // content-script CSS is injected as an agent sheet -- so copyStyles()
      // never copies the .scrollpeak-magnifier__page rule below into the
      // frame. Without transform-origin the scale composes about the wrap's
      // centre instead of its top-left, which moves the clone by
      // (1 - SCALE) * half the document height: on Wikipedia about 8,900px.
      // Relative offsets survive (the origin cancels in a difference), which
      // is why the alignment test did not catch it; absolute placement does
      // not, which is what a person sees.
      wrap.style.transformOrigin = "0 0";
      wrap.style.background = "#fff";
      // Absolute at the frame's origin, again mirroring the rule that cannot
      // reach here. The frame's body is subject to the page's own `body`
      // rules -- the copied cascade styles it as if it were the page's body
      // -- so a static wrap is pushed by that padding: on article.html, by
      // its body padding, 16px right and 32px down. The relative-offset test
      // cancels that constant and passes; the absolute check does not.
      wrap.style.position = "absolute";
      wrap.style.left = "0";
      wrap.style.top = "0";
      // And a `body > div` rule can still reach the wrap; these keep the box
      // exactly the geometry the transform assumes.
      wrap.style.margin = "0";
      wrap.style.padding = "0";
      wrap.style.border = "0";
      wrap.style.display = "block";
      // The preview's own layout width, so percentage widths, tables and
      // floats resolve for the viewport the preview actually has.
      wrap.style.width = `${layoutWidth}px`;
      wrap.appendChild(imported);
      frameDoc.body.appendChild(wrap);

      copyState(document.body, imported);

      /**
       * How tall the clone's own layout is.
       *
       * Not `scrollHeight` while the wrap has a height: pages can pin an
       * absolutely positioned decorative element to the document's exact
       * bottom (Wikipedia's `.vector-body`), and that pins the clone's
       * scrollHeight to the page's height, hiding a reflow that is genuinely
       * shorter. With the wrap at auto height the measurement is the in-flow
       * content -- absolute boxes whose containing block is the viewport do
       * not count -- and the wrap is then given the page's height back, so
       * `height: 100%` inside the clone still has a document to resolve
       * against.
       */
      function measureCloneHeight() {
        wrap.style.height = "auto";
        const measured = Math.max(1, wrap.scrollHeight);
        wrap.style.height = `${Math.max(1, doc.scrollHeight)}px`;
        return measured;
      }

      // A viewport-pinned overlay has no document position: it is not anywhere
      // in the document, it is wherever the viewport is. Left in, a cookie
      // banner or a sticky toolbar would appear pinned to the top of every
      // preview of the whole page. Checked after the clone is attached, since
      // a detached subtree has no computed style to read -- and read through
      // the frame's window, which is where the clone now lives.
      for (const el of imported.querySelectorAll("*")) {
        if (frameWin.getComputedStyle(el).position === "fixed") {
          el.style.display = "none";
        }
      }

      buildMs = Math.round(performance.now() - t0);
      nodeCount = wrap.querySelectorAll("*").length;

      // The clone's height after its own reflow; see measureCloneHeight().
      cloneHeight = measureCloneHeight();

      page = wrap;
      builtAt = ctx.map.revision;

      // The frame's fonts load asynchronously, so the first layout used the
      // fallback metrics -- which also means the clone's height was measured
      // with them. Re-measure and redraw once they are ready.
      frameDoc.fonts?.ready.then(() => {
        cloneHeight = measureCloneHeight();
        if (visible) show(latestY);
      }).catch(() => {});

      return true;
    }

    /**
     * The frame's initial document is ready, or a later navigation replaced it.
     *
     * The first build usually happens well after this -- Kate's 250ms delay
     * comes first -- but when it did not, the build was skipped and is run
     * now. A second load means the frame navigated underneath us, which
     * replaces the document and the clone with it, so drop the clone and let
     * the next show rebuild it.
     */
    function onFrameLoad() {
      frameDoc = frameEl.contentDocument;
      frameWin = frameEl.contentWindow;
      if (frameReady) page = null;
      frameReady = true;
      if (visible) show(latestY);
    }

    /**
     * Copy the page's cascade into the frame.
     *
     * A frame does not inherit stylesheets, so without this the clone is
     * unstyled -- and grey boxes where icons were, because `currentColor`
     * resolves against whatever cascade it lands in. Rules are read through
     * the CSSOM so they are present synchronously; a cross-origin sheet cannot
     * be read, so its <link> is re-linked and allowed to load.
     */
    function copyStyles(head) {
      for (const sheet of document.styleSheets) {
        let text = null;
        try {
          text = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
        } catch {
          // Cross-origin: unreadable, and handled by href below.
        }
        if (text) {
          const style = frameDoc.createElement("style");
          style.textContent = text;
          head.appendChild(style);
        } else if (sheet.href) {
          const link = frameDoc.createElement("link");
          link.rel = "stylesheet";
          link.href = sheet.href;
          head.appendChild(link);
        }
      }
    }

    /**
     * Copy what cloneNode does not carry.
     *
     * The two trees have the same shape, so they can be walked in step. A
     * cloned <canvas> is blank, and a cloned input shows its markup's value
     * rather than what the user has typed into it.
     */
    function copyState(from, to) {
      const a = from.querySelectorAll("*");
      const b = to.querySelectorAll("*");
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const src = a[i];
        const dst = b[i];
        const tag = src.tagName;
        if (tag === "CANVAS") {
          try {
            const g = dst.getContext("2d");
            if (g) g.drawImage(src, 0, 0);
          } catch {
            // A cross-origin image drawn into the page's canvas taints it, and
            // a tainted canvas cannot be read back. The clone keeps its blank
            // canvas rather than the whole preview failing.
          }
        } else if (tag === "INPUT") {
          if (src.type === "checkbox" || src.type === "radio") dst.checked = src.checked;
          else dst.value = src.value;
        } else if (tag === "TEXTAREA" || tag === "SELECT") {
          dst.value = src.value;
        }
      }
    }

    /** Rebuild the preview for the document offset under the cursor. */
    function paint(docY) {
      // Built once, then reused. A rebuild is deferred to the settle timer;
      // see SETTLE_MS. Doing it here would put it inside a pointer event.
      if (!page) {
        if (!buildPage()) return;
      }

      // Everything below is either a cached number or a transform. Nothing
      // here writes a layout-affecting property and then reads one back, and
      // nothing queries the clone -- which is the whole page, and walking it
      // per pointer move cost more than the layout did.
      const pageDocHeight = Math.max(1, ctx.map.docHeight);
      const cloneDocHeight = Math.max(1, cloneHeight || pageDocHeight);

      // The clone is the page rendered at the preview's width, so its height
      // can differ from the page's -- a narrow viewport reflows the text,
      // usually taller. Map the hovered *fraction* of the document: docY is a
      // page offset and cloneY its counterpart in the reflowed clone. Exact
      // correspondence would need the page re-rendered at the same width, and
      // the fraction is what the map's proportional strip shows anyway.
      const cloneY = docY * (cloneDocHeight / pageDocHeight);

      // The document point that lands at the stage's top-left corner. A point
      // p is drawn at SCALE * (p - t), so t = p puts p at the corner.
      let ty = cloneY - stageH / (2 * SCALE);
      // Clamped, so the preview does not show blank space above the clone for
      // a cursor near the top, nor below it near the bottom.
      ty = Math.max(0, Math.min(ty, Math.max(0, cloneDocHeight - stageH / SCALE)));

      // Horizontally there is nothing to choose: the frame's viewport is the
      // width the stage shows, so its left edge is the window's left edge.
      // A site that is laid out wider than its viewport (a fixed-width
      // design) is clipped on the right exactly as a browser window that
      // narrow would clip it.
      const visibleW = stageW / SCALE;
      const tx = -BUFFER / SCALE;

      // scale() then translate(): the translate is in the clone's own
      // coordinates, so the pair maps document point t to the stage origin.
      page.style.transform = `scale(${SCALE}) translate(${-tx}px, ${-ty}px)`;

      // Published for the hover-tracking and alignment tests, and for debugging
      // a site that previews oddly.
      const lineHeight = Math.round(ctx.map.medianLineHeight() || 18);
      popup.dataset.dbg = JSON.stringify({
        docY: Math.round(docY),
        centre: Math.round(ty + stageH / (2 * SCALE)),
        lineHeight,
        rows: Math.max(1, Math.floor(stageH / (lineHeight * SCALE))),
        items: nodeCount,
        lines: ctx.map.lines.length,
        boxes: buildMs,           // milliseconds spent building the clone
        nodes: nodeCount,
        docHeight: Math.round(pageDocHeight),
        // What the clone's own viewport and document height came out as, so a
        // test can tell a reflow from a crop.
        cloneHeight: Math.round(cloneDocHeight),
        frameWidth: Math.round(visibleW),
        // The map revision the clone was built from. When this is behind
        // ctx.map.revision the preview is knowingly stale -- see SETTLE_MS.
        builtAt,
        revision: ctx.map.revision,
      });
    }

    /**
     * Put the preview beside the scrollbar, on the hovered line.
     *
     * Kate places the preview immediately left of the scrollbar and clamps it
     * vertically so it never leaves the widget.
     *
     * By transform rather than by left/top. left and top affect layout, so
     * writing them here would invalidate the document's layout on every
     * pointer move and leave the next move to pay for it. A transform is a
     * paint-time property: the browser can move the popup without re-laying
     * out the page inside it.
     */
    function position(docY) {
      const stripRect = ctx.strip.getBoundingClientRect();
      const left = Math.max(8, stripRect.left - popupW);

      const onStrip = stripRect.top + (docY / docHeight()) * stripRect.height;
      const maxTop = Math.max(stripRect.top, stripRect.bottom - popupH);
      const top = clamp(onStrip - popupH / 2, stripRect.top, maxTop);

      popup.style.transform = `translate(${left}px, ${top}px)`;
    }

    function docHeight() {
      return Math.max(1, ctx.map.docHeight);
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
    /** Rebuild the clone once the pointer has stopped moving. */
    function scheduleSettle() {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (!visible || builtAt === ctx.map.revision) return;
        if (!buildPage()) return;
        paint(latestY);
        position(latestY);
      }, SETTLE_MS);
    }

    function schedule(clientY) {
      latestY = clientY;
      scheduleSettle();
      if (created) {
        // One paint per frame. A pointer moving quickly fires pointermove more
        // than once per frame, and there is nothing to gain from painting a
        // position the next event is about to replace -- the frame the browser
        // is going to draw would never have shown it.
        if (frame === null) {
          frame = requestAnimationFrame(() => {
            frame = null;
            show(latestY);
          });
        }
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
    // Build on arrival, not on the first paint.
    //
    // The build is the expensive half and it has to happen somewhere. Kate's
    // preview does not appear until 250ms after the pointer arrives, so a build
    // started on entry is finished inside that delay and costs nothing anyone
    // can see. Left until the first paint, it lands *after* the delay, in the
    // middle of the first movement, which is the one place it is visible.
    rail.addEventListener("pointerenter", () => {
      if (page && builtAt === ctx.map.revision) return;
      buildPage();
    });
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
        clearTimeout(settleTimer);
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        window.removeEventListener("blur", hide);
        window.removeEventListener("resize", measure);
        popup.remove();
        page = null;
        frameEl = null;
        frameDoc = null;
        frameWin = null;
      },
    };
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  globalThis.ScrollPeakMagnifier = { mount };
})();
