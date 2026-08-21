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
const missingExport = read("assets/export-missing-xlsx.js");
const preview = read("assets/safe-preview.js");
const imageThumbnail = read("assets/image-thumbnail-preview.js");
const amrPreview = read("assets/amr-preview.js");
const searchUi = read("assets/search-ui.js");
const trackerReport = read("assets/tracker-report.js");

test("main viewer loads the 7730 save guard and not the duplicate autosave shim", () => {
  const html = read("index.html");
  assert.match(html, /assets\/config\.js\?v=20260724-7730-count-guard-2/);
  assert.match(html, /assets\/app\.js\?v=20260821-perf-1/);
  assert.match(html, /assets\/save-online-merge\.js\?v=20260821-save-total-guard-4/);
  assert.match(html, /assets\/export-missing-xlsx\.js\?v=20260821-legal-missing-export-1/);
  assert.match(html, /assets\/tracker\.js\?v=20260821-legal-tagged-export-1/);
  assert.match(html, /Download All Missing Tags XLSX/);
  assert.doesNotMatch(html, /autosave-online-v3\.js/);
  assert.match(html, /updates the spreadsheet backup/);
});

test("notes online save waits for ten seconds of idle typing", () => {
  const html = read("index.html");
  assert.match(html, /assets\/notes-input-buffer\.js\?v=20260720-notes-10s-idle-1/);
  assert.match(saveMerge, /NOTES_FALLBACK_DELAY_MS\s*=\s*10000/);
  assert.match(saveMerge, /NOTES_BUFFERED_COMMIT_DELAY_MS\s*=\s*0/);
  assert.match(saveMerge, /DECISION_SAVE_DELAY_MS\s*=\s*900/);
});

test("image auto-preview uses record metadata and Dropbox thumbnail IDs", () => {
  assert.match(imageThumbnail, /20260720-thumbnail-metadata-id-1/);
  assert.match(imageThumbnail, /function recordExtension/);
  assert.match(imageThumbnail, /function thumbnailResource/);
  assert.match(imageThumbnail, /detectsImagesFromRecordMetadata/);
  assert.match(imageThumbnail, /usesDropboxIdResourceForFileIds/);
  assert.doesNotMatch(imageThumbnail, /files\/download/);
  assert.match(preview, /20260720-supported-auto-preview-2/);
  assert.match(preview, /thumbnailFileIdsUseDropboxIdResource/);
});

