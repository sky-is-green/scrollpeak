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

  // --- below here: web-specific, no Kate equivalent ---

  // The strip's background. "" derives a darker shade of the page's own
  // background, which is the closest thing to Kate's behaviour: his minimap
  // sits on the editor background and the marks are the text's own colours.
  // A page's text colours are chosen against the page, not against our
  // strip, so the marks are then forced to contrast with whatever we get.
  mapBackground: "",

  // One colour for every mark, or "" for the page's own text colours. The
  // page's own is Kate's arrangement and the reason a heading reads differently
  // from body text in the strip; this is for a monochrome strip, which some
  // people want and which is easier to read at 60px.
  markColour: "",

  // How far to darken the browser's background for the default strip colour.
  darkenAmount: 0.82,

  // WCAG contrast ratio the marks must reach against the strip. 3 is enough
  // for a 1px mark carrying shape rather than reading as text.
  markContrast: 3,

  // "Minimap only": drop the track so the rail is just the map.
  hideTrack: false,

  // "Peek": park the rail off-screen until the user scrolls or approaches it.
  hideWhenIdle: false,
  peekZone: 48,
  peekDelay: 1600,

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

/**
 * Which of the theme's colours should the minimap follow?
 *
 * In order of how deliberate a theme's choice of them usually is. `toolbar` is
 * the browser's main surface and the one a theme is most likely to have set on
 * purpose; `frame` is the window behind it; `popup` and `sidebar` are surfaces
 * too, so a theme that set only one of those still has an opinion about what
 * the browser looks like.
 */
const THEME_BASE_KEYS = ["toolbar", "frame", "popup", "sidebar", "button_background"];

/** The matching text colours, same reasoning. */
const THEME_TEXT_KEYS = [
  "toolbar_text", "tab_background_text", "frame_text", "popup_text",
  "sidebar_text", "button_text",
];

function firstColour(colors, keys) {
  for (const key of keys) {
    if (colors[key]) return colors[key];
  }
  return null;
}

/**
 * The browser's own colours, for the minimap's default.
 *
 * theme.getCurrent() is the only way an extension can see them. With a theme
 * installed it returns that theme's `colors`; with the default theme it
 * returns the default theme's own, which is what "the system default" means
 * here. A `colors` object that is empty or absent means the browser has told us
 * nothing, and the content script falls back to the page's own background.
 */
async function themePalette() {
  let colors = {};
  try {
    const theme = await browser.theme.getCurrent();
    colors = theme?.colors || {};
  } catch {
    // No theme API in this context, or a Firefox too old to have one.
    colors = {};
  }
  return {
    base: firstColour(colors, THEME_BASE_KEYS),
    text: firstColour(colors, THEME_TEXT_KEYS),
    // Firefox themes can set an accent outright; toolbar_field_focus is the
    // nearest thing every theme sets that reads as "the colour this browser
    // is built around".
    accent: firstColour(colors, ["accent", "toolbar_field_focus"]),
    named: Object.keys(colors).length > 0,
  };
}

/**
 * Tell the open tabs and refresh the toolbar icon.
 *
 * Settings are read once, when a content script mounts, so a change has to be
 * announced. Watching storage rather than broadcasting from each writer means
 * the popup and the options page do not need to know the tabs exist.
 */
async function broadcastChange() {
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => tab.id != null)
      .map((tab) =>
        browser.tabs
          .sendMessage(tab.id, { type: "scrollpeak:settingsChanged" })
          // Tabs without a content script (privileged pages, other add-ons)
          // reject; expected, not an error.
          .catch(() => {}),
      ),
  );
  await refreshAction();
}

/**
 * Show whether ScrollPeek is on for the tab you are looking at.
 *
 * Without this the only way to tell is to look for the rail, and "nothing
 * appeared" is indistinguishable from "broken".
 */
async function refreshAction() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;

  const settings = await getSettings();
  const on = isEnabledForUrl(settings, tab.url ?? "");
  const host = hostOf(tab.url);

  await browser.action.setIcon({
    tabId: tab.id,
    path: on ? {
      16: "icons/scrollpeak.svg", 32: "icons/scrollpeak.svg", 48: "icons/scrollpeak.svg",
    } : {
      16: "icons/scrollpeak-off.svg", 32: "icons/scrollpeak-off.svg", 48: "icons/scrollpeak-off.svg",
    },
  });

  await browser.action.setTitle({
    tabId: tab.id,
    title: on
      ? `ScrollPeek — showing on ${host || "this page"}`
      : `ScrollPeek — off on ${host || "this page"}`,
  });
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) broadcastChange();
});

/**
 * A theme change is a colour change, and the minimap's default follows the
 * theme. Sent on its own rather than as a settings change, because nothing the
 * user stored has moved: the tabs only need to re-derive and repaint, not tear
 * the rail down and rebuild it.
 */
browser.theme.onUpdated.addListener(async () => {
  const palette = await themePalette();
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => tab.id != null)
      .map((tab) =>
        browser.tabs
          .sendMessage(tab.id, { type: "scrollpeak:themeChanged", theme: palette })
          .catch(() => {}),
      ),
  );
});

browser.tabs.onActivated.addListener(() => refreshAction());
browser.tabs.onUpdated.addListener((tabId, info, tab) => {
  // Only when the tab actually navigated: onUpdated also fires for every
  // favicon and title change, and this queries storage each time.
  if (info.status === "complete" || info.url) refreshAction();
});
browser.windows.onFocusChanged.addListener(() => refreshAction());

browser.runtime.onInstalled.addListener(() => refreshAction());
browser.runtime.onStartup.addListener(() => refreshAction());

browser.runtime.onMessage.addListener((message, sender) => {
  switch (message?.type) {
    case "scrollpeak:isEnabled":
      return getSettings().then((settings) =>
        isEnabledForUrl(settings, sender.tab?.url ?? message.url ?? ""),
      );

    case "scrollpeak:getSettings":
      return getSettings();

    case "scrollpeak:getTheme":
      return themePalette();

    case "scrollpeak:setSetting": {
      return getSettings().then(async (settings) => {
        const next = { ...settings, ...message.patch };
        // The broadcast is not done here. storage.onChanged below watches the
        // store, so every writer -- popup, options page, or anything added
        // later -- updates the tabs without having to remember to.
        await browser.storage.local.set({ settings: next });
        return next;
      });
    }

    default:
      return undefined;
  }
});
