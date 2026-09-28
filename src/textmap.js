// ScrollPeek — the minimap renderer.
//
// A port of Kate's scrollbar minimap. The reference is KateScrollBar in
// ktexteditor, src/view/kateviewhelpers.cpp: updatePixmap() builds the map,
// miniMapPaintEvent() draws it, and KateTextPreview (katetextpreview.cpp) is
// the hover preview.
//
// Kate's method, in full:
//
//   1. Rasterise the document's TEXT into an offscreen pixmap, one pixel per
//      non-space character, each pixel taking that character's own colour.
//   2. Downsample by skipping: every `lineIncrement`-th line, and every
//      `charIncrement`-th character, sized so the pixmap is about as tall as
//      the groove. charIncrement is capped at 6; past that Kate skips whole
//      lines instead of thinning characters further.
//   3. Stretch that pixmap to the width of the strip, and fade everything
//      outside the current viewport with the page background at alpha 110.
//
// Step 1 is the expensive one and Kate caches it, rebuilding on a 300ms timer;
// steps 2-3 are cheap and run every frame. That split is preserved here.
//
// Where the web forced a change, it is noted at the point of change. There is
// exactly one: Kate can ask a syntax highlighter for each character's colour,
// whereas a page only exposes colour per element, so a "line" here is a line
// box of a single text node rather than a line of arbitrary mixed colour. A
// paragraph with a link in it therefore becomes two runs, which is more
// faithful to the page, not less.

