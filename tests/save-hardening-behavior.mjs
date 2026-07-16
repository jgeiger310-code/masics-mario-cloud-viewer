import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class Element {
  constructor(id, value = "", textContent = "") {
    this.id = id;
    this.value = value;
    this.textContent = textContent;
    this.disabled = false;
  }
}

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    dump: () => Object.fromEntries(data)
  };
}

function response(body, status = 200, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] || headers[name] || "" },
    text: async () => text,
    json: async () => JSON.parse(text)
  };
}

const manifest = {
  records: [
    { queue_number: 1, review_id: "r1", filename: "one.pdf", file_type: "pdf", dropbox_path: "/one.pdf" },
    { queue_number: 2, review_id: "r2", filename: "two.pdf", file_type: "pdf", dropbox_path: "/two.pdf" }
  ]
};

let online = {
  queueIdentity: "q1",
  total: 2,
  decisions: { r2: { decision: "responsive", notes: "kept online", updatedAt: "2026-07-16T00:00:00.000Z" } }
};
let rev = "rev-a";
let progressUploadAttempts = 0;
const uploads = [];

const elements = {
  "save-status": new Element("save-status"),
  "status-line": new Element("status-line"),
  "record-position": new Element("record-position", "", "Record 1 of 2"),
  "record-title": new Element("record-title", "", "one.pdf"),
  decision: new Element("decision", "missing"),
  notes: new Element("notes", "captured note"),
  "save-online": new Element("save-online")
};

const listeners = {};
const localStorage = storage({
  "masics_cloud_progress:q1": JSON.stringify({
    queueIdentity: "q1",
    decisions: { r1: { decision: "missing", notes: "local previous", updatedAt: "2026-07-15T00:00:00.000Z" } }
  })
});
const sessionStorage = storage({ masics_access_token: "token" });

const context = {
  console,
  navigator: { userAgent: "behavior-test" },
  location: { href: "https://example.test/" },
  HTMLElement: Element,
  document: {
    getElementById: (id) => elements[id] || null,
    addEventListener: (type, cb) => { listeners[type] = listeners[type] || []; listeners[type].push(cb); }
  },
  window: {
    MASICS_DROPBOX_CONFIG: {
      queueIdentity: "q1",
      queueVersion: "test",
      manifestDropboxPath: "/manifest.json",
      progressDropboxFolder: "/progress"
    },
    sessionStorage,
    localStorage,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    addEventListener: (type, cb) => { listeners[`window:${type}`] = listeners[`window:${type}`] || []; listeners[`window:${type}`].push(cb); }
  },
  fetch: async (url, options = {}) => {
    const arg = JSON.parse(options.headers?.["Dropbox-API-Arg"] || "{}");
    if (url.includes("files/download") && arg.path === "/manifest.json") return response(manifest);
    if (url.includes("files/download") && arg.path === "/progress/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json") {
      return response(online, 200, { "dropbox-api-result": JSON.stringify({ rev }) });
    }
    if (url.includes("files/upload")) {
      uploads.push({ arg, body: options.body });
      if (arg.path.endsWith("MASICS_MARIO_REVIEW_PROGRESS_LATEST.json")) {
        progressUploadAttempts += 1;
        if (progressUploadAttempts === 1) {
          online.decisions.r2.notes = "updated by other browser";
          rev = "rev-b";
          return response({ error_summary: "conflict" }, 409);
        }
        assert.deepEqual(arg.mode, { ".tag": "update", update: "rev-b" });
        online = JSON.parse(options.body);
        rev = "rev-c";
        return response({ rev });
      }
      return response({ rev: `${arg.path}-rev` });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }
};
context.window.document = context.document;
context.window.navigator = context.navigator;
context.window.location = context.location;
context.window.fetch = context.fetch;
context.window.HTMLElement = Element;
context.globalThis = context.window;

vm.createContext(context);
vm.runInContext(fs.readFileSync("assets/save-online-merge.js", "utf8"), context);

listeners.click[0]({
  target: elements["save-online"],
  preventDefault() {},
  stopImmediatePropagation() {}
});

await new Promise((resolve) => setTimeout(resolve, 10));

assert.equal(progressUploadAttempts, 2, "progress save should retry after Dropbox rev conflict");
assert.equal(online.decisions.r1.decision, "missing", "captured current mutation must be saved");
assert.equal(online.decisions.r1.notes, "captured note", "captured notes must survive delayed save");
assert.equal(online.decisions.r2.notes, "updated by other browser", "conflict retry must preserve newer online decision");
assert.ok(online.generationId, "progress generation id should be written");
assert.ok(online.sourceProgressHash, "progress source hash should be written");
assert.equal(localStorage.getItem("masics_cloud_progress:q1:dirty_unsynced"), null, "dirty marker should clear after verified save");

console.log("PASS save hardening behavior checks");
