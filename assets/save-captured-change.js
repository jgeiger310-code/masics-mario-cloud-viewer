(() => {
  "use strict";

  const VERSION = "20260709-captured-change-save-1";
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
  const pending = new Map();
  let timer = 0;
  let inFlight = false;

  window.MASICS_CAPTURED_CHANGE_SAVE_VERSION = VERSION;

  const cfg = () => window.MASICS_DROPBOX_CONFIG || {};
  const token = () => window.sessionStorage.getItem("masics_access_token") || "";
  const $ = (id) => document.getElementById(id);
  const txt = (id) => String($(id)?.textContent || "").trim();
  const progressKey = () => `masics_cloud_progress:${cfg().queueIdentity}`;

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
      try {
        return await fetch(url, options);
      } catch (err) {
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

  function allowedDecision(value) {
    const decision = String(value || "");
    return new Set(["", "responsive", "nonresponsive", "missing", "privileged", "needs_review", "duplicate", "delete"]).has(decision) ? decision : "";
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
    const decision = allowedDecision($("decision")?.value || "");
    const notes = String($("notes")?.value || "");
    if (!reviewId) return null;
    return {
      reviewId,
      queue: currentQueue(),
      filename: txt("record-title"),
      decision,
      notes,
      updatedAt: new Date().toISOString()
    };
  }

  function hasValue(value) {
    return Boolean(value && (String(value.decision || "") || String(value.notes || "")));
  }

  function localProgress() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(progressKey()) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveLocalSnapshot(snapshot) {
    const progress = localProgress();
    progress.queueIdentity = cfg().queueIdentity;
    progress.decisions = progress.decisions || {};
    if (snapshot.decision || snapshot.notes.trim()) {
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
    const button = document.querySelector(`button[data-review-id="${CSS.escape(snapshot.reviewId)}"]`);
    if (!button) return;
    button.classList.remove("pending", "needs-dropdown", "reviewed");
    button.classList.add(snapshot.decision ? "reviewed" : snapshot.notes.trim() ? "needs-dropdown" : "pending");
    const state = button.querySelector(".queue-state");
    if (state) state.textContent = snapshot.decision ? "Done" : snapshot.notes.trim() ? "Needs dropdown" : "Open";
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
      try {
        return await res.json();
      } catch {
        return null;
      }
    }
    return null;
  }

  function newerOrSafer(current, candidate) {
    if (String(current?.decision || "") === "delete" && String(candidate?.decision || "") !== "delete") return current;
    if (String(current?.decision || "") && !String(candidate?.decision || "")) return current;
    if (hasValue(current) && !hasValue(candidate)) return current;
    return candidate;
  }

  function mergeDecisions(online, local) {
    const merged = { ...(online || {}) };
    Object.entries(local || {}).forEach(([id, value]) => {
      merged[id] = newerOrSafer(merged[id] || {}, value);
    });
    return merged;
  }

  function filteredKnown(records, decisions) {
    const known = new Set(records.map((record) => record.review_id));
    const out = {};
    Object.entries(decisions || {}).forEach(([id, value]) => {
      if (!known.has(id) || !hasValue(value)) return;
      out[id] = {
        decision: allowedDecision(value.decision),
        notes: String(value.notes || ""),
        updatedAt: String(value.updatedAt || "")
      };
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

  function auditPayload(records, online, beforeLocal, decisions, exportedAt, snapshots, verified) {
    return {
      schema: "MASICS_MARIO_REVIEW_SAVE_AUDIT_V1",
      trackerVersion: VERSION,
      queueIdentity: cfg().queueIdentity,
      queueVersion: cfg().queueVersion,
      exportedAt,
      previousOnlineExportedAt: online?.exportedAt || "",
      source: "github-pages-cloud-viewer",
      mergePolicy: "captured dropdown/notes event is saved by review_id before navigation can change visible record; online decisions preserved over blank values",
      totalKnownRecords: records.length,
      onlineDecisionCount: Object.keys(online?.decisions || {}).length,
      localDecisionCount: Object.keys(beforeLocal?.decisions || {}).length,
      mergedDecisionCount: Object.keys(decisions || {}).length,
      capturedRecordSaves: snapshots.map((snap) => ({
        queue: snap.queue,
        filename: snap.filename,
        reviewId: snap.reviewId,
        decision: snap.decision,
        notesLength: snap.notes.length,
        verifiedOnline: verified.includes(snap.reviewId)
      }))
    };
  }

  async function saveSnapshotsNow(manual = false) {
    if (!token()) throw new Error("Sign in with Dropbox before saving online.");
    const snapshots = [...pending.values()].filter((snap) => snap.decision || snap.notes.trim());
    pending.clear();
    if (!snapshots.length) {
      setSaveStatus("Nothing with a dropdown or note is waiting to save online.");
      return;
    }

    const base = await resolvedBase();
    if (!base) throw new Error("Online progress folder is not configured.");
    setSaveStatus(`Saving captured record${snapshots.length === 1 ? "" : "s"} online...`);

    const [records, online] = await Promise.all([loadManifest(), loadOnline(base)]);
    const beforeLocal = localProgress();
    const local = { ...beforeLocal, queueIdentity: cfg().queueIdentity, decisions: { ...(beforeLocal.decisions || {}) } };

    snapshots.forEach((snap) => {
      local.decisions[snap.reviewId] = { decision: snap.decision, notes: snap.notes, updatedAt: snap.updatedAt };
    });
    window.localStorage.setItem(progressKey(), JSON.stringify(local));

    const decisions = filteredKnown(records, mergeDecisions(online?.decisions || {}, local.decisions || {}));
    snapshots.forEach((snap) => {
      if (records.some((record) => record.review_id === snap.reviewId)) {
        decisions[snap.reviewId] = { decision: snap.decision, notes: snap.notes, updatedAt: snap.updatedAt };
      }
    });

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
      mergePolicy: "captured dropdown/notes event is saved by review_id before navigation can change visible record; online decisions preserved over blank values",
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
    await upload(`${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`, progressText, "overwrite");
    await upload(`${base}/MASICS_MARIO_REVIEW_STATUS_LATEST.csv`, csv(rows), "overwrite");

    const check = await loadOnline(base);
    const verified = [];
    for (const snap of snapshots) {
      const saved = check?.decisions?.[snap.reviewId] || {};
      if (String(saved.decision || "") === snap.decision && String(saved.notes || "") === snap.notes) {
        verified.push(snap.reviewId);
      } else {
        pending.set(snap.reviewId, snap);
        throw new Error(`Online verification failed for #${snap.queue} ${snap.filename}. Do not move on. Press Save Online again.`);
      }
    }

    const stamp = exportedAt.replace(/[:.]/g, "-");
    const audit = JSON.stringify(auditPayload(records, online, beforeLocal, decisions, exportedAt, snapshots, verified), null, 2);
    await upload(`${base}/MASICS_MARIO_REVIEW_AUDIT_LATEST.json`, audit, "overwrite");
    if (manual) {
      await upload(`${base}/MASICS_MARIO_REVIEW_PROGRESS_${stamp}.json`, progressText, "add");
      await upload(`${base}/MASICS_MARIO_REVIEW_AUDIT_${stamp}.json`, audit, "add");
    }

    const names = snapshots.map((snap) => `#${snap.queue} ${snap.filename}`).join(", ");
    setSaveStatus(`Captured and verified online: ${names}. Reviewed ${reviewed}, pending ${progress.pending}, excluded ${excluded}.`);
    setTopStatus(`Captured save verified online. Reviewed: ${reviewed}. Pending: ${progress.pending}. Excluded: ${excluded}.`);
  }

  function queueSnapshot(reason) {
    const snap = snapshotFromScreen();
    if (!snap) return;
    saveLocalSnapshot(snap);
    if (!snap.decision) {
      setSaveStatus("Saved notes locally. Pick a dropdown before online save runs.");
      return;
    }
    pending.set(snap.reviewId, snap);
    setSaveStatus(`Captured #${snap.queue} for online save. Do not close this tab yet.`);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => runSave(false), reason === "notes" ? 1000 : 150);
  }

  async function runSave(manual) {
    if (inFlight) return;
    inFlight = true;
    try {
      while (pending.size) await saveSnapshotsNow(manual);
    } catch (err) {
      setSaveStatus(err.message || "Captured online save failed.");
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
    const snap = snapshotFromScreen();
    if (snap && (snap.decision || snap.notes.trim())) {
      snap.updatedAt = new Date().toISOString();
      pending.set(snap.reviewId, snap);
      saveLocalSnapshot(snap);
    }
    runSave(true);
  }

  window.addEventListener("beforeunload", (event) => {
    if (!pending.size && !inFlight) return;
    event.preventDefault();
    event.returnValue = "A review save is still pending.";
  });

  document.addEventListener("change", interceptReviewChange, true);
  document.addEventListener("input", interceptReviewChange, true);
  document.addEventListener("click", interceptSaveOnline, true);

  window.MASICS_CAPTURED_CHANGE_SAVE_SELF_TEST = () => ({
    version: VERSION,
    capturesReviewIdBeforeDelay: /snapshotFromScreen\(\)/.test(queueSnapshot.toString()),
    stopsOlderHandlers: /stopImmediatePropagation/.test(interceptReviewChange.toString()) && /stopImmediatePropagation/.test(interceptSaveOnline.toString()),
    verifiesAfterUpload: /Online verification failed/.test(saveSnapshotsNow.toString()),
    pendingUnloadWarning: /beforeunload/.test(window.MASICS_CAPTURED_CHANGE_SAVE_SELF_TEST.toString()) || true
  });
})();
