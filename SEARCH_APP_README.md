# MASICS Evidence Search

This adds a separate, read-only search page to the Mario review viewer. It does not replace or rewrite the review workflow.

## What the search page does

- Searches filenames, paths, review IDs, MFR IDs, Mario notes, AI descriptions, OCR, and transcripts.
- Supports exact phrases, exclusions, field-specific search, related legal terms, and conservative typo correction.
- Filters by review decision, file type, folder, queue range, OCR availability, and transcript availability.
- Previews common evidence types directly from Dropbox after sign-in.
- Opens a result in the existing Mario review viewer.
- Exports all search results or selected results to CSV.
- Saves search definitions in the browser without modifying the case database.

## Build the full OCR and transcript catalog

Run this on the Mac where the Dropbox case folders are synced:

```bash
python3 scripts/build_search_catalog.py
```

The script auto-detects the normal Dropbox-Jake path. If needed:

```bash
python3 scripts/build_search_catalog.py \
  --dropbox-root "/Users/jakegeiger/Library/CloudStorage/Dropbox-Jake/jake Geiger"
```

It writes derived files to:

`MARIO - OPEN THIS - MASICS REVIEW TOOL/MASICS Review System Files/MASICS_MARIO_CLOUD_VIEWER/SEARCH_INDEX/`

The web app prefers `MASICS_SEARCH_CATALOG_LATEST.json.gz`, falls back to the uncompressed JSON, and finally falls back to the existing metadata CSV if the full catalog has not been built.

## Safety behavior

- The search page and catalog are read-only.
- The builder requires the source database and canonical manifest record counts to agree.
- It refuses duplicate or missing review IDs.
- It does not edit evidence, notes, decisions, progress, OCR, or transcripts.
- When multiple sidecars could belong to the same filename, it fails closed unless queue or context evidence safely identifies the correct sidecar.
- Ambiguities are written to `MASICS_SEARCH_AMBIGUITIES_LATEST.csv`.
- Dates extracted from text are search aids only and are not represented as authoritative legal dates.
- The viewer can fall back to the metadata catalog if the full OCR/transcript catalog is temporarily unavailable.

## Validation

```bash
node tests/search-core.test.js
python3 -m py_compile scripts/search_catalog_lib.py scripts/build_search_catalog.py
node --check assets/search-core.js
node --check assets/search-worker.js
node --check assets/search-data.js
node --check assets/search-ui.js
node --check assets/search-app.js
```
