#!/usr/bin/env python3
"""Check a metadata retrieve against Bilingual .stf exports, key by key.

A retrieve returns translation content only for parents named in the SAME request:
CustomObject (+ Layout) for CustomObjectTranslation, GlobalValueSet / StandardValueSet for
their translations, CustomLabel / CustomApplication / CustomTab for Translations. Retrieved
alone, a CustomObjectTranslation can come back holding little more than caseValues, and a
near-empty file does NOT mean the object has no translations. Run this check before
trusting a retrieve as a read of translation state.

For every TRANSLATED .stf key whose parent is in the retrieve:
    exact              the retrieve holds the same text
    same (whitespace)  equal once whitespace is normalised
    CR only            differs only by carriage returns - a CR was lost or added
    MISSING            the retrieve does not hold it
    DIFFERENT          the retrieve holds other text
and the other way round, EXTRA: values the retrieve holds that the .stf does not list.

.stf escapes (\\n, \\t, \\r) are decoded and retrieved files are read with crsafe, so a
carriage return that is part of a value is compared, not silently dropped.
Key types this script cannot map are counted as "not compared", never as a pass.

Usage:
  python compare_retrieve_stf.py <retrieve dir> [<retrieve dir> ...] --stf-dir <dir>
      [--langs cs,de,...] [--out report.json]
Exit 2 if anything is MISSING, DIFFERENT or CR only; 0 otherwise.
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import crsafe  # noqa: E402
import stf  # noqa: E402

NS = "{%s}" % crsafe.NS
FAIL = ("MISSING", "DIFFERENT", "CR only")


def _t(e, n: str) -> str:
    return e.findtext(NS + n) or ""


def _stem(p: Path) -> str:
    """'Widget__c-de.objectTranslation' / '...-meta.xml' -> 'Widget__c-de'."""
    name = urllib.parse.unquote(p.name)
    if name.endswith("-meta.xml"):
        name = name[: -len("-meta.xml")]
    return name.rsplit(".", 1)[0]


def _lower_first(s: str) -> str:
    return s[:1].lower() + s[1:]


def _parse(p: Path) -> ET.Element:
    try:
        return crsafe.parse(p).getroot()
    except ValueError as e:
        print(f"WARNING: {e}\n   read without CR protection; CR comparisons for this file "
              "are not reliable", file=sys.stderr)
        return ET.parse(p).getroot()


def _read_field(f: ET.Element, obj: str, g: dict[str, str]) -> None:
    """One <fields> element (metadata format) or CustomFieldTranslation file (source format)."""
    nm = re.sub(r"__c$", "", _t(f, "name"))
    for tag, kind in (("label", "FieldLabel"), ("help", "HelpText"),
                      ("relationshipLabel", "RelatedListLabel")):
        if _t(f, tag).strip():
            g[f"CustomField.{obj}.{nm}.{kind}"] = _t(f, tag)
    for pv in f.findall(NS + "picklistValues"):
        if _t(pv, "translation").strip():
            g[f"PicklistValue.{obj}.{nm}.{_t(pv, 'masterLabel')}"] = _t(pv, "translation")


def read_retrieve(dirs: list[Path]):
    """({lang: {key: value}}, {lang: {(obj, layout, section): [labels]}}, scope sets)"""
    got: dict[str, dict[str, str]] = collections.defaultdict(dict)
    secs = collections.defaultdict(lambda: collections.defaultdict(list))
    objs, gvs, svs, labels = set(), set(), set(), set()
    files = [p for d in dirs for p in Path(d).rglob("*") if p.is_file()]
    for p in files:
        n = p.name.replace("-meta.xml", "")
        if n.endswith(".objectTranslation"):
            obj, lang = _stem(p).rsplit("-", 1)
            objs.add(obj)
            root, g = _parse(p), got[lang]
            for f in root.findall(NS + "fields"):
                _read_field(f, obj, g)
            for r in root.findall(NS + "recordTypes"):
                if _t(r, "label").strip():
                    g[f"RecordType.{obj}.{_t(r, 'name')}"] = _t(r, "label")
            for v in root.findall(NS + "validationRules"):
                if _t(v, "errorMessage").strip():
                    g[f"ValidationFormula.{obj}.{_t(v, 'name')}"] = _t(v, "errorMessage")
            for w in root.findall(NS + "webLinks"):
                if _t(w, "label").strip():
                    g[f"ButtonOrLink.{obj}.{_t(w, 'name')}"] = _t(w, "label")
            for lay in root.findall(NS + "layouts"):
                for s in lay.findall(NS + "sections"):
                    if _t(s, "label").strip():
                        secs[lang][(obj, _t(lay, "layout"), _t(s, "section"))].append(_t(s, "label"))
        elif n.endswith(".fieldTranslation"):              # source format: one field per file
            obj, lang = p.parent.name.rsplit("-", 1)
            objs.add(obj)
            _read_field(_parse(p), obj, got[lang])
        elif n.endswith(".globalValueSetTranslation"):
            name, lang = _stem(p).rsplit("-", 1)
            gvs.add(name)
            for v in _parse(p).findall(NS + "valueTranslation"):
                if _t(v, "translation").strip():
                    got[lang][f"PicklistValue.{name}__gvs.{_t(v, 'masterLabel')}"] = _t(v, "translation")
        elif n.endswith(".standardValueSetTranslation"):
            name, lang = _stem(p).rsplit("-", 1)
            svs.add(_lower_first(name))
            for v in _parse(p).findall(NS + "valueTranslation"):
                if _t(v, "translation").strip():
                    got[lang][f"PicklistValue.Standard.{_lower_first(name)}.{_t(v, 'masterLabel')}"] = \
                        _t(v, "translation")
        elif n.endswith(".translation"):
            lang = _stem(p)
            root = _parse(p)
            for tag, kind in (("customLabels", "CustomLabel"), ("customApplications", "CustomApp"),
                              ("customTabs", "WebTab")):
                for e in root.findall(NS + tag):
                    if _t(e, "label").strip():
                        got[lang][f"{kind}.{_t(e, 'name')}"] = _t(e, "label")
        elif n.endswith(".labels"):
            for e in _parse(p).findall(NS + "labels"):
                labels.add(_t(e, "fullName"))
        elif n.endswith(".label"):                         # source format: one label per file
            labels.add(_stem(p))
    return got, secs, {"obj": objs, "gvs": gvs, "svs": svs, "label": labels}


def in_scope(key: str, scope) -> bool:
    if "." not in key:
        return False
    typ, rest = key.split(".", 1)
    if typ == "CustomLabel":
        return rest in scope["label"]
    if typ in ("CustomApp", "WebTab"):
        return True
    parts = rest.split(".")
    if typ == "PicklistValue" and parts[0] == "Standard":
        return len(parts) > 1 and parts[1] in scope["svs"]
    if typ == "PicklistValue" and parts[0].endswith("__gvs"):
        return parts[0][:-5] in scope["gvs"]
    if typ in ("CustomField", "PicklistValue", "RecordType", "ValidationFormula",
               "LayoutSection", "ButtonOrLink"):
        return parts[0] in scope["obj"]
    return False


def classify(have: str | None, want: str) -> str:
    if have is None:
        return "MISSING"
    if have == want:
        return "exact"
    if have.replace("\r", "") == want.replace("\r", ""):
        return "CR only"
    if " ".join(have.split()) == " ".join(want.split()):
        return "same (whitespace)"
    return "DIFFERENT"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("retrieved", nargs="+", type=Path, help="retrieve folder(s)")
    ap.add_argument("--stf-dir", required=True, type=Path,
                    help="folder with Bilingual_<lang>_*.stf exports (searched recursively)")
    ap.add_argument("--langs", help="comma-separated language codes (default: all in both)")
    ap.add_argument("--out", type=Path, help="write a JSON report here")
    for _s in (sys.stdout, sys.stderr):
        if hasattr(_s, "reconfigure"):
            _s.reconfigure(encoding="utf-8", errors="replace")
    a = ap.parse_args(argv)

    got, secs, scope = read_retrieve(a.retrieved)
    stfs = stf.find_bilingual(a.stf_dir)
    langs = a.langs.split(",") if a.langs else sorted(set(got) & set(stfs))
    missing_stf = [lg for lg in langs if lg not in stfs]
    if missing_stf:
        sys.exit(f"error: no Bilingual .stf for: {', '.join(missing_stf)}")
    print(f"retrieve: {len(scope['obj'])} objects, {len(scope['gvs'])} GVS, {len(scope['svs'])} SVS, "
          f"{len(scope['label'])} labels  |  languages compared: {len(langs)}")

    by_type = collections.defaultdict(collections.Counter)
    by_lang = collections.defaultdict(collections.Counter)
    examples = collections.defaultdict(list)
    skipped = collections.Counter()
    for lang in langs:
        want = {k: tr for k, (_lab, tr) in stf.translated(stfs[lang]).items()}
        g, sc = got.get(lang, {}), secs.get(lang, {})
        for key, val in want.items():
            typ = key.split(".", 1)[0]
            if not in_scope(key, scope):
                skipped[typ] += 1
                continue
            if typ == "LayoutSection":
                parts = key.split(".", 3)
                if len(parts) < 4:
                    skipped[typ] += 1
                    continue
                _, obj, lay, sec = parts
                hit = sc.get((obj, lay, re.sub(r"_\d+$", "", sec))) or sc.get((obj, lay, sec))
                have = hit[0] if hit else None
            else:
                have = g.get(key)
            res = classify(have, val)
            by_type[typ][res] += 1
            by_lang[lang][res] += 1
            if res in FAIL and len(examples[f"{typ}|{res}"]) < 4:
                examples[f"{typ}|{res}"].append([lang, key, val[:60], (have or "")[:60]])
        for key in g:
            if key not in want:
                typ = key.split(".", 1)[0]
                by_type[typ]["EXTRA"] += 1
                by_lang[lang]["EXTRA"] += 1
                if len(examples[f"EXTRA|{typ}"]) < 3:
                    examples[f"EXTRA|{typ}"].append([lang, key, g[key][:60]])

    cols = ("exact", "same (whitespace)", "CR only", "MISSING", "DIFFERENT", "EXTRA")
    print(f"\n{'type':20} {'exact':>7} {'ws':>5} {'CR':>4} {'MISSING':>8} {'DIFFER':>7} {'EXTRA':>6}")
    tot: collections.Counter = collections.Counter()
    for typ in sorted(by_type):
        c = by_type[typ]
        tot.update(c)
        print(f"  {typ:18} " + " ".join(f"{c[k]:{w}}" for k, w in zip(cols, (7, 5, 4, 8, 7, 6))))
    print(f"  {'TOTAL':18} " + " ".join(f"{tot[k]:{w}}" for k, w in zip(cols, (7, 5, 4, 8, 7, 6))))
    print(f"\nnot compared (outside the retrieve's parents): {dict(skipped.most_common())}")
    for k, v in sorted(examples.items()):
        print(f"\n  {k}:")
        for x in v:
            print(f"     {x!r}")
    if a.out:
        a.out.write_text(json.dumps({"by_type": by_type, "by_lang": by_lang, "skipped": skipped,
                                     "examples": examples}, ensure_ascii=False, indent=1),
                         encoding="utf-8")
    return 2 if any(tot[k] for k in FAIL) else 0


if __name__ == "__main__":
    sys.exit(main())
