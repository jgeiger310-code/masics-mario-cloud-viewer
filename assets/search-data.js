(() => {
  "use strict";
  const A = window.MASICSSearchApp = window.MASICSSearchApp || {};
  const RPC = "https://api.dropboxapi.com/2/";
  const CONTENT = "https://content.dropboxapi.com/2/";
  const cfg = window.MASICS_DROPBOX_CONFIG || {};
  const core = window.MASICSSearchCore;
  const store = window.sessionStorage;
  const $ = (id) => document.getElementById(id);
  const E = {
    status: $("status-line"), badge: $("catalog-badge"), signIn: $("sign-in"), signOut: $("sign-out"),
    query: $("query"), go: $("search-button"), related: $("related-terms"), fuzzy: $("fuzzy-search"),
    decisions: $("decision-filters"), categories: $("file-category-filters"),
    ocr: $("has-ocr"), transcript: $("has-transcript"), type: $("file-type"),
    folder: $("folder-filter"), qmin: $("queue-min"), qmax: $("queue-max"), saved: $("saved-searches"),
    save: $("save-search"), clear: $("clear-search"), count: $("result-count"), expand: $("expansion-note"),
    sort: $("sort-results"), select: $("select-page"), exportSel: $("export-selected"), exportAll: $("export-results"),
    loading: $("loading-state"), bar: $("progress-bar"), loadingMsg: $("loading-message"), list: $("results-list"),
    pages: $("pagination"), prev: $("previous-page"), next: $("next-page"), pageStatus: $("page-status"),
    dialog: $("preview-dialog"), previewPos: $("preview-position"), previewTitle: $("preview-title"),
    previewStatus: $("preview-status"), previewBody: $("preview-body"), previewReview: $("preview-review"),
    previewDropbox: $("preview-dropbox"), close: $("close-preview")
  };
  const S = {
    token: store.getItem("masics_access_token") || "", records: [], map: new Map(), results: [], worker: null,
    ready: false, request: 0, page: 1, selected: new Set(), mode: "", path: "", objectUrl: "", expansions: [], timer: 0
  };
  const catalogPaths = [
    ...(cfg.searchCatalogDropboxPaths || []),
    `${String(cfg.progressDropboxFolder || "").replace(/\/+$/g, "")}/SEARCH_INDEX/MASICS_SEARCH_CATALOG_LATEST.json.gz`,
    `${String(cfg.progressDropboxFolder || "").replace(/\/+$/g, "")}/SEARCH_INDEX/MASICS_SEARCH_CATALOG_LATEST.json`,
    "/jake Geiger/Mario_Viewer_Exports/Solid_AI_And_Sidecar_Cleanup/SEARCHABLE_FILE_INDEX_20260721_124238.csv"
  ].filter(Boolean);
  const unique = (values) => [...new Set(values.flat().filter(Boolean))];
  const status = (message) => { E.status.textContent = message; };
  function loading(message, percent = 0, show = true) {
    E.loading.hidden = !show;
    E.loadingMsg.textContent = message;
    E.bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function random64(bytes = 32) {
    const data = new Uint8Array(bytes);
    crypto.getRandomValues(data);
    return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  async function sha64(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  async function request(url, options) {
    let last;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await fetch(url, options); }
      catch (error) {
        last = error;
        if (!/Failed to fetch|NetworkError|Load failed/i.test(String(error))) throw error;
        await wait(500 * (attempt + 1));
      }
    }
    throw last;
  }
  async function download(path) {
    const response = await request(CONTENT + "files/download", {
      method: "POST",
      headers: { Authorization: `Bearer ${S.token}`, "Dropbox-API-Arg": JSON.stringify({ path }) }
    });
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign in again.");
    if (response.status === 409) { const error = new Error(`Dropbox file not found: ${path}`); error.lookup = true; throw error; }
    if (!response.ok) throw new Error(`Dropbox download failed: ${response.status}`);
    return response;
  }
  async function rpc(endpoint, body) {
    const response = await request(RPC + endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${S.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (response.status === 401) throw new Error("Dropbox sign-in expired. Sign in again.");
    if (response.status === 409) { const error = new Error("Dropbox could not locate the file."); error.lookup = true; throw error; }
    if (!response.ok) throw new Error(`Dropbox request failed: ${response.status}`);
    return response.json();
  }
  async function tempLink(path) {
    const result = await rpc("files/get_temporary_link", { path });
    if (!result.link) throw new Error("Dropbox did not return a preview link.");
    return result.link;
  }
  async function responseText(response, gzip) {
    if (!gzip) return response.text();
    if (typeof DecompressionStream !== "function") throw new Error("Compressed catalog unsupported");
    return new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).text();
  }
  async function loadCatalog() {
    let last;
    for (const path of unique(catalogPaths)) {
      try {
        loading(`Loading ${path.split("/").pop()}…`, 5);
        const text = await responseText(await download(path), path.toLowerCase().endsWith(".gz"));
        let rows;
        if (path.toLowerCase().endsWith(".csv")) { rows = core.parseCsv(text); S.mode = "metadata"; }
        else {
          const catalog = JSON.parse(text);
          if (!Array.isArray(catalog.records) || Number(catalog.record_count || catalog.records.length) !== catalog.records.length) {
            throw new Error("Search catalog is malformed.");
          }
          rows = catalog.records;
          S.mode = rows.some((record) => record.ocr_text || record.transcript_text) ? "full" : "metadata";
        }
        if (!rows.length) throw new Error("Search catalog is empty.");
        S.path = path;
        return rows;
      } catch (error) {
        last = error;
        if (!error.lookup && !/compressed catalog unsupported/i.test(error.message)) throw error;
      }
    }
    throw last || new Error("No search catalog was found.");
  }
  async function optionalJson(paths) {
    for (const path of unique(paths)) {
      try { return await (await download(path)).json(); }
      catch (error) { if (!error.lookup) console.warn(path, error); }
    }
    return null;
  }
  function splitNotes(value) {
    const text = String(value || "");
    const index = text.indexOf("AI note:");
    return index < 0 ? { mario: text.trim(), ai: "" } : { mario: text.slice(0, index).trim(), ai: text.slice(index + 8).trim() };
  }
  /** Remove Mario marker stars (*, **, ***, ****, etc.) from note text for display/export. */
  function scrubStarMarkers(value) {
    return String(value || "")
      .replace(/\*+/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  function scrubRecordNotes(record) {
    if (!record || typeof record !== "object") return record;
    if (String(record.decision || "").toLowerCase() === "missing") {
      if (record.mario_notes) record.mario_notes = scrubStarMarkers(record.mario_notes);
      if (record.ai_note) record.ai_note = scrubStarMarkers(record.ai_note);
      if (record.notes) record.notes = scrubStarMarkers(record.notes);
    }
    return record;
  }
  /**
   * Source of truth = current viewer queue (manifest).
   * Catalog/CSV only enriches OCR/transcript/search text.
   * Progress is READ-ONLY overlay for current decisions/notes display.
   * Archived or extra catalog rows that are not in the live manifest are dropped.
   * Nothing here writes to Dropbox, SQLite, or the production viewer tracker.
   */
  function mergeData(catalog, manifest, progress) {
    const catalogById = new Map(
      (catalog || []).map((record) => [String(record.review_id || record.id || ""), { ...record }])
    );
    const manifestRecords = manifest?.records || [];
    if (!manifestRecords.length) {
      throw new Error("Current queue list (manifest) is required. Search will not invent or keep a separate file list.");
    }
    const byId = new Map();
    manifestRecords.forEach((source) => {
      const id = String(source.review_id || "");
      if (!id) return;
      const extra = catalogById.get(id) || {};
      // Manifest wins for identity/path/queue; catalog may add ocr/transcript/search fields only.
      byId.set(id, {
        ...extra,
        ...source,
        review_id: id,
        filename: source.filename || extra.filename,
        dropbox_path: source.dropbox_path || extra.dropbox_path,
        dropbox_file_id: source.dropbox_file_id || extra.dropbox_file_id,
        dropbox_path_alternates: unique([source.dropbox_path_alternates || [], extra.dropbox_path_alternates || []]),
        ocr_text: extra.ocr_text || source.ocr_text || "",
        transcript_text: extra.transcript_text || source.transcript_text || "",
        has_ocr_sidecar: extra.has_ocr_sidecar ?? source.has_ocr_sidecar,
        has_transcript_sidecar: extra.has_transcript_sidecar ?? source.has_transcript_sidecar,
        ai_note: source.ai_note || extra.ai_note || "",
        mario_notes: source.mario_notes || extra.mario_notes || "",
        decision: source.decision || extra.decision || ""
      });
    });
    // Read-only: reflect Mario's current decisions/notes in search results; never save back.
    Object.entries(progress?.decisions || {}).forEach(([id, saved]) => {
      const record = byId.get(id);
      if (!record) return;
      const notes = splitNotes(saved.notes);
      record.decision = saved.decision || record.decision || "";
      // Always apply progress notes when present (including empty clear), then scrub missing stars.
      if (saved.notes != null && saved.notes !== "") {
        record.mario_notes = notes.mario || record.mario_notes || "";
        record.ai_note = notes.ai || record.ai_note || "";
      }
      if (notes.mario) record.mario_notes = notes.mario;
      if (notes.ai) record.ai_note = notes.ai;
      record.updated_at = saved.updatedAt || record.updated_at || "";
      scrubRecordNotes(record);
    });
    return [...byId.values()]
      .filter((record) => record.review_id)
      .map(scrubRecordNotes)
      .sort((a, b) => Number(a.queue_number) - Number(b.queue_number));
  }
  async function loadData() {
    const base = String(cfg.progressDropboxFolder || "").replace(/\/+$/g, "");
    // Manifest is required (current list). Catalog is optional enrichment. Progress is optional read-only overlay.
    const [catalogResult, manifest, progress] = await Promise.all([
      loadCatalog().catch((error) => {
        console.warn("Search catalog enrichment unavailable; using current queue list only.", error);
        return [];
      }),
      optionalJson([cfg.manifestDropboxPath, cfg.manifestDropboxPathAlternates || []]),
      optionalJson([
        cfg.progressDropboxLatestJsonId,
        base ? `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json` : "",
        (cfg.progressDropboxFolderAlternates || []).map((folder) => `${String(folder).replace(/\/+$/g, "")}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`)
      ])
    ]);
    if (!manifest || !Array.isArray(manifest.records) || !manifest.records.length) {
      throw new Error("Could not load the current queue list (MASICS_MARIO_QUEUE_MANIFEST). Search is read-only and must follow the live list.");
    }
    const records = mergeData(catalogResult || [], manifest, progress);
    if (!records.length) throw new Error("No searchable records were loaded from the current queue list.");
    return records;
  }
  const INDEX_DB_NAME = "masics_search_index_cache_v2";
  const INDEX_STORE = "indexes";
  const INDEX_MAX_BYTES = 45 * 1024 * 1024;

  function openIndexDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      const request = indexedDB.open(INDEX_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(INDEX_STORE)) db.createObjectStore(INDEX_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    });
  }

  async function idbGet(key) {
    try {
      const db = await openIndexDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(INDEX_STORE, "readonly");
        const req = tx.objectStore(INDEX_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async function idbSet(key, value) {
    try {
      const db = await openIndexDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(INDEX_STORE, "readwrite");
        tx.objectStore(INDEX_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      return true;
    } catch {
      return false;
    }
  }

  function fingerprintRecords(records) {
    // Cheap stable key: count + first/last ids + sample of updated fields
    const n = records.length;
    if (!n) return "empty";
    const first = records[0]?.review_id || "";
    const last = records[n - 1]?.review_id || "";
    let acc = 0;
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 64))) {
      const r = records[i];
      acc = (acc + String(r.review_id || "").length * 17 + String(r.decision || "").length * 3 + String(r.mario_notes || "").length) >>> 0;
    }
    return `v2:${n}:${first}:${last}:${acc}:${S.mode || "meta"}`;
  }

  function createWorker() {
    S.worker?.terminate();
    S.worker = new Worker("assets/search-worker.js?v=20260724-file-category-1");
    const cacheKey = fingerprintRecords(S.records);
    S.worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "build-progress") loading(`Building search index for ${S.records.length.toLocaleString()} records…`, message.percent);
      else if (message.type === "build-complete") {
        S.ready = true;
        loading("", 100, false);
        const fromCache = message.fromCache ? " (cached index)" : "";
        status(`${S.records.length.toLocaleString()} queue records ready${fromCache}. Search is read-only — it cannot change evidence or review decisions.`);
        if (message.serialized && !message.fromCache) {
          // Persist for next session when payload is not huge.
          try {
            const approx = JSON.stringify(message.serialized).length;
            if (approx <= INDEX_MAX_BYTES) {
              idbSet(cacheKey, { key: cacheKey, savedAt: Date.now(), payload: message.serialized }).catch(() => {});
            }
          } catch {
            /* ignore cache write failures */
          }
        }
        A.runSearch();
      } else if (message.type === "search-results" && message.requestId === S.request) {
        S.results = message.results || [];
        S.expansions = message.expansions || [];
        S.page = 1;
        S.selected.clear();
        A.render();
      } else if (message.type === "error") status(message.message || "Search failed.");
    };
    S.worker.onerror = (event) => status(`Search engine failed: ${event.message || "unknown error"}`);

    // Try hydrate from IndexedDB first for speed; fall back to full build.
    idbGet(cacheKey).then((cached) => {
      if (cached?.payload?.version === 2 && Array.isArray(cached.payload.docs) && cached.payload.docs.length === S.records.length) {
        loading("Restoring cached search index…", 40);
        S.worker.postMessage({ type: "hydrate", payload: cached.payload });
        return;
      }
      S.worker.postMessage({ type: "build", records: S.records });
    }).catch(() => {
      S.worker.postMessage({ type: "build", records: S.records });
    });
  }
  function encodeOauthState(plainState, verifier, returnTo) {
    // Same masics1 envelope as auth-storage-fallback so production index can recover
    // PKCE verifier + return_to after the Dropbox redirect (sessionStorage does not cross localhost → github.io).
    const payload = JSON.stringify({ s: plainState, v: verifier, r: returnTo || "", t: Date.now() });
    const b64 = btoa(unescape(encodeURIComponent(payload)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    return `masics1.${b64}`;
  }

  async function signIn() {
    if (!cfg.appKey || !cfg.redirectUri) throw new Error("Dropbox sign-in is not configured.");
    // Dropbox redirect_uri is production github.io. OAuth must start on that origin or return_to is lost
    // and the user is stranded on the Mario viewer. Send them to production search first when needed.
    let redirectBase;
    try {
      redirectBase = new URL(cfg.redirectUri);
    } catch {
      throw new Error("Dropbox redirect URI is invalid.");
    }
    if (location.origin !== redirectBase.origin) {
      status("Opening the production Evidence Search page for Dropbox sign-in (required so you are not sent into the Mario review viewer)…");
      location.href = new URL("search.html", cfg.redirectUri).href;
      return;
    }
    const plainState = random64(24);
    const verifier = random64(64);
    const challenge = await sha64(verifier);
    store.setItem("masics_oauth_state", plainState);
    store.setItem("masics_pkce_verifier", verifier);
    store.setItem("masics_auth_return_to", "search");
    // Embed verifier + return_to in OAuth state (survives redirect even if storage is wiped).
    const state = encodeOauthState(plainState, verifier, "search");
    // Search tool is view/search only — never request Dropbox write scopes.
    const readOnlyScopes = ["files.metadata.read", "files.content.read"];
    const query = new URLSearchParams({
      client_id: cfg.appKey,
      response_type: "code",
      redirect_uri: cfg.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      token_access_type: "online",
      scope: readOnlyScopes.join(" ")
    });
    location.href = `https://www.dropbox.com/oauth2/authorize?${query}`;
  }
  function signOut() {
    ["masics_access_token", "masics_oauth_state", "masics_pkce_verifier", "masics_auth_return_to"].forEach((key) => store.removeItem(key));
    S.worker?.terminate();
    Object.assign(S, { token: "", records: [], map: new Map(), results: [], worker: null, ready: false });
    E.signIn.hidden = false; E.signOut.hidden = true; E.list.innerHTML = "";
    E.badge.textContent = "Not loaded"; E.badge.className = "catalog-badge";
    status("Signed out. Sign in with Dropbox to search the protected database.");
    loading("The protected catalog has not been loaded.");
  }
  Object.assign(A, { cfg, core, store, E, S, PAGE: 50, unique, status, loading, download, tempLink, loadData, createWorker, signIn, signOut });
})();
