(() => {
  "use strict";
  const btn = document.getElementById("connect");
  if (!btn) return;
  const original = btn.onclick;
  btn.onclick = function(ev) {
    try {
      if (!sessionStorage.getItem("masics_access_token")) {
        sessionStorage.setItem("masics_auth_return_to", "date-review-remaining");
        sessionStorage.setItem("masics_return_to_date_review", "remaining");
        location.assign("./");
        return;
      }
    } catch {}
    if (typeof original === "function") return original.call(this, ev);
  };
})();
