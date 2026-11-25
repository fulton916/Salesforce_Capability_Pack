#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""
Fill the `translation` column of the roundtrip CSVs from Translation Workbench Bilingual
.stf exports — the org's real translation state.

Run it after `to-csv --retrieve-existing`. The two reads cover different ground: the
export reaches picklist values and field labels keyed in ways the local download does not,
and the download reaches layout headings whose export keys carry a positional suffix.
Where both have a value, the export's wins.

Bilingual .stf layout: KEY <tab> SOURCE <tab> TRANSLATION <tab> out-of-date(- or *),
split into TRANSLATED and OUTDATED-AND-UNTRANSLATED sections. Only the TRANSLATED section
carries a translation column.

Usage:
    python prefill_from_stf.py <csv_dir> --stf-dir "bilingual export" [--write]
"""
from __future__ import annotations

import argparse
import csv
import glob
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

_LANG_FROM_NAME = re.compile(r"Bilingual_(.+?)_\d{4}-\d{2}-\d{2}")


def parse_bilingual(path: str) -> dict[str, str]:
    """{key: translation} from the TRANSLATED section of a Bilingual .stf."""
    out: dict[str, str] = {}
    for line in Path(path).read_bytes().decode("utf-8-sig", "replace").splitlines():
        if not line or line.startswith("#") or "\t" not in line:
            continue
        parts = line.split("\t")
        # Untranslated rows carry only KEY<tab>LABEL; a translation needs 3+ columns.
        if len(parts) < 3:
            continue
        key, _source, translation = parts[0], parts[1], parts[2]
        if translation.strip():
            out[key] = translation
    return out


def _base(field: str) -> str:
    """.stf strips the __c suffix from field API names."""
    return field[:-3] if field.endswith("__c") else field


# Task and Event are views over Activity; Salesforce files their custom fields under
# Activity. Same mapping as to_translation._SHARED_FIELD_PARENT.
_SHARED_FIELD_PARENT = {"Task": "Activity", "Event": "Activity"}


def stf_keys(row: dict) -> list[str]:
    """Candidate .stf keys for a roundtrip CSV row, best guess first."""
    t, comp, fld, master = (row.get("type", ""), row.get("component", ""),
                            row.get("field", ""), row.get("masterLabel", ""))
    b = _base(fld)
    # Task and Event are views over Activity and do not own their custom fields, so the
    # .stf files them under Activity while a deploy addresses them as Task / Event. Offer
    # both spellings or every Task/Event row reads as "not addressable" -- a false
    # negative that wrongly condemns rows the org accepts.
    comps = [comp] + ([_SHARED_FIELD_PARENT[comp]] if comp in _SHARED_FIELD_PARENT else [])
    if t == "field-label":
        return [f"CustomField.{c}.{b}.FieldLabel" for c in comps]
    if t == "field-picklist":
        return [f"PicklistValue.{c}.{b}.{master}" for c in comps]
    if t in ("global-value", "standard-value"):
        # A value set is keyed by the SET, not by each field that uses it:
        #   global   -> PicklistValue.<Set>__gvs.<value>        (Color_Set__gvs)
        #   standard -> PicklistValue.Standard.<set>.<value>    (accountContactMultiRoles)
        # The standard form lower-cases the first letter of the set name.
        lower1 = comp[0].lower() + comp[1:] if comp else comp
        return [f"PicklistValue.{comp}__gvs.{master}",
                f"PicklistValue.Standard.{lower1}.{master}",
                f"PicklistValue.{comp}.{master}"]
    if t == "record-type":
        return [f"RecordType.{comp}.{fld}"]
    if t == "validation-rule":
        return [f"ValidationFormula.{comp}.{fld}"]
    if t == "layout-section":
        # Sections are disambiguated by position, so the key ends in _<index>: two
        # sections on one layout can share a label. Resolved by prefix, see PREFIX_TYPES.
        return [f"LayoutSection.{comp}.{fld}.{master}"]
    if t == "custom-label":
        return [f"CustomLabel.{fld}"]
    if t == "quick-action":
        return [f"QuickAction.{fld}"]
    if t == "custom-tab":
        return [f"WebTab.{fld}"]
    if t == "custom-app":
        return [f"CustomApp.{fld}"]
    if t == "report-type":
        return [f"CustomReportType.{fld}.Name"]
    if t == "report-type-section":
        return [f"CrtLayoutSection.{fld}_{master}", f"CrtLayoutSection.{master}"]
    return []


# Types whose .stf key carries a positional suffix, so they match on prefix not equality.
PREFIX_TYPES = {"layout-section", "report-type-section"}


def lookup(row: dict, table: dict[str, str], prefixes: dict[str, str]) -> str | None:
    for k in stf_keys(row):
        if k in table:
            return table[k]
        if row.get("type") in PREFIX_TYPES:
            hit = prefixes.get(k)
            if hit is not None:
                return hit
    return None


def build_prefix_index(table: dict[str, str]) -> dict[str, str]:
    """Map 'KEY' -> translation for keys that really are 'KEY_<index>'.

    Where several indexed keys share a base (the same section label twice on one layout)
    the first is used; they are alternative positions of the same label, so the
    translation is the same.
    """
    out: dict[str, str] = {}
    for k, v in table.items():
        base = re.sub(r"_\d+$", "", k)
        if base != k:
            out.setdefault(base, v)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("csv_dir")
    ap.add_argument("--stf-dir", required=True)
    ap.add_argument("--write", action="store_true",
                    help="Write the translations into the CSVs. Without it, report only.")
    args = ap.parse_args()

    stf = {}
    # Recursive: a Translation Workbench download unzips into a nested folder, so the
    # outer directory is the natural thing to pass. A non-recursive glob finds nothing
    # and every CSV then reports "no matching .stf language".
    for p in glob.glob(os.path.join(args.stf_dir, "**", "Bilingual_*.stf"), recursive=True):
        m = _LANG_FROM_NAME.match(os.path.basename(p))
        if m:
            with open(p, "rb") as fh:
                head = fh.read(400).decode("utf-8-sig", "replace")
            if "Bilingual" not in head:
                sys.exit(f"error: {p} does not look like a Bilingual export (wrong export type?)")
            if m.group(1) in stf:
                sys.exit(f"error: two exports for {m.group(1)}: {os.path.basename(stf[m.group(1)])} "
                         f"and {os.path.basename(p)}. Keep only the latest.")
            stf[m.group(1)] = p
    if not stf:
        sys.exit(f"No Bilingual_*.stf found under: {args.stf_dir}")
    print(f"bilingual exports found: {len(stf)} — {', '.join(sorted(stf))}\n")

    grand = Counter()
    skipped = []
    for csv_path in sorted(Path(args.csv_dir).glob("*.csv")):
        with open(csv_path, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            fieldnames = reader.fieldnames
            rows = list(reader)
        lang = next((l for l in stf if any(f"-{l}/" in r.get("file", "") or
                                           f"/{l}." in r.get("file", "") for r in rows[:50])), None)
        if not lang:
            print(f"   {csv_path.name}: no matching .stf language — skipped")
            skipped.append(csv_path.name)
            continue
        table = parse_bilingual(stf[lang])
        prefixes = build_prefix_index(table)
        hits = Counter(); miss = Counter()
        for r in rows:
            found = lookup(r, table, prefixes)
            if found is not None:
                r["translation"] = found
                hits[r["type"]] += 1
            else:
                miss[r["type"]] += 1
        total_h, total_m = sum(hits.values()), sum(miss.values())
        grand["hit"] += total_h; grand["miss"] += total_m
        print(f"   {csv_path.name:42} lang={lang:6} matched {total_h:5} / {total_h+total_m}")
        if args.write:
            with open(csv_path, "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=fieldnames)
                w.writeheader(); w.writerows(rows)
        if csv_path == sorted(Path(args.csv_dir).glob("*.csv"))[0]:
            print("      by type:")
            for t in sorted(set(hits) | set(miss)):
                print(f"         {t:22} matched {hits[t]:5}  unmatched {miss[t]:5}")
    print(f"\nTOTAL matched {grand['hit']} / {grand['hit'] + grand['miss']}")
    if not args.write:
        print("(report only — pass --write to update the CSVs)")
    if skipped:
        sys.exit(f"error: no Bilingual export for {len(skipped)} CSV(s): {', '.join(skipped)}. "
                 "Export those languages too (Setup → Translation Workbench → Export).")


if __name__ == "__main__":
    main()
