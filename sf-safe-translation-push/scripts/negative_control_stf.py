"""Negative control for lock 2 (check_vs_stf.py): plant findings in a COPY of the export and prove
the check catches exactly those.

  B. a translation in one slot the push FILLS (as if translated in the org)  -> CONFLICT
  A. (named overwrites) a different value in one named slot                  -> NAMED MISMATCH
  C. (two or more named overwrites) another named slot shown untranslated     -> NAMED MISMATCH
  D. (with --before-stf) a third named slot translated in a copy of the
     before-push export                                                      -> NOT PROVEN OURS
Runs check_vs_stf.py on the copies with the same flags as the real check. CAUGHT = exit 2 with
exactly the planted findings and nothing UNVERIFIED. Writes only *_negctl* paths.

    python negative_control_stf.py --work <dir> --stf-dir "<export dir>" --not-before "YYYY-MM-DD HHMM"
        [--allow-named] [--before-stf <dir>] [--same-from <report>] [--lightning-tab-dir <dir>]
Exit 0 = CAUGHT.
"""
import argparse
import glob
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stfread as S  # noqa: E402
import translib as L  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def set_translation(path, export_key, value):
    """Set column 3 of the row for export_key; returns the number of rows changed."""
    raw = Path(path).read_bytes().decode("utf-8-sig")
    lines, hits = raw.split("\n"), 0
    for i, l in enumerate(lines):
        parts = l.rstrip("\r").split("\t")
        if parts[0] != export_key or len(parts) < 2:
            continue
        while len(parts) < 3:
            parts.append("")
        parts[2] = value
        lines[i] = "\t".join(parts) + ("\r" if l.endswith("\r") else "")
        hits += 1
    Path(path).write_bytes("\n".join(lines).encode("utf-8"))
    return hits


def newest(d, lang):
    fs = S.find_exports(d).get(lang)
    return max(fs)[1] if fs else None


def main(argv=None):
    L.utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", default=".")
    ap.add_argument("--stf-dir", required=True)
    ap.add_argument("--not-before", required=True)
    ap.add_argument("--report", default="push_report.json")
    ap.add_argument("--allow-named", action="store_true")
    ap.add_argument("--before-stf")
    ap.add_argument("--same-from")
    ap.add_argument("--lightning-tab-dir")
    a = ap.parse_args(argv)
    W = os.path.abspath(a.work)
    P = lambda x: x if os.path.isabs(x) else os.path.join(W, x)
    rep = L.load_json(P(a.report))
    auth = {(x["folder"], x["component"], L.sig_tuple(x["sig"])) for x in rep.get("authorized", [])}
    fills = [x for x in rep["targets"] if (x["folder"], x["component"], L.sig_tuple(x["sig"])) not in auth and x.get("key")]
    named = rep.get("authorized", [])

    dst = P("stf_negctl")
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(a.stf_dir, dst)
    want_conf, want_mm, want_nb, bdst = set(), set(), set(), None

    def plant_in(d, x, value):
        p = newest(d, x["lang"])
        if not p:
            return 0
        ks = S.Export(p, x["lang"]).export_keys(x["key"])
        return set_translation(p, ks[0], value) if len(ks) == 1 else 0

    b = next((x for x in fills if plant_in(dst, x, "PLANTED TRANSLATION") == 1), None)
    if b is None:
        print("no fill slot could be planted (none listed exactly once in the export) - control not valid")
        return 2
    want_conf.add((b["lang"], b["key"]))
    print("planted B (CONFLICT):", b["lang"], b["key"])
    if named and a.allow_named:
        x = named[0]
        if plant_in(dst, x, x["expect"] + " (CHANGED IN ORG)") != 1:
            print("plant A did not land exactly once - control not valid")
            return 2
        want_mm.add((x["lang"], x["key"]))
        print("planted A (NAMED MISMATCH, changed):", x["lang"], x["key"])
        if len(named) > 1:
            x = named[1]
            if plant_in(dst, x, "") != 1:
                print("plant C did not land exactly once - control not valid")
                return 2
            want_mm.add((x["lang"], x["key"]))
            print("planted C (NAMED MISMATCH, untranslated):", x["lang"], x["key"])
        if a.before_stf:
            x = named[2] if len(named) > 2 else named[-1]
            bdst = P("stf_negctl_before")
            shutil.rmtree(bdst, ignore_errors=True)
            shutil.copytree(a.before_stf, bdst)
            if plant_in(bdst, x, "SOMEONE ELSE'S VALUE") != 1:
                print("plant D did not land exactly once - control not valid")
                return 2
            want_nb.add((x["lang"], x["key"]))
            print("planted D (NOT PROVEN OURS):", x["lang"], x["key"])

    out = P("check_vs_stf_negctl.json")
    cmd = [sys.executable, os.path.join(HERE, "check_vs_stf.py"), "--work", W, "--stf-dir", dst, "--not-before", a.not_before,
           "--report", a.report, "--out", out]
    cmd += (["--allow-named"] if a.allow_named else []) + (["--before-stf", bdst] if bdst else [])
    cmd += (["--same-from", a.same_from] if a.same_from else []) + (["--lightning-tab-dir", a.lightning_tab_dir] if a.lightning_tab_dir else [])
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    res = L.load_json(out) if os.path.isfile(out) else {}
    cf = {(x["lang"], x["key"]) for x in res.get("conflicts", [])}
    mm = {(x["lang"], x["key"]) for x in res.get("named_mismatch", [])}
    nb = {(x["lang"], x["key"]) for x in res.get("named_not_proven_ours", [])}
    print(f"check exit {r.returncode}; conflicts {sorted(cf)}; named mismatch {sorted(mm)}; not proven ours {sorted(nb)}; "
          f"unverified {len(res.get('unverified', []))}")
    ok = r.returncode == 2 and cf == want_conf and mm == want_mm and nb == want_nb and not res.get("unverified")
    for p in (dst, bdst):
        if p:
            shutil.rmtree(p, ignore_errors=True)
    for p in glob.glob(P("check_vs_stf_negctl.json")):
        os.remove(p)
    print("RESULT:", "CAUGHT" if ok else "NOT CAUGHT")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
