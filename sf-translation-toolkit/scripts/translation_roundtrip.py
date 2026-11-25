#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Translate Salesforce fields via a CSV round-trip.

End-to-end flow, two modes:

  to-csv   Given a list of fields (fields.csv format) and a target language, produce a
           CSV with every value that needs translating -- field labels, inline picklist
           values, global value set values, and standard value set values -- with a blank
           `translation` column for a translator/TMS to fill.

  validate Check a filled CSV against the metadata on disk and report rows the org will
           reject -- picklist values that moved to a global value set, values/record types
           that no longer exist, and mangled non-ASCII text. Orgs change while a
           spreadsheet is out for translation, so run this before to-files. --fix repairs
           what is mechanical; --drop-deleted removes rows whose target is gone.

  to-files Read that filled CSV and produce deployable SFDX source-format translation files
           (objectTranslations/, globalValueSetTranslations/, standardValueSetTranslations/,
           translations/). Blank `translation` cells are written as empty elements unless
           --skip-untranslated is passed, which drops those rows (and any file left empty).

Beyond fields, to-csv also covers, scoped to the referenced objects: record-type labels,
validation-rule error messages, and layout section headings (all inline in each object's
CustomObjectTranslation container). Custom labels are chosen via a separate --labels-list
(API names) and translated through the global Translations type (translations/<lang>...).

CSV columns: file, type, component, field, masterLabel, source, translation, gender. The
`file` column is the source-format path each row belongs to; `type` is one of field-label,
field-picklist, global-value, standard-value, standard-field (a RENAMED standard field,
keyed by its rename token), object-label, record-type, validation-rule, layout-section, or
custom-label. Edit the `translation` column, plus `gender` where it applies.

`gender` only applies to standard-field and object-label rows -- the ones that deploy as
<caseValues> -- and only in gendered languages (de, fr, es, ...), which Salesforce rejects
with "Gender is required for language X" if it is missing. Fill it with a Salesforce Gender
value (Masculine, Feminine, Neuter, ...); it is written as <gender> whenever non-empty and
ignored when blank, so ungendered languages can leave the whole column alone.

Renamed standard field/object labels are read from the org default-language (en_US)
CustomObjectTranslation (retrieved via manifest/package.xml); unchanged standard labels are
excluded by default since Salesforce auto-translates them (override with
--include-unchanged-standard-fields).

By default to-csv emits a blank `translation` column. Pass --retrieve-existing (with
--target-org) to first retrieve the existing <lang> translation metadata for the referenced
components (retrieve only -- never deploys) and pre-fill `translation` from any values that
already exist; rows with no existing translation stay blank.

Reads/writes local files only (never deploys). For to-csv, metadata is located via
-d/--projectdir. For to-files, output is written under --dir (default: current directory).

Multiple languages can be produced in one shot: pass a comma-separated LANG to to-csv
(outputs <stem>_<lang>.csv per language), and pass several CSVs to to-files.

Examples:
  python3 scripts/translation_roundtrip.py to-csv fields.csv de -o translations.csv
  python3 scripts/translation_roundtrip.py to-csv fields.csv de,fr,es -o translations.csv
  python3 scripts/translation_roundtrip.py to-csv fields.csv de --retrieve-existing --target-org myorg
  python3 scripts/translation_roundtrip.py to-csv fields.csv de --labels-list labels.txt -o translations.csv
  # ...fill in the translation column of each CSV...
  python3 scripts/translation_roundtrip.py to-files translations_de.csv translations_fr.csv --dir out
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path
from xml.sax.saxutils import escape

# Reuse the field resolver so to-csv routes values exactly like the file generator.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from expand_picklists import find_default_dir  # noqa: E402
from to_translation import (  # noqa: E402
    collect,
    read_field,
    read_fields_csv,
    read_value_set_labels,
)

NS = "http://soap.sforce.com/2006/04/metadata"
COLUMNS = ["file", "type", "component", "field", "masterLabel", "source", "translation",
           "plural_translation", "gender", "startsWith", "caseType", "article", "plural"]

# Languages whose object/field label translations need a <gender> alongside <caseValues>.
# Used only to prompt the translator: `gender` is always written when the cell is filled,
# whatever the language, so a language missing from this list still works.
GENDERED_LANGUAGES = {
    "ar", "bg", "ca", "cs", "da", "de", "el", "es", "fr", "ga", "he", "hi", "hr", "is",
    "it", "iw", "lt", "lv", "nb", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sl", "sq",
    "sr", "sv", "uk", "ur",
}
FIELD_SUFFIX = ".fieldTranslation-meta.xml"
GVS_SUFFIX = ".globalValueSetTranslation-meta.xml"
SVS_SUFFIX = ".standardValueSetTranslation-meta.xml"
CONTAINER_SUFFIX = ".objectTranslation-meta.xml"
# Custom labels translate via the global Translations type, not CustomObjectTranslation.
TRANSLATIONS_SUFFIX = ".translation-meta.xml"  # note: NOT objectTranslation (capital T)
_SF = ["cmd", "/c", "sf"] if sys.platform == "win32" else ["sf"]
NOT_SUPPORTED_PLURAL = "<Not Supported for this field, Do Not Populate>"


# --------------------------------------------------------------------------- to-csv


def read_renames(default_dir: Path, obj: str) -> tuple[list[dict], list[tuple[bool, str]]]:
    """Read RENAMED standard fields/object label from the org default-language (en_US)
    CustomObjectTranslation for `obj`.

    Standard field/object label overrides are NOT in CustomField metadata; they live here,
    keyed by an internal rename token (e.g. `size_account`) with the label in
    <caseValues>, not <label>. Unchanged standard labels are absent (Salesforce auto-
    translates them). Returns (field_renames, object_labels):
      - field_renames: [{token, source}] (the en_US singular label per renamed field)
      - object_labels: [(plural, source)] from the container's object-name caseValues
    """
    folder = default_dir / "objectTranslations" / f"{obj}-en_US"
    field_renames: list[dict] = []
    object_labels: list[tuple[bool, str]] = []
    if not folder.is_dir():
        return field_renames, object_labels

    for ff in sorted(folder.glob(f"*{FIELD_SUFFIX}")):
        root = ET.parse(ff).getroot()
        cases = root.findall("{*}caseValues")
        if not cases:  # a custom-field translation (uses <label>), not a standard rename
            continue
        token = root.findtext("{*}name") or ff.name[: -len(FIELD_SUFFIX)]
        source = ""
        for c in cases:  # prefer the singular (plural=false) value
            value = c.findtext("{*}value") or ""
            if (c.findtext("{*}plural") or "false") == "false":
                source = value
                break
            source = source or value
        field_renames.append({"token": token, "source": source})

    container = folder / f"{obj}-en_US.objectTranslation-meta.xml"
    if container.is_file():
        root = ET.parse(container).getroot()
        for c in root.findall("{*}caseValues"):
            plural = (c.findtext("{*}plural") or "false") == "true"
            object_labels.append((plural, c.findtext("{*}value") or ""))

    return field_renames, object_labels


def read_record_types(default_dir: Path, obj: str) -> list[tuple[str, str]]:
    """Return [(name, label)] for an object's record types (source text to translate)."""
    folder = default_dir / "objects" / obj / "recordTypes"
    out: list[tuple[str, str]] = []
    if not folder.is_dir():
        return out
    for f in sorted(folder.glob("*.recordType-meta.xml")):
        root = ET.parse(f).getroot()
        name = root.findtext("{*}fullName") or f.name[: -len(".recordType-meta.xml")]
        label = root.findtext("{*}label") or ""
        if label:
            out.append((name, label))
    return out


def read_validation_rules(default_dir: Path, obj: str) -> list[tuple[str, str]]:
    """Return [(name, errorMessage)] for an object's validation rules."""
    folder = default_dir / "objects" / obj / "validationRules"
    out: list[tuple[str, str]] = []
    if not folder.is_dir():
        return out
    for f in sorted(folder.glob("*.validationRule-meta.xml")):
        root = ET.parse(f).getroot()
        name = root.findtext("{*}fullName") or f.name[: -len(".validationRule-meta.xml")]
        msg = root.findtext("{*}errorMessage") or ""
        if msg:
            out.append((name, msg))
    return out


def read_layout_sections(default_dir: Path, obj: str) -> list[tuple[str, str]]:
    """Return [(layout, section_label)] for an object's layout section headings.

    Layout fullNames are `<Obj>-<Layout Name>`. Only sections with a non-empty <label>
    are translatable; system/standard sections without a label are skipped.
    """
    folder = default_dir / "layouts"
    out: list[tuple[str, str]] = []
    if not folder.is_dir():
        return out
    for f in sorted(folder.glob(f"{obj}-*.layout-meta.xml")):
        layout = f.name[: -len(".layout-meta.xml")].split("-", 1)[1]
        root = ET.parse(f).getroot()
        for sec in root.findall("{*}layoutSections"):
            label = sec.findtext("{*}label") or ""
            if label:
                out.append((layout, label))
    return out


