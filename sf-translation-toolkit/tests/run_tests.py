#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Tiny offline regression tests for the toolkit scripts.

Runs the offline scripts (expand_picklists, translation_roundtrip to-csv/to-files) against a
small self-contained metadata fixture under tests/fixtures/ and asserts the output, then
runs tests/test_toolkit.py (languages, manifests, settings, safeguards). No org access
required. Run with:

    python tests/run_tests.py

Exits non-zero on the first failure.
"""

from __future__ import annotations

import csv
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
FIXTURES = HERE / "fixtures"
FIELD_CSV = FIXTURES / "fields.csv"
PY = sys.executable
NO_CACHE = HERE / "_no_such_cache.json"  # force scripts to ignore optional JSON caches

passed = 0


def run(*args: str) -> None:
    result = subprocess.run([PY, *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise AssertionError(f"command failed: {' '.join(args)}\n{result.stderr}")


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed
    if not condition:
        raise AssertionError(f"FAIL: {name}{(' — ' + detail) if detail else ''}")
    passed += 1
    print(f"  ok: {name}")


def read_csv(path: Path) -> list[dict]:
    with open(path, newline="") as fh:
        return list(csv.DictReader(fh))


def test_expand_picklists(tmp: Path) -> None:
    print("expand_picklists:")
    out = tmp / "expanded.csv"
    run(str(SCRIPTS / "expand_picklists.py"), str(FIELD_CSV),
        "-d", str(FIXTURES), "-o", str(out), "--standard-picklists", str(NO_CACHE))
    rows = read_csv(out)
    # expand_picklists emits the picklist API value (fullName), not the label.
    pv = lambda name: sorted(r["PicklistValue"] for r in rows
                             if r["Name"] == name and r["PicklistValue"])
    check("inline picklist expanded", pv("Widget__c.Color__c") == ["BLUE", "RED"],
          str(pv("Widget__c.Color__c")))
    check("global value set expanded", pv("Widget__c.Size__c") == ["LARGE", "SMALL"],
          str(pv("Widget__c.Size__c")))
    notes = [r for r in rows if r["Name"] == "Widget__c.Notes__c"]
    check("non-picklist passes through", len(notes) == 1 and notes[0]["PicklistValue"] == "")


def test_translation_roundtrip(tmp: Path) -> None:
    print("translation_roundtrip:")
    csv_path = tmp / "translations_de.csv"
    run(str(SCRIPTS / "translation_roundtrip.py"), "to-csv", str(FIELD_CSV), "de",
        "-d", str(FIXTURES), "-o", str(csv_path), "--standard-labels", str(NO_CACHE))
    rows = read_csv(csv_path)
    by_type = lambda t: [r for r in rows if r["type"] == t]
    check("field-label rows", {r["field"] for r in by_type("field-label")} ==
          {"Color__c", "Size__c", "Notes__c"})
    check("inline picklist rows", sorted(r["masterLabel"] for r in by_type("field-picklist"))
          == ["Blue", "Red"])
    check("global-value rows", sorted(r["masterLabel"] for r in by_type("global-value"))
          == ["Large", "Small"])

    # Fill translations ("de::" prefix) and round-trip back to files.
    for r in rows:
        r["translation"] = "de::" + r["source"] if r["source"] else ""
    with open(csv_path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)

    out = tmp / "out"
    run(str(SCRIPTS / "translation_roundtrip.py"), "to-files", str(csv_path), "--dir", str(out))
    field_file = out / "objectTranslations" / "Widget__c-de" / "Color__c.fieldTranslation-meta.xml"
    gvs_file = out / "globalValueSetTranslations" / "SizeSet-de.globalValueSetTranslation-meta.xml"
    check("field translation file written", field_file.is_file())
    text = field_file.read_text() if field_file.is_file() else ""
    check("field label translated", "<label>de::Color</label>" in text)
    check("picklist value translated", "<translation>de::Red</translation>" in text)
    check("global value set file written", gvs_file.is_file())
    check("global value translated",
          "de::Small" in (gvs_file.read_text() if gvs_file.is_file() else ""))


def test_prefill(tmp: Path) -> None:
    """--retrieve-existing's pre-fill step: merge existing <lang> files into rows (offline)."""
    print("translation_roundtrip prefill:")
    sys.path.insert(0, str(SCRIPTS))
    from translation_roundtrip import prefill_rows  # imported here to keep top offline-only

    default_dir = tmp / "default"
    field_dir = default_dir / "objectTranslations" / "Widget__c-de"
    field_dir.mkdir(parents=True)
    (field_dir / "Color__c.fieldTranslation-meta.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<CustomFieldTranslation xmlns="http://soap.sforce.com/2006/04/metadata">\n'
        "    <label>de::Color</label>\n    <name>Color__c</name>\n"
        "    <picklistValues>\n        <masterLabel>Red</masterLabel>\n"
        "        <translation>de::Red</translation>\n    </picklistValues>\n"
        "</CustomFieldTranslation>\n"
    )
    gvs_dir = default_dir / "globalValueSetTranslations"
    gvs_dir.mkdir(parents=True)
    (gvs_dir / "SizeSet-de.globalValueSetTranslation-meta.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<GlobalValueSetTranslation xmlns="http://soap.sforce.com/2006/04/metadata">\n'
        "    <valueTranslation>\n        <masterLabel>Small</masterLabel>\n"
        "        <translation>de::Small</translation>\n    </valueTranslation>\n"
        "</GlobalValueSetTranslation>\n"
    )

    field_file = "objectTranslations/Widget__c-de/Color__c.fieldTranslation-meta.xml"
    gvs_file = "globalValueSetTranslations/SizeSet-de.globalValueSetTranslation-meta.xml"
    rows = [
        {"file": field_file, "type": "field-label", "field": "Color__c", "masterLabel": "", "translation": ""},
        {"file": field_file, "type": "field-picklist", "field": "Color__c", "masterLabel": "Red", "translation": ""},
        {"file": field_file, "type": "field-picklist", "field": "Color__c", "masterLabel": "Blue", "translation": ""},
        {"file": gvs_file, "type": "global-value", "field": "", "masterLabel": "Small", "translation": ""},
    ]
    filled = prefill_rows(rows, default_dir)
    check("prefill count", filled == 3, str(filled))
    check("label prefilled", rows[0]["translation"] == "de::Color")
    check("picklist prefilled", rows[1]["translation"] == "de::Red")
    check("missing stays blank", rows[2]["translation"] == "")
    check("global value prefilled", rows[3]["translation"] == "de::Small")


