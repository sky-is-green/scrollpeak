# AMO listing copy

Draft for the add-on's listing on addons.mozilla.org. The manifest
`description` is a summary, not a listing description; these are the words for
the form. Edit freely — this is copy, not code.

## Name

ScrollPeak

## Summary

*(AMO's Summary field takes up to 250 characters, so it can carry more than
the manifest `description` — keep that one-liner short for Firefox's
Extensions panel, and use the text below, 247 characters, in the AMO form.
Everything essential is inside the first 250.)*

A scrollbar minimap for Firefox, ported from Kate, the KDE text editor. Hover
the scrollbar to see the whole page, preview any section under the cursor,
and click to jump or drag to scroll. Rendered locally, in the page's own
colours, on any site.

## Description

**The whole page beside you, always.**

ScrollPeak replaces the scrollbar with a miniature map of the page: its text,
its headings, its links, its code and its controls, drawn in the page's own
colours. It is a port of the scrollbar minimap from
[Kate](https://kate-editor.org), the KDE text editor, where finding a function
in a 5,000-line file is a glance rather than a hunt.

The web has no equivalent. On a long article or a documentation page you
scroll, stop, read, and scroll again — and usually overshoot. ScrollPeak shows
you where the rest of the page is before you go there.

- **Hover** the strip to preview the region under the cursor.
- **Move** across it and the preview follows, like a lens down the page.
- **Click** to jump there. **Drag** to scroll continuously.
- **Peek** parks the rail off-screen until you approach it.
- **Minimap only** drops the track and keeps the map.
- The map is the page itself, rendered small: the same markup, the same
  styles, the same layout the browser already made. A photo, a player, a
  chart, a form, a table of contents — it is shown as what it is, on any site,
  rather than being guessed at.
- Pages that cannot be cloned (rare) fall back to Kate's text raster, so the
  rail is never empty.
- The map's width, the preview's size, its colours and a per-site exclusion
  list are all settings.
- The default strip colour follows your Firefox theme.

Everything is drawn locally, from the page you are already looking at.

### Privacy

No network access, no analytics, no telemetry. ScrollPeak reads the page it is
running on to draw the map, and stores nothing beyond your own preferences.

Requires Firefox 146 or later. It has not been tested on Firefox for Android.

## Permissions justification

*(AMO asks you to explain each permission in the review notes; this is also
what the "Access your data for all websites" message in the install prompt
means.)*

- **Access your data for all websites** — the extension must read the
  structure and text of whatever page you are on to draw the map. The content
  is read in the page, drawn into a canvas, and never sent anywhere.
- **Storage** — holds your settings (width, colours, per-site exclusions).
- **Theme** — reads the browser's own colours so the default strip colour
  matches the theme you are using.

## Category

Other. It is a navigation aid, not a theme or a search tool.

## Keywords

minimap, scrollbar, scroll bar, overview, navigation, long documents

## Notes for reviewers

The submitted ZIP is the extension's unminified source with `manifest.json` at
its root; nothing is minified, concatenated or generated. The only vendored
file is `src/vendor/vugluscr.standalone.js`, an unminified rollup bundle of
vugluscr 2.0.0 (MIT), shipped with its LICENSE and NOTICE unchanged.

**Exact reproduction (no build step).** To create a byte-identical copy of the
submitted package:

    git clone https://github.com/sky-is-green/scrollpeak
    cd scrollpeak
    git checkout 8055b83
    python3 scripts/build.py

That writes `dist/scrollpeak-0.1.0.zip`. The script needs only Python 3 (no
dependencies); it verifies the manifest and packs `src/`, and the zip is
deterministic, so its sha256 matches the submitted file:
`e39834cdc0b85dc66b74a2888723654f302eb8a20c9577908c90555421293a30`. No
separate source package is required.

**Data collection.** The manifest declares
`browser_specific_settings.gecko.data_collection_permissions` as
`{"required": ["none"]}`. The extension makes no network requests, has no
analytics or telemetry, and transmits nothing. It reads the page it runs on
only to draw the map, and stores only the user's own settings.

**How the map is made.** The map and the hover preview are a snapshot of the
page's own `<body>`, mounted in a sandboxed same-origin iframe
(`src/clone.js`, `src/thumb.js`) and scaled with CSS transforms
(`src/magnifier.js`). Scripts do not run in the frame, and animations and
media are paused, so it is a picture of the page rather than a second live
copy. On a page that cannot be cloned, the fallback is a text raster
(`src/textmap.js`), a port of `KateScrollBar` from KDE's KTextEditor
(https://invent.kde.org/frameworks/ktexteditor).

**Permissions.**

- **Access your data for all websites** — the extension must read whatever
  page it runs on to draw the map; that content is read locally and used for
  nothing else.
- **Storage** — saves the user's settings (width, colours, per-site
  exclusions).
- **Theme** — reads the browser's colours so the default strip colour follows
  the user's theme.

Requires Firefox 146 or later: MV3 host permissions (Firefox 127+) and the
`@scope` CSS used by the vendored scrollbar (Firefox 146).
