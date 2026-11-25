#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Mark each workbook row with whether its values really landed in the org.

A clean deploy report does not prove the data is live. This reads the org AFTER the
deploy (a retrieve and/or a Bilingual export) and stamps every row of the workbook with a
per-row status, so nobody has to trust a blanket "deployed" banner.

Per (row, language) with a filled value in the '<Language> <suffix>' column:
    LANDED          the org holds exactly this value
    LANDED (spacing)  the org holds it with different spacing (e.g. a trimmed trailing space)
    ALREADY HELD    the org held this value BEFORE the deploy too (needs --before-*):
                    nothing to fix, not part of the deploy
    DIFFERENT       the org holds other text            <- needs attention
    NOT LANDED      the org knows the item, holds no translation   <- needs attention
    UNREADABLE      the org defines the item; no source can show its translation
    NO TARGET       no source knows the item

Row status: LANDED when every language landed or was already held, else the worst
category with its languages, e.g. "NOT LANDED: fr, it". A 'Landed detail' column lists
every language.

Writes a COPY (default <workbook>_landed.xlsx); the input is never changed unless --in-place.

Example:
    python mark_landed.py corrections.xlsx --suffix Translation --stf-dir exports/after \\
        --before-stf-dir exports/before --out out/corrections_landed.xlsx
"""
from __future__ import annotations

import argparse
import collections
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402

ORDER = ["DIFFERENT", "NOT LANDED", "NO TARGET", "UNREADABLE", "LANDED (spacing)", "ALREADY HELD", "LANDED"]


def verdict(val, st, ov, before):
    if before is not None and before[0] == "held" and before[1] == val and st == "held" and ov == val:
        return "ALREADY HELD"
    if st == "absent":
        return "NO TARGET"
    if st == "unreadable":
        return "UNREADABLE"
    if st == "empty":
        return "NOT LANDED"
    if ov == val:
        return "LANDED"
    if R.norm_ws(ov) == R.norm_ws(val):
        return "LANDED (spacing)"
    return "DIFFERENT"


def main(argv=None):
    from openpyxl.styles import Alignment, Font, PatternFill

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workbook")
    ap.add_argument("--suffix", default="Translation", help="language column suffix holding what was sent")
    ap.add_argument("--retrieve", nargs="+", default=[], help="after-deploy retrieve folder(s)")
    ap.add_argument("--stf-dir", help="after-deploy Bilingual export")
    ap.add_argument("--before-retrieve", nargs="+", default=[], help="pre-deploy retrieve (optional)")
    ap.add_argument("--before-stf-dir", help="pre-deploy Bilingual export (optional)")
    ap.add_argument("--sheets", nargs="+")
    ap.add_argument("--cols")
    ap.add_argument("--lang-map")
    ap.add_argument("--out", help="output copy (default: <workbook>_landed<ext>)")
    ap.add_argument("--in-place", action="store_true", help="write into the workbook itself")
    a = ap.parse_args(argv)
    R.utf8_stdout()
    lang_map = R.load_lang_map(a.lang_map)
    cols = R.parse_cols(a.cols)
    org = R.OrgState(a.retrieve, a.stf_dir)
    before = R.OrgState(a.before_retrieve, a.before_stf_dir) if (a.before_retrieve or a.before_stf_dir) else None

    status = {}                                   # (sheet, row) -> (row status, detail)
    tally = collections.Counter()
    for sheet, rn, row, vals in R.iter_rows(a.workbook, cols, a.sheets, a.suffix, lang_map):
        per = collections.defaultdict(list)
        for lang, (_ci, val) in vals.items():
            if not val.strip():
                continue
            args = (lang, row["type"], row["component"], row["field"], row["item"])
            st, ov, _k, _s = org.lookup(*args)
            b = before.lookup(*args)[:2] if before else None
            v = verdict(val, st, ov, b)
            per[v].append(lang)
            tally[v] += 1
        if not per:
            continue
        worst = next(c for c in ORDER if c in per)
        bad = [c for c in ORDER[:4] if c in per]
        row_status = "LANDED" if not bad else "; ".join(f"{c}: {', '.join(sorted(per[c]))}" for c in bad)
        detail = "; ".join(f"{c}: {', '.join(sorted(per[c]))}" for c in ORDER if c in per)
        status[(sheet, rn)] = (row_status, detail, worst)

    src = Path(a.workbook)
    out = src if a.in_place else Path(a.out or src.with_name(f"{src.stem}_landed{src.suffix}"))
    if out != src:
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, out)
    wb = R.open_workbook(out)
    ok_fill, ok_font = PatternFill("solid", fgColor="C6EFCE"), Font(color="006100")
    no_fill, no_font = PatternFill("solid", fgColor="FFC7CE"), Font(color="9C0006")
    mid_fill = PatternFill("solid", fgColor="FFEB9C")
    for sheet in sorted({k[0] for k in status}):
        ws = wb[sheet]
        hdr = [R.s(c.value) for c in ws[1]]
        for name in ("Landed status", "Landed detail"):
            if name not in hdr:
                ws.cell(1, len(hdr) + 1, name).font = Font(bold=True)
                hdr.append(name)
        sc, dc = hdr.index("Landed status") + 1, hdr.index("Landed detail") + 1
        for (sh, rn), (row_status, detail, worst) in status.items():
            if sh != sheet:
                continue
            c = ws.cell(rn, sc, row_status)
            ws.cell(rn, dc, detail).alignment = Alignment(wrap_text=True, vertical="top")
            if row_status == "LANDED":
                c.fill, c.font = ok_fill, ok_font
            elif worst in ("DIFFERENT", "NOT LANDED"):
                c.fill, c.font = no_fill, no_font
            else:
                c.fill = mid_fill
    wb.save(str(out))
    rows = collections.Counter("LANDED" if v[0] == "LANDED" else v[2] for v in status.values())
    print(f"cells: {dict(tally.most_common())}")
    print(f"rows : {dict(rows.most_common())}")
    print(f"written: {out}")
    return 2 if any(v[2] in ("DIFFERENT", "NOT LANDED") for v in status.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
