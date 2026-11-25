#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Split layout-section rows by the ORG's verdict and fill the rendered text.

Consumes `layout_section_verdicts.json` from classify_layout_sections.py, which tests
ownership by rendering each section in a probe language the org has never translated
into (settings.json "probe_language"). That is a
positive test, unlike the `.stf`-absence inference it replaces — which, measured against a real
org, missed Salesforce-owned rows.

Three outcomes, and the third is the honest one:
  editable   -> stays on the main tab; you can translate it
  SF-owned   -> moves to the excluded tab, with the rendered text per language
  UNVERIFIED -> STAYS on the main tab. `describe/layouts` does not expose every section
                (heading drift at runtime, and `Custom Links` is not a detail section),
                so some rows cannot be tested. Nothing is hidden from reviewers
                without evidence.

A real run rebuilds the excluded tab in its send-ready shape and is idempotent: re-running
it on the finished workbook changes no cell value and no fill.

Usage:
    python apply_layout_verdicts.py <workbook>.xlsx --verdicts layout_section_verdicts.json
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import shutil
import sys
from datetime import datetime

try:
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
except ImportError:
    sys.exit("openpyxl is required: pip install openpyxl")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from combine_translations import EXCLUDED_TAB, MAIN_TAB, LANGUAGE_NAMES  # noqa: E402
from sf_languages import code_for, name as lang_name  # noqa: E402

NOTE_TEMPLATE = (
    "Salesforce renders these layout section headings from its own language pack, so they "
    "cannot be translated here: a deploy setting one is accepted and then silently discarded. "
    "Ownership was established by rendering each section in {probe} — a language this org "
    "has not translated into — so a heading that appears in {probe} has a Salesforce string "
    "behind it. The Existing Value columns show what a user of that language sees, read live "
    "from the org; where the text is English, Salesforce has no translation for that "
    "language and English is what is displayed. None of these values can be changed. "
    "NOTE: the rule is per object + layout + section, not per heading name — the same "
    "heading can be yours on a different layout."
)

STATUS_COL = "Layout Section Status"
EVIDENCE_COL = "Evidence"
NOT_READ = " (not read)"
BANNER = "Do Not Edit"
EVIDENCE_JA = "Org rendering (probe language)"
EDITABLE_JA = "Editable (confirmed in org)"
UNVERIFIED = "UNVERIFIED - not confirmed in org"
NAVY, DARK_GREY, LIGHT_GREY, PROBE_GREEN = "1F3864", "808080", "D9D9D9", "E2EFDA"
AMBER = "FFF2CC"


