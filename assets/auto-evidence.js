(() => {
  "use strict";

  let lastRequestedTitle = "";
  let pendingTimer = 0;

  function currentTitle() {
    return (document.getElementById("record-title")?.textContent || "").trim();
  }

  function evidenceStatus() {
    return (document.getElementById("evidence-status")?.textContent || "").trim();
  }

  function scheduleEvidenceLoad() {
    const title = currentTitle();
    const view = document.getElementById("record-view");
    const button = document.getElementById("load-evidence");
    if (!title || !view || view.hidden || !button || button.disabled) return;

    const status = evidenceStatus();
    const shouldLoad = title !== lastRequestedTitle || /not loaded|not requested|missing|unable|failed/i.test(status);
    if (!shouldLoad || /Checking Dropbox|Loading evidence/i.test(status)) return;

    lastRequestedTitle = title;
    window.clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(() => {
      const freshTitle = currentTitle();
      const freshStatus = evidenceStatus();
      if (freshTitle === title && !/Checking Dropbox|Loading evidence|loaded from Dropbox/i.test(freshStatus)) {
        button.click();
      }
    }, 250);
  }

  document.addEventListener("click", () => window.setTimeout(scheduleEvidenceLoad, 50), true);
  document.addEventListener("change", () => window.setTimeout(scheduleEvidenceLoad, 50), true);

  const observer = new MutationObserver(scheduleEvidenceLoad);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  scheduleEvidenceLoad();
})();
