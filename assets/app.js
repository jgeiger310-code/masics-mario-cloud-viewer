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

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $("status-line"),
    signIn: $("sign-in"),
    signOut: $("sign-out"),
    search: $("search"),
    filter: $("filter"),
    list: $("queue-list"),
    empty: $("empty-state"),
    view: $("record-view"),
    pos: $("record-position"),
    title: $("record-title"),
    meta: $("record-meta"),
    decision: $("decision"),
    notes: $("notes"),
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

  function escapeText(value) {
    return String(value || "");
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

  function progressFor(id) {
    const progress = loadProgress();
    return progress.decisions[id] || { decision: "", notes: "", updatedAt: "" };
  }

  function setProgressFor(id, patch) {
    const progress = loadProgress();
    const savedAt = new Date().toISOString();
    progress.decisions[id] = { ...(progress.decisions[id] || {}), ...patch, updatedAt: savedAt };
    saveProgress(progress);
    markSaved(savedAt);
    renderList();
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
    window.location.assign(`${DROPBOX_AUTH}?${params.toString()}`);
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
    const response = await fetch(DROPBOX_TOKEN, {
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

  function isLookupError(err) {
    const message = String(err && err.message || "");
    return /missing|moved|not_found|malformed_path|lookup/i.test(message);
  }

  async function dropboxRpc(endpoint, body) {
    const response = await fetch(DROPBOX_RPC + endpoint, {
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
    const response = await fetch(DROPBOX_CONTENT + "files/download", {
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

  async function dropboxUpload(path, text, mode = "overwrite") {
    const response = await fetch(DROPBOX_CONTENT + "files/upload", {
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
    setStatus(`Loaded ${records.length} protected queue records. Pending: ${loaded.pending_count}. Reviewed: ${loaded.reviewed_count}.`);
    updateSaveStatus();
    renderList();
  }

  function validateManifest(loaded) {
    if (!loaded || loaded.schema !== cfg.queueVersion) throw new Error("Queue manifest version mismatch.");
    if (loaded.queue_identity !== cfg.queueIdentity) throw new Error("Queue manifest identity mismatch.");
    if (!Array.isArray(loaded.records)) throw new Error("Queue manifest records are malformed.");
    if (loaded.records.length !== cfg.expectedRecordCount) throw new Error("Queue manifest record count mismatch.");
    if (loaded.reviewed_count !== 0 || loaded.pending_count !== cfg.expectedRecordCount) throw new Error("Queue manifest contains initial decisions.");
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
      const reviewed = Boolean(saved.decision || saved.notes);
      if (els.filter.value === "pending" && reviewed) return false;
      if (els.filter.value === "reviewed" && !reviewed) return false;
      if (!q) return true;
      return [record.filename, record.review_id, record.display?.mfr_request_ids].some((v) => String(v || "").toLowerCase().includes(q));
    });
  }

  function renderList() {
    els.list.innerHTML = "";
    filteredRecords().forEach((record) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = active && active.review_id === record.review_id ? "active" : "";
      button.textContent = `${record.queue_number}. ${record.filename}`;
      button.addEventListener("click", () => showRecord(record));
      item.appendChild(button);
      els.list.appendChild(item);
    });
  }

  function showRecord(record) {
    active = record;
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
    renderList();
    updateExportStatus();
    updateSaveStatus(saved.updatedAt ? `Autosaved locally: ${formatLocalTime(saved.updatedAt)}` : undefined);
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
      const locators = uniqueLocators([active.dropbox_file_id, active.dropbox_path, active.dropbox_path_alternates || []]);
      const locator = await metadataFirst(locators);
      els.evidenceStatus.textContent = "Loading evidence preview...";
      const response = await dropboxDownload(locator);
      const blob = await response.blob();
      activeObjectUrl = URL.createObjectURL(blob);
      renderPreview(blob, activeObjectUrl, active);
      els.evidenceStatus.textContent = "Evidence loaded from Dropbox for this record only.";
    } catch (err) {
      els.evidenceStatus.textContent = err.message || "Unable to load evidence.";
    }
  }

  function renderPreview(blob, url, record) {
    const ext = String(record.extension || "").toLowerCase();
    els.preview.innerHTML = "";
    if (blob.type.startsWith("image/") || [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = record.filename;
      els.preview.appendChild(img);
    } else if (blob.type === "application/pdf" || ext === ".pdf") {
      const frame = document.createElement("iframe");
      frame.src = url;
      frame.title = record.filename;
      els.preview.appendChild(frame);
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

  function taggedRows(progress) {
    const decisions = progress.decisions || {};
    return records.map((record) => {
      const saved = decisions[record.review_id] || {};
      if (!(saved.decision || saved.notes)) return null;
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

  async function saveOnline() {
    if (!token) throw new Error("Sign in with Dropbox before saving online.");
    if (!records.length) throw new Error("The queue is not loaded yet.");
    const base = progressDropboxBase();
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
    els.signIn.addEventListener("click", signIn);
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
      setStatus("Signed out.");
    });
    els.search.addEventListener("input", renderList);
    els.filter.addEventListener("change", renderList);
    els.load.addEventListener("click", loadEvidence);
    els.decision.addEventListener("change", () => active && setProgressFor(active.review_id, { decision: els.decision.value, notes: els.notes.value }));
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
        els.signIn.hidden = true;
        els.signOut.hidden = false;
        setStatus("Dropbox sign-in complete. Loading protected queue manifest...");
        await loadManifest();
      }
    } catch (err) {
      setStatus(err.message);
    }
  }

  init();
})();
