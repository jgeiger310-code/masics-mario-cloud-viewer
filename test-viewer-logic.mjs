import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = process.cwd();

function test(name, fn) {
  try {
    awaitMaybe(fn());
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  }
}

function awaitMaybe(value) {
  if (value && typeof value.then === "function") {
    throw new Error("Async tests are not supported in this tiny harness.");
  }
}

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} not found`);
  let brace = source.indexOf("{", start);
  let depth = 0;
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

test("live page references current performance asset versions", () => {
  const html = read("index.html");
  assert.match(html, /assets\/config\.js\?v=20260707-4/);
  assert.match(html, /assets\/styles\.css\?v=20260707-8/);
  assert.match(html, /assets\/app\.js\?v=20260707-19/);
  assert.match(html, /assets\/safe-preview\.js\?v=20260707-19/);
  assert.match(html, /assets\/save-online-merge\.js\?v=20260707-12/);
});

test("manifest validation allows appended records above protected baseline", () => {
  const fn = extractFunction(app, "validateManifest");
  assert.match(fn, /loaded\.records\.length < minimumRecordCount/);
  assert.doesNotMatch(fn, /loaded\.records\.length !== cfg\.expectedRecordCount/);
  assert.match(fn, /loaded\.pending_count !== loaded\.records\.length/);
});

test("tracker metrics prefer live manifest total over stale progress total", () => {
  const fn = extractFunction(trackerReport, "renderMetrics");
  assert.match(fn, /manifestRecords\.length \|\| latestProgress\.total/);
  const html = read("tracker.html");
  assert.match(html, /assets\/tracker-report\.js\?v=20260707-8/);
});

test("record changes emit exactly the preview event hook", () => {
  assert.match(app, /window\.dispatchEvent\(new CustomEvent\("masics:record-change"\)\)/);
  assert.match(preview, /window\.addEventListener\("masics:record-change", \(\) => schedulePreview\(\)\)/);
});

test("mobile review controls keep save online near next and move metadata low", () => {
  const html = read("index.html");
  const styles = read("assets/styles.css");
  assert.match(html, /<button id="next-record" type="button">Next<\/button>\s+<button id="save-online"/);
  assert.match(html, /<div class="bottom-record-actions">\s+<button id="previous-record"/);
  assert.match(html, /<button id="next-pending" class="primary" type="button">Next Pending<\/button>\s+<button id="load-evidence"/);
  assert.match(html, /<div id="preview" class="preview"><\/div>\s+<dl id="record-meta" class="record-meta compact-meta"><\/dl>/);
  assert.doesNotMatch(html, /progress-warning/);
  assert.match(html, /class="top-note"/);
  assert.match(styles, /\.compact-meta/);
  assert.match(styles, /\.bottom-record-actions/);
});

test("filter changes select a visible record when the active record is hidden", () => {
  assert.match(app, /function selectVisibleRecordAfterFilter/);
  assert.match(app, /showRecord\(visibleRecords\[0\]\)/);
  assert.match(app, /els\.filter\.addEventListener\("change", selectVisibleRecordAfterFilter\)/);
  assert.match(app, /els\.search\.addEventListener\("input", selectVisibleRecordAfterFilter\)/);
});

test("preview no longer uses base64 FileReader path", () => {
  assert.doesNotMatch(preview, /readAsDataURL|FileReader|blobToDataUrl/);
  assert.match(preview, /URL\.createObjectURL\(blob\)/);
  assert.match(preview, /URL\.revokeObjectURL\(activePreviewUrl\)/);
});

test("manual safe preview supports media while auto preview stays image-light", () => {
  assert.match(preview, /const audioExts = \["\.mp3", "\.wav", "\.m4a", "\.aac", "\.ogg"\]/);
  assert.match(preview, /const videoExts = \["\.mp4", "\.mov", "\.m4v", "\.webm"\]/);
  assert.match(preview, /function renderPreview/);
  assert.match(preview, /document\.createElement\("audio"\)/);
  assert.match(preview, /document\.createElement\("video"\)/);
  assert.match(preview, /if \(!options\.force && !isImageRecord\(record\)\)/);
});

test("queue update avoids full list rebuild in normal note typing path", () => {
  const fn = extractFunction(app, "setProgressFor");
  assert.match(fn, /needsFullListRefresh/);
  assert.match(fn, /else refreshListState\(\)/);
});

test("decision dropdown saves on input and change events", () => {
  assert.match(app, /els\.decision\.addEventListener\("change", saveDecisionFromControls\)/);
  assert.match(app, /els\.decision\.addEventListener\("input", saveDecisionFromControls\)/);
  assert.match(saveMerge, /target\.id === "notes" \|\| target\.id === "decision"/);
});

test("notes-only rows are visible as needs dropdown", () => {
  const html = read("index.html");
  const trackerHtml = read("tracker.html");
  const styles = read("assets/styles.css");
  assert.match(html, /option value="needs_dropdown"/);
  assert.match(trackerHtml, /option value="needs_dropdown"/);
  assert.match(app, /function needsDropdown/);
  assert.match(app, /Needs dropdown/);
  assert.match(styles, /button\.needs-dropdown/);
  assert.match(trackerReport, /needsDropdown/);
  assert.match(trackerReport, /Needs dropdown/);
  assert.match(trackerReport, /needs_dropdown/);
  assert.match(trackerReport, /"needs_dropdown"/);
});

test("tracker metrics use all saved rows, not the active filter", () => {
  assert.match(trackerReport, /function render\(\) {\s+const allRows = reviewedRows\(\);\s+renderMetrics\(allRows\);\s+renderReviewed\(filteredReviewedRows\(\)\);/);
});

test("normal save merge keeps existing online decisions over blank local values", () => {
  const code = [
    extractFunction(saveMerge, "hasReviewValue"),
    extractFunction(saveMerge, "updatedAt"),
    extractFunction(saveMerge, "shouldReplaceDecision"),
    extractFunction(saveMerge, "mergeDecisions"),
    `globalThis.result = mergeDecisions({
      a: { decision: "missing", notes: "online note", updatedAt: "2026-07-07T10:00:00Z" },
      b: { decision: "responsive", notes: "", updatedAt: "2026-07-07T10:00:00Z" }
    }, {
      a: { decision: "", notes: "", updatedAt: "2026-07-07T11:00:00Z" },
      b: { decision: "", notes: "local note only", updatedAt: "2026-07-07T11:00:00Z" },
      c: { decision: "duplicate", notes: "new", updatedAt: "2026-07-07T12:00:00Z" }
    });`
  ].join("\n");
  const context = {};
  vm.runInNewContext(code, context);
  assert.equal(context.result.a.decision, "missing");
  assert.equal(context.result.a.notes, "online note");
  assert.equal(context.result.b.decision, "responsive");
  assert.equal(context.result.c.decision, "duplicate");
});

test("delete/exclude is not overwritten by a later non-delete local decision", () => {
  const code = [
    extractFunction(saveMerge, "hasReviewValue"),
    extractFunction(saveMerge, "updatedAt"),
    extractFunction(saveMerge, "shouldReplaceDecision"),
    extractFunction(saveMerge, "mergeDecisions"),
    `globalThis.result = mergeDecisions({
      d: { decision: "delete", notes: "exclude", updatedAt: "2026-07-07T10:00:00Z" }
    }, {
      d: { decision: "missing", notes: "later local", updatedAt: "2026-07-07T12:00:00Z" }
    });`
  ].join("\n");
  const context = {};
  vm.runInNewContext(code, context);
  assert.equal(context.result.d.decision, "delete");
});

test("CSV rows preserve reviewed and excluded as separate states", () => {
  const code = [
    extractFunction(saveMerge, "buildRows"),
    extractFunction(saveMerge, "csvEscape"),
    extractFunction(saveMerge, "buildCsv"),
    `const records = [
      { queue_number: 1, filename: "a.jpg", review_id: "a", file_type: "jpg", dropbox_path: "/a.jpg" },
      { queue_number: 2, filename: "b.jpg", review_id: "b", file_type: "jpg", dropbox_path: "/b.jpg" },
      { queue_number: 3, filename: "c.jpg", review_id: "c", file_type: "jpg", dropbox_path: "/c.jpg" }
    ];
    const rows = buildRows(records, {
      a: { decision: "missing", notes: "needs, quote", updatedAt: "2026-07-07T10:00:00Z" },
      b: { decision: "delete", notes: "remove from list", updatedAt: "2026-07-07T11:00:00Z" },
      c: { decision: "", notes: "notes only", updatedAt: "2026-07-07T12:00:00Z" }
    });
    globalThis.rows = rows;
    globalThis.csv = buildCsv(rows);`
  ].join("\n");
  const context = {};
  vm.runInNewContext(code, context);
  assert.equal(context.rows[0].reviewed, true);
  assert.equal(context.rows[0].excluded, false);
  assert.equal(context.rows[1].reviewed, false);
  assert.equal(context.rows[1].excluded, true);
  assert.equal(context.rows[2].reviewed, false);
  assert.equal(context.rows[2].excluded, false);
  assert.match(context.csv, /"needs, quote"/);
});

test("audit reports preserved online, adopted local, and unknown local ids", () => {
  const code = [
    `const version = "test-version";`,
    `const window = { MASICS_DROPBOX_CONFIG: { queueIdentity: "queue", queueVersion: "manifest", expectedRecordCount: 2 } };`,
    extractFunction(saveMerge, "cfg"),
    extractFunction(saveMerge, "updatedAt"),
    extractFunction(saveMerge, "hasReviewValue"),
    extractFunction(saveMerge, "shouldReplaceDecision"),
    extractFunction(saveMerge, "summarizeDecision"),
    extractFunction(saveMerge, "sameSummary"),
    extractFunction(saveMerge, "buildAudit"),
    `globalThis.audit = buildAudit(
      [{ review_id: "keep" }, { review_id: "adopt" }],
      { exportedAt: "old", decisions: { keep: { decision: "missing", notes: "online", updatedAt: "2026-07-07T10:00:00Z" } } },
      { decisions: {
        keep: { decision: "", notes: "", updatedAt: "2026-07-07T11:00:00Z" },
        adopt: { decision: "responsive", notes: "local", updatedAt: "2026-07-07T12:00:00Z" },
        unknown: { decision: "missing", notes: "bad", updatedAt: "2026-07-07T12:00:00Z" }
      }},
      {
        keep: { decision: "missing", notes: "online", updatedAt: "2026-07-07T10:00:00Z" },
        adopt: { decision: "responsive", notes: "local", updatedAt: "2026-07-07T12:00:00Z" }
      },
      "new"
    );`
  ].join("\n");
  const context = {};
  vm.runInNewContext(code, context);
  assert.equal(context.audit.preservedFromOnlineCount, 1);
  assert.equal(context.audit.adoptedFromLocalCount, 1);
  assert.equal(context.audit.ignoredUnknownLocalCount, 1);
  assert.equal(context.audit.changedCount, 1);
});
