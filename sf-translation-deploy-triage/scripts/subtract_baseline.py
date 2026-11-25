#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Show only the NEW errors in a deploy/validate result, by subtracting a known baseline.

A sandbox that has drifted from production fails a validate for reasons that have nothing
to do with the change being tested: fields that only exist elsewhere, a language that is
not enabled, data differences. Those errors repeat on every run and bury the ones that
matter. Record them once as a baseline, then every later run shows only what is new.

A failure's signature is "<fullName> :: <problem>" with the '(line:col)' position removed,
so the same error matches across runs.

Usage:
  # record the known errors of a reference run
  python subtract_baseline.py validate_ref.json --write-baseline known_errors.txt
  # later: what is new?
  python subtract_baseline.py validate_new.json known_errors.txt [--json-out new.json]
Exit 1 if any NEW error remains, 0 if none.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import triage_common as T  # noqa: E402


def signature(f: dict) -> str:
    return f"{f.get('fullName', '')} :: {T.strip_position(f.get('problem', ''))}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("deploy_json", help="deploy/validate --json output")
    ap.add_argument("baseline", nargs="?", help="baseline file of known signatures")
    ap.add_argument("--write-baseline", metavar="FILE",
                    help="write every failure of deploy_json as the baseline and stop")
    ap.add_argument("--json-out", help="write the NEW failures as JSON here")
    ap.add_argument("--show", type=int, default=60, help="how many new signatures to print")
    T.utf8_console()
    a = ap.parse_args(argv)

    res, fails, _ok = T.load_deploy(a.deploy_json)
    if a.write_baseline:
        sigs = sorted({signature(f) for f in fails})
        Path(a.write_baseline).write_text(
            f"# Known deploy errors: {len(sigs)} signature(s) from {Path(a.deploy_json).name}\n"
            "# One '<fullName> :: <problem>' per line. Lines starting with # are ignored.\n"
            + "".join(s + "\n" for s in sigs), encoding="utf-8")
        print(f"baseline written: {a.write_baseline} ({len(sigs)} signatures)")
        return 0

    baseline: set[str] = set()
    if a.baseline:
        if not Path(a.baseline).exists():
            sys.exit(f"error: baseline {a.baseline} not found")
        baseline = {ln.strip() for ln in Path(a.baseline).read_text(encoding="utf-8-sig").splitlines()
                    if ln.strip() and not ln.startswith("#")}

    new, known = [], 0
    cats: Counter = Counter()
    for f in fails:
        if signature(f) in baseline:
            known += 1
            continue
        new.append(f)
        cat, attr = T.categorise(f.get("problem", ""))
        cats[f"{cat}{': ' + attr if attr else ''}"] += 1

    print(f"components total     : {res.get('numberComponentsTotal')}")
    print(f"deployed / passed    : {res.get('numberComponentsDeployed')}")
    print(f"failures total       : {len(fails)}")
    print(f"  known baseline     : {known}  (subtracted)")
    print(f"  NEW                : {len(new)}")
    if cats:
        print("\n=== NEW by category ===")
        for k, v in cats.most_common():
            print(f"  {v:4}  {k}")
        print(f"\n=== NEW error detail (first {a.show}) ===")
        for s in sorted(signature(f) for f in new)[: a.show]:
            print("  " + s)
    if a.json_out:
        Path(a.json_out).write_text(json.dumps(new, indent=1, ensure_ascii=False), encoding="utf-8")
    return 1 if new else 0


if __name__ == "__main__":
    sys.exit(main())
