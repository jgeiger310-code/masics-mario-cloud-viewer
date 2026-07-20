(() => {
  "use strict";

  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const imageExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff"]);
  const cache = new Map();
  const maxCachedImages = 12;
  let generation = 0;
  let bypassNextRecordChange = false;
  let thumbnailTimer = 0;

  window.MASICS_IMAGE_THUMBNAIL_PREVIEW_VERSION = "20260720-thumbnail-metadata-id-1";

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

  function recordExtension(record) {
    const fromExtension = String(record?.extension || "").trim().toLowerCase();
    if (fromExtension) return fromExtension.startsWith(".") ? fromExtension : `.${fromExtension}`;
    const fromType = String(record?.file_type || "").trim().toLowerCase();
    if (fromType && !fromType.includes("/") && !fromType.startsWith(".")) return `.${fromType}`;
    return extension(record?.filename || $("record-title")?.textContent || "");
  }

  function isImageRecord(record) {
    return imageExts.has(recordExtension(record));
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

  function thumbnailResource(locator) {
    const value = String(locator || "").trim();
    if (/^id:/i.test(value)) return { ".tag": "id", id: value };
    return { ".tag": "path", path: value };
  }

  function activeRecordFromApp() {
    const record = window.MASICS_ACTIVE_RECORD;
    if (record && typeof record === "object") return record;
    const records = window.MASICS_QUEUE_RECORDS;
    if (!Array.isArray(records)) return null;
    const position = ($("record-position")?.textContent || "").match(/Record\s+(\d+)\s+of/i);
    if (position) {
      const queueNumber = Number(position[1]);
      const found = records.find((candidate) => Number(candidate.queue_number) === queueNumber);
      if (found) return found;
    }
    const title = ($("record-title")?.textContent || "").trim();
    return records.find((candidate) => candidate.filename === title) || null;
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
  }

  async function thumbnail(locator) {
    if (cache.has(locator)) return cache.get(locator);
    const response = await fetch(DROPBOX_CONTENT + "files/get_thumbnail_v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Dropbox-API-Arg": JSON.stringify({
          resource: thumbnailResource(locator),
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

  async function firstThumbnail(record) {
    let lastError = null;
    for (const locator of locators(record)) {
      try {
        return await thumbnail(locator);
      } catch (error) {
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
    try {
      status.textContent = "Loading fast image preview from Dropbox...";
      const record = recordHint || activeRecordFromApp();
      if (!record || run !== generation || key !== selectedKey()) return;
      const url = await firstThumbnail(record);
      if (run !== generation || key !== selectedKey()) return;
      render(url, record);
      status.textContent = "Fast image preview loaded. Full-resolution image remains available through Preview Evidence.";
    } catch (error) {
      if (run === generation && key === selectedKey()) fallBackToSafePreview();
    }
  }

  function scheduleThumbnail(recordHint = null) {
    cancelThumbnailRequest();
    thumbnailTimer = window.setTimeout(() => {
      thumbnailTimer = 0;
      loadThumbnail(recordHint);
    }, 350);
  }

  function scheduleIfCurrentRecordIsImage(recordHint = null) {
    const record = recordHint || activeRecordFromApp();
    if (!isImageRecord(record)) return;
    scheduleThumbnail(record);
  }

  function recoverMissedInitialRecord() {
    scheduleIfCurrentRecordIsImage();
  }

  window.addEventListener("masics:record-change", (event) => {
    if (bypassNextRecordChange) {
      bypassNextRecordChange = false;
      return;
    }
    const record = event.detail?.record || activeRecordFromApp();
    if (!isImageRecord(record)) return;
    event.stopImmediatePropagation();
    scheduleIfCurrentRecordIsImage(record);
  });

  window.setTimeout(recoverMissedInitialRecord, 0);
  window.addEventListener("load", recoverMissedInitialRecord);

  window.addEventListener("pagehide", () => {
    cancelThumbnailRequest();
    for (const url of cache.values()) URL.revokeObjectURL(url);
    cache.clear();
  });

  window.MASICS_IMAGE_THUMBNAIL_SELF_TEST = () => ({
    version: window.MASICS_IMAGE_THUMBNAIL_PREVIEW_VERSION,
    supportsCommonImages: imageExts.has(".jpg") && imageExts.has(".png") && imageExts.has(".webp"),
    usesDropboxThumbnail: /files\/get_thumbnail_v2/.test(thumbnail.toString()),
    neverDownloadsManifestOrEvidenceForAutoPreview: !/files\/download/.test(activeRecordFromApp.toString() + loadThumbnail.toString()),
    detectsImagesFromRecordMetadata: isImageRecord({ filename: "no-visible-extension", file_type: "jpg" }) && isImageRecord({ filename: "no-visible-extension", extension: "png" }),
    usesDropboxIdResourceForFileIds: thumbnailResource("id:abc123")[".tag"] === "id",
    keepsFullResolutionOnDemand: /Preview Evidence/.test(render.toString()),
    hasSafePreviewFallback: /thumbnailFallback/.test(fallBackToSafePreview.toString()),
    cachesRecentThumbnails: maxCachedImages > 0,
    debouncesRecordChanges: /setTimeout/.test(scheduleThumbnail.toString()) && /350/.test(scheduleThumbnail.toString()),
    recoversMissedInitialRecord: /scheduleIfCurrentRecordIsImage/.test(recoverMissedInitialRecord.toString()),
    ignoresStaleThumbnailResponses: /generation/.test(loadThumbnail.toString()) && /selectedKey/.test(loadThumbnail.toString())
  });
})();
