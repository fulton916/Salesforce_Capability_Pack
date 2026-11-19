"""prevalidate_payload (offline, via a snapshot or a stub runner) and compare_retrieve_stf."""
import json
import tempfile
import unittest
from pathlib import Path

from helpers import run, write_bilingual

import crsafe
import prevalidate_payload as PV

HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n'
NSA = 'xmlns="http://soap.sforce.com/2006/04/metadata"'


def field_file(name: str, label: str, picks: list[tuple[str, str]], help_text: str = "") -> str:
    pv = "".join(f"    <picklistValues>\n        <masterLabel>{m}</masterLabel>\n"
                 f"        <translation>{t}</translation>\n    </picklistValues>\n" for m, t in picks)
    h = f"    <help>{help_text}</help>\n" if help_text else ""
    return (f"{HEAD}<CustomFieldTranslation {NSA}>\n{h}    <label>{label}</label>\n"
            f"    <name>{name}</name>\n{pv}</CustomFieldTranslation>\n")


def make_payload(root: Path) -> Path:
    w = root / "objectTranslations" / "Widget__c-de"
    w.mkdir(parents=True)
    # Help text with a CR that is part of the value: must survive the rewrite.
    (w / "Color__c.fieldTranslation-meta.xml").write_bytes(
        field_file("Color__c", "Farbe", [("Red", "Rot"), ("Gone", "Weg")],
                   help_text="eins&#13;\nzwei").encode("utf-8"))
    (w / "Old__c.fieldTranslation-meta.xml").write_text(field_file("Old__c", "Alt", []), encoding="utf-8", newline=chr(10))
    (w / "Name.fieldTranslation-meta.xml").write_text(field_file("Name", "Name", []), encoding="utf-8", newline=chr(10))
    (w / "Widget__c-de.objectTranslation-meta.xml").write_text(
        f"{HEAD}<CustomObjectTranslation {NSA}>\n"
        "    <recordTypes>\n        <label>Gross</label>\n        <name>Big</name>\n    </recordTypes>\n"
        "    <recordTypes>\n        <label>Klein</label>\n        <name>Small</name>\n    </recordTypes>\n"
        "    <validationRules>\n        <errorMessage>Fehler</errorMessage>\n"
        "        <name>Old_Rule</name>\n    </validationRules>\n</CustomObjectTranslation>\n",
        encoding="utf-8", newline=chr(10))
    g = root / "objectTranslations" / "Gadget__c-de"
    g.mkdir()
    (g / "Gadget__c-de.objectTranslation-meta.xml").write_text(
        f"{HEAD}<CustomObjectTranslation {NSA}>\n</CustomObjectTranslation>\n", encoding="utf-8", newline=chr(10))
    t = root / "translations"
    t.mkdir()
    (t / "de.translation-meta.xml").write_text(
        f"{HEAD}<Translations {NSA}>\n"
        "    <customLabels>\n        <label>Hallo</label>\n        <name>Greeting</name>\n    </customLabels>\n"
        "    <customLabels>\n        <label>Weg</label>\n        <name>Removed_Label</name>\n    </customLabels>\n"
        "</Translations>\n", encoding="utf-8", newline=chr(10))
    return root


def make_snapshot(d: Path) -> Path:
    d.mkdir(parents=True)
    (d / "Widget__c.json").write_text(json.dumps({"result": {"name": "Widget__c", "fields": [
        {"name": "Color__c", "picklistValues": [{"label": "Red", "value": "RED"}]},
        {"name": "Name", "picklistValues": []}]}}))
    (d / "_recordtypes.json").write_text(json.dumps([["Widget__c", "Big"]]))
    (d / "_validationrules.json").write_text(json.dumps([]))
    (d / "_customlabels.json").write_text(json.dumps(["Greeting"]))
    return d


