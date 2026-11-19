"""Offline tests for sf-territory-export. No org is called (sf is mocked).

    python tests/run_tests.py
"""
import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(HERE / "fixtures"))

import build_fixtures  # noqa: E402
import territory_common as tc  # noqa: E402


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


exp = load("territory_export")
aud = load("territory_access_audit")
ops = load("territory_rule_operators")


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.a, cls.b = build_fixtures.build(cls.tmp / "json")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def sheet_rows(self, path, name):
        from openpyxl import load_workbook
        return list(load_workbook(path)[name].iter_rows(values_only=True))


class CommonTests(Base):
    def test_choose_model_defaults_to_active(self):
        models = tc.load_records(self.a, "models")
        self.assertEqual(tc.choose_model(models, None)["DeveloperName"], "Sales_Model")
        self.assertEqual(tc.choose_model(models, "Planning_Model")["Id"], "MODEL-2")
        with self.assertRaises(tc.TerritoryError):
            tc.choose_model(models, "Nope")
        with self.assertRaises(tc.TerritoryError):
            tc.choose_model([m for m in models if m["State"] != "Active"], None)

    def test_find_territory_by_devname_and_duplicate_name(self):
        terr = tc.load_records(self.a, "territories")
        self.assertEqual(tc.find_territory(terr, "Southwest_Child_1")["Id"], "T-211")
        # "Southwest" is the Name of two territories but the DeveloperName of one: DeveloperName wins.
        self.assertEqual(tc.find_territory(terr, "Southwest")["Id"], "T-21")

    def test_find_territory_ambiguous_name_is_an_error(self):
        terr = [t for t in tc.load_records(self.a, "territories") if t["Id"] != "T-21"]
        with self.assertRaises(tc.TerritoryError):
            tc.find_territory(terr + [dict(terr[0], Id="X", DeveloperName="Other", Name="All Regions")], "All Regions")

    def test_hierarchy_order(self):
        terr = [t for t in tc.load_records(self.a, "territories") if t["Territory2ModelId"] == "MODEL-1"]
        names = [(t["DeveloperName"], lvl) for t, lvl in tc.hierarchy(terr, "North")]
        self.assertEqual(names, [("North", 0), ("Northeast", 1), ("Northeast_Retail", 2), ("Northwest", 1),
                                 ("Strategic_Accounts_North", 1)])

    def test_flatten_and_truncation(self):
        rec = {"attributes": {}, "Id": "1", "User": {"attributes": {}, "Name": "A", "Profile": {"attributes": {}, "Name": "P"}}}
        self.assertEqual(tc.flatten(rec), {"Id": "1", "User.Name": "A", "User.Profile.Name": "P"})
        self.assertIn("TRUNCATED", tc.truncation_note({"result": {"records": [1], "totalSize": 5}}))
        self.assertEqual(tc.truncation_note({"result": {"records": [1], "totalSize": 1}}), "")
        self.assertEqual(tc.soql_literal("O'Brien"), "'O\\'Brien'")


