#!/usr/bin/env python3
"""Re-key rows that failed only because the key text was slightly off.

Example: a value set whose org labels carry TRAILING SPACES. The live value is
'Extra Large ', not 'Extra Large'. A load that supplies the un-padded label is rejected
as "Invalid picklist value", which reads exactly like a deleted value and is not one.

This is a key fix only. The supplied translation is carried across byte for byte. The
key is taken from the org pull exactly as the org spells it, padding included, so if the
padding ever changes this follows it.

Matching is deliberately narrow. A failed key is re-keyed only when exactly one org key
in the same component (and field, when given) differs from it by WHITESPACE ALONE:
leading/trailing spaces, doubled spaces, or a non-breaking space. Anything else (a
number prefix, punctuation, a renamed value) is a real decision for a person and is
listed, not re-keyed.

Input: the failed rows, as a CSV or .xlsx with these columns (rename with --col-*):
  language     language code (de, fr, pt_BR ...)
  component    object or value set name. 'Name-<lang>' (a deploy fullName) also works.
  field        field API name; leave blank for global / standard value sets
  masterLabel  the key that was rejected
  translation  the translation that was supplied

Usage:
  python build_rekey_payload.py failures.csv <fresh_csv_dir> --out-dir rekey_payload
  python build_rekey_payload.py triage.xlsx pull/ --out-dir rekey --sheet "Value Not Found" \\
      --col-language Language --col-component "Salesforce Component" --col-field "Field / GVS" \\
      --col-key "Bad Value" --col-translation "Reviewer Translation" --component Sizes
Writes CSVs only. Nothing is deployed.
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tcsv  # noqa: E402


def ws_norm(s: str) -> str:
    """Whitespace-insensitive form: NBSP as space, runs collapsed, ends stripped."""
    return re.sub(r"\s+", " ", (s or "").replace(" ", " ")).strip()


def read_failures(path: Path, sheet: str | None, cols: dict[str, str]) -> list[dict]:
    if path.suffix.lower() in (".xlsx", ".xlsm"):
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        ws = wb[sheet] if sheet else wb[wb.sheetnames[0]]
        it = ws.iter_rows(values_only=True)
        hdr = [str(h or "") for h in next(it)]
        raw = [dict(zip(hdr, ["" if v is None else str(v) for v in r])) for r in it]
    else:
        with open(path, newline="", encoding="utf-8-sig") as f:
            raw = list(csv.DictReader(f))
    missing = [v for k, v in cols.items() if k != "field" and raw and v not in raw[0]]
    if missing:
        sys.exit(f"error: column(s) {missing} not found in {path}. Use --col-* to map them.")
    out = []
    for r in raw:
        lang = (r.get(cols["language"]) or "").strip()
        comp = (r.get(cols["component"]) or "").strip()
        if lang and comp.endswith(f"-{lang}"):
            comp = comp[: -len(lang) - 1]
        field = (r.get(cols["field"]) or "").strip()
        if "." in field:                    # 'Object.Field' -> 'Field'
            field = field.split(".", 1)[1]
        if field == comp:                   # a value set reported by its own name
            field = ""
        out.append({"language": lang, "component": comp, "field": field,
                    "key": r.get(cols["key"]) or "",
                    "translation": r.get(cols["translation"]) or ""})
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("failures", type=Path, help="failed rows (.csv or .xlsx)")
    ap.add_argument("fresh_dir", type=Path, help="fresh org pull: translations_<lang>.csv")
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--sheet", help="worksheet name when failures is an .xlsx")
    ap.add_argument("--component", action="append", default=[],
                    help="only re-key these components (repeatable). Default: any.")
    ap.add_argument("--col-language", default="language")
    ap.add_argument("--col-component", default="component")
    ap.add_argument("--col-field", default="field")
    ap.add_argument("--col-key", default="masterLabel")
    ap.add_argument("--col-translation", default="translation")
    ap.add_argument("--force", action="store_true", help="replace CSVs in a non-empty --out-dir")
    for _s in (sys.stdout, sys.stderr):
        if hasattr(_s, "reconfigure"):
            _s.reconfigure(encoding="utf-8", errors="replace")
    a = ap.parse_args(argv)

    cols = {"language": a.col_language, "component": a.col_component, "field": a.col_field,
            "key": a.col_key, "translation": a.col_translation}
    fails = read_failures(a.failures, a.sheet, cols)
    fresh = tcsv.load_dir(a.fresh_dir)
    if not fresh:
        sys.exit(f"error: no translation CSVs found in {a.fresh_dir}")

    # (lang, component, field, normalised key) -> [org rows]
    index: dict[tuple, list[dict]] = defaultdict(list)
    for lang, (_p, _h, rows) in fresh.items():
        for r in rows:
            if r.get("masterLabel"):
                index[(lang, r.get("component", ""), r.get("field", ""),
                       ws_norm(r["masterLabel"]))].append(r)

    picks: dict[str, list[dict]] = defaultdict(list)
    report = defaultdict(list)
    for f in fails:
        if a.component and f["component"] not in a.component:
            report["outside --component"].append(f)
            continue
        if not f["translation"].strip():
            report["no translation supplied"].append(f)
            continue
        hits = index.get((f["language"], f["component"], f["field"], ws_norm(f["key"])), [])
        if not f["field"] and not hits:
            # Field not given: accept a unique match on any field of the component.
            hits = [r for (lg, c, _fld, k), rs in index.items()
                    if lg == f["language"] and c == f["component"] and k == ws_norm(f["key"])
                    for r in rs]
        if not hits:
            report["no whitespace-only match in the org - needs a decision"].append(f)
            continue
        if len(hits) > 1:
            report["ambiguous - several org keys match"].append(f)
            continue
        org = hits[0]
        if org["masterLabel"] == f["key"]:
            report["key already matches the org exactly - not a whitespace problem"].append(f)
            continue
        if (org.get("translation") or "") == f["translation"]:
            report["already correct in the org"].append(f)
            continue
        prev = next((p for p in picks[f["language"]]
                     if tcsv.slot_key(p) == tcsv.slot_key(org)), None)
        if prev is not None:
            if prev["translation"] != f["translation"]:
                report["conflicting translations for the same slot - dropped"].append(f)
                picks[f["language"]].remove(prev)
            continue
        row = dict(org)
        row["translation"] = f["translation"]   # byte for byte; key stays as the org has it
        picks[f["language"]].append(row)

    tcsv.prepare_out_dir(a.out_dir, a.force)
    for lang, rows in picks.items():
        if rows:
            tcsv.write_csv(a.out_dir / f"translations_{lang}.csv", fresh[lang][1], rows)

    print(f"failed rows read     : {len(fails)}")
    print(f"re-keyed             : {sum(len(v) for v in picks.values())} across {len(picks)} language(s)")
    for lg in sorted(picks):
        print(f"   {lg:6} {len(picks[lg])}")
    for reason, rows in report.items():
        print(f"\n{reason}: {len(rows)}")
        for f in rows[:10]:
            print(f"   [{f['language']:5}] {f['component']}.{f['field']} {f['key']!r}")
    print(f"\npayload CSVs: {a.out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
