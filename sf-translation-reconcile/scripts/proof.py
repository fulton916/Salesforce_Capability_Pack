#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Step 7 (lock 1): offline proof that a payload differs from "before" ONLY at the scoped slots.

Raw and whitespace-exact: every value leaf of every payload file is compared with the same
file in the before read, as text, with no trimming. Leaves are addressed by their path of
named elements (fields[name] / picklistValues[masterLabel] / translation ...), so a value
that moved is caught as well as a value that changed.

PASS only when:
  * every differing leaf is a scoped CHANGE slot (or a leaf a created slot adds),
  * at each such leaf exactly the expected old value went and the scoped value came, and
  * every scoped CHANGE slot is present in the payload with its value.
In payload mode it also checks that package.xml lists exactly the payload's files.

--negative-control re-runs the proof on two deliberately broken copies (one out-of-scope
leaf changed, one scoped value altered) and FAILS unless both are caught. Run it once per
payload: a proof that cannot fail proves nothing.

--after compares an after-deploy read instead of a payload (same manifest as before).
Salesforce normalises some values on save (trims trailing spaces on some picklist values,
adds <aspect> to a saved quick action), so after mode reports those; verify.py classifies
them.

Example:
    python proof.py --located run/located.json --before run/before --dir run/payload --negative-control
    python proof.py --located run/located.json --before run/before --dir run/after --after
