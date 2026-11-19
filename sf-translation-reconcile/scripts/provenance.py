#!/usr/bin/env python3
"""Step 5: provenance of every value a payload would overwrite.

For each CHANGE slot whose current value is not empty (an overwrite, not a fill):

    PRE-EXISTING  a baseline snapshot (taken before any of our pushes) already held a
                  value in that slot - the value was there before us
    OURS          no baseline held a value, and one of our own deployed payloads wrote
                  exactly the current value - we wrote it, so we may overwrite it
    OTHER         no baseline held a value, and none of our payloads wrote it - someone
                  else wrote it after the baseline
    UNKNOWN       no baseline read covers the slot's file - cannot tell, so treated as
                  PRE-EXISTING

The safe default rule: overwrite only OURS. Every other overwrite is written to the holds
file, unless its entry id is listed in --authority (a file of ids someone with authority
named explicitly, one per line, '#' comments allowed). Re-run locate.py with
--holds <file> before building the payload.

Task/Event: a slot stored under Activity is also looked up in our payloads' Task-<lang> /
Event-<lang> files, because an earlier push may have sent the field under those names.

Baselines and our payloads are metadata-format folders (a retrieve, or a payload folder
built by locate.py --build).

Example:
    python provenance.py --located run/located.json \\
        --baseline snapshot=snapshots/before_first_push --baseline read0=runs/first/before \\
        --ours push1=runs/first/payload --ours push2=runs/second/payload \\
        --holds-out run/holds.json --report run/provenance.xlsx
"""
from __future__ import annotations

import argparse
import collections
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402
from slots import Trees, slot_file, slot_value  # noqa: E402


def named_dirs(items, what):
    out = []
    for x in items or []:
        name, sep, path = x.partition("=")
        if not sep or not Path(path).is_dir():
            R.die(f"{what} must be NAME=EXISTING_DIR, got {x!r}")
        out.append((name, Trees(path)))
    return out


def classify(d, baselines, ours):
    cur = d["current"]
    pre = {}
    covered = False
    for name, t in baselines:
        if t.has(slot_file(d)):
            covered = True
        v = slot_value(t, d)
        if v:
            pre[name] = v
    written = [name for name, t in ours if slot_value(t, d) == cur]
    if not written and d.get("obj") in R.SHARED_PARENT and d["type"] in R.FIELD_TYPES:
        written = [f"{name} (as {d['obj']})" for name, t in ours if slot_value(t, d, as_written_obj=d["obj"]) == cur]
    if pre:
        prov = "PRE-EXISTING"
    elif not covered:
        prov = "UNKNOWN"
    elif written:
        prov = "OURS"
    else:
        prov = "OTHER"
    return prov, pre, written


def read_authority(path):
    if not path:
        return set()
    out = set()
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            out.add(line)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--located", required=True)
    ap.add_argument("--baseline", action="append", required=True, metavar="NAME=DIR",
                    help="a read taken before any of our pushes (repeatable)")
    ap.add_argument("--ours", action="append", default=[], metavar="NAME=DIR",
                    help="a payload we deployed (repeatable)")
    ap.add_argument("--authority", help="file of entry ids explicitly allowed to be overwritten")
    ap.add_argument("--out", help="located.json with provenance added (default: overwrite --located)")
    ap.add_argument("--holds-out", help="write the ids to hold here")
    ap.add_argument("--report", help="Excel report of every overwrite")
    a = ap.parse_args(argv)
    R.utf8_stdout()
    located = R.load_json(a.located)
    baselines = named_dirs(a.baseline, "--baseline")
    ours = named_dirs(a.ours, "--ours")
    allowed = read_authority(a.authority)
    res = collections.Counter()
    holds, rows = [], []
    for d in located:
        for k in ("prov", "baseline_values", "written_by", "overwrite"):
            d.pop(k, None)
        if d.get("status") != "CHANGE" or not d.get("current"):
            continue
        prov, pre, written = classify(d, baselines, ours)
        d["prov"], d["baseline_values"], d["written_by"] = prov, pre, written
        named = d["id"] in allowed
        d["overwrite"] = "allowed (ours)" if prov == "OURS" else "allowed (named)" if named else "HOLD"
        res[(prov, d["overwrite"])] += 1
        if d["overwrite"] == "HOLD":
            holds.append(d["id"])
        rows.append([d["id"], d["lang"], d["type"], d.get("obj"), d.get("field"), d.get("item"), d["current"],
                     d["value"], prov, " | ".join(f"{k}={v}" for k, v in pre.items()), ", ".join(written),
                     d["overwrite"]])
    for (p, o), v in sorted(res.items()):
        print(f"  {v:7}  {p:13} {o}")
    pre_same = sum(1 for d in located if d.get("prov") == "PRE-EXISTING" and d["current"] in d["baseline_values"].values())
    print(f"PRE-EXISTING whose current value equals a baseline value: {pre_same}")
    unused = allowed - {d["id"] for d in located if d.get("prov")}
    if unused:
        print(f"NOTE: {len(unused)} --authority ids are not overwrites in this scope: {sorted(unused)[:5]}")
    R.dump_json(located, a.out or a.located)
    if a.holds_out:
        R.dump_json(holds, a.holds_out)
        print(f"holds ({len(holds)}): {a.holds_out}")
    if a.report:
        hdr = ["id", "lang", "type", "object", "field", "item", "current", "new", "provenance",
               "baseline value", "written by", "overwrite"]
        R.write_xlsx(a.report, {"Overwrites": (hdr, rows)})
        print(f"report: {a.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
