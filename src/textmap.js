// ScrollPeak — the minimap renderer.
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
// Where the web forced a change, it is noted at the point of change. There are
// two. One: Kate can ask a syntax highlighter for each character's colour,
// whereas a page only exposes colour per element, so a "line" here is a line
// box of a single text node rather than a line of arbitrary mixed colour. A
// paragraph with a link in it therefore becomes two runs, which is more
// faithful to the page, not less. Two, beyond the port: a short page does not
// have enough lines to make a raster, so the map switches to semantic blocks
// when it is zoomed in past the point where characters read as text. See
// #wantsBlocks() and #collectBlocks(). On a long document nothing changes.

(function () {
  // All the colour maths lives in colour.js, shared with the options page so
  // the swatch there shows the colour the strip will actually be.
  const {
    parseRgb, resolveColor, ensureContrast, withAlpha, resolveStripBackground,
  } = globalThis.ScrollPeakColour;

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

  // Beyond the port: when the map is stretched so far that a text line would
  // occupy more than this many pixels of the groove, the raster stops reading
  // as text and turns into blobs. Below that much zoom the map draws semantic
  // blocks instead. See collectBlocks().
  const BLOCK_MIN_LINE_PX = 4;

  // And when the text is spread wider than this fraction of the viewport, it
  // is not one column: the raster draws every line from the left margin by
  // design, so the extremes -- a watch page with its sidebar -- become rows
  // of unrelated fragments. Measured: YouTube's watch page 0.88, GitHub's
  // repository page 0.67 (its file list still reads as text, so it stays on
  // the raster), Wikipedia 0.44, a single-column article 0.03.
  const BLOCK_SPREAD_FRACTION = 0.75;

  // What stays a text block when the map sweeps the page: the boxes a person
  // navigates by. Links, images and form controls are drawn as themselves; an
  // element that paints a background, a border or a background image becomes a
  // box outline in its own colour; anything else -- a transparent wrapper --
  // has nothing to say in a map and stays out.
  const BLOCK_TEXT_TAGS = new Set([
    "P", "LI", "DT", "DD", "H1", "H2", "H3", "H4", "H5", "H6",
    "BLOCKQUOTE", "PRE", "FIGCAPTION", "CAPTION", "TD", "TH",
    "SUMMARY", "LABEL", "OUTPUT",
  ]);

  // -------------------------------------------------------------- the media
  //
  // A page whose content is pictures does not rasterise: the raster spreads a
  // player's badges and a card's title into unrelated fragments, so those
  // pages choose the block renderer instead. See #isMediaPage(); the old
  // native-scrollbar fallback this replaced was removed because the blocks
  // read well once every painted element is drawn.
  //
  // Thresholds measured across real pages. YouTube's watch page has a 797x598
  // player; Reddit's front page is 38 large pictures covering 56% of the
  // document and BBC's front 43 covering 33%. Wikipedia's infobox holds a
  // 250x141 video thumbnail and GitHub has one large picture at 2%: both keep
  // the raster. The top-of-page rule below catches eBay and Amazon, whose
  // long documents dilute any fraction.
  const MEDIA_VIDEO_MIN_W = 300;
  const MEDIA_VIDEO_MIN_H = 150;
  const MEDIA_IMAGE_MIN_W = 200;
  const MEDIA_IMAGE_MIN_H = 100;
  const MEDIA_IMAGE_COUNT = 12;
  const MEDIA_IMAGE_AREA_FRACTION = 0.35;
  // A picture shelf near the top of the page does not have to cover the whole
  // document to drown the raster, and a long document dilutes any
  // whole-document fraction. Measured at 1440x814 over the first two
  // viewports: eBay 19 pictures, YouTube 7, Amazon's search list 5;
  // Wikipedia 2, GitHub 0.
  const MEDIA_TOP_MIN_W = 120;
  const MEDIA_TOP_MIN_H = 80;
  const MEDIA_TOP_COUNT = 5;
  const MEDIA_TOP_VIEWPORTS = 2;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE",
    "CANVAS", "IFRAME", "OBJECT", "EMBED", "SVG",
  ]);

  // What the block renderer draws as a control rather than as text.
  const CONTROL_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON"]);

  // Firefox's default control colours, measured on an unstyled form (156):
  // ButtonFace and ButtonBorder. Used when the control itself paints neither
  // -- a checkbox, radio or slider is drawn by the browser and reports a
  // transparent background and no border.
  const CONTROL_FACE = [233, 233, 237];
  const CONTROL_BORDER = [143, 143, 157];

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
      /**
       * Semantic blocks, collected instead of the text raster when the map is
       * too zoomed for the raster to read. See collectBlocks().
       */
      this.blocks = [];
      this.blockMode = false;
      this.blockLeft = 0;
      this.blockRight = 0;
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

      // None, any more. The preview used to be assembled from collected
      // graphics and text runs, and these were the graphics. It is now a clone
      // of the page, laid out by the browser, so the collection is dead weight
      // -- and it was not cheap: a querySelectorAll("*") plus a
      // getComputedStyle for every element on every rebuild, to produce
      // something nothing read. The map itself stays text-only, which is
      // faithful to Kate.
      this.boxes = [];

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

      // Which renderer this revision gets is decided by the page: a handful
      // of line boxes stretched over a tall groove is not text any more, and
      // neither is a page of pictures. See #wantsBlocks().
      this.blockMode = this.#wantsBlocks();
      if (this.blockMode) {
        this.#collectBlocks(root, scrollX, scrollY, maxY);
        // A page with nothing block-shaped (rare) reads better as text.
        this.blockMode = this.blocks.length > 0;
      } else {
        this.blocks = [];
      }

      this.revision++;
      return lines;
    }

    /** Is the map stretched past the point where the raster reads as text? */
    #wantsBlocks() {
      // A page whose content is pictures is block-shaped however its text
      // falls, and a player or a card grid has no single column for the
      // raster to draw. See #isMediaPage().
      if (this.#isMediaPage()) return true;
      // One text line per BLOCK_MIN_LINE_PX of groove, or fatter. The height
      // guard keeps a tiny map from flipping modes on rounding.
      if (this.height >= 40 && this.lines.length > 0 &&
          this.lines.length * BLOCK_MIN_LINE_PX < this.height) {
        return true;
      }
      return this.#spreadFraction() > BLOCK_SPREAD_FRACTION;
    }

    /**
     * Is this page one whose content is pictures?
     *
     * A player is decisive: on a watch page the video *is* the content.
     * Otherwise a field of large pictures, either many of them covering a
     * real share of the document or a shelf of them in the first screen or
     * two, where they are what the visitor landed on. Only pictures are
     * measured, and only their rects; a text page with a few images pays
     * almost nothing.
     *
     * Fixed and sticky subtrees are ignored (see #isStuck): a lightbox or a
     * media viewer is not the page's content, and a page must not change its
     * renderer -- or worse, lose its rail -- because one opened.
     */
    #isMediaPage() {
      for (const el of document.querySelectorAll("video")) {
        const r = el.getBoundingClientRect();
        if (r.width < MEDIA_VIDEO_MIN_W || r.height < MEDIA_VIDEO_MIN_H) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility !== "visible") continue;
        if (this.#isStuck(el)) continue;
        return true;
      }

      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = window.innerHeight || 1;
      const scroller = document.scrollingElement || document.documentElement;
      const docArea = Math.max(1, scroller.scrollHeight * vw);
      const topLimit = vh * MEDIA_TOP_VIEWPORTS;
      let count = 0;
      let area = 0;
      let topCount = 0;
      for (const el of document.querySelectorAll("img, canvas, iframe")) {
        const r = el.getBoundingClientRect();
        if (r.width < MEDIA_TOP_MIN_W || r.height < MEDIA_TOP_MIN_H) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" ||
            cs.visibility === "collapse" || this.#isStuck(el)) {
          continue;
        }
        if (r.width >= MEDIA_IMAGE_MIN_W && r.height >= MEDIA_IMAGE_MIN_H) {
          count++;
          area += r.width * r.height;
        }
        if (r.top < topLimit && r.bottom > 0) {
          topCount++;
          if (topCount >= MEDIA_TOP_COUNT) return true;
        }
      }
      return count >= MEDIA_IMAGE_COUNT && area > docArea * MEDIA_IMAGE_AREA_FRACTION;
    }

    /**
     * How wide is the text, as a fraction of the viewport?
     *
     * The 10th to 90th percentile of line x, so a single stray line does not
     * decide it. Sampled when the document is very long, because this runs on
     * every collect and the sort is the only cost.
     */
    #spreadFraction() {
      const n = this.lines.length;
      if (n < 12) return 0;
      const step = n > 4000 ? 3 : 1;
      const xs = [];
      for (let i = 0; i < n; i += step) xs.push(this.lines[i].x);
      xs.sort((a, b) => a - b);
      const low = xs[Math.floor(xs.length * 0.1)];
      const high = xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))];
      const width = document.documentElement.clientWidth || window.innerWidth;
      return (high - low) / Math.max(1, width);
    }

    /**
     * The elements worth drawing as blocks, in document coordinates.
     *
     * This is the one pass that reads the page as elements rather than text,
     * and it only runs when the map is not a raster: on a long single-column
     * document the raster looks better and this sweep is skipped entirely, so
     * the cost of a per-element getBoundingClientRect never lands on the
     * pages that do not need it.
     *
     * Every element is considered, not a document vocabulary: app-shaped
     * pages are made of divs and custom elements, and a block list that only
     * knows paragraphs and lists leaves a shop page's cards invisible. An
     * element that paints something -- a background, a border, a background
     * image -- becomes a box drawn as an outline in its own colour; a box
     * that paints the page background itself is left out (drawing it would
     * flood the strip and mislead everything drawn over it, and the strip
     * already is the page's background). Text areas, links, images and
     * controls are classified as before.
     *
     * Links use their line fragments rather than one bounding box, so a link
     * that wraps is two blue bars instead of a rectangle covering the text
     * between them. Images are atomic. Form controls keep their own field or
     * face colour and their border, so a checkbox or a slider reads as a
     * control rather than as another bar of text.
     */
    #collectBlocks(root, scrollX, scrollY, maxY) {
      const blocks = [];
      const pageRgb = opaqueRgb(this.background);
      for (const el of root.querySelectorAll("*")) {
        if (el.closest(".vugluscr, .scrollpeak-magnifier, .scrollpeak-map")) {
          continue;
        }
        const tag = el.tagName;
        if (SKIP_TAGS.has(tag)) continue;
        const cs = getComputedStyle(el);
        if (
          cs.display === "none" ||
          cs.visibility === "hidden" || cs.visibility === "collapse" ||
          this.#isStuck(el)
        ) {
          continue;
        }

        let kind = (tag === "IMG" || tag === "VIDEO") ? "image"
          : (tag === "A" && el.hasAttribute("href")) ? "link"
          : CONTROL_TAGS.has(tag) ? "control"
          : BLOCK_TEXT_TAGS.has(tag) ? "text"
          : null;

        // A control's own colours, as the browser paints it: the field or
        // button face, and the border. A natively drawn widget -- checkbox,
        // radio, slider -- reports neither, because the browser paints those
        // itself, so those fall back to Firefox's defaults in #paintBlocks().
        // Strings, not parsed triples: the painter parses them again, the
        // same way it does for a link's colour.
        let face = kind === "control" && opaqueRgb(cs.backgroundColor)
          ? cs.backgroundColor
          : null;
        let border = kind === "control" && cs.borderTopStyle !== "none" &&
          opaqueRgb(cs.borderTopColor)
          ? cs.borderTopColor
          : null;

        if (kind === null) {
          // Strings, like every other kind: the painter parses them again.
          // The parsed triple is only for the page-background comparison.
          const boxRgb = opaqueRgb(cs.backgroundColor);
          face = boxRgb ? cs.backgroundColor : null;
          if (boxRgb && pageRgb && sameColour(boxRgb, pageRgb)) face = null;
          border = cs.borderTopStyle !== "none" &&
            parseFloat(cs.borderTopWidth) > 0 && opaqueRgb(cs.borderTopColor)
            ? cs.borderTopColor
            : null;
          const hasImage = cs.backgroundImage !== "none";
          if (!face && !border && !hasImage) continue;
          kind = "box";
        }

        const rects = kind === "link"
          ? Array.from(el.getClientRects())
          : [el.getBoundingClientRect()];

        for (const r of rects) {
          if (r.width < 1 || r.height < 1) continue;
          if (kind === "box" && (r.width < 2 || r.height < 2)) continue;
          const y = r.top + scrollY;
          if (y + r.height < 0 || y > maxY) continue;
          blocks.push({
            x: r.left + scrollX,
            y,
            w: r.width,
            h: r.height,
            kind,
            colour: kind === "link" ? cs.color : face,
            border,
          });
        }
      }

      // Boxes first, then text over them, then controls, links and image
      // outlines on top of everything.
      const order = { box: 0, text: 1, control: 2, link: 3, image: 4 };
      blocks.sort((a, b) => order[a.kind] - order[b.kind]);

      this.blocks = blocks;
      let left = Infinity;
      let right = -Infinity;
      for (const b of blocks) {
        if (b.x < left) left = b.x;
        if (b.x + b.w > right) right = b.x + b.w;
      }
      this.blockLeft = blocks.length ? left : 0;
      this.blockRight = blocks.length ? right : 1;
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
    setAppearance({ mapBackground, markContrast, darkenAmount, theme } = {}) {
      this._mapBackgroundPref = mapBackground || "";
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

      // The page's own text colours, each one nudged until it reads against
      // the strip. That is the reason a heading looks different from body
      // text in the map; a page chose those colours, and they are better than
      // anything we would pick.
      this.markColours.clear();
      for (const line of this.lines) {
        if (this.markColours.has(line.color)) continue;
        const rgb = parseRgb(line.color);
        if (!rgb) continue;
        const fixed = ensureContrast(rgb, bg, this.markContrast);
        this.markColours.set(line.color, `rgb(${fixed.join(",")})`);
      }

      // One palette for everything the rail draws, so the strip, the thumb
      // and the rail's own chrome cannot end up in three different colour
      // schemes. `ink` is a colour that reads against the strip.
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

      // Which renderer drew this map, and for blocks, what it had to work
      // with. Published for the block test and the site probe.
      let modeKey = "text";
      let counts = null;
      if (this.blockMode) {
        counts = { box: 0, text: 0, control: 0, link: 0, image: 0 };
        for (const b of this.blocks) counts[b.kind]++;
        modeKey = `blocks:${JSON.stringify(counts)}:` +
          `${Math.round(this.blockLeft)}:${Math.round(this.blockRight)}`;
      }
      if (modeKey !== this._modeKey) {
        this._modeKey = modeKey;
        this.canvas.dataset.mode = this.blockMode ? "blocks" : "text";
        if (counts) {
          this.canvas.dataset.blocks = JSON.stringify(counts);
          this.canvas.dataset.blockSpan = JSON.stringify({
            left: Math.round(this.blockLeft),
            right: Math.round(this.blockRight),
          });
        } else {
          delete this.canvas.dataset.blocks;
          delete this.canvas.dataset.blockSpan;
        }
      }

      const rectKey = `${Math.round(docTop)}:${Math.round(docHeight)}`;
      if (rectKey !== this._rectKey) {
        this._rectKey = rectKey;
        this.canvas.dataset.docRect = JSON.stringify({
          top: Math.round(docTop), height: Math.round(docHeight),
        });
      }
      // The document height the blocks were collected against, published for
      // the tests: a probe comparing live page rects with drawn ones needs to
      // know whether the map is stale.
      const dhKey = String(Math.round(this.docHeight));
      if (dhKey !== this._dhKey) {
        this._dhKey = dhKey;
        this.canvas.dataset.docHeight = dhKey;
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

      // Stretch the pixmap over the whole groove, or, when the map is too
      // zoomed for the raster to read as text, draw the semantic blocks.
      if (this.blockMode) {
        this.#paintBlocks(docTop, docHeight);
      } else {
        const contentW = this.pixmapLineWidth - S_PIXEL_MARGIN;
        if (contentW > 0) {
          ctx.drawImage(
            this.pixmap,
            S_PIXEL_MARGIN, 0, contentW, this.pixmapLineCount,
            DOC_X_MARGIN, docTop, this.width - DOC_X_MARGIN, docHeight,
          );
        }
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

    /**
     * The block renderer: text areas as contrast fills, links in their own
     * colour, images as hollow outlines, controls as boxes in their own
     * field, face and border colours, and every other painted element as an
     * outline in its own colour.
     *
     * Like the raster, this maps document coordinates onto the drawn rect, so
     * the viewport band and the preview's document offsets still line up with
     * what is drawn. The horizontal span is the blocks' own extent rather
     * than the viewport's, so a page with a sidebar or a narrow column still
     * uses the whole strip instead of a sliver of it.
     */
    #paintBlocks(docTop, docHeight) {
      const ctx = this.ctx;
      const span = Math.max(1, this.blockRight - this.blockLeft);
      const stripW = Math.max(1, this.width - 2 * DOC_X_MARGIN);
      const ink = this.palette.ink;
      const bgRgb = this._mapBackgroundRgb;

      for (const b of this.blocks) {
        const x = DOC_X_MARGIN + ((b.x - this.blockLeft) / span) * stripW;
        const w = Math.max(1, (b.w / span) * stripW);
        const y = docTop + (b.y / this.docHeight) * docHeight;
        const h = Math.max(1, (b.h / this.docHeight) * docHeight);

        if (b.kind === "box") {
          // A painted panel, drawn as an outline in its own colour. A fill
          // would sit under the text blocks and either hide them or fight
          // them for contrast; what a map needs from a card is where its
          // edges are. The outline is the box's own background colour, or
          // its border's when the background is the page's own. parseRgb
          // takes a string; a box may carry neither colour.
          const rgb = ensureContrast(
            (b.colour && parseRgb(b.colour)) ||
            (b.border && parseRgb(b.border)) || [128, 128, 128],
            bgRgb, this.markContrast);
          ctx.strokeStyle = `rgb(${rgb.join(",")})`;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
        } else if (b.kind === "link") {
          // The page's own link colour, pushed to contrast with the strip the
          // same way the text raster pushes its marks: a link stays
          // link-coloured and readable on any strip.
          const rgb = ensureContrast(
            parseRgb(b.colour) || [59, 110, 165], bgRgb, this.markContrast);
          ctx.fillStyle = `rgb(${rgb.join(",")})`;
          ctx.fillRect(x, y, w, h);
        } else if (b.kind === "control") {
          // A control is the browser's own field or button face, outlined
          // with its own border -- or Firefox's defaults when the browser
          // paints the widget itself and reports neither. Both colours are
          // pushed to contrast: the face against the strip, the border
          // against the face, so a control stays a visible box on any strip
          // instead of merging into the text around it.
          const face = ensureContrast(
            parseRgb(b.colour) || CONTROL_FACE, bgRgb, this.markContrast);
          const border = ensureContrast(
            parseRgb(b.border) || CONTROL_BORDER, face, this.markContrast);
          ctx.fillStyle = `rgb(${face.join(",")})`;
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = `rgb(${border.join(",")})`;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
        } else if (b.kind === "image") {
          // Hollow, so it reads as a picture rather than as another block of
          // text. The hole is painted first because an image inside a
          // paragraph is covered by the paragraph's fill.
          ctx.fillStyle = this.mapBackground;
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = ink;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
        } else {
          ctx.fillStyle = ink;
          ctx.fillRect(x, y, w, h);
        }
      }
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
  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  /** 5th-percentile x, so a single far-left outlier cannot shift the column. */
  function contentLeft(lines) {
    const xs = lines.map((l) => l.x).sort((a, b) => a - b);
    if (!xs.length) return 0;
    return xs[Math.floor(xs.length * 0.05)] || 0;
  }

  /**
   * parseRgb, but null when the colour is fully transparent.
   *
   * A control with no background of its own computes to `rgba(0, 0, 0, 0)`,
   * and parseRgb ignores alpha, so without this a checkbox would be painted
   * black. Semi-transparent counts as painted, the same reading as
   * pageBackground().
   */
  function opaqueRgb(value) {
    const rgb = parseRgb(value);
    if (!rgb) return null;
    const alpha = /rgba?\([^)]*?,\s*([\d.]+)\s*\)$/.exec(value || "");
    // The regex matches the last component of rgb() too, where it is the
    // blue channel; only an exact 0 matters, and blue 0 is not transparency.
    if (alpha && Number(alpha[1]) === 0) return null;
    return rgb;
  }

  /**
   * Is this parsed colour the page background itself, or near enough?
   *
   * The threshold is small but not zero: the same colour written as rgb() and
   * as #rrggbb parses identically, but a hand-picked near-white page often
   * differs by a step or two. A box that paints the page background is the
   * page, not a mark on it; see #collectBlocks().
   */
  function sameColour(a, b) {
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) +
      Math.abs(a[2] - b[2]) <= 24;
  }

  function renderedText(slice) {
    return slice.replace(/\s+/g, " ").replace(/ +$/, "");
  }

  globalThis.ScrollPeakTextMap = { TextMap, REBUILD_DELAY_MS, S_PIXEL_MARGIN };
})();
