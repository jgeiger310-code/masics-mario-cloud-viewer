(() => {
  "use strict";
  function wantsDateReview() {
    try {
      return sessionStorage.getItem("masics_auth_return_to") === "date-review" ||
        sessionStorage.getItem("masics_return_to_date_review") === "1";
    } catch {
      return false;
    }
  }
  function tokenReady() {
    try {
      return Boolean(sessionStorage.getItem("masics_access_token"));
    } catch {
      return false;
    }
  }
  function clearFlags() {
    try {
      sessionStorage.removeItem("masics_auth_return_to");
      sessionStorage.removeItem("masics_return_to_date_review");
    } catch {}
  }
  function returnToDateReview() {
    clearFlags();
    window.location.replace("date-review.html?auth=dropbox&v=20260720-4");
  }
  if (!wantsDateReview()) return;
  const status = document.getElementById("status-line");
  if (status) status.textContent = "Dropbox sign-in complete. Returning to the date-review file viewer…";
  if (tokenReady()) {
    returnToDateReview();
    return;
  }
  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    if (tokenReady()) {
      window.clearInterval(timer);
      returnToDateReview();
    } else if (tries > 80) {
      window.clearInterval(timer);
      if (status) status.textContent = "Dropbox sign-in did not finish. Try signing in again with browser privacy/ad-block extensions off for Dropbox.";
    }
  }, 250);
})();
