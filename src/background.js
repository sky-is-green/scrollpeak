// ScrollPeek — background service worker (MV3).
//
// Owns preferences and nothing else. Content scripts own the DOM; the worker
// owns settings, so a background restart costs the user nothing visible.
//
// The defaults are Kate's. ktexteditor's KateViewConfig, Appearance > Borders:
//
//   ScrollBarMiniMapWidth   60    (kateconfig.cpp; note the constructor says
//                                  40, but kateview.cpp applies 60 at init)
//   ShowScrollBarPreview    true
//   ShowScrollBarMarks      false
//   ShowScrollbars          AlwaysOn | ShowWhenNeeded | AlwaysOff
//
// Kate also has ShowScrollBarMiniMapAll, but katedialogs.cpp hides its own
// checkbox with the comment "temporary until the feature is done", so it is not
// a setting anyone can rely on and is not ported.

const DEFAULT_SETTINGS = {
  // Global kill switch. Turning this off is not uninstalling.
  enabled: true,

  // Kate's ShowScrollbars. "whenNeeded" is Kate's ShowWhenNeeded: show the
  // rail only when the page actually scrolls.
  //   always    - show even on a page that fits
  //   whenNeeded- show only when there is something to scroll
  //   never     - do not show the rail
  scrollbarMode: "always",

  // Kate's ScrollBarMiniMapWidth.
  minimapWidth: 60,

  // Kate's ShowScrollBarPreview: the hover preview of the text under the
  // cursor, which is the feature this whole project exists for.
  showMagnifier: true,

  // Kate's ShowScrollBarMarks, default off. In Kate these are bookmarks and
  // breakpoints; here they are heading positions, which is a guess about what
  // matters on an arbitrary page, so it stays opt-in.
  showMarkers: false,

  // Hosts the rail is hidden on. A parent domain covers its subdomains.
  disabledSites: [],
};

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

function isListed(host, list) {
  return (list || []).some((entry) => {
    const bare = entry.replace(/^\*\./, "");
    return host === bare || host.endsWith(`.${bare}`);
  });
}

function isEnabledForUrl(settings, url) {
  if (!settings.enabled) return false;
  if (settings.scrollbarMode === "never") return false;

  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }

  return !isListed(host, settings.disabledSites);
}

/**
 * Does this page have anything to scroll?
 *
 * Read from the scrolling element rather than document.body: pages that scroll
 * on <html> -- the common case -- report a body height of one viewport, which
 * would make every such page look undeserving.
 */
function pageScrolls() {
  const scroller = document.scrollingElement || document.documentElement;
  return scroller.scrollHeight > window.innerHeight;
}

browser.runtime.onMessage.addListener((message, sender) => {
  switch (message?.type) {
    case "scrollpeak:isEnabled":
      return getSettings().then((settings) =>
        isEnabledForUrl(settings, sender.tab?.url ?? message.url ?? ""),
      );

    case "scrollpeak:getSettings":
      return getSettings();

    case "scrollpeak:setSetting": {
      return getSettings().then(async (settings) => {
        const next = { ...settings, ...message.patch };
        await browser.storage.local.set({ settings: next });
        // Settings are read once, when a content script mounts. Tell the open
        // tabs rather than leaving the UI showing a stale rail.
        const tabs = await browser.tabs.query({});
        await Promise.all(
          tabs
            .filter((tab) => tab.id != null)
            .map((tab) =>
              browser.tabs
                .sendMessage(tab.id, { type: "scrollpeak:settingsChanged" })
                // Tabs without a content script (privileged pages, other
                // extensions) reject; expected, not an error.
                .catch(() => {}),
            ),
        );
        return next;
      });
    }

    default:
      return undefined;
  }
});
