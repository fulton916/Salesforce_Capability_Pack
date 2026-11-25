#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Step 1 of a targeted correction: turn a decisions file into scope.json (exact slot values).

Values are taken EXACTLY as given: no trimming, no case change. Numbers become text and
are reported. Leading/trailing spaces, double spaces, non-breaking spaces and line breaks
are listed as warnings so someone decides on them before anything is built.

Two input shapes:

  long (default)  one row per (slot, language). Columns (rename with --col KEY=Header):
                  lang, type, object, field, item, value
                  optional: gender, startsWith, english, decision
  wide (--wide)   one row per item with type / component / field / masterLabel columns and
                  '<Language> <suffix>' value columns (default suffix 'Translation');
                  standard-field rows may add '<Language> Gender' / '<Language> Starts with'.

Decisions (long shape, --decision-col): a cell matching --approve keeps the row's value;
blank or matching --hold makes the row a HOLD; anything else is a HOLD with a warning,
unless --comment-is-value, which takes the decision text itself as the value.

The scope is refused (exit 2, nothing written) when one slot gets two different values,
or a row has an unknown type or language. One slot = (lang, stored object, type, field,
item); Task/Event fields are stored under Activity, so a Task row and an Event row for the
same field are the same slot and must agree.

Example:
    python scope.py decisions.xlsx --out run/scope.json
    python scope.py review.xlsx --wide --sheet "Fields" --out run/scope.json
    python scope.py conflicts.xlsx --decision-col Comment --approve ok approved --out run/scope.json
