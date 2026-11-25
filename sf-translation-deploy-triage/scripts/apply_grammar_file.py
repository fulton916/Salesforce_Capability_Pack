#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Apply a filled grammar file back into the translation CSVs, scoped for a redeploy.

Reads the ANSWER column of the file from make_grammar_file.py, checks every answer against
the values Salesforce accepts for that language, and writes it into the CSV's `gender` or
`startsWith` column ('Vowel sound' / 'Yes' -> Vowel, 'Consonant sound' / 'No' -> Consonant,
the enum Salesforce stores).

The output holds ONLY the components that failed on grammar (every row of each failing
object + language, because a CustomObjectTranslation deploys as one unit). Everything that
already landed stays out of the redeploy.

Safety:
  - An answer that is not valid for its language stops the run (all are listed).
  - Unanswered rows stop the run unless --allow-incomplete: they would fail again.
  - The source CSVs are not modified; output goes to a new folder.

Usage:
  python apply_grammar_file.py grammar_values.xlsx csv_dir/ deploy.json --out-dir redeploy_csv/
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import triage_common as T  # noqa: E402

SHEET = "Grammar Values Needed"


def read_answers(path: str) -> tuple[dict, list[str], list[str]]:
    """({(object, field, lang): {attr: value}}, invalid messages, unanswered messages)."""
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    if SHEET not in wb.sheetnames:
        sys.exit(f"error: no '{SHEET}' tab in {path}")
    _hdr, rows = T.sheet_rows(wb[SHEET])
    out: dict[tuple[str, str, str], dict[str, str]] = {}
    invalid, blank = [], []
    for r in rows:
        obj, fld, lang = r.get("Object", ""), r.get("Field API Name", ""), r.get("Language Code", "")
        attr = "startsWith" if "start" in (r.get("Attribute") or "").lower() else "gender"
        ans = (r.get("ANSWER") or "").strip()
        where = f"{obj}.{fld} [{lang}] {attr}"
        if not ans:
            blank.append(where)
            continue
        valid = [v.strip() for v in (r.get("Valid Answers") or "").split(",") if v.strip()]
        if attr == "startsWith":
            ans = T.sw_metadata(ans)
            if ans not in ("Vowel", "Consonant"):
                invalid.append(f"{where} = {r.get('ANSWER')!r} (expected Vowel sound / Consonant sound)")
                continue
        elif valid and ans not in valid:
            invalid.append(f"{where} = {ans!r} is not in {valid}")
            continue
        out.setdefault((obj, fld, lang), {})[attr] = ans
    return out, invalid, blank


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("grammar_xlsx", help="filled file from make_grammar_file.py")
    ap.add_argument("csv_dir", help="translation CSVs that were deployed")
    ap.add_argument("deploy_json", help="the deploy/validate result that reported the grammar failures")
    ap.add_argument("-d", "--out-dir", required=True, help="new folder for the scoped CSVs")
    ap.add_argument("--allow-incomplete", action="store_true",
                    help="write the scoped CSVs even if some rows have no answer")
    T.utf8_console()
    a = ap.parse_args(argv)

    answers, invalid, blank = read_answers(a.grammar_xlsx)
    if invalid:
        sys.exit("error: answers not valid for their language:\n  " + "\n  ".join(invalid))
    if blank:
        print(f"{len(blank)} row(s) have no answer:")
        for b in blank[:20]:
            print(f"   {b}")
        if not a.allow_incomplete:
            print("Those components would fail again. Get the answers, or pass --allow-incomplete.")
            return 1

    _res, fails, _ok = T.load_deploy(a.deploy_json)
    pairs = set(T.grammar_pairs(fails))
    out_dir = Path(a.out_dir)
    if out_dir.exists() and any(out_dir.iterdir()):
        sys.exit(f"error: {out_dir} is not empty; choose a new folder")
    out_dir.mkdir(parents=True, exist_ok=True)

    applied, total = 0, 0
    used = set()
    for src in sorted(Path(a.csv_dir).glob("*.csv")):
        hdr, rows = T.read_csv(src)
        default = T.file_language(src, rows)
        keep = []
        for r in rows:
            lang = T.row_lang(r, default)
            if not lang or (r.get("component", ""), lang) not in pairs:
                continue
            hit = answers.get((r.get("component", ""), r.get("field", ""), lang))
            if hit:
                for attr, val in hit.items():
                    r[attr] = val
                    applied += 1
                used.add((r.get("component", ""), r.get("field", ""), lang))
            keep.append(r)
        if keep:
            fields = hdr + [c for c in ("gender", "startsWith") if c not in hdr]
            T.write_csv(out_dir / src.name, fields, keep)
            total += len(keep)
            print(f"  {src.name}: {len(keep)} row(s)")

    expected = sum(len(v) for v in answers.values())
    print(f"\ncomponents to redeploy : {len(pairs)}")
    print(f"grammar values applied : {applied} (answers in the file: {expected})")
    print(f"rows in scope          : {total}")
    unused = set(answers) - used
    if unused:
        print(f"WARNING: {len(unused)} answered row(s) matched no CSV row in a failing component:",
              file=sys.stderr)
        for k in sorted(unused)[:10]:
            print(f"   {k}", file=sys.stderr)
    print(f"Saved: {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
