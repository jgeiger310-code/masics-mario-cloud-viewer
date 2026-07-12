(() => {
  "use strict";

  const VERSION = "20260712-transaction-ledger-v2";
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
  const pending = new Map();
  let timer = 0;
  let inFlight = false;
  let verifiedSinceBackup = 0;
  let bypassNavigation = false;
  let queuedNavigation = null;

  window.MASICS_CAPTURED_CHANGE_SAVE_VERSION = VERSION;

  const cfg = () => window.MASICS_DROPBOX_CONFIG || {};
  const token = () => window.sessionStorage.getItem("masics_access_token") || "";
  const $ = (id) => document.getElementById(id);
  const txt = (id) => String($(id)?.textContent || "").trim();
  const progressKey = () => `masics_cloud_progress:${cfg().queueIdentity}`;
  const offlineKey = () => `masics_offline_transactions:${cfg().queueIdentity}`;
  const backupKey = () => `masics_local_backups:${cfg().queueIdentity}`;
  const deviceKey = "masics_device_id";
  const sessionId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function stableId(key, prefix) {
    let value = window.localStorage.getItem(key);
    if (!value) {
      value = `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
      window.localStorage.setItem(key, value);
    }
    return value;
  }

  const deviceId = stableId(deviceKey, "device");

  function setSaveStatus(message) {
    const el = $("save-status");
    if (el) el.textContent = message;
  }

  function setTopStatus(message) {
    const el = $("status-line");
    if (el) el.textContent = message;
  }

  function delay(ms) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
  function safeJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
  function pad(n) { return String(n).padStart(2, "0"); }
  function stamp(date = new Date()) {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}-${String(date.getUTCMilliseconds()).padStart(3, "0")}Z`;
  }
  function day(date = new Date()) { return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`; }

  function isTransient(err) {
    return /Failed to fetch|NetworkError|Load failed|timeout/i.test(String(err && err.message || err || ""));
  }

  async function fetchWithRetry(url, options) {
    let last = null;
    for (let i = 0; i < 4; i += 1) {
      try {
        const res = await fetch(url, options);
        if (res.status >= 500 || res.status === 429) throw new Error(`Transient Dropbox response ${res.status}`);
        return res;
      } catch (err) {
        last = err;
        if (!isTransient(err)) throw err;
        await delay(700 * (i + 1));
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

  function allowedDecision(value) {
    const decision = String(value || "");
    return new Set(["", "responsive", "nonresponsive", "missing", "privileged", "needs_review", "duplicate", "delete"]).has(decision) ? decision : "";
  }

  function updatedAt(value) {
    const time = Date.parse(value || "");
    return Number.isFinite(time) ? time : 0;
  }

  function currentReviewId() {
    const meta = $("record-meta");
    if (!meta) return "";
    for (const term of Array.from(meta.querySelectorAll("dt"))) {
      if (String(term.textContent || "").trim().toLowerCase() !== "review id") continue;
      return String(term.nextElementSibling?.textContent || "").trim();
    }
    return "";
  }

  function currentQueue() {
    const match = txt("record-position").match(/Record\s+(\d+)\s+of/i);
    return match ? Number(match[1]) : 0;
  }

  function snapshotFromScreen() {
    const reviewId = currentReviewId();
    if (!reviewId) return null;
    return {
      reviewId,
      queue: currentQueue(),
      filename: txt("record-title"),
      decision: allowedDecision($("decision")?.value || ""),
      notes: String($("notes")?.value || ""),
      updatedAt: new Date().toISOString(),
      reviewer: "Mario",
      deviceId,
      sessionId,
      userAgent: navigator.userAgent,
      url: location.href
    };
  }

  function hasValue(value) {
    return Boolean(value && (String(value.decision || "") || String(value.notes || "").trim()));
  }

  function localProgress() {
    return safeJson(window.localStorage.getItem(progressKey()) || "{}", {});
  }

  function offlineTransactions() {
    const value = safeJson(window.localStorage.getItem(offlineKey()) || "[]", []);
    return Array.isArray(value) ? value : [];
  }

  function writeOfflineTransactions(items) {
    window.localStorage.setItem(offlineKey(), JSON.stringify(items.slice(-5000)));
  }

  function addOffline(snapshot, reason) {
    const items = offlineTransactions();
    const tx = {
      transactionId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      reason,
      createdAt: new Date().toISOString(),
      ...snapshot
    };
    const idx = items.findIndex((item) => item.reviewId === tx.reviewId);
    if (idx >= 0) items[idx] = tx; else items.push(tx);
    writeOfflineTransactions(items);
    return tx;
  }

  function removeOffline(reviewIds) {
    const ids = new Set(reviewIds);
    writeOfflineTransactions(offlineTransactions().filter((item) => !ids.has(item.reviewId)));
  }

  function saveLocalBackup(label) {
    const backups = safeJson(window.localStorage.getItem(backupKey()) || "[]", []);
    backups.push({
      label,
      createdAt: new Date().toISOString(),
      progress: localProgress(),
      offlineTransactions: offlineTransactions()
    });
    window.localStorage.setItem(backupKey(), JSON.stringify(backups.slice(-12)));
  }

  function replaceLocalWith(decisions, exportedAt) {
    saveLocalBackup("before-online-replace");
    window.localStorage.setItem(progressKey(), JSON.stringify({
      queueIdentity: cfg().queueIdentity,
      decisions: decisions || {},
      exportedAt: exportedAt || new Date().toISOString(),
      source: "dropbox-transaction-ledger-v2"
    }));
  }

  function saveLocalSnapshot(snapshot) {
    const progress = localProgress();
    progress.queueIdentity = cfg().queueIdentity;
    progress.decisions = progress.decisions || {};
    if (hasValue(snapshot)) {
      progress.decisions[snapshot.reviewId] = {
        decision: snapshot.decision,
        notes: snapshot.notes,
        updatedAt: snapshot.updatedAt
      };
    }
    window.localStorage.setItem(progressKey(), JSON.stringify(progress));
    updateListState(snapshot);
  }

  function updateListState(snapshot) {
    const escaped = window.CSS && CSS.escape ? CSS.escape(snapshot.reviewId) : String(snapshot.reviewId).replace(/["\\]/g, "\\$&");
    const button = document.querySelector(`button[data-review-id="${escaped}"]`);
    if (!button) return;
    button.classList.remove("pending", "needs-dropdown", "reviewed");
    button.classList.add(snapshot.decision ? "reviewed" : snapshot.notes.trim() ? "needs-dropdown" : "pending");
    const state = button.querySelector(".queue-state");
    if (state) state.textContent = snapshot.decision ? "Done" : snapshot.notes.trim() ? "Notes saved" : "Open";
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
      if (meta?.path_display) return String(meta.path_display).replace(/\/+$/g, "");
    }
    return String(cfg().progressDropboxFolder || "").replace(/\/+$/g, "");
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

  function chooseSafer(current, candidate) {
    const currentDecision = String(current?.decision || "");
    const candidateDecision = String(candidate?.decision || "");
    if (currentDecision === "delete" && candidateDecision !== "delete") return current;
    if (currentDecision && !candidateDecision && !String(candidate?.notes || "").trim()) return current;
    if (hasValue(current) && !hasValue(candidate)) return current;
    if (hasValue(current) && hasValue(candidate) && updatedAt(current.updatedAt) > updatedAt(candidate.updatedAt)) return current;
    return candidate;
  }

  function filteredKnown(records, decisions) {
    const known = new Set(records.map((record) => record.review_id));
    const out = {};
    Object.entries(decisions || {}).forEach(([id, value]) => {
      if (!known.has(id) || !hasValue(value)) return;
      out[id] = { decision: allowedDecision(value.decision), notes: String(value.notes || ""), updatedAt: String(value.updatedAt || "") };
    });
    return out;
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

  function csvEscape(value) {
    const s = String(value ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function csv(rows) {
    const header = ["queue_number", "filename", "review_id", "file_type", "decision", "notes", "updated_at", "reviewed", "excluded", "dropbox_path"];
    return [header, ...rows.map((row) => header.map((key) => row[key]))].map((line) => line.map(csvEscape).join(",")).join("\r\n") + "\r\n";
  }

  function transactionPayload(snapshot, previous) {
    return {
      schema: "MASICS_REVIEW_TRANSACTION_V2",
      trackerVersion: VERSION,
      transactionId: snapshot.transactionId || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
      queueIdentity: cfg().queueIdentity,
      queueVersion: cfg().queueVersion,
      createdAt: new Date().toISOString(),
      reviewer: snapshot.reviewer,
      deviceId: snapshot.deviceId,
      sessionId: snapshot.sessionId,
      userAgent: snapshot.userAgent,
      url: snapshot.url,
      reviewId: snapshot.reviewId,
      queue: snapshot.queue,
      filename: snapshot.filename,
      previous: previous || null,
      current: { decision: snapshot.decision, notes: snapshot.notes, updatedAt: snapshot.updatedAt }
    };
  }

  async function uploadRecoveryCandidates(base, online) {
    const local = localProgress();
    const candidates = [];
    Object.entries(local.decisions || {}).forEach(([reviewId, value]) => {
      const remote = online?.decisions?.[reviewId];
      if (!hasValue(value)) return;
      if (!remote || updatedAt(value.updatedAt) > updatedAt(remote.updatedAt) || String(value.decision || "") !== String(remote.decision || "") || String(value.notes || "") !== String(remote.notes || "")) {
        candidates.push({ reviewId, ...value });
      }
    });
    if (!candidates.length) return 0;
    const payload = {
      schema: "MASICS_LOCAL_RECOVERY_CANDIDATES_V1",
      createdAt: new Date().toISOString(),
      queueIdentity: cfg().queueIdentity,
      reviewer: "Mario",
      deviceId,
      sessionId,
      candidates
    };
    await upload(`${base}/recovery_candidates/LOCAL_RECOVERY_${stamp()}.json`, JSON.stringify(payload, null, 2), "add");
    return candidates.length;
  }

  async function uploadBackup(base, online, label) {
    if (!online) return;
    const payload = { ...online, backupLabel: label, backedUpAt: new Date().toISOString(), backupDeviceId: deviceId, backupSessionId: sessionId };
    await upload(`${base}/backups/${day()}/MASICS_MARIO_REVIEW_PROGRESS_${stamp()}.json`, JSON.stringify(payload, null, 2), "add");
  }

  async function saveSnapshotsNow(manual = false) {
    if (!token()) throw new Error("OFFLINE: Sign in with Dropbox before saving online.");
    const snapshots = [...pending.values(), ...offlineTransactions()].filter(hasValue);
    pending.clear();
    if (!snapshots.length) {
      setSaveStatus("Saved online. Nothing else is waiting.");
      return;
    }

    const deduped = new Map();
    snapshots.forEach((snap) => {
      const current = deduped.get(snap.reviewId);
      if (!current || updatedAt(snap.updatedAt) >= updatedAt(current.updatedAt)) deduped.set(snap.reviewId, snap);
    });
    const batch = [...deduped.values()];
    const base = await resolvedBase();
    if (!base) throw new Error("Online progress folder is not configured.");
    setSaveStatus(`SAVING ${batch.length} record${batch.length === 1 ? "" : "s"} online. Do not close or move on.`);

    const [records, online] = await Promise.all([loadManifest(), loadOnline(base)]);
    if (manual || verifiedSinceBackup >= 10) await uploadBackup(base, online, manual ? "manual-save-before-change" : "automatic-10-record-backup");
    await uploadRecoveryCandidates(base, online);

    const decisions = filteredKnown(records, online?.decisions || {});
    const known = new Set(records.map((record) => record.review_id));
    const transactions = [];
    for (const snap of batch) {
      if (!known.has(snap.reviewId)) continue;
      const previous = decisions[snap.reviewId] || null;
      const next = chooseSafer(previous || {}, { decision: snap.decision, notes: snap.notes, updatedAt: snap.updatedAt });
      decisions[snap.reviewId] = next;
      const tx = transactionPayload(snap, previous);
      transactions.push(tx);
      await upload(`${base}/transactions/${day()}/${stamp()}_${tx.transactionId}.json`, JSON.stringify(tx, null, 2), "add");
    }

    const rows = buildRows(records, decisions);
    const reviewed = rows.filter((row) => row.reviewed).length;
    const excluded = rows.filter((row) => row.excluded).length;
    const exportedAt = new Date().toISOString();
    const progress = {
      schema: "MASICS_MARIO_ONLINE_REVIEW_PROGRESS_V2",
      queueIdentity: cfg().queueIdentity,
      queueVersion: cfg().queueVersion,
      trackerVersion: VERSION,
      exportedAt,
      source: "github-pages-cloud-viewer",
      mergePolicy: "Append-only transaction ledger plus verified Dropbox snapshot; local differences are backed up as recovery candidates before replacement",
      reviewer: "Mario",
      deviceId,
      sessionId,
      userAgent: navigator.userAgent,
      url: location.href,
      total: records.length,
      reviewed,
      excluded,
      pending: Math.max(0, records.length - reviewed - excluded),
      unsyncedLocal: 0,
      decisions,
      tagged: rows.filter((row) => row.reviewed),
      excludedRows: rows.filter((row) => row.excluded)
    };

    const progressText = JSON.stringify(progress, null, 2);
    await upload(`${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`, progressText, "overwrite");
    const check = await loadOnline(base);
    const verified = [];
    for (const snap of batch) {
      if (!known.has(snap.reviewId)) continue;
      const wanted = decisions[snap.reviewId] || {};
      const saved = check?.decisions?.[snap.reviewId] || {};
      if (String(saved.decision || "") === String(wanted.decision || "") && String(saved.notes || "") === String(wanted.notes || "")) verified.push(snap.reviewId);
      else {
        pending.set(snap.reviewId, snap);
        throw new Error(`SAVE FAILED for #${snap.queue} ${snap.filename}. Do not move on. Press Save Online again.`);
      }
    }

    await upload(`${base}/MASICS_MARIO_REVIEW_STATUS_LATEST.csv`, csv(rows), "overwrite");
    const audit = {
      schema: "MASICS_MARIO_REVIEW_SAVE_AUDIT_V2",
      trackerVersion: VERSION,
      exportedAt,
      previousOnlineExportedAt: online?.exportedAt || "",
      reviewer: "Mario",
      deviceId,
      sessionId,
      totalKnownRecords: records.length,
      onlineDecisionCountBefore: Object.keys(online?.decisions || {}).length,
      mergedDecisionCount: Object.keys(decisions).length,
      transactionCount: transactions.length,
      verifiedReviewIds: verified,
      reviewed,
      pending: progress.pending,
      excluded
    };
    await upload(`${base}/MASICS_MARIO_REVIEW_AUDIT_LATEST.json`, JSON.stringify(audit, null, 2), "overwrite");
    await upload(`${base}/audits/${day()}/MASICS_MARIO_REVIEW_AUDIT_${stamp()}.json`, JSON.stringify(audit, null, 2), "add");

    removeOffline(verified);
    replaceLocalWith(decisions, exportedAt);
    verifiedSinceBackup = manual ? 0 : verifiedSinceBackup + verified.length;
    if (verifiedSinceBackup >= 10) verifiedSinceBackup = 0;
    setSaveStatus(`SAVED ONLINE ✓ ${verified.length} verified. Reviewed ${reviewed}, pending ${progress.pending}, excluded ${excluded}.`);
    setTopStatus(`Online verified. Reviewed: ${reviewed}. Pending: ${progress.pending}. Excluded: ${excluded}.`);
  }

  function queueSnapshot(reason) {
    const snap = snapshotFromScreen();
    if (!snap || !hasValue(snap)) return;
    saveLocalSnapshot(snap);
    addOffline(snap, reason);
    pending.set(snap.reviewId, snap);
    setSaveStatus(`WAITING TO SYNC #${snap.queue}. Keep this tab open.`);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => runSave(false), reason === "notes" ? 800 : 100);
  }

  async function runSave(manual) {
    if (inFlight) return false;
    inFlight = true;
    try {
      while (pending.size || offlineTransactions().length) await saveSnapshotsNow(manual);
      return true;
    } catch (err) {
      setSaveStatus(err.message || "SAVE FAILED. Work remains stored locally and will retry.");
      setTopStatus("Offline or save failed. Work is still stored on this device and has not been verified online.");
      return false;
    } finally {
      inFlight = false;
    }
  }

  function interceptReviewChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id !== "decision" && target.id !== "notes") return;
    event.stopImmediatePropagation();
    queueSnapshot(target.id === "notes" ? "notes" : "decision");
  }

  function interceptSaveOnline(event) {
    const button = event.target && event.target.closest && event.target.closest("#save-online");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    queueSnapshot("manual-save");
    runSave(true);
  }

  async function interceptNavigation(event) {
    const button = event.target && event.target.closest && event.target.closest("#next-record, #next-pending, #next-pending-top, #previous-record");
    if (!button || bypassNavigation) return;
    const snap = snapshotFromScreen();
    if (!snap || !hasValue(snap)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    queuedNavigation = button;
    queueSnapshot("navigation");
    const ok = await runSave(false);
    if (!ok) {
      setSaveStatus("NOT MOVING: current record is not verified online.");
      return;
    }
    const target = queuedNavigation;
    queuedNavigation = null;
    bypassNavigation = true;
    try { target?.click(); } finally { bypassNavigation = false; }
  }

  window.addEventListener("beforeunload", (event) => {
    if (!pending.size && !inFlight && !offlineTransactions().length) return;
    event.preventDefault();
    event.returnValue = "Review work is still waiting to sync online.";
  });

  window.addEventListener("online", () => runSave(false));
  window.setInterval(() => {
    if (token() && (pending.size || offlineTransactions().length)) runSave(false);
  }, 30000);

  saveLocalBackup("session-start");
  document.addEventListener("change", interceptReviewChange, true);
  document.addEventListener("input", interceptReviewChange, true);
  document.addEventListener("click", interceptSaveOnline, true);
  document.addEventListener("click", interceptNavigation, true);

  window.MASICS_CAPTURED_CHANGE_SAVE_SELF_TEST = () => ({
    version: VERSION,
    appendOnlyTransactions: true,
    durableOfflineQueue: true,
    verifiedNavigation: true,
    recoveryCandidateBackup: true,
    periodicBackups: true,
    sessionAndDeviceTracking: true,
    pendingUnloadWarning: true
  });
})();