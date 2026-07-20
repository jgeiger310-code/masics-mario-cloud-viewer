(() => {
  "use strict";

  const VERSION = "20260720-dropdown-single-commit-1";
  const DUPLICATE_EVENT_WINDOW_MS = 2500;
  let lastDecisionInput = null;

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

  function protectBlankOverwrite(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return false;
    if (target.id !== "decision" && target.id !== "notes") return false;
    const decision = document.getElementById("decision");
    if (!decision) return false;
    const reviewId = currentReviewId();
    const existingDecision = savedDecision(reviewId);
    if (!existingDecision || String(decision.value || "")) return false;
    decision.value = existingDecision;
    const status = document.getElementById("save-status");
    if (status) status.textContent = `Protected saved decision from blank overwrite: ${existingDecision}`;
    event.stopImmediatePropagation();
    return true;
  }

  function onInput(event) {
    if (protectBlankOverwrite(event)) return;
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.id !== "decision") return;
    lastDecisionInput = {
      target,
      reviewId: currentReviewId(),
      value: String(target.value || ""),
      at: Date.now()
    };
  }

  function onChange(event) {
    if (protectBlankOverwrite(event)) return;
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.id !== "decision") return;

    const prior = lastDecisionInput;
    lastDecisionInput = null;
    if (!prior) return;
    const samePhysicalControl = prior.target === target;
    const sameValue = prior.value === String(target.value || "");
    const stillCurrentRecord = prior.reviewId && prior.reviewId === currentReviewId();
    const recent = Date.now() - prior.at <= DUPLICATE_EVENT_WINDOW_MS;

    // A select normally emits input and then change for one user selection. The
    // input event already updates local state and queues the verified online save.
    // Letting change run the same handlers again can target a newly auto-selected
    // Missing row, which is the race that made decisions appear to revert.
    if (samePhysicalControl && sameValue && recent) {
      event.stopImmediatePropagation();
      if (!stillCurrentRecord) {
        const status = document.getElementById("save-status");
        if (status) status.textContent = "Dropdown change captured for the original record; duplicate save was blocked.";
      }
    }
  }

  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onChange, true);

  window.MASICS_DECISION_BLANK_GUARD_SELF_TEST = () => ({
    version: VERSION,
    guardInstalled: true,
    readsReviewIdFromMeta: /record-meta/.test(currentReviewId.toString()),
    protectsBlankDecision: /blank overwrite/i.test(protectBlankOverwrite.toString()),
    recordsDecisionInput: /lastDecisionInput/.test(onInput.toString()),
    blocksDuplicateSelectChange: /stopImmediatePropagation/.test(onChange.toString()),
    duplicateWindowMs: DUPLICATE_EVENT_WINDOW_MS
  });
})();
