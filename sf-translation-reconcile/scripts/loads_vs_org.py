#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""What did earlier load files actually leave live in the org?

For every (item, language) any load file supplies, compare with the org now. Load files
are given oldest first; a later file supersedes an earlier one for the same item.

    LIVE         the org holds the latest load value (spacing-only differences count as live)
    LIVE-OLDER   the org holds an EARLIER load's value - the later one never landed
    NOT LIVE     the org knows the item and holds no translation - the value never landed
    OTHER        the org holds text none of the loads supplied (someone else's edit?)
    UNREADABLE   the org defines the item but no source can show its translation
    NO TARGET    no source knows the item (deleted / renamed since)

NOT LIVE values are redeploy candidates - unless --flags lists the value as known-bad
(wrong language, row shifted, placeholder...). Known-bad values are never candidates, and
those the org is serving live are listed on their own tab.

Load file layout: a sheet with type / component / field / masterLabel columns and
'<Language> Translation' columns (--suffix), or with a column of export keys (--key-col,
e.g. 'CustomField.Account.Region.FieldLabel') instead of the four key columns.

Example:
    python loads_vs_org.py --load "Load 1=loads/load1.xlsx" --load "Load 2=loads/load2.xlsx" \\
        --retrieve read/obj_1 read/vs_labels --stf-dir exports/today --out out/loads_vs_org.xlsx
"""
from __future__ import annotations

import argparse
import collections
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402


def read_load(path, cols, suffix, lang_map, key_col, skip_prefixes):
    """{(item key tuple): {lang: (value, sheet, row)}} plus item metadata."""
    out, meta = collections.defaultdict(dict), {}
    wb = R.open_workbook(path, read_only=True)
    for ws in wb.worksheets:
        rows = ws.iter_rows(values_only=True)
        hdr = list(next(rows, ()) or ())
        idx = {R.s(h).strip(): i for i, h in enumerate(hdr) if h is not None}
        lc = R.lang_columns(hdr, suffix, lang_map)
        if not lc:
            continue
        for rn, r in enumerate(rows, start=2):
            g = lambda name: R.s(r[idx[name]]) if name in idx and idx[name] < len(r) else ""
            if key_col and key_col in idx:
                key = g(key_col).strip()
                if "." not in key:
                    continue
                k = ("KEY", key)
                meta[k] = {"keys": [key], "type": "layout-section" if key.startswith("LayoutSection.") else "",
                           "component": key.split(".")[1] if key.count(".") >= 1 else "", "field": key,
                           "item": "", "english": g(cols["english"]).strip()}
            else:
                typ = g(cols["type"]).strip()
                if typ not in R.ROW_TYPES:
                    continue
                row = {"type": typ, "component": g(cols["component"]), "field": g(cols["field"]),
                       "item": g(cols["item"]), "english": g(cols["english"]).strip()}
                k = ("ROW", typ, row["component"], row["field"], row["item"])
                meta[k] = dict(row, keys=None)
            for i, lang in lc.items():
                v = r[i] if i < len(r) else None
                if v in (None, "") or lang == "en_US":
                    continue
                v = str(v)
                if skip_prefixes and v.startswith(tuple(skip_prefixes)):
                    continue
                out[k][lang] = (v, ws.title, rn)
    wb.close()
    return out, meta


def org_value(org: R.OrgState, lang, m):
    if m.get("keys"):                         # raw export keys
        key = m["keys"][0]
        f = org.stf.get(lang)
        rv = org.ret.vals.get(lang, {}) if org.ret else {}
        if rv.get(key):
            return "held", rv[key], key
        if f and key in f.held:
            return "held", f.held[key], key
        base = R.strip_pos(key)
        if f and base != key and base in f.held_pos:
            return "held", f.held_pos[base], key
        if key in rv or (f and key in f.present) or key in org.universe:
            return "empty", None, key
        return "absent", None, key
    st, v, key, _ = org.lookup(lang, m["type"], m["component"], m["field"], m["item"])
    return st, v, key


def read_flags(path):
    """{(lang, english, value)} -> issue, from a table with columns lang, english, value, issue."""
    out = {}
    for r in R.read_table(path):
        lang, eng, val = (R.s(r.get(c)).strip() for c in ("lang", "english", "value"))
        if lang and val:
            out[(lang, eng, val)] = R.s(r.get("issue")) or "flagged"
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--load", action="append", required=True, metavar="NAME=XLSX",
                    help="a load file; give them oldest first")
    ap.add_argument("--retrieve", nargs="+", default=[])
    ap.add_argument("--stf-dir")
    ap.add_argument("--suffix", default="Translation", help="language column suffix in the load files")
    ap.add_argument("--key-col", help="column holding export keys instead of the four key columns")
    ap.add_argument("--cols", help="column-name overrides, e.g. 'item=Value'")
    ap.add_argument("--lang-map")
    ap.add_argument("--skip-prefix", action="append", default=["Do Not Edit"],
                    help="cell values starting with this are placeholders, not values")
    ap.add_argument("--flags", help="csv/xlsx of known-bad values: lang, english, value, issue")
    ap.add_argument("--out", help="Excel report")
    ap.add_argument("--json", help="JSON of every classified pair")
    a = ap.parse_args(argv)
    R.utf8_stdout()
    lang_map = R.load_lang_map(a.lang_map)
    cols = R.parse_cols(a.cols)
    org = R.OrgState(a.retrieve, a.stf_dir)
    flags = read_flags(a.flags) if a.flags else {}

    supplied = collections.defaultdict(dict)        # (k, lang) -> {load index: (value, sheet, row)}
    meta, names = {}, []
    for n, (name, path) in enumerate(x.partition("=")[::2] for x in a.load):
        names.append(name)
        vals, m = read_load(path, cols, a.suffix, lang_map, a.key_col, a.skip_prefix)
        meta.update(m)
        for k, per in vals.items():
            for lang, v in per.items():
                supplied[(k, lang)][n] = v

    res, by_load = collections.Counter(), collections.defaultdict(collections.Counter)
    tabs = collections.defaultdict(list)
    recs = []
    for (k, lang), loads in supplied.items():
        m = meta[k]
        latest = max(loads)
        val, sheet, rn = loads[latest]
        flag = flags.get((lang, m.get("english", ""), val.strip()))
        st, ov, okey = org_value(org, lang, m)
        if st == "absent":
            cat = "NO TARGET"
        elif st == "unreadable":
            cat = "UNREADABLE"
        elif st == "empty":
            cat = "NOT LIVE"
        elif R.norm_ws(ov) == R.norm_ws(val):
            cat = "LIVE"
        elif any(R.norm_ws(ov) == R.norm_ws(loads[n][0]) for n in loads if n != latest):
            cat = "LIVE-OLDER"
        else:
            cat = "OTHER"
        res[cat + (" (flagged)" if flag else "")] += 1
        by_load[names[latest]][cat] += 1
        rec = {"lang": lang, "type": m.get("type", ""), "component": m.get("component", ""),
               "field": m.get("field", ""), "item": m.get("item", ""), "english": m.get("english", ""),
               "load": names[latest], "sheet": sheet, "row": rn, "value": val, "org": ov or "",
               "older": " | ".join(f"{names[n]}={loads[n][0]}" for n in sorted(loads) if n != latest),
               "key": okey, "flag": flag or "", "cat": cat}
        recs.append(rec)
        if cat == "NOT LIVE" and not flag:
            tabs["Redeploy candidates"].append(rec)
        if flag and cat == "LIVE":
            tabs["Flagged values live"].append(rec)
        if cat == "LIVE-OLDER" and not flag:
            tabs["Later load never landed"].append(rec)
        if cat == "OTHER" and not flag:
            tabs["Org holds other text"].append(rec)

    print(f"(item, language) pairs supplied by {len(names)} load file(s): {len(supplied)}")
    for k, v in res.most_common():
        print(f"  {v:7}  {k}")
    print("\nby latest load:")
    for n in names:
        print(f"  {n}: {dict(by_load[n].most_common())}")
    red = tabs["Redeploy candidates"]
    print(f"\nredeploy candidates (NOT LIVE, not flagged): {len(red)}  "
          f"by lang {dict(collections.Counter(r['lang'] for r in red).most_common())}")
    print(f"flagged values live in the org: {len(tabs['Flagged values live'])}")
    hdr = ["lang", "type", "component", "field", "item", "english", "load", "sheet", "row", "value", "org",
           "older", "key", "flag"]
    if a.out:
        sheets = {"Summary": (["category", "pairs"], [[k, v] for k, v in res.most_common()])}
        for t in ("Redeploy candidates", "Flagged values live", "Later load never landed", "Org holds other text"):
            data = sorted(tabs[t], key=lambda x: (x["component"], x["field"], x["item"], x["lang"]))
            sheets[t] = (hdr, [[r[h] for h in hdr] for r in data])
        R.write_xlsx(a.out, sheets)
        print(f"written: {a.out}")
    if a.json:
        R.dump_json({"counts": res, "records": recs}, a.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
