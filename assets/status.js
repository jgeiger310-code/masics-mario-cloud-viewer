(() => {
  "use strict";

  const DROPBOX_AUTH = "https://www.dropbox.com/oauth2/authorize";
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const cfg = window.MASICS_DROPBOX_CONFIG;
  const $ = (id) => document.getElementById(id);
  const authStore = window.sessionStorage;
  const tokenKey = "masics_access_token";
  let refreshTimer = 0;

  function setMessage(message) { $("status-message").textContent = message; }
  function token() { return authStore.getItem(tokenKey) || ""; }
  function randomBase64Url(bytes = 32) {
    const data = new Uint8Array(bytes);
    crypto.getRandomValues(data);
    return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  async function sha256Base64Url(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  function formatTime(value) {
    try { return new Date(value).toLocaleString(); } catch { return String(value || ""); }
  }
  function setAuthButtons() {
    const signedIn = Boolean(token());
    $("sign-in").hidden = signedIn;
    $("sign-out").hidden = !signedIn;
  }
  async function beginSignIn() {
    const state = randomBase64Url(24);
    const verifier = randomBase64Url(64);
    const challenge = await sha256Base64Url(verifier);
    authStore.setItem("masics_oauth_state", state);
    authStore.setItem("masics_pkce_verifier", verifier);
    window.localStorage.setItem("masics_return_to_status", "1");
    const params = new URLSearchParams({
      client_id: cfg.appKey,
      response_type: "code",
      redirect_uri: cfg.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      token_access_type: "online",
      scope: cfg.scopes.join(" ")
    });
    window.location.href = `${DROPBOX_AUTH}?${params.toString()}`;
  }
  async function loadStatus() {
    window.clearTimeout(refreshTimer);
    setAuthButtons();
    if (!token()) {
      $("counts").hidden = true;
      $("progress-section").hidden = true;
      setMessage("Sign in to read the current shared Dropbox tracker. This page never writes review data.");
      return;
    }
    $("refresh").disabled = true;
    setMessage("Loading the newest saved totals from Dropbox…");
    try {
      const response = await fetch(DROPBOX_CONTENT + "files/download", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token()}`,
          "Dropbox-API-Arg": JSON.stringify({ path: cfg.progressDropboxLatestJsonId })
        },
        cache: "no-store"
      });
      if (response.status === 401) {
        authStore.removeItem(tokenKey);
        throw new Error("Dropbox sign-in expired. Sign in again.");
      }
      if (!response.ok) throw new Error(`Dropbox tracker read failed: ${response.status}`);
      const data = await response.json();
      const total = Number(data.total || 0);
      const reviewed = Number(data.reviewed || 0);
      const excluded = Number(data.excluded || 0);
      const pending = Number(data.pending ?? Math.max(0, total - reviewed - excluded));
      const denominator = Math.max(1, total - excluded);
      const percent = Math.max(0, Math.min(100, (reviewed / denominator) * 100));
      $("total").textContent = total.toLocaleString();
      $("reviewed").textContent = reviewed.toLocaleString();
      $("excluded").textContent = excluded.toLocaleString();
      $("pending").textContent = pending.toLocaleString();
      $("percent").textContent = `${percent.toFixed(1)}%`;
      $("progress-bar").style.width = `${percent}%`;
      $("last-updated").textContent = `Last saved online: ${formatTime(data.exportedAt)}`;
      $("counts").hidden = false;
      $("progress-section").hidden = false;
      setMessage("Current shared tracker totals");
      refreshTimer = window.setTimeout(loadStatus, 60000);
    } catch (err) {
      setMessage(err.message || "Unable to read the tracker.");
      setAuthButtons();
    } finally {
      $("refresh").disabled = false;
    }
  }

  $("refresh").addEventListener("click", loadStatus);
  $("sign-in").addEventListener("click", beginSignIn);
  $("sign-out").addEventListener("click", () => {
    authStore.removeItem(tokenKey);
    loadStatus();
  });
  loadStatus();
})();
