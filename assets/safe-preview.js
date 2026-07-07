(() => {
  "use strict";

  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
  let records = null;
  let lastPreviewKey = "";
  let previewTimer = 0;
  let previewInFlight = false;
  let previewQueued = false;
  let activePreviewUrl = "";

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

  function isImageRecord(record) {
    return imageExts.includes(String(record.extension || "").toLowerCase());
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
    if (!response.ok) throw new Error(`Dropbox preview failed: ${response.status}`);
    return response;
  }

  async function downloadFirst(locators) {
    let lastError = null;
    for (const locator of unique(locators)) {
      try {
        return await dropboxDownload(locator);
      } catch (err) {
        lastError = err;
        if (!/missing|moved|not_found|lookup/i.test(String(err.message || ""))) throw err;
      }
    }
    throw lastError || new Error("No Dropbox locator is available for this record.");
  }

  function releasePreviewUrl() {
    if (activePreviewUrl) URL.revokeObjectURL(activePreviewUrl);
    activePreviewUrl = "";
  }

  async function loadManifest() {
    if (records) return records;
    const cfg = window.MASICS_DROPBOX_CONFIG;
    if (!cfg) throw new Error("Viewer configuration is not loaded.");
    const response = await downloadFirst([cfg.manifestDropboxPath, cfg.manifestDropboxPathAlternates || []]);
    const manifest = await response.json();
    records = manifest.records || [];
    return records;
  }

  function activeRecordFrom(records) {
    const position = ($("record-position")?.textContent || "").match(/Record\s+(\d+)\s+of/i);
    if (position) {
      const queueNumber = Number(position[1]);
      const byNumber = records.find((record) => Number(record.queue_number) === queueNumber);
      if (byNumber) return byNumber;
    }
    const title = ($("record-title")?.textContent || "").trim();
    return records.find((record) => record.filename === title);
  }

  function selectedKey() {
    const position = ($("record-position")?.textContent || "").trim();
    const title = ($("record-title")?.textContent || "").trim();
    return position && title ? `${position}|${title}` : "";
  }

  function showNoDownloadMessage(record) {
    const preview = $("preview");
    const message = document.createElement("p");
    message.className = "preview-message";
    message.textContent = `${record.filename} is not auto-previewed in this safe image-only build. No file was downloaded.`;
    preview.appendChild(message);
  }

  async function previewActiveRecord(options = {}) {
    const status = $("evidence-status");
    const preview = $("preview");
    const view = $("record-view");
    const key = selectedKey();
    if (!status || !preview || !view || view.hidden || !key || !token()) return;
    if (!options.force && key === lastPreviewKey) return;
    if (previewInFlight) {
      previewQueued = true;
      return;
    }

    previewInFlight = true;
    previewQueued = false;
    lastPreviewKey = key;
    releasePreviewUrl();
    preview.innerHTML = "";

    try {
      const allRecords = await loadManifest();
      const record = activeRecordFrom(allRecords);
      if (!record) throw new Error("No active record is selected.");

      if (!isImageRecord(record)) {
        showNoDownloadMessage(record);
        status.textContent = "Safe auto-preview is image-only right now. No file was downloaded.";
        return;
      }

      status.textContent = "Loading in-page image preview from Dropbox...";
      const locators = [record.dropbox_file_id, record.dropbox_path, record.dropbox_path_alternates || []];
      const response = await downloadFirst(locators);
      const blob = await response.blob();
      const img = document.createElement("img");
      img.alt = record.filename;
      activePreviewUrl = URL.createObjectURL(blob);
      img.src = activePreviewUrl;
      if (key !== selectedKey()) return;
      preview.appendChild(img);
      status.textContent = "Image preview loaded in-page. No file was downloaded.";
    } catch (err) {
      lastPreviewKey = "";
      if (err.name !== "AbortError") status.textContent = err.message || "Unable to load image preview.";
    } finally {
      previewInFlight = false;
      if (previewQueued) schedulePreview({ force: true });
    }
  }

  function schedulePreview(options = {}) {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => previewActiveRecord(options), options.force ? 0 : 300);
  }

  document.addEventListener("click", (event) => {
    const button = event.target && event.target.closest && event.target.closest("#load-evidence");
    if (button) {
      event.preventDefault();
      event.stopImmediatePropagation();
      lastPreviewKey = "";
      previewActiveRecord({ force: true });
      return;
    }
  }, true);

  window.addEventListener("masics:record-change", () => schedulePreview());
  window.addEventListener("pagehide", releasePreviewUrl);
})();
