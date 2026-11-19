#!/usr/bin/env python3
"""Pull-down: a review workbook of every translatable value live in an org.

Offline. Reads a metadata-format retrieve that holds BOTH the definitions and their
translations (CustomObject + Layout + CustomObjectTranslation, GlobalValueSet +
GlobalValueSetTranslation, StandardValueSet + StandardValueSetTranslation, CustomLabels +
Translations, and optionally QuickAction / CustomTab / CustomApplication), all in the same
manifest. A Bilingual export (--stf-dir) fills what a retrieve cannot show (inactive
picklist values, some managed-package content) and supplies the English text English users
see.

Rows come from the org's definitions:
    custom field labels and help text, local picklist values, active record types and
    validation rules, layout sections the org owns (customLabel = true; Salesforce-owned
    headings are left out - Salesforce translates those itself and ignores ours), global
    and standard value set values, custom labels (not protected, not URLs / numbers /
    ids / emails), quick actions, tabs, apps.

Columns: type, component, field, masterLabel, English, New, then per language
'<Language> Existing Value' (grey = org value, yellow = no translation) and
'<Language> Translation' (orange, empty - for the reviewer). With --template, rows the
template workbook lacks are marked New and coloured blue, and template rows the org no
longer defines are listed on their own tab.

The output reads straight back into compare_workbook.py --check for an independent check
against a Bilingual export.

Example:
    python pulldown.py --retrieve read/obj_1 read/obj_2 read/vs_labels --stf-dir exports/today \\
        --langs de fr it --template master.xlsx --out out/review.xlsx
"""
from __future__ import annotations

import argparse
import collections
import datetime
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402

NONTEXT = [re.compile(r"^https?://", re.I), re.compile(r"^\d+$"), re.compile(r"^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$"),
           re.compile(r"^[\w.+\-]+@[\w.\-]+\.[a-z]{2,}$", re.I)]
TYPE_ORDER = ["field-label", "field-help", "field-picklist", "record-type", "validation-rule", "layout-section",
              "global-value", "standard-value", "custom-label", "custom-app", "custom-tab", "quick-action"]
TAB_OF = {"custom-label": "Custom Labels", "custom-app": "UI Labels", "custom-tab": "UI Labels",
          "quick-action": "UI Labels"}
KEY_HDR = ["type", "component", "field", "masterLabel", "English", "New"]


def items_from(ret: R.RetrieveRead, include_inactive: bool, include_nontext: bool):
    """(type, component, field, item, english) for every translatable item the org defines."""
    out = []
    for obj, fields in sorted(ret.fields.items()):
        for fn, f in sorted(fields.items()):
            if fn.endswith("__c") and f["label"]:
                out.append(("field-label", obj, fn, "", f["label"]))
                if f["help"]:
                    out.append(("field-help", obj, fn, "", f["help"]))
            for v, active in f["values"].items():
                if active or include_inactive:
                    out.append(("field-picklist", obj, fn, v, v))
        for n, (label, active) in sorted(ret.rts.get(obj, {}).items()):
            if active:
                out.append(("record-type", obj, n, "", label))
        for n, (msg, active) in sorted(ret.vrs.get(obj, {}).items()):
            if active:
                out.append(("validation-rule", obj, n, "", msg))
    for (obj, lay), secs in sorted(ret.layouts.items()):
        for sec in dict.fromkeys(secs):
            out.append(("layout-section", obj, lay, sec, sec))
    for typ, sets in (("global-value", ret.gvs), ("standard-value", ret.svs)):
        for name, vals in sorted(sets.items()):
            for v, active in vals.items():
                if active or include_inactive:
                    out.append((typ, name, "", v, v))
    for name, (eng, protected) in sorted(ret.labels.items()):
        if protected or not eng.strip():
            continue
        if not include_nontext and any(p.match(eng.strip()) for p in NONTEXT):
            continue
        out.append(("custom-label", "(global)", name, "", eng))
    for typ in ("quick-action", "custom-tab", "custom-app"):
        for name, label in sorted(ret.defined_named.get(typ, {}).items()):
            out.append((typ, "(global)", name, "", label))
    return out


def template_keys(path, cols):
    have = set()
    rows = []
    for _sheet, _rn, row, _v in R.iter_rows(path, cols):
        k = (row["type"], R.stored_obj(row["type"], row["component"]), row["field"], row["item"])
        have.add(k)
        rows.append(row)
    return have, rows


