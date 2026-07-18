(() => {
  "use strict";

  const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const CACHE_KEY = "masics_stream_preview_links_v1";
  const imageExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
  const audioExts = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg"]);
  const videoExts = new Set([".mp4", ".mov", ".m4v", ".webm"]);
  const officeExts = new Set([".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".odt", ".ods", ".odp", ".rtf"]);
  let manifestRecords = null;
  let activeGeneration = 0;
  let linkCache = loadCache();

  window.MASICS_STREAM_PREVIEW_VERSION = "20260718-stream-native-1";

  function $(id) {
    return document.getElementById(id);
  }

  function token() {
    return window.sessionStorage.getItem("masics_access_token") || "";
  }

  function loadCache() {
    try {
      const parsed = JSON.parse(window.sessionStorage.getItem(CACHE_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveCache() {
    try {
      window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(linkCache));
    } catch {}
  }

  function extensionFromName(value) {
    const match = String(value || "").trim().toLowerCase().match(/\.[a-z0-9]{1,8}$/);
    return match ? match[0] : "";
  }

  function currentExtension() {
    return extensionFromName($("record-title")?.textContent || "");
  }

  function isAndroid() {
    return /Android/i.test(navigator.userAgent || "");
  }

  function isNativeStreamExtension(ext) {
    return imageExts.has(ext) || audioExts.has(ext) || videoExts.has(ext) || (ext === ".pdf" && !isAndroid());
  }

  function selectedKey() {
    return `${$("record-position")?.textContent || ""}|${$("record-title")?.textContent || ""}`;
  }

  function unique(values) {
    const seen = new Set();
    return values.flat().map((value) => String(value || "").trim()).filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function locators(record) {
    return unique([record?.dropbox_file_id, record?.dropbox_path_alternates || [], record?.dropbox_path]);
  }

  async function downloadJson(locator) {
    const response = await fetch(DROPBOX_CONTENT + "files/download", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Dropbox-API-Arg": JSON.stringify({ path: locator })
      }
    });
    if (!response.ok) throw new Error(`Dropbox manifest lookup failed: ${response.status}`);
    return response.json();
  }

  async function records() {
    if (manifestRecords) return manifestRecords;
    const cfg = window.MASICS_DROPBOX_CONFIG;
    let lastError = null;
    for (const locator of unique([cfg?.manifestDropboxPath, cfg?.manifestDropboxPathAlternates || []])) {
      try {
        const manifest = await downloadJson(locator);
        manifestRecords = manifest.records || [];
        return manifestRecords;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Review manifest is unavailable.");
  }

  function activeRecordFrom(allRecords) {
    const position = ($("record-position")?.textContent || "").match(/Record\s+(\d+)\s+of/i);
    if (position) {
      const queueNumber = Number(position[1]);
      const found = allRecords.find((record) => Number(record.queue_number) === queueNumber);
      if (found) return found;
    }
    const title = ($("record-title")?.textContent || "").trim();
    return allRecords.find((record) => record.filename === title);
  }

  async function temporaryLink(locator) {
    const cached = linkCache[locator];
    if (cached && cached.link && Number(cached.expiresAt || 0) > Date.now() + 60000) return cached.link;
    const response = await fetch(DROPBOX_RPC + "files/get_temporary_link", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path: locator })
    });
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign in again.");
    if (response.status === 403) throw new Error("Dropbox permission denied for this file.");
    if (response.status === 409) throw new Error(`Dropbox file is missing or moved: ${locator}`);
    if (!response.ok) throw new Error(`Dropbox streaming link failed: ${response.status}`);
    const data = await response.json();
    linkCache[locator] = { link: data.link, expiresAt: Date.now() + (3.5 * 60 * 60 * 1000) };
    saveCache();
    return data.link;
  }

  async function firstTemporaryLink(record) {
    let lastError = null;
    for (const locator of locators(record)) {
      try {
        return await temporaryLink(locator);
      } catch (error) {
        lastError = error;
        if (!/missing|moved|not_found|lookup/i.test(String(error.message || ""))) throw error;
      }
    }
    throw lastError || new Error("No Dropbox locator is available for this record.");
  }

  function addActions(container, link, record, label = "Open original") {
    const actions = document.createElement("div");
    actions.className = "preview-file-actions";
    const open = document.createElement("a");
    open.className = "preview-open";
    open.href = link;
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = label;
    const save = document.createElement("a");
    save.className = "preview-open";
    save.href = link;
    save.download = record.filename || "evidence-file";
    save.textContent = "Save a copy";
    actions.append(open, save);
    container.appendChild(actions);
  }

  function renderStream(link, record, ext) {
    const preview = $("preview");
    preview.innerHTML = "";
    if (imageExts.has(ext)) {
      const image = document.createElement("img");
      image.alt = record.filename;
      image.decoding = "async";
      image.loading = "eager";
      image.src = link;
      preview.appendChild(image);
      addActions(preview, link, record, "Open image");
      return "Image streaming from Dropbox.";
    }
    if (audioExts.has(ext) || videoExts.has(ext)) {
      const media = document.createElement(audioExts.has(ext) ? "audio" : "video");
      media.controls = true;
      media.preload = "metadata";
      media.src = link;
      media.title = record.filename;
      preview.appendChild(media);
      addActions(preview, link, record, audioExts.has(ext) ? "Open audio" : "Open video");
      return "Media ready to stream from Dropbox. Playback can begin before the full file downloads.";
    }
    if (ext === ".pdf") {
      const shell = document.createElement("div");
      shell.className = "preview-pdf";
      const frame = document.createElement("iframe");
      frame.title = record.filename;
      frame.src = link;
      shell.appendChild(frame);
      addActions(shell, link, record, "Open PDF");
      preview.appendChild(shell);
      return "PDF streaming in the browser. It can begin displaying before the complete file downloads.";
    }
    return "Evidence link ready.";
  }

  function renderOfficeLink(link, record) {
    const preview = $("preview");
    preview.innerHTML = "";
    const message = document.createElement("p");
    message.className = "preview-message";
    message.textContent = "This browser cannot display this Office format in-page. Open the original immediately in its installed app.";
    preview.appendChild(message);
    addActions(preview, link, record);
  }

  async function accelerate({ allowOffice = false } = {}) {
    const generation = ++activeGeneration;
    const key = selectedKey();
    const status = $("evidence-status");
    if (!key || !token() || !status) return;
    try {
      status.textContent = "Preparing fast Dropbox preview...";
      const record = activeRecordFrom(await records());
      if (!record || generation !== activeGeneration || key !== selectedKey()) return;
      const ext = extensionFromName(record.filename || "");
      if (!isNativeStreamExtension(ext) && !(allowOffice && officeExts.has(ext))) return;
      const link = await firstTemporaryLink(record);
      if (generation !== activeGeneration || key !== selectedKey()) return;
      status.textContent = officeExts.has(ext) ? "Original file link ready." : renderStream(link, record, ext);
      if (officeExts.has(ext)) renderOfficeLink(link, record);
    } catch (error) {
      if (generation === activeGeneration) status.textContent = error.message || "Fast preview could not load.";
    }
  }

  window.addEventListener("masics:record-change", (event) => {
    const ext = currentExtension();
    if (!isNativeStreamExtension(ext)) return;
    event.stopImmediatePropagation();
    accelerate();
  });

  document.addEventListener("click", (event) => {
    const button = event.target && event.target.closest && event.target.closest("#load-evidence");
    if (!button) return;
    const ext = currentExtension();
    if (!isNativeStreamExtension(ext) && !officeExts.has(ext)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    accelerate({ allowOffice: true });
  }, true);

  window.addEventListener("pagehide", () => { activeGeneration += 1; });

  window.MASICS_STREAM_PREVIEW_SELF_TEST = () => ({
    version: window.MASICS_STREAM_PREVIEW_VERSION,
    streamsImages: isNativeStreamExtension(".jpg"),
    streamsAudio: isNativeStreamExtension(".mp3"),
    streamsVideo: isNativeStreamExtension(".mp4"),
    streamsDesktopPdf: isAndroid() || isNativeStreamExtension(".pdf"),
    leavesDocxForLocalParser: !isNativeStreamExtension(".docx"),
    handlesLegacyOfficeOnDemand: officeExts.has(".doc") && officeExts.has(".xlsx") && officeExts.has(".pptx"),
    cachesTemporaryLinks: /linkCache\[locator\]/.test(temporaryLink.toString())
  });
})();