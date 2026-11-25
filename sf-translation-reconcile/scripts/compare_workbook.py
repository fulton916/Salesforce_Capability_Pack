#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Compare a translation workbook's "Existing Value" cells against what the org really holds.

Read-only: the workbook is never touched. Writes a change plan (JSON) that
apply_change_plan.py can apply, plus an optional Excel report.

Org value per (row, language): the retrieve folders (--retrieve, metadata format, parents
named in the same manifest) win; the Bilingual export (--stf-dir) fills what the retrieve
does not cover. Either source alone also works.

Categories per (row, language):
    same        workbook == org (exact)
    whitespace  differs only in spacing
    FILL        workbook blank, org holds a translation
    DIFFERENT   both filled, not equal
    CLEAR       workbook filled, org knows the item and holds no translation
    UNREADABLE  org defines the item, but no source can show its translation - left alone
    UNRESOLVED  no source knows the item (deleted / renamed / never read) - left alone

The plan holds FILL / DIFFERENT / CLEAR for non-English columns (add --plan-whitespace to
include whitespace fixes). English is reported, never planned: the English "Existing Value"
normally carries the English label, not an en_US override.

--check turns this into an independent check of a pull-down workbook: exit 2 when any
cell (English included, against the export's source text) is FILL, DIFFERENT or CLEAR.
Spacing-only differences are reported but count as agreeing (the export and a retrieve do
not always carry the same outer whitespace).

Examples:
    python compare_workbook.py master.xlsx --retrieve read/obj_1 read/vs_labels \\
        --stf-dir "exports/today" --plan out/change_plan.json --report out/compare.xlsx
    python compare_workbook.py review.xlsx --stf-dir exports/after --check
"""
from __future__ import annotations

import argparse
import collections
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402

CATS = ["same", "whitespace", "FILL", "DIFFERENT", "CLEAR", "UNREADABLE", "UNRESOLVED"]


def classify(wbv: str, status: str, orgv):
    if status == "absent":
        return "UNRESOLVED"
    if status == "unreadable":
        return "UNREADABLE"
    if status == "empty":
        return "CLEAR" if wbv else "same"
    if not wbv:
        return "FILL"
    if wbv == orgv:
        return "same"
    if R.norm_ws(wbv) == R.norm_ws(orgv):
        return "whitespace"
    return "DIFFERENT"


def compare(workbook, org: R.OrgState, cols, suffix, lang_map, sheets=None, english="en_US",
            plan_ws=False):
    plan, report = [], []
    tally = collections.defaultdict(collections.Counter)
    for sheet, rn, row, vals in R.iter_rows(workbook, cols, sheets, suffix, lang_map):
        for lang, (ci, wbv) in vals.items():
            if lang == english:
                st, orgv, key, src = org.lookup(lang, row["type"], row["component"], row["field"], row["item"])
                if st != "held":
                    eng = org.english_source(row["type"], row["component"], row["field"], row["item"])
                    st, orgv, src = ("held", eng, "export source") if eng is not None else (st, orgv, src)
            else:
                st, orgv, key, src = org.lookup(lang, row["type"], row["component"], row["field"], row["item"])
            cat = classify(wbv, st, orgv)
            tally[f"{sheet} | {row['type']}"][cat] += 1
            rec = {"sheet": sheet, "row": rn, "col": ci + 1, "lang": lang, "type": row["type"],
                   "component": row["component"], "field": row["field"], "item": row["item"],
                   "cat": cat, "old": wbv, "new": orgv or "", "key": key, "source": src}
            if cat not in ("same",):
                report.append(rec)
            plannable = cat in ("FILL", "DIFFERENT", "CLEAR") or (plan_ws and cat == "whitespace")
            if lang != english and plannable:
                plan.append(rec)
    return plan, report, tally


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workbook")
    ap.add_argument("--retrieve", nargs="+", default=[], help="metadata-format retrieve folder(s)")
    ap.add_argument("--stf-dir", help="folder holding a Bilingual export (Bilingual_<lang>_*.stf)")
    ap.add_argument("--suffix", default="Existing Value", help="language column suffix (default: %(default)s)")
    ap.add_argument("--sheets", nargs="+", help="sheets to read (default: every sheet with a type column)")
    ap.add_argument("--cols", help="column-name overrides, e.g. 'item=Section,field=API Name'")
    ap.add_argument("--lang-map", help="JSON {display name: code} added to the built-in map")
    ap.add_argument("--english", default="en_US", help="code of the English column (default: %(default)s)")
    ap.add_argument("--plan", help="write the change plan JSON here")
    ap.add_argument("--plan-whitespace", action="store_true", help="also plan whitespace-only fixes")
    ap.add_argument("--report", help="write an Excel report of every non-'same' cell")
    ap.add_argument("--check", action="store_true",
                    help="independent check: exit 2 on any FILL / DIFFERENT / CLEAR cell")
    a = ap.parse_args(argv)
    R.utf8_stdout()
    lang_map = R.load_lang_map(a.lang_map)
    org = R.OrgState(a.retrieve, a.stf_dir)
    plan, report, tally = compare(a.workbook, org, R.parse_cols(a.cols), a.suffix, lang_map, a.sheets,
                                  a.english, a.plan_whitespace)
    if not tally:
        R.die(f"no data rows with '<Language> {a.suffix}' columns found in {a.workbook}")
    print(f"{'sheet | type':42}" + "".join(f"{c[:11]:>12}" for c in CATS))
    tot = collections.Counter()
    for k in sorted(tally):
        tot.update(tally[k])
        print(f"{k[:42]:42}" + "".join(f"{tally[k][c]:12}" for c in CATS))
    print(f"{'TOTAL':42}" + "".join(f"{tot[c]:12}" for c in CATS))
    print(f"\nplanned changes (non-English): {dict(collections.Counter(p['cat'] for p in plan))}")
    if a.plan:
        R.dump_json({"workbook": str(a.workbook), "suffix": a.suffix, "changes": plan}, a.plan)
        print(f"plan written: {a.plan}")
    if a.report:
        hdr = ["sheet", "row", "lang", "type", "component", "field", "item", "cat", "workbook", "org", "key", "source"]
        R.write_xlsx(a.report, {"Differences": (hdr, [[r[h] if h in r else r["old" if h == "workbook" else "new"]
                                                       for h in hdr] for r in report])})
        print(f"report written: {a.report}")
    if a.check:
        bad = sum(tot[c] for c in ("FILL", "DIFFERENT", "CLEAR"))      # spacing-only counts as agreeing
        print("CHECK", "PASS" if not bad else f"FAIL ({bad} cells disagree)")
        return 2 if bad else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
