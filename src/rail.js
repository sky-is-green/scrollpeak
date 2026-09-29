// ScrollPeek — mounts the vugluscr rail and installs our own minimap.
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
      console.warn("[ScrollPeek] could not mount rail:", err);
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
      console.warn("[ScrollPeek] could not disable vugluscr map:", err);
    }

    const strip = minimap.domNode.domNode;
    const map = new globalThis.ScrollPeekTextMap.TextMap({
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
     * Every colour the rail draws comes from here, so the strip, the thumb and
     * the markers cannot end up in three unrelated schemes -- and the accent
     * follows the Firefox theme when one is installed, rather than being a
     * hardcoded blue that is wrong on every machine but the one it was picked
     * on. Written to <html> because that is where content.css sets them, and
     * where vugluscr reads them from.
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

    let rebuildTimer = null;

    /** Kate's updatePixmap(), behind his 300ms single-shot timer. */
    function rebuild() {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        const t0 = performance.now();
        map.collect(content);
        map.buildPixmap();
        map.paint(scroller.scrollTop, window.innerHeight);
        // Worth seeing: collect() walks every text node in the page and is the
        // only genuinely expensive thing this extension does. In the
        // content-script console (about:debugging -> Inspect, with "Enable
        // JavaScript debugging" ticked) this is the first place to look if a
        // big page feels heavy.
        console.debug(
          `[ScrollPeek] ${map.lines.length} lines, ` +
          `charIncrement=${map.charIncrement} lineIncrement=${map.lineIncrement}, ` +
          `pixmap ${map.pixmapLineWidth}x${map.pixmapLineCount}, ` +
          `${(performance.now() - t0).toFixed(1)}ms`,
        );
      }, globalThis.ScrollPeekTextMap.REBUILD_DELAY_MS);
    }

    /** Kate's cheap per-frame path: no DOM work at all. */
    function repaint() {
      map.paint(scroller.scrollTop, window.innerHeight);
    }

    function relayout() {
      const h = strip.clientHeight || window.innerHeight;
      applyAppearance();
      if (map.setSize(settings.minimapWidth, h)) rebuild();
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

    const observer = new ResizeObserver(relayout);
    observer.observe(content);
    observer.observe(strip);

    // Pages that mount content lazily, and SPAs that swap their whole
    // contents, change without resizing and without navigating. A child-list
    // watch catches both, which a scrollHeight comparison does not: an SPA
    // route can change every word and keep the same height. Debounced hard,
    // because sites like GitHub mutate constantly.
    const mutations = new MutationObserver(() => rebuild());
    mutations.observe(content, { childList: true, subtree: true });

    // popstate covers back/forward within an SPA.
    window.addEventListener("popstate", () => rebuild());

    // First paint. Kate defers this to showEvent; we cannot wait for the
    // strip to be visible, so build it straight away.
    try {
      map.collect(content);
      map.buildPixmap();
      repaint();
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

      /**
       * The browser's theme changed underneath us. Re-derive the colours and
       * repaint; the map's geometry is untouched, so no rebuild is needed.
       */
      setTheme(next) {
        themePalette = next || null;
        applyAppearance();
        repaint();
      },

      /**
       * Kate's scrollbar marks: this.put them in lanes by depth, so h1/h2 --
       * the ones worth finding -- take the outer lanes.
       */
      paintMarkers() {
        if (!settings.showMarkers) {
          rail.setMarkers([]);
          return;
        }
        const top = content.getBoundingClientRect().top;
        rail.setMarkers(
          Array.from(content.querySelectorAll("h1, h2, h3")).map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              start: rect.top - top,
              end: rect.bottom - top,
              lane: Number(el.tagName[1]) <= 2 ? "left" : "center",
            };
          }),
        );
      },

      teardown() {
        clearTimeout(rebuildTimer);
        clearTimeout(peekTimer);
        observer.disconnect();
        mutations.disconnect();
        window.removeEventListener("scroll", onPeekTrigger);
        window.removeEventListener("pointermove", onPeekTrigger);
        window.removeEventListener("wheel", onPeekTrigger);
        window.removeEventListener("keydown", onPeekTrigger);
        document.documentElement.classList.remove(
          "scrollpeak-minimap-only", "scrollpeak-peek", "scrollpeak-visible");
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

  globalThis.ScrollPeekRail = { mount };
})();
