// ScrollPeak — when the map is rebuilt, and when a band is refreshed.
//
// The clone is a snapshot, not a live mirror: the browser is not going to
// repaint it because the page changed underneath. So the question this file
// answers is *when* to take a new one, and the answer is never during a scroll
// and never while the pointer is on the rail.
//
// Two decisions, two costs:
//
//   * onRebuild() — a new snapshot of the whole page. Expensive, so it is
//     debounced and rate-limited, and it is suppressed on pages that recycle
//     their content (see "recycler" below).
//   * onSettle()  — one look at the band the user just landed on. Cheap and
//     viewport-bounded; rail.js patches it if the base is stale there.
//
// A mutation only raises a flag here. Nothing computes inside the observer.

(function () {
  // How long the page must be still before a settle is a settle.
  const SETTLE_MS = 180;
  // The debounce on the rebuild timer itself.
  const REBUILD_DELAY_MS = 300;
  // Consecutive settles whose band changed, with the document unchanged in
  // height, before a page is treated as recycling its content.
  const RECYCLER_RUNS = 3;

  function create({ onRebuild, onSettle, isHeld, minInterval = 1000, now }) {
    let disposed = false;
    let dirty = false;
    let scrolling = false;
    let settleTimer = null;
    let rebuildTimer = null;
    let heldPending = false;
    let lastRebuild = now();
    // A recycling page (Reddit, X, a virtualised list) never holds the whole
    // document in the DOM, so a full rebuild is worse than useless: it drops
    // the content the map has already seen. Once one is recognised, only band
    // samples and forced rebuilds (height change, route change, settings) run.
    let differRuns = 0;
    let bandOnly = false;
    let rebuilds = 0;
    let bands = 0;

    const mutations = new MutationObserver(() => {
      dirty = true;
      scheduleRebuild(false);
    });
    mutations.observe(document.body, { childList: true, subtree: true });

    function scheduleRebuild(force) {
      if (disposed || rebuildTimer !== null) return;
      const since = now() - lastRebuild;
      const wait = force
        ? REBUILD_DELAY_MS
        : Math.max(REBUILD_DELAY_MS, minInterval - since);
      rebuildTimer = setTimeout(() => {
        rebuildTimer = null;
        if (disposed) return;
        if (isHeld() || scrolling) {
          heldPending = true;
          return;
        }
        if (bandOnly && !force) {
          dirty = false;
          return;
        }
        dirty = false;
        lastRebuild = now();
        rebuilds++;
        onRebuild(force);
      }, wait);
    }

    function onScroll() {
      scrolling = true;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        scrolling = false;
        if (disposed) return;
        let res = null;
        try {
          res = onSettle ? onSettle() : null;
        } catch (err) {
          document.documentElement.dataset.sperr = String(err && err.stack || err);
        }
        bands++;
        if (res && res.checked) {
          if (res.differed) {
            differRuns++;
            if (differRuns >= RECYCLER_RUNS && res.stable && !bandOnly) {
              bandOnly = true;
            }
          } else {
            differRuns = 0;
          }
        }
        if (dirty || heldPending) {
          heldPending = false;
          scheduleRebuild(false);
        }
      }, SETTLE_MS);
    }

    function onPop() {
      scheduleRebuild(true);
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("popstate", onPop);

    return {
      requestRebuild: (force) => scheduleRebuild(force),
      /** The pointer left the rail; pick up anything that was held back. */
      resume() {
        if (!heldPending) return;
        heldPending = false;
        scheduleRebuild(false);
      },
      dispose() {
        disposed = true;
        clearTimeout(settleTimer);
        clearTimeout(rebuildTimer);
        mutations.disconnect();
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("popstate", onPop);
      },
      get bandOnly() { return bandOnly; },
      get stats() { return { rebuilds, bands, bandOnly }; },
    };
  }

  globalThis.ScrollPeakFreshness = { create };
})();