def _is_banner(cells) -> bool:
    filled = [v for v in cells if v not in (None, "")]
    return bool(filled) and all(str(v).startswith(BANNER) for v in filled)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workbook")
    ap.add_argument("--verdicts", default="layout_section_verdicts.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    raw = json.load(open(args.verdicts, encoding="utf-8"))
    meta = raw.get("_meta") if isinstance(raw, dict) else None
    verdicts = raw.get("verdicts") if meta else raw
    if not verdicts:
        sys.exit("verdicts file is empty — refusing to reclassify anything.")
    probed = set(meta["languages"]) if meta else None
    n_edit = sum(1 for v in verdicts.values() if v["editable"])
    print(f"verdicts: {len(verdicts)} sections  ({n_edit} editable, "
          f"{len(verdicts) - n_edit} Salesforce-owned)")
    if meta:
        print(f"  probed languages: {len(probed)}  (probe={meta.get('probe_language')})")
    else:
        print("  WARNING: verdicts file has no _meta block — produced by an older "
              "classify run. Language coverage is unknown.")

    wb = openpyxl.load_workbook(args.workbook)
    ws = wb[MAIN_TAB]
    header = [c.value for c in ws[1]]
    cols = {h: i for i, h in enumerate(header) if h}
    ti, ci, fi, mi = cols["type"], cols["component"], cols["field"], cols["masterLabel"]

    ev_cols = {}
    for h, i in cols.items():
        if str(h).endswith(" Existing Value"):
            lg = code_for(str(h)[:-len(" Existing Value")])
            if lg:
                ev_cols[lg] = i

    # Only write columns the classify run actually probed. A --langs de,fr run applied
    # to a workbook with more languages would otherwise overwrite every other language
    # column with "" on every moved row — real org data lost, reported as success.
    if probed is not None:
        # en_US is never probed; its column is set to the English heading separately below.
        unprobed = sorted(set(ev_cols) - probed - {"en_US"})
        if unprobed:
            print(f"  NOT touching {len(unprobed)} unprobed language column(s): "
                  f"{', '.join(unprobed)}")
    ev_cols = {l: i for l, i in ev_cols.items()
               if l != "en_US" and (probed is None or l in probed)}

    # Rows already parked on the excluded tab must be reconsidered too.
    si = cols.get(STATUS_COL)
    if si is None:
        print(f"  WARNING: {MAIN_TAB} has no {STATUS_COL!r} column. The excluded tab will "
              f"carry no Evidence column, and any parked row this verdicts file does not "
              f"cover has no recorded evidence, so it is returned to {MAIN_TAB}.",
              file=sys.stderr)
    parked = []
    if EXCLUDED_TAB in wb.sheetnames:
        old = wb[EXCLUDED_TAB]
        # Parked rows are read by the MAIN tab's column positions, so the two headers
        # must line up. Prove it rather than assume it.
        norm = [(str(h)[:-len(NOT_READ)] if str(h).endswith(NOT_READ) else h)
                for h in (c.value for c in old[3])]
        norm = [STATUS_COL if h == EVIDENCE_COL else h for h in norm]
        main_h = list(header)
        for h in (norm, main_h):
            while h and h[-1] is None:
                h.pop()
        if norm != main_h:
            bad = [i for i in range(max(len(norm), len(main_h)))
                   if (norm[i] if i < len(norm) else None)
                   != (main_h[i] if i < len(main_h) else None)]
            sys.exit(f"{EXCLUDED_TAB} header does not line up with {MAIN_TAB} at "
                     f"column(s) {bad[:5]} — refusing to reclassify, since the tab is "
                     f"rebuilt from these rows.")
        skipped_banner = 0
        for n, r in enumerate(old.iter_rows(min_row=4, values_only=True), 4):
            if not any(v not in (None, "") for v in r):
                continue
            if ti < len(r) and str(r[ti] or "").strip() == "layout-section":
                parked.append(list(r))
            elif _is_banner(r):
                skipped_banner += 1
            else:
                # The tab is deleted and rebuilt below, so an unrecognised row would be
                # lost without a trace.
                sys.exit(f"{EXCLUDED_TAB} row {n} is neither a layout-section row nor "
                         f"the Do-Not-Edit banner (type={r[ti] if ti < len(r) else None!r})"
                         f" — refusing to rebuild the tab and drop it.")
        print(f"  parked rows read: {len(parked)}  (banner rows skipped: {skipped_banner})")
        del wb[EXCLUDED_TAB]

    keep_rows, move_rows = [], []
    tally = collections.Counter()

    def classify(vals: list):
        g = lambda i: ("" if i >= len(vals) or vals[i] is None else str(vals[i]).strip())
        key = f"{g(ci)}|{g(fi)}|{g(mi)}"
        v = verdicts.get(key)
        if v is None:
            tally["unverified"] += 1
            return "keep", None
        if v["editable"]:
            tally["editable"] += 1
            return "keep", None
        tally["sf-owned"] += 1
        return "move", v

    # existing main-tab rows, bottom-up so deletes stay valid
    for row in list(ws.iter_rows(min_row=2))[::-1]:
        vals = [c.value for c in row]
        g = lambda i: ("" if i >= len(vals) or vals[i] is None else str(vals[i]).strip())
        if g(ti) != "layout-section":
            continue
        what, v = classify(vals)
        if what == "move":
            move_rows.append((vals, v))
            if not args.dry_run:
                ws.delete_rows(row[0].row, 1)

    # Rows parked by a previous pass. A row with no entry in this verdicts file stays
    # parked only if it carries evidence of its own (the deploy probe covers sections
    # describe/layouts cannot see; returning those would silently undo probe-confirmed
    # rows). A row parked on NO evidence — e.g. by the retired .stf-absence
    # filter — goes back to the main tab as UNVERIFIED: nothing is hidden without proof.
    for vals in parked:
        vals = list(vals) + [""] * max(0, len(header) - len(vals))
        g = lambda i: ("" if i >= len(vals) or vals[i] is None else str(vals[i]).strip())
        v = verdicts.get(f"{g(ci)}|{g(fi)}|{g(mi)}")
        if v is None and si is not None and g(si):
            move_rows.append((vals, None))        # stay parked, every cell kept as-is
            tally["parked-no-verdict"] += 1
        elif v is None:
            if si is not None:
                vals[si] = UNVERIFIED
            keep_rows.append((vals, True))
            tally["returned-no-evidence"] += 1
        elif v["editable"]:
            # The probed columns hold Salesforce pack text rendered by an earlier pass,
            # not yours. Blank them rather than present pack text as org state.
            for col in ev_cols.values():
                vals[col] = ""
            if si is not None:
                vals[si] = EDITABLE_JA
            keep_rows.append((vals, False))
            tally["returned-editable"] += 1
        else:
            move_rows.append((vals, v))
            tally["sf-owned"] += 1

    print(f"\n  editable (stay)      : {tally['editable']}")
    print(f"  Salesforce-owned     : {tally['sf-owned']}")
    print(f"  UNVERIFIED (stay)    : {tally['unverified']}")
    print(f"  parked, no verdict here (left parked): {tally['parked-no-verdict']}")
    print(f"  returning to main tab: {len(keep_rows)}")
    if tally["returned-editable"]:
        print(f"  WARNING: {tally['returned-editable']} parked row(s) are now editable and "
              f"return with their probed Existing Value columns BLANK — the parked values "
              f"were Salesforce pack text. Re-pull to refresh them.", file=sys.stderr)
    if tally["returned-no-evidence"]:
        print(f"  WARNING: {tally['returned-no-evidence']} parked row(s) carried no evidence "
              f"and return to {MAIN_TAB} as {UNVERIFIED!r}.", file=sys.stderr)
    if args.dry_run:
        print("\n(dry run — nothing written)")
        return

    for vals, amber in keep_rows:
        ws.append(vals)
        if amber and si is not None:
            ws.cell(ws.max_row, si + 1).fill = PatternFill("solid", fgColor=AMBER)

    # The excluded tab is what reviewers see, so it is rebuilt in its send-ready shape:
    # Translation columns marked "(not read)" and greyed (nothing loads them), a
    # Do-Not-Edit banner, and the status column carrying the evidence instead.
    ex_header = [EVIDENCE_COL if h == STATUS_COL
                 else (h + NOT_READ if str(h).endswith(" Translation") else h)
                 for h in header]
    tr_cols = [i for i, h in enumerate(header) if str(h).endswith(" Translation")]
    en_col = cols.get(f"{LANGUAGE_NAMES.get('en_US', 'en_US')} Existing Value")

    out = wb.create_sheet(EXCLUDED_TAB)
    probe = (meta or {}).get("probe_language") or "ja"
    out.append([NOTE_TEMPLATE.format(probe=lang_name(probe))])
    out["A1"].font = Font(italic=True, color="7F7F7F")
    out["A1"].alignment = Alignment(wrap_text=False)
    out.append([])
    out.append(ex_header)
    out.append([None if h is None else
                (f"{BANNER} - nothing reads this column" if i in tr_cols else BANNER)
                for i, h in enumerate(ex_header)])
    for i, h in enumerate(ex_header):
        if h is None:
            continue
        hc, bc = out.cell(3, i + 1), out.cell(4, i + 1)
        hc.font = Font(bold=True, color="FFFFFF")
        hc.fill = PatternFill("solid", fgColor=DARK_GREY if i in tr_cols else NAVY)
        bc.font = Font(italic=True, color="595959")
        bc.fill = PatternFill("solid", fgColor=LIGHT_GREY)

    # Rendered rows sorted; rows parked by other evidence (the deploy probe) follow as a
    # block in their existing order, with that evidence highlighted.
    ordered = sorted((t for t in move_rows if t[1] is not None),
                     key=lambda t: (str(t[0][ci]), str(t[0][fi])))
    ordered += [t for t in move_rows if t[1] is None]

    filled = collections.Counter()
    no_label = collections.Counter()
    typed_away = 0
    for vals, v in ordered:
        row = list(vals) + [""] * max(0, len(header) - len(vals))
        if v is not None:
            # Rendered text as the org shows it — including English where Salesforce has no
            # pack string, since that is what the user sees. That relies on classify storing
            # the English render in `labels`; a missing label blanks the cell and is counted
            # in the no_label warning below.
            labels = v.get("labels") or {}
            for lg, col in ev_cols.items():
                row[col] = labels.get(lg) or ""
                if row[col]:
                    filled[lg] += 1
                else:
                    no_label[lg] += 1
            if en_col is not None:
                row[en_col] = row[mi]
            if si is not None:
                row[si] = EVIDENCE_JA
            typed_away += sum(1 for c in tr_cols if row[c] not in (None, ""))
        out.append(row)
        r = out.max_row
        for c in tr_cols:
            out.cell(r, c + 1).fill = PatternFill("solid", fgColor=LIGHT_GREY)
        if v is None and si is not None:
            out.cell(r, si + 1).fill = PatternFill("solid", fgColor=PROBE_GREEN)
    out.freeze_panes = "A5"
    for i, col in enumerate(out.iter_cols(min_row=3, max_row=min(60, out.max_row)), 1):
        w = max((len(str(c.value or "")) for c in col), default=10)
        out.column_dimensions[get_column_letter(i)].width = min(w + 2, 46)

    tot = sum(filled.values())
    print(f"\n  rendered labels filled: {tot:,} cells across {len(filled)} languages")
    top = ", ".join(f"{l}={filled[l]}" for l in sorted(filled, key=lambda x: -filled[x])[:6])
    print(f"    {top}")
    if no_label:
        print(f"  WARNING: {sum(no_label.values())} probed cell(s) had no rendered label "
              f"and are blank: {dict(no_label)}")
    if typed_away:
        print(f"  WARNING: {typed_away} Translation cell(s) on Salesforce-owned rows now "
              f"sit in '(not read)' columns and will NOT be loaded.")

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = f"{os.path.splitext(args.workbook)[0]}_PRE-verdicts_{stamp}.xlsx"
    shutil.copy2(args.workbook, backup)
    wb.save(args.workbook)
    # Row 1 header, row 2 the Do-Not-Edit / To-Populate banner, data from row 3.
    n_main = sum(1 for r in ws.iter_rows(min_row=3, values_only=True)
                 if any(v not in (None, "") for v in r))
    print(f"\nbackup: {backup}")
    print(f"saved : {args.workbook}")
    print(f"  {MAIN_TAB}: {n_main} rows")
    print(f"  {EXCLUDED_TAB}: {len(move_rows)} rows")


if __name__ == "__main__":
    main()
