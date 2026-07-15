(() => {
  "use strict";

  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
  const VERSION = "20260715-5844-save-guard-1";
  let timer = 0;
  let inFlight = false;
  let queued = false;

  window.MASICS_ONLINE_SAVE_MERGE_VERSION = VERSION;

  const cfg = () => window.MASICS_DROPBOX_CONFIG || {};
  const token = () => window.sessionStorage.getItem("masics_access_token") || "";
  const $ = (id) => document.getElementById(id);
  const text = (id) => String($(id)?.textContent || "").trim();
  const progressKey = () => `masics_cloud_progress:${cfg().queueIdentity}`;
  const stampKey = (name) => `${progressKey()}:${name}`;

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
    const res = await fetchWithRetry(DROPBOX_CONTENT + "files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({ path, mode: { ".tag": mode }, autorename: false, mute: true, strict_conflict: false })
      },
      body: content
    });
    if (res.status === 401) throw new Error("Dropbox sign-in expired. Sign out and sign in again.");
    if (res.status === 403) throw new Error("Dropbox did not allow online save. Mario needs edit access to the review folder.");
    if (res.status === 409) throw new Error("Dropbox could not write the tracker file. Check shared-folder edit permissions.");
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
    const locators = unique([
      cfg().progressDropboxLatestJsonId,
      `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`,
      (cfg().progressDropboxFolderAlternates || []).map((folder) => `${String(folder || "").replace(/\/+$/g, "")}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`)
    ]);
    for (const locator of locators) {
      const res = await download(locator);
      if (!res) continue;
      try { return await res.json(); } catch { return null; }
    }
    return null;
  }

  function localProgress() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(progressKey()) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch { return {}; }
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

  function csv(rows) {
    const header = ["queue_number", "filename", "review_id", "file_type", "decision", "notes", "updated_at", "reviewed", "excluded", "dropbox_path"];
    return [header, ...rows.map((row) => header.map((key) => row[key]))].map((line) => line.map(csvEscape).join(",")).join("\r\n") + "\r\n";
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

  function auditPayload(records, online, beforeLocal, decisions, exportedAt, current, controls, verified) {
    return {
      schema: "MASICS_MARIO_REVIEW_SAVE_AUDIT_V1",
      trackerVersion: VERSION,
      queueIdentity: cfg().queueIdentity,
      queueVersion: cfg().queueVersion,
      exportedAt,
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

  async function saveNow(reason = "manual") {
    if (!token()) throw new Error("Sign in with Dropbox before saving online.");
    const isAuto = reason === "auto";
    const base = await resolvedBase();
    if (!base) throw new Error("Online progress folder is not configured.");

    const button = $("save-online");
    if (button) button.disabled = true;
    setSaveStatus(isAuto ? "Auto-saving this visible record online..." : "Saving this visible record online...");

    try {
      const [records, online] = await Promise.all([loadManifest(), loadOnline(base)]);
      const current = currentRecord(records);
      const controls = currentControls();
      if (isAuto && !controls.decision) {
        setSaveStatus("Saved locally. Choose a dropdown decision before online auto-save runs.");
        return;
      }
      const beforeLocal = localProgress();
      const local = { ...beforeLocal, queueIdentity: cfg().queueIdentity, decisions: { ...(beforeLocal.decisions || {}) } };
      if (current && (controls.decision || controls.notes.trim())) {
        local.decisions[current.review_id] = { decision: controls.decision, notes: controls.notes, updatedAt: new Date().toISOString() };
      }
      saveLocal(local);

      const decisions = filteredKnown(records, mergeDecisions(online?.decisions || {}, local.decisions || {}));
      const rows = buildRows(records, decisions);
      const reviewed = rows.filter((row) => row.reviewed).length;
      const excluded = rows.filter((row) => row.excluded).length;
      const exportedAt = new Date().toISOString();
      const progress = {
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

      const progressText = JSON.stringify(progress, null, 2);
      const statusCsv = csv(rows);
      const markedCsv = csv(markedRows(rows));
      await upload(`${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`, progressText, "overwrite");
      await upload(`${base}/MASICS_MARIO_REVIEW_STATUS_LATEST.csv`, statusCsv, "overwrite");
      await upload(`${base}/MASICS_MARIO_MARKED_REVIEWED_LATEST.csv`, markedCsv, "overwrite");

      let verified = true;
      if (current && controls.decision) {
        const check = await loadOnline(base);
        const saved = check?.decisions?.[current.review_id] || {};
        verified = String(saved.decision || "") === controls.decision && String(saved.notes || "") === controls.notes;
        if (!verified) throw new Error(`Online verification failed for #${current.queue_number} ${current.filename}. Press Save Online again before moving on.`);
      }

      const stamp = exportedAt.replace(/[:.]/g, "-");
      const audit = JSON.stringify(auditPayload(records, online, beforeLocal, decisions, exportedAt, current, controls, verified), null, 2);
      await upload(`${base}/MASICS_MARIO_REVIEW_AUDIT_LATEST.json`, audit, "overwrite");
      if (!isAuto) {
        await upload(`${base}/MASICS_MARIO_REVIEW_PROGRESS_${stamp}.json`, progressText, "add");
        await upload(`${base}/MASICS_MARIO_REVIEW_AUDIT_${stamp}.json`, audit, "add");
        await upload(`${base}/MASICS_MARIO_MARKED_REVIEWED_${stamp}.csv`, markedCsv, "add");
      }

      saveLocal({ queueIdentity: cfg().queueIdentity, decisions, exportedAt });
      window.localStorage.setItem(stampKey("last_online_sync_at"), exportedAt);
      const recordText = current ? `#${current.queue_number} ${current.filename}` : "current progress";
      setSaveStatus(`${isAuto ? "Auto-saved" : "Saved"} and verified online: ${recordText}. Reviewed ${reviewed}, pending ${progress.pending}, excluded ${excluded}.`);
      setTopStatus(`Saved and verified online. Reviewed: ${reviewed}. Pending: ${progress.pending}. Excluded: ${excluded}. Marked spreadsheet backup updated.`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function schedule(reason) {
    if (!token()) return;
    window.clearTimeout(timer);
    const controls = currentControls();
    if (!controls.decision) {
      setSaveStatus("Saved locally. Pick a dropdown before online auto-save runs.");
      return;
    }
    setSaveStatus("Saved locally. Online verification queued...");
    timer = window.setTimeout(() => runAuto().catch((err) => setSaveStatus(`Online save failed: ${err.message || err}`)), reason === "notes" ? 2600 : 900);
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
    saveNow("manual").catch((err) => setSaveStatus(err.message || "Online save failed."));
  }, true);

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.id !== "decision") return;
    schedule("decision");
  }, true);

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id === "notes") schedule("notes");
    if (target.id === "decision") schedule("decision");
  }, true);

  window.addEventListener("beforeunload", (event) => {
    if (!timer && !inFlight) return;
    event.preventDefault();
    event.returnValue = "A review save is still being verified online.";
  });

  window.MASICS_ONLINE_SAVE_MERGE_SELF_TEST = () => ({
    version: VERSION,
    savesVisibleRecordFromPage: /currentRecord\(records\)/.test(saveNow.toString()),
    verifiesByReadingDropboxBack: /Online verification failed/.test(saveNow.toString()),
    autoRequiresDropdown: /!controls\.decision/.test(schedule.toString()),
    manualSnapshotsOnly: /if \(!isAuto\)/.test(saveNow.toString()),
    writesMarkedReviewedCsv: /MASICS_MARIO_MARKED_REVIEWED_LATEST\.csv/.test(saveNow.toString())
  });
})();
