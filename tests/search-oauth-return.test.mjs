import assert from "node:assert/strict";

/**
 * Regression: Dropbox OAuth for Evidence Search must not strand users on the Mario viewer.
 * Same failure class as date-review/tracker return_to bugs.
 */

function encodeOauthState(plainState, verifier, returnTo) {
  const payload = JSON.stringify({ s: plainState, v: verifier, r: returnTo || "", t: Date.now() });
  const b64 = Buffer.from(payload, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `masics1.${b64}`;
}

function decodeOauthState(raw) {
  assert.ok(String(raw).startsWith("masics1."), "state must use masics1 envelope");
  const json = Buffer.from(String(raw).slice("masics1.".length).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json);
}

// 1) Encoded state carries return_to=search and PKCE verifier
const plain = "state-abc";
const verifier = "verifier-xyz";
const encoded = encodeOauthState(plain, verifier, "search");
const decoded = decodeOauthState(encoded);
assert.equal(decoded.s, plain);
assert.equal(decoded.v, verifier);
assert.equal(decoded.r, "search");

// 2) app.js must short-circuit search return before queue load (source guard)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appJs = fs.readFileSync(path.join(root, "assets/app.js"), "utf8");
assert.match(appJs, /returnTo === "search"/);
assert.match(appJs, /location\.replace\("search\.html"\)/);
// search return must appear before loadManifest in the handled block
const handledIdx = appJs.indexOf("const handled = await handleCallback()");
const searchReturnIdx = appJs.indexOf('returnTo === "search"');
const loadManifestIdx = appJs.indexOf("await loadManifest()", handledIdx);
assert.ok(handledIdx >= 0 && searchReturnIdx > handledIdx && loadManifestIdx > searchReturnIdx,
  "search OAuth return must run after handleCallback and before loadManifest");

// 3) search-auth-return must target search.html
const authReturn = fs.readFileSync(path.join(root, "assets/search-auth-return.js"), "utf8");
assert.match(authReturn, /search\.html/);
assert.match(authReturn, /masics_auth_return_to/);

// 4) search.html loads auth-storage-fallback before search-data
const searchHtml = fs.readFileSync(path.join(root, "search.html"), "utf8");
const fallbackPos = searchHtml.indexOf("auth-storage-fallback.js");
const dataPos = searchHtml.indexOf("search-data.js");
assert.ok(fallbackPos >= 0 && dataPos > fallbackPos, "auth-storage-fallback must load before search-data");

// 5) index.html includes search-auth-return
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
assert.match(indexHtml, /search-auth-return\.js/);

// 6) Wrong-origin sign-in must redirect to production search.html (not start OAuth on localhost)
const searchData = fs.readFileSync(path.join(root, "assets/search-data.js"), "utf8");
assert.match(searchData, /location\.origin !== redirectBase\.origin/);
assert.match(searchData, /search\.html/);
assert.match(searchData, /encodeOauthState/);
assert.match(searchData, /files\.content\.read/);
assert.doesNotMatch(searchData, /files\.content\.write/);

console.log("search-oauth-return tests passed");
