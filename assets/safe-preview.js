(() => {
  "use strict";

  const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
  const pdfExts = [".pdf"];
  const audioExts = [".mp3", ".wav", ".m4a", ".aac", ".ogg"];
  const videoExts = [".mp4", ".mov", ".m4v", ".webm"];
  const textExts = [".txt", ".csv", ".json", ".md"];
  const previewTypes = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".md": "text/markdown"
  };
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
    return imageExts.includes(fileExtension(record));
  }

  function fileExtension(record) {
    const fromExtension = String(record.extension || "").trim().toLowerCase();
    if (fromExtension) return fromExtension.startsWith(".") ? fromExtension : `.${fromExtension}`;
    const fromType = String(record.file_type || "").trim().toLowerCase();
    if (fromType && !fromType.includes("/") && !fromType.startsWith(".")) return `.${fromType}`;
    const fromName = String(record.filename || "").trim().toLowerCase().match(/\.[a-z0-9]{1,8}$/);
    return fromName ? fromName[0] : "";
  }

  function previewBlob(blob, record) {
    const ext = fileExtension(record);
    const type = previewTypes[ext] || blob.type || "application/octet-stream";
    if (blob.type === type) return blob;
    return new Blob([blob], { type });
  }

  function isStreamPreviewRecord(record) {
    const ext = fileExtension(record);
    return audioExts.includes(ext) || videoExts.includes(ext);
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

  async function dropboxTemporaryLink(locator) {
    const response = await fetch(DROPBOX_RPC + "files/get_temporary_link", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path: locator })
    });
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign in again.");
    if (response.status === 403) throw new Error("Dropbox permission denied for this file.");
    if (response.status === 409) throw new Error(`Dropbox file is missing or moved: ${locator}`);
    if (!response.ok) throw new Error(`Dropbox temporary preview link failed: ${response.status}`);
    const data = await response.json();
    if (!data || !data.link) throw new Error("Dropbox did not return a preview link.");
    return data.link;
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

  async function temporaryLinkFirst(locators) {
    let lastError = null;
    for (const locator of unique(locators)) {
      try {
        return await dropboxTemporaryLink(locator);
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

  function renderPreview(blob, url, record) {
    const preview = $("preview");
    const ext = fileExtension(record);
    preview.innerHTML = "";
    if (blob.type.startsWith("image/") || imageExts.includes(ext)) {
      const img = document.createElement("img");
      img.alt = record.filename;
      img.src = url;
      preview.appendChild(img);
    } else if (blob.type === "application/pdf" || pdfExts.includes(ext)) {
      const shell = document.createElement("div");
      shell.className = "preview-pdf";
      const frame = document.createElement("iframe");
      frame.title = record.filename;
      frame.src = url;
      const open = document.createElement("a");
      open.className = "preview-open";
      open.href = url;
      open.target = "_blank";
      open.rel = "noopener";
      open.textContent = "Open PDF";
      shell.append(frame, open);
      preview.appendChild(shell);
    } else if (blob.type.startsWith("audio/") || audioExts.includes(ext)) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = url;
      preview.appendChild(audio);
    } else if (blob.type.startsWith("video/") || videoExts.includes(ext)) {
      const video = document.createElement("video");
      video.controls = true;
      video.src = url;
      preview.appendChild(video);
    } else if (blob.type.startsWith("text/") || textExts.includes(ext)) {
      blob.text().then((text) => {
        const pre = document.createElement("pre");
        pre.textContent = text.slice(0, 200000);
        preview.appendChild(pre);
      });
    } else {
      const message = document.createElement("p");
      message.className = "preview-message";
      message.textContent = "Preview is unavailable for this file type. No file was downloaded.";
      preview.appendChild(message);
    }
  }

  function renderStreamPreview(url, record) {
    const preview = $("preview");
    const ext = fileExtension(record);
    preview.innerHTML = "";
    if (audioExts.includes(ext)) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = url;
      preview.appendChild(audio);
    } else if (videoExts.includes(ext)) {
      const video = document.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      video.src = url;
      preview.appendChild(video);
    }
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

      if (!options.force && !isImageRecord(record)) {
        showNoDownloadMessage(record);
        status.textContent = "Safe auto-preview is image-only right now. No file was downloaded.";
        return;
      }

      status.textContent = isImageRecord(record) ? "Loading in-page image preview from Dropbox..." : "Loading evidence preview from Dropbox...";
      const locators = [record.dropbox_file_id, record.dropbox_path, record.dropbox_path_alternates || []];
      if (options.force && isStreamPreviewRecord(record)) {
        const link = await temporaryLinkFirst(locators);
        if (key !== selectedKey()) return;
        renderStreamPreview(link, record);
        status.textContent = "Evidence preview loaded from Dropbox. No file was saved to this device.";
        return;
      }
      const response = await downloadFirst(locators);
      const blob = previewBlob(await response.blob(), record);
      activePreviewUrl = URL.createObjectURL(blob);
      if (key !== selectedKey()) return;
      renderPreview(blob, activePreviewUrl, record);
      status.textContent = isImageRecord(record) ? "Image preview loaded in-page. No file was downloaded." : "Evidence preview loaded in-page. No file was downloaded.";
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
