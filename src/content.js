// ScrollPeek — content script entry point.
//
// Loaded last (see the js array order in manifest.json), after the vendored
// vugluscr bundle and after textmap.js / rail.js / magnifier.js have defined
// their globals. Content scripts in Firefox are not ES modules and cannot
// dynamically import extension-local files, so the wiring is by load order
// rather than by import graph — MDN documents that js files run in array
// order, which is why the order is written out explicitly here.
//
// This file owns the lifecycle: ask the background whether to run, mount, and
// re-mount when settings change.

(async function main() {
  if (window.__scrollpeakLoaded) return;
  window.__scrollpeakLoaded = true;

  // No content script runs on privileged pages, but be explicit rather than
  // surprised about it later.
  const url = location.href;
  if (url.startsWith("about:") || url.startsWith("moz-extension:")) return;

  if (!globalThis.Vugluscr?.Scrollbar) {
    console.warn("[ScrollPeek] vugluscr did not load; minimap unavailable");
    return;
  }
  if (!globalThis.ScrollPeekTextMap) {
    console.warn("[ScrollPeek] textmap.js did not load; minimap unavailable");
    return;
  }

  let teardown = null;

  async function mount() {
    let enabled;
    let settings;
    try {
      [enabled, settings] = await Promise.all([
        browser.runtime.sendMessage({ type: "scrollpeak:isEnabled", url }),
        browser.runtime.sendMessage({ type: "scrollpeak:getSettings" }),
      ]);
    } catch (err) {
      // Background worker reloading, or the extension was just updated.
      // Leave the page exactly as we found it.
      console.debug("[ScrollPeek] could not reach background:", err);
      return;
    }

    if (!enabled || !settings) {
      teardown?.();
      teardown = null;
      return;
    }

    // A page with no scrollbar has no minimap. vugluscr's autoHide also hides
    // the rail here, but checking first avoids constructing the whole widget —
    // ResizeObserver included — for a page that will not use it.
    if (settings.hideWhenPageFits && !qualifies()) {
      teardown?.();
      teardown = null;
      return;
    }

    // Replace rather than stack: a settings change re-enters this function.
    teardown?.();

    const ctx = globalThis.ScrollPeekRail.mount(settings);
    if (!ctx) return;

    const magnifier = globalThis.ScrollPeekMagnifier.mount(ctx, settings);
    teardown = () => {
      magnifier?.teardown();
      ctx.teardown();
    };
  }

  await mount();

  // Settings are read once, at mount. Re-mount in place rather than reloading
  // the page: a reload would discard whatever the user has typed or half-
  // filled in, which is a much worse outcome than a brief teardown.
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "scrollpeak:settingsChanged") mount();
  });
})();

/**
 * Is this page long enough to be worth a minimap?
 *
 * Read from the scrolling element rather than document.body: pages that
 * scroll on <html> (the common case) report a body height of one viewport,
 * which would make every such page look undeserving.
 */
function qualifies() {
  const scroller = document.scrollingElement || document.documentElement;
  return scroller.scrollHeight > window.innerHeight * 1.5;
}
