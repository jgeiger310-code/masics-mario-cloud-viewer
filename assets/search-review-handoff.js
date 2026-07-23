(() => {
  "use strict";
  const reviewId = window.sessionStorage.getItem("masics_search_open_review_id");
  if (!reviewId) return;
  let attempts = 0;
  const select = () => {
    const safe = window.CSS && typeof window.CSS.escape === "function" ? window.CSS.escape(reviewId) : reviewId.replace(/["\\]/g, "\\$&");
    const button = document.querySelector(`button[data-review-id="${safe}"]`);
    if (button) {
      window.sessionStorage.removeItem("masics_search_open_review_id");
      button.click();
      button.scrollIntoView({ block: "center" });
      return;
    }
    attempts += 1;
    if (attempts < 300) window.setTimeout(select, 100);
  };
  select();
})();
