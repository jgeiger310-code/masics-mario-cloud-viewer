(() => {
  "use strict";

  const cfg = window.MASICS_DROPBOX_CONFIG;
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const TOKEN_KEY = "masics_access_token";
  const AUTO_EXPORT_KEY = "masics_auto_export_missing_xlsx";
  const EXPORT_QUERY = "export_missing";
  const VERSION = "20260715-missing-export-all-tags-1";

  if (!cfg) return;
  window.MASICS_MISSING_EXPORT_VERSION = VERSION;

  function uniqueLocators(values) {
    const seen = new Set();
    return values.flat().map((value) => String(value || "").trim()).filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function isLookupError(status, detail) {
    return status === 409 || /not_found|missing|moved|malformed_path|lookup/i.test(String(detail || ""));
  }

  async function dropboxDownload(locator) {
    const token = window.sessionStorage.getItem(TOKEN_KEY) || "";
    if (!token) throw new Error("Sign in with Dropbox before exporting.");
    const response = await fetch(DROPBOX_CONTENT + "files/download", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path: locator })
      }
    });
    if (response.status === 401) throw new Error("Dropbox authentication expired. Sign in again.");
    if (response.status === 403) throw new Error("Dropbox permission denied for the review files.");
    if (!response.ok) {
      let detail = "";
      try { detail = await response.text(); } catch {}
      const error = new Error(`Dropbox download failed: ${response.status}${detail ? ` (${detail.slice(0, 180)})` : ""}`);
      error.lookupFailure = isLookupError(response.status, detail);
      throw error;
    }
    return response;
  }

  async function downloadJsonFirst(locators) {
    let lastError = null;
    for (const locator of uniqueLocators(locators)) {
      try {
        const response = await dropboxDownload(locator);
        return await response.json();
      } catch (error) {
        lastError = error;
        if (!error.lookupFailure) throw error;
      }
    }
    throw lastError || new Error("The required Dropbox file could not be located.");
  }

  async function loadCurrentData() {
    const progressBase = String(cfg.progressDropboxFolder || "").replace(/\/+$/g, "");
    const alternateBases = (cfg.progressDropboxFolderAlternates || []).map((folder) => String(folder || "").replace(/\/+$/g, ""));
    const [manifest, progress] = await Promise.all([
      downloadJsonFirst([cfg.manifestDropboxPath, cfg.manifestDropboxPathAlternates || []]),
      downloadJsonFirst([
        cfg.progressDropboxLatestJsonId,
        progressBase ? `${progressBase}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json` : "",
        alternateBases.map((folder) => folder ? `${folder}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json` : "")
      ])
    ]);

    if (!manifest || manifest.queue_identity !== cfg.queueIdentity || !Array.isArray(manifest.records)) {
      throw new Error("The queue manifest does not match this viewer.");
    }
    if (!progress || progress.queueIdentity !== cfg.queueIdentity || typeof progress.decisions !== "object") {
      throw new Error("The current progress file does not match this viewer.");
    }
    return { manifest, progress };
  }

  function missingRows(manifest, progress) {
    return manifest.records.map((record) => {
      const saved = progress.decisions[record.review_id] || {};
      if (!isMissingDecision(saved.decision)) return null;
      return {
        "Queue #": Number(record.queue_number) || "",
        "File name": String(record.filename || ""),
        "File type": String(record.file_type || record.extension || "").replace(/^\./, "").toUpperCase(),
        "Mario's note / missing information": String(saved.notes || ""),
        "Date tagged": String(saved.updatedAt || ""),
        "Review ID": String(record.review_id || ""),
        "Dropbox path": String(record.dropbox_path || ""),
        "Decision": "Missing"
      };
    }).filter(Boolean).sort((a, b) => Number(a["Queue #"]) - Number(b["Queue #"]));
  }

  function isMissingDecision(decision) {
    return String(decision || "").trim().toLowerCase() === "missing";
  }

  function exportWorkbook(rows, progress) {
    if (!window.XLSX) throw new Error("The Excel export library did not load. Refresh and try again.");
    const worksheet = window.XLSX.utils.json_to_sheet(rows, {
      header: [
        "Queue #",
        "File name",
        "File type",
        "Mario's note / missing information",
        "Date tagged",
        "Review ID",
        "Dropbox path",
        "Decision"
      ]
    });
    worksheet["!cols"] = [
      { wch: 10 },
      { wch: 38 },
      { wch: 12 },
      { wch: 75 },
      { wch: 25 },
      { wch: 74 },
      { wch: 75 },
      { wch: 12 }
    ];
    if (rows.length) worksheet["!autofilter"] = { ref: `A1:H${rows.length + 1}` };

    const workbook = window.XLSX.utils.book_new();
    workbook.Props = {
      Title: "Mario Files Marked Missing",
      Subject: `All current Missing decisions from ${progress.reviewed || "the reviewed"} records`,
      Author: "MASICS Mario Review Viewer",
      CreatedDate: new Date()
    };
    window.XLSX.utils.book_append_sheet(workbook, worksheet, "Mario Missing Files");

    const date = new Date().toISOString().slice(0, 10);
    const filename = `Mario_All_Files_Marked_Missing_${date}_${rows.length}_records.xlsx`;
    window.XLSX.writeFile(workbook, filename, { compression: true });
    return filename;
  }

  function loadScriptOnce(src, globalName) {
    if (globalName && window[globalName]) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const existing = Array.from(document.scripts).find((script) => script.src === src);
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error(`Unable to load ${src}`)), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Unable to load ${src}`));
      document.head.appendChild(script);
    });
  }

  async function ensureXlsxLoaded() {
    if (window.XLSX) return;
    await loadScriptOnce(new URL("assets/vendor/xlsx.full.min.js?v=0.18.5", window.location.href).href, "XLSX");
  }

  function updateStatus(message) {
    const status = document.getElementById("status-line");
    if (status) status.textContent = message;
  }

  async function exportMissingXlsx() {
    const button = document.getElementById("export-missing-xlsx");
    if (button) button.disabled = true;
    updateStatus("Loading the full live review tracker and building the Missing-files spreadsheet...");
    try {
      await ensureXlsxLoaded();
      const { manifest, progress } = await loadCurrentData();
      const rows = missingRows(manifest, progress);
      const filename = exportWorkbook(rows, progress);
      updateStatus(`Downloaded ${filename}. It contains all ${rows.length} current records marked Missing out of ${progress.reviewed || 0} reviewed.`);
      window.localStorage.setItem("masics_last_missing_export", JSON.stringify({
        exportedAt: new Date().toISOString(),
        sourceProgressAt: String(progress.exportedAt || ""),
        reviewed: Number(progress.reviewed || 0),
        missing: rows.length,
        filename
      }));
    } finally {
      if (button) button.disabled = false;
    }
  }

  function requestExport() {
    const token = window.sessionStorage.getItem(TOKEN_KEY) || "";
    if (!token) {
      window.sessionStorage.setItem(AUTO_EXPORT_KEY, "1");
      const signIn = document.getElementById("sign-in");
      if (signIn) signIn.click();
      else updateStatus("Sign in with Dropbox, then use Download Missing Files XLSX.");
      return;
    }
    exportMissingXlsx().catch((error) => updateStatus(error.message || "Missing-files export failed."));
  }

  function wireExport() {
    const params = new URLSearchParams(window.location.search);
    if (params.get(EXPORT_QUERY) === "1") window.sessionStorage.setItem(AUTO_EXPORT_KEY, "1");

    const button = document.getElementById("export-missing-xlsx");
    if (button) button.addEventListener("click", requestExport);

    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const requested = window.sessionStorage.getItem(AUTO_EXPORT_KEY) === "1";
      const token = window.sessionStorage.getItem(TOKEN_KEY) || "";
      if (!requested) {
        window.clearInterval(timer);
        return;
      }
      if (token) {
        window.sessionStorage.removeItem(AUTO_EXPORT_KEY);
        window.clearInterval(timer);
        exportMissingXlsx().catch((error) => updateStatus(error.message || "Missing-files export failed."));
        return;
      }
      const callbackParams = new URLSearchParams(window.location.search);
      const callbackInProgress = callbackParams.has("code") || callbackParams.has("state");
      if (!callbackInProgress && attempts === 2) {
        const signIn = document.getElementById("sign-in");
        if (signIn && !signIn.hidden) signIn.click();
      }
      if (attempts > 240) {
        window.clearInterval(timer);
        updateStatus("Dropbox sign-in did not complete. Open the viewer and try Download Missing Files XLSX again.");
      }
    }, 500);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireExport, { once: true });
  else wireExport();

  window.MASICS_MISSING_EXPORT_SELF_TEST = () => ({
    version: VERSION,
    includesOnlyMissingRows: missingRows({
      records: [
        { queue_number: 2, filename: "b.pdf", review_id: "b", file_type: "pdf", dropbox_path: "/b.pdf" },
        { queue_number: 1, filename: "a.jpg", review_id: "a", file_type: "jpg", dropbox_path: "/a.jpg" },
        { queue_number: 3, filename: "c.png", review_id: "c", file_type: "png", dropbox_path: "/c.png" }
      ]
    }, {
      decisions: {
        a: { decision: " Missing ", notes: "case and whitespace", updatedAt: "2026-07-15T01:00:00Z" },
        b: { decision: "missing", notes: "plain", updatedAt: "2026-07-15T02:00:00Z" },
        c: { decision: "responsive", notes: "not missing", updatedAt: "2026-07-15T03:00:00Z" }
      }
    }).map((row) => row["Review ID"]).join(",") === "a,b",
    writesXlsx: /writeFile/.test(exportWorkbook.toString()),
    autoExportQuerySupported: EXPORT_QUERY === "export_missing"
  });
})();
