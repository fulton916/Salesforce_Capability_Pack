#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Manifests for a broad, read-only retrieve of translations WITH their parents.

Used before compare_workbook.py, loads_vs_org.py, pulldown.py and mark_landed.py. A
retrieve returns translation content only for parents named in the same request, so every
manifest names the parents (CustomObject + its Layouts; value sets; CustomLabel etc.)
next to their translations.

Inputs are what `sf org list metadata` says the org has (run these yourself, read-only):

    sf org list metadata --metadata-type CustomObject   --target-org <alias> --json > lists/list_CustomObject.json
    sf org list metadata --metadata-type Layout         --target-org <alias> --json > lists/list_Layout.json
    sf org list metadata --metadata-type GlobalValueSet --target-org <alias> --json > lists/list_GlobalValueSet.json

Scope: every listed object, or only the objects / layouts / value sets a workbook's rows
name (--workbook), or --objects. Objects are split into batches (--batch-size) to keep
each retrieve small. Standard value sets cannot be listed - name them with
--standard-value-sets (or let --workbook name them).

Writes obj_<n>.xml (objects + translations + layouts), vs_labels.xml (value sets, labels,
apps, tabs, quick actions, report types + Translations) and read_scope.json. Retrieve each
manifest into its own folder:

    sf project retrieve start --manifest manifests/obj_1.xml --target-metadata-dir read/obj_1 \\
        --unzip --target-org <alias> --wait 30 --json > read/obj_1.json

Example:
    python read_manifests.py --lists lists --langs de fr it --workbook master.xlsx --out manifests
"""
from __future__ import annotations

import argparse
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402
from slots import package_xml  # noqa: E402


def listed(lists: Path, typ: str) -> set[str]:
    p = lists / f"list_{typ}.json"
    if not p.is_file():
        R.die(f"missing {p} (sf org list metadata --metadata-type {typ} --json)")
    d = R.load_json(p)
    if d.get("status") not in (0, None):
        R.die(f"{p}: status {d.get('status')}")
    res = d.get("result") or []
    return {x["fullName"] for x in (res if isinstance(res, list) else [res])}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lists", required=True, help="folder with list_CustomObject/Layout/GlobalValueSet.json")
    ap.add_argument("--langs", nargs="+", required=True, help="language codes to read")
    ap.add_argument("--workbook", help="scope the read to the items this workbook's rows name")
    ap.add_argument("--cols", help="workbook column-name overrides")
    ap.add_argument("--objects", nargs="+", help="scope to these objects")
    ap.add_argument("--standard-value-sets", nargs="+", default=[])
    ap.add_argument("--batch-size", type=int, default=10)
    ap.add_argument("--api-version", default=R.DEFAULT_API_VERSION)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    org_objs, org_lays, org_gvs = (listed(Path(a.lists), t) for t in ("CustomObject", "Layout", "GlobalValueSet"))
    objs, svs = set(a.objects or []), set(a.standard_value_sets)
    if a.workbook:
        for _s, _r, row, _v in R.iter_rows(a.workbook, R.parse_cols(a.cols)):
            t, c = row["type"], row["component"]
            if t in R.FIELD_TYPES or t in ("record-type", "validation-rule", "layout-section", "web-link",
                                           "standard-field"):
                objs.add(c)
            if t == "standard-value":
                svs.add(c)
    if not objs and not a.workbook:
        objs = set(org_objs)
    if objs & {"Task", "Event"}:
        objs.add("Activity")
    present = sorted(o for o in objs if o in org_objs)
    absent = sorted(objs - org_objs)
    lay_of = {}
    for m in org_lays:
        plain = urllib.parse.unquote(m)
        lay_of.setdefault(plain.split("-", 1)[0], []).append(m)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    batches = [present[i:i + a.batch_size] for i in range(0, len(present), a.batch_size)]
    for n, batch in enumerate(batches, 1):
        T = {"CustomObject": set(batch),
             "CustomObjectTranslation": {f"{o}-{l}" for o in batch for l in a.langs},
             "Layout": {m for o in batch for m in lay_of.get(o, [])}}
        (out / f"obj_{n}.xml").write_text(package_xml(T, a.api_version), encoding="utf-8", newline="\n")
    T = {"GlobalValueSet": set(org_gvs),
         "GlobalValueSetTranslation": {f"{g}-{l}" for g in org_gvs for l in a.langs},
         "CustomLabel": {"*"}, "CustomApplication": {"*"}, "CustomTab": {"*"}, "QuickAction": {"*"},
         "ReportType": {"*"}, "Translations": set(a.langs)}
    if svs:
        T["StandardValueSet"] = set(svs)
        T["StandardValueSetTranslation"] = {f"{v}-{l}" for v in svs for l in a.langs}
    T = {k: v for k, v in T.items() if v}
    (out / "vs_labels.xml").write_text(package_xml(T, a.api_version), encoding="utf-8", newline="\n")
    R.dump_json({"langs": a.langs, "objects": present, "objects_not_in_org": absent,
                 "global_value_sets": sorted(org_gvs), "standard_value_sets": sorted(svs),
                 "batches": len(batches)}, out / "read_scope.json")
    print(f"objects: {len(present)} in the org, {len(absent)} not in the org {absent[:10]}")
    print(f"batches: {len(batches)} | GVS: {len(org_gvs)} | SVS: {len(svs)} | languages: {len(a.langs)}")
    print(f"written to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
