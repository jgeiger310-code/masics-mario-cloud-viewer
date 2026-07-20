(() => {
  "use strict";

  const VERSION = "20260720-missing-filter-stable-selection-1";
  const AUTO_SELECT_DELAY_MS = 1600;
  const filter = document.getElementById("filter");
  const list = document.getElementById("queue-list");
  const counts = document.getElementById("queue-counts");
  const cfg = window.MASICS_DROPBOX_CONFIG;
  if (!filter || !list || !cfg?.queueIdentity) return;

  const progressKey = `masics_cloud_progress:${cfg.queueIdentity}`;
  let applying = false;
  let selectTimer = 0;
  let selectionGeneration = 0;

  window.MASICS_MISSING_FILES_FILTER_VERSION = VERSION;

  function decisions() {
    try {
      const raw = window.localStorage.getItem(progressKey);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed.decisions || {};
    } catch {
      return {};
    }
  }

  function scheduleFirstVisibleSelection(button) {
    selectionGeneration += 1;
    const generation = selectionGeneration;
    window.clearTimeout(selectTimer);
    if (!button) return;
    selectTimer = window.setTimeout(() => {
      if (generation !== selectionGeneration || filter.value !== "missing") return;
      if (!button.isConnected || button.closest("li")?.hidden) return;
      const activeButton = list.querySelector("button.active");
      if (activeButton && !activeButton.closest("li")?.hidden) return;
      button.click();
    }, AUTO_SELECT_DELAY_MS);
  }

  function applyMissingFilter() {
    if (applying || filter.value !== "missing") return;
    applying = true;
    try {
      const saved = decisions();
      const items = Array.from(list.querySelectorAll("li"));
      let shown = 0;
      let firstVisibleButton = null;
      let activeVisible = false;

      items.forEach((item) => {
        const button = item.querySelector("button[data-review-id]");
        const reviewId = button?.dataset.reviewId || "";
        const isMissing = saved[reviewId]?.decision === "missing";
        item.hidden = !isMissing;
        if (isMissing) {
          shown += 1;
          if (!firstVisibleButton) firstVisibleButton = button;
          if (button?.classList.contains("active")) activeVisible = true;
          const state = button?.querySelector(".queue-state");
          if (state) state.textContent = "Missing";
        }
      });

      if (counts) {
        counts.textContent = counts.textContent.replace(/^\d+ shown/, `${shown} shown`);
      }

      // Do not switch records inside the same browser event cycle that changed a
      // dropdown. A select emits input and change, and immediate auto-selection
      // previously let the second event save against the next Missing record.
      if (!activeVisible) scheduleFirstVisibleSelection(firstVisibleButton);
      else scheduleFirstVisibleSelection(null);
    } finally {
      applying = false;
    }
  }

  filter.addEventListener("change", () => {
    selectionGeneration += 1;
    window.clearTimeout(selectTimer);
    if (filter.value === "missing") {
      window.setTimeout(applyMissingFilter, 0);
      return;
    }
    list.querySelectorAll("li[hidden]").forEach((item) => { item.hidden = false; });
  });

  const observer = new MutationObserver(() => {
    if (filter.value === "missing") window.setTimeout(applyMissingFilter, 0);
  });
  observer.observe(list, { childList: true, subtree: true });

  window.MASICS_MISSING_FILES_FILTER_SELF_TEST = () => ({
    version: VERSION,
    filtersFromSavedReviewId: /dataset\.reviewId/.test(applyMissingFilter.toString()),
    delaysAutoSelection: AUTO_SELECT_DELAY_MS >= 1000,
    cancelsStaleSelection: /selectionGeneration/.test(scheduleFirstVisibleSelection.toString())
  });
})();
