# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Offline tests for sf-translation-reconcile. Synthetic data only; no org is called.

    python tests/run_tests.py
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(HERE))

import fixtures as F  # noqa: E402
import reconlib as R  # noqa: E402
import apply_change_plan, check_export, compare_workbook, export_diff, loads_vs_org  # noqa: E402,E401
import locate, lock, manifest, mark_landed, merge_translations, overlay_retrieve  # noqa: E402,E401
import proof, provenance, pulldown, read_manifests, scope, verify  # noqa: E402,E401

KEYS = ["type", "component", "field", "masterLabel", "English"]


def run(mod, *args):
    """(exit code, stdout) of a script's main()."""
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        try:
            code = mod.main([str(a) for a in args])
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else 1
    return code or 0, out.getvalue()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="reconcile_"))
        self.before = F.write_retrieve(self.tmp / "before")
        self.stf = F.write_stf(self.tmp / "stf", F.STF_DE)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


# ───────────────────────────── library ─────────────────────────────

class LibraryTests(Base):
    def test_stf_parse(self):
        f = R.StfFile(next(self.stf.glob("*.stf")))
        self.assertEqual(f.held["PicklistValue.Widget__c.Color.Red"], "Rot")
        self.assertEqual(f.held["CustomField.Widget__c.Notes.HelpText"], "Zeile eins\nZeile zwei")
        self.assertIn("PicklistValue.Widget__c.Color.Blue", f.present)
        self.assertNotIn("PicklistValue.Widget__c.Color.Blue", f.held)
        self.assertIn("LayoutSection.Widget__c.Widget Layout.Details", f.present_pos)
        self.assertFalse(f.truncated)

    def test_truncated_export_detected(self):
        p = self.tmp / "t" / "Bilingual_de_2026-01-01.stf"
        p.parent.mkdir()
        p.write_text("CustomLabel.X\tX\tY", encoding="utf-8")
        self.assertTrue(R.StfFile(p).truncated)

    def test_retrieve_keys_and_comments(self):
        r = R.RetrieveRead([self.before])
        self.assertEqual(r.vals["de"]["CustomField.Widget__c.Color.FieldLabel"], "Farbe")
        self.assertEqual(r.vals["de"]["PicklistValue.Widget__c.Color.Blue"], "")      # untranslated
        self.assertEqual(r.vals["de"]["ValidationFormula.Widget__c.Require_Color"], "Farbe fehlt  ")
        self.assertEqual(r.layouts[("Widget__c", "Widget Layout")], ["Details"])       # SF-owned left out
        self.assertEqual(r.gvs_of("Widget__c", "Accent__c"), "Colors")
        self.assertFalse(r.gvs["Colors"]["Old"])

    def test_orgstate_statuses(self):
        org = R.OrgState([self.before], self.stf)
        L = lambda *a: org.lookup("de", *a)[:2]
        self.assertEqual(L("field-label", "Widget__c", "Color__c", ""), ("held", "Farbe"))
        self.assertEqual(L("global-value", "Colors", "", "Old"), ("held", "Alt"))            # export fallback
        self.assertEqual(L("field-picklist", "Widget__c", "Color__c", "Blue"), ("empty", None))
        self.assertEqual(L("field-picklist", "Widget__c", "Color__c", "Purple"), ("unreadable", None))
        self.assertEqual(L("field-label", "Widget__c", "Gone__c", ""), ("absent", None))
        self.assertEqual(L("field-label", "Task", "Topic__c", ""), ("empty", None))      # Task -> Activity
        self.assertEqual(L("layout-section", "Widget__c", "Widget Layout", "Details"), ("empty", None))
        only_stf = R.OrgState(None, self.stf)
        self.assertEqual(only_stf.lookup("de", "layout-section", "Widget__c", "Widget Layout", "Details")[0], "empty")
        self.assertEqual(only_stf.lookup("de", "field-picklist", "Widget__c", "Accent__c", "Old")[0], "absent")

    def test_lang_headers(self):
        m = R.load_lang_map()
        self.assertEqual(R.split_lang_header("German (Austria) Existing Value", m), ("de_AT", "Existing Value"))
        self.assertEqual(R.split_lang_header("French Translation", m), ("fr", "Translation"))
        self.assertEqual(R.split_lang_header("de Translation", m), ("de", "Translation"))
        self.assertEqual(R.split_lang_header("component", m), (None, "component"))


# ───────────────────────────── (a) workbook vs org ─────────────────────────────

