import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value)
  };
}

function installResolver(nativeFetch) {
  globalThis.window = { fetch: nativeFetch, sessionStorage: storage() };
  globalThis.document = { getElementById: () => ({ textContent: "" }) };
  vm.runInThisContext(fs.readFileSync("assets/dropbox-mounted-path-resolver.js", "utf8"));
  return window.fetch;
}

{
  assert.throws(
    () => new Headers({ "Dropbox-API-Arg": JSON.stringify({ path: "/Mario’s Missing Files/test.jpg" }) }),
    /ByteString|greater than 255/,
    "The regression test must reproduce the browser Unicode-header failure"
  );

  const calls = [];
  const nativeFetch = async (input, init = {}) => {
    calls.push({ input, init });
    const value = new Headers(init.headers || {}).get("Dropbox-API-Arg") || "";
    assert.equal(value.includes("’"), false, "Dropbox-API-Arg must contain ASCII-safe JSON");
    assert.equal(JSON.parse(value).path, "/Mario’s Missing Files/20220613_114354.jpg");
    return new Response("image", { status: 200 });
  };
  const wrappedFetch = installResolver(nativeFetch);
  const response = await wrappedFetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      Authorization: "Bearer test",
      "Dropbox-API-Arg": JSON.stringify({ path: "/Mario’s Missing Files/20220613_114354.jpg" })
    }
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1, "A valid Unicode path should not require search after header escaping");
  assert.equal(window.MASICS_DROPBOX_MOUNT_RESOLVER_SELF_TEST().escapesUnicodeHeaderJson, true);
}

{
  const calls = [];
  const nativeFetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    if (url.endsWith("files/search_v2")) {
      const search = JSON.parse(init.body);
      assert.equal(search.query, "20220613_114354.jpg");
      return new Response(JSON.stringify({
        matches: [{
          metadata: {
            ".tag": "metadata",
            metadata: {
              ".tag": "file",
              id: "id:unrelated-copy",
              name: "20220613_114354.jpg",
              path_display: "/jake Geiger/Unrelated Folder/20220613_114354.jpg"
            }
          }
        }],
        has_more: true,
        cursor: "next-page"
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("files/search/continue_v2")) {
      assert.deepEqual(JSON.parse(init.body), { cursor: "next-page" });
      return new Response(JSON.stringify({
        matches: [
          {
            metadata: {
              ".tag": "metadata",
              metadata: {
                ".tag": "file",
                id: "id:nested-copy",
                name: "20220613_114354.jpg",
                path_display: "/jake Geiger/Masic Case Master - Working Database/01_SOURCE_COLLECTION_COPIES/Mario’s Missing Files/20220613_114354.jpg"
              }
            }
          },
          {
            metadata: {
              ".tag": "metadata",
              metadata: {
                ".tag": "file",
                id: "id:mounted-file",
                name: "20220613_114354.jpg",
                path_display: "/jake Geiger/Mario’s Missing Files/20220613_114354.jpg"
              }
            }
          }
        ],
        has_more: false
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const arg = JSON.parse(new Headers(init.headers || {}).get("Dropbox-API-Arg") || "{}");
    if (arg.path === "id:mounted-file") return new Response("image", { status: 200 });
    return new Response("lookup failed", { status: 409 });
  };
  const wrappedFetch = installResolver(nativeFetch);
  const request = {
    method: "POST",
    headers: {
      Authorization: "Bearer test",
      "Dropbox-API-Arg": JSON.stringify({ path: "/Mario’s Missing Files/20220613_114354.jpg" })
    }
  };
  assert.equal((await wrappedFetch("https://content.dropboxapi.com/2/files/download", request)).status, 200);
  assert.equal(calls.length, 4, "Fallback should perform original lookup, paginated search, and file-ID retry");
  assert.equal(JSON.parse(new Headers(calls[3].init.headers).get("Dropbox-API-Arg")).path, "id:mounted-file");

  calls.length = 0;
  assert.equal((await wrappedFetch("https://content.dropboxapi.com/2/files/download", request)).status, 200);
  assert.equal(calls.length, 2, "Cached mounted file IDs should skip later Dropbox searches");
}

console.log("PASS Unicode failure reproduction, paginated mounted-path selection, duplicate handling, file-ID retry, and cache checks");
