import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

const protectedMinimum = 5844;
const config = read("assets/config.js");
const index = read("index.html");
const app = read("assets/app.js");
const mountedResolver = read("assets/dropbox-mounted-path-resolver.js");
const notesBuffer = read("assets/notes-input-buffer.js");
const imageThumbnail = read("assets/image-thumbnail-preview.js");
const saveMerge = read("assets/save-online-merge.js");
const missingExport = read("assets/export-missing-xlsx.js");
const preview = read("assets/safe-preview.js");

assert.match(config, /expectedRecordCount:\s*5844\b/, "Protected queue minimum must remain 5,844");
const configuredMinimum = Number(config.match(/expectedRecordCount:\s*(\d+)/)?.[1] || 0);
assert.ok(configuredMinimum >= protectedMinimum, `Protected minimum fell below ${protectedMinimum}`);

assert.match(index, /assets\/config\.js\?v=20260715-manifest-5844-2/, "Viewer must load the current protected config version");
assert.match(index, /assets\/dropbox-mounted-path-resolver\.js\?v=20260718-mounted-folders-3/, "Mounted Dropbox path resolver is missing");
assert.ok(index.indexOf("dropbox-mounted-path-resolver.js") < index.indexOf("assets/app.js"), "Mounted Dropbox path resolver must load before app.js");
assert.match(index, /assets\/notes-input-buffer\.js\?v=20260718-notes-input-buffer-1/, "Notes input performance buffer is missing");
assert.ok(index.indexOf("notes-input-buffer.js") < index.indexOf("assets/app.js"), "Notes input buffer must load before app.js");
assert.ok(index.indexOf("notes-input-buffer.js") < index.indexOf("save-online-merge.js"), "Notes input buffer must load before online-save input listeners");
assert.match(index, /assets\/image-thumbnail-preview\.js\?v=20260718-thumbnail-autopreview-1/, "Fast image thumbnail preview is missing");
assert.ok(index.indexOf("image-thumbnail-preview.js") < index.indexOf("assets/app.js"), "Image thumbnails must register before the app selects records");
assert.ok(index.indexOf("image-thumbnail-preview.js") < index.indexOf("safe-preview.js"), "Image thumbnails must load before full-resolution preview listeners");
assert.doesNotMatch(index, /stream-preview-accelerator\.js/, "Dropbox temporary-link preview must remain disabled because it can force downloads");
assert.match(index, /assets\/app\.js\?v=20260718-auth-redirect-1/, "App auth-redirect cache bust is missing");
assert.match(index, /assets\/safe-preview\.js\?v=20260718-thumbnail-auto-1/, "Safe preview thumbnail cache bust is missing");
assert.match(index, /assets\/export-missing-xlsx\.js\?v=20260718-lazy-xlsx-1/, "Lazy XLSX export cache bust is missing");
assert.match(index, /assets\/save-online-merge\.js\?v=20260718-auth-redirect-1/, "Verified online save guard is missing");
assert.match(index, /assets\/queue-performance\.css\?v=20260718-1/, "Queue performance containment CSS is missing");
assert.doesNotMatch(index, /assets\/vendor\/xlsx\.full\.min\.js\?v=0\.18\.5/, "XLSX dependency must not block normal review startup");
assert.doesNotMatch(index, /assets\/vendor\/mammoth\.browser\.min\.js\?v=1\.12\.0/, "Mammoth dependency must not block normal review startup");
assert.doesNotMatch(index, /cdn\.jsdelivr\.net\/npm\/xlsx/, "XLSX CDN dependency must not be used by the production viewer");
assert.doesNotMatch(index, /autosave-online-v3\.js/, "Obsolete duplicate autosave shim must not return");

