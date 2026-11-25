#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Apply a returned reviewer action file (from make_action_file.py) to translation CSVs.

Tab 1: Yes/No "starts with a vowel sound" -> the CSV `startsWith` column as Vowel/Consonant.
Tab 2: confirmed picklist keys -> the CSV `masterLabel` is remapped (the translation is kept
       as is); DROP removes the row.

Answers are validated before anything is written: an answer that is not Yes/No stops the run.
A Tab 2 answer that leaves the key unchanged is reported, because it will fail again.

--startswith-only applies Tab 1 alone. Use it when the Tab 2 keys belong to a global value
set: a global value set is keyed by the value's LABEL, so remapping it to an API name breaks it.

Usage:
  python apply_action_file.py action.xlsx csv_dir/ -d out_csv/ [--startswith-only]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import triage_common as T  # noqa: E402

TAB1 = "1. Starts With Needed"
TAB2 = "2. Picklist API Names"


def read_tab1(wb) -> dict[tuple[str, str, str], str]:
    out = {}
    if TAB1 not in wb.sheetnames:
        return out
    hdr, rows = T.sheet_rows(wb[TAB1])
    q = next((h for h in hdr if h.startswith("Q:")), hdr[-1] if hdr else "")
    errors = []
    for r in rows:
        ans = (r.get(q) or "").strip().lower()
        key = (r.get("Object", ""), r.get("Field API Name", ""), r.get("Language Code", ""))
        if ans in ("yes", "no"):
            out[key] = "Vowel" if ans == "yes" else "Consonant"
        elif ans:
            errors.append(f"{key[0]}.{key[1]} [{key[2]}] answer {r.get(q)!r} is not Yes/No")
    if errors:
        sys.exit("error: Tab 1 answers must be Yes or No:\n  " + "\n  ".join(errors))
    return out


def read_tab2(wb):
    remap, dropped, unchanged = {}, set(), []
    if TAB2 not in wb.sheetnames:
        return remap, dropped, unchanged
    hdr, rows = T.sheet_rows(wb[TAB2])
    q = next((h for h in hdr if h.startswith("Q:")), "")
    rep_col = hdr[-1] if hdr else ""
    for r in rows:
        full, sent, sugg = r.get("Object.Field", ""), r.get("Value Sent", ""), r.get("Suggested API Name (from org)", "")
        ans = (r.get(q) or "").strip().lower()
        rep = (r.get(rep_col) or "").strip()
        if ans not in ("", "yes", "no", "n/a"):
            sys.exit(f"error: Tab 2 {full} {sent!r}: answer {r.get(q)!r} is not Yes/No")
        if rep.upper() == "DROP":
            dropped.add((full, sent))
            continue
        target = (rep or sugg) if ans == "yes" else rep
        if not target:
            continue
        if target == sent:
            unchanged.append((full, sent))
        else:
            remap[(full, sent)] = target
    return remap, dropped, unchanged


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action_xlsx")
    ap.add_argument("csv_dir", help="translation CSVs to apply the answers to (not modified)")
    ap.add_argument("-d", "--out-dir", required=True, help="new folder for the updated CSVs")
    ap.add_argument("--startswith-only", action="store_true", help="apply Tab 1 only")
    T.utf8_console()
    a = ap.parse_args(argv)

    import openpyxl
    wb = openpyxl.load_workbook(a.action_xlsx, read_only=True, data_only=True)
    sw = read_tab1(wb)
    remap, dropped, unchanged = (({}, set(), []) if a.startswith_only else read_tab2(wb))
    print(f"Tab 1 startsWith answers : {len(sw)}")
    print(f"Tab 2 key remaps         : {len(remap)}")
    print(f"Tab 2 rows to drop       : {len(dropped)}")
    if unchanged:
        print(f"Tab 2 returned UNCHANGED : {len(unchanged)} (same value as sent - will fail again)")

    out_dir = Path(a.out_dir)
    if out_dir.exists() and any(out_dir.iterdir()):
        sys.exit(f"error: {out_dir} is not empty; choose a new folder")
    out_dir.mkdir(parents=True, exist_ok=True)

    n_sw = n_remap = n_drop = 0
    for src in sorted(Path(a.csv_dir).glob("*.csv")):
        hdr, rows = T.read_csv(src)
        default = T.file_language(src, rows)
        keep = []
        for r in rows:
            comp, fld, ml = r.get("component", ""), r.get("field", ""), r.get("masterLabel", "")
            full = f"{comp}.{fld}"
            if ml and (full, ml) in dropped:
                n_drop += 1
                continue
            if ml and (full, ml) in remap:
                r["masterLabel"] = remap[(full, ml)]
                n_remap += 1
            hit = sw.get((comp, fld, T.row_lang(r, default) or ""))
            if hit:
                r["startsWith"] = hit
                n_sw += 1
            keep.append(r)
        fields = hdr + (["startsWith"] if "startsWith" not in hdr and n_sw else [])
        T.write_csv(out_dir / src.name, fields, keep)

    print(f"\nApplied: {n_sw} startsWith cell(s), {n_remap} key remap(s), {n_drop} row(s) dropped")
    if n_sw < len(sw):
        print(f"WARNING: {len(sw) - n_sw} startsWith answer(s) matched no CSV row", file=sys.stderr)
    print(f"Saved: {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