class WorkbookVsOrgTests(Base):
    def make_wb(self):
        hdr = KEYS + ["English Existing Value", "German Existing Value", "German Translation"]
        rows = [hdr, ["Do Not Edit"] * len(hdr),
                ["field-label", "Widget__c", "Color__c", None, "Color", "Color", "Farbe", None],      # same
                ["field-picklist", "Widget__c", "Color__c", "Red", "Red", "Red", "Rot ", None],      # whitespace
                ["record-type", "Widget__c", "Premium", None, "Premium", "Premium", "Alt", None],    # DIFFERENT
                ["field-label", "Widget__c", "Notes__c", None, "Notes", "Notes", "Notizen", None],  # CLEAR
                ["global-value", "Colors", None, "Old", "Old", "Old", None, None],                  # FILL
                ["field-label", "Widget__c", "Gone__c", None, "Gone", "Gone", "Weg", None],         # UNRESOLVED
                ["field-picklist", "Widget__c", "Color__c", "Purple", "Purple", "Purple", None, None]]  # UNREADABLE
        return F.workbook(self.tmp / "master.xlsx", {"Fields": rows})

    def test_compare_categories_and_plan(self):
        wb = self.make_wb()
        plan = self.tmp / "plan.json"
        code, out = run(compare_workbook, wb, "--retrieve", self.before, "--stf-dir", self.stf, "--plan", plan)
        self.assertEqual(code, 0, out)
        cats = {(c["type"], c["item"] or c["field"]): c["cat"] for c in R.load_json(plan)["changes"]}
        self.assertEqual(cats, {("record-type", "Premium"): "DIFFERENT", ("field-label", "Notes__c"): "CLEAR",
                                ("global-value", "Old"): "FILL"})
        self.assertIn("UNREADABLE", out)
        self.assertTrue(all(c["lang"] == "de" for c in R.load_json(plan)["changes"]))   # English never planned

    def test_apply_dry_run_then_apply_then_stale(self):
        wb = self.make_wb()
        plan = self.tmp / "plan.json"
        run(compare_workbook, wb, "--retrieve", self.before, "--stf-dir", self.stf, "--plan", plan)
        before_bytes = wb.read_bytes()
        code, out = run(apply_change_plan, wb, plan)
        self.assertEqual(code, 0, out)
        self.assertEqual(wb.read_bytes(), before_bytes)                 # dry run writes nothing
        record = self.tmp / "rec.xlsx"
        code, out = run(apply_change_plan, wb, plan, "--apply", "--record", record, "--reference", f"other={self.stf}")
        self.assertEqual(code, 0, out)
        import openpyxl
        ws = openpyxl.load_workbook(wb)["Fields"]
        self.assertEqual(ws["G5"].value, "Premium DE")
        self.assertIsNone(ws["G6"].value)
        self.assertEqual(ws["G7"].value, "Alt")
        self.assertTrue(record.is_file())
        self.assertEqual(len(list(self.tmp.glob("master_PRE-apply_*.xlsx"))), 1)
        code, out = run(apply_change_plan, wb, plan, "--apply", "--record", record)   # plan is now stale
        self.assertEqual(code, 2)
        self.assertIn("changed since the plan", out)

    def test_loads_vs_org(self):
        hdr = KEYS + ["German Translation"]
        l1 = F.workbook(self.tmp / "l1.xlsx", {"S": [hdr,
             ["record-type", "Widget__c", "Premium", None, "Premium", "Premium DE"],
             ["field-label", "Widget__c", "Color__c", None, "Color", "Farbe"],
             ["field-label", "Widget__c", "Notes__c", None, "Notes", "Notizen"]]})
        l2 = F.workbook(self.tmp / "l2.xlsx", {"S": [hdr,
             ["record-type", "Widget__c", "Premium", None, "Premium", "Premium neu"],     # LIVE-OLDER
             ["validation-rule", "Widget__c", "Require_Color", None, "Color is required", "Andere"],  # OTHER
             ["field-label", "Widget__c", "Gone__c", None, "Gone", "Weg"],                # NO TARGET
             ["custom-label", "(global)", "Bye", None, "Goodbye", "Tschuss"]]})          # NOT LIVE, flagged
        flags = self.tmp / "flags.csv"
        flags.write_text("lang,english,value,issue\nde,Goodbye,Tschuss,wrong spelling\n", encoding="utf-8")
        js = self.tmp / "l.json"
        code, out = run(loads_vs_org, "--load", f"L1={l1}", "--load", f"L2={l2}", "--retrieve", self.before,
                        "--stf-dir", self.stf, "--flags", flags, "--out", self.tmp / "l.xlsx", "--json", js)
        self.assertEqual(code, 0, out)
        cats = {(r["type"], r["field"]): r["cat"] for r in R.load_json(js)["records"]}
        self.assertEqual(cats[("record-type", "Premium")], "LIVE-OLDER")
        self.assertEqual(cats[("field-label", "Color__c")], "LIVE")
        self.assertEqual(cats[("field-label", "Notes__c")], "NOT LIVE")
        self.assertEqual(cats[("validation-rule", "Require_Color")], "OTHER")
        self.assertEqual(cats[("field-label", "Gone__c")], "NO TARGET")
        self.assertIn("redeploy candidates (NOT LIVE, not flagged): 1", out)


