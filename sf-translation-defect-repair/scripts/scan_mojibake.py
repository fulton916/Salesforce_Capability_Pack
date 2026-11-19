#!/usr/bin/env python3
"""Scan translation data for mojibake (UTF-8 read as cp1252) and propose exact repairs.

A deploy never reports most of this damage:

  corrupted KEY    (a picklist masterLabel) - the key matches nothing, so the row FAILS to
                   deploy. It does show in the deploy log, as "Invalid picklist value".
  corrupted VALUE  (a translation) - the key is fine, so the row DEPLOYS and the damaged
                   text goes live. Nothing errors, so no log reports it. Only a scan of
                   what is in the org finds it.

Global value set translations are NOT in the Translation Workbench .stf export. A scan of
.stf files alone misses them. Scan the org pull (translation CSVs) or a retrieve as well.

Sources (give any mix):
  --stf-dir DIR   Bilingual_<lang>_*.stf: translated values. Source_*.stf: keys and labels.
  --csv-dir DIR   translation CSVs (translations_<lang>.csv), e.g. a fresh org pull or a
                  load file: masterLabel (key), source and translation columns.
  --xml-dir DIR   retrieved metadata: every leaf value.

Output: a CSV report (and .xlsx if the name ends in .xlsx) with one row per finding:
status (repairable / damaged), the text, and the repair when one is exact.

Usage:
  python scan_mojibake.py --csv-dir pull/ --stf-dir exports/ --out mojibake_report.csv
Exit 2 if anything was found, 0 if clean.
"""
from __future__ import annotations

import argparse
import csv
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import crsafe  # noqa: E402
import mojibake  # noqa: E402
import stf  # noqa: E402
import tcsv  # noqa: E402

HEADERS = ["Origin", "File", "Language", "Kind", "Key", "Reference (English)",
           "Text", "Status", "Suggested repair", "Effect"]

EFFECT = {
    "key": "Row cannot deploy - the key matches nothing in the org",
    "value": "Damaged text is (or will be) live - no deploy error reports it",
    "source": "English source text is damaged - fix at the origin of the export",
}


def _finding(origin, path, lang, kind, key, ref, text, euro):
    f = mojibake.inspect(text, ref if mojibake.is_clean(ref, euro) else
                         mojibake.repair(ref, euro_is_suspect=euro), euro)
    if f.status == "clean":
        return None
    return [origin, str(path), lang, kind, key, ref, text, f.status, f.repaired, EFFECT[kind]]


def scan_stf(stf_dir: Path, euro: bool) -> list[list]:
    out = []
    for p in sorted(stf_dir.rglob("*.stf")):
        lang = stf.stf_language(p) or ""
        for section, rows in stf.read_stf(p).items():
            for key, label, trans in rows:
                if p.name.startswith("Source_") or section == "SOURCE":
                    for kind, text in (("key", key), ("source", label)):
                        r = _finding("stf", p.name, lang, kind, key, "", text, euro)
                        if r:
                            out.append(r)
                    continue
                if section == "TRANSLATED" and trans.strip():
                    r = _finding("stf", p.name, lang, "value", key, label, trans, euro)
                    if r:
                        out.append(r)
    return out


def scan_csv(csv_dir: Path, euro: bool) -> list[list]:
    out = []
    for lang, (path, _hdr, rows) in tcsv.load_dir(csv_dir).items():
        for row in rows:
            key = ".".join(x for x in tcsv.slot_key(row) if x)
            src, ml, tr = row.get("source", ""), row.get("masterLabel", ""), row.get("translation", "")
            for kind, text, ref in (("key", ml, ""), ("source", src, ""),
                                    ("value", tr, ml or src)):
                if text and text.strip():
                    r = _finding("csv", path.name, lang, kind, key, ref, text, euro)
                    if r:
                        out.append(r)
    return out


_ID_TAGS = ("name", "masterLabel", "fullName", "layout", "section", "label")


def _q(tag: str) -> str:
    return tag.split("}", 1)[-1]


