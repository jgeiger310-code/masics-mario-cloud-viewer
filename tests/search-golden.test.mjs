import assert from "node:assert/strict";

await import("../assets/search-core.js");
const core = globalThis.MASICSSearchCore;
assert.ok(core);

const records = [
  {
    review_id: "foil1",
    queue_number: 1,
    filename: "FOIL response June 2022.pdf",
    file_type: "pdf",
    decision: "missing",
    mario_notes: "Town FOIL denial",
    ai_note: "Freedom of Information Law response",
    ocr_text: "Your Freedom of Information Law request is denied in part",
    dropbox_path: "/Franklinville/foil.pdf",
    has_ocr_sidecar: true
  },
  {
    review_id: "co1",
    queue_number: 2,
    filename: "certificate of occupancy scan.jpg",
    file_type: "jpg",
    decision: "needs_review",
    mario_notes: "",
    ai_note: "C of O for Farrington garage",
    ocr_text: "Certificate of Occupancy issued by Town of Franklinville",
    dropbox_path: "/Franklinville/co.jpg",
    has_ocr_sidecar: true
  },
  {
    review_id: "audio1",
    queue_number: 3,
    filename: "2 18 machias dog license.mp3",
    file_type: "mp3",
    decision: "privileged",
    mario_notes: "machias dog license name change kennel",
    transcript_text: "The clerk said the dog license was changed from Fran to Mario",
    dropbox_path: "/Franklinville/dog.mp3",
    has_transcript_sidecar: true
  },
  {
    review_id: "video1",
    queue_number: 7730,
    filename: "20190118_141613.mp4",
    file_type: "mp4",
    decision: "",
    mario_notes: "",
    ai_note: "Large Franklinville discovery video",
    transcript_text: "january eighteenth two thousand nineteen",
    dropbox_path: "/new stuff franklinville discovery/20190118_141613.mp4",
    has_transcript_sidecar: true
  },
  {
    review_id: "noise1",
    queue_number: 50,
    filename: "public_records_workshop_agenda.pdf",
    file_type: "pdf",
    decision: "nonresponsive",
    mario_notes: "generic public records training",
    ocr_text: "agenda for public records workshop and freedom of the press panel",
    dropbox_path: "/Franklinville/agenda.pdf"
  },
  {
    review_id: "miller1",
    queue_number: 6,
    filename: "Letter to Frank Miller.pdf",
    file_type: "pdf",
    decision: "missing",
    mario_notes: "letter frank miller geiger farrington",
    ai_note: "Attorney Frank Miller correspondence",
    dropbox_path: "/Franklinville/miller.pdf"
  }
];

const engine = new core.SearchEngine(records).build();

const cases = [
  { q: "FOIL", must: ["foil1"], mustNot: ["noise1"] },
  { q: "certificate of occupancy", must: ["co1"] },
  { q: "c of o", must: ["co1"] },
  { q: "dog license", must: ["audio1"] },
  { q: "kennel", must: ["audio1"] },
  { q: "frank miller", must: ["miller1"] },
  { q: "filename:machias", must: ["audio1"] },
  { q: "decision:missing", mustIncludeAny: ["foil1", "miller1"] },
  { q: '"Freedom of Information"', must: ["foil1"] }
];

for (const test of cases) {
  const res = engine.search(test.q, test.opts || {});
  const ids = new Set(res.results.map((r) => r.review_id));
  for (const id of test.must || []) {
    assert.ok(ids.has(id), `query "${test.q}" must include ${id}, got ${[...ids]}`);
  }
  for (const id of test.mustNot || []) {
    assert.equal(ids.has(id), false, `query "${test.q}" must not include ${id}`);
  }
  if (test.mustIncludeAny) {
    assert.ok(
      test.mustIncludeAny.some((id) => ids.has(id)),
      `query "${test.q}" must include one of ${test.mustIncludeAny}`
    );
  }
}

assert.equal(engine.search("foil", { fuzzy: true }).results[0].review_id, "foil1");

const qualityEngine = new core.SearchEngine([
  {
    review_id: "goodnote",
    queue_number: 1,
    filename: "other.pdf",
    mario_notes: "zoning permit discussion",
    ocr_text: "",
    ocr_quality: "good"
  },
  {
    review_id: "poorocr",
    queue_number: 2,
    filename: "scan.jpg",
    mario_notes: "",
    ocr_text: "zoning permit gibberish scan text",
    ocr_quality: "poor"
  }
]).build();
assert.equal(qualityEngine.search("zoning permit").results[0].review_id, "goodnote");

const payload = engine.serialize();
const restored = core.SearchEngine.hydrate(payload);
assert.equal(restored.search("FOIL").results[0].review_id, "foil1");
assert.equal(restored.docs.length, records.length);

const progress = {
  total: 99,
  reviewed: 1,
  pending: 1,
  decisions: {
    foil1: { decision: "missing", notes: "x" },
    audio1: { decision: "privileged", notes: "" },
    video1: { decision: "", notes: "" },
    orphan: { decision: "missing", notes: "old" }
  }
};
const summary = core.recomputeProgressSummaries(progress, {
  knownReviewIds: records.map((r) => r.review_id)
});
assert.equal(summary.total, records.length);
assert.equal(summary.reviewed, 2);
assert.equal(summary.pending, 4);
assert.equal(summary.tagged, 2);

console.log("search-golden tests passed");