# ───────────────────────────── (b) pull-down, (c) landed ─────────────────────────────

class PulldownTests(Base):
    def test_pulldown_rows_new_items_and_check(self):
        tpl = F.workbook(self.tmp / "tpl.xlsx", {"Fields": [KEYS,
              ["field-label", "Widget__c", "Color__c", None, "Color"],
              ["field-label", "Widget__c", "Removed__c", None, "Removed"]]})
        out = self.tmp / "review.xlsx"
        code, txt = run(pulldown, "--retrieve", self.before, "--stf-dir", self.stf, "--langs", "de",
                        "--template", tpl, "--out", out)
        self.assertEqual(code, 0, txt)
        import openpyxl
        wb = openpyxl.load_workbook(out)
        rows = list(wb["Fields"].iter_rows(values_only=True))
        hdr = rows[0]
        by = {(r[0], r[1], r[2], r[3]): r for r in rows[1:]}
        self.assertIn(("layout-section", "Widget__c", "Widget Layout", "Details"), by)
        self.assertNotIn(("layout-section", "Widget__c", "Widget Layout", "System Information"), by)
        self.assertNotIn(("field-picklist", "Widget__c", "Color__c", "Purple"), by)       # inactive
        self.assertNotIn(("global-value", "Colors", None, "Old"), by)
        ex = hdr.index("German Existing Value")
        self.assertEqual(by[("field-label", "Widget__c", "Color__c", None)][ex], "Farbe")
        self.assertIsNone(by[("field-label", "Widget__c", "Color__c", None)][hdr.index("New")])
        self.assertEqual(by[("field-label", "Widget__c", "Notes__c", None)][hdr.index("New")], "yes")
        labels = [r[2] for r in wb["Custom Labels"].iter_rows(min_row=2, values_only=True)]
        self.assertEqual(labels, ["Bye", "Greeting"])                                       # URL label left out
        gone = list(wb["Template rows not in org"].iter_rows(min_row=2, values_only=True))
        self.assertEqual([g[2] for g in gone], ["Removed__c"])
        code, txt = run(compare_workbook, out, "--stf-dir", self.stf, "--check")         # independent check
        self.assertEqual(code, 0, txt)
        self.assertIn("CHECK PASS", txt)

    def test_check_fails_on_wrong_cell(self):
        hdr = KEYS + ["German Existing Value"]
        wb = F.workbook(self.tmp / "r.xlsx", {"S": [hdr, ["field-label", "Widget__c", "Color__c", None, "Color", "Falsch"]]})
        code, txt = run(compare_workbook, wb, "--stf-dir", self.stf, "--check")
        self.assertEqual(code, 2, txt)

    def test_mark_landed(self):
        hdr = KEYS + ["German Translation", "French Translation"]
        wb = F.workbook(self.tmp / "c.xlsx", {"S": [hdr,
             ["field-label", "Widget__c", "Color__c", None, "Color", "Farbe", None],
             ["field-picklist", "Widget__c", "Color__c", "Blue", "Blue", "Blau", None],
             ["record-type", "Widget__c", "Premium", None, "Premium", "Premium Neu", None],
             ["validation-rule", "Widget__c", "Require_Color", None, "x", "Farbe fehlt", None]]})
        out = self.tmp / "c_landed.xlsx"
        code, txt = run(mark_landed, wb, "--retrieve", self.before, "--out", out)
        self.assertEqual(code, 2, txt)
        import openpyxl
        ws = openpyxl.load_workbook(out)["S"]
        h = [c.value for c in ws[1]]
        col = h.index("Landed status") + 1
        self.assertEqual(ws.cell(2, col).value, "LANDED")
        self.assertEqual(ws.cell(3, col).value, "NOT LANDED: de")
        self.assertEqual(ws.cell(4, col).value, "DIFFERENT: de")
        self.assertIn("LANDED (spacing)", ws.cell(5, h.index("Landed detail") + 1).value)
        self.assertEqual(openpyxl.load_workbook(wb)["S"].max_column, len(hdr))           # input untouched