def test_validate(tmp: Path) -> None:
    """validate: catches GVS moves, vanished values, and mangled text; passes clean rows."""
    print("translation_roundtrip validate:")
    sys.path.insert(0, str(SCRIPTS))
    from translation_roundtrip import validate_rows

    d = tmp / "vdefault"
    (d / "objects" / "Widget__c" / "fields").mkdir(parents=True)
    (d / "globalValueSets").mkdir(parents=True)
    NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"'

    # Colour__c still has inline values; Size__c has moved to a global value set.
    (d / "objects/Widget__c/fields/Colour__c.field-meta.xml").write_text(
        f'<?xml version="1.0" encoding="UTF-8"?>\n<CustomField {NS}>\n'
        "    <type>Picklist</type>\n    <valueSet>\n        <valueSetDefinition>\n"
        "            <value><fullName>RED</fullName><label>Red</label></value>\n"
        "        </valueSetDefinition>\n    </valueSet>\n</CustomField>\n")
    (d / "objects/Widget__c/fields/Size__c.field-meta.xml").write_text(
        f'<?xml version="1.0" encoding="UTF-8"?>\n<CustomField {NS}>\n'
        "    <type>Picklist</type>\n    <valueSet>\n"
        "        <valueSetName>SizeSet</valueSetName>\n    </valueSet>\n</CustomField>\n")
    (d / "globalValueSets/SizeSet.globalValueSet-meta.xml").write_text(
        f'<?xml version="1.0" encoding="UTF-8"?>\n<GlobalValueSet {NS}>\n'
        "    <customValue><fullName>S</fullName><label>Small</label></customValue>\n"
        "</GlobalValueSet>\n")

    def row(type_, field, master, source="x", file=None):
        return {"file": file or f"objectTranslations/Widget__c-de/{field}.fieldTranslation-meta.xml",
                "type": type_, "component": "Widget__c", "field": field,
                "masterLabel": master, "source": source, "translation": "t"}

    gvs_file = "globalValueSetTranslations/SizeSet-de.globalValueSetTranslation-meta.xml"
    cases = {
        "clean inline value": (row("field-picklist", "Colour__c", "Red"), None),
        "vanished value": (row("field-picklist", "Colour__c", "Purple"), "value no longer exists"),
        "moved to global value set": (row("field-picklist", "Size__c", "Small"),
                                      "picklist moved to a global value set"),
        "unknown field": (row("field-label", "Gone__c", ""), "field not in metadata"),
        "clean global value": (row("global-value", "", "Small", file=gvs_file), None),
        "vanished global value": (row("global-value", "", "Huge", file=gvs_file),
                                  "value no longer exists"),
        "mangled text": (row("field-picklist", "Colour__c", "Red", source="Fianc\u00c3\u00a9"),
                         "encoding damage"),
    }
    for name, (r, expected) in cases.items():
        found = {c for c, _ in validate_rows([r], d)}
        if expected is None:
            check(name, not found, str(found))
        else:
            check(name, expected in found, f"got {found or 'nothing'}")

    # An org snapshot catches what local metadata can't: components deleted from the org
    # (a retrieve never deletes) -- while deactivated picklist values still validate, since
    # they remain translatable even though a describe omits them.
    org = {"Widget__c": {"fields": {"Colour__c"}, "recordTypes": {"Live"}}}
    rt = dict(row("record-type", "Retired", ""), type="record-type",
              file="objectTranslations/Widget__c-de/Widget__c-de.objectTranslation-meta.xml")
    check("deleted field caught via org",
          "deleted in the org" in {c for c, _ in validate_rows([row("field-label", "Size__c", "")], d, org)})
    check("deleted record type caught via org",
          "deleted in the org" in {c for c, _ in validate_rows([rt], d, org)})
    check("live field not flagged",
          not validate_rows([row("field-picklist", "Colour__c", "Red")], d, org))

    # The global-value-set hint names the file the row should have gone to.
    _, detail = validate_rows([row("field-picklist", "Size__c", "Small")], d)[0]
    check("hint names the target file", "globalValueSetTranslations/SizeSet-de" in detail, detail)


