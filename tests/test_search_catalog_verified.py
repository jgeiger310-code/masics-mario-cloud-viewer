from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = REPO_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from build_search_catalog_verified import (  # noqa: E402
    build_sidecar_maps_without_provenance,
    is_provenance_sidecar,
)
from search_catalog_lib import read_text  # noqa: E402


class VerifiedCatalogBuilderTests(unittest.TestCase):
    def test_source_files_are_provenance_not_transcript_content(self) -> None:
        self.assertTrue(is_provenance_sidecar(Path("call.source.txt")))
        self.assertTrue(is_provenance_sidecar(Path("CALL.SOURCE.TXT")))
        self.assertFalse(is_provenance_sidecar(Path("call.txt")))

    def test_provenance_candidates_are_removed_from_exact_and_stem_maps(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            folder = Path(temp_dir)
            (folder / "call.txt").write_text("Actual spoken transcript", encoding="utf-8")
            (folder / "call.source.txt").write_text("Source: original voicemail", encoding="utf-8")
            (folder / "only_provenance.source.txt").write_text("Source metadata only", encoding="utf-8")

            by_exact, by_stem = build_sidecar_maps_without_provenance(folder)
            all_candidates = {
                candidate.path.name
                for mapping in (by_exact, by_stem)
                for candidates in mapping.values()
                for candidate in candidates
            }

            self.assertIn("call.txt", all_candidates)
            self.assertNotIn("call.source.txt", all_candidates)
            self.assertNotIn("only_provenance.source.txt", all_candidates)
            self.assertTrue(all(not name.lower().endswith(".source.txt") for name in all_candidates))

    def test_sidecar_text_reads_are_cached(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "repeat.txt"
            path.write_text("cached sidecar text", encoding="utf-8")

            read_text.cache_clear()
            before = read_text.cache_info()
            self.assertEqual(read_text(path, 100), ("cached sidecar text", False))
            self.assertEqual(read_text(path, 100), ("cached sidecar text", False))
            after = read_text.cache_info()

            self.assertEqual(after.misses - before.misses, 1)
            self.assertEqual(after.hits - before.hits, 1)


if __name__ == "__main__":
    unittest.main()
