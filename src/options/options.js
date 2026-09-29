// ScrollPeek — options page.
//
// The setting set is deliberately Kate's and only Kate's; see the note in
// background.js for the mapping and options.html for what was left out.

const $ = (id) => document.getElementById(id);

const CHECKBOXES = ["enabled", "showMagnifier", "showMarkers", "hideTrack", "hideWhenIdle"];
const RANGES = ["minimapWidth", "darkenAmount", "markContrast", "peekZone", "peekDelay"];
const MODES = ["always", "whenNeeded", "never"];

function formatRange(id, value) {
  if (id === "minimapWidth" || id === "peekZone") return `${value}px`;
  if (id === "peekDelay") return `${(value / 1000).toFixed(1)}s`;
  if (id === "markContrast") return `${value}:1`;
  if (id === "darkenAmount") return `${Math.round(value * 100)}%`;
  return String(value);
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

  wireColour(settings);
  wireSiteForm();
  wireLinks();
  renderSites(settings.disabledSites || []);
}

/**
 * Add a host to the exclusion list.
 *
 * Normalised on the way in: users paste URLs, and "https://Example.com/path"
 * and "example.com" should not become two different entries.
 */
/**
 * The strip colour.
 *
 * An empty setting means "derive a darker shade of the page's background",
 * which a colour input cannot represent. So the swatch shows the derived
 * value and is marked as following the page, and the button is what clears an
 * override.
 */
function wireColour(settings) {
  const input = $("mapBackground");
  const reset = $("mapBackground-reset");
  const hint = $("mapBackground-hint");

  // The derived colour is a darkened page background, which the options page
  // cannot know -- it is not looking at a page. Show the value that is in
  // force, and say which of the two it is.
  let following = !settings.mapBackground;
  input.value = settings.mapBackground || DERIVED_PLACEHOLDER;

  const describe = () => {
    hint.textContent = following
      ? "Following the page: a darker shade of its own background."
      : `Using ${settings.mapBackground}.`;
  };
  describe();

  input.addEventListener("change", async () => {
    const next = await persist({ mapBackground: input.value });
    following = !next.mapBackground;
    describe();
  });

  reset.addEventListener("click", async () => {
    const next = await persist({ mapBackground: "" });
    settings.mapBackground = next.mapBackground;
    following = !next.mapBackground;
    input.value = settings.mapBackground || DERIVED_PLACEHOLDER;
    describe();
  });
}

/** Swatch shown while the colour is being derived. Matches the default darken. */
const DERIVED_PLACEHOLDER = "#2a2a33";

function wireSiteForm() {
  const form = $("addsite");
  const input = $("site-input");
  const error = $("site-error");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const host = normaliseHost(input.value);
    if (!host) {
      error.textContent = "That does not look like a hostname.";
      error.hidden = false;
      return;
    }
    const current = await browser.runtime.sendMessage({
      type: "scrollpeak:getSettings",
    });
    const sites = current.disabledSites || [];
    if (sites.includes(host)) {
      error.textContent = `${host} is already excluded.`;
      error.hidden = false;
      return;
    }
    error.hidden = true;
    const next = [...sites, host];
    await persist({ disabledSites: next });
    renderSites(next);
    input.value = "";
  });

  input.addEventListener("input", () => {
    error.hidden = true;
  });
}

/** Take a pasted URL or hostname down to a bare hostname. */
function normaliseHost(value) {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return "";
  const withScheme = /^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    const { hostname } = new URL(withScheme);
    // A hostname with no dot is not a site, it is a typo.
    return hostname.includes(".") ? hostname : "";
  } catch {
    return "";
  }
}

function wireLinks() {
  for (const el of document.querySelectorAll("[data-url]")) {
    el.addEventListener("click", () => browser.tabs.create({ url: el.dataset.url }));
  }
  $("copy-settings").addEventListener("click", async () => {
    const settings = await browser.runtime.sendMessage({
      type: "scrollpeak:getSettings",
    });
    // Handy for filing a bug with your configuration attached. The clipboard
    // can refuse -- permission policy, a non-secure context, an extension page
    // with no transient activation -- and a rejected promise here would be an
    // unhandled rejection in the page, so it is handled rather than assumed.
    const note = $("copy-note");
    try {
      await navigator.clipboard.writeText(JSON.stringify(settings, null, 2));
      note.textContent = "Copied to the clipboard.";
    } catch {
      note.textContent = "Could not reach the clipboard.";
    }
    note.hidden = false;
    setTimeout(() => {
      note.hidden = true;
    }, 2000);
  });
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
      remove.setAttribute("aria-label", `Stop excluding ${site}`);
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
