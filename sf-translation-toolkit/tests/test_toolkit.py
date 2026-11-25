#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Offline tests for what makes the toolkit project-neutral: any Salesforce language,
the generated retrieve manifest, and the shared settings. No org access.

    python tests/test_toolkit.py
"""
from __future__ import annotations

import csv
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
FIXTURES = HERE / "fixtures"
PY = sys.executable
sys.path.insert(0, str(SCRIPTS))

passed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed
    if not ok:
        raise AssertionError(f"FAIL: {name}{(' — ' + detail) if detail else ''}")
    passed += 1
    print(f"  ok: {name}")


def run(*args, cwd=None) -> subprocess.CompletedProcess:
    r = subprocess.run([PY, *map(str, args)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", cwd=cwd)
    if r.returncode != 0:
        raise AssertionError(f"command failed: {' '.join(map(str, args))}\n{r.stderr[-2000:]}")
    return r


def test_languages() -> None:
    print("sf_languages:")
    import sf_languages as L
    check("every Salesforce language is listed", len(L.LANGUAGES) >= 221, str(len(L.LANGUAGES)))
    names = [n.lower() for n in L.LANGUAGES.values()]
    check("display names are unique", len(names) == len(set(names)))
    check("name -> code round-trips for all", all(L.code_for(n) == c for c, n in L.LANGUAGES.items()))
    check("bare codes and aliases resolve",
          L.code_for("ja") == "ja" and L.code_for("Portuguese (European)") == "pt_PT"
          and L.code_for("Slovenian") == "sl"
          and L.code_for("chinese (simplified)") == "zh_CN")
    check("unknown code displays as itself", L.name("xx_YY") == "xx_YY")
    check("English first, then by name", L.ordered({"ja", "de", "en_US", "cac"}) == ["en_US", "cac", "de", "ja"])


def test_any_language_end_to_end(tmp: Path) -> None:
    print("any language, end to end (fixtures):")
    proj = tmp / "proj"
    shutil.copytree(FIXTURES, proj / "force-app" / "main" / "default")
    run_dir = proj / "work" / "run"
    run_dir.mkdir(parents=True)
    fields = FIXTURES / "fields.csv"
    langs = "de,ja,pt_BR,cac"

    run(SCRIPTS / "translation_roundtrip.py", "to-csv", fields, langs,
        "-o", run_dir / "translations.csv", "--standard-labels", tmp / "_none.json", cwd=proj)
    made = sorted(p.name for p in run_dir.glob("translations_*.csv"))
    check("one CSV per language, any code", made == [f"translations_{c}.csv" for c in sorted(langs.split(","))], str(made))

    wb_path = run_dir / "master.xlsx"
    run(SCRIPTS / "combine_translations.py", "--input-dir", run_dir, "--output", wb_path, cwd=proj)
    import openpyxl
    wb = openpyxl.load_workbook(wb_path)
    ws = wb["Fields"]
    header = [c.value for c in ws[1]]
    for want in ("Japanese Translation", "Portuguese (Brazil) Translation", "Chuj Translation",
                 "German Translation"):
        check(f"workbook has a '{want}' column", want in header)
    banner = [c.value for c in ws[2]]
    from toolkit_settings import BANNER_TO_POPULATE
    check("banner uses the settings text", BANNER_TO_POPULATE in banner)

    # Reviewers fill the Translation columns.
    cols = {h: i for i, h in enumerate(header) if h}
    src = cols["Value to Translate"]
    filled = 0
    for row in ws.iter_rows(min_row=3):
        if row[cols["type"]].value and row[src].value:
            for name, code in (("Japanese", "ja"), ("Portuguese (Brazil)", "pt_BR"), ("Chuj", "cac")):
                row[cols[f"{name} Translation"]].value = f"{code}::{row[src].value}"
                filled += 1
    returned = run_dir / "returned.xlsx"
    wb.save(returned)
    check("rows filled", filled > 0, str(filled))

    out_csv = run_dir / "out_fields"
    r = run(SCRIPTS / "split_master_translations.py", returned, "--sheet", "Fields",
            "--roundtrip", "--fix-file-lang", "-d", out_csv)
    check("split needs no --lang-code for any Salesforce language", "no language code known" not in r.stderr, r.stderr[-300:])
    names = sorted(p.name for p in out_csv.glob("*.csv"))
    check("split writes translations-<language>.csv", "translations-japanese.csv" in names, str(names))

    out = run_dir / "out"
    run(SCRIPTS / "translation_roundtrip.py", "to-files", *sorted(out_csv.glob("*.csv")),
        "--dir", out, "--skip-untranslated", cwd=proj)
    ja_field = out / "objectTranslations" / "Widget__c-ja" / "Color__c.fieldTranslation-meta.xml"
    check("Japanese field file written", ja_field.is_file())
    check("Japanese label carried", "<label>ja::Color</label>" in (ja_field.read_text(encoding="utf-8") if ja_field.is_file() else ""))
    check("three-letter code folder written", (out / "objectTranslations" / "Widget__c-cac").is_dir())
    check("value set file for pt_BR written",
          (out / "globalValueSetTranslations" / "SizeSet-pt_BR.globalValueSetTranslation-meta.xml").is_file())
    check("German not written (left blank)", not (out / "objectTranslations" / "Widget__c-de").exists())


def test_error_file_codes() -> None:
    print("make_deploy_error_file language codes:")
    from make_deploy_error_file import _lang_from_file_col, parse_fullname
    check("three-letter code in a component name", parse_fullname("Widget__c-cac", "CustomObjectTranslation") == ("cac", "Widget__c"))
    check("three-letter code in a file path",
          _lang_from_file_col("objectTranslations/Widget__c-haw/Color__c.fieldTranslation-meta.xml") == "haw")
    check("two-letter + region still parsed", parse_fullname("Account-pt_BR", "CustomObjectTranslation") == ("pt_BR", "Account"))


def test_make_manifest() -> None:
    print("make_manifest:")
    from make_manifest import build
    ns = {"m": "http://soap.sforce.com/2006/04/metadata"}

    def types_of(xml):
        root = ET.fromstring(xml)
        return {t.find("m:name", ns).text: [m.text for m in t.findall("m:members", ns)]
                for t in root.findall("m:types", ns)}

    files = build({"Widget__c.Color__c", "Account.Industry", "Task.Subject"}, ["fr", "de"],
                  layouts=["Account-Account Layout", "Task-Task Layout", "Widget__c-Widget Layout",
                           "Contact-Contact Layout"],
                  quick_actions=["Account.New_Widget", "Global_Action"], batch_size=2)
    check("one manifest per batch plus labels", sorted(files) == ["labels.xml", "obj_1.xml", "obj_2.xml"], str(sorted(files)))
    b1 = types_of(files["obj_1.xml"])
    check("Activity kept with Task in the first batch", b1["CustomObject"] == ["Activity", "Task"], str(b1["CustomObject"]))
    check("translations named per language, plus en_US and the probe",
          b1["CustomObjectTranslation"] == ["Activity-de", "Activity-en_US", "Activity-fr", "Activity-ja",
                                            "Task-de", "Task-en_US", "Task-fr", "Task-ja"], str(b1["CustomObjectTranslation"]))
    check("the batch's own layouts named", b1["Layout"] == ["Task-Task Layout"])
    allb = [types_of(files[f]) for f in ("obj_1.xml", "obj_2.xml")]
    acct = next(t for t in allb if "Account" in t["CustomObject"])
    check("object quick actions travel with their object", acct.get("QuickAction") == ["Account.New_Widget"])
    check("no layouts for objects out of scope", not any("Contact-Contact Layout" in t.get("Layout", []) for t in allb))
    lab = types_of(files["labels.xml"])
    check("custom labels and global value sets in the labels manifest",
          lab["CustomLabel"] == ["*"] and lab["GlobalValueSet"] == ["*"])
    check("standard value set for a scoped standard picklist", lab.get("StandardValueSet") == ["Industry"])
    check("each language named for custom labels, plus en_US", lab["Translations"] == ["de", "en_US", "fr"])


def test_safeguards(tmp: Path) -> None:
    print("safeguards:")
    import sf_languages as L
    try:
        L.require_known(["de", "nl"], "test")
        stopped = ""
    except SystemExit as e:
        stopped = str(e)
    check("an unknown code stops the run with a hint", "nl (use nl_NL)" in stopped, stopped)
    check("a proven no-grammar language is known", L.grammar_known("fi") and L.grammar_known("de"))
    check("a language without rules is unknown, not 'none'", not L.grammar_known("ja"))
    import combine_translations as ct
    check("unknown grammar is never complete", not ct._object_grammar_complete("ja", {"gender": "Feminine"}))
    check("proven no-grammar language is complete", ct._object_grammar_complete("fi", {}))

    # a workbook header that maps to no Salesforce code must stop the split
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Fields"
    ws.append(["file", "type", "component", "field", "masterLabel", "Value to Translate",
               "Klingon Existing Value", "Klingon Translation"])
    ws.append(["Do Not Edit"] * 6 + ["Do Not Edit", "To Populate"])
    ws.append(["objectTranslations/Widget__c-de/Color__c.fieldTranslation-meta.xml", "field-label",
               "Widget__c", "Color__c", "", "Color", "", "tlhIngan"])
    path = tmp / "bad_header.xlsx"
    wb.save(path)
    r = subprocess.run([PY, str(SCRIPTS / "split_master_translations.py"), str(path), "--sheet",
                        "Fields", "--roundtrip", "--fix-file-lang", "-d", str(tmp / "bad")],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    check("unmappable header stops the split", r.returncode != 0 and "Klingon" in r.stderr, r.stderr[-200:])

    # grammar without name forms is never written
    out = tmp / "objn" / "force-app" / "main" / "default"
    out.mkdir(parents=True)
    ct._write_object_names_xml(out, {"Account": {"de": {"values": {}, "gender": "Masculine", "startsWith": ""}}})
    check("grammar without names is skipped", not (out / "objectTranslations" / "Account-de").exists())


def test_header_colours() -> None:
    print("language header colours:")
    import combine_translations as ct
    langs = ["en_US", "de", "es", "fr", "it", "ja"]
    ct.assign_lang_colors(langs)
    check("colours follow the languages present, in order",
          [ct.lang_color(l) for l in langs] == ct._LANG_PALETTE[:len(langs)])
    many = sorted(ct.LANGUAGE_NAMES)[: len(ct._LANG_PALETTE) + 3]
    ct.assign_lang_colors(many)
    check("any number of languages gets a colour (palette repeats)",
          all(ct.lang_color(l) in ct._LANG_PALETTE for l in many)
          and ct.lang_color(many[len(ct._LANG_PALETTE)]) == ct._LANG_PALETTE[0])
    ct.assign_lang_colors(["de"])
    check("an unassigned language takes the next colour", ct.lang_color("ko") == ct._LANG_PALETTE[1])


def test_namespaced_filter() -> None:
    print("psg2csv_collect --drop-namespaced:")
    from psg2csv_collect import NAMESPACED_OBJECT
    obj = lambda name: name.split(".", 1)[0]
    check("managed-package object matched", bool(NAMESPACED_OBJECT.search(obj("mypkg__Gadget__c.Part__c"))))
    check("own custom object kept", not NAMESPACED_OBJECT.search(obj("Invoice__c.Total__c")))
    check("knowledge object kept", not NAMESPACED_OBJECT.search(obj("Knowledge__kav.Details__c")))
    check("standard object with managed field kept", not NAMESPACED_OBJECT.search(obj("Account.mypkg__Zone__c")))


def main() -> None:
    with tempfile.TemporaryDirectory() as td:
        try:
            test_languages()
            test_any_language_end_to_end(Path(td))
            test_error_file_codes()
            test_make_manifest()
            test_safeguards(Path(td))
            test_header_colours()
            test_namespaced_filter()
        except AssertionError as e:
            print(f"\n{e}", file=sys.stderr)
            sys.exit(1)
    print(f"\nAll {passed} checks passed.")


if __name__ == "__main__":
    main()
