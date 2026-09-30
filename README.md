# ScrollPeak

**A scrollbar minimap for Firefox.**

Hover the scrollbar to see the whole page as a small map, move across it to
read a preview of that part of the page, and click to jump there. The map is
the page's own rendering, scaled down; on a page that cannot be cloned, Kate's
text raster is the fallback.

A port of the scrollbar minimap from [Kate](https://kate-editor.org), the KDE
text editor. How the original works is best explained by the original: the
minimap lives in `KateScrollBar` in
[KTextEditor](https://invent.kde.org/frameworks/ktexteditor).

## Demo

<!-- Short webms of ScrollPeak in use go here. One clip per feature reads
     best: hover preview, click-to-jump, peek. -->
_Demo clips coming soon._

## Running it

ScrollPeak needs **Firefox 146 or later**, and the floor is measured, not
taste: MV3 host permissions — without which content scripts never run — are
not granted at install before Firefox 127, and the vendored scrollbar CSS
uses `@scope`, which Firefox shipped in 146.

The quick way starts a second Firefox on a throwaway profile with ScrollPeak
installed, and leaves the window open. Your own Firefox, its bookmarks and
its other extensions are untouched:

```sh
python3 scripts/dev-launch.py                        # blank tab
python3 scripts/dev-launch.py https://en.wikipedia.org/wiki/Firefox
```

To use it in your normal browser instead: open
`about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**,
and pick `src/manifest.json`. Release Firefox does not install unsigned
extensions, and a temporary add-on does not survive a restart.

## Development

- **Tests** — `python3 test/<name>.py`; each suite starts its own fixture
  server and headless Firefox. `python3 test/smoke.py` is the quickest
  end-to-end check.
- **Release zip** — `python3 scripts/build.py` writes
  `dist/scrollpeak-<version>.zip` and verifies the manifest before packing.
  The build is deterministic, so the printed sha256 identifies the source.
- **Live sites** — `python3 test/probe_sites.py` drives real pages and
  reports what the map did on each.

## Privacy

No network access, no analytics, no telemetry. ScrollPeak reads the page you
are on in order to draw the map, and stores nothing beyond your own
preferences. It requests access to all URLs because it must be able to read
any page it runs on; that permission is used for the map and nothing else.

## License

MIT
