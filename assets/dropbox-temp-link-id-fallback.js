(() => {
  "use strict";
  const originalFetch = window.fetch.bind(window);
  const API = "https://api.dropboxapi.com/2/";
  const TEMP = API + "files/get_temporary_link";
  const SEARCH = API + "files/search_v2";

  function basename(path) {
    const s = String(path || "").split("?")[0];
    return decodeURIComponent(s.slice(s.lastIndexOf("/") + 1)).trim();
  }
  function exact(file, name) {
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
  async function searchFiles(name, headers, withPath) {
    const options = { filename_only: true, max_results: 50, file_status: "active" };
    if (withPath) options.path = "/jake Geiger";
    const res = await originalFetch(SEARCH, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: name, options })
    });
    if (!res.ok) return [];
    const data = await res.json();
    const files = (data.matches || [])
      .map(m => m && m.metadata && m.metadata.metadata)
      .filter(m => m && m[".tag"] === "file" && exact(m, name));
    files.sort((a, b) => rank(a) - rank(b));
    return files;
  }
  async function tempLink(target, headers) {
    return originalFetch(TEMP, { method: "POST", headers, body: JSON.stringify({ path: target }) });
  }

  window.fetch = async function(input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (!url.includes("/files/get_temporary_link")) return originalFetch(input, init);

    let path = "";
    try { path = JSON.parse(init && init.body || "{}").path || ""; } catch {}
    const headers = init && init.headers || {};
    const name = basename(path);

    if (name && path.includes("/")) {
      try {
        let files = await searchFiles(name, headers, true);
        if (!files.length) files = await searchFiles(name, headers, false);
        for (const f of files) {
          for (const candidate of [f.id, f.path_display, f.path_lower].filter(Boolean)) {
            const retry = await tempLink(candidate, headers);
            if (retry.ok) return retry;
          }
        }
      } catch {}
    }

    return originalFetch(input, init);
  };
})();