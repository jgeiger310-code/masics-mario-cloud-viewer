(() => {
  "use strict";

  const VERSION = "20260709-storage-quota-2";
  const memory = Object.create(null);
  const managedKeys = new Set([
    "masics_access_token",
    "masics_oauth_state",
    "masics_pkce_verifier",
    "masics_auth_return_to"
  ]);

  window.MASICS_AUTH_STORAGE_FALLBACK_VERSION = VERSION;

  function base64UrlEncode(text) {
    return btoa(unescape(encodeURIComponent(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlDecode(text) {
    const padded = String(text || "").replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(text || "").length + 3) % 4);
    return decodeURIComponent(escape(atob(padded)));
  }

  function encodeState(payload) {
    return `masics1.${base64UrlEncode(JSON.stringify(payload))}`;
  }

  function decodeState(value) {
    const text = String(value || "");
    if (!text.startsWith("masics1.")) return null;
    try {
      const parsed = JSON.parse(base64UrlDecode(text.slice("masics1.".length)));
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function currentRawState() {
    try {
      const query = String(window.location.search || "").replace(/^\?/, "");
      const pairs = query ? query.split("&") : [];
      for (const pair of pairs) {
        const index = pair.indexOf("=");
        const key = decodeURIComponent((index >= 0 ? pair.slice(0, index) : pair).replace(/\+/g, " "));
        if (key !== "state") continue;
        return decodeURIComponent((index >= 0 ? pair.slice(index + 1) : "").replace(/\+/g, " "));
      }
    } catch {}
    return "";
  }

  function currentStatePayload() {
    return decodeState(currentRawState());
  }

  function cookieName(key) {
    return `masics_${String(key).replace(/[^a-zA-Z0-9_:-]/g, "_")}`;
  }

  function readCookie(key) {
    const name = `${cookieName(key)}=`;
    const found = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(name));
    if (!found) return null;
    try {
      return decodeURIComponent(found.slice(name.length));
    } catch {
      return null;
    }
  }

  function writeCookie(key, value) {
    if (!managedKeys.has(String(key))) return;
    try {
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${cookieName(key)}=${encodeURIComponent(String(value || ""))}; Max-Age=21600; Path=/; SameSite=Lax${secure}`;
    } catch {}
  }

  function clearCookie(key) {
    if (!managedKeys.has(String(key))) return;
    try {
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${cookieName(key)}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
    } catch {}
  }

  function specialValue(key) {
    const payload = currentStatePayload();
    if (!payload) return null;
    if (key === "masics_oauth_state") return payload.s || "";
    if (key === "masics_pkce_verifier") return payload.v || "";
    if (key === "masics_auth_return_to") return payload.r || "";
    return null;
  }

  function safeOriginalGet(storage, originalGet, key) {
    try {
      return originalGet.call(storage, key);
    } catch {
      return null;
    }
  }

  if (window.Storage && window.Storage.prototype) {
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    const originalRemove = Storage.prototype.removeItem;

    Storage.prototype.getItem = function patchedGetItem(key) {
      const normalizedKey = String(key);
      const fromState = specialValue(normalizedKey);
      if (fromState !== null && fromState !== undefined && fromState !== "") return fromState;
      const fromStorage = safeOriginalGet(this, originalGet, normalizedKey);
      if (fromStorage !== null && fromStorage !== undefined) return fromStorage;
      if (Object.prototype.hasOwnProperty.call(memory, normalizedKey)) return memory[normalizedKey];
      const fromCookie = readCookie(normalizedKey);
      if (fromCookie !== null && fromCookie !== undefined) return fromCookie;
      return null;
    };

    Storage.prototype.setItem = function patchedSetItem(key, value) {
      const normalizedKey = String(key);
      const normalizedValue = String(value);
      memory[normalizedKey] = normalizedValue;
      writeCookie(normalizedKey, normalizedValue);
      try {
        return originalSet.call(this, normalizedKey, normalizedValue);
      } catch (err) {
        console.warn("MASICS storage fallback captured setItem failure", normalizedKey, err && err.message ? err.message : err);
        return undefined;
      }
    };

    Storage.prototype.removeItem = function patchedRemoveItem(key) {
      const normalizedKey = String(key);
      delete memory[normalizedKey];
      clearCookie(normalizedKey);
      try {
        return originalRemove.call(this, normalizedKey);
      } catch {
        return undefined;
      }
    };
  }

  if (window.URLSearchParams && window.URLSearchParams.prototype) {
    const originalGet = URLSearchParams.prototype.get;
    const originalToString = URLSearchParams.prototype.toString;

    URLSearchParams.prototype.get = function patchedGet(name) {
      const value = originalGet.call(this, name);
      if (String(name) === "state") {
        const payload = decodeState(value);
        if (payload && payload.s) return payload.s;
      }
      return value;
    };

    URLSearchParams.prototype.toString = function patchedToString() {
      try {
        const responseType = originalGet.call(this, "response_type");
        const rawState = originalGet.call(this, "state") || "";
        const challenge = originalGet.call(this, "code_challenge");
        const isDropboxAuth = responseType === "code" && rawState && challenge;
        if (isDropboxAuth && !rawState.startsWith("masics1.")) {
          const verifier = memory.masics_pkce_verifier || readCookie("masics_pkce_verifier") || "";
          if (verifier) {
            this.set("state", encodeState({
              s: rawState,
              v: verifier,
              r: memory.masics_auth_return_to || readCookie("masics_auth_return_to") || "",
              t: Date.now()
            }));
          }
        }
      } catch {}
      return originalToString.call(this);
    };
  }

  try {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = params.get("masics_access_token");
    if (token) {
      memory.masics_access_token = token;
      writeCookie("masics_access_token", token);
      if (window.history && window.history.replaceState) window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
    }
  } catch {}

  window.MASICS_AUTH_STORAGE_FALLBACK_SELF_TEST = () => ({
    version: VERSION,
    storagePrototypePatched: Boolean(window.Storage && Storage.prototype && Storage.prototype.getItem),
    stateFallbackPresent: Boolean(currentStatePayload()),
    stateParamDecoded: (() => {
      try {
        const raw = encodeState({ s: "state-test", v: "verifier-test", r: "tracker" });
        return new URLSearchParams(`state=${encodeURIComponent(raw)}`).get("state") === "state-test";
      } catch {
        return false;
      }
    })(),
    cookieFallbackAvailable: (() => {
      try {
        writeCookie("masics_oauth_state", "test");
        const ok = readCookie("masics_oauth_state") === "test";
        clearCookie("masics_oauth_state");
        return ok;
      } catch {
        return false;
      }
    })()
  });
})();