assert.match(notesBuffer, /stopImmediatePropagation/, "Notes input buffer must stop per-keystroke legacy listeners");
assert.match(notesBuffer, /SAVE_AFTER_IDLE_MS\s*=\s*750/, "Notes save debounce must remain enabled");
assert.match(notesBuffer, /masicsBufferedCommit/, "Notes input buffer must preserve the existing save pipeline after debounce");
assert.match(notesBuffer, /addEventListener\("blur"/, "Notes input must flush immediately on blur");

assert.match(imageThumbnail, /files\/get_thumbnail_v2/, "Images must use Dropbox's thumbnail endpoint for fast previews");
assert.match(imageThumbnail, /w1024h768/, "Image thumbnails must use a screen-sized preview");
assert.match(imageThumbnail, /URL\.createObjectURL\(blob\)/, "Image thumbnails must remain in-page object URLs");
assert.match(imageThumbnail, /stopImmediatePropagation/, "Image thumbnails must bypass the automatic full-image download");
assert.doesNotMatch(imageThumbnail, /files\/download/, "Image thumbnail auto-preview must not download manifests or evidence files");
assert.match(imageThumbnail, /Preview Evidence/, "Full-resolution images must remain available on demand");
assert.match(imageThumbnail, /fallBackToSafePreview/, "Thumbnail failures must fall back to the established safe preview");
assert.match(imageThumbnail, /debouncesRecordChanges/, "Image thumbnail requests must be debounced during fast navigation");
assert.match(imageThumbnail, /350/, "Image thumbnail debounce must be long enough to absorb fast record navigation");
assert.match(imageThumbnail, /recoversMissedInitialRecord/, "Image thumbnail preview must recover if the initial record-change event was missed");
assert.match(imageThumbnail, /ignoresStaleThumbnailResponses/, "Stale image thumbnail responses must be ignored");
assert.doesNotMatch(imageThumbnail, /get_temporary_link/, "Image preview must not use download-forcing Dropbox temporary links");

assert.match(app, /loaded\.records\.length < minimumRecordCount/, "Manifest shrink guard is missing");
assert.match(app, /record_count does not match records/, "Manifest count integrity check is missing");
assert.match(app, /duplicate or missing review ID/, "Review ID uniqueness check is missing");
assert.match(app, /Queue manifest includes an embedded decision/, "Manifest decision contamination guard is missing");
assert.match(app, /function evidenceLocators/, "Evidence locator ordering helper is missing");
assert.match(app, /dropbox_path_alternates[\s\S]*dropbox_path/, "Evidence alternates must be tried before mounted primary paths");
assert.match(app, /document\.createDocumentFragment/, "Queue list batch rendering is missing");
assert.match(app, /MASICS_AUTH_REDIRECT_IN_PROGRESS/, "Dropbox auth redirects must bypass the save-leave warning");
assert.match(app, /MASICS_QUEUE_RECORDS = records/, "App must expose loaded records to the thumbnail helper without another manifest download");
assert.match(app, /MASICS_ACTIVE_RECORD = record/, "App must expose the active record to the thumbnail helper");
assert.match(app, /masics:record-change", \{ detail: \{ record \} \}/, "Record-change events must pass the active record to avoid redundant manifest reads");

assert.match(mountedResolver, /asciiHeaderJson/, "Unicode-safe Dropbox header encoding is missing");
assert.match(mountedResolver, /files\/search_v2/, "Mounted-folder file-ID search fallback is missing");
assert.match(mountedResolver, /files\/search\/continue_v2/, "Mounted-folder paginated search fallback is missing");
assert.match(mountedResolver, /path_display/, "Mounted-folder suffix matching is missing");
assert.match(mountedResolver, /sessionStorage/, "Resolved Dropbox file-ID cache is missing");

for (const filename of [
  "MASICS_MARIO_REVIEW_PROGRESS_LATEST.json",
  "MASICS_MARIO_REVIEW_STATUS_LATEST.csv",
  "MASICS_MARIO_MARKED_REVIEWED_LATEST.csv",
  "MASICS_MARIO_REVIEW_AUDIT_LATEST.json"
]) {
  assert.ok(saveMerge.includes(filename), `${filename} is no longer written by Save Online`);
}
assert.match(saveMerge, /Online verification failed/, "Save Online must verify by reading Dropbox back");
assert.match(saveMerge, /mergeDecisions\(online\?\.decisions/, "Online and local decisions must still be merged");
assert.match(saveMerge, /beforeunload/, "Pending save navigation warning is missing");
assert.match(saveMerge, /MASICS_AUTH_REDIRECT_IN_PROGRESS/, "Pending save warning must allow Dropbox auth redirects");
assert.match(saveMerge, /\.tag["']?:\s*"update"/, "Dropbox optimistic-concurrency update mode is missing");
assert.match(saveMerge, /dirty_unsynced/, "Durable dirty-state marker is missing");
assert.match(saveMerge, /captureVisibleMutation/, "Captured mutation save guard is missing");
assert.match(saveMerge, /generationId/, "Progress generation identity is missing");
assert.match(saveMerge, /sourceProgressHash/, "Progress source hash is missing");
assert.match(saveMerge, /local_json_quarantine/, "Local JSON corruption quarantine is missing");
assert.match(saveMerge, /saved decision count unexpectedly decreased/, "Whole-save decision-count verification is missing");

assert.match(missingExport, /String\(decision \|\| ""\)\.trim\(\)\.toLowerCase\(\) === "missing"/, "Missing export must remain decision-specific");
assert.match(missingExport, /window\.XLSX\.writeFile/, "Missing XLSX writer is missing");
assert.match(missingExport, /ensureXlsxLoaded/, "XLSX must be loaded on demand");
assert.match(missingExport, /xlsx\.full\.min\.js\?v=0\.18\.5/, "Lazy XLSX dependency must remain locally pinned");

assert.match(preview, /URL\.createObjectURL\(blob\)/, "Evidence preview must use browser object URLs");
assert.doesNotMatch(preview, /readAsDataURL|FileReader/, "Unsafe full-file data URL preview must not return");
assert.match(preview, /sanitizeDocxHtml/, "DOCX preview sanitization is missing");
assert.match(preview, /ensureMammothLoaded/, "Mammoth must be loaded on demand");
assert.match(preview, /dropbox_path_alternates[\s\S]*dropbox_path/, "Safe preview alternates must be tried before mounted primary paths");
assert.match(preview, /imageAutoPreviewUsesThumbnailOnly/, "Image auto-preview must use Dropbox thumbnails, not full file downloads");
assert.match(preview, /nonImageAutoPreviewDoesNotDownload/, "Non-image record selection must not auto-download evidence");
assert.match(preview, /manualFullPreviewStillDownloadsActiveRecord/, "Manual Preview Evidence must still load only the active record");
assert.match(preview, /files\/get_thumbnail_v2/, "Thumbnail endpoint is missing");
assert.match(preview, /No full evidence file was downloaded/, "Thumbnail status must say full evidence was not downloaded");
assert.match(preview, /maxAutoPreviewBytes/, "Auto-preview byte limit is missing");
assert.match(preview, /maxInitialPdfPages/, "Initial PDF page limit is missing");
assert.match(preview, /AbortController/, "Preview cancellation is missing");
assert.match(preview, /Load .*more PDF page/, "PDF lazy load-more control is missing");
assert.match(preview, /new URL\(`vendor\/pdf\.mjs/, "PDF.js module must be locally pinned");
assert.match(preview, /new URL\(`vendor\/pdf\.worker\.mjs/, "PDF.js worker must be locally pinned");
assert.doesNotMatch(preview, /cdn\.jsdelivr\.net\/npm\/pdfjs-dist/, "PDF.js CDN dependency must not be used by the production viewer");

console.log("PASS Mario viewer deployment safety checks");
