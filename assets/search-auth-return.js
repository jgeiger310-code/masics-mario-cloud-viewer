(() => {
  "use strict";
  if (window.sessionStorage.getItem("masics_auth_return_to") !== "search") return;
  let attempts = 0;
  const check = () => {
    if (window.sessionStorage.getItem("masics_access_token")) {
      window.sessionStorage.removeItem("masics_auth_return_to");
      window.location.replace("search.html");
      return;
    }
    attempts += 1;
    if (attempts < 300) window.setTimeout(check, 100);
  };
  check();
})();
