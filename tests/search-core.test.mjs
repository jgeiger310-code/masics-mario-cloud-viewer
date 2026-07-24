import assert from "node:assert/strict";

await import("../assets/search-core.js");
const core = globalThis.MASICSSearchCore;
assert.ok(core, "search core should load");

const csv = 'name,notes\r\n"One, File","Line 1\nLine 2"\r\nTwo,Plain\r\n';
const parsed = core.parseCsv(csv);
assert.equal(parsed.length, 2);
assert.equal(parsed[0].name, "One, File");
assert.equal(parsed[0].notes, "Line 1\nLine 2");

const records = [
  {
    review_id: "a", queue_number: 1, filename: "Town FOIL response.pdf", file_type: "pdf", decision: "missing",
    mario_notes: "Town did not produce the public records response", ai_note: "FOIL denial dated June 21, 2022",
    ocr_text: "Freedom of Information Law request and denial", transcript_text: "",
    dropbox_path: "/Franklinville/foil response.pdf", has_ocr_sidecar: true
  },
  {
    review_id: "b", queue_number: 2, filename: "Machias dog license.mp3", file_type: "mp3", decision: "privileged",
    mario_notes: "Dog license changed from Fran to Mario", ai_note: "Audio regarding kennel licensing",
    transcript_text: "The clerk said the dog license name was changed.", dropbox_path: "/Franklinville/audio.mp3",
    has_transcript_sidecar: true
  }
];

const engine = new core.SearchEngine(records).build();
assert.equal(engine.search("FOIL").results[0].review_id, "a");
assert.equal(engine.search('"dog license"').results[0].review_id, "b");
assert.equal(engine.search("filename:machias").results[0].review_id, "b");
assert.equal(engine.search("publik", { fuzzy: true }).results[0].review_id, "a");
assert.equal(engine.search("kennel", { related: true }).results[0].review_id, "b");
assert.equal(engine.search("license", { filters: { decisions: ["missing"] } }).total, 0);
assert.equal(engine.search("", { filters: { hasOcr: true } }).total, 1);

// File category filters (image / audio / video / document / other)
assert.equal(core.categorizeFileType("jpg"), "image");
assert.equal(core.categorizeFileType(".MP4"), "video");
assert.equal(core.categorizeFileType("mp3"), "audio");
assert.equal(core.categorizeFileType("pdf"), "document");
assert.equal(core.categorizeFileType("amr"), "audio");
assert.equal(core.categorizeFileType("url"), "other");
assert.equal(engine.search("", { filters: { fileCategories: ["document"] } }).total, 1);
assert.equal(engine.search("", { filters: { fileCategories: ["audio"] } }).results[0].review_id, "b");
assert.equal(engine.search("", { filters: { fileCategories: ["image"] } }).total, 0);
assert.equal(engine.search("", { filters: { fileCategories: ["document", "audio"] } }).total, 2);
assert.equal(engine.search("", { filters: { fileCategories: ["document"], fileTypes: ["mp3"] } }).total, 0);

// Regression: stopwords must not zero multi-word legal phrases
const legal = new core.SearchEngine([
  {
    review_id: "noc", queue_number: 10, filename: "Masic Notice of Claim.pdf", file_type: "pdf",
    mario_notes: "filed notice of claim", ai_note: "", ocr_text: "NOTICE OF CLAIM against the Town",
    dropbox_path: "/Franklinville/Masic Notice of Claim.pdf"
  },
  {
    review_id: "co", queue_number: 11, filename: "occupancy.pdf", file_type: "pdf",
    mario_notes: "", ai_note: "certificate of occupancy discussion", ocr_text: "",
    dropbox_path: "/Franklinville/occupancy.pdf"
  },
  {
    review_id: "unrelated", queue_number: 12, filename: "agenda.pdf", file_type: "pdf",
    mario_notes: "public records workshop", ai_note: "records retention", ocr_text: "freedom of the press",
    dropbox_path: "/Franklinville/agenda.pdf"
  }
]).build();
assert.ok(legal.search("notice of claim").total >= 1, "unquoted notice of claim must hit");
assert.ok(legal.search("certificate of occupancy").total >= 1, "unquoted certificate of occupancy must hit");
// FOIL must not explode into every "public"/"records" document
assert.equal(legal.search("FOIL").results.some((r) => r.review_id === "unrelated"), false,
  "FOIL synonym expansion must not match loose public/records tokens alone");

console.log("search-core tests passed");
