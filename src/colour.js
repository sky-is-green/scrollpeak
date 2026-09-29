// ScrollPeak — colour maths, shared.
//
// Loaded by the content script (see the js array in manifest.json) and by the
// options page and popup (see a <script> tag in each). It is a plain global
// rather than a module because content scripts in Firefox are not ES modules
// and cannot dynamically import extension-local files.
//
// It is a separate file for one reason: the options page has to show the user
// the colour the strip will actually be, which is the same arithmetic the
// content script runs. Duplicating it in the UI is how a swatch ends up
// promising a colour the strip never uses.

// Kate has none of this. His minimap is filled with the editor's background
// colour and the text's own colours are drawn into it, so his marks contrast by
// construction. A web page's text colours are chosen against the page, not
// against our strip, so a dark grey that is perfectly legible in a light
// article disappears on a dark strip. Hence the contrast pass below.

(function () {
  /** Relative luminance, per WCAG. */
  function luminance(rgb) {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** WCAG contrast ratio, 1 to 21. */
  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  }

  /**
   * Parse a colour the browser has already computed, to [r, g, b].
   *
   * Only the forms getComputedStyle can return: rgb()/rgba(), and color(srgb
   * --) for a wide-gamut input. Hex and named colours are *not* accepted here;
   * use resolveColor() for a value that has not been through the browser yet.
   */
  function parseRgb(color) {
    const text = (color || "").trim();
    const srgb = /^color\(srgb\s+([^)]+)\)$/.exec(text);
    if (srgb) {
      const nums = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number);
      if (nums.length < 3 || nums.slice(0, 3).some(Number.isNaN)) return null;
      return nums
        .slice(0, 3)
        .map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
    }
    const m = /^rgba?\(([^)]+)\)$/.exec(text);
    if (!m) return null;
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return parts.slice(0, 3);
  }

  /**
   * Resolve any CSS colour to [r, g, b], by asking the browser.
   *
   * A <input type="color"> only ever produces "#rrggbb", so a regex over rgb()
   * silently throws away everything the user picks -- which is exactly what it
   * did, and why changing the colour appeared to do nothing. Rather than keep
   * a table of hex lengths and named colours in step with CSS, hand the value
   * to the CSS parser and read back what it resolved to. The probe is attached
   * for one synchronous turn and removed before anything can walk the document,
   * and its answers are memoised because the same handful of colours is
   * resolved on every rebuild.
   */
  const colourCache = new Map();
  let probe = null;

  function resolveColor(value) {
    const text = (value || "").trim();
    if (!text) return null;
    if (colourCache.has(text)) return colourCache.get(text);

    let out = null;
    if (!probe) {
      probe = document.createElement("span");
      probe.setAttribute("aria-hidden", "true");
      // Out of the way, but laid out: getComputedStyle is not required to
      // resolve a value on a display:none subtree.
      probe.style.cssText =
        "position:absolute;left:-9999px;top:0;width:1px;height:1px;" +
        "overflow:hidden;pointer-events:none";
    }
    probe.style.color = "";
    probe.style.color = text;
    // An unparseable value leaves the declaration empty, which is how the CSS
    // parser says no.
    if (probe.style.color) {
      (probe.ownerDocument || document).documentElement.appendChild(probe);
      out = parseRgb(getComputedStyle(probe).color);
      probe.remove();
    }
    colourCache.set(text, out);
    return out;
  }

  /** Mix towards black by `amount`, which is what the default background is. */
  function darken(rgb, amount) {
    return rgb.map((v) => Math.round(v * (1 - amount)));
  }

  /**
   * Nudge a colour along the lightness axis until it contrasts with `bg`.
   *
   * Moving towards whichever of black or white is further from the background
   * keeps the hue, so a link stays link-coloured and a heading stays
   * heading-coloured -- only its lightness changes. Returns the input
   * unchanged if the target cannot be met, which happens for mid-greys
   * against a mid-grey background.
   */
  function ensureContrast(rgb, bg, target) {
    if (contrast(rgb, bg) >= target) return rgb;
    const towardsWhite = luminance(bg) < 0.5;
    let best = rgb;
    for (let step = 0; step <= 20; step++) {
      const t = towardsWhite ? step / 20 : 1 - step / 20;
      const candidate = towardsWhite
        ? rgb.map((v) => Math.round(v + (255 - v) * t))
        : rgb.map((v) => Math.round(v * (1 - t)));
      if (contrast(candidate, bg) >= target) return candidate;
      best = candidate;
    }
    return best;
  }

  /** Apply an alpha to an [r, g, b] triple. Kate sets alpha on a QColor. */
  function withAlpha(rgb, alpha) {
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha / 255})`;
  }

  /**
   * The strip's background, and where it came from.
   *
   * The order of preference is the user's own colour, then a darker shade of
   * the *browser's* background -- the installed Firefox theme's if there is
   * one, otherwise the page's -- and finally the system's light or dark
   * appearance for a page that paints no background at all.
   *
   * `source` is for the settings UI and for debugging: "the strip is the wrong
   * colour" is a much easier question to answer when you can see whether the
   * user's colour, the theme, or the page won.
   */
  function resolveStripBackground({ chosen, theme, page, systemDark, amount }) {
    const fallback = systemDark ? [0, 0, 0] : [255, 255, 255];
    const mine = resolveColor(chosen);
    if (mine) return { rgb: mine, source: "yours" };

    const themed = resolveColor(theme);
    const base = themed || resolveColor(page) || fallback;
    return {
      rgb: darken(base, amount),
      source: themed ? "firefox theme" : resolveColor(page) ? "the page" : "the system",
    };
  }

  globalThis.ScrollPeakColour = {
    luminance,
    contrast,
    parseRgb,
    resolveColor,
    darken,
    ensureContrast,
    withAlpha,
    resolveStripBackground,
  };
})();
