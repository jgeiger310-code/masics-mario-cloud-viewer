(() => {
  "use strict";

  const nativeFetch = window.fetch.bind(window);
  const DROPBOX_RPC_PREFIX = "https://api.dropboxapi.com/2/";
  const DROPBOX_CONTENT_PREFIX = "https://content.dropboxapi.com/2/";
  const CACHE_KEY = "masics_dropbox_mounted_locator_cache_v1";
  const MAX_SEARCH_PAGES = 5;
  const RETRYABLE_ENDPOINTS = new Set([
    "files/download",
    "files/get_metadata",
    "files/get_temporary_link"
  ]);
  let locatorCache = loadCache();

  window.MASICS_DROPBOX_MOUNT_RESOLVER_VERSION = "20260718-mounted-folders-1";

  function loadCache() {
    try {
      const parsed = JSON.parse(window.sessionStorage.getItem(CACHE_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveCache() {
    try {
      window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(locatorCache));
    } catch {}
  }

  function normalizePath(value) {
    return String(value || "")
      .normalize("NFC")
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/")
      .replace(/\/$/, "")
      .toLocaleLowerCase("en-US");
  }

  function filenameFromPath(value) {
    const normalized = String(value || "").normalize("NFC").replace(/\\/g, "/").replace(/\/$/, "");
    return normalized.slice(normalized.lastIndexOf("/") + 1);
  }

  function metadataFromMatch(match) {
    const wrapper = match && match.metadata;
    if (!wrapper) return null;
    if (wrapper[".tag"] === "metadata" && wrapper.metadata) return wrapper.metadata;
    return wrapper.metadata || wrapper;
  }

  function chooseSearchMatch(matches, requestedPath) {
    const filename = filenameFromPath(requestedPath);
    const normalizedFilename = filename.normalize("NFC").toLocaleLowerCase("en-US");
    const normalizedRequestedPath = normalizePath(requestedPath);
    const candidates = (matches || [])
      .map(metadataFromMatch)
      .filter((metadata) => metadata && metadata.id && String(metadata.name || "").normalize("NFC").toLocaleLowerCase("en-US") === normalizedFilename);

    const suffixMatches = candidates.filter((metadata) => {
      const display = normalizePath(metadata.path_display || "");
      const lower = normalizePath(metadata.path_lower || "");
      return (display && display.endsWith(normalizedRequestedPath)) || (lower && lower.endsWith(normalizedRequestedPath));
    });

    if (suffixMatches.length === 1) return suffixMatches[0];
    if (suffixMatches.length > 1) return suffixMatches[0];
    if (candidates.length === 1) return candidates[0];
    return null;
  }

  async function searchDropboxForMountedPath(path, authorization) {
    const query = filenameFromPath(path);
    if (!query || !authorization) return "";

    let endpoint = "files/search_v2";
    let body = {
      query,
      options: {
        filename_only: true,
        file_status: "active",
        max_results: 100
      }
    };

    for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
      const response = await nativeFetch(DROPBOX_RPC_PREFIX + endpoint, {
        method: "POST",
        headers: {
          "Authorization": authorization,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      if (!response.ok) return "";
      const data = await response.json();
      const match = chooseSearchMatch(data.matches || [], path);
      if (match && match.id) return match.id;
      if (!data.has_more || !data.cursor) return "";
      endpoint = "files/search/continue_v2";
      body = { cursor: data.cursor };
    }
    return "";
  }

  async function resolveMountedPath(path, authorization) {
    const normalized = normalizePath(path);
    if (!normalized || !normalized.startsWith("/") || normalized.startsWith("/id:")) return "";
    if (locatorCache[normalized]) return locatorCache[normalized];
    const resolved = await searchDropboxForMountedPath(path, authorization);
    if (resolved) {
      locatorCache[normalized] = resolved;
      saveCache();
    }
    return resolved;
  }

  function requestUrl(input) {
    return typeof input === "string" ? input : String(input && input.url || "");
  }

  function endpointFromUrl(url) {
    if (url.startsWith(DROPBOX_RPC_PREFIX)) return url.slice(DROPBOX_RPC_PREFIX.length).split("?")[0];
    if (url.startsWith(DROPBOX_CONTENT_PREFIX)) return url.slice(DROPBOX_CONTENT_PREFIX.length).split("?")[0];
    return "";
  }

  function headerEntries(source) {
    if (!source) return [];
    if (typeof Headers !== "undefined" && source instanceof Headers) return [...source.entries()];
    if (Array.isArray(source)) return source;
    return Object.entries(source);
  }

  function asciiHeaderJson(value) {
    return String(value || "").replace(/[^\x20-\x7E]/g, (character) => {
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    });
  }

  function safeInit(input, init) {
    const source = init && init.headers ? init.headers : (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
    if (!source) return init;
    const headers = {};
    headerEntries(source).forEach(([name, value]) => {
      headers[name] = String(name).toLowerCase() === "dropbox-api-arg" ? asciiHeaderJson(value) : value;
    });
    return { ...(init || {}), headers };
  }

  function requestHeaders(input, init) {
    return new Headers((safeInit(input, init) || {}).headers || {});
  }

  function locatorFromRequest(endpoint, headers, init) {
    try {
      if (endpoint === "files/download") {
        return String(JSON.parse(headers.get("Dropbox-API-Arg") || "{}").path || "");
      }
      return String(JSON.parse(String(init && init.body || "{}")).path || "");
    } catch {
      return "";
    }
  }

  function retryOptions(endpoint, input, init, resolvedId) {
    const headers = requestHeaders(input, init);
    if (endpoint === "files/download") {
      headers.set("Dropbox-API-Arg", JSON.stringify({ path: resolvedId }));
      return { ...(init || {}), headers };
    }
    return { ...(init || {}), headers, body: JSON.stringify({ path: resolvedId }) };
  }

  function updateEvidenceStatus(message) {
    const status = document.getElementById("evidence-status");
    if (status) status.textContent = message;
  }

  window.fetch = async function masicsDropboxMountedFolderFetch(input, init) {
    const url = requestUrl(input);
    const endpoint = endpointFromUrl(url);
    const preparedInit = safeInit(input, init);
    const response = await nativeFetch(input, preparedInit);
    if (response.status !== 409 || !RETRYABLE_ENDPOINTS.has(endpoint)) return response;

    const headers = requestHeaders(input, preparedInit);
    const locator = locatorFromRequest(endpoint, headers, preparedInit);
    if (!locator || locator.startsWith("id:")) return response;

    updateEvidenceStatus("Locating this file in its shared Dropbox folder...");
    const resolvedId = await resolveMountedPath(locator, headers.get("Authorization") || "");
    if (!resolvedId) return response;

    updateEvidenceStatus("Shared Dropbox file found. Loading preview...");
    return nativeFetch(input, safeInit(input, retryOptions(endpoint, input, preparedInit, resolvedId)));
  };

  window.MASICS_DROPBOX_MOUNT_RESOLVER_SELF_TEST = () => ({
    version: window.MASICS_DROPBOX_MOUNT_RESOLVER_VERSION,
    normalizesUnicodePaths: normalizePath("/Mario’s Missing Files/Test.JPG") === "/mario’s missing files/test.jpg",
    matchesMountedSuffix: Boolean(chooseSearchMatch([{
      metadata: {
        ".tag": "metadata",
        metadata: {
          id: "id:test",
          name: "Test.JPG",
          path_display: "/jake Geiger/Mario’s Missing Files/Test.JPG"
        }
      }
    }], "/Mario’s Missing Files/Test.JPG")),
    wrapsDropboxFetch: window.fetch !== nativeFetch,
    escapesUnicodeHeaderJson: asciiHeaderJson('{"path":"/Mario’s Missing Files/Test.JPG"}').includes("\\u2019")
  });
})();
