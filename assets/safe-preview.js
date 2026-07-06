(() => {
  "use strict";

  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const progressPrefix = "masics_safe_preview:";
  let records = null;

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
    if (!response.ok) throw new Error(`Dropbox download failed: ${response.status}`);
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

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Browser could not prepare the in-page preview."));
      reader.readAsDataURL(blob);
    });
  }

  async function loadManifest() {
    if (records) return records;
    const cfg = window.MASICS_DROPBOX_CONFIG;
    if (!cfg) throw new Error("Viewer configuration is not loaded.");
    const cached = window.sessionStorage.getItem(progressPrefix + cfg.queueIdentity);
    if (cached) {
      try {
        records = JSON.parse(cached);
        if (Array.isArray(records) && records.length) return records;
      } catch {}
    }
    const response = await downloadFirst([cfg.manifestDropboxPath, cfg.manifestDropboxPathAlternates || []]);
    const manifest = await response.json();
    records = manifest.records || [];
    window.sessionStorage.setItem(progressPrefix + cfg.queueIdentity, JSON.stringify(records));
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

  function renderUnsupported(record) {
    const message = document.createElement("p");
    message.textContent = `Preview is unavailable for ${record.filename}. No file was downloaded.`;
    $("preview").appendChild(message);
  }

  async function safePreview(event) {
    const button = event.target && event.target.closest && event.target.closest("#load-evidence");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const status = $("evidence-status");
    const preview = $("preview");
    if (!status || !preview) return;
    preview.innerHTML = "";
    status.textContent = "Loading in-page preview from Dropbox...";

    try {
      const allRecords = await loadManifest();
      const record = activeRecordFrom(allRecords);
      if (!record) throw new Error("No active record is selected.");
      const locators = [record.dropbox_file_id, record.dropbox_path, record.dropbox_path_alternates || []];
      const response = await downloadFirst(locators);
      const blob = await response.blob();
      const ext = String(record.extension || "").toLowerCase();

      if (blob.type.startsWith("image/") || [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) {
        const img = document.createElement("img");
        img.alt = record.filename;
        preview.appendChild(img);
        img.src = await blobToDataUrl(blob);
        status.textContent = "Image preview loaded in-page. No file was downloaded.";
        return;
      }

      if (blob.type === "application/pdf" || ext === ".pdf") {
        const frame = document.createElement("iframe");
        frame.title = record.filename;
        frame.src = URL.createObjectURL(blob);
        preview.appendChild(frame);
        status.textContent = "PDF preview loaded in-page. No file was downloaded.";
        return;
      }

      if (blob.type.startsWith("audio/")) {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = URL.createObjectURL(blob);
        preview.appendChild(audio);
        status.textContent = "Audio preview loaded in-page. No file was downloaded.";
        return;
      }

      if (blob.type.startsWith("video/")) {
        const video = document.createElement("video");
        video.controls = true;
        video.src = URL.createObjectURL(blob);
        preview.appendChild(video);
        status.textContent = "Video preview loaded in-page. No file was downloaded.";
        return;
      }

      renderUnsupported(record);
      status.textContent = "Preview unavailable for this file type. No file was downloaded.";
    } catch (err) {
      status.textContent = err.message || "Unable to load evidence preview.";
    }
  }

  document.addEventListener("click", safePreview, true);
})();
