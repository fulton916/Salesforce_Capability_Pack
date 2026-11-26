# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Offline tests for user_access_teardown.py. `sf` is mocked; no org is called.

    python tests/run_tests.py
"""
import csv
import importlib.util
import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "scripts" / "user_access_teardown.py"
spec = importlib.util.spec_from_file_location("teardown", SCRIPT)
td = importlib.util.module_from_spec(spec)
sys.modules["teardown"] = td   # dataclasses need the module registered
spec.loader.exec_module(td)

# Synthetic, obviously fake User Ids (005 + 12 characters).
U = [f"005FAKE{n:08d}" for n in range(1, 6)]
ME = "005FAKE00000099"


def ids_file(tmp: Path, lines) -> Path:
    p = tmp / "user_ids.txt"
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


class FakeOrg:
    """Answers the sf calls the script makes. Records disappear once their bulk job runs."""

    def __init__(self, sandbox=True, fail_step=None, include_me=False):
        self.sandbox, self.fail_step = sandbox, fail_step
        self.calls = []
        users = U + ([ME] if include_me else [])
        self.data = {
            "psg": [{"Id": f"0PAG{n}", "AssigneeId": u} for n, u in enumerate(users[:2])],
            "ps": [{"Id": f"0PAP{n}", "AssigneeId": u} for n, u in enumerate(users[:3])],
            "psl": [{"Id": f"2LAL{n}", "AssigneeId": u} for n, u in enumerate(users[:1])],
            "territory": [{"Id": f"0R0T{n}", "UserId": u} for n, u in enumerate(users[:2])],
            "groups": [],
            "queues": [{"Id": f"011Q{n}", "UserOrGroupId": u} for n, u in enumerate(users[:1])],
            "role": [{"Id": u, "Username": f"user{n}@example.com",
                      "UserRole": {"attributes": {}, "DeveloperName": "Sales_Rep", "Name": "Sales Rep"}}
                     for n, u in enumerate(users[:4])],
        }
        self.users = [{"Id": u, "Username": "me@example.com" if u == ME else f"user{n}@example.com",
                       "Name": f"User {n}", "IsActive": True}
                      for n, u in enumerate(users[:4] + ([ME] if include_me else []))]

    def step_of(self, soql):
        for s in td.STEPS:
            if f"FROM {s.sobject} WHERE" in soql and (not s.where or s.where in soql):
                if s.key == "ps" and "PermissionSetGroupId != null" in soql:
                    continue
                return s
        return None

    def __call__(self, args):
        self.calls.append(args)
        if args[:2] == ["org", "display"]:
            return {"status": 0, "result": {"username": "me@example.com"}}
        if args[:2] == ["data", "query"]:
            soql = args[args.index("--query") + 1]
            if "FROM Organization" in soql:
                recs = [{"Id": "00DFAKE", "Name": "Example Org", "IsSandbox": self.sandbox}]
            elif soql.startswith("SELECT Id, Username, Name, IsActive"):
                recs = [u for u in self.users if u["Id"] in soql]
            else:
                s = self.step_of(soql)
                assert s, soql
                field = "Id" if s.key == "role" else s.user_field
                recs = [r for r in self.data[s.key] if f"'{r[field]}'" in soql.split(" NOT IN ")[0]
                        and not (" NOT IN " in soql and f"'{r[field]}'" in soql.split(" NOT IN ")[1])]
            return {"status": 0, "result": {"records": recs, "totalSize": len(recs), "done": True}}
        if args[:3] in (["data", "delete", "bulk"], ["data", "update", "bulk"]):
            sobject = args[args.index("--sobject") + 1]
            file = Path(args[args.index("--file") + 1])
            step = next(s for s in td.STEPS if file.name.startswith(s.name))
            assert step.sobject == sobject
            if step.key == self.fail_step:
                return {"status": 1, "message": "simulated bulk failure", "result": {}}
            with file.open(newline="", encoding="utf-8") as fh:
                done = {r["Id"] for r in csv.DictReader(fh)}
            self.data[step.key] = [r for r in self.data[step.key] if r["Id"] not in done]
            return {"status": 0, "result": {"jobInfo": {"numberRecordsProcessed": len(done), "numberRecordsFailed": 0}}}
        raise AssertionError(args)

    def bulk_calls(self):
        return [a[a.index("--file") + 1].split("\\")[-1].split("/")[-1] for a in self.calls if "bulk" in a]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.out = self.tmp / "out"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def main(self, extra, org=None, ask=lambda _: "", interactive=False):
        args = ["--user-ids", str(ids_file(self.tmp, U)), "-o", "my-sandbox", "--out", str(self.out), *extra]
        buf_out, buf_err = io.StringIO(), io.StringIO()
        with redirect_stdout(buf_out), redirect_stderr(buf_err):
            if org is None:
                with mock.patch.object(td.shutil, "which", return_value=None):
                    rc = td.main(args, ask=ask, interactive=interactive)
            else:
                with mock.patch.object(td, "sf", side_effect=org):
                    rc = td.main(args, ask=ask, interactive=interactive)
        self.stdout, self.stderr = buf_out.getvalue(), buf_err.getvalue()
        return rc


class InputTests(Base):
    def test_read_user_ids(self):
        p = ids_file(self.tmp, ["User Id", "", "# comment", U[0], f'"{U[1]}",', U[0] + "AAA",
                                "not-an-id", U[2]])
        ids, ignored, dupes = td.read_user_ids(p)
        self.assertEqual(ids, [U[0], U[1], U[2]])
        self.assertEqual(ignored, ["not-an-id"])
        self.assertEqual(dupes, 1)   # 18-char form of U[0]

    def test_build_soql(self):
        step = next(s for s in td.STEPS if s.key == "queues")
        q = td.build_soql(step, U[:2], [ME])
        self.assertEqual(q, "SELECT Id, UserOrGroupId, Group.DeveloperName, Group.Name FROM GroupMember "
                            f"WHERE UserOrGroupId IN ('{U[0]}','{U[1]}') AND Group.Type = 'Queue' "
                            f"AND UserOrGroupId NOT IN ('{ME}')")
        role = td.build_soql(td.STEPS[-1], U[:1], [])
        self.assertIn("FROM User WHERE Id IN", role)
        self.assertIn("UserRoleId != null", role)

    def test_select_steps_keeps_safe_order(self):
        self.assertEqual([s.key for s in td.select_steps("role,psl,ps")], ["ps", "psl", "role"])
        with self.assertRaises(td.TeardownError):
            td.select_steps("ps,bogus")

    def test_no_ids(self):
        p = ids_file(self.tmp, ["header only"])
        with redirect_stderr(io.StringIO()):
            rc = td.main(["--user-ids", str(p), "-o", "x", "--generate-only", "--out", str(self.out)])
        self.assertEqual(rc, 1)


class GenerateOnlyTests(Base):
    def test_generate_only_writes_queries_and_commands_without_sf(self):
        rc = self.main(["--generate-only", "--chunk-size", "2", "--keep-user-id", ME])
        self.assertEqual(rc, 0)
        queries = (self.out / "QUERIES.txt").read_text()
        self.assertEqual(queries.count("--- chunk "), 3 * len(td.STEPS))   # 5 ids / 2 per chunk = 3 chunks
        self.assertIn("chunk 3 of 3 (1 users)", queries)
        self.assertEqual(queries.count(f"NOT IN ('{ME}')"), 3 * len(td.STEPS))
        cmds = (self.out / "BULK_COMMANDS.sh").read_text()
        self.assertIn('sf data delete bulk --sobject PermissionSetAssignment --file 1_PermissionSetGroupAssignments_ids.csv '
                      '--target-org "$ORG" --wait 30 --line-ending LF', cmds)
        self.assertIn("sf data update bulk --sobject User --file 7_UserRoles_update.csv", cmds)
        self.assertIn('ORG="my-sandbox"', cmds)
        order = [cmds.index(s.name) for s in td.STEPS]
        self.assertEqual(order, sorted(order))


class QueryOnlyTests(Base):
    def test_query_only_writes_csvs_and_changes_nothing(self):
        org = FakeOrg()
        rc = self.main([], org=org)
        self.assertEqual(rc, 0, self.stderr)
        self.assertEqual(org.bulk_calls(), [])
        summary = json.loads((self.out / "summary.json").read_text())
        self.assertEqual(summary["mode"], "query-only")
        self.assertEqual({s["step"]: s["records"] for s in summary["steps"]}["2_PermissionSetAssignments"], 3)
        self.assertEqual(summary["total"], 2 + 3 + 1 + 2 + 0 + 1 + 4)
        with (self.out / "7_UserRoles_update.csv").open(newline="") as fh:
            rows = list(csv.reader(fh))
        self.assertEqual(rows[0], ["Id", "UserRoleId"])
        self.assertTrue(all(r[1] == "#N/A" for r in rows[1:]))
        detail = (self.out / "7_UserRoles.csv").read_text().splitlines()
        self.assertEqual(detail[0], "Id,Username,UserRole.DeveloperName,UserRole.Name")
        self.assertIn("Sales_Rep", detail[1])
        self.assertNotIn(b"\r", (self.out / "1_PermissionSetGroupAssignments_ids.csv").read_bytes())
        self.assertEqual((self.out / "missing_user_ids.txt").read_text().split(), [U[4]])
        self.assertIn("Nothing was changed", self.stdout)


class ExecuteTests(Base):
    def test_wrong_confirm_refuses(self):
        org = FakeOrg()
        self.assertEqual(self.main(["--execute", "--confirm", "5"], org=org), 1)
        self.assertIn("--confirm 13", self.stderr)
        self.assertEqual(org.bulk_calls(), [])

    def test_no_terminal_and_no_confirm_refuses(self):
        org = FakeOrg()
        self.assertEqual(self.main(["--execute"], org=org, interactive=False), 1)
        self.assertEqual(org.bulk_calls(), [])

    def test_interactive_wrong_answer_refuses(self):
        org = FakeOrg()
        self.assertEqual(self.main(["--execute"], org=org, interactive=True, ask=lambda _: "yes"), 1)
        self.assertEqual(org.bulk_calls(), [])

    def test_production_needs_allow_flag(self):
        org = FakeOrg(sandbox=False)
        self.assertEqual(self.main(["--execute", "--confirm", "13"], org=org), 1)
        self.assertIn("PRODUCTION", self.stderr)
        self.assertEqual(org.bulk_calls(), [])
        org = FakeOrg(sandbox=False)
        self.assertEqual(self.main(["--execute", "--confirm", "13", "--allow-production"], org=org), 0)

    def test_execute_in_order_then_verify(self):
        org = FakeOrg()
        rc = self.main(["--execute"], org=org, interactive=True, ask=lambda _: "my-sandbox")
        self.assertEqual(rc, 0, self.stderr)
        self.assertEqual(org.bulk_calls(), ["1_PermissionSetGroupAssignments_ids.csv", "2_PermissionSetAssignments_ids.csv",
                                            "3_PermissionSetLicenseAssignments_ids.csv", "4_TerritoryAssignments_ids.csv",
                                            "6_QueueMemberships_ids.csv", "7_UserRoles_update.csv"])  # groups: 0 rows
        summary = json.loads((self.out / "summary.json").read_text())
        self.assertEqual(sum(summary["remaining"].values()), 0)
        self.assertEqual(summary["execute"][0]["numberRecordsProcessed"], 2)
        self.assertTrue((self.out / "1_PermissionSetGroupAssignments_after.csv").is_file())

    def test_bulk_failure_stops_later_steps(self):
        org = FakeOrg(fail_step="ps")
        rc = self.main(["--execute", "--confirm", "13"], org=org)
        self.assertEqual(rc, 2)
        self.assertEqual(org.bulk_calls(), ["1_PermissionSetGroupAssignments_ids.csv", "2_PermissionSetAssignments_ids.csv"])
        summary = json.loads((self.out / "summary.json").read_text())
        self.assertEqual(summary["remaining"]["3_PermissionSetLicenseAssignments"], 1)

    def test_failed_check_afterwards_still_saves_summary(self):
        class QueryDiesAfterBulk(FakeOrg):
            def __call__(self, args):
                if args[:2] == ["data", "query"] and self.bulk_calls():
                    return {"status": 1, "message": "simulated query outage"}
                return super().__call__(args)
        org = QueryDiesAfterBulk()
        rc = self.main(["--execute", "--confirm", "13"], org=org)
        self.assertEqual(rc, td.EXIT_CHECK_FAILED)
        self.assertEqual(td.EXIT_CHECK_FAILED, 3)
        self.assertIn("Changes were made, but the check afterwards failed", self.stderr)
        self.assertIn("simulated query outage", self.stderr)
        self.assertIn("Re-run without --execute to see what is left.", self.stderr)
        summary = json.loads((self.out / "summary.json").read_text())
        self.assertEqual(summary["execute"][0]["numberRecordsProcessed"], 2)
        self.assertNotIn("remaining", summary)
        self.assertIn("simulated query outage", summary["remaining_check_failed"])
        self.assertTrue((self.out / "summary.csv").is_file())
        self.assertEqual(len(org.bulk_calls()), 6)   # the writes themselves ran as before

    def test_own_user_is_kept(self):
        org = FakeOrg(include_me=True)
        p = ids_file(self.tmp, U + [ME])
        with redirect_stdout(io.StringIO()) as out, mock.patch.object(td, "sf", side_effect=org):
            rc = td.main(["--user-ids", str(p), "-o", "my-sandbox", "--out", str(self.out)])
        self.assertEqual(rc, 0)
        self.assertIn("excluded from every step", out.getvalue())
        self.assertIn(ME, json.loads((self.out / "summary.json").read_text())["kept_user_ids"])
        self.assertIn(f"NOT IN ('{ME}')", (self.out / "QUERIES.txt").read_text())

    def test_truncated_query_is_an_error(self):
        def org(args):
            if args[:2] == ["org", "display"]:
                return {"status": 0, "result": {"username": "me@example.com"}}
            return {"status": 0, "result": {"records": [{"Id": "x", "IsSandbox": True, "Name": "n"}], "totalSize": 9}}
        self.assertEqual(self.main([], org=org), 1)
        self.assertIn("org-max-query-limit", self.stderr)


class FindCountsTests(unittest.TestCase):
    def test_nested(self):
        self.assertEqual(td.find_counts({"a": [{"jobInfo": {"numberRecordsProcessed": 3, "numberRecordsFailed": 1}}]}),
                         {"numberRecordsProcessed": 3, "numberRecordsFailed": 1})


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    sys.exit(0 if result.wasSuccessful() else 1)
