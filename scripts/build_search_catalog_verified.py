#!/usr/bin/env python3
"""Run the MASICS catalog builder while excluding transcript provenance sidecars.

The canonical transcript directory contains both transcript text files and
``*.source.txt`` provenance files that describe where a transcript came from.
Provenance text is useful for auditing, but it is not transcript content and must
not be indexed or selected as the best transcript for an evidence record.

This wrapper leaves every source file untouched. It filters only the in-memory
sidecar maps supplied to the existing read-only catalog builder.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

import build_search_catalog as builder
import search_catalog_lib

PROVENANCE_SUFFIXES = (".source.txt",)


def is_provenance_sidecar(path: Path) -> bool:
    """Return True for transcript provenance files, not transcript content."""
    return path.name.lower().endswith(PROVENANCE_SUFFIXES)


def build_sidecar_maps_without_provenance(folder: Path):
    """Build normal sidecar maps and remove provenance-only candidates."""
    by_exact, by_stem = search_catalog_lib.build_sidecar_maps(folder)
    skipped_paths: set[Path] = set()

    for mapping in (by_exact, by_stem):
        for key, candidates in list(mapping.items()):
            kept = []
            for candidate in candidates:
                if is_provenance_sidecar(candidate.path):
                    skipped_paths.add(candidate.path)
                else:
                    kept.append(candidate)
            if kept:
                mapping[key] = kept
            else:
                del mapping[key]

    if skipped_paths:
        print(
            f"Excluded {len(skipped_paths):,} provenance-only .source.txt file(s) "
            f"from searchable transcript content in {folder}."
        )
    return by_exact, by_stem


def main(argv: Optional[list[str]] = None) -> int:
    # build_search_catalog imported build_sidecar_maps into its own module
    # namespace, so patch that reference for this one process only.
    builder.build_sidecar_maps = build_sidecar_maps_without_provenance
    return builder.main(argv)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Cancelled.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
