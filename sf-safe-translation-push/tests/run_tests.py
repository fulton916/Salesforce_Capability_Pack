# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Offline tests: python tests/run_tests.py   (no Salesforce org is called)."""
import copy
import glob
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers as H  # noqa: E402
from helpers import L, run  # noqa: E402

import crsafe  # noqa: E402

SCRIPTS = ["make_source.py", "make_manifests.py", "build_push.py", "negative_control.py", "check_vs_stf.py",
           "negative_control_stf.py", "pre_deploy_check.py", "verify_push.py", "export_diff_check.py",
           "snapshot.py", "review_excel.py"]
J = os.path.join


def build(w, *extra):
    return run("build_push.py", "--work", w, *extra)


def payload_leaves(w, out="payload"):
    got = {}
    for (f, c), ps in L.component_sources(J(w, out)).items():
        for p in ps:
            got[(f, c)] = L.leaves(p)
    return got


class T01Help(unittest.TestCase):
    def test_every_script_has_help(self):
        for s in SCRIPTS:
            r = run(s, "--help")
            self.assertEqual(r.returncode, 0, f"{s}: {r.stderr}")


class T02CrSafe(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()

    def test_content_cr_survives_read_and_write(self):
        p = J(self.d, "a.xml")
        Path(p).write_bytes(b'<?xml version="1.0" encoding="UTF-8"?>\n<a>\n    <b>one\r\ntwo</b>\n</a>\n')
        root = crsafe.parse(p).getroot()
        self.assertEqual(root.find("b").text, "one\r\ntwo")
        q = J(self.d, "b.xml")
        crsafe.write_xml(root, q)
        data = Path(q).read_bytes()
        self.assertNotIn(b"\r", data)
        self.assertEqual(data.count(b"&#13;"), 1)
        self.assertEqual(crsafe.parse(q).getroot().find("b").text, "one\r\ntwo")

    def test_crlf_line_endings_are_refused(self):
        p = J(self.d, "crlf.xml")
        Path(p).write_bytes(b'<?xml version="1.0" encoding="UTF-8"?>\r\n<a>\r\n  <b>x</b>\r\n</a>\r\n')
        with self.assertRaises(SystemExit):
            crsafe.parse(p)

    def test_cr_between_elements_is_refused(self):
        p = J(self.d, "between.xml")
        Path(p).write_bytes(b'<?xml version="1.0" encoding="UTF-8"?>\n<a>\n  <b>x</b>\r\n  <c>y</c>\n</a>\n')
        with self.assertRaises(SystemExit):
            crsafe.parse(p)


class T03MakeSource(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()

    def write(self, name, text):
        p = J(self.d, name)
        Path(p).write_text(text, encoding="utf-8", newline="")
        return p

    def test_long_and_wide_give_the_same_rows(self):
        lp = self.write("long.csv", "Language,Key,Value\nde,CustomLabel.A,Eins\nfr,CustomLabel.A,Un\nde,CustomLabel.B,\n")
        wp = self.write("wide.csv", "Key,de,fr\nCustomLabel.A,Eins,Un\nCustomLabel.B,,\n")
        self.assertEqual(run("make_source.py", "--input", lp, "--out", J(self.d, "l.json")).returncode, 0)
        self.assertEqual(run("make_source.py", "--input", wp, "--wide", "--langs", "de,fr", "--out", J(self.d, "w.json")).returncode, 0)
        strip = lambda p: [(r["lang"], r["key"], r["value"]) for r in L.load_json(p)["rows"]]
        self.assertEqual(strip(J(self.d, "l.json")), strip(J(self.d, "w.json")))
        self.assertEqual(len(strip(J(self.d, "l.json"))), 2)

    def test_xlsx_input(self):
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Translations"
        ws.append(["Language", "Key", "Value"])
        ws.append(["de", "CustomLabel.A", " Eins "])
        p = J(self.d, "in.xlsx")
        wb.save(p)
        r = run("make_source.py", "--input", p, "--sheet", "Translations", "--out", J(self.d, "x.json"))
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(L.load_json(J(self.d, "x.json"))["rows"][0]["value"], "Eins")

    def test_conflicting_duplicates_stop(self):
        p = self.write("dup.csv", "Language,Key,Value\nde,CustomLabel.A,Eins\nde,CustomLabel.A,Zwei\n")
        self.assertEqual(run("make_source.py", "--input", p, "--out", J(self.d, "o.json")).returncode, 2)

    def test_task_and_event_must_agree(self):
        p = self.write("te.csv", "Language,Key,Value\nde,CustomField.Task.Note.FieldLabel,Notiz\n"
                                 "de,CustomField.Event.Note.FieldLabel,Bemerkung\n")
        self.assertEqual(run("make_source.py", "--input", p, "--out", J(self.d, "o.json")).returncode, 2)

    def test_override_needs_the_expected_value(self):
        p = self.write("o.csv", "Language,Key,Value\nde,CustomLabel.A,Ein\n")
        good = self.write("good.json", json.dumps([{"lang": "de", "key": "CustomLabel.A", "expect": "Ein", "value": "Eins"}]))
        bad = self.write("bad.json", json.dumps([{"lang": "de", "key": "CustomLabel.A", "expect": "Zwei", "value": "Eins"}]))
        self.assertEqual(run("make_source.py", "--input", p, "--overrides", good, "--out", J(self.d, "g.json")).returncode, 0)
        self.assertEqual(L.load_json(J(self.d, "g.json"))["rows"][0]["value"], "Eins")
        self.assertEqual(run("make_source.py", "--input", p, "--overrides", bad, "--out", J(self.d, "b.json")).returncode, 2)


class T04Build(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.w = H.new_work()
        cls.r = build(cls.w)
        cls.rep = L.load_json(J(cls.w, "push_report.json"))
        cls.plan = {(r["lang"], r["key"]): r for r in L.load_json(J(cls.w, "plan.json"))["rows"]}

    def test_build_passes(self):
        self.assertEqual(self.r.returncode, 0, self.r.stdout + self.r.stderr)
        self.assertEqual(self.rep["proof_failures"], [])
        self.assertEqual(self.rep["overwrite_risk"], [])

    def test_fills_only_empty_slots(self):
        d = {k: r["decision"] for k, r in self.plan.items()}
        self.assertEqual(d[("de", "CustomField.Widget__c.Color.HelpText")], "FILL")
        self.assertEqual(d[("de", "PicklistValue.Widget__c.Color.Blue")], "FILL")
        self.assertEqual(d[("de", "QuickAction.Widget__c.Log_Widget")], "FILL")      # only in the second batch: merged
        self.assertEqual(d[("de", "ReportTypeSection.Widgets_with_Parts.Widgets")], "FILL")
        self.assertEqual(d[("de", "CustomField.Task.Note.FieldLabel")], "FILL")
        self.assertEqual(self.rep["counts"]["fills"], 18)
        self.assertEqual(self.rep["counts"]["named_overwrites"], 0)

    def test_held_values_are_not_sent(self):
        d = {k: r["decision"] for k, r in self.plan.items()}
        for k in [("de", "PicklistValue.Widget__c.Color.Red"), ("de", "RecordType.Widget__c.Big.Name"),
                  ("de", "PicklistValue.Colors__gvs.Green"),
                  ("de", "CustomField.Task.Priority_Code.FieldLabel")]:        # Task slot empty, Activity holds it
            self.assertEqual(d[k], "HOLD", k)
        self.assertEqual(d[("de", "CustomLabel.Greeting")], "LIVE")
        self.assertEqual(d[("fr", "CustomField.Widget__c.Size.FieldLabel")], "LIVE")
        self.assertEqual(d[("en_US", "CustomField.Widget__c.Color.FieldLabel")], "SKIPPED")
        text = "".join(Path(p).read_text(encoding="utf-8") for p in glob.glob(J(self.w, "payload", "**", "*.*"), recursive=True))
        for v in ("Rot!", "Grün", "Groß", "Prioritätscode", "Colour"):
            self.assertNotIn(v, text)
        self.assertFalse(glob.glob(J(self.w, "payload", "**", "*en_US*"), recursive=True))

    def test_every_payload_leaf_is_intended_or_the_targets_own(self):
        tg = {(x["folder"], x["component"], L.sig_tuple(x["sig"])): x["value"] for x in self.rep["targets"]}
        raw = L.component_sources(J(self.w, "before"))
        for (f, c), lv in payload_leaves(self.w).items():
            base = L.raw_values(raw[(f, c)])
            for s, v in lv.items():
                if (f, c, s) in tg:
                    self.assertEqual(v, tg[(f, c, s)])
                    self.assertFalse(any(not L.is_empty(x) for x in base.get(s, ())), (c, s))
                else:
                    self.assertIn(v, base.get(s, ()), (c, s))

    def test_existing_carriage_return_is_kept(self):
        data = Path(J(self.w, "payload", "objectTranslations", "Widget__c-de.objectTranslation")).read_bytes()
        self.assertNotIn(b"\r", data)
        self.assertIn(b"Erste Zeile&#13;\nzweite Zeile", data)

    def test_unplaced_row_fails_unless_allowed(self):
        w = H.new_work()
        src = L.load_json(J(w, "source.json"))
        src["rows"].append({"lang": "de", "key": "CustomField.Widget__c.Missing.FieldLabel", "value": "X"})
        L.dump_json(src, J(w, "source.json"))
        self.assertEqual(build(w).returncode, 2)
        self.assertEqual(build(w, "--allow-unplaced").returncode, 0)


class T05NegativeControls(unittest.TestCase):
    def test_disguised_overwrite_in_plan_is_refused(self):
        w = H.new_work()
        self.assertEqual(build(w).returncode, 0)
        plan = L.load_json(J(w, "plan.json"))
        for r in plan["rows"]:
            if (r["lang"], r["key"]) == ("de", "PicklistValue.Widget__c.Color.Red"):
                r["bucket"], r["org_value"] = "NEW", ""
        L.dump_json(plan, J(w, "plan_x.json"))
        r = build(w, "--plan-in", "plan_x.json", "--out", "payload_x", "--report", "report_x.json")
        self.assertEqual(r.returncode, 2, r.stdout)
        risk = L.load_json(J(w, "report_x.json"))["overwrite_risk"]
        self.assertEqual(len(risk), 1)
        self.assertIn("Red", risk[0][1])

    def test_negative_control_script_catches_all_plants(self):
        w = H.new_work()
        self.assertEqual(build(w).returncode, 0)
        r = run("negative_control.py", "--work", w)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("RESULT: CAUGHT", r.stdout)
        self.assertFalse(glob.glob(J(w, "*negctl*")))           # cleaned up
        self.assertTrue(os.path.isdir(J(w, "payload")))          # the real run is untouched

    def test_lossy_writer_fails_the_proof(self):
        import build_push
        w = H.new_work()
        real = crsafe.write_xml

        def drop_cr(root, path):
            root = root.getroot() if hasattr(root, "getroot") else root
            for e in root.iter():
                if e.text and "\r" in e.text:
                    e.text = e.text.replace("\r", "")
            real(root, path)
        crsafe.write_xml = drop_cr
        try:
            import io
            import contextlib
            with contextlib.redirect_stdout(io.StringIO()):
                rc = build_push.main(["--work", w])
        finally:
            crsafe.write_xml = real
        self.assertEqual(rc, 2)
        pf = L.load_json(J(w, "push_report.json"))["proof_failures"]
        self.assertTrue(any(f[0] == "Widget__c-de" for f in pf), pf)


class T06Named(unittest.TestCase):
    def named(self, w, was):
        L.dump_json([{"lang": "de", "key": "RecordType.Widget__c.Big.Name", "was": was}], J(w, "named_overwrites.json"))

    def test_named_overwrite_with_matching_was_is_written(self):
        w = H.new_work()
        self.named(w, "Gross")
        r = build(w, "--named", "named_overwrites.json")
        self.assertEqual(r.returncode, 0, r.stdout)
        rep = L.load_json(J(w, "push_report.json"))
        self.assertEqual(rep["counts"]["named_overwrites"], 1)
        self.assertIn("<label>Groß</label>", Path(J(w, "payload", "objectTranslations", "Widget__c-de.objectTranslation")).read_text(encoding="utf-8"))
        r = run("negative_control.py", "--work", w, "--named", "named_overwrites.json")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("C. stale", r.stdout)

    def test_stale_was_is_held_and_fails(self):
        w = H.new_work()
        self.named(w, "Something else")
        r = build(w, "--named", "named_overwrites.json")
        self.assertEqual(r.returncode, 2)
        rep = L.load_json(J(w, "push_report.json"))
        self.assertEqual(rep["counts"]["named_overwrites"], 0)
        self.assertEqual(len(rep["named_stale"]), 1)

    def test_name_that_matches_nothing_fails(self):
        w = H.new_work()
        L.dump_json([{"lang": "de", "key": "CustomLabel.Nope", "was": "x"}], J(w, "named_overwrites.json"))
        self.assertEqual(build(w, "--named", "named_overwrites.json").returncode, 2)


def full_run(named=False):
    """Build + exports + lock 2 for a fresh work dir; returns (work dir, export dir)."""
    w = H.new_work()
    args = []
    if named:
        L.dump_json([{"lang": "de", "key": "RecordType.Widget__c.Big.Name", "was": "Gross"},
                     {"lang": "de", "key": "PicklistValue.Colors__gvs.Green", "was": "Gruen"}], J(w, "named_overwrites.json"))
        args = ["--named", "named_overwrites.json"]
    r = build(w, *args)
    assert r.returncode == 0, r.stdout
    exp = J(w, "export_before")
    H.write_exports(exp, H.EXPORT_BEFORE)
    return w, exp


class T07CheckVsStf(unittest.TestCase):
    def check(self, w, exp, *extra):
        return run("check_vs_stf.py", "--work", w, "--stf-dir", exp, "--not-before", H.READ_START_ORG, *extra)

    def test_pass_on_untranslated_slots(self):
        w, exp = full_run()
        r = self.check(w, exp)
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_conflict_when_export_holds_a_filled_slot(self):
        w, exp = full_run()
        data = copy.deepcopy(H.EXPORT_BEFORE)
        data["de"]["CustomLabel.Farewell"] = "Tschuess"
        shutil.rmtree(exp)
        H.write_exports(exp, data)
        r = self.check(w, exp)
        self.assertEqual(r.returncode, 2)
        self.assertEqual([x["key"] for x in L.load_json(J(w, "check_vs_stf.json"))["conflicts"]], ["CustomLabel.Farewell"])

    def test_old_export_and_missing_language_fail(self):
        w, exp = full_run()
        r = run("check_vs_stf.py", "--work", w, "--stf-dir", exp, "--not-before", "2026-01-15 1100")
        self.assertEqual(r.returncode, 2)
        os.remove(glob.glob(J(exp, "Bilingual_fr_*.stf"))[0])
        self.assertEqual(self.check(w, exp).returncode, 2)

    def test_named_overwrites_need_allow_named(self):
        w, exp = full_run(named=True)
        self.assertEqual(self.check(w, exp).returncode, 2)
        r = self.check(w, exp, "--allow-named")
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_negative_control_stf(self):
        w, exp = full_run()
        r = run("negative_control_stf.py", "--work", w, "--stf-dir", exp, "--not-before", H.READ_START_ORG)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_negative_control_stf_with_named(self):
        w, exp = full_run(named=True)
        before_push = J(w, "export_first_push")
        H.write_exports(before_push, {"de": {}, "fr": {}}, stamp="2025-12-01 0800")
        r = run("negative_control_stf.py", "--work", w, "--stf-dir", exp, "--not-before", H.READ_START_ORG,
                "--allow-named", "--before-stf", before_push)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("planted D", r.stdout)


class T08PreDeploy(unittest.TestCase):
    def prepare(self):
        w, exp = full_run()
        self.assertEqual(run("check_vs_stf.py", "--work", w, "--stf-dir", exp, "--not-before", H.READ_START_ORG).returncode, 0)
        time.sleep(1.1)
        shutil.copytree(J(w, "before"), J(w, "pre"), ignore=shutil.ignore_patterns("*.json"))
        for b in os.listdir(J(w, "pre")):
            H.write_retrieve_json(J(w, "pre", b))
        return w

    def test_pass_when_nothing_moved(self):
        w = self.prepare()
        r = run("pre_deploy_check.py", "--work", w)
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_fail_when_a_value_changed_in_the_target(self):
        w = self.prepare()
        H.set_leaf(w, "pre/**/Widget__c-de.objectTranslation", (("layouts", "Widget Layout"), ("sections", "System Information"), "label"), "System (edited)")
        r = run("pre_deploy_check.py", "--work", w)
        self.assertEqual(r.returncode, 2)
        self.assertIn("changed in the target", r.stdout)

    def test_fail_when_pre_is_a_copy_of_before(self):
        w = self.prepare()
        for b in os.listdir(J(w, "before")):
            if b.endswith(".json"):
                shutil.copy2(J(w, "before", b), J(w, "pre", b))
        self.assertEqual(run("pre_deploy_check.py", "--work", w).returncode, 2)

    def test_fail_when_payload_changed_after_the_check(self):
        w = self.prepare()
        p = J(w, "payload", "translations", "de.translation")
        with open(p, "a", encoding="utf-8") as f:
            f.write("\n")
        self.assertEqual(run("pre_deploy_check.py", "--work", w).returncode, 2)


class T09Verify(unittest.TestCase):
    def test_pass_after_a_clean_deploy(self):
        w, _ = full_run()
        H.simulate_deploy(w)
        r = run("verify_push.py", "--work", w)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("intended values live: 18 / 18", r.stdout)

    def test_unexpected_change_in_a_pushed_component_fails(self):
        w, _ = full_run()
        H.simulate_deploy(w)
        H.set_leaf(w, "after/**/Widget__c-de.objectTranslation", (("layouts", "Widget Layout"), ("sections", "System Information"), "label"), "Systeminfo")
        r = run("verify_push.py", "--work", w)
        self.assertEqual(r.returncode, 2)
        self.assertIn("CHANGED", r.stdout)

    def test_change_outside_the_push_fails(self):
        w, _ = full_run()
        H.simulate_deploy(w)
        H.set_leaf(w, "after/**/Widget__c-en_US.objectTranslation", (("fields", "Color__c"), "label"), "Colour")
        r = run("verify_push.py", "--work", w)
        self.assertEqual(r.returncode, 2)
        self.assertIn("changed outside the push: 1", r.stdout)

    def test_value_that_did_not_land_fails(self):
        w, _ = full_run()
        H.simulate_deploy(w)
        H.set_leaf(w, "after/**/de.translation", (("customLabels", "Farewell"), "label"), "")
        self.assertEqual(run("verify_push.py", "--work", w).returncode, 2)

    def test_aspect_master_on_a_filled_quick_action_is_accepted(self):
        w, _ = full_run()
        H.simulate_deploy(w)
        import xml.etree.ElementTree as ET
        for p in glob.glob(J(w, "after", "**", "Widget__c-de.objectTranslation"), recursive=True):
            root = crsafe.parse(p).getroot()
            for qa in root.findall(L.NS + "quickActions"):
                ET.SubElement(qa, L.NS + "aspect").text = "Master"
            crsafe.write_xml(root, p)
        r = run("verify_push.py", "--work", w)
        self.assertEqual(r.returncode, 0, r.stdout)


class T10ExportDiff(unittest.TestCase):
    def test_after_export_with_exactly_the_sent_values(self):
        w, exp = full_run()
        rep = L.load_json(J(w, "push_report.json"))
        after = copy.deepcopy(H.EXPORT_BEFORE)
        for x in rep["targets"]:
            k = x["key"].replace("CustomField.Task.", "CustomField.Activity.")
            if k.startswith("ReportTypeSection."):
                k = "CrtLayoutSection.Widgets_with_Parts_1"
            after[x["lang"]][k] = x["value"]
        H.write_exports(J(w, "export_after"), after, stamp="2026-01-15 1200")
        r = run("export_diff_check.py", "--before", exp, "--after", J(w, "export_after"), "--report", J(w, "push_report.json"))
        self.assertEqual(r.returncode, 0, r.stdout)
        del after["fr"]["CustomLabel.Greeting"]
        shutil.rmtree(J(w, "export_after"))
        H.write_exports(J(w, "export_after"), after, stamp="2026-01-15 1200")
        r = run("export_diff_check.py", "--before", exp, "--after", J(w, "export_after"), "--report", J(w, "push_report.json"))
        self.assertEqual(r.returncode, 2)
        self.assertIn("LOST: 1", r.stdout)


class T11Snapshot(unittest.TestCase):
    def test_create_add_finish_verify(self):
        w, _ = full_run()
        root = tempfile.mkdtemp(prefix="snaps_")
        r = run("snapshot.py", "create", "--root", root, "--org", "MYPROD", "--what", "labels-push", "--work", w)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        snap = glob.glob(J(root, "MYPROD_*_before_labels-push"))[0]
        self.assertRegex(os.path.basename(snap), r"^MYPROD_\d{4}-\d{2}-\d{2}_\d{4}_before_labels-push$")
        self.assertTrue(os.path.isdir(J(snap, "before")))
        self.assertTrue(os.path.isfile(J(snap, "push_report.json")))
        L.dump_json({"result": "PASS"}, J(w, "check_vs_stf.json"))
        self.assertEqual(run("snapshot.py", "add", "--snapshot", snap, "--work", w, "check_vs_stf.json").returncode, 0)
        self.assertEqual(run("snapshot.py", "verify", "--snapshot", snap).returncode, 0)
        self.assertEqual(run("snapshot.py", "finish", "--snapshot", snap, "--deploy-id", "X" * 18).returncode, 0)
        done = snap + "_" + "X" * 18
        self.assertTrue(os.path.isdir(done))
        self.assertEqual(L.load_json(J(done, "SNAPSHOT.json"))["deploy_id"], "X" * 18)
        with open(J(done, "push_report.json"), "a") as f:
            f.write(" ")
        self.assertEqual(run("snapshot.py", "verify", "--snapshot", done).returncode, 2)

    def test_mark_start_with_org_time(self):
        w = tempfile.mkdtemp()
        r = run("snapshot.py", "mark-start", "--work", w, "--org-time", "2026-01-15 0900")
        self.assertEqual(r.returncode, 0, r.stdout)
        lines = Path(J(w, "read_start.txt")).read_text(encoding="utf-8").splitlines()
        self.assertTrue(lines[0].startswith("UTC "))
        self.assertEqual(lines[1], "ORG 2026-01-15 0900")


class T12ManifestsAndReview(unittest.TestCase):
    def test_manifests(self):
        w = H.new_work()
        r = run("make_manifests.py", "--source", J(w, "source.json"), "--out", J(w, "manifests"))
        self.assertEqual(r.returncode, 0, r.stdout)
        obj = Path(J(w, "manifests", "obj_1.xml")).read_text(encoding="utf-8")
        for m in ("<members>Activity-de</members>", "<members>Widget__c-fr</members>", "<members>Widget__c-Widget Layout</members>",
                  "<members>Widget__c.Log_Widget</members>"):
            self.assertIn(m, obj)
        self.assertNotIn("en_US", obj)
        lab = Path(J(w, "manifests", "labels.xml")).read_text(encoding="utf-8")
        for m in ("<members>Colors-de</members>", "<members>LeadSource-fr</members>", "<members>Farewell</members>",
                  "<name>Translations</name>"):
            self.assertIn(m, lab)

    def test_api_version_default_and_override(self):
        import build_push
        import make_manifests
        self.assertEqual(L.DEFAULT_API_VERSION, "67.0")
        for mod in (build_push, make_manifests):
            self.assertIn('L.DEFAULT_API_VERSION', Path(mod.__file__).read_text(encoding="utf-8"))
        w = H.new_work()
        run("make_manifests.py", "--source", J(w, "source.json"), "--out", J(w, "manifests"))
        for f in ("obj_1.xml", "labels.xml"):
            self.assertIn("<version>67.0</version>", Path(J(w, "manifests", f)).read_text(encoding="utf-8"))
        run("make_manifests.py", "--source", J(w, "source.json"), "--out", J(w, "manifests2"), "--api-version", "62.0")
        self.assertIn("<version>62.0</version>", Path(J(w, "manifests2", "labels.xml")).read_text(encoding="utf-8"))

    def test_build_payload_version(self):
        w = H.new_work()
        self.assertEqual(build(w).returncode, 0)
        self.assertIn("<version>67.0</version>", Path(J(w, "payload", "package.xml")).read_text(encoding="utf-8"))
        w2 = H.new_work()
        self.assertEqual(build(w2, "--api-version", "62.0").returncode, 0)
        self.assertIn("<version>62.0</version>", Path(J(w2, "payload", "package.xml")).read_text(encoding="utf-8"))

    def test_review_excel(self):
        w, _ = full_run()
        out = J(w, "review.xlsx")
        r = run("review_excel.py", "--work", w, "--out", out)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        import openpyxl
        wb = openpyxl.load_workbook(out)
        self.assertEqual(wb["ACTION"].max_row - 1, 4)
        self.assertEqual(wb["Pushed"].max_row - 1, 18)


if __name__ == "__main__":
    unittest.main(verbosity=2)
