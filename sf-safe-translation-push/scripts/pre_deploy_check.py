"""Lock 3, the last gate before the real deploy: the target has not moved since the build, and the
payload is the one the export check (lock 2) passed.

The payload re-sends the target's EXISTING values alongside the new ones (whole blocks, whole value
sets), at their wording when before/ was retrieved. If someone edits one of them in the org between
that retrieve and the deploy (a Translation Workbench or Setup edit leaves no DeployRequest), the
deploy writes the old wording back over it. So re-retrieve every manifest into pre/ right before
the deploy and require every translation file to match before/, raw text, whitespace included.

    python pre_deploy_check.py --work <dir> [--max-age-min 20]

Exit 2 if:
  - check_vs_stf.json is not a PASS, or the payload, push_report.json or check_vs_stf.py differ from
    what it checked (unless --no-export-check: SANDBOX ONLY, recorded);
  - the export lock 2 read is older than the before/ retrieve's start (read_start.txt), unless the
    user waives it (--export-floor + --export-waiver "<their words>", recorded);
  - a pre/ batch is missing, did not succeed cleanly (status, messages, warnings), is not that dir's
    own retrieve (zipFilePath; listed files = files on disk), was written before check_vs_stf.json,
    or is older than --max-age-min: pre/ must be a fresh re-retrieve, not a copy or a leftover;
  - any translation file was added, removed or changed since before/.
If it fails, restart at the retrieve: a new before/, build, export and checks.
"""
import argparse
import calendar
import glob
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import translib as L  # noqa: E402


def read_start(path):
    out = {}
    if os.path.isfile(path):
        for line in open(path, encoding="utf-8-sig"):
            k, _, v = line.strip().partition(" ")
            out[k] = v.strip()
    return out


def batches(root):
    return {os.path.basename(d) for d in glob.glob(os.path.join(root, "*")) if os.path.isdir(d)}


def validate_batch(d):
    """(problems, mtime of d.json) for one retrieve batch: d/ and the `sf ... --json` output d.json beside it."""
    rj, probs = d.rstrip("\\/") + ".json", []
    try:
        doc = L.load_json(rj)
    except Exception as e:  # noqa: BLE001 - missing or unreadable is a failure
        return [f"{os.path.basename(rj)}: unreadable ({e.__class__.__name__})"], None
    r = doc.get("result") or {}
    msgs, warns = r.get("messages") or [], doc.get("warnings") or []
    if r.get("status") != "Succeeded" or msgs or warns:
        probs.append(f"status {r.get('status')!r}, {len(msgs) if isinstance(msgs, list) else 1} message(s), {len(warns)} warning(s)")
    zp, root = r.get("zipFilePath") or "", os.path.normcase(os.path.abspath(d))
    try:
        inside = bool(zp) and os.path.commonpath([os.path.normcase(os.path.abspath(zp)), root]) == root
    except ValueError:
        inside = False
    if not inside:
        probs.append(f"zipFilePath {zp!r} is not inside this dir - the JSON is not this dir's retrieve")
    listed = {os.path.normcase(os.path.normpath(fp["fileName"])) for fp in (r.get("fileProperties") or [])
              if fp.get("type") != "Package" and fp.get("fileName")}
    on_disk = set()
    for p in glob.glob(os.path.join(d, "**", "*"), recursive=True):
        if os.path.isfile(p) and not p.lower().endswith((".zip", "package.xml")):
            rel = os.path.normcase(os.path.relpath(p, d))
            pre = "unpackaged" + os.sep
            on_disk.add(rel[len(pre):] if rel.startswith(pre) else rel)
    if listed != on_disk:
        probs.append(f"{len(listed - on_disk)} listed file(s) not on disk, {len(on_disk - listed)} on disk not listed")
    return probs, os.path.getmtime(rj)


def translation_files(root):
    out = {}
    for folder, ext in L.FOLDER_EXT.items():
        for p in glob.glob(os.path.join(root, "**", folder, f"*.{ext}"), recursive=True):
            out[os.path.relpath(p, root)] = p
    return out