def test_validate_fix(tmp: Path) -> None:
    """validate --fix: repairs mangled text and re-points moved values, leaves the rest."""
    print("translation_roundtrip validate --fix:")
    sys.path.insert(0, str(SCRIPTS))
    from translation_roundtrip import drop_gone, fix_rows, scan_rows

    d = tmp / "vdefault"  # metadata built by test_validate
    def row(field, master, translation="t", source=None):
        return {"file": f"objectTranslations/Widget__c-de/{field}.fieldTranslation-meta.xml",
                "type": "field-picklist", "component": "Widget__c", "field": field,
                "masterLabel": master, "source": source if source is not None else master,
                "translation": translation}

    rows, notes = fix_rows([
        row("Size__c", "Small", "Klein"),        # moved to SizeSet -> re-point
        row("Size__c", "Enormous"),              # moved AND renamed -> leave alone
        row("Colour__c", "Red", "Rot"),          # fine -> untouched
        row("Colour__c", "Red", "", source="Fianc\u00c3\u00a9"),  # mangled + duplicate
    ], d)

    moved = next(r for r in rows if r["component"] == "SizeSet")
    check("re-pointed file", moved["file"].endswith("SizeSet-de.globalValueSetTranslation-meta.xml"),
          moved["file"])
    check("re-pointed type", moved["type"] == "global-value", moved["type"])
    check("re-pointed clears field", moved["field"] == "", repr(moved["field"]))
    check("translation preserved", moved["translation"] == "Klein")

    stayed = next(r for r in rows if r["masterLabel"] == "Enormous")
    check("renamed value left alone", stayed["type"] == "field-picklist", stayed["type"])

    check("mangled text repaired",
          all("\u00c3" not in r["source"] for r in rows), [r["source"] for r in rows])
    check("duplicate merged", sum(1 for r in rows if r["masterLabel"] == "Red") == 1,
          str(sum(1 for r in rows if r["masterLabel"] == "Red")))
    check("kept the filled translation",
          next(r for r in rows if r["masterLabel"] == "Red")["translation"] == "Rot")
    check("reports what it did", any("re-pointed" in n for n in notes), str(notes))

    # --drop-deleted removes only the rows whose target is gone.
    org = {"Widget__c": {"fields": {"Colour__c"}, "recordTypes": set()}}
    candidates = [row("Colour__c", "Red"), row("Colour__c", "Purple"), row("Size__c", "Small")]
    kept, dropped = drop_gone(candidates, scan_rows(candidates, d, org))
    check("dropped the gone rows", dropped == 2, str(dropped))
    check("kept the good row", [r["masterLabel"] for r in kept] == ["Red"],
          str([r["masterLabel"] for r in kept]))
    check("nothing left to report", not scan_rows(kept, d, org))


