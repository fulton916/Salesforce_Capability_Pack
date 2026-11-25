#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""
Verify that a load file actually landed in the org, by checking every filled
translation cell against a Translation Workbench Bilingual .stf export.

Why this exists: a clean deploy report does NOT mean the data is live. The Bilingual
export is an independent read taken by Salesforce itself, so it is the check.

It also resolves the Task/Event -> Activity keying difference: Task and Event are
views over Activity and do not own their custom fields, so a row the workbook keys
as `Task.Status__c` is filed by the org as
`PicklistValue.Activity.Status.<value>`. Without that fallback, many rows can read as
"missing" when they are in fact live.

Usage:
    python verify_load.py <returned workbook>.xlsx \\
        --stf-dir "<folder of Bilingual .stf files taken after the deploy>" \\
        --output verification.xlsx

Buckets per (row, language):
    LANDED     org value == the value in the load file
    DIFFERENT  org holds something else  <- the important one
    MISSING    key exists as a target but has no translation in that language
    NO KEY     could not build an .stf key for the row (report-only, not a defect)
"""
from __future__ import annotations

import argparse
import collections
import glob
import os
import re
import sys

try:
    import openpyxl
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter
except ImportError:
    sys.exit("openpyxl is required: pip install openpyxl")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prefill_from_stf import stf_keys, build_prefix_index, PREFIX_TYPES  # noqa: E402
from to_translation import read_field  # noqa: E402
from sf_languages import code_for  # noqa: E402
from toolkit_settings import BANNER_TEXTS  # noqa: E402

from pathlib import Path


def gvs_keys(row: dict, default_dir: Path, cache: dict) -> list[str]:
    """.stf keys for a picklist row whose field is backed by a global value set.

    A GVS-backed field's values are filed under the SET, not the field:
    `PicklistValue.<Set>__gvs.<label>`. Without this, every value of such a field
    reads as unverifiable — on a large object that can be a thousand rows. read_field resolves
    Task/Event through Activity, so it works for those too.
    """
    if row.get("type") != "field-picklist" or not row.get("masterLabel"):
        return []
    obj, fld = row.get("component", ""), row.get("field", "")
    ck = (obj, fld)
    if ck not in cache:
        try:
            meta = read_field(default_dir, obj, fld)
            cache[ck] = (meta or {}).get("value_set_name")
        except Exception:
            cache[ck] = None
    vs = cache[ck]
    return [f"PicklistValue.{vs}__gvs.{row['masterLabel']}"] if vs else []

_LANG_RE = re.compile(r"Bilingual_(.+?)_\d{4}-\d{2}-\d{2}")

# Header language names map to codes through sf_languages.code_for (any language).


def parse_bilingual(path: str) -> dict[str, str]:
    """{key: translation} from the TRANSLATED section of a Bilingual .stf."""
    out: dict[str, str] = {}
    with open(path, "rb") as fh:
        text = fh.read().decode("utf-8-sig", "replace")
    for line in text.splitlines():
        if not line or line.startswith("#") or "\t" not in line:
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        if parts[2].strip():
            out[parts[0]] = parts[2]
    return out


def load_stf(stf_dir: str) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    used: dict[str, str] = {}
    for p in sorted(glob.glob(os.path.join(stf_dir, "**", "Bilingual_*.stf"), recursive=True)):
        m = _LANG_RE.match(os.path.basename(p))
        if m:
            if m.group(1) in used:
                sys.exit(f"error: two exports for {m.group(1)} in {stf_dir} "
                         f"({os.path.basename(used[m.group(1)])}, {os.path.basename(p)}); "
                         "keep only the one taken after the deploy")
            used[m.group(1)] = p
            out[m.group(1)] = parse_bilingual(p)
    for code, p in sorted(used.items()):
        print(f"  {code}: {os.path.basename(p)}")
    return out


def all_keys(stf_dir: str) -> set[str]:
    """Every key seen in any language — used to tell MISSING from NO KEY."""
    seen: set[str] = set()
    for p in glob.glob(os.path.join(stf_dir, "**", "Bilingual_*.stf"), recursive=True):
        with open(p, "rb") as fh:
            text = fh.read().decode("utf-8-sig", "replace")
        for line in text.splitlines():
            if line and not line.startswith("#") and "\t" in line:
                seen.add(line.split("\t")[0])
    return seen


def resolve(row: dict, table: dict[str, str], pidx: dict[str, str],
            default_dir: Path, vs_cache: dict):
    """(value, key) for the first .stf key that hits, else (None, candidate_keys)."""
    ks = stf_keys(row) + gvs_keys(row, default_dir, vs_cache)
    for k in ks:
        if k in table:
            return table[k], k
        if row.get("type") in PREFIX_TYPES and k in pidx:
            return pidx[k], k
    return None, ks


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("load_file")
    ap.add_argument("--stf-dir", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--sheet", default=None,
                    help="Worksheet to verify (default: every sheet with a 'field' column)")
    ap.add_argument("--project-dir", default=".",
                    help="Project root holding force-app/main/default, used to look up "
                         "which picklist fields are global-value-set backed.")
    args = ap.parse_args()

    default_dir = Path(args.project_dir) / "force-app" / "main" / "default"
    vs_cache: dict = {}

    print(f"Reading .stf exports from: {args.stf_dir}")
    stf = load_stf(args.stf_dir)
    universe = all_keys(args.stf_dir)
    pidx = {L: build_prefix_index(t) for L, t in stf.items()}
    print(f"  {len(stf)} languages, {len(universe):,} distinct keys\n")

    wb = openpyxl.load_workbook(args.load_file, read_only=True, data_only=True)
    sheets = [args.sheet] if args.sheet else wb.sheetnames

    landed, different, missing, nokey = [], [], [], []
    not_checked: list[str] = []
    per_lang = collections.defaultdict(collections.Counter)

    for name in sheets:
        ws = wb[name]
        hdr = [c.value for c in next(ws.iter_rows(min_row=1, max_row=1))]
        cols = {h: i for i, h in enumerate(hdr) if h}
        # The UI Labels tab names its key columns "API Name" / "Section" and has no
        # object; its rows are keyed under the "(global)" component, as in the pull CSVs.
        ui_tab = "field" not in cols and "API Name" in cols
        if "field" not in cols and not ui_tab:
            print(f"[{name}] skipped: not a Fields/Custom Labels-shaped tab "
                  "(object names and renamed fields are not in a Bilingual export)")
            continue
        langcols = {}
        for h, i in cols.items():
            hs = str(h)
            if hs.endswith(" Translation") and not hs.endswith(("Singular Translation",
                                                                "Plural Translation")):
                code = code_for(hs[:-len(" Translation")])
                if not code:
                    not_checked.append(f"{name}: column {hs!r} (unknown language)")
                elif code not in stf:
                    not_checked.append(f"{name}: {code} (no export for it in {args.stf_dir})")
                else:
                    langcols[code] = i
        if not langcols:
            continue
        print(f"[{name}] {len(langcols)} languages mapped")

        ti, ci, fi = cols.get("type"), cols.get("component"), cols.get("field")
        mi = cols.get("masterLabel")
        if ui_tab:
            ci, fi, mi = None, cols.get("API Name"), cols.get("Section")
        for rn, r in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
            g = lambda i: ("" if i is None or i >= len(r) or r[i] is None else str(r[i]).strip())
            row = {"type": g(ti), "component": "(global)" if ui_tab else g(ci),
                   "field": g(fi), "masterLabel": g(mi)}
            if not row["field"]:
                continue
            if row["type"].lower() in BANNER_TEXTS:
                continue   # the grey banner row under the headers, not data
            for code, idx in langcols.items():
                val = g(idx)
                if not val:
                    continue
                org, key = resolve(row, stf[code], pidx[code], default_dir, vs_cache)
                rec = (name, rn, row["component"], row["field"], row["masterLabel"],
                       code, val, org if org is not None else "",
                       key if isinstance(key, str) else " | ".join(key))
                if org is None:
                    if isinstance(key, list) and any(k in universe for k in key):
                        missing.append(rec); per_lang[code]["MISSING"] += 1
                    else:
                        nokey.append(rec); per_lang[code]["NO KEY"] += 1
                elif org == val:
                    landed.append(rec); per_lang[code]["LANDED"] += 1
                else:
                    different.append(rec); per_lang[code]["DIFFERENT"] += 1

    tot = len(landed) + len(different) + len(missing) + len(nokey)
    print(f"\n  LANDED     {len(landed):7,}   confirmed live in the org")
    print(f"  DIFFERENT  {len(different):7,}   org holds other text — review")
    print(f"  MISSING    {len(missing):7,}   target exists, no translation")
    print(f"  UNVERIFIED {len(nokey):7,}   could not build an .stf key — NOT a pass")
    print(f"  total      {tot:7,}\n")

    if nokey:
        print(f"  ⚠  {len(nokey):,} cells are UNVERIFIED. This is not evidence they landed —")
        print( "     it means the check could not address them. Treat as unknown, and fix")
        print( "     the key mapping before relying on this report. Most common causes:")
        print( "     layout sections (positional '_N' suffix) and value-set-backed picklists.")
        by = collections.Counter(f"{r[2]}.{r[3]}" for r in nokey)
        for k, n in by.most_common(5):
            print(f"       {k:44} {n:6,}")
        print()
    if missing:
        print(f"  ⚠  {len(missing):,} cells were sent but the org has NO translation.")
        print( "     Check whether the component failed to deploy — a CustomObjectTranslation")
        print( "     is all-or-nothing, so one bad reference discards the whole object.\n")

    HDR = ["Sheet", "Row", "Component", "Field", "Master Label", "Language",
           "Load file value", "Org value", ".stf key"]
    out = openpyxl.Workbook()
    ws = out.active; ws.title = "Summary"
    ws.append(["Language", "LANDED", "DIFFERENT", "MISSING", "UNVERIFIED"])
    for code in sorted(per_lang):
        c = per_lang[code]
        ws.append([code, c["LANDED"], c["DIFFERENT"], c["MISSING"], c["NO KEY"]])
    for tab, rows in (("Different", different), ("Missing", missing),
                      ("Landed", landed), ("Unverified", nokey)):
        s = out.create_sheet(tab)
        s.append(HDR)
        for rec in rows:
            s.append(list(rec))
    for s in out:
        for cell in s[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="1F3864")
        for i, col in enumerate(s.columns, start=1):
            w = max((len(str(c.value or "")) for c in col), default=10)
            s.column_dimensions[get_column_letter(i)].width = min(w + 2, 60)
    out.save(args.output)
    print(f"Written: {args.output}")

    if not_checked:
        print()
        print("  NOT CHECKED (no pass for these):")
        for x in not_checked:
            print(f"     {x}")

    # Exit non-zero unless every sent cell was positively confirmed. A report that
    # cannot address a row, or a language it could not check, must not read as a pass.
    if missing or nokey or not_checked:
        sys.exit(2)


if __name__ == "__main__":
    main()