test("supported non-image records auto-preview with a size guard", () => {
  assert.match(preview, /supportedNonImagesAutoPreviewWithByteLimit/);
  assert.match(preview, /!options\.force && !isAutoPreviewRecord\(record\)/);
  assert.match(preview, /!options\.force && isImageRecord\(record\)/);
  assert.match(preview, /recordSize > maxAutoPreviewBytes/);
  assert.match(preview, /downloadFirst\(locators/);
  assert.match(preview, /textExts\.includes\(fileExtension\(record\)\)/);
  assert.match(preview, /jsonIsAutoPreview/);
  assert.match(preview, /csvIsAutoPreview/);
});

test("AMR playback is handled by the dedicated decoder before generic preview", () => {
  const html = read("index.html");
  assert.match(html, /'wasm-unsafe-eval'/);
  assert.match(html, /assets\/amr-preview\.js\?v=20260728-amr-wasm-csp-3/);
  assert.ok(html.indexOf("amr-preview.js") < html.indexOf("safe-preview.js"));
  assert.match(amrPreview, /MASICS_AMR_PREVIEW_SELF_TEST/);
  assert.match(amrPreview, /AMR_DECODER_URL/);
  assert.match(amrPreview, /pcmToWavBlob/);
  assert.match(amrPreview, /MASICS_ACTIVE_RECORD/);
  assert.match(amrPreview, /usesActiveRecordWithoutManifestRedownload/);
  assert.match(amrPreview, /Save original AMR/);
  assert.match(searchUi, /AMR playback is handled by the Review Viewer decoder/);
  assert.doesNotMatch(searchUi, /\["mp3", "wav", "m4a", "aac", "ogg", "amr"\]\.includes\(ext\)/);
});

test("review startup avoids export and docx preview dependency blockers", () => {
  const html = read("index.html");
  assert.doesNotMatch(html, /assets\/vendor\/xlsx\.full\.min\.js\?v=0\.18\.5/);
  assert.doesNotMatch(html, /assets\/vendor\/mammoth\.browser\.min\.js\?v=1\.12\.0/);
  assert.match(html, /assets\/queue-performance\.css\?v=20260821-virtual-1/);
  assert.match(missingExport, /ensureXlsxLoaded/);
  assert.match(missingExport, /xlsx\.full\.min\.js\?v=0\.18\.5/);
  assert.match(preview, /ensureMammothLoaded/);
  assert.match(preview, /mammoth\.browser\.min\.js\?v=1\.12\.0/);
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

test("initial sync preserves online AI notes against stale browser-local notes", () => {
  const code = [
    extractFunction(app, "updatedAt"),
    extractFunction(app, "noteHasAINote"),
    extractFunction(app, "notesWithPreservedAINote"),
    extractFunction(app, "hasReviewValue"),
    extractFunction(app, "shouldReplaceDecision"),
    extractFunction(app, "mergeDecisions"),
    `globalThis.result = mergeDecisions({
      sameTime: { decision: "missing", notes: "Mario original\\n\\nAI note: Online context", updatedAt: "2026-07-20T00:00:00Z" },
      newerLocal: { decision: "missing", notes: "Old Mario\\n\\nAI note: Keep this", updatedAt: "2026-07-20T00:00:00Z" }
    }, {
      sameTime: { decision: "missing", notes: "Mario original", updatedAt: "2026-07-20T00:00:00Z" },
      newerLocal: { decision: "missing", notes: "Edited Mario", updatedAt: "2026-07-21T00:00:00Z" }
    });`
  ].join("\n");
  const context = {};
  vm.runInNewContext(code, context);
  assert.equal(context.result.sameTime.notes, "Mario original\n\nAI note: Online context");
  assert.equal(context.result.newerLocal.notes, "Edited Mario\n\nAI note: Keep this");
});

test("save merge protects newer online decisions from stale local sessions", () => {
  const code = [
    extractFunction(saveMerge, "hasValue"),
    extractFunction(saveMerge, "updatedAt"),
    extractFunction(saveMerge, "noteHasAINote"),
    extractFunction(saveMerge, "notesWithPreservedAINote"),
    extractFunction(saveMerge, "newerOrSafer"),
    extractFunction(saveMerge, "mergeDecisions"),
    `globalThis.result = mergeDecisions({
      keep: { decision: "missing", notes: "new online", updatedAt: "2026-07-15T01:00:00Z" },
      blank: { decision: "responsive", notes: "online value", updatedAt: "2026-07-15T01:00:00Z" },
      deleted: { decision: "delete", notes: "excluded", updatedAt: "2026-07-15T01:00:00Z" },
      ai: { decision: "missing", notes: "Mario\\n\\nAI note: Preserve online AI", updatedAt: "2026-07-15T01:00:00Z" }
    }, {
      keep: { decision: "responsive", notes: "old local", updatedAt: "2026-07-14T01:00:00Z" },
      blank: { decision: "", notes: "", updatedAt: "2026-07-15T02:00:00Z" },
      deleted: { decision: "missing", notes: "later local", updatedAt: "2026-07-15T02:00:00Z" },
      adopt: { decision: "duplicate", notes: "fresh local", updatedAt: "2026-07-15T02:00:00Z" },
      ai: { decision: "missing", notes: "Mario", updatedAt: "2026-07-15T01:00:00Z" }
    });`
  ].join("\n");
  const context = {};
  vm.runInNewContext(code, context);
  assert.equal(context.result.keep.decision, "missing");
  assert.equal(context.result.blank.decision, "responsive");
  assert.equal(context.result.deleted.decision, "delete");
  assert.equal(context.result.adopt.decision, "duplicate");
  assert.equal(context.result.ai.notes, "Mario\n\nAI note: Preserve online AI");
});

test("save path writes progress, full status csv, marked csv, audit, and manual snapshots", () => {
  assert.match(read("index.html"), /assets\/save-online-merge\.js\?v=20260821-save-total-guard-4/);
  assert.match(saveMerge, /MASICS_MARIO_REVIEW_PROGRESS_LATEST\.json/);
  assert.match(saveMerge, /MASICS_MARIO_REVIEW_STATUS_LATEST\.csv/);
  assert.match(saveMerge, /MASICS_MARIO_MARKED_REVIEWED_LATEST\.csv/);
  assert.match(saveMerge, /MASICS_MARIO_REVIEW_AUDIT_LATEST\.json/);
  assert.match(saveMerge, /MASICS_MARIO_MARKED_REVIEWED_\$\{stamp\}\.csv/);
  assert.match(saveMerge, /Online verification failed/);
  assert.match(saveMerge, /completeDecisionMap/);
  assert.match(saveMerge, /saved decision map does not cover the full protected queue/);
  assert.match(saveMerge, /pending records are preserved as blank decision entries/);
  assert.match(saveMerge, /generated status rows do not cover the full protected queue/);
  assert.match(saveMerge, /Total records: \$\{records\.length\}/);
  assert.match(saveMerge, /beforeunload/);
  assert.match(saveMerge, /MASICS_AUTH_REDIRECT_IN_PROGRESS/);
});

test("evidence preview tries good alternate locators before mounted primary paths", () => {
  const appLocators = extractFunction(app, "evidenceLocators");
  const previewLocators = extractFunction(preview, "evidenceLocators");
  for (const fn of [appLocators, previewLocators]) {
    assert.ok(fn.indexOf("dropbox_file_id") < fn.indexOf("dropbox_path_alternates"));
    assert.ok(fn.indexOf("dropbox_path_alternates") < fn.lastIndexOf("dropbox_path"));
  }
  assert.match(app, /const locators = evidenceLocators\(active\)/);
  assert.match(preview, /const locators = evidenceLocators\(record\)/);
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

test("missing xlsx export includes every file tagged missing and only missing", () => {
  const code = [
    extractFunction(missingExport, "isMissingDecision"),
    extractFunction(missingExport, "splitNotes"),
    extractFunction(missingExport, "batesFromText"),
    extractFunction(missingExport, "derivedCategory"),
    extractFunction(missingExport, "legalMetadata"),
    extractFunction(missingExport, "missingRows"),
    `const manifest = { records: [
      { queue_number: 3, filename: "third.png", review_id: "third", file_type: "png", dropbox_path: "/third.png" },
      { queue_number: 1, filename: "first.pdf", review_id: "first", file_type: "pdf", dropbox_path: "/first.pdf", display: { viewer_bates: "MASICS-00001 · DEF000001", bates_range: "DEF000001-DEF000002", category: "FOIL requests" } },
      { queue_number: 2, filename: "second.jpg", review_id: "second", file_type: "jpg", dropbox_path: "/second.jpg", display: { control_bates: "MASICS-00002", priority_tier: "Town Board minutes", ai_note: "Fallback description" } },
      { queue_number: 4, filename: "fourth.jpg", review_id: "fourth", file_type: "jpg", dropbox_path: "/fourth.jpg" }
    ] };
    const progress = { decisions: {
      first: { decision: " Missing ", notes: "BATES: DEF000001-DEF000002 | Mario note\\n\\nAI note: Legal description", updatedAt: "2026-07-15T01:00:00Z" },
      second: { decision: "missing", notes: "plain", updatedAt: "2026-07-15T02:00:00Z" },
      third: { decision: "responsive", notes: "not exported", updatedAt: "2026-07-15T03:00:00Z" },
      fourth: { decision: "delete", notes: "not exported", updatedAt: "2026-07-15T04:00:00Z" }
    } };
    globalThis.rows = missingRows(manifest, progress);`
  ].join("\n");
  const context = {};
  vm.runInNewContext(code, context);
  assert.equal(context.rows.length, 2);
  assert.equal(context.rows.map((row) => row["Review ID"]).join(","), "first,second");
  assert.equal(context.rows.map((row) => row["Queue #"]).join(","), "1,2");
  assert.equal(context.rows[0]["Decision"], "Missing");
  assert.equal(context.rows[0]["Bates Number"], "MASICS-00001 · DEF000001");
  assert.equal(context.rows[0]["Source Bates / Range"], "DEF000001-DEF000002");
  assert.equal(context.rows[0]["Category"], "FOIL requests");
  assert.equal(context.rows[0]["Short Description"], "Legal description");
  assert.equal(context.rows[0]["Mario's note / missing information"], "BATES: DEF000001-DEF000002 | Mario note");
  assert.equal(context.rows[1]["Category"], "Town Board minutes");
});

test("viewer uses native missing/needs-review filters and a progress cache", () => {
  const html = read("index.html");
  const fn = extractFunction(app, "filteredRecords");
  assert.match(html, /value="needs_review"/);
  assert.match(app, /MASICS_NATIVE_QUEUE_FILTERS/);
  assert.match(app, /FILTER_SELECT_DELAY_MS\s*=\s*1600/);
  assert.match(app, /progressCache/);
  assert.match(fn, /filterValue === "missing"/);
  assert.match(fn, /filterValue === "needs_review"/);
  assert.match(app, /paintQueueWindow/);
  assert.match(app, /QUEUE_SEARCH_DEBOUNCE_MS\s*=\s*150/);
});

test("save reuses loaded queue and does not duplicate tagged rows into progress JSON", () => {
  assert.match(saveMerge, /MASICS_QUEUE_RECORDS/);
  assert.match(saveMerge, /cachedManifestRecords/);
  assert.doesNotMatch(saveMerge, /JSON\.stringify\(progress,\s*null,\s*2\)/);
  assert.doesNotMatch(saveMerge, /tagged: rows\.filter/);
  assert.doesNotMatch(saveMerge, /excludedRows: rows\.filter/);
  assert.match(saveMerge, /completeDecisionMap/);
  assert.match(saveMerge, /MASICS_MARIO_REVIEW_STATUS_LATEST\.csv/);
  assert.match(saveMerge, /MASICS_MARIO_MARKED_REVIEWED_LATEST\.csv/);
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
