#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Combine per-language translation CSVs into a master Excel workbook.

Tab 1 – Fields: all regular object rows (field labels, picklists, record types,
validation messages, layout headings) — everything except object-label,
standard-field, custom-label and UI rows. One Existing Value + Translation column
pair per language.

Tab 2 – Standard Field Grammar: object-label and standard-field rows only (renamed
standard fields + object labels; these are the rows that carry a per-language gender).
Grammar dropdowns lead each language block, followed by Singular (and, when needed,
Plural) Existing Value + Translation pairs. object-label rows (which arrive as separate
singular/plural keys) are combined into one Excel row per component.

Tab 3 – Object Names: object names in every case/article/possessive form each language
needs, with the language's grammar dropdowns (see LANGUAGE_GRAMMAR).

Then Custom Labels, UI Labels (quick actions, tabs, apps, report types) and, only when
layout headings were held back, Salesforce-Owned.

Usage:
  # Generate Excel from CSVs (pull step)
  python combine_translations.py --input-dir <run folder> --output master_translations.xlsx --org "<org alias>"

Languages come from the translations_<code>.csv files in --input-dir; any Salesforce
language code works (see sf_languages.py).
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime
from collections import defaultdict
from pathlib import Path

try:
    import openpyxl
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.datavalidation import DataValidation
except ImportError:
    sys.exit("openpyxl is required: pip install openpyxl")

# ── Language configuration ─────────────────────────────────────────────────────
# Language names and grammar live in sf_languages.py; project settings in settings.json.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from sf_languages import (  # noqa: E402
    LANGUAGES as LANGUAGE_NAMES, LANGUAGE_GRAMMAR, LANGUAGE_CASE_FORMS,
    LANGUAGE_ARTICLE_FORMS, LANGUAGE_POSSESSIVE_FORMS, ordered as order_languages,
    grammar_known, require_known,
)
from toolkit_settings import (  # noqa: E402
    API_PATH, API_VERSION, BANNER_TO_POPULATE as _SETTINGS_BANNER, STANDARD_OBJECT_LABELS,
)

# Every language Salesforce offers, English first, for readers that must recognise any
# language column in a workbook.
ORDERED_LANGS = order_languages(LANGUAGE_NAMES)

# Timeout for the wildcard CustomObjectTranslation retrieve. It is one request covering
# all languages, so the cost does not scale with language count. Generous because a
# timeout is a hard failure (see _fetch_sf_object_genders) and a slow-but-working org
# should not kill a long build.
_GENDER_RETRIEVE_TIMEOUT = 600

# English singular/plural labels for common standard (non-custom) objects. Display only.
# A standard object not listed here still works: its name is guessed by _humanize and its
# localized labels are fetched from the org. Add or correct entries in settings.json
# ("standard_object_labels"); those win over this table.
_STANDARD_OBJECT_LABELS: dict[str, tuple[str, str]] = {
    "Account": ("Account", "Accounts"),
    "AccountContactRelation": ("Account Contact Relation", "Account Contact Relations"),
    "AccountTeamMember": ("Account Team Member", "Account Team Members"),
    "Activity": ("Activity", "Activities"),
    "Asset": ("Asset", "Assets"),
    "Campaign": ("Campaign", "Campaigns"),
    "CampaignMember": ("Campaign Member", "Campaign Members"),
    "Case": ("Case", "Cases"),
    "Contact": ("Contact", "Contacts"),
    "Contract": ("Contract", "Contracts"),
    "ContractLineItem": ("Contract Line Item", "Contract Line Items"),
    "Entitlement": ("Entitlement", "Entitlements"),
    "Event": ("Event", "Events"),
    "Lead": ("Lead", "Leads"),
    "Location": ("Location", "Locations"),
    "Opportunity": ("Opportunity", "Opportunities"),
    "OpportunityContactRole": ("Opportunity Contact Role", "Opportunity Contact Roles"),
    "OpportunityLineItem": ("Opportunity Product", "Opportunity Products"),
    "OpportunityLineItemSchedule": ("Opportunity Product Schedule", "Opportunity Product Schedules"),
    "Order": ("Order", "Orders"),
    "OrderItem": ("Order Product", "Order Products"),
    "Pricebook2": ("Price Book", "Price Books"),
    "PricebookEntry": ("Price Book Entry", "Price Book Entries"),
    "Product2": ("Product", "Products"),
    "Quote": ("Quote", "Quotes"),
    "QuoteLineItem": ("Quote Line Item", "Quote Line Items"),
    "ServiceContract": ("Service Contract", "Service Contracts"),
    "Solution": ("Solution", "Solutions"),
    "Task": ("Task", "Tasks"),
    "User": ("User", "Users"),
}
_STANDARD_OBJECT_LABELS.update(STANDARD_OBJECT_LABELS)


def _is_standard_object(obj: str) -> bool:
    """Standard objects have no "__" suffix (custom ones end __c, __kav, ...)."""
    return "__" not in obj


# Standard objects in scope that are not in _STANDARD_OBJECT_LABELS, found in the local
# metadata by _load_object_labels. Their labels are also fetched from the org.
_UNLISTED_STANDARD_OBJECTS: set[str] = set()


def _humanize(api_name: str) -> tuple[str, str]:
    """English label guess for a standard object the table does not know: "WorkOrder" ->
    ("Work Order", "Work Orders"). Display only; set the real one in settings.json."""
    words = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", api_name).strip()
    if words.endswith("y") and not words.endswith(("ay", "ey", "oy", "uy")):
        plural = words[:-1] + "ies"
    elif words.endswith(("s", "x", "ch", "sh")):
        plural = words + "es"
    else:
        plural = words + "s"
    return words, plural

# Row types that go on Tab 2 / Tab 3 only
GENDER_ROW_TYPES = frozenset({"object-label", "standard-field"})

# Row types that go on the dedicated "Custom Labels" tab (Tab 4) instead of Tab 1
# Tab names. Kept as constants because the highlighter and the pre-fill both look tabs
# up by name - a rename made in one place only would silently stop them matching.
MAIN_TAB    = "Fields"
GENDER_TAB  = "Standard Field Grammar"
SUMMARY_TAB = "Summary"
LABELS_TAB  = "Custom Labels"
UI_TAB      = "UI Labels"
OBJNAMES_TAB = "Object Names"
EXCLUDED_TAB = "Salesforce-Owned"

# UI-label rows carry no object, so the pull CSVs key them under this sentinel component.
# The UI Labels tab shows "What it is" in that position instead, so the reader has to put
# it back rather than read it off the sheet.
UI_COMPONENT = "(global)"

CUSTOM_LABEL_TYPES = frozenset({"custom-label"})

# Quick actions, tabs, apps and report types are org-wide UI chrome, not object data. They
# get their own tab for the same reason custom labels do: Tab 1 is built around
# component/field/masterLabel, which carry no meaning for a global row. They are also a
# different translation job — these are length-sensitive UI strings (a tab label that
# doubles in German breaks the nav bar), so they benefit from being reviewed together.
# One tab rather than four: the `type` column already separates them, and each type is
# usually too small to justify a tab of its own.
UI_LABEL_TYPES = frozenset({
    "quick-action", "custom-tab", "custom-app", "report-type", "report-type-section",
})

# Columns that identify a unique translatable item across all languages
KEY_COLS = ("type", "component", "field", "masterLabel")

# Header colours for language column groups, all dark enough for white text. They are not
# tied to any language: each language present gets the next colour in workbook column
# order (English first, then by name), and the palette repeats after the last entry.
_LANG_PALETTE = [
    "538135",  # Green
    "17375E",  # Midnight Blue
    "2E74B5",  # Blue
    "C55A11",  # Dark Orange
    "2E86C1",  # Steel Blue
    "7030A0",  # Purple
    "843C0C",  # Brown
    "B5451B",  # Brick Orange
    "1F497D",  # Dark Navy
    "1A5276",  # Dark Cerulean
    "C00000",  # Dark Red
    "8064A2",  # Medium Purple
    "A0522D",  # Sienna
    "404040",  # Dark Grey
    "833C00",  # Rust
    "002060",  # Deep Navy
    "4F6228",  # Olive
    "9C0D38",  # Crimson
    "5F3A8B",  # Dark Purple
    "7B5B00",  # Dark Amber
]
LANG_COLORS: dict[str, str] = {}


def assign_lang_colors(langs: list[str]) -> None:
    """Give each language a palette colour by its position in `langs` (the workbook's
    column order), so the colours depend only on the languages actually present."""
    LANG_COLORS.clear()
    for i, lang in enumerate(langs):
        LANG_COLORS[lang] = _LANG_PALETTE[i % len(_LANG_PALETTE)]


def lang_color(lang: str) -> str:
    """The colour assigned to a language. One not assigned yet takes the next palette slot."""
    if lang not in LANG_COLORS:
        LANG_COLORS[lang] = _LANG_PALETTE[len(LANG_COLORS) % len(_LANG_PALETTE)]
    return LANG_COLORS[lang]

_BASE_HEADER_FILL = PatternFill("solid", fgColor="595959")  # Dark grey for key columns
_HEADER_FONT = Font(bold=True, color="FFFFFF")
_BANNER_FILL = PatternFill("solid", fgColor="D9D9D9")
_BANNER_FONT = Font(italic=True, color="888888")
_REQUIRED_FILL = PatternFill("solid", fgColor="C00000")
_REQUIRED_FONT = Font(bold=True, color="FFFFFF")

BANNER_DO_NOT_EDIT = "Do Not Edit"
BANNER_TO_POPULATE = _SETTINGS_BANNER
_LEGACY_BANNERS = ("To Populate",)
BANNER_REQUIRED = "Required"


# ── Custom label non-translatable detection ───────────────────────────────────

_NONTRANSLATABLE_PATTERNS = [
    re.compile(r"^https?://", re.I),          # URL
    re.compile(r"^\d+$"),                      # pure numeric
    re.compile(r"^[A-Z0-9]{15,18}$"),          # Salesforce ID
    re.compile(r"^[\w.+\-]+@[\w.\-]+\.[a-z]{2,}$", re.I),  # email
]


def _load_label_values(labels_xml: Path) -> dict[str, str]:
    """Return {fullName: English value} from CustomLabels XML for non-translatable detection."""
    NS_L = "http://soap.sforce.com/2006/04/metadata"
    label_values: dict[str, str] = {}
    if labels_xml.is_file():
        xml_root = ET.parse(labels_xml).getroot()
        for el in xml_root.findall(f"{{{NS_L}}}labels"):
            n = (el.findtext(f"{{{NS_L}}}fullName") or "").strip()
            v = (el.findtext(f"{{{NS_L}}}value") or "").strip()
            if n:
                label_values[n] = v
    return label_values


def _apply_lang_header_colors(ws, base_col_count: int, lang_col_groups: list[tuple[str, int]]) -> None:
    """Color header row: dark grey for base columns, per-language color for language columns."""
    header_row = ws[1]
    for i in range(base_col_count):
        header_row[i].fill = _BASE_HEADER_FILL
        header_row[i].font = _HEADER_FONT
        header_row[i].alignment = Alignment(wrap_text=False)
    col = base_col_count
    for lang, count in lang_col_groups:
        color = lang_color(lang)
        fill = PatternFill("solid", fgColor=color)
        for i in range(count):
            header_row[col + i].fill = fill
            header_row[col + i].font = _HEADER_FONT
            header_row[col + i].alignment = Alignment(wrap_text=False)
        col += count


