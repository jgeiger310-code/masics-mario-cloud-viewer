(() => {
  "use strict";

  const VERSION = "20260713-autosave-online-v4";
  let debounceTimer = 0;
  let saveInProgress = false;
  let navigationBypass = false;
  let lastQueuedAt = 0;

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function hasCurrentValue() {
    const decision = String($("decision")?.value || "");
    const notes = String($("notes")?.value || "").trim();
    return Boolean(decision || notes);
  }

  function setSaveStatus(message) {
    const el = $("save-status");
    if (el) el.textContent = message;
  }

  function updateVisibleCounts() {
    const list = $("queue-list");
    const summary = $("queue-counts");
    if (!list || !summary) return;
    const buttons = Array.from(list.querySelectorAll("button[data-review-id]"));
    const reviewed = buttons.filter((b) => b.classList.contains("reviewed")).length;
    const pending = buttons.filter((b) => b.classList.contains("pending") || b.classList.contains("needs-dropdown")).length;
    summary.textContent = `${buttons.length} shown | ${reviewed} reviewed | ${pending} pending`;
  }

  async function waitForSaveResult(previousText, timeoutMs = 30000) {
    const started = Date.now();
    let sawSaving = false;
    while (Date.now() - started < timeoutMs) {
      const text = String($("save-status")?.textContent || "");
      if (/Saving online|Autosaving online|Saving current record/i.test(text)) sawSaving = true;
      if (sawSaving && text !== previousText && (/Saved online:/i.test(text) || /SAVED ONLINE/i.test(text))) return true;
      if (/failed|offline|expired|permission|could not|not allow|not confirmed/i.test(text)) return false;
      await sleep(150);
    }
    return false;
  }

  async function saveNow(reason = "autosave") {
    if (saveInProgress) {
      const started = Date.now();
      while (saveInProgress && Date.now() - started < 30000) await sleep(100);
      return /Saved online:|SAVED ONLINE/i.test(String($("save-status")?.textContent || ""));
    }
    if (!hasCurrentValue()) return true;
    const button = $("save-online");
    if (!button) return false;
    saveInProgress = true;
    const previousText = String($("save-status")?.textContent || "");
    setSaveStatus(reason === "navigation" ? "Saving current record online before moving..." : "Autosaving online...");
    button.click();
    const ok = await waitForSaveResult(previousText);
    saveInProgress = false;
    if (!ok) setSaveStatus("SAVE NOT CONFIRMED. Stay on this record and press Save Online.");
    return ok;
  }

  function queueAutosave() {
    lastQueuedAt = Date.now();
    clearTimeout(debounceTimer);
    setSaveStatus("Waiting to autosave online...");
    debounceTimer = setTimeout(async () => {
      debounceTimer = 0;
      const queuedAt = lastQueuedAt;
      const ok = await saveNow("autosave");
      if (ok && queuedAt === lastQueuedAt) updateVisibleCounts();
    }, 900);
  }

  document.addEventListener("input", (event) => {
    if (event.target?.id === "notes") queueAutosave();
  });

  document.addEventListener("change", (event) => {
    if (event.target?.id === "decision") queueAutosave();
  });

  document.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("#next-record, #next-pending, #next-pending-top, #previous-record");
    if (!button || navigationBypass || !hasCurrentValue()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clearTimeout(debounceTimer);
    debounceTimer = 0;
    const ok = await saveNow("navigation");
    if (!ok) return;
    updateVisibleCounts();
    navigationBypass = true;
    try { button.click(); } finally { navigationBypass = false; }
  }, true);

  window.addEventListener("beforeunload", (event) => {
    if (!saveInProgress && !debounceTimer) return;
    event.preventDefault();
    event.returnValue = "A review may still be saving online.";
  });

  window.MASICS_AUTOSAVE_ONLINE_VERSION = VERSION;
})();
