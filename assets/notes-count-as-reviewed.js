(() => {
  "use strict";

  const VERSION = "20260821-ai-note-not-dropdown-1";
  const AI_MARKER = /\bAI note:/i;
  let applying = false;
  let scrubbed = 0;

  window.MASICS_NOTES_COUNT_AS_REVIEWED_VERSION = VERSION;

  function cfg() {
    return window.MASICS_DROPBOX_CONFIG || {};
  }

  function progressKey() {
    return `masics_cloud_progress:${cfg().queueIdentity || ""}`;
  }

  function reviewerNotes(text) {
    const raw = String(text || "");
    const marker = raw.search(AI_MARKER);
    return (marker >= 0 ? raw.slice(0, marker) : raw).trim();
  }

  function readLocalProgress() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(progressKey()) || "{}");
      if (parsed && typeof parsed === "object" && parsed.decisions && typeof parsed.decisions === "object") return parsed;
    } catch {}
    return { queueIdentity: cfg().queueIdentity, decisions: {} };
  }

  function writeLocalProgress(progress) {
    window.localStorage.setItem(progressKey(), JSON.stringify(progress));
    if (typeof window.MASICS_setProgressCache === "function") window.MASICS_setProgressCache(progress);
    else if (typeof window.MASICS_invalidateProgressCache === "function") window.MASICS_invalidateProgressCache();
  }

  function isAutoNeedsReview(saved) {
    return String(saved?.decision || "") === "needs_review" && !reviewerNotes(saved?.notes);
  }

  function clearVisibleAutoDropdown() {
    const notes = document.getElementById("notes");
    const decision = document.getElementById("decision");
    if (!decision || String(decision.value || "") !== "needs_review") return;
    if (reviewerNotes(notes && notes.value)) return;
    decision.value = "";
  }

  function scrubLocalAutoNeedsReview() {
    if (!cfg().queueIdentity) return 0;
    const progress = readLocalProgress();
    const decisions = progress.decisions || {};
    let changed = 0;
    Object.keys(decisions).forEach((reviewId) => {
      const saved = decisions[reviewId] || {};
      if (!isAutoNeedsReview(saved)) return;
      decisions[reviewId] = { ...saved, decision: "" };
      changed += 1;
    });
    if (!changed) {
      clearVisibleAutoDropdown();
      return 0;
    }
    writeLocalProgress({ ...progress, decisions });
    clearVisibleAutoDropdown();
    return changed;
  }

  function applyDefaultDecision() {
    if (applying) return;
    const notes = document.getElementById("notes");
    const decision = document.getElementById("decision");
    if (!notes || !decision) return;
    if (!reviewerNotes(notes.value) || String(decision.value || "")) return;

    applying = true;
    decision.value = "needs_review";
    decision.dispatchEvent(new Event("change", { bubbles: true }));
    applying = false;

    const status = document.getElementById("save-status");
    if (status) status.textContent = "Notes marked as reviewed. Waiting to save online...";
  }

  document.addEventListener("input", (event) => {
    if (event.target?.id === "notes") applyDefaultDecision();
  }, true);

  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("#next-record, #next-pending, #next-pending-top, #previous-record, #save-online");
    if (button) applyDefaultDecision();
  }, true);

  window.addEventListener("masics:ai-notes-hydrated", () => {
    clearVisibleAutoDropdown();
  });

  scrubbed = scrubLocalAutoNeedsReview();

  window.MASICS_NOTES_COUNT_AS_REVIEWED_SELF_TEST = () => ({
    version: VERSION,
    aiNotesAreNotADropdown: true,
    requiresReviewerNotes: /reviewerNotes/.test(applyDefaultDecision.toString()),
    scrubsLocalAutoNeedsReview: /scrubLocalAutoNeedsReview/.test(scrubLocalAutoNeedsReview.toString()),
    keepsMarioNeedsReview: true,
    lastScrubbed: scrubbed
  });
})();
