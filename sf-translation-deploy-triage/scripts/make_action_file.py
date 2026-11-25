#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Build the reviewer action file for what a deploy still could not load.

Two plain questions, one tab each:

  1. Starts With Needed   For languages that need a "starts with a vowel sound" value next to
                          gender (French, Italian, Hungarian...). Asked as Yes/No, the way
                          Setup > Rename Tabs and Labels shows it (a checkbox), not as the
                          Vowel/Consonant enum the metadata stores. The conversion is done
                          on apply.
  2. Picklist API Names   Picklist keys sent as the DISPLAY LABEL where the org keys the
                          translation by the API name (or the reverse). Each failed key is
                          checked against the field's describe:
                            Already correct              the key matches an API name
                            Sent LABEL - needs API name  a suggestion is ready to confirm
                            NOT FOUND in org             nothing to confirm; a replacement
                                                         value (or DROP) is needed
                          Keys with no translation in any language are left out: they are
                          never written, so they cannot be causing a failure.

Nothing is changed until the file comes back. apply_action_file.py applies it.

Usage:
  python make_action_file.py deploy.json csv_dir/ --describes describes/ --out action.xlsx
  (describes/: `sf sobject describe -s <Object> --json > describes/<Object>.json`)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import triage_common as T  # noqa: E402

TAB1 = "1. Starts With Needed"
TAB2 = "2. Picklist API Names"
H1 = ["Object", "Field API Name", "English Label", "Language Code", "Language",
      "Translated Label", "Q: Does this translated word start with a vowel sound? (Yes/No)"]
H2 = ["Object.Field", "Value Sent", "Status", "Suggested API Name (from org)",
      "Org Display Label", "Q: Use the suggested API name? (Yes/No)",
      "If No, or if NOT FOUND - the value to use instead (or DROP)"]
NOT_FOUND = "NOT FOUND in org"
NEEDS_API = "Sent LABEL - needs API name"


def load_describes(d: str | None) -> dict[str, dict[str, list[dict]]]:
    """{object: {field: [picklistValues]}}"""
    out: dict[str, dict[str, list[dict]]] = {}
    if not d:
        return out
    for p in sorted(Path(d).glob("*.json")):
        try:
            res = (T.load_json_multi(p) or {}).get("result") or {}
        except ValueError:
            continue
        if res.get("fields"):
            out[res.get("name") or p.stem] = {f["name"]: f.get("picklistValues") or []
                                              for f in res["fields"]}
    return out


def startswith_rows(fails, lang_rows, types: set[str]) -> list[list[str]]:
    pairs = {k for k, attrs in T.grammar_pairs(fails, attrs=("startsWith",)).items()}
    rows = []
    for comp, lang in sorted(pairs):
        for r in lang_rows.get(lang, []):
            if r.get("component") == comp and r.get("type") in types:
                rows.append([comp, r.get("field", ""), r.get("source", ""), lang,
                             T.LANGUAGE_NAMES.get(lang, lang), r.get("translation", ""), ""])
    return rows


