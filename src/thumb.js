// ScrollPeak — the rail's clone thumb.
//
// The map base is the page's own rendering: the shared snapshot (clone.js) is
// mounted into the strip and scaled so the whole document fits the groove. No
// vocabulary, no renderer selection, no per-site rules — a picture, a player,
// a canvas or a column layout is whatever the browser painted.
//
// The frame is sized like the preview's (the clone's own layout width by the
// page's viewport height, so vh and media queries resolve as on the page) and
// the wrap inside it carries the scale that fits it into the strip. The frame
// itself is clipped by the .scrollpeak-thumb container; the overlay canvas
// sits above it for the viewport fade and band patches.

(function () {
  function mount(strip, opts) {
    const container = document.createElement("div");
    container.className = "scrollpeak-thumb";
    // Before whatever is already in the strip (the overlay canvas), so the
    // clone is the bottom layer and the fade draws over it.
    strip.insertBefore(container, strip.firstChild);

    let width = 1;
    let cloneHeight = 1;

    const inst = globalThis.ScrollPeakClone.createInstance(container, {
      frameClass: "scrollpeak-thumb__frame",
      pageClass: "scrollpeak-thumb__page",
      onReady: () => {
        if (opts.onReady) opts.onReady();
      },
    });

    function apply() {
      if (!inst.wrap) return;
      const rect = container.getBoundingClientRect();
      const w = Math.max(1, rect.width || inst.frame.clientWidth || 1);
      const h = Math.max(1, rect.height || inst.frame.clientHeight || 1);
      // Fractional: the clone can reflow to a different height than the page,
      // and the strip maps the document proportionally, so the clone is fitted
      // by its own height. The strip does the same thing to the raster.
      inst.wrap.style.transform =
        `scale(${w / Math.max(1, width)}, ${h / Math.max(1, cloneHeight)})`;
    }

    /** Mount the current snapshot. Returns clone.js's fill result. */
    function fill(snapshot) {
      width = globalThis.ScrollPeakClone.previewWidth(opts.settings);
      const res = inst.fill(snapshot, {
        width,
        fixedIndices: opts.getFixedIndices ? opts.getFixedIndices() : null,
        onFonts: () => {
          cloneHeight = inst.measureHeight();
          apply();
        },
      });
      if (!res.ok) return res;
      cloneHeight = res.cloneHeight;
      apply();
      return res;
    }

    /** The strip was resized; the fit is geometry, so no rebuild is needed. */
    function setSize() {
      apply();
    }

    function dispose() {
      inst.dispose();
      container.remove();
    }

    return {
      el: container,
      fill,
      setSize,
      dispose,
      get cloneHeight() { return cloneHeight; },
    };
  }

  globalThis.ScrollPeakThumb = { mount };
})();
