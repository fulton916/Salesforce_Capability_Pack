"""Review workbook after a no-overwrite push: what the target already held, side by side with what
was requested, for someone to decide on.

Tabs:
  ACTION     every held value (the target holds a different value, or the same with different
             whitespace, or a named overwrite whose "was" no longer matched): requested vs kept,
             with a Decision column (keep current / use requested). A "use requested" decision
             becomes a named overwrite in a later push (named_overwrites.json: lang, key, was).
  Pushed     every value sent (fills and named overwrites), with "live" from verify_push.json if given
  Unplaced   source rows the builder could not place, and why
  Read me    what each tab means

    python review_excel.py --work <dir> --out review.xlsx [--target-label PROD] [--deploy-id <id>]
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import translib as L  # noqa: E402


def main(argv=None):
    L.utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", default=".")
    ap.add_argument("--report", default="push_report.json")
    ap.add_argument("--verify", default="verify_push.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--target-label", default="target org")
    ap.add_argument("--deploy-id", default="")
    a = ap.parse_args(argv)
    import openpyxl
    from openpyxl.styles import Font, PatternFill
    from openpyxl.worksheet.datavalidation import DataValidation
    P = lambda x: x if os.path.isabs(x) else os.path.join(a.work, x)
    rep = L.load_json(P(a.report))
    ver = L.load_json(P(a.verify)) if os.path.isfile(P(a.verify)) else None
    not_live = {(p[0], p[1]) for p in (ver or {}).get("problems", []) if len(p) > 1}

    wb = openpyxl.Workbook()
    bold, head = Font(bold=True), PatternFill("solid", fgColor="DDDDDD")

    def sheet(title, header, rows, widths):
        ws = wb.create_sheet(title)
        ws.append(header)
        for c in ws[1]:
            c.font, c.fill = bold, head
        for r in rows:
            ws.append(r)
        for i, w in enumerate(widths):
            ws.column_dimensions[openpyxl.utils.get_column_letter(i + 1)].width = w
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions
        return ws

    held = sorted(rep.get("held", []), key=lambda h: (h["lang"], h["key"]))
    ws = sheet("ACTION", ["Language", "Translation key", f"Kept ({a.target_label} value)", "Requested", "Why held", "Decision"],
               [[h["lang"], h["key"], h.get("org_value"), h.get("value"),
                 {"HOLD-STALE": "named overwrite, but the target no longer holds the expected value"}.get(
                     h.get("decision"), "whitespace only" if h.get("bucket") == "WHITESPACE ONLY" else "the target already holds a value"),
                 ""] for h in held], [10, 60, 40, 40, 45, 20])
    if held:
        dv = DataValidation(type="list", formula1='"keep current,use requested"', allow_blank=True)
        ws.add_data_validation(dv)
        dv.add(f"F2:F{len(held) + 1}")
    auth = {(x["folder"], x["component"], L.sig_tuple(x["sig"])) for x in rep.get("authorized", [])}
    sheet("Pushed", ["Language", "Translation key", "Value sent", "Kind", "Live after deploy"],
          [[x["lang"], x.get("key"), x["value"],
            "named overwrite" if (x["folder"], x["component"], L.sig_tuple(x["sig"])) in auth else "fill",
            "" if ver is None else ("no" if (x["component"], str(L.sig_tuple(x["sig"]))) in not_live else "yes")]
           for x in rep["targets"]], [10, 60, 50, 16, 16])
    sheet("Unplaced", ["Language", "Translation key", "Value", "Why"],
          [[u["lang"], u["key"], u.get("value"), u.get("why")] for u in rep.get("unplaced", [])], [10, 60, 40, 60])
    rm = wb.worksheets[0]
    rm.title = "Read me"
    for line in [f"No-overwrite translation push to {a.target_label}" + (f", deploy {a.deploy_id}" if a.deploy_id else ""),
                 f"Values sent: {len(rep['targets'])} (fills {rep['counts']['fills']}, named overwrites {rep['counts']['named_overwrites']})",
                 f"Held for review (ACTION): {len(held)}. Nothing on this tab was changed in the org.",
                 "ACTION: choose 'use requested' to overwrite the kept value in a later push, as a named overwrite.",
                 "Pushed: every value sent. Unplaced: rows that could not be placed in the target, and why."]:
        rm.append([line])
    rm.column_dimensions["A"].width = 110
    wb.save(a.out)
    print(f"{a.out}: ACTION {len(held)}, Pushed {len(rep['targets'])}, Unplaced {len(rep.get('unplaced', []))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
