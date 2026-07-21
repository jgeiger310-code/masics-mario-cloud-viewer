"""Build a read-only MASICS full-text search catalog from the Mario viewer database.

The script never edits original evidence, Mario's notes, decisions, OCR sidecars,
or transcripts. It produces new derived catalog files in the viewer SEARCH_INDEX
folder so the static web search interface can load them after Dropbox sign-in.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

SCHEMA = "MASICS_SEARCH_CATALOG_V1"
DEFAULT_OCR_LIMIT = 120_000
DEFAULT_TRANSCRIPT_LIMIT = 350_000
TOKEN_RE = re.compile(r"[a-z0-9]{2,}", re.IGNORECASE)
YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
DATE_RE = re.compile(
    r"\b(?:"
    r"(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:19|20)?\d{2}"
    r"|(?:19|20)\d{2}-[01]\d-[0-3]\d"
    r"|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+[0-3]?\d,?\s+(?:19|20)\d{2}"
    r")\b",
    re.IGNORECASE,
)
STOPWORDS = {
    "the", "and", "for", "that", "this", "with", "from", "was", "were", "are", "has", "have",
    "had", "not", "but", "you", "your", "their", "they", "them", "his", "her", "its", "our", "ours",
    "about", "record", "file", "document", "concerning", "related", "relevant", "viewer", "preview",
}


@dataclass(frozen=True)
class Sidecar:
    path: Path
    stripped_name: str
    queue_prefix: Optional[int]
    size: int


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_name(value: str) -> str:
    text = str(value or "").strip().lower().replace("\\", "/").split("/")[-1]
    return re.sub(r"[^a-z0-9]+", "", text)


def source_stem(filename: str) -> str:
    name = Path(str(filename or "")).name
    while True:
        stem = Path(name).stem
        if stem == name:
            return normalize_name(stem)
        name = stem


def strip_queue_prefix(name: str) -> tuple[str, Optional[int]]:
    match = re.match(r"^(\d{5})_(.+)$", name)
    if not match:
        return name.lower(), None
    return match.group(2).lower(), int(match.group(1))


def tokenize(value: str) -> set[str]:
    return {token.lower() for token in TOKEN_RE.findall(str(value or "")) if token.lower() not in STOPWORDS}


def overlap_score(context: str, candidate_text: str) -> float:
    left = tokenize(context)
    right = tokenize(candidate_text[:25_000])
    if not left or not right:
        return 0.0
    return len(left & right) / max(1, len(left))


def clean_text(value: str, limit: int) -> tuple[str, bool]:
    text = str(value or "").replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{4,}", "\n\n\n", text).strip()
    truncated = len(text) > limit
    return text[:limit], truncated


def read_text(path: Path, limit: int) -> tuple[str, bool]:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "utf-16", "latin-1"):
        try:
            return clean_text(raw.decode(encoding), limit)
        except UnicodeDecodeError:
            continue
    return clean_text(raw.decode("utf-8", errors="replace"), limit)


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False) as tmp:
        tmp.write(data)
        tmp.flush()
        os.fsync(tmp.fileno())
        temp_path = Path(tmp.name)
    temp_path.replace(path)


def atomic_write_text(path: Path, text: str) -> None:
    atomic_write_bytes(path, text.encode("utf-8"))


def locate_dropbox_root(explicit: Optional[str]) -> Path:
    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    home = Path.home()
    candidates.extend([
        home / "Library/CloudStorage/Dropbox-Jake/jake Geiger",
        home / "Library/CloudStorage/Dropbox/jake Geiger",
        home / "Dropbox/jake Geiger",
        home / "Dropbox",
    ])
    for candidate in candidates:
        if candidate.exists() and candidate.is_dir():
            return candidate.resolve()
    raise FileNotFoundError("Could not locate the Dropbox case root. Use --dropbox-root with the folder that contains Mario_Viewer_Exports.")


def newest_file(folder: Path, pattern: str) -> Path:
    matches = [path for path in folder.glob(pattern) if path.is_file()]
    if not matches:
        raise FileNotFoundError(f"No files matched {pattern!r} in {folder}")
    return max(matches, key=lambda path: (path.stat().st_mtime_ns, path.name))


def load_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def load_json(path: Path, required: bool = True) -> dict:
    if not path.exists():
        if required:
            raise FileNotFoundError(path)
        return {}
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def split_notes(value: str) -> tuple[str, str]:
    text = str(value or "")
    match = re.search(r"(?:^|\n)\s*AI note:\s*", text, flags=re.IGNORECASE)
    if not match:
        return text.strip(), ""
    return text[: match.start()].strip(), text[match.end() :].strip()


def build_sidecar_maps(folder: Path) -> tuple[dict[str, list[Sidecar]], dict[str, list[Sidecar]]]:
    by_exact: dict[str, list[Sidecar]] = defaultdict(list)
    by_stem: dict[str, list[Sidecar]] = defaultdict(list)
    if not folder.exists():
        return by_exact, by_stem
    for path in folder.rglob("*.txt"):
        if not path.is_file():
            continue
        stripped, queue_prefix = strip_queue_prefix(path.name)
        sidecar = Sidecar(path=path, stripped_name=stripped, queue_prefix=queue_prefix, size=path.stat().st_size)
        by_exact[stripped].append(sidecar)
        by_stem[source_stem(stripped)].append(sidecar)
    return by_exact, by_stem


def choose_sidecar(candidates: list[Sidecar], queue_number: int, context: str, text_limit: int) -> tuple[Optional[Sidecar], str, bool, list[dict]]:
    if not candidates:
        return None, "", False, []
    exact_queue = [candidate for candidate in candidates if candidate.queue_prefix == queue_number]
    pool = exact_queue or candidates
    evaluated = []
    for candidate in pool:
        text, truncated = read_text(candidate.path, text_limit)
        evaluated.append((candidate, text, truncated, overlap_score(context, text)))
    if len(evaluated) == 1:
        candidate, text, truncated, _ = evaluated[0]
        return candidate, text, truncated, []
    evaluated.sort(key=lambda item: (item[3], len(item[1]), item[0].size), reverse=True)
    best, second = evaluated[0], evaluated[1]
    ambiguity = [{
        "path": str(item[0].path), "queue_prefix": item[0].queue_prefix,
        "characters": len(item[1]), "context_overlap": round(item[3], 4),
    } for item in evaluated[:10]]
    if exact_queue or (best[3] >= 0.08 and best[3] - second[3] >= 0.03):
        return best[0], best[1], best[2], ambiguity
    return None, "", False, ambiguity


def relative_or_absolute(path: Optional[Path], root: Path) -> str:
    if not path:
        return ""
    try:
        return "/" + str(path.resolve().relative_to(root.resolve())).replace(os.sep, "/")
    except ValueError:
        return str(path)


def extract_dates_and_years(*values: str) -> tuple[list[str], list[int]]:
    combined = "\n".join(str(value or "") for value in values)
    dates = []
    for match in DATE_RE.finditer(combined):
        value = re.sub(r"\s+", " ", match.group(0)).strip()
        if value not in dates:
            dates.append(value)
        if len(dates) >= 30:
            break
    years = sorted({int(value) for value in YEAR_RE.findall(combined)})
    return dates, years


def file_type(filename: str, explicit: str) -> str:
    value = str(explicit or "").strip().lower().lstrip(".")
    if value:
        return value
    return Path(filename).suffix.lower().lstrip(".") or "unknown"


def bool_value(value: object) -> bool:
    return value is True or str(value or "").strip().lower() in {"true", "1", "yes"}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