def test_gender(tmp: Path) -> None:
    """`gender` column: pre-filled from existing files, written as <gender>, omitted if blank."""
    print("translation_roundtrip gender:")
    sys.path.insert(0, str(SCRIPTS))
    from translation_roundtrip import COLUMNS, prefill_rows, to_files

    # An existing renamed-standard-field translation carrying a gender.
    default_dir = tmp / "gdefault"
    field_dir = default_dir / "objectTranslations" / "Account-de"
    field_dir.mkdir(parents=True)
    rel = "objectTranslations/Account-de/size_account.fieldTranslation-meta.xml"
    (default_dir / rel).write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<CustomFieldTranslation xmlns="http://soap.sforce.com/2006/04/metadata">\n'
        "    <caseValues>\n        <plural>false</plural>\n"
        "        <value>Kontogröße</value>\n    </caseValues>\n"
        "    <gender>Feminine</gender>\n    <name>size_account</name>\n"
        "</CustomFieldTranslation>\n",
        encoding="utf-8",
    )
    rows = [{"file": rel, "type": "standard-field", "field": "size_account",
             "masterLabel": "", "translation": "", "gender": ""}]
    prefill_rows(rows, default_dir)
    check("gender prefilled", rows[0]["gender"] == "Feminine", rows[0]["gender"])
    check("translation prefilled", rows[0]["translation"] == "Kontogröße")

    # to-files writes <gender> when set, and omits the element entirely when blank.
    csv_path = tmp / "gender_de.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerow({"file": rel, "type": "standard-field", "component": "Account",
                    "field": "size_account", "masterLabel": "", "source": "Account Size",
                    "translation": "Kontogröße", "gender": "Feminine"})
        w.writerow({"file": "objectTranslations/Contact-de/nickname_contact.fieldTranslation-meta.xml",
                    "type": "standard-field", "component": "Contact", "field": "nickname_contact",
                    "masterLabel": "", "source": "Nickname", "translation": "Spitzname",
                    "gender": ""})
    out = tmp / "gender_out"
    to_files(out, csv_path)
    with_gender = (out / rel).read_text(encoding="utf-8")
    without = (out / "objectTranslations/Contact-de/"
               "nickname_contact.fieldTranslation-meta.xml").read_text(encoding="utf-8")
    check("<gender> written", "<gender>Feminine</gender>" in with_gender)
    check("gender before name", with_gender.index("<gender>") < with_gender.index("<name>"))
    check("blank gender omitted", "<gender>" not in without)

    # A CSV predating the column (no `gender` header at all) still works.
    old_csv = tmp / "old_de.csv"
    old_csv.write_text(
        "file,type,component,field,masterLabel,source,translation\n"
        f"{rel},standard-field,Account,size_account,,Account Size,Kontogröße\n",
        encoding="utf-8",
    )
    old_out = tmp / "old_out"
    to_files(old_out, old_csv)
    check("7-column CSV still works",
          "<gender>" not in (old_out / rel).read_text(encoding="utf-8"))


