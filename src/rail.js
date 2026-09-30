// ScrollPeak — mounts the vugluscr rail and installs our own minimap.
//
// Division of labour, decided against Kate's reference implementation:
//
//   vugluscr keeps  the scrollbar mechanics. The thumb, click-to-jump,
//                    drag-to-continue, wheel forwarding, the strip's hit area,
//                    and the SVG whose viewBox is in document pixels -- which
//                    is the coordinate space the preview needs.
//   we replace      the map rendering. Kate rasterises the document's text one
//                    pixel per character; vugluscr draws a rectangle per
//                    element. Different features, so we do not use vugluscr's.
//
// vugluscr's own walk is switched off rather than left running underneath.
// Minimap.renderSurface() returns immediately when sourceElement is null,
// after it has set the viewBox -- so nulling it costs us nothing we use and
// saves a full getBoundingClientRect sweep of the document on every layout.
//
// Kate's timing is preserved exactly: m_updateTimer is 300ms and rebuilds the
// pixmap, and scrolling only repaints. That split is the whole performance
// story -- building the map is expensive, stretching it is not.

(function () {
  function mount(settings, theme) {
    const scroller = document.scrollingElement || document.documentElement;
    const content = document.body;
    if (!scroller || !content) return null;

    // Which map base: the page's own rendering (clone) or Kate's raster. The
    // raster stays as the fallback while the clone mounts, and as the escape
    // hatch if a page cannot be cloned at all.
    const mapMode = settings.mapMode === "clone" ? "clone" : "raster";

    let rail;
    try {
      rail = new globalThis.Vugluscr.Scrollbar({
        contentElement: content,
        showMinimap: true,
        // Kate's ShowWhenNeeded. "always" means the rail stays even on a page
        // that fits, which is what m_autoHide = false gives us here; vugluscr
        // also hides the rail in fullscreen either way, which is right.
        autoHide: settings.scrollbarMode !== "always",
        minimap: {
          // Kate's default: m_miniMapWidth(40)
          minimapWidth: settings.minimapWidth,
          // Kate always paints the current-viewport marker.
          showThumb: "always",
        },
      });
    } catch (err) {
      console.warn("[ScrollPeak] could not mount rail:", err);
      return null;
    }

    const minimap = rail.rail?.minimap;
    if (!minimap?.svg) {
      rail.dispose();
      return null;
    }

    // Stop vugluscr drawing its block map. See the note above.
    try {
      minimap.setSourceElement(null);
    } catch (err) {
      console.warn("[ScrollPeak] could not disable vugluscr map:", err);
    }

    const strip = minimap.domNode.domNode;
    const map = new globalThis.ScrollPeakTextMap.TextMap({
      width: settings.minimapWidth,
      height: window.innerHeight,
    });
    strip.insertBefore(map.canvas, strip.firstChild);

    // The fade is read off the real thumb, so the map and the scrollbar can
    // never show the viewport in two different places.
    map.setThumbEl(minimap.thumb?.domNode ?? null);

    // Strip background and mark contrast. Re-applied wherever the inputs can
    // have moved: a relayout, and every collect(), because a page's background
    // can change under a dark-mode media query and the default is derived
    // from it.
    let themePalette = theme || null;

    /**
     * Push the resolved palette at the CSS.
     *
     * Every colour the rail draws comes from here, so the strip, the thumb
     * and the rail's own chrome cannot end up in three unrelated schemes --
     * and the accent follows the Firefox theme when one is installed, rather
     * than being a hardcoded blue that is wrong on every machine but the one
     * it was picked on. Written to <html> because that is where content.css
     * sets them, and where vugluscr reads them from.
     */
    function applyAppearance() {
      map.setAppearance({ ...settings, theme: themePalette });
      const root = document.documentElement.style;
      const { background, ink, accent, source } = map.palette;
      root.setProperty("--sp-strip", background);
      root.setProperty("--sp-ink", ink);
      if (accent) root.setProperty("--sp-accent", accent);
      // Read by the appearance test, and the first thing to check when the
      // strip is the wrong colour.
      root.setProperty("--sp-palette-source", source);
    }
    applyAppearance();

    /**
     * Is the pointer on the rail?
     *
     * A rebuild is not free: collect() walks every text node in the page and
     * buildPixmap() rasterises them all, and on a long article that is tens of
     * milliseconds. It runs on a timer, so it lands whenever it lands -- which
     * at speed is the middle of a drag, and the preview visibly stalls and then
     * catches up. While the pointer is on the rail nothing is rebuilt; it
     * happens as soon as the pointer leaves. Nothing is lost: a map built a
     * moment late is no less correct.
     */
    let pointerOnRail = false;

    // Freshness bookkeeping: the base's signature for each band, the document
    // height the last settle saw, and the policy that schedules the work.
    let bandSigs = new Map();
    let lastBandHeight = 0;
    let policy = null;

    function stepHeight() {
      return Math.max(1, window.innerHeight);
    }

    // The clone snapshot the preview (and, in clone mode, the rail thumb)
    // mounts. It is built from the same collect() as the raster pixmap, so a
    // revision is a consistent picture of the page, and it is shared between
    // the views. Built lazily, on demand; the fixed-element indices found by
    // the first mount are reused by every later one.
    let snapshot = null;
    let snapshotRev = -1;
    let fixedIndices = null;
    // The rail's clone thumb, when the page is mapped that way. Null in raster
    // mode, which is the fallback and the escape hatch.
    let thumb = null;

    function getSnapshot() {
      if (!snapshot || snapshotRev !== map.revision) {
        snapshot = globalThis.ScrollPeakClone.snapshotPage();
        snapshotRev = map.revision;
        fixedIndices = null;
      }
      return snapshot;
    }

    function buildMap() {
      const t0 = performance.now();
      map.collect(content);
      if (mapMode === "clone") applyThumb();
      // In clone mode the thumb is the map and there is nothing to rasterise;
      // the pixmap is built only while the thumb is unavailable (its frame
      // still loading, or a mount that failed).
      if (map.renderMode === "raster") map.buildPixmap();
      map.paint(scroller.scrollTop, window.innerHeight);
      if (map.renderMode === "clone") {
        // The base is fresh wherever the live page agrees with it. Record a
        // signature for every band it holds, so a settle only patches a real
        // change; clear patches, whose content the new base supersedes.
        map.clearPatches();
        bandSigs = map.bandSignatures(stepHeight());
        lastBandHeight = scroller.scrollHeight;
      }
      publishStats();
      // Worth seeing: collect() walks every text node in the page and is the
      // only genuinely expensive thing this extension does. In the
      // content-script console (about:debugging -> Inspect, with "Enable
      // JavaScript debugging" ticked) this is the first place to look if a
      // big page feels heavy.
      console.debug(
        `[ScrollPeak] ${map.lines.length} lines, mode=${map.renderMode}, ` +
        `thumb=${thumb ? "yes" : "no"}, ${(performance.now() - t0).toFixed(1)}ms`,
      );
    }

    /**
     * Mount the current snapshot into the rail thumb, and switch the strip to
     * it. Returns false while the frame is still loading or the page cannot be
     * cloned, which leaves the raster map in place.
     */
    function applyThumb() {
      if (!thumb) return false;
      try {
        const res = thumb.fill(getSnapshot());
        if (!res.ok) return false;
        if (res.fixedIndices) fixedIndices = res.fixedIndices;
        map.setRenderMode("clone");
        return true;
      } catch (err) {
        document.documentElement.dataset.sperr = String(err && err.stack || err);
        map.setRenderMode("raster");
        return false;
      }
    }

    function rebuild(force = false) {
      policy?.requestRebuild(force);
    }

    function publishStats() {
      if (!policy) return;
      map.canvas.dataset.engine = JSON.stringify(
        { ...policy.stats, patches: map.patches.length });
    }

    /**
     * One look at the band the viewport is in, at scroll settle.
     *
     * The base already holds the band when the live sample hashes the same as
     * the signature recorded at the last rebuild. When it differs the base is
     * stale there — content loaded, changed, or was recycled in — and a text
     * patch is drawn over just that band. Returns what freshness.js needs to
     * recognise a recycling page.
     */
    function bandTick() {
      if (map.renderMode !== "clone") return { checked: false };
      const step = stepHeight();
      const docH = Math.max(1, scroller.scrollHeight);
      const y0 = Math.floor(scroller.scrollTop / step) * step;
      const y1 = Math.min(y0 + step, docH);
      const sample = map.sampleBand(y0, y1, step);
      const prev = bandSigs.get(sample.key);
      const changed = prev !== sample.sig;
      const differed = changed && sample.lines.length > 0;
      const stable = docH === lastBandHeight;
      lastBandHeight = docH;
      if (differed) {
        bandSigs.set(sample.key, sample.sig);
        map.addBandPatch(sample.key, sample.lines);
        repaint();
      }
      publishStats();
      return { checked: true, differed, stable };
    }

    /** Kate's cheap per-frame path: no DOM work at all. */
    function repaint() {
      map.paint(scroller.scrollTop, window.innerHeight);
    }

    function relayout() {
      const h = strip.clientHeight || window.innerHeight;
      applyAppearance();
      // Fitting the clone into the groove is geometry, not content: rescale
      // without rebuilding.
      thumb?.setSize();
      if (map.setSize(settings.minimapWidth, h)) rebuild(true);
    }

    rail.onLayout(() => {
      repaint();
      relayout();
    });

    // Kate connects his timer to the view's scroll updates as well; scrolling
    // never triggers a rebuild on its own, it only repaints.
    window.addEventListener("scroll", repaint, { passive: true });
    window.addEventListener("resize", relayout, { passive: true });

    // The system appearance can change while the page is open: the OS flips at
    // sunset, or the user changes it in the browser. The default strip colour
    // follows it when the page paints no background of its own, so re-derive and
    // repaint. Only colours change here, so nothing is rebuilt.
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const onSchemeChange = () => {
      applyAppearance();
      repaint();
    };
    if (scheme.addEventListener) scheme.addEventListener("change", onSchemeChange);
    else scheme.addListener(onSchemeChange);

    const railNode = rail.rail.domNode;
    const onRailEnter = () => {
      pointerOnRail = true;
    };
    const onRailLeave = () => {
      pointerOnRail = false;
      // Pick up whatever was deferred while the pointer was here.
      policy?.resume();
    };
    railNode.addEventListener("pointerenter", onRailEnter);
    railNode.addEventListener("pointerleave", onRailLeave);

    const observer = new ResizeObserver(relayout);
    observer.observe(content);
    observer.observe(strip);

    // The update policy. A mutation only raises a flag inside it; the rebuild
    // happens after the debounce and at scroll settle, never mid-scroll and
    // never while the pointer is on the rail. On a page that recycles its
    // content the policy stops scheduling full rebuilds and the rail patches
    // only the bands the user lands on. See freshness.js.
    policy = globalThis.ScrollPeakFreshness.create({
      onRebuild: () => buildMap(),
      onSettle: () => bandTick(),
      isHeld: () => pointerOnRail,
      minInterval: mapMode === "clone" ? 1000 : 0,
      now: () => performance.now(),
    });

    // The rail's clone thumb. Created here, just before the first build, so
    // the snapshot it mounts is the one that build produces. Its frame loads
    // asynchronously: until then the raster map is shown, and onReady fills
    // the thumb and switches the strip over.
    if (mapMode === "clone") {
      thumb = globalThis.ScrollPeakThumb.mount(strip, {
        settings,
        getFixedIndices: () => fixedIndices,
        onReady: () => {
          if (applyThumb()) repaint();
        },
      });
    }

    // First paint. Kate defers this to showEvent; we cannot wait for the
    // strip to be visible, so build it straight away.
    try {
      buildMap();
    } catch (err) {
      document.documentElement.dataset.sperr = String(err && err.stack || err);
      throw err;
    }

    // --- rail-level appearance -------------------------------------------
    //
    // Both of these are set as classes on <html> and acted on in content.css,
    // because they change the rail's layout rather than the map's pixels.

    /** "Minimap only": drop the track so the rail is just the map. */
    function applyTrackVisibility() {
      document.documentElement.classList.toggle(
        "scrollpeak-minimap-only", Boolean(settings.hideTrack));
    }

    /**
     * "Peek": park the rail off the right edge until the user scrolls or
     * brings the pointer near it.
     *
     * The rail is still in the layout while hidden -- only transformed -- so
     * the page keeps its padding and nothing reflows when it appears.
     */
    let peekTimer = null;
    function applyPeek() {
      const on = Boolean(settings.hideWhenIdle);
      document.documentElement.classList.toggle("scrollpeak-peek", on);
      if (!on) {
        // classList.toggle(token, undefined) is treated as *no force
        // argument*, so it toggles rather than removes. Remove explicitly, or
        // the class list claims the rail is showing when peek is off.
        clearTimeout(peekTimer);
        peekTimer = null;
        document.documentElement.classList.remove("scrollpeak-visible");
        return;
      }
      peek(true);
    }

    function peek(show) {
      const root = document.documentElement;
      const visible = Boolean(show);
      if (visible) root.classList.add("scrollpeak-visible");
      else root.classList.remove("scrollpeak-visible");
      clearTimeout(peekTimer);
      peekTimer = null;
      if (show) {
        peekTimer = setTimeout(() => {
          peekTimer = null;
          // Do not slide away while the pointer is still on the rail.
          if (!rail.rail.domNode.matches(":hover")) {
            root.classList.remove("scrollpeak-visible");
          }
        }, settings.peekDelay ?? 1600);
      }
    }

    function onPeekTrigger(event) {
      if (!settings.hideWhenIdle) return;
      if (peekTimer !== null) {
        peek(true);
        return;
      }
      if (event && event.type === "pointermove") {
        // Only when the pointer is near the right edge, which is what "within
        // range of the minimap" means.
        const edge = settings.peekZone ?? 48;
        if (event.clientX < window.innerWidth - edge) return;
      }
      peek(true);
    }

    applyTrackVisibility();
    applyPeek();

    // vugluscr reserves container padding equal to the rail's width, which
    // still counts the track after it has been hidden. Re-measure and correct
    // it, otherwise the page keeps a gutter where the track used to be.
    function syncRailPadding() {
      if (!settings.hideTrack) return;
      const width = rail.rail.domNode.getBoundingClientRect().width;
      if (width > 0) content.style.paddingRight = `${Math.round(width)}px`;
    }
    syncRailPadding();
    rail.onLayout(syncRailPadding);
    new ResizeObserver(syncRailPadding).observe(rail.rail.domNode);
    window.addEventListener("scroll", onPeekTrigger, { passive: true });
    window.addEventListener("pointermove", onPeekTrigger, { passive: true });
    window.addEventListener("wheel", onPeekTrigger, { passive: true });
    window.addEventListener("keydown", onPeekTrigger, { passive: true });

    const ctx = {
      rail,
      minimap,
      map,
      scroller,
      content,
      settings,
      get strip() {
        return strip;
      },
      repaint,
      rebuild,
      getSnapshot,
      getFixedIndices: () => fixedIndices,
      setFixedIndices: (list) => {
        if (list && list.length) fixedIndices = list;
      },

      /**
       * The browser's theme changed underneath us. Re-derive the colours and
       * repaint; the map's geometry is untouched, so no rebuild is needed.
       */
      setTheme(next) {
        themePalette = next || null;
        applyAppearance();
        repaint();
      },

      teardown() {
        policy?.dispose();
        policy = null;
        clearTimeout(peekTimer);
        thumb?.dispose();
        thumb = null;
        observer.disconnect();
        window.removeEventListener("scroll", onPeekTrigger);
        window.removeEventListener("pointermove", onPeekTrigger);
        window.removeEventListener("wheel", onPeekTrigger);
        window.removeEventListener("keydown", onPeekTrigger);
        document.documentElement.classList.remove(
          "scrollpeak-minimap-only", "scrollpeak-peek", "scrollpeak-visible");
        railNode.removeEventListener("pointerenter", onRailEnter);
        railNode.removeEventListener("pointerleave", onRailLeave);
        window.removeEventListener("scroll", repaint);
        window.removeEventListener("resize", relayout);
        if (scheme.removeEventListener) scheme.removeEventListener("change", onSchemeChange);
        else scheme.removeListener(onSchemeChange);
        try {
          rail.dispose();
        } catch {
          // dispose() is structural; a page that already tore itself down
          // (SPA navigation, bfcache restore) can throw here harmlessly.
        }
      },
    };

    window.addEventListener("pagehide", () => ctx.teardown(), { once: true });
    return ctx;
  }

  globalThis.ScrollPeakRail = { mount };
})();
