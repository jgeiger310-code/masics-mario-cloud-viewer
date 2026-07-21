#!/usr/bin/env python3
"""Build the MASICS read-only OCR/transcript search catalog."""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import sys
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Optional

from search_catalog_lib import (
    SCHEMA, DEFAULT_OCR_LIMIT, DEFAULT_TRANSCRIPT_LIMIT, atomic_write_bytes,
    atomic_write_text, bool_value, build_sidecar_maps, choose_sidecar,
    extract_dates_and_years, file_type, load_csv, load_json, locate_dropbox_root,
    newest_file, now_iso, relative_or_absolute, sha256_bytes, source_stem,
    split_notes,
)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dropbox-root", help="Folder containing Mario_Viewer_Exports and the Mario review-tool folder")
    parser.add_argument("--source-csv", help="Existing SEARCHABLE_FILE_INDEX CSV. Defaults to the newest matching file.")
    parser.add_argument("--manifest", help="Current MASICS_MARIO_QUEUE_MANIFEST_V1.json")
    parser.add_argument("--progress", help="Current MASICS_MARIO_REVIEW_PROGRESS_LATEST.json")
    parser.add_argument("--ocr-dir", help="OCR sidecar directory")
    parser.add_argument("--transcript-dir", help="Canonical transcript directory")
    parser.add_argument("--output-dir", help="Search index output directory")
    parser.add_argument("--ocr-limit", type=int, default=DEFAULT_OCR_LIMIT, help="Maximum OCR characters per record")
    parser.add_argument("--transcript-limit", type=int, default=DEFAULT_TRANSCRIPT_LIMIT, help="Maximum transcript characters per record")
    parser.add_argument("--gzip-only", action="store_true", help="Write the compressed catalog but not the uncompressed JSON")
    args = parser.parse_args(argv)

    root = locate_dropbox_root(args.dropbox_root)
    exports = root / "Mario_Viewer_Exports"
    cleanup = exports / "Solid_AI_And_Sidecar_Cleanup"
    viewer = root / "MARIO - OPEN THIS - MASICS REVIEW TOOL/MASICS Review System Files/MASICS_MARIO_CLOUD_VIEWER"

    source_csv = Path(args.source_csv).expanduser() if args.source_csv else newest_file(cleanup, "SEARCHABLE_FILE_INDEX_*.csv")
    manifest_path = Path(args.manifest).expanduser() if args.manifest else viewer / "MASICS_MARIO_QUEUE_MANIFEST_V1.json"
    progress_path = Path(args.progress).expanduser() if args.progress else viewer / "MASICS_MARIO_REVIEW_PROGRESS_LATEST.json"
    ocr_dir = Path(args.ocr_dir).expanduser() if args.ocr_dir else exports / "Mario_FULL_Viewer_OCR_AI_Description_Output_20260720/ocr_text_by_record"
    transcript_dir = Path(args.transcript_dir).expanduser() if args.transcript_dir else cleanup / "CANONICAL_TRANSCRIPTS_BY_STEM"
    output_dir = Path(args.output_dir).expanduser() if args.output_dir else viewer / "SEARCH_INDEX"

    print(f"Dropbox case root: {root}")
    print(f"Source database:   {source_csv}")
    print(f"Manifest:          {manifest_path}")
    print(f"Progress:          {progress_path}")
    print(f"OCR sidecars:      {ocr_dir}")
    print(f"Transcripts:       {transcript_dir}")
    print(f"Output:            {output_dir}")

    rows = load_csv(source_csv)
    manifest = load_json(manifest_path)
    progress = load_json(progress_path, required=False)
    manifest_records = manifest.get("records") or []
    manifest_by_id = {str(record.get("review_id")): record for record in manifest_records if record.get("review_id")}
    decisions = progress.get("decisions") or {}

    if not rows:
        raise RuntimeError("The source CSV contains no records.")
    source_ids = [str(row.get("review_id") or "") for row in rows]
    if any(not value for value in source_ids):
        raise RuntimeError("At least one source row has no review_id.")
    if len(set(source_ids)) != len(source_ids):
        raise RuntimeError("The source CSV contains duplicate review_id values.")
    if manifest_records and len(rows) != len(manifest_records):
        raise RuntimeError(
            f"Record-count mismatch: source CSV has {len(rows):,}; manifest has {len(manifest_records):,}. "
            "Do not build the index until the canonical inputs agree."
        )

    print("Indexing sidecar filenames once (this does not open or alter evidence files)...")
    ocr_exact, ocr_stem = build_sidecar_maps(ocr_dir)
    transcript_exact, transcript_stem = build_sidecar_maps(transcript_dir)

    catalog_records = []
    ambiguities = []
    counters = Counter()
    built_at = now_iso()

    for index, row in enumerate(rows, start=1):
        review_id = str(row.get("review_id") or "")
        base = manifest_by_id.get(review_id, {})
        current = decisions.get(review_id) or {}
        current_mario, current_ai = split_notes(current.get("notes") or "")
        filename = str(base.get("filename") or row.get("filename") or f"Record {index}")
        queue_number = int(base.get("queue_number") or row.get("queue_number") or index)
        mario_notes = current_mario or str(row.get("mario_notes") or "")
        ai_note = current_ai or str(row.get("ai_note") or "")
        decision = str(current.get("decision") or row.get("decision") or "").strip().lower()
        context = "\n".join([filename, mario_notes, ai_note, str(row.get("dropbox_path") or "")])

        expected_ocr = filename.lower() + ".txt"
        ocr_candidates = list(ocr_exact.get(expected_ocr, []))
        if not ocr_candidates:
            ocr_candidates = list(ocr_stem.get(source_stem(filename), []))
        ocr_sidecar, ocr_text, ocr_truncated, ocr_ambiguity = choose_sidecar(ocr_candidates, queue_number, context, args.ocr_limit)

        canonical_name = str(row.get("canonical_transcript") or "").strip().lower()
        transcript_candidates = list(transcript_exact.get(canonical_name, [])) if canonical_name else []
        if not transcript_candidates:
            transcript_candidates = list(transcript_stem.get(source_stem(filename), []))
        transcript_sidecar, transcript_text, transcript_truncated, transcript_ambiguity = choose_sidecar(
            transcript_candidates, queue_number, context, args.transcript_limit
        )

        if ocr_ambiguity and (not ocr_sidecar or len(ocr_candidates) > 1):
            ambiguities.append({
                "review_id": review_id, "queue_number": queue_number, "filename": filename, "sidecar_type": "ocr",
                "selected": relative_or_absolute(ocr_sidecar.path, root) if ocr_sidecar else "",
                "candidates": json.dumps(ocr_ambiguity, ensure_ascii=False),
            })
        if transcript_ambiguity and (not transcript_sidecar or len(transcript_candidates) > 1):
            ambiguities.append({
                "review_id": review_id, "queue_number": queue_number, "filename": filename, "sidecar_type": "transcript",
                "selected": relative_or_absolute(transcript_sidecar.path, root) if transcript_sidecar else "",
                "candidates": json.dumps(transcript_ambiguity, ensure_ascii=False),
            })

        dates, years = extract_dates_and_years(filename, mario_notes, ai_note, ocr_text, transcript_text)
        display = base.get("display") or {}
        record = {
            "queue_number": queue_number, "review_id": review_id, "filename": filename,
            "file_type": file_type(filename, row.get("file_type") or base.get("file_type") or base.get("extension")),
            "decision": decision, "dropbox_path": str(base.get("dropbox_path") or row.get("dropbox_path") or ""),
            "dropbox_path_alternates": base.get("dropbox_path_alternates") or [], "dropbox_file_id": str(base.get("dropbox_file_id") or ""),
            "mfr_request_ids": display.get("mfr_request_ids") or row.get("mfr_request_ids") or "",
            "match_reason": display.get("match_reason") or row.get("match_reason") or "",
            "mario_notes": mario_notes, "ai_note": ai_note,
            "has_ocr_sidecar": bool(ocr_sidecar) or bool_value(row.get("has_ocr_sidecar")),
            "has_transcript_sidecar": bool(transcript_sidecar) or bool_value(row.get("has_transcript_sidecar")),
            "ocr_text": ocr_text, "transcript_text": transcript_text,
            "ocr_sidecar_path": relative_or_absolute(ocr_sidecar.path, root) if ocr_sidecar else "",
            "transcript_sidecar_path": relative_or_absolute(transcript_sidecar.path, root) if transcript_sidecar else "",
            "ocr_text_truncated": ocr_truncated, "transcript_text_truncated": transcript_truncated,
            "dates_extracted": dates, "years": years,
        }
        catalog_records.append(record)
        counters["records"] += 1
        counters["ocr_indexed"] += bool(ocr_text)
        counters["transcripts_indexed"] += bool(transcript_text)
        counters["ocr_sidecar_flag_without_text"] += bool(record["has_ocr_sidecar"] and not ocr_text)
        counters["transcript_sidecar_flag_without_text"] += bool(record["has_transcript_sidecar"] and not transcript_text)
        counters["ocr_truncated"] += ocr_truncated
        counters["transcript_truncated"] += transcript_truncated
        if index % 500 == 0 or index == len(rows):
            print(f"  Prepared {index:,}/{len(rows):,} records")

    catalog_records.sort(key=lambda item: (int(item["queue_number"]), item["review_id"]))
    catalog = {
        "schema": SCHEMA, "built_at": built_at,
        "queue_identity": manifest.get("queue_identity") or progress.get("queueIdentity") or "",
        "queue_version": manifest.get("schema") or progress.get("queueVersion") or "",
        "record_count": len(catalog_records),
        "source_files": {
            "database_csv": relative_or_absolute(source_csv, root), "manifest": relative_or_absolute(manifest_path, root),
            "progress": relative_or_absolute(progress_path, root) if progress_path.exists() else "",
            "ocr_directory": relative_or_absolute(ocr_dir, root), "transcript_directory": relative_or_absolute(transcript_dir, root),
        },
        "integrity_notes": [
            "This is a derived read-only search catalog. Original evidence files were not changed.",
            "Ambiguous sidecars are excluded unless a queue match or meaningful context match identifies one safely.",
            "Extracted dates and years are search aids, not authoritative legal date findings.",
        ],
        "records": catalog_records,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    compact = json.dumps(catalog, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    summary_path = output_dir / "MASICS_SEARCH_BUILD_SUMMARY_LATEST.json"
    gzip_path = output_dir / "MASICS_SEARCH_CATALOG_LATEST.json.gz"
    json_path = output_dir / "MASICS_SEARCH_CATALOG_LATEST.json"
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    snapshot_path = output_dir / f"MASICS_SEARCH_CATALOG_{stamp}.json.gz"
    gzip_bytes = gzip.compress(compact, compresslevel=9, mtime=0)
    atomic_write_bytes(gzip_path, gzip_bytes)
    atomic_write_bytes(snapshot_path, gzip_bytes)
    if not args.gzip_only:
        atomic_write_bytes(json_path, compact)

    ambiguity_path = output_dir / "MASICS_SEARCH_AMBIGUITIES_LATEST.csv"
    columns = ["review_id", "queue_number", "filename", "sidecar_type", "selected", "candidates"]
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="", dir=output_dir, prefix=ambiguity_path.name + ".", suffix=".tmp", delete=False) as handle:
        writer = csv.DictWriter(handle, fieldnames=columns); writer.writeheader(); writer.writerows(ambiguities); temp_path = Path(handle.name)
    temp_path.replace(ambiguity_path)

    summary = {
        "schema": "MASICS_SEARCH_BUILD_SUMMARY_V1", "built_at": built_at, "record_count": len(catalog_records),
        "ocr_text_records": counters["ocr_indexed"], "transcript_text_records": counters["transcripts_indexed"],
        "ocr_sidecar_flag_without_indexed_text": counters["ocr_sidecar_flag_without_text"],
        "transcript_sidecar_flag_without_indexed_text": counters["transcript_sidecar_flag_without_text"],
        "ocr_records_truncated": counters["ocr_truncated"], "transcript_records_truncated": counters["transcript_truncated"],
        "ambiguous_sidecar_rows": len(ambiguities), "catalog_json_bytes": len(compact), "catalog_gzip_bytes": len(gzip_bytes),
        "catalog_sha256": sha256_bytes(compact), "gzip_sha256": sha256_bytes(gzip_bytes),
        "outputs": { "latest_gzip": str(gzip_path), "latest_json": str(json_path) if not args.gzip_only else "", "snapshot_gzip": str(snapshot_path), "ambiguities": str(ambiguity_path) },
        "safety": { "evidence_files_modified": 0, "mario_notes_modified": 0, "decisions_modified": 0, "progress_file_modified": False },
    }
    atomic_write_text(summary_path, json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print("\nSearch catalog built successfully.")
    print(f"  Records:               {len(catalog_records):,}")
    print(f"  OCR text indexed:      {counters['ocr_indexed']:,}")
    print(f"  Transcripts indexed:   {counters['transcripts_indexed']:,}")
    print(f"  Ambiguity report rows: {len(ambiguities):,}")
    print(f"  Compressed size:       {len(gzip_bytes) / (1024 * 1024):.2f} MiB")
    print(f"  Latest catalog:        {gzip_path}")
    print(f"  Summary:               {summary_path}")
    print("No original evidence, Mario note, decision, or live progress record was changed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Cancelled.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
