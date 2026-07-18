(() => {
  "use strict";

  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const imageExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff"]);
  const cache = new Map();
  const maxCachedImages = 12;
  let manifestRecords = null;
  let generation = 0;
  let bypassNextRecordChange = false;
  let thumbnailTimer = 0;
  let thumbnailAbortController = null;

  window.MASICS_IMAGE_THUMBNAIL_PREVIEW_VERSION = "20260718-thumbnail-debounce-1";

  function $(id) {
    return document.getElementById(id);
  }

  function token() {
    return window.sessionStorage.getItem("masics_access_token") || "";
  }

  function extension(value) {
    const match = String(value || "").trim().toLowerCase().match(/\.[a-z0-9]{1,8}$/);
    return match ? match[0] : "";
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

  function remember(locator, url) {
    if (cache.has(locator)) URL.revokeObjectURL(cache.get(locator));
    cache.set(locator, url);
    while (cache.size > maxCachedImages) {
      const oldest = cache.keys().next().value;
      URL.revokeObjectURL(cache.get(oldest));
      cache.delete(oldest);
    }
  }

  function cancelThumbnailRequest() {
    generation += 1;
    window.clearTimeout(thumbnailTimer);
    thumbnailTimer = 0;
    if (thumbnailAbortController) thumbnailAbortController.abort();
    thumbnailAbortController = null;
  }

  async function thumbnail(locator, signal = null) {
    if (cache.has(locator)) return cache.get(locator);
    const response = await fetch(DROPBOX_CONTENT + "files/get_thumbnail_v2", {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${token()}`,
        "Dropbox-API-Arg": JSON.stringify({
          resource: { ".tag": "path", path: locator },
          format: "jpeg",
          size: "w1024h768",
          mode: "fitone_bestfit"
        })
      }
    });
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign in again.");
    if (response.status === 409) throw new Error(`Dropbox thumbnail unavailable for ${locator}`);
    if (!response.ok) throw new Error(`Dropbox thumbnail failed: ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    remember(locator, url);
    return url;
  }

  async function firstThumbnail(record, signal = null) {
    let lastError = null;
    for (const locator of locators(record)) {
      try {
        return await thumbnail(locator, signal);
      } catch (error) {
        if (error.name === "AbortError") throw error;
        lastError = error;
        if (!/unavailable|missing|moved|not_found|lookup/i.test(String(error.message || ""))) throw error;
      }
    }
    throw lastError || new Error("No image locator is available.");
  }

  function render(url, record) {
    const preview = $("preview");
    preview.innerHTML = "";
    const image = document.createElement("img");
    image.alt = record.filename || "Evidence image";
    image.decoding = "async";
    image.src = url;
    preview.appendChild(image);

    const note = document.createElement("p");
    note.className = "preview-message";
    note.textContent = "Fast image preview shown. Press Preview Evidence to load the full-resolution original when needed.";
    preview.appendChild(note);
  }

  function fallBackToSafePreview() {
    bypassNextRecordChange = true;
    window.dispatchEvent(new CustomEvent("masics:record-change", { detail: { thumbnailFallback: true } }));
  }

  async function loadThumbnail(recordHint = null) {
    const run = ++generation;
    const key = selectedKey();
    const status = $("evidence-status");
    if (!key || !token() || !status) return;
    if (thumbnailAbortController) thumbnailAbortController.abort();
    thumbnailAbortController = new AbortController();
    try {
      status.textContent = "Loading fast image preview from Dropbox...";
      const record = recordHint || activeRecordFrom(await records());
      if (!record || run !== generation || key !== selectedKey()) return;
      const url = await firstThumbnail(record, thumbnailAbortController.signal);
      if (run !== generation || key !== selectedKey()) return;
      render(url, record);
      status.textContent = "Fast image preview loaded. Full-resolution image remains available through Preview Evidence.";
    } catch (error) {
      if (error.name === "AbortError") return;
      if (run === generation && key === selectedKey()) fallBackToSafePreview();
    } finally {
      if (run === generation) thumbnailAbortController = null;
    }
  }

  function scheduleThumbnail(recordHint = null) {
    cancelThumbnailRequest();
    thumbnailTimer = window.setTimeout(() => {
      thumbnailTimer = 0;
      loadThumbnail(recordHint);
    }, 180);
  }

  window.addEventListener("masics:record-change", (event) => {
    if (bypassNextRecordChange) {
      bypassNextRecordChange = false;
      return;
    }
    const ext = extension($("record-title")?.textContent || "");
    if (!imageExts.has(ext)) return;
    event.stopImmediatePropagation();
    scheduleThumbnail(event.detail?.record || null);
  });

  window.addEventListener("pagehide", () => {
    cancelThumbnailRequest();
    for (const url of cache.values()) URL.revokeObjectURL(url);
    cache.clear();
  });

  window.MASICS_IMAGE_THUMBNAIL_SELF_TEST = () => ({
    version: window.MASICS_IMAGE_THUMBNAIL_PREVIEW_VERSION,
    supportsCommonImages: imageExts.has(".jpg") && imageExts.has(".png") && imageExts.has(".webp"),
    usesDropboxThumbnail: /files\/get_thumbnail_v2/.test(thumbnail.toString()),
    keepsFullResolutionOnDemand: /Preview Evidence/.test(render.toString()),
    hasSafePreviewFallback: /thumbnailFallback/.test(fallBackToSafePreview.toString()),
    cachesRecentThumbnails: maxCachedImages > 0,
    debouncesRecordChanges: /setTimeout/.test(scheduleThumbnail.toString()) && /180/.test(scheduleThumbnail.toString()),
    abortsStaleThumbnailRequests: /AbortController/.test(loadThumbnail.toString()) && /signal/.test(thumbnail.toString())
  });
})();