class ExportTests(Base):
    def test_queries_have_model_filter(self):
        q = {tab: soql for tab, _, soql, _ in exp.build_queries("MODEL-1", False, False, [])}
        self.assertIn("WHERE Territory2ModelId = 'MODEL-1'", q["2_Territories"])
        self.assertIn("Territory2.Territory2ModelId = 'MODEL-1'", q["6_UserTerritories"])
        q_all = {tab: soql for tab, _, soql, _ in exp.build_queries(None, True, False, [])}
        self.assertNotIn("WHERE", q_all["2_Territories"])
        self.assertIn("8_ObjectTerritories", q_all)

    def test_field_checks_and_extra_queries(self):
        plan = exp.build_queries("M", False, True, ["My_Users=SELECT Id FROM User WHERE IsActive = true"])
        tabs = {tab: (soql, vertical) for tab, _, soql, vertical in plan}
        self.assertEqual(tabs["F_Account"], ("SELECT FIELDS(ALL) FROM Account LIMIT 1", True))
        self.assertEqual(tabs["My_Users"][0], "SELECT Id FROM User WHERE IsActive = true")
        with self.assertRaises(tc.TerritoryError):
            exp.build_queries("M", False, False, ["no equals sign"])

    def test_from_json_whole_model(self):
        out = self.tmp / "whole.xlsx"
        self.assertEqual(exp.main(["--from-json", str(self.a), "--output", str(out)]), 0)
        index = {r[0]: r for r in self.sheet_rows(out, "Index")[1:]}
        self.assertEqual(index["2_Territories"][1], 10)          # model 2's territory filtered out
        self.assertEqual(index["4_RuleItems"][1], 7)             # items of model 1 rules only
        self.assertTrue(all(r[2] in ("OK", "computed") for r in index.values()))
        hier = self.sheet_rows(out, "Hierarchy")
        self.assertEqual(hier[1][:3], (0, "All Regions", "All_Regions"))
        northeast = next(r for r in hier if r[2] == "Northeast")
        self.assertEqual((northeast[9], northeast[10], northeast[12]), (2, 1, 25))  # users, own rules, records

    def test_from_json_root_scope(self):
        out = self.tmp / "north.xlsx"
        exp.main(["--from-json", str(self.a), "--root-territory", "North", "--output", str(out)])
        index = {r[0]: r[1] for r in self.sheet_rows(out, "Index")[1:]}
        self.assertEqual(index["2_Territories"], 5)
        self.assertEqual(index["3_Rules"], 2)
        self.assertEqual(index["6_UserTerritories"], 2)

    def test_online_path_with_mocked_sf_saves_json_and_survives_a_failed_query(self):
        def fake_query(org, soql):
            self.assertEqual(org, "my-sandbox")
            if "UserTerritory2Association" in soql:
                raise tc.TerritoryError("INVALID_FIELD: simulated failure")
            for key in ("models", "territories", "rule_items", "rules", "rule_territories", "object_territory_counts"):
                obj = build_fixtures.SOBJECT[key]
                if f"FROM {obj}" in soql or (key == "object_territory_counts" and "COUNT(Id)" in soql):
                    return json.loads((self.a / f"{key}.json").read_text())
            raise AssertionError(soql)

        saved = self.tmp / "saved"
        out = self.tmp / "online.xlsx"
        with mock.patch.object(tc, "run_query", side_effect=fake_query):
            rc = exp.main(["-o", "my-sandbox", "--save-json", str(saved), "--output", str(out)])
        self.assertEqual(rc, 0)
        index = {r[0]: r for r in self.sheet_rows(out, "Index")[1:]}
        self.assertTrue(index["6_UserTerritories"][2].startswith("ERROR"))
        self.assertEqual(index["2_Territories"][2], "OK")
        self.assertTrue((saved / "territories.json").is_file())
        self.assertFalse((saved / "user_territories.json").exists())


class AccessAuditTests(Base):
    def test_analyse_finds_branch_and_parent_differences(self):
        terr = aud.model_territories(self.a, None)
        rows, patterns, parent_differs = aud.analyse(terr, None, 1)
        off = sorted(r["t"]["DeveloperName"] for r in rows if r["branch"] != aud.TOP and aud.access(r["t"]) != r["want"])
        self.assertEqual(off, ["South", "Strategic_Accounts_North"])
        self.assertEqual(sorted(t["DeveloperName"] for t in parent_differs), ["All_Regions", "South"])
        self.assertEqual(patterns["South"][0], ("Read", "Read", "Edit"))

    def test_workbook_with_compare(self):
        out = self.tmp / "audit.xlsx"
        rc = aud.main(["--json-dir", str(self.a), "--label", "org-a", "--compare", f"org-b={self.b}",
                       "--output", str(out)])
        self.assertEqual(rc, 0)
        rows = self.sheet_rows(out, "Territory Access")
        head = rows[1]
        self.assertEqual(head[:4], ("Should be: Account Access", "Should be: Opportunity Access",
                                    "Should be: Case Access", "Territory Name"))
        data = {r[20]: r for r in rows[2:]}
        self.assertEqual(data["Strategic_Accounts_North"][-1], "not there")
        self.assertTrue(data["Northwest"][-1].startswith("differs"))
        self.assertEqual(data["Northeast"][-1], "same")
        self.assertTrue(str(data["Northeast"][7]).startswith("=IF("))
        self.assertEqual(data["Strategic_Accounts_North"][0], "Read/Write")   # proposal = branch pattern
        summary = " ".join(str(c) for r in self.sheet_rows(out, "Summary") for c in r if c)
        self.assertIn("North Central", summary)
        self.assertIn("Southwest x2", summary)

    def test_no_proposal_and_root(self):
        out = self.tmp / "audit2.xlsx"
        aud.main(["--json-dir", str(self.a), "--root-territory", "South", "--no-proposal", "--output", str(out)])
        rows = self.sheet_rows(out, "Territory Access")[2:]
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(r[0] in (None, "") for r in rows))

    def test_missing_folder(self):
        self.assertEqual(aud.main(["--json-dir", str(self.tmp / "nope")]), 1)


