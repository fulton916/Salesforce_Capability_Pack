# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Merge the Custom Labels and UI Labels CSVs into one CSV per language.

Both tabs write the same Salesforce file (translations/<lang>.translation-meta.xml).
to-files builds that file from scratch for each CSV it is given, so if the two tabs
go in as separate CSVs the second silently replaces the first. Merge them first.

Usage:
    python merge_label_csvs.py <custom labels dir> <ui labels dir> <output dir>
"""
import argparse
import csv
import sys
from pathlib import Path

_head, _rest = __doc__.split("\n\n", 1)
_ap = argparse.ArgumentParser(description=_head, epilog=_rest,
                              formatter_class=argparse.RawDescriptionHelpFormatter)
_ap.add_argument("labels_dir", type=Path, help="CSVs split from the Custom Labels tab")
_ap.add_argument("appui_dir", type=Path, help="CSVs split from the UI Labels tab")
_ap.add_argument("out_dir", type=Path, help="folder for the merged CSVs (created if missing)")
_args = _ap.parse_args()
labels, appui, out = _args.labels_dir, _args.appui_dir, _args.out_dir
for folder in (labels, appui):
    if not folder.is_dir():
        sys.exit(f"error: folder not found: {folder}")
in_labels = {p.name for p in labels.glob("*.csv")}
in_appui = {p.name for p in appui.glob("*.csv")}
if not in_labels or not in_appui:
    sys.exit(f"error: no CSV files in {labels if not in_labels else appui}")
for name in sorted(in_labels ^ in_appui):
    print(f"warning: {name} is only in {labels if name in in_labels else appui}",
          file=sys.stderr)
out.mkdir(parents=True, exist_ok=True)
names = sorted(in_labels | in_appui)

for name in names:
    header, rows, counts = None, [], []
    for folder in (labels, appui):
        path = folder / name
        if not path.is_file():
            counts.append(0)
            continue
        with open(path, newline="", encoding="utf-8") as fh:
            reader = csv.reader(fh)
            h = next(reader, None)
            if h is None:
                sys.exit(f"error: {path} is empty")
            if header is None:
                header = h
            elif h != header:
                sys.exit(f"error: header mismatch in {path}")
            part = list(reader)
            counts.append(len(part))
            rows += part
    with open(out / name, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        writer.writerows(rows)
    print(f"{name}: {len(rows)} rows ({counts[0]} custom labels + {counts[1]} app & UI)")