def read_labels_list(path: Path) -> list[str]:
    """Read custom-label API names from a labels list (one per line, or a CSV's first/Name col).

    Blank lines and lines starting with '#' are ignored; a leading 'Name' header is skipped.
    """
    names: list[str] = []
    with open(path, newline="", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            name = line.split(",", 1)[0].strip()
            if name and name != "Name":
                names.append(name)
    return names


# Global Translations children beyond custom labels. Each is a folder of metadata files
# whose stem is the API name; the translatable text is the file's own <label>.
#
# Only files that HAVE a <label> are translatable. Roughly half do not: a custom-object tab
# takes its label from the object (already translated through CustomObjectTranslation, so
# emitting it here would duplicate it), and a standard quick action like NewLead takes its
# label from Salesforce. Emitting those would be blank rows reviewers cannot action.
_GLOBAL_TRANSLATABLES = [
    ("quick-action", "quickActions", ".quickAction-meta.xml"),
    ("custom-tab",   "tabs",         ".tab-meta.xml"),
    ("custom-app",   "applications", ".app-meta.xml"),
]


# Salesforce's own apps/tabs (standard__*) and managed-package items (<namespace>__*) are
# translated by their owner, not by you. Many standard__ apps carry a <label> and would
# otherwise be handed to reviewers as work.
_FOREIGN_PREFIX = re.compile(r"^[A-Za-z0-9]+__")


def _is_foreign(api_name: str) -> bool:
    return bool(_FOREIGN_PREFIX.match(api_name)
                or _FOREIGN_PREFIX.match(api_name.split(".")[-1]))


def read_global_translatables(default_dir: Path) -> list[tuple[str, str, str, str]]:
    """Return [(type, api_name, masterLabel, source)] for quick actions, tabs and apps."""
    out: list[tuple[str, str, str, str]] = []
    for type_, folder, suffix in _GLOBAL_TRANSLATABLES:
        d = default_dir / folder
        if not d.is_dir():
            continue
        for f in sorted(d.glob(f"*{suffix}")):
            name = f.name[: -len(suffix)]
            if _is_foreign(name):
                continue
            label = ET.parse(f).getroot().findtext("{*}label")
            if label and label.strip():
                out.append((type_, name, "", label.strip()))
    return out


def read_report_types(default_dir: Path) -> list[tuple[str, str, str, str]]:
    """Return [(type, api_name, masterLabel, source)] for report types and their sections.

    A report type carries its own label plus a label per section; the section rows are keyed
    by the section's masterLabel, which is what the translation file matches on.
    """
    out: list[tuple[str, str, str, str]] = []
    d = default_dir / "reportTypes"
    if not d.is_dir():
        return out
    for f in sorted(d.glob("*.reportType-meta.xml")):
        name = f.name[: -len(".reportType-meta.xml")]
        if _is_foreign(name):
            continue
        root = ET.parse(f).getroot()
        label = root.findtext("{*}label")
        if label and label.strip():
            out.append(("report-type", name, "", label.strip()))
        for sec in root.findall("{*}sections"):
            ml = sec.findtext("{*}masterLabel")
            if ml and ml.strip():
                out.append(("report-type-section", name, ml.strip(), ml.strip()))
    return out


def read_custom_labels(default_dir: Path, names: list[str]) -> list[tuple[str, str]]:
    """Return [(name, value)] for the requested custom labels, in the input order.

    Reads labels/CustomLabels.labels-meta.xml; unknown names are warned and skipped.
    """
    file = default_dir / "labels" / "CustomLabels.labels-meta.xml"
    out: list[tuple[str, str]] = []
    if not names:
        return out
    values: dict[str, str] = {}
    if file.is_file():
        root = ET.parse(file).getroot()
        for label in root.findall("{*}labels"):
            full = label.findtext("{*}fullName") or ""
            if full:
                values[full] = label.findtext("{*}value") or ""
    for name in names:
        if name in values:
            out.append((name, values[name]))
        else:
            sys.stderr.write(f"warning: custom label '{name}' not found in metadata (skipped)\n")
    return out


def build_rows(
    object_fields: dict[str, list[dict]],
    gvs_names: set[str],
    svs_names: set[str],
    lang: str,
    default_dir: Path,
    referenced_fields: set[str],
    standard_labels: dict,
    include_unchanged: bool,
    filter_to_input: bool = False,
    custom_labels: list[tuple[str, str]] | None = None,
) -> list[dict]:
    """Turn resolved translatable items into CSV rows with their target file paths."""
    rows: list[dict] = []

    for obj, fields in sorted(object_fields.items()):
        base = f"objectTranslations/{obj}-{lang}"
        for f in sorted(fields, key=lambda x: x["name"]):
            file = f"{base}/{f['name']}{FIELD_SUFFIX}"
            if f["label"]:
                rows.append({
                    "file": file, "type": "field-label", "component": obj,
                    "field": f["name"], "masterLabel": "", "source": f["label"],
                    "translation": "",
                })
            for value, label in f["inline"]:
                master = label or value or ""
                rows.append({
                    "file": file, "type": "field-picklist", "component": obj,
                    "field": f["name"], "masterLabel": master, "source": master,
                    "translation": "",
                })

    # Standard object/field labels: only RENAMED ones, sourced from the org default-language
    # (en_US) CustomObjectTranslation. Unchanged standard labels are auto-translated by
    # Salesforce, so they are excluded by default.
    referenced_objects = sorted({
        f.split(".", 1)[0] for f in referenced_fields
        if "." in f and "__" not in f.split(".", 1)[0]
    })
    # For --filter-standard-fields-to-input: reverse the describe label map (Object.Field ->
    # label) into label -> {Object.Field}, so a rename token's en_US label resolves to API
    # field name(s) and can be checked against the input field list.
    label_to_fields: dict[str, set[str]] = {}
    if filter_to_input:
        for object_field, label in standard_labels.get("fields", {}).items():
            label_to_fields.setdefault(label, set()).add(object_field)

    for obj in referenced_objects:
        field_renames, object_labels = read_renames(default_dir, obj)
        base = f"objectTranslations/{obj}-{lang}"
        container = f"{base}/{obj}-{lang}.objectTranslation-meta.xml"
        if object_labels:
            sing_src = next((s for p, s in object_labels if not p), "")
            plur_src = next((s for p, s in object_labels if p), "")
            rows.append({
                "file": container, "type": "object-label", "component": obj,
                "field": "", "masterLabel": "",
                "source": sing_src, "translation": "", "plural_translation": plur_src,
                "gender": "",
            })
        for r in field_renames:
            if filter_to_input:
                resolved = label_to_fields.get(r["source"])
                if resolved is None:
                    sys.stderr.write(
                        f"warning: could not map rename '{r['token']}' on {obj} to an "
                        "Object.Field (kept; verify manually)\n"
                    )
                elif not (resolved & referenced_fields):
                    continue  # resolved to a field not in the input list -> drop
            rows.append({
                "file": f"{base}/{r['token']}{FIELD_SUFFIX}", "type": "standard-field",
                "component": obj, "field": r["token"], "masterLabel": "",
                "source": r["source"], "translation": "",
                "plural_translation": NOT_SUPPORTED_PLURAL, "gender": "",
            })

    # Opt-in: also translate UNCHANGED standard field labels (describe-based). Usually
    # unnecessary (Salesforce auto-translates them) and not deploy-correct for standard
    # fields, so off by default.
    if include_unchanged:
        field_labels = standard_labels.get("fields", {})
        for object_field in sorted(f for f in referenced_fields if f in field_labels):
            obj, field = object_field.split(".", 1)
            rows.append({
                "file": f"objectTranslations/{obj}-{lang}/{field}{FIELD_SUFFIX}",
                "type": "field-label", "component": obj, "field": field,
                "masterLabel": "", "source": field_labels[object_field], "translation": "",
            })

    # Record types, validation-rule error messages, and layout section headings live inline
    # in each object's CustomObjectTranslation container, scoped to referenced objects.
    referenced_objects_all = sorted({
        f.split(".", 1)[0] for f in referenced_fields if "." in f
    })
    for obj in referenced_objects_all:
        container = f"objectTranslations/{obj}-{lang}/{obj}-{lang}{CONTAINER_SUFFIX}"
        for rt_name, label in read_record_types(default_dir, obj):
            rows.append({
                "file": container, "type": "record-type", "component": obj,
                "field": rt_name, "masterLabel": "", "source": label, "translation": "",
            })
        for vr_name, msg in read_validation_rules(default_dir, obj):
            rows.append({
                "file": container, "type": "validation-rule", "component": obj,
                "field": vr_name, "masterLabel": "", "source": msg, "translation": "",
            })
        for layout, section in read_layout_sections(default_dir, obj):
            rows.append({
                "file": container, "type": "layout-section", "component": obj,
                "field": layout, "masterLabel": section, "source": section, "translation": "",
            })

    # Custom labels: global Translations type, chosen via a separate --labels-list input.
    translations_file = f"translations/{lang}{TRANSLATIONS_SUFFIX}"
    if custom_labels:
        for name, value in custom_labels:
            rows.append({
                "file": translations_file, "type": "custom-label", "component": "(global)",
                "field": name, "masterLabel": "", "source": value, "translation": "",
            })

    # Quick actions, tabs, apps and report types also live in the global Translations file.
    # Unlike custom labels these are not opt-in: they are org-wide user-visible labels, and
    # leaving them out means they are never translated.
    for type_, name, master, source in (read_global_translatables(default_dir)
                                        + read_report_types(default_dir)):
        rows.append({
            "file": translations_file, "type": type_, "component": "(global)",
            "field": name, "masterLabel": master, "source": source, "translation": "",
        })

    for name in sorted(gvs_names):
        labels = read_value_set_labels(
            default_dir / "globalValueSets" / f"{name}.globalValueSet-meta.xml", "customValue"
        )
        file = f"globalValueSetTranslations/{name}-{lang}{GVS_SUFFIX}"
        for label in labels:
            rows.append({
                "file": file, "type": "global-value", "component": name, "field": "",
                "masterLabel": label, "source": label, "translation": "",
            })

    for name in sorted(svs_names):
        labels = read_value_set_labels(
            default_dir / "standardValueSets" / f"{name}.standardValueSet-meta.xml", "standardValue"
        )
        file = f"standardValueSetTranslations/{name}-{lang}{SVS_SUFFIX}"
        for label in labels:
            rows.append({
                "file": file, "type": "standard-value", "component": name, "field": "",
                "masterLabel": label, "source": label, "translation": "",
            })

    return rows


def retrieve_existing(
    objects: set[str],
    gvs_names: set[str],
    svs_names: set[str],
    lang: str,
    target_org: str,
    default_dir: Path,
    include_translations: bool = False,
) -> bool:
    """Retrieve the existing <lang> translation metadata for the referenced components.

    Retrieve only (never deploys). Builds a precise component list from what collect()
    resolved and shells out to `sf project retrieve start`, writing the files into the
    project source tree so the pre-fill step can read them. Missing members (e.g. a
    language not yet translated for an object) are not errors; sf simply skips them.

    Record types, validation rules, and layout sections ride along inside
    CustomObjectTranslation. Custom labels are separate: when include_translations is set
    (custom labels requested), the global Translations:<lang> is also retrieved.
    """
    components = (
        [f"CustomObjectTranslation:{obj}-{lang}" for obj in sorted(objects)]
        + [f"GlobalValueSetTranslation:{name}-{lang}" for name in sorted(gvs_names)]
        + [f"StandardValueSetTranslation:{name}-{lang}" for name in sorted(svs_names)]
    )
    if include_translations:
        components.append(f"Translations:{lang}")
    if not components:
        return True

    cmd = _SF + ["project", "retrieve", "start", "-o", target_org]
    for c in components:
        cmd += ["-m", c]
    # Project root holds sfdx-project.json; default_dir is <root>/force-app/main/default.
    cwd = default_dir.parents[2] if len(default_dir.parents) >= 3 else None
    print(f"Retrieving {len(components)} existing '{lang}' translation component(s) "
          f"from {target_org}...", file=sys.stderr)
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        # Returning False matters: pre-fill reads the local tree, which may hold another
        # org's translations. Filling after a failed retrieve presents them as this org's.
        sys.stderr.write(
            f"ERROR: retrieve for '{lang}' from {target_org} FAILED — pre-fill SKIPPED so "
            f"no other org's values are presented as {target_org}'s:\n"
            f"{result.stderr.strip() or result.stdout.strip()}\n"
        )
        return False
    return True


def read_existing_file(path: Path) -> dict[tuple[str, str, str], str]:
    """Map (type, field, masterLabel) -> existing translation for one translation file.

    Keys mirror how build_rows identifies each row, so a row's existing value is a direct
    dict lookup. Empty translations are omitted so they don't overwrite anything.
    """
    out: dict[tuple[str, str, str], str] = {}
    if not path.is_file():
        return out
    root = ET.parse(path).getroot()
    name = path.name

    if name.endswith(FIELD_SUFFIX):
        field = name[: -len(FIELD_SUFFIX)]
        cases = root.findall("{*}caseValues")
        if cases:  # renamed standard field (caseValues + token, no <label>)
            value = ""
            for c in cases:  # prefer the singular (plural=false) value
                v = c.findtext("{*}value") or ""
                if (c.findtext("{*}plural") or "false") == "false":
                    value = v
                    break
                value = value or v
            if value:
                out[("standard-field", field, "")] = value
            gender = root.findtext("{*}gender")
            if gender:
                out[("gender:standard-field", field, "")] = gender
        else:
            label = root.findtext("{*}label")
            if label:
                out[("field-label", field, "")] = label
            for pv in root.findall("{*}picklistValues"):
                ml = pv.findtext("{*}masterLabel") or ""
                tr = pv.findtext("{*}translation") or ""
                if tr:
                    out[("field-picklist", field, ml)] = tr
    elif name.endswith(CONTAINER_SUFFIX):
        gender = root.findtext("{*}gender")
        if gender:
            out[("gender:object-label", "", "")] = gender
        for c in root.findall("{*}caseValues"):
            plural = (c.findtext("{*}plural") or "false") == "true"
            v = c.findtext("{*}value") or ""
            if v:
                out[("object-label", "plural" if plural else "singular", "")] = v
        for rt in root.findall("{*}recordTypes"):
            n, lbl = rt.findtext("{*}name") or "", rt.findtext("{*}label") or ""
            if n and lbl:
                out[("record-type", n, "")] = lbl
        for vr in root.findall("{*}validationRules"):
            n, msg = vr.findtext("{*}name") or "", vr.findtext("{*}errorMessage") or ""
            if n and msg:
                out[("validation-rule", n, "")] = msg
        for lay in root.findall("{*}layouts"):
            layout = lay.findtext("{*}layout") or ""
            for sec in lay.findall("{*}sections"):
                section = sec.findtext("{*}section") or ""
                lbl = sec.findtext("{*}label") or ""
                if layout and section and lbl:
                    out[("layout-section", layout, section)] = lbl
    elif name.endswith(GVS_SUFFIX) or name.endswith(SVS_SUFFIX):
        type_ = "global-value" if name.endswith(GVS_SUFFIX) else "standard-value"
        for vt in root.findall("{*}valueTranslation"):
            ml = vt.findtext("{*}masterLabel") or ""
            tr = vt.findtext("{*}translation") or ""
            if tr:
                out[(type_, "", ml)] = tr
    elif name.endswith(TRANSLATIONS_SUFFIX):  # global Translations (custom labels)
        for cl in root.findall("{*}customLabels"):
            n, lbl = cl.findtext("{*}name") or "", cl.findtext("{*}label") or ""
            if n and lbl:
                out[("custom-label", n, "")] = lbl
    return out


def prefill_rows(rows: list[dict], default_dir: Path) -> int:
    """Fill each row's `translation` from existing <lang> files under default_dir.

    Row `file` paths are source-format relative paths (e.g. objectTranslations/Account-de/
    Name.fieldTranslation-meta.xml), which is exactly where retrieve writes, so the existing
    file for a row is default_dir/<file>. Returns how many rows were filled.
    """
    cache: dict[Path, dict[tuple[str, str, str], str]] = {}
    filled = 0
    for r in rows:
        path = default_dir / r["file"]
        existing = cache.get(path)
        if existing is None:
            existing = cache[path] = read_existing_file(path)
        value = existing.get((r["type"], r["field"], r["masterLabel"]))
        if value:
            r["translation"] = value
            filled += 1
        if r["type"] in ("standard-field", "object-label"):
            # <gender> is per-field for a rename, per-object for the container.
            key = r["field"] if r["type"] == "standard-field" else ""
            gender = existing.get((f"gender:{r['type']}", key, ""))
            if gender:
                r["gender"] = gender
        if r["type"] == "object-label":
            plur = existing.get(("object-label", "plural", ""))
            if plur:
                r["plural_translation"] = plur
    return filled


def output_for_lang(output: Path, lang: str, multiple: bool) -> Path:
    """One output path per language: as-is for a single language, '<stem>_<lang>' for many."""
    if not multiple:
        return output
    return output.with_name(f"{output.stem}_{lang}{output.suffix or '.csv'}")


def to_csv(
    input_path: Path,
    languages: list[str],
    projectdir: Path | None,
    output: Path,
    labels_path: Path,
    include_unchanged: bool,
    filter_to_input: bool,
    retrieve: bool,
    target_org: str | None,
    labels_list_path: Path | None,
) -> None:
    default_dir = find_default_dir(projectdir)
    fields = read_fields_csv(input_path)
    # Language-independent resolution is done once and reused for every language.
    object_fields, gvs_names, svs_names = collect(fields, default_dir)
    # Every referenced object (custom + standard) can carry a CustomObjectTranslation.
    referenced_objects_all = {f.split(".", 1)[0] for f in fields if "." in f}

    # Custom labels come from a separate list (not tied to the field CSV); resolve once.
    # If no explicit list is given, auto-discover all labels from CustomLabels.labels-meta.xml.
    custom_labels: list[tuple[str, str]] = []
    if labels_list_path is not None:
        custom_labels = read_custom_labels(default_dir, read_labels_list(labels_list_path))
    else:
        _labels_file = default_dir / "labels" / "CustomLabels.labels-meta.xml"
        if _labels_file.is_file():
            import xml.etree.ElementTree as _ET
            _NS_L = "http://soap.sforce.com/2006/04/metadata"
            _root = _ET.parse(_labels_file).getroot()
            _all_names = [
                el.findtext(f"{{{_NS_L}}}fullName")
                for el in _root.findall(f"{{{_NS_L}}}labels")
                if el.findtext(f"{{{_NS_L}}}fullName")
            ]
            if _all_names:
                custom_labels = read_custom_labels(default_dir, _all_names)

    # Describe-based labels feed the unchanged-standard-fields path and the input filter.
    standard_labels: dict = {}
    if include_unchanged or filter_to_input:
        if labels_path.is_file():
            with open(labels_path, encoding="utf-8") as fh:
                standard_labels = json.load(fh)
        else:
            sys.stderr.write(
                f"note: {labels_path} not found; --include-unchanged-standard-fields / "
                "--filter-standard-fields-to-input need it (run gen_standard_labels.py)\n"
            )

    multiple = len(languages) > 1
    if retrieve:
        sys.stderr.write(
            f"note: pre-fill reads {default_dir}. If that tree holds ANOTHER org's "
            f"translations they will be pre-filled as {target_org}'s. Use one project "
            f"folder per org, downloaded fresh with the make_manifest.py manifests.\n"
        )
    for lang in languages:
        retrieved = True
        if retrieve:
            retrieved = retrieve_existing(
                referenced_objects_all, gvs_names, svs_names, lang,
                target_org, default_dir, include_translations=bool(custom_labels))
        rows = build_rows(object_fields, gvs_names, svs_names, lang, default_dir,
                          fields, standard_labels, include_unchanged, filter_to_input,
                          custom_labels)
        filled = prefill_rows(rows, default_dir) if retrieve and retrieved else 0
        out = output_for_lang(output, lang, multiple)
        with open(out, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=COLUMNS)
            writer.writeheader()
            writer.writerows(rows)

        counts = Counter(r["type"] for r in rows)
        print(
            f"Wrote {len(rows)} translatable slot(s) for '{lang}' to {out} — "
            f"{counts['field-label']} custom field label, {counts['field-picklist']} inline "
            f"picklist, {counts['global-value']} global value, {counts['standard-value']} "
            f"standard value, {counts['standard-field']} renamed standard field, "
            f"{counts['object-label']} object label, {counts['record-type']} record type, "
            f"{counts['validation-rule']} validation rule, {counts['layout-section']} layout "
            f"section, {counts['custom-label']} custom label, {counts['quick-action']} quick "
            f"action, {counts['custom-tab']} tab, {counts['custom-app']} app, "
            f"{counts['report-type']} report type, {counts['report-type-section']} report "
            f"type section."
            + (f" Pre-filled {filled} from existing translations." if retrieve else ""),
            file=sys.stderr,
        )
        needs_gender = counts["standard-field"] + counts["object-label"]
        if needs_gender and lang.split("_")[0] in GENDERED_LANGUAGES:
            blank = sum(1 for r in rows if r["type"] in ("standard-field", "object-label")
                        and not (r["gender"] or "").strip())
            if blank:
                sys.stderr.write(
                    f"NOTICE: '{lang}' is a gendered language: fill the `gender` column "
                    f"(Masculine/Feminine/Neuter) on the {blank} renamed standard field / "
                    "object label row(s) still blank. Salesforce rejects those translations "
                    "with \"Gender is required\" otherwise.\n"
                )
        if counts["standard-field"] and not filter_to_input:
            sys.stderr.write(
                f"NOTICE: the output includes ALL {counts['standard-field']} renamed standard "
                "field(s) on the referenced standard objects, so it may contain more renamed "
                "standard fields than your input field list. Pass "
                "--filter-standard-fields-to-input (with gen_standard_labels.py's "
                "standard_labels.json) to keep only those matching your input.\n"
            )


# --------------------------------------------------------------------------- validate


def describe_object(obj: str, target_org: str) -> dict | None:
    """What the org says an object has right now: fields, picklist values, record types.

    Local metadata can't answer this: a retrieve never deletes, so a field or record type
    dropped from the org lingers on disk and looks alive. Returns None if the describe fails
    (an object that no longer exists at all, or no access).

    Only names are taken from the describe. Picklist *values* are still read from local
    metadata, because a describe omits deactivated values and those are translatable --
    checking against the describe would report them as missing when they deploy fine.
    """
    result = subprocess.run(_SF + ["sobject", "describe", "-s", obj, "-o", target_org, "--json"],
                            capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        return None
    try:
        described = json.loads(result.stdout)["result"]
    except (ValueError, KeyError):
        return None
    return {
        "fields": {f["name"] for f in described.get("fields", [])},
        "recordTypes": {rt["developerName"] for rt in described.get("recordTypeInfos", [])},
    }


def org_snapshot(objects: list[str], target_org: str) -> dict[str, dict | None]:
    """Describe every referenced object once, so validate can check against the live org."""
    print(f"Describing {len(objects)} object(s) in {target_org}...", file=sys.stderr)
    snapshot: dict[str, dict | None] = {}
    for obj in objects:
        snapshot[obj] = describe_object(obj, target_org)
        if snapshot[obj] is None:
            print(f"  warning: could not describe {obj}", file=sys.stderr)
    return snapshot


def looks_mojibake(text: str) -> str | None:
    """Return the repaired text if `text` is UTF-8 that was decoded as CP1252.

    'Size \u00e2\u20ac\u201c Large' -> 'Size \u2013 Large'. Master labels come from
    English metadata, so this is the usual cause of a stray non-ASCII run in them.
    """
    if text.isascii():
        return None
    try:
        fixed = text.encode("cp1252").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return None
    return fixed if fixed != text else None


def lang_of(rel: str) -> str:
    """Language code encoded in a row's file path ('' if it can't be read)."""
    parts = rel.split("/")
    if parts[0] == "objectTranslations" and len(parts) == 3:
        return parts[1].rsplit("-", 1)[-1]
    if parts[0] == "translations":
        return parts[-1].split(".")[0]
    if len(parts) == 2:
        return parts[1].split(".")[0].rsplit("-", 1)[-1]
    return ""


# Problems that mean "the thing this row translates is not there any more". These are the
# rows --drop-deleted removes; everything else needs a person to decide.
GONE_CATEGORIES = {
    "deleted in the org",
    "field not in metadata",
    "value no longer exists",
    "record type not in metadata",
    "validation rule not in metadata",
    "layout not in metadata",
    "custom label not in metadata",
}


def scan_rows(rows: list[dict], default_dir: Path,
              org: dict[str, dict | None] | None = None) -> list[tuple[int, str, str]]:
    """Check rows against the metadata on disk. Returns [(category, detail)].

    `org` is an optional describe snapshot (see org_snapshot). Where it has an answer it
    wins, because it is the only way to see something that was deleted from the org.

    Returns [(row index, category, detail)] so callers can act on the offending rows.
    """
    problems: list[tuple[int, str, str]] = []
    field_cache: dict[tuple[str, str], dict | None] = {}
    vs_cache: dict[Path, list[str]] = {}

    def field_info(obj: str, field: str) -> dict | None:
        key = (obj, field)
        if key not in field_cache:
            field_cache[key] = read_field(default_dir, obj, field)
        return field_cache[key]

    def value_set(path: Path, tag: str) -> list[str]:
        """Master labels of a value set, including deactivated values (still translatable)."""
        if path not in vs_cache:
            vs_cache[path] = read_value_set_labels(path, tag)
        return vs_cache[path]

    def exists(*parts: str) -> bool:
        return (default_dir.joinpath(*parts)).is_file()

    labels_file = default_dir / "labels" / "CustomLabels.labels-meta.xml"
    custom_labels = set()
    if labels_file.is_file():
        custom_labels = {e.text for e in ET.parse(labels_file).getroot().iter("{*}fullName")}
    layouts_dir = default_dir / "layouts"
    have_layouts = layouts_dir.is_dir() and any(layouts_dir.iterdir())

    for index, r in enumerate(rows):
        type_, obj, field = r["type"], r["component"], r["field"]
        master, source = r["masterLabel"], r["source"]
        where = f"{obj}.{field}" if field else obj

        for column, text in (("masterLabel", master), ("source", source)):
            fixed = looks_mojibake(text)
            if fixed:
                problems.append((index, "encoding damage",
                                 f"{where}: {column} {text!r} looks like mangled UTF-8 "
                                 f"-- should be {fixed!r}"))

        if type_ in ("field-label", "field-picklist"):
            described = (org or {}).get(obj)
            if described is not None and field not in described["fields"]:
                problems.append((index, "deleted in the org",
                                 f"{where}: the org has no such field (it is still in your "
                                 "local metadata because a retrieve never deletes)"))
                continue
            info = field_info(obj, field)
            if info is None:
                problems.append((index, "field not in metadata",
                                 f"{where}: no field metadata (deleted in the org, or the "
                                 "object was never retrieved)"))
                continue
            if type_ != "field-picklist":
                continue
            gvs = info["value_set_name"]
            if gvs:
                lang = lang_of(r["file"])
                problems.append((index, "picklist moved to a global value set",
                                 f"{where}: now uses global value set {gvs} -- this value "
                                 f"belongs in globalValueSetTranslations/{gvs}-{lang}"
                                 f"{GVS_SUFFIX}, not in the field's translation"))
            elif info["inline"]:
                if master not in [label for _, label in info["inline"]]:
                    problems.append((index, "value no longer exists",
                                     f"{where}: {master!r} is not a value of this picklist"))

        elif type_ in ("global-value", "standard-value"):
            name = Path(r["file"]).name
            if type_ == "global-value":
                stem = name[: -len(GVS_SUFFIX)].rsplit("-", 1)[0]
                path = default_dir / "globalValueSets" / f"{stem}.globalValueSet-meta.xml"
                tag = "customValue"
            else:
                stem = name[: -len(SVS_SUFFIX)].rsplit("-", 1)[0]
                path = default_dir / "standardValueSets" / f"{stem}.standardValueSet-meta.xml"
                tag = "standardValue"
            values = value_set(path, tag)
            if not values:
                problems.append((index, "value set not retrieved",
                                 f"{stem}: no metadata at {path.relative_to(default_dir)}"))
            elif master not in values:
                problems.append((index, "value no longer exists",
                                 f"{stem}: {master!r} is not a value of this set"))

        elif type_ == "record-type":
            described = (org or {}).get(obj)
            if described is not None:
                if field not in described["recordTypes"]:
                    problems.append((index, "deleted in the org",
                                     f"{obj}.{field}: the org has no such record type (it is "
                                     "still in your local metadata because a retrieve never "
                                     "deletes)"))
                continue
            if not exists("objects", obj, "recordTypes", f"{field}.recordType-meta.xml"):
                problems.append((index, "record type not in metadata",
                                 f"{obj}.{field}: no record type by that name"))

        elif type_ == "validation-rule":
            if not exists("objects", obj, "validationRules",
                          f"{field}.validationRule-meta.xml"):
                problems.append((index, "validation rule not in metadata",
                                 f"{obj}.{field}: no validation rule by that name"))

        elif type_ == "layout-section" and have_layouts:
            # Layout files are named <Object>-<Layout>.layout-meta.xml.
            if not exists("layouts", f"{obj}-{field}.layout-meta.xml"):
                problems.append((index, "layout not in metadata",
                                 f"{obj}.{field}: no layout by that name "
                                 "(re-run gen_layout_list.py and retrieve)"))

        elif type_ == "custom-label" and custom_labels:
            if field not in custom_labels:
                problems.append((index, "custom label not in metadata", f"{field}: no label by that name"))

    return problems


def validate_rows(rows: list[dict], default_dir: Path,
                  org: dict[str, dict | None] | None = None) -> list[tuple[str, str]]:
    """scan_rows without the row indexes."""
    return [(category, detail) for _, category, detail in scan_rows(rows, default_dir, org)]


def drop_gone(rows: list[dict], problems: list[tuple[int, str, str]]) -> tuple[list[dict], int]:
    """Remove rows whose target no longer exists. Returns (kept rows, dropped count)."""
    gone = {index for index, category, _ in problems if category in GONE_CATEGORIES}
    if not gone:
        return rows, 0
    return [r for i, r in enumerate(rows) if i not in gone], len(gone)


def fix_rows(rows: list[dict], default_dir: Path) -> tuple[list[dict], list[str]]:
    """Apply the repairs that are safe to make mechanically.

    Two classes only: text mangled by a CP1252/UTF-8 round trip, and picklist values whose
    field has moved to a global value set (re-pointed at the value set's translation file).
    Anything needing a judgement call -- a value that no longer exists, a deleted field --
    is left alone for a human. Returns (rows, notes); rows may be shorter after de-duping.
    """
    notes: list[str] = []
    repaired = 0
    for r in rows:
        for column in ("masterLabel", "source", "translation"):
            fixed = looks_mojibake(r.get(column) or "")
            if fixed:
                r[column] = fixed
                repaired += 1
    if repaired:
        notes.append(f"repaired {repaired} mangled text value(s)")

    field_cache: dict[tuple[str, str], dict | None] = {}
    gvs_cache: dict[str, list[str]] = {}
    moved = skipped = 0
    for r in rows:
        if r["type"] != "field-picklist":
            continue
        key = (r["component"], r["field"])
        if key not in field_cache:
            field_cache[key] = read_field(default_dir, *key)
        info = field_cache[key]
        gvs = info and info["value_set_name"]
        if not gvs:
            continue
        if gvs not in gvs_cache:
            gvs_cache[gvs] = read_value_set_labels(
                default_dir / "globalValueSets" / f"{gvs}.globalValueSet-meta.xml", "customValue")
        if r["masterLabel"] not in gvs_cache[gvs]:
            # Moved *and* renamed: re-pointing it would just fail somewhere else.
            skipped += 1
            continue
        lang = lang_of(r["file"])
        r["file"] = f"globalValueSetTranslations/{gvs}-{lang}{GVS_SUFFIX}"
        r["type"] = "global-value"
        r["component"] = gvs
        r["field"] = ""
        moved += 1
    if moved:
        notes.append(f"re-pointed {moved} value(s) at their global value set")
    if skipped:
        notes.append(f"left {skipped} moved value(s) alone (not in the value set either)")

    # Re-pointing can collide with rows that already translate the same value.
    seen: dict[tuple[str, str, str], dict] = {}
    out: list[dict] = []
    conflicts = dropped = 0
    for r in rows:
        key = (r["file"], r["field"], r["masterLabel"])
        first = seen.get(key)
        if first is None:
            seen[key] = r
            out.append(r)
            continue
        dropped += 1
        mine, theirs = (r.get("translation") or "").strip(), (first.get("translation") or "").strip()
        if mine and not theirs:
            first["translation"] = mine
        elif mine and theirs and mine != theirs:
            conflicts += 1
            notes.append(f"kept {theirs!r} over {mine!r} for {r['component']} "
                         f"{r['masterLabel']!r} -- check this one")
    if dropped:
        notes.append(f"merged {dropped} duplicate row(s)"
                     + (f", {conflicts} with differing translations" if conflicts else ""))
    return out, notes


def validate(csv_paths: list[Path], projectdir: Path | None, fix: bool = False,
             target_org: str | None = None, drop_deleted: bool = False) -> int:
    """Report rows that current metadata says will not deploy. Returns an exit code."""
    default_dir = find_default_dir(projectdir)
    worst = 0
    org: dict[str, dict | None] | None = None
    for csv_path in csv_paths:
        if not csv_path.is_file():
            sys.exit(f"error: CSV not found: {csv_path}")
        with open(csv_path, newline="", encoding="utf-8") as fh:
            reader = csv.DictReader(fh)
            columns = reader.fieldnames or COLUMNS
            rows = list(reader)
        notes: list[str] = []
        if fix:
            rows, notes = fix_rows(rows, default_dir)
        if target_org and org is None:
            objects = sorted({r["component"] for r in rows
                              if r["type"] in ("field-label", "field-picklist", "record-type",
                                               "validation-rule", "object-label",
                                               "standard-field") and r["component"]})
            org = org_snapshot(objects, target_org)
        problems = scan_rows(rows, default_dir, org)

        if drop_deleted:
            rows, dropped = drop_gone(rows, problems)
            if dropped:
                notes.append(f"dropped {dropped} row(s) whose target no longer exists")
                problems = scan_rows(rows, default_dir, org)
        if notes:
            with open(csv_path, "w", newline="", encoding="utf-8") as fh:
                writer = csv.DictWriter(fh, fieldnames=columns, extrasaction="ignore")
                writer.writeheader()
                writer.writerows(rows)
            print(f"{csv_path}: rewritten in place")
            for note in notes:
                print(f"  - {note}")
        if not problems:
            print(f"{csv_path}: {len(rows)} row(s), no problems found.")
            continue
        if fix or drop_deleted:
            print(f"{csv_path}: {len(problems)} problem(s) left needing a human decision")
        else:
            print(f"{csv_path}: {len(problems)} problem(s) in {len(rows)} row(s)")
        worst = 1
        by_category: dict[str, list[str]] = defaultdict(list)
        for _, category, detail in problems:
            by_category[category].append(detail)
        for category in sorted(by_category, key=lambda c: -len(by_category[c])):
            details = by_category[category]
            # Details repeat across languages/values; show a few and count the rest.
            unique = list(dict.fromkeys(details))
            print(f"  {category} ({len(details)}):")
            for d in unique[:5]:
                print(f"    - {d}")
            if len(unique) > 5:
                print(f"    ... and {len(unique) - 5} more")
    return worst


# --------------------------------------------------------------------------- to-files


def write_field_file(path: Path, field: str, label: str, picks: list[tuple[str, str]],
                     omit_empty_label: bool = False) -> None:
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', f'<CustomFieldTranslation xmlns="{NS}">']
    # <label> is optional; omitting it (rather than sending an empty one) leaves any label
    # translation already in the org untouched. See --skip-untranslated.
    if label or not omit_empty_label:
        lines.append(f"    <label>{escape(label)}</label>")
    lines.append(f"    <name>{escape(field)}</name>")
    for ml, tr in picks:
        lines.append("    <picklistValues>")
        lines.append(f"        <masterLabel>{escape(ml)}</masterLabel>")
        lines.append(f"        <translation>{escape(tr)}</translation>")
        lines.append("    </picklistValues>")
    lines.append("</CustomFieldTranslation>")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# Languages whose caseValues require a <possessive> (FIELD_POSSESSIVE_LANGS in
# sf_languages.py, e.g. Finnish). Salesforce rejects their renamed-standard-field /
# object-name caseValues without it ("Possessive is required for language FINNISH").
# The base form is possessive=None.
from sf_languages import FIELD_ARTICLE_LANGS, FIELD_POSSESSIVE_LANGS  # noqa: E402
POSSESSIVE_LANGS = FIELD_POSSESSIVE_LANGS

# Languages whose caseValues require an <article> (FIELD_ARTICLE_LANGS in sf_languages.py:
# Danish, Swedish, Romanian). Norwegian also has article forms, but its field rules have
# not been proven, so it is not listed. Confirmed by dry run:
# supplying gender alone returns "Article is required for language DANISH/SWEDISH/ROMANIAN".
# On a FIELD caseValue the base form None is the ONLY accepted value — Definite/Indefinite
# are rejected ("You have specified invalid attributes for field ... in language DANISH") —
# so it is written automatically rather than being a translator choice. Object-name
# caseValues (Tab 3) DO take the full variant set and supply their own article per row.
ARTICLE_LANGS = FIELD_ARTICLE_LANGS


def write_standard_field_file(path: Path, token: str, translation: str,
                              gender: str = "", possessive: str = "",
                              starts_with: str = "", article: str = "") -> None:
    """Write a renamed-standard-field translation (caseValues + rename token, no <label>).

    Gendered languages (German, French, Spanish, ...) reject caseValues without a <gender>;
    it comes from the CSV's `gender` column. Possessive languages (e.g. Finnish, Hungarian)
    require a <possessive> instead. Article languages (Danish, Swedish, Romanian) require an
    <article>. French/Italian/Hungarian/English additionally require <startsWith>
    ("StartsWith is required for language FRENCH").

    Element order follows the schema, verified against retrieved org metadata (a renamed
    standard field in an <Object>-fr folder): caseValues, gender, name, startsWith.
    """
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', f'<CustomFieldTranslation xmlns="{NS}">']
    lines.append("    <caseValues>")
    if article:
        lines.append(f"        <article>{escape(article)}</article>")
    lines.append("        <plural>false</plural>")
    if possessive:
        lines.append(f"        <possessive>{escape(possessive)}</possessive>")
    lines.append(f"        <value>{escape(translation)}</value>")
    lines.append("    </caseValues>")
    if gender:
        lines.append(f"    <gender>{escape(gender)}</gender>")
    lines.append(f"    <name>{escape(token)}</name>")
    if starts_with:
        lines.append(f"    <startsWith>{escape(starts_with)}</startsWith>")
    lines.append("</CustomFieldTranslation>")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_value_set_file(path: Path, root_tag: str, entries: list[tuple[str, str]]) -> None:
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', f'<{root_tag} xmlns="{NS}">']
    for ml, tr in entries:
        lines.append("    <valueTranslation>")
        lines.append(f"        <masterLabel>{escape(ml)}</masterLabel>")
        lines.append(f"        <translation>{escape(tr)}</translation>")
        lines.append("    </valueTranslation>")
    lines.append(f"</{root_tag}>")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_container(
    path: Path,
    cases: list[tuple[bool, str]] | None = None,
    layouts: list[tuple[str, str, str]] | None = None,
    record_types: list[tuple[str, str]] | None = None,
    validation_rules: list[tuple[str, str]] | None = None,
    gender: str = "",
    case_values_ext: list[dict] | None = None,
    possessive: str = "",
    starts_with: str = "",
) -> None:
    """Write the object-translation container with all inline (non-field) translations.

    Elements are emitted in CustomObjectTranslation child order: caseValues, layouts,
    recordTypes, validationRules (fields stay in their own .fieldTranslation files).
      - layouts: list of (layout, section_master, section_translation)
      - record_types / validation_rules: list of (name, translation)
      - gender: required by gendered languages whenever caseValues are present
      - possessive: required by possessive languages such as Finnish (base form = None)
        whenever caseValues present
    """
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', f'<CustomObjectTranslation xmlns="{NS}">']
    if case_values_ext is not None:
        for cv in case_values_ext:
            lines.append("    <caseValues>")
            if cv.get("article"):
                lines.append(f"        <article>{escape(cv['article'])}</article>")
            if cv.get("caseType"):
                lines.append(f"        <caseType>{escape(cv['caseType'])}</caseType>")
            if cv.get("gender"):
                lines.append(f"        <gender>{escape(cv['gender'])}</gender>")
            lines.append(f"        <plural>{'true' if cv['plural'] else 'false'}</plural>")
            if possessive:
                lines.append(f"        <possessive>{escape(possessive)}</possessive>")
            lines.append(f"        <value>{escape(cv['value'])}</value>")
            lines.append("    </caseValues>")
    else:
        for plural, value in cases or []:
            lines.append("    <caseValues>")
            lines.append(f"        <plural>{'true' if plural else 'false'}</plural>")
            if possessive:
                lines.append(f"        <possessive>{escape(possessive)}</possessive>")
            lines.append(f"        <value>{escape(value)}</value>")
            lines.append("    </caseValues>")
    if gender:
        lines.append(f"    <gender>{escape(gender)}</gender>")
    # Group sections by layout so each layout is emitted once.
    by_layout: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for layout, section, tr in layouts or []:
        by_layout[layout].append((section, tr))
    for layout in sorted(by_layout):
        lines.append("    <layouts>")
        lines.append(f"        <layout>{escape(layout)}</layout>")
        for section, tr in by_layout[layout]:
            lines.append("        <sections>")
            lines.append(f"            <label>{escape(tr)}</label>")
            lines.append(f"            <section>{escape(section)}</section>")
            lines.append("        </sections>")
        lines.append("    </layouts>")
    for name, tr in record_types or []:
        lines.append("    <recordTypes>")
        lines.append(f"        <label>{escape(tr)}</label>")
        lines.append(f"        <name>{escape(name)}</name>")
        lines.append("    </recordTypes>")
    for name, tr in validation_rules or []:
        lines.append("    <validationRules>")
        lines.append(f"        <errorMessage>{escape(tr)}</errorMessage>")
        lines.append(f"        <name>{escape(name)}</name>")
        lines.append("    </validationRules>")
    # <startsWith> is last in CustomObjectTranslation child order — verified against
    # retrieved org metadata (e.g. Widget__c-fr): caseValues, gender, nameFieldLabel, startsWith.
    if starts_with:
        lines.append(f"    <startsWith>{escape(starts_with)}</startsWith>")
    lines.append("</CustomObjectTranslation>")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_translations_file(path: Path, rows: list[dict]) -> None:
    """Write the global Translations file: custom labels, quick actions, tabs, apps,
    report types (and their sections).

    Children are emitted in the schema's alphabetical order — customApplications,
    customLabels, customTabs, quickActions, reportTypes — the same ordering discipline the
    CustomObjectTranslation writer follows. A report type's sections nest inside their
    parent, so section rows are grouped under the report type they belong to rather than
    emitted as siblings.
    """
    simple = [("custom-app", "customApplications"),
              ("custom-label", "customLabels"),
              ("custom-tab", "customTabs"),
              ("quick-action", "quickActions")]

    lines = ['<?xml version="1.0" encoding="UTF-8"?>', f'<Translations xmlns="{NS}">']
    for type_, tag in simple:
        for r in [x for x in rows if x.get("type") == type_]:
            tr = (r.get("translation") or "").strip()
            if not tr:
                continue
            lines.append(f"    <{tag}>")
            lines.append(f"        <label>{escape(tr)}</label>")
            lines.append(f"        <name>{escape(r['field'])}</name>")
            lines.append(f"    </{tag}>")

    sections: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r.get("type") == "report-type-section" and (r.get("translation") or "").strip():
            sections[r["field"]].append(r)
    parents = {r["field"]: r for r in rows
               if r.get("type") == "report-type" and (r.get("translation") or "").strip()}
    for name in sorted(set(parents) | set(sections)):
        lines.append("    <reportTypes>")
        parent = parents.get(name)
        if parent:
            lines.append(f"        <label>{escape(parent['translation'].strip())}</label>")
        lines.append(f"        <name>{escape(name)}</name>")
        for s in sections.get(name, []):
            lines.append("        <sections>")
            lines.append(f"            <label>{escape(s['translation'].strip())}</label>")
            lines.append(f"            <name>{escape(s['masterLabel'])}</name>")
            lines.append("        </sections>")
        lines.append("    </reportTypes>")

    lines.append("</Translations>")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _is_extended(rows: list[dict], type_: str) -> bool:
    """True if any row of this type has caseType, article, or plural filled in."""
    return any(
        (r.get("caseType") or r.get("article") or r.get("plural"))
        for r in rows if r.get("type") == type_
    )


def _casevalues_from_rows(rows: list[dict], type_: str) -> list[dict]:
    """Build caseValues entry list from extended-format CSV rows."""
    out = []
    for r in rows:
        if r.get("type") != type_:
            continue
        val = (r.get("translation") or "").strip()
        if not val:
            continue
        out.append({
            "article":  (r.get("article")  or "").strip(),
            "caseType": (r.get("caseType") or "").strip(),
            "gender":   (r.get("gender")   or "").strip(),
            "plural":   str(r.get("plural") or "").strip().lower() in ("true", "1"),
            "value":    val,
        })
    return out


def write_standard_field_file_extended(
    path: Path, token: str, case_values: list[dict], gender: str = "", possessive: str = "",
    starts_with: str = "", article: str = ""
) -> None:
    """Write a renamed-standard-field with full caseValues (article, caseType, plural, possessive).

    `article` is the language-level default applied when a row carries none of its own.
    """
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', f'<CustomFieldTranslation xmlns="{NS}">']
    for cv in case_values:
        lines.append("    <caseValues>")
        if cv.get("article") or article:
            lines.append(f"        <article>{escape(cv.get('article') or article)}</article>")
        if cv.get("caseType"):
            lines.append(f"        <caseType>{escape(cv['caseType'])}</caseType>")
        # NB: <gender> is NOT a valid child of <caseValues> — its only valid children are
        # article, caseType, plural, possessive, value. Emitting it here fails with
        # "Element gender invalid at this location". The row's gender is hoisted to the
        # parent element by the caller (primary_gender).
        lines.append(f"        <plural>{'true' if cv['plural'] else 'false'}</plural>")
        if possessive:
            lines.append(f"        <possessive>{escape(possessive)}</possessive>")
        lines.append(f"        <value>{escape(cv['value'])}</value>")
        lines.append("    </caseValues>")
    if gender:
        lines.append(f"    <gender>{escape(gender)}</gender>")
    lines.append(f"    <name>{escape(token)}</name>")
    if starts_with:
        lines.append(f"    <startsWith>{escape(starts_with)}</startsWith>")
    lines.append("</CustomFieldTranslation>")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def gender_of(rows: list[dict], type_: str) -> str:
    """First non-empty `gender` cell among rows of this type ('' if the column is absent)."""
    return next((g for r in rows if r["type"] == type_
                 and (g := (r.get("gender") or "").strip())), "")


def starts_with_of(rows: list[dict], type_: str) -> str:
    """First non-empty `startsWith` cell among rows of this type ('' if the column is absent)."""
    return next((s for r in rows if r["type"] == type_
                 and (s := (r.get("startsWith") or "").strip())), "")


def repoint_global_value_rows(rows: list[dict], default_dir: Path) -> tuple[int, int, int]:
    """Re-point field-picklist rows whose field is backed by a global value set.

    Salesforce rejects EVERY value of a GVS-backed picklist when it is translated inside
    CustomObjectTranslation — with the misleading "Invalid picklist value: X in field: Y",
    which reads as if the value was deleted. It is not: the value belongs in
    globalValueSetTranslations/<set>-<lang>. Confirmed by deploy:
    even the org's own API names are rejected in the field file.

    The GVS keys off the value's LABEL, not its API name. Returns
    (repointed, left_alone, deduped).
    """
    field_cache: dict[tuple[str, str], dict | None] = {}
    gvs_cache: dict[str, list[str]] = {}
    repointed = left_alone = 0
    unresolved: set[tuple[str, str]] = set()

    for r in rows:
        if r.get("type") != "field-picklist":
            continue
        key = (r.get("component", ""), r.get("field", ""))
        if key not in field_cache:
            field_cache[key] = read_field(default_dir, *key)
        info = field_cache[key]
        if info is None:
            # No local metadata means we cannot tell whether this field is GVS-backed.
            # Staying silent here is how a mis-route hides: the rows would be written into
            # the field file and fail with "Invalid picklist value", which reads like the
            # value was deleted. Surface it instead so the retrieve gap gets fixed.
            unresolved.add(key)
            continue
        gvs = info.get("value_set_name")
        if not gvs:
            continue
        if gvs not in gvs_cache:
            gvs_cache[gvs] = read_value_set_labels(
                default_dir / "globalValueSets" / f"{gvs}.globalValueSet-meta.xml", "customValue")
        if r.get("masterLabel") not in gvs_cache[gvs]:
            # Not a member of the set under this key either — re-pointing would just move
            # the failure. Leave it where it is so the error names the original field.
            left_alone += 1
            continue
        lang = lang_of(r["file"])
        r["file"] = f"globalValueSetTranslations/{gvs}-{lang}{GVS_SUFFIX}"
        r["type"] = "global-value"
        r["component"] = gvs
        r["field"] = ""
        repointed += 1

    # A value set is shared across objects (e.g. Color_Set behind Color__c on two objects), so
    # re-pointing can produce the same valueTranslation twice in one file.
    seen: set[tuple[str, str]] = set()
    deduped = 0
    for i in range(len(rows) - 1, -1, -1):
        r = rows[i]
        if r.get("type") != "global-value":
            continue
        k = (r["file"], r.get("masterLabel", ""))
        if k in seen:
            del rows[i]
            deduped += 1
        else:
            seen.add(k)
    if unresolved:
        names = ", ".join(f"{o}.{f}" for o, f in sorted(unresolved)[:4])
        more = f" (+{len(unresolved) - 4} more)" if len(unresolved) > 4 else ""
        print(f"  warning: no local field metadata for {len(unresolved)} picklist field(s) "
              f"— cannot tell if they belong to a global value set: {names}{more}. "
              f"Retrieve those objects if a deploy reports invalid picklist values on them.",
              file=sys.stderr)
    return repointed, left_alone, deduped


def to_files(root: Path, csv_path: Path, skip_untranslated: bool = False,
             projectdir: Path | None = None) -> None:
    with open(csv_path, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))

    total_rows = len(rows)
    skipped = 0
    if skip_untranslated:
        # Drop blank slots so they aren't written as empty elements (an empty <label> can
        # clear an existing translation in the org). Files left with no rows aren't written.
        rows = [r for r in rows if (r.get("translation") or "").strip()]
        skipped = total_rows - len(rows)

    repointed, unmatched, deduped = repoint_global_value_rows(rows, find_default_dir(projectdir))
    if repointed or unmatched:
        note = f"re-pointed {repointed} global-value-set value(s) out of their field file"
        if deduped:
            note += f", merged {deduped} duplicate(s)"
        if unmatched:
            note += f"; left {unmatched} not in the value set alone"
        print(f"  {note}.", file=sys.stderr)

    by_file: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_file[r["file"]].append(r)

    files_written = 0
    object_folders: set[Path] = set()
    containers_written: set[Path] = set()
    for rel, frows in by_file.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        # Language is the suffix of the object folder name, e.g. Account-fi -> fi,
        # Account-nl_NL -> nl_NL. Possessive languages need <possessive> on caseValues.
        lang = path.parent.name.rsplit("-", 1)[-1]
        poss = "None" if lang in POSSESSIVE_LANGS else ""
        art = "None" if lang in ARTICLE_LANGS else ""
        if rel.endswith(FIELD_SUFFIX):
            field = path.name[: -len(FIELD_SUFFIX)]
            if any(r["type"] == "standard-field" for r in frows):
                sw = starts_with_of(frows, "standard-field")
                if _is_extended(frows, "standard-field"):
                    cvs = _casevalues_from_rows(frows, "standard-field")
                    primary_gender = next((cv["gender"] for cv in cvs if cv["gender"]), "")
                    write_standard_field_file_extended(path, field, cvs, primary_gender,
                                                       possessive=poss, starts_with=sw,
                                                       article=art)
                else:
                    tr = next((r["translation"] for r in frows if r["type"] == "standard-field"), "")
                    write_standard_field_file(path, field, tr, gender_of(frows, "standard-field"),
                                              possessive=poss, starts_with=sw, article=art)
            else:
                label = next((r["translation"] for r in frows if r["type"] == "field-label"), "")
                picks = [(r["masterLabel"], r["translation"]) for r in frows
                         if r["type"] == "field-picklist"]
                write_field_file(path, field, label, picks, skip_untranslated)
            object_folders.add(path.parent)
            files_written += 1
        elif rel.endswith(CONTAINER_SUFFIX):  # container: object labels + inline types
            if _is_extended(frows, "object-label"):
                ext_cases = _casevalues_from_rows(frows, "object-label")
                primary_gender = next((cv["gender"] for cv in ext_cases if cv["gender"]), "")
                cases_simple = None
            else:
                ext_cases = None
                cases_simple = []
                for r in (r for r in frows if r["type"] == "object-label"):
                    # New format: one row, translation=singular, plural_translation=plural
                    # Old format: two rows, field="singular"/"plural"
                    sing = (r.get("translation") or "").strip()
                    plur = (r.get("plural_translation") or "").strip()
                    if r.get("field") in ("singular", "plural"):
                        # Old two-row format
                        cases_simple.append((r["field"] == "plural", sing))
                    else:
                        # New one-row format
                        if sing:
                            cases_simple.append((False, sing))
                        if plur and plur != NOT_SUPPORTED_PLURAL:
                            cases_simple.append((True, plur))
                primary_gender = gender_of(frows, "object-label")
            layouts = [(r["field"], r["masterLabel"], r["translation"]) for r in frows
                       if r["type"] == "layout-section"]
            record_types = [(r["field"], r["translation"]) for r in frows
                            if r["type"] == "record-type"]
            validation_rules = [(r["field"], r["translation"]) for r in frows
                                if r["type"] == "validation-rule"]
            write_container(path, cases_simple, layouts, record_types, validation_rules,
                            primary_gender, case_values_ext=ext_cases, possessive=poss,
                            starts_with=starts_with_of(frows, "object-label"))
            containers_written.add(path)
            object_folders.add(path.parent)
            files_written += 1
        elif rel.endswith(GVS_SUFFIX):
            write_value_set_file(path, "GlobalValueSetTranslation",
                                 [(r["masterLabel"], r["translation"]) for r in frows])
            files_written += 1
        elif rel.endswith(SVS_SUFFIX):
            write_value_set_file(path, "StandardValueSetTranslation",
                                 [(r["masterLabel"], r["translation"]) for r in frows])
            files_written += 1
        elif rel.endswith(TRANSLATIONS_SUFFIX):  # global Translations
            write_translations_file(path, frows)
            files_written += 1
        else:
            sys.stderr.write(f"warning: unrecognized translation file, skipped: {rel}\n")

    # Ensure every object folder has a container (empty if it had no object-label rows).
    for folder in object_folders:
        container = folder / f"{folder.name}.objectTranslation-meta.xml"
        if container not in containers_written:
            write_container(container)
            files_written += 1

    translated = sum(1 for r in rows if r.get("translation"))
    note = f", skipped {skipped} untranslated slot(s)" if skip_untranslated else ""
    print(
        f"Wrote {files_written} translation file(s) under {root} from {csv_path} "
        f"({translated} of {total_rows} slot(s) translated{note}).",
        file=sys.stderr,
    )


def to_files_many(root: Path, csv_paths: list[Path], skip_untranslated: bool = False) -> None:
    """Run to_files for each CSV (each CSV is one language; paths encode the language)."""
    for csv_path in csv_paths:
        if not csv_path.is_file():
            sys.exit(f"error: CSV not found: {csv_path}")
        to_files(root, csv_path, skip_untranslated)


# --------------------------------------------------------------------------- cli


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Translate Salesforce fields via a CSV round-trip (to-csv, then to-files).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="mode", required=True)

    pc = sub.add_parser("to-csv", help="field list -> CSV of values to translate")
    pc.add_argument("input_file", metavar="FIELDS_CSV",
                    help="CSV in fields.csv format (Name = Object.Field).")
    pc.add_argument("language", metavar="LANG",
                    help="Target language code(s); comma-separate for a batch, e.g. de,fr,pt_BR. "
                    "With multiple, output files are named <output stem>_<lang>.csv.")
    pc.add_argument("-d", "--projectdir", type=Path, default=None,
                    help="Project root used to locate metadata (default: current directory).")
    pc.add_argument("-o", "--output", type=Path, default=Path("translations.csv"),
                    help="Output CSV (default: translations.csv).")
    pc.add_argument("--standard-labels", type=Path, default=Path("standard_labels.json"),
                    help="describe-based labels from gen_standard_labels.py, only used with "
                    "--include-unchanged-standard-fields (default: standard_labels.json).")
    pc.add_argument("--include-unchanged-standard-fields", action="store_true",
                    help="Also translate standard field labels that have NOT been renamed. "
                    "Off by default: unchanged standard labels are auto-translated by "
                    "Salesforce, so only renamed standard fields (from the en_US "
                    "CustomObjectTranslation) are included.")
    pc.add_argument("--filter-standard-fields-to-input", action="store_true",
                    help="Keep only renamed standard fields whose label maps to an "
                    "Object.Field in your input list (needs gen_standard_labels.py's "
                    "standard_labels.json). Unmappable renames are kept with a warning.")
    pc.add_argument("--retrieve-existing", action="store_true",
                    help="Before writing the CSV, retrieve the existing <lang> translation "
                    "metadata for the referenced components (retrieve only, never deploys) "
                    "and pre-fill the `translation` column from it. Requires --target-org. "
                    "Off by default; without it the script stays offline and emits blanks.")
    pc.add_argument("--target-org", default=None,
                    help="Org alias to retrieve from; required with --retrieve-existing.")
    pc.add_argument("--labels-list", type=Path, default=None,
                    help="File of custom-label API names (one per line, or a CSV with a "
                    "Name/first column) to also translate via the global Translations type. "
                    "Custom labels aren't in the field CSV, so they're chosen separately.")

    pf = sub.add_parser("to-files", help="filled CSV(s) -> deployable translation files")
    pf.add_argument("csv", type=Path, nargs="+",
                    help="One or more filled CSVs from to-csv (e.g. per-language batch).")
    pf.add_argument("--dir", type=Path, default=Path("."),
                    help="Root to write translation files under (default: current directory).")
    pf.add_argument("--skip-untranslated", action="store_true",
                    help="Ignore rows with a blank `translation` instead of writing them as "
                    "empty elements, and don't write files that end up with nothing. Useful "
                    "for a partly filled CSV: an empty <label> can clear a translation that "
                    "already exists in the org.")

    pv = sub.add_parser("validate", help="check filled CSV(s) against the metadata on disk")
    pv.add_argument("csv", type=Path, nargs="+",
                    help="One or more CSVs to check (from to-csv or a translator).")
    pv.add_argument("-d", "--projectdir", type=Path, default=None,
                    help="Project root used to locate metadata (default: current directory).")
    pv.add_argument("--target-org", default=None,
                    help="Also check against the live org (describe only, never deploys). "
                    "Catches fields and record types deleted from the org, which local "
                    "metadata can't show because a retrieve never deletes.")
    pv.add_argument("--drop-deleted", action="store_true",
                    help="Also remove rows whose target no longer exists (deleted fields, "
                    "record types, picklist values ...) so the rest can deploy. Pair with "
                    "--target-org to catch things deleted from the org. Rewrites the CSV.")
    pv.add_argument("--fix", action="store_true",
                    help="Rewrite the CSV in place, applying the repairs that are "
                    "mechanical: mangled text, and picklist values whose field moved to a "
                    "global value set. Everything else is reported, not touched.")

    args = parser.parse_args()
    if args.mode == "validate":
        sys.exit(validate(args.csv, args.projectdir, args.fix, args.target_org,
                          args.drop_deleted))
    if args.mode == "to-csv":
        input_path = Path(args.input_file)
        if not input_path.is_file():
            sys.exit(f"error: input file not found: {input_path}")
        languages = [s.strip() for s in args.language.split(",") if s.strip()]
        if not languages:
            sys.exit("error: no target language given")
        from sf_languages import require_known
        require_known(languages, "to-csv")
        if args.retrieve_existing and not args.target_org:
            sys.exit("error: --retrieve-existing requires --target-org")
        if args.labels_list is not None and not args.labels_list.is_file():
            sys.exit(f"error: labels list not found: {args.labels_list}")
        to_csv(input_path, languages, args.projectdir, args.output,
               args.standard_labels, args.include_unchanged_standard_fields,
               args.filter_standard_fields_to_input,
               args.retrieve_existing, args.target_org, args.labels_list)
    else:
        to_files_many(args.dir, args.csv, args.skip_untranslated)


if __name__ == "__main__":
    main()
