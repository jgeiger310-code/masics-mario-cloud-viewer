(() => {
  "use strict";
  const button = document.getElementById("connect");
  if (!button) return;

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    sessionStorage.setItem("masics_return_to_date_review", "1");
    const status = document.getElementById("connection");
    if (status) status.textContent = "Opening the normal Dropbox sign-in page…";
    window.location.assign("./");
  }, true);
})();
