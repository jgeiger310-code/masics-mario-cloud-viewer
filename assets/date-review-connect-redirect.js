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

    sessionStorage.setItem("masics_auth_return_to", "date-review");
    sessionStorage.setItem("masics_return_to_date_review", "1");
    if (status) status.textContent = "Opening the normal Dropbox sign-in page. After sign-in, return to the date review page.";
    window.location.assign("./");
  }, true);
})();
