(() => {
  "use strict";

  const filter = document.getElementById("filter");
  const list = document.getElementById("queue-list");
  const counts = document.getElementById("queue-counts");
  const cfg = window.MASICS_DROPBOX_CONFIG;
  if (!filter || !list || !cfg?.queueIdentity) return;

  const progressKey = `masics_cloud_progress:${cfg.queueIdentity}`;
  let applying = false;

  function decisions() {
    try {
      const raw = window.localStorage.getItem(progressKey);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed.decisions || {};
    } catch {
      return {};
    }
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

      if (!activeVisible && firstVisibleButton) firstVisibleButton.click();
    } finally {
      applying = false;
    }
  }

  filter.addEventListener("change", () => {
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
})();
