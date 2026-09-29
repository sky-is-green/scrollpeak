# ScrollPeak

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
scroll, stop, read, and scroll again — and usually overshoot. ScrollPeak keeps
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
| `m_miniMapWidth(40)` | default strip width, 70px — our default, not Kate's 60 |
| `m_updateTimer.setInterval(300)` | `REBUILD_DELAY_MS` |
| `m_delayTextPreviewTimer.setInterval(250)`, first show only | preview debounce |
| `setScaleFactor(0.75)`, half width by fifth height, centred, clamped | `magnifier.js` |
| pixmap stretched to the strip; fade outside the viewport at alpha 110 | `paint()` |
| ~~`docHeight = min(groove, pixmapHeight*2) - 2`~~ | **not ported — see below** |
| `m_doc->lines() > 7500` skips highlighting | `SIMPLE_MODE_LINE_COUNT` |

Kate caches the pixmap and rebuilds it on a timer; scrolling only repaints.
That split is preserved, because building the map is the expensive half and
stretching it is not.

The one deliberate deviation in Kate's arithmetic is the struck-through line
in the table. Kate sizes the map's *scrollable* range as
`min(grooveHeight, pixmapHeight * 2) - 2`,
so a pixmap shorter than half the groove is drawn doubled and the document
scrolls through that part only. On the web the clamp always bites — on the
fixture article the map was being squeezed into 124px of a 682px groove, 18% of
the strip — and it leaves the map, the thumb and the preview in three different
coordinate systems. The map spans the groove instead; the arithmetic and the
measurement are at the point of use in `src/textmap.js` (`paint()`).

**On a long document the map is a raster of the page's text, not a schematic
of its elements.** Kate draws one pixel per character, coloured by that
character's own attributes, and downsamples by skipping every Nth line and
every Nth character as the document outgrows the strip. A page gives us the
colouring for free — Kate pays for syntax highlighting explicitly, whereas a
page's computed styles already separate headings, links, body copy,
quotations and code.

`src/textmap.js` does this on a canvas.

One thing needed care: Kate asks its buffer for line *N* and gets line *N*, so
he knows exactly which characters are on which line. Here the text is laid out
by the browser, so that has to be recovered from the text node. A binary search
per line-box boundary, using `Range.getBoundingClientRect()` on single
characters, gets it exactly — O(log n) rect queries instead of O(n).
`test/verify_line_split.py` checks that against an oracle that measures every
character: 14 of 14 wrapped nodes exact, 2708 characters.

The text itself is the text the browser rendered: a source file that is
hard-wrapped in the HTML collapses its newlines to the single spaces the
browser drew, and `renderedText()` puts the line back into that shape before
characters are sliced onto it. Whitespace that is genuinely significant
(`<pre>`, `white-space: pre*`) is detected per element from its own computed
value rather than guessed.

**A page that is not one column of text stops being a raster.** Three things
switch the map to semantic blocks. One is zoom: below one text line per 4px of
groove — short articles, site stubs, the settings page — each line is stretched
into a band of blobs and the characters stop being characters. The second is
shape: when the text is spread over more than 0.75 of the viewport's width (a
watch page with its recommendation column), the raster has no way to show it,
because by design it draws every line from the left margin. The third is
content: a page whose content is pictures — a player, a card grid, a shop's
search results — is block-shaped however its text falls.

Blocks are drawn from every element on the page, not from a vocabulary: text
areas filled white or black, whichever contrasts with the strip; links in the
page's own link colour, pushed to contrast the same way the raster's marks are;
images and video as hollow 1px outlines; form controls as boxes in the
browser's own field, face and border colours, so a settings page reads as the
controls it is made of; and every other element that paints a background, a
border or a background image as an outline in its own colour. That last part is
what reads on app-shaped pages: a shop card, a recommendation thumbnail and a
player are divs, images and `<video>`, and a selector that only knew document
tags left them invisible, so the map was a handful of stray labels. A box that
paints the page background itself is left out — it is the page, and drawing it
would flood the strip and mislead everything drawn over it. It is an addition
to the port rather than a change to it: on a long single-column document, where
Kate's raster reads as text, nothing about it changes.

`test/fixtures/expected-map.png` is the real output, magnified 6×.

