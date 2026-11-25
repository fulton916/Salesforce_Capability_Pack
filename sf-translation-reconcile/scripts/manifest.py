#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Step 2: the package.xml for the "before" read of a scope, in the parent-inclusive shape.

A retrieve returns translation content only for parents named in the SAME manifest, so
each translation file is listed together with its parent:

    CustomObjectTranslation <Obj>-<lang>   + CustomObject <Obj> (+ Layout <Obj>-<Layout> for sections)
    GlobalValueSetTranslation <Set>-<lang> + GlobalValueSet <Set>
    StandardValueSetTranslation            + StandardValueSet
    Translations <lang>                    + CustomLabel / CustomTab / CustomApplication /
                                             ReportType / QuickAction named in the scope

Retrieve it three times with the SAME manifest: before (step 3), pre (lock, just before the
deploy) and after (verify):

    sf project retrieve start --manifest run/manifest.xml --target-metadata-dir run/before \\
        --unzip --target-org <alias> --wait 30 --json > run/before.json

Example:
    python manifest.py run/scope.json --out run/manifest.xml [--api-version 62.0]
"""
from __future__ import annotations

import argparse
import collections
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402
from slots import package_xml  # noqa: E402


def manifest_types(scope) -> dict[str, set]:
    T = collections.defaultdict(set)
    for d in scope:
        o, lang, t, f = d.get("obj") or "", d["lang"], d["type"], d.get("field") or ""
        if t in ("field-label", "field-help", "field-relationship-label", "field-picklist", "record-type",
                 "validation-rule", "web-link", "layout-section", "standard-field"):
            so = R.stored_obj(t, o)
            T["CustomObjectTranslation"].add(f"{so}-{lang}")
            T["CustomObject"].add(so)
            if t == "layout-section":
                T["Layout"].add(f"{o}-{f}")
        elif t == "standard-value":
            T["StandardValueSetTranslation"].add(f"{o}-{lang}")
            T["StandardValueSet"].add(o)
        elif t == "global-value":
            T["GlobalValueSetTranslation"].add(f"{o}-{lang}")
            T["GlobalValueSet"].add(o)
        elif t == "quick-action":
            T["Translations"].add(lang)
            T["QuickAction"].add(f)
            if "." in f:
                ob = f.split(".", 1)[0]
                T["CustomObjectTranslation"].add(f"{ob}-{lang}")
                T["CustomObject"].add(ob)
        elif t in ("custom-label", "custom-tab", "custom-app", "report-type", "report-type-section"):
            T["Translations"].add(lang)
            T[{"custom-label": "CustomLabel", "custom-tab": "CustomTab", "custom-app": "CustomApplication"}
              .get(t, "ReportType")].add(f)
        else:
            R.die(f"unknown type {t!r} in {d.get('id')}")
    return T


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scope", help="scope.json from scope.py")
    ap.add_argument("--out", required=True)
    ap.add_argument("--api-version", default=R.DEFAULT_API_VERSION)
    a = ap.parse_args(argv)
    S = [d for d in R.load_json(a.scope) if d.get("decision") != "HOLD"]
    T = manifest_types(S)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(package_xml(T, a.api_version), encoding="utf-8", newline="\n")
    print({t: len(v) for t, v in sorted(T.items())})
    print(f"written: {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
