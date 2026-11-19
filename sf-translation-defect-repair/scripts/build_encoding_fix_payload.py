#!/usr/bin/env python3
"""Build a payload that repairs mojibake (UTF-8 read as cp1252) in translations.

The same root cause (an export or edit step that read UTF-8 as cp1252) shows up three ways:

  A  corrupted KEY in a load file   the row never deployed. Its key is repaired, the
                                    repaired key is checked to exist in the org pull, and
                                    the translation is put on that slot.
  B  corrupted VALUE, live          the key was fine, the row deployed, and the damaged
                                    text is in the org now. No deploy log reports it.
  C  corrupted VALUE in a global    also live, and invisible to a scan of .stf exports,
     value set                      because global value sets are not in them. The org
                                    pull covers them, so B and C are found the same way.

The payload is built by overlaying repaired translations onto the FRESH org-pull CSVs.
Those rows already carry the right keys, type and target path for every slot, so nothing
about routing or file layout is re-invented here. Only rows whose text actually changes
are written.

Safety:
  - A repair is used only when it is exact (byte round-trip) or pinned down by a clean
    reference text (the key or the English source). Anything else is listed in the
    unrepairable report and left out. A guessed repair looks authoritative and is worse
    than a blank.
  - Every value written is re-checked to be clean; a dirty one stops the run.
  - Two different repairs for the same slot stop the run.
  - Writes CSVs only. Nothing is deployed.

Usage:
  python build_encoding_fix_payload.py <fresh_csv_dir> --out-dir <dir>
      [--load-dir <load_csv_dir> ...] [--casing-fix "CrèME=Crème"] [--force]

Next: turn the CSVs into metadata with your CSV-to-metadata tool, run
prevalidate_payload.py on the result, then a dry-run deploy.
"""
from __future__ import annotations

import argparse
import csv
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mojibake  # noqa: E402
import tcsv  # noqa: E402


def _addr(r: dict) -> tuple[str, str, str]:
    return (r.get("component", ""), r.get("field", ""), r.get("masterLabel", ""))


