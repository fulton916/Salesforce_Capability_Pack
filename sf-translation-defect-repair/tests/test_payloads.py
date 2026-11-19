import tempfile
import unittest
from pathlib import Path

from helpers import gv, moji, pick, read_csv, run, write_bilingual, write_csv

import stf


class StfReader(unittest.TestCase):
    def test_sections_and_escapes(self):
        tmp = Path(tempfile.mkdtemp())
        p = write_bilingual(tmp / "Bilingual_de_2026-01-05 0900.stf", "de",
                            [("CustomField.Widget.Notes.HelpText", "a\\r\\nb", "x\\r\\ny"),
                             ("PicklistValue.Widget.Color.Red", "Red", "Rot")],
                            [("PicklistValue.Widget.Color.Blue", "Blue")])
        self.assertEqual(stf.stf_language(p), "de")
        tr = stf.translated(p)
        self.assertEqual(tr["CustomField.Widget.Notes.HelpText"], ("a\r\nb", "x\r\ny"))
        self.assertNotIn("PicklistValue.Widget.Color.Blue", tr)
        self.assertIn("PicklistValue.Widget.Color.Blue", stf.source_keys(p))


class EncodingPayload(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.fresh = self.tmp / "pull"
        # Live org state (the org pull). Global value set 'Flavor' is NOT in .stf exports.
        write_csv(self.fresh / "translations_de.csv", [
            gv("de", "Flavor", "Crème", moji("Crème")),                    # C: live, GVS
            pick("de", "Widget__c", "Stage__c", "Open – pending review", ""),  # A: key fix target
            pick("de", "Widget__c", "Kind__c", "Pre‑Assembled", "Vorâ€'montiert"),  # B: damaged, live
            pick("de", "Widget__c", "Kind__c", "Basic", "Einfach"),
            pick("de", "Widget__c", "Kind__c", "Trailing", "Ende â€"),        # unrepairable
        ])
        # The load file that was sent: corrupted key, translation echoed the damage.
        self.load = self.tmp / "load"
        write_csv(self.load / "translations_de.csv", [
            pick("de", "Widget__c", "Stage__c", moji("Open – pending review"),
                 "Offen " + moji("–") + " in Prüfung"),
            pick("de", "Widget__c", "Stage__c", moji("No such value – x"), "egal"),
        ])

    def test_builds_exact_repairs_only(self):
        out = self.tmp / "fix"
        r = run("build_encoding_fix_payload.py", self.fresh, "--out-dir", out,
                "--load-dir", self.load)
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = {(x["component"], x["masterLabel"]): x["translation"]
                for x in read_csv(out / "translations_de.csv")}
        self.assertEqual(rows, {
            ("Flavor", "Crème"): "Crème",
            ("Widget__c", "Open – pending review"): "Offen – in Prüfung",
            ("Widget__c", "Pre‑Assembled"): "Vor‑montiert",
        })
        report = read_csv(self.tmp / "fix_unrepairable.csv")
        reasons = " | ".join(x["reason"] for x in report)
        self.assertIn("not in the org pull", reasons)
        self.assertIn("no exact repair", reasons)

    def test_refuses_non_empty_out_dir(self):
        out = self.tmp / "fix"
        out.mkdir()
        (out / "old.csv").write_text("x")
        r = run("build_encoding_fix_payload.py", self.fresh, "--out-dir", out)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not empty", r.stderr)

    def test_casing_fix(self):
        write_csv(self.fresh / "translations_fr.csv", [gv("fr", "Flavor", "Crème", moji("CrèME"))])
        out = self.tmp / "fix2"
        r = run("build_encoding_fix_payload.py", self.fresh, "--out-dir", out,
                "--casing-fix", "CrèME=Crème")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(read_csv(out / "translations_fr.csv")[0]["translation"], "Crème")


class RekeyPayload(unittest.TestCase):
    def test_whitespace_only_rekey(self):
        tmp = Path(tempfile.mkdtemp())
        write_csv(tmp / "pull" / "translations_de.csv", [
            gv("de", "Sizes", "Extra Large ", ""),
            gv("de", "Sizes", "Medium", "Mittel"),
            gv("de", "Sizes", "1 - Small", ""),
        ])
        fails = write_csv(tmp / "fails.csv", [
            {"language": "de", "component": "Sizes-de", "masterLabel": "Extra Large",
             "translation": "Extragroß"},
            {"language": "de", "component": "Sizes", "masterLabel": "Small",
             "translation": "Klein"},                        # prefix differs: a decision
            {"language": "de", "component": "Sizes", "masterLabel": "Medium",
             "translation": "Mittel"},                       # exact already
        ], cols=["language", "component", "field", "masterLabel", "translation"])
        out = tmp / "rekey"
        r = run("build_rekey_payload.py", fails, tmp / "pull", "--out-dir", out)
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = read_csv(out / "translations_de.csv")
        self.assertEqual([(x["masterLabel"], x["translation"]) for x in rows],
                         [("Extra Large ", "Extragroß")])
        self.assertIn("needs a decision", r.stdout)


class Scan(unittest.TestCase):
    def test_scan_finds_gvs_only_in_pull(self):
        tmp = Path(tempfile.mkdtemp())
        write_csv(tmp / "pull" / "translations_de.csv", [
            gv("de", "Flavor", "Crème", moji("Crème")),
            pick("de", "Widget__c", "Kind__c", "Basic", "Einfach"),
        ])
        write_bilingual(tmp / "stf" / "Bilingual_de_2026-01-05 0900.stf", "de",
                        [("PicklistValue.Widget.Kind.Basic", "Basic", "Einfach")])
        out = tmp / "report.csv"
        r = run("scan_mojibake.py", "--stf-dir", tmp / "stf", "--out", out)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("global value set", r.stdout)
        r = run("scan_mojibake.py", "--stf-dir", tmp / "stf", "--csv-dir", tmp / "pull", "--out", out)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        rows = read_csv(out)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["Suggested repair"], "Crème")
        self.assertEqual(rows[0]["Kind"], "value")

    def test_scan_xml_and_xlsx(self):
        tmp = Path(tempfile.mkdtemp())
        d = tmp / "retrieve" / "globalValueSetTranslations"
        d.mkdir(parents=True)
        (d / "Flavor-de.globalValueSetTranslation-meta.xml").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<GlobalValueSetTranslation xmlns="http://soap.sforce.com/2006/04/metadata">\n'
            f'    <valueTranslation>\n        <masterLabel>Crème</masterLabel>\n'
            f'        <translation>{moji("Crème")}</translation>\n    </valueTranslation>\n'
            '</GlobalValueSetTranslation>\n', encoding="utf-8")
        out = tmp / "report.xlsx"
        r = run("scan_mojibake.py", "--xml-dir", tmp / "retrieve", "--out", out)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        import openpyxl
        ws = openpyxl.load_workbook(out).active
        self.assertEqual(ws.max_row, 2)
        self.assertEqual(ws.cell(row=2, column=3).value, "de")
        self.assertEqual(ws.cell(row=2, column=9).value, "Crème")


if __name__ == "__main__":
    unittest.main()