def main(argv=None):
    import openpyxl
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--retrieve", nargs="+", required=True, help="metadata-format retrieve folder(s)")
    ap.add_argument("--stf-dir", help="Bilingual export for values a retrieve cannot show")
    ap.add_argument("--langs", nargs="+", help="language codes (default: every non-English language read)")
    ap.add_argument("--template", help="scope/master workbook; rows it lacks are marked New")
    ap.add_argument("--cols", help="template column-name overrides")
    ap.add_argument("--lang-map")
    ap.add_argument("--include-inactive", action="store_true", help="keep inactive picklist values")
    ap.add_argument("--include-nontext", action="store_true", help="keep labels that are URLs, numbers, ids")
    ap.add_argument("--title", default="Org translations - review", help="Read me heading")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    R.utf8_stdout()
    lang_map = R.load_lang_map(a.lang_map)
    org = R.OrgState(a.retrieve, a.stf_dir)
    langs = a.langs or sorted(l for l in org.langs() if l != "en_US")
    items = items_from(org.ret, a.include_inactive, a.include_nontext)
    if not items:
        R.die("the retrieve holds no definitions (CustomObject, Layout, value sets, labels...). "
              "Retrieve definitions and translations in the same manifest.")
    have, trows = template_keys(a.template, R.parse_cols(a.cols)) if a.template else (None, [])

    grey, yellow = PatternFill("solid", fgColor="F2F2F2"), PatternFill("solid", fgColor="FFF2CC")
    orange, blue = PatternFill("solid", fgColor="FCE4D6"), PatternFill("solid", fgColor="DDEBF7")
    head = PatternFill("solid", fgColor="305496")
    white = Font(bold=True, color="FFFFFF")
    wb = openpyxl.Workbook()
    readme = wb.active
    readme.title = "Read me"
    sheets = {}
    stats = collections.defaultdict(collections.Counter)
    unread = collections.Counter()
    new_count = collections.Counter()
    items.sort(key=lambda x: (TAB_OF.get(x[0], "Fields"), x[1], TYPE_ORDER.index(x[0]), x[2], x[3]))
    names = {l: R.lang_name(l, lang_map) for l in ["en_US"] + langs}
    hdr = KEY_HDR + [f"{names['en_US']} Existing Value"]
    for l in langs:
        hdr += [f"{names[l]} Existing Value", f"{names[l]} Translation"]
    for typ, comp, field, item, eng in items:
        tab = TAB_OF.get(typ, "Fields")
        if tab not in sheets:
            ws = wb.create_sheet(tab)
            ws.append(hdr)
            for c in ws[1]:
                c.font, c.fill, c.alignment = white, head, Alignment(wrap_text=True, vertical="center")
            sheets[tab] = ws
        ws = sheets[tab]
        is_new = have is not None and (typ, R.stored_obj(typ, comp), field, item) not in have \
            and not (typ in R.FIELD_TYPES and comp == "Activity"
                     and any((typ, o, field, item) in have for o in ("Task", "Event")))
        st, ev, _k, _src = org.lookup("en_US", typ, comp, field, item)
        english_seen = ev if st == "held" else (org.english_source(typ, comp, field, item) or eng)
        line = [typ, comp, field, item or None, eng, "yes" if is_new else None, english_seen]
        fills = []
        for l in langs:
            st, v, _k, _src = org.lookup(l, typ, comp, field, item)
            if st == "unreadable":
                unread[l] += 1
            stats[l]["translated" if st == "held" else "none"] += 1
            line += [v if st == "held" else None, None]
            fills += [grey if st == "held" else yellow, orange]
        ws.append(line)
        rn = ws.max_row
        if is_new:
            new_count[tab] += 1
            for j in range(1, len(KEY_HDR) + 1):
                ws.cell(rn, j).fill = blue
        for j, f in enumerate(fills, start=len(KEY_HDR) + 2):
            ws.cell(rn, j).fill = f
    for ws in sheets.values():
        ws.freeze_panes = ws.cell(row=2, column=len(KEY_HDR) + 2)
        ws.auto_filter.ref = f"A1:{get_column_letter(ws.max_column)}{ws.max_row}"
        for j in range(1, ws.max_column + 1):
            ws.column_dimensions[get_column_letter(j)].width = 26 if j > 4 else 18
    gone = []
    if a.template:
        for r in trows:
            if org.ret.defines(r["type"], r["component"], r["field"], r["item"]) is False:
                gone.append([r["type"], r["component"], r["field"], r["item"], r["english"]])
        ws = wb.create_sheet("Template rows not in org")
        ws.append(["type", "component", "field", "masterLabel", "English"])
        for g in gone:
            ws.append(g)

    lines = [(a.title, True),
             (f"Built {datetime.date.today():%Y-%m-%d} from a metadata retrieve"
              + (" and a Bilingual export" if a.stf_dir else "") + ".", False),
             ("'<Language> Existing Value' (grey) = what the org shows today; yellow = no translation.", False),
             ("Type in '<Language> Translation' only to add a missing translation or correct a wrong one.", False),
             ("Blue rows (New = yes) are items the org has that the template lacks.", False),
             ("Task and Event fields share one translation, stored under Activity.", False),
             ("Left out: Salesforce-owned layout section headings, inactive picklist values "
              "(unless asked), protected labels.", False), ("", False)]
    for text, bold in lines:
        readme.append([text])
        readme.cell(readme.max_row, 1).font = Font(bold=bold, size=13 if bold else 11)
    readme.append(["Language", "translated", "no translation", "not readable"])
    for c in readme[readme.max_row]:
        c.font, c.fill = white, head
    for l in langs:
        readme.append([names[l], stats[l]["translated"], stats[l]["none"], unread[l]])
    readme.column_dimensions["A"].width = 30
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    wb.save(a.out)
    print(f"rows: { {t: ws.max_row - 1 for t, ws in sheets.items()} }  new vs template: {dict(new_count)}")
    if a.template:
        print(f"template rows the org no longer defines (left out): {len(gone)}")
    print(f"per language translated / none: { {l: (stats[l]['translated'], stats[l]['none']) for l in langs} }")
    print(f"written: {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
