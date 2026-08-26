(() => {
  "use strict";

  const cfg = window.MASICS_DROPBOX_CONFIG;
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const TOKEN_KEY = "masics_access_token";
  const AUTO_EXPORT_KEY = "masics_auto_export_missing_docx";
  const EXPORT_QUERY = "export_missing_docx";
  const DOCX_URL = "https://cdn.jsdelivr.net/npm/docx@9.5.1/dist/index.umd.cjs";
  const VERSION = "20260826-legal-missing-docx-1";

  if (!cfg) return;
  window.MASICS_MISSING_DOCX_EXPORT_VERSION = VERSION;

  function unique(values) {
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
    for (const locator of unique(locators)) {
      try {
        return await (await dropboxDownload(locator)).json();
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
    if (!manifest || manifest.queue_identity !== cfg.queueIdentity || !Array.isArray(manifest.records)) throw new Error("The queue manifest does not match this viewer.");
    if (!progress || progress.queueIdentity !== cfg.queueIdentity || typeof progress.decisions !== "object") throw new Error("The current progress file does not match this viewer.");
    return { manifest, progress };
  }

  function splitNotes(notes) {
    const text = String(notes || "").trim();
    const marker = text.search(/\bAI note:/i);
    if (marker < 0) return { marioNote: text, aiDescription: "" };
    return {
      marioNote: text.slice(0, marker).trim(),
      aiDescription: text.slice(marker).replace(/^AI note:\s*/i, "").trim()
    };
  }

  function batesFromText(value) {
    const text = String(value || "");
    const match = text.match(/\bBATES:\s*([^|\n\r]+)/i) || text.match(/\bBates\s+([A-Z]{2,}[0-9][A-Z0-9]*(?:\s*[-–]\s*[A-Z]{2,}[0-9][A-Z0-9]*)?)/);
    return match ? match[1].trim() : "";
  }

  function derivedCategory(record, display) {
    const outcome = String(display.missing_discovery_outcomes || "").toUpperCase();
    const requestIds = String(display.mfr_request_ids || "").trim();
    const requestTitles = String(display.mfr_request_titles || "").trim();
    const matchReason = String(display.match_reason || "").trim();
    const sourceRoot = String(display.source_root_name || record.source_root_folder || record.source_root_name || "").trim();
    const fileType = String(record.file_type || record.extension || "").toLowerCase();
    if (requestIds || /\bMFR\b/i.test(matchReason) || /\bMFR\b/i.test(requestTitles)) return "Discovery request / MFR evidence";
    if (outcome.includes("DEFENSE_PRODUCTION")) return "Defense production evidence";
    if (outcome.includes("PLAINTIFF_EVIDENCE")) return "Plaintiff evidence / missing discovery support";
    if (/franklinville/i.test(sourceRoot)) return "Franklinville municipal record";
    if (/jpe?g|png|heic|tiff|image/.test(fileType)) return "Image / screenshot evidence";
    if (/pdf/.test(fileType)) return "PDF document evidence";
    if (/mp3|amr|wav|m4a|aac|ogg/.test(fileType)) return "Audio evidence";
    if (/mp4|mov|m4v|webm/.test(fileType)) return "Video evidence";
    return "Uncategorized / needs legal review";
  }

  function legalMetadata(record, saved) {
    const display = record.display || {};
    const notes = splitNotes(saved.notes || "");
    const priorityTier = String(display.priority_tier || "").trim();
    const descriptivePriorityCategory = /^[A-Z]$|^\d+$/i.test(priorityTier) || /_|APPEND|BUCKET|UNRANKED|STAGED/i.test(priorityTier) ? "" : priorityTier;
    return {
      queue: Number(record.queue_number) || 0,
      viewerBates: String(display.viewer_bates || display.control_bates || (record.queue_number ? `MASICS-${String(record.queue_number).padStart(5, "0")}` : "")).trim(),
      sourceBates: String(display.bates_range || display.bates_begin || batesFromText(saved.notes) || "").trim(),
      category: String(display.category || display.legal_category || descriptivePriorityCategory || derivedCategory(record, display) || "").trim() || "Uncategorized / needs legal review",
      filename: String(record.filename || ""),
      fileType: String(record.file_type || record.extension || "").replace(/^\./, "").toUpperCase(),
      marioNote: notes.marioNote,
      aiDescription: notes.aiDescription || String(display.ai_note || record.ai_note || "").trim(),
      reviewId: String(record.review_id || ""),
      dropboxPath: String(record.dropbox_path || ""),
      updatedAt: String(saved.updatedAt || ""),
      sourceRequest: String(display.mfr_request_titles || "").trim(),
      sourceRequestIds: String(display.mfr_request_ids || "").trim()
    };
  }

  function rowsForDecision(manifest, progress, decision) {
    const wanted = String(decision).toLowerCase();
    return manifest.records.map((record) => {
      const saved = progress.decisions[record.review_id] || {};
      if (String(saved.decision || "").trim().toLowerCase() !== wanted) return null;
      return legalMetadata(record, saved);
    }).filter(Boolean).sort((a, b) => a.queue - b.queue);
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

  async function ensureDocxLoaded() {
    if (window.docx && window.docx.Document) return;
    await loadScriptOnce(DOCX_URL, "docx");
    if (!window.docx || !window.docx.Document) throw new Error("The Word export library did not load.");
  }

  function safeText(value) {
    return String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  }

  function makeItemParagraphs(d, item, index) {
    const { Paragraph, TextRun } = d;
    const children = [
      new Paragraph({
        spacing: { before: 120, after: 40 },
        children: [
          new TextRun({ text: `${index}. ${safeText(item.viewerBates)} — ${safeText(item.filename)}`, bold: true, size: 21 })
        ]
      })
    ];
    const fields = [
      ["Queue", item.queue],
      ["File type", item.fileType],
      ["Source Bates / range", item.sourceBates],
      ["Mario's missing-information note", item.marioNote],
      ["Neutral description", item.aiDescription],
      ["Related request / MFR", [item.sourceRequestIds, item.sourceRequest].filter(Boolean).join(" — ")],
      ["Review ID", item.reviewId],
      ["Evidence path", item.dropboxPath]
    ];
    fields.forEach(([label, value]) => {
      if (!value) return;
      children.push(new Paragraph({
        indent: { left: 360 },
        spacing: { after: 25 },
        children: [new TextRun({ text: `${label}: `, bold: true, size: 18 }), new TextRun({ text: safeText(value), size: 18 })]
      }));
    });
    return children;
  }

  function groupedRows(rows) {
    const map = new Map();
    rows.forEach((row) => {
      const category = row.category || "Uncategorized / needs legal review";
      if (!map.has(category)) map.set(category, []);
      map.get(category).push(row);
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  async function exportLegalDocx(manifest, progress) {
    await ensureDocxLoaded();
    const d = window.docx;
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Footer, PageNumber } = d;
    const missing = rowsForDecision(manifest, progress, "missing");
    const needsReview = rowsForDecision(manifest, progress, "needs_review");
    const excluded = Number(progress.excluded || 0);
    const total = Number(progress.total || manifest.records.length || 0);
    const reviewed = Number(progress.reviewed || 0);

    const body = [];
    body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 180 }, children: [new TextRun({ text: "MASICS / MARIO REVIEW", bold: true, size: 30 })] }));
    body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 220 }, children: [new TextRun({ text: "SCHEDULE OF MATERIALS IDENTIFIED AS MISSING OR UNPRODUCED", bold: true, size: 28 })] }));
    body.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: `Generated from the live review tracker ${new Date().toISOString().slice(0, 10)}`, italics: true, size: 18 })] }));
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Review Status and Scope" }));
    body.push(new Paragraph({ text: `Live queue: ${total.toLocaleString()} records. Reviewed/retained: ${reviewed.toLocaleString()}. Excluded: ${excluded.toLocaleString()}. Pending: ${Number(progress.pending || 0).toLocaleString()}. Records explicitly designated Missing: ${missing.length.toLocaleString()}. Records designated Needs Further Review: ${needsReview.length.toLocaleString()}.` }));
    body.push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: "Important qualification: ", bold: true }), new TextRun("This schedule reports reviewer designations and database metadata. It is not, by itself, a judicial finding that a party violated a discovery obligation or that a listed item was required to be produced. Counsel should tie each item to the governing demand, order, disclosure obligation, or representation before filing or using the schedule in court.")] }));
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Schedule A — Items Marked Missing" }));
    let itemIndex = 1;
    groupedRows(missing).forEach(([category, rows]) => {
      body.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: `${category} (${rows.length})` }));
      rows.forEach((row) => {
        body.push(...makeItemParagraphs(d, row, itemIndex));
        itemIndex += 1;
      });
    });

    body.push(new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_1, text: "Schedule B — Needs Further Review / Visibility Exceptions" }));
    body.push(new Paragraph({ spacing: { after: 120 }, text: "These records are not blank or pending; Mario affirmatively marked them Needs Further Review. They should remain on a legal-review exception list rather than being represented as substantively resolved." }));
    let exceptionIndex = 1;
    groupedRows(needsReview).forEach(([category, rows]) => {
      body.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: `${category} (${rows.length})` }));
      rows.forEach((row) => {
        body.push(...makeItemParagraphs(d, row, exceptionIndex));
        exceptionIndex += 1;
      });
    });

    const document = new Document({
      creator: "MASICS Mario Review Viewer",
      title: "MASICS Mario Missing / Unproduced Materials Schedule",
      description: "Live legal-review schedule generated from the MASICS Mario review manifest and progress tracker.",
      styles: {
        default: { document: { run: { font: "Arial", size: 20 }, paragraph: { spacing: { line: 276 } } } },
        paragraphStyles: [
          { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { bold: true, size: 26, font: "Arial" }, paragraph: { spacing: { before: 220, after: 100 }, outlineLevel: 0 } },
          { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { bold: true, size: 22, font: "Arial" }, paragraph: { spacing: { before: 160, after: 70 }, outlineLevel: 1 } }
        ]
      },
      sections: [{
        properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "MASICS Missing Materials Schedule  |  Page ", size: 16 }), PageNumber.CURRENT, new TextRun({ text: " of ", size: 16 }), PageNumber.TOTAL_PAGES] })] }) },
        children: body
      }]
    });

    const blob = await Packer.toBlob(document);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    const filename = `MASICS_Mario_Missing_Legal_Schedule_${date}_${missing.length}_missing_${needsReview.length}_needs_review.docx`;
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return { filename, missing: missing.length, needsReview: needsReview.length };
  }

  function updateStatus(message) {
    const status = document.getElementById("status-line");
    if (status) status.textContent = message;
  }

  async function exportNow() {
    const button = document.getElementById("export-missing-docx");
    if (button) button.disabled = true;
    updateStatus("Loading the live review data and building the legal Missing-materials Word schedule...");
    try {
      const { manifest, progress } = await loadCurrentData();
      const result = await exportLegalDocx(manifest, progress);
      updateStatus(`Downloaded ${result.filename}. It includes all ${result.missing} Missing records plus ${result.needsReview} Needs Further Review exceptions.`);
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
      else updateStatus("Sign in with Dropbox, then use Download Legal Missing Schedule DOCX.");
      return;
    }
    exportNow().catch((error) => updateStatus(error.message || "Word legal schedule export failed."));
  }

  function wire() {
    const params = new URLSearchParams(window.location.search);
    if (params.get(EXPORT_QUERY) === "1") window.sessionStorage.setItem(AUTO_EXPORT_KEY, "1");
    const button = document.getElementById("export-missing-docx");
    if (button) button.addEventListener("click", requestExport);

    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (window.sessionStorage.getItem(AUTO_EXPORT_KEY) !== "1") {
        window.clearInterval(timer);
        return;
      }
      const token = window.sessionStorage.getItem(TOKEN_KEY) || "";
      if (token) {
        window.sessionStorage.removeItem(AUTO_EXPORT_KEY);
        window.clearInterval(timer);
        exportNow().catch((error) => updateStatus(error.message || "Word legal schedule export failed."));
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
        updateStatus("Dropbox sign-in did not complete. Open the viewer and try the Word export again.");
      }
    }, 500);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire, { once: true });
  else wire();
})();
