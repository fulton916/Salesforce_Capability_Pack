"""Find one translation slot (file + element + value tag) inside a metadata-format retrieve.

Used by locate.py, proof.py, verify.py and provenance.py so they all agree on where a
scoped value lives. A scope entry is a dict with:

    lang, type, obj, field, item, value   (+ gender / startsWith for standard-field)

Types and where they live (mdapi format):

    field-label / field-help / field-relationship-label / field-picklist
        objectTranslations/<Obj>-<lang>.objectTranslation   (Task/Event fields: under Activity)
    record-type / validation-rule / web-link / layout-section / standard-field
        objectTranslations/<Obj>-<lang>.objectTranslation
    quick-action  field "Obj.Action": the object's file first, then translations/<lang>.translation
    global-value / standard-value
        globalValueSetTranslations/<Set>-<lang>.globalValueSetTranslation (or standard...)
    custom-label / custom-tab / custom-app / report-type / report-type-section
        translations/<lang>.translation
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

from reconlib import NS, NS_URI, find_root, parse_xml, stored_obj

N = NS
# Child tags that NAME an element rather than hold a value (in order of preference).
KEY_TAGS = ("name", "masterLabel", "fullName", "layout", "section", "developerName")
SLOT_TYPES = {
    "field-label", "field-help", "field-relationship-label", "field-picklist", "record-type",
    "validation-rule", "layout-section", "web-link", "standard-field", "quick-action",
    "global-value", "standard-value", "custom-label", "custom-tab", "custom-app", "report-type",
    "report-type-section",
}
CREATABLE = {"standard-field", "quick-action", "global-value", "standard-value"}


class Trees:
    """Lazy cache of parsed translation files under one retrieve root (comments kept)."""

    def __init__(self, root_dir):
        self.root = find_root(root_dir) if root_dir else None
        self.cache: dict[str, ET.ElementTree | None] = {}

    def get(self, rel: str):
        if rel not in self.cache:
            p = self.root / rel if self.root else None
            self.cache[rel] = parse_xml(p, keep_comments=True) if p and p.is_file() else None
        return self.cache[rel]

    def has(self, rel: str) -> bool:
        return self.get(rel) is not None


def kid(e, tag: str, key_tag: str, text):
    """First child <tag> of e whose <key_tag> text equals text (exact)."""
    if e is None:
        return None
    for c in e.findall(N + tag):
        x = c.find(N + key_tag)
        if x is not None and (x.text or "") == (text or ""):
            return c
    return None


def obj_file(obj: str, lang: str) -> str:
    return f"objectTranslations/{obj}-{lang}.objectTranslation"


def slot_file(d: dict, as_written_obj: str | None = None) -> str:
    t, lang = d["type"], d["lang"]
    if t in ("standard-value", "global-value"):
        kind = "standardValueSet" if t == "standard-value" else "globalValueSet"
        return f"{kind}Translations/{d['obj']}-{lang}.{kind}Translation"
    if t in ("custom-label", "custom-tab", "custom-app", "report-type", "report-type-section"):
        return f"translations/{lang}.translation"
    if t == "quick-action":
        f = d["field"] or ""
        return obj_file(f.split(".", 1)[0], lang) if "." in f else f"translations/{lang}.translation"
    return obj_file(as_written_obj or stored_obj(t, d["obj"]), lang)


def find_slot(trees: Trees, d: dict, as_written_obj: str | None = None):
    """(rel, element holding the value, value tag) - element None when not there."""
    t, lang = d["type"], d["lang"]
    field, item = d.get("field") or "", d.get("item") or ""
    rel = slot_file(d, as_written_obj)
    if t == "quick-action":
        if "." in field:
            ob, act = field.split(".", 1)
            tr = trees.get(rel)
            q = kid(tr.getroot(), "quickActions", "name", act) if tr else None
            if q is not None:
                return rel, q, "label"
        rel2 = f"translations/{lang}.translation"
        tr = trees.get(rel2)
        return rel2, (kid(tr.getroot(), "quickActions", "name", field) if tr else None), "label"
    tr = trees.get(rel)
    if tr is None:
        return rel, None, None
    root = tr.getroot()
    if t in ("standard-value", "global-value"):
        return rel, kid(root, "valueTranslation", "masterLabel", item), "translation"
    if t == "custom-label":
        return rel, kid(root, "customLabels", "name", field), "label"
    if t == "custom-tab":
        return rel, kid(root, "customTabs", "name", field), "label"
    if t == "custom-app":
        return rel, kid(root, "customApplications", "name", field), "label"
    if t == "report-type":
        return rel, kid(root, "reportTypes", "name", field), "label"
    if t == "report-type-section":
        return rel, kid(kid(root, "reportTypes", "name", field), "sections", "name", item), "label"
    if t == "record-type":
        return rel, kid(root, "recordTypes", "name", field), "label"
    if t == "validation-rule":
        return rel, kid(root, "validationRules", "name", field), "errorMessage"
    if t == "web-link":
        return rel, kid(root, "webLinks", "name", field), "label"
    if t == "layout-section":
        return rel, kid(kid(root, "layouts", "layout", field), "sections", "section", item), "label"
    f = kid(root, "fields", "name", field)
    if t == "field-label":
        return rel, f, "label"
    if t == "field-help":
        return rel, f, "help"
    if t == "field-relationship-label":
        return rel, f, "relationshipLabel"
    if t == "standard-field":
        if f is None:
            return rel, None, None
        for cv in f.findall(N + "caseValues"):
            if (cv.findtext(N + "plural") or "") == "false" and cv.find(N + "article") is None \
                    and cv.find(N + "caseType") is None and cv.find(N + "possessive") is None:
                return rel, cv, "value"
        return rel, None, None
    if t == "field-picklist":
        return rel, kid(f, "picklistValues", "masterLabel", item), "translation"
    raise ValueError(f"unknown slot type {t!r}")


def slot_value(trees: Trees, d: dict, as_written_obj: str | None = None):
    """Current text of the slot, '' for an empty element, None when the slot is not there."""
    rel, e, tag = find_slot(trees, d, as_written_obj)
    if e is None:
        return None
    v = e.find(N + tag)
    return "" if v is None else (v.text or "")


def field_gender(trees: Trees, d: dict):
    tr = trees.get(slot_file(d))
    f = kid(tr.getroot(), "fields", "name", d.get("field")) if tr else None
    return None if f is None else f.findtext(N + "gender")


# ─────────────────────────── leaf paths (for the proof) ───────────────────────────

def element_key(e):
    for k in KEY_TAGS:
        x = e.find(N + k)
        if x is not None and x.text is not None:
            return x.text
    return None


def parent_map(root):
    return {c: p for p in root.iter() for c in p}


def leaf_path(root, e, tag) -> list:
    """Path of the value leaf <tag> under e, as [[tag, key], ..., tag] from the file root."""
    pm = parent_map(root)
    chain = []
    cur = e
    while cur is not None and cur is not root:
        chain.append([cur.tag.replace(N, ""), element_key(cur)])
        cur = pm.get(cur)
    return list(reversed(chain)) + [tag]


def leaves(e, path=()):
    """{path tuple: [raw texts]} for every value leaf (whitespace-exact, comments ignored)."""
    out: dict[tuple, list] = {}
    for c in e:
        if not isinstance(c.tag, str):
            continue
        tag = c.tag.replace(N, "")
        has_kids = any(isinstance(x.tag, str) for x in c)
        if has_kids:
            for k, v in leaves(c, path + ((tag, element_key(c)),)).items():
                out.setdefault(k, []).extend(v)
        elif tag not in KEY_TAGS:
            out.setdefault(path + (tag,), []).append(c.text or "")
    return out


def path_key(p) -> tuple:
    """JSON leaf path -> the tuple form leaves() uses."""
    return tuple(tuple(x) if isinstance(x, list) else x for x in p)


# ─────────────────────────── creating a missing slot ───────────────────────────

def sub(parent, tag, text=None):
    e = ET.SubElement(parent, N + tag)
    e.text = text
    return e


def insert_sorted(root, elem, key_tag: str) -> None:
    """Insert elem among root's children: after same-tag siblings whose key sorts first;
    with no same-tag siblings, before the first child whose tag sorts after it."""
    tag = elem.tag
    key = elem.findtext(N + key_tag) or ""
    kids = list(root)
    same = [i for i, c in enumerate(kids) if c.tag == tag]
    if same:
        pos = same[0]
        for i in same:
            if (kids[i].findtext(N + key_tag) or "") <= key:
                pos = i + 1
        root.insert(pos, elem)
        return
    for i, c in enumerate(kids):
        if isinstance(c.tag, str) and c.tag > tag:
            root.insert(i, elem)
            return
    root.append(elem)


def derive_starts_with(word: str) -> str:
    return "Vowel" if word[:1].lower() in "aeiouàâäáéèêëíîïóôöúùûüæøå" else "Consonant"


def create_slot(trees: Trees, d: dict):
    """Create a missing slot in an EXISTING file, for the few types where that is safe.

    standard-field  a <fields> block with singular caseValue + gender + startsWith
    quick-action    a <quickActions> block
    global-value / standard-value
                    a <valueTranslation> - only when the retrieved value set defines the
                    value as INACTIVE (a retrieve omits inactive values from the file)
    Returns ((rel, element, tag), extra_leaves) or None. extra_leaves are the other new
    leaf values the proof must expect, as [leaf path, value].
    """
    t = d["type"]
    if t not in CREATABLE:
        return None
    rel = slot_file(d)
    tr = trees.get(rel)
    if tr is None:
        return None
    root = tr.getroot()
    extra = []
    if t == "standard-field":
        if not d.get("gender"):
            return None
        f = ET.Element(N + "fields")
        cv = sub(f, "caseValues")
        sub(cv, "plural", "false")
        sub(cv, "value", "")
        sub(f, "gender", d["gender"])
        sub(f, "name", d["field"])
        sw = d.get("startsWith") or derive_starts_with(d["value"])
        if not d.get("startsWith"):
            d["startsWith_derived"] = sw
        sub(f, "startsWith", sw)
        insert_sorted(root, f, "name")
        base = [["fields", d["field"]]]
        extra = [[base + [["caseValues", None], "plural"], "false"], [base + ["gender"], d["gender"]],
                 [base + ["startsWith"], sw]]
        return (rel, cv, "value"), extra
    if t == "quick-action":
        q = ET.Element(N + "quickActions")
        sub(q, "label", "")
        name = d["field"].split(".", 1)[1] if "." in d["field"] and rel.startswith("objectTranslations/") \
            else d["field"]
        sub(q, "name", name)
        insert_sorted(root, q, "name")
        return (rel, q, "label"), extra
    # value sets: only an inactive value the definition knows
    kind = "globalValueSets" if t == "global-value" else "standardValueSets"
    ext = "globalValueSet" if t == "global-value" else "standardValueSet"
    defp = trees.root / kind / f"{d['obj']}.{ext}"
    if not defp.is_file():
        return None
    tag = "customValue" if t == "global-value" else "standardValue"
    act = [(v.findtext(N + "isActive") or "true") for v in parse_xml(defp).getroot().iter(N + tag)
           if (v.findtext(N + "label") or v.findtext(N + "fullName")) == d["item"]]
    if act != ["false"]:
        return None
    v = ET.Element(N + "valueTranslation")
    sub(v, "masterLabel", d["item"])
    sub(v, "translation", "")
    insert_sorted(root, v, "masterLabel")
    d["key_note"] = "inactive value (created)"
    return (rel, v, "translation"), extra


def serialize(tree) -> str:
    """Whole file text. A carriage return inside a value is written as &#13; so it survives
    the XML parser on the other side (a raw CR would be normalised away)."""
    body = ET.tostring(tree.getroot(), encoding="unicode").replace("\r", "&#13;")
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + body + "\n"


def write_file(path, text: str) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def package_xml(types: dict[str, set], api_version: str) -> str:
    esc = lambda x: x.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    m = f'<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="{NS_URI}">\n'
    for t in sorted(types):
        m += "    <types>\n" + "".join(f"        <members>{esc(x)}</members>\n" for x in sorted(types[t]))
        m += f"        <name>{t}</name>\n    </types>\n"
    return m + f"    <version>{api_version}</version>\n</Package>\n"


def translation_files(d) -> list[str]:
    """Relative posix paths of the translation files under a retrieve/payload root."""
    root = Path(d)
    out = []
    for folder in ("objectTranslations", "globalValueSetTranslations", "standardValueSetTranslations",
                   "translations"):
        for p in sorted((root / folder).glob("*")) if (root / folder).is_dir() else []:
            if p.is_file():
                out.append(p.relative_to(root).as_posix())
    return out


def slot_id(d: dict) -> tuple:
    """One slot per (lang, stored object, type, field, item)."""
    return (d["lang"], stored_obj(d["type"], d.get("obj") or ""), d["type"], d.get("field") or "",
            d.get("item") or "")