"""
from __future__ import annotations

import argparse
import collections
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402
from slots import SLOT_TYPES, slot_id  # noqa: E402

LONG_COLS = {"lang": "lang", "type": "type", "obj": "object", "field": "field", "item": "item",
             "value": "value", "gender": "gender", "startsWith": "startsWith", "english": "english",
             "decision": "decision"}


def text(v, where, warn):
    if v is None or v == "":
        return None
    if not isinstance(v, str):
        warn.append(f"{where}: non-text cell {v!r} taken as {str(v)!r}")
    return str(v)


def ws_warnings(v):
    out = []
    if v != v.strip():
        out.append("leading/trailing whitespace")
    if "  " in v:
        out.append("double space")
    if " " in v:
        out.append("non-breaking space")
    if "\r" in v or "\n" in v:
        out.append("line break")
    return out


def read_long(a, lang_map, warn):
    cols = dict(LONG_COLS)
    for x in a.col or []:
        k, _, v = x.partition("=")
        if k not in cols:
            R.die(f"--col: unknown key {k!r} (known: {', '.join(cols)})")
        cols[k] = v
    out = []
    for r in R.read_table(a.decisions, a.sheet):
        where = f"row {r['__row__']}"
        g = lambda k: r.get(cols[k])
        lang = R.s(g("lang")).strip()
        if not lang and not R.s(g("type")).strip():
            continue
        lang = lang_map.get(lang.lower(), lang)
        d = {"id": f"{Path(a.decisions).name}!{r['__row__']}:{lang}", "row": r["__row__"], "lang": lang,
             "type": R.s(g("type")).strip(), "obj": R.s(g("obj")), "field": R.s(g("field")) or None,
             "item": text(g("item"), where, warn), "english": R.s(g("english")) or None,
             "value": text(g("value"), where, warn)}
        if g("gender"):
            d["gender"] = R.s(g("gender")).strip()
        if g("startsWith"):
            d["startsWith"] = R.s(g("startsWith")).strip()
        if a.decision_col:
            c = R.s(r.get(a.decision_col)).strip()
            if c.lower() in a.approve:
                d["decision"] = "approve"
            elif not c or c.lower() in a.hold or c.lower().startswith(tuple(a.hold_prefix)):
                d["decision"], d["value"] = "HOLD", None
            elif a.comment_is_value:
                d["decision"], d["value"] = "value given", c
            else:
                d["decision"], d["value"] = "HOLD", None
                warn.append(f"{where}: decision {c!r} not recognised - held")
        out.append(d)
    return out


def read_wide(a, lang_map, warn):
    cols = R.parse_cols(a.cols)
    out = []
    wb = R.open_workbook(a.decisions, read_only=True)
    sheets = [a.sheet] if a.sheet else wb.sheetnames
    for name in sheets:
        rows = wb[name].iter_rows(values_only=True)
        hdr = list(next(rows, ()) or ())
        idx = {R.s(h).strip(): i for i, h in enumerate(hdr) if h is not None}
        if cols["type"] not in idx:
            continue
        val_cols = R.lang_columns(hdr, a.suffix, lang_map)
        extra = {}
        for i, h in enumerate(hdr):
            code, rest = R.split_lang_header(h, lang_map)
            if code and rest == "Gender":
                extra[(code, "gender")] = i
            elif code and rest.startswith("Starts with"):
                extra[(code, "startsWith")] = i
        for rn, r in enumerate(rows, start=2):
            g = lambda k: r[idx[cols[k]]] if cols[k] in idx and idx[cols[k]] < len(r) else None
            typ = R.s(g("type")).strip()
            if typ not in R.ROW_TYPES:
                continue
            for i, lang in val_cols.items():
                v = text(r[i] if i < len(r) else None, f"{name} r{rn} {lang}", warn)
                if v is None:
                    continue
                d = {"id": f"{name}!{rn}:{lang}", "row": rn, "sheet": name, "lang": lang, "type": typ,
                     "obj": R.s(g("component")), "field": R.s(g("field")) or None,
                     "item": text(g("item"), f"{name} r{rn}", warn), "english": R.s(g("english")) or None,
                     "value": v}
                for (code, attr), j in extra.items():
                    if code == lang and j < len(r) and r[j] not in (None, ""):
                        d[attr] = R.s(r[j]).strip()
                out.append(d)
    wb.close()
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("decisions", help=".xlsx / .xlsm / .csv")
    ap.add_argument("--out", required=True, help="scope.json to write")
    ap.add_argument("--sheet", help="sheet to read (long: default first sheet; wide: default all)")
    ap.add_argument("--wide", action="store_true", help="read '<Language> <suffix>' columns")
    ap.add_argument("--suffix", default="Translation")
    ap.add_argument("--cols", help="wide shape: key column overrides, e.g. 'item=Section'")
    ap.add_argument("--col", action="append", metavar="KEY=Header", help="long shape: column names")
    ap.add_argument("--decision-col", help="long shape: column holding the decision")
    ap.add_argument("--approve", nargs="+", default=["ok", "approved", "change approved", "yes"])
    ap.add_argument("--hold", nargs="+", default=["hold", "no", "keep"])
    ap.add_argument("--hold-prefix", nargs="+", default=["hold"], help="decision text starting with these = HOLD")
    ap.add_argument("--comment-is-value", action="store_true",
                    help="an unrecognised decision text IS the value to send")
    ap.add_argument("--lang-map")
    a = ap.parse_args(argv)
    R.utf8_stdout()
    a.approve = {x.lower() for x in a.approve}
    a.hold = {x.lower() for x in a.hold}
    a.hold_prefix = [x.lower() for x in a.hold_prefix]
    lang_map = R.load_lang_map(a.lang_map)
    warn = []
    S = read_wide(a, lang_map, warn) if a.wide else read_long(a, lang_map, warn)
    codes = set(lang_map.values())
    errors = []
    for d in S:
        if d["type"] not in SLOT_TYPES:
            errors.append(f"{d['id']}: unknown type {d['type']!r}")
        if d["lang"] not in codes:
            errors.append(f"{d['id']}: unknown language {d['lang']!r} (add it with --lang-map)")
        if d.get("decision") != "HOLD" and d["value"] is None:
            errors.append(f"{d['id']}: no value")
        if d["type"] == "standard-field" and not d.get("gender"):
            warn.append(f"{d['id']}: standard-field without a gender - the current gender is kept")
        for w in ws_warnings(d["value"] or ""):
            warn.append(f"{d['id']}: {w} in {d['value']!r}")
    groups = collections.defaultdict(set)
    for d in S:
        if d.get("decision") != "HOLD":
            groups[slot_id(d)].add((d["value"], d.get("gender")))
    conflicts = {k: v for k, v in groups.items() if len(v) > 1}
    for k, v in list(conflicts.items())[:30]:
        errors.append(f"CONFLICT {k}: {sorted(map(str, v))}")
    for w in warn[:200]:
        print("WARN ", w)
    if len(warn) > 200:
        print(f"WARN  ... {len(warn) - 200} more")
    if errors:
        for e in errors[:50]:
            print("ERROR", e)
        R.die(f"{len(errors)} problem(s); scope not written")
    R.dump_json(S, a.out)
    print(f"entries {len(S)} | slots {len(groups)} | holds {sum(d.get('decision') == 'HOLD' for d in S)}")
    print(f"by language/type: {dict(collections.Counter((d['lang'], d['type']) for d in S).most_common(20))}")
    print(f"written: {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