# ───────────────────────────── (d) targeted corrections ─────────────────────────────

DECISIONS = """lang,type,object,field,item,value,gender
de,field-label,Widget__c,Notes__c,,Notizen,
de,field-picklist,Widget__c,Color__c,Blue,Blau,
de,field-picklist,Widget__c,Color__c,Red,Rot,
de,record-type,Widget__c,Premium,,Premium Plus,
de,layout-section,Widget__c,Widget Layout,Details,Einzelheiten,
de,global-value,Colors,,Green,Grün ,
de,field-label,Task,Topic__c,,Thema,
de,field-label,Event,Topic__c,,Thema,
de,custom-label,,Bye,,Tschüss,
de,field-label,Widget__c,Missing__c,,Fehlt,
fr,standard-field,Account,AccountNumber,,Numéro,Masculine
"""


class CorrectionTests(Base):
    def flow(self, decisions=DECISIONS, extra=()):
        d = self.tmp / "decisions.csv"
        d.write_text(decisions, encoding="utf-8")
        sc, loc, pay = self.tmp / "scope.json", self.tmp / "located.json", self.tmp / "payload"
        code, out = run(scope, d, "--out", sc)
        self.assertEqual(code, 0, out)
        code, out = run(locate, "--scope", sc, "--before", self.before, "--out", loc, "--build", pay,
                        "--allow-not-found", *extra)
        self.assertEqual(code, 0, out)
        return sc, loc, pay

    def test_scope_conflict_refused(self):
        d = self.tmp / "d.csv"
        d.write_text("lang,type,object,field,item,value\nde,field-label,Task,Topic__c,,A\n"
                     "de,field-label,Event,Topic__c,,B\n", encoding="utf-8")
        code, out = run(scope, d, "--out", self.tmp / "s.json")
        self.assertEqual(code, 2)
        self.assertIn("CONFLICT", out)
        self.assertFalse((self.tmp / "s.json").exists())

    def test_scope_decisions_and_exact_values(self):
        d = self.tmp / "d.csv"
        d.write_text("lang,type,object,field,item,value,decision\n"
                     "de,custom-label,,Bye,,Tschüss ,ok\nde,custom-label,,Greeting,,Servus,\n"
                     "German,record-type,Widget__c,Premium,,X,use Premium Gold\n", encoding="utf-8")
        s = self.tmp / "s.json"
        code, out = run(scope, d, "--out", s, "--decision-col", "decision", "--comment-is-value")
        self.assertEqual(code, 0, out)
        S = R.load_json(s)
        self.assertEqual(S[0]["value"], "Tschüss ")                     # not trimmed
        self.assertIn("leading/trailing whitespace", out)
        self.assertEqual(S[1]["decision"], "HOLD")
        self.assertEqual((S[2]["lang"], S[2]["value"]), ("de", "use Premium Gold"))

    def test_manifest_parent_inclusive(self):
        d = self.tmp / "d.csv"
        d.write_text(DECISIONS, encoding="utf-8")
        run(scope, d, "--out", self.tmp / "s.json")
        code, out = run(manifest, self.tmp / "s.json", "--out", self.tmp / "m.xml")
        self.assertEqual(code, 0, out)
        m = (self.tmp / "m.xml").read_text(encoding="utf-8")
        for member in ("<members>Activity-de</members>", "<members>Activity</members>",
                       "<members>Widget__c-Widget Layout</members>", "<members>Colors</members>",
                       "<members>Bye</members>", "<name>CustomLabel</name>", "<name>GlobalValueSet</name>"):
            self.assertIn(member, m)
        self.assertNotIn("Task-de", m)

    def test_locate_statuses_and_payload(self):
        _sc, loc, pay = self.flow()
        L = {(d["type"], d.get("obj"), d.get("item") or d.get("field")): d for d in R.load_json(loc)}
        self.assertEqual(L[("field-picklist", "Widget__c", "Red")]["status"], "SAME")
        self.assertEqual(L[("field-picklist", "Widget__c", "Blue")]["status"], "CHANGE")
        self.assertEqual(L[("field-label", "Widget__c", "Missing__c")]["status"], "NOT FOUND")
        self.assertEqual(L[("field-label", "Event", "Topic__c")]["duplicate_of"],
                         L[("field-label", "Task", "Topic__c")]["id"])
        self.assertEqual(L[("record-type", "Widget__c", "Premium")]["current"], "Premium DE")
        files = sorted(p.relative_to(pay).as_posix() for p in pay.rglob("*") if p.is_file())
        self.assertIn("objectTranslations/Activity-de.objectTranslation", files)
        self.assertNotIn("objectTranslations/Task-de.objectTranslation", files)
        self.assertTrue(Path(str(pay) + ".sha256").is_file())
        w = (pay / "objectTranslations/Widget__c-de.objectTranslation").read_text(encoding="utf-8")
        self.assertIn("<translation>Blau</translation>", w)
        self.assertIn("&#13;", w)                                       # CR kept
        self.assertIn("<errorMessage>Farbe fehlt  </errorMessage>", w)  # untouched, exact
        self.assertIn("<!-- Details -->", (self.before / "unpackaged/objectTranslations/Widget__c-de.objectTranslation")
                      .read_text(encoding="utf-8"))
        self.assertIn("<label>Einzelheiten</label>", w)
        self.assertIn("<translation>Grün </translation>",
                      (pay / "globalValueSetTranslations/Colors-de.globalValueSetTranslation").read_text(encoding="utf-8"))
        a = (pay / "objectTranslations/Account-fr.objectTranslation").read_text(encoding="utf-8")
        self.assertIn("<value>Numéro</value>", a)
        self.assertIn("<value>Numeros</value>", a)

    def test_build_refused_with_not_found(self):
        d = self.tmp / "d.csv"
        d.write_text(DECISIONS, encoding="utf-8")
        run(scope, d, "--out", self.tmp / "s.json")
        code, out = run(locate, "--scope", self.tmp / "s.json", "--before", self.before, "--out",
                        self.tmp / "l.json", "--build", self.tmp / "p")
        self.assertEqual(code, 2)
        self.assertFalse((self.tmp / "p").exists())

    def test_proof_pass_controls_and_tamper(self):
        _sc, loc, pay = self.flow()
        code, out = run(proof, "--located", loc, "--before", self.before, "--dir", pay, "--negative-control")
        self.assertEqual(code, 0, out)
        self.assertEqual(out.count("CAUGHT"), 2, out)
        self.assertNotIn("NOT CAUGHT", out)
        p = pay / "objectTranslations/Widget__c-de.objectTranslation"
        p.write_text(p.read_text(encoding="utf-8").replace("Farbe fehlt  ", "Farbe fehlt"), encoding="utf-8")
        code, out = run(proof, "--located", loc, "--before", self.before, "--dir", pay)
        self.assertEqual(code, 2)
        self.assertIn("UNEXPECTED", out)                                 # a trimmed space is caught

    def test_proof_catches_package_mismatch(self):
        _sc, loc, pay = self.flow()
        (pay / "package.xml").write_text((pay / "package.xml").read_text(encoding="utf-8")
                                         .replace("<members>Colors-de</members>", ""), encoding="utf-8")
        code, out = run(proof, "--located", loc, "--before", self.before, "--dir", pay)
        self.assertEqual(code, 2)
        self.assertIn("not listed", out)

    def test_create_inactive_value_and_quick_action(self):
        dec = ("lang,type,object,field,item,value\nde,global-value,Colors,,Old,Alt\n"
               "de,global-value,Colors,,Nope,Nein\n")
        _sc, loc, pay = self.flow(dec, ("--allow-create",))
        L = {d["item"]: d for d in R.load_json(loc)}
        self.assertTrue(L["Old"].get("created"))
        self.assertEqual(L["Nope"]["status"], "NOT FOUND")              # not defined: never created
        code, out = run(proof, "--located", loc, "--before", self.before, "--dir", pay)
        self.assertEqual(code, 0, out)

    def test_standard_field_gender_and_create(self):
        dec = ("lang,type,object,field,item,value,gender\n"
               "fr,standard-field,Account,AccountNumber,,Numero,Feminine\n"     # gender only
               "fr,standard-field,Account,Phone,,Telephone,Masculine\n")        # created
        _sc, loc, pay = self.flow(dec, ("--allow-create",))
        L = {d["field"]: d for d in R.load_json(loc)}
        self.assertEqual(L["AccountNumber"]["status"], "CHANGE")
        self.assertTrue(L["Phone"].get("created"))
        self.assertEqual(L["Phone"].get("startsWith_derived"), "Consonant")
        a = (pay / "objectTranslations/Account-fr.objectTranslation").read_text(encoding="utf-8")
        self.assertIn("<gender>Feminine</gender>", a)
        self.assertLess(a.index("AccountNumber"), a.index("<name>Phone</name>"))        # sorted placement
        code, out = run(proof, "--located", loc, "--before", self.before, "--dir", pay, "--negative-control")
        self.assertEqual(code, 0, out)

    def test_lock(self):
        _sc, loc, pay = self.flow()
        pre = self.tmp / "pre"
        shutil.copytree(self.before, pre)
        pj = self.tmp / "pre.json"
        pj.write_text(json.dumps({"status": 0, "result": {"status": "Succeeded", "success": True, "messages": []}}))
        code, out = run(lock, "--before", self.before, "--pre", pre, "--pre-json", pj, "--payload", pay)
        self.assertEqual(code, 0, out)
        f = pre / "unpackaged/translations/de.translation"
        f.write_text(f.read_text(encoding="utf-8").replace("Hallo", "Hallo!"), encoding="utf-8")
        code, out = run(lock, "--before", self.before, "--pre", pre, "--pre-json", pj, "--payload", pay)
        self.assertEqual(code, 2)
        self.assertIn("CHANGED since the before read", out)
        shutil.rmtree(pre)
        shutil.copytree(self.before, pre)
        old = time.time() - 3600
        os.utime(pj, (old, old))
        code, out = run(lock, "--before", self.before, "--pre", pre, "--pre-json", pj, "--payload", pay)
        self.assertEqual(code, 2)
        self.assertIn("min old", out)

    def after_from_payload(self, pay, edit=None):
        after = self.tmp / "after"
        shutil.copytree(self.before, after)
        for p in pay.rglob("*"):
            if p.is_file() and p.name != "package.xml":
                dst = after / "unpackaged" / p.relative_to(pay)
                shutil.copy2(p, dst)
        if edit:
            rel, a, b = edit
            f = after / "unpackaged" / rel
            f.write_text(f.read_text(encoding="utf-8").replace(a, b), encoding="utf-8")
        return after

    def test_verify(self):
        _sc, loc, pay = self.flow()
        after = self.after_from_payload(pay)
        code, out = run(verify, "--located", loc, "--before", self.before, "--after", after)
        self.assertEqual(code, 0, out)
        shutil.rmtree(after)
        after = self.after_from_payload(pay, ("globalValueSetTranslations/Colors-de.globalValueSetTranslation",
                                              "Grün </translation>", "Grün</translation>"))
        code, out = run(verify, "--located", loc, "--before", self.before, "--after", after)
        self.assertEqual(code, 1, out)
        self.assertIn("trailing space trimmed", out)
        shutil.rmtree(after)
        after = self.after_from_payload(pay, ("translations/de.translation", "Hallo", "Servus"))
        code, out = run(verify, "--located", loc, "--before", self.before, "--after", after)
        self.assertEqual(code, 2, out)
        self.assertIn("UNEXPECTED", out)

    def test_check_export(self):
        dec = ("lang,type,object,field,item,value\nde,field-picklist,Widget__c,Color__c,Blue,Blau\n"
               "de,record-type,Widget__c,Premium,,Premium Plus\n")
        _sc, loc, _pay = self.flow(dec)
        code, out = run(check_export, "--located", loc, "--stf-dir", self.stf)
        self.assertEqual(code, 0, out)
        bad = F.write_stf(self.tmp / "stf2", [l.replace("Premium DE", "Premium Gold") for l in F.STF_DE])
        code, out = run(check_export, "--located", loc, "--stf-dir", bad)
        self.assertEqual(code, 2, out)
        self.assertIn("CONFLICT", out)

    def test_export_diff(self):
        dec = "lang,type,object,field,item,value\nde,field-picklist,Widget__c,Color__c,Blue,Blau\n"
        _sc, loc, _pay = self.flow(dec)
        after_lines = [l for l in F.STF_DE if not l.startswith("PicklistValue.Widget__c.Color.Blue")]
        after_lines.insert(3, "PicklistValue.Widget__c.Color.Blue\tBlue\tBlau\t-")
        after = F.write_stf(self.tmp / "after_stf", after_lines, stamp="2026-01-02 1000")
        code, out = run(export_diff, "--before", self.stf, "--after", after, "--located", loc)
        self.assertEqual(code, 0, out)
        after2 = F.write_stf(self.tmp / "after_stf2", [l.replace("\tHallo\t", "\tServus\t") for l in after_lines])
        code, out = run(export_diff, "--before", self.stf, "--after", after2, "--located", loc)
        self.assertEqual(code, 2, out)
        self.assertIn("CHANGED outside the pushes: 1", out)


