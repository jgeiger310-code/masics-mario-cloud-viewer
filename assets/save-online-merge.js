(() => {
  "use strict";

  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
  const version = "20260707-5";

  function cfg() {
    return window.MASICS_DROPBOX_CONFIG || {};
  }

  function token() {
    return window.sessionStorage.getItem("masics_access_token") || "";
  }

  function progressKey() {
    return `masics_cloud_progress:${cfg().queueIdentity}`;
  }

  function stampKey(name) {
    return `${progressKey()}:${name}`;
  }

  function saveStatus() {
    return document.getElementById("save-status");
  }

  function setSaveStatus(message) {
    const el = saveStatus();
    if (el) el.textContent = message;
  }

  function setTopStatus(message) {
    const el = document.getElementById("status-line");
    if (el) el.textContent = message;
  }

  function progressFolder() {
    return String(cfg().progressDropboxFolder || "").replace(/\/+$/g, "");
  }

  function progressFolders() {
    const folders = [cfg().progressDropboxFolder, cfg().progressDropboxFolderAlternates || []];
    return unique(folders).map((folder) => folder.replace(/\/+$/g, ""));
  }

  function loadLocalProgress() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(progressKey()) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveLocalProgress(progress) {
    window.localStorage.setItem(progressKey(), JSON.stringify(progress));
  }

  function updatedAt(value) {
    const time = Date.parse(value || "");
    return Number.isFinite(time) ? time : 0;
  }

  function hasReviewValue(value) {
    return Boolean(value && (String(value.decision || "") || String(value.notes || "")));
  }

  function shouldReplaceDecision(current, candidate) {
    const currentHasValue = hasReviewValue(current);
    const candidateHasValue = hasReviewValue(candidate);
    if (currentHasValue && !candidateHasValue) return false;
    if (!currentHasValue && candidateHasValue) return true;
    return updatedAt(candidate?.updatedAt) >= updatedAt(current?.updatedAt);
  }

  function mergeDecisions(onlineDecisions, localDecisions) {
    const merged = { ...(onlineDecisions || {}) };
    Object.entries(localDecisions || {}).forEach(([reviewId, local]) => {
      const current = merged[reviewId] || {};
      if (shouldReplaceDecision(current, local)) merged[reviewId] = local;
    });
    return merged;
  }

  function summarizeDecision(value) {
    return {
      hasValue: hasReviewValue(value),
      decision: String(value?.decision || ""),
      hasNotes: Boolean(String(value?.notes || "")),
      noteLength: String(value?.notes || "").length,
      updatedAt: String(value?.updatedAt || "")
    };
  }

  function sameSummary(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function buildAudit(records, online, localProgress, mergedDecisions, exportedAt) {
    const knownIds = new Set(records.map((record) => record.review_id));
    const ids = new Set([
      ...Object.keys(online?.decisions || {}),
      ...Object.keys(localProgress?.decisions || {}),
      ...Object.keys(mergedDecisions || {})
    ]);
    const changed = [];
    const preservedFromOnline = [];
    const adoptedFromLocal = [];
    const ignoredUnknownLocalIds = [];

    ids.forEach((reviewId) => {
      const onlineValue = online?.decisions?.[reviewId];
      const localValue = localProgress?.decisions?.[reviewId];
      const mergedValue = mergedDecisions?.[reviewId];
      if (!knownIds.has(reviewId)) {
        if (localValue) ignoredUnknownLocalIds.push(reviewId);
        return;
      }
      const onlineSummary = summarizeDecision(onlineValue);
      const localSummary = summarizeDecision(localValue);
      const mergedSummary = summarizeDecision(mergedValue);
      if (hasReviewValue(onlineValue) && localValue && !shouldReplaceDecision(onlineValue, localValue) && sameSummary(mergedSummary, onlineSummary)) {
        preservedFromOnline.push({ reviewId, online: onlineSummary, local: localSummary });
      }
      if (hasReviewValue(localValue) && shouldReplaceDecision(onlineValue || {}, localValue) && sameSummary(mergedSummary, localSummary) && !sameSummary(onlineSummary, localSummary)) {
        adoptedFromLocal.push({ reviewId, online: onlineSummary, local: localSummary });
      }
      if (!sameSummary(onlineSummary, mergedSummary)) {
        changed.push({ reviewId, before: onlineSummary, after: mergedSummary });
      }
    });

    return {
      schema: "MASICS_MARIO_REVIEW_SAVE_AUDIT_V1",
      trackerVersion: version,
      queueIdentity: cfg().queueIdentity,
      queueVersion: cfg().queueVersion,
      exportedAt,
      previousOnlineExportedAt: online?.exportedAt || "",
      source: "github-pages-cloud-viewer",
      mergePolicy: "preserve existing online note/decision over blank local values; otherwise newest updatedAt wins",
      totalKnownRecords: records.length || cfg().expectedRecordCount || 636,
      onlineDecisionCount: Object.keys(online?.decisions || {}).length,
      localDecisionCount: Object.keys(localProgress?.decisions || {}).length,
      mergedDecisionCount: Object.keys(mergedDecisions || {}).length,
      changedCount: changed.length,
      preservedFromOnlineCount: preservedFromOnline.length,
      adoptedFromLocalCount: adoptedFromLocal.length,
      ignoredUnknownLocalCount: ignoredUnknownLocalIds.length,
      changed,
      preservedFromOnline,
      adoptedFromLocal,
      ignoredUnknownLocalIds
    };
  }

  function normalizeDecision(value) {
    const decision = String(value?.decision || "");
    const allowedDecisions = new Set(["", "responsive", "nonresponsive", "missing", "privileged", "needs_review"]);
    return {
      decision: allowedDecisions.has(decision) ? decision : "",
      notes: String(value?.notes || ""),
      updatedAt: String(value?.updatedAt || "")
    };
  }

  function filterKnownDecisions(records, decisions) {
    const knownIds = new Set(records.map((record) => record.review_id));
    const filtered = {};
    Object.entries(decisions || {}).forEach(([reviewId, value]) => {
      if (knownIds.has(reviewId) && value && typeof value === "object" && hasReviewValue(value)) filtered[reviewId] = normalizeDecision(value);
    });
    return filtered;
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
    if (response.status === 409 || response.status === 404) return null;
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign out, sign in again, then press Save Online.");
    if (response.status === 403) throw new Error("Dropbox permission denied while reading online tracker.");
    if (!response.ok) throw new Error(`Dropbox read failed: ${response.status}`);
    return response;
  }

  async function dropboxRpc(endpoint, body) {
    const response = await fetch(DROPBOX_RPC + endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {})
    });
    if (response.status === 409 || response.status === 404) return null;
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign out, sign in again, then press Save Online.");
    if (response.status === 403) throw new Error("Dropbox permission denied while resolving the online tracker folder.");
    if (!response.ok) throw new Error(`Dropbox metadata lookup failed: ${response.status}`);
    return response.json();
  }

  async function dropboxUpload(path, text, mode = "overwrite") {
    const response = await fetch(DROPBOX_CONTENT + "files/upload", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token()}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({
          path,
          mode: { ".tag": mode },
          autorename: false,
          mute: true,
          strict_conflict: false
        })
      },
      body: text
    });
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign out, sign in again, then press Save Online.");
    if (response.status === 403) throw new Error("Dropbox did not allow online save. The app and shared folder need review-progress write permission.");
    if (response.status === 409) throw new Error("Dropbox could not write the online tracker file. Check that Mario has edit access to the shared review folder.");
    if (!response.ok) throw new Error(`Dropbox write failed: ${response.status}`);
    return response.json();
  }

  async function loadManifestRecords() {
    const config = cfg();
    for (const locator of unique([config.manifestDropboxPath, config.manifestDropboxPathAlternates || []])) {
      const response = await dropboxDownload(locator);
      if (!response) continue;
      const manifest = await response.json();
      return Array.isArray(manifest.records) ? manifest.records : [];
    }
    return [];
  }

  async function loadOnlineProgress(base) {
    const locators = unique([
      cfg().progressDropboxLatestJsonId,
      base ? `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json` : "",
      progressFolders().map((folder) => `${folder}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`)
    ]);
    for (const locator of locators) {
      const response = await dropboxDownload(locator);
      if (!response) continue;
      try {
        return await response.json();
      } catch {
        return null;
      }
    }
    return null;
  }

  async function resolvedProgressFolder() {
    if (cfg().progressDropboxFolderId) {
      const metadata = await dropboxRpc("files/get_metadata", { path: cfg().progressDropboxFolderId, include_media_info: false, include_deleted: false });
      if (metadata && metadata.path_display) return String(metadata.path_display).replace(/\/+$/g, "");
    }
    return progressFolder();
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function buildRows(records, decisions) {
    return records.map((record) => {
      const saved = decisions[record.review_id] || {};
      const decision = saved.decision || "";
      const notes = saved.notes || "";
      return {
        queue_number: record.queue_number,
        filename: record.filename,
        review_id: record.review_id,
        file_type: record.file_type || record.extension || "",
        decision,
        notes,
        updated_at: saved.updatedAt || "",
        reviewed: Boolean(decision || notes),
        dropbox_path: record.dropbox_path || ""
      };
    });
  }

  function buildCsv(rows) {
    const header = ["queue_number", "filename", "review_id", "file_type", "decision", "notes", "updated_at", "reviewed", "dropbox_path"];
    const lines = [header, ...rows.map((row) => header.map((field) => row[field]))];
    return lines.map((line) => line.map(csvEscape).join(",")).join("\r\n") + "\r\n";
  }

  async function saveOnlineMerged(event) {
    event.preventDefault();
    event.stopImmediatePropagation();

    const button = document.getElementById("save-online");
    const base = await resolvedProgressFolder();
    if (!token()) throw new Error("Sign in with Dropbox before saving online.");
    if (!base) throw new Error("Online progress folder is not configured.");

    if (button) button.disabled = true;
    setSaveStatus("Saving online tracker...");

    try {
      const [records, online] = await Promise.all([loadManifestRecords(), loadOnlineProgress(base)]);
      const localProgress = loadLocalProgress();
      const mergedDecisions = filterKnownDecisions(records, mergeDecisions(online?.decisions || {}, localProgress.decisions || {}));
      const exportedAt = new Date().toISOString();
      const rows = buildRows(records, mergedDecisions);
      const reviewed = rows.filter((row) => row.reviewed).length;
      const payload = {
        schema: "MASICS_MARIO_ONLINE_REVIEW_PROGRESS_V1",
        queueIdentity: cfg().queueIdentity,
        queueVersion: cfg().queueVersion,
        trackerVersion: version,
        exportedAt,
        source: "github-pages-cloud-viewer",
        mergePolicy: "preserve existing online note/decision over blank local values; otherwise newest updatedAt wins",
        reviewer: "Mario",
        userAgent: navigator.userAgent,
        url: location.href,
        total: records.length || cfg().expectedRecordCount || 636,
        reviewed,
        pending: Math.max(0, (records.length || cfg().expectedRecordCount || 636) - reviewed),
        decisions: mergedDecisions,
        tagged: rows.filter((row) => row.reviewed)
      };
      const jsonText = JSON.stringify(payload, null, 2);
      const csvText = buildCsv(rows);
      const stamp = exportedAt.replace(/[:.]/g, "-");
      const audit = buildAudit(records, online, localProgress, mergedDecisions, exportedAt);
      const auditText = JSON.stringify(audit, null, 2);

      await dropboxUpload(`${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`, jsonText, "overwrite");
      await dropboxUpload(`${base}/MASICS_MARIO_REVIEW_STATUS_LATEST.csv`, csvText, "overwrite");
      await dropboxUpload(`${base}/MASICS_MARIO_REVIEW_PROGRESS_${stamp}.json`, jsonText, "add");
      await dropboxUpload(`${base}/MASICS_MARIO_REVIEW_AUDIT_LATEST.json`, auditText, "overwrite");
      await dropboxUpload(`${base}/MASICS_MARIO_REVIEW_AUDIT_${stamp}.json`, auditText, "add");

      saveLocalProgress({ queueIdentity: cfg().queueIdentity, decisions: mergedDecisions, exportedAt });
      window.localStorage.setItem(stampKey("last_online_sync_at"), exportedAt);
      setSaveStatus(`Saved online tracker: ${reviewed} reviewed, ${payload.pending} pending.`);
      setTopStatus(`Saved online tracker. Reviewed: ${reviewed}. Pending: ${payload.pending}.`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id !== "save-online") return;
    saveOnlineMerged(event).catch((err) => setSaveStatus(err.message || "Online tracker save failed."));
  }, true);
})();
