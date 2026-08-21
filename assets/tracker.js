(() => {
  "use strict";

  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const trackerVersion = "20260706-2";
  let manifestRecords = null;
  let lastSeen = new Map();
  let timer = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function cfg() {
    return window.MASICS_DROPBOX_CONFIG;
  }

  function token() {
    return window.sessionStorage.getItem("masics_access_token") || "";
  }

  function progressKey() {
    return `masics_cloud_progress:${cfg().queueIdentity}`;
  }

  function auditKey() {
    return `masics_cloud_audit:${cfg().queueIdentity}`;
  }

  function trackerKey() {
    return `masics_tracker_state:${cfg().queueIdentity}`;
  }

  function reviewerName() {
    return window.localStorage.getItem("masics_reviewer_name") || "Mario";
  }

  function unique(values) {
    const seen = new Set();
    return values.flat().map((value) => String(value || "").trim()).filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  async function dropboxDownload(locator) {
    const response = await fetch(DROPBOX_CONTENT + "files/download", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token()}`,
        "Dropbox-API-Arg": JSON.stringify({ path: locator })
      }
    });
    if (!response.ok) throw new Error(`Tracker manifest load failed: ${response.status}`);
    return response;
  }

  async function loadRecords() {
    if (manifestRecords) return manifestRecords;
    const config = cfg();
    if (!config || !token()) return [];
    let lastError = null;
    for (const locator of unique([config.manifestDropboxPath, config.manifestDropboxPathAlternates || []])) {
      try {
        const response = await dropboxDownload(locator);
        const manifest = await response.json();
        manifestRecords = manifest.records || [];
        return manifestRecords;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error("Tracker could not load queue manifest.");
  }

  function loadProgress() {
    try {
      return JSON.parse(window.localStorage.getItem(progressKey()) || "{}");
    } catch {
      return {};
    }
  }

  function loadAudit() {
    try {
      const value = JSON.parse(window.localStorage.getItem(auditKey()) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function saveAudit(events) {
    window.localStorage.setItem(auditKey(), JSON.stringify(events));
  }

  function readDecisionState() {
    const progress = loadProgress();
    return progress.decisions || {};
  }

  function blankState() {
    return JSON.stringify({ decision: "", notes: "", updatedAt: "" });
  }

  function recordById(records, id) {
    return records.find((record) => record.review_id === id) || {};
  }

  function stateFor(decision) {
    return JSON.stringify({
      decision: decision?.decision || "",
      notes: decision?.notes || "",
      updatedAt: decision?.updatedAt || ""
    });
  }

  async function scanForChanges(reason = "scan") {
    const records = await loadRecords();
    const decisions = readDecisionState();
    const audit = loadAudit();
    let changed = false;

    Object.entries(decisions).forEach(([reviewId, decision]) => {
      const next = stateFor(decision);
      const prev = lastSeen.has(reviewId) ? lastSeen.get(reviewId) : blankState();
      if (prev !== next) {
        const record = recordById(records, reviewId);
        audit.push({
          event_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          event_type: "tag_change",
          reason,
          queue_number: record.queue_number || "",
          review_id: reviewId,
          filename: record.filename || "",
          file_type: record.file_type || record.extension || "",
          previous: JSON.parse(prev),
          current: JSON.parse(next),
          reviewer: reviewerName(),
          logged_at: new Date().toISOString(),
          tracker_version: trackerVersion
        });
        lastSeen.set(reviewId, next);
        changed = true;
      }
    });

    if (changed) saveAudit(audit);
    updateTrackerSummary();
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
    let category = "";
    if (requestIds || /\bMFR\b/i.test(matchReason) || /\bMFR\b/i.test(requestTitles)) {
      category = "Discovery request / MFR evidence";
    } else if (outcome.includes("DEFENSE_PRODUCTION")) {
      category = "Defense production evidence";
    } else if (outcome.includes("PLAINTIFF_EVIDENCE")) {
      category = "Plaintiff evidence / missing discovery support";
    } else if (/franklinville/i.test(sourceRoot)) {
      category = "Franklinville municipal record";
    } else if (/jpe?g|png|heic|tiff|image/.test(fileType)) {
      category = "Image / screenshot evidence";
    } else if (/pdf/.test(fileType)) {
      category = "PDF document evidence";
    }
    const priority = String(display.priority_tier || "").trim();
    const priorityCode = /^[A-Z]$|^\d+$/i.test(priority) ? priority : "";
    return category && priorityCode ? `${category} (Priority ${priorityCode})` : category || (priorityCode ? `Legal review priority ${priorityCode}` : "");
  }

  function legalMetadata(record, saved) {
    const display = record.display || {};
    const notes = splitNotes(saved.notes || "");
    const sourceBates = String(display.bates_range || display.bates_begin || batesFromText(saved.notes) || "").trim();
    const viewerBates = String(display.viewer_bates || display.control_bates || (record.queue_number ? `MASICS-${String(record.queue_number).padStart(5, "0")}` : "")).trim();
    const priorityTier = String(display.priority_tier || "").trim();
    const descriptivePriorityCategory = /^[A-Z]$|^\d+$/i.test(priorityTier) || /_|APPEND|BUCKET|UNRANKED|STAGED/i.test(priorityTier) ? "" : priorityTier;
    const category = String(
      display.category ||
      display.legal_category ||
      descriptivePriorityCategory ||
      derivedCategory(record, display) ||
      ""
    ).trim() || "Uncategorized / needs legal review";
    const aiDescription = notes.aiDescription || String(display.ai_note || record.ai_note || "").trim();
    const shortDescription = aiDescription || notes.marioNote || String(display.mfr_request_titles || record.filename || "").trim();
    return {
      viewerBates,
      sourceBates,
      category,
      shortDescription,
      marioNote: notes.marioNote,
      aiDescription
    };
  }

  function downloadText(filename, text, type = "text/csv") {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportTaggedCsv() {
    const records = await loadRecords();
    const decisions = readDecisionState();
    const rows = [[
      "queue_number",
      "viewer_bates",
      "source_bates",
      "category",
      "filename",
      "review_id",
      "file_type",
      "decision",
      "short_description",
      "mario_note",
      "ai_description",
      "notes",
      "updated_at",
      "reviewer",
      "dropbox_path",
      "dropbox_path_alternates"
    ]];

    records.forEach((record) => {
      const saved = decisions[record.review_id] || {};
      if (!(saved.decision || saved.notes)) return;
      const meta = legalMetadata(record, saved);
      rows.push([
        record.queue_number,
        meta.viewerBates,
        meta.sourceBates,
        meta.category,
        record.filename,
        record.review_id,
        record.file_type || record.extension || "",
        saved.decision || "",
        meta.shortDescription,
        meta.marioNote,
        meta.aiDescription,
        saved.notes || "",
        saved.updatedAt || "",
        reviewerName(),
        record.dropbox_path || "",
        (record.dropbox_path_alternates || []).join(" | ")
      ]);
    });

    const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadText(`masics-tagged-files-${cfg().queueIdentity}-${stamp}.csv`, csv);
    await logUtilityEvent("export_tagged_csv", { tagged_count: rows.length - 1 });
  }

  async function exportAuditJson() {
    await scanForChanges("export_audit");
    const audit = loadAudit();
    const payload = {
      queueIdentity: cfg().queueIdentity,
      exportedAt: new Date().toISOString(),
      trackerVersion,
      eventCount: audit.length,
      events: audit
    };
    const stamp = payload.exportedAt.replace(/[:.]/g, "-");
    downloadText(`masics-review-audit-${cfg().queueIdentity}-${stamp}.json`, JSON.stringify(payload, null, 2), "application/json");
  }

  async function logUtilityEvent(eventType, detail = {}) {
    const audit = loadAudit();
    audit.push({
      event_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      event_type: eventType,
      detail,
      reviewer: reviewerName(),
      logged_at: new Date().toISOString(),
      tracker_version: trackerVersion
    });
    saveAudit(audit);
    updateTrackerSummary();
  }

  function taggedCount() {
    const decisions = readDecisionState();
    return Object.values(decisions).filter((value) => value && (value.decision || value.notes)).length;
  }

  function updateTrackerSummary() {
    const summary = $("tracker-summary");
    if (!summary) return;
    summary.textContent = `Tagged: ${taggedCount()} | Audit events: ${loadAudit().length}`;
  }

  function addTrackerControls() {
    const actions = document.querySelector(".progress-actions");
    if (!actions || $("export-tagged-csv")) return;

    const exportCsv = document.createElement("button");
    exportCsv.id = "export-tagged-csv";
    exportCsv.type = "button";
    exportCsv.textContent = "Export Tagged CSV";
    exportCsv.addEventListener("click", () => exportTaggedCsv().catch((err) => alert(err.message)));

    const exportAudit = document.createElement("button");
    exportAudit.id = "export-audit-json";
    exportAudit.type = "button";
    exportAudit.textContent = "Export Audit JSON";
    exportAudit.addEventListener("click", () => exportAuditJson().catch((err) => alert(err.message)));

    const summary = document.createElement("span");
    summary.id = "tracker-summary";
    summary.className = "tracker-summary";

    actions.append(exportCsv, exportAudit, summary);
    updateTrackerSummary();
  }

  function initializeBaseline() {
    const decisions = readDecisionState();
    Object.entries(decisions).forEach(([reviewId, decision]) => lastSeen.set(reviewId, stateFor(decision)));
    window.localStorage.setItem(trackerKey(), JSON.stringify({ initializedAt: new Date().toISOString(), trackerVersion }));
  }

  function scheduleScan(reason) {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => scanForChanges(reason).catch(() => {}), 250);
  }

  document.addEventListener("change", () => scheduleScan("change"), true);
  document.addEventListener("input", () => scheduleScan("input"), true);
  document.addEventListener("click", () => {
    addTrackerControls();
    scheduleScan("click");
  }, true);

  initializeBaseline();
  addTrackerControls();
  window.setInterval(() => {
    addTrackerControls();
    scheduleScan("interval");
  }, 3000);
})();
