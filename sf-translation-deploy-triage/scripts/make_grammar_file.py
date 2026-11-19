#!/usr/bin/env python3
"""Build a reviewer-fillable file for the gender / starts-with values a deploy rejected.

Salesforce reports these at the COMPONENT level ("Widget__c-de: Gender is required") and
never names the field, so the error log cannot show what needs answering. This expands each
failing (object, language) into the rows that carry the grammar (by default the renamed
standard fields, CSV type 'standard-field'), and asks one question per row and attribute:

  Gender        per language, only the values Salesforce accepts for THAT language
                (a dropdown in the ANSWER cell)
  Starts with   'Vowel sound' / 'Consonant sound' - the same question as the 'Starts with
                vowel sound' checkbox in Setup > Rename Tabs and Labels

Salesforce reports only the FIRST missing attribute per component, so a language that needs
both (French, Italian) is asked for both at once, whatever the error named.

The value already supplied (from the CSV, or from a previously filled file given with
--known) is carried across and pre-fills ANSWER, so people confirm rather than re-derive.

Usage:
  python make_grammar_file.py deploy.json csv_dir/ --out grammar_values.xlsx
      [--known last_round.xlsx] [--types standard-field,object-label] [--grammar-rules rules.json]
Then: send the file, get it back filled, run apply_grammar_file.py.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import triage_common as T  # noqa: E402

SHEET = "Grammar Values Needed"
HEADERS = ["Object", "Field API Name", "Row Type", "English Label", "Language Code",
           "Language", "Translated Label", "Attribute", "Valid Answers",
           "Previously Supplied", "ANSWER"]
ATTR_LABEL = {"gender": "Gender", "startsWith": "Starts with vowel or consonant sound"}

INSTRUCTIONS = [
    "Gender and starts-with values needed",
    "",
    "Salesforce will not accept a translated label for these rows without a piece of grammar",
    "alongside it. It reports the problem against the whole object, never the field, so this",
    "file expands it into the specific rows that need an answer.",
    "",
    "Fill the yellow ANSWER column. Everything else is reference.",
    "  'Previously Supplied' - an answer already known for this row. ANSWER is pre-filled to",
    "                          match; change it only if it is wrong.",
    "",
    "Gender describes the TRANSLATED WORD, not the English one and not the object.",
    "  Example: German 'Konto' is Neuter (das Konto), but the label 'Rechnungsadresse' is",
    "  Feminine (die Rechnungsadresse). Read the word in 'Translated Label' and judge that.",
    "",
    "Danish, Swedish and Dutch have no Masculine: their common gender maps to Feminine.",
    "Czech, Polish, Russian and Slovak add AnimateMasculine, for living beings.",
    "",
    "'Starts with vowel or consonant sound' is about the SOUND, not the first letter:",
    "  Italian words starting s+consonant, z, gn, ps take 'lo' - answer Consonant sound.",
    "  French mute h (l'heure) is Vowel sound; aspirated h (le hall) is Consonant sound.",
    "",
    "The dropdown only offers values Salesforce accepts for that language.",
    "Please return the file with the ANSWER column completed. Do not change other columns.",
]


def read_known(path: str | None) -> dict[tuple[str, str, str, str], str]:
    """{(object, field, lang, attribute): answer} from a previously filled grammar file."""
    if not path:
        return {}
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[SHEET] if SHEET in wb.sheetnames else wb[wb.sheetnames[0]]
    _hdr, rows = T.sheet_rows(ws)
    out = {}
    for r in rows:
        ans = (r.get("ANSWER") or "").strip()
        attr = "startsWith" if "start" in (r.get("Attribute") or "").lower() else "gender"
        if ans and ans.lower() != "n/a":
            out[(r.get("Object", ""), r.get("Field API Name", ""), r.get("Language Code", ""), attr)] = ans
    return out


def build_rows(failures: list[dict], lang_rows: dict[str, list[dict]], types: set[str],
               rules: dict, known: dict) -> list[list[str]]:
    pairs = T.grammar_pairs(failures)
    out = []
    seen = set()
    for (comp, lang), asked in sorted(pairs.items()):
        for r in lang_rows.get(lang, []):
            if r.get("component") != comp or r.get("type") not in types:
                continue
            fld = r.get("field", "")
            for attr, valid in T.grammar_attrs(lang, rules, asked):
                key = (comp, fld, lang, attr)
                if key in seen:
                    continue
                seen.add(key)
                prev = known.get(key) or (r.get(attr) or "").strip()
                if attr == "startsWith" and prev:
                    prev = T.sw_display(prev)
                out.append([comp, fld, r.get("type", ""), r.get("source", ""), lang,
                            T.LANGUAGE_NAMES.get(lang, lang), r.get("translation", ""),
                            ATTR_LABEL[attr], ", ".join(valid), prev, prev])
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("deploy_json", help="deploy/validate --json output with the grammar failures")
    ap.add_argument("csv_dir", help="translation CSVs that were deployed")
    ap.add_argument("--out", required=True, help="output .xlsx")
    ap.add_argument("--known", help="a previously filled grammar file to pre-fill from")
    ap.add_argument("--types", default="standard-field",
                    help="CSV row types that carry grammar (comma-separated, default standard-field)")
    ap.add_argument("--grammar-rules", help="JSON overriding/extending the per-language rules")
    T.utf8_console()
    a = ap.parse_args(argv)

    import openpyxl
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.datavalidation import DataValidation

    _res, fails, _ok = T.load_deploy(a.deploy_json)
    pairs = T.grammar_pairs(fails)
    print(f"failing (object, language) pairs: {len(pairs)}")
    rows = build_rows(fails, T.load_csv_dir(a.csv_dir), set(a.types.split(",")),
                      T.load_grammar_rules(a.grammar_rules), read_known(a.known))
    covered = {(r[0], r[4]) for r in rows}
    for comp, lang in sorted(set(pairs) - covered):
        print(f"  WARNING: {comp}-{lang} failed on grammar but has no '{a.types}' row in the CSVs")

    st = T.styles()
    wb = openpyxl.Workbook()
    ws0 = wb.active
    ws0.title = "Instructions"
    for line in INSTRUCTIONS:
        ws0.append([line])
    ws0["A1"].font = st["title"]
    ws0.column_dimensions["A"].width = 100

    ws = wb.create_sheet(SHEET)
    ws.append(HEADERS)
    T.style_header(ws)
    ans_col = len(HEADERS)
    for i, row in enumerate(rows, start=2):
        ws.append(row)
        if i % 2 == 0:
            for c in ws[i]:
                c.fill = st["alt_fill"]
        c = ws.cell(row=i, column=ans_col)
        c.fill, c.font = st["act_fill"], st["in_font"]
        valid = [v for v in row[8].split(", ") if v]
        if valid:
            dv = DataValidation(type="list", formula1='"' + ",".join(valid) + '"', allow_blank=True)
            dv.errorTitle, dv.error = "Invalid value", "Pick a value from the list for this language."
            ws.add_data_validation(dv)
            dv.add(c)
    for idx, w in enumerate([22, 30, 14, 26, 10, 20, 30, 22, 40, 18, 18], start=1):
        ws.column_dimensions[get_column_letter(idx)].width = w
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(HEADERS))}{len(rows) + 1}"
    wb.save(a.out)

    pre = sum(1 for r in rows if r[-1])
    print(f"{len(rows)} row(s) needing an answer; {pre} pre-filled from earlier answers")
    print(f"Saved: {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
