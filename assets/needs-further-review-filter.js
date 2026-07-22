(() => {
  "use strict";

  const VERSION = "20260721-needs-review-filter-stable-selection-1";
  const FILTER_VALUE = "needs_review";
  const FILTER_LABEL = "Needs further review";
  const AUTO_SELECT_DELAY_MS = 1600;
  const filter = document.getElementById("filter");
  const list = document.getElementById("queue-list");
  const counts = document.getElementById("queue-counts");
  const empty = document.getElementById("empty-state");
  const view = document.getElementById("record-view");
  const cfg = window.MASICS_DROPBOX_CONFIG;

  if (!filter || !list || !cfg?.queueIdentity) return;

  const progressKey = `masics_cloud_progress:${cfg.queueIdentity}`;
  let applying = false;
  let selectTimer = 0;
  let selectionGeneration = 0;

  window.MASICS_NEEDS_REVIEW_FILTER_VERSION = VERSION;

  if (![...filter.options].some((option) => option.value === FILTER_VALUE)) {
    const option = document.createElement("option");
    option.value = FILTER_VALUE;
    option.textContent = FILTER_LABEL;
    const reviewedOption = [...filter.options].find((candidate) => candidate.value === "reviewed");
    filter.insertBefore(option, reviewedOption || null);
  }

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
      if (generation !== selectionGeneration || filter.value !== FILTER_VALUE) return;
      if (!button.isConnected || button.closest("li")?.hidden) return;
      const activeButton = list.querySelector("button.active");
      if (activeButton && !activeButton.closest("li")?.hidden) return;
      button.click();
    }, AUTO_SELECT_DELAY_MS);
  }

  function applyNeedsReviewFilter() {
    if (applying || filter.value !== FILTER_VALUE) return;
    applying = true;
    try {
      const saved = decisions();
      const items = [...list.querySelectorAll("li")];
      let shown = 0;
      let firstVisibleButton = null;
      let activeVisible = false;

      items.forEach((item) => {
        const button = item.querySelector("button[data-review-id]");
        const reviewId = button?.dataset.reviewId || "";
        const isNeedsReview = saved[reviewId]?.decision === FILTER_VALUE;
        item.hidden = !isNeedsReview;
        if (isNeedsReview) {
          shown += 1;
          if (!firstVisibleButton) firstVisibleButton = button;
          if (button?.classList.contains("active")) activeVisible = true;
          const state = button?.querySelector(".queue-state");
          if (state) state.textContent = "Needs review";
        }
      });

      if (counts) {
        counts.textContent = counts.textContent.replace(/^\d+ shown/, `${shown} shown`);
      }

      if (!shown) {
        scheduleFirstVisibleSelection(null);
        if (empty) {
          empty.hidden = false;
          empty.textContent = "No records are marked Needs further review.";
        }
        if (view) view.hidden = true;
      } else {
        if (empty) empty.hidden = true;
        if (view) view.hidden = false;
        if (!activeVisible) scheduleFirstVisibleSelection(firstVisibleButton);
        else scheduleFirstVisibleSelection(null);
      }
    } finally {
      applying = false;
    }
  }

  filter.addEventListener("change", () => {
    selectionGeneration += 1;
    window.clearTimeout(selectTimer);
    if (filter.value === FILTER_VALUE) {
      window.setTimeout(applyNeedsReviewFilter, 0);
    }
  });

  const observer = new MutationObserver(() => {
    if (filter.value === FILTER_VALUE) window.setTimeout(applyNeedsReviewFilter, 0);
  });
  observer.observe(list, { childList: true, subtree: true });

  window.MASICS_NEEDS_REVIEW_FILTER_SELF_TEST = () => ({
    version: VERSION,
    optionPresent: [...filter.options].some((option) => option.value === FILTER_VALUE),
    filtersFromSavedReviewId: /dataset\.reviewId/.test(applyNeedsReviewFilter.toString()),
    delaysAutoSelection: AUTO_SELECT_DELAY_MS >= 1000,
    cancelsStaleSelection: /selectionGeneration/.test(scheduleFirstVisibleSelection.toString())
  });
})();
