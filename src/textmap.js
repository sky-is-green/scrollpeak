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

  // How many lines either side of the hovered offset the preview looks at
  // when it picks the column to centre. Wide on purpose: narrow enough and
  // the window sits inside one tall table, and the preview centres on the
  // table rather than on the column it is part of.
  const SPAN_WINDOW_LINES = 40;

  // What becomes a block: the boxes a person navigates by. Links and images
  // are drawn as themselves; everything else is a text area.
  const BLOCK_SELECTOR = [
    "p", "li", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "pre", "figcaption", "caption", "td", "th",
    "summary", "button", "label", "a[href]", "img",
  ].join(", ");

  // -------------------------------------------------------------- the media
  //
  // A media page is navigated by its pictures, not by its text, and the two
  // renderers above cannot see that: the raster spreads a badge's label and a
  // title across the strip as unrelated fragments, and the block vocabulary
  // never sees the video or the card containers at all. So media pages get a
  // third renderer whose vocabulary is replaced elements by geometry rather
  // than by tag name: the player, the cards, the embeds. The text renderers
  // are untouched; this one only runs on pages that pass #wantsMedia().
  //
  // Thresholds measured across real pages (chars/px = body text length over
  // document height):
  //
  //   page              video      images >= 200x100   image area   text
  //   YouTube watch     797x598    26                  0.20         1.12
  //   Reddit front      -          38                  0.56         1.27
  //   BBC news front    -          43                  0.33         1.67
  //   Wikipedia        250x141     9                   0.014        2.35
  //   GitHub repo      -           1                   0.02         2.03
  //   Hacker News      -           0                   0.032        3.07
  //
  // Wikipedia's 250x141 infobox video is the case the video floor exists for.
  const MEDIA_VIDEO_MIN_W = 300;
  const MEDIA_VIDEO_MIN_H = 150;
  const MEDIA_IMAGE_MIN_W = 200;
  const MEDIA_IMAGE_MIN_H = 100;
  const MEDIA_IMAGE_COUNT = 12;
  const MEDIA_IMAGE_AREA_FRACTION = 0.2;
  // What the media renderer actually draws. Below this are icons, avatars and
  // tracking pixels; drawing them turns the map into a confetti field.
  const MEDIA_BOX_MIN_W = 48;
  const MEDIA_BOX_MIN_H = 32;

  // What the media renderer adds to the text vocabulary. The block selector
  // is not extended; this is the same idea applied separately, and it leaves
  // out exactly the parts the media boxes already stand for: links and
  // buttons are the cards' labels, and `img` is drawn as a box, not as text.
  const MEDIA_TEXT_SELECTOR = [
    "p", "li", "dt", "dd", "h4", "h5", "h6", "blockquote", "pre",
    "figcaption", "caption", "td", "th", "summary",
  ].join(", ");

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
      /**
       * Semantic blocks, collected instead of the text raster when the map is
       * too zoomed for the raster to read. See collectBlocks().
       */
      this.blocks = [];
      this.blockMode = false;
      this.blockLeft = 0;
      this.blockRight = 0;
      /**
       * Replaced elements and headings, collected instead of both text
       * renderers on a page whose structure is pictures. See #wantsMedia().
       */
      this.media = [];
      /**
       * Paragraphs and captions on a media page, drawn under the media boxes.
       * Links and buttons are left out: on a card the media box *is* the
       * link, and drawing the title again beside it is the noise, not the
       * signal.
       */
      this.mediaText = [];
      this.mediaMode = false;
      this.mediaLeft = 0;
      this.mediaRight = 0;
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
            // The right edge is what makes the preview able to centre a
            // column: text alone cannot tell a 300px sidebar from a 900px
            // article until the box is measured.
            right: rects[i].right + scrollX,
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

      // Which renderer this revision gets. Media first: a page whose
      // structure is pictures is media whether or not its text is spread
      // wide, and the spread rule would otherwise send it to the block
      // renderer, whose model does not contain the player or the cards. Then
      // zoom, which chooses between the raster and the blocks for text
      // pages. See #wantsMedia() and #wantsBlocks().
      this.#collectMedia(root, scrollX, scrollY, maxY);
      this.mediaMode = this.#wantsMedia() && this.media.length > 0;

      if (this.mediaMode) {
        const text = this.#collectBlocks(
          root, scrollX, scrollY, maxY, MEDIA_TEXT_SELECTOR);
        this.mediaText = text.blocks;
        this.blocks = [];
        this.blockMode = false;
        this.#mediaSpan();
      } else {
        this.media = [];
        this.mediaText = [];
        this.blockMode = this.#wantsBlocks();
        if (this.blockMode) {
          const blocks = this.#collectBlocks(
            root, scrollX, scrollY, maxY, BLOCK_SELECTOR);
          this.blocks = blocks.blocks;
          this.blockLeft = blocks.left;
          this.blockRight = blocks.right;
          // A page with nothing block-shaped (rare) reads better as text.
          this.blockMode = this.blocks.length > 0;
        } else {
          this.blocks = [];
        }
      }

      this.revision++;
      return lines;
    }

    /** Is the map stretched past the point where the raster reads as text? */
    #wantsBlocks() {
      // One text line per BLOCK_MIN_LINE_PX of groove, or fatter. The height
      // guard keeps a tiny map from flipping modes on rounding.
      if (this.height >= 40 && this.lines.length > 0 &&
          this.lines.length * BLOCK_MIN_LINE_PX < this.height) {
        return true;
      }
      return this.#spreadFraction() > BLOCK_SPREAD_FRACTION;
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
     * and it only runs when the map is zoomed in: on a long document the
     * raster looks better and this sweep is skipped entirely, so the cost of
     * a per-element getBoundingClientRect never lands on the pages that do
     * not need it.
     *
     * Links use their line fragments rather than one bounding box, so a link
     * that wraps is two blue bars instead of a rectangle covering the text
     * between them. Images are atomic. Everything else is a text area.
     */
    #collectBlocks(root, scrollX, scrollY, maxY, selector) {
      const blocks = [];
      for (const el of root.querySelectorAll(selector)) {
        if (el.closest(".vugluscr, .scrollpeak-magnifier, .scrollpeak-map")) {
          continue;
        }
        const cs = getComputedStyle(el);
        if (
          cs.display === "none" ||
          cs.visibility === "hidden" || cs.visibility === "collapse" ||
          this.#isStuck(el)
        ) {
          continue;
        }

        const kind = el.tagName === "IMG" ? "image"
          : el.tagName === "A" ? "link" : "text";
        const rects = kind === "link"
          ? Array.from(el.getClientRects())
          : [el.getBoundingClientRect()];

        for (const r of rects) {
          if (r.width < 1 || r.height < 1) continue;
          const y = r.top + scrollY;
          if (y + r.height < 0 || y > maxY) continue;
          blocks.push({
            x: r.left + scrollX,
            y,
            w: r.width,
            h: r.height,
            kind,
            colour: kind === "link" ? cs.color : null,
          });
        }
      }

      // Text areas first, then links, then image outlines on top of both.
      const order = { text: 0, link: 1, image: 2 };
      blocks.sort((a, b) => order[a.kind] - order[b.kind]);

      let left = Infinity;
      let right = -Infinity;
      for (const b of blocks) {
        if (b.x < left) left = b.x;
        if (b.x + b.w > right) right = b.x + b.w;
      }
      return {
        blocks,
        left: blocks.length ? left : 0,
        right: blocks.length ? right : 1,
      };
    }

    /**
     * Collect what the media renderer draws.
     *
     * Unlike #collectBlocks(), the vocabulary is geometry, not tags: anything
     * the browser actually renders as a picture -- <video>, <img>, <canvas>,
     * <iframe> -- above a floor size. That is the point of a separate media
     * path. YouTube's player is a <video> the block selector never had; its
     * cards are divs no selector would find; and the titles and badges the
     * block map did catch are the noise there, not the structure.
     *
     * Headings come along for orientation. The rest of the text does not:
     * body text on a media page is labels and captions, and the preview is
     * one hover away when it is actually wanted.
     */
    #collectMedia(root, scrollX, scrollY, maxY) {
      const found = [];
      for (const el of root.querySelectorAll("video, img, canvas, iframe")) {
        if (el.closest(".vugluscr, .scrollpeak-magnifier, .scrollpeak-map")) continue;
        const r = el.getBoundingClientRect();
        if (r.width < MEDIA_BOX_MIN_W || r.height < MEDIA_BOX_MIN_H) continue;
        const cs = getComputedStyle(el);
        if (
          cs.display === "none" ||
          cs.visibility === "hidden" || cs.visibility === "collapse" ||
          this.#isStuck(el)
        ) {
          continue;
        }
        const y = r.top + scrollY;
        if (y + r.height < 0 || y > maxY) continue;
        found.push({
          x: r.left + scrollX,
          y,
          w: r.width,
          h: r.height,
          kind: el.tagName === "VIDEO" ? "video" : "media",
        });
      }

      // One box per picture. A <video> and its <canvas> overlay cover the
      // same rect, and a site can nest an <img> under the same placeholder as
      // an <iframe>. The selector order already ranks them usefully, so keep
      // the first of a set and drop the rest.
      const media = [];
      for (const m of found) {
        // A gallery can hold thousands of pictures; the map cannot show them
        // and the strip is 60px wide. The first few hundred are the page.
        if (media.length >= 600) break;
        let dup = false;
        for (const k of media) {
          if (Math.abs(k.x - m.x) < 3 && Math.abs(k.y - m.y) < 3 &&
              Math.abs(k.w - m.w) < 4 && Math.abs(k.h - m.h) < 4) {
            dup = true;
            break;
          }
        }
        if (!dup) media.push(m);
      }

      // The page's own wayfinding marks, so a media map can say where the
      // title is rather than only where the pictures are.
      for (const el of root.querySelectorAll("h1, h2, h3")) {
        if (el.closest(".vugluscr, .scrollpeak-magnifier, .scrollpeak-map")) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 6) continue;
        const cs = getComputedStyle(el);
        if (
          cs.display === "none" ||
          cs.visibility === "hidden" || cs.visibility === "collapse" ||
          this.#isStuck(el)
        ) {
          continue;
        }
        const y = r.top + scrollY;
        if (y + r.height < 0 || y > maxY) continue;
        media.push({
          x: r.left + scrollX,
          y,
          w: r.width,
          h: r.height,
          kind: "heading",
        });
      }

      this.media = media;
    }

    /**
     * The horizontal extent the media renderer maps onto the strip.
     *
     * Taken over the text it draws as well as the boxes, so a wide paragraph
     * cannot overflow the map's x projection, and set after both
     * collections.
     */
    #mediaSpan() {
      let left = Infinity;
      let right = -Infinity;
      for (const m of this.media) {
        if (m.x < left) left = m.x;
        if (m.x + m.w > right) right = m.x + m.w;
      }
      for (const b of this.mediaText) {
        if (b.x < left) left = b.x;
        if (b.x + b.w > right) right = b.x + b.w;
      }
      const any = this.media.length || this.mediaText.length;
      this.mediaLeft = any ? left : 0;
      this.mediaRight = any ? right : 1;
    }

    /**
     * Is this page one whose structure is pictures?
     *
     * A big video is decisive: on a watch page the video *is* the content.
     * Otherwise a field of large pictures -- many of them, covering a real
     * share of the document. Both parts of the picture test matter: BBC's
     * front page and Reddit's are card grids (43 and 38 large pictures,
     * 33% and 56% of the document), while Wikipedia has 9 and GitHub 1,
     * percentages in the low hundredths.
     *
     * The video floor is measured too: Wikipedia's infobox holds a 250x141
     * video, which is a thumbnail, not a player.
     */
    #wantsMedia() {
      let bigCount = 0;
      let bigArea = 0;
      for (const m of this.media) {
        if (m.kind === "video") {
          if (m.w >= MEDIA_VIDEO_MIN_W && m.h >= MEDIA_VIDEO_MIN_H) return true;
        } else if (m.kind === "media") {
          if (m.w >= MEDIA_IMAGE_MIN_W && m.h >= MEDIA_IMAGE_MIN_H) {
            bigCount++;
            bigArea += m.w * m.h;
          }
        }
      }
      if (bigCount < MEDIA_IMAGE_COUNT) return false;
      const docArea = this.docHeight *
        (document.documentElement.clientWidth || window.innerWidth);
      return bigArea > docArea * MEDIA_IMAGE_AREA_FRACTION;
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
      // The accent has to contrast with the strip too: the media renderer
      // fills the video's box with it, and a themed accent can be the strip's
      // own colour (a grey theme's accent on a grey strip), which would make
      // the player disappear.
      const accent = ensureContrast(
        resolveColor(this.theme?.accent) || [59, 110, 165],
        bg,
        this.markContrast,
      );
      this.palette = {
        background: this.mapBackground,
        ink: `rgb(${ink.join(",")})`,
        inkRgb: ink,
        accent: `rgb(${accent.join(",")})`,
        accentRgb: accent,
        source: this.paletteSource,
      };
    }

    /** Left edge of the main content column, robustly. */
    contentLeftOf() {
      return this.contentLeft;
    }

    /**
     * The horizontal span of the content *the preview window will show*.
     *
     * A single contentLeft is right for a text document, where every line
     * starts at the same x, and for a page with one column. It is wrong for a
     * page with two, and for a page with a float: the lead beside Wikipedia's
     * infobox is wrapped to a narrow column, and anchoring the window's left
     * edge there clipped the infobox off the right and left a quarter of the
     * window blank on the left.
     *
     * The span is the union of the line boxes that overlap the window
     * vertically, so the preview centres everything it is about to show. The
     * 2nd and 98th percentiles drop a stray fragment -- absolutely positioned
     * badges and the like -- without dropping a real second column or a
     * float. The vertical band is the one paint() maps to the stage, and the
     * fallback window covers a blank run or a page shorter than the window.
     */
    contentSpanNear(docY, top, height) {
      const lines = this.lines;
      if (!lines.length) {
        return { left: this.contentLeft, right: this.contentLeft + 1 };
      }
      const bandTop = top == null ? docY : top;
      const bandBottom = bandTop + (height == null ? 0 : height);

      // Lines that overlap the window vertically. indexAtY gives the last
      // line starting at or above bandTop; walk back while earlier boxes
      // still extend into the band.
      let start = this.indexAtY(bandTop);
      while (start > 0 && lines[start - 1].y + lines[start - 1].height > bandTop) {
        start--;
      }
      let end = start;
      while (end < lines.length && lines[end].y < bandBottom) end++;

      if (end - start < 4) {
        const at = this.indexAtY(docY);
        start = Math.max(0, at - SPAN_WINDOW_LINES);
        end = Math.min(lines.length, at + SPAN_WINDOW_LINES + 1);
      }

      const lefts = [];
      const rights = [];
      for (let i = start; i < end; i++) {
        lefts.push(lines[i].x);
        rights.push(lines[i].right ?? lines[i].x);
      }
      lefts.sort((a, b) => a - b);
      rights.sort((a, b) => a - b);
      const pick = (sorted, q) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
      return { left: pick(lefts, 0.02), right: pick(rights, 0.98) };
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

      // Which renderer drew this map, and for blocks and media, what it had
      // to work with. Published for the tests and the site probe.
      let modeKey = "text";
      let counts = null;
      if (this.mediaMode) {
        counts = { video: 0, media: 0, heading: 0, text: this.mediaText.length };
        for (const m of this.media) counts[m.kind]++;
        modeKey = `media:${JSON.stringify(counts)}:` +
          `${Math.round(this.mediaLeft)}:${Math.round(this.mediaRight)}`;
      } else if (this.blockMode) {
        counts = { text: 0, link: 0, image: 0 };
        for (const b of this.blocks) counts[b.kind]++;
        modeKey = `blocks:${JSON.stringify(counts)}:` +
          `${Math.round(this.blockLeft)}:${Math.round(this.blockRight)}`;
      }
      if (modeKey !== this._modeKey) {
        this._modeKey = modeKey;
        this.canvas.dataset.mode = this.mediaMode ? "media"
          : this.blockMode ? "blocks" : "text";
        if (counts) {
          const datasetName = this.mediaMode ? "media" : "blocks";
          const spanName = this.mediaMode ? "mediaSpan" : "blockSpan";
          this.canvas.dataset[datasetName] = JSON.stringify(counts);
          this.canvas.dataset[spanName] = JSON.stringify({
            left: Math.round(this.mediaMode ? this.mediaLeft : this.blockLeft),
            right: Math.round(this.mediaMode ? this.mediaRight : this.blockRight),
          });
          const other = this.mediaMode ? "blocks" : "media";
          const otherSpan = this.mediaMode ? "blockSpan" : "mediaSpan";
          delete this.canvas.dataset[other];
          delete this.canvas.dataset[otherSpan];
        } else {
          for (const name of ["blocks", "blockSpan", "media", "mediaSpan"]) {
            delete this.canvas.dataset[name];
          }
        }
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

      // Stretch the pixmap over the whole groove; or, when the text would not
      // read at this zoom, draw the semantic blocks; or, on a page whose
      // structure is pictures, draw the media skeleton.
      if (this.mediaMode) {
        this.#paintMedia(docTop, docHeight);
      } else if (this.blockMode) {
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
     * colour, images as hollow outlines.
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

        if (b.kind === "link") {
          // The page's own link colour, pushed to contrast with the strip the
          // same way the text raster pushes its marks: a link stays
          // link-coloured and readable on any strip.
          const rgb = ensureContrast(
            parseRgb(b.colour) || [59, 110, 165], bgRgb, this.markContrast);
          ctx.fillStyle = `rgb(${rgb.join(",")})`;
          ctx.fillRect(x, y, w, h);
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

    /**
     * The media renderer: the picture boxes, the text under them, and the
     * headings that orient both.
     *
     * A video is the page's subject, so it is drawn as a filled accent block
     * -- the one mark that should be findable at a glance. Every other piece
     * of media is a hollow outline, the same convention the block renderer
     * uses for images: it reads as a picture rather than as text, and an
     * outline can sit over the strip without hiding anything under it.
     * Paragraphs and captions are ink bars under the boxes; headings are the
     * same bars, collected with the media. Links and buttons are not drawn:
     * on a card the box is the link, and its title would be the box's label
     * repeated.
     *
     * The x span is the media's own extent, like #paintBlocks(), so the map
     * uses the full strip width instead of a sliver beside a sidebar.
     */
    #paintMedia(docTop, docHeight) {
      const ctx = this.ctx;
      const span = Math.max(1, this.mediaRight - this.mediaLeft);
      const stripW = Math.max(1, this.width - 2 * DOC_X_MARGIN);
      const inkRgb = this.palette.inkRgb;
      const accentRgb = this.palette.accentRgb;
      const ink = `rgb(${inkRgb.join(",")})`;
      const accent = `rgb(${accentRgb.join(",")})`;

      // The text first, under the boxes: the same paint order the block
      // renderer uses, so a card's box reads as something over the text it
      // holds, not the other way round.
      for (const b of this.mediaText) {
        const x = DOC_X_MARGIN + ((b.x - this.mediaLeft) / span) * stripW;
        const w = Math.max(1, (b.w / span) * stripW);
        const y = docTop + (b.y / this.docHeight) * docHeight;
        const h = Math.max(1, (b.h / this.docHeight) * docHeight);
        ctx.fillStyle = ink;
        ctx.fillRect(x, y, w, h);
      }

      for (const m of this.media) {
        const x = DOC_X_MARGIN + ((m.x - this.mediaLeft) / span) * stripW;
        const w = Math.max(1, (m.w / span) * stripW);
        const y = docTop + (m.y / this.docHeight) * docHeight;
        const h = Math.max(1, (m.h / this.docHeight) * docHeight);

        if (m.kind === "heading") {
          ctx.fillStyle = ink;
          ctx.fillRect(x, y, w, h);
        } else if (m.kind === "video") {
          ctx.fillStyle = withAlpha(accentRgb, 110);
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
        } else {
          ctx.fillStyle = this.mapBackground;
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = ink;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
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

  function renderedText(slice) {
    return slice.replace(/\s+/g, " ").replace(/ +$/, "");
  }

  globalThis.ScrollPeakTextMap = { TextMap, REBUILD_DELAY_MS, S_PIXEL_MARGIN };
})();
