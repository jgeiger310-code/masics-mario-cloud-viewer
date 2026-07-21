import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class StorageShim {
  constructor(initial = {}) {
    this.data = { ...initial };
  }

  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.data, String(key)) ? this.data[String(key)] : null;
  }

  setItem(key, value) {
    if (String(key) === "large-progress") throw new Error("quota exceeded");
    this.data[String(key)] = String(value);
  }

  removeItem(key) {
    delete this.data[String(key)];
  }
}

let cookieValue = "";
const context = {
  console: { warn() {} },
  btoa: (text) => Buffer.from(String(text), "binary").toString("base64"),
  atob: (text) => Buffer.from(String(text), "base64").toString("binary"),
  URLSearchParams,
  document: {
    title: "test",
    get cookie() {
      return cookieValue;
    },
    set cookie(value) {
      cookieValue = String(value || "");
    }
  },
  window: {
    Storage: StorageShim,
    localStorage: new StorageShim({ "large-progress": "stale-progress" }),
    sessionStorage: new StorageShim(),
    location: { protocol: "https:", search: "", hash: "", pathname: "/" },
    history: { replaceState() {} }
  }
};

context.window.window = context.window;
context.window.document = context.document;
context.window.URLSearchParams = URLSearchParams;
context.window.btoa = context.btoa;
context.window.atob = context.atob;
context.Storage = StorageShim;
context.globalThis = context.window;

vm.createContext(context);
vm.runInContext(fs.readFileSync("assets/auth-storage-fallback.js", "utf8"), context);

assert.equal(context.window.localStorage.getItem("large-progress"), "stale-progress", "existing persisted value should read before a failed write");
context.window.localStorage.setItem("large-progress", "fresh-progress-with-ai-notes");
assert.equal(context.window.localStorage.getItem("large-progress"), "fresh-progress-with-ai-notes", "failed large writes must be preferred from memory");

context.window.localStorage.setItem("small-progress", "fresh-persisted");
assert.equal(context.window.localStorage.getItem("small-progress"), "fresh-persisted", "successful writes must still read normally");

context.window.localStorage.removeItem("large-progress");
assert.equal(context.window.localStorage.getItem("large-progress"), null, "remove should clear both memory preference and persisted storage state");
assert.equal(context.window.MASICS_AUTH_STORAGE_FALLBACK_SELF_TEST().failedWriteMemoryPreferred, true);

console.log("PASS storage fallback behavior checks");
