#!/usr/bin/env python3
"""Turn Salesforce deploy/validate results for translation metadata into a triage workbook.

One or more deploy logs (`sf project deploy start|validate ... --json`) go in. One .xlsx
comes out: a Summary tab plus one tab per failure category. Every row says what failed,
the text that was supplied for it, a DIAGNOSIS, a suggested fix where one is certain
enough, and WHO MUST ACT.

The raw Salesforce message is not enough to triage on. "Invalid picklist value: X" can mean
the value was deleted, renamed, given a number prefix, padded with spaces in the org, or
that the key text is mojibake. Salesforce also caps the values it lists per component, so a
named value is not even proof that THAT value is the bad one. Where org evidence is given
(describes, record types, value set metadata, a Source .stf export) each row is resolved
against it and the diagnosis says which case it is.

It also checks what actually LANDED. A deploy that returns SucceededPartial reads like a
success, but a CustomObjectTranslation is all-or-nothing: one bad reference discards every
translation in that object and language. The run prints the failed components and, with a
payload folder, how many translated elements they took down. Exit code 2 when anything
failed, unless --allow-partial.

Usage:
  python triage_deploy_errors.py --load deploy.json --out errors.xlsx
  python triage_deploy_errors.py --out errors.xlsx \\
      --load "Load 1=load1/deploy.json=load1/csv" --load "Load 2=load2/deploy.json=load2/csv" \\
      --describes describes/ --source-stf exports/Source_en_US_2026-01-05.stf
--load is LABEL=DEPLOY_JSON[=CSV_DIR[=PAYLOAD_DIR]], or just DEPLOY_JSON.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mojibake  # noqa: E402
import triage_common as T  # noqa: E402

HEADERS = ["Load", "Language", "Component", "Component Type", "Field / Value Set",
           "Bad Value", "English Source", "Supplied Translation", "Grammar Attribute",
           "Diagnosis", "Suggested Key", "Suggested Translation", "Who Must Act",
           "Error Message"]
WIDTHS = [13, 9, 26, 24, 30, 30, 26, 26, 14, 52, 30, 30, 34, 60]
ACTION_COLS = ("Who Must Act", "Suggested Key", "Suggested Translation")

_NUM_PREFIX = re.compile(r"^(\s*\d+\s*[-–]\s*)")


class Parties:
    """Names used in the 'Who Must Act' column. The text before ' - ' is the party."""

    def __init__(self, developer: str, reviewer: str, admin: str):
        self.developer, self.reviewer, self.admin = developer, reviewer, admin
        self.none, self.investigate = "No action", "Investigate"


def norm(s: str) -> str:
    """Strip a leading '12-' / '1 - ' numbering prefix and all punctuation, spacing, case."""
    s = _NUM_PREFIX.sub("", s or "")
    return re.sub(r"[^a-z0-9]", "", s.lower())


def apply_prefix(org_label: str, translation: str) -> str:
    """Carry the org label's numbering prefix onto a translation.

    A picklist translation REPLACES the displayed label, so dropping a '1 - ' prefix would
    hide the number from every translated user while English keeps it. The separator
    differs by field ('1 - ' vs '21-'), so it is copied verbatim.
    """
    if not org_label or not translation:
        return ""
    m = _NUM_PREFIX.match(org_label)
    if not m:
        return ""
    if _NUM_PREFIX.match(translation):
        return translation
    return m.group(1) + translation


# ── Org evidence ─────────────────────────────────────────────────────────────


class Evidence:
    def __init__(self, describes: str | None, record_types: str | None,
                 value_sets: str | None, source_stf: str | None):
        self.picklists: dict[str, dict[str, list[str]]] = {}
        self.field_labels: dict[tuple[str, str], str] = {}
        self.rectypes: dict[str, dict[str, tuple[str, str]]] = defaultdict(dict)
        self.value_sets: dict[str, list[str]] = {}
        self.source_keys = T.load_source_keys(source_stf)
        if describes:
            for p in sorted(Path(describes).glob("*.json")):
                if p.name.startswith("_"):
                    continue
                try:
                    res = (T.load_json_multi(p) or {}).get("result") or {}
                except ValueError:
                    continue
                if not res.get("fields"):
                    continue
                obj = res.get("name") or p.stem
                self.picklists[obj] = {f["name"]: [v.get("label", "") for v in f.get("picklistValues") or []]
                                       for f in res["fields"]}
                for f in res["fields"]:
                    self.field_labels[(obj, f["name"])] = f.get("label", "")
            if not record_types and (Path(describes) / "_recordtypes.json").exists():
                record_types = str(Path(describes) / "_recordtypes.json")
        if record_types:
            data = T.load_json_multi(record_types) or {}
            for r in (data.get("result") or {}).get("records") or []:
                self.rectypes[r.get("SobjectType", "")][norm(r.get("Name", ""))] = (
                    r.get("DeveloperName", ""), r.get("Name", ""))
                self.rectypes[r.get("SobjectType", "")].setdefault(
                    norm(r.get("DeveloperName", "")), (r.get("DeveloperName", ""), r.get("Name", "")))
        if value_sets:
            for p in Path(value_sets).rglob("*"):
                for suffix in (".globalValueSet-meta.xml", ".standardValueSet-meta.xml",
                               ".globalValueSet", ".standardValueSet"):
                    if p.name.endswith(suffix):
                        self.value_sets[p.name[: -len(suffix)]] = re.findall(
                            r"<label>(.*?)</label>", p.read_text(encoding="utf-8"))

    def labels_for(self, field_disp: str) -> list[str] | None:
        """Current labels of a picklist ('Obj.Field') or value set ('Country'), or None."""
        if "." in (field_disp or ""):
            obj, _, fld = field_disp.partition(".")
            labels = self.picklists.get(obj, {}).get(fld)
            if labels is not None:
                return labels
            base = fld[:-3] if fld.endswith("__c") else fld
            prefix = f"PicklistValue.{obj}.{base}."
        else:
            if field_disp in self.value_sets:
                return self.value_sets[field_disp]
            prefix = f"PicklistValue.{field_disp}__gvs."
        if self.source_keys:
            hits = [k[len(prefix):] for k in self.source_keys if k.startswith(prefix)]
            if hits:
                return hits
        return None

    @property
    def any(self) -> bool:
        return bool(self.picklists or self.rectypes or self.value_sets or self.source_keys)


def diagnose(cat: str, problem: str, bad: str, field_disp: str, english: str,
             ev: Evidence, P: Parties) -> tuple[str, str, str]:
    """(diagnosis, suggested key, who must act)."""
    if cat == T.INVALID_CHARS:
        fixed = mojibake.repair(bad) if bad else ""
        return ("The key text is mojibake (UTF-8 read as cp1252) in the file that was "
                "deployed, so it matches nothing in the org. The text was damaged before "
                "the translator saw it; repair the key and reload.",
                fixed, f"{P.developer} - repair the encoding and reload")

    if cat == T.VALUE_NOT_FOUND:
        labels = ev.labels_for(field_disp)
        if labels is None:
            return ("Not checked - no describe, value set metadata or Source .stf covers "
                    "this field." if ev.any else
                    "Not checked - give org evidence (--describes, --value-sets, --source-stf).",
                    "", f"{P.investigate} - check the value against the org")
        if bad in labels:
            return ("This value IS valid in the org. Salesforce caps its error list per "
                    "component, so it was named next to a genuinely bad value on the same field.",
                    bad, f"{P.none} - collateral in the error list")
        nmap: dict[str, list[str]] = defaultdict(list)
        for lab in labels:
            nmap[norm(lab)].append(lab)
        hit = nmap.get(norm(bad))
        if hit:
            org = hit[0]
            if _NUM_PREFIX.match(org) and not _NUM_PREFIX.match(bad):
                return ("The org value now carries a numbering prefix that the file does not. "
                        "Same value, translation still good; the prefix must lead both the "
                        "key and the translated label.",
                        org, f"{P.reviewer} - confirm the prefixed key and translation, then reload")
            if org.strip() == (bad or "").strip() or " ".join(org.split()) == " ".join((bad or "").split()):
                return (f"Only whitespace differs, and it is in the ORG's own label ({org!r} vs "
                        f"{bad!r}). The supplied value and translation are right; the key just "
                        "has to match the org byte for byte.",
                        org, f"{P.developer} - re-key to the org value exactly")
            return ("Same value, formatted differently in the org (punctuation or spacing). "
                    "The translation is fine; only the key must match the org exactly.",
                    org, f"{P.developer} - re-key to the org value exactly")
        return ("The value is not in the org under any spelling. It was removed or renamed.",
                "", f"{P.reviewer} - give the replacement value, or drop the row")

    if cat == T.DELETED_FIELD:
        obj, _, fld = (field_disp or "").partition(".")
        base = fld[:-3] if fld.endswith("__c") else fld
        if f"CustomField.{obj}.{base}.FieldLabel" in ev.source_keys:
            return ("The field IS in the org's Source export, so it exists. The failure is "
                    "about access or the reference text, not a deletion.", "",
                    f"{P.investigate} - check the field in the target org")
        fields = ev.picklists.get(obj, {})
        same_label = [n for n in fields if n != fld and english
                      and ev.field_labels.get((obj, n), "").strip().lower() == english.strip().lower()]
        if len(same_label) == 1:
            cand = same_label[0]
            return (f"Field was probably RECREATED under a new API name: the org has {cand} "
                    f"with the identical label {english!r}. The translation is still valid; only "
                    "the key changes.",
                    cand, f"{P.reviewer} - confirm it is the same field, then reload")
        if len(same_label) > 1:
            return (f"Field is gone. Several org fields carry the label {english!r} "
                    f"({', '.join(same_label[:4])}), so which one replaced it is not certain.",
                    "", f"{P.reviewer} - say which field replaced it; otherwise drop the row")
        stem = norm(base)
        near = [n for n in fields if n != fld and stem and
                len(os.path.commonprefix([stem, norm(n)])) >= min(6, len(stem))]
        if near:
            cand = near[0]
            return (f"Field is gone. The org has a similarly named {cand}, but its label "
                    f"({ev.field_labels.get((obj, cand)) or 'unknown'!r}) does not match "
                    f"{english!r}, so it is NOT confirmed as the same field.",
                    "", f"{P.reviewer} - confirm whether it was renamed; otherwise drop the row")
        return ("Field was deleted from the org.", "",
                f"{P.none} - drop the row, nothing to re-supply")

    if cat == T.DELETED_RT:
        obj, _, rt = (field_disp or "").partition(".")
        hit = ev.rectypes.get(obj, {}).get(norm(rt))
        if hit and hit[0] != rt:
            dev, label = hit
            return (f"Record type was RENAMED, not deleted: {rt} is now {dev}, labelled "
                    f"{label!r}. The translation is still good under the new name.",
                    dev, f"{P.reviewer} - confirm the new key (and any label prefix), then reload")
        return ("Record type was deleted from the org.", "",
                f"{P.none} - drop the row, nothing to re-supply")

    if cat == T.DELETED_COMPONENT:
        if T.MISSING_OBJECT_RE.search(problem):
            return ("Object does not exist in this org. The file was probably built against "
                    "a different org, so it was never deployable here.", "",
                    f"{P.none} - drop the row, nothing to re-supply")
        return ("Component was deleted from the org after the file was produced.", "",
                f"{P.none} - drop the row, nothing to re-supply")
    if cat == T.GENDER_REQUIRED:
        return ("Salesforce needs a grammatical gender with this translated label. It names "
                "the object, not the field: build the grammar file to expand it into rows.",
                "", f"{P.reviewer} - supply the gender (make_grammar_file.py)")
    if cat == T.GRAMMAR_REQUIRED:
        return ("Salesforce needs another grammar value (starts-with sound, article or "
                "possessive) with this translated label.", "",
                f"{P.reviewer} - supply the value (make_grammar_file.py)")
    if cat == T.INVALID_GRAMMAR:
        return ("A grammar value is not valid for this language (for example Masculine for a "
                "language with only common/neuter gender).", "",
                f"{P.reviewer} - pick a value valid for this language")
    if cat == T.NAMESPACED:
        return ("Translations of a managed package's namespaced components cannot be "
                "deployed. Exclude them from the payload.", "",
                f"{P.developer} - remove the namespaced components")
    if cat == T.CANNOT_TRANSLATE:
        return ("The language is not enabled for translation in this org.", "",
                f"{P.admin} - enable the language in Translation Workbench, or drop it")
    return ("", "", f"{P.investigate} - read the error message")


def lookup(lang: str, obj: str, problem: str, by_pick: dict, by_field: dict) -> tuple[str, str, str, str]:
    """(field display, bad value, english source, supplied translation) for one failure."""
    m = T.PICKLIST_FIELD_RE.search(problem)
    if m:
        bad, full = m.group(1).strip(), m.group(2).strip()
        comp, _, fld = full.partition(".") if "." in full else (obj, "", full)
        src, tr = by_pick.get((lang, comp, fld, bad), by_pick.get((lang, comp, "", bad), ("", "")))
        return full, bad, src, tr
    m = T.PICKLIST_GVS_RE.search(problem)
    if m:
        bad, target = m.group(1).strip(), m.group(2).strip()
        vs = target.rsplit("-", 1)[0] if "-" in target else obj
        src, tr = by_pick.get((lang, vs, "", bad), ("", ""))
        return vs, bad, src, tr
    for rx in (T.MISSING_FIELD_RE, T.MISSING_RT_RE):
        m = rx.search(problem)
        if m:
            full = m.group(1).strip()
            comp, _, fld = full.partition(".") if "." in full else (obj, "", full)
            src, tr = by_field.get((lang, comp, fld), ("", ""))
            return full, "", src, tr
    return "", "", "", ""


def build_indexes(lang_rows: dict[str, list[dict]]):
    by_pick: dict[tuple, tuple[str, str]] = {}
    by_field: dict[tuple, tuple[str, str]] = {}
    for lang, rows in lang_rows.items():
        for r in rows:
            comp, fld, ml = r.get("component", ""), r.get("field", ""), r.get("masterLabel", "")
            val = (r.get("source", ""), r.get("translation", ""))
            if ml:
                by_pick[(lang, comp, fld, ml)] = val
                by_pick.setdefault((lang, comp, "", ml), val)
            else:
                by_field[(lang, comp, fld)] = val
    return by_pick, by_field


def stf_key(cat: str, field_disp: str, bad: str, suggested: str = "") -> str | None:
    """The .stf key a row targets. For a rename, the SUGGESTED (new) name is what to check:
    the old name is correctly absent, so checking it would call a fixed row broken."""
    if "." not in (field_disp or ""):
        if cat in (T.VALUE_NOT_FOUND, T.INVALID_CHARS) and field_disp and (suggested or bad):
            return f"PicklistValue.{field_disp}__gvs.{suggested or bad}"
        return None
    obj, _, fld = field_disp.partition(".")
    base = fld[:-3] if fld.endswith("__c") else fld
    if cat == T.DELETED_RT:
        return f"RecordType.{obj}.{suggested or fld}"
    if cat == T.DELETED_FIELD:
        b = suggested[:-3] if suggested.endswith("__c") else (suggested or base)
        return f"CustomField.{obj}.{b}.FieldLabel"
    if cat in (T.VALUE_NOT_FOUND, T.INVALID_CHARS) and (suggested or bad):
        return f"PicklistValue.{obj}.{base}.{suggested or bad}"
    return None


# ── Payload impact ───────────────────────────────────────────────────────────

_ELEMENT_RE = re.compile(r"<(?:label|translation|errorMessage|help|value)>[^<]+</")


def count_elements(payload_dir: Path, component: str) -> int:
    """Translated elements a component carried in the payload (source or metadata format)."""
    cands = [payload_dir / "objectTranslations" / component,
             payload_dir / "objectTranslations" / f"{component}.objectTranslation",
             payload_dir / "translations" / f"{component}.translation-meta.xml",
             payload_dir / "translations" / f"{component}.translation"]
    for sub in ("globalValueSetTranslations", "standardValueSetTranslations"):
        cands += list((payload_dir / sub).glob(f"{component}.*")) if (payload_dir / sub).is_dir() else []
    total = 0
    for c in cands:
        files = list(c.rglob("*")) if c.is_dir() else [c] if c.is_file() else []
        for f in files:
            if f.is_file():
                total += len(_ELEMENT_RE.findall(f.read_text(encoding="utf-8", errors="replace")))
    return total


def report_impact(label: str, result: dict, failures: list, successes: list,
                  payload_dir: Path | None) -> bool:
    """Print what the deploy actually landed. True if anything did not land."""
    status = str(result.get("status", "?"))
    failed = sorted({f.get("fullName") for f in failures if f.get("fullName")})
    ok = sorted({s.get("fullName") for s in successes if s.get("fullName")} - set(failed))
    print("\n" + "=" * 68)
    print(f"[{label}] DEPLOY STATUS: {status}"
          + ("   (check-only validate: nothing was saved)" if result.get("checkOnly") else ""))
    print(f"  components landed : {len(ok)}")
    print(f"  components FAILED : {len(failed)}")
    have_payload = bool(payload_dir and payload_dir.is_dir())
    if have_payload:
        lost = sum(count_elements(payload_dir, c) for c in failed)
        landed = sum(count_elements(payload_dir, c) for c in ok)
        print(f"  translated elements landed : {landed:,}")
        print(f"  translated elements LOST   : {lost:,}")
        if lost + landed:
            print(f"  -> {100 * lost / (lost + landed):.1f}% of the payload did NOT land")
    else:
        print("  (give a payload folder in --load to measure how many translations were lost)")
    if status == "Succeeded" and not failed:
        print("  all components landed")
        print("=" * 68)
        return False
    print("\n  *** THIS DEPLOY DID NOT FULLY LAND ***")
    print("  A CustomObjectTranslation is all-or-nothing: one bad field, record type or")
    print("  picklist reference discards EVERY translation in that object and language.")
    print("  Fix the references and redeploy. Do not treat this run as complete.")
    if failed:
        ranked = sorted(failed, key=lambda c: -count_elements(payload_dir, c)) if have_payload else failed
        print(f"\n  worst-hit components ({min(len(failed), 10)} of {len(failed)}):")
        for c in ranked[:10]:
            n = count_elements(payload_dir, c) if have_payload else 0
            print(f"     {c:34} {n:6,} elements lost" if n else f"     {c}")
    print("=" * 68)
    return True


# ── Main ─────────────────────────────────────────────────────────────────────


def load_baseline(path: str | None) -> set[str]:
    if not path:
        return set()
    return {ln.strip() for ln in Path(path).read_text(encoding="utf-8-sig").splitlines()
            if ln.strip() and not ln.startswith("#")}


def parse_load(spec: str) -> tuple[str, Path, Path | None, Path | None]:
    parts = spec.split("=")
    if len(parts) == 1:
        return Path(parts[0]).stem, Path(parts[0]), None, None
    label, jf = parts[0], Path(parts[1])
    csv_dir = Path(parts[2]) if len(parts) > 2 and parts[2] else None
    payload = Path(parts[3]) if len(parts) > 3 and parts[3] else None
    return label, jf, csv_dir, payload


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--load", action="append", required=True, metavar="SPEC",
                    help="LABEL=DEPLOY_JSON[=CSV_DIR[=PAYLOAD_DIR]] or DEPLOY_JSON. Repeatable.")
    ap.add_argument("--out", required=True, help="output .xlsx")
    ap.add_argument("--describes", help="folder of `sf sobject describe --json` outputs (<Object>.json)")
    ap.add_argument("--record-types", help="`sf data query` JSON of RecordType (SobjectType, "
                                           "DeveloperName, Name). Default: <describes>/_recordtypes.json")
    ap.add_argument("--value-sets", help="folder holding globalValueSets/ and standardValueSets/ metadata")
    ap.add_argument("--source-stf", help="Source_<lang>_*.stf export: the org's own list of keys")
    ap.add_argument("--stf-dir", help="Bilingual_<lang>_*.stf exports. Rows whose target is now "
                                      "translated there are dropped as resolved.")
    ap.add_argument("--resolved-in-org", help="retrieved metadata (zip or folder). Grammar rows "
                                              "whose component already has gender/startsWith there are dropped as stale.")
    ap.add_argument("--baseline", help="known errors to subtract (one 'fullName :: problem' per line; "
                                       "see subtract_baseline.py --write-baseline)")
    ap.add_argument("--hide-diagnosis", action="append", default=[], metavar="CATEGORY",
                    help="ship this category without diagnosis/suggestion columns filled. Use it "
                         "when a per-row hint would read as more certain than it is. Repeatable.")
    ap.add_argument("--only-tab", action="append", default=[], help="emit only these category tabs")
    ap.add_argument("--drop-column", action="append", default=[], help="omit a column by header name")
    ap.add_argument("--note", action="append", default=[], help="a line for the top of the Summary")
    ap.add_argument("--title", default="Deploy errors - triage", help="Summary tab title")
    ap.add_argument("--developer-name", default="Developer",
                    help="who builds and loads the files (default: 'Developer')")
    ap.add_argument("--reviewer-name", default="Reviewer",
                    help="who owns the translated content (default: 'Reviewer')")
    ap.add_argument("--admin-name", default="Admin", help="who administers the org (default: 'Admin')")
    ap.add_argument("--allow-partial", action="store_true",
                    help="exit 0 even when a deploy did not fully land (off by default so a "
                         "SucceededPartial cannot pass unnoticed)")
    T.utf8_console()
    a = ap.parse_args(argv)

    import openpyxl
    from openpyxl.styles import Font
    from openpyxl.utils import get_column_letter

    P = Parties(a.developer_name, a.reviewer_name, a.admin_name)
    ev = Evidence(a.describes, a.record_types, a.value_sets, a.source_stf)
    stf_done = T.load_stf_translated(a.stf_dir)
    org_grammar = T.load_org_grammar(a.resolved_in_org)
    baseline = load_baseline(a.baseline)
    print(f"evidence: describes for {len(ev.picklists)} object(s), record types for "
          f"{len(ev.rectypes)}, {len(ev.value_sets)} value set(s), {len(ev.source_keys)} Source keys")

    buckets: dict[str, list[list]] = defaultdict(list)
    per_load: Counter = Counter()
    cat_by_load: dict[str, Counter] = defaultdict(Counter)
    dropped: Counter = Counter()
    not_landed = False
    labels = []

    for spec in a.load:
        label, jf, csv_dir, payload = parse_load(spec)
        labels.append(label)
        result, fails, oks = T.load_deploy(jf)
        by_pick, by_fld = build_indexes(T.load_csv_dir(csv_dir))
        not_landed |= report_impact(label, result, fails, oks, payload)

        for f in fails:
            full = f.get("fullName", "") or ""
            ctype = f.get("componentType", "") or ""
            problem = f.get("problem", "") or ""
            if f"{full} :: {T.strip_position(problem)}" in baseline:
                dropped["known baseline"] += 1
                continue
            lang, obj = T.parse_fullname(full)
            cat, gattr = T.categorise(problem)
            fdisp, bad, src, tr = lookup(lang, obj, problem, by_pick, by_fld)
            diag, sugg, who = diagnose(cat, problem, bad, fdisp, src, ev, P)
            sk = stf_key(cat, fdisp, bad, sugg)
            if sk and sk in stf_done.get(lang, set()):
                dropped["resolved (translated in the .stf export)"] += 1
                continue
            if cat in (T.GENDER_REQUIRED, T.GRAMMAR_REQUIRED) and (obj, lang) in org_grammar:
                dropped["stale grammar (already in the org)"] += 1
                continue
            if cat == T.INVALID_CHARS:
                # The translator often copied the damaged English into their cell. That is
                # the same defect, so repair it too when the repair is exact.
                sugg_tr = mojibake.repair(tr, sugg) if mojibake.is_mojibake(tr) else ""
            else:
                prefix_src = sugg
                if cat == T.DELETED_RT and sugg:
                    hit = ev.rectypes.get(fdisp.partition(".")[0], {}).get(norm(fdisp.partition(".")[2]))
                    prefix_src = hit[1] if hit else sugg
                sugg_tr = apply_prefix(prefix_src, tr) if sugg and sugg != bad else ""
            if cat in a.hide_diagnosis:
                diag = sugg = sugg_tr = who = ""
            per_load[label] += 1
            cat_by_load[cat][label] += 1
            buckets[cat].append([label, lang, full, ctype, fdisp, bad, src, tr, gattr,
                                 diag, sugg, sugg_tr, who, problem])

    st = T.styles()
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    ws = wb.create_sheet("Summary")
    ws.append([a.title])
    ws["A1"].font = st["title"]
    ws.append([])
    ws.append(["Each tab groups one kind of failure across every load."])
    ws.append(["'Diagnosis' and 'Who Must Act' say what the raw Salesforce message does not."])
    for n in a.note:
        ws.append([n])
        ws.cell(row=ws.max_row, column=1).font = Font(bold=True, color="C00000")
    for reason, n in dropped.items():
        ws.append([f"Not listed: {n} row(s) - {reason}"])
    ws.append([])
    ws.append(["Category"] + labels + ["Total"])
    T.style_header(ws, ws.max_row)
    for cat in sorted(cat_by_load, key=lambda c: -sum(cat_by_load[c].values())):
        ws.append([cat] + [cat_by_load[cat].get(lb, 0) for lb in labels]
                  + [sum(cat_by_load[cat].values())])
    ws.append(["TOTAL"] + [per_load[lb] for lb in labels] + [sum(per_load.values())])
    for c in ws[ws.max_row]:
        c.font = st["bold"]
    ws.column_dimensions["A"].width = 30
    for i in range(2, len(labels) + 3):
        ws.column_dimensions[get_column_letter(i)].width = 14

    keep = [i for i, h in enumerate(HEADERS) if h not in set(a.drop_column)]
    headers = [HEADERS[i] for i in keep]
    taken = {"Summary"}
    for cat in sorted(buckets, key=lambda c: -len(buckets[c])):
        if a.only_tab and cat not in a.only_tab:
            continue
        rows = [[r[i] for i in keep] for r in buckets[cat]]
        sh = wb.create_sheet(T.safe_sheet_name(cat, taken))
        sh.append(headers)
        T.style_header(sh)
        for i, r in enumerate(sorted(rows, key=lambda r: tuple(map(str, r[:3]))), start=2):
            sh.append(r)
            if i % 2 == 0:
                for c in sh[i]:
                    c.fill = st["alt_fill"]
            sh.cell(row=i, column=len(headers)).font = st["err_font"]
            for name in ACTION_COLS:
                if name in headers:
                    sh.cell(row=i, column=headers.index(name) + 1).fill = st["act_fill"]
        widths = dict(zip(HEADERS, WIDTHS))
        for idx, h in enumerate(headers, start=1):
            sh.column_dimensions[get_column_letter(idx)].width = widths.get(h, 24)
        sh.freeze_panes = "A2"
        sh.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows) + 1}"
        print(f"  {cat}: {len(rows)}")

    wb.save(a.out)
    for reason, n in dropped.items():
        print(f"dropped {n} row(s): {reason}")
    print(f"\nSaved: {a.out}")
    if not_landed and not a.allow_partial:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
