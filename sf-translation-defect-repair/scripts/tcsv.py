# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Read and write translation CSVs (one file per language).

The repair scripts read and write the same simple per-language CSV layout, one row per
translatable slot:

  file         target metadata path, e.g. objectTranslations/Widget__c-de/Color__c.fieldTranslation-meta.xml
  type         field-label | field-picklist | standard-field | object-label | record-type |
               validation-rule | layout-section | custom-label | global-value | standard-value
  component    object or value set name (Widget__c, Sizes)
  field        field API name, or the record type / rule / label name; '' for value sets
  masterLabel  picklist / value set key (the value's label in the org); '' otherwise
  source       English (source language) text
  translation  translated text
  ...          any extra columns (gender, startsWith, ...) are carried through unchanged

Files are named translations_<lang>.csv. The language comes from the file name, or else
from the `file` column.
"""
from __future__ import annotations

import csv
import re
from pathlib import Path

KEY_COLS = ("type", "component", "field", "masterLabel")

_LANG_FROM_FILE_RE = re.compile(
    r"objectTranslations/[^/]+-([a-z]{2,3}(?:_[A-Z]{2})?)/|"
    r"(?:global|standard)ValueSetTranslations/[^/]+-([a-z]{2,3}(?:_[A-Z]{2})?)\.|"
    r"translations/([a-z]{2,3}(?:_[A-Z]{2})?)\.translation"
)
_LANG_FROM_NAME_RE = re.compile(r"^translations_([A-Za-z]{2,3}(?:_[A-Za-z]{2})?)\.csv$")


def lang_from_file_col(file_col: str) -> str | None:
    m = _LANG_FROM_FILE_RE.search((file_col or "").replace("\\", "/"))
    return next((g for g in m.groups() if g), None) if m else None


def csv_language(path: Path, rows: list[dict]) -> str | None:
    m = _LANG_FROM_NAME_RE.match(path.name)
    if m:
        return m.group(1)
    for r in rows:
        lang = lang_from_file_col(r.get("file", ""))
        if lang:
            return lang
    return None


def read_csv(path: Path) -> tuple[list[str], list[dict]]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        rd = csv.DictReader(f)
        return list(rd.fieldnames or []), list(rd)


def write_csv(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def load_dir(csv_dir: Path) -> dict[str, tuple[Path, list[str], list[dict]]]:
    """{lang: (path, fieldnames, rows)} for every translation CSV in csv_dir."""
    out: dict[str, tuple[Path, list[str], list[dict]]] = {}
    for p in sorted(Path(csv_dir).glob("*.csv")):
        hdr, rows = read_csv(p)
        lang = csv_language(p, rows)
        if lang:
            out[lang] = (p, hdr, rows)
    return out


def slot_key(r: dict) -> tuple[str, str, str, str]:
    return tuple(r.get(c, "") or "" for c in KEY_COLS)  # type: ignore[return-value]


def prepare_out_dir(out: Path, force: bool) -> None:
    """Create an empty output folder. Refuse to mix a new payload into an old one."""
    if out.exists() and any(out.iterdir()):
        if not force:
            raise SystemExit(f"error: {out} is not empty. Choose a new folder or pass --force "
                             "to replace its CSVs.")
        for p in out.glob("*.csv"):
            p.unlink()
    out.mkdir(parents=True, exist_ok=True)
