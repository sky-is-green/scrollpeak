// ScrollPeak — content script entry point.
//
// Loaded last (see the js array order in manifest.json), after the vendored
// vugluscr bundle and after clone.js / thumb.js / freshness.js / textmap.js /
// rail.js / magnifier.js have defined their globals. Content scripts in
// Firefox are not ES modules and cannot dynamically import extension-local
// files, so the wiring is by load order rather than by import graph -- MDN
// documents that js files run in array order, which is why the order is
// written out explicitly here.
//
// This file owns the lifecycle: ask the background whether to run, mount, and
// re-mount when settings change.

// ------------------------------------------------------------------- the map
//
// The map's base is a clone of the page's own rendering (clone.js): the
// browser has already laid the page out, so there is no renderer to choose and
// no page shape to classify. The rail always mounts, so a player that appears
// later, or a lightbox over the page, cannot take it away. Kate's text raster
// remains only as the fallback for a page that cannot be cloned.

(async function main() {
  if (window.__scrollpeakLoaded) return;
  window.__scrollpeakLoaded = true;

  // No content script runs on privileged pages, but be explicit rather than
  // surprised about it later.
  const url = location.href;
  if (url.startsWith("about:") || url.startsWith("moz-extension:")) return;

  if (!globalThis.Vugluscr?.Scrollbar) {
    console.warn("[ScrollPeak] vugluscr did not load; minimap unavailable");
    return;
  }
  if (!globalThis.ScrollPeakTextMap) {
    console.warn("[ScrollPeak] textmap.js did not load; minimap unavailable");
    return;
  }
  if (!globalThis.ScrollPeakClone || !globalThis.ScrollPeakThumb ||
      !globalThis.ScrollPeakFreshness) {
    console.warn("[ScrollPeak] clone.js/thumb.js/freshness.js did not load; minimap unavailable");
    return;
  }

  let teardown = null;
  // The live rail, for the messages that update it in place rather than
  // replacing it. Distinct from teardown, which is the function that disposes
  // of it -- calling .setTheme() on that would be a TypeError.
  let rail = null;

  function unmount() {
    teardown?.();
    teardown = null;
    rail = null;
  }

  async function mount() {
    let enabled;
    let settings;
    let theme;
    try {
      [enabled, settings, theme] = await Promise.all([
        browser.runtime.sendMessage({ type: "scrollpeak:isEnabled", url }),
        browser.runtime.sendMessage({ type: "scrollpeak:getSettings" }),
        // The minimap's default colour follows the browser's own theme, and
        // only the background can see the theme API.
        browser.runtime.sendMessage({ type: "scrollpeak:getTheme" }),
      ]);
    } catch (err) {
      // Background worker reloading, or the extension was just updated.
      // Leave the page exactly as we found it.
      console.debug("[ScrollPeak] could not reach background:", err);
      return;
    }

    if (!enabled || !settings) {
      unmount();
      return;
    }

    // Kate's ShowWhenNeeded: only build the widget when there is something to
    // scroll. Checked here rather than left to vugluscr's autoHide, which
    // would construct the whole thing -- ResizeObserver and all -- first.
    if (settings.scrollbarMode === "whenNeeded" && !pageScrolls()) {
      unmount();
      return;
    }

    // Replace rather than stack: a settings change re-enters this function.
    teardown?.();

    const ctx = globalThis.ScrollPeakRail.mount(settings, theme);
    if (!ctx) return;
    rail = ctx;

    const magnifier = globalThis.ScrollPeakMagnifier.mount(ctx, settings);
    teardown = () => {
      magnifier?.teardown();
      ctx.teardown();
      rail = null;
    };
  }

  await mount();

  // Settings are read once, at mount. Re-mount in place rather than reloading
  // the page: a reload would discard whatever the user has typed or half-
  // filled in, which is a much worse outcome than a brief teardown.
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "scrollpeak:settingsChanged") {
      mount();
      return;
    }
    // A theme change moves the default strip colour. Nothing the user stored
    // has changed, so this re-derives and repaints in place rather than tearing
    // the rail down and rebuilding the map.
    if (message?.type === "scrollpeak:themeChanged") {
      rail?.setTheme(message.theme);
    }
  });
})();

/** Read from the scrolling element; see the note in background.js. */
function pageScrolls() {
  const scroller = document.scrollingElement || document.documentElement;
  return scroller.scrollHeight > window.innerHeight;
}
