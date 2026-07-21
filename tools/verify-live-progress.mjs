import fs from "node:fs";
import path from "node:path";

const AI_NOTE_RE = /(?:^|\n)\s*AI note\s*:/i;

function usage() {
  return `Usage:
  node tools/verify-live-progress.mjs --progress <progress.json> [--manifest <manifest.json>] [--backup <backup-progress.json>] [--out-dir <folder>] [--warn-only]

Purpose:
  Verifies the live MASICS Mario progress JSON without changing it.
  Use --backup when you need proof that decisions and Mario's original notes were preserved.
`;
}

function parseArgs(argv) {
  const args = { warnOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--warn-only") {
      args.warnOnly = true;
      continue;
    }
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    i += 1;
    const normalized = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    args[normalized] = value;
  }
  if (!args.progress) throw new Error("--progress is required");
  return args;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Could not read JSON from ${filePath}: ${err.message}`);
  }
}

function ensureObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is missing or is not an object`);
  }
  return value;
}

function decisionValue(saved) {
  return String(saved?.decision || "").trim();
}

function noteValue(saved) {
  return String(saved?.notes || "");
}

function hasReviewValue(saved) {
  return Boolean(decisionValue(saved) || noteValue(saved).trim());
}

function noteHasAiNote(saved) {
  return AI_NOTE_RE.test(noteValue(saved));
}

function marioNotePart(saved) {
  const notes = noteValue(saved);
  const match = notes.match(AI_NOTE_RE);
  if (!match || match.index === undefined) return notes.trimEnd();
  return notes.slice(0, match.index).trimEnd();
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(filePath, rows) {
  const headers = ["type", "review_id", "queue_number", "filename", "detail"];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function getManifestRecords(manifest) {
  if (!manifest) return [];
  const records = Array.isArray(manifest.records) ? manifest.records : [];
  return records.map((record, index) => ({
    review_id: String(record.review_id || ""),
    queue_number: record.queue_number || index + 1,
    filename: String(record.filename || "")
  }));
}

function duplicateReviewIds(records) {
  const seen = new Set();
  const duplicates = new Set();
  for (const record of records) {
    if (!record.review_id) continue;
    if (seen.has(record.review_id)) duplicates.add(record.review_id);
    seen.add(record.review_id);
  }
  return [...duplicates].sort();
}

function progressRecordFallback(decisions) {
  return Object.keys(decisions)
    .sort()
    .map((review_id, index) => ({ review_id, queue_number: index + 1, filename: "" }));
}

function summarize({ progress, manifest = null, backup = null }) {
  const decisions = ensureObject(progress.decisions, "progress.decisions");
  const backupDecisions = backup ? ensureObject(backup.decisions, "backup.decisions") : null;
  const manifestRecords = getManifestRecords(manifest);
  const records = manifestRecords.length ? manifestRecords : progressRecordFallback(decisions);
  const manifestIds = new Set(records.map((record) => record.review_id).filter(Boolean));
  const decisionIds = new Set(Object.keys(decisions));
  const duplicateIds = duplicateReviewIds(records);
  const exceptions = [];

  let recordsWithAiNote = 0;
  let reviewedCount = 0;
  let excludedCount = 0;
  let notesOnlyCount = 0;
  let decisionChanges = 0;
  let marioNoteChanges = 0;

  for (const record of records) {
    const saved = decisions[record.review_id] || {};
    const decision = decisionValue(saved);
    const notes = noteValue(saved);

    if (!decisionIds.has(record.review_id)) {
      exceptions.push({ ...record, type: "missing_progress_decision", detail: "Manifest record has no matching progress decision entry" });
    }

    if (decision === "delete") excludedCount += 1;
    else if (decision) reviewedCount += 1;
    else if (notes.trim()) notesOnlyCount += 1;

    if (noteHasAiNote(saved)) {
      recordsWithAiNote += 1;
    } else {
      exceptions.push({ ...record, type: "missing_ai_note", detail: "Notes field does not contain exact label AI note:" });
    }

    if (backupDecisions && backupDecisions[record.review_id]) {
      const before = backupDecisions[record.review_id];
      const beforeDecision = decisionValue(before);
      if (beforeDecision !== decision) {
        decisionChanges += 1;
        exceptions.push({
          ...record,
          type: "decision_changed_from_backup",
          detail: `Backup decision was ${beforeDecision || "blank"}; live decision is ${decision || "blank"}`
        });
      }
      if (marioNotePart(before) !== marioNotePart(saved)) {
        marioNoteChanges += 1;
        exceptions.push({ ...record, type: "mario_note_changed_from_backup", detail: "Text before AI note: changed compared to backup" });
      }
    }
  }

  for (const id of decisionIds) {
    if (manifestIds.size && !manifestIds.has(id) && hasReviewValue(decisions[id])) {
      exceptions.push({ type: "extra_progress_decision", review_id: id, queue_number: "", filename: "", detail: "Progress has a decision ID not found in manifest" });
    }
  }

  for (const id of duplicateIds) {
    exceptions.push({ type: "duplicate_manifest_review_id", review_id: id, queue_number: "", filename: "", detail: "Manifest contains this review ID more than once" });
  }

  const recordsTotal = records.length;
  const recordsMissingAiNote = Math.max(0, recordsTotal - recordsWithAiNote);
  return {
    summary: {
      verified_at: new Date().toISOString(),
      queue_identity: progress.queueIdentity || progress.queue_identity || "",
      manifest_queue_identity: manifest?.queue_identity || manifest?.queueIdentity || "",
      records_total: recordsTotal,
      progress_decisions_total: Object.keys(decisions).length,
      records_with_ai_note: recordsWithAiNote,
      records_missing_ai_note: recordsMissingAiNote,
      reviewed_count: reviewedCount,
      excluded_count: excludedCount,
      notes_only_count: notesOnlyCount,
      pending_count: Math.max(0, recordsTotal - reviewedCount - excludedCount),
      duplicate_manifest_review_ids: duplicateIds.length,
      decision_changes: backupDecisions ? decisionChanges : null,
      mario_note_changes: backupDecisions ? marioNoteChanges : null,
      backup_compared: Boolean(backupDecisions),
      exceptions_count: exceptions.length,
      status: exceptions.length === 0 ? "PASS" : "FAIL"
    },
    exceptions
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const progress = readJson(args.progress);
  const manifest = args.manifest ? readJson(args.manifest) : null;
  const backup = args.backup ? readJson(args.backup) : null;
  const outDir = args.outDir || path.dirname(path.resolve(args.progress));
  fs.mkdirSync(outDir, { recursive: true });

  const { summary, exceptions } = summarize({ progress, manifest, backup });
  const summaryPath = path.join(outDir, "LIVE_AI_NOTE_VERIFICATION_SUMMARY.json");
  const exceptionsPath = path.join(outDir, "LIVE_AI_NOTE_VERIFICATION_EXCEPTIONS.csv");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeCsv(exceptionsPath, exceptions);

  console.log(JSON.stringify(summary, null, 2));
  console.log(`Summary written: ${summaryPath}`);
  console.log(`Exceptions written: ${exceptionsPath}`);

  if (summary.status !== "PASS" && !args.warnOnly) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error(err.message);
  console.error(usage());
  process.exitCode = 1;
}
