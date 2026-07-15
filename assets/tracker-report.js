(() => {
  "use strict";

  const DROPBOX_AUTH = "https://www.dropbox.com/oauth2/authorize";
  const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const cfg = window.MASICS_DROPBOX_CONFIG || {};
  const authStore = window.sessionStorage;
  const autoRefreshMs = 30000;
  let latestProgress = null;
  let latestAudit = null;
  let manifestRecords = [];
  let backupEntries = [];
  let refreshTimer = 0;
  let loadInFlight = false;

  window.MASICS_TRACKER_REPORT_VERSION = "20260715-marked-backups-1";

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $("tracker-status"),
    signIn: $("tracker-sign-in"),
    signOut: $("tracker-sign-out"),
    refresh: $("tracker-refresh"),
    search: $("tracker-search"),
    decision: $("tracker-decision"),
    total: $("metric-total"),
    reviewed: $("metric-reviewed"),
    pending: $("metric-pending"),
    excluded: $("metric-excluded"),
    exported: $("metric-exported"),
    progressBackups: $("metric-progress-backups"),
    auditBackups: $("metric-audit-backups"),
    duplicateGroupsMetric: $("metric-duplicate-groups"),
    reviewedDuplicateGroupsMetric: $("metric-reviewed-duplicate-groups"),
    reviewedCount: $("reviewed-count"),
    reviewedBody: $("reviewed-body"),
    backupCount: $("backup-count"),
    backupBody: $("backup-body"),
    auditSummary: $("audit-summary"),
    auditBody: $("audit-body"),
    duplicateSummary: $("duplicate-summary"),
    duplicateBody: $("duplicate-body"),
    exportReviewed: $("export-reviewed-csv"),
    exportAudit: $("export-audit-json"),
    exportDuplicatesCsv: $("export-duplicates-csv"),
    exportDuplicatesJson: $("export-duplicates-json")
  };

  function setStatus(message) {
    els.status.textContent = message;
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function isTransientFetchError(err) {
    return /Failed to fetch|NetworkError|Load failed/i.test(String(err && err.message || err || ""));
  }

  async function fetchWithRetry(url, options) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await fetch(url, options);
      } catch (err) {
        lastError = err;
        if (!isTransientFetchError(err)) throw err;
        await delay(600 * (attempt + 1));
      }
    }
    throw lastError || new Error("Dropbox request failed before it could start.");
  }

  function token() {
    return authStore.getItem("masics_access_token") || "";
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[char]));
  }

  function formatTime(value) {
    if (!value) return "-";
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return String(value);
    return new Date(time).toLocaleString();
  }

  function formatBytes(value) {
    const size = Number(value || 0);
    if (!size) return "-";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function unique(values) {
    const seen = new Set();
    return values.flat().map((value) => String(value || "").trim()).filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function randomBase64Url(bytes = 32) {
    const data = new Uint8Array(bytes);
    crypto.getRandomValues(data);
    return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function sha256Base64Url(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function signIn() {
    if (!cfg.appKey || cfg.appKey.startsWith("__")) {
      setStatus("Dropbox app key is not configured.");
      return;
    }
    setStatus("Opening Dropbox sign-in...");
    const state = randomBase64Url(24);
    const verifier = randomBase64Url(64);
    const challenge = await sha256Base64Url(verifier);
    authStore.setItem("masics_oauth_state", state);
    authStore.setItem("masics_pkce_verifier", verifier);
    authStore.setItem("masics_auth_return_to", "tracker");
    const params = new URLSearchParams({
      client_id: cfg.appKey,
      response_type: "code",
      redirect_uri: cfg.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      token_access_type: "online",
      scope: cfg.scopes.join(" ")
    });
    window.location.href = `${DROPBOX_AUTH}?${params.toString()}`;
  }

  function signedInUi(isSignedIn) {
    els.signIn.hidden = isSignedIn;
    els.signOut.hidden = !isSignedIn;
    els.refresh.hidden = !isSignedIn;
  }

  async function dropboxRpc(endpoint, body) {
    const response = await fetchWithRetry(DROPBOX_RPC + endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {})
    });
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign in again.");
    if (response.status === 403) throw new Error("Dropbox permission denied for tracker files.");
    if (!response.ok) throw new Error(`Dropbox metadata request failed: ${response.status}`);
    return response.json();
  }

  async function dropboxDownload(locator) {
    const response = await fetchWithRetry(DROPBOX_CONTENT + "files/download", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token()}`,
        "Dropbox-API-Arg": JSON.stringify({ path: locator })
      }
    });
    if (response.status === 409 || response.status === 404) return null;
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign in again.");
    if (response.status === 403) throw new Error("Dropbox permission denied for tracker files.");
    if (!response.ok) throw new Error(`Dropbox file download failed: ${response.status}`);
    return response;
  }

  async function downloadJson(locators) {
    let lastError = null;
    for (const locator of unique(locators)) {
      try {
        const response = await dropboxDownload(locator);
        if (!response) continue;
        return await response.json();
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw lastError;
    return null;
  }

  async function resolveProgressFolder() {
    if (cfg.progressDropboxFolderId) {
      try {
        const metadata = await dropboxRpc("files/get_metadata", { path: cfg.progressDropboxFolderId, include_deleted: false });
        if (metadata.path_display) return metadata.path_display.replace(/\/+$/g, "");
      } catch {}
    }
    return String(cfg.progressDropboxFolder || "").replace(/\/+$/g, "");
  }

  async function listFolder(path) {
    const entries = [];
    let result = await dropboxRpc("files/list_folder", { path, recursive: false, include_deleted: false });
    entries.push(...(result.entries || []));
    while (result.has_more && result.cursor) {
      result = await dropboxRpc("files/list_folder/continue", { cursor: result.cursor });
      entries.push(...(result.entries || []));
    }
    return entries;
  }

  async function loadOptionalJson(label, locators) {
    try {
      setStatus(`Loading ${label} from Dropbox...`);
      return await downloadJson(locators);
    } catch (err) {
      if (isTransientFetchError(err)) throw new Error(`Dropbox connected, but the browser blocked the ${label} download. Refresh this tracker and try again.`);
      throw err;
    }
  }

  async function loadData() {
    if (!token()) return;
    if (loadInFlight) return;
    loadInFlight = true;
    signedInUi(true);
    try {
      setStatus("Loading online tracker files from Dropbox...");
      const base = await resolveProgressFolder();
      const manifest = await loadOptionalJson("queue manifest", [cfg.manifestDropboxPath, cfg.manifestDropboxPathAlternates || []]);
      const progress = await loadOptionalJson("latest progress", [cfg.progressDropboxLatestJsonId, `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`]);
      const audit = await loadOptionalJson("latest audit", [`${base}/MASICS_MARIO_REVIEW_AUDIT_LATEST.json`]);
      setStatus("Loading backup snapshot list from Dropbox...");
      const entries = await listFolder(cfg.progressDropboxFolderId || base).catch(() => listFolder(base));
      manifestRecords = Array.isArray(manifest?.records) ? manifest.records : [];
      latestProgress = progress || {};
      latestAudit = audit || {};
      backupEntries = entries.filter((entry) => /^MASICS_MARIO_(REVIEW_(PROGRESS|AUDIT)|MARKED_REVIEWED)_.+\.(json|csv)$/i.test(entry.name || ""));
      render();
      setStatus(`Loaded tracker. Last save: ${formatTime(latestProgress.exportedAt)}. Auto-refresh is on.`);
    } finally {
      loadInFlight = false;
    }
  }

  function scheduleAutoRefresh() {
    window.clearInterval(refreshTimer);
    if (!token()) return;
    refreshTimer = window.setInterval(() => {
      if (document.hidden) return;
      loadData().catch((err) => setStatus(err.message || "Tracker refresh failed."));
    }, autoRefreshMs);
  }

  function recordMap() {
    const map = new Map();
    manifestRecords.forEach((record) => map.set(record.review_id, record));
    return map;
  }

  function savedFor(reviewId) {
    return (latestProgress?.decisions || {})[reviewId] || {};
  }

  function rowStateFor(record) {
    const saved = savedFor(record.review_id);
    const decision = saved?.decision || "";
    return {
      decision,
      notes: saved?.notes || "",
      updatedAt: saved?.updatedAt || "",
      reviewed: Boolean(decision && decision !== "delete"),
      excluded: decision === "delete",
      pending: !decision
    };
  }

  function reviewedRows() {
    const recordsById = recordMap();
    const decisions = latestProgress?.decisions || {};
    return Object.entries(decisions).map(([reviewId, saved]) => {
      const record = recordsById.get(reviewId) || {};
      const decision = saved?.decision || "";
      const notes = saved?.notes || "";
      return {
        queue: record.queue_number || "",
        filename: record.filename || reviewId,
        reviewId,
        decision,
        needsDropdown: Boolean(!decision && String(notes).trim()),
        notes,
        updatedAt: saved?.updatedAt || "",
        fileType: record.file_type || record.extension || ""
      };
    }).filter((row) => row.decision || row.needsDropdown).sort((a, b) => Number(a.queue || 0) - Number(b.queue || 0));
  }

  function filteredReviewedRows() {
    const search = els.search.value.trim().toLowerCase();
    const decision = els.decision.value;
    return reviewedRows().filter((row) => {
      if (decision === "needs_dropdown" && !row.needsDropdown) return false;
      if (decision !== "all" && decision !== "needs_dropdown" && row.decision !== decision) return false;
      if (!search) return true;
      return [row.queue, row.filename, row.reviewId, row.decision, row.notes, row.updatedAt, row.fileType].join(" ").toLowerCase().includes(search);
    });
  }

  function normalizePath(value) {
    return String(value || "").trim().toLowerCase().replace(/\\/g, "/").replace(/\/+/g, "/");
  }

  function normalizeFilename(value) {
    return String(value || "").trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
  }

  function stemFilename(value) {
    return normalizeFilename(value).replace(/\.[a-z0-9]{1,8}$/i, "");
  }

  function fuzzyFilenameKey(record) {
    const ext = String(record.extension || record.file_type || "").replace(/^\./, "").toLowerCase();
    let stem = stemFilename(record.filename);
    stem = stem
      .replace(/\b(copy|scan|scanned|final|draft|edited|new|old)\b/g, " ")
      .replace(/\bv\d+\b/g, " ")
      .replace(/\(\d+\)|\[\d+\]|[-_ ]+\d+$/g, " ")
      .replace(/[^a-z0-9]+/g, "")
      .trim();
    return stem && stem.length >= 6 ? `${stem}.${ext}` : "";
  }

  function contentHashFor(record) {
    const direct = String(record.database_file_sha256 || "").trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(direct)) return direct;
    const review = String(record.review_id || "").trim().toLowerCase();
    const match = review.match(/^sha:([a-f0-9]{64})$/);
    return match ? match[1] : "";
  }

  function addGroup(map, type, key, record) {
    if (!key) return;
    const mapKey = `${type}:${key}`;
    if (!map.has(mapKey)) map.set(mapKey, { type, key, records: [] });
    map.get(mapKey).records.push(record);
  }

  function duplicateAuditGroups() {
    const groups = new Map();
    manifestRecords.forEach((record) => {
      addGroup(groups, "Exact content hash", contentHashFor(record), record);
      addGroup(groups, "Exact Dropbox path", normalizePath(record.dropbox_path), record);
      addGroup(groups, "Same filename", normalizeFilename(record.filename), record);
      addGroup(groups, "Likely filename match", fuzzyFilenameKey(record), record);
    });

    const filtered = [...groups.values()].filter((group) => group.records.length > 1).map((group) => {
      const ids = new Set(group.records.map((record) => record.review_id));
      const records = [...ids].map((id) => group.records.find((record) => record.review_id === id)).filter(Boolean);
      const reviewed = records.filter((record) => rowStateFor(record).reviewed).length;
      const excluded = records.filter((record) => rowStateFor(record).excluded).length;
      const pending = records.length - reviewed - excluded;
      return { ...group, records, reviewed, excluded, pending };
    }).filter((group) => group.records.length > 1);

    const severity = { "Exact content hash": 1, "Exact Dropbox path": 2, "Same filename": 3, "Likely filename match": 4 };
    return filtered.sort((a, b) => {
      const reviewPressure = Number(b.reviewed > 0 && b.pending > 0) - Number(a.reviewed > 0 && a.pending > 0);
      if (reviewPressure) return reviewPressure;
      return (severity[a.type] || 9) - (severity[b.type] || 9) || b.records.length - a.records.length || a.key.localeCompare(b.key);
    });
  }

  function renderMetrics(rows, duplicateGroups) {
    const total = manifestRecords.length || latestProgress.total || cfg.expectedRecordCount || "-";
    const excluded = rows.filter((row) => row.decision === "delete").length;
    const reviewed = rows.filter((row) => row.decision && row.decision !== "delete").length;
    const pending = Math.max(0, Number(total || 0) - reviewed - excluded);
    const progressBackups = backupEntries.filter((entry) => /^MASICS_MARIO_REVIEW_PROGRESS_/i.test(entry.name || "")).length;
    const auditBackups = backupEntries.filter((entry) => /^MASICS_MARIO_REVIEW_AUDIT_/i.test(entry.name || "")).length;
    const reviewedDupGroups = duplicateGroups.filter((group) => group.reviewed > 0 && group.pending > 0).length;
    els.total.textContent = total;
    els.reviewed.textContent = reviewed;
    els.pending.textContent = pending;
    els.excluded.textContent = excluded;
    els.exported.textContent = formatTime(latestProgress.exportedAt);
    els.progressBackups.textContent = progressBackups;
    els.auditBackups.textContent = auditBackups;
    if (els.duplicateGroupsMetric) els.duplicateGroupsMetric.textContent = duplicateGroups.length;
    if (els.reviewedDuplicateGroupsMetric) els.reviewedDuplicateGroupsMetric.textContent = reviewedDupGroups;
  }

  function renderReviewed(rows) {
    els.reviewedCount.textContent = `${rows.length} shown`;
    if (!rows.length) {
      els.reviewedBody.innerHTML = `<tr><td colspan="5">No decision, notes-only, or excluded files match the current filter.</td></tr>`;
      return;
    }
    els.reviewedBody.innerHTML = rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.queue)}</td>
        <td><strong>${escapeHtml(row.filename)}</strong><br><span class="muted">${escapeHtml(row.reviewId)}</span></td>
        <td>${escapeHtml(row.needsDropdown ? "Needs dropdown" : row.decision || "notes only")}</td>
        <td>${escapeHtml(formatTime(row.updatedAt))}</td>
        <td>${escapeHtml(row.notes)}</td>
      </tr>
    `).join("");
  }

  function renderDuplicates(groups) {
    const pressureGroups = groups.filter((group) => group.reviewed > 0 && group.pending > 0);
    els.duplicateSummary.textContent = `${groups.length} groups found. ${pressureGroups.length} have reviewed plus pending items.`;
    if (!groups.length) {
      els.duplicateBody.innerHTML = `<tr><td colspan="5">No exact or likely duplicate groups were found in the loaded manifest.</td></tr>`;
      return;
    }
    const shown = groups.slice(0, 100);
    els.duplicateBody.innerHTML = shown.map((group) => {
      const records = group.records.slice(0, 8).map((record) => {
        const state = rowStateFor(record);
        const label = state.excluded ? "excluded" : state.reviewed ? state.decision : "pending";
        return `#${escapeHtml(record.queue_number)} ${escapeHtml(record.filename)} <span class="muted">${escapeHtml(label)} | ${escapeHtml(record.dropbox_path || "")}</span>`;
      }).join("<br>");
      const more = group.records.length > 8 ? `<br><span class="muted">+${group.records.length - 8} more in this group</span>` : "";
      return `
        <tr>
          <td>${escapeHtml(group.type)}</td>
          <td><span class="muted">${escapeHtml(group.key)}</span></td>
          <td>${group.records.length}</td>
          <td>${group.reviewed} reviewed / ${group.pending} pending / ${group.excluded} excluded</td>
          <td>${records}${more}</td>
        </tr>
      `;
    }).join("");
  }

  function renderBackups() {
    const sorted = [...backupEntries].sort((a, b) => String(b.server_modified || "").localeCompare(String(a.server_modified || "")));
    els.backupCount.textContent = `${sorted.length} backups`;
    if (!sorted.length) {
      els.backupBody.innerHTML = `<tr><td colspan="4">No Dropbox backup snapshots were found.</td></tr>`;
      return;
    }
    els.backupBody.innerHTML = sorted.map((entry) => {
      const type = /AUDIT/i.test(entry.name || "") ? "Audit" : /STATUS/i.test(entry.name || "") ? "CSV" : "Progress";
      return `
        <tr>
          <td>${type}</td>
          <td>${escapeHtml(formatTime(entry.server_modified || entry.client_modified))}</td>
          <td>${escapeHtml(entry.name)}</td>
          <td>${escapeHtml(formatBytes(entry.size))}</td>
        </tr>
      `;
    }).join("");
  }

  function summarizeDecision(value) {
    if (!value || !value.hasValue) return "blank";
    const parts = [value.decision || "notes"];
    if (value.hasNotes) parts.push(`${value.noteLength || 0} chars`);
    if (value.updatedAt) parts.push(formatTime(value.updatedAt));
    return parts.join(" / ");
  }

  function renderAudit() {
    const changed = Array.isArray(latestAudit.changed) ? latestAudit.changed : [];
    els.auditSummary.textContent = latestAudit.exportedAt
      ? `${changed.length} changed in latest save at ${formatTime(latestAudit.exportedAt)}`
      : "No latest audit loaded";
    if (!changed.length) {
      els.auditBody.innerHTML = `<tr><td colspan="3">Latest save audit shows no changed decisions.</td></tr>`;
      return;
    }
    els.auditBody.innerHTML = changed.map((item) => `
      <tr>
        <td>${escapeHtml(item.reviewId)}</td>
        <td>${escapeHtml(summarizeDecision(item.before))}</td>
        <td>${escapeHtml(summarizeDecision(item.after))}</td>
      </tr>
    `).join("");
  }

  function render() {
    const allRows = reviewedRows();
    const duplicateGroups = duplicateAuditGroups();
    renderMetrics(allRows, duplicateGroups);
    renderDuplicates(duplicateGroups);
    renderReviewed(filteredReviewedRows());
    renderBackups();
    renderAudit();
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function downloadText(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportReviewedCsv() {
    const header = ["queue", "filename", "review_id", "decision", "needs_dropdown", "notes", "updated_at", "file_type"];
    const lines = [header, ...filteredReviewedRows().map((row) => [
      row.queue,
      row.filename,
      row.reviewId,
      row.decision,
      row.needsDropdown ? "true" : "false",
      row.notes,
      row.updatedAt,
      row.fileType
    ])];
    downloadText(`masics-reviewed-files-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`, lines.map((line) => line.map(csvEscape).join(",")).join("\r\n") + "\r\n", "text/csv");
  }

  function exportAuditJson() {
    downloadText(`masics-latest-save-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, JSON.stringify(latestAudit || {}, null, 2), "application/json");
  }

  function duplicateAuditExportRows() {
    return duplicateAuditGroups().flatMap((group) => group.records.map((record) => {
      const state = rowStateFor(record);
      return {
        type: group.type,
        groupKey: group.key,
        groupCount: group.records.length,
        groupReviewed: group.reviewed,
        groupPending: group.pending,
        groupExcluded: group.excluded,
        queue: record.queue_number || "",
        filename: record.filename || "",
        reviewId: record.review_id || "",
        fileType: record.file_type || record.extension || "",
        decision: state.decision,
        notes: state.notes,
        updatedAt: state.updatedAt,
        dropboxPath: record.dropbox_path || "",
        databaseFileId: record.database_file_id || "",
        databaseSha256: contentHashFor(record)
      };
    }));
  }

  function exportDuplicatesCsv() {
    const header = ["type", "group_key", "group_count", "group_reviewed", "group_pending", "group_excluded", "queue", "filename", "review_id", "file_type", "decision", "notes", "updated_at", "dropbox_path", "database_file_id", "database_sha256"];
    const rows = duplicateAuditExportRows();
    const lines = [header, ...rows.map((row) => [
      row.type, row.groupKey, row.groupCount, row.groupReviewed, row.groupPending, row.groupExcluded,
      row.queue, row.filename, row.reviewId, row.fileType, row.decision, row.notes, row.updatedAt, row.dropboxPath, row.databaseFileId, row.databaseSha256
    ])];
    downloadText(`masics-duplicate-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`, lines.map((line) => line.map(csvEscape).join(",")).join("\r\n") + "\r\n", "text/csv");
  }

  function exportDuplicatesJson() {
    const payload = {
      schema: "MASICS_DUPLICATE_AUDIT_V1",
      generatedAt: new Date().toISOString(),
      source: "github-pages-tracker",
      queueIdentity: latestProgress?.queueIdentity || cfg.queueIdentity || "",
      manifestRecordCount: manifestRecords.length,
      progressExportedAt: latestProgress?.exportedAt || "",
      note: "This audit uses manifest metadata and review progress only. It does not open, download, delete, or modify evidence files.",
      groups: duplicateAuditGroups().map((group) => ({
        type: group.type,
        key: group.key,
        count: group.records.length,
        reviewed: group.reviewed,
        pending: group.pending,
        excluded: group.excluded,
        records: group.records.map((record) => {
          const state = rowStateFor(record);
          return {
            queue: record.queue_number || "",
            filename: record.filename || "",
            reviewId: record.review_id || "",
            fileType: record.file_type || record.extension || "",
            decision: state.decision,
            notes: state.notes,
            updatedAt: state.updatedAt,
            dropboxPath: record.dropbox_path || "",
            databaseFileId: record.database_file_id || "",
            databaseSha256: contentHashFor(record)
          };
        })
      }))
    };
    downloadText(`masics-duplicate-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, JSON.stringify(payload, null, 2), "application/json");
  }

  function wireEvents() {
    els.signIn.addEventListener("click", () => signIn().catch((err) => setStatus(err.message || "Dropbox sign-in failed.")));
    els.signOut.addEventListener("click", () => {
      authStore.removeItem("masics_access_token");
      window.clearInterval(refreshTimer);
      signedInUi(false);
      setStatus("Signed out. Sign in with Dropbox to review saved progress.");
    });
    els.refresh.addEventListener("click", () => loadData().catch((err) => setStatus(err.message || "Tracker refresh failed.")));
    els.search.addEventListener("input", render);
    els.decision.addEventListener("change", render);
    els.exportReviewed.addEventListener("click", exportReviewedCsv);
    els.exportAudit.addEventListener("click", exportAuditJson);
    if (els.exportDuplicatesCsv) els.exportDuplicatesCsv.addEventListener("click", exportDuplicatesCsv);
    if (els.exportDuplicatesJson) els.exportDuplicatesJson.addEventListener("click", exportDuplicatesJson);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && token()) loadData().catch((err) => setStatus(err.message || "Tracker refresh failed."));
    });
    window.addEventListener("focus", () => {
      if (token()) loadData().catch((err) => setStatus(err.message || "Tracker refresh failed."));
    });
  }

  async function init() {
    wireEvents();
    signedInUi(Boolean(token()));
    if (!token()) return;
    try {
      await loadData();
      scheduleAutoRefresh();
    } catch (err) {
      setStatus(err.message || "Tracker load failed.");
    }
  }

  init();
})();
