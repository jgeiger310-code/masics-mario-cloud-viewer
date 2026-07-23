(() => {
  "use strict";
  const A = window.MASICSSearchApp;
  const { E, S, core, store, PAGE, unique, download, tempLink } = A;
  const decisions = ["pending", "responsive", "nonresponsive", "missing", "privileged", "needs_review", "duplicate", "delete"];
  const labels = { pending: "Pending", responsive: "Responsive", nonresponsive: "Non-responsive", missing: "Missing", privileged: "Privileged", needs_review: "Needs review", duplicate: "Duplicate", delete: "Excluded" };
  const savedKey = `masics_saved_searches:${A.cfg.queueIdentity || "default"}`;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  function filters() {
    return {
      decisions: [...document.querySelectorAll("input[data-filter-decision]:checked")].map((input) => input.value),
      fileTypes: E.type.value ? [E.type.value] : [],
      hasOcr: E.ocr.checked ? true : null,
      hasTranscript: E.transcript.checked ? true : null,
      folder: E.folder.value.trim(),
      queueMin: E.qmin.value ? Number(E.qmin.value) : null,
      queueMax: E.qmax.value ? Number(E.qmax.value) : null
    };
  }
  function searchState() {
    return {
      query: E.query.value,
      matchMode: document.querySelector('input[name="match-mode"]:checked')?.value || "all",
      related: E.related.checked,
      fuzzy: E.fuzzy.checked,
      filters: filters(),
      sort: E.sort.value
    };
  }
  function runSearch() {
    if (!S.ready) return;
    const current = searchState();
    S.request += 1;
    S.worker.postMessage({
      type: "search", requestId: S.request, query: current.query,
      options: { matchMode: current.matchMode, related: current.related, fuzzy: current.fuzzy, filters: current.filters }
    });
    E.count.textContent = "Searching…";
  }
  function scheduleSearch() {
    clearTimeout(S.timer);
    S.timer = setTimeout(runSearch, 250);
  }
  function sortedResults() {
    const records = [...S.results];
    if (E.sort.value === "queue") records.sort((a, b) => a.queue_number - b.queue_number);
    else if (E.sort.value === "filename") records.sort((a, b) => (S.map.get(a.review_id)?.filename || "").localeCompare(S.map.get(b.review_id)?.filename || ""));
    else if (E.sort.value === "decision") records.sort((a, b) => (S.map.get(a.review_id)?.decision || "").localeCompare(S.map.get(b.review_id)?.decision || ""));
    return records;
  }
  function resultCard(result) {
    const record = S.map.get(result.review_id) || {};
    const item = document.createElement("li");
    const checked = S.selected.has(record.review_id);
    const decision = record.decision || "pending";
    item.className = "result-card";
    item.innerHTML = `<input class="result-select" type="checkbox" aria-label="Select ${escapeHtml(record.filename)}" ${checked ? "checked" : ""}>
      <div><div class="result-title-row"><h3 class="result-title"><span class="result-number">${escapeHtml(record.queue_number)}.</span>${escapeHtml(record.filename)}</h3>
      <div class="badges"><span class="badge ${escapeHtml(decision)}">${escapeHtml(labels[decision] || decision)}</span><span class="badge">${escapeHtml(record.file_type || "file")}</span>
      ${record.has_ocr_sidecar || record.ocr_text ? '<span class="badge">OCR</span>' : ""}${record.has_transcript_sidecar || record.transcript_text ? '<span class="badge">Transcript</span>' : ""}</div></div>
      <p class="result-path">${escapeHtml(record.dropbox_path || "")}</p>${record.ai_note ? `<p class="result-description">${escapeHtml(record.ai_note)}</p>` : ""}
      <p class="result-snippet"><strong>${escapeHtml((result.matched_field || "match").replace(/_/g, " "))}:</strong> ${escapeHtml(result.snippet || "")}</p>
      <div class="result-meta"><span class="match-label">Relevance ${escapeHtml(result.score)}</span><div class="card-actions"><button class="button ghost preview" type="button">Preview</button><button class="button ghost viewer" type="button">Open in viewer</button></div></div></div>`;
    item.querySelector(".result-select").addEventListener("change", (event) => {
      if (event.target.checked) S.selected.add(record.review_id); else S.selected.delete(record.review_id);
      updateButtons();
    });
    item.querySelector(".preview").addEventListener("click", () => preview(record));
    item.querySelector(".viewer").addEventListener("click", () => openViewer(record));
    return item;
  }
  function render() {
    const all = sortedResults();
    const pageCount = Math.max(1, Math.ceil(all.length / PAGE));
    S.page = Math.min(S.page, pageCount);
    const start = (S.page - 1) * PAGE;
    const current = all.slice(start, start + PAGE);
    E.list.innerHTML = "";
    if (!current.length) E.list.innerHTML = '<li class="empty-results">No records match this search. Try fewer terms, “Match any word,” or remove a filter.</li>';
    else current.forEach((result) => E.list.appendChild(resultCard(result)));
    E.count.textContent = `${all.length.toLocaleString()} result${all.length === 1 ? "" : "s"}${all.length ? ` · showing ${start + 1}-${Math.min(start + PAGE, all.length)}` : ""}`;
    E.expand.hidden = !S.expansions.length;
    E.expand.textContent = S.expansions.length ? `Also searched: ${S.expansions.slice(0, 8).join(", ")}` : "";
    E.pages.hidden = all.length <= PAGE;
    E.pageStatus.textContent = `Page ${S.page} of ${pageCount}`;
    E.prev.disabled = S.page <= 1; E.next.disabled = S.page >= pageCount;
    updateButtons();
  }
  function updateButtons() {
    E.exportAll.disabled = !S.results.length;
    E.exportSel.disabled = !S.selected.size;
  }
  function selectPage() {
    sortedResults().slice((S.page - 1) * PAGE, S.page * PAGE).forEach((result) => S.selected.add(result.review_id));
    render();
  }
  function scrubStarMarkers(value) {
    return String(value || "")
      .replace(/\*+/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }
  function exportRows(kind) {
    const picks = kind === "selected" ? S.results.filter((result) => S.selected.has(result.review_id)) : S.results;
    return picks.map((result) => {
      const record = S.map.get(result.review_id) || {};
      const isMissing = String(record.decision || "").toLowerCase() === "missing";
      const mario = isMissing ? scrubStarMarkers(record.mario_notes) : (record.mario_notes || "");
      const ai = isMissing ? scrubStarMarkers(record.ai_note) : (record.ai_note || "");
      const excerpt = isMissing ? scrubStarMarkers(result.snippet) : (result.snippet || "");
      return {
        queue_number: record.queue_number, review_id: record.review_id, filename: record.filename, file_type: record.file_type,
        decision: record.decision || "pending", dropbox_path: record.dropbox_path, mario_notes: mario,
        ai_note: ai, matched_field: result.matched_field, match_excerpt: excerpt,
        relevance_score: result.score, has_ocr: Boolean(record.has_ocr_sidecar || record.ocr_text),
        has_transcript: Boolean(record.has_transcript_sidecar || record.transcript_text)
      };
    });
  }
  function saveBlob(text, name, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportCsv(kind) {
    const rows = exportRows(kind);
    if (!rows.length) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    saveBlob(core.toCsv(rows), `MASICS_SEARCH_${kind.toUpperCase()}_${stamp}.csv`, "text/csv;charset=utf-8");
  }
  function locators(record) { return unique([record.dropbox_file_id, record.dropbox_path_alternates || [], record.dropbox_path]); }
  async function firstWorking(record, action) {
    let last;
    for (const locator of locators(record)) {
      try { return await action(locator); }
      catch (error) { last = error; if (!error.lookup) throw error; }
    }
    throw last || new Error("No Dropbox locator is available.");
  }
  function openViewer(record) {
    store.setItem("masics_search_open_review_id", record.review_id);
    location.href = "./";
  }
  function releasePreview() {
    if (S.objectUrl) URL.revokeObjectURL(S.objectUrl);
    S.objectUrl = "";
    E.previewBody.innerHTML = "";
  }
  function renderBlob(blob, record) {
    releasePreview();
    const ext = String(record.file_type || "").toLowerCase();
    S.objectUrl = URL.createObjectURL(blob);
    if (blob.type.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext)) {
      const image = document.createElement("img"); image.src = S.objectUrl; image.alt = record.filename; E.previewBody.appendChild(image);
    } else if (blob.type === "application/pdf" || ext === "pdf") {
      const frame = document.createElement("iframe"); frame.src = S.objectUrl; frame.title = record.filename; E.previewBody.appendChild(frame);
    } else if (blob.type.startsWith("text/") || ["txt", "csv", "json", "md", "log"].includes(ext)) {
      blob.text().then((text) => { const pre = document.createElement("pre"); pre.textContent = text.slice(0, 500000); E.previewBody.appendChild(pre); });
    }
  }
  async function preview(record) {
    releasePreview();
    E.previewPos.textContent = `QUEUE ${record.queue_number} · ${labels[record.decision || "pending"] || record.decision}`;
    E.previewTitle.textContent = record.filename;
    E.previewStatus.textContent = "Loading protected evidence from Dropbox…";
    E.previewReview.onclick = () => openViewer(record);
    E.previewDropbox.onclick = async () => {
      try { window.open(await firstWorking(record, tempLink), "_blank", "noopener"); }
      catch (error) { E.previewStatus.textContent = error.message; }
    };
    if (E.dialog.showModal) E.dialog.showModal(); else E.dialog.setAttribute("open", "");
    const ext = String(record.file_type || "").toLowerCase();
    try {
      if (["mp3", "wav", "m4a", "aac", "ogg", "amr", "mp4", "mov", "m4v", "webm"].includes(ext)) {
        const element = document.createElement(["mp3", "wav", "m4a", "aac", "ogg", "amr"].includes(ext) ? "audio" : "video");
        element.controls = true; element.preload = "metadata"; element.src = await firstWorking(record, tempLink); E.previewBody.appendChild(element);
        E.previewStatus.textContent = "Streaming the original evidence from Dropbox.";
      } else if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "pdf", "txt", "csv", "json", "md", "log"].includes(ext)) {
        let blob = await (await firstWorking(record, download)).blob();
        const types = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", pdf: "application/pdf", txt: "text/plain", csv: "text/csv", json: "application/json", md: "text/markdown", log: "text/plain" };
        if (!blob.type && types[ext]) blob = new Blob([blob], { type: types[ext] });
        renderBlob(blob, record);
        E.previewStatus.textContent = "Preview loaded. The original evidence was not changed.";
      } else {
        E.previewBody.innerHTML = "<p>This browser cannot directly render this file type. Use Open original or Open in Review Viewer.</p>";
        E.previewStatus.textContent = "The file is available, but direct preview is not supported.";
      }
    } catch (error) { E.previewStatus.textContent = error.message || "Unable to preview this evidence."; }
  }
  function closePreview() {
    releasePreview();
    if (E.dialog.close) E.dialog.close(); else E.dialog.removeAttribute("open");
  }
  function savedSearches() {
    try { const value = JSON.parse(localStorage.getItem(savedKey) || "[]"); return Array.isArray(value) ? value : []; }
    catch { return []; }
  }
  function refreshSaved(selected = "") {
    E.saved.innerHTML = '<option value="">Choose a saved search</option>';
    savedSearches().forEach((search) => {
      const option = document.createElement("option"); option.value = option.textContent = search.name; option.selected = search.name === selected; E.saved.appendChild(option);
    });
  }
  function saveSearch() {
    const name = prompt("Name this saved search:", E.query.value.trim() || "Filtered records");
    if (!name?.trim()) return;
    const all = savedSearches().filter((search) => search.name !== name.trim());
    all.push({ name: name.trim(), ...searchState() });
    all.sort((a, b) => a.name.localeCompare(b.name));
    localStorage.setItem(savedKey, JSON.stringify(all));
    refreshSaved(name.trim());
  }
  function applySearch(search) {
    E.query.value = search.query || "";
    const match = document.querySelector(`input[name="match-mode"][value="${search.matchMode === "any" ? "any" : "all"}"]`);
    if (match) match.checked = true;
    E.related.checked = search.related !== false; E.fuzzy.checked = search.fuzzy !== false;
    document.querySelectorAll("input[data-filter-decision]").forEach((input) => { input.checked = Boolean(search.filters?.decisions?.includes(input.value)); });
    E.type.value = search.filters?.fileTypes?.[0] || ""; E.ocr.checked = search.filters?.hasOcr === true; E.transcript.checked = search.filters?.hasTranscript === true;
    E.folder.value = search.filters?.folder || ""; E.qmin.value = search.filters?.queueMin || ""; E.qmax.value = search.filters?.queueMax || ""; E.sort.value = search.sort || "relevance";
    runSearch();
  }
  function clearSearch() {
    E.query.value = ""; document.querySelector('input[name="match-mode"][value="all"]').checked = true; E.related.checked = E.fuzzy.checked = true;
    document.querySelectorAll("input[data-filter-decision]").forEach((input) => { input.checked = false; });
    E.ocr.checked = E.transcript.checked = false; E.type.value = E.folder.value = E.qmin.value = E.qmax.value = E.saved.value = ""; E.sort.value = "relevance";
    runSearch();
  }
  function populateFilters() {
    E.decisions.innerHTML = "";
    decisions.forEach((decision) => { const label = document.createElement("label"); label.innerHTML = `<input type="checkbox" data-filter-decision value="${decision}"> ${labels[decision]}`; E.decisions.appendChild(label); });
    const types = [...new Set(S.records.map((record) => String(record.file_type || record.extension || "").replace(/^\./, "").toLowerCase()).filter(Boolean))].sort();
    E.type.innerHTML = '<option value="">All file types</option>';
    types.forEach((type) => { const option = document.createElement("option"); option.value = option.textContent = type; E.type.appendChild(option); });
  }
  Object.assign(A, { runSearch, scheduleSearch, render, selectPage, exportCsv, preview, openViewer, closePreview, refreshSaved, saveSearch, applySearch, clearSearch, populateFilters, savedSearches });
})();