# ── Data loading ───────────────────────────────────────────────────────────────

def _extract_lang(path: Path) -> str | None:
    """Return language code from filenames like translations_pt_PT.csv."""
    stem = path.stem
    prefix = "translations_"
    return stem[len(prefix):] if stem.startswith(prefix) else None


def load_csvs(input_dir: Path, pattern: str) -> dict:
    """Load all matching CSVs; return nested dict: key -> lang -> row_dict."""
    data: dict = defaultdict(dict)
    found: list[tuple[str, Path]] = []

    for path in sorted(input_dir.glob(pattern)):
        lang = _extract_lang(path)
        if lang is not None:
            found.append((lang, path))

    if not found:
        sys.exit(f"No files matching {pattern!r} found in {input_dir}")

    for lang, path in found:
        with open(path, encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                key = tuple(row[c] for c in KEY_COLS)
                data[key][lang] = row

    print(f"Loaded {len(found)} language file(s), {len(data)} unique rows.", file=sys.stderr)
    return data


def _ref_file(lang_rows: dict) -> str:
    for row in lang_rows.values():
        if row.get("file"):
            return row["file"]
    return ""


def _source(lang_rows: dict) -> str:
    for row in lang_rows.values():
        if row.get("source"):
            return row["source"]
    return ""


# ── Sheet builders ─────────────────────────────────────────────────────────────

def _base_row(key: tuple, lang_rows: dict) -> list:
    return [
        _ref_file(lang_rows),  # file (reference only)
        key[0],                # type
        key[1],                # component
        key[2],                # field
        key[3],                # masterLabel
        _source(lang_rows),    # Value to Translate
    ]


def _build_tab2_items(data: dict) -> list[dict]:
    """Build Tab 2 item list: one per standard-field key, one per object-label component.

    object-label rows appear twice in data (field='singular' and field='plural');
    combine them into a single item with separate singular_rows / plural_rows dicts.
    """
    items: list[dict] = []
    obj_label_idx: dict[str, int] = {}  # component -> index in items

    for key, lang_rows in data.items():
        type_, component, field, master = key
        if type_ not in GENDER_ROW_TYPES:
            continue
        if type_ == "standard-field":
            items.append({
                "type": type_, "component": component,
                "field": field, "masterLabel": master,
                "singular_rows": lang_rows, "plural_rows": {},
            })
        elif type_ == "object-label":
            if field in ("singular", "plural"):
                # Old two-row format
                if component not in obj_label_idx:
                    obj_label_idx[component] = len(items)
                    items.append({
                        "type": type_, "component": component,
                        "field": "", "masterLabel": "",
                        "singular_rows": {}, "plural_rows": {},
                    })
                idx = obj_label_idx[component]
                if field == "singular":
                    items[idx]["singular_rows"] = lang_rows
                elif field == "plural":
                    items[idx]["plural_rows"] = lang_rows
            else:
                # New one-row format: translation=singular, plural_translation=plural
                if component not in obj_label_idx:
                    obj_label_idx[component] = len(items)
                    items.append({
                        "type": type_, "component": component,
                        "field": "", "masterLabel": "",
                        "singular_rows": lang_rows, "plural_rows": {},
                    })

    return items


def _find_default_dir(start: Path) -> Path | None:
    """Walk up from start to find force-app/main/default."""
    search = start.resolve()
    for _ in range(6):
        candidate = search / "force-app" / "main" / "default"
        if candidate.is_dir():
            return candidate
        search = search.parent
    return None


def _load_object_labels(input_dir: Path) -> dict[str, tuple[str, str]]:
    """Return {component: (singular_en, plural_en)} for all objects in scope.

    Derives the object list from objectTranslation folders that match components
    appearing in the translations CSVs. Labels come from object-meta.xml for
    custom objects and from _STANDARD_OBJECT_LABELS for standard objects.
    """
    import xml.etree.ElementTree as ET

    default_dir = _find_default_dir(input_dir)

    ot_objects: set[str] = set()
    if default_dir:
        ot_dir = default_dir / "objectTranslations"
        if ot_dir.is_dir():
            for p in ot_dir.iterdir():
                if p.is_dir():
                    ot_objects.add(p.name.rsplit("-", 1)[0])

    # Components from CSVs
    csv_comps: set[str] = set()
    for path in sorted(input_dir.glob("translations_*.csv")):
        with open(path, encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                c = row.get("component", "")
                if c and c != "(global)":
                    csv_comps.add(c)

    in_scope = sorted(csv_comps & ot_objects) if ot_objects else sorted(csv_comps)

    labels: dict[str, tuple[str, str]] = {}
    obj_dir = (default_dir / "objects") if default_dir else None
    for obj in in_scope:
        if obj in _STANDARD_OBJECT_LABELS:
            labels[obj] = _STANDARD_OBJECT_LABELS[obj]
        elif obj_dir:
            xml_path = obj_dir / obj / f"{obj}.object-meta.xml"
            if xml_path.is_file():
                root = ET.parse(xml_path).getroot()
                if not root.findtext("{*}label") and _is_standard_object(obj):
                    # A standard object the table does not know: retrieved standard objects
                    # carry no <label>, so show a readable guess and ask the org for the
                    # real names (see _fetch_sf_object_labels).
                    labels[obj] = _humanize(obj)
                    _UNLISTED_STANDARD_OBJECTS.add(obj)
                    continue
                sing = root.findtext("{*}label") or obj
                plur = root.findtext("{*}pluralLabel") or sing
                labels[obj] = (sing, plur)
            else:
                labels[obj] = (obj, obj)
        else:
            labels[obj] = (obj, obj)
    return labels


def _read_existing_object_names(default_dir: Path | None, langs: list[str], objects: list[str]) -> dict:
    """Read existing <caseValues>, <gender>, <startsWith> from objectTranslation XML files.

    Returns {obj: {lang: {"values": {(caseType, article, is_plural): str},
                           "gender": str, "startsWith": str}}}
    """
    import xml.etree.ElementTree as ET
    NS = "http://soap.sforce.com/2006/04/metadata"
    result: dict = {}
    if not default_dir:
        return result
    ot_dir = default_dir / "objectTranslations"
    if not ot_dir.is_dir():
        return result
    for obj in objects:
        for lang in langs:
            xml_path = ot_dir / f"{obj}-{lang}" / f"{obj}-{lang}.objectTranslation-meta.xml"
            if not xml_path.is_file():
                continue
            root = ET.parse(xml_path).getroot()
            obj_data = result.setdefault(obj, {})
            lang_data = obj_data.setdefault(lang, {"values": {}, "gender": "", "startsWith": ""})
            for cv in root.findall(f"{{{NS}}}caseValues"):
                case_type  = cv.findtext(f"{{{NS}}}caseType")   or ""
                article    = cv.findtext(f"{{{NS}}}article")    or ""
                possessive = cv.findtext(f"{{{NS}}}possessive") or ""
                # Use whichever is set; a language uses one or the other, never both
                variant   = article or (possessive if possessive.lower() != "none" else "")
                plural_s  = cv.findtext(f"{{{NS}}}plural")      or "false"
                # ET returns None for comment-only nodes; get raw text via itertext
                val_el = cv.find(f"{{{NS}}}value")
                value = ""
                if val_el is not None:
                    raw = "".join(val_el.itertext()).strip()
                    if raw:
                        value = raw
                if value:
                    lang_data["values"][(case_type, variant, plural_s.lower() == "true")] = value
            gender_el = root.find(f"{{{NS}}}gender")
            gender = "".join(gender_el.itertext()).strip() if gender_el is not None else ""
            if gender:
                lang_data["gender"] = gender
            sw_el = root.find(f"{{{NS}}}startsWith")
            sw = "".join(sw_el.itertext()).strip() if sw_el is not None else ""
            if sw:
                lang_data["startsWith"] = sw
    return result


def _obj_lang_cols(lang: str) -> list[tuple[str, str, str]]:
    """Return list of (header_suffix, case_or_none, variant_or_none) for one language's object name columns.

    Each tuple describes one translation column:
      header_suffix — appended to the language name for the column header
      case          — caseType value, or "" if none
      variant       — article or possessive value, or "" if none
    Singular/Plural are always paired, so this returns only the descriptor; caller adds both.
    """
    cases = LANGUAGE_CASE_FORMS.get(lang, [])
    articles = LANGUAGE_ARTICLE_FORMS.get(lang, [])
    possessives = LANGUAGE_POSSESSIVE_FORMS.get(lang, [])
    cols: list[tuple[str, str, str]] = []

    if cases and articles:
        for case in cases:
            for art in articles:
                label = f"{case} {art}" if art != "None" else case
                art_key = "" if art == "None" else art
                cols.append((label, case, art_key))
    elif cases and possessives:
        for case in cases:
            for poss in possessives:
                if poss == "None":
                    label = case
                    poss_key = ""
                else:
                    label = f"{case} {poss} person possessive"
                    poss_key = poss
                cols.append((label, case, poss_key))
    elif cases:
        for case in cases:
            cols.append((case, case, ""))
    elif articles:
        for art in articles:
            label = art if art != "None" else "Base"
            art_key = "" if art == "None" else art
            cols.append((label, "", art_key))
    elif possessives:
        # Hungarian: possessive forms but no case forms. Without this branch its
        # possessives are dropped and the deploy fails "Possessive is required".
        for poss in possessives:
            label = "Base" if poss == "None" else f"{poss} person possessive"
            poss_key = "" if poss == "None" else poss
            cols.append((label, "", poss_key))
    else:
        cols.append(("", "", ""))

    return cols


# RETIRED — the `.stf`-absence rule that used to live here.
#
# It inferred "Salesforce owns this layout section" from the key being missing from
# Source_en_US.stf. Measured against a real org that rule **under-excluded** (missed Salesforce-owned rows),
# and an earlier variant over-excluded rows that had no positive control at all.
# Absence from an export is not evidence of ownership.
#
# Ownership is now decided by `classify_layout_sections.py`, which renders each section
# in a probe language the org has not translated into and treats a non-English rendering as
# proof Salesforce has its own string. That is a positive test. Its output,
# `layout_section_verdicts.json`, is applied by `apply_layout_verdicts.py`.
#
# This builder no longer classifies anything. It emits every layout-section row to the
# main tab; run the two scripts above afterwards. Leaving the old rule wired in here
# meant the next `--output` build silently re-split the rows by the discredited rule and
# undid the corrected classification.
#
# _source_layout_keys below is kept only as a standalone helper. Nothing in this script
# calls it, and build_tab1 passes no Source keys, so no row is excluded by this rule.


def _source_layout_keys(project_root: Path | None, control_key: str) -> set[str]:
    """Base `LayoutSection.` keys from a Source_en_US export, positional suffix stripped.

    Source is the org's own list of every translatable key, so a layout-section row
    whose key is absent from it is not yours to translate.

    `control_key` is a positive control: a `LayoutSection.` key you know is in YOUR org's
    Source export, for example "LayoutSection.Widget.Widget Layout.Widget Details" (the
    export drops `__c`). There is no default, because no key exists in every org. If the
    key is absent, the export is treated as truncated or from another org.

    Returns an EMPTY set — which disables the filter — whenever the export is missing,
    unreadable, or fails the positive control. Every one of those paths announces
    itself on stderr: a filter that silently does nothing is a costly failure mode.

    Picks the NEWEST export by mtime, not the first alphabetically: two exports in the
    tree must not make the result depend on path order.
    """
    if project_root is None:
        print("NOTE: no project root found — layout-section filter DISABLED; "
              "Salesforce-owned sections will stay on the main tab.", file=sys.stderr)
        return set()
    hits = sorted(project_root.glob("**/Source_en_US*.stf"),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    if not hits:
        print("NOTE: no Source_en_US*.stf found — layout-section filter DISABLED; "
              "Salesforce-owned sections will stay on the main tab.", file=sys.stderr)
        return set()
    chosen = hits[0]
    keys: set[str] = set()
    text = chosen.read_bytes().decode("utf-8-sig", "replace")
    for line in text.splitlines():
        if line.startswith("LayoutSection."):
            keys.add(re.sub(r"_\d+$", "", line.split("\t")[0]))

    stamp = datetime.fromtimestamp(chosen.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
    print(f"Source export for layout-section filter: {chosen.name} "
          f"(modified {stamp}, {len(keys)} LayoutSection keys)", file=sys.stderr)
    if len(hits) > 1:
        print(f"  ({len(hits)} Source exports present; newest chosen)", file=sys.stderr)

    if control_key not in keys:
        print(f"WARNING: control key {control_key!r} is ABSENT from this export. "
              "It is either truncated, from another org, or not a Source export. "
              "Layout-section filter DISABLED rather than risk condemning your own rows.",
              file=sys.stderr)
        return set()
    return keys


def _is_sf_owned_section(key: tuple, source_keys: set[str]) -> bool:  # noqa: D401
    """RETIRED as a builder rule. build_tab1 passes no Source keys, so it never excludes.

    ⚠ Measured against a real org this UNDER-EXCLUDES. Do not reintroduce it
    into `build_tab1`. Use `classify_layout_sections.py` + `apply_layout_verdicts.py`.
    """
    return _is_sf_owned_section_impl(key, source_keys)


def _is_sf_owned_section_impl(key: tuple, source_keys: set[str]) -> bool:
    """True when this layout-section row is Salesforce's, not yours to translate.

    Salesforce owns standard section headings and renders them from its language pack.
    Proven by deploy: setting one is
    ACCEPTED (Succeeded 1/1, 0 errors) then silently discarded — never stored, never
    rendered — while a custom section in the SAME payload landed and reads back.

    ⚠ Only returns True when the Source export demonstrably covers this object, i.e.
    the object has at least one LayoutSection key of its own. Without that, "absent
    from Source" cannot be distinguished from "Source never enumerates this object's
    layouts", and condemning on it is an argument from absence. Objects with
    zero Source coverage are left alone.
    """
    if key[0] != "layout-section" or not source_keys:
        return False
    obj = key[1]
    if not any(k.startswith(f"LayoutSection.{obj}.") for k in source_keys):
        return False  # no positive control for this object — do not condemn
    return f"LayoutSection.{key[1]}.{key[2]}.{key[3]}" not in source_keys


def build_tab1(ws, data: dict, langs: list[str],
               source_keys: set[str] | None = None) -> list[tuple]:
    """Translations tab — all non-gender rows, wide format.

    Returns the keys of any Salesforce-owned layout-section rows held back, so the
    caller can show them to reviewers on their own tab rather than dropping them
    silently.
    """
    source_keys = source_keys or set()
    excluded: list[tuple] = []
    base_headers = ["file", "type", "component", "field", "masterLabel", "Value to Translate"]
    lang_headers: list[str] = []
    for lang in langs:
        name = LANGUAGE_NAMES.get(lang, lang)
        lang_headers += [f"{name} Existing Value", f"{name} Translation"]

    ws.append(base_headers + lang_headers)
    ws.append(
        [BANNER_DO_NOT_EDIT] * len(base_headers)
        + [BANNER_DO_NOT_EDIT if i % 2 == 0 else BANNER_TO_POPULATE for i in range(len(lang_headers))]
    )
    _apply_lang_header_colors(ws, len(base_headers), [(lang, 2) for lang in langs])

    for key, lang_rows in data.items():
        if key[0] in GENDER_ROW_TYPES or key[0] in CUSTOM_LABEL_TYPES \
                or key[0] in UI_LABEL_TYPES:
            continue
        if _is_sf_owned_section(key, source_keys):
            excluded.append(key)
            continue
        row = _base_row(key, lang_rows)
        for lang in langs:
            lr = lang_rows.get(lang, {})
            row.append(lr.get("translation", ""))  # Existing Value (pre-filled from org)
            row.append("")                          # Translation (blank for reviewers)
        ws.append(row)
    return excluded


def build_excluded_tab(ws, data: dict, keys: list[tuple], langs: list[str]) -> None:
    """Tab listing the layout-section rows Salesforce owns, with the reason."""
    ws.append([
        "Salesforce owns these layout section headings and translates them from its own "
        "language pack. A deploy setting one is accepted and then silently discarded "
        "(verified by deploy), so they cannot be translated by you "
        "and are not included on the " + MAIN_TAB + " tab."
    ])
    ws["A1"].font = Font(italic=True, color="7F7F7F")
    ws.append([])

    base_headers = ["file", "type", "component", "field", "masterLabel", "Value to Translate"]
    lang_headers: list[str] = []
    for lang in langs:
        name = LANGUAGE_NAMES.get(lang, lang)
        lang_headers += [f"{name} Existing Value", f"{name} Translation"]
    ws.append(base_headers + lang_headers)
    for cell in ws[3]:
        if cell.value is not None:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="1F3864")

    for key in keys:
        lang_rows = data.get(key, {})
        row = _base_row(key, lang_rows)
        for lang in langs:
            lr = lang_rows.get(lang, {})
            row.append(lr.get("translation", ""))
            row.append("")
        ws.append(row)
    ws.freeze_panes = "A4"


def build_custom_labels_tab(
    ws, data: dict, langs: list[str],
    *, project_root: Path | None = None
) -> None:
    """Custom Labels tab — one row per custom label, same column structure as Tab 1.

    Labels whose English value is a URL, Salesforce ID, numeric constant, or email
    are excluded as non-translatable.
    """
    labels_xml = (
        project_root / "force-app" / "main" / "default" / "labels" / "CustomLabels.labels-meta.xml"
        if project_root else Path("/nonexistent")
    )
    label_values = _load_label_values(labels_xml)

    def _skip_label(label_name: str) -> bool:
        val = label_values.get(label_name, "")
        return bool(val and any(p.match(val) for p in _NONTRANSLATABLE_PATTERNS))

    base_headers = ["file", "type", "component", "field", "masterLabel", "Value to Translate"]
    lang_headers: list[str] = []
    for lang in langs:
        name = LANGUAGE_NAMES.get(lang, lang)
        lang_headers += [f"{name} Existing Value", f"{name} Translation"]

    ws.append(base_headers + lang_headers)
    ws.append(
        [BANNER_DO_NOT_EDIT] * len(base_headers)
        + [BANNER_DO_NOT_EDIT if i % 2 == 0 else BANNER_TO_POPULATE for i in range(len(lang_headers))]
    )
    _apply_lang_header_colors(ws, len(base_headers), [(lang, 2) for lang in langs])

    for key, lang_rows in data.items():
        if key[0] not in CUSTOM_LABEL_TYPES:
            continue
        if _skip_label(key[2]):  # key[2] = label fullName
            continue
        row = _base_row(key, lang_rows)
        for lang in langs:
            lr = lang_rows.get(lang, {})
            row.append(lr.get("translation", ""))  # Existing Value
            row.append("")                          # Translation (blank for reviewers)
        ws.append(row)


_UI_TYPE_NAMES = {
    "quick-action":        "Quick Action",
    "custom-tab":          "Tab",
    "custom-app":          "App",
    "report-type":         "Report Type",
    "report-type-section": "Report Type - Section",
}


def build_ui_labels_tab(ws, data: dict, langs: list[str]) -> None:
    """UI Labels tab — quick actions, tabs, apps, report types and their sections.

    `What it is` replaces Tab 1's component/field columns, which say nothing useful for a
    global row. Keeping the API name visible still matters: it is the key the translation
    is written against, and reviewers may need to re-key against it.
    """
    base_headers = ["file", "type", "What it is", "API Name", "Section", "Value to Translate"]
    lang_headers: list[str] = []
    for lang in langs:
        name = LANGUAGE_NAMES.get(lang, lang)
        lang_headers += [f"{name} Existing Value", f"{name} Translation"]

    ws.append(base_headers + lang_headers)
    ws.append(
        [BANNER_DO_NOT_EDIT] * len(base_headers)
        + [BANNER_DO_NOT_EDIT if i % 2 == 0 else BANNER_TO_POPULATE
           for i in range(len(lang_headers))]
    )
    _apply_lang_header_colors(ws, len(base_headers), [(lang, 2) for lang in langs])

    # Group a report type's sections directly under their parent rather than letting the
    # two row types interleave alphabetically.
    def sort_key(key):
        type_, component, field, master = key[0], key[1], key[2], key[3]
        family = field if type_.startswith("report-type") else ""
        return (_UI_TYPE_NAMES.get(type_, type_) if not family else "Report Type",
                family, 1 if type_ == "report-type-section" else 0, master, field)

    rows = [(k, v) for k, v in data.items() if k[0] in UI_LABEL_TYPES]
    for key, lang_rows in sorted(rows, key=lambda kv: sort_key(kv[0])):
        ref = next(iter(lang_rows.values()), {})
        ws.append([
            ref.get("file", ""),
            key[0],
            _UI_TYPE_NAMES.get(key[0], key[0]),
            key[2],
            key[3],
            ref.get("source", ""),
        ] + [v for lang in langs
             for v in (lang_rows.get(lang, {}).get("translation", ""), "")])


_NOT_SUPPORTED = "<Not Supported for this field, Do Not Populate>"
_NOT_SUPPORTED_PLURAL_FROM_CSV = "<Not Supported for this field, Do Not Populate>"
# Salesforce stores this as the enum Consonant/Vowel, but those read as jargon in a
# translator-facing sheet and Setup shows it as a "Starts with vowel sound" checkbox.
# The sheet therefore asks it in words and converts on the way in and out; the XML only
# ever sees Consonant/Vowel.
_STARTS_WITH_VALUES = ["Vowel sound", "Consonant sound"]
_STARTS_WITH_LABEL = "Starts with vowel or consonant sound"
_SW_TO_DISPLAY = {"Vowel": "Vowel sound", "Consonant": "Consonant sound"}
_SW_TO_METADATA = {"Vowel sound": "Vowel", "Consonant sound": "Consonant"}


def sw_display(value: str) -> str:
    """Salesforce enum -> what the translator sees ('Vowel' -> 'Vowel sound')."""
    return _SW_TO_DISPLAY.get((value or "").strip(), (value or "").strip())


def sw_metadata(value: str) -> str:
    """What the translator picked -> Salesforce enum. Accepts the bare enum too, so
    workbooks produced before this wording change still load."""
    return _SW_TO_METADATA.get((value or "").strip(), (value or "").strip())


def _dv_range(col_idx: int, first_row: int, last_row: int) -> str:
    """Return an Excel range string like 'H3:H500' for a single column."""
    letter = get_column_letter(col_idx)
    return f"{letter}{first_row}:{letter}{last_row}"


def _tab2_grammar_cols(lang: str) -> list[tuple[str, str, list[str]]]:
    """Return [(attribute, column_label, allowed_values), ...] for one language's Tab 2 grammar.

    These are the attributes Salesforce requires on a renamed-standard-field / object-label
    <caseValues>. Omitting one is rejected at deploy with "<Attribute> is required for
    language X", and the errors CASCADE — SF reports only the first missing attribute per
    component, so all of them must be supplied together. Every column here is Required.

    Only attributes a translator actually has to DECIDE appear here. `possessive` and
    `article` (FIELD_POSSESSIVE_LANGS / FIELD_ARTICLE_LANGS in sf_languages.py) are both
    omitted: on a single label slot the base form "None"
    is the only value Salesforce accepts, and to_files() now writes both automatically
    (POSSESSIVE_LANGS / ARTICLE_LANGS in translation_roundtrip.py). Exposing either would be
    a dropdown with one option — a control that changes nothing. Article *variants* are a
    Tab 3 / object-name concept, where each form is its own caseValue, so
    LANGUAGE_ARTICLE_FORMS stays intact for _obj_lang_cols.
    """
    out: list[tuple[str, str, list[str]]] = []
    grammar = LANGUAGE_GRAMMAR.get(lang)
    if grammar:
        # The attribute name is the grammar's own type — en_US/hu are "startsWith", not
        # "gender". Hardcoding "gender" here would emit <gender>Consonant</gender> and
        # fail with "'Consonant' is not a valid value for the enum 'Gender'".
        out.append((grammar["type"], grammar["label"], grammar["values"]))
        if grammar.get("starts_with"):
            out.append(("startsWith", _STARTS_WITH_LABEL, _STARTS_WITH_VALUES))
    return out


def build_rename_tabs(
    ws, data: dict, langs: list[str], sf_genders: dict | None = None
) -> list[int]:
    """Rename Tabs and Labels — Singular/Plural translations + grammar dropdowns per language.

    Returns the 1-indexed column numbers of every grammar column, so the caller can mark
    them Required (red) after style_sheet() has rewritten row 2.
    """
    items = _build_tab2_items(data)
    _sf_genders = sf_genders or {}

    # Renamed standard fields have no plural slot in Salesforce, so when the tab holds
    # nothing but those, every Plural cell reads "<Not Supported…>" — two columns of noise
    # per language. Drop the pair entirely in that case. Data-driven rather than
    # hard-coded, so the columns come back on their own if object-label rows reappear.
    show_plural = any(i["type"] != "standard-field" for i in items)

    # Per language: 4 translation cols + one col per required grammar attribute
    base_headers = ["file", "type", "component", "field", "masterLabel", "Value to Translate"]
    lang_headers: list[str] = []
    lang_col_widths: list[tuple[str, int]] = []  # (lang, total cols) for header colouring
    for lang in langs:
        name = LANGUAGE_NAMES.get(lang, lang)
        cols = [
            f"{name} Singular Existing Value",
            f"{name} Singular Translation",
        ]
        if show_plural:
            cols += [f"{name} Plural Existing Value", f"{name} Plural Translation"]
        # Grammar leads the language block, matching the Object Names tab. It is the
        # Required answer, so it should be the first thing seen, not trailing the
        # translation columns where it reads like an afterthought.
        cols = [f"{name} {label}" for _, label, _ in _tab2_grammar_cols(lang)] + cols
        lang_headers += cols
        lang_col_widths.append((lang, len(cols)))

    ws.append(base_headers + lang_headers)

    banner = [BANNER_DO_NOT_EDIT] * len(base_headers)
    for lang in langs:
        banner += [BANNER_REQUIRED] * len(_tab2_grammar_cols(lang))
        banner += [BANNER_DO_NOT_EDIT, BANNER_TO_POPULATE]
        if show_plural:
            banner += [BANNER_DO_NOT_EDIT, BANNER_TO_POPULATE]
    ws.append(banner)
    _apply_lang_header_colors(ws, len(base_headers), lang_col_widths)

    # Data validation dropdowns — compute column positions from the layout above
    data_first = 3
    data_last = max(len(items) + 2, data_first)
    base_col_count = len(base_headers)
    grammar_col_idxs: list[int] = []
    col = base_col_count + 1  # 1-indexed, advances as we walk through languages
    for lang in langs:
        for _attr, _label, values in _tab2_grammar_cols(lang):
            dv = DataValidation(
                type="list",
                formula1='"' + ",".join(values) + '"',
                allow_blank=True,
                showDropDown=False,
            )
            dv.sqref = _dv_range(col, data_first, data_last)
            ws.add_data_validation(dv)
            grammar_col_idxs.append(col)
            col += 1
        col += 4 if show_plural else 2   # the translation columns follow the grammar

    for item in items:
        ref = item["singular_rows"] or item["plural_rows"]
        is_std = item["type"] == "standard-field"
        row = [
            _ref_file(ref),
            item["type"],
            item["component"],
            item["field"],
            item["masterLabel"],
            _source(ref),
        ]
        plur_is_unsupported = is_std  # safe default if langs is empty
        for lang in langs:
            sing = item["singular_rows"].get(lang, {})
            plur = item["plural_rows"].get(lang, {})
            # Plural value: prefer plural_translation column (new format),
            # fall back to plural_rows lookup (old two-row format)
            plur_existing = sing.get("plural_translation", "") or plur.get("translation", "")
            plur_is_unsupported = (
                is_std or plur_existing == _NOT_SUPPORTED_PLURAL_FROM_CSV
            )
            lang_cells = [sing.get("translation", ""), ""]
            if show_plural:
                lang_cells += [
                    _NOT_SUPPORTED if plur_is_unsupported else plur_existing,
                    _NOT_SUPPORTED if plur_is_unsupported else "",
                ]
            grammar_cells: list[str] = []
            # Pre-fill grammar from CSV (prior run) or org retrieve; stable across cycles.
            # A standard-field row's gender belongs to the FIELD LABEL's noun, so only a
            # real per-field value from the org is valid. The OBJECT's gender is a
            # different noun and must NOT be used as a fallback here — doing so silently
            # fabricates wrong genders (e.g. every field on a Masculine-named object stamped
            # Masculine, although a field label's own noun may be Feminine), which then
            # look authoritative to translators and would deploy bad grammar.
            if is_std:
                org_grammar = _sf_genders.get((item["component"], item["field"], lang), {})
            else:  # object-label — the object's own gender IS the right value
                org_grammar = _sf_genders.get((item["component"], lang), {})
            for attr, _label, _values in _tab2_grammar_cols(lang):
                if attr == "gender":
                    grammar_cells.append(
                        sing.get("gender", "") or org_grammar.get("gender", ""))
                elif attr == "startsWith":
                    grammar_cells.append(sw_display(org_grammar.get("startsWith", "")))
                else:
                    # article: "None" is the only value Salesforce accepts on a field
                    # caseValue, so pre-fill it rather than making the translator pick the
                    # single legal option. Required but not a real choice.
                    grammar_cells.append(sing.get(attr, "") or "None")
            row += grammar_cells + lang_cells
        ws.append(row)

        # Grey the plural cells for standard-field rows — SF has no plural slot for these
        if show_plural and plur_is_unsupported:
            excel_row = ws.max_row
            data_col = base_col_count + 1  # 1-indexed, walk per-language
            for lang in langs:
                n_gram = len(_tab2_grammar_cols(lang))
                plural_ev = data_col + n_gram + 2
                plural_tr = data_col + n_gram + 3
                for c in (plural_ev, plural_tr):
                    cell = ws.cell(row=excel_row, column=c)
                    cell.fill = _BANNER_FILL
                    cell.font = _BANNER_FONT
                data_col += n_gram + 4

    return grammar_col_idxs


def _fetch_sf_object_labels(
    objects: list[str], langs: list[str], org_alias: str
) -> dict[tuple[str, str], tuple[str, str]]:
    """Fetch current SF object singular/plural labels via Composite Batch API + Accept-Language.

    Returns {(obj, lang): (singular, plural)}.
    Sends one composite batch per (object chunk, language), run in parallel; the chunk
    size is set below. Only standard objects are fetched.
    Uses 'sf api request rest' which handles auth internally (avoids token redaction issue).
    """
    import json
    import os
    import subprocess
    import tempfile
    from concurrent.futures import ThreadPoolExecutor, as_completed

    sf_cmd = "sf.cmd" if sys.platform == "win32" else "sf"
    # Only fetch standard objects — custom objects have no SF built-in translations
    # and composite batch describe is too slow for larger sets.
    std_objects = [o for o in objects if o in _STANDARD_OBJECT_LABELS or o in _UNLISTED_STANDARD_OBJECTS]
    if not std_objects:
        return {}
    chunk_size = 1  # 1 describe per composite batch — smaller payload, avoids 60s timeout on some locales
    obj_chunks = [std_objects[i : i + chunk_size] for i in range(0, len(std_objects), chunk_size)]

    def _fetch_batch(lang: str, chunk: list[str]) -> tuple[str, dict[str, tuple[str, str]]]:
        accept_lang = lang.replace("_", "-")
        body = {
            "batchRequests": [
                {"method": "GET", "url": f"/services/data/{API_PATH}/sobjects/{obj}/describe"}
                for obj in chunk
            ],
            "haltOnError": False,
        }
        tmpfile = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8") as f:
                json.dump(body, f)
                tmpfile = f.name
            result = subprocess.run(
                [
                    sf_cmd, "api", "request", "rest",
                    f"/services/data/{API_PATH}/composite/batch",
                    "-o", org_alias,
                    "--method", "POST",
                    "--body", f"@{tmpfile}",
                    "-H", f"Accept-Language: {accept_lang}",
                ],
                capture_output=True,
                timeout=90,
            )
            if result.returncode != 0:
                return lang, {}
            data = json.loads(result.stdout.decode("utf-8-sig"))
            out: dict[str, tuple[str, str]] = {}
            for obj, res in zip(chunk, data.get("results", [])):
                if res.get("statusCode") == 200:
                    r = res.get("result", {})
                    out[obj] = (r.get("label", ""), r.get("labelPlural", ""))
            return lang, out
        except Exception:
            return lang, {}
        finally:
            if tmpfile and os.path.exists(tmpfile):
                os.unlink(tmpfile)

    tasks = [(lang, chunk) for lang in langs for chunk in obj_chunks]
    print(
        f"Fetching SF labels for {len(std_objects)} standard objects: {len(tasks)} batch requests "
        f"({len(langs)} langs × {len(obj_chunks)} batches of ≤{chunk_size})...",
        file=sys.stderr,
    )
    labels: dict[tuple[str, str], tuple[str, str]] = {}
    empty = 0
    with ThreadPoolExecutor(max_workers=20) as pool:
        futures = {pool.submit(_fetch_batch, lang, chunk): (lang, chunk) for lang, chunk in tasks}
        for fut in as_completed(futures):
            lang, batch_labels = fut.result()
            empty += not batch_labels
            for obj, (sing, plur) in batch_labels.items():
                labels[(obj, lang)] = (sing, plur)
    print(f"  Total: {len(labels)} labels fetched"
          + (f"; {empty} of {len(tasks)} calls returned none (those cells stay blank)" if empty else "")
          + ".", file=sys.stderr)
    return labels


def _fetch_sf_object_genders(
    objects: list[str], langs: list[str], org_alias: str
) -> dict[tuple[str, str], dict]:
    """Retrieve gender/startsWith/caseValues per (object, language) from the target org.

    Covers gendered languages (need gender) AND languages with case forms (e.g. Finnish
    possessives). Uses a Metadata API retrieve into a throwaway temp SFDX project —
    read-only, never touches the working tree.

    Returns a dict with two kinds of key:
      (obj, lang)        -> {"gender", "startsWith", "values": {(caseType, variant, is_plural): str}}
                            the OBJECT's own grammar (correct for object-label rows)
      (obj, field, lang) -> {"gender", "startsWith"}
                            a renamed standard field's OWN grammar, read from its
                            *.fieldTranslation-meta.xml (correct for standard-field rows)
    The two are deliberately separate: a field label is a different noun from its object,
    so one is never a valid fallback for the other.
    """
    import os
    import shutil
    import subprocess
    import tempfile
    import xml.etree.ElementTree as ET

    NS = "http://soap.sforce.com/2006/04/metadata"
    sf_cmd = "sf.cmd" if sys.platform == "win32" else "sf"
    # Include gendered languages AND languages with case/possessive forms
    needs_fetch = {
        l for l in langs
        if LANGUAGE_GRAMMAR.get(l) or LANGUAGE_CASE_FORMS.get(l) or LANGUAGE_POSSESSIVE_FORMS.get(l)
    }
    objects_set = set(objects)
    if not needs_fetch or not objects_set:
        return {}

    tmpdir = tempfile.mkdtemp(prefix="sf_gender_")
    try:
        (Path(tmpdir) / "force-app" / "main" / "default").mkdir(parents=True, exist_ok=True)
        (Path(tmpdir) / "sfdx-project.json").write_text(
            '{"packageDirectories":[{"path":"force-app","default":true}],"sourceApiVersion":"%s"}' % API_VERSION,
            encoding="utf-8",
        )
        # Wildcard retrieve of all object translations — one clean request, no invalid-member risk.
        manifest = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Package xmlns="http://soap.sforce.com/2006/04/metadata">'
            '<types><members>*</members><name>CustomObjectTranslation</name></types>'
            f'<version>{API_VERSION}</version></Package>'
        )
        manifest_path = Path(tmpdir) / "package.xml"
        manifest_path.write_text(manifest, encoding="utf-8")

        print(
            f"Retrieving object gender/startsWith from {org_alias} "
            f"(read-only, temp project)...",
            file=sys.stderr,
        )
        result = subprocess.run(
            [sf_cmd, "project", "retrieve", "start",
             "--manifest", str(manifest_path), "-o", org_alias],
            cwd=tmpdir,
            capture_output=True,
            timeout=_GENDER_RETRIEVE_TIMEOUT,
        )
        if result.returncode != 0:
            # Retrieve may still write partial results (e.g. disabled-language warnings);
            # read whatever landed rather than failing the whole run.
            print("  (gender retrieve returned warnings — reading whatever was retrieved)",
                  file=sys.stderr)

        ot_dir = Path(tmpdir) / "force-app" / "main" / "default" / "objectTranslations"
        genders: dict[tuple[str, str], dict] = {}
        _possessive_langs = frozenset(LANGUAGE_POSSESSIVE_FORMS)
        if ot_dir.is_dir():
            for entry in ot_dir.iterdir():
                if not entry.is_dir():
                    continue
                obj, _, lang = entry.name.rpartition("-")
                if obj not in objects_set or lang not in needs_fetch:
                    continue
                xml_path = entry / f"{entry.name}.objectTranslation-meta.xml"
                if not xml_path.is_file():
                    continue
                root = ET.parse(xml_path).getroot()
                g_el = root.find(f"{{{NS}}}gender")
                sw_el = root.find(f"{{{NS}}}startsWith")
                g  = "".join(g_el.itertext()).strip()  if g_el  is not None else ""
                sw = "".join(sw_el.itertext()).strip() if sw_el is not None else ""
                cv_vals: dict[tuple, str] = {}
                for cv in root.findall(f"{{{NS}}}caseValues"):
                    case_type  = cv.findtext(f"{{{NS}}}caseType")   or ""
                    article    = cv.findtext(f"{{{NS}}}article")    or ""
                    possessive = cv.findtext(f"{{{NS}}}possessive") or ""
                    variant    = article or (possessive if possessive.lower() != "none" else "")
                    plural_s   = cv.findtext(f"{{{NS}}}plural")     or "false"
                    val_el = cv.find(f"{{{NS}}}value")
                    value = ""
                    if val_el is not None:
                        raw = "".join(val_el.itertext()).strip()
                        if raw:
                            value = raw
                    if value:
                        cv_vals[(case_type, variant, plural_s.lower() == "true")] = value
                if g or sw or cv_vals:
                    genders[(obj, lang)] = {"gender": g, "startsWith": sw, "values": cv_vals}

                # Per-FIELD gender for renamed standard fields. A field's <caseValues>
                # gender describes the FIELD LABEL's noun, which is a different word from
                # the object's name — an object whose German name is Masculine can have a
                # renamed field whose label noun is Feminine. So these must be collected
                # separately and never substituted for each other.
                # Keyed by a 3-tuple so it cannot collide with the (obj, lang) entries.
                for fpath in entry.glob("*.fieldTranslation-meta.xml"):
                    try:
                        froot = ET.parse(fpath).getroot()
                    except ET.ParseError:
                        continue
                    fname = (froot.findtext(f"{{{NS}}}name") or "").strip() \
                        or fpath.name.split(".")[0]
                    fg_el = froot.find(f"{{{NS}}}gender")
                    fsw_el = froot.find(f"{{{NS}}}startsWith")
                    fg = "".join(fg_el.itertext()).strip() if fg_el is not None else ""
                    fsw = "".join(fsw_el.itertext()).strip() if fsw_el is not None else ""
                    if fg or fsw:
                        genders[(obj, fname, lang)] = {"gender": fg, "startsWith": fsw}

        _obj_pairs = sum(1 for k in genders if len(k) == 2)
        _fld_pairs = sum(1 for k in genders if len(k) == 3)
        print(f"  Retrieved gender/startsWith/caseValues for {_obj_pairs} object/language pairs"
              f" and real per-field gender for {_fld_pairs} field/language pair(s).",
              file=sys.stderr)
        return genders
    except subprocess.TimeoutExpired as e:
        # A timeout means nothing usable landed. Passing --org is an explicit request for
        # org data, so quietly degrading to a workbook with NO gender/startsWith pre-fill
        # is silent data loss — the build would exit 0 and look fine. (A machine going to
        # sleep mid-retrieve causes exactly this.) Fail loudly.
        # A non-zero exit is handled separately above, because a partial retrieve is
        # still worth reading.
        raise RuntimeError(
            f"Gender retrieve from '{org_alias}' timed out after {_GENDER_RETRIEVE_TIMEOUT}s.\n"
            f"  The workbook would have had NO org gender/startsWith pre-fill.\n"
            f"  Re-run, or omit --org to build a local-only workbook deliberately."
        ) from e
    except Exception as e:
        print(f"  Gender retrieve skipped ({type(e).__name__}: {e}).", file=sys.stderr)
        return {}
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _load_obj_names_cache(script_dir: Path) -> dict:
    """Load optional JSON cache of pre-filled object name case forms.

    File: <script_dir>/object_names_cache.json
    Structure: {"fi": {"Account": {"Nominative": {"singular": "Tili", "plural": "Tilit"}, ...}}}
    Keys beginning with "_" are treated as comments and ignored.
    Returns empty dict if file is absent or malformed.
    """
    cache_path = script_dir / "object_names_cache.json"
    if not cache_path.is_file():
        return {}
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {}
        # Strip comment keys
        return {k: v for k, v in data.items() if not k.startswith("_")}
    except Exception as e:
        print(f"  object_names_cache.json skipped ({e})", file=sys.stderr)
        return {}


def build_object_names_tab(
    ws,
    object_labels: dict[str, tuple[str, str]],
    langs: list[str],
    existing_data: dict | None = None,
    sf_labels: dict[tuple[str, str], tuple[str, str]] | None = None,
    obj_names_cache: dict | None = None,
) -> list[int]:
    """Object Names tab — Existing Value + Translation column pairs per form per language.

    Column structure mirrors Tab 1 / Tab 2:
      For each language × each case/article form:
        {Lang} {Suffix} Singular Existing Value  (pre-filled from SF REST or XML)
        {Lang} {Suffix} Singular Translation     (blank for reviewers)
        {Lang} {Suffix} Plural Existing Value    (pre-filled)
        {Lang} {Suffix} Plural Translation       (blank for reviewers)
      Then per-language grammar dropdown(s).
    """
    base_headers = ["component", "English Singular", "English Plural"]
    lang_headers: list[str] = []
    lang_col_widths: list[tuple[str, int]] = []

    for lang in langs:
        name = LANGUAGE_NAMES.get(lang, lang)
        grammar = LANGUAGE_GRAMMAR.get(lang)
        form_cols = _obj_lang_cols(lang)
        n_cols = len(form_cols) * 4 + (1 if grammar else 0) + (1 if grammar and grammar.get("starts_with") else 0)
        lang_col_widths.append((lang, n_cols))

        if grammar:
            lang_headers.append(f"{name} {grammar['label']}")
            if grammar.get("starts_with"):
                lang_headers.append(f"{name} {_STARTS_WITH_LABEL}")
        for suffix, _case, _art in form_cols:
            prefix = f"{name} {suffix}".strip()
            lang_headers += [
                f"{prefix} Singular Existing Value",
                f"{prefix} Singular Translation",
                f"{prefix} Plural Existing Value",
                f"{prefix} Plural Translation",
            ]

    ws.append(base_headers + lang_headers)

    banner = [BANNER_DO_NOT_EDIT] * len(base_headers)
    grammar_banner_positions: list[int] = []  # 0-indexed positions in banner for gender cols
    for lang in langs:
        grammar = LANGUAGE_GRAMMAR.get(lang)
        form_cols = _obj_lang_cols(lang)
        if grammar:
            grammar_banner_positions.append(len(banner))
            banner.append(BANNER_REQUIRED)
            if grammar.get("starts_with"):
                grammar_banner_positions.append(len(banner))
                banner.append(BANNER_REQUIRED)
        for _ in form_cols:
            banner += [BANNER_DO_NOT_EDIT, BANNER_TO_POPULATE, BANNER_DO_NOT_EDIT, BANNER_TO_POPULATE]
    ws.append(banner)
    _apply_lang_header_colors(ws, len(base_headers), lang_col_widths)

    # Data validation dropdowns — gender/starts_with lead each language's group
    data_first = 3
    data_last = max(len(object_labels) + 2, data_first)
    col_idx = len(base_headers) + 1
    for lang in langs:
        grammar = LANGUAGE_GRAMMAR.get(lang)
        form_cols = _obj_lang_cols(lang)
        if grammar:
            dv = DataValidation(
                type="list",
                formula1='"' + ",".join(grammar["values"]) + '"',
                allow_blank=True,
                showDropDown=False,
            )
            dv.sqref = _dv_range(col_idx, data_first, data_last)
            ws.add_data_validation(dv)
            col_idx += 1
            if grammar.get("starts_with"):
                dv_sw = DataValidation(
                    type="list",
                    formula1='"' + ",".join(_STARTS_WITH_VALUES) + '"',
                    allow_blank=True,
                    showDropDown=False,
                )
                dv_sw.sqref = _dv_range(col_idx, data_first, data_last)
                ws.add_data_validation(dv_sw)
                col_idx += 1
        col_idx += len(form_cols) * 4  # skip the 4-col form groups

    # Data rows
    for component, (sing_en, plur_en) in object_labels.items():
        row = [component, sing_en, plur_en]
        obj_ex = (existing_data or {}).get(component, {})
        sf_sing, sf_plur = (sf_labels or {}).get((component, ""), ("", ""))  # fallback

        for lang in langs:
            grammar = LANGUAGE_GRAMMAR.get(lang)
            form_cols = _obj_lang_cols(lang)
            lang_ex = obj_ex.get(lang, {})
            cv_vals = lang_ex.get("values", {})
            sf_sing_l, sf_plur_l = (sf_labels or {}).get((component, lang), ("", ""))

            if grammar:
                # type="startsWith" langs (en_US) store their value in startsWith, not gender
                if grammar.get("type") == "startsWith":
                    row.append(sw_display(lang_ex.get("startsWith", "")))
                else:
                    row.append(lang_ex.get("gender", ""))
                if grammar.get("starts_with"):
                    row.append(sw_display(lang_ex.get("startsWith", "")))
            for i, (_suffix, case, art) in enumerate(form_cols):
                # Existing Value: prefer XML-deployed value, then cache, then SF REST label
                xml_sing = cv_vals.get((case, art, False), "")
                xml_plur = cv_vals.get((case, art, True),  "")
                is_base_form = (i == 0)
                # Cache covers base (non-possessive) forms, e.g. built-in SF translations
                cache_sing = cache_plur = ""
                if art == "" and obj_names_cache:
                    case_cache = (obj_names_cache.get(lang, {})
                                                 .get(component, {})
                                                 .get(case, {}))
                    cache_sing = case_cache.get("singular", "")
                    cache_plur = case_cache.get("plural", "")
                existing_sing = xml_sing or cache_sing or (sf_sing_l if is_base_form else "")
                existing_plur = xml_plur or cache_plur or (sf_plur_l if is_base_form else "")
                # Pre-fill Translation only for values already in XML (explicit org overrides).
                # Cache/REST values show as reference only — translator must explicitly accept them.
                # This prevents --load-object-names from wiping existing XML caseValues.
                trans_sing = xml_sing
                trans_plur = xml_plur
                row += [existing_sing, trans_sing, existing_plur, trans_plur]
        ws.append(row)

    # Return 1-indexed column positions of grammar (Required) cells in the banner row
    return [p + 1 for p in grammar_banner_positions]


def _parse_object_names_excel(excel_path: Path, langs: list[str],
                              from_existing: bool = False) -> dict:
    """Read the Object Names tab from a filled-in master Excel file.

    With from_existing, reads the "Existing Value" columns instead of "Translation" —
    for seeding a new org from what the source org already holds.

    Returns {obj: {lang: {"values": {(caseType, article, is_plural): str},
                           "gender": str, "startsWith": str}}}
    """
    value_col = "Existing Value" if from_existing else "Translation"
    # Build reverse header → (lang, case, art, is_plural|"__grammar__"|"__startswith__") map
    header_map: dict[str, tuple] = {}
    for lang in langs:
        name = LANGUAGE_NAMES.get(lang, lang)
        grammar = LANGUAGE_GRAMMAR.get(lang)
        for suffix, case, art in _obj_lang_cols(lang):
            prefix = f"{name} {suffix}".strip()
            header_map[f"{prefix} Singular {value_col}"] = (lang, case, art, False)
            header_map[f"{prefix} Plural {value_col}"]   = (lang, case, art, True)
        if grammar:
            header_map[f"{name} {grammar['label']}"] = (lang, "__grammar__", "", True)
            if grammar.get("starts_with"):
                header_map[f"{name} {_STARTS_WITH_LABEL}"] = (lang, "__startswith__", "", True)

    wb = openpyxl.load_workbook(excel_path, read_only=True, data_only=True)
    ws = next((s for s in wb.worksheets if s.title == OBJNAMES_TAB), None)
    if ws is None:
        wb.close()
        raise ValueError(f"No {OBJNAMES_TAB!r} sheet found in {excel_path}")
    rows = list(ws.iter_rows(values_only=True))
    wb.close()

    if len(rows) < 3:
        return {}

    headers = [str(h).strip() if h is not None else "" for h in rows[0]]
    comp_idx = next((i for i, h in enumerate(headers) if h == "component"), 0)

    result: dict = {}
    for row in rows[2:]:  # skip header row + banner row
        if not row or row[comp_idx] is None:
            continue
        component = str(row[comp_idx]).strip()
        if not component:
            continue
        obj_data = result.setdefault(component, {})
        for col_idx, header in enumerate(headers):
            if col_idx >= len(row) or row[col_idx] is None:
                continue
            val = str(row[col_idx]).strip()
            if not val:
                continue
            col_def = header_map.get(header)
            if col_def is None:
                continue
            lang, case, art, is_plur = col_def
            lang_data = obj_data.setdefault(lang, {"values": {}, "gender": "", "startsWith": ""})
            if case == "__grammar__":
                grammar_cfg = LANGUAGE_GRAMMAR.get(lang)
                if grammar_cfg and grammar_cfg.get("type") == "startsWith":
                    lang_data["startsWith"] = sw_metadata(val)
                else:
                    lang_data["gender"] = val
            elif case == "__startswith__":
                lang_data["startsWith"] = sw_metadata(val)
            else:
                lang_data["values"][(case, art, is_plur)] = val
    return result


def _object_grammar_complete(lang: str, lang_data: dict) -> bool:
    """Would this object's caseValues deploy, or is its required grammar missing?

    Salesforce rejects an object-name caseValue that arrives without the grammar its
    language requires, so a row with values but no gender/startsWith is not merely
    incomplete — it cannot deploy at all, and it takes the whole component down with it.
    """
    if not grammar_known(lang):
        return False  # rules unknown for this language: never send it unproven grammar
    cfg = LANGUAGE_GRAMMAR.get(lang)
    if not cfg:
        return True  # proven to need no gender (e.g. fi); possessive is written automatically
    if cfg.get("type") == "startsWith":
        return bool(lang_data.get("startsWith"))  # e.g. en_US
    if not lang_data.get("gender"):
        return False
    # some gendered languages (e.g. fr, it) carry startsWith in addition to gender
    return bool(lang_data.get("startsWith")) if cfg.get("starts_with") else True


def _write_object_names_xml(default_dir: Path, data: dict,
                            skip_incomplete: bool = False) -> None:
    """Write caseValues/gender/startsWith from Excel data into objectTranslation XML files.

    Preserves all existing content (field translations, validation rules, etc.) and
    replaces only the object-level grammar elements.

    With skip_incomplete, an (object, language) whose required grammar is missing is left
    alone entirely rather than written as an undeployable component.
    """
    import xml.etree.ElementTree as ET
    NS = "http://soap.sforce.com/2006/04/metadata"
    ET.register_namespace("", NS)

    ot_dir = default_dir / "objectTranslations"
    written = created = skipped = 0
    incomplete: dict[str, int] = {}
    grammar_only: dict[str, int] = {}
    unknown_grammar: dict[str, int] = {}

    for obj, obj_data in sorted(data.items()):
        for lang, lang_data in sorted(obj_data.items()):
            cv_vals   = lang_data.get("values", {})
            gender    = lang_data.get("gender", "")
            starts_w  = lang_data.get("startsWith", "")
            if not cv_vals and not gender and not starts_w:
                skipped += 1
                continue
            if not cv_vals:
                # Grammar is only valid together with the name forms; sent alone Salesforce
                # mis-reads it and rejects the whole object file.
                grammar_only[lang] = grammar_only.get(lang, 0) + 1
                continue
            if not grammar_known(lang):
                unknown_grammar[lang] = unknown_grammar.get(lang, 0) + 1
                continue
            if not _object_grammar_complete(lang, lang_data):
                incomplete[lang] = incomplete.get(lang, 0) + 1
                if skip_incomplete:
                    continue

            folder   = ot_dir / f"{obj}-{lang}"
            xml_path = folder / f"{obj}-{lang}.objectTranslation-meta.xml"

            if xml_path.is_file():
                tree = ET.parse(xml_path)
                root = tree.getroot()
            else:
                folder.mkdir(parents=True, exist_ok=True)
                root = ET.Element(f"{{{NS}}}CustomObjectTranslation")
                tree = ET.ElementTree(root)
                created += 1

            # Always remove caseValues — fully rewritten from Tab 3.
            # Only remove gender/startsWith if Tab 3 provides a replacement; otherwise
            # preserve whatever --load-translations wrote from Tab 2 gender columns.
            for el in root.findall(f"{{{NS}}}caseValues"):
                root.remove(el)
            if gender:
                for el in root.findall(f"{{{NS}}}gender"):
                    root.remove(el)
                ET.SubElement(root, f"{{{NS}}}gender").text = gender
            if starts_w:
                for el in root.findall(f"{{{NS}}}startsWith"):
                    root.remove(el)
                ET.SubElement(root, f"{{{NS}}}startsWith").text = starts_w

            _possessive_langs = frozenset(LANGUAGE_POSSESSIVE_FORMS)
            _article_langs = frozenset(LANGUAGE_ARTICLE_FORMS)
            # Sort: singular before plural, then by caseType, then by variant
            for (case_type, variant, is_plural), value in sorted(
                cv_vals.items(), key=lambda x: (x[0][2], x[0][0], x[0][1])
            ):
                if not value:
                    continue
                # Element order must follow the ObjectNameCaseValue schema:
                # article, caseType, plural, possessive, value. Article languages
                # need an explicit <article> on every form (including None).
                cv_el = ET.SubElement(root, f"{{{NS}}}caseValues")
                if lang in _article_langs:
                    ET.SubElement(cv_el, f"{{{NS}}}article").text = variant if variant else "None"
                if case_type:
                    ET.SubElement(cv_el, f"{{{NS}}}caseType").text = case_type
                ET.SubElement(cv_el, f"{{{NS}}}plural").text = "true" if is_plural else "false"
                if lang in _possessive_langs:
                    ET.SubElement(cv_el, f"{{{NS}}}possessive").text = variant if variant else "None"
                ET.SubElement(cv_el, f"{{{NS}}}value").text = value

            ET.indent(root, space="    ")
            tree.write(xml_path, encoding="UTF-8", xml_declaration=True)
            written += 1

    print(f"Object Names written: {written} file(s) ({created} new, {skipped} empty skipped)", file=sys.stderr)
    if grammar_only:
        detail = ", ".join(f"{l}:{n}" for l, n in sorted(grammar_only.items()))
        print(f"  Skipped {sum(grammar_only.values())} (object,language) with grammar but no "
              f"name forms — grammar cannot be sent alone — {detail}", file=sys.stderr)
    if unknown_grammar:
        detail = ", ".join(f"{l}:{n}" for l, n in sorted(unknown_grammar.items()))
        print(f"  Skipped {sum(unknown_grammar.values())} (object,language) whose language has "
              f"no proven grammar rules (add them to sf_languages.py) — {detail}", file=sys.stderr)
    if incomplete:
        total = sum(incomplete.values())
        detail = ", ".join(f"{l}:{n}" for l, n in sorted(incomplete.items()))
        if skip_incomplete:
            print(f"  Skipped {total} (object,language) with missing required grammar "
                  f"— {detail}", file=sys.stderr)
        else:
            print(f"  WARNING: {total} (object,language) have caseValues but no required "
                  f"gender/startsWith and WILL FAIL to deploy — {detail}. "
                  f"Re-run with --skip-incomplete-grammar to omit them.", file=sys.stderr)


# ── Pink highlighting ──────────────────────────────────────────────────────────

_PINK_FILL = PatternFill("solid", fgColor="FFD7D7")


def _build_skipped_keys(reviewer_path: Path) -> set[tuple]:
    """Return (component, field, masterLabel) keys where all translation columns are blank."""
    print(f"Reading reviewer file: {reviewer_path}", file=sys.stderr)
    reviewer_wb = openpyxl.load_workbook(reviewer_path, read_only=True, data_only=True)
    reviewer_ws = reviewer_wb.worksheets[0]
    reviewer_rows = list(reviewer_ws.iter_rows(values_only=True))
    reviewer_wb.close()

    if not reviewer_rows:
        print("Reviewer file is empty — skipping highlight step.", file=sys.stderr)
        return set()

    headers = [str(h).strip() if h is not None else "" for h in reviewer_rows[0]]

    def _find(h_lower: str) -> int | None:
        for i, h in enumerate(headers):
            if h.lower() == h_lower:
                return i
        return None

    comp_col   = _find("component")
    field_col  = _find("field")
    master_col = _find("masterlabel")

    KEY_NAMES_LOWER = {"file", "type", "component", "field", "masterlabel",
                       "value to translate", "source", "do not edit"}
    trans_cols = [
        i for i, h in enumerate(headers)
        if h and h.lower() not in KEY_NAMES_LOWER and not h.lower().startswith("do not")
    ]
    print(f"  Reviewer file: {len(trans_cols)} translation column(s) found", file=sys.stderr)

    skipped: set[tuple] = set()
    for row in reviewer_rows[1:]:
        comp   = str(row[comp_col]).strip()   if comp_col   is not None and row[comp_col]   else ""
        field  = str(row[field_col]).strip()  if field_col  is not None and row[field_col]  else ""
        master = str(row[master_col]).strip() if master_col is not None and row[master_col] else ""
        all_blank = all(
            row[i] is None or str(row[i]).strip() == "" or str(row[i]).strip().lower() == "do not edit"
            for i in trans_cols
        )
        if all_blank:
            skipped.add((comp, field, master))

    print(f"  Reviewer file: {len(skipped)} row(s) with no translations across any language",
          file=sys.stderr)
    return skipped


def apply_pink_highlight(wb, skipped_keys: set[tuple]) -> None:
    """Highlight rows in all sheets where (component, field, masterLabel) is in skipped_keys."""
    def _find_col(headers: list[str], *names: str) -> int | None:
        for name in names:
            for i, h in enumerate(headers):
                if h.lower() == name.lower():
                    return i
        return None

    total = 0
    for ws in wb.worksheets:
        headers = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]
        comp_col   = _find_col(headers, "component")
        field_col  = _find_col(headers, "field")
        master_col = _find_col(headers, "masterLabel", "masterlabel")

        if comp_col is None or field_col is None:
            continue

        count = 0
        for row in ws.iter_rows(min_row=3):
            comp   = str(row[comp_col].value).strip()   if row[comp_col].value   else ""
            field  = str(row[field_col].value).strip()  if row[field_col].value  else ""
            master = str(row[master_col].value).strip() if master_col is not None and row[master_col].value else ""
            if (comp, field, master) in skipped_keys:
                for cell in row:
                    cell.fill = _PINK_FILL
                count += 1

        print(f"  Sheet '{ws.title}': highlighted {count} row(s) pink", file=sys.stderr)
        total += count

    print(f"  Total: {total} row(s) highlighted pink", file=sys.stderr)


# ── Styling ────────────────────────────────────────────────────────────────────

def style_sheet(ws) -> None:
    """Grey italic banner row, freeze panes after key columns.
    Header row colors are applied per-language by _apply_lang_header_colors.
    """
    for cell in ws[2]:
        cell.fill = _BANNER_FILL
        cell.font = _BANNER_FONT
    ws.freeze_panes = "G3"  # freeze file/type/component/field/masterLabel/source + header+banner


# ── Load-translations write-back ───────────────────────────────────────────────

def _parse_excel_for_load(
    excel_path: Path, langs: list[str], from_existing: bool = False
) -> dict[tuple, dict[str, dict]]:
    """Read the filled value columns from the master Excel's four content tabs.

    Covers the MAIN_TAB, GENDER_TAB, LABELS_TAB and UI_TAB sheets.
    (Object Names is read separately by _parse_object_names_excel.)

    With from_existing, reads each language's "Existing Value" column instead of its
    "Translation" column — for seeding a new org from what the source org already holds,
    where the Translation columns are still empty.

    Returns {(type, component, field, masterLabel): {lang: {"translation": str, "plural_translation": str, "gender": str}}}
    Only entries with a non-blank value are included.
    """
    wb = openpyxl.load_workbook(excel_path, read_only=True, data_only=True)
    edits: dict[tuple, dict[str, dict]] = {}

    def _cell(row, idx):
        if idx is None or idx >= len(row):
            return ""
        v = row[idx]
        return str(v).strip() if v is not None else ""

    # Tab names come from the constants the builder writes with, so renaming a tab in one
    # place cannot leave this reader matching nothing and loading only part of the
    # workbook. A missing sheet warns rather than passing quietly.
    suffix = "Existing Value" if from_existing else "Translation"
    for sheet_name, kind in [
        (MAIN_TAB,   "tab1"),
        (GENDER_TAB, "tab2"),
        (LABELS_TAB, "tab1"),
        (UI_TAB,     "ui"),
    ]:
        ws = next((s for s in wb.worksheets if s.title == sheet_name), None)
        if ws is None:
            print(f"Warning: sheet {sheet_name!r} not found in {excel_path.name} "
                  f"— nothing loaded from it.", file=sys.stderr)
            continue
        is_tab2 = kind == "tab2"
        rows = list(ws.iter_rows(values_only=True))
        if len(rows) < 3:
            print(f"Warning: sheet {sheet_name!r} has no data rows.", file=sys.stderr)
            continue
        headers = [str(h).strip() if h is not None else "" for h in rows[0]]

        # Locate base columns
        def col(name):
            try: return headers.index(name)
            except ValueError: return None

        type_col = col("type")
        if kind == "ui":
            # This tab replaces component/field/masterLabel with What it is/API Name/Section.
            comp_col, field_col, master_col = None, col("API Name"), col("Section")
            required = [type_col, field_col]
        else:
            comp_col   = col("component")
            field_col  = col("field")
            master_col = col("masterLabel")
            required = [type_col, comp_col, field_col, master_col]
        if any(c is None for c in required):
            print(f"Warning: sheet {sheet_name!r} is missing expected key columns "
                  f"— skipped.", file=sys.stderr)
            continue

        # Build per-language column index maps
        # Tab 1: "{LangName} Translation"
        # Tab 2: "{LangName} Singular Translation", "{LangName} Plural Translation", "{LangName} {Grammar label}"
        lang_cols: dict[str, dict[str, int | None]] = {}
        for lang in langs:
            name = LANGUAGE_NAMES.get(lang, lang)
            grammar = LANGUAGE_GRAMMAR.get(lang)
            if is_tab2:
                entry = {
                    "translation": col(f"{name} Singular {suffix}"),
                    "plural_translation": col(f"{name} Plural {suffix}"),
                    "gender": None, "startsWith": None, "article": None,
                }
                # Grammar columns are looked up by header name, so column order is irrelevant.
                # They have no Existing/Translation pair, so from_existing does not apply.
                for attr, label, _values in _tab2_grammar_cols(lang):
                    entry[attr] = col(f"{name} {label}")
                lang_cols[lang] = entry
            else:
                lang_cols[lang] = {"translation": col(f"{name} {suffix}"),
                                   "plural_translation": None, "gender": None,
                                   "startsWith": None, "article": None}

        for row in rows[2:]:  # skip header + banner
            if not row:
                continue
            row_type   = _cell(row, type_col)
            row_comp   = UI_COMPONENT if kind == "ui" else _cell(row, comp_col)
            row_field  = _cell(row, field_col)
            row_master = _cell(row, master_col)
            # The UI tab has no component of its own; its identity is type + API Name.
            if not row_comp or (kind == "ui" and not row_field):
                continue
            key = (row_type, row_comp, row_field, row_master)
            for lang, cols in lang_cols.items():
                t = _cell(row, cols["translation"])
                p = _cell(row, cols["plural_translation"])
                g = _cell(row, cols["gender"])
                # The sheet asks for "Vowel sound"/"Consonant sound"; the XML enum is
                # Vowel/Consonant. sw_metadata also passes the bare enum through, so a
                # workbook produced before this wording change still loads.
                sw = sw_metadata(_cell(row, cols["startsWith"]))
                art = _cell(row, cols["article"])
                # Skip placeholder/banner text that looks like a system value
                if t in ("", BANNER_DO_NOT_EDIT, BANNER_TO_POPULATE, _NOT_SUPPORTED, *_LEGACY_BANNERS):
                    t = ""
                if p in ("", BANNER_DO_NOT_EDIT, BANNER_TO_POPULATE, _NOT_SUPPORTED, *_LEGACY_BANNERS):
                    p = ""
                if t or p or g or sw or art:
                    edits.setdefault(key, {})[lang] = {
                        "translation": t, "plural_translation": p,
                        "gender": g, "startsWith": sw, "article": art,
                    }

    wb.close()
    return edits


def _load_translations(
    excel_path: Path, langs: list[str], default_dir: Path, input_dir: Path,
    from_existing: bool = False
) -> None:
    """Write Tab 1 + Tab 2 translations from the filled Excel back to XML metadata files.

    For each language:
      1. Load the source CSV (translations_{lang}.csv) that was generated during the pull step.
      2. Patch the translation/gender columns with values reviewers entered in the Excel.
      3. Write a patched temp CSV, then call translation_roundtrip.to_files() to emit XML.

    Blank Excel cells are treated as "keep existing" — only non-empty Translation values overwrite.
    """
    import csv as csv_mod
    import shutil
    import tempfile

    # Import to_files from the sibling script
    _tr_dir = str(Path(__file__).parent)
    if _tr_dir not in sys.path:
        sys.path.insert(0, _tr_dir)
    try:
        from translation_roundtrip import to_files as _to_files
    except ImportError as exc:
        sys.exit(f"Cannot import translation_roundtrip: {exc}")

    edits = _parse_excel_for_load(excel_path, langs, from_existing)
    if not edits:
        print("No translations found in Excel — nothing written.", file=sys.stderr)
        return

    total_patched = 0
    tmpdir = tempfile.mkdtemp(prefix="sf_load_translations_")
    try:
        processed = 0
        for lang in langs:
            src_csv = input_dir / f"translations_{lang}.csv"
            if not src_csv.is_file():
                print(f"  {LANGUAGE_NAMES.get(lang, lang)}: source CSV not found ({src_csv}) — skipped",
                      file=sys.stderr)
                continue

            with open(src_csv, encoding="utf-8", newline="") as fh:
                reader = csv_mod.DictReader(fh)
                fieldnames = list(reader.fieldnames or [])
                source_rows = list(reader)

            # Ensure optional columns exist (CSVs generated before these were added lack
            # them, and DictWriter rejects keys that aren't in fieldnames)
            for optional_col in ("plural_translation", "startsWith", "article"):
                if optional_col not in fieldnames:
                    fieldnames.append(optional_col)
                    for r in source_rows:
                        r.setdefault(optional_col, "")

            patched = 0
            if not grammar_known(lang):
                held = 0
                for row in source_rows:
                    if row.get("type") in GENDER_ROW_TYPES and (row.get("translation") or "").strip():
                        row["translation"] = ""
                        held += 1
                if held:
                    print(f"  {LANGUAGE_NAMES.get(lang, lang)}: {held} renamed-field/object-label "
                          "row(s) NOT written: this language's grammar rules are unknown "
                          "(see sf_languages.py)", file=sys.stderr)
            for row in source_rows:
                key = (row.get("type", ""), row.get("component", ""),
                       row.get("field", ""), row.get("masterLabel", ""))
                lang_edit = edits.get(key, {}).get(lang)
                if lang_edit and not grammar_known(lang) and row.get("type") in GENDER_ROW_TYPES:
                    lang_edit = None
                if lang_edit:
                    if lang_edit["translation"]:
                        row["translation"] = lang_edit["translation"]
                        patched += 1
                    if lang_edit["plural_translation"]:
                        row["plural_translation"] = lang_edit["plural_translation"]
                    if lang_edit["gender"]:
                        row["gender"] = lang_edit["gender"]
                    if lang_edit.get("article"):
                        row["article"] = lang_edit["article"]
                    if lang_edit.get("startsWith"):
                        row["startsWith"] = lang_edit["startsWith"]

            out_csv = Path(tmpdir) / f"translations_{lang}.csv"
            with open(out_csv, "w", encoding="utf-8", newline="") as fh:
                writer = csv_mod.DictWriter(fh, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(source_rows)

            print(f"  {LANGUAGE_NAMES.get(lang, lang)}: {patched} translation(s) applied",
                  file=sys.stderr)
            total_patched += patched

            # Write XML files for this language (root = force-app/main/default).
            # skip_untranslated=True so blank Excel cells don't emit empty <label>/<value>
            # tags — those would CLEAR existing org translations on deploy (and would emit
            # empty-value caseValues for gendered-but-untranslated standard fields).
            _to_files(default_dir, out_csv, skip_untranslated=True)
            processed += 1

        print(f"Wrote XML for {processed} language(s) — {total_patched} translation(s) total.",
              file=sys.stderr)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── Entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Combine per-language translation CSVs into a master Excel workbook.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--input-dir", type=Path, default=Path("."),
        help="Directory containing translation CSVs (default: current directory).",
    )
    parser.add_argument(
        "--output", default="master_translations.xlsx",
        help="Output Excel filename (default: master_translations.xlsx).",
    )
    parser.add_argument(
        "--pattern", default="translations_*.csv",
        help="Glob pattern for CSV files (default: translations_*.csv).",
    )
    parser.add_argument(
        "--compare-reviewer", type=Path, default=None, metavar="REVIEWER_FILE",
        help="Path to a reviewer-provided Excel file. Rows with no translations in that file are highlighted pink.",
    )
    parser.add_argument(
        "--org", default=None, metavar="ORG_ALIAS",
        help="Salesforce org alias. When provided, fetches current SF object labels to pre-fill Existing Value columns on the Object Names tab.",
    )
    parser.add_argument(
        "--load-object-names", type=Path, default=None, metavar="EXCEL_FILE",
        help="Read Object Names tab from EXCEL_FILE and write <caseValues> XML back to objectTranslation files.",
    )
    parser.add_argument(
        "--load-translations", type=Path, default=None, metavar="EXCEL_FILE",
        help=f"Read filled Translation columns from EXCEL_FILE ({MAIN_TAB}, {GENDER_TAB}, "
             f"{LABELS_TAB}, {UI_TAB}) and write XML back via "
             "translation_roundtrip.to_files().",
    )
    parser.add_argument(
        "--skip-incomplete-grammar", action="store_true",
        help="With --load-object-names, omit any (object, language) whose required "
             "gender/startsWith is missing. Such a component cannot deploy at all, so "
             "including it only turns a partial row into a failed one. Use when seeding "
             "another org with whatever grammar the source org actually has.",
    )
    parser.add_argument(
        "--from-existing", action="store_true",
        help="With --load-translations or --load-object-names, read each language's "
             "'Existing Value' column instead of its 'Translation' column. Use this to seed "
             "a new org from the values the source org already holds, when the Translation "
             "columns are still empty because translators have not returned the workbook.",
    )
    args = parser.parse_args()

    # Early exit: write-back mode (--load-translations)
    if args.load_translations:
        if not args.load_translations.exists():
            sys.exit(f"File not found: {args.load_translations}")
        default_dir = _find_default_dir(args.input_dir)
        if not default_dir:
            sys.exit("Cannot find force-app/main/default — run from the project root.")
        # Determine which languages to process from the CSVs present
        data = load_csvs(args.input_dir, args.pattern)
        present_langs = {lang for lang_rows in data.values() for lang in lang_rows}
        require_known(present_langs, f"language CSVs in {args.input_dir}")
        langs = order_languages(present_langs)
        print(f"Languages: {', '.join(LANGUAGE_NAMES.get(l, l) for l in langs)}", file=sys.stderr)
        _load_translations(args.load_translations, langs, default_dir, args.input_dir,
                           args.from_existing)
        return

    # Early exit: write-back mode (--load-object-names)
    if args.load_object_names:
        if not args.load_object_names.exists():
            sys.exit(f"File not found: {args.load_object_names}")
        default_dir = _find_default_dir(args.input_dir)
        if not default_dir:
            sys.exit("Cannot find force-app/main/default — run from the project root.")
        obj_data = _parse_object_names_excel(args.load_object_names, ORDERED_LANGS,
                                             args.from_existing)
        _write_object_names_xml(default_dir, obj_data, args.skip_incomplete_grammar)
        return

    data = load_csvs(args.input_dir, args.pattern)

    present_langs = {lang for lang_rows in data.values() for lang in lang_rows}
    require_known(present_langs, f"language CSVs in {args.input_dir}")
    langs = order_languages(present_langs)
    print(f"Languages: {', '.join(LANGUAGE_NAMES.get(l, l) for l in langs)}", file=sys.stderr)
    assign_lang_colors(langs)

    wb = openpyxl.Workbook()

    # Resolved before Tab 1 so the layout-section filter can find Source_en_US*.stf.
    default_dir = _find_default_dir(args.input_dir)
    project_root = default_dir.parent.parent.parent if default_dir else None

    ws1 = wb.active
    ws1.title = MAIN_TAB
    # No layout-section classification here — see the RETIRED note above _source_layout_keys.
    excluded_keys = build_tab1(ws1, data, langs)
    style_sheet(ws1)
    n_ls = sum(1 for k in data if k[0] == "layout-section")
    if n_ls:
        print(f"Layout sections: {n_ls} row(s) on '{MAIN_TAB}', unclassified. Run "
              "classify_layout_sections.py then apply_layout_verdicts.py to split out "
              "the Salesforce-owned ones before sending this workbook to anyone.",
              file=sys.stderr)

    # Load object labels and gender from the org BEFORE building Tab 2 so the
    # grammar (gender) Translation column can be pre-populated on generation.
    object_labels = _load_object_labels(args.input_dir)

    existing_obj_data = _read_existing_object_names(default_dir, langs, list(object_labels.keys()))
    sf_labels: dict = {}
    sf_genders: dict = {}
    if args.org:
        sf_labels = _fetch_sf_object_labels(list(object_labels.keys()), langs, args.org)
        # Pre-fill gender/startsWith from the target org (authoritative per-org); the org
        # value wins over local XML wherever it's set, else local XML is kept.
        sf_genders = _fetch_sf_object_genders(list(object_labels.keys()), langs, args.org)
        for key, gd in sf_genders.items():
            # _fetch_sf_object_genders returns two key shapes: (obj, lang) for the object's
            # own grammar and (obj, field, lang) for a renamed standard field's. Only the
            # object-level entries belong in existing_obj_data (Tab 3); the per-field ones
            # are consumed directly by build_rename_tabs via the 3-tuple lookup.
            if len(key) != 2:
                continue
            obj, lang = key
            lang_d = existing_obj_data.setdefault(obj, {}).setdefault(
                lang, {"values": {}, "gender": "", "startsWith": ""}
            )
            if gd.get("gender"):
                lang_d["gender"] = gd["gender"]
            if gd.get("startsWith"):
                lang_d["startsWith"] = gd["startsWith"]
            if gd.get("values"):
                lang_d["values"].update(gd["values"])

    ws2 = wb.create_sheet(GENDER_TAB)
    tab2_grammar_cols = build_rename_tabs(ws2, data, langs, sf_genders=sf_genders)
    style_sheet(ws2)
    # Mark grammar columns Required AFTER style_sheet (which overwrites row 2). Salesforce
    # rejects the row outright when one of these is blank, so they are not optional.
    for col in tab2_grammar_cols:
        cell = ws2.cell(row=2, column=col)
        cell.value = BANNER_REQUIRED
        cell.fill = _REQUIRED_FILL
        cell.font = _REQUIRED_FONT

    ws3 = wb.create_sheet(OBJNAMES_TAB)
    obj_names_cache = _load_obj_names_cache(Path(__file__).parent)
    grammar_cols = build_object_names_tab(ws3, object_labels, langs, existing_data=existing_obj_data, sf_labels=sf_labels, obj_names_cache=obj_names_cache)
    style_sheet(ws3)
    ws3.freeze_panes = "D3"  # Object Names has only 3 base columns
    # Apply Required styling to gender/startsWith columns AFTER style_sheet (which overwrites row 2)
    for col in grammar_cols:
        cell = ws3.cell(row=2, column=col)
        cell.value = BANNER_REQUIRED
        cell.fill = _REQUIRED_FILL
        cell.font = _REQUIRED_FONT

    ws4 = wb.create_sheet(LABELS_TAB)
    build_custom_labels_tab(ws4, data, langs, project_root=project_root)
    style_sheet(ws4)

    ws5 = wb.create_sheet(UI_TAB)
    build_ui_labels_tab(ws5, data, langs)
    style_sheet(ws5)

    # Last tab: what was held back, so the exclusion is visible rather than silent.
    # Deliberately NOT run through style_sheet — that rewrites row 2, which here is a
    # spacer under the explanation rather than a banner row.
    if excluded_keys:
        build_excluded_tab(wb.create_sheet(EXCLUDED_TAB), data, excluded_keys, langs)

    if args.compare_reviewer:
        if not args.compare_reviewer.exists():
            print(f"Warning: --compare-reviewer file not found: {args.compare_reviewer}",
                  file=sys.stderr)
        else:
            skipped_keys = _build_skipped_keys(args.compare_reviewer)
            if skipped_keys:
                apply_pink_highlight(wb, skipped_keys)

    wb.save(args.output)
    print(f"Saved {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
