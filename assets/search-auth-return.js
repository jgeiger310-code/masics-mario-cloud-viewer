(() => {
  "use strict";
  /**
   * After Dropbox OAuth, the app lands on index.html (redirect_uri root).
   * If the user started from search, send them back to search.html with the token.
   *
   * REGRESSION NOTE (2026-07-23, same class as date-review/tracker):
   * - OAuth redirect_uri is always production github.io root.
   * - Production must include this script on index.html AND ship search.html.
   * - Signing in from localhost loses sessionStorage; PKCE + return_to must travel
   *   in the encoded OAuth state (auth-storage-fallback / search-data encode).
   */
  function readReturnTo() {
    try {
      return String(window.sessionStorage.getItem("masics_auth_return_to") || "");
    } catch {
      return "";
    }
  }

  function tokenReady() {
    try {
      return Boolean(window.sessionStorage.getItem("masics_access_token"));
    } catch {
      return false;
    }
  }

  function clearReturnFlag() {
    try {
      window.sessionStorage.removeItem("masics_auth_return_to");
    } catch {}
  }

  function goSearch() {
    clearReturnFlag();
    window.location.replace("search.html");
  }

  if (readReturnTo() !== "search") return;

  const status = document.getElementById("status-line");
  if (status) {
    status.textContent = "Dropbox sign-in complete. Returning to Evidence Search (not the review viewer)…";
  }

  if (tokenReady()) {
    goSearch();
    return;
  }

  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    if (tokenReady()) {
      window.clearInterval(timer);
      goSearch();
    } else if (tries > 80) {
      window.clearInterval(timer);
      if (status) {
        status.textContent =
          "Dropbox sign-in did not finish returning to Evidence Search. Open Search Files and try again with privacy/ad-block extensions off for Dropbox.";
      }
    }
  }, 250);
})();
