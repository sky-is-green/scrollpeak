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
  function mount(settings) {
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
    map.collect(content);
    map.buildPixmap();
    repaint();

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
        observer.disconnect();
        mutations.disconnect();
        window.removeEventListener("scroll", repaint);
        window.removeEventListener("resize", relayout);
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