class RuleOperatorTests(Base):
    def test_eval_filter(self):
        self.assertTrue(ops.eval_filter("1 AND (2 OR 3)", {1: True, 2: False, 3: True}, 3))
        self.assertFalse(ops.eval_filter("1 AND (2 OR 3)", {1: True, 2: False, 3: False}, 3))
        self.assertFalse(ops.eval_filter(None, {1: True, 2: False}, 2))   # no logic = AND
        self.assertTrue(ops.eval_filter("NOT 1 or 2", {1: False}, 2))
        with self.assertRaises(ValueError):
            ops.eval_filter("1 AND __import__('os')", {1: True}, 1)

    def test_combine(self):
        r = {"BooleanFilter": "1 AND (2 OR 3)"}
        its = [{"SortOrder": 1, "Field": "A"}, {"SortOrder": 2, "Field": "B"}, {"SortOrder": 3, "Field": "C"}]
        self.assertTrue(ops.combine(r, its, {"B", "C"}).startswith("ANY"))
        self.assertTrue(ops.combine({"BooleanFilter": None}, its, {"B", "C"}).startswith("ALL"))
        self.assertEqual(ops.combine(r, its, {"Z"}), "n/a - no focus-field lines")
        self.assertTrue(ops.combine(r, its, None).startswith("Mixed"))

    def test_workbook(self):
        out = self.tmp / "ops.xlsx"
        rc = ops.main(["--json-dir", str(self.a), "--focus-field", "Account.Sales_Code__c",
                       "--focus-field", "Account.Alt_Code__c", "--compare", f"org-b={self.b}", "--output", str(out)])
        self.assertEqual(rc, 0)
        crit = self.sheet_rows(out, "Rule Criteria")
        self.assertEqual(len(crit) - 1, 7)                       # 7 lines in model 1 (incl. unattached rule)
        contains = [r for r in crit[1:] if r[14] == "Contains"]
        self.assertEqual([(r[6], r[11]) for r in contains], [("Northeast_Rule", "Account.Sales_Code__c")])
        self.assertEqual(contains[0][-1], "equals")              # operator in org-b
        self.assertIn("(not attached)", [r[1] for r in crit[1:]])
        diff = self.sheet_rows(out, "Diff org-b")[1:]
        kinds = sorted((r[2], r[3]) for r in diff)
        self.assertIn(("Northwest_Rule", "Focus-field values differ"), kinds)
        self.assertIn(("Northeast_Rule", "Operators differ"), kinds)
        self.assertIn(("North_Central", "In org-b only"), kinds)
        by_terr = {r[2]: r for r in self.sheet_rows(out, "Rules by Territory")[1:]}
        self.assertTrue(by_terr["Northwest"][9].startswith("ALL"))
        self.assertTrue(by_terr["Northeast"][9].startswith("ANY"))
        self.assertEqual(by_terr["Southwest"][12], "Yes")       # inherited rule


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    sys.exit(0 if result.wasSuccessful() else 1)
