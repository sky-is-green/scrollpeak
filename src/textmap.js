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
  // All the colour maths lives in colour.js, shared with the options page so
  // the swatch there shows the colour the strip will actually be.
  const {
    parseRgb, resolveColor, ensureContrast, withAlpha, resolveStripBackground,
  } = globalThis.ScrollPeekColour;

  /**
   * Memo of element -> is it out of the document's flow.
   *
   * Per document rather than per TextMap: the answer depends only on the page,
   * and a rebuild must not pay for it twice.
   */
  const STUCK = new Map();

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
      this._mapBackgroundRgb = [255, 255, 255];
      this.markContrast = 3;
      /** The browser theme palette, once resolved. See resolveColours(). */
      this.theme = null;
      /** Everything the rail draws, resolved to one scheme. */
      this.palette = { background: "#ffffff", ink: "#ffffff", accent: null, source: "?" };
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
          const raw = text.slice(bounds[i], bounds[i + 1]);
          if (!raw.trim()) continue;
          lines.push({
            y: rects[i].top + scrollY,
            height: rects[i].height,
            x: rects[i].left + scrollX,
            text: style.preserve ? raw : renderedText(raw),
            color: style.color,
            family: style.family,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            fontStyle: style.fontStyle,
            letterSpacing: style.letterSpacing,
            wordSpacing: style.wordSpacing,
            textTransform: style.textTransform,
            fontStretch: style.fontStretch,
            fontKerning: style.fontKerning,
            fontVariant: style.fontVariant,
            fontFeatureSettings: style.fontFeatureSettings,
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
      this.background = this.pageBackground();
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
        // Same rule as the text pass: a fixed or sticky element has no
        // document position, so a box for it would be placed at a guess.
        if (this.#isStuck(el)) return;
        seen.add(el);

        // The background as *computed*, carried onto the clone.
        //
        // A clone keeps the element's classes, which is enough for a rule that
        // matches the element itself -- but not for one that matches its place
        // in the document. Wikipedia colours its version rows with a rule on the
        // row, so a <td> cloned out of its table has no colour at all: the
        // preview showed five identical white rows where the page has green,
        // amber and red ones. Reading the computed value sidesteps the question
        // of which selector produced it.
        const cs = getComputedStyle(el);
        const paint = {
          bg: isPainted(cs.backgroundColor) ? cs.backgroundColor : null,
          image: cs.backgroundImage !== "none" ? cs.backgroundImage : null,
          size: cs.backgroundSize,
          position: cs.backgroundPosition,
          repeat: cs.backgroundRepeat,
        };

        const rects = Array.from(el.getClientRects()).filter(
          (r) => r.width > 0.5 && r.height > 0.5,
        );
        for (const rect of rects) {
          if (rect.width < 1 || rect.height < 1) continue;
          found.push(makeBox(el, rect, scrollX, scrollY, paint));
        }
      };

      // Media elements and inline SVG draw directly onto a canvas.
      for (const el of root.querySelectorAll(
        "img, svg, canvas, video, picture img, object, embed",
      )) {
        if (found.length >= MAX_BOXES) break;
        consider(el);
      }

      // Backgrounds: images and colours.
      //
      // Kate has neither. His preview draws text on the editor background, and
      // for a text editor that is the whole of it. On a web page a background
      // carries meaning a text-only preview throws away -- on Wikipedia's
      // version history table the row colour is what says which release is
      // current, and the preview showed five identical rows of black text.
      //
      // The page's own background is excluded: html/body would otherwise cover
      // the whole region, and the preview already paints the page's background
      // behind everything. Anything as large as the viewport in both axes is
      // the same thing in a wrapper, so it goes too; a page-level wrapper's
      // colour is the page background under another name.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      for (const el of root.querySelectorAll("*")) {
        if (found.length >= MAX_BOXES) break;
        if (el === document.body || el === document.documentElement) continue;
        if (seen.has(el)) continue;
        const cs = getComputedStyle(el);
        const hasImage = cs.backgroundImage && cs.backgroundImage !== "none";
        if (!hasImage && !isPainted(cs.backgroundColor)) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= vw && r.height >= vh) continue;
        consider(el);
      }

      return found;
    }


    /**
     * Settings that affect how the strip is coloured.
     *
     * Both colours are CSS colours, or "" for the default. Anything the CSS
     * parser accepts is accepted here; see resolveColor().
     *
     * `theme` is the palette the background resolved from the installed Firefox
     * theme, or null. See resolveColours().
     */
    setAppearance({ mapBackground, markColour, markContrast, darkenAmount, theme } = {}) {
      this._mapBackgroundPref = mapBackground || "";
      this._markColourPref = markColour || "";
      this.markContrast = Number(markContrast) || 3;
      this._darkenAmount = darkenAmount == null ? 0.82 : Number(darkenAmount);
      this.theme = theme || null;
      this.resolveColours();
    }

    /**
     * Is this element not actually on screen, or not in the document's flow?
     *
     * Two different reasons, one walk, because both mean "we cannot say where
     * this belongs":
     *
     * **Out of flow.** `position: fixed` and `position: sticky` report a
     * viewport-relative rect: fixed content does not scroll at all, and sticky
     * content is reported where it is stuck rather than where it would flow. We
     * convert rects to document coordinates by adding scrollY, so for either of
     * them the result is wrong -- and rather than spreading out, they pile up at
     * that wrong position.
     *
     * **Not displayed.** `getClientRects()` still returns a rect for content
     * hidden with `visibility: hidden` or `opacity: 0`, unlike `display: none`.
     * Wikipedia hides its collapsed menus and its unpinned sidebars that way,
     * so the page tools -- "Printable version", "In other projects",
     * "Wikidata item", "Wikimedia Commons" -- were mapped from inside a
     * collapsed dropdown and landed on top of the infobox. Measured on the
     * page: `.vector-dropdown-content` is `display:block`, `visibility:hidden`,
     * `opacity:0`, and reports one rect.
     *
     * `visibility` is inherited and can be overridden back to `visible` by a
     * descendant, so the element's own computed value is the authoritative
     * answer for it and #styleFor() checks that directly. `opacity` and
     * `content-visibility` are not inherited, so they are checked here.
     *
     * Kate's minimap has no analogue of any of this, because a text editor's
     * document contains no fixed, hidden or collapsed UI.
     */
    #isStuck(el) {
      const chain = [];
      let result = false;
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const hit = STUCK.get(n);
        if (hit !== undefined) {
          result = hit;
          break;
        }
        chain.push(n);
        const cs = getComputedStyle(n);
        const pos = cs.position;
        if (
          pos === "fixed" || pos === "sticky" ||
          cs.opacity === "0" || cs.contentVisibility === "hidden"
        ) {
          result = true;
          break;
        }
      }
      // Cache the *answer* for every node walked, not "is this node itself out
      // of flow". The answer is inherited: a node inside a hidden or sticky
      // container is in the same state, so the whole chain shares it.
      //
      // Caching the per-node fact instead -- as this first did -- makes the walk
      // stop at the first ancestor a previous call happened to visit and return
      // that ancestor's false without ever reaching the hidden container above
      // it. That is exactly what happened: the collapsed menus were still
      // mapped, at their stuck viewport position.
      for (const n of chain) STUCK.set(n, result);
      return result;
    }

    /**
     * The page's own background, or null if it has none.
     *
     * Read from <body> alone this is wrong more often than it is right: a body
     * background is transparent by default, and plenty of sites set the
     * background on <html>, or on a full-bleed wrapper. Walking up to the
     * first ancestor that actually paints one is what a person means by "the
     * page's background", and it is what the default strip colour is derived
     * from.
     */
    pageBackground() {
      for (let el = document.body; el; el = el.parentElement) {
        const value = getComputedStyle(el).backgroundColor;
        const rgb = parseRgb(value);
        if (!rgb) continue;
        // Fully transparent contributes nothing; semi-transparent is the page
        // really painting, so it counts.
        const alpha = /rgba?\([^)]*?,\s*([\d.]+)\s*\)$/.exec(value || "");
        if (alpha && Number(alpha[1]) === 0) continue;
        return `rgb(${rgb.join(",")})`;
      }
      return null;
    }

    /**
     * Work out the strip's background, and a legible colour for every mark.
     *
     * The background comes from colour.js, which the options page also calls,
     * so the swatch it shows is the colour the strip will actually be.
     *
     * The marks are then forced to contrast with whatever came out, because
     * they are the page's text colours and those were chosen against the page,
     * not against our strip.
     */
    resolveColours() {
      const strip = resolveStripBackground({
        chosen: this._mapBackgroundPref,
        theme: this.theme?.base,
        page: this.background,
        // The only thing about the machine a content script can observe:
        // measured, Firefox's own widget colours read light even when
        // ui.systemUsesDarkTheme is 1, and theme.getCurrent() is empty unless
        // a theme is installed.
        systemDark: matchMedia("(prefers-color-scheme: dark)").matches,
        amount: this._darkenAmount,
      });
      const bg = strip.rgb;
      this.paletteSource = strip.source;
      this._mapBackgroundRgb = bg;
      this.mapBackground = `rgb(${bg.join(",")})`;

      // A single colour for every mark, if the user asked for one. Otherwise
      // the page's own, which is Kate's arrangement and the reason a heading
      // reads differently from body text in the strip.
      const forced = resolveColor(this._markColourPref);
      const fixedForced = forced && ensureContrast(forced, bg, this.markContrast);

      this.markColours.clear();
      for (const line of this.lines) {
        if (this.markColours.has(line.color)) continue;
        const rgb = fixedForced || parseRgb(line.color);
        if (!rgb) continue;
        const fixed = ensureContrast(rgb, bg, this.markContrast);
        this.markColours.set(line.color, `rgb(${fixed.join(",")})`);
      }

      // One palette for everything the rail draws, so the strip, the thumb and
      // the markers cannot end up in three different colour schemes. `ink` is a
      // colour that reads against the strip, used for the rail's own chrome.
      const ink = ensureContrast(
        resolveColor(this.theme?.text) || [255, 255, 255],
        bg,
        this.markContrast,
      );
      this.palette = {
        background: this.mapBackground,
        ink: `rgb(${ink.join(",")})`,
        accent: resolveColor(this.theme?.accent) || null,
        source: this.paletteSource,
      };
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
      if (
        cs.display === "none" ||
        cs.visibility === "hidden" || cs.visibility === "collapse" ||
        this.#isStuck(parent)
      ) {
        cache.set(parent, null);
        return null;
      }
      // Kate's simpleMode falls back to the default text colour on very large
      // documents. We do the same, but the real cost saving here is the
      // per-element getComputedStyle, which the cache already dedupes.
      const size = parseFloat(cs.fontSize) || 16;
      // Does this element keep its source whitespace? <pre> and white-space:pre*
      // do, and for those the raw text *is* the rendered text. Everything else
      // collapses runs of whitespace, so the raw text is not.
      const preserve = /^\s*(pre|pre-wrap|pre-line|break-spaces)\s*$/.test(cs.whiteSpace);
      const style = simpleMode
        ? {
            color: cs.color,
            family: cs.fontFamily,
            fontSize: size,
            fontWeight: cs.fontWeight,
            fontStyle: cs.fontStyle,
            ...SHAPING(cs),
            preserve,
          }
        : {
            color: cs.color,
            family: cs.fontFamily,
            fontSize: size,
            fontWeight: cs.fontWeight,
            fontStyle: cs.fontStyle,
            ...SHAPING(cs),
            preserve,
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
      // Published alongside the other diagnostics, and read by the appearance
      // test: the strip colour, the theme it was derived from, and how many
      // distinct mark colours survived. Those are exactly the things that are
      // otherwise invisible until they are wrong.
      //
      // The mark count is read from the resolved palette rather than counted
      // off the canvas, because the pixmap is stretched to the groove and every
      // mark edge is interpolated on the way, so the painted pixels are a
      // spread of blends rather than the colours that were asked for.
      const distinctMarks = new Set(this.markColours.values()).size;
      const palette =
        `${this.mapBackground}|${JSON.stringify(this.theme)}|${distinctMarks}`;
      if (palette !== this._paletteKey) {
        this._paletteKey = palette;
        this.canvas.dataset.palette = palette;
      }

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
      const fade = withAlpha(this._mapBackgroundRgb, 110);
      ctx.fillStyle = fade;
      if (band.top > 0) ctx.fillRect(0, 0, this.width, band.top);
      if (band.top + band.height < grooveHeight) {
        ctx.fillRect(0, band.top + band.height, this.width,
          grooveHeight - band.top - band.height);
      }

      // Kate's thin line limiting the scrollbar.
      ctx.fillStyle = withAlpha(this._mapBackgroundRgb, 255);
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
   * The properties that change a run's advance widths.
   *
   * The preview renders at 0.75 scale in the same font, so its widths must
   * match the page's or two runs on one line drift into each other. These are
   * the ones that move them.
   */
  function SHAPING(cs) {
    return {
      letterSpacing: cs.letterSpacing,
      wordSpacing: cs.wordSpacing,
      textTransform: cs.textTransform,
      fontStretch: cs.fontStretch,
      fontKerning: cs.fontKerning,
      fontVariant: cs.fontVariant,
      fontFeatureSettings: cs.fontFeatureSettings,
    };
  }

  /**
   * The slice of a text node as the browser actually renders it.
   *
   * An HTML text node still holds the newlines and runs of spaces from the
   * source, and the browser collapses each of those to a single space when it
   * lays the line out. The rects in collect() come from that layout, so the
   * slice has to be put back into the same shape -- otherwise the collected
   * line is not the line on screen.
   *
   * This is not cosmetic. The preview draws a run with white-space: pre, so a
   * surviving source newline becomes a real line break: the run spills onto a
   * second line and collides with the run below it, which is what a
   * hard-wrapped HTML source does to every paragraph. Leading and trailing
   * whitespace goes for the same reason -- the browser discards it at a soft
   * wrap, so keeping it would indent every line but the first.
   *
   * Not applied where whitespace is genuinely significant: <pre> and the
   * white-space: pre* values keep their source text, so there the raw slice
   * already is the rendered text.
   */
  function makeBox(el, rect, scrollX, scrollY, paint) {
    return {
      el,
      x: rect.left + scrollX,
      y: rect.top + scrollY,
      width: rect.width,
      height: rect.height,
      kind: el.tagName,
      paint,
    };
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  /**
   * Does this computed background colour actually paint anything?
   *
   * A fully transparent background is what an unstyled element reports, and
   * cloning one would cost a node to draw nothing. A *semi*-transparent one
   * does paint, and is kept: a table row at 20% green is a table row that
   * means something.
   */
  function isPainted(color) {
    const text = (color || "").trim();
    if (!text || text === "transparent") return false;
    if (!parseRgb(text)) return false;
    const alpha = /^rgba?\([^)]*?,\s*([\d.]+)\s*\)$/.exec(text);
    if (alpha) return Number(alpha[1]) > 0;
    const slash = /\/\s*([\d.]+%?)\s*\)$/.exec(text);
    if (slash) {
      const v = slash[1].endsWith("%")
        ? parseFloat(slash[1]) / 100
        : parseFloat(slash[1]);
      return v > 0;
    }
    return true;
  }

  /** 5th-percentile x, so a single far-left outlier cannot shift the column. */
  function contentLeft(lines) {
    const xs = lines.map((l) => l.x).sort((a, b) => a - b);
    if (!xs.length) return 0;
    return xs[Math.floor(xs.length * 0.05)] || 0;
  }

  function renderedText(slice) {
    return slice.replace(/\s+/g, " ").replace(/ +$/, "");
  }

  globalThis.ScrollPeekTextMap = { TextMap, REBUILD_DELAY_MS, S_PIXEL_MARGIN };
})();
