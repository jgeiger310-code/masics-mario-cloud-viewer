(() => {
  "use strict";
  const API = "https://api.dropboxapi.com/2/";
  const originalFetch = window.fetch.bind(window);
  const basename = value => {
    const clean = String(value || "").split(/[?#]/)[0];
    return decodeURIComponent(clean.slice(clean.lastIndexOf("/") + 1));
  };
  const norm = value => String(value || "").normalize("NFC").toLowerCase();
  const metadataFromMatch = match => match && match.metadata && (match.metadata.metadata || match.metadata);
  const displayPath = file => file && (file.path_display || file.path_lower || file.id || "");
  const keysFor = file => [file && file.id, file && file.path_lower, file && file.path_display].filter(Boolean);
  const rank = file => {
    const p = String(displayPath(file)).toLowerCase();
    if (p.includes("/2nd round discovery mario/")) return 0;
    if (p.includes("/mario’s missing files/") || p.includes("/mario's missing files/")) return 1;
    if (p.includes("email_intake")) return 2;
    if (p.includes("ocr_descriptors") || p.endsWith(".search.txt") || p.endsWith(".ocr.txt") || p.endsWith(".json")) return 9;
    return 4;
  };
  async function searchExactFilename(name, init) {
    const search = await originalFetch(API + "files/search_v2", {
      method: "POST",
      headers: init.headers,
      body: JSON.stringify({ query: name, options: { filename_only: true, max_results: 100, file_status: "active" } })
    });
    if (!search.ok) return [];
    const data = await search.json();
    const matches = (data.matches || []).map(metadataFromMatch).filter(file => file && file[".tag"] === "file" && norm(file.name) === norm(name));
    const unique = new Map();
    for (const file of matches) unique.set(file.id || displayPath(file), file);
    return Array.from(unique.values()).sort((a, b) => rank(a) - rank(b));
  }
  async function retryBySearch(name, init) {
    const files = await searchExactFilename(name, init);
    for (const file of files) {
      for (const key of keysFor(file)) {
        const retry = await originalFetch(API + "files/get_temporary_link", {
          method: "POST",
          headers: init.headers,
          body: JSON.stringify({ path: key })
        });
        if (retry.ok) return retry;
      }
    }
    return null;
  }
  window.fetch = async function patchedFetch(input, init = {}) {
    const url = input && input.url ? input.url : String(input || "");
    if (!url.includes("/files/get_temporary_link") || !init.body) return originalFetch(input, init);
    const first = await originalFetch(input, init);
    if (first.ok || first.status !== 409) return first;
    let body = null;
    try { body = JSON.parse(init.body); } catch { return first; }
    const path = body && body.path;
    if (!path || String(path).startsWith("id:")) return first;
    const name = basename(path);
    if (!name) return first;
    const fixed = await retryBySearch(name, init).catch(() => null);
    return fixed || first;
  };
})();