def main(argv=None):
    L.utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", default=".")
    ap.add_argument("--before", default="before")
    ap.add_argument("--pre", default="pre")
    ap.add_argument("--check", default="check_vs_stf.json")
    ap.add_argument("--payload", default="payload")
    ap.add_argument("--report", default="push_report.json")
    ap.add_argument("--read-start", default="read_start.txt", help='lines "UTC <ISO>Z" and "ORG YYYY-MM-DD HHMM" '
                                                                   "(snapshot.py mark-start writes it)")
    ap.add_argument("--max-age-min", type=float, default=20.0, help="oldest acceptable pre/ batch, in minutes")
    ap.add_argument("--out", default="pre_deploy_check.json")
    ap.add_argument("--export-floor", help='USER WAIVER ONLY: org time "YYYY-MM-DD HHMM" the export must be at or after, '
                                           "used instead of the read start; needs --export-waiver")
    ap.add_argument("--export-waiver", help="the user's words authorising an older export (recorded)")
    ap.add_argument("--no-export-check", action="store_true",
                    help="SANDBOX ONLY: no export check (lock 2) was run; its checks are skipped and the skip recorded")
    a = ap.parse_args(argv)
    P = lambda p: p if os.path.isabs(p) else os.path.join(a.work, p)
    fail = []
    script_dir = os.path.dirname(os.path.abspath(__file__))

    # ---- 1. the payload and its inputs are the ones the export check passed ----------------------
    chk = L.load_json(P(a.check)) if os.path.isfile(P(a.check)) else {}
    ph = L.dir_sha256(P(a.payload))
    rep = L.load_json(P(a.report)) if os.path.isfile(P(a.report)) else {}
    if rep.get("payload_sha256") != ph:
        fail.append("payload hash differs from push_report.json - the payload changed after the build")
    if a.no_export_check:
        print("NOTE: --no-export-check - lock 2 was not run for this target; its checks are skipped (SANDBOX ONLY)")
    else:
        if chk.get("result") != "PASS":
            fail.append(f"{a.check}: result is {chk.get('result')!r}, not PASS")
        for name, now, then in (("check_vs_stf.py", L.file_sha256(os.path.join(script_dir, "check_vs_stf.py")), chk.get("script_sha256")),
                                ("payload", ph, chk.get("payload_sha256")),
                                (a.report, L.file_sha256(P(a.report)), chk.get("report_sha256"))):
            if not now or now != then:
                fail.append(f"{name} hash {str(now)[:16]}... differs from the one check_vs_stf.py passed "
                            f"({str(then)[:16]}...) - changed since; re-run the checks")
        # the export must be newer than the start of the before/ retrieve
        s3 = read_start(P(a.read_start))
        if not s3.get("UTC") or not s3.get("ORG"):
            fail.append(f"{a.read_start} with 'UTC ...' and 'ORG YYYY-MM-DD HHMM' lines is required - the export's age cannot be checked")
        else:
            t_utc = calendar.timegm(time.strptime(s3["UTC"], "%Y-%m-%dT%H:%M:%SZ"))
            res = sorted(os.path.getmtime(p) for p in glob.glob(os.path.join(P(a.before), "*.json")))
            if not res or not (t_utc <= res[0] <= t_utc + 1800):
                fail.append(f"{a.read_start} UTC {s3['UTC']} does not match the before/ retrieve (first batch result "
                            f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(res[0])) if res else 'none'})")
            floor = s3["ORG"]
            if bool(a.export_floor) != bool(a.export_waiver):
                fail.append("--export-floor and --export-waiver go together")
            elif a.export_floor:
                floor = a.export_floor
                print(f"NOTE: USER WAIVER - export accepted from {floor} (read started {s3['ORG']}): {a.export_waiver!r}")
            if (chk.get("not_before") or "") < floor:
                fail.append(f"{a.check}: --not-before {chk.get('not_before')!r} is earlier than {floor!r} (org time)")
            for lang, u in sorted((chk.get("exports") or {}).items()):
                if (u.get("stamp_org_time") or "") < floor:
                    fail.append(f"{a.check}: {lang} export {u.get('stamp_org_time')!r} is older than {floor!r}")

    # ---- 2. pre/ is a clean, fresh re-retrieve of every batch ---------------------------------------
    bb, pb = batches(P(a.before)), batches(P(a.pre))
    if not pb:
        fail.append(f"no batches in {P(a.pre)}")
    if bb != pb:
        fail.append(f"batches differ: before {sorted(bb)} vs pre {sorted(pb)}")
    check_time = 0 if a.no_export_check else (os.path.getmtime(P(a.check)) if os.path.isfile(P(a.check)) else float("inf"))
    ages = {}
    for b in sorted(pb):
        probs, t = validate_batch(os.path.join(P(a.pre), b))
        fail += [f"pre/{b}: {pr}" for pr in probs]
        if t is not None:
            ages[b] = round((time.time() - t) / 60, 1)
            if t <= check_time:
                fail.append(f"pre/{b}: retrieved before {a.check} was written - not a re-retrieve")
            if ages[b] > a.max_age_min:
                fail.append(f"pre/{b}: retrieved {ages[b]} min ago (> {a.max_age_min}) - re-retrieve right before the deploy")

    # ---- 3. nothing moved: raw text, whitespace included ----------------------------------------
    fb, fp = translation_files(P(a.before)), translation_files(P(a.pre))
    added, removed = sorted(set(fp) - set(fb)), sorted(set(fb) - set(fp))
    changed = []
    for rel in sorted(set(fb) & set(fp)):
        lb, lp = L.leaves(fb[rel]), L.leaves(fp[rel])
        for s in sorted(set(lb) | set(lp), key=str):
            if lb.get(s) != lp.get(s):
                changed.append({"file": rel, "sig": str(s), "before": lb.get(s), "pre": lp.get(s)})
    if added:
        fail.append(f"{len(added)} translation file(s) appeared since before/")
    if removed:
        fail.append(f"{len(removed)} translation file(s) missing from pre/")
    if changed:
        fail.append(f"{len(changed)} value(s) changed in the target since before/ ({len({c['file'] for c in changed})} file(s))")

    L.dump_json({"result": "PASS" if not fail else "FAIL", "export_check_skipped": a.no_export_check,
                 "export_floor": a.export_floor, "export_waiver": a.export_waiver, "payload_sha256": ph,
                 "pre_age_min": ages, "files_compared": len(set(fb) & set(fp)), "added": added, "removed": removed,
                 "changed": changed, "failures": fail}, P(a.out))
    print(f"payload sha256 {str(ph)[:16]}...  (export check passed {str(chk.get('payload_sha256'))[:16]}...)")
    print(f"pre/ retrieve age (min): {ages}")
    print(f"translation files compared before vs pre: {len(set(fb) & set(fp))}; added {len(added)}, removed {len(removed)}")
    print(f"values changed in the target since before/: {len(changed)} (must be 0)")
    for c in changed[:8]:
        print("   ", c["file"], c["sig"][:90], "|", repr(c["before"])[:40], "->", repr(c["pre"])[:40])
    print("RESULT:", "PASS" if not fail else "FAIL")
    for f in fail[:20]:
        print("   ", f)
    return 2 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