def test_new_types(tmp: Path) -> None:
    """Record types, validation rules, layout sections, and custom labels (to-csv + to-files)."""
    print("translation_roundtrip new types:")
    labels_list = FIXTURES / "labels.txt"
    csv_path = tmp / "nt_de.csv"
    run(str(SCRIPTS / "translation_roundtrip.py"), "to-csv", str(FIELD_CSV), "de",
        "-d", str(FIXTURES), "-o", str(csv_path), "--standard-labels", str(NO_CACHE),
        "--labels-list", str(labels_list))
    rows = read_csv(csv_path)
    src = lambda t: {(r["field"], r["masterLabel"]): r["source"] for r in rows if r["type"] == t}
    check("record-type row", src("record-type").get(("Premium", "")) == "Premium Widget")
    check("validation-rule row", src("validation-rule").get(("Require_Color", "")) == "Color is required.")
    check("layout-section row (labelled only)",
          src("layout-section") == {("Widget Layout", "Widget Details"): "Widget Details"})
    check("custom-label row (filtered to list)",
          src("custom-label") == {("Greeting", ""): "Hello"})  # Farewell excluded

    # Fill and round-trip to files.
    for r in rows:
        r["translation"] = "de::" + r["source"] if r["source"] else ""
    with open(csv_path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)
    out = tmp / "nt_out"
    run(str(SCRIPTS / "translation_roundtrip.py"), "to-files", str(csv_path), "--dir", str(out))

    container = (out / "objectTranslations" / "Widget__c-de" /
                 "Widget__c-de.objectTranslation-meta.xml").read_text()
    check("recordTypes inline in container", "<name>Premium</name>" in container
          and "<label>de::Premium Widget</label>" in container)
    check("validationRules inline in container",
          "<errorMessage>de::Color is required.</errorMessage>" in container)
    check("layouts inline in container", "<layout>Widget Layout</layout>" in container
          and "<section>Widget Details</section>" in container)
    # Container child order must be caseValues -> layouts -> recordTypes -> validationRules.
    check("container child order",
          container.find("<layouts>") < container.find("<recordTypes>") < container.find("<validationRules>"))
    labels_file = (out / "translations" / "de.translation-meta.xml").read_text()
    check("custom label in Translations file",
          "<name>Greeting</name>" in labels_file and "<label>de::Hello</label>" in labels_file)

    # Pre-fill round-trip: the values just written are read back by the existing-file reader.
    sys.path.insert(0, str(SCRIPTS))
    from translation_roundtrip import read_existing_file  # noqa: E402
    rt = read_existing_file(out / "objectTranslations" / "Widget__c-de" /
                            "Widget__c-de.objectTranslation-meta.xml")
    check("prefill reads record-type", rt.get(("record-type", "Premium", "")) == "de::Premium Widget")
    check("prefill reads layout-section",
          rt.get(("layout-section", "Widget Layout", "Widget Details")) == "de::Widget Details")
    cl = read_existing_file(out / "translations" / "de.translation-meta.xml")
    check("prefill reads custom-label", cl.get(("custom-label", "Greeting", "")) == "de::Hello")