# ───────────────────────────── (e) provenance ─────────────────────────────

class ProvenanceTests(Base):
    def test_provenance_classes_and_holds(self):
        dec = ("lang,type,object,field,item,value\n"
               "de,record-type,Widget__c,Premium,,Premium Plus\n"          # baseline held a value -> PRE-EXISTING
               "de,field-label,Widget__c,Color__c,,Widgetfarbe\n"          # we wrote 'Farbe' -> OURS
               "de,custom-label,,Greeting,,Servus\n"                       # someone else wrote it -> OTHER
               "de,field-label,Activity,Topic__c,,Thema\n")                 # fill: not an overwrite
        d = self.tmp / "d.csv"
        d.write_text(dec, encoding="utf-8")
        run(scope, d, "--out", self.tmp / "s.json")
        loc = self.tmp / "loc.json"
        run(locate, "--scope", self.tmp / "s.json", "--before", self.before, "--out", loc)
        base_files = dict(F.FILES)
        base_files["objectTranslations/Widget__c-de.objectTranslation"] = (
            F.WIDGET_DE.replace("<label>Farbe</label>", "<label><!-- Color --></label>"))
        base_files["translations/de.translation"] = F.DE_TRANSLATION.replace("<label>Hallo</label>",
                                                                              "<label><!-- Hello --></label>")
        baseline = F.write_retrieve(self.tmp / "snapshot", base_files)
        ours = F.write_tree(self.tmp / "push1", {
            "package.xml": F.PACKAGE,
            "objectTranslations/Widget__c-de.objectTranslation": F.WIDGET_DE})
        auth = self.tmp / "auth.txt"
        auth.write_text("# ids named by the owner\n", encoding="utf-8")
        holds = self.tmp / "holds.json"
        code, out = run(provenance, "--located", loc, "--baseline", f"snap={baseline}", "--ours", f"push1={ours}",
                        "--holds-out", holds, "--report", self.tmp / "prov.xlsx", "--authority", auth)
        self.assertEqual(code, 0, out)
        L = {(d["type"], d.get("field")): d for d in R.load_json(loc)}
        self.assertEqual(L[("record-type", "Premium")]["prov"], "PRE-EXISTING")
        self.assertEqual(L[("field-label", "Color__c")]["prov"], "OURS")
        self.assertEqual(L[("custom-label", "Greeting")]["prov"], "OTHER")
        self.assertNotIn("prov", L[("field-label", "Topic__c")])
        self.assertEqual(sorted(R.load_json(holds)), sorted([L[("record-type", "Premium")]["id"],
                                                             L[("custom-label", "Greeting")]["id"]]))
        # a named authority releases one hold
        auth.write_text(L[("record-type", "Premium")]["id"] + "\n", encoding="utf-8")
        run(provenance, "--located", loc, "--baseline", f"snap={baseline}", "--ours", f"push1={ours}",
            "--holds-out", holds, "--authority", auth)
        self.assertEqual(R.load_json(holds), [L[("custom-label", "Greeting")]["id"]])
        # held entries drop out of the payload
        code, out = run(locate, "--scope", loc, "--before", self.before, "--out", loc, "--holds", holds,
                        "--build", self.tmp / "pay")
        self.assertEqual(code, 0, out)
        self.assertFalse((self.tmp / "pay/translations/de.translation").exists())

    def test_unknown_when_baseline_lacks_file(self):
        d = self.tmp / "d.csv"
        d.write_text("lang,type,object,field,item,value\nde,custom-label,,Greeting,,Servus\n", encoding="utf-8")
        run(scope, d, "--out", self.tmp / "s.json")
        loc = self.tmp / "loc.json"
        run(locate, "--scope", self.tmp / "s.json", "--before", self.before, "--out", loc)
        empty = F.write_tree(self.tmp / "snap", {"package.xml": F.PACKAGE})
        code, out = run(provenance, "--located", loc, "--baseline", f"snap={empty}", "--holds-out", self.tmp / "h.json")
        self.assertEqual(code, 0, out)
        self.assertEqual(R.load_json(loc)[0]["prov"], "UNKNOWN")
        self.assertEqual(len(R.load_json(self.tmp / "h.json")), 1)


