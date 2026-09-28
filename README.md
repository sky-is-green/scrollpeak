# ScrollPeek

**A scrollbar minimap for Firefox.**

Hover the scrollbar to see the whole page rendered as its own text. Move the
cursor over a section to read a preview of what's there. Click to jump.

A port of [Kate](https://kate-editor.org)'s scrollbar minimap to the browser.

![the minimap](test/fixtures/expected-map.png)

## Why

Kate's scrollbar shows you the shape of a whole document without scrolling it,
and a preview when you hover. On a 5,000-line file that is the difference
between finding a function and hunting for it.

The web has no equivalent. On a long article or a documentation page you
scroll, stop, read, and scroll again — and usually overshoot. ScrollPeek keeps
the whole page beside you at all times and lets you aim before you leap.

## How it works

**This is a port, not an interpretation.** Where Kate's source settles a
question, the source wins. `textmap.js` follows `updatePixmap()` and
`miniMapPaintEvent()` step for step, including the arithmetic that is easy to
get subtly wrong:

| Kate | Ported as |
|---|---|
| `s_lineWidth` 100, `s_pixelMargin` 8, `s_linePixelIncLimit` 6 | same constants |
| `charIncrement = pixmapLineCount / grooveHeight`, capped at 6, then escalating to `lineIncrement` | `buildPixmap()` |
| `m_miniMapWidth(40)` | default strip width, 40px |
| `m_updateTimer.setInterval(300)` | `REBUILD_DELAY_MS` |
| `m_delayTextPreviewTimer.setInterval(250)` | preview debounce |
| `setScaleFactor(0.75)`, half width by fifth height, centred, clamped | `magnifier.js` |
| pixmap stretched to the strip; fade outside the viewport at alpha 110 | `paint()` |
| `m_doc->lines() > 7500` skips highlighting | `SIMPLE_MODE_LINE_COUNT` |

Kate caches the pixmap and rebuilds it on a timer; scrolling only repaints.
That split is preserved, because building the map is the expensive half and
stretching it is not.

**The map is a raster of the page's text, not a schematic of its elements.**
Kate draws one pixel per character, coloured by that character's own
attributes, and downsamples by skipping every Nth line and every Nth character
as the document outgrows the strip. A page gives us the colouring for free —
Kate pays for syntax highlighting explicitly, whereas a page's computed styles
already separate headings, links, body copy, quotations and code.

`src/textmap.js` does this on a canvas.

One thing needed care: Kate asks its buffer for line *N* and gets line *N*, so
he knows exactly which characters are on which line. Here the text is laid out
by the browser, so that has to be recovered from the text node. A binary search
per line-box boundary, using `Range.getBoundingClientRect()` on single
characters, gets it exactly — O(log n) rect queries instead of O(n).
`test/verify_line_split.py` checks that against an oracle that measures every
character: 14 of 14 wrapped nodes exact, 2708 characters.

`test/fixtures/expected-map.png` is the real output, magnified 6×.

**The preview is not a zoom of the map.** Kate's `KateTextPreview` renders the
*real text* of the hovered region at 0.75 scale — smaller than the editor's own
text — in a frameless window half the view's width by a fifth of its height,
centred on the hovered line and debounced by 250ms so that sweeping the mouse
across the scrollbar does not strobe it. `src/magnifier.js` reproduces all of
that.

**We do not screenshot the page.** `tabs.captureVisibleTab` accepts a `rect`
in page coordinates, so off-screen capture is nominally possible — but
`content-visibility: auto` (Baseline 2024) tells the user agent to skip layout
and painting for off-screen content, and lazy images below the fold have not
loaded. An off-screen capture comes back blank. Reading the DOM instead is
immune to all of it, because the text is in the document whether or not it has
been painted. That is precisely why the one prior art on AMO, Scrollbar Lens,
shows an empty strip.

## Architecture

```
src/
  manifest.json      MV3
  background.js      settings and per-site enablement; owns no page data
  content.js         lifecycle: mount, and re-mount when settings change
  textmap.js         Kate's updatePixmap(), on a canvas
  rail.js            mounts the rail, installs our map
  magnifier.js       Kate's KateTextPreview(), on a canvas
  content.css        theming, via vugluscr's own custom properties
  vendor/            vugluscr 2.0.0, vendored (MIT)
```

`vugluscr` supplies the scrollbar mechanics — the thumb, click-to-jump,
drag-to-continue, wheel forwarding, the strip's hit area, and an SVG whose
`viewBox` is in document pixels, which is the coordinate space the preview
needs. Its own map is switched off rather than left running: `Minimap.renderSurface()`
returns early when `sourceElement` is null, after it has set the viewBox, so
nulling it costs us nothing we use and saves a per-element
`getBoundingClientRect` sweep of the whole document on every layout pass.

We never write rules against vugluscr's internals. Its colours are all
`--vugluscr_*` custom properties, and its structural CSS lives in
`@layer vugluscr.structure`, so an unlayered rule of ours restyles it without
fighting specificity. That is what keeps the vendored copy replaceable.

## Installing it to try

This is a Release build of Firefox, and Release will not install unsigned
extensions — `xpinstall.signatures.required=false` is silently ignored outside
Nightly, Developer Edition and ESR. What Release does accept is a **temporary
add-on**, which needs no Mozilla account and no signing.

The quick way:

```sh
python3 scripts/dev-launch.py                        # blank tab
python3 scripts/dev-launch.py https://en.wikipedia.org/wiki/Firefox
```

That starts a second Firefox on a throwaway profile in `test-profile/`, installs
ScrollPeek into it, and leaves the window open. Your existing Firefox, your
bookmarks and your other extensions are untouched — it really is a separate
instance. Close that window when you are done; if you restart Firefox you need
to run the script again, because temporary add-ons do not survive a restart.

The manual way, in your normal browser:

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Pick `src/manifest.json`

To install it permanently, submit to [addons.mozilla.org](https://addons.mozilla.org)
as an **unlisted** add-on. That is signed automatically and is not human
reviewed, which is the right route once the UI is settled.

## Settings

Kate's own settings for this feature, and only those. From
`KateViewConfig` / the Appearance → Borders tab:

| Setting | Kate default | Here |
|---|---|---|
| Scrollbar minimap width | 60 | `minimapWidth` |
| Scrollbar preview (the hover preview) | on | `showMagnifier` |
| Scrollbar marks | off | `showMarkers` |
| Show scrollbars: always / when needed / never | always | `scrollbarMode` |

Two of my earlier guesses were wrong and are corrected: the default width is
**60**, not the 40 in `KateScrollBar`'s constructor — `kateview.cpp` applies the
config value at init and overrides it — and marks default **off**, which I had
on.

Deliberately **not** ported:

- **"Show whole document in the mini-map"** (`ShowScrollBarMiniMapAll`).
  Kate's own settings dialog hides its checkbox with the comment *"temporary
  until the feature is done"*, so it is not a setting anyone can depend on.
- **Preview size and scale.** Kate hardcodes half the window wide by a fifth
  tall, at 0.75 scale, and offers no control. Neither do we.
- **Map tint or opacity.** The map takes the page's own colours by design; a
  tint setting would fight that.

The web-specific addition is the site exclusion list, which has no analogue in
an editor.

### Testing the settings

`test/test_settings.py` installs the extension with different defaults and
checks what a real page ends up with — that `never` releases the padding the
rail reserved, that `whenNeeded` hides on a page that fits, that the width
actually changes the rail, and that every control on the options page maps to a
real setting.

```sh
python3 test/smoke.py             # map, preview, click-to-jump, hover
python3 test/verify_line_split.py # line splitting is exact, against an oracle
python3 test/test_settings.py     # every setting changes something
python3 test/probe_sites.py       # live sites: GitHub, Wikipedia, a W3C spec
```

Each test starts its own fixture server and its own headless Firefox on a
throwaway profile; nothing needs to be running first. `test/probe_sites.py`
needs internet and takes a list of URLs at the top of the file.

Loads the extension into a throwaway Firefox profile as a temporary add-on and
drives it over a real page with Marionette, asserting that the rail mounts, that
the map painted the page's own colours, that the strip is still hit-testable,
that the preview appears at the right size and position, and that clicking
scrolls. Exits non-zero on failure.

## Status

Working end to end, and verified against live sites. The map, the preview,
click-to-jump and drag are in place; the smoke test covers them, and
`test/probe_sites.py` confirms the map renders on GitHub (9×, 20 colours),
Wikipedia (73×, 13,590 DOM nodes) and a 20,254-node W3C spec without breaking
the page layout.

Known gaps, in rough priority order:

- **A page is not linear text.** Kate lays out a buffer of lines; a page has
  grid and flex layouts where two elements share a row, and a line box can
  report a `y` far outside the document (Wikipedia's infobox reports
  y ≈ -100000 for content scrolled out of an inner container). Both are
  handled — out-of-document boxes are dropped, and the preview declutters each
  row left to right — but a page with heavy multi-column layout will preview
  less completely than a text file would.
- SPA route changes and lazily-mounted content are caught by a debounced
  `MutationObserver`, which fires constantly on sites like GitHub. It works,
  but the debounce is a guess.
- Only vertical page scroll. vugluscr can drive an inner scroller; we do not.
- Untested on Firefox for Android, and on sites that virtualise their content.

## Privacy

No network access, no analytics, no telemetry. ScrollPeek renders locally from
the page you are already looking at and stores nothing beyond your own
preferences.

It requests access to all URLs, because it has to read the structure and text of
any page you visit in order to draw the map. That permission is used for that
and nothing else.

## License

MIT