def picklist_rows(fails, lang_rows, describes) -> tuple[list[list[str]], int, list[str]]:
    bad_fields = sorted({m.group(2).strip() for f in fails
                         for m in [T.PICKLIST_FIELD_RE.search(f.get("problem", "") or "")] if m})
    all_rows = [r for rows in lang_rows.values() for r in rows]
    translated = {(f"{r.get('component')}.{r.get('field')}", r["masterLabel"]) for r in all_rows
                  if r.get("masterLabel") and (r.get("translation") or "").strip()}
    out, seen, inert, no_describe = [], set(), 0, []
    for full in bad_fields:
        obj, _, fname = full.partition(".")
        pv = describes.get(obj, {}).get(fname)
        if pv is None:
            no_describe.append(full)
            continue
        api = {v.get("value", "") for v in pv}
        label2api = {v.get("label", ""): v.get("value", "") for v in pv}
        api2label = {v.get("value", ""): v.get("label", "") for v in pv}
        for r in all_rows:
            if r.get("component") != obj or r.get("field") != fname or not r.get("masterLabel"):
                continue
            val = r["masterLabel"]
            if (full, val) in seen:
                continue
            seen.add((full, val))
            if (full, val) not in translated:
                inert += 1
                continue
            if val in api:
                status, correct = "Already correct", val
            elif val in label2api:
                status, correct = NEEDS_API, label2api[val]
            else:
                status, correct = NOT_FOUND, ""
            out.append([full, val, status, correct, api2label.get(correct, ""), "", ""])
    out.sort(key=lambda r: (r[0], r[2] != NOT_FOUND, r[1]))
    return out, inert, no_describe


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("deploy_json")
    ap.add_argument("csv_dir", help="translation CSVs that were deployed")
    ap.add_argument("--describes", help="folder of `sf sobject describe --json` outputs")
    ap.add_argument("--out", required=True)
    ap.add_argument("--types", default="standard-field",
                    help="CSV row types asked about in tab 1 (comma-separated)")
    ap.add_argument("--intro", default="This file covers what the last deploy could not load.",
                    help="first line of the Instructions tab")
    T.utf8_console()
    a = ap.parse_args(argv)

    import openpyxl
    from openpyxl.styles import Font
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.datavalidation import DataValidation

    _res, fails, _ok = T.load_deploy(a.deploy_json)
    lang_rows = T.load_csv_dir(a.csv_dir)
    sw = startswith_rows(fails, lang_rows, set(a.types.split(",")))
    pk, inert, no_describe = picklist_rows(fails, lang_rows, load_describes(a.describes))
    st = T.styles()

    wb = openpyxl.Workbook()
    ws0 = wb.active
    ws0.title = "Instructions"

    ws1 = wb.create_sheet(TAB1)
    ws1.append(H1)
    T.style_header(ws1)
    dv_sw = DataValidation(type="list", formula1='"Yes,No"', allow_blank=True)
    dv_sw.errorTitle, dv_sw.error = "Invalid value", "Answer Yes or No."
    ws1.add_data_validation(dv_sw)
    for i, row in enumerate(sw, start=2):
        ws1.append(row)
        if i % 2 == 0:
            for c in ws1[i]:
                c.fill = st["alt_fill"]
        c = ws1.cell(row=i, column=7)
        c.fill, c.font = st["act_fill"], st["in_font"]
        dv_sw.add(c)
    for idx, w in enumerate([22, 34, 26, 14, 20, 34, 46], start=1):
        ws1.column_dimensions[get_column_letter(idx)].width = w
    ws1.freeze_panes = "A2"

    ws2 = wb.create_sheet(TAB2)
    ws2.append(H2)
    T.style_header(ws2)
    dv_api = DataValidation(type="list", formula1='"Yes,No"', allow_blank=True)
    ws2.add_data_validation(dv_api)
    for i, row in enumerate(pk, start=2):
        ws2.append(row)
        if i % 2 == 0:
            for c in ws2[i]:
                c.fill = st["alt_fill"]
        if row[2] == NOT_FOUND:
            ws2.cell(row=i, column=3).font = Font(color="C00000", bold=True)
            na = ws2.cell(row=i, column=6, value="n/a")   # nothing to confirm
            na.font = Font(color="808080", italic=True)
        else:
            c = ws2.cell(row=i, column=6)
            c.fill, c.font = st["act_fill"], st["in_font"]
            dv_api.add(c)
        c = ws2.cell(row=i, column=7)
        c.fill, c.font = st["act_fill"], st["in_font"]
    for idx, w in enumerate([30, 40, 30, 32, 32, 18, 34], start=1):
        ws2.column_dimensions[get_column_letter(idx)].width = w
    ws2.freeze_panes = "A2"
    ws2.auto_filter.ref = f"A1:G{len(pk) + 1}"

    notfound = sum(1 for r in pk if r[2] == NOT_FOUND)
    relabel = sum(1 for r in pk if r[2] == NEEDS_API)
    for line in [
        "Action required from reviewers", "", a.intro, "",
        f"TAB 1 - Starts With Needed ({len(sw)} rows)", "",
        "Some languages need one more answer alongside gender: whether the translated word",
        "begins with a vowel SOUND. It controls the article (l' vs le/la in French, l'/lo vs il",
        "in Italian). It is the 'Starts with vowel sound' checkbox in Setup > Rename Tabs and",
        "Labels.   Yes = ticked   No = unticked.   The apply step converts it for Salesforce.",
        "  - Italian words starting with s+consonant, z, gn, ps, x or y take 'lo': answer No.",
        "  - French words with an aspirated h (le hall) take 'le': answer No.",
        "  - French words with a mute h (l'heure) take l': answer Yes.", "",
        f"TAB 2 - Picklist API Names ({len(pk)} rows)", "",
        "These picklist values were sent as DISPLAY LABELS where Salesforce keys the translation",
        "by the API NAME. The translations are fine; only the lookup key is wrong.",
        "  'Q: Use the suggested API name?'  Yes = use it and keep the translation as is.",
        "                                    No  = put the value you DO want in the last column.",
        "  Last column: fill only when you answered No or the row says NOT FOUND.",
        "               Write DROP to remove the row from the load.",
        f"  - {relabel} rows have a suggestion ready. If it looks right, answer Yes.",
        f"  - {notfound} rows say NOT FOUND: the value is not in the org under any name.",
        "    Give the correct value, or write DROP.", "",
        "Nothing will be remapped until you answer. Please return the file with the yellow",
        "cells completed.",
    ]:
        ws0.append([line])
    ws0["A1"].font = st["title"]
    for cell in ws0["A"]:
        if str(cell.value or "").startswith("TAB "):
            cell.font = Font(bold=True, size=12)
    ws0.column_dimensions["A"].width = 100

    wb.save(a.out)
    print(f"Tab 1 (Starts With): {len(sw)} rows")
    print(f"Tab 2 (Picklist):    {len(pk)} rows ({relabel} need API name, {notfound} not found in org)")
    print(f"                     {inert} key(s) left out: no translation in any language")
    if no_describe:
        print(f"WARNING: no describe for {len(no_describe)} field(s); not checked: "
              f"{', '.join(no_describe[:5])}")
    print(f"Saved: {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
