"""Leaf-level view of Salesforce translation metadata files, and where a translation key lives.

A translation file is reduced to {signature: text} for EVERY leaf element: labels, picklist
translations, record-type descriptions, caseValues, gender, help texts, everything. A signature is
a tuple ((tag, id), ..., leaf_tag). Ids may contain '.', '/' or spaces, which is why it is a tuple
and not a string. A translation key maps to exactly one signature, so "nothing but the targets
changed" is a plain dict comparison with no element type left unchecked.

Values are kept RAW (not stripped): a whitespace-only change is a change. A slot counts as EMPTY
when its value is empty after stripping (a retrieve shows an untranslated slot as an empty element
or an XML comment, which the parser drops).

Translation keys use the Translation Workbench (.stf) spelling, for example:
  CustomField.Widget__c.Color.FieldLabel        CustomField.Widget__c.Color.HelpText
  PicklistValue.Widget__c.Color.Red             PicklistValue.Colors__gvs.Green
  PicklistValue.Standard.LeadSource.Web         RecordType.Widget__c.Big.Name
  ValidationFormula.Widget__c.Size_Required.ErrorMessage
  LayoutSection.Widget__c.Widget Layout.Details CustomLabel.Greeting
  CustomApp.Widget_Console                      WebTab.Widget__c
  CustomReportType.Widgets_with_Parts.Name      QuickAction.New_Widget / QuickAction.Account.Log_Call
  WebLink.Widget__c.Open_Map                    ReportTypeSection.Widgets_with_Parts.Widgets  (*)
(*) this package's own spelling for a report-type section, matched in the export by its label.
"""
import collections
import glob
import hashlib
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crsafe  # noqa: E402

NS_URI = crsafe.NS_URI
NS = "{" + NS_URI + "}"

# child elements that identify a block (skipped as leaves; they are part of the block's id)
ID_KEYS = {"fields": ("name",), "recordTypes": ("name",), "validationRules": ("name",), "layouts": ("layout",),
           "sections": ("section", "name"), "picklistValues": ("masterLabel",), "valueTranslation": ("masterLabel",),
           "webLinks": ("name",), "quickActions": ("name",), "sharingReasons": ("name",), "workflowTasks": ("name",),
           "standardFields": ("name",), "fieldSets": ("name",), "customLabels": ("name",),
           "customApplications": ("name",), "customTabs": ("name",), "reportTypes": ("name",),
           "flowDefinitions": ("fullName",), "prompts": ("name",), "customPageWebLinks": ("name",),
           "scontrols": ("name",)}
FOLDER_EXT = {"objectTranslations": "objectTranslation", "globalValueSetTranslations": "globalValueSetTranslation",
              "standardValueSetTranslations": "standardValueSetTranslation", "translations": "translation"}
FOLDER_TYPE = {"objectTranslations": "CustomObjectTranslation", "globalValueSetTranslations": "GlobalValueSetTranslation",
               "standardValueSetTranslations": "StandardValueSetTranslation", "translations": "Translations"}
# top-level element order Salesforce writes; a merged file is re-sorted into it before writing
ROOT_ORDER = ["caseValues", "fieldSets", "fields", "gender", "layouts", "nameFieldLabel", "quickActions",
              "recordTypes", "sharingReasons", "standardFields", "startsWith", "validationRules",
              "webLinks", "workflowTasks"]
TR_ORDER = ["bots", "customApplications", "customDataTranslations", "customLabels", "customPageWebLinks", "customTabs",
            "desFieldTemplateMessages", "flowDefinitions", "identityVerificationCustomFieldLabels",
            "pipelineInspMetricConfigs", "prompts", "quickActions", "reportTypes", "scontrols"]
ACTIVITY_CHILDREN = ("Task", "Event")


def local(tag):
    return tag[len(NS):] if isinstance(tag, str) and tag.startswith(NS) else tag