**A page that is mostly pictures gets that block map, not the browser's
scrollbar.** An earlier version gave those pages up: the rail did not mount and
the native scrollbar stayed. Measured on live pages — eBay's search, Amazon's
list, Reddit's front, YouTube's watch page — the generalized blocks read as the
page, so the rail keeps them, and `isMediaPage()` now only chooses the
renderer. Which pages count is measured, not taste: a video at least 300×150
(Wikipedia's 250×141 infobox thumbnail must not qualify), at least twelve
pictures of 200×100 covering more than a third of the document (Reddit's front
38 at 56%, BBC's front 43 at 33%; against Wikipedia 9 at 1.4%, GitHub 1 at 2%),
or five pictures of 120×80 in the first two viewports (measured: eBay 19,
YouTube 7, Amazon's list 5; Wikipedia 2, GitHub 0). `test/verify_media.py`
checks each fixture that must read as media, that the rail stays mounted, and
that a fixed overlay — a lightbox, Wikipedia's media viewer — changes neither:
only the page's own flow counts. The map chooses its renderer on every rebuild,
so a player that arrives later (YouTube is an SPA) switches the map to blocks
rather than taking the rail away, and opening a lightbox on a text page cannot
flip it.

**The preview is not a zoom of the map.** Kate's `KateTextPreview` renders the
*real text* of the hovered region at 0.75 scale — smaller than the editor's own
text — in a frameless window half the view's width by a fifth of its height,
centred on the hovered line and debounced by 250ms so that sweeping the mouse
across the scrollbar does not strobe it. `src/magnifier.js` reproduces all of
that.

**How the preview shows the content is the part that took longest to get
right.** Kate's preview calls `paintTextLine` for each line in the range: it
does not lay the text out, it asks the renderer to draw the line, and the
renderer is the thing that knows where every character goes. In a text editor
that is a complete answer, because a text editor's document *is* text. A web
page is not: a table cell's colour comes from its row, an icon's fill from
`currentColor`, text flows around a float, a container clips its children.

This was first ported by decomposing the page — collecting text runs, images,
canvases and backgrounds and re-emitting them at measured coordinates — and the
decomposition was the bug. Every relationship the layout engine provides is
lost, and each fix exposed the next symptom, which is the signal that the
approach is wrong rather than incomplete.

The right analogue of "ask the renderer" on the web is to let the browser
render it. **The preview is a clone of the page's content**, moved into the
magnifier with a CSS transform: translated so the hovered region is in view,
scaled by 0.75. Same markup, same layout engine, so there is nothing to keep in
sync and no way for it to disagree with the page. The transform is also what
makes it affordable: a transform does not reflow, so following the pointer is a
compositor operation, not a layout one.

**The clone renders in a sandboxed same-origin iframe**, not in this document.
A clone inserted here is live: its web components upgrade, their
`connectedCallback` runs, and a page's own components then re-render themselves
from state a clone does not have. On YouTube's watch page that wiped 94% of the
clone — 4,650 nodes to 303 — and left the preview blank. A frame has an empty
custom-element registry and no page scripts run in it, so the cloned components
stay inert. The page's stylesheets are copied in through the CSSOM, because a
frame does not inherit the parent's cascade.

**The frame's viewport is the preview's own width**, not the page's. That is
what makes a narrow preview work: the page's responsive CSS sees a window
exactly as wide as the frame and reflows — breakpoints, media queries,
percentage widths, `vw` — instead of being cropped. At a 50% preview on a
1280px window the clone is laid out at 848px, and the browser does the
adapting it would do in an 848px window. The frame's *height* stays the page's,
so `vh` units and full-height sections keep the shape they have on the page
instead of collapsing to the preview's slit. Because a reflow can change how
tall the document is, the hovered offset is mapped onto the clone by fraction:
the map is proportional, and the fraction is what it shows.

What the clone needs, then:

- **Our UI is removed from it** — or the rail and the preview would be cloned
  into themselves — and so is the room the rail reserved: vugluscr sets an
  inline `padding-right` on the body, and left in it makes the preview a rail's
  width narrower than the page really is. `canvas` pixels and
  `input`/`textarea`/`select` state are copied, because `cloneNode` does not
  carry them.
- **`position: fixed` elements are hidden**, read through the frame's window.
  A cookie banner or sticky toolbar has no document position — it is wherever
  the viewport is — so left in, it would sit pinned over one arbitrary part of
  a preview of the whole page. Elements that are merely `sticky` stay where
  they flow.
- **Ids stay.** Stripping them broke sites whose layout is placed with
  id-keyed rules: Wikipedia's Vector skin sets `grid-area` on
  `#content > .vector-body`, and without the id the article body was
  auto-placed into the wrong grid cell, thousands of pixels away. Through a
  frame there was never a duplication hazard to guard against.

Rebuilding the clone is the expensive half — about 130ms for a 13,500-node page
— so it happens on the map's own revision and not while the pointer is moving: a
clone a moment out of date is a much smaller lie than a preview that cannot keep
up with the cursor. The first build starts on pointer entry, inside Kate's 250ms
first-appearance delay.

`test/verify_preview_lines.py` checks the strong claim directly. It opens a
*reference* iframe of the same URL at the clone's exact width and asserts every
element lands on its counterpart — position and size — to 0.01px, alongside
the element and duplicate-content checks against the page itself. A fixture
whose breakpoint sits between the two widths proves the clone takes the page's
narrow layout while the page keeps its wide one. It also samples strings and
asserts each appears exactly once in the preview, which is the check that
would have caught the old model's duplication directly: a reconstructed run
and a cloned graphic drawing the same text, a few pixels apart.

The preview's frame is a 1px hairline: every pixel here is a pixel of the page
that is not shown, and the page supplies its own margins.

## The settings page

The options page mounts a real ScrollPeak on itself, from the same files a page
gets, so a change can be seen landing without leaving. That is deliberate: a
preview built from anything else could disagree with what a page actually gets.
Checked by moving the width control and watching the bar go 70px to 120px.

The popup carries the settings you reach mid-browsing -- the site toggle, the
magnifier, markers, width, minimap-only and peek -- and All settings, which is
the largest thing in it. Colour is not in the popup: it belongs on the settings
page, where the live bar shows what it does.

`test/test_ui.py` drives the popup and the options page through a stubbed
extension API; `test/test_settings.py` installs variants of the extension and
checks that each setting changes what a real page gets.

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
  magnifier.js       the hover preview: the page's content cloned under a
                     CSS transform
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

ScrollPeak needs **Firefox 146 or later**; the manifest enforces it, and the
reason is in [Status](#status).

The quick way:

```sh
python3 scripts/dev-launch.py                        # blank tab
python3 scripts/dev-launch.py https://en.wikipedia.org/wiki/Firefox
```

That starts a second Firefox on a throwaway profile in `test-profile/`, installs
ScrollPeak into it, and leaves the window open. Your existing Firefox, your
bookmarks and your other extensions are untouched — it really is a separate
instance. Close that window when you are done; if you restart Firefox you need
to run the script again, because temporary add-ons do not survive a restart.

The manual way, in your normal browser:

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Pick `src/manifest.json`

To install it permanently, submit to [addons.mozilla.org](https://addons.mozilla.org).
An **unlisted** submission is signed for your own use without a listing
review; a **listed** one is public and goes through review. Either way the
add-on is signed, which is what a Release build requires.

## Settings

There are two places, and the split is not a preference — MDN decides it.

A **popup** is loaded fresh every time it opens and Firefox resizes it to fit
its content with *no vertical scrolling*, capped at 800×600. An unbounded list
does not fit in that. So the popup carries the settings you might want to reach
mid-browsing: the current site's toggle, the three-way scrollbar mode, the two
checkboxes and the width slider. The **options page** carries the site list,
which grows without bound.

MDN also settles three details that are easy to get wrong:

- **Width goes on `<body>`, not `:root`.** Firefox computes a popup's preferred
  width from the body, and ignores a width on the root.
- **`browser_style` must not be set.** Its support was removed in Manifest V3 in
  Firefox 118, so the popup is styled by hand.
- **Firefox defaults `default_area` to `"menupanel"`**, which is where the
  button lives until the user moves it. `"navbar"` would put it beside the URL
  bar, and Firefox remembers that choice per extension — so changing it later
  would need a new add-on id. Left at the default.

The toolbar button also shows state: the icon is dimmed and the tooltip says
"off" when ScrollPeak is disabled for the site you are on. Without it, the only
way to tell is to look for the rail, and "nothing appeared" is indistinguishable
from "broken".

Settings changes are broadcast from `browser.storage.onChanged` rather than by
each writer remembering to, so the popup, the options page and anything added
later all update the open tabs without knowing the tabs exist.

### The settings Kate offers for this feature. From
`KateViewConfig` / the Appearance → Borders tab:

| Setting | Kate default | Here |
|---|---|---|
| Scrollbar minimap width | 60 | `minimapWidth`, default 70 |
| Scrollbar preview (the hover preview) | on | `showMagnifier` |
| Show scrollbars: always / when needed | always | `scrollbarMode`, default when-needed |

Kate's own default width is 60 — not the 40 in `KateScrollBar`'s constructor,
which `kateview.cpp` overrides at init — but ours is 70. Kate's "never" mode
is gone: the enabled switch supersedes it, and a profile that still carries
"never" is treated as disabled.

Deliberately **not** ported:

- **Scrollbar marks** (`ShowScrollBarMarks`). In Kate they are bookmarks and
  breakpoints, and on a web page "what matters" cannot be guessed; there is no
  equivalent worth showing.
- **A colour for every mark.** The page's own text colours are what make a
  heading look different from body copy, and they are better than anything a
  single override would pick.
- **"Show whole document in the mini-map"** (`ShowScrollBarMiniMapAll`).
  Kate's own settings dialog hides its checkbox with the comment *"temporary
  until the feature is done"*, so it is not a setting anyone can depend on.
- **Map tint or opacity.** The map takes the page's own colours by design; a
  tint setting would fight that.

### Not in Kate

These are web-specific, with no analogue in an editor:

| Setting | Default | What it does |
|---|---|---|
| Preview width | 30% of the window | The hover preview's width. Kate hardcodes his at half the window and offers no control. |
| Preview height | 20% of the window | The hover preview's height. Kate hardcodes a fifth. |
| Minimap only, no track | off | Drops the narrow drag track, so the rail is just the map and takes 14px less. The page's gutter shrinks with it. |
| Hide until I scroll or approach | off | Parks the rail off the right edge. It returns on scroll, wheel, key press, or when the pointer comes within the trigger distance. |
| Trigger distance | 48px | How close to the right edge counts as "near". |
| Stay visible for | 1.6s | How long it stays after a trigger. |
| Strip colour | follows the browser | The minimap's background. |
| Minimap background shade | 82% | How far to darken, for the default strip colour. |
| Minimum mark contrast | 3:1 | WCAG ratio the marks must reach against the strip. |

**On the strip colour and contrast.** Kate fills the minimap with the editor
background and draws the text's own colours into it, so his marks contrast by
construction. A page's text colours are chosen against the *page*, not against
our strip, so a dark grey that is perfectly legible in a light article vanishes
on a dark strip. The marks are therefore forced to contrast, and only their
lightness moves, so a link stays link-coloured. Measured on the fixture, the
page's 1036 distinct mark colours survive at 3.2:1 by default and 17:1 on a
light override.

**On the default colour following the browser.** The default strip colour is a
darker shade of, in order of preference:

1. your Firefox theme's `toolbar` (or `frame`, `popup`, `sidebar`);
2. the page's own background — the first ancestor from `<body>` upward that
   actually paints one, since a body background is transparent by default and
   many sites set theirs on `<html>` or a full-bleed wrapper;
3. the system's light or dark appearance, for a page that paints nothing.

Two things measured rather than assumed, because they decide how much of this
is possible:

- **`theme.getCurrent()` is `{}` unless a theme is installed.** With the default
  theme it returns no colours at all, so there is nothing to read, and the
  fallback to the page is what covers that case.
- **A content script cannot see Firefox's own widget colours.** `ButtonFace`,
  `AccentColor` and `-moz-Dialog` all resolve in a page, and they resolve to
  Firefox's *light* palette — measured identical with
  `ui.systemUsesDarkTheme` set to 1, while `prefers-color-scheme` correctly
  reported dark. So `prefers-color-scheme` is the only live signal about the
  machine a page can get, and it is all the third step above uses.

`browser.theme.onUpdated` re-derives and repaints in place, so changing theme
does not reload the page. `prefers-color-scheme` is watched for the same reason.

`src/colour.js` holds that arithmetic and is loaded by the content script *and*
by the options page and popup, so the swatch in the settings is the colour the
strip will actually be rather than a placeholder.

**On peek.** The rail is transformed off-screen rather than hidden, so it keeps
its box: the page's padding does not change when it slides away, and the
preview can still measure it while it is off-screen.

### Testing the settings

`test/test_settings.py` installs the extension with different defaults and
checks what a real page ends up with — that `whenNeeded` hides on a page that
fits, that the width actually changes the rail, that the preview size settings
change the preview, and that every control on the options page maps to a real
setting.

```sh
python3 test/test_ui.py               # the popup and the options page
python3 test/smoke.py                 # map, preview, click-to-jump, hover
python3 test/verify_alignment.py     # map, band, thumb and preview agree
python3 test/verify_hover_tracking.py # the preview follows a moving pointer
python3 test/verify_line_split.py     # line splitting is exact, vs an oracle
python3 test/verify_graphics.py       # images, SVG, canvas and backgrounds
python3 test/verify_preview_lines.py  # the preview reproduces the page's lines
python3 test/verify_blocks.py         # text raster when long, blocks when zoomed
python3 test/verify_media.py          # media pages get the block map, rail stays
python3 test/test_appearance.py       # colour, contrast, minimap-only, peek
python3 test/test_settings.py         # every setting changes something
python3 test/probe_sites.py           # live sites; edit SITES at the top
```

Each test starts its own fixture server and its own headless Firefox on a
throwaway profile; nothing needs to be running first. All of them resolve the
extension through `test/harness.py`, so none of them can drift onto a stale
copy — one of them had a hardcoded scratch path and had been quietly testing
two-commit-old code.

`test/verify_hover_tracking.py` is a regression test for a bug that was only
visible by hand: the preview was debounced on every move, so it only updated
once the pointer stopped. It fires a burst of moves 16ms apart and checks each
one lands on its own document offset. Reverting the fix makes three of its
checks fail, so it is not a test that passes by accident.

`test/smoke.py` loads the extension into a throwaway Firefox profile as a
temporary add-on and drives it over a real page with Marionette, asserting that
the rail mounts, that the map painted the page's own colours, that the strip is
still hit-testable, that the preview appears at the right size and position,
and that clicking scrolls. Exits non-zero on failure.

## Status

**Functionally complete; in release clean-up.** The map, the preview,
click-to-jump, drag, peek, minimap-only, the settings pages and the
theme-derived colours all work, and all eleven test suites pass. `probe_sites.py`
additionally drives GitHub, Wikipedia, a YouTube watch page, Reddit's front,
MDN, Hacker News and a 20,254-node W3C spec and reports map scale, painted
pixels, renderer, console errors and page-layout damage.

The numbers that look like boasts in this README are measurements, checked
against the page rather than against themselves: the preview reproduces the
page's element offsets and sizes to 0.01px and every sampled string in it
appears exactly once; a scripted cursor sweep down the rail holds p99 17.1ms,
with the single frame over 100ms on arrival rather than during the sweep; and
the map leaks no graphics (red = 0, green = 0 in the strip).

Known limits, in rough priority order:

- **The map is a text raster until a page is not one column of text.** On a
  long single-column document it is built from the page's own line boxes, so
  images, borders and empty containers carry no marks; that is Kate's model.
  When the text is stretched too far, spread across columns, or the page's
  content is pictures, it switches to the semantic blocks described above,
  where every painted element is drawn, images are outlines and links are
  their own colour. A box that paints the page background itself is skipped,
  and a fixed overlay is not the page. A page with heavy grid or flex layout
  still maps its text where the browser put it, and the preview is unaffected
  — the preview is the page.
- **The preview's first clone build is not free** (~130ms for a 13,500-node
  page) and lands on rail arrival. Kate's 250ms first-appearance delay hides it
  on the first hover of a page load; it is the one rough edge left in frame
  pacing. Moving the build to idle time was tried and reverted: it moved the
  cost rather than removing it.
- **SPA route changes and lazily-mounted content** are caught by a
  hard-debounced `MutationObserver`, which fires constantly on sites like
  GitHub. It works, but the debounce is a guess rather than a measurement.
- **Only the page's own vertical scroll.** vugluscr can drive an inner
  scroller; ScrollPeak does not mount on one.
- **Untested on Firefox for Android, and on sites that virtualise their
  content.**

The minimum version is **Firefox 146**, and it is not arbitrary. Manifest V3
host permissions — without which content scripts are never injected — are not
granted at install before Firefox 127, and the vendored vugluscr injects its
structural CSS inside `@scope`, which Firefox shipped in 146. On anything older
the extension either cannot inject or has no rail layout at all, so
`strict_min_version` states the floor rather than hoping.

## Privacy

No network access, no analytics, no telemetry. ScrollPeak renders locally from
the page you are already looking at and stores nothing beyond your own
preferences.

It requests access to all URLs, because it has to read the structure and text of
any page you visit in order to draw the map. That permission is used for that
and nothing else.

## License

MIT
