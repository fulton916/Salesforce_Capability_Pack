#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Find, and only when told to, remove the access assignments of a list of Salesforce users.

For every user Id in the list it queries, in this order:

  1_PermissionSetGroupAssignments   PermissionSetAssignment rows for permission set groups
  2_PermissionSetAssignments        PermissionSetAssignment rows for permission sets (not the profile's)
  3_PermissionSetLicenseAssignments PermissionSetLicenseAssign
  4_TerritoryAssignments            UserTerritory2Association
  5_PublicGroupMemberships          GroupMember where the group is a public group
  6_QueueMemberships                GroupMember where the group is a queue
  7_UserRoles                       User rows that have a role (the role is cleared, the user is kept)

QUERY-ONLY BY DEFAULT. It writes a CSV per step for review, plus the exact SOQL and sf
commands. Nothing changes in the org unless you pass --execute, and then only after:
  - every query succeeded,
  - the org is a sandbox, or you passed --allow-production,
  - you confirm: type the org alias at the prompt, or pass --confirm <total records>.
After executing, it queries again and reports what is left.

The order matters: permission set (group) assignments go before licence assignments, because
a licence cannot be removed while a permission set that needs it is still assigned.

Examples:
  python user_access_teardown.py --user-ids users.txt --target-org my-sandbox
  python user_access_teardown.py --user-ids users.txt --target-org my-sandbox --generate-only
  python user_access_teardown.py --user-ids users.txt --target-org my-sandbox --execute
  python user_access_teardown.py --user-ids users.txt --target-org my-sandbox --steps territory,groups --execute --confirm 42
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

USER_ID_RE = re.compile(r"^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$")
NULL_MARKER = "#N/A"   # Bulk API 2.0: a field value of #N/A sets the field to null (a blank is ignored)


@dataclass(frozen=True)
class Step:
    key: str
    name: str
    sobject: str
    user_field: str
    where: str
    fields: tuple
    operation: str          # "delete" or "update"
    description: str


STEPS = [
    Step("psg", "1_PermissionSetGroupAssignments", "PermissionSetAssignment", "AssigneeId",
         "PermissionSetGroupId != null",
         ("Id", "AssigneeId", "Assignee.Username", "PermissionSetGroup.DeveloperName"), "delete",
         "permission set group assignments"),
    Step("ps", "2_PermissionSetAssignments", "PermissionSetAssignment", "AssigneeId",
         "PermissionSetGroupId = null AND PermissionSet.IsOwnedByProfile = false",
         ("Id", "AssigneeId", "Assignee.Username", "PermissionSet.Name", "PermissionSet.Label"), "delete",
         "permission set assignments (not profile-owned)"),
    Step("psl", "3_PermissionSetLicenseAssignments", "PermissionSetLicenseAssign", "AssigneeId", "",
         ("Id", "AssigneeId", "Assignee.Username", "PermissionSetLicense.MasterLabel"), "delete",
         "permission set licence assignments"),
    Step("territory", "4_TerritoryAssignments", "UserTerritory2Association", "UserId", "",
         ("Id", "UserId", "User.Username", "Territory2.DeveloperName", "Territory2.Name", "RoleInTerritory2"),
         "delete", "territory assignments"),
    Step("groups", "5_PublicGroupMemberships", "GroupMember", "UserOrGroupId", "Group.Type = 'Regular'",
         ("Id", "UserOrGroupId", "Group.DeveloperName", "Group.Name"), "delete", "public group memberships"),
    Step("queues", "6_QueueMemberships", "GroupMember", "UserOrGroupId", "Group.Type = 'Queue'",
         ("Id", "UserOrGroupId", "Group.DeveloperName", "Group.Name"), "delete", "queue memberships"),
    Step("role", "7_UserRoles", "User", "Id", "UserRoleId != null",
         ("Id", "Username", "UserRole.DeveloperName", "UserRole.Name"), "update", "roles (cleared)"),
]
STEP_KEYS = [s.key for s in STEPS]


class TeardownError(Exception):
    """Stop with a clear message; nothing further is done."""


# ---------------------------------------------------------------- input

def read_user_ids(path: Path) -> tuple[list[str], list[str], int]:
    """Return (unique ids in file order, ignored non-id lines, duplicate count).

    Blank lines and lines starting with # are skipped. A first line that is not an Id is
    treated as a header. Other non-Id lines are returned so the caller can warn about them.
    """
    ids, ignored, seen, dupes = [], [], set(), 0
    first = True
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        tok = raw.strip().strip('",').strip()
        if not tok or tok.startswith("#"):
            continue
        is_header, first = first, False
        if not USER_ID_RE.match(tok):
            if not is_header:
                ignored.append(raw)
            continue
        key = tok[:15]
        if key in seen:
            dupes += 1
            continue
        seen.add(key)
        ids.append(tok)
    return ids, ignored, dupes


def chunked(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def in_list(ids: list[str]) -> str:
    return ",".join(f"'{i}'" for i in ids)


def build_soql(step: Step, ids: list[str], keep: list[str]) -> str:
    where = [f"{step.user_field} IN ({in_list(ids)})"]
    if step.where:
        where.append(step.where)
    if keep:
        where.append(f"{step.user_field} NOT IN ({in_list(keep)})")
    return f"SELECT {', '.join(step.fields)} FROM {step.sobject} WHERE " + " AND ".join(where)


def select_steps(spec: str | None) -> list[Step]:
    if not spec:
        return list(STEPS)
    wanted = [s.strip() for s in spec.split(",") if s.strip()]
    bad = [w for w in wanted if w not in STEP_KEYS]
    if bad:
        raise TeardownError(f"unknown step(s) {bad}; choose from {','.join(STEP_KEYS)}")
    return [s for s in STEPS if s.key in wanted]   # always in the safe order


# ---------------------------------------------------------------- sf CLI

def sf(args: list[str]) -> dict:
    """Run `sf ... --json`; return the parsed JSON (any status)."""
    exe = shutil.which("sf")
    if not exe:
        raise TeardownError("Salesforce CLI 'sf' was not found on PATH.")
    p = subprocess.run([exe, *args, "--json"], capture_output=True)
    out = p.stdout.decode("utf-8-sig", "replace")
    if "{" not in out:
        raise TeardownError(f"sf {' '.join(args[:3])} returned no JSON: {p.stderr.decode('utf-8', 'replace')[:300]}")
    return json.loads(out[out.index("{"):])


def query(org: str, soql: str) -> list[dict]:
    data = sf(["data", "query", "--query", soql, "--target-org", org])
    if data.get("status") != 0:
        raise TeardownError(f"query failed: {data.get('message')}\n  {soql[:300]}")
    r = data["result"]
    if len(r["records"]) < r.get("totalSize", 0):
        raise TeardownError(f"query returned {len(r['records'])} of {r['totalSize']} records; raise "
                            "org-max-query-limit (sf config set org-max-query-limit=<n>) or lower --chunk-size")
    return r["records"]


def flat(rec: dict, prefix: str = "") -> dict:
    out = {}
    for k, v in rec.items():
        if k == "attributes":
            continue
        if isinstance(v, dict):
            out.update(flat(v, f"{prefix}{k}."))
        else:
            out[f"{prefix}{k}"] = v
    return out


def bulk_command(step: Step, file: Path, org: str, wait: int) -> list[str]:
    verb = "delete" if step.operation == "delete" else "update"
    return ["data", verb, "bulk", "--sobject", step.sobject, "--file", str(file), "--target-org", org,
            "--wait", str(wait), "--line-ending", "LF"]


def find_counts(obj, names=("numberRecordsProcessed", "processedRecords", "numberRecordsFailed", "failedRecords",
                            "successfulRecords")) -> dict:
    """Pull job counters out of sf bulk --json output, wherever they sit."""
    found = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in names and isinstance(v, (int, str)) and k not in found:
                found[k] = v
            elif isinstance(v, (dict, list)):
                for name, count in find_counts(v, names).items():
                    found.setdefault(name, count)
    elif isinstance(obj, list):
        for v in obj:
            for name, count in find_counts(v, names).items():
                found.setdefault(name, count)
    return found


# ---------------------------------------------------------------- files

def write_csv(path: Path, header: list[str], rows: list[list]):
    with path.open("w", newline="", encoding="utf-8") as fh:   # LF line endings, no BOM
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)


def write_plan_files(out: Path, org: str, steps: list[Step], ids: list[str], keep: list[str], chunk: int,
                     wait: int):
    """SOQL per chunk (for review or a query tool) and the bulk commands --execute would run."""
    q_lines, c_lines = [], ["#!/bin/bash", "# Bulk commands that --execute runs, in this order.",
                            "# Review the CSVs first. These CHANGE DATA in the org.",
                            "# Run from this results folder (the CSV paths are relative).", f'ORG="{org}"', ""]
    chunks = list(chunked(ids, chunk))
    for s in steps:
        q_lines += ["=" * 70, f"{s.name} - {s.description} [{s.sobject}]", "=" * 70]
        for n, c in enumerate(chunks, 1):
            q_lines += [f"--- chunk {n} of {len(chunks)} ({len(c)} users) ---", build_soql(s, c, keep), ""]
        file = f"{s.name}_{'ids' if s.operation == 'delete' else 'update'}.csv"
        cmd = bulk_command(s, Path(file), "$ORG", wait)
        c_lines += [f"# {s.name}: {s.description}",
                    "sf " + " ".join(f'"{a}"' if a == "$ORG" else a for a in cmd), ""]
    (out / "QUERIES.txt").write_text("\n".join(q_lines) + "\n", encoding="utf-8")
    (out / "BULK_COMMANDS.sh").write_text("\n".join(c_lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------- phases

def run_queries(org: str, steps: list[Step], ids: list[str], keep: list[str], chunk: int, out: Path,
                label: str = "") -> dict[str, list[dict]]:
    found = {}
    chunks = list(chunked(ids, chunk))
    for s in steps:
        rows = []
        for n, c in enumerate(chunks, 1):
            rows += query(org, build_soql(s, c, keep))
        flat_rows = [flat(r) for r in rows]
        found[s.key] = flat_rows
        cols = list(dict.fromkeys(["Id", *[f for f in s.fields if f != "Id"]]))
        write_csv(out / f"{s.name}{label}.csv", cols, [[r.get(c, "") for c in cols] for r in flat_rows])
        if not label:
            if s.operation == "delete":
                write_csv(out / f"{s.name}_ids.csv", ["Id"], [[r["Id"]] for r in flat_rows])
            else:
                write_csv(out / f"{s.name}_update.csv", ["Id", "UserRoleId"], [[r["Id"], NULL_MARKER] for r in flat_rows])
        print(f"  {s.name:36} {len(flat_rows):6} records{' (after)' if label else ''}")
    return found


def confirm(org: str, total: int, given: int | None, interactive: bool, ask=input) -> None:
    if given is not None:
        if given != total:
            raise TeardownError(f"Not executed. This run would change {total} records; re-run with --confirm {total}.")
        return
    if not interactive:
        raise TeardownError(f"Not executed. No terminal to confirm in; pass --confirm {total}.")
    answer = ask(f"\nType the org alias ({org}) to change {total} records, anything else to stop: ").strip()
    if answer != org:
        raise TeardownError("Not executed. Confirmation did not match.")


def execute(org: str, steps: list[Step], found: dict, out: Path, wait: int) -> list[dict]:
    results = []
    for s in steps:
        n = len(found[s.key])
        if n == 0:
            results.append({"step": s.name, "records": 0, "status": "skipped (0 records)"})
            continue
        file = out / f"{s.name}_{'ids' if s.operation == 'delete' else 'update'}.csv"
        print(f"  {s.operation:6} {s.name} ({n}) ...", flush=True)
        data = sf(bulk_command(s, file, org, wait))
        (out / f"execute_{s.name}.json").write_text(json.dumps(data, indent=1), encoding="utf-8")
        counts = find_counts(data.get("result", {}))
        ok = data.get("status") == 0
        results.append({"step": s.name, "records": n, "status": "OK" if ok else "ERROR",
                        "message": "" if ok else str(data.get("message"))[:500], **counts})
        print(f"    {'OK' if ok else 'ERROR'} {counts or ''} {'' if ok else data.get('message')}")
        if not ok:
            print("  Stopped: later steps were not run. See the execute_*.json file and the org's bulk job.")
            break
    return results


def preflight(org: str, ids: list[str], keep: list[str], chunk: int, out: Path) -> tuple[list[str], bool]:
    """Users found (writes users.csv), running user auto-protected. Returns (keep, is_sandbox)."""
    me = sf(["org", "display", "--target-org", org])
    if me.get("status") != 0:
        raise TeardownError(f"cannot reach org {org}: {me.get('message')}")
    username = me["result"]["username"]
    org_row = query(org, "SELECT Id, Name, IsSandbox FROM Organization")[0]
    users = []
    for c in chunked(ids, chunk):
        users += query(org, f"SELECT Id, Username, Name, IsActive, UserRole.Name, Profile.Name FROM User "
                            f"WHERE Id IN ({in_list(c)})")
    found = {u["Id"][:15] for u in users}
    missing = [i for i in ids if i[:15] not in found]
    write_csv(out / "users.csv", ["Id", "Username", "Name", "IsActive", "UserRole.Name", "Profile.Name"],
              [[f.get(k, "") for k in ("Id", "Username", "Name", "IsActive", "UserRole.Name", "Profile.Name")]
               for f in map(flat, users)])
    (out / "missing_user_ids.txt").write_text("\n".join(missing) + ("\n" if missing else ""), encoding="utf-8")
    print(f"Org: {org_row['Name']} ({'sandbox' if org_row['IsSandbox'] else 'PRODUCTION'}), you are {username}")
    print(f"Users: {len(users)} found, {len(missing)} not found (missing_user_ids.txt)")
    me_user = [u for u in users if u["Username"].lower() == username.lower()]
    if me_user and me_user[0]["Id"] not in keep:
        print(f"Your own user {username} is in the list: it is excluded from every step.")
        keep = keep + [me_user[0]["Id"]]
    return keep, bool(org_row["IsSandbox"])


# ---------------------------------------------------------------- main

def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--user-ids", type=Path, required=True, help="text file, one User Id (005...) per line")
    p.add_argument("-o", "--target-org", required=True, help="sf org alias or username (required, no default)")
    p.add_argument("--out", type=Path, help="results folder (default: teardown_results/<org>_<UTC time>)")
    p.add_argument("--steps", help=f"comma list of steps to include (default all): {','.join(STEP_KEYS)}")
    p.add_argument("--keep-user-id", action="append", default=[], metavar="ID",
                   help="never touch this user even if listed; repeatable (your own user is kept automatically)")
    p.add_argument("--chunk-size", type=int, default=200, help="user Ids per query (default 200)")
    p.add_argument("--generate-only", action="store_true", help="write QUERIES.txt and BULK_COMMANDS.sh; no org call")
    p.add_argument("--execute", action="store_true", help="after querying, DELETE / UPDATE what was found")
    p.add_argument("--confirm", type=int, help="with --execute: must equal the total records to change")
    p.add_argument("--allow-production", action="store_true", help="with --execute: allow a production org")
    p.add_argument("--wait", type=int, default=30, help="minutes to wait for each bulk job (default 30)")
    a = p.parse_args(argv)
    if a.generate_only and a.execute:
        p.error("--generate-only and --execute cannot be combined")
    if a.chunk_size < 1 or a.chunk_size > 800:
        p.error("--chunk-size must be 1-800 (SOQL length limit)")
    return a


def main(argv=None, ask=input, interactive=None) -> int:
    a = parse_args(argv)
    try:
        if not a.user_ids.is_file():
            raise TeardownError(f"user Id file not found: {a.user_ids}")
        ids, ignored, dupes = read_user_ids(a.user_ids)
        if not ids:
            raise TeardownError(f"no User Ids (005...) found in {a.user_ids}")
        for k in a.keep_user_id:
            if not USER_ID_RE.match(k):
                raise TeardownError(f"--keep-user-id {k!r} is not a User Id")
        steps = select_steps(a.steps)
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        out = a.out or Path("teardown_results") / f"{re.sub(r'[^A-Za-z0-9_-]+', '_', a.target_org)}_{stamp}"
        out.mkdir(parents=True, exist_ok=True)
        print(f"{len(ids)} user Ids from {a.user_ids.name}" + (f", {dupes} duplicates dropped" if dupes else "")
              + (f", {len(ignored)} lines ignored (not Ids)" if ignored else ""))
        for line in ignored[:5]:
            print(f"  ignored: {line!r}")
        keep = list(a.keep_user_id)
        write_plan_files(out, a.target_org, steps, ids, keep, a.chunk_size, a.wait)
        if a.generate_only:
            print(f"Wrote {out / 'QUERIES.txt'} and {out / 'BULK_COMMANDS.sh'}. No org call made.")
            return 0

        keep, is_sandbox = preflight(a.target_org, ids, keep, a.chunk_size, out)
        write_plan_files(out, a.target_org, steps, ids, keep, a.chunk_size, a.wait)
        print("\nQuerying (read-only):")
        found = run_queries(a.target_org, steps, ids, keep, a.chunk_size, out)
        total = sum(len(v) for v in found.values())
        summary = {"org": a.target_org, "sandbox": is_sandbox, "time_utc": stamp, "user_ids": len(ids),
                   "kept_user_ids": keep, "mode": "execute" if a.execute else "query-only",
                   "steps": [{"step": s.name, "object": s.sobject, "operation": s.operation,
                              "records": len(found[s.key])} for s in steps], "total": total}
        print(f"  {'TOTAL':36} {total:6}")

        if a.execute and total:
            if not is_sandbox and not a.allow_production:
                raise TeardownError("Not executed. This is a PRODUCTION org; add --allow-production once approved.")
            confirm(a.target_org, total, a.confirm, sys.stdin.isatty() if interactive is None else interactive, ask)
            print("\nExecuting:")
            summary["execute"] = execute(a.target_org, steps, found, out, a.wait)
            print("\nQuerying again to check what is left:")
            after = run_queries(a.target_org, steps, ids, keep, a.chunk_size, out, label="_after")
            summary["remaining"] = {s.name: len(after[s.key]) for s in steps}
            left = sum(summary["remaining"].values())
            print(f"  {'REMAINING':36} {left:6}" + ("" if not left else "  <- check the *_after.csv files"))
        (out / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        write_csv(out / "summary.csv", ["step", "object", "operation", "records"],
                  [[x["step"], x["object"], x["operation"], x["records"]] for x in summary["steps"]])
        if not a.execute:
            print(f"\nQuery only. Nothing was changed. Review the CSVs in {out}, then re-run with --execute.")
            return 0
        if not total:
            print("\nNothing to change.")
            return 0
        failed = any(x["status"] == "ERROR" for x in summary["execute"])
        print(f"\nResults in {out}" + (" - at least one bulk job FAILED" if failed else ""))
        return 2 if failed else 0
    except TeardownError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
