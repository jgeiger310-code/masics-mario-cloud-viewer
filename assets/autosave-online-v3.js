(() => {
  "use strict";

  const VERSION = "20260712-autosave-online-v3";
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
    const excluded = 0;
    const pending = buttons.filter((b) => b.classList.contains("pending") || b.classList.contains("needs-dropdown")).length;
    const shown = buttons.length;
    summary.textContent = `${shown} shown | ${reviewed} reviewed | ${pending} pending | ${excluded} excluded`;
  }

  async function waitForSaveResult(timeoutMs = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const text = String($("save-status")?.textContent || "");
      if (/Saved online:/i.test(text) || /SAVED ONLINE/i.test(text)) return true;
      if (/failed|offline|expired|permission|could not|not allow/i.test(text)) return false;
      await sleep(150);
    }
    return false;
  }

  async function saveNow(reason = "autosave") {
    if (saveInProgress) {
      const started = Date.now();
      while (saveInProgress && Date.now() - started < 20000) await sleep(100);
      return /Saved online:|SAVED ONLINE/i.test(String($("save-status")?.textContent || ""));
    }
    if (!hasCurrentValue()) return true;
    const button = $("save-online");
    if (!button) return false;
    saveInProgress = true;
    setSaveStatus(reason === "navigation" ? "Saving current record online before moving..." : "Autosaving online...");
    button.click();
    const ok = await waitForSaveResult();
    saveInProgress = false;
    if (!ok) setSaveStatus("SAVE NOT CONFIRMED. Stay on this record and press Save Online.");
    return ok;
  }

  function queueAutosave() {
    lastQueuedAt = Date.now();
    clearTimeout(debounceTimer);
    setSaveStatus("Waiting to autosave online...");
    debounceTimer = setTimeout(async () => {
      const queuedAt = lastQueuedAt;
      const ok = await saveNow("autosave");
      if (ok && queuedAt === lastQueuedAt) updateVisibleCounts();
    }, 700);
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