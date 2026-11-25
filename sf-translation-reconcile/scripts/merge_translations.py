#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Copy the translation column from a source CSV into a destination CSV.

Rows are matched on key columns (default: type, component, field, masterLabel). Every
other column of the destination is left exactly as it is. Source values are copied
exactly (not trimmed); a blank source value never overwrites.

Dry run by default; --write updates the destination in place (a .bak copy is kept).

Example:
    python merge_translations.py translated_de.csv pull_de.csv
    python merge_translations.py translated_de.csv pull_de.csv --write
"""
from __future__ import annotations

import argparse
import csv
import shutil
import sys
from pathlib import Path


def read(path: Path):
    with path.open(newline="", encoding="utf-8-sig") as fh:
        r = csv.DictReader(fh)
        if r.fieldnames is None:
            sys.exit(f"ERROR: {path} is empty")
        return list(r.fieldnames), list(r)


def merge(src: Path, dest: Path, keys, col: str, write: bool):
    _sf, src_rows = read(src)
    fields, rows = read(dest)
    for k in list(keys) + [col]:
        if k not in fields:
            sys.exit(f"ERROR: column {k!r} not in {dest}")
    lookup = {}
    for r in src_rows:
        v = r.get(col) or ""
        if v.strip():
            lookup[tuple(r.get(k, "") for k in keys)] = v
    matched = changed = 0
    for r in rows:
        key = tuple(r.get(k, "") for k in keys)
        if key in lookup:
            matched += 1
            if r[col] != lookup[key]:
                changed += 1
                r[col] = lookup[key]
    if write:
        shutil.copy2(dest, dest.with_suffix(dest.suffix + ".bak"))
        with dest.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)
    return matched, changed, len(lookup)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path, help="CSV that carries the translated values")
    ap.add_argument("dest", type=Path, help="CSV to update")
    ap.add_argument("--keys", nargs="+", default=["type", "component", "field", "masterLabel"])
    ap.add_argument("--column", default="translation")
    ap.add_argument("--write", action="store_true", help="update dest in place (default: dry run)")
    a = ap.parse_args(argv)
    for p in (a.src, a.dest):
        if not p.is_file():
            sys.exit(f"ERROR: file not found: {p}")
    matched, changed, n = merge(a.src, a.dest, a.keys, a.column, a.write)
    print(f"source values {n} | matched rows {matched} | changed {changed}"
          + ("" if a.write else "  (dry run - add --write)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
