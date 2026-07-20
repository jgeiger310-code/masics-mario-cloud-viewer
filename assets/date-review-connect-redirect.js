(() => {
  "use strict";
  const button = document.getElementById("connect");
  if (!button) return;

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();

    const status = document.getElementById("connection");
    if (sessionStorage.getItem("masics_access_token")) {
      if (status) status.textContent = "Dropbox sign-in found. Loading the source files…";
      window.location.reload();
      return;
    }

    sessionStorage.setItem("masics_return_to_date_review", "1");
    const loginWindow = window.open("./", "masicsDropboxSignIn");
    if (!loginWindow) {
      if (status) status.textContent = "The browser blocked the Dropbox sign-in tab. Allow pop-ups for this site, then press Connect Dropbox again.";
      return;
    }

    if (status) status.textContent = "The normal Mario viewer opened in another tab. Sign in with Dropbox there, return to this tab, then press Connect Dropbox again.";
  }, true);
})();
