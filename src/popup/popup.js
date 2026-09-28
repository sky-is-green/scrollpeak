// ScrollPeek — toolbar popup.

const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init() {
  const tab = await activeTab();
  const settings = await browser.runtime.sendMessage({
    type: "scrollpeak:getSettings",
  });

  let host = "";
  try {
    host = new URL(tab?.url ?? "").hostname;
  } catch {
    host = "";
  }
  $("site-label").textContent = host || "this site";

  const siteToggle = $("site-toggle");
  const magToggle = $("magnifier-toggle");

  siteToggle.checked = !isListed(settings.disabledSites, host);
  magToggle.checked = settings.showMagnifier;

  siteToggle.addEventListener("change", async () => {
    const next = new Set(settings.disabledSites);
    if (siteToggle.checked) next.delete(host);
    else next.add(host);
    // The background broadcasts to every open tab afterwards, and the content
    // script re-mounts itself. Reloading here would discard whatever the user
    // had typed or half-filled in, for no benefit.
    await browser.runtime.sendMessage({
      type: "scrollpeak:setSetting",
      patch: { disabledSites: [...next] },
    });
  });

  magToggle.addEventListener("change", async () => {
    await browser.runtime.sendMessage({
      type: "scrollpeak:setSetting",
      patch: { showMagnifier: magToggle.checked },
    });
  });

  markersToggle.addEventListener("change", async () => {
    await browser.runtime.sendMessage({
      type: "scrollpeak:setSetting",
      patch: { showMarkers: markersToggle.checked },
    });
  });
}

function isListed(list, host) {
  if (!host) return false;
  return (list || []).some((entry) => {
    const bare = entry.replace(/^\*\./, "");
    return host === bare || host.endsWith(`.${bare}`);
  });
}

init();
