"""Reviewer hand-off files: grammar, action file, workbook marking."""
import tempfile
import unittest
from pathlib import Path

import openpyxl

from helpers import deploy_json, describe, fail, flabel, pick, read_csv, run, sheet, write_csv


def grammar_fixture(tmp: Path):
    csv_dir = tmp / "csv"
    write_csv(csv_dir / "translations_de.csv", [
        flabel("de", "Widget__c", "Name", "Widget Name", "Widget-Name", typ="standard-field"),
        flabel("de", "Widget__c", "Owner", "Owner", "Besitzer", typ="standard-field"),
        flabel("de", "Widget__c", "Color__c", "Color", "Farbe"),
        flabel("de", "Gadget__c", "Name", "Gadget Name", "Gadget-Name", typ="standard-field"),
    ])
    write_csv(csv_dir / "translations_fr.csv", [
        flabel("fr", "Widget__c", "Name", "Widget Name", "Nom du widget", typ="standard-field"),
    ])
    write_csv(csv_dir / "translations_hu.csv", [
        flabel("hu", "Widget__c", "Name", "Widget Name", "Widget neve", typ="standard-field"),
    ])
    dj = deploy_json(tmp / "deploy.json", [
        fail("Widget__c-de", "Gender is required for language GERMAN"),
        fail("Widget__c-fr", "Gender is required for language FRENCH"),
        fail("Widget__c-hu", "StartsWith is required for language HUNGARIAN"),
    ], successes=["Gadget__c-de"])
    return csv_dir, dj


def fill(path: Path, tab: str, answers: dict, key_cols: tuple, ans_col: str):
    wb = openpyxl.load_workbook(path)
    ws = wb[tab]
    hdr = [c.value for c in ws[1]]
    for row in ws.iter_rows(min_row=2):
        k = tuple(row[hdr.index(c)].value for c in key_cols)
        if k in answers:
            row[hdr.index(ans_col)].value = answers[k]
    wb.save(path)


