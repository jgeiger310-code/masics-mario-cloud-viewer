(() => {
  "use strict";

  const DROPBOX_AUTH = "https://www.dropbox.com/oauth2/authorize";
  const DROPBOX_TOKEN = "https://api.dropboxapi.com/oauth2/token";
  const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const cfg = window.MASICS_DROPBOX_CONFIG;
  const authStore = window.sessionStorage;
  const progressPrefix = "masics_cloud_progress:";
  let token = authStore.getItem("masics_access_token") || "";
  let manifest = null;
  let records = [];
  let active = null;
  let activeObjectUrl = "";
  const previewTypes = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".md": "text/markdown"
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $("status-line"),
    signIn: $("sign-in"),
    signOut: $("sign-out"),
    search: $("search"),
    filter: $("filter"),
    counts: $("queue-counts"),
    jumpActive: $("jump-active"),
    nextPendingTop: $("next-pending-top"),
    list: $("queue-list"),
    empty: $("empty-state"),
    view: $("record-view"),
    pos: $("record-position"),
    title: $("record-title"),
    meta: $("record-meta"),
    decision: $("decision"),
    notes: $("notes"),
    previousRecord: $("previous-record"),
    nextRecord: $("next-record"),
    nextPending: $("next-pending"),
    load: $("load-evidence"),
    evidenceStatus: $("evidence-status"),
    preview: $("preview"),
    saveOnline: $("save-online"),
    exportProgress: $("export-progress"),
    importProgress: $("import-progress"),
    resetProgress: $("reset-progress"),
    lastExport: $("last-export"),
    saveStatus: $("save-status")
  };

  function setStatus(message) {
    els.status.textContent = message;
  }

  function describeNetworkError(action, err) {
    const message = String(err && err.message || err || "");
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
      return `Dropbox connected, but the browser blocked the ${action}. Refresh and try Sign in again. If it repeats, turn off browser privacy/ad-block extensions for this viewer and Dropbox.`;
    }
    return message || `Dropbox ${action} failed.`;
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

  function escapeText(value) {
    return String(value || "");
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function progressKey() {
    return progressPrefix + cfg.queueIdentity;
  }

  function exportStampKey() {
    return progressPrefix + cfg.queueIdentity + ":last_export_at";
  }

  function saveStampKey() {
    return progressPrefix + cfg.queueIdentity + ":last_save_at";
  }

  function onlineSyncStampKey() {
    return progressPrefix + cfg.queueIdentity + ":last_online_sync_at";
  }

  function formatLocalTime(value) {
    if (!value) return "";
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  }

  function updateSaveStatus(message) {
    if (!els.saveStatus) return;
    if (message) {
      els.saveStatus.textContent = message;
      return;
    }
    const onlineAt = window.localStorage.getItem(onlineSyncStampKey());
    const savedAt = window.localStorage.getItem(saveStampKey());
    if (onlineAt) els.saveStatus.textContent = `Saved online: ${formatLocalTime(onlineAt)}`;
    else if (savedAt) els.saveStatus.textContent = `Autosaved locally: ${formatLocalTime(savedAt)}`;
    else els.saveStatus.textContent = "Autosave ready";
  }

  function markSaved(savedAt = new Date().toISOString()) {
    window.localStorage.setItem(saveStampKey(), savedAt);
    updateSaveStatus(`Autosaved locally: ${formatLocalTime(savedAt)}`);
  }

  function markSyncedOnline(savedAt = new Date().toISOString()) {
    window.localStorage.setItem(onlineSyncStampKey(), savedAt);
    updateSaveStatus(`Saved online: ${formatLocalTime(savedAt)}`);
  }

  function updateExportStatus() {
    if (!els.lastExport) return;
    const value = window.localStorage.getItem(exportStampKey());
    els.lastExport.textContent = value ? `Most recent export: ${new Date(value).toLocaleString()}` : "No progress export recorded yet.";
  }

  function loadProgress() {
    try {
      const raw = window.localStorage.getItem(progressKey());
      return raw ? JSON.parse(raw) : { queueIdentity: cfg.queueIdentity, decisions: {} };
    } catch {
      return { queueIdentity: cfg.queueIdentity, decisions: {} };
    }
  }

  function saveProgress(progress) {
    window.localStorage.setItem(progressKey(), JSON.stringify(progress));
  }

  function updatedAt(value) {
    const time = Date.parse(value || "");
    return Number.isFinite(time) ? time : 0;
  }

  function noteHasAINote(value) {
    return String(value?.notes || "").includes("AI note:");
  }

  function notesWithPreservedAINote(current, candidate) {
    if (!noteHasAINote(current) || noteHasAINote(candidate)) return candidate;
    const currentNotes = String(current?.notes || "");
    const marker = currentNotes.indexOf("AI note:");
    if (marker < 0) return candidate;
    const aiNote = currentNotes.slice(marker).trim();
    const candidateNotes = String(candidate?.notes || "").replace(/\n+$/g, "");
    return {
      ...(candidate || {}),
      notes: candidateNotes ? `${candidateNotes}\n\n${aiNote}` : aiNote
    };
  }

  function hasReviewValue(value) {
    return Boolean(value && (String(value.decision || "") || String(value.notes || "")));
  }

  function shouldReplaceDecision(current, candidate) {
    if (String(current?.decision || "") === "delete" && String(candidate?.decision || "") !== "delete") return false;
    if (String(current?.decision || "") && !String(candidate?.decision || "")) return false;
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
      const candidate = notesWithPreservedAINote(current, local);
      if (shouldReplaceDecision(current, candidate)) merged[reviewId] = candidate;
    });
    return merged;
  }

  function normalizeDecision(value) {
    const decision = String(value?.decision || "");
    const allowedDecisions = new Set(["", "responsive", "nonresponsive", "missing", "privileged", "needs_review", "duplicate", "delete"]);
    return {
      decision: allowedDecisions.has(decision) ? decision : "",
      notes: String(value?.notes || ""),
      updatedAt: String(value?.updatedAt || "")
    };
  }

  function filterKnownDecisions(decisions) {
    const knownIds = new Set(records.map((record) => record.review_id));
    const filtered = {};
    Object.entries(decisions || {}).forEach(([reviewId, value]) => {
      if (knownIds.has(reviewId) && value && typeof value === "object" && hasReviewValue(value)) filtered[reviewId] = normalizeDecision(value);
    });
    return filtered;
  }

  async function loadOnlineProgress() {
    const base = progressDropboxBase();
    const locators = uniqueLocators([
      cfg.progressDropboxLatestJsonId,
      base ? `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json` : "",
      (cfg.progressDropboxFolderAlternates || []).map((folder) => `${String(folder || "").replace(/\/+$/g, "")}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`)
    ]);
    let lastError = null;
    for (const locator of locators) {
      try {
        const response = await dropboxDownload(locator);
        const online = await response.json();
        if (!online || online.queueIdentity !== cfg.queueIdentity || typeof online.decisions !== "object") return null;
        return online;
      } catch (err) {
        lastError = err;
        if (!isLookupError(err)) throw err;
      }
    }
    if (lastError) console.warn("Online progress lookup failed", lastError);
    return null;
  }

  async function syncOnlineProgressIntoBrowser() {
    const online = await loadOnlineProgress();
    if (!online) return { reviewed: 0, imported: false };
    const localProgress = loadProgress();
    const decisions = filterKnownDecisions(mergeDecisions(online.decisions, localProgress.decisions || {}));
    const reviewed = Object.values(decisions).filter((saved) => saved && saved.decision && saved.decision !== "delete").length;
    const excluded = Object.values(decisions).filter((saved) => saved && saved.decision === "delete").length;
    saveProgress({ queueIdentity: cfg.queueIdentity, decisions, exportedAt: online.exportedAt || new Date().toISOString() });
    if (online.exportedAt) markSyncedOnline(online.exportedAt);
    return { reviewed, excluded, imported: true };
  }

  function progressFor(id) {
    const progress = loadProgress();
    return progress.decisions[id] || { decision: "", notes: "", updatedAt: "" };
  }

  function isReviewed(record, progress = null) {
    const saved = progress ? (progress.decisions[record.review_id] || {}) : progressFor(record.review_id);
    return Boolean(saved.decision && saved.decision !== "delete");
  }

  function isExcluded(record, progress = null) {
    const saved = progress ? (progress.decisions[record.review_id] || {}) : progressFor(record.review_id);
    return saved.decision === "delete";
  }

  function needsDropdown(record, progress = null) {
    const saved = progress ? (progress.decisions[record.review_id] || {}) : progressFor(record.review_id);
    return Boolean(!saved.decision && String(saved.notes || "").trim());
  }

  function reviewCounts() {
    const progress = loadProgress();
    let reviewed = 0;
    let excluded = 0;
    records.forEach((record) => {
      if (isExcluded(record, progress)) excluded += 1;
      else if (isReviewed(record, progress)) reviewed += 1;
    });
    const total = Math.max(0, records.length - excluded);
    return {
      total,
      reviewed,
      pending: Math.max(0, total - reviewed),
      excluded,
      visible: filteredRecords().length
    };
  }

  function activeIndex() {
    if (!active) return -1;
    return records.findIndex((record) => record.review_id === active.review_id);
  }

  function updateQueueSummary() {
    if (!els.counts) return;
    const counts = reviewCounts();
    els.counts.textContent = `${counts.visible} shown | ${counts.reviewed} reviewed | ${counts.pending} pending | ${counts.excluded} excluded`;
  }

  function updateReviewNavigation() {
    const index = activeIndex();
    const hasRecords = records.length > 0 && index >= 0;
    const progress = loadProgress();
    const pendingCount = records.filter((record) => !isExcluded(record, progress) && !isReviewed(record, progress)).length;
    if (els.previousRecord) els.previousRecord.disabled = !hasRecords || index <= 0;
    if (els.nextRecord) els.nextRecord.disabled = !hasRecords || index >= records.length - 1;
    if (els.nextPending) els.nextPending.disabled = pendingCount === 0;
    if (els.nextPendingTop) els.nextPendingTop.disabled = pendingCount === 0;
    if (els.jumpActive) els.jumpActive.disabled = !hasRecords;
  }

  function scrollActiveIntoView() {
    if (!active || !els.list) return;
    const button = els.list.querySelector(`button[data-review-id="${cssEscape(active.review_id)}"]`);
    if (button) button.scrollIntoView({ block: "nearest" });
  }

  function updateListButton(record, progress = null) {
    if (!record || !els.list) return;
    const button = els.list.querySelector(`button[data-review-id="${cssEscape(record.review_id)}"]`);
    if (!button) return;
    const reviewed = isReviewed(record, progress);
    const notesOnly = needsDropdown(record, progress);
    button.className = `${active && active.review_id === record.review_id ? "active " : ""}${reviewed ? "reviewed" : notesOnly ? "needs-dropdown" : "pending"}`.trim();
    const state = button.querySelector(".queue-state");
    if (state) state.textContent = reviewed ? "Done" : notesOnly ? "Needs dropdown" : "Open";
  }

  function refreshListState(previousReviewId = "") {
    const progress = loadProgress();
    els.list.querySelectorAll("button.active").forEach((button) => button.classList.remove("active"));
    if (previousReviewId) {
      const previous = records.find((record) => record.review_id === previousReviewId);
      updateListButton(previous, progress);
    }
    updateListButton(active, progress);
    updateQueueSummary();
    updateReviewNavigation();
    scrollActiveIntoView();
  }

  function selectRecordAt(index) {
    if (index < 0 || index >= records.length) return;
    showRecord(records[index]);
  }

  function selectNextPending() {
    if (!records.length) return;
    const start = activeIndex();
    for (let offset = 1; offset <= records.length; offset += 1) {
      const index = (Math.max(start, -1) + offset) % records.length;
      if (!isExcluded(records[index]) && !isReviewed(records[index])) {
        showRecord(records[index]);
        return;
      }
    }
    setStatus("No pending records remain in this queue.");
  }

  function setProgressFor(id, patch) {
    const progress = loadProgress();
    const savedAt = new Date().toISOString();
    progress.decisions[id] = { ...(progress.decisions[id] || {}), ...patch, updatedAt: savedAt };
    saveProgress(progress);
    markSaved(savedAt);
    const needsFullListRefresh = els.search.value.trim() || els.filter.value !== "all" || patch.decision === "delete";
    if (needsFullListRefresh) renderList();
    else refreshListState();
  }

  async function requestPersistentStorage() {
    if (!navigator.storage || !navigator.storage.persist) return;
    try {
      const alreadyPersisted = await navigator.storage.persisted();
      const persisted = alreadyPersisted || await navigator.storage.persist();
      window.localStorage.setItem(progressPrefix + cfg.queueIdentity + ":persistent_storage", persisted ? "granted" : "best_effort");
    } catch {
      window.localStorage.setItem(progressPrefix + cfg.queueIdentity + ":persistent_storage", "unavailable");
    }
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
      setStatus("Dropbox app key is not configured yet.");
      return;
    }
    setStatus("Opening Dropbox sign-in...");
    const state = randomBase64Url(24);
    const verifier = randomBase64Url(64);
    const challenge = await sha256Base64Url(verifier);
    authStore.setItem("masics_oauth_state", state);
    authStore.setItem("masics_pkce_verifier", verifier);
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
    window.MASICS_AUTH_REDIRECT_IN_PROGRESS = true;
    window.location.href = `${DROPBOX_AUTH}?${params.toString()}`;
  }

  async function handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code && !state) return false;
    const expected = authStore.getItem("masics_oauth_state");
    const verifier = authStore.getItem("masics_pkce_verifier");
    if (!code || !state || state !== expected || !verifier) {
      clearAuth();
      throw new Error("Dropbox sign-in failed state validation.");
    }
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: cfg.appKey,
      redirect_uri: cfg.redirectUri,
      code_verifier: verifier
    });
    const response = await fetchWithRetry(DROPBOX_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!response.ok) throw new Error("Dropbox token exchange failed.");
    const result = await response.json();
    if (!result.access_token) throw new Error("Dropbox did not return an access token.");
    token = result.access_token;
    authStore.setItem("masics_access_token", token);
    authStore.removeItem("masics_oauth_state");
    authStore.removeItem("masics_pkce_verifier");
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  }

  function clearAuth() {
    token = "";
    authStore.removeItem("masics_access_token");
    authStore.removeItem("masics_oauth_state");
    authStore.removeItem("masics_pkce_verifier");
    releasePreview();
  }

  function uniqueLocators(values) {
    const seen = new Set();
    return values.flat().filter((value) => {
      const locator = String(value || "").trim();
      if (!locator || seen.has(locator)) return false;
      seen.add(locator);
      return true;
    });
  }

  function evidenceLocators(record) {
    return uniqueLocators([
      record?.dropbox_file_id,
      record?.dropbox_path_alternates || [],
      record?.dropbox_path
    ]);
  }

  function isLookupError(err) {
    const message = String(err && err.message || "");
    return /missing|moved|not_found|malformed_path|lookup/i.test(message);
  }

  async function dropboxRpc(endpoint, body) {
    const response = await fetchWithRetry(DROPBOX_RPC + endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {})
    });
    if (response.status === 401) throw new Error("Dropbox authentication expired. Sign in again.");
    if (response.status === 403) throw new Error("Dropbox permission denied for this file.");
    if (response.status === 409) {
      let detail = "";
      try { detail = await response.text(); } catch {}
      const suffix = detail ? ` (${detail.slice(0, 240)})` : "";
      throw new Error(`Dropbox lookup failed${suffix}`);
    }
    if (!response.ok) throw new Error(`Dropbox request failed: ${response.status}`);
    return response.json();
  }

  async function dropboxDownload(pathOrId) {
    const response = await fetchWithRetry(DROPBOX_CONTENT + "files/download", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path: pathOrId })
      }
    });
    if (response.status === 401) throw new Error("Dropbox authentication expired. Sign in again.");
    if (response.status === 403) throw new Error("Dropbox permission denied for this file.");
    if (response.status === 409) {
      let detail = "";
      try { detail = await response.text(); } catch {}
      const suffix = detail ? ` (${detail.slice(0, 240)})` : "";
      throw new Error(`Dropbox file is missing or moved: ${pathOrId}${suffix}`);
    }
    if (!response.ok) throw new Error(`Dropbox download failed: ${response.status}`);
    return response;
  }

  async function dropboxTemporaryLink(pathOrId) {
    const response = await fetchWithRetry(DROPBOX_RPC + "files/get_temporary_link", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path: pathOrId })
    });
    if (response.status === 401) throw new Error("Dropbox authentication expired. Sign in again.");
    if (response.status === 403) throw new Error("Dropbox permission denied for this file.");
    if (response.status === 409) {
      let detail = "";
      try { detail = await response.text(); } catch {}
      const suffix = detail ? ` (${detail.slice(0, 240)})` : "";
      throw new Error(`Dropbox file is missing or moved: ${pathOrId}${suffix}`);
    }
    if (!response.ok) throw new Error(`Dropbox temporary preview link failed: ${response.status}`);
    const data = await response.json();
    if (!data || !data.link) throw new Error("Dropbox did not return a preview link.");
    return data.link;
  }

  async function dropboxUpload(path, text, mode = "overwrite") {
    const response = await fetchWithRetry(DROPBOX_CONTENT + "files/upload", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
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
    if (response.status === 403) throw new Error("Dropbox did not allow online save. The app/folder needs write permission for review progress.");
    if (response.status === 409) {
      let detail = "";
      try { detail = await response.text(); } catch {}
      throw new Error(`Dropbox could not save the tracker file. Check that Mario has edit access to the shared review folder. ${detail.slice(0, 220)}`);
    }
    if (!response.ok) throw new Error(`Dropbox online save failed: ${response.status}`);
    return response.json();
  }

  async function downloadFirst(locators) {
    let lastError = null;
    for (const locator of uniqueLocators(locators)) {
      try {
        return await dropboxDownload(locator);
      } catch (err) {
        lastError = err;
        if (!isLookupError(err)) throw err;
      }
    }
    throw lastError || new Error("No Dropbox locator is available.");
  }

  async function temporaryLinkFirst(locators) {
    let lastError = null;
    for (const locator of uniqueLocators(locators)) {
      try {
        return await dropboxTemporaryLink(locator);
      } catch (err) {
        lastError = err;
        if (!isLookupError(err)) throw err;
      }
    }
    throw lastError || new Error("No Dropbox locator is available.");
  }

  async function metadataFirst(locators) {
    let lastError = null;
    for (const locator of uniqueLocators(locators)) {
      try {
        await dropboxRpc("files/get_metadata", { path: locator, include_media_info: false, include_deleted: false });
        return locator;
      } catch (err) {
        lastError = err;
        if (!isLookupError(err)) throw err;
      }
    }
    throw lastError || new Error("No Dropbox locator is available.");
  }

  async function loadManifest() {
    const response = await downloadFirst([cfg.manifestDropboxPath, cfg.manifestDropboxPathAlternates || []]);
    const loaded = await response.json();
    validateManifest(loaded);
    manifest = loaded;
    records = loaded.records;
    window.MASICS_QUEUE_RECORDS = records;
    const onlineSync = await syncOnlineProgressIntoBrowser();
    const excluded = onlineSync.imported ? onlineSync.excluded || 0 : 0;
    const reviewed = onlineSync.imported ? onlineSync.reviewed : loaded.reviewed_count;
    const pending = Math.max(0, records.length - excluded - reviewed);
    const source = onlineSync.imported ? " Synced online progress." : "";
    setStatus(`Loaded ${records.length} protected queue records. Pending: ${pending}. Reviewed: ${reviewed}. Excluded: ${excluded}.${source}`);
    renderList();
    if (records.length) showRecord(records[0]);
    setStatus(`Loaded ${records.length} protected queue records. Pending: ${pending}. Reviewed: ${reviewed}. Excluded: ${excluded}.${source}`);
    updateSaveStatus();
  }

  function validateManifest(loaded) {
    if (!loaded || loaded.schema !== cfg.queueVersion) throw new Error("Queue manifest version mismatch.");
    if (loaded.queue_identity !== cfg.queueIdentity) throw new Error("Queue manifest identity mismatch.");
    if (!Array.isArray(loaded.records)) throw new Error("Queue manifest records are malformed.");
    const minimumRecordCount = cfg.expectedRecordCount || 1;
    if (loaded.records.length < minimumRecordCount) throw new Error("Queue manifest record count is lower than the protected baseline.");
    if (Number(loaded.record_count || loaded.records.length) !== loaded.records.length) throw new Error("Queue manifest record_count does not match records.");
    // Appended manifests may carry stale summary counters from the current tracker.
    // Record-level initial_review data is the authoritative no-embedded-decision guard below.
    const ids = new Set();
    const nums = new Set();
    loaded.records.forEach((record, index) => {
      if (!record.review_id || ids.has(record.review_id)) throw new Error("Queue manifest duplicate or missing review ID.");
      if (Number(record.queue_number) !== index + 1 || nums.has(record.queue_number)) throw new Error("Queue manifest order is invalid.");
      if (!record.dropbox_file_id && !record.dropbox_path) throw new Error("Queue manifest record is missing a Dropbox locator.");
      if (record.initial_review && (record.initial_review.reviewer || record.initial_review.reviewed_at || record.initial_review.notes || record.initial_review.final_tag !== "Pending")) {
        throw new Error("Queue manifest includes an embedded decision.");
      }
      ids.add(record.review_id);
      nums.add(record.queue_number);
    });
  }

  function filteredRecords() {
    const q = els.search.value.trim().toLowerCase();
    const progress = loadProgress();
    return records.filter((record) => {
      const saved = progress.decisions[record.review_id] || {};
      if (saved.decision === "delete") return false;
      const reviewed = Boolean(saved.decision);
      const notesOnly = Boolean(!saved.decision && String(saved.notes || "").trim());
      if (els.filter.value === "pending" && reviewed) return false;
      if (els.filter.value === "needs_dropdown" && !notesOnly) return false;
      if (els.filter.value === "reviewed" && !reviewed) return false;
      if (els.filter.value === "duplicate" && saved.decision !== "duplicate") return false;
      if (!q) return true;
      return [record.filename, record.review_id, record.display?.mfr_request_ids, saved.decision, saved.notes].some((v) => String(v || "").toLowerCase().includes(q));
    });
  }

  function selectVisibleRecordAfterFilter() {
    const visibleRecords = filteredRecords();
    renderList();
    if (!visibleRecords.length) {
      els.empty.hidden = false;
      els.empty.textContent = "No records match the current filter.";
      els.view.hidden = true;
      return;
    }
    if (!active || !visibleRecords.some((record) => record.review_id === active.review_id)) {
      showRecord(visibleRecords[0]);
    } else {
      refreshListState();
      updateReviewNavigation();
    }
  }

  function renderList() {
    els.list.innerHTML = "";
    const progress = loadProgress();
    const fragment = document.createDocumentFragment();
    filteredRecords().forEach((record) => {
      const reviewed = isReviewed(record, progress);
      const notesOnly = needsDropdown(record, progress);
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `${active && active.review_id === record.review_id ? "active " : ""}${reviewed ? "reviewed" : notesOnly ? "needs-dropdown" : "pending"}`.trim();
      button.dataset.reviewId = record.review_id;
      const number = document.createElement("span");
      number.className = "queue-number";
      number.textContent = `${record.queue_number}.`;
      const name = document.createElement("span");
      name.className = "queue-name";
      name.textContent = record.filename;
      const state = document.createElement("span");
      state.className = "queue-state";
      state.textContent = reviewed ? "Done" : notesOnly ? "Needs dropdown" : "Open";
      button.append(number, name, state);
      button.addEventListener("click", () => showRecord(record));
      item.appendChild(button);
      fragment.appendChild(item);
    });
    els.list.appendChild(fragment);
    updateQueueSummary();
    updateReviewNavigation();
    scrollActiveIntoView();
  }

  function showRecord(record) {
    const previousReviewId = active?.review_id || "";
    active = record;
    window.MASICS_ACTIVE_RECORD = record;
    releasePreview();
    els.empty.hidden = true;
    els.view.hidden = false;
    els.pos.textContent = `Record ${record.queue_number} of ${records.length}`;
    els.title.textContent = record.filename;
    els.meta.innerHTML = "";
    const fields = [
      ["Review ID", record.review_id],
      ["File Type", record.file_type],
      ["MFR IDs", record.display?.mfr_request_ids || ""],
      ["Match", record.display?.match_reason || ""]
    ];
    fields.forEach(([key, value]) => {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = key;
      dd.textContent = escapeText(value);
      els.meta.append(dt, dd);
    });
    const saved = progressFor(record.review_id);
    els.decision.value = saved.decision || "";
    els.notes.value = saved.notes || "";
    els.evidenceStatus.textContent = "Evidence is not loaded until requested.";
    els.preview.innerHTML = "";
    refreshListState(previousReviewId);
    const panel = document.querySelector(".review-panel");
    if (panel) panel.scrollTo({ top: 0 });
    updateExportStatus();
    updateReviewNavigation();
    updateSaveStatus(saved.updatedAt ? `Autosaved locally: ${formatLocalTime(saved.updatedAt)}` : undefined);
    window.dispatchEvent(new CustomEvent("masics:record-change", { detail: { record } }));
  }

  function releasePreview() {
    if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = "";
    if (els.preview) els.preview.innerHTML = "";
  }

  async function loadEvidence() {
    if (!active) return;
    releasePreview();
    els.evidenceStatus.textContent = "Checking Dropbox metadata...";
    try {
      const locators = evidenceLocators(active);
      const locator = await metadataFirst(locators);
      els.evidenceStatus.textContent = "Loading evidence preview...";
      if (isStreamPreviewRecord(active)) {
        const link = await temporaryLinkFirst([locator, locators]);
        renderStreamPreview(link, active);
        els.evidenceStatus.textContent = "Evidence preview loaded from Dropbox. No file was saved to this device.";
        return;
      }
      const response = await dropboxDownload(locator);
      const blob = previewBlob(await response.blob(), active);
      activeObjectUrl = URL.createObjectURL(blob);
      renderPreview(blob, activeObjectUrl, active);
      els.evidenceStatus.textContent = "Evidence loaded from Dropbox for this record only.";
    } catch (err) {
      els.evidenceStatus.textContent = err.message || "Unable to load evidence.";
    }
  }

  function renderPreview(blob, url, record) {
    const ext = fileExtension(record);
    els.preview.innerHTML = "";
    if (blob.type.startsWith("image/") || [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = record.filename;
      els.preview.appendChild(img);
    } else if (blob.type === "application/pdf" || ext === ".pdf") {
      const shell = document.createElement("div");
      shell.className = "preview-pdf";
      const frame = document.createElement("iframe");
      frame.src = url;
      frame.title = record.filename;
      const open = document.createElement("a");
      open.className = "preview-open";
      open.href = url;
      open.target = "_blank";
      open.rel = "noopener";
      open.textContent = "Open PDF";
      shell.append(frame, open);
      els.preview.appendChild(shell);
    } else if (blob.type.startsWith("audio/") || [".mp3", ".wav", ".m4a", ".aac", ".ogg"].includes(ext)) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = url;
      els.preview.appendChild(audio);
    } else if (blob.type.startsWith("video/") || [".mp4", ".mov", ".m4v", ".webm"].includes(ext)) {
      const video = document.createElement("video");
      video.controls = true;
      video.src = url;
      els.preview.appendChild(video);
    } else if (blob.type.startsWith("text/") || [".txt", ".csv", ".json", ".md"].includes(ext)) {
      blob.text().then((text) => {
        const pre = document.createElement("pre");
        pre.textContent = text.slice(0, 200000);
        els.preview.appendChild(pre);
      });
    } else {
      const message = document.createElement("p");
      message.textContent = "Preview is unavailable for this file type. No file was downloaded.";
      els.preview.appendChild(message);
    }
  }

  function renderStreamPreview(url, record) {
    const ext = fileExtension(record);
    els.preview.innerHTML = "";
    if ([".mp3", ".wav", ".m4a", ".aac", ".ogg"].includes(ext)) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = url;
      els.preview.appendChild(audio);
    } else if ([".mp4", ".mov", ".m4v", ".webm"].includes(ext)) {
      const video = document.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      video.src = url;
      els.preview.appendChild(video);
    }
  }

  function fileExtension(record) {
    const fromExtension = String(record.extension || "").trim().toLowerCase();
    if (fromExtension) return fromExtension.startsWith(".") ? fromExtension : `.${fromExtension}`;
    const fromType = String(record.file_type || "").trim().toLowerCase();
    if (fromType && !fromType.includes("/") && !fromType.startsWith(".")) return `.${fromType}`;
    const fromName = String(record.filename || "").trim().toLowerCase().match(/\.[a-z0-9]{1,8}$/);
    return fromName ? fromName[0] : "";
  }

  function previewBlob(blob, record) {
    const ext = fileExtension(record);
    const type = previewTypes[ext] || blob.type || "application/octet-stream";
    if (blob.type === type) return blob;
    return new Blob([blob], { type });
  }

  function isStreamPreviewRecord(record) {
    const ext = fileExtension(record);
    return [".mp3", ".wav", ".m4a", ".aac", ".ogg"].includes(ext) || [".mp4", ".mov", ".m4v", ".webm"].includes(ext);
  }

  function taggedRows(progress) {
    const decisions = progress.decisions || {};
    return records.map((record) => {
      const saved = decisions[record.review_id] || {};
      if (!saved.decision || saved.decision === "delete") return null;
      return {
        queue_number: record.queue_number,
        filename: record.filename,
        review_id: record.review_id,
        file_type: record.file_type || record.extension || "",
        decision: saved.decision || "",
        notes: saved.notes || "",
        updated_at: saved.updatedAt || "",
        dropbox_path: record.dropbox_path || ""
      };
    }).filter(Boolean);
  }

  function buildOnlinePayload() {
    const progress = loadProgress();
    const exportedAt = new Date().toISOString();
    const tagged = taggedRows(progress);
    return {
      schema: "MASICS_MARIO_ONLINE_REVIEW_PROGRESS_V1",
      queueIdentity: cfg.queueIdentity,
      queueVersion: cfg.queueVersion,
      exportedAt,
      source: "github-pages-cloud-viewer",
      reviewer: "Mario",
      userAgent: navigator.userAgent,
      url: location.href,
      total: records.length,
      reviewed: tagged.length,
      pending: Math.max(0, records.length - tagged.length),
      decisions: progress.decisions || {},
      tagged
    };
  }

  function progressDropboxBase() {
    return String(cfg.progressDropboxFolder || "").replace(/\/+$/g, "");
  }

  async function resolvedProgressDropboxBase() {
    if (cfg.progressDropboxFolderId) {
      try {
        const metadata = await dropboxRpc("files/get_metadata", { path: cfg.progressDropboxFolderId, include_media_info: false, include_deleted: false });
        if (metadata && metadata.path_display) return String(metadata.path_display).replace(/\/+$/g, "");
      } catch (err) {
        if (!isLookupError(err)) throw err;
      }
    }
    return progressDropboxBase();
  }

  async function saveOnline() {
    if (!token) throw new Error("Sign in with Dropbox before saving online.");
    if (!records.length) throw new Error("The queue is not loaded yet.");
    const base = await resolvedProgressDropboxBase();
    if (!base) throw new Error("Online progress folder is not configured.");
    const payload = buildOnlinePayload();
    const text = JSON.stringify(payload, null, 2);
    const stamp = payload.exportedAt.replace(/[:.]/g, "-");
    const latestPath = `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`;
    const snapshotPath = `${base}/MASICS_MARIO_REVIEW_PROGRESS_${stamp}.json`;
    els.saveOnline.disabled = true;
    updateSaveStatus("Saving online...");
    try {
      await dropboxUpload(latestPath, text, "overwrite");
      await dropboxUpload(snapshotPath, text, "add");
      markSyncedOnline(payload.exportedAt);
      setStatus(`Saved online. Reviewed: ${payload.reviewed}. Pending: ${payload.pending}.`);
    } finally {
      els.saveOnline.disabled = false;
    }
  }

  function downloadProgress(prefix = "masics-progress") {
    const progress = loadProgress();
    const exportedAt = new Date().toISOString();
    progress.exportedAt = exportedAt;
    const blob = new Blob([JSON.stringify(progress, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${prefix}-${cfg.queueIdentity}-${exportedAt.replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
    window.localStorage.setItem(exportStampKey(), exportedAt);
    updateExportStatus();
  }

  function exportProgress() {
    downloadProgress("masics-progress");
  }

  async function importProgress(file) {
    const text = await file.text();
    let imported;
    try {
      imported = JSON.parse(text);
    } catch {
      throw new Error("Progress import is not valid JSON.");
    }
    if (!imported || imported.queueIdentity !== cfg.queueIdentity || typeof imported.decisions !== "object") {
      throw new Error("Progress import does not match this queue.");
    }
    for (const id of Object.keys(imported.decisions)) {
      if (!records.some((record) => record.review_id === id)) throw new Error("Progress import contains an unknown review ID.");
      const value = imported.decisions[id];
      if (typeof value !== "object" || /<script|javascript:/i.test(JSON.stringify(value))) throw new Error("Progress import contains unsafe values.");
    }
    saveProgress(imported);
    markSaved(imported.exportedAt || new Date().toISOString());
    if (active) showRecord(active);
    setStatus("Progress import completed.");
  }

  function wireEvents() {
    els.signIn.addEventListener("click", () => {
      signIn().catch((err) => {
        setStatus(describeNetworkError("sign-in start", err));
      });
    });
    els.signOut.addEventListener("click", () => {
      downloadProgress("masics-progress-backup-before-signout");
      clearAuth();
      manifest = null;
      records = [];
      active = null;
      els.signIn.hidden = false;
      els.signOut.hidden = true;
      els.view.hidden = true;
      els.empty.hidden = false;
      els.empty.textContent = "Signed out. Sign in with Dropbox to load the protected queue.";
      els.list.innerHTML = "";
      if (els.counts) els.counts.textContent = "0 loaded";
      updateReviewNavigation();
      setStatus("Signed out.");
    });
    els.search.addEventListener("input", selectVisibleRecordAfterFilter);
    els.filter.addEventListener("change", selectVisibleRecordAfterFilter);
    if (els.jumpActive) els.jumpActive.addEventListener("click", scrollActiveIntoView);
    if (els.previousRecord) els.previousRecord.addEventListener("click", () => selectRecordAt(activeIndex() - 1));
    if (els.nextRecord) els.nextRecord.addEventListener("click", () => selectRecordAt(activeIndex() + 1));
    if (els.nextPending) els.nextPending.addEventListener("click", selectNextPending);
    if (els.nextPendingTop) els.nextPendingTop.addEventListener("click", selectNextPending);
    els.load.addEventListener("click", loadEvidence);
    const saveDecisionFromControls = () => active && setProgressFor(active.review_id, { decision: els.decision.value, notes: els.notes.value });
    els.decision.addEventListener("change", saveDecisionFromControls);
    els.decision.addEventListener("input", saveDecisionFromControls);
    els.notes.addEventListener("input", () => active && setProgressFor(active.review_id, { decision: els.decision.value, notes: els.notes.value }));
    els.saveOnline.addEventListener("click", () => saveOnline().catch((err) => updateSaveStatus(err.message || "Online save failed.")));
    els.exportProgress.addEventListener("click", exportProgress);
    els.importProgress.addEventListener("change", async () => {
      if (!els.importProgress.files.length) return;
      try {
        await importProgress(els.importProgress.files[0]);
      } catch (err) {
        alert(err.message);
      } finally {
        els.importProgress.value = "";
      }
    });
    els.resetProgress.addEventListener("click", () => {
      if (confirm("Reset progress stored in this browser for this queue?")) {
        window.localStorage.removeItem(progressKey());
        window.localStorage.removeItem(saveStampKey());
        window.localStorage.removeItem(onlineSyncStampKey());
        updateSaveStatus("Autosave reset");
        if (active) showRecord(active);
      }
    });
  }

  async function init() {
    wireEvents();
    updateExportStatus();
    updateSaveStatus();
    requestPersistentStorage();
    try {
      const handled = await handleCallback();
      if (token || handled) {
        if (handled && authStore.getItem("masics_auth_return_to") === "tracker") {
          authStore.removeItem("masics_auth_return_to");
          window.location.replace("tracker.html");
          return;
        }
        els.signIn.hidden = true;
        els.signOut.hidden = false;
        setStatus("Dropbox sign-in complete. Loading protected queue manifest...");
        try {
          await loadManifest();
        } catch (err) {
          clearAuth();
          els.signIn.hidden = false;
          els.signOut.hidden = true;
          els.view.hidden = true;
          els.empty.hidden = false;
          els.empty.textContent = "Dropbox sign-in did not finish loading the protected queue. Try Sign in with Dropbox again.";
          throw new Error(describeNetworkError("queue load", err));
        }
      }
    } catch (err) {
      setStatus(describeNetworkError("sign-in", err));
    }
  }

  init();
})();
