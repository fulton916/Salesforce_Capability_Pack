# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Turn a translation workbook or CSV into source.json, the one input build_push.py reads.

The input is never edited. Two layouts are accepted:

  long (default)  one row per value: a language column, a key column and a value column
                    Language | Key                                   | Value
                    de       | CustomField.Widget__c.Color.FieldLabel | Farbe
  wide (--wide)   one row per key, one column per language (header from --wide-header)
                    Key                                   | de    | fr
                    CustomField.Widget__c.Color.FieldLabel | Farbe | Couleur

Keys use the Translation Workbench (.stf) spelling (see translib.py for the supported key types).
Blank values are ignored (a blank never clears anything). Outer whitespace is stripped unless
--keep-outer-space is given (Salesforce trims some types on save, so a stray space would read back
as a difference).

--overrides <json> applies approved corrections without editing the input:
    [{"lang": "de", "key": "...", "expect": "<value the input holds now>", "value": "<replacement>"}]
Each override must find exactly the row it names holding exactly "expect"; anything else stops the
run, so a re-sorted or already-fixed input never gets a guess written into the wrong place.

    python make_source.py --input translations.xlsx --sheet "Translations" --out source.json
    python make_source.py --input wide.csv --wide --langs de,fr --out source.json
Exit 2 on conflicting duplicates, a bad override, or no rows.
"""
import argparse
import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import translib as L  # noqa: E402


def read_table(path, sheet=None):
    """[(row_number, {header: value})] from a .csv/.tsv or .xlsx/.xlsm file."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".csv", ".tsv", ".txt"):
        with open(path, encoding="utf-8-sig", newline="") as f:
            rows = list(csv.reader(f, delimiter="\t" if ext == ".tsv" else ","))
    elif ext in (".xlsx", ".xlsm"):
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        ws = wb[sheet] if sheet else wb.worksheets[0]
        rows = [["" if v is None else str(v) for v in r] for r in ws.iter_rows(values_only=True)]
    else:
        raise SystemExit(f"{path}: unsupported file type {ext} (use .csv, .tsv, .xlsx or .xlsm)")
    if not rows:
        raise SystemExit(f"{path}: empty")
    hdr = [h.strip() for h in rows[0]]
    return hdr, [(i + 2, dict(zip(hdr, r))) for i, r in enumerate(rows[1:])]


def main(argv=None):
    L.utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, help=".csv, .tsv, .xlsx or .xlsm")
    ap.add_argument("--sheet", help="worksheet name (xlsx; default: the first sheet)")
    ap.add_argument("--out", default="source.json")
    ap.add_argument("--lang-col", default="Language")
    ap.add_argument("--key-col", default="Key")
    ap.add_argument("--value-col", default="Value")
    ap.add_argument("--wide", action="store_true", help="one column per language")
    ap.add_argument("--langs", help="comma-separated language codes (required with --wide; a filter otherwise)")
    ap.add_argument("--wide-header", default="{lang}", help='header of a language column, e.g. "{lang} Translation"')
    ap.add_argument("--keep-outer-space", action="store_true")
    ap.add_argument("--overrides", help="json list of {lang, key, expect, value}")
    a = ap.parse_args(argv)

    hdr, table = read_table(a.input, a.sheet)
    langs = [x.strip() for x in a.langs.split(",") if x.strip()] if a.langs else None
    if a.key_col not in hdr:
        raise SystemExit(f"no column {a.key_col!r} in {a.input} (columns: {hdr})")
    raw = []                                        # (lang, key, value, origin)
    if a.wide:
        if not langs:
            raise SystemExit("--wide needs --langs")
        cols = {l: a.wide_header.format(lang=l) for l in langs}
        missing = [c for c in cols.values() if c not in hdr]
        if missing:
            raise SystemExit(f"no column(s) {missing} in {a.input}")
        for n, r in table:
            for l, c in cols.items():
                raw.append((l, (r.get(a.key_col) or "").strip(), r.get(c) or "", f"row {n} col {c}"))
    else:
        for c in (a.lang_col, a.value_col):
            if c not in hdr:
                raise SystemExit(f"no column {c!r} in {a.input} (columns: {hdr})")
        for n, r in table:
            l = (r.get(a.lang_col) or "").strip()
            if langs is None or l in langs:
                raw.append((l, (r.get(a.key_col) or "").strip(), r.get(a.value_col) or "", f"row {n}"))

    rows, stripped, blank, nokey = {}, 0, 0, 0
    problems = []
    for l, k, v, origin in raw:
        if not v.strip():
            blank += 1
            continue
        if not k or not l:
            nokey += 1
            problems.append(f"{origin}: value without a language or key")
            continue
        if not a.keep_outer_space and v != v.strip():
            v, stripped = v.strip(), stripped + 1
        prev = rows.get((l, k))
        if prev and prev["value"] != v:
            problems.append(f"{l} {k}: two different values ({prev['origin']}: {prev['value']!r}; {origin}: {v!r})")
            continue
        rows[(l, k)] = {"lang": l, "key": k, "value": v, "origin": origin}

    applied = []
    if a.overrides:
        for o in L.load_json(a.overrides):
            r = rows.get((o["lang"], o["key"]))
            if r is None:
                problems.append(f"override {o['lang']} {o['key']}: no such row in the input")
            elif r["value"] != o["expect"]:
                problems.append(f"override {o['lang']} {o['key']}: input holds {r['value']!r}, not the expected {o['expect']!r}")
            else:
                r["value"], r["override"] = o["value"], {"was": o["expect"]}
                applied.append(o)

    # Task and Event rows for one field are one stored value (under Activity): they must agree
    by_norm = {}
    for (l, k), r in rows.items():
        nk = (l, L.norm_key(k))
        if nk in by_norm and by_norm[nk]["value"] != r["value"]:
            problems.append(f"{l} {k} and {by_norm[nk]['key']}: one Activity slot, two values "
                            f"({r['value']!r} / {by_norm[nk]['value']!r}) - decide one")
        by_norm.setdefault(nk, r)

    out = {"input": os.path.abspath(a.input), "input_sha256": L.file_sha256(a.input), "sheet": a.sheet,
           "overrides_applied": applied, "rows": sorted(rows.values(), key=lambda r: (r["lang"], r["key"]))}
    L.dump_json(out, a.out)
    print(f"rows: {len(out['rows'])}  languages: {sorted({r['lang'] for r in out['rows']})}")
    print(f"blank values ignored: {blank}  outer whitespace stripped: {stripped}  overrides applied: {len(applied)}")
    for p in problems[:20]:
        print("   PROBLEM:", p)
    if problems or not out["rows"]:
        print("RESULT: FAIL" + ("" if out["rows"] else " (no rows)"))
        return 2
    print(f"RESULT: PASS -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
