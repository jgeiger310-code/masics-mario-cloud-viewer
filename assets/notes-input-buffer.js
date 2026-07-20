(() => {
  "use strict";

  const VERSION = "20260720-notes-10s-idle-1";
  const SAVE_AFTER_IDLE_MS = 10000;
  let timer = 0;
  let pendingTarget = null;
  let composing = false;

  window.MASICS_NOTES_INPUT_BUFFER_VERSION = VERSION;

  function saveStatus(message) {
    const status = document.getElementById("save-status");
    if (status) status.textContent = message;
  }

  function clearTimer() {
    if (timer) window.clearTimeout(timer);
    timer = 0;
  }

  function commitPending() {
    clearTimer();
    const target = pendingTarget;
    pendingTarget = null;
    if (!target || !target.isConnected) return;

    const committed = new Event("input", { bubbles: true });
    Object.defineProperty(committed, "masicsBufferedCommit", {
      value: true,
      enumerable: false
    });
    target.dispatchEvent(committed);
  }

  function queueCommit(target) {
    pendingTarget = target;
    clearTimer();
    saveStatus("Typing notes... online save waits until you pause for 10 seconds.");
    timer = window.setTimeout(commitPending, SAVE_AFTER_IDLE_MS);
  }

  document.addEventListener("compositionstart", (event) => {
    if (event.target instanceof HTMLElement && event.target.id === "notes") composing = true;
  }, true);

  document.addEventListener("compositionend", (event) => {
    if (!(event.target instanceof HTMLElement) || event.target.id !== "notes") return;
    composing = false;
    queueCommit(event.target);
  }, true);

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.id !== "notes") return;
    if (event.masicsBufferedCommit === true) return;

    // The text is already present in the textarea. Stop the older listeners from
    // serializing progress and rescanning the entire queue for every character.
    event.stopImmediatePropagation();
    if (!composing) queueCommit(target);
  }, true);

  document.addEventListener("blur", (event) => {
    if (!(event.target instanceof HTMLElement) || event.target.id !== "notes") return;
    if (pendingTarget === event.target) commitPending();
  }, true);

  window.addEventListener("pagehide", commitPending);

  window.MASICS_NOTES_INPUT_BUFFER_SELF_TEST = () => ({
    version: VERSION,
    delayMs: SAVE_AFTER_IDLE_MS,
    buffersNotesOnly: true,
    flushesOnBlur: true,
    preservesExistingSavePipeline: true
  });
})();
