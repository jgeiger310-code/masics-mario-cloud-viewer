(() => {
  "use strict";
  const button = document.getElementById("connect");
  const status = document.getElementById("connection");
  if (!button) return;

  const APP_KEY = "1p4bbydzkh0wblg";
  const REDIRECT_URI = "https://jgeiger310-code.github.io/masics-mario-cloud-viewer/";
  const DROPBOX_AUTH = "https://www.dropbox.com/oauth2/authorize";

  function setStatus(message) {
    if (status) status.textContent = message;
  }

  function randomBase64Url(bytes = 32) {
    const data = new Uint8Array(bytes);
    crypto.getRandomValues(data);
    return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function sha256Base64Url(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function startDropboxSignIn() {
    const state = randomBase64Url(24);
    const verifier = randomBase64Url(64);
    const challenge = await sha256Base64Url(verifier);
    sessionStorage.setItem("masics_oauth_state", state);
    sessionStorage.setItem("masics_pkce_verifier", verifier);
    sessionStorage.setItem("masics_auth_return_to", "date-review");
    sessionStorage.setItem("masics_return_to_date_review", "1");
    const params = new URLSearchParams({
      client_id: APP_KEY,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      token_access_type: "online",
      scope: "files.metadata.read files.content.read files.content.write"
    });
    window.location.href = `${DROPBOX_AUTH}?${params.toString()}`;
  }

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (sessionStorage.getItem("masics_access_token")) {
      setStatus("Dropbox sign-in found. Loading the source files…");
      if (typeof window.loadSourceData === "function") window.loadSourceData(true);
      else window.location.reload();
      return;
    }
    setStatus("Opening Dropbox sign-in…");
    startDropboxSignIn().catch((err) => {
      setStatus(err && err.message ? err.message : "Dropbox sign-in could not start.");
    });
  }, true);
})();
