#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Step 11: after the deploy, check every scoped slot - and everything else - in a fresh read.

Retrieve with the SAME manifest as the before read (into run/after), then:

Per slot (raw, whitespace-exact):
    exact                   holds exactly the value sent
    trailing space trimmed  Salesforce stored it without the trailing space (seen on
                            some picklist / value-set values)
    outer space trimmed     stored without leading and trailing space
    DIFFERENT               holds something else                      <- FAIL
    DIFFERENT gender        standard-field gender is not what was sent <- FAIL
    not readable            the slot is not in the after read (e.g. an inactive value:
                            a retrieve never shows those) - check it in a Bilingual export

Everything else: every other leaf of every file in the read must be unchanged from before.
Known Salesforce additions (an <aspect> element on a quick action whose label was saved)
are reported separately; any other change outside the scope FAILS - it means something
else changed the org, or the payload did more than the proof said.

Exit 0 = all exact and nothing else changed; 1 = only trims / not readable / known
additions (read them); 2 = FAIL.

Example:
    python verify.py --located run/located.json --before run/before --after run/after
"""
from __future__ import annotations

import argparse
import collections
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402
import proof  # noqa: E402
from slots import N, Trees, field_gender, find_slot  # noqa: E402

KNOWN_ADDITIONS = {("quickActions", "aspect")}


def slot_verdict(after: Trees, d):
    rel, e, tag = find_slot(after, d)
    if e is None:
        return "not readable", None
    v = e.find(N + tag)
    cur = "" if v is None else (v.text or "")
    want = d["value"]
    k = ("exact" if cur == want else "trailing space trimmed" if cur == want.rstrip()
         else "outer space trimmed" if cur == want.strip() else "DIFFERENT")
    if d["type"] == "standard-field" and d.get("gender") and field_gender(after, d) != d["gender"]:
        k = "DIFFERENT gender"
    return k, cur


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--located", required=True)
    ap.add_argument("--before", required=True)
    ap.add_argument("--after", required=True, help="after-deploy retrieve, same manifest as before")
    ap.add_argument("--json", help="write per-slot results here")
    a = ap.parse_args(argv)
    R.utf8_stdout()
    located = R.load_json(a.located)
    after = Trees(a.after)
    res = collections.Counter()
    examples = collections.defaultdict(list)
    rows = []
    for d in located:
        if d.get("status") not in ("CHANGE", "SAME"):
            continue
        k, cur = slot_verdict(after, d)
        res[(d["status"], k)] += 1
        examples[(d["status"], k)].append(d)
        rows.append({"id": d["id"], "status": d["status"], "result": k, "sent": d["value"], "after": cur})
    for k, v in sorted(res.items()):
        print(f"  {k[0]:7} {k[1]:24} {v}")
    for k, xs in examples.items():
        if k[1] != "exact":
            for d in xs[:3]:
                print(f"     e.g. {d['id']} {d['lang']} {d['type']} {d.get('obj')} {d.get('field')} "
                      f"{d.get('item')!r} sent {d['value']!r}")

    problems, *_ = proof.prove(located, a.before, a.after, after=True)
    outside = collections.Counter()
    unexpected = []
    for kind, rel, p, detail in problems:
        if kind in ("WRONG VALUE", "MISSING"):
            continue                                   # scoped slots: classified above
        if kind == "UNEXPECTED" and p and len(p) >= 2 and (p[-2][0], p[-1]) in KNOWN_ADDITIONS:
            outside["known Salesforce addition"] += 1
            continue
        outside[kind] += 1
        unexpected.append((kind, rel, p, detail))
    print(f"outside the scope: {dict(outside) or 'nothing changed'}")
    for kind, rel, p, detail in unexpected[:20]:
        print(f"  {kind:15} {rel} {p} {detail}")

    fail = any(k[1].startswith("DIFFERENT") for k in res) or bool(unexpected)
    warn = any(k[1] != "exact" for k in res) or bool(outside)
    if a.json:
        R.dump_json({"slots": rows, "outside": outside,
                     "unexpected": [[k, r, repr(p), d] for k, r, p, d in unexpected]}, a.json)
    print("VERIFY", "FAIL" if fail else "PASS with notes" if warn else "PASS")
    return 2 if fail else 1 if warn else 0


if __name__ == "__main__":
    sys.exit(main())