def ident(e):
    tag = local(e.tag)
    if tag == "caseValues":
        return "|".join((e.findtext(NS + k) or "") for k in ("caseType", "plural", "article", "possessive"))
    for k in ID_KEYS.get(tag, ()):
        v = e.findtext(NS + k)
        if v:
            return v
    return ""


def child_nodes(e):
    """[(child, node)] for the element children of e; a repeated (tag, id) gets '#n' from the second on."""
    seen, out = {}, []
    for c in e:
        if not isinstance(c.tag, str):
            continue
        tag = local(c.tag)
        node = (tag, ident(c))
        seen[node] = seen.get(node, 0) + 1
        if seen[node] > 1:
            node = (tag, f"{node[1]}#{seen[node]}")
        out.append((c, node))
    return out


def walk(e, prefix, out):
    ids = ID_KEYS.get(local(e.tag), ())
    for c, node in child_nodes(e):
        if len(c):
            walk(c, prefix + (node,), out)
        elif node[0] not in ids:
            out[prefix + (node[0],)] = c.text or ""


def leaves(path):
    """{signature: raw text} for every leaf of a translation file (CRs inside values kept)."""
    out = {}
    walk(crsafe.parse(path).getroot(), (), out)
    return out


def is_empty(v):
    return not (v or "").strip()


def ws(v):
    """Whitespace-collapsed text, for comparing a value a human typed with a value the org holds."""
    return " ".join((v or "").split())


# ---- files -------------------------------------------------------------------------------------
def component_sources(root):
    """{(folder, component): [every retrieved copy, sorted]} under a retrieve dir (any batch layout)."""
    paths = collections.defaultdict(list)
    for folder, ext in FOLDER_EXT.items():
        for p in sorted(glob.glob(os.path.join(os.path.abspath(root), "**", folder, f"*.{ext}"), recursive=True)):
            paths[(folder, os.path.basename(p)[:-len(ext) - 1])].append(p)
    return dict(paths)


def raw_values(paths):
    """{sig: set(values)} over every raw copy of one component."""
    out = collections.defaultdict(set)
    for p in paths:
        for s, v in leaves(p).items():
            out[s].add(v)
    return out


def raw_union(paths):
    """{sig: value} over every raw copy; a non-empty value wins over an empty one."""
    out = {}
    for p in paths:
        for s, v in leaves(p).items():
            if not is_empty(v) or s not in out:
                out[s] = v
    return out


def lang_of(folder, comp):
    return comp if folder == "translations" else comp.rpartition("-")[2]


def activity_alias(folder, comp, sig):
    """(folder, 'Activity-<lang>') when a Task/Event FIELD slot is stored under Activity, else None."""
    if folder != "objectTranslations" or not sig or not isinstance(sig[0], tuple) or sig[0][0] != "fields":
        return None
    obj, _, lang = comp.rpartition("-")
    return (folder, f"Activity-{lang}") if obj in ACTIVITY_CHILDREN else None


def norm_key(key):
    """Task/Event field and picklist keys are one stored value under Activity."""
    return re.sub(r"^(CustomField|PicklistValue)\.(Task|Event)\.", r"\1.Activity.", key or "")


