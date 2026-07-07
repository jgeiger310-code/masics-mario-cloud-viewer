(() => {
  "use strict";

  const DROPBOX_AUTH = "https://www.dropbox.com/oauth2/authorize";
  const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const cfg = window.MASICS_DROPBOX_CONFIG || {};
  const authStore = window.sessionStorage;
  let latestProgress = null;
  let latestAudit = null;
  let manifestRecords = [];
  let backupEntries = [];

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
    exported: $("metric-exported"),
    progressBackups: $("metric-progress-backups"),
    auditBackups: $("metric-audit-backups"),
    reviewedCount: $("reviewed-count"),
    reviewedBody: $("reviewed-body"),
    backupCount: $("backup-count"),
    backupBody: $("backup-body"),
    auditSummary: $("audit-summary"),
    auditBody: $("audit-body"),
    exportReviewed: $("export-reviewed-csv"),
    exportAudit: $("export-audit-json")
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
    signedInUi(true);
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
    backupEntries = entries.filter((entry) => /^MASICS_MARIO_REVIEW_(PROGRESS|AUDIT)_.+\.(json|csv)$/i.test(entry.name || ""));
    render();
    setStatus(`Loaded tracker. Last save: ${formatTime(latestProgress.exportedAt)}.`);
  }

  function recordMap() {
    const map = new Map();
    manifestRecords.forEach((record) => map.set(record.review_id, record));
    return map;
  }

  function reviewedRows() {
    const recordsById = recordMap();
    const decisions = latestProgress?.decisions || {};
    return Object.entries(decisions).map(([reviewId, saved]) => {
      const record = recordsById.get(reviewId) || {};
      return {
        queue: record.queue_number || "",
        filename: record.filename || reviewId,
        reviewId,
        decision: saved?.decision || "",
        notes: saved?.notes || "",
        updatedAt: saved?.updatedAt || "",
        fileType: record.file_type || record.extension || ""
      };
    }).filter((row) => row.decision).sort((a, b) => Number(a.queue || 0) - Number(b.queue || 0));
  }

  function filteredReviewedRows() {
    const search = els.search.value.trim().toLowerCase();
    const decision = els.decision.value;
    return reviewedRows().filter((row) => {
      if (decision !== "all" && row.decision !== decision) return false;
      if (!search) return true;
      return [row.queue, row.filename, row.reviewId, row.decision, row.notes, row.updatedAt, row.fileType].join(" ").toLowerCase().includes(search);
    });
  }

  function renderMetrics(rows) {
    const total = latestProgress.total || manifestRecords.length || cfg.expectedRecordCount || "-";
    const reviewed = rows.length || 0;
    const pending = Math.max(0, Number(total || 0) - reviewed);
    const progressBackups = backupEntries.filter((entry) => /^MASICS_MARIO_REVIEW_PROGRESS_/i.test(entry.name || "")).length;
    const auditBackups = backupEntries.filter((entry) => /^MASICS_MARIO_REVIEW_AUDIT_/i.test(entry.name || "")).length;
    els.total.textContent = total;
    els.reviewed.textContent = reviewed;
    els.pending.textContent = pending;
    els.exported.textContent = formatTime(latestProgress.exportedAt);
    els.progressBackups.textContent = progressBackups;
    els.auditBackups.textContent = auditBackups;
  }

  function renderReviewed(rows) {
    els.reviewedCount.textContent = `${rows.length} shown`;
    if (!rows.length) {
      els.reviewedBody.innerHTML = `<tr><td colspan="5">No reviewed files match the current filter.</td></tr>`;
      return;
    }
    els.reviewedBody.innerHTML = rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.queue)}</td>
        <td><strong>${escapeHtml(row.filename)}</strong><br><span class="muted">${escapeHtml(row.reviewId)}</span></td>
        <td>${escapeHtml(row.decision || "notes only")}</td>
        <td>${escapeHtml(formatTime(row.updatedAt))}</td>
        <td>${escapeHtml(row.notes)}</td>
      </tr>
    `).join("");
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
    const rows = filteredReviewedRows();
    renderMetrics(rows);
    renderReviewed(rows);
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
    const header = ["queue", "filename", "review_id", "decision", "notes", "updated_at", "file_type"];
    const lines = [header, ...filteredReviewedRows().map((row) => [row.queue, row.filename, row.reviewId, row.decision, row.notes, row.updatedAt, row.fileType])];
    downloadText(`masics-reviewed-files-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`, lines.map((line) => line.map(csvEscape).join(",")).join("\r\n") + "\r\n", "text/csv");
  }

  function exportAuditJson() {
    downloadText(`masics-latest-save-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, JSON.stringify(latestAudit || {}, null, 2), "application/json");
  }

  function wireEvents() {
    els.signIn.addEventListener("click", () => signIn().catch((err) => setStatus(err.message || "Dropbox sign-in failed.")));
    els.signOut.addEventListener("click", () => {
      authStore.removeItem("masics_access_token");
      signedInUi(false);
      setStatus("Signed out. Sign in with Dropbox to review saved progress.");
    });
    els.refresh.addEventListener("click", () => loadData().catch((err) => setStatus(err.message || "Tracker refresh failed.")));
    els.search.addEventListener("input", render);
    els.decision.addEventListener("change", render);
    els.exportReviewed.addEventListener("click", exportReviewedCsv);
    els.exportAudit.addEventListener("click", exportAuditJson);
  }

  async function init() {
    wireEvents();
    signedInUi(Boolean(token()));
    if (!token()) return;
    try {
      await loadData();
    } catch (err) {
      setStatus(err.message || "Tracker load failed.");
    }
  }

  init();
})();
