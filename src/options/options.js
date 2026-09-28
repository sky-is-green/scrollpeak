// ScrollPeek — options page.

const CHECKBOXES = ["enabled", "optInPerSite", "hideWhenPageFits", "showMagnifier", "showMarkers"];
const RANGES = ["magnifierZoom", "magnifierWidth", "magnifierHeight", "minimapWidth"];

const $ = (id) => document.getElementById(id);

function formatRange(id, value) {
  if (id === "magnifierZoom") return `${value}×`;
  return `${value}px`;
}

async function load() {
  const settings = await browser.runtime.sendMessage({
    type: "scrollpeak:getSettings",
  });

  for (const id of CHECKBOXES) {
    const el = $(id);
    el.checked = Boolean(settings[id]);
    el.addEventListener("change", () => persist({ [id]: el.checked }));
  }

  for (const id of RANGES) {
    const el = $(id);
    const out = $(`${id}-out`);
    el.value = settings[id];
    out.textContent = formatRange(id, settings[id]);
    el.addEventListener("input", () => {
      out.textContent = formatRange(id, Number(el.value));
    });
    el.addEventListener("change", () => persist({ [id]: Number(el.value) }));
  }

  renderSites(settings.disabledSites || []);
}

async function persist(patch) {
  // The background script saves and then tells every open tab, so this page
  // does not need to know that content scripts exist.
  await browser.runtime.sendMessage({ type: "scrollpeak:setSetting", patch });
}

function renderSites(sites) {
  const list = $("site-list");
  $("sites-empty").hidden = sites.length > 0;
  list.replaceChildren(
    ...sites.map((site) => {
      const li = document.createElement("li");

      const name = document.createElement("span");
      name.textContent = site;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        const current = await browser.runtime.sendMessage({
          type: "scrollpeak:getSettings",
        });
        await persist({
          disabledSites: (current.disabledSites || []).filter((s) => s !== site),
        });
        renderSites((current.disabledSites || []).filter((s) => s !== site));
      });

      li.append(name, remove);
      return li;
    }),
  );
}

load();