"""
from __future__ import annotations

import argparse
import collections
import copy
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402
from slots import NS, leaves, path_key, translation_files  # noqa: E402


def expected_changes(located):
    """{(rel, path): {'add': Counter, 'remove': Counter, 'ids': [...]}} for CHANGE slots."""
    exp = collections.defaultdict(lambda: {"add": collections.Counter(), "remove": collections.Counter(), "ids": []})
    for d in located:
        if d.get("status") != "CHANGE" or d.get("duplicate_of"):
            continue
        rel = d["file"]
        p = path_key(d["leaf_path"])
        if d.get("current") != d["value"]:
            e = exp[(rel, p)]
            e["add"][d["value"]] += 1
            if d.get("current") is not None:
                e["remove"][d["current"]] += 1
            e["ids"].append(d["id"])
        if d["type"] == "standard-field" and d.get("gender") and not d.get("created") \
                and d.get("current_gender") != d["gender"]:
            gp = p[:-2] + ("gender",) if p[-2][0] == "caseValues" else p[:-1] + ("gender",)
            e = exp[(rel, gp)]
            e["add"][d["gender"]] += 1
            if d.get("current_gender") is not None:
                e["remove"][d["current_gender"]] += 1
            e["ids"].append(d["id"])
        for lp, val in d.get("extra_leaves") or []:
            e = exp[(rel, path_key(lp))]
            e["add"][val] += 1
            e["ids"].append(d["id"])
    return exp


def read_leaves(root: Path, rels):
    out = {}
    for rel in rels:
        p = root / rel
        out[rel] = leaves(ET.parse(str(p)).getroot()) if p.is_file() else None
    return out


def compare(before_leaves, dir_leaves, exp):
    """List of problems: (kind, rel, path, detail)."""
    problems = []
    seen = set()
    for rel, b in dir_leaves.items():
        a = before_leaves.get(rel)
        if a is None:
            problems.append(("UNEXPECTED FILE", rel, None, "not in the before read"))
            continue
        if b is None:
            problems.append(("MISSING FILE", rel, None, "in the before read, not here"))
            continue
        for p in set(a) | set(b):
            A, B = collections.Counter(a.get(p, [])), collections.Counter(b.get(p, []))
            add, rem = B - A, A - B
            if not add and not rem:
                continue
            e = exp.get((rel, p))
            if e is None:
                problems.append(("UNEXPECTED", rel, p, f"before {a.get(p)!r} -> now {b.get(p)!r}"))
                continue
            seen.add((rel, p))
            if add != e["add"] or rem != e["remove"]:
                problems.append(("WRONG VALUE", rel, p, f"expected +{dict(e['add'])} -{dict(e['remove'])}, "
                                                        f"got +{dict(add)} -{dict(rem)} ({', '.join(e['ids'][:3])})"))
    for (rel, p), e in exp.items():
        if (rel, p) not in seen:
            problems.append(("MISSING", rel, p, f"expected +{dict(e['add'])} ({', '.join(e['ids'][:3])})"))
    return problems


def package_check(d: Path, rels):
    pk = d / "package.xml"
    if not pk.is_file():
        return [("PACKAGE", "package.xml", None, "missing")]
    listed = set()
    for t in ET.parse(str(pk)).getroot().findall(NS + "types"):
        name = t.findtext(NS + "name")
        for m in t.findall(NS + "members"):
            listed.add((name, m.text))
    have = {(R.TRANSLATION_FOLDERS[r.split("/", 1)[0]], r.split("/", 1)[1].rsplit(".", 1)[0]) for r in rels}
    out = []
    for x in sorted(listed - have):
        out.append(("PACKAGE", "package.xml", None, f"lists {x} but no such file"))
    for x in sorted(have - listed):
        out.append(("PACKAGE", "package.xml", None, f"file {x} not listed"))
    return out


def prove(located, before_dir, d, after=False):
    before_root = R.find_root(before_dir)
    root = R.find_root(d) if after else Path(d)
    rels = translation_files(root)
    if after:
        rels = sorted(set(rels) | set(translation_files(before_root)))
    exp = expected_changes(located)
    bl = read_leaves(before_root, rels)
    dl = read_leaves(root, rels)
    problems = compare(bl, dl, exp)
    if not after:
        problems += package_check(root, rels)
    return problems, exp, bl, dl, rels


def negative_controls(bl, dl, exp):
    """Two broken copies; returns [(name, caught)]."""
    out = []
    bad = copy.deepcopy(dl)
    target = next(((rel, p) for rel, lv in bad.items() if lv for p, vals in sorted(lv.items(), key=str)
                   if (rel, p) not in exp and vals), None)
    if target:
        rel, p = target
        bad[rel][p] = [v + " (control)" for v in bad[rel][p]]
        out.append(("out-of-scope leaf changed", any(k == "UNEXPECTED" for k, *_ in compare(bl, bad, exp))))
    else:
        out.append(("out-of-scope leaf changed", None))
    bad = copy.deepcopy(dl)
    target = next(((rel, p) for (rel, p) in sorted(exp, key=str) if bad.get(rel) and p in bad[rel]), None)
    if target:
        rel, p = target
        bad[rel][p] = [v + " (control)" for v in bad[rel][p]]
        out.append(("scoped value altered", any(k in ("WRONG VALUE", "MISSING") for k, *_ in compare(bl, bad, exp))))
    else:
        out.append(("scoped value altered", None))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--located", required=True, help="located.json from locate.py")
    ap.add_argument("--before", required=True, help="the before retrieve folder")
    ap.add_argument("--dir", required=True, help="the payload folder (or an after read with --after)")
    ap.add_argument("--after", action="store_true", help="--dir is an after-deploy read, not a payload")
    ap.add_argument("--negative-control", action="store_true", help="prove the proof can fail")
    ap.add_argument("--json", help="write the problems here")
    a = ap.parse_args(argv)
    R.utf8_stdout()
    located = R.load_json(a.located)
    problems, exp, bl, dl, rels = prove(located, a.before, a.dir, a.after)
    n_diff = sum(1 for k, *_ in problems if k == "UNEXPECTED") + (len(exp) - sum(1 for k, *_ in problems
                                                                                    if k == "MISSING"))
    print(f"{a.dir}: files {sum(1 for r in rels if dl.get(r) is not None)} | expected changed leaves {len(exp)}"
          f" | differing leaves {n_diff}")
    by = collections.Counter(k for k, *_ in problems)
    for k, rel, p, detail in problems[:40]:
        print(f"  {k:15} {rel}  {p}  {detail}")
    if len(problems) > 40:
        print(f"  ... {len(problems) - 40} more")
    ok = not problems
    if a.negative_control:
        for name, caught in negative_controls(bl, dl, exp):
            print(f"negative control ({name}): {'CAUGHT' if caught else 'NOT CAUGHT' if caught is False else 'not run (nothing to alter)'}")
            if caught is False:
                ok = False
    if a.json:
        R.dump_json({"result": "PASS" if ok else "FAIL", "counts": by,
                     "problems": [[k, rel, repr(p), detail] for k, rel, p, detail in problems]}, a.json)
    print("PROOF", "PASS" if ok else f"FAIL {dict(by)}")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
