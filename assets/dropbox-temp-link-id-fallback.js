(() => {
  "use strict";
  const originalFetch = window.fetch.bind(window);
  const API = "https://api.dropboxapi.com/2/";
  const TEMP = API + "files/get_temporary_link";
  const SEARCH = API + "files/search_v2";

  function getFilename(path) {
    const s = String(path || "");
    const clean = s.split("?")[0];
    return decodeURIComponent(clean.slice(clean.lastIndexOf("/") + 1)).trim();
  }
  function exactName(file, name) {
    return String(file && file.name || "").toLowerCase() === String(name || "").toLowerCase();
  }
  function rank(file) {
    const p = String(file && (file.path_display || file.path_lower) || "").toLowerCase();
    if (p.includes("/2nd round discovery mario/")) return 0;
    if (p.includes("/mario’s missing files/") || p.includes("/mario's missing files/")) return 1;
    if (p.includes("/01_source_collection_copies/")) return 2;
    if (p.includes("ocr_descriptors") || p.endsWith(".txt") || p.endsWith(".json")) return 99;
    return 5;
  }
  async function findRealDropboxFiles(name, headers) {
    const res = await originalFetch(SEARCH, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: name, options: { path: "/jake Geiger", filename_only: true, max_results: 25, file_status: "active" } })
    });
    if (!res.ok) return [];
    const data = await res.json();
    const files = (data.matches || [])
      .map(m => m && m.metadata && m.metadata.metadata)
      .filter(m => m && m[".tag"] === "file" && exactName(m, name));
    files.sort((a, b) => rank(a) - rank(b));
    return files;
  }
  async function tryTempLink(target, headers) {
    return originalFetch(TEMP, { method: "POST", headers, body: JSON.stringify({ path: target }) });
  }
  window.fetch = async function(input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (!url.includes("/files/get_temporary_link")) return originalFetch(input, init);

    let path = "";
    try { path = JSON.parse(init && init.body || "{}").path || ""; } catch {}
    const first = await originalFetch(input, init);
    if (first.ok || first.status !== 409 || !path) return first;

    let errorText = "";
    try { errorText = await first.clone().text(); } catch {}
    if (!/not_found|path/i.test(errorText)) return first;

    const name = getFilename(path);
    if (!name) return first;

    const headers = (init && init.headers) || {};
    try {
      const files = await findRealDropboxFiles(name, headers);
      for (const f of files) {
        const candidates = [f.id, f.path_display, f.path_lower].filter(Boolean);
        for (const c of candidates) {
          const retry = await tryTempLink(c, headers);
          if (retry.ok) return retry;
        }
      }
    } catch {}
    return first;
  };
})();
