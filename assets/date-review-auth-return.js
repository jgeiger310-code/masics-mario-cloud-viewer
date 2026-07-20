(() => {
  "use strict";
  function getReturnTarget() {
    try {
      const target = sessionStorage.getItem("masics_auth_return_to") || "";
      if (target === "date-review-remaining") return "date-review-final-unresolved-v2.html?auth=dropbox&v=20260720-final-1";
      if (target === "date-review-ocr") return "date-review-ocr-unresolved.html?auth=dropbox&v=20260720-ocr-unresolved-1";
      if (target === "date-review") return "date-review.html?auth=dropbox&v=20260720-exact-1";
      const legacy = sessionStorage.getItem("masics_return_to_date_review");
      if (legacy === "remaining") return "date-review-final-unresolved-v2.html?auth=dropbox&v=20260720-final-1";
      if (legacy === "ocr") return "date-review-ocr-unresolved.html?auth=dropbox&v=20260720-ocr-unresolved-1";
      if (legacy === "1") return "date-review.html?auth=dropbox&v=20260720-exact-1";
    } catch {}
    return "";
  }
  function tokenReady() {
    try { return Boolean(sessionStorage.getItem("masics_access_token")); } catch { return false; }
  }
  function clearFlags() {
    try {
      sessionStorage.removeItem("masics_auth_return_to");
      sessionStorage.removeItem("masics_return_to_date_review");
    } catch {}
  }
  const target = getReturnTarget();
  if (!target) return;
  const status = document.getElementById("status-line");
  if (status) status.textContent = "Dropbox sign-in complete. Returning to the requested Mario review page…";
  function goBack() { clearFlags(); window.location.replace(target); }
  if (tokenReady()) { goBack(); return; }
  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    if (tokenReady()) { window.clearInterval(timer); goBack(); }
    else if (tries > 80) {
      window.clearInterval(timer);
      if (status) status.textContent = "Dropbox sign-in did not finish. Try signing in again with browser privacy/ad-block extensions off for Dropbox.";
    }
  }, 250);
})();
