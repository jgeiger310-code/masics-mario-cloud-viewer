(() => {
  "use strict";

  const DROPBOX_RPC = "https://api.dropboxapi.com/2/";
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const PDFJS_DIST_VERSION = "6.1.200";
  const PDFJS_MODULE_URL = `./vendor/pdf.mjs?v=${PDFJS_DIST_VERSION}`;
  const PDFJS_WORKER_URL = `./vendor/pdf.worker.mjs?v=${PDFJS_DIST_VERSION}`;
  const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
  const pdfExts = [".pdf"];
  const audioExts = [".mp3", ".wav", ".m4a", ".aac", ".ogg"];
  const videoExts = [".mp4", ".mov", ".m4v", ".webm"];
  const textExts = [".txt", ".csv", ".json", ".md"];
  const docxExts = [".docx"];
  const officeExts = [".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".odt", ".ods", ".odp", ".rtf"];
  const maxDocxPreviewBytes = 50 * 1024 * 1024;
  const maxAutoPreviewBytes = Number(window.MASICS_MAX_AUTO_PREVIEW_BYTES || 25 * 1024 * 1024);
  const maxInitialPdfPages = Number(window.MASICS_MAX_INITIAL_PDF_PAGES || 5);
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
  let activePreviewAbortController = null;
  let pdfJsPromise = null;

  window.MASICS_SAFE_PREVIEW_VERSION = "20260709-docx-auto-1";

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
    const fromExtension = String(record.extension || "").trim().toLowerCase();
    if (fromExtension) return fromExtension.startsWith(".") ? fromExtension : `.${fromExtension}`;
    const fromType = String(record.file_type || "").trim().toLowerCase();
    if (fromType && !fromType.includes("/") && !fromType.startsWith(".")) return `.${fromType}`;
    const fromName = String(record.filename || "").trim().toLowerCase().match(/\.[a-z0-9]{1,8}$/);
    return fromName ? fromName[0] : "";
  }

  function isImageRecord(record) {
    return imageExts.includes(fileExtension(record));
  }

  function isPdfRecord(record) {
    return pdfExts.includes(fileExtension(record));
  }

  function isAudioRecord(record) {
    return audioExts.includes(fileExtension(record));
  }

  function isVideoRecord(record) {
    return videoExts.includes(fileExtension(record));
  }

  function isDocxRecord(record) {
    return docxExts.includes(fileExtension(record));
  }

  function isAutoPreviewRecord(record) {
    return isImageRecord(record) || isPdfRecord(record) || isAudioRecord(record) || isVideoRecord(record) || isDocxRecord(record);
  }

  function isAndroidBrowser() {
    return /Android/i.test(navigator.userAgent || "");
  }

  function previewBlob(blob, record) {
    const ext = fileExtension(record);
    const type = previewTypes[ext] || blob.type || "application/octet-stream";
    if (blob.type === type) return blob;
    return new Blob([blob], { type });
  }

  async function dropboxDownload(locator, signal = null) {
    const response = await fetch(DROPBOX_CONTENT + "files/download", {
      method: "POST",
      signal,
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

  async function downloadFirst(locators, signal = null) {
    let lastError = null;
    for (const locator of unique(locators)) {
      try {
        return await dropboxDownload(locator, signal);
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

  function cancelActivePreview() {
    if (activePreviewAbortController) activePreviewAbortController.abort();
    activePreviewAbortController = null;
    releasePreviewUrl();
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
    message.textContent = `${record.filename} is not auto-previewed. Press Preview Evidence to load it safely from Dropbox.`;
    preview.appendChild(message);
  }

  function appendFileActions(container, url, record, openLabel = "Open original") {
    const actions = document.createElement("div");
    actions.className = "preview-file-actions";
    const open = document.createElement("a");
    open.className = "preview-open";
    open.href = url;
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = openLabel;
    const save = document.createElement("a");
    save.className = "preview-open";
    save.href = url;
    save.download = record.filename || "evidence-file";
    save.textContent = "Save a copy";
    actions.append(open, save);
    container.appendChild(actions);
  }

  function sanitizeDocxHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    template.content.querySelectorAll("script, style, iframe, object, embed, form").forEach((node) => node.remove());
    template.content.querySelectorAll("*").forEach((node) => {
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith("on") || name === "srcdoc" || ((name === "href" || name === "src") && value.startsWith("javascript:"))) {
          node.removeAttribute(attr.name);
        }
      }
      if (node.tagName === "A") {
        node.target = "_blank";
        node.rel = "noopener noreferrer";
      }
    });
    return template.content;
  }

  async function renderDocxPreview(blob, url, record, preview) {
    if (!window.mammoth || typeof window.mammoth.convertToHtml !== "function") {
      throw new Error("The DOCX preview component did not load.");
    }
    if (blob.size > maxDocxPreviewBytes) {
      const message = document.createElement("p");
      message.className = "preview-message";
      message.textContent = "This DOCX is too large for a safe in-page preview. Open the original file instead.";
      preview.appendChild(message);
      appendFileActions(preview, url, record);
      return;
    }
    const result = await window.mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
    const article = document.createElement("article");
    article.className = "preview-docx";
    article.appendChild(sanitizeDocxHtml(result.value));
    preview.appendChild(article);
    appendFileActions(preview, url, record);
  }

  function renderMediaElement(tagName, url, record) {
    const media = document.createElement(tagName);
    media.controls = true;
    media.preload = "metadata";
    media.src = url;
    media.title = record.filename;
    media.addEventListener("error", () => {
      const status = $("evidence-status");
      if (status) status.textContent = "Browser could not decode this media file, but no file was downloaded.";
    }, { once: true });
    return media;
  }

  async function loadPdfJs() {
    if (!pdfJsPromise) {
      pdfJsPromise = import(PDFJS_MODULE_URL).then((pdfjsLib) => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        return pdfjsLib;
      });
    }
    return pdfJsPromise;
  }

  function renderNativePdfFallback(url, record) {
    const shell = document.createElement("div");
    shell.className = "preview-pdf";
    const frame = document.createElement("iframe");
    frame.title = record.filename;
    frame.src = url;
    shell.appendChild(frame);
    appendFileActions(shell, url, record, "Open PDF");
    return shell;
  }

  function pdfCanvasWidth() {
    const preview = $("preview");
    const available = (preview && preview.clientWidth ? preview.clientWidth : window.innerWidth) - 42;
    return Math.max(280, Math.min(available, 980));
  }

  async function renderPdfPage(page, pages, pageNumber) {
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.max(0.45, Math.min(2.2, pdfCanvasWidth() / baseViewport.width));
    const viewport = page.getViewport({ scale });
    const outputScale = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));

    const pageShell = document.createElement("section");
    pageShell.className = "pdf-page";
    pageShell.setAttribute("aria-label", `PDF page ${pageNumber}`);

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const caption = document.createElement("div");
    caption.className = "pdf-page-caption";
    caption.textContent = `Page ${pageNumber}`;

    pageShell.appendChild(canvas);
    pageShell.appendChild(caption);
    pages.appendChild(pageShell);

    const canvasContext = canvas.getContext("2d", { alpha: false });
    const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
    await page.render({ canvasContext, viewport, transform }).promise;
  }

  async function renderPdfPreview(blob, url, record, expectedKey) {
    const preview = $("preview");
    const shell = document.createElement("div");
    shell.className = "preview-pdf preview-pdf-canvas";

    const note = document.createElement("p");
    note.className = "pdf-render-note";
    note.textContent = "Rendering PDF in this page for Android-compatible viewing...";

    const pages = document.createElement("div");
    pages.className = "pdf-pages";

    shell.appendChild(note);
    shell.appendChild(pages);
    preview.appendChild(shell);

    try {
      const pdfjsLib = await loadPdfJs();
      const data = new Uint8Array(await blob.arrayBuffer());
      const task = pdfjsLib.getDocument({ data, isEvalSupported: false, useWorkerFetch: false });
      const pdf = await task.promise;
      if (expectedKey && selectedKey() !== expectedKey) return { statusMessage: "Preview changed before PDF finished rendering." };

      let renderedPages = 0;
      async function renderThrough(limit) {
        for (let pageNumber = renderedPages + 1; pageNumber <= Math.min(limit, pdf.numPages); pageNumber += 1) {
          if (expectedKey && selectedKey() !== expectedKey) break;
          const page = await pdf.getPage(pageNumber);
          await renderPdfPage(page, pages, pageNumber);
          renderedPages = pageNumber;
        }
      }
      note.textContent = `${record.filename} rendered in-page (${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}). Showing the first ${Math.min(maxInitialPdfPages, pdf.numPages)} page${Math.min(maxInitialPdfPages, pdf.numPages) === 1 ? "" : "s"} to protect browser memory.`;
      await renderThrough(maxInitialPdfPages);
      if (renderedPages < pdf.numPages) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "preview-open";
        const label = () => `Load ${Math.min(maxInitialPdfPages, pdf.numPages - renderedPages)} more PDF page${Math.min(maxInitialPdfPages, pdf.numPages - renderedPages) === 1 ? "" : "s"}`;
        more.textContent = label();
        more.addEventListener("click", async () => {
          more.disabled = true;
          await renderThrough(renderedPages + maxInitialPdfPages);
          if (renderedPages < pdf.numPages) {
            more.disabled = false;
            more.textContent = label();
          } else {
            more.remove();
            note.textContent = `${record.filename} fully rendered in-page (${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}).`;
          }
        });
        shell.appendChild(more);
      }
      return { statusMessage: "PDF preview rendered in-page. No file was downloaded." };
    } catch (err) {
      shell.innerHTML = "";
      if (!isAndroidBrowser() && url) {
        preview.appendChild(renderNativePdfFallback(url, record));
        return { statusMessage: "PDF.js renderer failed, so desktop browser PDF fallback was used. No file was downloaded." };
      }
      const message = document.createElement("p");
      message.className = "preview-message";
      message.textContent = "Android-safe PDF preview could not load. Reload the fresh viewer link and try Preview Evidence again.";
      shell.appendChild(message);
      throw err;
    }
  }

  async function renderPreview(blob, url, record, expectedKey) {
    const preview = $("preview");
    const ext = fileExtension(record);
    preview.innerHTML = "";
    if (blob.type.startsWith("image/") || imageExts.includes(ext)) {
      const img = document.createElement("img");
      img.alt = record.filename;
      img.src = url;
      preview.appendChild(img);
      return { statusMessage: "Image preview loaded in-page. No file was downloaded." };
    }
    if (blob.type === "application/pdf" || pdfExts.includes(ext)) {
      return await renderPdfPreview(blob, url, record, expectedKey);
    }
    if (docxExts.includes(ext)) {
      await renderDocxPreview(blob, url, record, preview);
      return { statusMessage: "DOCX preview loaded in-page. No file was saved to this device." };
    }
    if (blob.type.startsWith("audio/") || isAudioRecord(record)) {
      preview.appendChild(renderMediaElement("audio", url, record));
      appendFileActions(preview, url, record, "Open audio");
      return { statusMessage: "Media preview loaded in-page. No file was downloaded." };
    }
    if (blob.type.startsWith("video/") || isVideoRecord(record)) {
      preview.appendChild(renderMediaElement("video", url, record));
      appendFileActions(preview, url, record, "Open video");
      return { statusMessage: "Media preview loaded in-page. No file was downloaded." };
    }
    if (blob.type.startsWith("text/") || textExts.includes(ext)) {
      const pre = document.createElement("pre");
      pre.textContent = (await blob.text()).slice(0, 200000);
      preview.appendChild(pre);
      appendFileActions(preview, url, record, "Open text file");
      return { statusMessage: "Text preview loaded in-page. No file was downloaded." };
    }
    const message = document.createElement("p");
    message.className = "preview-message";
    message.textContent = officeExts.includes(ext)
      ? "This browser cannot display this Office format in-page. Open the original file in its installed app."
      : "This format cannot be displayed in-page. The original file is still available.";
    preview.appendChild(message);
    appendFileActions(preview, url, record);
    return { statusMessage: "Use Open original or Save a copy for this file type." };
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

      if (!options.force && !isAutoPreviewRecord(record)) {
        showNoDownloadMessage(record);
        status.textContent = "Preview waits for Preview Evidence. No file was downloaded.";
        return;
      }

      status.textContent = isImageRecord(record) ? "Loading in-page image preview from Dropbox..." : isDocxRecord(record) ? "Loading DOCX preview from Dropbox..." : "Loading evidence preview from Dropbox...";
      const recordSize = Number(record.file_size || record.size || 0);
      if (!options.force && recordSize > maxAutoPreviewBytes) {
        showNoDownloadMessage(record);
        status.textContent = `Auto-preview skipped because this file is larger than ${Math.round(maxAutoPreviewBytes / 1024 / 1024)} MB. Press Preview Evidence to load it intentionally.`;
        return;
      }
      const locators = [record.dropbox_file_id, record.dropbox_path, record.dropbox_path_alternates || []];
      cancelActivePreview();
      activePreviewAbortController = new AbortController();
      const response = await downloadFirst(locators, activePreviewAbortController.signal);
      const blob = previewBlob(await response.blob(), record);
      activePreviewUrl = URL.createObjectURL(blob);
      if (key !== selectedKey()) return;
      const result = await renderPreview(blob, activePreviewUrl, record, key);
      if (key !== selectedKey()) return;
      status.textContent = result?.statusMessage || "Evidence preview loaded in-page. No file was downloaded.";
    } catch (err) {
      lastPreviewKey = "";
      if (err.name !== "AbortError") status.textContent = err.message || "Unable to load evidence preview.";
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
  window.addEventListener("pagehide", cancelActivePreview);

  window.MASICS_SAFE_PREVIEW_SELF_TEST = () => ({
    version: window.MASICS_SAFE_PREVIEW_VERSION,
    docxIsAutoPreview: isAutoPreviewRecord({ filename: "sample.docx" }),
    docIsNotAutoPreview: !isAutoPreviewRecord({ filename: "sample.doc" }),
    pptxIsNotAutoPreview: !isAutoPreviewRecord({ filename: "sample.pptx" }),
    xlsxIsNotAutoPreview: !isAutoPreviewRecord({ filename: "sample.xlsx" }),
    onlyActiveRecordHasDownloadPath: /const record = activeRecordFrom\(allRecords\)/.test(previewActiveRecord.toString()) && !/forEach\(|for \(let.*records/.test(previewActiveRecord.toString()),
    noProgrammaticSaveClick: !/\.click\(\)/.test(appendFileActions.toString()),
    hasAutoPreviewByteLimit: maxAutoPreviewBytes > 0,
    hasInitialPdfPageLimit: maxInitialPdfPages > 0,
    hasAbortController: /AbortController/.test(previewActiveRecord.toString()),
    hasLoadMorePages: /Load .*more PDF page/.test(renderPdfPreview.toString())
  });
})();
