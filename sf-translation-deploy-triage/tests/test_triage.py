import json
import tempfile
import unittest
from pathlib import Path

from helpers import (deploy_json, describe, fail, flabel, moji, pick, read_csv, rtype, run,
                     sheet, write_csv)

import triage_common as T

DE = "Widget__c-de"


def build(tmp: Path) -> dict:
    csv_dir = tmp / "csv"
    write_csv(csv_dir / "translations_de.csv", [
        pick("de", "Widget__c", "Color__c", "Red", "Rot"),
        pick("de", "Widget__c", "Color__c", "Purple", "Lila"),
        pick("de", "Widget__c", "Stage__c", "Review", "Prüfung"),
        pick("de", "Widget__c", "Stage__c", "Open", "Offen"),
        pick("de", "Widget__c", "Kind__c", moji("Pre‑Assembled"), "Vor" + moji("‑") + "montiert"),
        flabel("de", "Widget__c", "Region_Old__c", "Region", "Region"),
        flabel("de", "Widget__c", "Old__c", "Old", "Alt"),
        rtype("de", "Widget__c", "Review", "Review", "Prüfung"),
        flabel("de", "Widget__c", "Name", "Widget Name", "Widget-Name", typ="standard-field"),
    ])
    write_csv(csv_dir / "translations_fr.csv", [
        flabel("fr", "Gadget__c", "Name", "Gadget Name", "Nom du gadget", typ="standard-field"),
    ])
    fails = [
        fail(DE, "Invalid picklist value: Red in field: Widget__c.Color__c (12:5)"),
        fail(DE, "Invalid picklist value: Purple in field: Widget__c.Color__c (14:5)"),
        fail(DE, "Invalid picklist value: Review in field: Widget__c.Stage__c"),
        fail(DE, "Invalid picklist value: Open in field: Widget__c.Stage__c"),
        fail(DE, f"Invalid picklist value: {moji('Pre‑Assembled')} in field: Widget__c.Kind__c"),
        fail(DE, "In field: field - no CustomField named Widget__c.Region_Old__c found"),
        fail(DE, "In field: field - no CustomField named Widget__c.Old__c found"),
        fail(DE, "In field: recordType - no RecordType named Widget__c.Review found"),
        fail(DE, "Gender is required for language GERMAN"),
        fail("Gadget__c-fr", "Gender is required for language FRENCH"),
        fail("ns__Thing__c-de", "Deploying CustomObjectTranslation with namespaced language is not allowed: ns__de"),
        fail("Gizmo__c-nl_NL", "Cannot translate into nl_NL"),
        fail("Legacy__c-de", "Invalid object name: Legacy__c (1:1)"),
    ]
    dj = deploy_json(tmp / "deploy.json", fails, successes=["Account-de"], warning=True)
    desc = tmp / "describes"
    describe(desc / "Widget__c.json", "Widget__c", {
        "Color__c": ("Color", [("RED", "Red"), ("BLUE", "Blue")]),
        "Stage__c": ("Stage", [("S1", "1 - Review"), ("OPEN", "Open ")]),
        "Kind__c": ("Kind", [("PRE", "Pre‑Assembled")]),
        "Region_New__c": ("Region", []),
        "Name": ("Widget Name", []),
    })
    (desc / "_recordtypes.json").write_text(json.dumps({"result": {"records": [
        {"SobjectType": "Widget__c", "DeveloperName": "R_01", "Name": "1 - Review"}]}}))
    org = tmp / "org" / "objectTranslations" / "Gadget__c-fr"
    org.mkdir(parents=True)
    (org / "Name.fieldTranslation-meta.xml").write_text(
        "<CustomFieldTranslation><gender>Masculine</gender><name>Name</name></CustomFieldTranslation>")
    base = tmp / "baseline.txt"
    base.write_text("# known\nLegacy__c-de :: Invalid object name: Legacy__c\n", encoding="utf-8")
    pay = tmp / "payload" / "objectTranslations"
    (pay / DE).mkdir(parents=True)
    (pay / DE / "Color__c.fieldTranslation-meta.xml").write_text(
        "<x><label>Farbe</label><picklistValues><translation>Rot</translation></picklistValues></x>")
    (pay / "Account-de").mkdir()
    (pay / "Account-de" / "Name.fieldTranslation-meta.xml").write_text("<x><label>Kontoname</label></x>")
    return {"csv": csv_dir, "json": dj, "desc": desc, "org": tmp / "org", "base": base,
            "payload": tmp / "payload"}


