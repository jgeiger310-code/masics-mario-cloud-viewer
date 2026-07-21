(() => {
  "use strict";

  const VERSION = "20260721-ai-note-hydrator-1";
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const AI_MARKER = "AI note:";
  const RETRY_DELAYS_MS = [250, 1500, 4000];
  let inFlight = false;

  window.MASICS_AI_NOTE_HYDRATOR_VERSION = VERSION;

  const cfg = () => window.MASICS_DROPBOX_CONFIG || {};
  const token = () => window.sessionStorage.getItem("masics_access_token") || "";
  const progressKey = () => `masics_cloud_progress:${cfg().queueIdentity}`;

  function unique(values) {
    const seen = new Set();
    return values.flat().map((value) => String(value || "").trim()).filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function progressLocators() {
    const base = String(cfg().progressDropboxFolder || "").replace(/\/+$/g, "");
    return unique([
      cfg().progressDropboxLatestJsonId,
      base ? `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json` : "",
      (cfg().progressDropboxFolderAlternates || []).map((folder) => `${String(folder || "").replace(/\/+$/g, "")}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`)
    ]);
  }

  async function downloadJson(locator) {
    const res = await fetch(DROPBOX_CONTENT + "files/download", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Dropbox-API-Arg": JSON.stringify({ path: locator })
      }
    });
    if (res.status === 409 || res.status === 404) return null;
    if (res.status === 401) throw new Error("Dropbox sign-in expired. Sign out and sign in again.");
    if (!res.ok) throw new Error(`Dropbox progress read failed: ${res.status}`);
    return res.json();
  }

  async function loadOnlineProgress() {
    if (!token() || !cfg().queueIdentity) return null;
    for (const locator of progressLocators()) {
      const json = await downloadJson(locator);
      if (!json) continue;
      if (json.queueIdentity !== cfg().queueIdentity || typeof json.decisions !== "object") return null;
      return json;
    }
    return null;
  }

  function readLocalProgress() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(progressKey()) || "{}");
      if (parsed && typeof parsed === "object" && typeof parsed.decisions === "object") return parsed;
    } catch {}
    return { queueIdentity: cfg().queueIdentity, decisions: {} };
  }

  function writeLocalProgress(progress) {
    window.localStorage.setItem(progressKey(), JSON.stringify(progress));
  }

  function hasValue(value) {
    return Boolean(value && (String(value.decision || "") || String(value.notes || "")));
  }

  function hasAINote(value) {
    return String(value?.notes || "").includes(AI_MARKER);
  }

  function appendAINote(localNotes, onlineNotes) {
    const marker = String(onlineNotes || "").indexOf(AI_MARKER);
    if (marker < 0) return String(localNotes || onlineNotes || "");
    const aiNote = String(onlineNotes || "").slice(marker).trim();
    const current = String(localNotes || "").replace(/\n+$/g, "");
    return current ? `${current}\n\n${aiNote}` : String(onlineNotes || "");
  }

  function mergeRecord(localValue = {}, onlineValue = {}) {
    const localDecision = String(localValue.decision || "");
    const onlineDecision = String(onlineValue.decision || "");
    const notes = hasAINote(localValue)
      ? String(localValue.notes || "")
      : hasAINote(onlineValue)
        ? appendAINote(localValue.notes, onlineValue.notes)
        : String(localValue.notes || onlineValue.notes || "");
    return {
      decision: localDecision === "delete" ? "delete" : localDecision || onlineDecision,
      notes,
      updatedAt: String(localValue.updatedAt || onlineValue.updatedAt || "")
    };
  }

  function knownReviewIds() {
    const records = Array.isArray(window.MASICS_QUEUE_RECORDS) ? window.MASICS_QUEUE_RECORDS : [];
    return records.length ? new Set(records.map((record) => record.review_id)) : null;
  }

  function hydrateDecisions(localProgress, onlineProgress) {
    const ids = knownReviewIds();
    const decisions = { ...(localProgress.decisions || {}) };
    let onlineWithAI = 0;
    let hydrated = 0;
    let adopted = 0;

    Object.entries(onlineProgress.decisions || {}).forEach(([reviewId, onlineValue]) => {
      if (ids && !ids.has(reviewId)) return;
      if (hasAINote(onlineValue)) onlineWithAI += 1;
      const localValue = decisions[reviewId] || {};
      const beforeNotes = String(localValue.notes || "");
      const beforeDecision = String(localValue.decision || "");
      if (!hasValue(localValue)) adopted += 1;
      const next = mergeRecord(localValue, onlineValue);
      if (!hasValue(next)) return;
      decisions[reviewId] = next;
      if (!beforeNotes.includes(AI_MARKER) && String(next.notes || "").includes(AI_MARKER)) hydrated += 1;
      if (beforeDecision === "delete" && String(next.decision || "") !== "delete") decisions[reviewId].decision = "delete";
    });

    return { decisions, onlineWithAI, hydrated, adopted };
  }

  function currentReviewId() {
    return window.MASICS_ACTIVE_RECORD?.review_id || "";
  }

  function refreshVisibleControls(decisions) {
    const reviewId = currentReviewId();
    if (!reviewId) return false;
    const saved = decisions[reviewId] || {};
    const notes = document.getElementById("notes");
    const decision = document.getElementById("decision");
    if (notes && document.activeElement !== notes && !String(notes.value || "").includes(AI_MARKER) && hasAINote(saved)) {
      notes.value = String(saved.notes || "");
    }
    if (decision && document.activeElement !== decision && !String(decision.value || "") && String(saved.decision || "")) {
      decision.value = String(saved.decision || "");
    }
    return hasAINote(saved);
  }

  function setStatus(message) {
    const el = document.getElementById("save-status");
    if (el) el.textContent = message;
  }

  async function hydrate(reason = "startup") {
    if (inFlight || !token()) return null;
    inFlight = true;
    try {
      const online = await loadOnlineProgress();
      if (!online) return null;
      const local = readLocalProgress();
      const beforeCount = Object.keys(local.decisions || {}).length;
      const beforeAI = Object.values(local.decisions || {}).filter(hasAINote).length;
      const result = hydrateDecisions(local, online);
      const progress = {
        ...local,
        queueIdentity: cfg().queueIdentity,
        exportedAt: online.exportedAt || local.exportedAt || "",
        decisions: result.decisions
      };
      writeLocalProgress(progress);
      const afterCount = Object.keys(progress.decisions || {}).length;
      const afterAI = Object.values(progress.decisions || {}).filter(hasAINote).length;
      const visibleHasAI = refreshVisibleControls(progress.decisions);
      const summary = {
        version: VERSION,
        reason,
        beforeCount,
        beforeAI,
        afterCount,
        afterAI,
        onlineWithAI: result.onlineWithAI,
        hydrated: result.hydrated,
        adopted: result.adopted,
        visibleHasAI
      };
      window.MASICS_AI_NOTE_HYDRATOR_LAST_RESULT = summary;
      if (afterAI > beforeAI || visibleHasAI) setStatus(`AI notes loaded from online progress: ${afterAI} files.`);
      window.dispatchEvent(new CustomEvent("masics:ai-notes-hydrated", { detail: summary }));
      return summary;
    } catch (err) {
      window.MASICS_AI_NOTE_HYDRATOR_LAST_ERROR = String(err?.message || err || "");
      return null;
    } finally {
      inFlight = false;
    }
  }

  function schedule(reason, delayMs) {
    window.setTimeout(() => hydrate(reason), delayMs);
  }

  window.addEventListener("masics:record-change", () => schedule("record-change", 100));
  RETRY_DELAYS_MS.forEach((delayMs) => schedule("startup", delayMs));

  window.MASICS_AI_NOTE_HYDRATOR_SELF_TEST = () => ({
    version: VERSION,
    readsLatestProgressOnly: /files\/download/.test(downloadJson.toString()) && !/files\/upload/.test(downloadJson.toString()),
    preservesDeleteDecision: /localDecision === "delete"/.test(mergeRecord.toString()),
    appendsOnlineAINote: /appendAINote/.test(mergeRecord.toString()),
    refreshesVisibleNotes: /notes\.value/.test(refreshVisibleControls.toString()),
    retriesAfterAsyncManifestLoad: RETRY_DELAYS_MS.length >= 3
  });
})();
