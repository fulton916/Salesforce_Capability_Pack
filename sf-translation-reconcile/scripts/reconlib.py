# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Shared helpers for sf-translation-reconcile. Standard library + openpyxl only.

Reading the org
---------------
Two read sources, both produced by commands you run yourself:

* a metadata retrieve in metadata (mdapi) format
  (`sf project retrieve start --manifest m.xml --target-metadata-dir DIR --unzip`)
* a Translation Workbench Bilingual export (one `Bilingual_<lang>_<date>.stf` per language)

Every value is keyed the way the Bilingual export keys it, for example
`CustomField.Account.Region.FieldLabel` or `PicklistValue.Widget__c.Color.Red`, so the two
sources can be compared and combined. When both hold a value the retrieve wins (it is the
fresher, file-level read); the export fills what a retrieve cannot show (inactive picklist
values, some managed-package content).

A retrieve only returns translation content for parents named in the SAME manifest
(CustomObject + Layout for CustomObjectTranslation, the value set for a value-set
translation, CustomLabel for Translations). A read built any other way looks empty and
must not be trusted.

Status of one (language, item) in the org:
    held        a translation is there (value returned)
    empty       the org knows the item and holds no translation
    unreadable  the org defines the item but no source can show its translation
    absent      no source lists the item at all
