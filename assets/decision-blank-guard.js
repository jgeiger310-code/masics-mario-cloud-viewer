(() => {
  "use strict";

  const VERSION = "20260709-no-blank-revert-1";
  window.MASICS_DECISION_BLANK_GUARD_VERSION = VERSION;

  function cfg() {
    return window.MASICS_DROPBOX_CONFIG || {};
  }

  function progressKey() {
    return `masics_cloud_progress:${cfg().queueIdentity}`;
  }

  function currentReviewId() {
    const meta = document.getElementById("record-meta");
    if (!meta) return "";
    const terms = Array.from(meta.querySelectorAll("dt"));
    for (const term of terms) {
      if (String(term.textContent || "").trim().toLowerCase() !== "review id") continue;
      const dd = term.nextElementSibling;
      return String(dd && dd.textContent || "").trim();
    }
    return "";
  }

  function savedDecision(reviewId) {
    if (!reviewId) return "";
    try {
      const raw = window.localStorage.getItem(progressKey());
      if (!raw) return "";
      const progress = JSON.parse(raw);
      return String(progress && progress.decisions && progress.decisions[reviewId] && progress.decisions[reviewId].decision || "");
    } catch {
      return "";
    }
  }

  function preventBlankOverwrite(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id !== "decision" && target.id !== "notes") return;
    const decision = document.getElementById("decision");
    if (!decision) return;
    const reviewId = currentReviewId();
    const existingDecision = savedDecision(reviewId);
    if (!existingDecision || String(decision.value || "")) return;
    decision.value = existingDecision;
    const status = document.getElementById("save-status");
    if (status) status.textContent = `Protected saved decision from blank overwrite: ${existingDecision}`;
    event.stopImmediatePropagation();
  }

  document.addEventListener("input", preventBlankOverwrite, true);
  document.addEventListener("change", preventBlankOverwrite, true);

  window.MASICS_DECISION_BLANK_GUARD_SELF_TEST = () => ({
    version: VERSION,
    guardInstalled: true,
    readsReviewIdFromMeta: /record-meta/.test(currentReviewId.toString()),
    blocksDecisionAndNotesEvents: /decision/.test(preventBlankOverwrite.toString()) && /notes/.test(preventBlankOverwrite.toString()),
    stopsBeforeBubbleSave: /stopImmediatePropagation/.test(preventBlankOverwrite.toString())
  });
})();
