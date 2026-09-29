// ScrollPeak — content script entry point.
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

// -------------------------------------------------------------- media pages
//
// Thresholds measured across real pages. YouTube's watch page has a 797x598
// player; Reddit's front page is 38 large pictures covering 56% of the
// document and BBC's front 43 covering 33%. Wikipedia's infobox holds a
// 250x141 video, which is a thumbnail rather than a player, and GitHub has one
// large picture at 2%: both keep their maps. The picture fraction is stricter
// than a straight reading of those numbers, so a news card grid keeps the
// block map it already rendered well.
const MEDIA_VIDEO_MIN_W = 300;
const MEDIA_VIDEO_MIN_H = 150;
const MEDIA_IMAGE_MIN_W = 200;
const MEDIA_IMAGE_MIN_H = 100;
const MEDIA_IMAGE_COUNT = 12;
const MEDIA_IMAGE_AREA_FRACTION = 0.35;

/**
 * Is this page one the minimap should leave alone?
 *
 * A page whose content is pictures does not get a minimap. The text raster
 * spreads a badge's label and a video title across the strip as unrelated
 * fragments, and a map that draws the player and the cards was a second
 * product to maintain that never read well enough to be worth it; so media
 * pages keep the browser's own scrollbar, which already works.
 *
 * A player is decisive: on a watch page the video *is* the content.
 * Otherwise a field of large pictures, many of them and covering a real share
 * of the document. The count is checked before any rect is measured, so a
 * text page with a few images pays almost nothing.
 */
function isMediaPage() {
  for (const el of document.querySelectorAll("video")) {
    const r = el.getBoundingClientRect();
    if (r.width < MEDIA_VIDEO_MIN_W || r.height < MEDIA_VIDEO_MIN_H) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" ||
        cs.visibility === "collapse") {
      continue;
    }
    return true;
  }
  const imageCount = document.images.length +
    document.querySelectorAll("canvas, iframe").length;
  if (imageCount < MEDIA_IMAGE_COUNT) return false;

  const scroller = document.scrollingElement || document.documentElement;
  const docArea = Math.max(1, scroller.scrollHeight *
    (document.documentElement.clientWidth || window.innerWidth));
  let count = 0;
  let area = 0;
  for (const el of document.querySelectorAll("img, canvas, iframe")) {
    const r = el.getBoundingClientRect();
    if (r.width < MEDIA_IMAGE_MIN_W || r.height < MEDIA_IMAGE_MIN_H) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" ||
        cs.visibility === "collapse") {
      continue;
    }
    count++;
    area += r.width * r.height;
  }
  return count >= MEDIA_IMAGE_COUNT && area > docArea * MEDIA_IMAGE_AREA_FRACTION;
}

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

  let teardown = null;
  // The live rail, for the messages that update it in place rather than
  // replacing it. Distinct from teardown, which is the function that disposes
  // of it -- calling .setTheme() on that would be a TypeError.
  let rail = null;

  // Watching a mounted page for a player that appears later. The observer
  // asks the question once per quiet moment, not per mutation; it only ever
  // runs while the rail is up, and the answer it waits for tears the rail
  // down. A page that never grows a player costs one no-op check per burst of
  // mutations, which is the same order as the rail's own map rebuild.
  let mediaObserver = null;
  let mediaTimer = null;

  function startMediaWatch() {
    if (mediaObserver) return;
    mediaObserver = new MutationObserver(() => {
      if (mediaTimer !== null) return;
      mediaTimer = setTimeout(() => {
        mediaTimer = null;
        if (isMediaPage()) mount();
      }, 400);
    });
    mediaObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopMediaWatch() {
    mediaObserver?.disconnect();
    mediaObserver = null;
    clearTimeout(mediaTimer);
    mediaTimer = null;
  }

  function unmount() {
    stopMediaWatch();
    teardown?.();
    teardown = null;
    rail = null;
  }

  async function mount() {
    stopMediaWatch();
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

    if (isMediaPage()) {
      console.debug("[ScrollPeak] media page; leaving the native scrollbar");
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
    // YouTube is an SPA: a watch page can begin as plain markup and build its
    // player after the content script has mounted, so the decision above is
    // not final. The watch tears the rail down if a player appears.
    startMediaWatch();
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
