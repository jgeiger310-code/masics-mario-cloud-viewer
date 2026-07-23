#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

EXPECTED_BRANCH="agent/masics-evidence-search"
CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || true)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "ERROR: This must run on $EXPECTED_BRANCH, not ${CURRENT_BRANCH:-an unknown branch}." >&2
  echo "Run: git fetch --all --prune && git checkout $EXPECTED_BRANCH && git pull origin $EXPECTED_BRANCH" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "WARNING: The repository has uncommitted changes. The builder will not edit repository source files."
  git status --short
fi

DROPBOX_ROOT="${1:-}"
if [[ -z "$DROPBOX_ROOT" ]]; then
  candidates=(
    "$HOME/Library/CloudStorage/Dropbox-Jake/jake Geiger"
    "$HOME/Library/CloudStorage/Dropbox/jake Geiger"
    "$HOME/Dropbox/jake Geiger"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -d "$candidate/Mario_Viewer_Exports" && -d "$candidate/MARIO - OPEN THIS - MASICS REVIEW TOOL" ]]; then
      DROPBOX_ROOT="$candidate"
      break
    fi
  done
fi

if [[ -z "$DROPBOX_ROOT" || ! -d "$DROPBOX_ROOT" ]]; then
  echo "ERROR: Could not locate the synced Dropbox case root." >&2
  echo "Run this script with the full path, for example:" >&2
  echo "  bash scripts/prepare_search_catalog.sh \"/Users/jakegeiger/Library/CloudStorage/Dropbox-Jake/jake Geiger\"" >&2
  exit 1
fi

VIEWER_DIR="$DROPBOX_ROOT/MARIO - OPEN THIS - MASICS REVIEW TOOL/MASICS Review System Files/MASICS_MARIO_CLOUD_VIEWER"
EXPORT_DIR="$DROPBOX_ROOT/Mario_Viewer_Exports/Solid_AI_And_Sidecar_Cleanup"
OCR_DIR="$DROPBOX_ROOT/Mario_Viewer_Exports/Mario_FULL_Viewer_OCR_AI_Description_Output_20260720/ocr_text_by_record"
TRANSCRIPT_DIR="$EXPORT_DIR/CANONICAL_TRANSCRIPTS_BY_STEM"
OUTPUT_DIR="$VIEWER_DIR/SEARCH_INDEX"
MANIFEST="$VIEWER_DIR/MASICS_MARIO_QUEUE_MANIFEST_V1.json"
PROGRESS="$VIEWER_DIR/MASICS_MARIO_REVIEW_PROGRESS_LATEST.json"

required_paths=(
  "$MANIFEST"
  "$PROGRESS"
  "$EXPORT_DIR"
  "$OCR_DIR"
  "$TRANSCRIPT_DIR"
)
for required in "${required_paths[@]}"; do
  if [[ ! -e "$required" ]]; then
    echo "ERROR: Required input is missing: $required" >&2
    exit 1
  fi
done

SOURCE_CSV="$(python3 - "$EXPORT_DIR" <<'PY'
import sys
from pathlib import Path
folder = Path(sys.argv[1])
matches = [path for path in folder.glob("SEARCHABLE_FILE_INDEX_*.csv") if path.is_file()]
if not matches:
    raise SystemExit(1)
print(max(matches, key=lambda path: (path.stat().st_mtime_ns, path.name)))
PY
)" || {
  echo "ERROR: No SEARCHABLE_FILE_INDEX_*.csv was found in $EXPORT_DIR" >&2
  exit 1
}

HASH_SNAPSHOT="$(mktemp -t masics-search-inputs.XXXXXX)"
trap 'rm -f "$HASH_SNAPSHOT"' EXIT
python3 - "$HASH_SNAPSHOT" "$MANIFEST" "$PROGRESS" "$SOURCE_CSV" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()

snapshot = {str(Path(value).resolve()): digest(Path(value)) for value in sys.argv[2:]}
Path(sys.argv[1]).write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
PY

echo "Repository:    $REPO_ROOT"
echo "Branch:        $CURRENT_BRANCH"
echo "Dropbox root:  $DROPBOX_ROOT"
echo "Source catalog: $SOURCE_CSV"
echo "Output:        $OUTPUT_DIR"
echo

echo "Running search and builder safety tests..."
node tests/search-core.test.mjs
python3 -m py_compile \
  scripts/search_catalog_lib.py \
  scripts/build_search_catalog.py \
  scripts/build_search_catalog_verified.py \
  tests/test_search_catalog_verified.py
