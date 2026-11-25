# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Read Salesforce Translation Workbench .stf exports.

Two export types matter here:

  Source_<lang>_<date>.stf     every translatable key with its source text:
                               KEY <tab> LABEL
  Bilingual_<lang>_<date>.stf  per language, in two sections:
                               ------TRANSLATED------
                               KEY <tab> LABEL <tab> TRANSLATION <tab> OUT OF DATE
                               ------OUTDATED AND UNTRANSLATED------
                               KEY <tab> LABEL ...

Lines starting with '#' are comments. Tabs, newlines and carriage returns inside values are
written as the two-character escapes \\t, \\n and \\r; unescape() turns them back.

Key shapes (note that a custom field's '__c' suffix is stripped):
  CustomField.<Object>.<Field>.FieldLabel | .HelpText | .RelatedListLabel
  PicklistValue.<Object>.<Field>.<MasterLabel>
  PicklistValue.<ValueSet>__gvs.<MasterLabel>          (global value set)
  PicklistValue.Standard.<valueSet>.<MasterLabel>      (standard value set)
  RecordType.<Object>.<DeveloperName>
  ValidationFormula.<Object>.<RuleName>
  LayoutSection.<Object>.<Layout>.<Section>
  ButtonOrLink.<Object>.<Name>
  CustomLabel.<Name>   CustomApp.<Name>   WebTab.<Name>
"""
from __future__ import annotations

import re
from pathlib import Path

_NAME_RE = re.compile(r"^(Bilingual|Source|Untranslated|Outdated)_(.+?)_\d{4}-\d{2}-\d{2}")
_ESC = {"\\n": "\n", "\\t": "\t", "\\r": "\r", "\\\\": "\\"}


def unescape(s: str) -> str:
    """Turn the .stf escapes \\n, \\t, \\r (and \\\\) back into the real characters."""
    return re.sub(r"\\[ntr\\]", lambda m: _ESC[m.group(0)], s or "")


def stf_language(path: Path | str) -> str | None:
    """Language code from a file name like 'Bilingual_de_2026-01-31 0915.stf'."""
    m = _NAME_RE.match(Path(path).name)
    return m.group(2) if m else None


def read_stf(path: Path | str) -> dict[str, list[tuple[str, str, str]]]:
    """{section: [(key, label, translation), ...]} with values unescaped.

    A Source export has no section header; its rows go under "SOURCE". Lines that are not
    data rows (comments, headers, 'Language code: xx') are skipped.
    """
    text = Path(path).read_bytes().decode("utf-8-sig", "replace")
    out: dict[str, list[tuple[str, str, str]]] = {}
    section = "SOURCE"
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        if line.startswith("-") and line.strip("- ").strip():
            section = line.strip("- ").strip().upper()
            continue
        if "\t" not in line:
            continue
        parts = line.split("\t")
        key = parts[0]
        if "." not in key:
            continue
        label = unescape(parts[1]) if len(parts) > 1 else ""
        trans = unescape(parts[2]) if len(parts) > 2 else ""
        out.setdefault(section, []).append((key, label, trans))
    return out


def translated(path: Path | str) -> dict[str, tuple[str, str]]:
    """{key: (source label, translation)} for rows that HAVE a translation."""
    rows = read_stf(path).get("TRANSLATED", [])
    return {k: (lab, tr) for k, lab, tr in rows if tr.strip()}


def source_keys(path: Path | str) -> dict[str, str]:
    """{key: source label} from a Source export (or every key of any export)."""
    out: dict[str, str] = {}
    for rows in read_stf(path).values():
        for k, lab, _tr in rows:
            out.setdefault(k, lab)
    return out


def find_bilingual(stf_dir: Path | str) -> dict[str, Path]:
    """{language: newest Bilingual_<lang>_*.stf} under stf_dir (searched recursively)."""
    found: dict[str, Path] = {}
    for p in sorted(Path(stf_dir).rglob("Bilingual_*.stf")):
        lang = stf_language(p)
        if lang:
            found[lang] = p          # sorted, so the newest date wins
    return found
