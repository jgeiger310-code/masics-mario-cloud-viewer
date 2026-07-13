(() => {
  "use strict";

  const VERSION = "20260713-save-safety-scalability-2";
  const CHECKPOINT_INTERVAL_MS = 15 * 60 * 1000;
  const MAX_SAVE_ATTEMPTS = 3;
  const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const cfg = window.MASICS_DROPBOX_CONFIG;
  const progressKey = `masics_cloud_progress:${cfg.queueIdentity}`;
  const checkpointKey = `${progressKey}:last_checkpoint_at`;
  const safetyDbName = "masics-review-safety";
  const safetyStoreName = "progress";

  let manifestRecords = null;
  let savePromise = null;

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function authToken() {
    return window.sessionStorage.getItem("masics_access_token") || "";
  }

  function setSaveStatus(message) {
    const element = $("save-status");
    if (element) element.textContent = message;
  }

  function setPageStatus(message) {
    const element = $("status-line");
    if (element) element.textContent = message;
  }

  function unique(values) {
    const seen = new Set();
    return values.flat().map((value) => String(value || "").trim()).filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function errorText(error) {
    return String(error?.message || error || "");
  }

  function isLookupError(error) {
    return /missing|moved|not_found|malformed_path|lookup/i.test(errorText(error));
  }

  function isConflictError(error) {
    return error?.code === "dropbox_conflict" || /conflict/i.test(errorText(error));
  }

  function isTransientError(error) {
    return /Failed to fetch|NetworkError|Load failed|429|500|502|503|504/i.test(errorText(error));
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

  async function rpc(endpoint, body) {
    const response = await fetchWithRetry(DROPBOX_RPC + endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${authToken()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {})
    });
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign in again before saving.");
    if (response.status === 403) throw new Error("Dropbox denied access to the protected review folder.");
    if (response.status === 409) {
      const error = new Error("Dropbox lookup conflict.");
      error.code = "dropbox_conflict";
      throw error;
    }
    if (!response.ok) throw new Error(`Dropbox request failed: ${response.status}`);
    return response.json();
  }

  async function download(locator) {
    const response = await fetchWithRetry(DROPBOX_CONTENT + "files/download", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${authToken()}`,
        "Dropbox-API-Arg": JSON.stringify({ path: locator })
      }
    });
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign in again before saving.");
    if (response.status === 403) throw new Error("Dropbox denied access to the protected review folder.");
    if (response.status === 409) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Dropbox file is missing or moved: ${locator} ${detail.slice(0, 160)}`);
    }
    if (!response.ok) throw new Error(`Dropbox download failed: ${response.status}`);
    return response;
  }

  async function upload(path, text, mode) {
    const response = await fetchWithRetry(DROPBOX_CONTENT + "files/upload", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${authToken()}`,
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

  function downloadMetadata(response) {
    try {
      return JSON.parse(response.headers.get("Dropbox-API-Result") || "{}");
    } catch {
      return {};
    }
  }

  async function downloadFirst(locators) {
    let lastError = null;
    for (const locator of unique(locators)) {
      try {
        return await download(locator);
      } catch (error) {
        lastError = error;
        if (!isLookupError(error)) throw error;
      }
    }
    throw lastError || new Error("No Dropbox locator is available.");
  }

  async function progressBase() {
    if (cfg.progressDropboxFolderId) {
      try {
        const metadata = await rpc("files/get_metadata", {
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

  async function records() {
    if (manifestRecords) return manifestRecords;
    const response = await downloadFirst([
      cfg.manifestDropboxPath,
      cfg.manifestDropboxPathAlternates || []
    ]);
    const manifest = await response.json();
    if (!manifest || manifest.schema !== cfg.queueVersion || manifest.queue_identity !== cfg.queueIdentity || !Array.isArray(manifest.records)) {
      throw new Error("The protected queue manifest failed safety validation.");
    }
    manifestRecords = manifest.records;
    return manifestRecords;
  }

  function loadLocal() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(progressKey) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function hasValue(value) {
    return Boolean(value && (String(value.decision || "") || String(value.notes || "").trim()));
  }

  function updatedAt(value) {
    const time = Date.parse(value || "");
    return Number.isFinite(time) ? time : 0;
  }

  function normalize(value) {
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
    if (hasValue(current) && !hasValue(candidate)) return false;
    if (!hasValue(current) && hasValue(candidate)) return true;
    return updatedAt(candidate?.updatedAt) >= updatedAt(current?.updatedAt);
  }

  function merge(remoteDecisions, localDecisions, knownRecords) {
    const known = new Set(knownRecords.map((record) => record.review_id));
    const merged = {};
    Object.entries(remoteDecisions || {}).forEach(([reviewId, value]) => {
      if (known.has(reviewId) && value && typeof value === "object" && hasValue(value)) merged[reviewId] = normalize(value);
    });
    Object.entries(localDecisions || {}).forEach(([reviewId, value]) => {
      if (!known.has(reviewId) || !value || typeof value !== "object" || !hasValue(value)) return;
      const candidate = normalize(value);
      if (shouldReplace(merged[reviewId] || {}, candidate)) merged[reviewId] = candidate;
    });
    return merged;
  }

  async function remoteProgress(base) {
    const locators = unique([
      cfg.progressDropboxLatestJsonId,
      `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`,
      (cfg.progressDropboxFolderAlternates || []).map((folder) => `${String(folder || "").replace(/\/+$/g, "")}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`)
    ]);
    let lastError = null;
    for (const locator of locators) {
      try {
        const response = await download(locator);
        const metadata = downloadMetadata(response);
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
    throw lastError || new Error("Online progress could not be loaded before saving.");
  }

  function buildPayload(knownRecords, decisions, previousExportedAt) {
    const exportedAt = new Date().toISOString();
    const tagged = knownRecords.map((record) => {
      const saved = decisions[record.review_id] || {};
      if (!hasValue(saved) || saved.decision === "delete") return null;
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
    const excluded = Object.values(decisions).filter((value) => value?.decision === "delete").length;
    return {
      schema: "MASICS_MARIO_ONLINE_REVIEW_PROGRESS_V1",
      queueIdentity: cfg.queueIdentity,
      queueVersion: cfg.queueVersion,
      exportedAt,
      previousOnlineExportedAt: previousExportedAt || "",
      source: "github-pages-cloud-viewer",
      reviewer: window.localStorage.getItem("masics_reviewer_name") || "Mario",
      userAgent: navigator.userAgent,
      url: location.href,
      total: knownRecords.length,
      reviewed: tagged.length,
      pending: Math.max(0, knownRecords.length - tagged.length - excluded),
      excluded,
      decisions,
      tagged,
      saveSafetyVersion: VERSION
    };
  }

  function saveLocal(payload) {
    window.localStorage.setItem(progressKey, JSON.stringify({
      queueIdentity: cfg.queueIdentity,
      decisions: payload.decisions,
      exportedAt: payload.exportedAt
    }));
  }

  function saveIndexedDb(payload) {
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve(false);
      const request = window.indexedDB.open(safetyDbName, 1);
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

  function checkpointDue(manualSave) {
    if (manualSave) return true;
    const previous = Date.parse(window.localStorage.getItem(checkpointKey) || "");
    return !Number.isFinite(previous) || Date.now() - previous >= CHECKPOINT_INTERVAL_MS;
  }

  async function safeSave(manualSave) {
    if (!authToken()) throw new Error("Sign in with Dropbox before saving online.");
    const button = $("save-online");
    if (button) button.disabled = true;
    setSaveStatus("Saving online with safety merge...");

    try {
      const knownRecords = await records();
      const base = await progressBase();
      if (!base) throw new Error("Online progress folder is not configured.");
      const latestPath = `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`;

      for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt += 1) {
        try {
          const remote = await remoteProgress(base);
          const local = loadLocal();
          const decisions = merge(remote.payload.decisions, local.decisions || {}, knownRecords);
          const payload = buildPayload(knownRecords, decisions, remote.payload.exportedAt || "");
          const text = JSON.stringify(payload, null, 2);

          saveLocal(payload);
          await saveIndexedDb(payload);

          const mode = remote.rev ? { ".tag": "update", update: remote.rev } : { ".tag": "overwrite" };
          await upload(latestPath, text, mode);

          let checkpointNote = "";
          if (checkpointDue(manualSave)) {
            const stamp = payload.exportedAt.replace(/[:.]/g, "-");
            const checkpointPath = `${base}/MASICS_MARIO_REVIEW_CHECKPOINT_${stamp}.json`;
            try {
              await upload(checkpointPath, text, { ".tag": "add" });
              window.localStorage.setItem(checkpointKey, payload.exportedAt);
            } catch (error) {
              checkpointNote = ` Latest progress is safe, but checkpoint creation failed: ${errorText(error)}`;
            }
          }

          const localTime = new Date(payload.exportedAt).toLocaleString();
          setSaveStatus(`Saved online: ${localTime}. Reviewed ${payload.reviewed}; pending ${payload.pending}.${checkpointNote}`);
          setPageStatus(`Saved online safely. Reviewed: ${payload.reviewed}. Pending: ${payload.pending}. Excluded: ${payload.excluded}.`);
          return payload;
        } catch (error) {
          if (!isConflictError(error) || attempt === MAX_SAVE_ATTEMPTS) throw error;
          setSaveStatus(`Another device saved first. Merging again (${attempt + 1}/${MAX_SAVE_ATTEMPTS})...`);
          await sleep(350 * attempt);
        }
      }
      throw new Error("Online save did not complete.");
    } finally {
      if (button) button.disabled = false;
    }
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

    savePromise = safeSave(Boolean(event.isTrusted))
      .catch((error) => {
        const message = errorText(error) || "Online save failed.";
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

  window.MASICS_SAVE_SAFETY_VERSION = VERSION;
})();