class Categorise(unittest.TestCase):
    def test_categories(self):
        cases = {
            "Invalid picklist value: A in field: Widget__c.Color__c": T.VALUE_NOT_FOUND,
            "Invalid picklist value: A in picklist value set translations: Sizes-de": T.VALUE_NOT_FOUND,
            "There are 12 invalid picklist values": T.VALUE_NOT_FOUND,
            f"Invalid picklist value: {moji('Crème')} in field: Widget__c.Flavor__c": T.INVALID_CHARS,
            "Invalid picklist value: Crème in field: Widget__c.Flavor__c": T.VALUE_NOT_FOUND,
            "no CustomField named Widget__c.X__c found": T.DELETED_FIELD,
            "no RecordType named Widget__c.Big found": T.DELETED_RT,
            "no ValidationRule named Widget__c.Rule found": T.DELETED_COMPONENT,
            "Invalid object name: Gone__c": T.DELETED_COMPONENT,
            "Gender is required for language GERMAN": T.GENDER_REQUIRED,
            "StartsWith is required for language HUNGARIAN": T.GRAMMAR_REQUIRED,
            "'Common' is not a valid value for the enum 'Gender'": T.INVALID_GRAMMAR,
            "Deploying CustomObjectTranslation with namespaced language is not allowed: ns__de": T.NAMESPACED,
            "Cannot translate into nl_NL": T.CANNOT_TRANSLATE,
            "Something else entirely": T.OTHER,
        }
        for msg, cat in cases.items():
            with self.subTest(msg=msg):
                self.assertEqual(T.categorise(msg)[0], cat)

    def test_load_deploy_handles_bom_warning_and_dict(self):
        tmp = Path(tempfile.mkdtemp())
        p = deploy_json(tmp / "d.json", [fail("A-de", "x")], warning=True)
        res, fails, _ = T.load_deploy(p)
        self.assertEqual(len(fails), 1)
        doc = json.loads(p.read_bytes()[3:].decode().split("\n", 1)[1])
        doc["result"]["details"]["componentFailures"] = fail("A-de", "x")   # a single dict
        p.write_text(json.dumps(doc))
        self.assertEqual(len(T.load_deploy(p)[1]), 1)


