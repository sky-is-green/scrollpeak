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

  // Cap on collected graphics. See collectBoxes().
  const MAX_BOXES = 600;

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
      /** Painted graphics, for the preview. @type {Array<object>} */
      this.boxes = [];
      this.docHeight = 1;
      /**
       * The strip's background, and how much darker than the page it should
       * be. See resolveColours().
       */
      this.mapBackground = "#ffffff";
      this.markContrast = 3;
      /** Per-collect memo of original mark colour -> adjusted. */
      this.markColours = new Map();
      this.charIncrement = 1;
      this.lineIncrement = 1;
      this.background = "#ffffff";
      this.revision = 0;
      // vugluscr's viewport thumb, read for the fade. Deriving the band from
      // the thumb itself rather than recomputing its geometry means the two
      // can never disagree.
      this.thumbEl = null;
    }

    setThumbEl(el) {
      this.thumbEl = el;
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
            family: style.family,
            fontSize: style.fontSize,
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

      // Painted graphics: images, inline SVG, canvas, background images.
      //
      // Kate's preview calls paintTextLine, which draws text lines, because in
      // a text editor text is the whole of the content. A web page is not
      // text, and an icon is often the only thing that tells you what a
      // section is -- a file type, a status, a warning. So the preview shows
      // them too. The minimap stays text-only, which is faithful.
      this.boxes = this.collectBoxes(root).filter(
        (b) => b.y > -b.height && b.y < maxY + b.height,
      );
      this.boxes.sort((a, b) => a.y - b.y);

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
      this.resolveColours();

      this.revision++;
      return lines;
    }

    /**
     * Collect the things on the page that paint something other than glyphs.
     *
     * Bounded on purpose: `querySelectorAll` on a big page returns thousands
     * of nodes, and a rect read for each would cost more than the text pass.
     * A page with more than MAX_BOXES of them gets the first MAX_BOXES in
     * document order, which is where the header and the first screenful are.
     */
    collectBoxes(root) {
      const scrollY = window.scrollY;
      const scrollX = window.scrollX;
      const found = [];
      const seen = new Set();

      const consider = (el) => {
        if (!el || seen.has(el)) return;
        if (el.closest(".vugluscr, .scrollpeak-magnifier, .scrollpeak-map")) return;
        seen.add(el);

        const rects = Array.from(el.getClientRects()).filter(
          (r) => r.width > 0.5 && r.height > 0.5,
        );
        for (const rect of rects) {
          if (rect.width < 1 || rect.height < 1) continue;
          found.push(makeBox(el, rect, scrollX, scrollY));
        }
      };

      // Media elements and inline SVG draw directly onto a canvas.
      for (const el of root.querySelectorAll(
        "img, svg, canvas, video, picture img, object, embed",
      )) {
        if (found.length >= MAX_BOXES) break;
        consider(el);
      }

      // Background images. The page's own background is excluded: the preview
      // already paints the page background, and html/body would otherwise
      // cover the whole region.
      for (const el of root.querySelectorAll("*")) {
        if (found.length >= MAX_BOXES) break;
        if (el === document.body || el === document.documentElement) continue;
        if (seen.has(el)) continue;
        const cs = getComputedStyle(el);
        if (!cs.backgroundImage || cs.backgroundImage === "none") continue;
        consider(el);
      }

      return found;
    }


    /**
     * Settings that affect how the strip is coloured.
     *
     * `mapBackground` is a CSS colour, or "" for the default. The default is a
     * darker shade of the page's own background, so the strip reads as part
     * of the site rather than as a foreign grey bar -- but darker, because
     * Kate's minimap sits on the editor's background and the marks are the
     * text's own colours, and a page's text colours are chosen against the
     * page, not against our strip.
     *
     * Which is why the marks are then forced to contrast. A dark grey that is
     * perfectly legible in a light article vanishes against a dark strip.
     */
    setAppearance({ mapBackground, markContrast, darkenAmount }) {
      this._mapBackgroundPref = mapBackground || "";
      this.markContrast = Number(markContrast) || 3;
      this._darkenAmount = darkenAmount == null ? 0.82 : Number(darkenAmount);
      this.resolveColours();
    }

    resolveColours() {
      const pageRgb = parseRgb(this.background) || [255, 255, 255];
      const chosen = parseRgb(this._mapBackgroundPref);
      this.mapBackground = chosen
        ? `rgb(${chosen.join(",")})`
        : `rgb(${darken(pageRgb, this._darkenAmount).join(",")})`;

      const bg = chosen || darken(pageRgb, this._darkenAmount);
      this._mapBackgroundRgb = bg;
      this.markColours.clear();
      for (const line of this.lines) {
        if (this.markColours.has(line.color)) continue;
        const rgb = parseRgb(line.color);
        if (!rgb) continue;
        const fixed = ensureContrast(rgb, bg, this.markContrast);
        this.markColours.set(
          line.color,
          `rgb(${fixed.join(",")})`,
        );
      }
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
      const size = parseFloat(cs.fontSize) || 16;
      const style = simpleMode
        ? {
            color: cs.color,
            family: cs.fontFamily,
            fontSize: size,
            bold: false,
            italic: false,
          }
        : {
            color: cs.color,
            family: cs.fontFamily,
            fontSize: size,
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
            ctx.fillStyle = this.markColours.get(line.color) || line.color;
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

      // The map always spans the full groove.
      //
      // Kate does not do this. It uses
      //   docHeight = min(grooveHeight, pixmapHeight * 2) - 2
      // so a document with few lines gets a short map occupying only the top
      // of the groove. That is invisible in a text editor, where a file has
      // thousands of lines and pixmapHeight lands near grooveHeight anyway --
      // but Kate's own scrollbar slider spans the full groove while its map and
      // its preview both use the compressed rect, so even there the two
      // disagree whenever the clamp bites.
      //
      // On the web the clamp always bites. A 2200px article has about 60 line
      // boxes, so the map was being squeezed into 124px of a 682px groove:
      // the map, the fade band, the thumb and the preview's document offset
      // were four different coordinate systems in one 60px widget. Filling the
      // groove is what makes it a scrollbar minimap rather than a density
      // sketch.
      const docTop = DOC_X_MARGIN;
      const docHeight = grooveHeight - 2 * DOC_X_MARGIN;

      // The band is read off the real thumb. vugluscr clamps the thumb to
      // MIN_THUMB_HEIGHT = 20 so it stays grabbable, which Kate's formula has
      // no equivalent of -- on a long page the two would differ by 10px of
      // height. Reading the thumb is one rect per frame, and we are already
      // repainting a canvas that costs far more than that.
      const band = this.thumbBand(docTop, docHeight, scrollTop, viewportHeight);
      this.lastBand = band;

      // Where the map was actually drawn. The canvas is always full height --
      // it is filled with the page background first -- so "does the map reach
      // the bottom" cannot be answered by looking at the canvas. Published so
      // the alignment test can assert the drawn rect instead.
      const rectKey = `${Math.round(docTop)}:${Math.round(docHeight)}`;
      if (rectKey !== this._rectKey) {
        this._rectKey = rectKey;
        this.canvas.dataset.docRect = JSON.stringify({
          top: Math.round(docTop), height: Math.round(docHeight),
        });
      }
      // Published for the alignment test and for debugging a site where the
      // indicators look wrong. Only touched when it moves, because paint()
      // runs on every scroll frame.
      const key = `${Math.round(band.top)}:${Math.round(band.height)}`;
      if (key !== this._bandKey) {
        this._bandKey = key;
        this.canvas.dataset.band = JSON.stringify({
          top: Math.round(band.top), height: Math.round(band.height),
        });
      }

      // The strip's own background, a darker shade of the page's by default.
      // Kate fills with the editor background, which is the right idea: the
      // marks are text colours, so they need a background their text was
      // chosen against, and a page's is the one its own text was chosen for.
      ctx.fillStyle = this.mapBackground;
      ctx.fillRect(0, 0, this.width, grooveHeight);

      // Stretch the pixmap over the whole groove.
      const contentW = this.pixmapLineWidth - S_PIXEL_MARGIN;
      if (contentW > 0) {
        ctx.drawImage(
          this.pixmap,
          S_PIXEL_MARGIN, 0, contentW, this.pixmapLineCount,
          DOC_X_MARGIN, docTop, this.width - DOC_X_MARGIN, docHeight,
        );
      }

      // Fade what is not currently visible. Kate: backgroundColor at alpha 110.
      const fade = withAlpha(this.mapBackground, 110);
      ctx.fillStyle = fade;
      if (band.top > 0) ctx.fillRect(0, 0, this.width, band.top);
      if (band.top + band.height < grooveHeight) {
        ctx.fillRect(0, band.top + band.height, this.width,
          grooveHeight - band.top - band.height);
      }

      // Kate's thin line limiting the scrollbar.
      ctx.fillStyle = withAlpha(this.mapBackground, 255);
      ctx.fillRect(0, 0, 1, grooveHeight);

      // Kate also draws a delimiter at the bottom of the map, which only has
      // somewhere to go because his map can be shorter than the groove. Ours
      // always reaches the bottom, so there is nothing to delimit.
    }

    /** The viewport band, taken from the thumb's real position. */
    thumbBand(docTop, docHeight, scrollTop, viewportHeight) {
      if (this.thumbEl && this.thumbEl.isConnected) {
        const thumb = this.thumbEl.getBoundingClientRect();
        const strip = this.thumbEl.parentElement?.getBoundingClientRect();
        if (strip && strip.height > 0 && thumb.height > 0) {
          const top = (thumb.top - strip.top) / strip.height * this.height;
          const height = (thumb.height / strip.height) * this.height;
          return {
            top: Math.max(0, Math.min(this.height, top)),
            height: Math.max(1, Math.min(this.height, height)),
          };
        }
      }
      // Before the thumb is laid out, fall back to the plain proportion.
      const max = Math.max(this.docHeight - viewportHeight, 1);
      const top = (scrollTop / max) * docHeight;
      const height = (viewportHeight / this.docHeight) * docHeight;
      return { top: docTop + top, height: Math.max(1, height) };
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

  /**
   * Relative luminance, per WCAG.
   *
   * Used to decide whether a mark is legible against the map's background. The
   * minimap's marks are the page's own text colours, which are chosen to be
   * legible against the page's background -- not against the strip's. On a
   * light page the strip is darker than the page, so a dark grey mark that
   * reads perfectly well in the article disappears in the map.
   */
  function luminance(rgb) {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** WCAG contrast ratio, 1 to 21. */
  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  }

  /** Parse a computed colour to [r,g,b], or null if it is not a plain colour. */
  function parseRgb(color) {
    const m = /^rgba?\(([^)]+)\)$/.exec((color || "").trim());
    if (!m) return null;
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return parts.slice(0, 3);
  }

  /** Mix towards black by `amount`, which is what the default background is. */
  function darken(rgb, amount) {
    return rgb.map((v) => Math.round(v * (1 - amount)));
  }

  /**
   * Nudge a colour along the lightness axis until it contrasts with `bg`.
   *
   * Moving towards whichever of black or white is further from the background
   * keeps the hue, so a link stays link-coloured and a heading stays
   * heading-coloured -- only its lightness changes. Returns the input
   * unchanged if the target cannot be met, which happens for mid-greys
   * against a mid-grey background.
   */
  function ensureContrast(rgb, bg, target) {
    if (contrast(rgb, bg) >= target) return rgb;
    const bgL = luminance(bg);
    const towardsWhite = bgL < 0.5;
    let best = rgb;
    for (let step = 0; step <= 20; step++) {
      const t = towardsWhite ? step / 20 : 1 - step / 20;
      const candidate = towardsWhite
        ? rgb.map((v, i) => Math.round(v + (255 - v) * t))
        : rgb.map((v) => Math.round(v * (1 - t)));
      if (contrast(candidate, bg) >= target) return candidate;
      best = candidate;
    }
    return best;
  }

  /**
   * Describe an element for the preview.
   *
   * The preview clones these into the page rather than rasterising them, so
   * there is nothing to cache and nothing to load: an inline <svg> cloned
   * into this document keeps the page's own styling, which is what most icon
   * systems rely on. A serialised data URL does not, and its image load
   * cannot be relied on to settle from a content script.
   */
  function makeBox(el, rect, scrollX, scrollY) {
    return {
      el,
      x: rect.left + scrollX,
      y: rect.top + scrollY,
      width: rect.width,
      height: rect.height,
      kind: el.tagName,
    };
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
