(() => {
  "use strict";
  if (sessionStorage.getItem("masics_return_to_date_review") !== "1") return;

  const actions = document.querySelector(".auth-actions");
  if (!actions) return;

  const link = document.createElement("a");
  link.href = "date-review.html";
  link.textContent = "Continue to Date Review";
  link.className = "primary";
  link.style.display = "inline-block";
  link.style.padding = "8px 12px";
  link.style.borderRadius = "6px";
  link.style.textDecoration = "none";
  link.style.color = "white";
  link.style.background = "#245c94";
  link.addEventListener("click", () => sessionStorage.removeItem("masics_return_to_date_review"));
  actions.appendChild(link);
})();
