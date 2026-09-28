// ScrollPeek — background service worker (MV3).
//
// The worker exists to answer two questions from the content script:
//   - "is ScrollPeek enabled for this URL?"  (global toggle + per-site list)
//   - "what are my settings?"
//
// It deliberately holds no page data. Content scripts own the DOM; the worker
// only owns preferences, so a background restart costs the user nothing
// visible.

const DEFAULT_SETTINGS = {
  enabled: true,
  // Kate replaces the scrollbar outright. We are more conservative by default:
  // ScrollPeek stays out of the way until asked, per site.
  optInPerSite: true,
  disabledSites: [],
  minimapWidth: 40,
  showMarkers: true,
  showMagnifier: true,
  magnifierZoom: 3,
  magnifierWidth: 320,
  magnifierHeight: 240,
  hideWhenPageFits: true,
};

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

function isEnabledForUrl(settings, url) {
  if (!settings.enabled) return false;

  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }

  const disabled = settings.disabledSites || [];
  // Match the host itself and any parent domain, so disabling example.com
  // also covers www.example.com and docs.example.com.
  const isListed = disabled.some((entry) => {
    const bare = entry.replace(/^\*\./, "");
    return host === bare || host.endsWith(`.${bare}`);
  });

  return settings.optInPerSite ? !isListed : true;
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
        // tabs rather than letting the UI keep showing a stale rail.
        const tabs = await browser.tabs.query({});
        await Promise.all(
          tabs
            .filter((tab) => tab.id != null)
            .map((tab) =>
              browser.tabs
                .sendMessage(tab.id, { type: "scrollpeak:settingsChanged" })
                // Tabs without a content script (privileged pages, other
                // extensions) reject; that is expected, not an error.
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
