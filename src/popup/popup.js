// ScrollPeak — toolbar popup.
//
// The popup is loaded fresh every time it opens and unloaded when it closes,
// so there is no state to keep. MDN also notes it cannot scroll vertically:
// Firefox resizes it to fit, capped at 800x600. That is why the site list is
// not here -- it is on the options page.
//
// Every control writes through the background script, which persists to
// storage and tells the open tabs to re-mount. Nothing here talks to content
// scripts.

const $ = (id) => document.getElementById(id);

const MODES = ["always", "whenNeeded", "never"];

async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const settings = await browser.runtime.sendMessage({
    type: "scrollpeak:getSettings",
  });

  const host = hostOf(tab?.url);
  $("host").textContent = host || "this site";

  const onThisSite = host ? !isListed(settings.disabledSites, host) : false;
  $("site-toggle").checked = onThisSite;
  $("site-toggle").disabled = !host;
  $("state-pill").hidden = onThisSite;
  $("state-pill").title = host ? `ScrollPeak is off on ${host}` : "";

  // Kate's three-way scrollbar choice, as a segmented control.
  for (const mode of MODES) {
    const el = document.querySelector(`input[name="scrollbarMode"][value="${mode}"]`);
    el.checked = settings.scrollbarMode === mode;
    el.addEventListener("change", () => {
      if (el.checked) save({ scrollbarMode: mode });
    });
  }

  bindCheckbox("showMagnifier", settings.showMagnifier);
  bindCheckbox("showMarkers", settings.showMarkers);

  const width = $("minimapWidth");
  const widthOut = $("minimapWidth-out");
  width.value = settings.minimapWidth;
  widthOut.textContent = `${settings.minimapWidth}px`;
  width.addEventListener("input", () => {
    widthOut.textContent = `${width.value}px`;
  });
  width.addEventListener("change", () => save({ minimapWidth: Number(width.value) }));

  $("site-toggle").addEventListener("change", async (e) => {
    if (!host) return;
    const next = new Set(settings.disabledSites);
    if (e.target.checked) next.delete(host);
    else next.add(host);
    await save({ disabledSites: [...next] });
    $("state-pill").hidden = e.target.checked;
  });

  bindCheckbox("hideTrack", settings.hideTrack);
  bindCheckbox("hideWhenIdle", settings.hideWhenIdle);

  const excluded = (settings.disabledSites || []).length;
  $("site-count").textContent = excluded
    ? `${excluded} site${excluded === 1 ? "" : "s"} excluded`
    : "";

  $("open-options").addEventListener("click", () => {
    // Opens the options page wherever the browser puts it: a tab if
    // options_ui.open_in_tab is true, otherwise inside the add-on manager.
    browser.runtime.openOptionsPage();
    window.close();
  });

  for (const el of document.querySelectorAll("[data-url]")) {
    el.addEventListener("click", () => {
      browser.tabs.create({ url: el.dataset.url });
      window.close();
    });
  }
}

function bindCheckbox(id, value) {
  const el = $(id);
  el.checked = Boolean(value);
  el.addEventListener("change", () => save({ [id]: el.checked }));
}

function save(patch) {
  return browser.runtime.sendMessage({ type: "scrollpeak:setSetting", patch });
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** A parent domain in the list covers its subdomains. */
function isListed(list, host) {
  if (!host) return false;
  return (list || []).some((entry) => {
    const bare = entry.replace(/^\*\./, "");
    return host === bare || host.endsWith(`.${bare}`);
  });
}

init();
