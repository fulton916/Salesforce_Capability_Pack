#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""After-deploy check from the org's own Bilingual exports: one before, one after one or more pushes.

Every pushed slot the export lists must be TRANSLATED with exactly the value sent (spacing
aside), and every TRANSLATED row outside the pushes must be unchanged. The pushed slots
come from each push's located.json (status CHANGE). Give pushes oldest first; when two set
the same slot, the later one is expected and the clash is listed.

Reports:
    landed       pushed slots holding the value sent
    WRONG        pushed slots holding something else, or not translated
    not listed   pushed slots the export does not list (some types are never exported)
    LOST         translated before, untranslated or gone after (outside the pushes)
    CHANGED      a different translation after (outside the pushes) - often someone
                 else's edit in the org; listed so a person can decide
    NEW          translated after but not before (outside the pushes)

Exit 2 on any WRONG / LOST / CHANGED / NEW, or a truncated export.

Example:
    python export_diff.py --before exports/before --after exports/after \\
        --located runs/push1/located.json --located runs/push2/located.json --out out/export_diff.json
"""
from __future__ import annotations

import argparse
import collections
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402


def expected_keys(f: R.StfFile, d):
    keys = R.stf_keys(d["type"], d.get("obj") or "", d.get("field") or "", d.get("item") or "")
    if d["type"] == "report-type-section":
        hits = f.crt.get((d.get("field") or "", d.get("item") or ""), [])
        return hits if len(hits) == 1 else []
    if d["type"] in R.PREFIX_TYPES:
        return sorted(k for k in f.present if R.strip_pos(k) in keys)
    return [k for k in keys if k in f.present][:1]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--before", required=True, help="Bilingual export taken before the first push")
    ap.add_argument("--after", required=True, help="Bilingual export taken after the last push")
    ap.add_argument("--located", action="append", required=True, help="a push's located.json (oldest first)")
    ap.add_argument("--out", help="JSON report")
    a = ap.parse_args(argv)
    R.utf8_stdout()
    B, A = R.load_stf_dir(a.before), R.load_stf_dir(a.after)
    trunc = [str(f.path) for f in list(B.values()) + list(A.values()) if f.truncated]
    if trunc:
        R.die(f"truncated export file(s): {trunc[:3]}")
    langs = sorted(set(B) & set(A))
    if set(B) != set(A):
        print("NOTE: languages in only one export:", sorted(set(B) ^ set(A)))
    pushed = []
    for path in a.located:
        n = 0
        for d in R.load_json(path):
            if d.get("status") == "CHANGE" and not d.get("duplicate_of"):
                pushed.append((Path(path).parent.name or path, d))
                n += 1
        print(f"{path}: {n} pushed slots")
    landed, not_listed = collections.Counter(), collections.Counter()
    wrong, lost, changed, new, clash = [], [], [], [], []
    unchanged = 0
    for lang in langs:
        fb, fa = B[lang], A[lang]
        expected = {}
        for w, d in pushed:
            if d["lang"] != lang:
                continue
            ks = expected_keys(fa, d)
            if not ks:
                not_listed[w] += 1
                continue
            for k in ks:
                if k in expected and R.norm_ws(expected[k][0]) != R.norm_ws(d["value"]):
                    clash.append((lang, k, expected[k], (d["value"], w)))
                expected[k] = (d["value"], w)
        for k in sorted(set(fb.held) | set(fa.held) | set(expected)):
            if k in expected:
                v, w = expected[k]
                if R.norm_ws(fa.held.get(k)) == R.norm_ws(v) and k in fa.held:
                    landed[w] += 1
                else:
                    wrong.append((lang, k, fb.held.get(k), fa.held.get(k), v, w))
                continue
            if k in fb.held and k not in fa.held:
                lost.append((lang, k, fb.held[k], "key gone" if k not in fa.present else "now untranslated"))
            elif k in fb.held and R.norm_ws(fb.held[k]) != R.norm_ws(fa.held[k]):
                changed.append((lang, k, fb.held[k], fa.held[k]))
            elif k not in fb.held and k in fa.held:
                new.append((lang, k, fa.held[k]))
            else:
                unchanged += 1
    print(f"languages compared: {len(langs)}")
    print(f"translated rows unchanged: {unchanged:,}")
    print(f"pushed slots landed: {dict(landed)} | WRONG: {len(wrong)} | not listed by the export: {dict(not_listed)}"
          f" | set differently by two pushes: {len(clash)}")
    print(f"LOST: {len(lost)}   CHANGED outside the pushes: {len(changed)}   NEW outside the pushes: {len(new)}")
    for name, xs in (("WRONG", wrong), ("LOST", lost), ("CHANGED", changed), ("NEW", new), ("CLASH", clash)):
        for x in xs[:10]:
            print(f"   {name}", x)
    ok = not (wrong or lost or changed or new)
    if a.out:
        R.dump_json({"result": "PASS" if ok else "FAIL", "landed": landed, "not_listed": not_listed,
                     "wrong": wrong, "lost": lost, "changed": changed, "new": new, "clash": clash}, a.out)
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