"""
from __future__ import annotations

import collections
import csv
import glob
import hashlib
import json
import os
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

NS_URI = "http://soap.sforce.com/2006/04/metadata"
NS = "{" + NS_URI + "}"
ET.register_namespace("", NS_URI)
DEFAULT_API_VERSION = "62.0"

# Display name (lower case) -> Salesforce language code, as Translation Workbench names
# them. A reference, not a list of languages any org must have. Extend or replace with
# --lang-map.
DEFAULT_LANG_MAP = {
    "english": "en_US", "english (canada)": "en_CA", "english (india)": "en_IN",
    "english (uk)": "en_GB", "arabic": "ar", "bulgarian": "bg",
    "chinese (simplified)": "zh_CN", "chinese (traditional)": "zh_TW", "croatian": "hr",
    "czech": "cs", "danish": "da", "dutch": "nl_NL", "dutch (belgium)": "nl_BE",
    "estonian": "et", "finnish": "fi", "french": "fr", "french (belgium)": "fr_BE",
    "french (canada)": "fr_CA", "french (switzerland)": "fr_CH", "german": "de",
    "german (austria)": "de_AT", "german (switzerland)": "de_CH", "greek": "el",
    "hebrew": "iw", "hindi": "hi", "hungarian": "hu", "indonesian": "in", "irish": "ga",
    "italian": "it", "italian (switzerland)": "it_CH", "japanese": "ja", "kazakh": "kk",
    "korean": "ko", "latvian": "lv", "lithuanian": "lt", "malay": "ms", "maltese": "mt",
    "norwegian": "no", "polish": "pl", "portuguese (brazil)": "pt_BR",
    "portuguese (european)": "pt_PT", "romanian": "ro", "russian": "ru",
    "serbian (cyrillic)": "sr", "serbian (latin)": "sh", "slovak": "sk", "slovenian": "sl",
    "spanish": "es", "spanish (mexico)": "es_MX", "swedish": "sv", "thai": "th",
    "turkish": "tr", "ukrainian": "uk", "vietnamese": "vi", "welsh": "cy",
}

# Row types understood across the toolset (the workbook "type" column).
ROW_TYPES = {
    "field-label", "field-help", "field-relationship-label", "field-picklist", "record-type",
    "validation-rule", "layout-section", "web-link", "global-value", "standard-value",
    "custom-label", "custom-tab", "custom-app", "quick-action", "report-type",
    "report-type-section", "standard-field",
}
FIELD_TYPES = {"field-label", "field-help", "field-relationship-label", "field-picklist"}
# Task and Event are views over Activity: their custom fields are stored under Activity.
SHARED_PARENT = {"Task": "Activity", "Event": "Activity"}
PREFIX_TYPES = {"layout-section"}          # export keys carry a positional _<n> suffix
TRANSLATION_FOLDERS = {
    "objectTranslations": "CustomObjectTranslation",
    "globalValueSetTranslations": "GlobalValueSetTranslation",
    "standardValueSetTranslations": "StandardValueSetTranslation",
    "translations": "Translations",
}
_POS = re.compile(r"_\d+$")


def die(msg: str, code: int = 2) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def utf8_stdout() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


def s(v) -> str:
    """Cell value as text, EXACT (no strip). None -> ''."""
    return "" if v is None else str(v)


def norm_ws(x) -> str:
    return " ".join(s(x).split())


def lower1(x: str) -> str:
    return x[:1].lower() + x[1:]


def base_field(f: str) -> str:
    """The export drops the __c suffix of custom field names."""
    return f[:-3] if f.endswith("__c") else f


def stored_obj(typ: str, obj: str) -> str:
    """The object a slot is stored under: Task/Event fields live under Activity."""
    return SHARED_PARENT.get(obj, obj) if typ in FIELD_TYPES else obj


def sha256_dir(d) -> str:
    """Hash of every file under d (relative path + bytes), order-independent of the OS."""
    d = Path(d)
    h = hashlib.sha256()
    for p in sorted(x for x in d.rglob("*") if x.is_file()):
        h.update(p.relative_to(d).as_posix().encode("utf-8") + b"\0")
        h.update(p.read_bytes() + b"\0")
    return h.hexdigest()


def load_json(path):
    with open(path, encoding="utf-8-sig") as fh:
        return json.load(fh)


def dump_json(obj, path) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1, default=_json_default)


def _json_default(o):
    if isinstance(o, (set, frozenset)):
        return sorted(o)
    if isinstance(o, collections.Counter):
        return dict(o)
    raise TypeError(type(o))


# ───────────────────────────────── languages ─────────────────────────────────

def load_lang_map(path=None) -> dict[str, str]:
    """display name (lower) -> code. A JSON file {"German": "de", ...} extends the default."""
    m = dict(DEFAULT_LANG_MAP)
    if path:
        for k, v in load_json(path).items():
            m[str(k).strip().lower()] = v
    return m


def split_lang_header(header, lang_map: dict[str, str]):
    """('de_AT', 'Existing Value') from 'German (Austria) Existing Value', or from
    'de_AT Existing Value'. (None, header) when no language prefix matches."""
    h = s(header).strip()
    low = h.lower()
    for name in sorted(lang_map, key=len, reverse=True):     # longest first
        if low.startswith(name + " "):
            return lang_map[name], h[len(name) + 1:]
    codes = set(lang_map.values())
    first, _, rest = h.partition(" ")
    if first in codes and rest:
        return first, rest
    return None, h


def lang_columns(header, suffix: str, lang_map) -> dict[int, str]:
    """{column index: language code} for headers '<Language> <suffix>'."""
    out = {}
    for i, h in enumerate(header):
        code, rest = split_lang_header(h, lang_map)
        if code and rest == suffix:
            out[i] = code
    return out


def lang_name(code: str, lang_map) -> str:
    for k, v in lang_map.items():
        if v == code:
            return k.title()
    return code


# ───────────────────────────────── keys ─────────────────────────────────

def stf_keys(typ: str, comp: str, field: str, item: str) -> list[str]:
    """Candidate Bilingual-export keys for one workbook row, best guess first."""
    comp, field, item = s(comp), s(field), s(item)
    b = base_field(field)
    comps = [comp] + ([SHARED_PARENT[comp]] if comp in SHARED_PARENT else [])
    if comp == "Knowledge__kav":
        comps.append("Knowledge__c")      # the export files Knowledge fields under __c
    if typ == "field-label":
        return [f"CustomField.{c}.{b}.FieldLabel" for c in comps]
    if typ == "field-help":
        return [f"CustomField.{c}.{b}.HelpText" for c in comps]
    if typ == "field-relationship-label":
        return [f"CustomField.{c}.{b}.RelatedListLabel" for c in comps]
    if typ == "field-picklist":
        return [f"PicklistValue.{c}.{b}.{item}" for c in comps]
    if typ in ("global-value", "standard-value"):
        # value sets are keyed by the SET; the standard form lower-cases the first letter
        return [f"PicklistValue.{comp}__gvs.{item}", f"PicklistValue.Standard.{lower1(comp)}.{item}"]
    if typ == "record-type":
        return [f"RecordType.{comp}.{field}"]
    if typ == "validation-rule":
        return [f"ValidationFormula.{comp}.{field}"]
    if typ == "web-link":
        return [f"ButtonOrLink.{comp}.{field}"]
    if typ == "layout-section":
        return [f"LayoutSection.{c}.{field}.{item}" for c in comps]
    if typ == "custom-label":
        return [f"CustomLabel.{field}"]
    if typ == "quick-action":
        return [f"QuickAction.{field}"]
    if typ == "custom-tab":
        return [f"WebTab.{field}"]
    if typ == "custom-app":
        return [f"CustomApp.{field}"]
    if typ == "report-type":
        return [f"CustomReportType.{field}.Name"]
    if typ == "report-type-section":
        return [f"CrtLayoutSection.{field}.{item}"]
    return []


def strip_pos(k: str) -> str:
    return _POS.sub("", k)


# ───────────────────────────────── Bilingual .stf ─────────────────────────────────

_STF_NAME = re.compile(r"Bilingual_(.+?)_(\d{4}-\d{2}-\d{2}(?:[ _]\d{4})?)")


def find_stf(stf_dir) -> dict[str, Path]:
    """{lang: newest Bilingual_<lang>_<date>.stf} under stf_dir (recursive)."""
    out: dict[str, tuple[str, Path]] = {}
    for p in glob.glob(os.path.join(str(stf_dir), "**", "Bilingual_*.stf"), recursive=True):
        m = _STF_NAME.match(os.path.basename(p))
        if m and (m.group(1) not in out or m.group(2) > out[m.group(1)][0]):
            out[m.group(1)] = (m.group(2), Path(p))
    return {k: v[1] for k, v in out.items()}


def _unescape_stf(v: str) -> str:
    # The export writes a line break inside a value as the two characters \n.
    return v.replace("\\r", "\r").replace("\\n", "\n").replace("\\t", "\t")


class StfFile:
    """One language of a Bilingual export.

    held     {key: translation}   rows that carry a translation
    present  {key}                every key the export lists (translated or not)
    source   {key: English text}
    truncated  True when the file does not end in a newline (a cut-off download)
    """

    def __init__(self, path):
        text = Path(path).read_bytes().decode("utf-8-sig", "replace")
        self.path = Path(path)
        self.truncated = bool(text) and not text.endswith("\n")
        self.held: dict[str, str] = {}
        self.present: set[str] = set()
        self.source: dict[str, str] = {}
        for line in text.split("\n"):
            line = line.rstrip("\r")
            if not line or line.startswith("#") or "\t" not in line:
                continue
            parts = line.split("\t")
            key = parts[0]
            if not key or "." not in key:
                continue
            self.present.add(key)
            self.source[key] = _unescape_stf(parts[1]) if len(parts) > 1 else ""
            if len(parts) >= 3 and parts[2].strip():
                self.held[key] = _unescape_stf(parts[2])
        self.held_pos = {}
        self.present_pos = set()
        for k in self.present:
            b = strip_pos(k)
            if b != k:
                self.present_pos.add(b)
                if k in self.held:
                    self.held_pos.setdefault(b, self.held[k])
        # report-type sections are numbered: (report type, English label) -> keys
        self.crt = collections.defaultdict(list)
        for k in self.present:
            m = re.fullmatch(r"CrtLayoutSection\.(.+)_(\d+)", k)
            if m:
                self.crt[(m.group(1), self.source.get(k, ""))].append(k)


def load_stf_dir(stf_dir) -> dict[str, StfFile]:
    files = find_stf(stf_dir)
    if not files:
        die(f"no Bilingual_*.stf found under {stf_dir}")
    return {lang: StfFile(p) for lang, p in files.items()}


# ───────────────────────────────── retrieve ─────────────────────────────────

def find_root(d) -> Path:
    """The folder of a retrieve that holds package.xml (shallowest), else d itself."""
    d = Path(d)
    hits = sorted(d.rglob("package.xml"), key=lambda p: len(p.parts))
    return hits[0].parent if hits else d


def _stem(p) -> str:
    return urllib.parse.unquote(os.path.basename(str(p)).rsplit(".", 1)[0])


def _t(e, tag: str) -> str:
    # ElementTree drops comments, so an untranslated <label><!-- English --></label> reads "".
    return (e.findtext(NS + tag) or "") if e is not None else ""


def parse_xml(path, keep_comments: bool = False):
    if keep_comments:
        return ET.parse(str(path), parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True)))
    return ET.parse(str(path))


class RetrieveRead:
    """Everything a set of mdapi retrieve folders says about translations and definitions."""

    def __init__(self, dirs):
        self.vals = collections.defaultdict(dict)        # lang -> key -> value ('' = untranslated)
        self.files = set()                               # (kind, parent, lang)
        self.fields = collections.defaultdict(dict)      # obj -> field -> {label, values, gvs}
        self.rts = collections.defaultdict(dict)         # obj -> name -> (label, active)
        self.vrs = collections.defaultdict(dict)         # obj -> name -> (message, active)
        self.layouts = {}                                # (obj, layout) -> [section labels]
        self.gvs = {}                                    # set -> {label: active}
        self.svs = {}                                    # set -> {label: active}
        self.labels = {}                                 # name -> (english, protected)
        self.defined_named = collections.defaultdict(dict)   # quick-action/custom-tab/... -> name -> label
        for d in dirs:
            root = find_root(d)
            for p in sorted(root.rglob("*")):
                if p.is_file():
                    self._read(p)

    # translation files ------------------------------------------------------
    def _read(self, p: Path) -> None:
        n = p.name
        try:
            if n.endswith(".objectTranslation"):
                self._ot(p)
            elif n.endswith(".globalValueSetTranslation") or n.endswith(".standardValueSetTranslation"):
                self._vst(p)
            elif n.endswith(".translation"):
                self._tr(p)
            elif n.endswith(".object"):
                self._obj(p)
            elif n.endswith(".layout"):
                self._layout(p)
            elif n.endswith(".globalValueSet"):
                self.gvs[_stem(p)] = self._values(p, "customValue")
            elif n.endswith(".standardValueSet"):
                self.svs[_stem(p)] = self._values(p, "standardValue")
            elif n.endswith(".labels"):
                for e in parse_xml(p).getroot().findall(NS + "labels"):
                    self.labels[_t(e, "fullName")] = (_t(e, "value"), _t(e, "protected") == "true")
            elif n.endswith(".quickAction"):
                self.defined_named["quick-action"][_stem(p)] = _t(parse_xml(p).getroot(), "label")
            elif n.endswith(".tab"):
                self.defined_named["custom-tab"][_stem(p)] = _t(parse_xml(p).getroot(), "label")
            elif n.endswith(".app"):
                self.defined_named["custom-app"][_stem(p)] = _t(parse_xml(p).getroot(), "label")
        except ET.ParseError as exc:
            die(f"cannot parse {p}: {exc}")

    def _put(self, lang, key, val):
        self.vals[lang][key] = val

    def _ot(self, p):
        obj, lang = _stem(p).rsplit("-", 1)
        self.files.add(("obj", obj, lang))
        root = parse_xml(p).getroot()
        for f in root.findall(NS + "fields"):
            n = base_field(_t(f, "name"))
            for tag, kind in (("label", "FieldLabel"), ("help", "HelpText"),
                              ("relationshipLabel", "RelatedListLabel")):
                if f.find(NS + tag) is not None:
                    self._put(lang, f"CustomField.{obj}.{n}.{kind}", _t(f, tag))
            for pv in f.findall(NS + "picklistValues"):
                self._put(lang, f"PicklistValue.{obj}.{n}.{_t(pv, 'masterLabel')}", _t(pv, "translation"))
        for r in root.findall(NS + "recordTypes"):
            self._put(lang, f"RecordType.{obj}.{_t(r, 'name')}", _t(r, "label"))
        for v in root.findall(NS + "validationRules"):
            self._put(lang, f"ValidationFormula.{obj}.{_t(v, 'name')}", _t(v, "errorMessage"))
        for w in root.findall(NS + "webLinks"):
            self._put(lang, f"ButtonOrLink.{obj}.{_t(w, 'name')}", _t(w, "label"))
        for q in root.findall(NS + "quickActions"):
            self._put(lang, f"QuickAction.{obj}.{_t(q, 'name')}", _t(q, "label"))
        for L in root.findall(NS + "layouts"):
            for sec in L.findall(NS + "sections"):
                self.vals[lang].setdefault(
                    f"LayoutSection.{obj}.{_t(L, 'layout')}.{_t(sec, 'section')}", _t(sec, "label"))

    def _vst(self, p):
        name, lang = _stem(p).rsplit("-", 1)
        std = p.name.endswith(".standardValueSetTranslation")
        self.files.add(("svs" if std else "gvs", name, lang))
        for v in parse_xml(p).getroot().findall(NS + "valueTranslation"):
            key = (f"PicklistValue.Standard.{lower1(name)}.{_t(v, 'masterLabel')}" if std
                   else f"PicklistValue.{name}__gvs.{_t(v, 'masterLabel')}")
            self._put(lang, key, _t(v, "translation"))

    def _tr(self, p):
        lang = _stem(p)
        self.files.add(("tr", "", lang))
        root = parse_xml(p).getroot()
        for tag, kind in (("customLabels", "CustomLabel"), ("customApplications", "CustomApp"),
                          ("customTabs", "WebTab"), ("quickActions", "QuickAction")):
            for e in root.findall(NS + tag):
                self._put(lang, f"{kind}.{_t(e, 'name')}", _t(e, "label"))
        for rt in root.findall(NS + "reportTypes"):
            n = _t(rt, "name")
            self._put(lang, f"CustomReportType.{n}.Name", _t(rt, "label"))
            for sec in rt.findall(NS + "sections"):
                self._put(lang, f"CrtLayoutSection.{n}.{_t(sec, 'name')}", _t(sec, "label"))

    # definitions ------------------------------------------------------------
    @staticmethod
    def _values(p, tag):
        out = {}
        for v in parse_xml(p).getroot().iter(NS + tag):
            out[_t(v, "label") or _t(v, "fullName")] = (_t(v, "isActive") or "true") != "false"
        return out

    def _obj(self, p):
        obj = _stem(p)
        root = parse_xml(p).getroot()
        for f in root.findall(NS + "fields"):
            vs = f.find(NS + "valueSet")
            gvs = _t(vs, "valueSetName") if vs is not None else ""
            values = {}
            if vs is not None and not gvs:
                for v in vs.iter(NS + "value"):
                    values[_t(v, "label") or _t(v, "fullName")] = (_t(v, "isActive") or "true") != "false"
            self.fields[obj][_t(f, "fullName")] = {"label": _t(f, "label"), "help": _t(f, "inlineHelpText"),
                                                   "values": values, "gvs": gvs}
        for r in root.findall(NS + "recordTypes"):
            self.rts[obj][_t(r, "fullName")] = (_t(r, "label"), (_t(r, "active") or "true") == "true")
        for v in root.findall(NS + "validationRules"):
            self.vrs[obj][_t(v, "fullName")] = (_t(v, "errorMessage"), (_t(v, "active") or "true") == "true")

    def _layout(self, p):
        obj, lay = _stem(p).split("-", 1)
        self.layouts[(obj, lay)] = [_t(s_, "label") for s_ in parse_xml(p).getroot().findall(NS + "layoutSections")
                                    if _t(s_, "customLabel") == "true" and _t(s_, "label")]

    def gvs_of(self, obj: str, field: str) -> str:
        o = stored_obj("field-picklist", obj)
        return (self.fields.get(o, {}).get(field) or self.fields.get(obj, {}).get(field) or {}).get("gvs", "")

    def defines(self, typ, comp, field, item):
        """True/False when the retrieved definitions settle whether the item exists, else None."""
        o = stored_obj(typ, comp)
        if typ in FIELD_TYPES:
            fl = self.fields.get(o) or self.fields.get(comp)
            if fl is None:
                return None
            f = fl.get(field)
            if f is None:
                return False
            if typ == "field-picklist":
                if f["gvs"]:
                    return self._set_has(self.gvs, f["gvs"], item)
                return item in f["values"]
            return True
        if typ == "record-type":
            return (field in self.rts[comp]) if comp in self.rts or comp in self.fields else None
        if typ == "validation-rule":
            return (field in self.vrs[comp]) if comp in self.vrs or comp in self.fields else None
        if typ == "global-value":
            return self._set_has(self.gvs, comp, item)
        if typ == "standard-value":
            return self._set_has(self.svs, comp, item)
        if typ == "custom-label":
            return (field in self.labels) if self.labels else None
        if typ == "layout-section":
            secs = self.layouts.get((comp, field))
            return None if secs is None else item in secs
        return None

    @staticmethod
    def _set_has(sets, name, item):
        return None if name not in sets else item in sets[name]

    def active(self, typ, comp, field, item) -> bool | None:
        o = stored_obj(typ, comp)
        if typ == "field-picklist":
            f = (self.fields.get(o) or {}).get(field)
            if not f:
                return None
            vals = self.gvs.get(f["gvs"], {}) if f["gvs"] else f["values"]
            return vals.get(item)
        if typ == "global-value":
            return self.gvs.get(comp, {}).get(item)
        if typ == "standard-value":
            return self.svs.get(comp, {}).get(item)
        return None


# ───────────────────────────────── combined org state ─────────────────────────────────

class OrgState:
    """Retrieve (wins) + Bilingual export (fallback), queried per workbook row."""

    def __init__(self, retrieve_dirs=None, stf_dir=None):
        self.ret = RetrieveRead(retrieve_dirs) if retrieve_dirs else None
        self.stf = load_stf_dir(stf_dir) if stf_dir else {}
        if not self.ret and not self.stf:
            die("give at least one --retrieve folder or an --stf-dir")
        self.universe = set()
        for f in self.stf.values():
            self.universe |= f.present
        self.universe_pos = {strip_pos(k) for k in self.universe}

    def langs(self) -> set[str]:
        out = set(self.stf)
        if self.ret:
            out |= set(self.ret.vals)
        return out

    def keys_for(self, typ, comp, field, item) -> list[str]:
        ks = stf_keys(typ, comp, field, item)
        if typ == "field-picklist" and self.ret:
            vs = self.ret.gvs_of(comp, field)
            if vs:
                ks.append(f"PicklistValue.{vs}__gvs.{item}")
        if typ == "quick-action" and "." in s(field):
            ks.insert(0, f"QuickAction.{field}")
        return ks

    def lookup(self, lang, typ, comp, field, item):
        """(status, value, key, source). status: held | empty | unreadable | absent."""
        ks = self.keys_for(typ, comp, field, item)
        known_empty = None
        if self.ret:
            rv = self.ret.vals.get(lang, {})
            for k in ks:
                if k in rv:
                    if rv[k] != "":
                        return "held", rv[k], k, "retrieve"
                    known_empty = known_empty or k
        f = self.stf.get(lang)
        if f:
            for k in ks:
                if k in f.held:
                    return "held", f.held[k], k, "export"
                if typ in PREFIX_TYPES and k in f.held_pos:
                    return "held", f.held_pos[k], k, "export"
            if typ == "report-type-section":
                hits = f.crt.get((s(field), s(item)), [])
                if len(hits) == 1:
                    k = hits[0]
                    return ("held", f.held[k], k, "export") if k in f.held else ("empty", None, k, "export")
            for k in ks:
                if k in f.present or (typ in PREFIX_TYPES and k in f.present_pos):
                    known_empty = known_empty or k
        if known_empty:
            return "empty", None, known_empty, "retrieve" if self.ret else "export"
        if self.ret:
            d = self.ret.defines(typ, comp, field, item)
            if d:
                return "unreadable", None, ks[0] if ks else "", "retrieve"
        if any(k in self.universe or (typ in PREFIX_TYPES and k in self.universe_pos) for k in ks):
            return "empty", None, ks[0], "export"
        return "absent", None, ks[0] if ks else "", ""

    def english_source(self, typ, comp, field, item):
        """The org's English text for an item, from the export's source column."""
        for f in self.stf.values():
            for k in self.keys_for(typ, comp, field, item):
                if k in f.source:
                    return f.source[k]
                if typ in PREFIX_TYPES:
                    for present_key in f.present:
                        if strip_pos(present_key) == k:
                            return f.source.get(present_key)
        return None


# ───────────────────────────────── workbooks ─────────────────────────────────

DEFAULT_COLS = {"type": "type", "component": "component", "field": "field", "item": "masterLabel",
                "english": "English"}


def parse_cols(spec: str | None) -> dict[str, str]:
    """'type=Kind,item=Value' -> column-name overrides on top of DEFAULT_COLS."""
    cols = dict(DEFAULT_COLS)
    if spec:
        for part in spec.split(","):
            k, _, v = part.partition("=")
            if k.strip() not in cols:
                die(f"--cols: unknown key {k!r} (known: {', '.join(cols)})")
            cols[k.strip()] = v.strip()
    return cols


def open_workbook(path, read_only=False):
    import openpyxl
    keep_vba = str(path).lower().endswith(".xlsm")
    return openpyxl.load_workbook(str(path), read_only=read_only, keep_vba=keep_vba and not read_only,
                                  data_only=read_only)


def iter_rows(path, cols, sheets=None, suffix=None, lang_map=None):
    """Yield (sheet, row_number, row_dict, {lang: (col_index, value)}) for every data row.

    A data row is one whose type cell holds a known row type, so banner rows ("Do Not Edit")
    and blank rows are skipped by content wherever they sit. Key cells are NOT stripped:
    some org labels carry a trailing space and a stripped key would miss them.
    """
    wb = open_workbook(path, read_only=True)
    names = sheets or wb.sheetnames
    for name in names:
        if name not in wb.sheetnames:
            die(f"{path}: no sheet {name!r}")
        rows = wb[name].iter_rows(values_only=True)
        hdr = list(next(rows, ()) or ())
        idx = {s(h).strip(): i for i, h in enumerate(hdr) if h is not None}
        if cols["type"] not in idx:
            continue
        lc = lang_columns(hdr, suffix, lang_map) if suffix else {}
        for rn, r in enumerate(rows, start=2):
            g = (lambda key: s(r[idx[cols[key]]]) if cols[key] in idx and idx[cols[key]] < len(r) else "")
            typ = g("type").strip()
            if typ not in ROW_TYPES:
                continue
            row = {"type": typ, "component": g("component"), "field": g("field"), "item": g("item"),
                   "english": g("english")}
            vals = {code: (i, s(r[i]) if i < len(r) else "") for i, code in lc.items()}
            yield name, rn, row, vals
    wb.close()


def write_xlsx(path, sheets: dict[str, tuple[list[str], list[list]]]) -> None:
    """Simple report workbook: {title: (header, rows)}."""
    import openpyxl
    from openpyxl.styles import Font, PatternFill
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for title, (hdr, rows) in sheets.items():
        ws = wb.create_sheet(title[:31])
        ws.append(hdr)
        for c in ws[1]:
            c.font = Font(bold=True, color="FFFFFF")
            c.fill = PatternFill("solid", fgColor="1F3864")
        for r in rows:
            ws.append(list(r))
        ws.freeze_panes = "A2"
    if not wb.sheetnames:
        wb.create_sheet("Empty")
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(path))


def read_table(path, sheet=None) -> list[dict]:
    """Rows of a .csv / .xlsx / .xlsm as dicts (values exact; numbers become text)."""
    p = str(path)
    if p.lower().endswith(".csv"):
        with open(p, newline="", encoding="utf-8-sig") as fh:
            return [dict(r, __row__=i) for i, r in enumerate(csv.DictReader(fh), start=2)]
    wb = open_workbook(p, read_only=True)
    ws = wb[sheet] if sheet else wb.worksheets[0]
    it = ws.iter_rows(values_only=True)
    hdr = [s(h).strip() for h in next(it, ())]
    out = []
    for i, r in enumerate(it, start=2):
        if r is None or all(v is None for v in r):
            continue
        d = {h: r[j] if j < len(r) else None for j, h in enumerate(hdr) if h}
        d["__row__"] = i
        out.append(d)
    wb.close()
    return out