def collect(fresh: dict, load_dirs: list[Path], euro: bool):
    """Return (fixes, unrepairable, clashes).

    fixes: {(lang, slot_key): (new_translation, origin)}
    """
    fixes: dict[tuple, tuple[str, str]] = {}
    unrepairable: list[list[str]] = []
    clashes: list[str] = []

    def put(lang, row, value, origin):
        k = (lang, tcsv.slot_key(row))
        prev = fixes.get(k)
        if prev and prev[0] != value:
            clashes.append(f"[{lang}] {'.'.join(x for x in k[1] if x)}: "
                           f"{prev[0]!r} ({prev[1]}) vs {value!r} ({origin})")
            return
        fixes[k] = (value, origin)

    # B + C: damaged values that are live in the org now.
    for lang, (_p, _h, rows) in fresh.items():
        for r in rows:
            tr = r.get("translation", "") or ""
            if not tr.strip() or not mojibake.is_mojibake(tr, euro):
                continue
            ref = r.get("masterLabel") or r.get("source") or ""
            fixed = mojibake.repair(tr, ref, euro)
            if fixed:
                put(lang, r, fixed, "live value")
            else:
                unrepairable.append([lang, "live value", *tcsv.slot_key(r), tr,
                                     "no exact repair - fix by hand"])

    # A: corrupted keys in load files. Index the org pull by address.
    by_addr = {lang: {_addr(r): r for r in rows} for lang, (_p, _h, rows) in fresh.items()}
    for d in load_dirs:
        for lang, (path, _h, rows) in tcsv.load_dir(d).items():
            for r in rows:
                key = r.get("masterLabel", "") or ""
                if not key or not mojibake.is_mojibake(key, euro):
                    continue
                tr = r.get("translation", "") or ""
                if not tr.strip():
                    continue
                fixed_key = mojibake.repair(key, "", euro)
                if not fixed_key:
                    unrepairable.append([lang, f"key in {path.name}", *tcsv.slot_key(r), key,
                                         "key has no exact repair"])
                    continue
                target = by_addr.get(lang, {}).get((r.get("component", ""), r.get("field", ""),
                                                    fixed_key))
                if target is None:
                    unrepairable.append([lang, f"key in {path.name}", *tcsv.slot_key(r), key,
                                         f"repaired key {fixed_key!r} is not in the org pull"])
                    continue
                if mojibake.is_mojibake(tr, euro):
                    # The translator often echoed the corrupted English back. That is the
                    # export's defect, not theirs, so it is repaired too, against the
                    # repaired key.
                    tr = mojibake.repair(tr, fixed_key, euro)
                    if not tr:
                        unrepairable.append([lang, f"value in {path.name}", *tcsv.slot_key(r),
                                             r.get("translation", ""),
                                             "translation has no exact repair"])
                        continue
                put(lang, target, tr, f"key fix from {path.name}")
    return fixes, unrepairable, clashes


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("fresh_dir", type=Path,
                    help="fresh org pull: translations_<lang>.csv with current org values")
    ap.add_argument("--out-dir", type=Path, required=True, help="where to write payload CSVs")
    ap.add_argument("--load-dir", type=Path, action="append", default=[],
                    help="CSVs that were sent for deploy (repeatable). Rows with a corrupted "
                         "key are repaired and mapped onto the org slot.")
    ap.add_argument("--casing-fix", action="append", default=[], metavar="BAD=GOOD",
                    help="replace a repaired value exactly (e.g. a proper noun that "
                         "autocorrect re-cased). Repeatable. Every use is printed.")
    ap.add_argument("--euro-is-suspect", action="store_true",
                    help="treat every euro sign as damage (only for data with no real ones)")
    ap.add_argument("--force", action="store_true", help="replace CSVs in a non-empty --out-dir")
    for _s in (sys.stdout, sys.stderr):
        if hasattr(_s, "reconfigure"):
            _s.reconfigure(encoding="utf-8", errors="replace")
    a = ap.parse_args(argv)

    casing = {}
    for spec in a.casing_fix:
        bad, sep, good = spec.partition("=")
        if not sep:
            ap.error(f"--casing-fix needs BAD=GOOD, got {spec!r}")
        casing[bad] = good

    fresh = tcsv.load_dir(a.fresh_dir)
    if not fresh:
        sys.exit(f"error: no translation CSVs found in {a.fresh_dir}")
    fixes, unrepairable, clashes = collect(fresh, a.load_dir, a.euro_is_suspect)
    if clashes:
        sys.exit("error: conflicting repairs for the same slot:\n  " + "\n  ".join(clashes))

    tcsv.prepare_out_dir(a.out_dir, a.force)
    written: dict[str, int] = defaultdict(int)
    same = 0
    for lang, (_p, hdr, rows) in fresh.items():
        keep = []
        for r in rows:
            hit = fixes.get((lang, tcsv.slot_key(r)))
            if not hit:
                continue
            new = hit[0]
            if new in casing:
                print(f"   casing fix [{lang}] {new!r} -> {casing[new]!r}")
                new = casing[new]
            if not mojibake.is_clean(new, a.euro_is_suspect):
                sys.exit(f"error: refusing to write an unclean repair: [{lang}] {new!r}")
            if new == (r.get("translation") or ""):
                same += 1
                continue
            out = dict(r)
            out["translation"] = new
            keep.append(out)
            written[lang] += 1
        if keep:
            tcsv.write_csv(a.out_dir / f"translations_{lang}.csv", hdr, keep)

    report = a.out_dir.parent / f"{a.out_dir.name}_unrepairable.csv"
    if unrepairable:
        with open(report, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["language", "origin", *tcsv.KEY_COLS, "text", "reason"])
            w.writerows(unrepairable)

    print(f"repairs found        : {len(fixes)}")
    print(f"already correct      : {same}")
    print(f"rows to deploy       : {sum(written.values())} across {len(written)} language(s)")
    for lg in sorted(written):
        print(f"   {lg:6} {written[lg]}")
    if unrepairable:
        print(f"\nNOT REPAIRED ({len(unrepairable)}) - left out of the payload, listed in {report}")
        for u in unrepairable[:20]:
            print(f"   [{u[0]:5}] {u[6]!r} - {u[7]}")
        print("   No exact repair exists for these. Guessing would be fabrication; they need "
              "a person (usually the translator) to re-supply the text.")
    print(f"\npayload CSVs: {a.out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