python3 -m unittest tests/test_search_catalog_verified.py

echo
echo "Building the read-only full OCR/transcript search catalog..."
python3 scripts/build_search_catalog_verified.py --dropbox-root "$DROPBOX_ROOT"

SUMMARY="$OUTPUT_DIR/MASICS_SEARCH_BUILD_SUMMARY_LATEST.json"
CATALOG_GZ="$OUTPUT_DIR/MASICS_SEARCH_CATALOG_LATEST.json.gz"
AMBIGUITIES="$OUTPUT_DIR/MASICS_SEARCH_AMBIGUITIES_LATEST.csv"
for output in "$SUMMARY" "$CATALOG_GZ" "$AMBIGUITIES"; do
  if [[ ! -s "$output" ]]; then
    echo "ERROR: Expected non-empty output was not created: $output" >&2
    exit 1
  fi
done

python3 - "$HASH_SNAPSHOT" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()

snapshot = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
changed = []
for raw_path, before in snapshot.items():
    path = Path(raw_path)
    after = digest(path)
    if after != before:
        changed.append((raw_path, before, after))
if changed:
    print("ERROR: A protected source changed while the catalog was being built.", file=sys.stderr)
    for path, before, after in changed:
        print(f"  {path}\n    before {before}\n    after  {after}", file=sys.stderr)
    print("Do not approve this build. Rerun when Mario is not actively saving.", file=sys.stderr)
    raise SystemExit(1)
print("Protected manifest, progress, and source-catalog hashes remained unchanged.")
PY

echo
python3 - "$SUMMARY" "$AMBIGUITIES" "$CATALOG_GZ" "$SOURCE_CSV" <<'PY'
import csv
import gzip
import hashlib
import json
import sys
from pathlib import Path

summary_path = Path(sys.argv[1])
ambiguity_path = Path(sys.argv[2])
catalog_gz = Path(sys.argv[3])
source_csv = Path(sys.argv[4])
summary = json.loads(summary_path.read_text(encoding="utf-8"))

with source_csv.open("r", encoding="utf-8-sig", newline="") as handle:
    source_count = sum(1 for _ in csv.DictReader(handle))
with ambiguity_path.open("r", encoding="utf-8-sig", newline="") as handle:
    ambiguity_count = sum(1 for _ in csv.DictReader(handle))

record_count = int(summary.get("record_count", 0))
if record_count != source_count:
    raise SystemExit(f"ERROR: Built record count {record_count:,} does not match source count {source_count:,}.")

def hash_stream(handle) -> str:
    hasher = hashlib.sha256()
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        hasher.update(chunk)
    return hasher.hexdigest()

with catalog_gz.open("rb") as handle:
    gzip_hash = hash_stream(handle)
with gzip.open(catalog_gz, "rb") as handle:
    catalog_hash = hash_stream(handle)
if gzip_hash != summary.get("gzip_sha256"):
    raise SystemExit("ERROR: Compressed catalog hash does not match the build summary.")
if catalog_hash != summary.get("catalog_sha256"):
    raise SystemExit("ERROR: Decompressed catalog hash does not match the build summary.")

print("Verified catalog build summary")
print(f"  Source records:          {source_count:,}")
print(f"  Built records:           {record_count:,}")
print(f"  OCR text records:        {summary.get('ocr_text_records', 0):,}")
print(f"  Transcript text records: {summary.get('transcript_text_records', 0):,}")
print(f"  Ambiguity rows:          {ambiguity_count:,}")
print(f"  Catalog JSON bytes:      {summary.get('catalog_json_bytes', 0):,}")
print(f"  Catalog gzip bytes:      {summary.get('catalog_gzip_bytes', 0):,}")
print(f"  Catalog SHA-256:         {catalog_hash}")
print(f"  Gzip SHA-256:            {gzip_hash}")

safety = summary.get("safety") or {}
expected = {
    "evidence_files_modified": 0,
    "mario_notes_modified": 0,
    "decisions_modified": 0,
    "progress_file_modified": False,
}
for key, value in expected.items():
    if safety.get(key) != value:
        raise SystemExit(f"ERROR: Safety summary failed for {key}: {safety.get(key)!r}")
print("  Safety summary:          PASS")
print("  Catalog hash validation: PASS")
PY

echo
echo "Catalog preparation completed without merging or deploying anything."
echo "Next: review the ambiguity CSV and perform the authenticated browser smoke test before merging PR #7."