def test_grammar_contract(tmp: Path) -> None:
    """The grammar contract Salesforce enforces on caseValues rows.

    Guards four bugs that each
    was invisible locally and only failed at deploy — or worse, only once a translator
    picked a particular dropdown value.
    """
    print("grammar contract:")
    sys.path.insert(0, str(SCRIPTS))
    import combine_translations as ct
    from translation_roundtrip import (COLUMNS, to_files, write_standard_field_file)

    # 1. Every Tab 2 dropdown offers only values that exist in Salesforce's enums.
    #    Regression: da/sv offered "Common" (no such member — utrum is Feminine) and
    #    cs/pl/ru/sk offered "Animate Masculine" with a space instead of AnimateMasculine.
    valid = {
        "gender":     {"Feminine", "Masculine", "Neuter", "AnimateMasculine"},
        "startsWith": {"Consonant", "Vowel"},
        "article":    {"None", "Definite", "Indefinite"},
    }
    # startsWith is shown to translators in words ("Vowel sound"), so it is the CONVERTED
    # value that has to be a real enum member — that conversion is the only thing standing
    # between the dropdown and invalid XML.
    def as_metadata(attr, v):
        return ct.sw_metadata(v) if attr == "startsWith" else v

    bad = [
        (lang, label, v)
        for lang in ct.ORDERED_LANGS
        for attr, label, vals in ct._tab2_grammar_cols(lang)
        for v in vals
        if as_metadata(attr, v) not in valid.get(attr, set())
    ]
    check("Tab 2 dropdowns map to real SF enum values", not bad, repr(bad[:4]))

    # 1a. The startsWith wording converts round-trip, and the bare enum still loads so a
    #     workbook built before the wording change is not silently dropped.
    sw_bad = [v for v in ("Vowel", "Consonant", "Vowel sound", "Consonant sound")
              if ct.sw_metadata(v) not in {"Vowel", "Consonant"}]
    check("startsWith wording converts to the enum (incl. legacy bare values)",
          not sw_bad, repr(sw_bad))
    check("startsWith display is stable under round-trip",
          all(ct.sw_metadata(ct.sw_display(v)) == v for v in ("Vowel", "Consonant")))
    check("blank startsWith stays blank", ct.sw_metadata("") == "" and ct.sw_display("") == "")

    # 1b. Gender is validated PER LANGUAGE — a globally-valid member can still be rejected
    #     ("Invalid gender 'Masculine' for language DUTCH"). These sets are what actually
    #     appears in retrieved org metadata, so a dropdown must not exceed them.
    #     Regression: nl_NL offered Masculine, which Dutch rejects (common gender is
    #     Feminine). The global check above cannot catch this.
    #
    #     This is a DENYLIST of values proven wrong, not an allowlist of values seen in
    #     the org. Absence from org metadata only means nobody has translated such a noun
    #     yet — e.g. ru legitimately supports AnimateMasculine even though an org may have no
    #     instance of it, so an allowlist would produce a false failure.
    # All three PROVEN by dry-run, not inferred:
    #   nl_NL "Invalid gender 'Masculine' for language DUTCH"
    #   da/sv "Invalid gender 'Masculine' for language DANISH/SWEDISH"
    # These are the common-gender (utrum) languages: de-woorden / en-ord are Feminine.
    REJECTED = {
        "nl_NL": {"Masculine"},
        "da":    {"Masculine"},
        "sv":    {"Masculine"},
    }
    offered_rejected = []
    for lang, denied in REJECTED.items():
        for attr, _label, vals in ct._tab2_grammar_cols(lang):
            if attr != "gender":
                continue
            hit = set(vals) & denied
            if hit:
                offered_rejected.append((lang, sorted(hit)))
    check("no dropdown offers a gender that language rejects",
          not offered_rejected, repr(offered_rejected))

    # 1c. Tab 2's Article dropdown must offer ONLY "None". Definite/Indefinite are valid
    #     for object-name caseValues (Tab 3) but rejected on a field's single label slot:
    #     "You have specified invalid attributes for field <field> in language DANISH"
    #     (proven by dry run for da/sv Definite+Indefinite and ro Definite).
    art_bad = [
        (lang, vals)
        for lang in ct.ORDERED_LANGS
        for attr, _label, vals in ct._tab2_grammar_cols(lang)
        if attr == "article" and set(vals) != {"None"}
    ]
    check("Tab 2 Article offers only 'None'", not art_bad, repr(art_bad))

    # 1d. ...but LANGUAGE_ARTICLE_FORMS itself must keep its variants, because Tab 3's
    #     object-name columns are built from it (one caseValue per article form).
    check("object-name article forms still include Definite/Indefinite",
          {"Definite", "Indefinite"} <= set(ct.LANGUAGE_ARTICLE_FORMS.get("da", [])),
          repr(ct.LANGUAGE_ARTICLE_FORMS.get("da")))

    # 2. The attribute name is the grammar's own type, never hardcoded to "gender".
    #    Regression: en_US/hu are startsWith-type; writing their value to `gender`
    #    would emit <gender>Consonant</gender>.
    for lang in ("en_US", "hu"):
        attrs = [a for a, _l, _v in ct._tab2_grammar_cols(lang)]
        check(f"{lang} uses startsWith (not gender)",
              "startsWith" in attrs and "gender" not in attrs, repr(attrs))

    # 3. Languages with possessive forms but NO case forms still get possessive columns.
    #    Regression: _obj_lang_cols dropped Hungarian's 3 possessives because every
    #    branch required non-empty `cases`.
    hu_variants = {variant for _label, _case, variant in ct._obj_lang_cols("hu")}
    check("hu object-name columns include possessive variants",
          {"First", "Second"} <= hu_variants, repr(sorted(hu_variants)))

    # 4. Element placement in the written XML.
    #    Regression: <gender> was emitted INSIDE <caseValues>, whose only valid children
    #    are article/caseType/plural/possessive/value.
    f = tmp / "contract.fieldTranslation-meta.xml"
    write_standard_field_file(f, "nickname_contact", "Alias", gender="Masculine",
                              starts_with="Vowel")
    xml = f.read_text(encoding="utf-8")
    case_block = xml.split("<caseValues>")[1].split("</caseValues>")[0]
    check("<gender> is NOT inside <caseValues>", "<gender>" not in case_block, case_block)
    check("<startsWith> is written", "<startsWith>Vowel</startsWith>" in xml)
    order = [xml.index(t) for t in ("</caseValues>", "<gender>", "<name>", "<startsWith>")]
    check("element order is caseValues, gender, name, startsWith",
          order == sorted(order), repr(order))

    # 5. startsWith survives the CSV -> XML round trip (it had no column at all before).
    rel = "objectTranslations/Contact-fr/nickname_contact.fieldTranslation-meta.xml"
    csv_path = tmp / "contract_fr.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerow({"file": rel, "type": "standard-field", "component": "Contact",
                    "field": "nickname_contact", "masterLabel": "", "source": "Nickname",
                    "translation": "Surnom", "gender": "Masculine",
                    "startsWith": "Consonant"})
    out = tmp / "contract_out"
    to_files(out, csv_path)
    check("startsWith round-trips CSV -> XML",
          "<startsWith>Consonant</startsWith>" in (out / rel).read_text(encoding="utf-8"))

    # 6. Article languages get <article>None</article> on field caseValues automatically.
    #    Regression: supplying gender alone was rejected with "Article is required for
    #    language DANISH/SWEDISH/ROMANIAN" on a dry run. On a
    #    field, None is the only accepted article, so it is written rather than asked for.
    for lang, gender in (("da", "Neuter"), ("sv", "Neuter"), ("ro", "Feminine")):
        rel_a = f"objectTranslations/Contact-{lang}/nickname_contact.fieldTranslation-meta.xml"
        csv_a = tmp / f"contract_{lang}.csv"
        with open(csv_a, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=COLUMNS)
            w.writeheader()
            w.writerow({"file": rel_a, "type": "standard-field", "component": "Contact",
                        "field": "nickname_contact", "masterLabel": "", "source": "Nickname",
                        "translation": "Alias", "gender": gender})
        out_a = tmp / f"contract_out_{lang}"
        to_files(out_a, csv_a)
        xml_a = (out_a / rel_a).read_text(encoding="utf-8")
        case_a = xml_a.split("<caseValues>")[1].split("</caseValues>")[0]
        check(f"{lang} field caseValues carry <article>None</article>",
              "<article>None</article>" in case_a, case_a)
        check(f"{lang} article precedes plural",
              case_a.index("<article>") < case_a.index("<plural>"), case_a)

    # 7. Task/Event custom fields are filed under Activity. Without that fallback,
    #    read_field returns None for them and value-set routing cannot be determined —
    #    on a real scope, thousands of rows can sit in that blind spot.
    from to_translation import read_field as _read_field
    act = tmp / "act" / "objects" / "Activity" / "fields"
    act.mkdir(parents=True, exist_ok=True)
    (act / "Probe__c.field-meta.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">'
        "<fullName>Probe__c</fullName><label>Probe</label><type>Picklist</type>"
        "<valueSet><valueSetName>Probe_Set</valueSetName></valueSet></CustomField>",
        encoding="utf-8")
    for owner in ("Task", "Event"):
        info = _read_field(tmp / "act", owner, "Probe__c")
        check(f"{owner} field resolves via Activity",
              info is not None and info.get("value_set_name") == "Probe_Set",
              repr(info))
    check("a genuinely absent field still returns None",
          _read_field(tmp / "act", "Task", "Not_There__c") is None)

    # 8. Global Translations children beyond custom labels. Regression: quick actions,
    #    tabs, apps and report types were never emitted at all, leaving user-visible
    #    labels untranslatable. Salesforce validated this exact structure on a dry run
    #    with zero errors on these four types.
    import re
    import xml.etree.ElementTree as ET
    from translation_roundtrip import write_translations_file as _wtf
    tf = tmp / "glob.translation-meta.xml"
    _wtf(tf, [
        {"type": "custom-app",   "field": "Widget_App", "masterLabel": "", "translation": "Widget-App"},
        {"type": "custom-label", "field": "Lbl_A",      "masterLabel": "", "translation": "Etikett"},
        {"type": "custom-tab",   "field": "Activities", "masterLabel": "", "translation": "Aktivitäten"},
        {"type": "quick-action", "field": "Account.New_X", "masterLabel": "", "translation": "Neu X"},
        {"type": "report-type",  "field": "RT_A", "masterLabel": "", "translation": "Bericht A"},
        {"type": "report-type-section", "field": "RT_A", "masterLabel": "Accounts",
         "translation": "Konten"},
        {"type": "quick-action", "field": "Skip_Me", "masterLabel": "", "translation": "  "},
    ])
    gx = tf.read_text(encoding="utf-8")
    ET.fromstring(gx)
    order = []
    for m in re.finditer(r"^    <(\w+)>", gx, re.M):
        if not order or order[-1] != m.group(1):
            order.append(m.group(1))
    check("Translations children are in schema (alphabetical) order",
          order == ["customApplications", "customLabels", "customTabs", "quickActions",
                    "reportTypes"], repr(order))
    check("report-type sections nest inside their parent",
          re.search(r"<reportTypes>.*?<name>RT_A</name>.*?<sections>.*?<name>Accounts</name>"
                    r".*?</sections>.*?</reportTypes>", gx, re.S) is not None)
    check("untranslated global rows are skipped", "Skip_Me" not in gx)
    check("all four new types emitted",
          all(t in gx for t in ("customApplications", "customTabs", "quickActions",
                                "reportTypes")))

    # A section whose parent has no translation still needs its <name> anchor written.
    tf2 = tmp / "glob2.translation-meta.xml"
    _wtf(tf2, [{"type": "report-type-section", "field": "RT_B", "masterLabel": "Cases",
                "translation": "Fälle"}])
    g2 = tf2.read_text(encoding="utf-8")
    ET.fromstring(g2)
    check("orphan section still anchors to its report type",
          "<name>RT_B</name>" in g2 and "<name>Cases</name>" in g2, g2)

    # Non-article languages must NOT gain one.
    rel_d = "objectTranslations/Contact-de/nickname_contact.fieldTranslation-meta.xml"
    csv_d = tmp / "contract_de.csv"
    with open(csv_d, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerow({"file": rel_d, "type": "standard-field", "component": "Contact",
                    "field": "nickname_contact", "masterLabel": "", "source": "Nickname",
                    "translation": "Spitzname", "gender": "Masculine"})
    out_d = tmp / "contract_out_de"
    to_files(out_d, csv_d)
    check("non-article language gets no <article>",
          "<article>" not in (out_d / rel_d).read_text(encoding="utf-8"))


# Tests that read the sample metadata tree under tests/fixtures/. If those files are
# absent the tests cannot run — but the rest of the suite still can, so they are skipped
# rather than aborting the whole run (previously the first one failed and tests 2-10
# never executed, leaving the tooling with no safety net at all).
NEEDS_FIXTURES = (
    test_expand_picklists,
    test_translation_roundtrip,
    test_new_types,
)

# Self-contained: these build whatever they need inside the temp dir.
FIXTURE_FREE = (
    test_prefill,
    test_gender,
    test_grammar_contract,
    test_validate,
    test_validate_fix,
)


def main() -> None:
    have_fixtures = FIELD_CSV.exists()
    tests = list(FIXTURE_FREE)
    if have_fixtures:
        tests = list(NEEDS_FIXTURES) + tests
    else:
        print(f"WARNING: metadata fixtures not found ({FIELD_CSV}).")
        print(f"  Skipping {len(NEEDS_FIXTURES)} fixture-dependent test(s): "
              f"{', '.join(t.__name__ for t in NEEDS_FIXTURES)}.")
        print(f"  Running the {len(FIXTURE_FREE)} self-contained test(s) below.\n")

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        try:
            for test in tests:
                test(tmp)
        except AssertionError as e:
            print(f"\n{e}", file=sys.stderr)
            sys.exit(1)

    if have_fixtures:
        print(f"\nAll {passed} checks passed.")
    else:
        # Exit 0 so the checks that CAN run stay useful in CI, but make the gap loud.
        print(f"\n{passed} checks passed, "
              f"{len(NEEDS_FIXTURES)} test(s) SKIPPED (missing tests/fixtures/).")

    # Second suite: project-neutral behaviour (any language, manifests, settings).
    print("\n=== tests/test_toolkit.py ===", flush=True)
    rc =subprocess.run([PY, str(HERE / "test_toolkit.py")]).returncode
    if rc != 0:
        sys.exit(rc)


if __name__ == "__main__":
    main()
