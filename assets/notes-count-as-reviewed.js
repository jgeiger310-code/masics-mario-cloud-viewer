(() => {
  "use strict";

  const VERSION = "20260713-notes-count-as-reviewed-1";
  let applying = false;

  function applyDefaultDecision() {
    if (applying) return;
    const notes = document.getElementById("notes");
    const decision = document.getElementById("decision");
    if (!notes || !decision) return;
    if (!String(notes.value || "").trim() || String(decision.value || "")) return;

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

  window.MASICS_NOTES_COUNT_AS_REVIEWED_VERSION = VERSION;
})();
