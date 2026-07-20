(() => {
  "use strict";
  const button = document.getElementById("connect");
  if (!button) return;
  button.addEventListener("click", (event) => {
    try {
      if (sessionStorage.getItem("masics_access_token")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      sessionStorage.setItem("masics_auth_return_to", "date-review-ocr");
      sessionStorage.setItem("masics_return_to_date_review", "ocr");
      window.location.assign("./");
    } catch {}
  }, true);
})();
