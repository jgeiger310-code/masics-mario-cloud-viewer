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
    decisions: $("decision-filters"), ocr: $("has-ocr"), transcript: $("has-transcript"), type: $("file-type"),
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
  function mergeData(catalog, manifest, progress) {
    const byId = new Map(catalog.map((record) => [String(record.review_id || record.id || ""), { ...record }]));
    (manifest?.records || []).forEach((source) => {
      const id = String(source.review_id || "");
      const record = byId.get(id) || {};
      byId.set(id, {
        ...source, ...record, review_id: id, filename: record.filename || source.filename,
        dropbox_path: record.dropbox_path || source.dropbox_path,
        dropbox_file_id: source.dropbox_file_id || record.dropbox_file_id,
        dropbox_path_alternates: unique([source.dropbox_path_alternates || [], record.dropbox_path_alternates || []])
      });
    });
    Object.entries(progress?.decisions || {}).forEach(([id, saved]) => {
      const record = byId.get(id);
      if (!record) return;
      const notes = splitNotes(saved.notes);
      record.decision = saved.decision || record.decision || "";
      if (notes.mario) record.mario_notes = notes.mario;
      if (notes.ai) record.ai_note = notes.ai;
      record.updated_at = saved.updatedAt || record.updated_at || "";
    });
    return [...byId.values()].filter((record) => record.review_id).sort((a, b) => Number(a.queue_number) - Number(b.queue_number));
  }
  async function loadData() {
    const base = String(cfg.progressDropboxFolder || "").replace(/\/+$/g, "");
    const [catalog, manifest, progress] = await Promise.all([
      loadCatalog(),
      optionalJson([cfg.manifestDropboxPath, cfg.manifestDropboxPathAlternates || []]),
      optionalJson([
        cfg.progressDropboxLatestJsonId,
        base ? `${base}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json` : "",
        (cfg.progressDropboxFolderAlternates || []).map((folder) => `${String(folder).replace(/\/+$/g, "")}/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json`)
      ])
    ]);
    const records = mergeData(catalog, manifest, progress);
    if (!records.length) throw new Error("No searchable records were loaded.");
    return records;
  }
  function createWorker() {
    S.worker?.terminate();
    S.worker = new Worker("assets/search-worker.js?v=20260721-1");
    S.worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "build-progress") loading(`Building search index for ${S.records.length.toLocaleString()} records…`, message.percent);
      else if (message.type === "build-complete") {
        S.ready = true;
        loading("", 100, false);
        status(`${S.records.length.toLocaleString()} records ready. Search is read-only and cannot change evidence or review decisions.`);
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
    S.worker.postMessage({ type: "build", records: S.records });
  }
  async function signIn() {
    if (!cfg.appKey || !cfg.redirectUri) throw new Error("Dropbox sign-in is not configured.");
    const state = random64(24), verifier = random64(64), challenge = await sha64(verifier);
    store.setItem("masics_oauth_state", state);
    store.setItem("masics_pkce_verifier", verifier);
    store.setItem("masics_auth_return_to", "search");
    const query = new URLSearchParams({
      client_id: cfg.appKey, response_type: "code", redirect_uri: cfg.redirectUri, state,
      code_challenge: challenge, code_challenge_method: "S256", token_access_type: "online",
      scope: (cfg.scopes || ["files.metadata.read", "files.content.read"]).join(" ")
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