class Grammar(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.csv, self.dj = grammar_fixture(self.tmp)
        self.xlsx = self.tmp / "grammar.xlsx"
        r = run("make_grammar_file.py", self.dj, self.csv, "--out", self.xlsx)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_rows_expand_component_errors(self):
        rows = sheet(self.xlsx, "Grammar Values Needed")
        got = {(r["Object"], r["Field API Name"], r["Language Code"], r["Attribute"]) for r in rows}
        self.assertEqual(got, {
            ("Widget__c", "Name", "de", "Gender"), ("Widget__c", "Owner", "de", "Gender"),
            ("Widget__c", "Name", "fr", "Gender"),
            ("Widget__c", "Name", "fr", "Starts with vowel or consonant sound"),
            ("Widget__c", "Name", "hu", "Starts with vowel or consonant sound"),
        })
        de = next(r for r in rows if r["Language Code"] == "de")
        self.assertEqual(de["Valid Answers"], "Masculine, Feminine, Neuter")
        ws = openpyxl.load_workbook(self.xlsx)["Grammar Values Needed"]
        self.assertGreater(len(ws.data_validations.dataValidation), 0)

    def answer_all(self, de_gender="Masculine"):
        key = ("Object", "Field API Name", "Language Code", "Attribute")
        fill(self.xlsx, "Grammar Values Needed", {
            ("Widget__c", "Name", "de", "Gender"): de_gender,
            ("Widget__c", "Owner", "de", "Gender"): "Masculine",
            ("Widget__c", "Name", "fr", "Gender"): "Masculine",
            ("Widget__c", "Name", "fr", "Starts with vowel or consonant sound"): "Consonant sound",
            ("Widget__c", "Name", "hu", "Starts with vowel or consonant sound"): "Vowel sound",
        }, key, "ANSWER")

    def test_apply_scopes_to_failed_components(self):
        self.answer_all()
        out = self.tmp / "redeploy"
        r = run("apply_grammar_file.py", self.xlsx, self.csv, self.dj, "-d", out)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        de = read_csv(out / "translations_de.csv")
        self.assertEqual({x["component"] for x in de}, {"Widget__c"}, "Gadget__c landed; not redeployed")
        self.assertEqual(len(de), 3, "every row of the failing component is in scope")
        name = next(x for x in de if x["field"] == "Name")
        self.assertEqual(name["gender"], "Masculine")
        fr = read_csv(out / "translations_fr.csv")[0]
        self.assertEqual((fr["gender"], fr["startsWith"]), ("Masculine", "Consonant"))
        self.assertEqual(read_csv(out / "translations_hu.csv")[0]["startsWith"], "Vowel")

    def test_invalid_answer_stops(self):
        self.answer_all(de_gender="Common")
        r = run("apply_grammar_file.py", self.xlsx, self.csv, self.dj, "-d", self.tmp / "x")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Common", r.stderr)

    def test_blank_answers_stop_unless_allowed(self):
        r = run("apply_grammar_file.py", self.xlsx, self.csv, self.dj, "-d", self.tmp / "y")
        self.assertEqual(r.returncode, 1)
        self.assertFalse((self.tmp / "y").exists() and any((self.tmp / "y").iterdir()))
        r = run("apply_grammar_file.py", self.xlsx, self.csv, self.dj, "-d", self.tmp / "z",
                "--allow-incomplete")
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_known_prefills(self):
        self.answer_all()
        again = self.tmp / "again.xlsx"
        r = run("make_grammar_file.py", self.dj, self.csv, "--out", again, "--known", self.xlsx)
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = sheet(again, "Grammar Values Needed")
        self.assertTrue(all(r["ANSWER"] for r in rows))


class ActionFile(unittest.TestCase):
    def test_make_and_apply(self):
        tmp = Path(tempfile.mkdtemp())
        csv_dir = tmp / "csv"
        write_csv(csv_dir / "translations_it.csv", [
            flabel("it", "Widget__c", "Name", "Widget Name", "Nome widget", typ="standard-field"),
            pick("it", "Widget__c", "Stage__c", "Sales/Service", "Vendite"),
            pick("it", "Widget__c", "Stage__c", "Ghost", "Fantasma"),
            pick("it", "Widget__c", "Stage__c", "Closed", "Chiuso"),
            pick("it", "Widget__c", "Stage__c", "Untranslated", ""),
        ])
        dj = deploy_json(tmp / "deploy.json", [
            fail("Widget__c-it", "StartsWith is required for language ITALIAN"),
            fail("Widget__c-it", "Invalid picklist value: Sales/Service in field: Widget__c.Stage__c"),
        ])
        describe(tmp / "desc" / "Widget__c.json", "Widget__c", {"Stage__c": ("Stage", [
            ("SALES_SERVICE", "Sales/Service"), ("Closed", "Closed")])})
        out = tmp / "action.xlsx"
        r = run("make_action_file.py", dj, csv_dir, "--describes", tmp / "desc", "--out", out)
        self.assertEqual(r.returncode, 0, r.stderr)
        t2 = {x["Value Sent"]: x for x in sheet(out, "2. Picklist API Names")}
        self.assertEqual(set(t2), {"Sales/Service", "Ghost", "Closed"})
        self.assertEqual(t2["Sales/Service"]["Suggested API Name (from org)"], "SALES_SERVICE")
        self.assertEqual(t2["Ghost"]["Status"], "NOT FOUND in org")
        self.assertEqual(t2["Closed"]["Status"], "Already correct")

        wb = openpyxl.load_workbook(out)
        ws1 = wb["1. Starts With Needed"]
        ws1.cell(row=2, column=7).value = "No"
        ws2 = wb["2. Picklist API Names"]
        for row in ws2.iter_rows(min_row=2):
            if row[1].value == "Sales/Service":
                row[5].value = "Yes"
            if row[1].value == "Ghost":
                row[6].value = "DROP"
        wb.save(out)
        res = tmp / "applied"
        r = run("apply_action_file.py", out, csv_dir, "-d", res)
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = read_csv(res / "translations_it.csv")
        labels = [x["masterLabel"] for x in rows if x["masterLabel"]]
        self.assertIn("SALES_SERVICE", labels)
        self.assertNotIn("Ghost", labels)
        self.assertEqual(next(x for x in rows if x["field"] == "Name")["startsWith"], "Consonant")
        self.assertEqual(next(x for x in rows if x["masterLabel"] == "SALES_SERVICE")["translation"],
                         "Vendite")

    def test_bad_answer_stops(self):
        tmp = Path(tempfile.mkdtemp())
        csv_dir = tmp / "csv"
        write_csv(csv_dir / "translations_it.csv", [
            flabel("it", "Widget__c", "Name", "Widget Name", "Nome", typ="standard-field")])
        dj = deploy_json(tmp / "d.json", [fail("Widget__c-it", "StartsWith is required for language ITALIAN")])
        out = tmp / "a.xlsx"
        run("make_action_file.py", dj, csv_dir, "--out", out)
        wb = openpyxl.load_workbook(out)
        wb["1. Starts With Needed"].cell(row=2, column=7).value = "Maybe"
        wb.save(out)
        r = run("apply_action_file.py", out, csv_dir, "-d", tmp / "o")
        self.assertNotEqual(r.returncode, 0)


class MarkCells(unittest.TestCase):
    def workbook(self, path: Path):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["type", "component", "field", "masterLabel", "source",
                   "German Existing Value", "German Translation", "fr Existing Value", "fr Translation"])
        ws.append(["field-label", "Widget__c", "Color__c", "", "Color", "", "", "", ""])
        ws.append(["field-label", "Widget__c", "Size__c", "", "Size", "Groesse", "", "", ""])
        ws.append(["field-label", "Widget__c", "Kind__c", "", "Kind", "", "", "", ""])
        wb.save(path)

    def test_grey_skipped(self):
        tmp = Path(tempfile.mkdtemp())
        wbp = tmp / "m.xlsx"
        self.workbook(wbp)
        write_csv(tmp / "tr" / "translations_de.csv", [flabel("de", "Widget__c", "Kind__c", "Kind", "Art")])
        r = run("mark_workbook_cells.py", "grey-skipped", wbp, "--translator-dir", tmp / "tr")
        self.assertEqual(r.returncode, 0, r.stderr)
        ws = openpyxl.load_workbook(wbp).active
        grey = lambda c: (ws[c].fill.fgColor.rgb or "")[-6:] == "C0C0C0"
        self.assertTrue(grey("G2"))         # Color: skipped, org empty
        self.assertFalse(grey("G3"))        # Size: org has a value to review
        self.assertFalse(grey("G4"))        # Kind: translator gave a value
        self.assertTrue(grey("I2"))         # fr: nothing anywhere

    def test_flag_prior_skips(self):
        tmp = Path(tempfile.mkdtemp())
        wbp = tmp / "m.xlsx"
        self.workbook(wbp)
        write_csv(tmp / "r1" / "translations_de.csv", [
            flabel("de", "Widget__c", "Color__c", "Color", ""),
            flabel("de", "Widget__c", "Kind__c", "Kind", "")])
        write_csv(tmp / "r1" / "translations_fr.csv", [
            flabel("fr", "Widget__c", "Color__c", "Color", "Couleur")])
        for lg in ("de", "fr"):
            write_csv(tmp / "pull" / f"translations_{lg}.csv", [
                flabel(lg, "Widget__c", f, f, "Couleur" if (lg, f) == ("fr", "Color__c") else "")
                for f in ("Color__c", "Size__c", "Kind__c")])
        r = run("mark_workbook_cells.py", "flag-prior-skips", wbp, "--org-pull", tmp / "pull",
                "--prior-dir", tmp / "r1", "--out", tmp / "o.xlsx")
        self.assertEqual(r.returncode, 0, r.stderr)
        wb = openpyxl.load_workbook(tmp / "o.xlsx")
        self.assertEqual(wb.sheetnames[0], "Summary")
        ws = wb["Sheet"]
        red = lambda c: (ws[c].fill.fgColor.rgb or "")[-6:] == "FFC7CE"
        self.assertTrue(red("G2"))      # de Color: asked, fr filled, de blank, org empty
        self.assertFalse(red("G4"))     # de Kind: no other language filled it - not a decision
        self.assertFalse(red("G3"))     # Size: never asked


class HelpRuns(unittest.TestCase):
    def test_every_script_has_help(self):
        scripts = Path(__file__).resolve().parent.parent / "scripts"
        for p in sorted(scripts.glob("*.py")):
            if p.name in ("triage_common.py",):
                continue
            with self.subTest(script=p.name):
                r = run(p.name, "--help")
                self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main()
