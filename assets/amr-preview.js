(() => {
  "use strict";

  const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
  const AMR_DECODER_URL = "https://cdn.jsdelivr.net/npm/@audio/amr-decode@1.0.0/+esm";
  let manifestRecords = null;
  let activeAudio = null;
  let activeOriginalUrl = "";
  let activePlayableUrl = "";

  window.MASICS_AMR_PREVIEW_VERSION = "20260728-amr-nb-wb-wav-2";

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
    const active = window.MASICS_ACTIVE_RECORD;
    if (active && typeof active === "object" && isAmrRecord(active)) return active;
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
      if (activeAudio) {
        activeAudio.pause();
        activeAudio.removeAttribute("src");
        activeAudio.load();
      }
    } catch (_) {}
    activeAudio = null;
    if (activeOriginalUrl) URL.revokeObjectURL(activeOriginalUrl);
    if (activePlayableUrl) URL.revokeObjectURL(activePlayableUrl);
    activeOriginalUrl = "";
    activePlayableUrl = "";
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

  function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  }

  function pcmToWavBlob(channelData, sampleRate) {
    if (!Array.isArray(channelData) || !channelData.length || !channelData[0]?.length) {
      throw new Error("AMR decoder returned no audio samples.");
    }
    const channels = channelData.length;
    const frames = channelData[0].length;
    const bytesPerSample = 2;
    const dataBytes = frames * channels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);

    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * bytesPerSample, true);
    view.setUint16(32, channels * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, dataBytes, true);

    let offset = 44;
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const sample = Math.max(-1, Math.min(1, Number(channelData[channel][frame]) || 0));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  function amrHeader(bytes) {
    const head = new TextDecoder("ascii").decode(bytes.slice(0, 16));
    if (head.startsWith("#!AMR-WB\n")) return "AMR-WB";
    if (head.startsWith("#!AMR\n")) return "AMR-NB";
    return "AMR";
  }

  async function renderAmr(record) {
    const status = $("evidence-status");
    const preview = $("preview");
    if (!status || !preview) return;
    clearActivePlayer();
    preview.innerHTML = "";
    status.textContent = "Loading AMR audio from Dropbox...";

    const response = await downloadFirst(evidenceLocators(record));
    const originalBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(originalBuffer);
    const format = amrHeader(bytes);
    const originalBlob = new Blob([originalBuffer], { type: "audio/amr" });
    activeOriginalUrl = URL.createObjectURL(originalBlob);

    status.textContent = `Decoding ${format} audio in the browser...`;
    const module = await import(AMR_DECODER_URL);
    const decode = module.default;
    if (typeof decode !== "function") throw new Error("AMR decoder module did not expose its decode function.");

    const decoded = await decode(originalBuffer);
    if (!decoded || !decoded.channelData || !decoded.sampleRate) {
      throw new Error("AMR decoder could not read this evidence file.");
    }

    const wavBlob = pcmToWavBlob(decoded.channelData, decoded.sampleRate);
    activePlayableUrl = URL.createObjectURL(wavBlob);

    const shell = document.createElement("div");
    shell.className = "preview-amr";
    const label = document.createElement("p");
    label.className = "preview-message";
    label.textContent = `${record.filename} — ${format} converted temporarily to WAV for browser playback`;

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = activePlayableUrl;
    audio.title = record.filename;
    audio.style.width = "100%";
    activeAudio = audio;

    audio.addEventListener("error", () => {
      const mediaError = audio.error;
      status.textContent = mediaError
        ? `Decoded audio could not play (browser media error ${mediaError.code}). The original AMR is still available.`
        : "Decoded audio could not play. The original AMR is still available.";
    }, { once: true });

    shell.append(label, audio);
    preview.appendChild(shell);
    appendFileActions(preview, activeOriginalUrl, record);
    status.textContent = `${format} decoded successfully at ${decoded.sampleRate} Hz and converted to WAV for playback. Original evidence was not modified.`;
  }

  async function interceptAmrPreview(event) {
    const button = event.target && event.target.closest && event.target.closest("#load-evidence");
    if (!button || !token()) return;
    const activeTitle = ($("record-title")?.textContent || "").trim().toLowerCase();
    const active = window.MASICS_ACTIVE_RECORD;
    if (!isAmrRecord(active) && !/\.(amr|awb)$/.test(activeTitle)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      const records = active && isAmrRecord(active) ? [] : await loadManifest();
      const record = activeRecordFrom(records);
      if (!record || !isAmrRecord(record)) throw new Error("The selected AMR record could not be matched to the Dropbox queue.");
      await renderAmr(record);
    } catch (err) {
      const status = $("evidence-status");
      const preview = $("preview");
      if (preview) preview.innerHTML = "";
      if (status) status.textContent = `AMR playback error: ${err?.message || "Unable to decode this AMR file."}`;
      console.error("MASICS AMR preview failed", err);
    }
  }

  document.addEventListener("click", interceptAmrPreview, true);
  window.addEventListener("masics:record-change", clearActivePlayer);
  window.addEventListener("pagehide", clearActivePlayer);

  window.MASICS_AMR_PREVIEW_SELF_TEST = () => ({
    version: window.MASICS_AMR_PREVIEW_VERSION,
    recognizesAmr: isAmrRecord({ filename: "sample.amr" }),
    recognizesAwb: isAmrRecord({ filename: "sample.awb" }),
    detectsNarrowbandHeader: amrHeader(new TextEncoder().encode("#!AMR\nabc")) === "AMR-NB",
    detectsWidebandHeader: amrHeader(new TextEncoder().encode("#!AMR-WB\nabc")) === "AMR-WB",
    usesDropboxDownload: /files\/download/.test(dropboxDownload.toString()),
    convertsDecodedPcmToWav: /RIFF/.test(pcmToWavBlob.toString()),
    leavesOriginalAvailable: /Save original AMR/.test(appendFileActions.toString()),
    usesActiveRecordWithoutManifestRedownload: /MASICS_ACTIVE_RECORD/.test(activeRecordFrom.toString() + interceptAmrPreview.toString())
  });
})();
