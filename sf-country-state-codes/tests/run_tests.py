# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Offline tests for export_country_state_codes.py. No org is called.

    python tests/run_tests.py
"""
import importlib.util
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "scripts" / "export_country_state_codes.py"
FIXTURE = HERE / "fixtures" / "Address.settings-meta.xml"

spec = importlib.util.spec_from_file_location("cscodes", SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ParseTests(unittest.TestCase):
    def setUp(self):
        self.rows = m.parse_address_settings(FIXTURE)

    def test_row_count_one_per_state_or_stateless_country(self):
        # US: 2 states, Iceland: none (1 row), Canada: 2 states
        self.assertEqual(len(self.rows), 5)

    def test_sorted_by_country_then_state(self):
        keys = [(r["Country"], r["State"]) for r in self.rows]
        self.assertEqual(keys, [
            ("Canada", "Custom Region"), ("Canada", "Ontario"), ("Iceland", ""),
            ("United States", "Alaska"), ("United States", "Texas"),
        ])

    def test_columns_and_values(self):
        self.assertEqual(list(self.rows[0].keys()), m.HEADERS)
        tx = next(r for r in self.rows if r["State Code"] == "TX")
        self.assertEqual(tx["Country Code"], "US")
        self.assertEqual(tx["Country Org Default"], "true")
        self.assertEqual(tx["State Integration Value"], "Texas")
        zz = next(r for r in self.rows if r["State Code"] == "ZZ")
        self.assertEqual(zz["State Salesforce Standard"], "false")
        self.assertEqual(zz["Country Integration Value"], "CA-INT")

    def test_stateless_country_has_blank_state_columns(self):
        iceland = next(r for r in self.rows if r["Country Code"] == "IS")
        self.assertTrue(all(iceland[h] == "" for h, _ in m.STATE_FIELDS))
        self.assertEqual(iceland["Country Active"], "false")

    def test_summary(self):
        self.assertEqual(m.summarize(self.rows),
                         {"countries": 3, "active_countries": 2, "states": 4, "active_states": 3})


class ErrorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_bad_xml(self):
        p = self.tmp / "bad.xml"
        p.write_text("<AddressSettings><oops", encoding="utf-8")
        with self.assertRaises(m.ExportError):
            m.parse_address_settings(p)

    def test_missing_section(self):
        p = self.tmp / "empty.xml"
        p.write_text('<AddressSettings xmlns="http://soap.sforce.com/2006/04/metadata"/>', encoding="utf-8")
        with self.assertRaises(m.ExportError):
            m.parse_address_settings(p)

    def test_skip_retrieve_needs_a_path(self):
        with self.assertRaises(m.ExportError):
            m.resolve_xml_path(None, None)

    def test_project_dir_must_be_a_project(self):
        with self.assertRaises(m.ExportError):
            m.retrieve_address_settings(self.tmp, "my-sandbox", None)


class CommandTests(unittest.TestCase):
    def test_org_is_passed_when_given(self):
        cmd = m.build_retrieve_command("sf", "my-sandbox", "67.0")
        self.assertIn("Settings:Address", cmd)
        self.assertEqual(cmd[cmd.index("--target-org") + 1], "my-sandbox")
        self.assertEqual(cmd[cmd.index("--api-version") + 1], "67.0")

    def test_default_org_when_omitted(self):
        self.assertNotIn("--target-org", m.build_retrieve_command("sf", None, None))

    def test_retrieve_uses_temp_project_and_cleans_up(self):
        seen = {}

        def fake_run(cmd, cwd, **kw):
            seen["cwd"] = Path(cwd)
            target = Path(cwd) / m.DEFAULT_XML
            target.parent.mkdir(parents=True)
            shutil.copy(FIXTURE, target)
            return mock.Mock(returncode=0, stdout='{"status":0}', stderr="")

        out = Path(tempfile.mkdtemp()) / "out.xlsx"
        with mock.patch.object(m.shutil, "which", return_value="sf"), \
                mock.patch.object(m.subprocess, "run", side_effect=fake_run):
            m.run(m.parse_args(["--target-org", "my-sandbox", "--output", str(out)]))
        self.assertTrue(out.is_file())
        self.assertFalse(seen["cwd"].exists(), "temporary project should be deleted")


class WorkbookTests(unittest.TestCase):
    def test_workbook_written(self):
        from openpyxl import load_workbook
        out = Path(tempfile.mkdtemp()) / "codes.xlsx"
        rc = m.main(["--skip-retrieve", "--xml-path", str(FIXTURE), "--output", str(out)])
        self.assertEqual(rc, 0)
        ws = load_workbook(out).active
        self.assertEqual(ws.title, "Country_State_Codes")
        self.assertEqual([c.value for c in ws[1]], m.HEADERS)
        self.assertEqual(ws.max_row, 6)
        self.assertEqual(ws.freeze_panes, "A2")
        self.assertIn("CountryStateCodes", ws.tables)


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    sys.exit(0 if result.wasSuccessful() else 1)
