# AMO listing copy

Draft for the add-on's listing on addons.mozilla.org. The manifest
`description` is a summary, not a listing description; these are the words for
the form. Edit freely — this is copy, not code.

## Name

ScrollPeak

## Summary

*(This is the manifest `description`; Firefox uses it in the Extensions panel
and AMO reuses it. One sentence.)*

A scrollbar minimap. Hover the scrollbar to see the whole page, magnify a
section, click to jump.

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
- On short or multi-column pages the map turns into a block diagram — links in
  their own colour, pictures as outlines, form controls as boxes in their
  browser colours — so it stays clean instead of blurring.
- On pages that are mostly pictures — a video player, a card grid, a shop's
  search results — the map keeps the text and draws pictures and players as
  solid bars, so the page still gets a map rather than the browser's own
  scrollbar.
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

- The minimap's rendering is a port of `KateScrollBar` in Kate's
  `ktexteditor` (upstream: https://invent.kde.org/frameworks/ktexteditor).
  The tables in the README map each piece of Kate's arithmetic to its port.
- `src/vendor/vugluscr.standalone.js` is an unminified rollup bundle of
  vugluscr 2.0.0 (MIT); the surrounding files are the extension. The vendor's
  NOTICE and LICENSE are in `src/vendor/`.
- There is no build step. The zip is `src/` as-is; `python3 scripts/build.py`
  only verifies the manifest and packs it.
