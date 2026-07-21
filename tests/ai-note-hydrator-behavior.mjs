import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class Element {
  constructor(id, value = "") {
    this.id = id;
    this.value = value;
    this.textContent = "";
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

function response(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body
  };
}

const progressKey = "masics_cloud_progress:q1";
const localStorage = storage({
  [progressKey]: JSON.stringify({
    queueIdentity: "q1",
    exportedAt: "2026-07-20T00:00:00.000Z",
    decisions: {
      r1: { decision: "missing", notes: "Mario local note", updatedAt: "2026-07-21T10:00:00.000Z" },
      r2: { decision: "delete", notes: "Mario delete note", updatedAt: "2026-07-21T10:01:00.000Z" }
    }
  })
});

const sessionStorage = storage({ masics_access_token: "token" });
const elements = {
  notes: new Element("notes", "Mario local note"),
  decision: new Element("decision", "missing"),
  "save-status": new Element("save-status")
};
const listeners = {};
const timeoutJobs = [];
const fetches = [];

const onlineProgress = {
  queueIdentity: "q1",
  exportedAt: "2026-07-21T11:00:00.000Z",
  decisions: {
    r1: { decision: "responsive", notes: "Mario online note\n\nAI note: r1 analysis", updatedAt: "2026-07-20T10:00:00.000Z" },
    r2: { decision: "responsive", notes: "AI note: r2 analysis", updatedAt: "2026-07-20T10:01:00.000Z" },
    r3: { decision: "", notes: "AI note: r3 pending analysis", updatedAt: "2026-07-20T10:02:00.000Z" },
    unknown: { decision: "responsive", notes: "AI note: should not attach", updatedAt: "2026-07-20T10:03:00.000Z" }
  }
};

const context = {
  console,
  CustomEvent: class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  },
  document: {
    activeElement: null,
    getElementById: (id) => elements[id] || null
  },
  window: {
    MASICS_DROPBOX_CONFIG: {
      queueIdentity: "q1",
      progressDropboxLatestJsonId: "id:progress",
      progressDropboxFolder: "/progress"
    },
    MASICS_QUEUE_RECORDS: [
      { review_id: "r1", queue_number: 1, filename: "one.pdf" },
      { review_id: "r2", queue_number: 2, filename: "two.pdf" },
      { review_id: "r3", queue_number: 3, filename: "three.pdf" }
    ],
    MASICS_ACTIVE_RECORD: { review_id: "r1", queue_number: 1, filename: "one.pdf" },
    localStorage,
    sessionStorage,
    setTimeout: (fn, delay) => {
      timeoutJobs.push({ fn, delay });
      return timeoutJobs.length;
    },
    addEventListener: (type, cb) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(cb);
    },
    dispatchEvent: (event) => {
      (listeners[event.type] || []).forEach((cb) => cb(event));
    }
  },
  fetch: async (url, options = {}) => {
    fetches.push({ url, options });
    assert.match(url, /files\/download/, "hydrator may only download online progress");
    return response(onlineProgress);
  }
};

context.window.document = context.document;
context.window.fetch = context.fetch;
context.globalThis = context.window;

vm.createContext(context);
vm.runInContext(fs.readFileSync("assets/ai-note-local-hydrator.js", "utf8"), context);

assert.equal(context.window.MASICS_AI_NOTE_HYDRATOR_SELF_TEST().preservesDeleteDecision, true);
assert.ok(timeoutJobs.length >= 3, "startup retry hydration should be scheduled");
await timeoutJobs[0].fn();

const hydrated = JSON.parse(localStorage.getItem(progressKey));
assert.equal(fetches.length, 1, "hydrator should read online progress once for the startup pass");
assert.equal(hydrated.decisions.r1.decision, "missing", "local decision must win over older online decision");
assert.equal(hydrated.decisions.r1.notes, "Mario local note\n\nAI note: r1 analysis", "AI note must append to Mario's local note");
assert.equal(hydrated.decisions.r2.decision, "delete", "delete decisions must be preserved");
assert.match(hydrated.decisions.r2.notes, /AI note: r2 analysis/, "AI note must append to deleted local note without restoring it");
assert.equal(hydrated.decisions.r3.notes, "AI note: r3 pending analysis", "online AI note-only pending records must be adopted");
assert.equal(hydrated.decisions.unknown, undefined, "unknown online records must not be attached to the loaded queue");
assert.match(elements.notes.value, /AI note: r1 analysis/, "visible notes field must refresh after hydration");
assert.match(elements["save-status"].textContent, /AI notes loaded/, "viewer should report that AI notes loaded locally");
assert.equal(context.window.MASICS_AI_NOTE_HYDRATOR_LAST_RESULT.afterAI, 3);

console.log("PASS AI-note hydrator behavior checks");
