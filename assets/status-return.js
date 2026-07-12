(() => {
  "use strict";
  const flag = "masics_return_to_status";
  if (window.localStorage.getItem(flag) !== "1") return;
  const started = Date.now();
  const timer = window.setInterval(() => {
    const token = window.sessionStorage.getItem("masics_access_token");
    if (token) {
      window.clearInterval(timer);
      window.localStorage.removeItem(flag);
      window.location.replace("status.html");
      return;
    }
    if (Date.now() - started > 30000) {
      window.clearInterval(timer);
      window.localStorage.removeItem(flag);
    }
  }, 100);
})();
