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

console.log("search-core tests passed");