# ---- where a key lives -------------------------------------------------------------------------
def placement(key, lang, svs_names, field_names):
    """((folder, component, signature), None) for a translation key, or (None, why)."""
    if not key or "." not in key:
        return None, "no key"
    typ, rest = key.split(".", 1)
    if typ == "CustomLabel":
        return ("translations", lang, (("customLabels", rest), "label")), None
    if typ == "CustomApp":
        return ("translations", lang, (("customApplications", rest), "label")), None
    if typ == "WebTab":
        return ("translations", lang, (("customTabs", rest), "label")), None
    if typ == "CustomReportType":
        rt, _, what = rest.rpartition(".")
        tag = {"Name": "label", "Description": "description"}.get(what)
        return (("translations", lang, (("reportTypes", rt), tag)), None) if rt and tag else (None, "report type part not supported")
    if typ == "ReportTypeSection":
        rt, _, sec = rest.partition(".")
        return (("translations", lang, (("reportTypes", rt), ("sections", sec), "label")), None) if sec else (None, "no section")
    if typ == "QuickAction":
        if "." in rest:
            obj, qa = rest.split(".", 1)
            return ("objectTranslations", f"{obj}-{lang}", (("quickActions", qa), "label")), None
        return ("translations", lang, (("quickActions", rest), "label")), None
    m = re.match(r"PicklistValue\.(.+?)__gvs\.(.*)$", key)
    if m:
        return ("globalValueSetTranslations", f"{m.group(1)}-{lang}", (("valueTranslation", m.group(2)), "translation")), None
    m = re.match(r"PicklistValue\.Standard\.(.+?)\.(.*)$", key)
    if m:
        s = next((n for n in svs_names if n.lower() == m.group(1).lower()), None)
        if s is None:
            return None, "standard value set not in the retrieve"
        return ("standardValueSetTranslations", f"{s}-{lang}", (("valueTranslation", m.group(2)), "translation")), None
    parts = rest.split(".")
    if len(parts) < 2:
        return None, "key too short"
    obj, comp = parts[0], f"{parts[0]}-{lang}"
    if typ in ("WebLink", "ButtonOrLink"):
        return ("objectTranslations", comp, (("webLinks", parts[1]), "label")), None
    if typ in ("CustomField", "PicklistValue"):
        names = field_names(obj, lang)
        f = next((n for n in (parts[1] + "__c", parts[1]) if n in names), None)
        if f is None:
            return None, "field not listed in the object's translation file"
        if typ == "CustomField":
            tag = {"FieldLabel": "label", "HelpText": "help", "RelatedListLabel": "relationshipLabel"}.get(parts[-1])
            return (("objectTranslations", comp, (("fields", f), tag)), None) if tag and len(parts) == 3 else (None, "field part not supported")
        return ("objectTranslations", comp, (("fields", f), ("picklistValues", ".".join(parts[2:])), "translation")), None
    if typ == "RecordType":
        tag = "description" if len(parts) > 2 and parts[2] == "Description" else "label"
        return ("objectTranslations", comp, (("recordTypes", parts[1]), tag)), None
    if typ == "ValidationFormula":
        return ("objectTranslations", comp, (("validationRules", parts[1]), "errorMessage")), None
    if typ == "LayoutSection":
        bits = rest.split(".", 2)
        if len(bits) < 3:
            return None, "layout section key needs object, layout and section"
        return ("objectTranslations", comp, (("layouts", bits[1]), ("sections", re.sub(r"_[0-9]+$", "", bits[2])), "label")), None
    return None, f"key type {typ!r} not supported"


def ambiguous(sig, base):
    """True if a block on the path to sig occurs twice in base (e.g. two sections with one name)."""
    for i, part in enumerate(sig[:-1]):
        twin = sig[:i] + ((part[0], f"{part[1]}#2"),)
        if any(s[:i + 1] == twin for s in base):
            return True
    return False


# ---- JSON / hashing helpers ----------------------------------------------------------------------
def sig_json(sig):
    return [list(x) if isinstance(x, tuple) else x for x in sig]


def sig_tuple(sig):
    return tuple(tuple(x) if isinstance(x, list) else x for x in sig)


def load_json(path):
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def dump_json(obj, path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def file_sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest() if path and os.path.isfile(path) else None


def dir_sha256(d):
    """One hash over every file's relative path and bytes, in sorted order."""
    if not os.path.isdir(d):
        return None
    h = hashlib.sha256()
    for p in sorted(glob.glob(os.path.join(d, "**", "*"), recursive=True)):
        if os.path.isfile(p):
            h.update(os.path.relpath(p, d).replace("\\", "/").encode())
            h.update(Path(p).read_bytes())
    return h.hexdigest()


def utf8_stdout():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


if __name__ == "__main__":
    print(__doc__)
