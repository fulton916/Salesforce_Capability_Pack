#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Overlay a verified retrieve (already converted to source format) onto a local project tree.

Use it after compare_workbook.py has shown the retrieve is the truth, so the local tree
stops carrying stale translations. Overwrite-only:
  * files the retrieve produced replace their local copy (or are added)
  * local files it did NOT produce are left in place and listed - for example managed-
    package field translations, which a retrieve may not return
Dry run by default (counts only). --apply first copies every local file it will replace to
--backup, then writes.

Convert a metadata-format retrieve first:
    sf project convert mdapi --root-dir read/obj_1 --output-dir converted/obj_1

Example:
    python overlay_retrieve.py --src converted --dest force-app/main/default
    python overlay_retrieve.py --src converted --dest force-app/main/default --langs de fr \\
        --apply --backup backups/before_overlay
"""
from __future__ import annotations

import argparse
import collections
import filecmp
import shutil
import sys
from pathlib import Path

FOLDERS = ("objectTranslations", "globalValueSetTranslations", "standardValueSetTranslations", "translations")


def lang_of(rel: Path) -> str:
    """Language of a source-format translation path."""
    top = rel.parts[0]
    name = rel.parts[1] if len(rel.parts) > 1 else rel.name
    if top == "translations":
        return name.split(".", 1)[0]
    return name.split(".", 1)[0].rsplit("-", 1)[-1]


def find_default_dirs(src: Path):
    """Every folder under src that holds one of the translation folders."""
    out = set()
    for f in FOLDERS:
        for p in src.rglob(f):
            if p.is_dir():
                out.add(p.parent)
    return sorted(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="folder holding converted (source-format) retrieves")
    ap.add_argument("--dest", required=True, help="local tree, e.g. force-app/main/default")
    ap.add_argument("--folders", nargs="+", default=list(FOLDERS))
    ap.add_argument("--langs", nargs="+", help="only these languages (default: all)")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--backup", help="where replaced local files are copied first (required with --apply)")
    a = ap.parse_args(argv)
    src, dest = Path(a.src), Path(a.dest)
    if a.apply and not a.backup:
        sys.exit("ERROR: --apply needs --backup")
    plan = []
    for root in find_default_dirs(src):
        for folder in a.folders:
            for p in sorted((root / folder).rglob("*")) if (root / folder).is_dir() else []:
                if not p.is_file():
                    continue
                rel = p.relative_to(root)
                if a.langs and lang_of(rel) not in a.langs:
                    continue
                plan.append((folder, p, dest / rel, rel))
    if not plan:
        sys.exit(f"ERROR: no translation files under {src}")
    stat = collections.Counter()
    covered = set()
    for folder, s, d, rel in plan:
        if folder == "objectTranslations" and len(rel.parts) > 2:
            covered.add(d.parent)
        stat[(folder, "new" if not d.exists() else "identical" if filecmp.cmp(s, d, shallow=False) else "changed")] += 1
    produced = {d.resolve() for _f, _s, d, _r in plan}
    leftover = []
    for cd in sorted(covered):
        if cd.is_dir():
            leftover += [p for p in sorted(cd.iterdir()) if p.is_file() and p.resolve() not in produced]
    for folder in a.folders:
        print(f"  {folder:30} new={stat[(folder, 'new')]:6} changed={stat[(folder, 'changed')]:6} "
              f"identical={stat[(folder, 'identical')]:6}")
    kinds = collections.Counter("managed (ns__)" if p.name.count("__") >= 2 else "unmanaged" for p in leftover)
    print(f"  local files in covered folders NOT produced by the retrieve (left in place): {dict(kinds)}")
    for p in leftover[:8]:
        print(f"     e.g. {p}")
    if not a.apply:
        print("\n(dry run - nothing written; add --apply --backup DIR)")
        return 0
    backup = Path(a.backup)
    for _f, _s, d, rel in plan:
        if d.exists():
            (backup / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(d, backup / rel)
    for _f, s, d, _r in plan:
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(s, d)
    print(f"\nAPPLIED: {len(plan)} files written into {dest}; replaced files backed up in {backup}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
