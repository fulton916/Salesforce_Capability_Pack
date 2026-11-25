# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Point-in-time snapshot of the target before a push, and the read-start stamp the checks need.

A push cannot be taken back out by a deploy (most translation types ignore a blank or an omitted
value), so the record of what the target held before the push is the before/ retrieve. This helper
copies it, with the run's inputs and check results, into a dated folder outside the run folder:

    <ORG>_<YYYY-MM-DD>_<HHMM>_before_<what>[_<deployId>]      (local time, sorts by date)
        before/                 the target's retrieve (every batch + its sf --json result)
        source.json, plan.json, push_report.json, read_start.txt, ...   (whatever exists)
        SNAPSHOT.json           every file's size and sha256, plus a log of what was added when
        README.txt              what this folder is

Subcommands:
  mark-start  --work <dir> (--org-tz <IANA zone> | --org-time "YYYY-MM-DD HHMM")
              write read_start.txt (UTC and org time) right BEFORE the first retrieve into before/
  create      --root <snapshots dir> --org <label> --what <slug> --work <dir> [--include a b ...]
              copy before/ and the run files, verify the copy (count, bytes, hashes)
  add         --snapshot <dir> --work <dir> <file> [<file> ...]   add check results / deploy JSONs later
  finish      --snapshot <dir> --deploy-id <id>    record the deploy ID and append it to the folder name
  supersede   --snapshot <dir> --reason <slug>     mark a snapshot whose run was restarted (not deployed)
  verify      --snapshot <dir>                     re-hash every file against SNAPSHOT.json
"""
import argparse
import datetime
import hashlib
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import translib as L  # noqa: E402

DEFAULT_INCLUDE = ["before", "read_start.txt", "source.json", "plan.json", "named_overwrites.json", "push_report.json"]
README = """Point-in-time snapshot of {org} before a translation push ({what}).