class Prevalidate(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.payload = make_payload(self.tmp / "payload")
        self.snap = make_snapshot(self.tmp / "snap")

    def snapshot_bytes(self):
        return {p: p.read_bytes() for p in self.payload.rglob("*") if p.is_file()}

    def test_report_only_changes_nothing(self):
        before = self.snapshot_bytes()
        r = run("prevalidate_payload.py", self.payload, "--snapshot", self.snap)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("WOULD DROP", r.stdout)
        self.assertEqual(before, self.snapshot_bytes())

    def test_apply_strips_and_keeps_crs(self):
        r = run("prevalidate_payload.py", self.payload, "--snapshot", self.snap, "--apply")
        self.assertEqual(r.returncode, 0, r.stderr)
        w = self.payload / "objectTranslations" / "Widget__c-de"
        self.assertFalse((self.payload / "objectTranslations" / "Gadget__c-de").exists())
        self.assertFalse((w / "Old__c.fieldTranslation-meta.xml").exists())
        self.assertTrue((w / "Name.fieldTranslation-meta.xml").exists(), "renamed standard field kept")
        color = crsafe.parse(w / "Color__c.fieldTranslation-meta.xml").getroot()
        labels = [e.text for e in color.iter() if e.tag.endswith("masterLabel")]
        self.assertEqual(labels, ["Red"])
        self.assertEqual(crsafe.content_crs(color), 1, "the CR in the help text must survive")
        self.assertNotIn(b"\r", (w / "Color__c.fieldTranslation-meta.xml").read_bytes())
        obj = (w / "Widget__c-de.objectTranslation-meta.xml").read_text(encoding="utf-8")
        self.assertIn("<name>Big</name>", obj)
        self.assertNotIn("Small", obj)
        self.assertNotIn("Old_Rule", obj)
        tr = (self.payload / "translations" / "de.translation-meta.xml").read_text(encoding="utf-8")
        self.assertIn("Greeting", tr)
        self.assertNotIn("Removed_Label", tr)

    def test_refuses_apply_inside_force_app(self):
        fa = self.tmp / "force-app" / "main" / "default"
        make_payload(fa)
        r = run("prevalidate_payload.py", fa, "--snapshot", self.snap, "--apply")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("force-app", r.stderr)

    def test_failed_query_stops_the_run(self):
        def runner(args):
            if args[:2] == ["org", "display"]:
                return {"status": 0}
            return {"status": 1, "message": "session expired"}
        org = PV.OrgIndex("my-sandbox", runner=runner)
        with self.assertRaises(PV.OrgError):
            org.load_lists()

    def test_nothing_found_in_org_stops_the_run(self):
        def runner(args):
            if args[0] == "sobject":
                return {"status": 1, "message": "not found"}
            return {"status": 0, "result": {"records": []}}
        org = PV.OrgIndex("my-sandbox", runner=runner)
        org.load_lists()
        chk = PV.Checker(org, apply=True)
        before = self.snapshot_bytes()
        with self.assertRaises(PV.OrgError):
            chk.run(self.payload)
        self.assertEqual(before, self.snapshot_bytes())

    def test_live_runner_builds_index(self):
        calls = []

        def runner(args):
            calls.append(args)
            if args[0] == "sobject":
                return {"status": 0, "result": {"fields": [{"name": "Color__c", "picklistValues": []}]}}
            if "RecordType" in " ".join(args):
                return {"status": 0, "result": {"records": [{"SobjectType": "Widget__c",
                                                             "DeveloperName": "Big"}]}}
            return {"status": 0, "result": {"records": []}}
        org = PV.OrgIndex("my-sandbox", runner=runner)
        org.load_lists()
        self.assertIn(("Widget__c", "Big"), org.record_types)
        self.assertIsNotNone(org.describe("Widget__c"))
        self.assertTrue(all("my-sandbox" in c for c in calls))


class CompareRetrieveStf(unittest.TestCase):
    def test_compare(self):
        tmp = Path(tempfile.mkdtemp())
        ret = tmp / "retrieve" / "objectTranslations" / "Widget__c-de"
        ret.mkdir(parents=True)
        (ret / "Color__c.fieldTranslation-meta.xml").write_bytes(field_file(
            "Color__c", "Farbe", [("Red", "Rot"), ("Blue", "Blau")],
            help_text="eins&#13;\nzwei").encode("utf-8"))
        (ret / "Size__c.fieldTranslation-meta.xml").write_text(
            field_file("Size__c", "Groesse", []), encoding="utf-8", newline=chr(10))
        write_bilingual(tmp / "stf" / "Bilingual_de_2026-01-05 0900.stf", "de", [
            ("CustomField.Widget__c.Color.FieldLabel", "Color", "Farbe"),
            ("CustomField.Widget__c.Color.HelpText", "one\\r\\ntwo", "eins\\r\\nzwei"),
            ("PicklistValue.Widget__c.Color.Red", "Red", "Rot"),
            ("CustomField.Widget__c.Size.FieldLabel", "Size", "Größe"),       # DIFFERENT
            ("PicklistValue.Widget__c.Color.Green", "Green", "Grün"),         # MISSING
            ("CustomLabel.Not_Retrieved", "x", "y"),                          # not compared
        ])
        out = tmp / "cmp.json"
        r = run("compare_retrieve_stf.py", tmp / "retrieve", "--stf-dir", tmp / "stf", "--out", out)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        rep = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(rep["by_type"]["CustomField"].get("exact"), 2)
        self.assertEqual(rep["by_type"]["CustomField"].get("DIFFERENT"), 1)
        self.assertEqual(rep["by_type"]["PicklistValue"].get("MISSING"), 1)
        self.assertEqual(rep["by_type"]["PicklistValue"].get("EXTRA"), 1)
        self.assertEqual(rep["skipped"].get("CustomLabel"), 1)

    def test_lost_cr_is_reported(self):
        tmp = Path(tempfile.mkdtemp())
        ret = tmp / "retrieve" / "objectTranslations" / "Widget__c-de"
        ret.mkdir(parents=True)
        (ret / "Color__c.fieldTranslation-meta.xml").write_text(field_file(
            "Color__c", "Farbe", [], help_text="eins\nzwei"), encoding="utf-8", newline=chr(10))
        write_bilingual(tmp / "stf" / "Bilingual_de_2026-01-05 0900.stf", "de", [
            ("CustomField.Widget__c.Color.HelpText", "one\\r\\ntwo", "eins\\r\\nzwei")])
        out = tmp / "cmp.json"
        r = run("compare_retrieve_stf.py", tmp / "retrieve", "--stf-dir", tmp / "stf", "--out", out)
        self.assertEqual(r.returncode, 2)
        rep = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(rep["by_type"]["CustomField"].get("CR only"), 1)


class HelpRuns(unittest.TestCase):
    def test_every_script_has_help(self):
        scripts = sorted(p.name for p in (Path(__file__).resolve().parent.parent / "scripts").glob("*.py"))
        for s in scripts:
            if s in ("stf.py", "tcsv.py"):
                continue
            with self.subTest(script=s):
                r = run(s, "--help")
                self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main()