# ───────────────────────────── utilities ─────────────────────────────

class UtilityTests(Base):
    def test_merge_translations(self):
        src, dst = self.tmp / "src.csv", self.tmp / "dst.csv"
        src.write_text("type,component,field,masterLabel,translation\nfield-label,Widget__c,Color__c,,Farbe \n"
                       "field-label,Widget__c,Notes__c,,\n", encoding="utf-8")
        dst.write_text("file,type,component,field,masterLabel,translation\nx,field-label,Widget__c,Color__c,,\n"
                       "y,field-label,Widget__c,Notes__c,,Alt\n", encoding="utf-8")
        code, out = run(merge_translations, src, dst)
        self.assertIn("dry run", out)
        self.assertNotIn("Farbe", dst.read_text(encoding="utf-8"))
        code, out = run(merge_translations, src, dst, "--write")
        text = dst.read_text(encoding="utf-8")
        self.assertIn(",Farbe \n", text)                                # exact, not trimmed
        self.assertIn("Alt", text)                                      # blank source never overwrites

    def test_overlay(self):
        src = self.tmp / "conv/main/default"
        F.write_tree(src, {"objectTranslations/Widget__c-de/Color__c.fieldTranslation-meta.xml": "<new/>",
                           "objectTranslations/Widget__c-fr/Color__c.fieldTranslation-meta.xml": "<fr/>"})
        dest = self.tmp / "fa"
        F.write_tree(dest, {"objectTranslations/Widget__c-de/Color__c.fieldTranslation-meta.xml": "<old/>",
                            "objectTranslations/Widget__c-de/ns__Pkg__c.fieldTranslation-meta.xml": "<keep/>"})
        code, out = run(overlay_retrieve, "--src", self.tmp / "conv", "--dest", dest, "--langs", "de")
        self.assertIn("changed=     1", out)
        self.assertIn("managed (ns__)", out)
        code, out = run(overlay_retrieve, "--src", self.tmp / "conv", "--dest", dest, "--langs", "de", "--apply")
        self.assertNotEqual(code, 0)                                    # --backup required
        code, out = run(overlay_retrieve, "--src", self.tmp / "conv", "--dest", dest, "--langs", "de",
                        "--apply", "--backup", self.tmp / "bak")
        self.assertEqual((dest / "objectTranslations/Widget__c-de/Color__c.fieldTranslation-meta.xml")
                         .read_text(), "<new/>")
        self.assertTrue((self.tmp / "bak/objectTranslations/Widget__c-de/Color__c.fieldTranslation-meta.xml").is_file())
        self.assertFalse((dest / "objectTranslations/Widget__c-fr").exists())
        self.assertTrue((dest / "objectTranslations/Widget__c-de/ns__Pkg__c.fieldTranslation-meta.xml").is_file())

    def test_read_manifests(self):
        lists = self.tmp / "lists"
        lists.mkdir()
        for typ, names in (("CustomObject", ["Widget__c", "Activity", "Account"]),
                           ("Layout", ["Widget__c-Widget Layout", "Account-Account Layout"]),
                           ("GlobalValueSet", ["Colors"])):
            (lists / f"list_{typ}.json").write_text(json.dumps(
                {"status": 0, "result": [{"fullName": n} for n in names]}), encoding="utf-8")
        wb = F.workbook(self.tmp / "w.xlsx", {"S": [KEYS, ["field-label", "Task", "Topic__c", None, "x"],
                                                     ["field-label", "Gadget__c", "A__c", None, "y"]]})
        code, out = run(read_manifests, "--lists", lists, "--langs", "de", "fr", "--workbook", wb,
                        "--out", self.tmp / "m")
        self.assertEqual(code, 0, out)
        m = (self.tmp / "m/obj_1.xml").read_text(encoding="utf-8")
        self.assertIn("<members>Activity-fr</members>", m)
        self.assertNotIn("Widget__c", m)
        self.assertIn("Gadget__c", R.load_json(self.tmp / "m/read_scope.json")["objects_not_in_org"])
        self.assertIn("<members>Colors-de</members>", (self.tmp / "m/vs_labels.xml").read_text(encoding="utf-8"))

    def test_every_script_help(self):
        for p in sorted(SCRIPTS.glob("*.py")):
            r = subprocess.run([sys.executable, str(p), "--help"], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f"{p.name}: {r.stderr}")


if __name__ == "__main__":
    unittest.main(verbosity=1)
