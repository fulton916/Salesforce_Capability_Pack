#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Step 4 (and 6 with --build): find every scoped slot in the "before" read.

For each scope entry:
    SAME       the slot already holds exactly the value (whitespace-exact) - nothing to send
    CHANGE     the slot holds something else, or nothing - will be sent
    NOT FOUND  the slot is not in the read (item missing in this org, or wrong manifest)
    HOLD       held by the scope's decision or by --holds (e.g. from provenance.py)

Writes located.json: the scope plus status, the file, the current value ('current'), the
leaf path the proof will check, and for created slots the extra leaves they add.

--build writes the payload: WHOLE translation files from the before read with ONLY the
CHANGE slots' value leaves replaced, a package.xml, and <out>.sha256 (lock.py checks it).
Comments for untranslated items, element order and every other value are kept as read;
a carriage return is written as &#13; so it survives.

--allow-create lets locate add a missing slot to an existing file for: standard-field
(a renamed standard field's singular form + gender), quick-action, and an INACTIVE
global/standard value set value (a retrieve leaves inactive values out of the file).
Without it those slots are NOT FOUND.

Refuses to build (exit 2) when there are NOT FOUND entries (unless --allow-not-found) or
when one slot is given two different values.

Example:
    python locate.py --scope run/scope.json --before run/before --out run/located.json
    python locate.py --scope run/scope.json --before run/before --out run/located.json \\
        --holds run/holds.json --build run/payload
"""
from __future__ import annotations

import argparse
import collections
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402
from slots import (N, Trees, create_slot, field_gender, find_slot, kid, leaf_path,  # noqa: E402
                   package_xml, serialize, slot_id, write_file)


def locate(S, trees: Trees, holds: set, allow_create: bool):
    res = collections.Counter()
    changes = {}                         # slot id -> (rel, element, tag, entry)
    seen = {}                            # slot id -> first entry located for it
    for d in S:
        for k in ("status", "file", "current", "current_gender", "leaf_path", "extra_leaves", "created",
                  "duplicate_of"):
            d.pop(k, None)
        if d.get("decision") == "HOLD" or d.get("id") in holds:
            d["status"] = "HOLD"
            res["HOLD"] += 1
            continue
        sid = slot_id(d)
        if sid in seen:                          # the same slot again (e.g. Task + Event rows)
            prev = seen[sid]
            if (prev["value"], prev.get("gender")) != (d["value"], d.get("gender")):
                R.die(f"slot {sid} is given two values: {prev['value']!r} ({prev['id']}) and "
                      f"{d['value']!r} ({d['id']})")
            for k in ("status", "file", "current", "leaf_path"):
                if k in prev:
                    d[k] = prev[k]
            d["duplicate_of"] = prev["id"]
            res[d["status"] + " (duplicate row)"] += 1
            continue
        seen[sid] = d
        rel, e, tag = find_slot(trees, d)
        extra = []
        if e is None and allow_create:
            made = create_slot(trees, d)
            if made:
                (rel, e, tag), extra = made
                d["created"] = True
        if e is None:
            d["status"] = "NOT FOUND"
            d["file"] = rel
            res["NOT FOUND"] += 1
            continue
        v = e.find(N + tag)
        cur = None if v is None or d.get("created") else (v.text or "")
        d["file"], d["current"] = rel, cur
        d["leaf_path"] = leaf_path(trees.get(rel).getroot(), e, tag)
        if extra:
            d["extra_leaves"] = extra
        same = cur == d["value"]
        if d["type"] == "standard-field":
            g = field_gender(trees, d)
            d["current_gender"] = g
            if d.get("gender") and g != d["gender"]:
                same = False
        if d.get("created"):
            same = False
        d["status"] = "SAME" if same else "CHANGE"
        res[d["status"]] += 1
        if not same:
            changes[sid] = (rel, e, tag, d)
    return res, changes


def build(changes, trees: Trees, out: Path, api_version: str):
    if out.exists():
        shutil.rmtree(out)
    files = set()
    for rel, e, tag, d in changes.values():
        v = e.find(N + tag)
        if v is None:                                   # a slot element without its value leaf
            v = ET.SubElement(e, N + tag)
        for c in list(v):                               # drop the <!-- English --> comment
            v.remove(c)
        v.text = d["value"]
        if d["type"] == "standard-field" and d.get("gender") and not d.get("created"):
            f = kid(trees.get(rel).getroot(), "fields", "name", d["field"])
            g = f.find(N + "gender")
            if g is None:
                R.die(f"{d['id']}: no <gender> element to set on {d['field']}")
            g.text = d["gender"]
        files.add(rel)
    types = collections.defaultdict(set)
    for rel in sorted(files):
        write_file(out / rel, serialize(trees.get(rel)))
        folder, name = rel.split("/", 1)
        types[R.TRANSLATION_FOLDERS[folder]].add(name.rsplit(".", 1)[0])
    write_file(out / "package.xml", package_xml(types, api_version))
    h = R.sha256_dir(out)
    Path(str(out) + ".sha256").write_text(h + "\n", encoding="utf-8")
    return types, h


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scope", required=True, help="scope.json (or a located.json to re-run)")
    ap.add_argument("--before", required=True, help="the before retrieve folder (metadata format)")
    ap.add_argument("--out", required=True, help="located.json to write")
    ap.add_argument("--holds", help="JSON list of entry ids to hold (or objects with an 'id')")
    ap.add_argument("--allow-create", action="store_true", help="create the few slot types that can be created")
    ap.add_argument("--allow-not-found", action="store_true", help="build even with NOT FOUND entries")
    ap.add_argument("--build", metavar="PAYLOAD_DIR", help="write the payload here (replaced if present)")
    ap.add_argument("--api-version", default=R.DEFAULT_API_VERSION)
    a = ap.parse_args(argv)
    R.utf8_stdout()
    S = R.load_json(a.scope)
    holds = set()
    if a.holds:
        holds = {h["id"] if isinstance(h, dict) else h for h in R.load_json(a.holds)}
    trees = Trees(a.before)
    if not any((trees.root / f).is_dir() for f in R.TRANSLATION_FOLDERS):
        R.die(f"{a.before}: no translation folders found - is it a metadata-format retrieve?")
    res, changes = locate(S, trees, holds, a.allow_create)
    for d in S:
        if d["status"] == "NOT FOUND":
            print(f"NOT FOUND  {d['id']}  {d['lang']} {d['type']} {d.get('obj')} {d.get('field')} "
                  f"{d.get('item')!r}  ({d['file']})")
    print(dict(res))
    ch = [d for _r, _e, _t, d in changes.values()]
    print(f"CHANGE slots {len(ch)} | slot empty now (fill) {sum(1 for d in ch if not d['current'])}"
          f" | overwrite of a current value {sum(1 for d in ch if d['current'])}"
          f" | created {sum(1 for d in ch if d.get('created'))}")
    R.dump_json(S, a.out)
    print(f"written: {a.out}")
    if a.build:
        if res["NOT FOUND"] and not a.allow_not_found:
            R.die("NOT FOUND entries: resolve them, hold them, or pass --allow-not-found. No payload built.")
        if not changes:
            R.die("nothing to change - no payload built")
        types, h = build(changes, trees, Path(a.build), a.api_version)
        print(f"payload: { {t: len(v) for t, v in types.items()} } files, {len(changes)} slots")
        print(f"payload sha256 {h} -> {a.build}.sha256")
    return 0


if __name__ == "__main__":
    sys.exit(main())
