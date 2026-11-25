#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Apply a change plan from compare_workbook.py to the workbook: Existing Value := org value.

Dry run by default: checks every planned cell and prints what would change.
With --apply, in this order:
  1. stops (nothing written) if ANY planned cell no longer holds the value the plan saw -
     the workbook changed since the plan was made; re-run compare_workbook.py
  2. writes the record of every changed cell (--record, Excel), with optional columns
     saying where each OLD value also exists (another export, earlier load files), so a
     reviewer can tell a stale value from a deliberate one
  3. copies the workbook to a timestamped backup next to it
  4. saves the workbook

Examples:
    python apply_change_plan.py master.xlsx out/change_plan.json
    python apply_change_plan.py master.xlsx out/change_plan.json --apply \\
        --record out/changed_cells.xlsx --reference sandbox=exports/sandbox \\
        --load-file "Load 1=loads/load1.xlsx" --load-file "Load 2=loads/load2.xlsx"
"""
from __future__ import annotations

import argparse
import collections
import shutil
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402


def named_paths(items, what):
    out = []
    for x in items or []:
        name, sep, path = x.partition("=")
        if not sep:
            R.die(f"{what} must be NAME=PATH, got {x!r}")
        out.append((name.strip(), path.strip()))
    return out


def load_file_values(path, lang_map) -> dict[str, set[str]]:
    """{lang: {stripped values}} from every '<Language> Translation|Existing Value' column."""
    out = collections.defaultdict(set)
    wb = R.open_workbook(path, read_only=True)
    for ws in wb.worksheets:
        it = ws.iter_rows(values_only=True)
        hdr = next(it, None) or ()
        cols = {}
        for i, h in enumerate(hdr):
            code, rest = R.split_lang_header(h, lang_map)
            if code and rest in ("Translation", "Existing Value"):
                cols[i] = code
        for r in it:
            for i, lang in cols.items():
                if i < len(r) and r[i] not in (None, ""):
                    out[lang].add(str(r[i]).strip())
    wb.close()
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workbook")
    ap.add_argument("plan", help="change_plan.json from compare_workbook.py")
    ap.add_argument("--apply", action="store_true", help="write (default: dry run)")
    ap.add_argument("--record", help="Excel record of every changed cell (default: <plan dir>/changed_cells.xlsx)")
    ap.add_argument("--categories", default="FILL,DIFFERENT,CLEAR,whitespace",
                    help="plan categories to apply (default: %(default)s)")
    ap.add_argument("--reference", action="append", metavar="NAME=STF_DIR",
                    help="another Bilingual export; the record says if the OLD value is also there")
    ap.add_argument("--load-file", action="append", metavar="NAME=XLSX",
                    help="an earlier load file; the record says if the OLD value came from it")
    ap.add_argument("--lang-map", help="JSON {display name: code} added to the built-in map")
    a = ap.parse_args(argv)
    R.utf8_stdout()
    lang_map = R.load_lang_map(a.lang_map)
    plan = R.load_json(a.plan)
    changes = [c for c in plan["changes"] if c["cat"] in set(a.categories.split(","))]
    if Path(plan.get("workbook", a.workbook)).name != Path(a.workbook).name:
        print(f"NOTE: the plan was made for {plan.get('workbook')}, applying to {a.workbook}")

    refs = {n: {l: set(f.held.values()) for l, f in R.load_stf_dir(p).items()}
            for n, p in named_paths(a.reference, "--reference")}
    loads = [(n, load_file_values(p, lang_map)) for n, p in named_paths(a.load_file, "--load-file")]

    wb = R.open_workbook(a.workbook)
    stale = []
    for c in changes:
        cur = R.s(wb[c["sheet"]].cell(c["row"], c["col"]).value)
        if cur != c["old"]:
            stale.append((c["sheet"], c["row"], c["col"], c["old"], cur))
    if stale:
        for x in stale[:20]:
            print(f"  {x[0]} r{x[1]} c{x[2]}: plan expected {x[3]!r}, workbook holds {x[4]!r}")
        R.die(f"{len(stale)} planned cells changed since the plan was made. Nothing written. "
              "Re-run compare_workbook.py.")

    hdr = ["sheet", "row", "column", "lang", "type", "component", "field", "item", "change",
           "old (workbook)", "new (org)", "org key", "read from"]
    hdr += [f"old value also in {n}" for n in refs] + ["old value in a load file"] * bool(loads)
    rows = []
    for c in changes:
        line = [c["sheet"], c["row"], c["col"], c["lang"], c["type"], c["component"], c["field"], c["item"],
                c["cat"], c["old"], c["new"], c.get("key", ""), c.get("source", "")]
        line += ["yes" if c["old"] and c["old"] in v.get(c["lang"], ()) else "" for v in refs.values()]
        if loads:
            line.append(", ".join(n for n, v in loads if c["old"] and c["old"].strip() in v.get(c["lang"], ())))
        rows.append(line)
    counts = dict(collections.Counter(c["cat"] for c in changes))
    if not a.apply:
        print(f"dry run: {len(changes)} cells would change {counts}; all still hold the planned old value.")
        print("re-run with --apply to write the record, a backup and the workbook.")
        return 0
    record = Path(a.record) if a.record else Path(a.plan).parent / "changed_cells.xlsx"
    R.write_xlsx(record, {"Changed cells": (hdr, rows)})              # 2. the record, first
    for c in changes:
        wb[c["sheet"]].cell(c["row"], c["col"]).value = c["new"] or None
    src = Path(a.workbook)
    backup = src.with_name(f"{src.stem}_PRE-apply_{datetime.now():%Y%m%d-%H%M%S}{src.suffix}")
    shutil.copy2(src, backup)                                          # 3. the backup
    wb.save(str(src))                                                  # 4. the workbook
    print(f"changed {len(changes)} cells {counts}")
    print(f"record: {record}\nbackup: {backup}\nsaved : {src}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
