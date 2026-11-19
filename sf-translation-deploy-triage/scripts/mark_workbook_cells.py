#!/usr/bin/env python3
"""Mark cells in a multi-language translation workbook so reviewers see what was skipped.

The workbook needs key columns `type`, `component`, `field`, `masterLabel` and, per
language, a "<Language> Translation" column (the language as a code or a name, e.g.
"de Translation" or "German Translation"). An optional "<Language> Existing Value" column
holds what the org already has.

Two modes:

  grey-skipped      Grey a language's cells when the translator's returned CSV has no
                    translation for the row AND the org has no existing value. Those are
                    plain skips. Cells with a translator value, or with an org value a
                    reviewer should check, stay white. Re-running clears earlier grey.

  flag-prior-skips  Red-flag a blank cell only when all three hold:
                      1. the slot was in an earlier load file (so it was asked for),
                      2. that earlier file filled the slot in at least one OTHER language
                         (so the row was worked and this blank was a decision), and
                      3. the org still has no value for it (per a fresh org pull).
                    Slots new since the earlier files are never flagged. Adds a
                    'Summary' tab that says red means "confirm", not "error".

Usage:
  python mark_workbook_cells.py grey-skipped master.xlsx --translator-dir returned_csv/ [--out marked.xlsx]
  python mark_workbook_cells.py flag-prior-skips master.xlsx --org-pull pull/ --prior-dir round1/ [--prior-dir round2/]
Translation CSVs are the per-language files described in README.md.
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import triage_common as T  # noqa: E402

KEYS = ("type", "component", "field", "masterLabel")
GREY = "C0C0C0"
RED = "FFC7CE"
SUMMARY_TAB = "Summary"


def slot(r: dict) -> tuple:
    return tuple(str(r.get(k) or "") for k in KEYS)


def load_by_lang(dirs: list[str]) -> dict[str, dict[tuple, str]]:
    """{lang: {slot: translation}} from translation CSV folders (later folders win)."""
    out: dict[str, dict[tuple, str]] = defaultdict(dict)
    for d in dirs:
        for lang, rows in T.load_csv_dir(d).items():
            for r in rows:
                tr = (r.get("translation") or "").strip()
                if tr or slot(r) not in out[lang]:
                    out[lang][slot(r)] = tr
    return out


def language_columns(hdr: list[str]) -> dict[str, tuple[int, int | None]]:
    """{lang code: (translation col, existing-value col or None)} (1-based)."""
    by_name = {v.lower(): k for k, v in T.LANGUAGE_NAMES.items()}
    out = {}
    for i, h in enumerate(hdr, start=1):
        if h.endswith(" Translation"):
            label = h[: -len(" Translation")]
            code = by_name.get(label.lower(), label)
            ev = f"{label} Existing Value"
            out[code] = (i, hdr.index(ev) + 1 if ev in hdr else None)
    return out


def open_sheet(path: str, sheet: str | None, header_row: int):
    import openpyxl
    wb = openpyxl.load_workbook(path)
    ws = wb[sheet] if sheet else wb.worksheets[0]
    hdr = [str(c.value or "") for c in ws[header_row]]
    missing = [k for k in KEYS if k not in hdr]
    if missing:
        sys.exit(f"error: key column(s) {missing} not found in {ws.title!r} row {header_row}")
    return wb, ws, hdr


def fill_of(cell) -> str:
    c = cell.fill.fgColor.rgb if cell.fill and cell.fill.fill_type == "solid" else ""
    return str(c or "")[-6:].upper()


def grey_skipped(a) -> int:
    from openpyxl.styles import PatternFill
    wb, ws, hdr = open_sheet(a.workbook, a.sheet, a.header_row)
    cols = language_columns(hdr)
    if not cols:
        sys.exit("error: no '<Language> Translation' columns found")
    given = load_by_lang([a.translator_dir])
    kc = {k: hdr.index(k) + 1 for k in KEYS}
    grey, none = PatternFill("solid", fgColor=GREY), PatternFill(fill_type=None)
    greyed = total = 0
    for row in range(a.header_row + 1, ws.max_row + 1):
        key = tuple(str(ws.cell(row=row, column=kc[k]).value or "") for k in KEYS)
        if not any(key):
            continue
        for lang, (tc, ec) in cols.items():
            total += 1
            cells = [ws.cell(row=row, column=c) for c in (tc, ec) if c]
            org_val = str(ws.cell(row=row, column=ec).value or "").strip() if ec else ""
            if not given.get(lang, {}).get(key) and not org_val:
                for c in cells:
                    c.fill = grey
                greyed += 1
            else:
                for c in cells:
                    if fill_of(c) == GREY:
                        c.fill = none
    wb.save(a.out or a.workbook)
    print(f"Greyed {greyed:,} of {total:,} language x row cells "
          f"({100 * greyed / total if total else 0:.1f}% skipped).")
    print(f"Saved: {a.out or a.workbook}")
    return 0


def flag_prior_skips(a) -> int:
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter
    wb, ws, hdr = open_sheet(a.workbook, a.sheet, a.header_row)
    cols = language_columns(hdr)
    langs = list(cols)
    prior = load_by_lang(a.prior_dir)
    org = load_by_lang([a.org_pull])
    fresh_keys = {k for d in org.values() for k in d}

    asked: dict[tuple, set[str]] = defaultdict(set)
    filled: dict[tuple, set[str]] = defaultdict(set)
    for lang, slots in prior.items():
        if lang not in cols:
            continue
        for k, tr in slots.items():
            asked[k].add(lang)
            if tr:
                filled[k].add(lang)
    deliberate: dict[tuple, set[str]] = defaultdict(set)
    outstanding: dict[tuple, set[str]] = defaultdict(set)
    for k, lgs in asked.items():
        if k not in fresh_keys:
            continue
        for lg in lgs - filled[k]:
            if org.get(lg, {}).get(k):
                continue
            outstanding[k].add(lg)
            if filled[k]:
                deliberate[k].add(lg)

    kc = {k: hdr.index(k) + 1 for k in KEYS}
    red, red_font = PatternFill("solid", fgColor=RED), Font(color="9C0006")
    painted = 0
    for row in range(a.header_row + 1, ws.max_row + 1):
        key = tuple(str(ws.cell(row=row, column=kc[k]).value or "") for k in KEYS)
        for lg in deliberate.get(key, ()):
            cell = ws.cell(row=row, column=cols[lg][0])
            if str(cell.value or "").strip():
                continue
            cell.fill, cell.font = red, red_font
            painted += 1

    if SUMMARY_TAB in wb.sheetnames:
        del wb[SUMMARY_TAB]
    s = wb.create_sheet(SUMMARY_TAB, 0)
    st = T.styles()
    for line in ["Coverage as at this pull", "", "RED DOES NOT MEAN AN ERROR OR A MISSED ROW.", "",
                 "A red cell was in an earlier load file, was translated in at least one other",
                 "language, was left blank in this one, and the org still has no value for it.",
                 "Usually that was a scope decision. Confirm it: still not applicable -> leave it",
                 "blank; applies after all -> enter the translation.", "",
                 "Slots that are new in this pull are not highlighted: nobody has been asked yet.",
                 "'Still outstanding' counts every slot with no value from any source. It is an",
                 "upper bound, not a workload.", ""]:
        s.append([line])
    s["A1"].font = st["title"]
    s.append(["Language", "Code", "Slots in pull", "Already in org",
              "Previously skipped - confirm (red)", "Still outstanding"])
    T.style_header(s, s.max_row)
    for lg in langs:
        s.append([T.LANGUAGE_NAMES.get(lg, lg), lg, len(fresh_keys),
                  sum(1 for v in org.get(lg, {}).values() if v),
                  sum(1 for v in deliberate.values() if lg in v),
                  sum(1 for v in outstanding.values() if lg in v)])
    for i, w in enumerate([24, 8, 14, 15, 22, 18], start=1):
        s.column_dimensions[get_column_letter(i)].width = w
    wb.save(a.out or a.workbook)
    print(f"Flagged {painted} cell(s) across {len(deliberate)} slot(s).")
    print(f"Still outstanding (reference): {sum(len(v) for v in outstanding.values())} cell(s).")
    print(f"Saved: {a.out or a.workbook}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="mode", required=True)
    for name, extra in (("grey-skipped", "translator"), ("flag-prior-skips", "prior")):
        p = sub.add_parser(name)
        p.add_argument("workbook")
        p.add_argument("--sheet", help="worksheet name (default: the first)")
        p.add_argument("--header-row", type=int, default=1)
        p.add_argument("--out", help="write here instead of overwriting the workbook")
        if extra == "translator":
            p.add_argument("--translator-dir", required=True,
                           help="translation CSVs as returned by the translators")
        else:
            p.add_argument("--org-pull", required=True, help="translation CSVs pulled fresh from the org")
            p.add_argument("--prior-dir", action="append", required=True,
                           help="translation CSVs of an earlier load round (repeatable)")
    T.utf8_console()
    a = ap.parse_args(argv)
    return grey_skipped(a) if a.mode == "grey-skipped" else flag_prior_skips(a)


if __name__ == "__main__":
    sys.exit(main())
