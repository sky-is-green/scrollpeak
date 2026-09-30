// ScrollPeak — when the map is rebuilt.
//
// The clone is a snapshot, not a live mirror: the browser is not going to
// repaint it because the page changed underneath. So the question this file
// answers is *when* to take a new one, and the answer is never during a scroll
// and never while the pointer is on the rail.
//
// A mutation only raises a flag here; nothing computes inside the observer.
// The rebuild itself is debounced and rate-limited, and a scroll that ends
// with work pending is what starts it.

(function () {
  // How long the page must be still before a settle is a settle.
  const SETTLE_MS = 180;
  // The debounce on the rebuild timer itself.
  const REBUILD_DELAY_MS = 300;

  function create({ onRebuild, isHeld, minInterval = 1000, now }) {
    let disposed = false;
    let dirty = false;
    let scrolling = false;
    let settleTimer = null;
    let rebuildTimer = null;
    let heldPending = false;
    let lastRebuild = now();
    let rebuilds = 0;

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
      get stats() { return { rebuilds }; },
    };
  }

  globalThis.ScrollPeakFreshness = { create };
})();
