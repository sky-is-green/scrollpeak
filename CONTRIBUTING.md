# Contributing

Thanks for your interest.

## Getting set up

No build step. Clone, then load `src/manifest.json` in Firefox via
`about:debugging` → *This Firefox* → *Load Temporary Add-on*.

## Architecture

The extension is a thin shell around two pieces:

- **vugluscr** (`src/vendor/vugluscr.standalone.js`) — MIT, vendored. Provides
  the custom scrollbar, the SVG block map, click-to-jump and drag-to-scroll.
  Its internals are adapted from VS Code's editor scrollbar. Do not edit the
  vendored file; changes belong upstream in `jurijsk/vugluscr`.
- **ScrollPeek's own code** — the extension manifest, settings, per-site
  enable/disable, and the magnifier. This is what we own.

Keep the boundary sharp. If a change can be made upstream, make it upstream
and bump the vendored build. If it is genuinely web-extension-specific, it
belongs here.

## Before you open a pull request

- `npx web-ext lint --source-dir src/` is clean.
- The change works on a page with a lazy-loading feed, not just a static
  article. Most of the hard bugs in this problem are on pages that mutate.
- You have not added a dependency without discussing it. ScrollPeek ships a
  prebuilt IIFE and a `vendor/` directory on purpose — it keeps the extension
  auditable, which matters for something requesting access to every page you
  visit.

## Reporting bugs

Include the page you were on (or a close analogue if it is private) and what
you expected the minimap to show versus what it did.
