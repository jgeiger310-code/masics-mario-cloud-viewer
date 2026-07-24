(() => {
  "use strict";
  const A = window.MASICSSearchApp;
  const { E, S, status, loading } = A;
  function wireEvents() {
    E.signIn.addEventListener("click", () => A.signIn().catch((error) => status(error.message || "Dropbox sign-in failed.")));
    E.signOut.addEventListener("click", A.signOut);
    E.go.addEventListener("click", A.runSearch);
    E.query.addEventListener("input", A.scheduleSearch);
    E.query.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); A.runSearch(); } });
    document.querySelectorAll('input[name="match-mode"],#related-terms,#fuzzy-search,#has-ocr,#has-transcript').forEach((input) => input.addEventListener("change", A.runSearch));
    E.decisions.addEventListener("change", A.runSearch);
    if (E.categories) E.categories.addEventListener("change", A.runSearch);
    E.type.addEventListener("change", A.runSearch);
    [E.folder, E.qmin, E.qmax].forEach((input) => input.addEventListener("input", A.scheduleSearch));
    E.sort.addEventListener("change", A.render);
    E.select.addEventListener("click", A.selectPage);
    E.exportSel.addEventListener("click", () => A.exportCsv("selected"));
    E.exportAll.addEventListener("click", () => A.exportCsv("results"));
    E.prev.addEventListener("click", () => { if (S.page > 1) { S.page -= 1; A.render(); } });
    E.next.addEventListener("click", () => { if (S.page < Math.ceil(S.results.length / A.PAGE)) { S.page += 1; A.render(); } });
    E.save.addEventListener("click", A.saveSearch);
    E.clear.addEventListener("click", A.clearSearch);
    E.saved.addEventListener("change", () => { const search = A.savedSearches().find((item) => item.name === E.saved.value); if (search) A.applySearch(search); });
    E.close.addEventListener("click", A.closePreview);
    E.dialog.addEventListener("cancel", (event) => { event.preventDefault(); A.closePreview(); });
  }
  async function init() {
    wireEvents();
    A.refreshSaved();
    if (!S.token) { E.signIn.hidden = false; E.signOut.hidden = true; return; }
    E.signIn.hidden = true; E.signOut.hidden = false;
    try {
      status("Dropbox connected. Loading the protected database and current review status…");
      S.records = await A.loadData();
      S.map = new Map(S.records.map((record) => [record.review_id, record]));
      A.populateFilters();
      const full = S.mode === "full";
      E.badge.textContent = full ? "Full OCR + transcript index" : "Metadata index only";
      E.badge.className = `catalog-badge ${full ? "full" : "fallback"}`;
      if (!full) status("Search is ready for filenames, paths, notes, descriptions, and tags. Build the full catalog to add OCR and transcript text.");
      A.createWorker();
    } catch (error) {
      if (/expired|401/i.test(error.message)) A.signOut();
      status(error.message || "Unable to load the database.");
      loading("Nothing was changed. The protected search database could not be loaded.");
    }
  }
  init();
})();
