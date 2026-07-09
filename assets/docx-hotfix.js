(() => {
  "use strict";

  const VERSION = "20260709-2";
  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const MAX_DOCX_PREVIEW_BYTES = 50 * 1024 * 1024;
  const MANIFEST_CACHE_KEY = "masics_docx_hotfix_manifest_cache";
  let manifestRecords = null;
  let activeObjectUrl = "";
  let previewTimer = 0;
  let inFlight = false;
  let queued = false;
  let lastKey = "";

  window.MASICS_DOCX_HOTFIX_VERSION = VERSION;

  function $(id) {
    return document.getElementById(id);
  }

  function token() {
    return window.sessionStorage.getItem("masics_access_token") || "";
  }

  function cfg() {
    return window.MASICS_DROPBOX_CONFIG || {};
  }

  function selectedKey() {
    const position = ($("record-position")?.textContent || "").trim();
    const title = ($("record-title")?.textContent || "").trim();
    return position && title ? `${position}|${title}` : "";
  }

  function unique(values) {
    const seen = new Set();
    return values.flat(Infinity).map((value) => String(value || "").trim()).filter((value) => {
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

  function isDocxRecord(record) {
    return fileExtension(record) === ".docx";
  }

  function releaseObjectUrl() {
    if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = "";
  }

  function setStatus(message) {
    const status = $("evidence-status");
    if (status) status.textContent = message;
  }

  async function dropboxDownload(locator) {
    const response = await fetch(DROPBOX_CONTENT + "files/download", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token()}`,
        "Dropbox-API-Arg": JSON.stringify({ path: locator })
      }
    });
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign in again, then reopen this DOCX.");
    if (response.status === 403) throw new Error("Dropbox permission denied for this DOCX file.");
    if (response.status === 409) throw new Error(`Dropbox file is missing or moved: ${locator}`);
    if (!response.ok) throw new Error(`Dropbox DOCX download failed: ${response.status}`);
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
    throw lastError || new Error("No Dropbox locator is available for this DOCX record.");
  }

  async function loadManifestRecords() {
    if (manifestRecords) return manifestRecords;
    const conf = cfg();
    const response = await downloadFirst([conf.manifestDropboxPath, conf.manifestDropboxPathAlternates || []]);
    const manifest = await response.json();
    if (!manifest || !Array.isArray(manifest.records)) throw new Error("DOCX hotfix could not read the review manifest.");
    manifestRecords = manifest.records;
    try {
      window.sessionStorage.setItem(MANIFEST_CACHE_KEY, JSON.stringify({ at: new Date().toISOString(), count: manifestRecords.length }));
    } catch {}
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
    return records.find((record) => record.filename === title);
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
    save.download = record.filename || "evidence.docx";
    save.textContent = "Save a copy";
    actions.append(open, save);
    container.appendChild(actions);
  }

  function sanitizeDocxHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html || "");
    template.content.querySelectorAll("script, style, iframe, object, embed, form, meta, link").forEach((node) => node.remove());
    template.content.querySelectorAll("*").forEach((node) => {
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith("on") || name === "srcdoc" || ((name === "href" || name === "src") && value.startsWith("javascript:"))) node.removeAttribute(attr.name);
      }
      if (node.tagName === "A") {
        node.target = "_blank";
        node.rel = "noopener noreferrer";
      }
    });
    return template.content;
  }

  async function waitForMammoth() {
    for (let i = 0; i < 20; i += 1) {
      if (window.mammoth && typeof window.mammoth.convertToHtml === "function") return window.mammoth;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    throw new Error("DOCX conversion component did not load. The original DOCX can still be opened or saved below.");
  }

  async function renderDocx(blob, record, preview) {
    activeObjectUrl = URL.createObjectURL(blob);
    appendFileActions(preview, activeObjectUrl, record, "Open DOCX");
    if (blob.size > MAX_DOCX_PREVIEW_BYTES) {
      const message = document.createElement("p");
      message.className = "preview-message";
      message.textContent = "This DOCX is too large for safe in-page preview. Use Open DOCX or Save a copy.";
      preview.prepend(message);
      return { statusMessage: "DOCX fallback ready. File is too large for in-page preview." };
    }
    try {
      const mammoth = await waitForMammoth();
      const result = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
      const article = document.createElement("article");
      article.className = "preview-docx";
      article.appendChild(sanitizeDocxHtml(result.value));
      preview.prepend(article);
      return { statusMessage: "DOCX preview loaded in-page. Open/Save controls are also available." };
    } catch (err) {
      const message = document.createElement("p");
      message.className = "preview-message";
      message.textContent = `${err.message || "DOCX preview failed."} Use Open DOCX or Save a copy.`;
      preview.prepend(message);
      return { statusMessage: "DOCX preview fallback ready. Open/Save controls are available." };
    }
  }

  async function previewActiveDocx(options = {}) {
    const key = selectedKey();
    const preview = $("preview");
    const view = $("record-view");
    if (!key || !preview || !view || view.hidden || !token()) return false;
    if (!options.force && key === lastKey) return false;
    if (inFlight) {
      queued = true;
      return true;
    }
    inFlight = true;
    queued = false;
    lastKey = key;
    try {
      const records = await loadManifestRecords();
      const record = activeRecordFrom(records);
      if (!record || !isDocxRecord(record)) return false;
      releaseObjectUrl();
      preview.innerHTML = "";
      setStatus("Loading DOCX from Dropbox for in-page preview...");
      const response = await downloadFirst([record.dropbox_file_id, record.dropbox_path, record.dropbox_path_alternates || []]);
      const blob = await response.blob();
      if (key !== selectedKey()) return true;
      const result = await renderDocx(blob, record, preview);
      if (key === selectedKey()) setStatus(result.statusMessage);
      return true;
    } catch (err) {
      lastKey = "";
      setStatus(err.message || "DOCX preview failed.");
      return true;
    } finally {
      inFlight = false;
      if (queued) schedulePreview({ force: true });
    }
  }

  function schedulePreview(options = {}) {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => previewActiveDocx(options), options.force ? 0 : 300);
  }

  window.addEventListener("click", (event) => {
    const button = event.target && event.target.closest && event.target.closest("#load-evidence");
    if (!button) return;
    const title = ($("record-title")?.textContent || "").trim().toLowerCase();
    if (!title.endsWith(".docx")) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    lastKey = "";
    previewActiveDocx({ force: true });
  }, true);

  window.addEventListener("masics:record-change", () => schedulePreview());
  window.addEventListener("pagehide", releaseObjectUrl);

  window.MASICS_DOCX_HOTFIX_SELF_TEST = () => {
    const bad = document.createElement("div");
    bad.appendChild(sanitizeDocxHtml('<p onclick="alert(1)"><a href="javascript:bad()">x</a><script>alert(1)</script></p>'));
    return {
      version: VERSION,
      removesScript: !bad.querySelector("script"),
      removesJavascriptHref: !/javascript:/i.test(bad.innerHTML),
      findsDocx: isDocxRecord({ filename: "sample.docx" }),
      ignoresNonDocx: !isDocxRecord({ filename: "sample.pdf" }),
      cache: window.sessionStorage.getItem(MANIFEST_CACHE_KEY) || ""
    };
  };
})();
