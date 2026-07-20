(() => {
  "use strict";

  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
  const VERSION = "20260720-notes-10s-idle-1";
  const NOTES_BUFFERED_COMMIT_DELAY_MS = 0;
  const NOTES_FALLBACK_DELAY_MS = 10000;
  const DECISION_SAVE_DELAY_MS = 900;
  let timer = 0;
  let inFlight = false;
  let queued = false;
  let capturedMutation = null;

  window.MASICS_ONLINE_SAVE_MERGE_VERSION = VERSION;

  const cfg = () => window.MASICS_DROPBOX_CONFIG || {};
  const token = () => window.sessionStorage.getItem("masics_access_token") || "";
  const $ = (id) => document.getElementById(id);
  const text = (id) => String($(id)?.textContent || "").trim();
  const progressKey = () => `masics_cloud_progress:${cfg().queueIdentity}`;
  const stampKey = (name) => `${progressKey()}:${name}`;
  const dirtyKey = () => stampKey("dirty_unsynced");
  const dirtyPayloadKey = () => stampKey("dirty_unsynced_payload");
  const quarantineKey = () => stampKey("local_json_quarantine");

  function setSaveStatus(message) {
    const el = $("save-status");
    if (el) el.textContent = message;
  }

  function setTopStatus(message) {
    const el = $("status-line");
    if (el) el.textContent = message;
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function jsonHash(textValue) {
    let hash = 5381;
    const value = String(textValue || "");
    for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
    return `djb2-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function generationId(exportedAt, progressText) {
    return `masics-${String(exportedAt || "").replace(/[^0-9A-Za-z]/g, "-")}-${jsonHash(progressText)}`;
  }

  function isTransient(err) {
    return /Failed to fetch|NetworkError|Load failed/i.test(String(err && err.message || err || ""));
  }

  async function fetchWithRetry(url, options) {
    let last = null;
    for (let i = 0; i < 3; i += 1) {
      try { return await fetch(url, options); }
      catch (err) {
        last = err;
        if (!isTransient(err)) throw err;
        await delay(600 * (i + 1));
      }
    }
    throw last || new Error("Dropbox request failed before it could start.");
  }

  function unique(values) {
    const seen = new Set();
    return values.flat().map((value) => String(value || "").trim()).filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function baseFolder() {
    return String(cfg().progressDropboxFolder || "").replace(/\/+$/g, "");
  }

  async function rpc(endpoint, body) {
    const res = await fetchWithRetry(DROPBOX_RPC + endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    if (res.status === 409 || res.status === 404) return null;
    if (res.status === 401) throw new Error("Dropbox sign-in expired. Sign out and sign in again.");
    if (res.status === 403) throw new Error("Dropbox permission denied for the tracker folder.");
    if (!res.ok) throw new Error(`Dropbox metadata failed: ${res.status}`);
    return res.json();
  }

  async function resolvedBase() {
    if (cfg().progressDropboxFolderId) {
      const meta = await rpc("files/get_metadata", { path: cfg().progressDropboxFolderId, include_deleted: false });
      if (meta && meta.path_display) return String(meta.path_display).replace(/\/+$/g, "");
    }
    return baseFolder();
  }

  async function download(locator) {
    const res = await fetchWithRetry(DROPBOX_CONTENT + "files/download", {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Dropbox-API-Arg": JSON.stringify({ path: locator }) }
    });
    if (res.status === 409 || res.status === 404) return null;
    if (res.status === 401) throw new Error("Dropbox sign-in expired. Sign out and sign in again.");
    if (res.status === 403) throw new Error("Dropbox permission denied while reading tracker data.");
    if (!res.ok) throw new Error(`Dropbox read failed: ${res.status}`);
    return res;
  }

  async function upload(path, content, mode = "overwrite") {
    const modeArg = typeof mode === "object" ? mode : { ".tag": mode };
    const res = await fetchWithRetry(DROPBOX_CONTENT + "files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({ path, mode: modeArg, autorename: false, mute: true, strict_conflict: false })
      },
      body: content
    });
    if (res.status === 401) throw new Error("Dropbox sign-in expired. Sign out and sign in again.");
    if (res.status === 403) throw new Error("Dropbox did not allow online save. Mario needs edit access to the review folder.");
    if (res.status === 409) {
      const err = new Error("Dropbox write conflict: online progress changed while this save was preparing.");
      err.dropboxConflict = true;
      throw err;
    }
    if (!res.ok) throw new Error(`Dropbox write failed: ${res.status}`);
    return res.json();
  }

  async function loadManifest() {
    for (const locator of unique([cfg().manifestDropboxPath, cfg().manifestDropboxPathAlternates || []])) {
      const res = await download(locator);
      if (!res) continue;
      const json = await res.json();
      return Array.isArray(json.records) ? json.records : [];
    }
    throw new Error("Queue manifest could not be loaded from Dropbox.");
  }

  async function loadOnline(base) {
    const loaded = await loadOnlineWithMetadata(base);
    return loaded ? loaded.json : null;
  }

  async function loadOnlineWithMetadata(base) {
    const locators = unique([
      cfg().progressDropboxLatestJsonId,
      `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`,
      (cfg().progressDropboxFolderAlternates || []).map((folder) => `${String(folder || "").replace(/\/+$/g, "")}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`)
    ]);
    for (const locator of locators) {
      const res = await download(locator);
      if (!res) continue;
      const metaText = res.headers.get("dropbox-api-result") || "{}";
      const raw = await res.text();
      try {
        const json = JSON.parse(raw);
        const meta = JSON.parse(metaText);
        return { json, rev: meta.rev || "", locator, raw };
      } catch {
        window.localStorage.setItem(quarantineKey(), JSON.stringify({ locator, raw, quarantinedAt: new Date().toISOString() }));
        throw new Error("Online progress JSON was malformed. Raw content was quarantined locally and online state must be recovered before saving.");
      }
    }
    return null;
  }

  function localProgress() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(progressKey()) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      const raw = window.localStorage.getItem(progressKey()) || "";
      window.localStorage.setItem(quarantineKey(), JSON.stringify({ source: "localStorage", raw, quarantinedAt: new Date().toISOString() }));
      setSaveStatus("Local progress JSON looked damaged. It was quarantined locally; reload online state before continuing.");
      return {};
    }
  }

  function saveLocal(progress) {
    window.localStorage.setItem(progressKey(), JSON.stringify(progress));
  }

  function allowedDecision(value) {
    const decision = String(value || "");
    return new Set(["", "responsive", "nonresponsive", "missing", "privileged", "needs_review", "duplicate", "delete"]).has(decision) ? decision : "";
  }

  function currentRecord(records) {
    const pos = text("record-position").match(/Record\s+(\d+)\s+of/i);
    const num = pos ? Number(pos[1]) : 0;
    const title = text("record-title");
    if (num) {
      const exact = records.find((r) => Number(r.queue_number) === num && (!title || r.filename === title));
      if (exact) return exact;
      const byNum = records.find((r) => Number(r.queue_number) === num);
      if (byNum) return byNum;
    }
    return title ? records.find((r) => r.filename === title) || null : null;
  }

  function currentControls() {
    return { decision: allowedDecision($("decision")?.value || ""), notes: String($("notes")?.value || "") };
  }

  function captureVisibleMutation(reason = "change") {
    const controls = currentControls();
    const pos = text("record-position").match(/Record\s+(\d+)\s+of/i);
    capturedMutation = {
      reason,
      queueNumber: pos ? Number(pos[1]) : 0,
      filename: text("record-title"),
      decision: controls.decision,
      notes: controls.notes,
      updatedAt: new Date().toISOString()
    };
    return capturedMutation;
  }

  function resolveMutationRecord(records, mutation) {
    if (!mutation) return null;
    if (mutation.queueNumber) {
      const exact = records.find((r) => Number(r.queue_number) === mutation.queueNumber && (!mutation.filename || r.filename === mutation.filename));
      if (exact) return exact;
      const byQueue = records.find((r) => Number(r.queue_number) === mutation.queueNumber);
      if (byQueue) return byQueue;
    }
    return mutation.filename ? records.find((r) => r.filename === mutation.filename) || null : null;
  }

  function markDirty(payload) {
    const value = { dirty: true, markedAt: new Date().toISOString(), payload: payload || capturedMutation || null };
    window.localStorage.setItem(dirtyKey(), "1");
    window.localStorage.setItem(dirtyPayloadKey(), JSON.stringify(value));
  }

  function clearDirty() {
    window.localStorage.removeItem(dirtyKey());
    window.localStorage.removeItem(dirtyPayloadKey());
  }

  function isAuthRedirectInProgress() {
    return window.MASICS_AUTH_REDIRECT_IN_PROGRESS === true;
  }

  function hasValue(value) {
    return Boolean(value && (String(value.decision || "") || String(value.notes || "")));
  }

  function updatedAt(value) {
    const time = Date.parse(value?.updatedAt || "");
    return Number.isFinite(time) ? time : 0;
  }

  function newerOrSafer(current, candidate) {
    if (String(current?.decision || "") === "delete" && String(candidate?.decision || "") !== "delete") return current;
    if (String(current?.decision || "") && !String(candidate?.decision || "")) return current;
    if (hasValue(current) && !hasValue(candidate)) return current;
    if (hasValue(current) && hasValue(candidate) && updatedAt(candidate) < updatedAt(current)) return current;
    return candidate;
  }

  function mergeDecisions(online, local) {
    const merged = { ...(online || {}) };
    Object.entries(local || {}).forEach(([id, value]) => { merged[id] = newerOrSafer(merged[id] || {}, value); });
    return merged;
  }

  function buildRows(records, decisions) {
    return records.map((record) => {
      const saved = decisions[record.review_id] || {};
      const decision = allowedDecision(saved.decision || "");
      const notes = String(saved.notes || "");
      return {
        queue_number: record.queue_number,
        filename: record.filename,
        review_id: record.review_id,
        file_type: record.file_type || record.extension || "",
        decision,
        notes,
        updated_at: saved.updatedAt || "",
        reviewed: Boolean(decision && decision !== "delete"),
        excluded: decision === "delete",
        dropbox_path: record.dropbox_path || ""
      };
    });
  }

  function markedRows(rows) {
    return rows.filter((row) => row.reviewed || row.excluded || String(row.notes || "").trim());
  }

  function csvEscape(value) {
    const s = String(value ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function csv(rows, generation = null) {
    const header = ["queue_number", "filename", "review_id", "file_type", "decision", "notes", "updated_at", "reviewed", "excluded", "dropbox_path"];
    const fullHeader = generation ? ["generation_id", "source_progress_hash", ...header] : header;
    const body = rows.map((row) => generation ? [generation.id, generation.hash, ...header.map((key) => row[key])] : header.map((key) => row[key]));
    return [fullHeader, ...body].map((line) => line.map(csvEscape).join(",")).join("\r\n") + "\r\n";
  }

  function filteredKnown(records, decisions) {
    const ids = new Set(records.map((r) => r.review_id));
    const out = {};
    Object.entries(decisions || {}).forEach(([id, value]) => {
      if (!ids.has(id) || !hasValue(value)) return;
      out[id] = { decision: allowedDecision(value.decision), notes: String(value.notes || ""), updatedAt: String(value.updatedAt || "") };
    });
    return out;
  }

  function auditPayload(records, online, beforeLocal, decisions, exportedAt, current, controls, verified, generation) {
    return {
      schema: "MASICS_MARIO_REVIEW_SAVE_AUDIT_V1",
      trackerVersion: VERSION,
      queueIdentity: cfg().queueIdentity,
      queueVersion: cfg().queueVersion,
      exportedAt,
      generationId: generation.id,
      sourceProgressHash: generation.hash,
      previousOnlineExportedAt: online?.exportedAt || "",
      source: "github-pages-cloud-viewer",
      mergePolicy: "visible record is written from current controls before merge; online decisions preserved over blank values",
      totalKnownRecords: records.length,
      onlineDecisionCount: Object.keys(online?.decisions || {}).length,
      localDecisionCount: Object.keys(beforeLocal?.decisions || {}).length,
      mergedDecisionCount: Object.keys(decisions || {}).length,
      visibleRecordSave: current ? {
        queue: current.queue_number,
        filename: current.filename,
        reviewId: current.review_id,
        decision: controls.decision,
        notesLength: controls.notes.length,
        verifiedOnline: verified
      } : null
    };
  }

  function verifyWholeSave({ records, beforeDecisionCount, decisions, progress, check, current, controls, uploadMeta, expectedRev }) {
    if (!check || check.queueIdentity !== cfg().queueIdentity) throw new Error("Online verification failed: queue identity changed or progress did not reload.");
    if (Number(check.total || 0) !== records.length) throw new Error("Online verification failed: saved record count does not match the protected manifest.");
    const savedCount = Object.keys(check.decisions || {}).length;
    if (savedCount < beforeDecisionCount) throw new Error("Online verification failed: saved decision count unexpectedly decreased.");
    for (const id of Object.keys(decisions || {})) {
      if (!check.decisions || !check.decisions[id]) throw new Error("Online verification failed: a merged decision disappeared after save.");
    }
    if (current && controls.decision) {
      const saved = check.decisions?.[current.review_id] || {};
      if (String(saved.decision || "") !== controls.decision || String(saved.notes || "") !== controls.notes) {
        throw new Error(`Online verification failed for #${current.queue_number} ${current.filename}. Press Save Online again before moving on.`);
      }
    }
    if (progress.generationId !== check.generationId || progress.sourceProgressHash !== check.sourceProgressHash) {
      throw new Error("Online verification failed: generation identity/hash mismatch.");
    }
    if (expectedRev && uploadMeta?.rev && uploadMeta.rev === expectedRev) throw new Error("Online verification failed: Dropbox revision did not advance.");
  }

  async function saveNow(reason = "manual") {
    if (!token()) throw new Error("Sign in with Dropbox before saving online.");
    const isAuto = reason === "auto";
    const base = await resolvedBase();
    if (!base) throw new Error("Online progress folder is not configured.");

    const button = $("save-online");
    if (button) button.disabled = true;
    setSaveStatus(isAuto ? "Auto-saving this visible record online..." : "Saving this visible record online...");

    try {
      const records = await loadManifest();
      const mutation = capturedMutation || captureVisibleMutation(reason);
      const current = resolveMutationRecord(records, mutation) || currentRecord(records);
      const controls = mutation ? { decision: allowedDecision(mutation.decision), notes: String(mutation.notes || "") } : currentControls();
      if (isAuto && !controls.decision) {
        setSaveStatus("Saved locally. Choose a dropdown decision before online auto-save runs.");
        return;
      }
      markDirty({ reason, current: current ? { reviewId: current.review_id, queueNumber: current.queue_number, filename: current.filename } : null, controls });
      let onlineWithMeta = await loadOnlineWithMetadata(base);
      let online = onlineWithMeta?.json || null;
      const beforeLocal = localProgress();
      const local = { ...beforeLocal, queueIdentity: cfg().queueIdentity, decisions: { ...(beforeLocal.decisions || {}) } };
      if (current && (controls.decision || controls.notes.trim())) {
        local.decisions[current.review_id] = { decision: controls.decision, notes: controls.notes, updatedAt: mutation?.updatedAt || new Date().toISOString() };
      }
      saveLocal(local);

      const decisions = filteredKnown(records, mergeDecisions(online?.decisions || {}, local.decisions || {}));
      const rows = buildRows(records, decisions);
      const reviewed = rows.filter((row) => row.reviewed).length;
      const excluded = rows.filter((row) => row.excluded).length;
      const exportedAt = new Date().toISOString();
      let progress = {
        schema: "MASICS_MARIO_ONLINE_REVIEW_PROGRESS_V1",
        queueIdentity: cfg().queueIdentity,
        queueVersion: cfg().queueVersion,
        trackerVersion: VERSION,
        exportedAt,
        source: "github-pages-cloud-viewer",
        mergePolicy: "visible record is written from current controls before merge; online decisions preserved over blank values",
        reviewer: "Mario",
        userAgent: navigator.userAgent,
        url: location.href,
        total: records.length,
        reviewed,
        excluded,
        pending: Math.max(0, records.length - reviewed - excluded),
        decisions,
        tagged: rows.filter((row) => row.reviewed),
        excludedRows: rows.filter((row) => row.excluded)
      };

      let progressText = JSON.stringify(progress, null, 2);
      const generation = { hash: jsonHash(progressText), id: "" };
      generation.id = generationId(exportedAt, progressText);
      progress = { ...progress, generationId: generation.id, sourceProgressHash: generation.hash };
      progressText = JSON.stringify(progress, null, 2);
      const statusCsv = csv(rows, generation);
      const markedCsv = csv(markedRows(rows), generation);
      let uploadMeta = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const mode = onlineWithMeta?.rev ? { ".tag": "update", update: onlineWithMeta.rev } : { ".tag": "overwrite" };
          uploadMeta = await upload(`${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`, progressText, mode);
          break;
        } catch (err) {
          if (!err.dropboxConflict || attempt >= 2) {
            throw new Error("Dropbox save conflict could not be resolved automatically. Local progress is preserved; reload and Save Online again.");
          }
          onlineWithMeta = await loadOnlineWithMetadata(base);
          online = onlineWithMeta?.json || null;
          const retryDecisions = filteredKnown(records, mergeDecisions(online?.decisions || {}, local.decisions || {}));
          progress.decisions = retryDecisions;
          progress.tagged = buildRows(records, retryDecisions).filter((row) => row.reviewed);
          progress.excludedRows = buildRows(records, retryDecisions).filter((row) => row.excluded);
          progressText = JSON.stringify(progress, null, 2);
        }
      }
      let sidecarWarning = "";
      try {
        await upload(`${base}/MASICS_MARIO_REVIEW_STATUS_LATEST.csv`, statusCsv, "overwrite");
        await upload(`${base}/MASICS_MARIO_MARKED_REVIEWED_LATEST.csv`, markedCsv, "overwrite");
      } catch (err) {
        sidecarWarning = ` Progress JSON saved, but CSV backup sidecars are incomplete: ${err.message || err}`;
      }
      const checkWithMeta = await loadOnlineWithMetadata(base);
      const check = checkWithMeta?.json || null;
      verifyWholeSave({ records, beforeDecisionCount: Object.keys(online?.decisions || {}).length, decisions, progress, check, current, controls, uploadMeta, expectedRev: onlineWithMeta?.rev || "" });
      const verified = true;

      const stamp = exportedAt.replace(/[:.]/g, "-");
      const audit = JSON.stringify(auditPayload(records, online, beforeLocal, decisions, exportedAt, current, controls, verified, generation), null, 2);
      try { await upload(`${base}/MASICS_MARIO_REVIEW_AUDIT_LATEST.json`, audit, "overwrite"); }
      catch (err) { sidecarWarning = `${sidecarWarning} Audit sidecar incomplete: ${err.message || err}`.trim(); }
      if (!isAuto) {
        await upload(`${base}/MASICS_MARIO_REVIEW_PROGRESS_${stamp}.json`, progressText, "add");
        try {
          await upload(`${base}/MASICS_MARIO_REVIEW_AUDIT_${stamp}.json`, audit, "add");
          await upload(`${base}/MASICS_MARIO_MARKED_REVIEWED_${stamp}.csv`, markedCsv, "add");
        } catch (err) {
          sidecarWarning = `${sidecarWarning} Timestamped backup sidecars incomplete: ${err.message || err}`.trim();
        }
      }

      saveLocal({ queueIdentity: cfg().queueIdentity, decisions, exportedAt });
      window.localStorage.setItem(stampKey("last_online_sync_at"), exportedAt);
      clearDirty();
      capturedMutation = null;
      const recordText = current ? `#${current.queue_number} ${current.filename}` : "current progress";
      setSaveStatus(`${isAuto ? "Auto-saved" : "Saved"} and verified online: ${recordText}. Reviewed ${reviewed}, pending ${progress.pending}, excluded ${excluded}.${sidecarWarning}`);
      setTopStatus(`Saved and verified online. Reviewed: ${reviewed}. Pending: ${progress.pending}. Excluded: ${excluded}. ${sidecarWarning || "Marked spreadsheet backup updated."}`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function schedule(reason, event = null) {
    if (!token()) return;
    window.clearTimeout(timer);
    const mutation = captureVisibleMutation(reason);
    markDirty(mutation);
    const controls = currentControls();
    if (!controls.decision) {
      setSaveStatus("Saved locally. Pick a dropdown before online auto-save runs.");
      return;
    }
    setSaveStatus("Saved locally. Online verification queued...");
    const delayMs = reason === "notes"
      ? (event?.masicsBufferedCommit === true ? NOTES_BUFFERED_COMMIT_DELAY_MS : NOTES_FALLBACK_DELAY_MS)
      : DECISION_SAVE_DELAY_MS;
    timer = window.setTimeout(() => runAuto().catch((err) => setSaveStatus(`Online save failed: ${err.message || err}`)), delayMs);
  }

  async function runAuto() {
    if (inFlight) { queued = true; return; }
    inFlight = true;
    try {
      do {
        queued = false;
        await saveNow("auto");
      } while (queued);
    } finally { inFlight = false; }
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.id !== "save-online") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    captureVisibleMutation("manual");
    saveNow("manual").catch((err) => setSaveStatus(err.message || "Online save failed."));
  }, true);

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.id !== "decision") return;
    schedule("decision", event);
  }, true);

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id === "notes") schedule("notes", event);
    if (target.id === "decision") schedule("decision", event);
  }, true);

  window.addEventListener("beforeunload", (event) => {
    if (isAuthRedirectInProgress()) return;
    if (!timer && !inFlight && window.localStorage.getItem(dirtyKey()) !== "1") return;
    event.preventDefault();
    event.returnValue = "A review save is still being verified online.";
  });

  window.addEventListener("focus", () => {
    if (window.localStorage.getItem(dirtyKey()) === "1") setSaveStatus("Unsynced local change detected. Press Save Online or wait for online verification before closing.");
  });

  window.MASICS_ONLINE_SAVE_MERGE_SELF_TEST = () => ({
    version: VERSION,
    savesVisibleRecordFromPage: /currentRecord\(records\)/.test(saveNow.toString()),
    verifiesByReadingDropboxBack: /Online verification failed/.test(saveNow.toString()),
    usesDropboxUpdateRevision: /\"\\.tag\": \"update\"/.test(saveNow.toString()),
    hasDirtyMarker: /dirty_unsynced/.test(dirtyKey.toString()),
    hasGenerationIdentity: /generationId/.test(saveNow.toString()),
    autoRequiresDropdown: /!controls\.decision/.test(schedule.toString()),
    manualSnapshotsOnly: /if \(!isAuto\)/.test(saveNow.toString()),
    allowsDropboxAuthRedirect: /MASICS_AUTH_REDIRECT_IN_PROGRESS/.test(isAuthRedirectInProgress.toString()),
    writesMarkedReviewedCsv: /MASICS_MARIO_MARKED_REVIEWED_LATEST\.csv/.test(saveNow.toString()),
    notesAutosaveWaitsForTenSecondIdle: NOTES_FALLBACK_DELAY_MS === 10000 && NOTES_BUFFERED_COMMIT_DELAY_MS === 0,
    dropdownSelectionStillQueuesOnlineSave: DECISION_SAVE_DELAY_MS <= 1000
  });
})();
