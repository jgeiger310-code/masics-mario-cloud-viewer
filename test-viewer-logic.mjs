import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = process.cwd();

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  }
}

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  let depth = 0;
  const brace = source.indexOf("{", start);
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

const app = read("assets/app.js");
const saveMerge = read("assets/save-online-merge.js");
const preview = read("assets/safe-preview.js");
const trackerReport = read("assets/tracker-report.js");

test("main viewer loads the 5844 save guard and not the duplicate autosave shim", () => {
  const html = read("index.html");
  assert.match(html, /assets\/config\.js\?v=20260715-manifest-5844-1/);
  assert.match(html, /assets\/save-online-merge\.js\?v=20260715-5844-save-guard-1/);
  assert.doesNotMatch(html, /autosave-online-v3\.js/);
  assert.match(html, /updates the spreadsheet backup/);
});

test("manifest validation allows append-only growth above protected baseline", () => {
  const fn = extractFunction(app, "validateManifest");
  assert.match(fn, /loaded\.records\.length < minimumRecordCount/);
  assert.doesNotMatch(fn, /loaded\.records\.length !== cfg\.expectedRecordCount/);
  assert.doesNotMatch(fn, /loaded\.pending_count !== loaded\.records\.length/);
  assert.match(fn, /initial_review/);
});

test("initial online sync merges with local progress instead of replacing it", () => {
  const fn = extractFunction(app, "syncOnlineProgressIntoBrowser");
  assert.match(fn, /const localProgress = loadProgress\(\)/);
  assert.match(fn, /filterKnownDecisions\(mergeDecisions\(online\.decisions, localProgress\.decisions \|\| \{\}\)\)/);
});

test("save merge protects newer online decisions from stale local sessions", () => {
  const code = [
    extractFunction(saveMerge, "hasValue"),
    extractFunction(saveMerge, "updatedAt"),
    extractFunction(saveMerge, "newerOrSafer"),
    extractFunction(saveMerge, "mergeDecisions"),
    `globalThis.result = mergeDecisions({
      keep: { decision: "missing", notes: "new online", updatedAt: "2026-07-15T01:00:00Z" },
      blank: { decision: "responsive", notes: "online value", updatedAt: "2026-07-15T01:00:00Z" },
      deleted: { decision: "delete", notes: "excluded", updatedAt: "2026-07-15T01:00:00Z" }
    }, {
      keep: { decision: "responsive", notes: "old local", updatedAt: "2026-07-14T01:00:00Z" },
      blank: { decision: "", notes: "", updatedAt: "2026-07-15T02:00:00Z" },
      deleted: { decision: "missing", notes: "later local", updatedAt: "2026-07-15T02:00:00Z" },
      adopt: { decision: "duplicate", notes: "fresh local", updatedAt: "2026-07-15T02:00:00Z" }
    });`
  ].join("\n");
  const context = {};
  vm.runInNewContext(code, context);
  assert.equal(context.result.keep.decision, "missing");
  assert.equal(context.result.blank.decision, "responsive");
  assert.equal(context.result.deleted.decision, "delete");
  assert.equal(context.result.adopt.decision, "duplicate");
});

test("save path writes progress, full status csv, marked csv, audit, and manual snapshots", () => {
  assert.match(saveMerge, /20260715-5844-save-guard-1/);
  assert.match(saveMerge, /MASICS_MARIO_REVIEW_PROGRESS_LATEST\.json/);
  assert.match(saveMerge, /MASICS_MARIO_REVIEW_STATUS_LATEST\.csv/);
  assert.match(saveMerge, /MASICS_MARIO_MARKED_REVIEWED_LATEST\.csv/);
  assert.match(saveMerge, /MASICS_MARIO_REVIEW_AUDIT_LATEST\.json/);
  assert.match(saveMerge, /MASICS_MARIO_MARKED_REVIEWED_\$\{stamp\}\.csv/);
  assert.match(saveMerge, /Online verification failed/);
  assert.match(saveMerge, /beforeunload/);
});

test("marked csv contains reviewed, excluded, and notes rows only", () => {
  const code = [
    extractFunction(saveMerge, "allowedDecision"),
    extractFunction(saveMerge, "buildRows"),
    extractFunction(saveMerge, "markedRows"),
    extractFunction(saveMerge, "csvEscape"),
    extractFunction(saveMerge, "csv"),
    `const records = [
      { queue_number: 1, filename: "a.jpg", review_id: "a", file_type: "jpg", dropbox_path: "/a.jpg" },
      { queue_number: 2, filename: "b.jpg", review_id: "b", file_type: "jpg", dropbox_path: "/b.jpg" },
      { queue_number: 3, filename: "c.jpg", review_id: "c", file_type: "jpg", dropbox_path: "/c.jpg" },
      { queue_number: 4, filename: "d.jpg", review_id: "d", file_type: "jpg", dropbox_path: "/d.jpg" }
    ];
    const rows = buildRows(records, {
      a: { decision: "missing", notes: "needs, quote", updatedAt: "2026-07-15T01:00:00Z" },
      b: { decision: "delete", notes: "remove", updatedAt: "2026-07-15T01:00:00Z" },
      c: { decision: "", notes: "notes only", updatedAt: "2026-07-15T01:00:00Z" }
    });
    globalThis.marked = markedRows(rows);
    globalThis.csvText = csv(globalThis.marked);`
  ].join("\n");
  const context = {};
  vm.runInNewContext(code, context);
  assert.equal(context.marked.length, 3);
  assert.equal(context.marked[0].reviewed, true);
  assert.equal(context.marked[1].excluded, true);
  assert.equal(context.marked[2].notes, "notes only");
  assert.match(context.csvText, /"needs, quote"/);
});

test("tracker sees marked reviewed csv backups", () => {
  const html = read("tracker.html");
  assert.match(html, /assets\/tracker-report\.js\?v=20260715-marked-backups-1/);
  assert.match(trackerReport, /MARKED_REVIEWED/);
});

test("mobile and preview guardrails remain present", () => {
  const html = read("index.html");
  const styles = read("assets/styles.css");
  assert.match(html, /<button id="next-record" type="button">Next<\/button>\s+<button id="save-online"/);
  assert.match(html, /<button id="next-pending" class="primary" type="button">Next Pending<\/button>\s+<button id="load-evidence"/);
  assert.match(styles, /@media \(max-width: 820px\)/);
  assert.doesNotMatch(preview, /readAsDataURL|FileReader|blobToDataUrl/);
  assert.match(preview, /URL\.createObjectURL\(blob\)/);
  assert.match(preview, /window\.mammoth\.convertToHtml/);
  assert.match(preview, /Open original/);
  assert.match(preview, /Save a copy/);
});