(function () {
  // Kate: s_lineWidth, s_pixelMargin, s_linePixelIncLimit
  const S_LINE_WIDTH = 100;
  const S_PIXEL_MARGIN = 8;
  const S_LINE_PIXEL_INC_LIMIT = 6;

  // Kate: m_updateTimer.setInterval(300)
  const REBUILD_DELAY_MS = 300;

  // Kate: the docXMargin in miniMapPaintEvent
  const DOC_X_MARGIN = 1;

  // Kate: simpleMode -- m_doc->lines() > 7500 skips highlighting work
  const SIMPLE_MODE_LINE_COUNT = 7500;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE",
    "CANVAS", "IFRAME", "OBJECT", "EMBED", "SVG",
  ]);

  class TextMap {
    constructor({ width, height }) {
      this.width = width;
      this.height = height;

      // Kate's m_pixmap. Rebuilt on a timer, never on scroll.
      this.pixmap = document.createElement("canvas");
      this.pixmapCtx = this.pixmap.getContext("2d", { alpha: true });

      // The visible surface: the pixmap stretched into it, plus the fades.
      this.canvas = document.createElement("canvas");
      this.canvas.className = "scrollpeak-map";
      this.canvas.setAttribute("aria-hidden", "true");
      this.ctx = this.canvas.getContext("2d", { alpha: true });

      /** Kate's per-line data. @type {Line[]} */
      this.lines = [];
      this.docHeight = 1;
      this.charIncrement = 1;
      this.lineIncrement = 1;
      this.background = "#ffffff";
      this.revision = 0;
    }

    setSize(width, height) {
      if (width === this.width && height === this.height) return false;
      this.width = width;
      this.height = height;
      return true;
    }

    // ---------------------------------------------------------------- collect

    /**
     * Read every visible line box, in document coordinates, with the exact
     * text on it.
     *
     * Kate asks its buffer for line N and gets line N. Here the text is laid
     * out by the browser, so the text of a line box has to be recovered from
     * the text node it came from. Range.getClientRects() gives the line boxes;
     * a binary search per boundary gives the exact character offset, which is
     * both affordable and exact rather than approximate.
     *
     * The whole pass is a pure read. We never write to the page while
     * collecting, so layout is flushed once and every subsequent
     * getClientRects() is cheap. Interleaving reads with writes here would
     * cost a reflow per line box.
     */
    collect(root) {
      const lines = [];
      const styleCache = new Map();
      const scrollY = window.scrollY;
      const scrollX = window.scrollX;
      const simpleMode = this.countLines(root) > SIMPLE_MODE_LINE_COUNT;

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) {
            return NodeFilter.FILTER_REJECT;
          }
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          // Never map our own UI; it is not part of the page.
          if (parent.closest(".vugluscr, .scrollpeak-magnifier, .scrollpeak-map")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const style = this.#styleFor(node.parentElement, styleCache, simpleMode);
        if (!style) continue;

        const range = document.createRange();
        range.selectNodeContents(node);
        // One rect per line box. Empty for display:none, visibility:hidden and
        // collapsed content, which is exactly the filtering wanted here -- and
        // it means we are immune to content-visibility: auto, the reason
        // screenshot-based minimaps come back blank.
        const rects = Array.from(range.getClientRects()).filter(
          (r) => r.width > 0 && r.height > 0,
        );
        if (!rects.length) continue;

        const text = node.nodeValue;
        const bounds = this.#charBounds(node, text, rects);

        for (let i = 0; i < rects.length; i++) {
          const slice = text.slice(bounds[i], bounds[i + 1]);
          if (!slice.trim()) continue;
          lines.push({
            y: rects[i].top + scrollY,
            height: rects[i].height,
            x: rects[i].left + scrollX,
            text: slice,
            color: style.color,
            font: style.font,
            bold: style.bold,
            italic: style.italic,
          });
        }
      }

      // Drop line boxes that fall outside the document.
      //
      // getClientRects() still reports boxes for content that has been
      // scrolled out of an inner container, and those land at wildly negative
      // y (Wikipedia's infobox tables report y around -100000). Left in, they
      // consume map rows and skew the whole rendering. On Wikipedia, 8841
      // lines were collected with the first at y = -99712 and the last past
      // the end of the document.
      const scrollerEl = document.scrollingElement || document.documentElement;
      const maxY = Math.max(1, scrollerEl.scrollHeight);
      const kept = lines.filter(
        (l) => l.y > -l.height && l.y < maxY + l.height,
      );

      kept.sort((a, b) => a.y - b.y);
      this.lines = kept;

      // Kate's preview starts at xStart = 0, so what it shows is the line's
      // own indentation, not its position on the page. A page's analogue is
      // the offset from the content's left edge -- without this, a site with
      // a fixed sidebar pushes every line off to the right of the preview.
      // A low percentile rather than the minimum, so one stray element does
      // not shift everything.
      this.contentLeft = contentLeft(lines);

      this.docHeight = maxY;
      this.background =
        getComputedStyle(document.body).backgroundColor || "#ffffff";

      this.revision++;
      return lines;
    }

    /** Left edge of the main content column, robustly. */
    contentLeftOf() {
      return this.contentLeft;
    }

    /** Cheap upper bound on line count, to pick simple mode before collecting. */
    countLines(root) {
      // An upper bound: text nodes <= line boxes is not true, but every extra
      // line box has at least one text node, so counting nodes and comparing
      // against the limit is the conservative direction only if nodes >= lines
      // is false. Use it as a rough guard, not a decision.
      return root.getElementsByTagName("*").length;
    }

    /**
     * Character offset where each line box starts, plus the end offset.
     *
     * For line box i, binary search for the first character whose own rect
     * sits below line box i. O(log n) rect queries per boundary, against O(n)
     * to measure every character.
     */
    #charBounds(node, text, rects) {
      const range = document.createRange();
      const bounds = new Array(rects.length + 1);
      bounds[0] = 0;

      for (let i = 1; i < rects.length; i++) {
        const above = rects[i - 1].top;
        let lo = bounds[i - 1];
        let hi = text.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          range.setStart(node, mid);
          range.setEnd(node, Math.min(text.length, mid + 1));
          const r = range.getBoundingClientRect();
          if (r.height === 0 || r.top > above) hi = mid;
          else lo = mid + 1;
        }
        bounds[i] = lo;
      }
      bounds[rects.length] = text.length;
      return bounds;
    }

    #styleFor(parent, cache, simpleMode) {
      const hit = cache.get(parent);
      if (hit !== undefined) return hit;

      const cs = getComputedStyle(parent);
      if (cs.display === "none") {
        cache.set(parent, null);
        return null;
      }
      // Kate's simpleMode falls back to the default text colour on very large
      // documents. We do the same, but the real cost saving here is the
      // per-element getComputedStyle, which the cache already dedupes.
      const style = simpleMode
        ? {
            color: cs.color,
            font: `${cs.fontSize} ${cs.fontFamily}`,
            bold: false,
            italic: false,
          }
        : {
            color: cs.color,
            font: `${cs.fontSize} ${cs.fontFamily}`,
            bold: parseInt(cs.fontWeight, 10) >= 600,
            italic: cs.fontStyle === "italic" || cs.fontStyle === "oblique",
          };
      cache.set(parent, style);
      return style;
    }

    // ------------------------------------------------------------- buildPixmap

    /**
     * Kate's updatePixmap(). Rasterise the lines into an offscreen canvas,
     * one pixel per non-space character, sized so it is about as tall as the
     * groove.
     */
    buildPixmap() {
      const grooveHeight = Math.max(5, this.height);
      const docLineCount = this.lines.length;

      // Kate's downsampling arithmetic, integer division throughout.
      let pixmapLineCount = docLineCount;
      const pixmapLinesUnscaled = pixmapLineCount;
      let charIncrement = 1;
      let lineIncrement = 1;
      if (grooveHeight > 10 && pixmapLineCount >= grooveHeight * 2) {
        charIncrement = Math.floor(pixmapLineCount / grooveHeight);
        while (charIncrement > S_LINE_PIXEL_INC_LIMIT) {
          lineIncrement++;
          pixmapLineCount = Math.floor(pixmapLinesUnscaled / lineIncrement);
          charIncrement = Math.floor(pixmapLineCount / grooveHeight);
        }
        pixmapLineCount = Math.floor(pixmapLineCount / charIncrement);
      }
      this.charIncrement = charIncrement;
      this.lineIncrement = lineIncrement;

      const pixmapLineWidth =
        S_PIXEL_MARGIN + Math.floor(S_LINE_WIDTH / charIncrement);

      const dpr = window.devicePixelRatio || 1;
      const pw = Math.max(1, Math.round(pixmapLineWidth * dpr));
      const ph = Math.max(1, Math.round(pixmapLineCount * dpr));
      if (this.pixmap.width !== pw || this.pixmap.height !== ph) {
        this.pixmap.width = pw;
        this.pixmap.height = ph;
      }
      const ctx = this.pixmapCtx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, pixmapLineWidth, pixmapLineCount);

      let pixelY = 0;
      let drawnLines = 0;

      for (let virtualLine = 0; virtualLine < docLineCount; virtualLine += lineIncrement) {
        const line = this.lines[virtualLine];
        if (!line) break;
        const text = line.text;
        let pixelX = S_PIXEL_MARGIN;

        for (let x = 0; x < text.length && x < S_LINE_WIDTH; x += charIncrement) {
          if (pixelX >= S_LINE_WIDTH + S_PIXEL_MARGIN) break;
          const ch = text.charCodeAt(x);
          if (ch === 32 /* space */) {
            pixelX++;
          } else if (ch === 9 /* tab */) {
            pixelX += Math.max(Math.floor(4 / charIncrement), 1);
          } else {
            // Kate batches the points of a colour range into one drawPoints
            // call. We have one colour per line box, so this is a plain fill.
            ctx.fillStyle = line.color;
            ctx.fillRect(pixelX++, pixelY, 1, 1);
          }
        }

        drawnLines++;
        if (drawnLines % charIncrement === 0) pixelY++;
      }

      this.pixmapLineWidth = pixmapLineWidth;
      this.pixmapLineCount = pixmapLineCount;
    }

    // ------------------------------------------------------------------ paint

    /**
     * Kate's miniMapPaintEvent(): stretch the pixmap into the groove, mark
     * the viewport, and fade everything outside it.
     *
     * Cheap enough to run on every scroll frame, which is the point of
     * keeping it separate from buildPixmap().
     */
    paint(scrollTop, viewportHeight) {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(this.width * dpr));
      const h = Math.max(1, Math.round(this.height * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;

      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const grooveHeight = this.height;
      const pixmapH = this.pixmapLineCount;

      // Kate: qMin(grooveRect.height(), pixmapHeight * 2) - 2 * docXMargin
      const docHeight = Math.min(grooveHeight, pixmapH * 2) - 2 * DOC_X_MARGIN;
      const docTop = DOC_X_MARGIN;
      const docWidth = this.width - DOC_X_MARGIN;
      if (docHeight <= 0) {
        ctx.clearRect(0, 0, this.width, this.height);
        return;
      }

      // Kate's visibleStart / visibleEnd, over the scrollbar's own value and
      // pageStep rather than the document's, so the highlight tracks the
      // slider exactly.
      const max = Math.max(this.docHeight - viewportHeight, 1);
      const pageStep = viewportHeight;
      const visibleStart = (scrollTop * docHeight) / (max + pageStep) + docTop + 0.5;
      const visibleEnd = ((scrollTop + pageStep) * docHeight) / (max + pageStep) + docTop;
      const visibleHeight = Math.max(1, visibleEnd - visibleStart);

      // The page background, so a short document does not show the strip's
      // own colour underneath. Kate: painter.drawRect(grooveRect).
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, this.width, grooveHeight);

      // Stretch the pixmap. Kate draws the s_pixelMargin column separately so
      // the left gutter (modified-line marks) is not stretched; we have no
      // such column, so the whole pixmap goes across.
      const contentW = this.pixmapLineWidth - S_PIXEL_MARGIN;
      if (contentW > 0) {
        ctx.imageSmoothingEnabled =
          grooveHeight < pixmapH ? true : grooveHeight < pixmapH;
        ctx.drawImage(
          this.pixmap,
          S_PIXEL_MARGIN, 0, contentW, pixmapH,
          DOC_X_MARGIN, docTop, docWidth, docHeight,
        );
        ctx.imageSmoothingEnabled = false;
      }

      // Fade what is not currently visible. Kate: backgroundColor at alpha 110.
      const fade = withAlpha(this.background, 110);
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, this.width, visibleStart);
      ctx.fillRect(0, visibleStart + visibleHeight, this.width,
        grooveHeight - visibleStart - visibleHeight);

      // Delimit the end of the document, if there is room below it.
      const endY = docTop + docHeight;
      if (endY + 2 < grooveHeight) {
        ctx.fillStyle = withAlpha(this.foregroundColor(), 30);
        ctx.fillRect(1, endY + 2, this.width - 1, 1);
      }

      // Kate's thin line limiting the scrollbar.
      ctx.fillStyle = withAlpha(this.foregroundColor(), 10);
      ctx.fillRect(0, 0, 1, grooveHeight);
    }

    foregroundColor() {
      return getComputedStyle(document.body).color || "#000000";
    }

    /**
     * Kate's posInPercent * visibleLines(): a cursor position on the strip,
     * in document pixels.
     */
    documentOffsetAt(clientY, stripRect) {
      if (!stripRect.height) return 0;
      const ratio = clamp((clientY - stripRect.top) / stripRect.height, 0, 1);
      return ratio * this.docHeight;
    }

    /**
     * Median line-box height, for centring the preview.
     *
     * Cached per revision: this sorts a few thousand values, and the preview
     * repaints on every pointermove now, so recomputing it per frame was the
     * single most expensive thing in the hover path.
     */
    medianLineHeight() {
      if (this._medianCacheRev === this.revision) return this._medianCache;
      if (!this.lines.length) {
        this._medianCacheRev = this.revision;
        return (this._medianCache = 0);
      }
      const step = this.lines.length > 400 ? 3 : 1;
      const heights = [];
      for (let i = 0; i < this.lines.length; i += step) {
        heights.push(this.lines[i].height);
      }
      heights.sort((a, b) => a - b);
      this._medianCacheRev = this.revision;
      this._medianCache = heights[heights.length >> 1];
      return this._medianCache;
    }

    /**
     * Index of the first line at or below `y`. Lines are sorted by y, so this
     * is a binary search -- the preview needs the same window on every
     * pointermove and a linear scan from zero is the wrong shape for that.
     */
    indexAtY(y) {
      const lines = this.lines;
      let lo = 0;
      let hi = lines.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].y < y) lo = mid + 1;
        else hi = mid;
      }
      return Math.max(0, lo - 1);
    }
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  /** 5th-percentile x, so a single far-left outlier cannot shift the column. */
  function contentLeft(lines) {
    if (!lines.length) return 0;
    const xs = lines.map((l) => l.x).sort((a, b) => a - b);
    return xs[Math.floor(xs.length * 0.05)] || 0;
  }

  /** Apply an alpha to a computed rgb()/rgba() colour. Kate sets alpha on a QColor. */
  function withAlpha(color, alpha) {
    const m = /^rgba?\(([^)]+)\)$/.exec(color.trim());
    if (!m) return color;
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    const [r, g, b] = parts;
    if ([r, g, b].some(Number.isNaN)) return color;
    return `rgba(${r}, ${g}, ${b}, ${alpha / 255})`;
  }

  globalThis.ScrollPeekTextMap = { TextMap, REBUILD_DELAY_MS, S_PIXEL_MARGIN };
})();
