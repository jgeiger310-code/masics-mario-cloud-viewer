(() => {
  "use strict";

  const VERSION = "20260713-save-safety-scalability-1";
  const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
  const MAX_SAVE_ATTEMPTS = 3;
  const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const cfg = window.MASICS_DROPBOX_CONFIG;
  const progressKey = `masics_cloud_progress:${cfg.queueIdentity}`;
  const lastSnapshotKey = `${progressKey}:last_checkpoint_snapshot_at`;
  const safetyDbName = "masics-review-safety";
  const safetyStoreName = "progress";

  let manifestCache = null;
  let savePromise = null;

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function setSaveStatus(message) {
    const element = $("save-status");
    if (element) element.textContent = message;
  }

  function setPageStatus(message) {
    const element = $("status-line");
    if (element) element.textContent = message;
  }

  function token() {
    return window.sessionStorage.getItem("masics_access_token") || "";
  }

  function uniqueLocators(values) {
    const seen = new Set();
    return values.flat().map((value) => String(value || "").trim()).filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function isLookupError(error) {
    return /missing|moved|not_found|malformed_path|lookup/i.test(String(error?.message || error || ""));
  }

  function isConflictError(error) {
    return error?.code === "dropbox_conflict" || /conflict/i.test(String(error?.message || error || ""));
  }

  function isTransientError(error) {
    return /Failed to fetch|NetworkError|Load failed|429|500|502|503|504/i.test(String(error?.message || error || ""));
  }

  async function fetchWithRetry(url, options) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await fetch(url, options);
      } catch (error) {
        lastError = error;
        if (!isTransientError(error)) throw error;
        await sleep(500 * (attempt + 1));
      }
    }
    throw lastError || new Error("Dropbox request failed before it could start.");
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
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign in again before saving.");
    if (response.status === 403) throw new Error("Dropbox did not allow access to the protected review folder.");
    if (response.status === 409) {
      const error = new Error("Dropbox lookup conflict.");
      error.code = "dropbox_conflict";
      throw error;
    }
    if (!response.ok) throw new Error(`Dropbox request failed: ${response.status}`);
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
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign in again before saving.");
    if (response.status === 403) throw new Error("Dropbox did not allow access to the protected review folder.");
    if (response.status === 409) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Dropbox file is missing or moved: ${locator} ${detail.slice(0, 160)}`);
    }
    if (!response.ok) throw new Error(`Dropbox download failed: ${response.status}`);
    return response;
  }

  async function dropboxUpload(path, text, mode) {
    const response = await fetchWithRetry(DROPBOX_CONTENT + "files/upload", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token()}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({
          path,
          mode,
          autorename: false,
          mute: true,
          strict_conflict: true
        })
      },
      body: text
    });
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign in again before saving.");
    if (response.status === 403) throw new Error("Dropbox did not allow online saving in the protected review folder.");
    if (response.status === 409) {
      const detail = await response.text().catch(() => "");
      const error = new Error(`Dropbox revision conflict. ${detail.slice(0, 180)}`);
      error.code = "dropbox_conflict";
      throw error;
    }
    if (!response.ok) throw new Error(`Dropbox online save failed: ${response.status}`);
    return response.json();
  }

  function metadataFromDownload(response) {
    try {
      return JSON.parse(response.headers.get("Dropbox-API-Result") || "{}");
    } catch {
      return {};
    }
  }

  async function downloadFirst(locators) {
    let lastError = null;
    for (const locator of uniqueLocators(locators)) {
      try {
        return await dropboxDownload(locator);
      } catch (error) {
        lastError = error;
        if (!isLookupError(error)) throw error;
      }
    }
    throw lastError || new Error("No Dropbox locator is available.");
  }

  async function resolvedProgressBase() {
    if (cfg.progressDropboxFolderId) {
      try {
        const metadata = await dropboxRpc("files/get_metadata", {
          path: cfg.progressDropboxFolderId,
          include_media_info: false,
          include_deleted: false
        });
        if (metadata?.path_display) return String(metadata.path_display).replace(/\/+$/g, "");
      } catch (error) {
        if (!isLookupError(error) && !isConflictError(error)) throw error;
      }
    }
    return String(cfg.progressDropboxFolder || "").replace(/\/+$/g, "");
  }

  async function loadManifestRecords() {
    if (manifestCache) return manifestCache;
    const response = await downloadFirst([
      cfg.manifestDropboxPath,
      cfg.manifestDropboxPathAlternates || []
    ]);
    const manifest = await response.json();
    if (!manifest || manifest.schema !== cfg.queueVersion || manifest.queue_identity !== cfg.queueIdentity || !Array.isArray(manifest.records)) {
      throw new Error("The protected queue manifest failed safety validation.");
    }
    manifestCache = manifest.records;
    return manifestCache;
  }

  function loadLocalProgress() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(progressKey) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function hasReviewValue(value) {
    return Boolean(value && (String(value.decision || "") || String(value.notes || "").trim()));
  }

  function updatedAt(value) {
    const time = Date.parse(value || "");
    return Number.isFinite(time) ? time : 0;
  }

  function normalizeDecision(value) {
    const allowed = new Set(["", "responsive", "nonresponsive", "missing", "privileged", "needs_review", "duplicate", "delete"]);
    const decision = String(value?.decision || "");
    return {
      decision: allowed.has(decision) ? decision : "",
      notes: String(value?.notes || ""),
      updatedAt: String(value?.updatedAt || "")
    };
  }

  function shouldReplace(current, candidate) {
    if (String(current?.decision || "") === "delete" && String(candidate?.decision || "") !== "delete") return false;
    if (String(current?.decision || "") && !String(candidate?.decision || "")) return false;
    const currentHasValue = hasReviewValue(current);
    const candidateHasValue = hasReviewValue(candidate);
    if (currentHasValue && !candidateHasValue) return false;
    if (!currentHasValue && candidateHasValue) return true;
    return updatedAt(candidate?.updatedAt) >= updatedAt(current?.updatedAt);
  }

  function mergeDecisions(remoteDecisions, localDecisions) {
    const merged = {};
    Object.entries(remoteDecisions || {}).forEach(([reviewId, value]) => {
      if (value && typeof value === "object" && hasReviewValue(value)) merged[reviewId] = normalizeDecision(value);
    });
    Object.entries(localDecisions || {}).forEach(([reviewId, value]) => {
      if (!value || typeof value !== "object" || !hasReviewValue(value)) return;
      const candidate = normalizeDecision(value);
      const current = merged[reviewId] || {};
      if (shouldReplace(current, candidate)) merged[reviewId] = candidate;
    });
    return merged;
  }

  function filterKnownDecisions(decisions, records) {
    const known = new Set(records.map((record) => record.review_id));
    const filtered = {};
    Object.entries(decisions || {}).forEach(([reviewId, value]) => {
      if (known.has(reviewId) && value && typeof value === "object" && hasReviewValue(value)) {
        filtered[reviewId] = normalizeDecision(value);
      }
    });
    return filtered;
  }

  async function loadRemoteProgress(base) {
    const locators = uniqueLocators([
      cfg.progressDropboxLatestJsonId,
      `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`,
      (cfg.progressDropboxFolderAlternates || []).map((folder) => `${String(folder || "").replace(/\/+$/g, "")}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`)
    ]);
    let lastError = null;
    for (const locator of locators) {
      try {
        const response = await dropboxDownload(locator);
        const metadata = metadataFromDownload(response);
        const payload = await response.json();
        if (!payload || payload.queueIdentity !== cfg.queueIdentity || typeof payload.decisions !== "object") {
          throw new Error("Online progress does not match this protected queue.");
        }
        return { payload, rev: String(metadata.rev || "") };
      } catch (error) {
        lastError = error;
        if (!isLookupError(error)) throw error;
      }
    }
    if (lastError) throw lastError;
    return { payload: null, rev: "" };
  }

  function buildTaggedRows(records, decisions) {
    return records.map((record) => {
      const saved = decisions[record.review_id] || {};
      if (!hasReviewValue(saved) || saved.decision === "delete") return null;
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

  function buildPayload(records, decisions, previousOnlineExportedAt) {
    const exportedAt = new Date().toISOString();
    const tagged = buildTaggedRows(records, decisions);
    const excluded = Object.values(decisions).filter((value) => value?.decision === "delete").length;
    return {
      schema: "MASICS_MARIO_ONLINE_REVIEW_PROGRESS_V1",
      queueIdentity: cfg.queueIdentity,
      queueVersion: cfg.queueVersion,
      exportedAt,
      previousOnlineExportedAt: previousOnlineExportedAt || "",
      source: "github-pages-cloud-viewer",
      reviewer: window.localStorage.getItem("masics_reviewer_name") || "Mario",
      userAgent: navigator.userAgent,
      url: location.href,
      total: records.length,
      reviewed: tagged.length,
      pending: Math.max(0, records.length - tagged.length - excluded),
      excluded,
      decisions,
      tagged,
      saveSafetyVersion: VERSION
    };
  }

  function saveLocalProgress(payload) {
    const localPayload = {
      queueIdentity: cfg.queueIdentity,
      decisions: payload.decisions,
      exportedAt: payload.exportedAt
    };
    window.localStorage.setItem(progressKey, JSON.stringify(localPayload));
  }

  function putIndexedDbBackup(payload) {
    return new Promise((resolve) => {
      if (!window.indexedDB) {
        resolve(false);
        return;
      }
      let request;
      try {
        request = window.indexedDB.open(safetyDbName, 1);
      } catch {
        resolve(false);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(safetyStoreName)) db.createObjectStore(safetyStoreName);
      };
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(safetyStoreName, "readwrite");
        transaction.objectStore(safetyStoreName).put(payload, cfg.queueIdentity);
        transaction.oncomplete = () => {
          db.close();
          resolve(true);
        };
        transaction.onerror = () => {
          db.close();
          resolve(false);
        };
      };
    });
  }

  function getIndexedDbBackup() {
    return new Promise((resolve) => {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }
      const request = window.indexedDB.open(safetyDbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(safetyStoreName)) db.createObjectStore(safetyStoreName);
      };
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(safetyStoreName, "readonly");
        const getRequest = transaction.objectStore(safetyStoreName).get(cfg.queueIdentity);
        getRequest.onsuccess = () => resolve(getRequest.result || null);
        getRequest.onerror = () => resolve(null);
        transaction.oncomplete = () => db.close();
      };
    });
  }

  function shouldCreateSnapshot(manualSave) {
    if (manualSave) return true;
    const previous = Date.parse(window.localStorage.getItem(lastSnapshotKey) || "");
    return !Number.isFinite(previous) || Date.now() - previous >= SNAPSHOT_INTERVAL_MS;
  }

  async function saveSafely(manualSave) {
    if (!token()) throw new Error("Sign in with Dropbox before saving online.");
    const button = $("save-online");
    if (button) button.disabled = true;
    setSaveStatus("Saving online with safety merge...");

    try {
      const records = await loadManifestRecords();
      const base = await resolvedProgressBase();
      if (!base) throw new Error("Online progress folder is not configured.");
      const latestPath = `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`;

      let lastError = null;
      for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt += 1) {
        try {
          const remote = await loadRemoteProgress(base);
          const local = loadLocalProgress();
          const merged = filterKnownDecisions(
            mergeDecisions(remote.payload?.decisions || {}, local.decisions || {}),
            records
          );
          const payload = buildPayload(records, merged, remote.payload?.exportedAt || "");
          const text = JSON.stringify(payload, null, 2);

          saveLocalProgress(payload);
          await putIndexedDbBackup(payload);

          const updateMode = remote.rev
            ? { ".tag": "update", update: remote.rev }
            : { ".tag": "overwrite" };
          await dropboxUpload(latestPath, text, updateMode);

          let snapshotWarning = "";
          if (shouldCreateSnapshot(manualSave)) {
            const stamp = payload.exportedAt.replace(/[:.]/g, "-");
            const snapshotPath = `${base}/checkpoints/MASICS_MARIO_REVIEW_PROGRESS_${stamp}.json`;
            try {
              await dropboxUpload(snapshotPath, text, { ".tag": "add" });
              window.localStorage.setItem(lastSnapshotKey, payload.exportedAt);
            } catch (error) {
              snapshotWarning = ` Checkpoint backup failed: ${error.message || error}`;
            }
          }

          const localTime = new Date(payload.exportedAt).toLocaleString();
          setSaveStatus(`Saved online: ${localTime}. Reviewed ${payload.reviewed}; pending ${payload.pending}.${snapshotWarning}`);
          setPageStatus(`Saved online safely. Reviewed: ${payload.reviewed}. Pending: ${payload.pending}. Excluded: ${payload.excluded}.`);
          return payload;
        } catch (error) {
          lastError = error;
          if (!isConflictError(error) || attempt === MAX_SAVE_ATTEMPTS) throw error;
          setSaveStatus(`Another device saved first. Merging again (${attempt + 1}/${MAX_SAVE_ATTEMPTS})...`);
          await sleep(350 * attempt);
        }
      }
      throw lastError || new Error("Online save did not complete.");
    } finally {
      if (button) button.disabled = false;
    }
  }

  function installRenderingContainment() {
    if ($("masics-rendering-containment")) return;
    const style = document.createElement("style");
    style.id = "masics-rendering-containment";
    style.textContent = `
      .queue-list { contain: layout style paint; }
      .queue-list > li { content-visibility: auto; contain-intrinsic-size: 52px; }
    `;
    document.head.appendChild(style);
  }

  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("#save-online");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    if (savePromise) {
      setSaveStatus("Saving online with safety merge...");
      return;
    }

    savePromise = saveSafely(Boolean(event.isTrusted))
      .catch((error) => {
        const message = error?.message || "Online save failed.";
        setSaveStatus(`SAVE FAILED: ${message}`);
        setPageStatus(`Online save failed. Stay on this record and try Save Online again. ${message}`);
      })
      .finally(() => {
        savePromise = null;
      });
  }, true);

  window.addEventListener("beforeunload", (event) => {
    if (!savePromise) return;
    event.preventDefault();
    event.returnValue = "A protected review save is still in progress.";
  });

  window.MASICS_SAVE_SAFETY_RECOVER_LOCAL = async () => {
    const payload = await getIndexedDbBackup();
    if (!payload || payload.queueIdentity !== cfg.queueIdentity || typeof payload.decisions !== "object") return false;
    saveLocalProgress(payload);
    return true;
  };

  installRenderingContainment();
  window.MASICS_SAVE_SAFETY_VERSION = VERSION;
})();