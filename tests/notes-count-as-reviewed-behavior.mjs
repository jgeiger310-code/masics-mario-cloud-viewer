import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class Element {
  constructor(id, value = "") {
    this.id = id;
    this.value = value;
    this.textContent = "";
  }

  closest(selector) {
    const ids = String(selector || "").split(",").map((part) => part.trim().replace(/^#/, ""));
    return ids.includes(this.id) ? this : null;
  }
}

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    dump: () => Object.fromEntries(data)
  };
}

function loadScript(localDecisions, notesValue, decisionValue) {
  const progressKey = "masics_cloud_progress:q1";
  const localStorage = storage({
    [progressKey]: JSON.stringify({
      queueIdentity: "q1",
      decisions: localDecisions
    })
  });
  const elements = {
    notes: new Element("notes", notesValue),
    decision: new Element("decision", decisionValue),
    "save-status": new Element("save-status"),
    "next-pending": new Element("next-pending")
  };
  const listeners = {};
  const cache = { progress: null, invalidated: 0 };

  const context = {
    console,
    Event: class Event {
      constructor(type, options = {}) {
        this.type = type;
        this.bubbles = Boolean(options.bubbles);
      }
    },
    document: {
      getElementById: (id) => elements[id] || null,
      addEventListener: (type, cb) => {
        listeners[`document:${type}`] = listeners[`document:${type}`] || [];
        listeners[`document:${type}`].push(cb);
      }
    },
    window: {
      MASICS_DROPBOX_CONFIG: { queueIdentity: "q1" },
      MASICS_setProgressCache: (progress) => {
        cache.progress = progress;
      },
      MASICS_invalidateProgressCache: () => {
        cache.invalidated += 1;
      },
      localStorage,
      addEventListener: (type, cb) => {
        listeners[`window:${type}`] = listeners[`window:${type}`] || [];
        listeners[`window:${type}`].push(cb);
      }
    }
  };
  context.window.document = context.document;
  elements.notes.dispatchEvent = () => {};
  elements.decision.dispatchEvent = (event) => {
    (listeners["document:change"] || []).forEach((cb) => cb(event));
  };
  context.globalThis = context.window;

  vm.createContext(context);
  vm.runInContext(fs.readFileSync("assets/notes-count-as-reviewed.js", "utf8"), context);
  return { context, elements, listeners, localStorage, progressKey, cache };
}

const source = fs.readFileSync("assets/notes-count-as-reviewed.js", "utf8");
assert.match(source, /20260821-ai-note-not-dropdown-1/, "AI-note dropdown fix version is missing");
assert.match(source, /reviewerNotes/, "Reviewer-note vs AI-note split is missing");
assert.doesNotMatch(
  source.replace(/function applyDefaultDecision[\s\S]*?(?=\n  document.addEventListener)/, ""),
  /if \(!String\(notes\.value \|\| ""\)\.trim\(\)/,
  "AI-only notes must not be enough to fill the dropdown"
);

{
  const { elements, listeners } = loadScript({}, "AI note: leftover photo analysis", "");
  listeners["document:click"][0]({ target: elements["next-pending"] });
  assert.equal(elements.decision.value, "", "AI-only notes must not auto-set Needs review");
}

{
  const { elements, listeners } = loadScript({}, "Mario: withhold this\n\nAI note: leftover photo analysis", "");
  listeners["document:click"][0]({ target: elements["next-pending"] });
  assert.equal(elements.decision.value, "needs_review", "Mario's own notes may still default to Needs review");
}

{
  const { elements, listeners } = loadScript({}, "Mario typed this note", "");
  listeners["document:input"][0]({ target: elements.notes });
  assert.equal(elements.decision.value, "needs_review", "Human notes without an AI block may still default to Needs review");
}

{
  const { localStorage, progressKey, elements } = loadScript(
    {
      leftover: { decision: "needs_review", notes: "AI note: copied OCR", updatedAt: "2026-08-21T19:00:00.000Z" },
      mario: { decision: "needs_review", notes: "Mario asked to look again\n\nAI note: old file", updatedAt: "2026-07-01T00:00:00.000Z" },
      missing: { decision: "missing", notes: "AI note: still missing", updatedAt: "2026-07-02T00:00:00.000Z" }
    },
    "AI note: copied OCR",
    "needs_review"
  );
  const progress = JSON.parse(localStorage.getItem(progressKey));
  assert.equal(progress.decisions.leftover.decision, "", "Local auto Needs review on AI-only leftover files must be cleared");
  assert.equal(progress.decisions.mario.decision, "needs_review", "Mario Needs review with his own notes must be kept");
  assert.equal(progress.decisions.missing.decision, "missing", "Non-Needs-review dropdowns must be left alone");
  assert.equal(elements.decision.value, "", "Visible leftover dropdown must return to Pending");
}

console.log("PASS notes-count-as-reviewed AI notes are not a dropdown");
