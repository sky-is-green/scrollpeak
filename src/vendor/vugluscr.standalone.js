(function() {
  "use strict";
  try {
    if (typeof document != "undefined") {
      var elementStyle = document.createElement("style");
      elementStyle.appendChild(document.createTextNode("/*\n * vugluscr's default look — the part that is yours to change.\n *\n * Optional: `import 'vugluscr/theme.css'` for the stock appearance, or skip it\n * and style `.vugluscr` from scratch. The layout the rail depends on is not in\n * here; the library injects that itself, so nothing in this file can break the\n * scrollbar — only restyle it.\n *\n * ── One knob ──────────────────────────────────────────────────────────────\n *\n * Everything neutral is a tint of a single colour, so matching the rail to a\n * design usually means setting one variable:\n *\n *   :root { --vugluscr_color: rebeccapurple; }\n *\n * The tints, from faintest to strongest:\n *\n *    11%  track and minimap backing\n *    17%  minimap containers (section, figure, ul, …)\n *    23%  minimap leaf blocks (p, li, figcaption, …)\n *    25%  minimap blocks of unrecognised elements\n *    30%  thumb          50% hovered      60% dragging\n *    90%  markers\n *\n * `--vugluscr_accent_color` is the one exception: images in the minimap read as\n * a different *kind* of content rather than a louder tint of the same one, so\n * they have their own colour.\n *\n * ── Overriding one thing ──────────────────────────────────────────────────\n *\n * Every derived value is also a token in its own right. Set one and it wins\n * over the tint it would otherwise have been:\n *\n *   :root {\n *     --vugluscr_color: rebeccapurple;      … tints the whole rail\n *     --vugluscr_thumb_background: tomato;  … except the thumb\n *   }\n *\n *   --vugluscr_track_background\n *   --vugluscr_thumb_background [_hover] [_active]\n *   --vugluscr_minimap_background\n *   --vugluscr_minimap_thumb_background\n *   --vugluscr_minimap_block            leaf blocks\n *   --vugluscr_minimap_block_group      containers\n *   --vugluscr_minimap_block_unknown    unrecognised elements\n *   --vugluscr_minimap_block_image\n *   --vugluscr_minimap_block_stroke     hairline around every block\n *   --vugluscr_marker_color             see below\n *   --vugluscr_marker_min_height        see below\n *\n * Tokens are read but never declared here. A declaration on `.vugluscr` would\n * sit closer to the element than a consumer's `:root` and quietly win, so the\n * defaults live in `var()` fallbacks at the point of use instead.\n *\n * ── Markers ───────────────────────────────────────────────────────────────\n *\n * Markers are painted onto a canvas, so CSS cannot reach them directly. Two\n * values are read back out by `ScrollbarTrack` at paint time so their\n * prominence is still a styling decision:\n *\n *   --vugluscr_marker_min_height   how thick a marker is — a single-position\n *                                  hit is drawn at exactly this height, so it\n *                                  is the knob for how loud markers read.\n *   --vugluscr_marker_color        colour for markers that don't carry one of\n *                                  their own. Set on `.track`'s `color` below\n *                                  so the browser resolves the `color-mix()`\n *                                  before the canvas, which cannot parse it,\n *                                  ever sees it.\n *\n * ── Structure ─────────────────────────────────────────────────────────────\n *\n *   .vugluscr [.is_embedded]\n *   └── .scrollbar\n *       ├── .minimap\n *       │   ├── svg > rect.<element-name>   one per content block\n *       │   └── .thumb [.visible|.active]   viewport indicator\n *       └── .track\n *           ├── canvas                      markers\n *           └── .thumb [.active]            draggable\n */\n\n@layer vugluscr.structure, vugluscr.theme;\n\n@layer vugluscr.theme {\n  @scope (.vugluscr) {\n    .minimap {\n      cursor: default;\n      background-color: var(\n        --vugluscr_minimap_background,\n        color-mix(in srgb, var(--vugluscr_color, rgb(121 121 121)) 11%, transparent)\n      );\n\n      svg {\n        rect {\n          fill: var(\n            --vugluscr_minimap_block_unknown,\n            color-mix(in srgb, var(--vugluscr_color, rgb(121 121 121)) 25%, transparent)\n          );\n          stroke: var(--vugluscr_minimap_block_stroke, rgb(255 255 255 / 0.3));\n          stroke-width: 0.5;\n        }\n\n        rect.article,\n        rect.section,\n        rect.figure,\n        rect.ul,\n        rect.ol {\n          fill: var(\n            --vugluscr_minimap_block_group,\n            color-mix(in srgb, var(--vugluscr_color, rgb(121 121 121)) 17%, transparent)\n          );\n        }\n\n        rect.p,\n        rect.li,\n        rect.figcaption,\n        rect.img,\n        rect.blockquote {\n          fill: var(\n            --vugluscr_minimap_block,\n            color-mix(in srgb, var(--vugluscr_color, rgb(121 121 121)) 23%, transparent)\n          );\n        }\n\n        rect.img {\n          fill: var(\n            --vugluscr_minimap_block_image,\n            color-mix(in srgb, var(--vugluscr_accent_color, rgb(158 181 255)) 30%, transparent)\n          );\n        }\n      }\n\n      /* `visible` is toggled by Minimap per its `showThumb` option — the\n         library owns when the indicator shows, this file only says how. */\n      .thumb {\n        background-color: var(\n          --vugluscr_minimap_thumb_background,\n          color-mix(in srgb, var(--vugluscr_color, rgb(121 121 121)) 30%, transparent)\n        );\n        opacity: 0;\n        transition: opacity 0.1s ease;\n      }\n\n      .thumb.visible,\n      .thumb.active {\n        opacity: 1;\n      }\n    }\n\n    .track {\n      background-color: var(\n        --vugluscr_track_background,\n        color-mix(in srgb, var(--vugluscr_color, rgb(121 121 121)) 11%, transparent)\n      );\n      /* Carrier for the canvas: `ScrollbarTrack` paints markers that carry\n         no colour of their own in the track's resolved `color`. */\n      color: var(\n        --vugluscr_marker_color,\n        color-mix(in srgb, var(--vugluscr_color, rgb(121 121 121)) 90%, transparent)\n      );\n\n      .thumb {\n        background-color: var(\n          --vugluscr_thumb_background,\n          color-mix(in srgb, var(--vugluscr_color, rgb(121 121 121)) 30%, transparent)\n        );\n        /* No grab/grabbing cursor: a native scrollbar thumb keeps the ordinary arrow\n           throughout, and a rail that swaps the pointer reads as a draggable object in\n           the page rather than as the scrollbar it is standing in for. The colour shifts\n           below carry the hover and drag states on their own. */\n        transition: background-color 0.1s ease;\n\n        &:hover {\n          background-color: var(\n            --vugluscr_thumb_background_hover,\n            color-mix(in srgb, var(--vugluscr_color, rgb(121 121 121)) 50%, transparent)\n          );\n        }\n\n        &.active {\n          background-color: var(\n            --vugluscr_thumb_background_active,\n            color-mix(in srgb, var(--vugluscr_color, rgb(121 121 121)) 60%, transparent)\n          );\n        }\n      }\n    }\n  }\n}"));
      document.head.appendChild(elementStyle);
    }
  } catch (e) {
    console.error("vite-plugin-css-injected-by-js", e);
  }
})();
var Vugluscr = function(exports) {
  "use strict";var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};

  function numberAsPixels(value) {
    if (typeof value === "number") {
      return value + "px";
    }
    return value;
  }
  class CachedDomNode {
    constructor(domNode) {
      __publicField(this, "widthValue", "");
      __publicField(this, "heightValue", "");
      __publicField(this, "topValue", "");
      __publicField(this, "leftValue", "");
      __publicField(this, "rightValue", "");
      __publicField(this, "classNameValue", "");
      this.domNode = domNode;
    }
    setWidth(value) {
      const pixelValue = numberAsPixels(value);
      if (this.widthValue === pixelValue) {
        return;
      }
      this.widthValue = pixelValue;
      this.domNode.style.width = pixelValue;
    }
    setHeight(value) {
      const pixelValue = numberAsPixels(value);
      if (this.heightValue === pixelValue) {
        return;
      }
      this.heightValue = pixelValue;
      this.domNode.style.height = pixelValue;
    }
    setTop(value) {
      const pixelValue = numberAsPixels(value);
      if (this.topValue === pixelValue) {
        return;
      }
      this.topValue = pixelValue;
      this.domNode.style.top = pixelValue;
    }
    setLeft(value) {
      const pixelValue = numberAsPixels(value);
      if (this.leftValue === pixelValue) {
        return;
      }
      this.leftValue = pixelValue;
      this.domNode.style.left = pixelValue;
    }
    setRight(value) {
      const pixelValue = numberAsPixels(value);
      if (this.rightValue === pixelValue) {
        return;
      }
      this.rightValue = pixelValue;
      this.domNode.style.right = pixelValue;
    }
    setClassName(className) {
      if (this.classNameValue === className) {
        return;
      }
      this.classNameValue = className;
      this.domNode.className = className;
    }
    toggleClassName(className, shouldHaveIt) {
      this.domNode.classList.toggle(className, shouldHaveIt);
      this.classNameValue = this.domNode.className;
    }
    setAttribute(name, value) {
      this.domNode.setAttribute(name, value);
    }
    appendChild(child) {
      this.domNode.appendChild(child.domNode);
    }
  }
  function createCachedDomNode(domNode) {
    return new CachedDomNode(domNode);
  }
  class DisposableStore {
    constructor() {
      __publicField(this, "disposables", []);
      __publicField(this, "isDisposed", false);
    }
    add(disposable) {
      if (this.isDisposed) {
        disposable.dispose();
        return disposable;
      }
      this.disposables.push(disposable);
      return disposable;
    }
    dispose() {
      if (this.isDisposed) {
        return;
      }
      this.isDisposed = true;
      for (const disposable of this.disposables) {
        disposable.dispose();
      }
      this.disposables.length = 0;
    }
  }
  class Emitter {
    constructor() {
      __publicField(this, "listeners", []);
      __publicField(this, "disposed", false);
    }
    get event() {
      return (listener) => {
        if (this.disposed) {
          return { dispose: () => {
          } };
        }
        this.listeners.push(listener);
        return {
          dispose: () => {
            const listenerIndex = this.listeners.indexOf(listener);
            if (listenerIndex >= 0) {
              this.listeners.splice(listenerIndex, 1);
            }
          }
        };
      };
    }
    fire(event) {
      if (this.disposed) {
        return;
      }
      const snapshot = this.listeners.slice();
      for (const listener of snapshot) {
        listener(event);
      }
    }
    dispose() {
      this.disposed = true;
      this.listeners.length = 0;
    }
  }
  class Disposable {
    constructor() {
      __publicField(this, "store", new DisposableStore());
    }
    register(disposable) {
      return this.store.add(disposable);
    }
    dispose() {
      this.store.dispose();
    }
  }
  const MIN_THUMB_HEIGHT = 20;
  function computeTrackGeometry(trackHeight, viewportHeight, scrollHeight) {
    const thumbHeight = scrollHeight > 0 ? Math.min(trackHeight, Math.max(MIN_THUMB_HEIGHT, trackHeight * viewportHeight / scrollHeight)) : trackHeight;
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
    return {
      thumbHeight,
      maxThumbTop,
      maxScrollTop,
      scrollPerTrackPx: maxThumbTop > 0 ? maxScrollTop / maxThumbTop : 0
    };
  }
  function thumbTopForScrollTop(scrollTop, geometry) {
    if (geometry.maxScrollTop <= 0) {
      return 0;
    }
    const clamped = clamp(scrollTop, 0, geometry.maxScrollTop);
    return clamped / geometry.maxScrollTop * geometry.maxThumbTop;
  }
  function scrollTopForThumbTop(thumbTop, geometry) {
    return clamp(thumbTop, 0, geometry.maxThumbTop) * geometry.scrollPerTrackPx;
  }
  function centredThumbTop(pointerY, geometry) {
    return clamp(pointerY - geometry.thumbHeight / 2, 0, geometry.maxThumbTop);
  }
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  const CLICK_SLOP = 3;
  class ScrollTrackOverlay extends Disposable {
    constructor(scrollable, className, width, surfaceElement, ariaHidden) {
      super();
      __publicField(this, "scrollable");
      __publicField(this, "domNode");
      __publicField(this, "surfaceElement");
      __publicField(this, "thumb");
      __publicField(this, "viewportHeight", 0);
      __publicField(this, "isDragging", false);
      this.scrollable = scrollable;
      this.surfaceElement = surfaceElement;
      this.domNode = createCachedDomNode(document.createElement("div"));
      this.domNode.setClassName(className);
      this.domNode.setWidth(width);
      if (ariaHidden) {
        this.domNode.domNode.setAttribute("aria-hidden", "true");
      }
      this.domNode.domNode.appendChild(this.surfaceElement);
      this.thumb = createCachedDomNode(document.createElement("div"));
      this.thumb.setClassName(this.getThumbClassName());
      this.domNode.appendChild(this.thumb);
      this.surfaceElement.addEventListener(
        "pointerdown",
        (event) => this.onPointerDown(event)
      );
      this.thumb.domNode.addEventListener("pointerdown", (event) => this.onPointerDown(event));
      this.register(
        scrollable.onScroll(() => {
          this.onScroll();
        })
      );
    }
    /** Handle native scroll updates */
    onScroll() {
      this.updateThumb();
    }
    layout(height) {
      this.viewportHeight = height;
      this.domNode.setHeight(height);
      this.renderSurface();
      this.updateThumb();
    }
    renderNow() {
      this.renderSurface();
      this.updateThumb();
    }
    /**
     * A press anywhere on the rail — bare track or the thumb itself — puts the thumb's centre where
     * the pointer is, and continues into a drag.
     *
     * The thumb is deliberately not exempt from the centring. Grabbing it at an offset, the way a
     * native scrollbar does, means a press on the thumb can only ever do nothing: the one place on
     * the rail where a small correction is most natural to reach for is the one place that ignores
     * you.
     *
     * WHEN it centres differs by where the press landed, though, and that matters more than it
     * sounds. On bare track there is nothing to disturb, so it moves at once. On the thumb it waits
     * for release, because a press there is just as likely to be the start of a deliberate drag —
     * and centring immediately would make every such drag begin with a jolt of up to half a thumb
     * height, which on a long document is several screens. So the drag keeps the offset it was
     * grabbed by, and the nudge is applied on release only if the pointer never really travelled.
     */
    onPointerDown(event) {
      event.preventDefault();
      event.stopPropagation();
      const surfaceRect = this.surfaceElement.getBoundingClientRect();
      const pointerY = event.clientY - surfaceRect.top;
      const geometry = this.getTrackGeometry();
      const thumbTop = thumbTopForScrollTop(
        this.scrollable.getCurrentScrollPosition().scrollTop,
        geometry
      );
      const onThumb = pointerY >= thumbTop && pointerY <= thumbTop + geometry.thumbHeight;
      if (!onThumb) {
        this.scrollable.setScrollPositionNow({
          scrollTop: scrollTopForThumbTop(centredThumbTop(pointerY, geometry), geometry)
        });
      }
      this.startDrag(event, pointerY, onThumb);
    }
    /**
     * Start a drag from `startY`.
     *
     * `nudgeOnRelease` defers the centring described in {@link onPointerDown}: the press landed on
     * the thumb, so the view holds still while the pointer might yet turn out to be dragging, and
     * centres only if it comes back up without having gone anywhere.
     */
    startDrag(event, startY, nudgeOnRelease) {
      this.isDragging = true;
      const dragStartScrollTop = this.scrollable.getCurrentScrollPosition().scrollTop;
      const geometry = this.getTrackGeometry();
      const startThumbTop = thumbTopForScrollTop(dragStartScrollTop, geometry);
      let travelled = 0;
      this.thumb.toggleClassName("active", true);
      this.thumb.domNode.setPointerCapture(event.pointerId);
      const onMove = (moveEvent) => {
        if (!this.isDragging) {
          return;
        }
        const surfaceRect = this.surfaceElement.getBoundingClientRect();
        const delta = moveEvent.clientY - surfaceRect.top - startY;
        travelled = Math.max(travelled, Math.abs(delta));
        this.thumb.setTop(Math.min(geometry.maxThumbTop, Math.max(0, startThumbTop + delta)));
        this.scrollable.setScrollPositionNow({
          scrollTop: dragStartScrollTop + delta * geometry.scrollPerTrackPx
        });
      };
      const onUp = () => {
        this.isDragging = false;
        this.thumb.toggleClassName("active", false);
        if (nudgeOnRelease && travelled <= CLICK_SLOP) {
          this.scrollable.setScrollPositionNow({
            scrollTop: scrollTopForThumbTop(centredThumbTop(startY, geometry), geometry)
          });
        }
        this.updateThumb();
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    }
    updateThumb() {
      const dimensions = this.scrollable.getScrollDimensions();
      if (dimensions.scrollHeight <= 0) {
        return;
      }
      const geometry = this.getTrackGeometry();
      this.thumb.setHeight(geometry.thumbHeight);
      if (this.isDragging) {
        return;
      }
      const scrollTop = this.scrollable.getCurrentScrollPosition().scrollTop;
      this.thumb.setTop(thumbTopForScrollTop(scrollTop, geometry));
    }
    /**
     * Track geometry for the current dimensions.
     *
     * The arithmetic itself lives in trackGeometry.ts, free of the DOM and unit-tested there; this
     * only feeds it the current dimensions.
     */
    getTrackGeometry() {
      const d = this.scrollable.getScrollDimensions();
      return computeTrackGeometry(this.viewportHeight, d.height, d.scrollHeight);
    }
  }
  const blockTagClassNames = /* @__PURE__ */ new Map([
    ["ADDRESS", "address"],
    ["ARTICLE", "article"],
    ["ASIDE", "aside"],
    ["DETAILS", "details"],
    ["DIALOG", "dialog"],
    ["DIV", "div"],
    ["DL", "dl"],
    ["FIELDSET", "fieldset"],
    ["FIGURE", "figure"],
    ["FOOTER", "footer"],
    ["FORM", "form"],
    ["HEADER", "header"],
    ["MAIN", "main"],
    ["NAV", "nav"],
    ["OL", "ol"],
    ["SECTION", "section"],
    ["UL", "ul"]
  ]);
  const terminalTagClassNames = /* @__PURE__ */ new Map([
    ["BLOCKQUOTE", "blockquote"],
    ["CAPTION", "caption"],
    ["DD", "dd"],
    ["DT", "dt"],
    ["FIGCAPTION", "figcaption"],
    ["H1", "h1"],
    ["H2", "h2"],
    ["H3", "h3"],
    ["H4", "h4"],
    ["H5", "h5"],
    ["H6", "h6"],
    ["HR", "hr"],
    ["IMG", "img"],
    ["LI", "li"],
    ["P", "p"],
    ["PRE", "pre"],
    ["TABLE", "table"]
  ]);
  const DEFAULT_OPTIONS$2 = {
    minimapWidth: 120,
    showThumb: "mouseover"
  };
  const _Minimap = class _Minimap extends ScrollTrackOverlay {
    constructor(scrollable, options) {
      const opts = { ...DEFAULT_OPTIONS$2, ...options };
      const svg = document.createElementNS(_Minimap.svgNamespace, "svg");
      svg.setAttribute("preserveAspectRatio", "none");
      super(scrollable, "minimap", opts.minimapWidth, svg, false);
      __publicField(this, "svg");
      __publicField(this, "options");
      __publicField(this, "sourceElement", null);
      this.svg = svg;
      this.options = opts;
      if (this.options.showThumb === "always") {
        this.thumb.toggleClassName("visible", true);
      } else {
        const showThumb = () => this.thumb.toggleClassName("visible", true);
        const hideThumb = () => this.thumb.toggleClassName("visible", false);
        this.domNode.domNode.addEventListener("pointerenter", showThumb);
        this.domNode.domNode.addEventListener("pointerleave", hideThumb);
        this.register({
          dispose: () => {
            this.domNode.domNode.removeEventListener("pointerenter", showThumb);
            this.domNode.domNode.removeEventListener("pointerleave", hideThumb);
          }
        });
      }
    }
    getThumbClassName() {
      return "thumb";
    }
    get width() {
      return this.options.minimapWidth;
    }
    setSourceElement(element) {
      this.sourceElement = element;
    }
    renderSurface() {
      const width = this.options.minimapWidth;
      const height = this.viewportHeight;
      const scrollHeight = this.scrollable.getScrollDimensions().scrollHeight;
      this.svg.setAttribute("width", String(width));
      this.svg.setAttribute("height", String(height));
      this.svg.setAttribute("viewBox", `0 0 ${width} ${Math.max(1, scrollHeight)}`);
      this.svg.style.width = width + "px";
      this.svg.style.height = height + "px";
      this.svg.replaceChildren();
      if (!this.sourceElement || scrollHeight <= 0) {
        return;
      }
      const articleRect = this.sourceElement.getBoundingClientRect();
      const structure = this.buildNodeGroup(this.sourceElement, articleRect, 0);
      if (structure) {
        this.svg.appendChild(structure);
      }
    }
    buildNodeGroup(element, articleRect, depth) {
      const terminalClassName = terminalTagClassNames.get(element.tagName);
      const blockClassName = blockTagClassNames.get(element.tagName);
      const includeSelf = depth === 0 || typeof terminalClassName !== "undefined" || typeof blockClassName !== "undefined";
      if (!includeSelf) {
        const passthroughGroup = this.createSvgElement("g");
        for (const child of Array.from(element.children)) {
          if (!(child instanceof HTMLElement)) {
            continue;
          }
          const childGroup = this.buildNodeGroup(child, articleRect, depth);
          if (childGroup) {
            passthroughGroup.appendChild(childGroup);
          }
        }
        return passthroughGroup.childNodes.length > 0 ? passthroughGroup : null;
      }
      const className = terminalClassName ?? blockClassName ?? "unknown";
      const rect = element.getBoundingClientRect();
      const y = Math.max(0, rect.top - articleRect.top);
      const height = Math.max(1.5, rect.height);
      const inset = Math.min(this.options.minimapWidth - 6, depth * 6 + 2);
      const width = Math.max(4, this.options.minimapWidth - inset - 2);
      if (typeof terminalClassName !== "undefined") {
        return this.createNodeRect(element, className, inset, y, width, height, depth);
      }
      const group = this.createSvgElement("g");
      group.setAttribute("class", className);
      group.setAttribute("data-node-name", element.tagName);
      group.setAttribute("data-depth", String(depth));
      group.appendChild(this.createNodeRect(element, className, inset, y, width, height, depth));
      for (const child of Array.from(element.children)) {
        if (!(child instanceof HTMLElement)) {
          continue;
        }
        const childGroup = this.buildNodeGroup(child, articleRect, depth + 1);
        if (childGroup) {
          group.appendChild(childGroup);
        }
      }
      return group;
    }
    createSvgElement(tagName) {
      return document.createElementNS(_Minimap.svgNamespace, tagName);
    }
    createNodeRect(element, className, inset, y, width, height, depth) {
      const shape = this.createSvgElement("rect");
      shape.setAttribute("class", className);
      shape.setAttribute("data-depth", String(depth));
      shape.setAttribute("x", String(inset));
      shape.setAttribute("y", String(y));
      shape.setAttribute("width", String(width));
      shape.setAttribute("height", String(height));
      shape.setAttribute("rx", "1");
      return shape;
    }
  };
  __publicField(_Minimap, "svgNamespace", "http://www.w3.org/2000/svg");
  let Minimap = _Minimap;
  class ScrollState {
    constructor(width, scrollWidth, scrollLeft, height, scrollHeight, scrollTop) {
      __publicField(this, "rawScrollLeft");
      __publicField(this, "rawScrollTop");
      __publicField(this, "width");
      __publicField(this, "scrollWidth");
      __publicField(this, "scrollLeft");
      __publicField(this, "height");
      __publicField(this, "scrollHeight");
      __publicField(this, "scrollTop");
      width = width | 0;
      scrollWidth = scrollWidth | 0;
      scrollLeft = scrollLeft | 0;
      height = height | 0;
      scrollHeight = scrollHeight | 0;
      scrollTop = scrollTop | 0;
      this.rawScrollLeft = scrollLeft;
      this.rawScrollTop = scrollTop;
      if (width < 0) {
        width = 0;
      }
      if (scrollLeft + width > scrollWidth) {
        scrollLeft = scrollWidth - width;
      }
      if (scrollLeft < 0) {
        scrollLeft = 0;
      }
      if (height < 0) {
        height = 0;
      }
      if (scrollTop + height > scrollHeight) {
        scrollTop = scrollHeight - height;
      }
      if (scrollTop < 0) {
        scrollTop = 0;
      }
      this.width = width;
      this.scrollWidth = scrollWidth;
      this.scrollLeft = scrollLeft;
      this.height = height;
      this.scrollHeight = scrollHeight;
      this.scrollTop = scrollTop;
    }
    equals(other) {
      return this.rawScrollLeft === other.rawScrollLeft && this.rawScrollTop === other.rawScrollTop && this.width === other.width && this.scrollWidth === other.scrollWidth && this.scrollLeft === other.scrollLeft && this.height === other.height && this.scrollHeight === other.scrollHeight && this.scrollTop === other.scrollTop;
    }
    withScrollDimensions(update, useRawScrollPositions) {
      return new ScrollState(
        typeof update.width !== "undefined" ? update.width : this.width,
        typeof update.scrollWidth !== "undefined" ? update.scrollWidth : this.scrollWidth,
        useRawScrollPositions ? this.rawScrollLeft : this.scrollLeft,
        typeof update.height !== "undefined" ? update.height : this.height,
        typeof update.scrollHeight !== "undefined" ? update.scrollHeight : this.scrollHeight,
        useRawScrollPositions ? this.rawScrollTop : this.scrollTop
      );
    }
    withScrollPosition(update) {
      return new ScrollState(
        this.width,
        this.scrollWidth,
        typeof update.scrollLeft !== "undefined" ? update.scrollLeft : this.rawScrollLeft,
        this.height,
        this.scrollHeight,
        typeof update.scrollTop !== "undefined" ? update.scrollTop : this.rawScrollTop
      );
    }
    createScrollEvent(previous) {
      return {
        inSmoothScrolling: false,
        oldWidth: previous.width,
        oldScrollWidth: previous.scrollWidth,
        oldScrollLeft: previous.scrollLeft,
        width: this.width,
        scrollWidth: this.scrollWidth,
        scrollLeft: this.scrollLeft,
        oldHeight: previous.height,
        oldScrollHeight: previous.scrollHeight,
        oldScrollTop: previous.scrollTop,
        height: this.height,
        scrollHeight: this.scrollHeight,
        scrollTop: this.scrollTop,
        widthChanged: this.width !== previous.width,
        scrollWidthChanged: this.scrollWidth !== previous.scrollWidth,
        scrollLeftChanged: this.scrollLeft !== previous.scrollLeft,
        heightChanged: this.height !== previous.height,
        scrollHeightChanged: this.scrollHeight !== previous.scrollHeight,
        scrollTopChanged: this.scrollTop !== previous.scrollTop
      };
    }
  }
  class Scrollable extends Disposable {
    constructor() {
      super();
      __publicField(this, "state");
      __publicField(this, "onScrollEmitter", this.register(new Emitter()));
      __publicField(this, "onScroll", this.onScrollEmitter.event);
      this.state = new ScrollState(0, 0, 0, 0, 0, 0);
    }
    getScrollDimensions() {
      return this.state;
    }
    setScrollDimensions(dimensions, useRawScrollPositions) {
      const newState = this.state.withScrollDimensions(dimensions, useRawScrollPositions);
      this.setState(newState);
    }
    getCurrentScrollPosition() {
      return this.state;
    }
    setScrollPositionNow(update) {
      const newState = this.state.withScrollPosition(update);
      this.setState(newState);
    }
    setState(newState) {
      const oldState = this.state;
      if (oldState.equals(newState)) {
        return;
      }
      this.state = newState;
      this.onScrollEmitter.fire(this.state.createScrollEvent(oldState));
    }
  }
  const DEFAULT_OPTIONS$1 = {
    width: 14,
    cursorColor: "rgba(160, 160, 160, 0.8)",
    minMarkerHeight: 2
  };
  class ScrollbarTrack extends ScrollTrackOverlay {
    constructor(scrollable, options) {
      const opts = { ...DEFAULT_OPTIONS$1, ...options };
      const canvas = document.createElement("canvas");
      super(scrollable, "track", opts.width, canvas, true);
      __publicField(this, "canvas");
      __publicField(this, "options");
      __publicField(this, "markers", []);
      __publicField(this, "cursorOffset", -1);
      this.canvas = canvas;
      this.options = opts;
    }
    getThumbClassName() {
      return "thumb";
    }
    get width() {
      return this.options.width;
    }
    setMarkers(markers) {
      this.markers = markers;
    }
    /** Pixel offset of the caret / current-position indicator; negative hides it. */
    setCursorOffset(offset) {
      this.cursorOffset = offset;
    }
    /**
     * Appearance that a stylesheet gets to decide, resolved off the track's own
     * computed style.
     *
     * Markers are painted onto a canvas, so they are invisible to CSS unless the
     * values are read back out like this. Colour rides on the `color` property
     * rather than being read raw from the custom property, so the browser has
     * already resolved whatever the consumer wrote — `color-mix()`, a variable
     * chain, anything — into something the canvas understands.
     */
    readMarkerStyling() {
      const computed = getComputedStyle(this.domNode.domNode);
      const declaredMinHeight = Number.parseFloat(
        computed.getPropertyValue("--vugluscr_marker_min_height")
      );
      return {
        minHeight: Number.isFinite(declaredMinHeight) ? declaredMinHeight : this.options.minMarkerHeight,
        color: computed.color
      };
    }
    renderSurface() {
      const dpr = window.devicePixelRatio || 1;
      const width = this.options.width;
      const height = this.viewportHeight;
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
      this.canvas.style.width = width + "px";
      this.canvas.style.height = height + "px";
      const context = this.canvas.getContext("2d");
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.scale(dpr, dpr);
      context.clearRect(0, 0, width, height);
      const dimensions = this.scrollable.getScrollDimensions();
      if (dimensions.scrollHeight <= 0) {
        return;
      }
      const heightRatio = height / dimensions.scrollHeight;
      const styling = this.readMarkerStyling();
      const minHeight = styling.minHeight;
      const halfMinHeight = minHeight / 2;
      const markersByColor = /* @__PURE__ */ new Map();
      for (const marker of this.markers) {
        const color = marker.color ?? styling.color;
        const group = markersByColor.get(color) || [];
        group.push(marker);
        markersByColor.set(color, group);
      }
      for (const [color, markers] of markersByColor) {
        context.fillStyle = color;
        for (const marker of markers) {
          let y1 = marker.start * heightRatio;
          let y2 = (marker.end ?? marker.start) * heightRatio;
          if (y2 - y1 < minHeight) {
            let yCenter = (y1 + y2) / 2;
            if (yCenter < halfMinHeight) {
              yCenter = halfMinHeight;
            }
            if (yCenter + halfMinHeight > height) {
              yCenter = height - halfMinHeight;
            }
            y1 = yCenter - halfMinHeight;
            y2 = yCenter + halfMinHeight;
          }
          const lane = marker.lane ?? "full";
          let x = 0;
          const laneWidth = lane === "full" ? width : width / 3;
          if (lane === "center") {
            x = laneWidth;
          } else if (lane === "right") {
            x = 2 * laneWidth;
          }
          context.fillRect(x, y1, laneWidth, y2 - y1);
        }
      }
      if (this.cursorOffset >= 0) {
        const cursorY = this.cursorOffset * heightRatio;
        context.fillStyle = this.options.cursorColor;
        context.fillRect(0, cursorY, width, 2);
      }
    }
  }
  const structureCss = `
@layer vugluscr.structure, vugluscr.theme;

@layer vugluscr.structure {
	html.vugluscr_active,
	.vugluscr_embedded {
		scrollbar-width: none;
	}

	html.vugluscr_active::-webkit-scrollbar,
	.vugluscr_embedded::-webkit-scrollbar {
		display: none;
	}

	@scope (.vugluscr) {
		:scope {
			position: relative;
		}

		:scope.is_embedded {
			position: absolute;
			inset: 0;
			pointer-events: none;
			z-index: 5;
		}

		.scrollbar {
			position: fixed;
			top: 0;
			right: 0;
			z-index: 5;
			display: flex;
			align-items: stretch;
			pointer-events: none;

			> * {
				pointer-events: auto;
			}
		}

		:scope.is_embedded .scrollbar {
			position: absolute;
		}

		.minimap {
			position: relative;
			overflow: hidden;

			svg {
				position: absolute;
				top: 0;
				left: 0;
				display: block;
			}

			.thumb {
				position: absolute;
				left: 0;
				right: 0;
				pointer-events: none;
			}
		}

		.track {
			position: relative;
			overflow: hidden;
			box-sizing: border-box;

			canvas {
				position: absolute;
				top: 0;
				left: 0;
				display: block;
			}

			.thumb {
				position: absolute;
				left: 0;
				right: 0;
				pointer-events: auto;
			}
		}
	}
}
`;
  const markerAttribute = "data-vugluscr";
  function injectStructureStyles() {
    if (document.querySelector(`style[${markerAttribute}="structure"]`)) {
      return;
    }
    const styleElement = document.createElement("style");
    styleElement.setAttribute(markerAttribute, "structure");
    styleElement.textContent = structureCss;
    document.head.appendChild(styleElement);
  }
  const DEFAULT_OPTIONS = {
    showMinimap: true
  };
  class ScrollRail extends Disposable {
    constructor(options) {
      super();
      __publicField(this, "node");
      __publicField(this, "options");
      __publicField(this, "scrollable");
      __publicField(this, "track");
      __publicField(this, "minimap");
      __publicField(this, "onScrollEmitter", this.register(new Emitter()));
      __publicField(this, "onScroll", this.onScrollEmitter.event);
      injectStructureStyles();
      this.options = { ...DEFAULT_OPTIONS, ...options };
      this.scrollable = this.register(new Scrollable());
      this.node = createCachedDomNode(document.createElement("div"));
      this.node.setClassName("scrollbar");
      this.minimap = this.options.showMinimap ? this.register(new Minimap(this.scrollable, this.options.minimap)) : null;
      if (this.minimap) {
        this.node.appendChild(this.minimap.domNode);
      }
      this.track = this.register(new ScrollbarTrack(this.scrollable, this.options.track));
      this.node.appendChild(this.track.domNode);
      this.register(
        this.scrollable.onScroll((event) => {
          this.onScrollEmitter.fire(event);
        })
      );
    }
    /**
     * The rail's root element, for a host that needs to place or measure it. The
     * write-caching wrapper it is really driven through stays internal — mutating
     * the element's geometry from outside would desynchronise that cache.
     */
    get domNode() {
      return this.node.domNode;
    }
    get width() {
      var _a;
      return this.track.width + (((_a = this.minimap) == null ? void 0 : _a.width) ?? 0);
    }
    getScrollDimensions() {
      return this.scrollable.getScrollDimensions();
    }
    setScrollDimensions(dimensions, useRawScrollPositions) {
      this.scrollable.setScrollDimensions(dimensions, useRawScrollPositions);
    }
    getCurrentScrollPosition() {
      return this.scrollable.getCurrentScrollPosition();
    }
    setScrollPositionNow(update) {
      this.scrollable.setScrollPositionNow(update);
    }
    layout(height) {
      var _a;
      this.node.setHeight(height);
      (_a = this.minimap) == null ? void 0 : _a.layout(height);
      this.track.layout(height);
    }
    renderNow() {
      var _a;
      (_a = this.minimap) == null ? void 0 : _a.renderNow();
      this.track.renderNow();
    }
    setMinimapSource(element) {
      var _a;
      (_a = this.minimap) == null ? void 0 : _a.setSourceElement(element);
    }
    setMarkers(markers) {
      this.track.setMarkers(markers);
    }
    setCursorOffset(offset) {
      this.track.setCursorOffset(offset);
    }
  }
  function createWindowScrollHost() {
    return {
      getScrollTop: () => window.scrollY,
      getScrollLeft: () => window.scrollX,
      getViewportWidth: () => window.innerWidth,
      getViewportHeight: () => window.innerHeight,
      getScrollHeight: () => document.documentElement.scrollHeight,
      scrollTo: (left, top) => window.scrollTo(left, top),
      addScrollListener: (listener) => {
        window.addEventListener("scroll", listener, { passive: true });
        return { dispose: () => window.removeEventListener("scroll", listener) };
      }
    };
  }
  function createElementScrollHost(element) {
    return {
      getScrollTop: () => element.scrollTop,
      getScrollLeft: () => element.scrollLeft,
      getViewportWidth: () => element.clientWidth,
      getViewportHeight: () => element.clientHeight,
      getScrollHeight: () => element.scrollHeight,
      scrollTo: (left, top) => element.scrollTo(left, top),
      addScrollListener: (listener) => {
        element.addEventListener("scroll", listener, { passive: true });
        return { dispose: () => element.removeEventListener("scroll", listener) };
      }
    };
  }
  class Scrollbar extends Disposable {
    constructor(options = {}) {
      super();
      __publicField(this, "container");
      __publicField(this, "contentElement");
      __publicField(this, "scrollHost");
      __publicField(this, "navigationLayer");
      __publicField(this, "rail");
      __publicField(this, "autoHide");
      __publicField(this, "onLayoutEmitter", this.register(new Emitter()));
      /**
       * Fires after each layout pass, once geometry has settled — where a consumer
       * recomputes marker offsets that depend on element positions.
       *
       * Returns something with a `dispose()` method; call it to unsubscribe.
       */
      __publicField(this, "onLayout", this.onLayoutEmitter.event);
      __publicField(this, "viewportHeight", 0);
      __publicField(this, "contentWidth", 0);
      __publicField(this, "hidden", false);
      /**
       * Loop guard: while syncing native scroll into the scrollbar, suppress the
       * scrollbar's `onScroll` so it doesn't scroll native back and ping-pong.
       */
      __publicField(this, "nativeScrollActive", false);
      const scrollContainer = options.scrollContainer;
      this.autoHide = options.autoHide ?? true;
      this.scrollHost = scrollContainer ? createElementScrollHost(scrollContainer) : createWindowScrollHost();
      this.container = options.container ?? (scrollContainer == null ? void 0 : scrollContainer.parentElement) ?? document.body;
      this.contentElement = options.contentElement ?? (scrollContainer == null ? void 0 : scrollContainer.firstElementChild) ?? document.body;
      if (scrollContainer) {
        if (getComputedStyle(this.container).position === "static") {
          this.forceStyle(this.container, "position", "relative");
        }
        this.forceStyle(scrollContainer, "overflow", "auto");
        this.forceStyle(scrollContainer, "min-block-size", "0");
        scrollContainer.classList.add("vugluscr_embedded");
        this.register({ dispose: () => scrollContainer.classList.remove("vugluscr_embedded") });
      } else {
        document.documentElement.classList.add("vugluscr_active");
        this.register({
          dispose: () => document.documentElement.classList.remove("vugluscr_active")
        });
      }
      const previousPaddingRight = this.container.style.paddingRight;
      this.register({
        dispose: () => {
          if (previousPaddingRight)
            this.container.style.paddingRight = previousPaddingRight;
          else
            this.container.style.removeProperty("padding-right");
        }
      });
      this.navigationLayer = createCachedDomNode(document.createElement("div"));
      this.navigationLayer.setClassName(scrollContainer ? "vugluscr is_embedded" : "vugluscr");
      this.container.appendChild(this.navigationLayer.domNode);
      this.register({ dispose: () => this.navigationLayer.domNode.remove() });
      this.rail = this.register(
        new ScrollRail({
          showMinimap: options.showMinimap ?? true,
          minimap: { showThumb: "mouseover", ...options.minimap },
          track: options.track
        })
      );
      this.rail.setMinimapSource(this.contentElement);
      this.navigationLayer.domNode.appendChild(this.rail.domNode);
      const onNativeScroll = () => {
        this.nativeScrollActive = true;
        this.rail.setScrollPositionNow({
          scrollTop: this.scrollHost.getScrollTop(),
          scrollLeft: this.scrollHost.getScrollLeft()
        });
        this.nativeScrollActive = false;
      };
      this.register(this.scrollHost.addScrollListener(onNativeScroll));
      this.register(
        this.rail.onScroll(() => {
          if (this.nativeScrollActive)
            return;
          const position = this.rail.getCurrentScrollPosition();
          this.scrollHost.scrollTo(position.scrollLeft, position.scrollTop);
        })
      );
      const railElement = this.rail.domNode;
      const onRailWheel = (event) => {
        if (event.deltaY === 0 && event.deltaX === 0)
          return;
        const linePx = 16;
        const dyPx = event.deltaMode === 1 ? event.deltaY * linePx : event.deltaMode === 2 ? event.deltaY * this.scrollHost.getViewportHeight() : event.deltaY;
        const dxPx = event.deltaMode === 1 ? event.deltaX * linePx : event.deltaMode === 2 ? event.deltaX * this.scrollHost.getViewportWidth() : event.deltaX;
        this.scrollHost.scrollTo(
          this.scrollHost.getScrollLeft() + dxPx,
          this.scrollHost.getScrollTop() + dyPx
        );
        event.preventDefault();
      };
      railElement.addEventListener("wheel", onRailWheel, { passive: false });
      this.register({
        dispose: () => railElement.removeEventListener("wheel", onRailWheel)
      });
      const resizeObserver = new ResizeObserver(() => this.layout());
      resizeObserver.observe(this.container);
      if (this.contentElement !== this.container) {
        resizeObserver.observe(this.contentElement);
      }
      this.register({ dispose: () => resizeObserver.disconnect() });
      const onFullscreenChange = () => this.layout();
      document.addEventListener("fullscreenchange", onFullscreenChange);
      this.register({
        dispose: () => document.removeEventListener("fullscreenchange", onFullscreenChange)
      });
      this.rail.setMarkers([]);
      this.rail.setCursorOffset(-1);
      const images = this.contentElement.querySelectorAll("img");
      let pendingLayoutFrame = null;
      const scheduleLayout = () => {
        if (pendingLayoutFrame !== null)
          return;
        pendingLayoutFrame = requestAnimationFrame(() => {
          pendingLayoutFrame = null;
          this.layout();
        });
      };
      for (const img of images) {
        img.addEventListener("load", scheduleLayout, { once: true });
      }
      this.register({
        dispose: () => {
          if (pendingLayoutFrame !== null)
            cancelAnimationFrame(pendingLayoutFrame);
        }
      });
      requestAnimationFrame(() => this.layout());
    }
    /**
     * Draw these markers on the track, replacing whatever was there. Offsets are
     * in pixels down `contentElement`, so they have to be recomputed whenever
     * geometry changes — see {@link onLayout}.
     */
    setMarkers(markers) {
      this.rail.setMarkers(markers);
      this.rail.renderNow();
    }
    /**
     * Position a current-position indicator on the track.
     *
     * @param offset Pixels down `contentElement`; negative hides the indicator.
     */
    setCursorOffset(offset) {
      this.rail.setCursorOffset(offset);
      this.rail.renderNow();
    }
    /** Total width the rail occupies — track plus minimap. */
    get width() {
      return this.rail.width;
    }
    /**
     * Set an inline style property on an element and register a disposer that
     * restores its previous inline value (empty → removed). Lets the rail own
     * the layout its mechanism requires without permanently mutating consumer
     * DOM.
     */
    forceStyle(element, property, value) {
      const previous = element.style.getPropertyValue(property);
      element.style.setProperty(property, value);
      this.register({
        dispose: () => {
          if (previous)
            element.style.setProperty(property, previous);
          else
            element.style.removeProperty(property);
        }
      });
    }
    setHidden(hidden) {
      if (hidden === this.hidden)
        return;
      this.hidden = hidden;
      this.navigationLayer.domNode.hidden = hidden;
      if (hidden)
        this.container.style.removeProperty("padding-right");
      else
        this.container.style.paddingRight = this.rail.width + "px";
    }
    layout() {
      const scrollHeight = this.scrollHost.getScrollHeight();
      const viewportHeight = this.scrollHost.getViewportHeight();
      if (this.autoHide && (document.fullscreenElement !== null || scrollHeight <= viewportHeight)) {
        this.setHidden(true);
        this.onLayoutEmitter.fire();
        return;
      }
      this.setHidden(false);
      this.nativeScrollActive = true;
      this.viewportHeight = viewportHeight;
      this.contentWidth = Math.max(0, this.scrollHost.getViewportWidth() - this.rail.width);
      this.container.style.paddingRight = this.rail.width + "px";
      const scrollWidth = Math.max(this.contentWidth, this.contentElement.scrollWidth);
      this.rail.setScrollDimensions(
        {
          width: this.contentWidth,
          height: this.viewportHeight,
          scrollWidth,
          scrollHeight
        },
        true
      );
      this.rail.setScrollPositionNow({
        scrollTop: this.scrollHost.getScrollTop(),
        scrollLeft: this.scrollHost.getScrollLeft()
      });
      this.rail.layout(this.viewportHeight);
      this.nativeScrollActive = false;
      this.onLayoutEmitter.fire();
    }
  }
  exports.Scrollbar = Scrollbar;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
}({});
