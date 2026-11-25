# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Read Salesforce Translation Workbench Bilingual exports (.stf) and look a translation key up in them.

Setup -> Translation Workbench -> Export -> Bilingual writes one file per language, named
"Bilingual_<lang>_<YYYY-MM-DD HHMM>.stf", stamped in the org's time zone. Each data row is
    <key> TAB <English label> TAB <translation> [TAB <out of date>]
in a TRANSLATED section (rows holding a translation) and an OUTDATED AND UNTRANSLATED section.
Salesforce leaves the TRANSLATED section out entirely for a language with no translations.

A key can be filed under another spelling in the export than in the metadata:
  - Task/Event field labels and picklist values are filed under Activity;
  - Knowledge__kav fields as Knowledge__c;
  - layout sections may carry a "_<n>" suffix;
  - report-type sections are "CrtLayoutSection.<report type>_<n>", told apart only by their label
    (this package spells them "ReportTypeSection.<report type>.<label>").
"""
import glob
import os
import re
from pathlib import Path

TRANSLATED = "------------------TRANSLATED-------------------"
UNTRANSLATED = "------------------OUTDATED AND UNTRANSLATED-----------------"
NAME_RE = re.compile(r"Bilingual_(.+?)_(\d{4}-\d{2}-\d{2} \d{4})")
SUFFIX = re.compile(r"_\d+$")
CRT = re.compile(r"CrtLayoutSection\.(.+)_(\d+)")


def find_exports(d):
    """{lang: [(stamp, path), ...]} for every Bilingual_*.stf under d."""
    out = {}
    for p in glob.glob(os.path.join(d, "**", "Bilingual_*.stf"), recursive=True):
        m = NAME_RE.match(os.path.basename(p))
        if m:
            out.setdefault(m.group(1), []).append((m.group(2), p))
    return out


class Export:
    """One language's Bilingual export: held translations, every key listed, header problems."""

    def __init__(self, path, lang):
        self.path, self.lang = path, lang
        text = Path(path).read_bytes().decode("utf-8-sig")
        lines = [l.rstrip("\r") for l in text.split("\n")]       # never splitlines(): U+2028 etc. are data
        self.problems = []
        if not text.endswith("\n"):
            self.problems.append("does not end in a newline - truncated")
        if f"Language code: {lang}" not in lines:
            self.problems.append(f"header does not say 'Language code: {lang}'")
        if "Type: Bilingual" not in lines:
            self.problems.append("header does not say 'Type: Bilingual'")
        if UNTRANSLATED not in lines:
            self.problems.append("the OUTDATED AND UNTRANSLATED marker is missing - truncated or not a Bilingual export")
        elif TRANSLATED not in lines:
            if any(l and not l.startswith("#") and "\t" in l for l in lines[:lines.index(UNTRANSLATED)]):
                self.problems.append("rows before the OUTDATED AND UNTRANSLATED marker but no TRANSLATED marker")
        self.held, self.present, self.label, self.crt = {}, set(), {}, {}
        for l in lines:
            if not l or l.startswith("#") or "\t" not in l:
                continue
            parts = l.split("\t")
            self.present.add(parts[0])
            self.label[parts[0]] = parts[1] if len(parts) > 1 else ""
            if len(parts) >= 3 and parts[2].strip():
                self.held[parts[0]] = parts[2]
            m = CRT.fullmatch(parts[0])
            if m and len(parts) > 1:
                self.crt.setdefault((m.group(1), parts[1]), []).append(parts[0])
        self.lay_held = {SUFFIX.sub("", k): v for k, v in self.held.items() if k.startswith("LayoutSection.")}
        self.lay_present = {SUFFIX.sub("", k) for k in self.present if k.startswith("LayoutSection.")}

    def export_keys(self, key):
        """The export rows this key may be filed under."""
        if key.startswith("ReportTypeSection."):
            rt, _, sec = key[len("ReportTypeSection."):].partition(".")
            return self.crt.get((rt, sec), [])
        ks = spellings(key)
        hits = [k for k in ks if k in self.present]
        lay = {SUFFIX.sub("", k) for k in ks if k.startswith("LayoutSection.")}
        if lay:
            hits += sorted(k for k in self.present if k.startswith("LayoutSection.")
                           and SUFFIX.sub("", k) in lay and k not in hits)
        return hits

    def look(self, key):
        """('held', value) / ('present', None) / ('absent', None) / ('ambiguous', None)."""
        if key.startswith("ReportTypeSection."):
            ks = self.export_keys(key)
            if len(ks) > 1:
                return "ambiguous", None
            if not ks:
                return "absent", None
            return ("held", self.held[ks[0]]) if ks[0] in self.held else ("present", None)
        ks = spellings(key)
        for k in ks:
            v = self.held.get(k)
            if v is None and k.startswith("LayoutSection."):
                v = self.lay_held.get(SUFFIX.sub("", k))
            if v is not None:
                return "held", v
        if any(k in self.present or (k.startswith("LayoutSection.") and SUFFIX.sub("", k) in self.lay_present) for k in ks):
            return "present", None
        return "absent", None


def spellings(key):
    """Every key the export may file this slot under."""
    out = [key]
    parts = key.split(".")
    if len(parts) > 2 and parts[0] in ("CustomField", "PicklistValue") and parts[1] in ("Task", "Event"):
        out.append(".".join([parts[0], "Activity"] + parts[2:]))
    out += [k.replace(".Knowledge__kav.", ".Knowledge__c.", 1) for k in list(out) if ".Knowledge__kav." in k]
    if parts[0] == "WebLink":
        out.append("ButtonOrLink." + key.split(".", 1)[1])
    return out


if __name__ == "__main__":
    print(__doc__)
