(() => {
  "use strict";

  const VERSION = "20260712-mario-july11-recovery-1";
  const PATCH_ID = "MARIO_JULY11_20260712";
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
  const RETRY_MS = 1500;
  const MAX_ATTEMPTS = 120;

  const PATCH = {
    "sha:9c34bad51d49d7821e1f4994edd00c2b504ea41fabb145272556b6632841fca9": {
      decision: "privileged",
      notes: "ginger county animal cruelty registry",
      updatedAt: "2026-07-11T17:02:58.881Z"
    },
    "sha:5abb1c7618e75b6aede5d5762a4a1460861ba6f5dff87b42a1e8f62f0044c25b": {
      decision: "missing",
      notes: "8 13 24 minutes laborer lonnie",
      updatedAt: "2026-07-11T17:06:15.788Z"
    },
    "sha:c12d233f479436028e20de42231e0c1c059ae8955d0c82705b66e489e4aaaa62": {
      decision: "privileged",
      notes: "article code officer fired for not having proper permits",
      updatedAt: "2026-07-11T17:08:18.182Z"
    },
    "sha:20afbf9f85a9f15525b5589c22a5d086188efb60cb8433d758eb6003e6821d9f": {
      decision: "privileged",
      notes: "article 2 code enf officer fired for not having permits",
      updatedAt: "2026-07-11T17:09:07.121Z"
    }
  };

  const cfg = () => window.MASICS_DROPBOX_CONFIG || {};
  const token = () => window.sessionStorage.getItem("masics_access_token") || "";
  const status = (message) => {
    const save = document.getElementById("save-status");
    const top = document.getElementById("status-line");
    if (save) save.textContent = message;
    if (top) top.textContent = message;
  };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
  const day = () => new Date().toISOString().slice(0, 10);
  const updatedAt = (value) => {
    const n = Date.parse(value || "");
    return Number.isFinite(n) ? n : 0;
  };

  async function rpc(endpoint, body) {
    const res = await fetch(DROPBOX_RPC + endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    if (res.status === 409 || res.status === 404) return null;
    if (!res.ok) throw new Error(`Dropbox metadata failed: ${res.status}`);
    return res.json();
  }

  async function download(locator) {
    const res = await fetch(DROPBOX_CONTENT + "files/download", {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Dropbox-API-Arg": JSON.stringify({ path: locator }) }
    });
    if (res.status === 409 || res.status === 404) return null;
    if (!res.ok) throw new Error(`Dropbox read failed: ${res.status}`);
    return res;
  }

  async function upload(path, text, mode = "overwrite") {
    const res = await fetch(DROPBOX_CONTENT + "files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({ path, mode: { ".tag": mode }, autorename: false, mute: true, strict_conflict: false })
      },
      body: text
    });
    if (!res.ok) throw new Error(`Dropbox write failed: ${res.status}`);
    return res.json();
  }

  async function baseFolder() {
    const c = cfg();
    if (c.progressDropboxFolderId) {
      const meta = await rpc("files/get_metadata", { path: c.progressDropboxFolderId, include_deleted: false });
      if (meta?.path_display) return String(meta.path_display).replace(/\/+$/g, "");
    }
    return String(c.progressDropboxFolder || "").replace(/\/+$/g, "");
  }

  async function loadManifest() {
    const c = cfg();
    const candidates = [c.manifestDropboxPath, ...(c.manifestDropboxPathAlternates || [])].filter(Boolean);
    for (const locator of candidates) {
      const res = await download(locator);
      if (!res) continue;
      const json = await res.json();
      if (Array.isArray(json.records)) return json.records;
    }
    throw new Error("Queue manifest unavailable during recovery.");
  }

  async function loadOnline(base) {
    const c = cfg();
    const candidates = [c.progressDropboxLatestJsonId, `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`].filter(Boolean);
    for (const locator of candidates) {
      const res = await download(locator);
      if (!res) continue;
      return res.json();
    }
    throw new Error("Online progress unavailable during recovery.");
  }

  function counts(records, decisions) {
    let reviewed = 0;
    let excluded = 0;
    for (const record of records) {
      const decision = String(decisions[record.review_id]?.decision || "");
      if (decision === "delete") excluded += 1;
      else if (decision) reviewed += 1;
    }
    return { reviewed, excluded, pending: Math.max(0, records.length - reviewed - excluded) };
  }

  async function markerExists(base) {
    return Boolean(await download(`${base}/recovery_applied/${PATCH_ID}.json`));
  }

  async function applyRecovery() {
    const base = await baseFolder();
    if (!base) throw new Error("Recovery folder is not configured.");
    if (await markerExists(base)) {
      status("Mario July 11 recovery already verified online.");
      return;
    }

    status("Applying Mario July 11 recovery safely...");
    const [records, online] = await Promise.all([loadManifest(), loadOnline(base)]);
    const known = new Map(records.map((r) => [r.review_id, r]));
    const decisions = { ...(online.decisions || {}) };
    const applied = [];
    const skipped = [];

    await upload(`${base}/backups/${day()}/PRE_RECOVERY_${PATCH_ID}_${stamp()}.json`, JSON.stringify(online, null, 2), "add");

    for (const [reviewId, candidate] of Object.entries(PATCH)) {
      const record = known.get(reviewId);
      if (!record) {
        skipped.push({ reviewId, reason: "not_in_manifest" });
        continue;
      }
      const current = decisions[reviewId] || {};
      if (String(current.decision || "") === "delete") {
        skipped.push({ reviewId, filename: record.filename, reason: "current_is_delete", current });
        continue;
      }
      if (updatedAt(current.updatedAt) > updatedAt(candidate.updatedAt)) {
        skipped.push({ reviewId, filename: record.filename, reason: "newer_online_value", current });
        continue;
      }

      decisions[reviewId] = { ...candidate };
      const tx = {
        schema: "MASICS_REVIEW_RECOVERY_TRANSACTION_V1",
        recoveryId: PATCH_ID,
        trackerVersion: VERSION,
        createdAt: new Date().toISOString(),
        reviewer: "Mario",
        reviewId,
        queue: record.queue_number,
        filename: record.filename,
        previous: current,
        current: candidate,
        source: "Gmail export masics-progress-masics_mario_task026_rc53_636_v1-2026-07-12T11-33-02-299Z.json"
      };
      await upload(`${base}/transactions/${day()}/RECOVERY_${PATCH_ID}_${reviewId.slice(-12)}_${stamp()}.json`, JSON.stringify(tx, null, 2), "add");
      applied.push({ reviewId, queue: record.queue_number, filename: record.filename, previous: current, current: candidate });
    }

    const c = counts(records, decisions);
    const merged = {
      ...online,
      schema: "MASICS_MARIO_ONLINE_REVIEW_PROGRESS_V2",
      trackerVersion: VERSION,
      exportedAt: new Date().toISOString(),
      source: "github-pages-cloud-viewer-recovery",
      mergePolicy: "Verified one-time recovery from Mario July 11 Gmail export; newer online values and delete decisions preserved",
      total: records.length,
      reviewed: c.reviewed,
      excluded: c.excluded,
      pending: c.pending,
      decisions
    };

    await upload(`${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`, JSON.stringify(merged, null, 2), "overwrite");
    const check = await loadOnline(base);
    const verified = applied.every((item) => {
      const saved = check.decisions?.[item.reviewId] || {};
      return saved.decision === item.current.decision && saved.notes === item.current.notes;
    });
    if (!verified) throw new Error("Recovery verification failed. No completion marker was written.");

    const marker = {
      schema: "MASICS_RECOVERY_APPLIED_V1",
      recoveryId: PATCH_ID,
      trackerVersion: VERSION,
      createdAt: new Date().toISOString(),
      sourceEmailFile: "masics-progress-masics_mario_task026_rc53_636_v1-2026-07-12T11-33-02-299Z.json",
      appliedCount: applied.length,
      skippedCount: skipped.length,
      applied,
      skipped,
      totalsAfter: c,
      verifiedOnline: true
    };
    await upload(`${base}/recovery_applied/${PATCH_ID}.json`, JSON.stringify(marker, null, 2), "add");
    status(`Mario July 11 recovery verified online: ${applied.length} restored. Reviewed ${c.reviewed}, pending ${c.pending}, excluded ${c.excluded}.`);
    setTimeout(() => location.reload(), 1800);
  }

  async function start() {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (token() && cfg().queueIdentity) {
        try {
          await applyRecovery();
        } catch (err) {
          console.error("Mario recovery failed", err);
          status(`Mario recovery is waiting: ${err.message || err}`);
        }
        return;
      }
      await delay(RETRY_MS);
    }
  }

  window.MASICS_MARIO_JULY11_RECOVERY_VERSION = VERSION;
  start();
})();
