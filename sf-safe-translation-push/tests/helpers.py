# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Synthetic fixtures for the offline tests: a run folder with a fake target retrieve, Bilingual
exports, and a simulated deploy. Nothing here calls Salesforce."""
import datetime
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPTS = os.path.join(ROOT, "scripts")
FIX = os.path.join(HERE, "fixtures")
sys.path.insert(0, SCRIPTS)

import translib as L  # noqa: E402
import negative_control  # noqa: E402

# every key the synthetic org's export lists, with its English label
EXPORT_KEYS = [
    ("CustomField.Widget__c.Color.FieldLabel", "Color"),
    ("CustomField.Widget__c.Color.HelpText", "Pick a color"),
    ("PicklistValue.Widget__c.Color.Red", "Red"),
    ("PicklistValue.Widget__c.Color.Blue", "Blue"),
    ("CustomField.Widget__c.Size.FieldLabel", "Size"),
    ("CustomField.Widget__c.Size.HelpText", "Widget size"),
    ("LayoutSection.Widget__c.Widget Layout.Details", "Details"),
    ("LayoutSection.Widget__c.Widget Layout.System Information", "System Information"),
    ("RecordType.Widget__c.Big.Name", "Big"),
    ("RecordType.Widget__c.Big.Description", "A big widget"),
    ("ValidationFormula.Widget__c.Size_Required.ErrorMessage", "Size is required"),
    ("QuickAction.Widget__c.Log_Widget", "Log Widget"),
    ("PicklistValue.Colors__gvs.Green", "Green"),
    ("PicklistValue.Colors__gvs.Yellow", "Yellow"),
    ("PicklistValue.Standard.LeadSource.Web", "Web"),
    ("CustomLabel.Greeting", "Hello"),
    ("CustomLabel.Farewell", "Goodbye"),
    ("WebTab.Widget__c", "Widgets"),
    ("CustomReportType.Widgets_with_Parts.Name", "Widgets with Parts"),
    ("CrtLayoutSection.Widgets_with_Parts_1", "Widgets"),
    ("CustomField.Activity.Note.FieldLabel", "Note"),
    ("CustomField.Activity.Priority_Code.FieldLabel", "Priority Code"),
]
# what the synthetic org holds before the push (must agree with tests/fixtures/before)
EXPORT_BEFORE = {
    "de": {"CustomField.Widget__c.Color.FieldLabel": "Farbe", "PicklistValue.Widget__c.Color.Red": "Rot",
           "CustomField.Widget__c.Size.HelpText": "Erste Zeile zweite Zeile",
           "LayoutSection.Widget__c.Widget Layout.System Information": "System", "RecordType.Widget__c.Big.Name": "Gross",
           "PicklistValue.Colors__gvs.Green": "Gruen", "CustomLabel.Greeting": "Hallo",
           "CustomField.Activity.Priority_Code.FieldLabel": "Prioritaetscode"},
    "fr": {"PicklistValue.Widget__c.Color.Red": "Rouge", "CustomField.Widget__c.Size.FieldLabel": "Taille",
           "CustomLabel.Greeting": "Bonjour"},
}
STAMP_BEFORE = "2026-01-15 1000"
READ_START_ORG = "2026-01-15 0900"
LANG_NAMES = {"de": "German", "fr": "French"}


def run(script, *args, cwd=None):
    r = subprocess.run([sys.executable, os.path.join(SCRIPTS, script)] + [str(x) for x in args],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=cwd)
    return r


def write_retrieve_json(batch_dir):
    """The `sf project retrieve start --json` result for a batch dir (status, zip path, file list)."""
    files = []
    for p in glob.glob(os.path.join(batch_dir, "**", "*"), recursive=True):
        if os.path.isfile(p) and not p.endswith(("package.xml", ".zip")):
            rel = os.path.relpath(p, batch_dir).replace("\\", "/")
            rel = rel[len("unpackaged/"):] if rel.startswith("unpackaged/") else rel
            files.append({"fileName": rel, "type": "CustomObjectTranslation"})
    doc = {"status": 0, "result": {"status": "Succeeded", "success": True, "messages": [],
                                    "zipFilePath": os.path.join(batch_dir, "unpackaged.zip"), "fileProperties": files},
           "warnings": []}
    with open(batch_dir.rstrip("\\/") + ".json", "w", encoding="utf-8") as f:
        json.dump(doc, f)


def write_exports(d, data, stamp=STAMP_BEFORE):
    os.makedirs(d, exist_ok=True)
    for lang, held in data.items():
        lines = ["# Use the Bilingual file to review and edit translations.", f"# Language: {LANG_NAMES.get(lang, lang)}",
                 f"Language code: {lang}", "Type: Bilingual", "Translation type: Metadata", ""]
        tr = [(k, en) for k, en in EXPORT_KEYS if k in held]
        un = [(k, en) for k, en in EXPORT_KEYS if k not in held]
        if tr:
            lines += ["------------------TRANSLATED-------------------", "", "# KEY\tLABEL\tTRANSLATION\tOUT OF DATE", ""]
            lines += [f"{k}\t{en}\t{held[k]}\t-" for k, en in tr]
            lines += [""]
        lines += ["------------------OUTDATED AND UNTRANSLATED-----------------", "", "# KEY\tLABEL", ""]
        lines += [f"{k}\t{en}" for k, en in un]
        with open(os.path.join(d, f"Bilingual_{lang}_{stamp}.stf"), "wb") as f:
            f.write(("\n".join(lines) + "\n").encode("utf-8"))


def new_work(source_csv=os.path.join(FIX, "source.csv")):
    """A run folder: before/ (copied fixtures + retrieve JSONs), read_start.txt and source.json."""
    w = tempfile.mkdtemp(prefix="sftp_test_")
    t = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=5)
    with open(os.path.join(w, "read_start.txt"), "w", encoding="utf-8") as f:
        f.write(f"UTC {t.strftime('%Y-%m-%dT%H:%M:%SZ')}\nORG {READ_START_ORG}\n")
    shutil.copytree(os.path.join(FIX, "before"), os.path.join(w, "before"))
    for b in os.listdir(os.path.join(w, "before")):
        write_retrieve_json(os.path.join(w, "before", b))
    r = run("make_source.py", "--input", source_csv, "--out", os.path.join(w, "source.json"))
    assert r.returncode == 0, r.stdout + r.stderr
    return w


def simulate_deploy(w, src="before", dst="after"):
    """A copy of src with every payload target written the way Salesforce stores it (Task/Event fields under Activity)."""
    shutil.rmtree(os.path.join(w, dst), ignore_errors=True)
    shutil.copytree(os.path.join(w, src), os.path.join(w, dst))
    rep = L.load_json(os.path.join(w, "push_report.json"))
    srcs = L.component_sources(os.path.join(w, dst))
    for x in rep["targets"]:
        k, s = (x["folder"], x["component"]), L.sig_tuple(x["sig"])
        k = L.activity_alias(*k, s) or k
        hits = sum(negative_control.plant(p, s, x["value"]) for p in srcs.get(k, []))
        assert hits, (k, s)
    for b in os.listdir(os.path.join(w, dst)):
        if os.path.isdir(os.path.join(w, dst, b)):
            write_retrieve_json(os.path.join(w, dst, b))
    return rep


def set_leaf(w, rel_glob, sig, value):
    n = 0
    for p in glob.glob(os.path.join(w, rel_glob), recursive=True):
        n += negative_control.plant(p, sig, value)
    assert n, rel_glob
