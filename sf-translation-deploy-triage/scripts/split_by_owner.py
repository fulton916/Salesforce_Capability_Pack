#!/usr/bin/env python3
"""Re-cut a triage workbook so each tab names the party that has to act.

Different problems look alike in a raw deploy log. An encoding defect and a deleted
picklist value both surface as "Invalid picklist value", but they have different owners:
damaged key text is the developer's to repair (nothing the reviewers did caused it and
nothing they can do fixes it), while a value that is gone needs a reviewer's decision. A
workbook ordered by error type makes every reader scan every tab for their own rows.

This reads the workbook written by triage_deploy_errors.py and groups every row by the
party named in its 'Who Must Act' column (the text before ' - '). One tab per party, or
per party and category with --per-category, plus a Summary that says what each party has
to do. Party tabs are colour-coded. The input workbook is not modified.

Usage:
  python split_by_owner.py errors.xlsx [--out errors_by_owner.xlsx] [--per-category]
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import triage_common as T  # noqa: E402

COLOURS = ["1F3864", "C55A11", "548235", "7030A0", "808080", "BF8F00"]


def party_of(who: str) -> str:
    return (who or "").split(" - ", 1)[0].strip() or "Unassigned"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workbook", help="triage workbook (from triage_deploy_errors.py)")
    ap.add_argument("--out", help="output .xlsx (default: <workbook>_by_owner.xlsx)")
    ap.add_argument("--per-category", action="store_true",
                    help="one tab per party AND category instead of one per party")
    ap.add_argument("--order", action="append", default=[],
                    help="party names in tab order (repeatable). Others follow by row count.")
    ap.add_argument("--title", default="Outstanding translation work, by who has to act")
    T.utf8_console()
    a = ap.parse_args(argv)

    import openpyxl
    from openpyxl.utils import get_column_letter

    src = Path(a.workbook)
    out = Path(a.out) if a.out else src.with_name(f"{src.stem}_by_owner.xlsx")
    if out.resolve() == src.resolve():
        sys.exit("error: --out must differ from the input workbook")

    wb_in = openpyxl.load_workbook(src, read_only=True, data_only=True)
    headers: list[str] = []
    rows_by_party: dict[str, list[dict]] = defaultdict(list)
    for ws in wb_in.worksheets:
        hdr, rows = T.sheet_rows(ws)
        if "Who Must Act" not in hdr:
            continue
        if not headers:
            headers = ["Category"] + hdr
        for r in rows:
            r["Category"] = ws.title
            rows_by_party[party_of(r.get("Who Must Act", ""))].append(r)
    if not rows_by_party:
        sys.exit("error: no tab with a 'Who Must Act' column - is this a triage workbook?")

    parties = [p for p in a.order if p in rows_by_party]
    parties += sorted((p for p in rows_by_party if p not in parties),
                      key=lambda p: (p in ("No action", "Unassigned"), -len(rows_by_party[p])))
    colour = {p: COLOURS[i % len(COLOURS)] for i, p in enumerate(parties)}

    st = T.styles()
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    summary = wb.create_sheet("Summary")
    taken = {"Summary"}
    tab_info: list[tuple[str, str, int, str]] = []      # (tab, party, rows, what to do)

    for p in parties:
        groups = ({cat: [r for r in rows_by_party[p] if r["Category"] == cat]
                   for cat in dict.fromkeys(r["Category"] for r in rows_by_party[p])}
                  if a.per_category else {"": rows_by_party[p]})
        for cat, rows in groups.items():
            name = T.safe_sheet_name(f"{p} - {cat}" if cat else p, taken)
            ws = wb.create_sheet(name)
            ws.sheet_properties.tabColor = colour[p]
            ws.append(headers)
            T.style_header(ws)
            for i, r in enumerate(sorted(rows, key=lambda r: (r["Category"], r.get("Language", ""),
                                                              r.get("Component", ""))), start=2):
                ws.append([r.get(h, "") for h in headers])
                if i % 2 == 0:
                    for c in ws[i]:
                        c.fill = st["alt_fill"]
                if "Who Must Act" in headers:
                    ws.cell(row=i, column=headers.index("Who Must Act") + 1).fill = st["act_fill"]
            for idx, h in enumerate(headers, start=1):
                ws.column_dimensions[get_column_letter(idx)].width = (
                    52 if h in ("Diagnosis", "Error Message") else 26)
            ws.freeze_panes = "A2"
            ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows) + 1}"
            actions = Counter((r.get("Who Must Act", "").split(" - ", 1) + [""])[1] for r in rows)
            todo = "; ".join(f"{act} ({n})" for act, n in actions.most_common(3) if act)
            tab_info.append((name, p, len(rows), todo))

    summary.append([a.title])
    summary["A1"].font = st["title"]
    summary.append([])
    summary.append(["Each tab holds the rows ONE party has to act on, whatever the error type."])
    summary.append(["'No action' rows are listed so the count is complete; they need nothing."])
    summary.append([])
    summary.append(["Tab", "Party", "Rows", "What has to happen"])
    T.style_header(summary, summary.max_row)
    hrow = summary.max_row
    for tab, p, n, todo in tab_info:
        summary.append([tab, p, n, todo])
    summary.append([])
    for p in parties:
        summary.append([f"TOTAL - {p}", "", len(rows_by_party[p]), ""])
        summary.cell(row=summary.max_row, column=1).font = st["bold"]
    for i, w in enumerate([36, 18, 8, 80], start=1):
        summary.column_dimensions[get_column_letter(i)].width = w
    summary.freeze_panes = f"A{hrow + 1}"

    wb.save(out)
    for tab, p, n, _ in tab_info:
        print(f"  {tab:34} {n:5} row(s)")
    print(f"Saved: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
