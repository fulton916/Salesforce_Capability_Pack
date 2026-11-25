#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Step 8 (lock 2, optional): a second, independent read of every CHANGE slot from the org's
own Bilingual export, taken AFTER the before read.

The before retrieve says what each slot holds now; the export must agree:
    fill (slot empty in the before read)   the export must list the key as untranslated
    overwrite (slot holds a value)         the export must hold that same value
Anything else is a CONFLICT: the two reads disagree, so the payload may be built on a wrong
picture of the org. Keys the export does not list are UNVERIFIED (some types are never in
an export, e.g. Lightning page tabs; pass them with --skip-types).

Comparison is spacing-insensitive (the export flattens some whitespace); the
whitespace-exact check is the proof against the retrieve.

A language with no translations at all may have no TRANSLATED section in the export; its
keys still show as untranslated, which is correct.

If no export can be taken, say so and record that this lock was skipped - do not
substitute an older export without noting it.

Example:
    python check_export.py --located run/located.json --stf-dir "exports/today"
"""
from __future__ import annotations

import argparse
import collections
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--located", required=True)
    ap.add_argument("--stf-dir", required=True)
    ap.add_argument("--skip-types", nargs="*", default=[], help="types never in an export (counted, not failed)")
    a = ap.parse_args(argv)
    R.utf8_stdout()
    located = R.load_json(a.located)
    stf = R.load_stf_dir(a.stf_dir)
    for lang, f in stf.items():
        if f.truncated:
            R.die(f"{f.path} does not end in a newline - the download looks truncated")
    res = collections.Counter()
    bad = []
    for d in located:
        if d.get("status") != "CHANGE" or d.get("duplicate_of"):
            continue
        if d["type"] in a.skip_types:
            res["skipped (type)"] += 1
            continue
        f = stf.get(d["lang"])
        if f is None:
            res["UNVERIFIED (no export for language)"] += 1
            bad.append(("UNVERIFIED", d, "no export file for this language"))
            continue
        keys = R.stf_keys(d["type"], d.get("obj") or "", d.get("field") or "", d.get("item") or "")
        held, listed = None, False
        for k in keys:
            if k in f.held or (d["type"] in R.PREFIX_TYPES and k in f.held_pos):
                held = f.held.get(k, f.held_pos.get(k))
                listed = True
                break
            if k in f.present or (d["type"] in R.PREFIX_TYPES and k in f.present_pos):
                listed = True
        if not listed:
            res["UNVERIFIED (key not in export)"] += 1
            bad.append(("UNVERIFIED", d, f"none of {keys[:2]} in the export"))
            continue
        cur = d.get("current") or ""
        if not cur and held is None:
            res["agrees (untranslated)"] += 1
        elif cur and held is not None and R.norm_ws(cur) == R.norm_ws(held):
            res["agrees (same value)"] += 1
        else:
            res["CONFLICT"] += 1
            bad.append(("CONFLICT", d, f"before read {cur!r}, export {held!r}"))
    for k, v in sorted(res.items()):
        print(f"  {v:7}  {k}")
    for kind, d, why in bad[:30]:
        print(f"  {kind:10} {d['id']} {d['lang']} {d['type']} {d.get('obj')} {d.get('field')} {d.get('item')!r}: {why}")
    print("LOCK 2", "PASS" if not bad else f"FAIL ({len(bad)})")
    return 2 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
