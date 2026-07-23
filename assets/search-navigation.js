(() => {
  "use strict";
  const button = document.getElementById("open-search");
  if (button) button.addEventListener("click", () => { window.location.href = "search.html"; });
})();