Created {created} UTC from {work}.
before/ is the target's own retrieve, taken before the build: the record of what the target held.
SNAPSHOT.json lists every file with its size and sha256 (python snapshot.py verify --snapshot <this folder>).
After the deploy the deploy ID is appended to the folder name and recorded in SNAPSHOT.json.
A folder ending in _SUPERSEDED-<reason> belongs to a run that was restarted and not deployed.
Do not edit anything in this folder.
"""


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def inventory(root):
    out = {}
    for dp, _, fs in os.walk(root):
        for f in fs:
            p = os.path.join(dp, f)
            rel = os.path.relpath(p, root).replace("\\", "/")
            if rel in ("SNAPSHOT.json", "README.txt"):
                continue
            out[rel] = {"size": os.path.getsize(p), "sha256": sha(p)}
    return out


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc)


def copy_in(snap, work, items):
    """Copy items (paths relative to work) into snap; return {rel: {size, sha256}} of what was copied, verified."""
    copied = {}
    for it in items:
        src = it if os.path.isabs(it) else os.path.join(work, it)
        name = os.path.basename(os.path.normpath(src))
        dst = os.path.join(snap, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=False)
            src_inv = {f"{name}/{k}": v for k, v in inventory(src).items()}
        elif os.path.isfile(src):
            if os.path.exists(dst):
                raise SystemExit(f"{dst} already exists in the snapshot - not overwritten")
            shutil.copy2(src, dst)
            src_inv = {name: {"size": os.path.getsize(src), "sha256": sha(src)}}
        else:
            continue
        for rel, meta in src_inv.items():
            got = os.path.join(snap, rel)
            if not os.path.isfile(got) or os.path.getsize(got) != meta["size"] or sha(got) != meta["sha256"]:
                raise SystemExit(f"copy check failed for {rel}")
        copied.update(src_inv)
    return copied


def manifest_path(snap):
    return os.path.join(snap, "SNAPSHOT.json")


def main(argv=None):
    L.utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("mark-start", help="write read_start.txt before the first retrieve")
    m.add_argument("--work", default=".")
    g = m.add_mutually_exclusive_group(required=True)
    g.add_argument("--org-tz", help="the org's time zone, e.g. America/New_York (Setup -> Company Information)")
    g.add_argument("--org-time", help='the org-time clock now, "YYYY-MM-DD HHMM" (if zoneinfo has no tz database)')
    c = sub.add_parser("create", help="create the snapshot folder")
    c.add_argument("--root", required=True, help="folder that holds all snapshots (outside the run folder)")
    c.add_argument("--org", required=True, help="short org label, e.g. PROD or SANDBOX1")
    c.add_argument("--what", required=True, help="short slug for the push, e.g. labels-push")
    c.add_argument("--work", default=".")
    c.add_argument("--include", nargs="*", default=None, help=f"paths in --work to copy (default: those of {DEFAULT_INCLUDE} that exist)")
    ad = sub.add_parser("add", help="add files to a snapshot")
    ad.add_argument("--snapshot", required=True)
    ad.add_argument("--work", default=".")
    ad.add_argument("files", nargs="+")
    f = sub.add_parser("finish", help="record the deploy ID and append it to the folder name")
    f.add_argument("--snapshot", required=True)
    f.add_argument("--deploy-id", required=True)
    s = sub.add_parser("supersede", help="mark a snapshot whose run was restarted")
    s.add_argument("--snapshot", required=True)
    s.add_argument("--reason", required=True)
    v = sub.add_parser("verify", help="re-hash every file")
    v.add_argument("--snapshot", required=True)
    a = ap.parse_args(argv)

    if a.cmd == "mark-start":
        t = now_utc()
        if a.org_tz:
            try:
                from zoneinfo import ZoneInfo
                org = t.astimezone(ZoneInfo(a.org_tz)).strftime("%Y-%m-%d %H%M")
            except Exception as e:  # noqa: BLE001 - no tz database (Windows without tzdata)
                print(f"cannot convert to {a.org_tz} ({e.__class__.__name__}); install tzdata or pass --org-time")
                return 2
        else:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{4}", a.org_time):
                print('--org-time must look like "2026-01-15 0730"')
                return 2
            org = a.org_time
        p = os.path.join(a.work, "read_start.txt")
        with open(p, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(f"UTC {t.strftime('%Y-%m-%dT%H:%M:%SZ')}\nORG {org}\n")
        print(f"{p}: UTC {t.strftime('%Y-%m-%dT%H:%M:%SZ')}, org time {org}. Start the before/ retrieves now.")
        print(f'Use --not-before "{org}" for check_vs_stf.py.')
        return 0

    if a.cmd == "create":
        t = now_utc()
        local = datetime.datetime.now()
        name = f"{re.sub(r'[^A-Za-z0-9-]+', '-', a.org)}_{local.strftime('%Y-%m-%d_%H%M')}_before_{re.sub(r'[^A-Za-z0-9-]+', '-', a.what)}"
        snap = os.path.join(a.root, name)
        if os.path.exists(snap):
            print(f"{snap} already exists")
            return 2
        work = os.path.abspath(a.work)
        items = a.include if a.include is not None else [x for x in DEFAULT_INCLUDE if os.path.exists(os.path.join(work, x))]
        if not any(os.path.basename(os.path.normpath(x)) == "before" for x in items):
            print("WARNING: before/ is not in the snapshot - it is the record of what the target held")
        os.makedirs(snap)
        files = copy_in(snap, work, items)
        doc = {"org": a.org, "what": a.what, "work": work, "created_utc": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
               "deploy_id": None, "files": files,
               "log": [{"utc": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "event": "created", "items": items}]}
        L.dump_json(doc, manifest_path(snap))
        with open(os.path.join(snap, "README.txt"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(README.format(org=a.org, what=a.what, created=doc["created_utc"], work=work))
        print(f"snapshot: {snap}")
        print(f"files: {len(files)}, bytes: {sum(x['size'] for x in files.values()):,} - copy verified (count, bytes, sha256)")
        return 0

    snap = os.path.abspath(a.snapshot)
    mp = manifest_path(snap)
    if not os.path.isfile(mp):
        print(f"{snap}: no SNAPSHOT.json - not a snapshot made by this script")
        return 2
    doc = L.load_json(mp)
    stamp = now_utc().strftime("%Y-%m-%dT%H:%M:%SZ")

    if a.cmd == "add":
        files = copy_in(snap, os.path.abspath(a.work), a.files)
        doc["files"].update(files)
        doc["log"].append({"utc": stamp, "event": "added", "items": a.files})
        L.dump_json(doc, mp)
        print(f"added {len(files)} file(s) to {snap}")
        return 0

    if a.cmd in ("finish", "supersede"):
        if doc.get("deploy_id") or doc.get("superseded"):
            print(f"{snap} is already closed (deploy {doc.get('deploy_id')!r}, superseded {doc.get('superseded')!r})")
            return 2
        if a.cmd == "finish":
            if not re.fullmatch(r"[A-Za-z0-9]{15,18}", a.deploy_id):
                print("--deploy-id must be the 15/18-character deploy request ID")
                return 2
            doc["deploy_id"], suffix = a.deploy_id, a.deploy_id
        else:
            doc["superseded"], suffix = a.reason, "SUPERSEDED-" + re.sub(r"[^A-Za-z0-9-]+", "-", a.reason)
        doc["log"].append({"utc": stamp, "event": a.cmd, "value": suffix})
        L.dump_json(doc, mp)
        new = snap.rstrip("\\/") + "_" + suffix
        os.rename(snap, new)
        print(f"renamed to {new}")
        return 0

    if a.cmd == "verify":
        have = inventory(snap)
        missing = sorted(set(doc["files"]) - set(have))
        extra = sorted(set(have) - set(doc["files"]))
        diff = sorted(k for k in set(have) & set(doc["files"]) if have[k] != doc["files"][k])
        print(f"files: {len(have)}  missing {len(missing)}  extra {len(extra)}  changed {len(diff)}")
        for x in (missing + extra + diff)[:20]:
            print("   ", x)
        ok = not (missing or extra or diff)
        print("RESULT:", "PASS" if ok else "FAIL")
        return 0 if ok else 2
    return 2


if __name__ == "__main__":
    sys.exit(main())