def scan_xml(xml_dir: Path, euro: bool) -> list[list]:
    out = []
    for p in sorted(f for f in xml_dir.rglob("*") if f.is_file()):
        if not (p.name.endswith(".xml") or p.name.endswith("Translation")
                or p.name.endswith(".translation")):
            continue
        try:
            root = crsafe.parse(p).getroot()
        except ValueError:
            root = ET.parse(p).getroot()       # scanning only; CRs do not matter here
        except ET.ParseError:
            continue
        lang = tcsv.lang_from_file_col(p.as_posix() + "/") or ""
        if not lang:
            stem = p.name.split(".")[0]
            lang = stem.rsplit("-", 1)[1] if "-" in stem else stem

        def walk(el, trail):
            kids = list(el)
            ident = next((el.findtext(c.tag) for c in kids if _q(c.tag) in _ID_TAGS
                          and len(c) == 0 and _q(c.tag) != "label"), None)
            here = f"{trail}/{_q(el.tag)}" + (f"[{ident}]" if ident else "")
            for c in kids:
                if len(c):
                    walk(c, here)
                    continue
                text = c.text or ""
                if not text.strip():
                    continue
                tag = _q(c.tag)
                kind = "key" if tag in ("masterLabel", "name", "fullName") else "value"
                ref = el.findtext(f"{{{crsafe.NS}}}masterLabel") or "" if kind == "value" else ""
                r = _finding("xml", p.relative_to(xml_dir), lang, kind, f"{here}/{tag}",
                             ref, text, euro)
                if r:
                    out.append(r)

        walk(root, "")
    return out


def write_report(rows: list[list], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.suffix.lower() == ".xlsx":
        import openpyxl
        from openpyxl.styles import Font, PatternFill
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Mojibake"
        ws.append(HEADERS)
        for c in ws[1]:
            c.fill, c.font = PatternFill("solid", fgColor="1F3864"), Font(color="FFFFFF", bold=True)
        for r in rows:
            ws.append(r)
        for col, w in zip("ABCDEFGHIJ", (8, 30, 9, 8, 50, 30, 34, 11, 34, 50)):
            ws.column_dimensions[col].width = w
        ws.freeze_panes = "A2"
        wb.save(out)
        return
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(HEADERS)
        w.writerows(rows)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stf-dir", type=Path)
    ap.add_argument("--csv-dir", type=Path)
    ap.add_argument("--xml-dir", type=Path)
    ap.add_argument("--out", type=Path, default=Path("mojibake_report.csv"))
    ap.add_argument("--euro-is-suspect", action="store_true",
                    help="treat every euro sign as damage (only for data with no real ones)")
    for _s in (sys.stdout, sys.stderr):
        if hasattr(_s, "reconfigure"):
            _s.reconfigure(encoding="utf-8", errors="replace")
    a = ap.parse_args(argv)
    if not (a.stf_dir or a.csv_dir or a.xml_dir):
        ap.error("give at least one of --stf-dir, --csv-dir, --xml-dir")
    if a.stf_dir and not (a.csv_dir or a.xml_dir):
        print("NOTE: global value set translations are not in .stf exports. Scan the org "
              "pull (--csv-dir) or a retrieve (--xml-dir) too, or they are missed.")

    rows: list[list] = []
    if a.stf_dir:
        rows += scan_stf(a.stf_dir, a.euro_is_suspect)
    if a.csv_dir:
        rows += scan_csv(a.csv_dir, a.euro_is_suspect)
    if a.xml_dir:
        rows += scan_xml(a.xml_dir, a.euro_is_suspect)

    write_report(rows, a.out)
    by = {}
    for r in rows:
        by.setdefault((r[3], r[7]), 0)
        by[(r[3], r[7])] += 1
    print(f"findings: {len(rows)}")
    for (kind, status), n in sorted(by.items()):
        print(f"   {kind:7} {status:11} {n}")
    fixed = sum(1 for r in rows if r[8])
    print(f"exact repair available for {fixed} of {len(rows)}")
    print(f"report: {a.out}")
    return 2 if rows else 0


if __name__ == "__main__":
    sys.exit(main())