class Triage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.f = build(cls.tmp)
        cls.out = cls.tmp / "errors.xlsx"
        cls.r = run("triage_deploy_errors.py", "--load", f"Load 1={cls.f['json']}={cls.f['csv']}={cls.f['payload']}",
                    "--out", cls.out, "--describes", cls.f["desc"], "--resolved-in-org", cls.f["org"],
                    "--baseline", cls.f["base"])

    def test_exit_code_flags_partial_deploy(self):
        self.assertEqual(self.r.returncode, 2, self.r.stderr)
        self.assertIn("DID NOT FULLY LAND", self.r.stdout)
        self.assertIn("translated elements LOST   : 2", self.r.stdout)

    def by_bad(self, tab):
        return {r["Bad Value"] or r["Field / Value Set"]: r for r in sheet(self.out, tab)}

    def test_value_diagnoses(self):
        rows = self.by_bad(T.VALUE_NOT_FOUND)
        self.assertTrue(rows["Red"]["Who Must Act"].startswith("No action"))
        self.assertIn("not in the org", rows["Purple"]["Diagnosis"])
        self.assertTrue(rows["Purple"]["Who Must Act"].startswith("Reviewer"))
        self.assertEqual(rows["Review"]["Suggested Key"], "1 - Review")
        self.assertEqual(rows["Review"]["Suggested Translation"], "1 - Prüfung")
        self.assertEqual(rows["Open"]["Suggested Key"], "Open ")
        self.assertTrue(rows["Open"]["Who Must Act"].startswith("Developer"))

    def test_invalid_characters_are_repaired(self):
        (row,) = sheet(self.out, T.INVALID_CHARS)
        self.assertEqual(row["Suggested Key"], "Pre‑Assembled")
        self.assertEqual(row["Suggested Translation"], "Vor‑montiert")
        self.assertTrue(row["Who Must Act"].startswith("Developer"))

    def test_field_and_record_type(self):
        rows = self.by_bad(T.DELETED_FIELD)
        self.assertEqual(rows["Widget__c.Region_Old__c"]["Suggested Key"], "Region_New__c")
        self.assertIn("deleted", rows["Widget__c.Old__c"]["Diagnosis"])
        (rt,) = sheet(self.out, T.DELETED_RT)
        self.assertEqual(rt["Suggested Key"], "R_01")
        self.assertEqual(rt["Suggested Translation"], "1 - Prüfung")

    def test_drops_stale_grammar_and_baseline(self):
        rows = sheet(self.out, T.GENDER_REQUIRED)
        self.assertEqual([r["Component"] for r in rows], [DE])
        self.assertIn("known baseline", self.r.stdout)
        import openpyxl
        names = openpyxl.load_workbook(self.out).sheetnames
        self.assertNotIn(T.DELETED_COMPONENT, names)
        self.assertIn(T.NAMESPACED, names)
        self.assertIn(T.CANNOT_TRANSLATE, names)

    def test_allow_partial_and_stf_resolution(self):
        stf = self.tmp / "stf" / "Bilingual_de_2026-01-05 0900.stf"
        stf.parent.mkdir()
        stf.write_text("------------------TRANSLATED-------------------\n\n"
                       "PicklistValue.Widget__c.Color.Purple\tPurple\tLila\t-\n", encoding="utf-8")
        out = self.tmp / "e2.xlsx"
        r = run("triage_deploy_errors.py", "--load", self.f["json"], "--out", out,
                "--describes", self.f["desc"], "--stf-dir", stf.parent, "--allow-partial",
                "--hide-diagnosis", T.DELETED_FIELD)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("Purple", {x["Bad Value"] for x in sheet(out, T.VALUE_NOT_FOUND)})
        self.assertTrue(all(not x["Diagnosis"] for x in sheet(out, T.DELETED_FIELD)))


class Baseline(unittest.TestCase):
    def test_write_and_subtract(self):
        tmp = Path(tempfile.mkdtemp())
        ref = deploy_json(tmp / "ref.json", [fail("A-de", "no CustomField named A.X__c found (3:1)")])
        base = tmp / "known.txt"
        self.assertEqual(run("subtract_baseline.py", ref, "--write-baseline", base).returncode, 0)
        same = deploy_json(tmp / "same.json", [fail("A-de", "no CustomField named A.X__c found (9:9)")])
        self.assertEqual(run("subtract_baseline.py", same, base).returncode, 0)
        new = deploy_json(tmp / "new.json", [fail("A-de", "no CustomField named A.X__c found"),
                                             fail("B-fr", "Gender is required for language FRENCH")])
        r = run("subtract_baseline.py", new, base, "--json-out", tmp / "new_only.json")
        self.assertEqual(r.returncode, 1)
        self.assertIn("NEW                : 1", r.stdout)
        self.assertEqual(len(json.loads((tmp / "new_only.json").read_text(encoding="utf-8"))), 1)


class SplitByOwner(unittest.TestCase):
    def test_tabs_per_party(self):
        tmp = Path(tempfile.mkdtemp())
        f = build(tmp)
        src = tmp / "errors.xlsx"
        run("triage_deploy_errors.py", "--load", f"L={f['json']}={f['csv']}", "--out", src,
            "--describes", f["desc"])
        r = run("split_by_owner.py", src)
        self.assertEqual(r.returncode, 0, r.stderr)
        import openpyxl
        wb = openpyxl.load_workbook(tmp / "errors_by_owner.xlsx")
        self.assertEqual(wb.sheetnames[0], "Summary")
        self.assertIn("Developer", wb.sheetnames)
        self.assertIn("Reviewer", wb.sheetnames)
        self.assertEqual(wb.sheetnames[-1], "No action")
        for name in wb.sheetnames[1:]:
            whos = {str(c.value) for c in wb[name]["N"][1:]}   # 'Who Must Act' column
            self.assertTrue(all(w.startswith(name) for w in whos), (name, whos))
        r = run("split_by_owner.py", src, "--out", tmp / "pc.xlsx", "--per-category")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Reviewer - Value Not Found", openpyxl.load_workbook(tmp / "pc.xlsx").sheetnames)


if __name__ == "__main__":
    unittest.main()
