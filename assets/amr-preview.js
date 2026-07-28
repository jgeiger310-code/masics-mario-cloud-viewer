(() => {
  "use strict";

  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const AMR_MODULE_URL = "https://cdn.jsdelivr.net/npm/web-amr@0.0.6/+esm";
  let manifestRecords = null;
  let activePlayer = null;
  let activeSourceUrl = "";

  window.MASICS_AMR_PREVIEW_VERSION = "20260728-amr-playback-1";

  function $(id) {
    return document.getElementById(id);
  }

  function token() {
    return window.sessionStorage.getItem("masics_access_token") || "";
  }

  function unique(values) {
    const seen = new Set();
    return values.flat().map((value) => String(value || "").trim()).filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function fileExtension(record) {
    const fromExtension = String(record?.extension || "").trim().toLowerCase();
    if (fromExtension) return fromExtension.startsWith(".") ? fromExtension : `.${fromExtension}`;
    const fromType = String(record?.file_type || "").trim().toLowerCase();
    if (fromType && !fromType.includes("/") && !fromType.startsWith(".")) return `.${fromType}`;
    const fromName = String(record?.filename || "").trim().toLowerCase().match(/\.[a-z0-9]{1,8}$/);
    return fromName ? fromName[0] : "";
  }

  function isAmrRecord(record) {
    return [".amr", ".awb"].includes(fileExtension(record));
  }

  function evidenceLocators(record) {
    return unique([
      record?.dropbox_file_id,
      record?.dropbox_path_alternates || [],
      record?.dropbox_path
    ]);
  }

  async function dropboxDownload(locator) {
    const response = await fetch(DROPBOX_CONTENT + "files/download", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token()}`,
        "Dropbox-API-Arg": JSON.stringify({ path: locator })
      }
    });
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign in again.");
    if (response.status === 403) throw new Error("Dropbox permission denied for this file.");
    if (response.status === 409) throw new Error(`Dropbox file is missing or moved: ${locator}`);
    if (!response.ok) throw new Error(`Dropbox AMR preview failed: ${response.status}`);
    return response;
  }

  async function downloadFirst(locators) {
    let lastError = null;
    for (const locator of unique(locators)) {
      try {
        return await dropboxDownload(locator);
      } catch (err) {
        lastError = err;
        if (!/missing|moved|not_found|lookup/i.test(String(err?.message || ""))) throw err;
      }
    }
    throw lastError || new Error("No Dropbox locator is available for this AMR record.");
  }

  async function loadManifest() {
    if (manifestRecords) return manifestRecords;
    const cfg = window.MASICS_DROPBOX_CONFIG;
    if (!cfg) throw new Error("Viewer configuration is not loaded.");
    const response = await downloadFirst([cfg.manifestDropboxPath, cfg.manifestDropboxPathAlternates || []]);
    const manifest = await response.json();
    manifestRecords = manifest.records || [];
    return manifestRecords;
  }

  function activeRecordFrom(records) {
    const position = ($("record-position")?.textContent || "").match(/Record\s+(\d+)\s+of/i);
    if (position) {
      const queueNumber = Number(position[1]);
      const byNumber = records.find((record) => Number(record.queue_number) === queueNumber);
      if (byNumber) return byNumber;
    }
    const title = ($("record-title")?.textContent || "").trim();
    return records.find((record) => record.filename === title) || null;
  }

  function clearActivePlayer() {
    try {
      if (activePlayer && typeof activePlayer.pause === "function") activePlayer.pause();
    } catch (_) {}
    activePlayer = null;
    if (activeSourceUrl) URL.revokeObjectURL(activeSourceUrl);
    activeSourceUrl = "";
  }

  function appendFileActions(container, url, record) {
    const actions = document.createElement("div");
    actions.className = "preview-file-actions";
    const save = document.createElement("a");
    save.className = "preview-open";
    save.href = url;
    save.download = record.filename || "evidence.amr";
    save.textContent = "Save original AMR";
    actions.appendChild(save);
    container.appendChild(actions);
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
  }

  function createAmrControls(player, record) {
    const shell = document.createElement("div");
    shell.className = "preview-amr";
    const label = document.createElement("p");
    label.className = "preview-message";
    label.textContent = `${record.filename} — AMR audio`;
    const controls = document.createElement("div");
    controls.className = "preview-file-actions";
    const play = document.createElement("button");
    play.type = "button";
    play.className = "preview-open";
    play.textContent = "Play";
    const pause = document.createElement("button");
    pause.type = "button";
    pause.className = "preview-open";
    pause.textContent = "Pause";
    const restart = document.createElement("button");
    restart.type = "button";
    restart.className = "preview-open";
    restart.textContent = "Restart";
    const time = document.createElement("span");
    time.className = "muted";
    time.textContent = Number.isFinite(player.duration) ? `0:00 / ${formatTime(player.duration)}` : "Ready";

    play.addEventListener("click", async () => {
      try {
        await player.play();
      } catch (err) {
        const status = $("evidence-status");
        if (status) status.textContent = err?.message || "AMR playback could not start.";
      }
    });
    pause.addEventListener("click", () => player.pause());
    restart.addEventListener("click", async () => {
      try {
        if (typeof player.fastSeek === "function") await player.fastSeek(0);
        else player.currentTime = 0;
        await player.play();
      } catch (err) {
        const status = $("evidence-status");
        if (status) status.textContent = err?.message || "AMR playback could not restart.";
      }
    });

    if (typeof player.addEventListener === "function") {
      const update = () => {
        const current = Number(player.currentTime || 0);
        const duration = Number(player.duration || 0);
        time.textContent = duration > 0 ? `${formatTime(current)} / ${formatTime(duration)}` : formatTime(current);
      };
      player.addEventListener("timeupdate", update);
      player.addEventListener("ended", update);
      player.addEventListener("play", () => { play.textContent = "Playing"; });
      player.addEventListener("pause", () => { play.textContent = "Play"; });
    }

    controls.append(play, pause, restart, time);
    shell.append(label, controls);
    return shell;
  }

  async function renderAmr(record) {
    const status = $("evidence-status");
    const preview = $("preview");
    if (!status || !preview) return;
    clearActivePlayer();
    preview.innerHTML = "";
    status.textContent = "Loading AMR audio from Dropbox...";
    const response = await downloadFirst(evidenceLocators(record));
    const originalBlob = new Blob([await response.arrayBuffer()], { type: "audio/amr" });
    activeSourceUrl = URL.createObjectURL(originalBlob);
    status.textContent = "Loading AMR decoder...";
    const module = await import(AMR_MODULE_URL);
    if (typeof module.AMRPlayer !== "function") throw new Error("AMR decoder did not load correctly.");
    const player = module.AMRPlayer(await originalBlob.arrayBuffer());
    if (player?.error) throw new Error(player.error.message || "AMR decoder could not read this file.");
    activePlayer = player;
    preview.appendChild(createAmrControls(player, record));
    appendFileActions(preview, activeSourceUrl, record);
    status.textContent = "AMR audio decoded in the browser and is ready to play. The original evidence file was not changed.";
  }

  async function interceptAmrPreview(event) {
    const button = event.target && event.target.closest && event.target.closest("#load-evidence");
    if (!button || !token()) return;
    const activeTitle = ($("record-title")?.textContent || "").trim().toLowerCase();
    if (!/\.(amr|awb)$/.test(activeTitle)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      const records = await loadManifest();
      const record = activeRecordFrom(records);
      if (!record || !isAmrRecord(record)) throw new Error("The selected AMR record could not be matched to the Dropbox queue.");
      await renderAmr(record);
    } catch (err) {
      const status = $("evidence-status");
      const preview = $("preview");
      if (preview) preview.innerHTML = "";
      if (status) status.textContent = err?.message || "Unable to play this AMR file.";
    }
  }

  document.addEventListener("click", interceptAmrPreview, true);
  window.addEventListener("masics:record-change", clearActivePlayer);
  window.addEventListener("pagehide", clearActivePlayer);

  window.MASICS_AMR_PREVIEW_SELF_TEST = () => ({
    version: window.MASICS_AMR_PREVIEW_VERSION,
    recognizesAmr: isAmrRecord({ filename: "sample.amr" }),
    recognizesAwb: isAmrRecord({ filename: "sample.awb" }),
    usesDropboxDownload: /files\/download/.test(dropboxDownload.toString()),
    usesBrowserDecoder: /web-amr/.test(AMR_MODULE_URL),
    leavesOriginalAvailable: /Save original AMR/.test(appendFileActions.toString())
  });
})();