(() => {
  "use strict";

  function cfg() {
    return window.MASICS_DROPBOX_CONFIG || {};
  }

  function key(suffix) {
    const id = cfg().queueIdentity || "unknown_queue";
    return `masics_cloud_progress:${id}:${suffix}`;
  }

  function saveStatus() {
    return document.getElementById("save-status");
  }

  function hasUnsyncedLocalProgress() {
    const localAt = window.localStorage.getItem(key("last_save_at"));
    const onlineAt = window.localStorage.getItem(key("last_online_sync_at"));
    return Boolean(localAt && (!onlineAt || localAt > onlineAt));
  }

  function remind() {
    const el = saveStatus();
    if (!el || !hasUnsyncedLocalProgress()) return;
    el.textContent = "Saved on this device. Press Save Online to update online tracker.";
  }

  function remindSoon() {
    window.setTimeout(remind, 80);
  }

  document.addEventListener("change", (event) => {
    if (event.target && event.target.id === "decision") remindSoon();
  }, true);

  document.addEventListener("input", (event) => {
    if (event.target && event.target.id === "notes") remindSoon();
  }, true);

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("#queue-list") || target.id === "save-online") remindSoon();
  }, true);

  window.setInterval(remind, 5000);
})();
