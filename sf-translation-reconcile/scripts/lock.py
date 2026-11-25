#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Step 9 (lock 3): right before the real deploy, prove nothing moved since the payload was built.

Re-retrieve with the SAME manifest into a new folder (run/pre) just before deploying:

    sf project retrieve start --manifest run/manifest.xml --target-metadata-dir run/pre \\
        --unzip --target-org <alias> --wait 30 --json > run/pre.json

PASS only when:
  * the re-retrieve's JSON says it succeeded, with no messages, and is fresh (--max-age-min)
  * it holds exactly the same files as the before read, each byte-identical
  * the payload still hashes to what locate.py --build recorded (<payload>.sha256)

On FAIL, do not deploy: something changed in the org (or the payload) since step 3.
Start again from the before read - a payload built on a stale read can overwrite
someone else's new value.

Example:
    python lock.py --before run/before --pre run/pre --pre-json run/pre.json --payload run/payload
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconlib as R  # noqa: E402


def retrieve_json_ok(path) -> list[str]:
    try:
        d = R.load_json(path)
    except Exception as exc:                          # noqa: BLE001
        return [f"cannot read {path}: {exc}"]
    r = d.get("result") or {}
    errs = []
    if d.get("status") not in (0, None):
        errs.append(f"sf exit status {d.get('status')}")
    if r.get("status") not in ("Succeeded", None) or r.get("success") is False:
        errs.append(f"retrieve status {r.get('status')!r}")
    msgs = r.get("messages") or []
    if msgs:
        errs.append(f"retrieve messages: {msgs if isinstance(msgs, dict) else msgs[:3]}")
    if not r:
        errs.append("no result in the retrieve JSON")
    return errs


def files(root: Path) -> dict[str, bytes]:
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*")
            if p.is_file() and p.name != "package.xml"}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--before", required=True)
    ap.add_argument("--pre", required=True, help="fresh re-retrieve, same manifest")
    ap.add_argument("--pre-json", required=True, help="the --json output of that retrieve")
    ap.add_argument("--payload", required=True)
    ap.add_argument("--hash-file", help="default: <payload>.sha256")
    ap.add_argument("--max-age-min", type=float, default=20.0, help="max age of the re-retrieve (default %(default)s)")
    a = ap.parse_args(argv)
    bad = []
    bad += [f"pre retrieve: {e}" for e in retrieve_json_ok(a.pre_json)]
    age = (time.time() - Path(a.pre_json).stat().st_mtime) / 60
    if age > a.max_age_min:
        bad.append(f"pre retrieve is {age:.1f} min old (max {a.max_age_min})")
    fb, fp = files(R.find_root(a.before)), files(R.find_root(a.pre))
    if not fb:
        bad.append("the before read holds no files")
    for f in sorted(set(fb) ^ set(fp)):
        bad.append(f"file only in {'before' if f in fb else 'pre'}: {f}")
    changed = [f for f in sorted(set(fb) & set(fp)) if fb[f] != fp[f]]
    for f in changed:
        bad.append(f"CHANGED since the before read: {f}")
    hf = Path(a.hash_file or (str(Path(a.payload)) + ".sha256"))
    if not hf.is_file():
        bad.append(f"no recorded payload hash at {hf}")
    elif R.sha256_dir(a.payload) != hf.read_text(encoding="utf-8").strip():
        bad.append("payload hash changed since it was built")
    for b in bad:
        print(" ", b)
    print(f"LOCK {'PASS' if not bad else 'FAIL'}: {len(fb)} files compared, {len(changed)} changed, "
          f"pre age {age:.1f} min")
    return 2 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
