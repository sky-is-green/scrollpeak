// ScrollPeek — options page.
//
// The setting set is deliberately Kate's and only Kate's; see the note in
// background.js for the mapping and options.html for what was left out.

const $ = (id) => document.getElementById(id);

const CHECKBOXES = ["enabled", "showMagnifier", "showMarkers"];
const RANGES = ["minimapWidth"];
const MODES = ["always", "whenNeeded", "never"];

function formatRange(id, value) {
  return id === "minimapWidth" ? `${value}px` : String(value);
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

  for (const mode of MODES) {
    const el = document.querySelector(`input[name="scrollbarMode"][value="${mode}"]`);
    el.checked = settings.scrollbarMode === mode;
    el.addEventListener("change", () => {
      if (el.checked) persist({ scrollbarMode: mode });
    });
  }

  renderSites(settings.disabledSites || []);
}

/**
 * Save, and let the background tell open tabs to re-mount.
 *
 * The background does the broadcast, so this page never has to know that
 * content scripts exist.
 */
async function persist(patch) {
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
        const next = (current.disabledSites || []).filter((s) => s !== site);
        await persist({ disabledSites: next });
        renderSites(next);
      });

      li.append(name, remove);
      return li;
    }),
  );
}

load();
