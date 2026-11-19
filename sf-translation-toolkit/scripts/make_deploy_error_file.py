#!/usr/bin/env python3
"""
Parse a Salesforce deploy/validate --json result and produce an xlsx error report.

Each category of failure gets its own tab. Each row shows:
  Language | Salesforce Component | Field / Value | English Source | Reviewer Translation | Error

Usage:
    python make_deploy_error_file.py <deploy.json> <csv_dir> [--out <output.xlsx>]

<csv_dir> must contain the --roundtrip CSVs produced by split_master_translations.py.
The script infers the language code from each CSV's `file` column.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter


# ── Failure categorisation ────────────────────────────────────────────────────

# Nothing here is "missing" in the sense of lost. A component is either absent because it
# was deliberately deleted from the org, or the reference in the payload is wrong. The
# names say which, so a reader is not sent looking for something that is never coming
# back.
CATEGORIES = [
    "Invalid Characters",      # mojibake in the source file
    "Value Not Found",  # picklist value not in the org under this key
    "Deleted Custom Field",
    "Deleted Record Type",
    "Gender Required",         # gender attribute missing — reviewers must supply
    "Grammar Required",        # article / possessive / startsWith missing
    "Deleted Org Component",   # object / ValidationRule / Flow removed from the org
    "Cannot Translate Language",
    "Other",
]

_PICKLIST_FIELD_RE   = re.compile(r"Invalid picklist value[:\s]+(.+?)\s+in field[:\s]+(.+?)(?:\s*\(\d+:\d+\))?$", re.I)
_PICKLIST_GVS_RE     = re.compile(r"Invalid picklist value[:\s]+(.+?)\s+in picklist value set translations[:\s]+(.+?)(?:\s*\(\d+:\d+\))?$", re.I)
_PICKLIST_BATCH_RE   = re.compile(r"There are \d+ invalid picklist values", re.I)
_MISSING_OBJECT_RE   = re.compile(r"Invalid object name:\s*(.+)", re.I)
_MISSING_FIELD_RE    = re.compile(r"no (?:Custom)?[Ff]ield named (.+?) found", re.I)
_MISSING_RT_RE       = re.compile(r"no RecordType named (.+?) found", re.I)
_GRAMMAR_RE          = re.compile(r"(gender|article|possessive|startsWith) is required", re.I)
_DELETED_COMP_RE     = re.compile(r"no (ValidationRule|Flow|WorkflowRule|WebLink|CustomTab|ApexClass|ApexTrigger) named (.+?) found", re.I)
_CANNOT_TRANSLATE_RE = re.compile(r"cannot translate into", re.I)


def load_org_grammar(path: str) -> set[tuple[str, str]]:
    """{(object, language)} whose translation already carries a gender/startsWith in the org.

    Re-running an old load file re-reports "Gender is required" for components that were
    since fixed from a separate file, because the old workbook still has no gender column.
    Those rows are stale, not outstanding. The org is the authority, so this reads retrieved
    metadata (a Metadata API zip or a directory of objectTranslation files) rather than
    trusting a hard-coded list.
    """
    import zipfile

    done: set[tuple[str, str]] = set()

    def note(base: str, text: str):
        obj, _, lang = base.rpartition("-")
        if obj and lang and ("<gender>" in text or "<startsWith>" in text):
            done.add((obj, lang))

    p = Path(path)
    if p.is_file() and p.suffix == ".zip":
        with zipfile.ZipFile(p) as z:
            for n in z.namelist():
                if n.endswith(".objectTranslation"):
                    note(Path(n).name[: -len(".objectTranslation")],
                         z.read(n).decode("utf-8", "replace"))
    elif p.is_dir():
        for f in p.rglob("*.objectTranslation*"):
            note(f.name.split(".")[0], f.read_text(encoding="utf-8", errors="replace"))
        for f in p.rglob("*.zip"):
            done |= load_org_grammar(str(f))
    return done


def categorise(problem: str) -> tuple[str, str]:
    """Return (category, grammar_attribute_or_empty)."""
    if _PICKLIST_FIELD_RE.search(problem) or _PICKLIST_GVS_RE.search(problem) or _PICKLIST_BATCH_RE.search(problem):
        return "Invalid Picklist Value", ""
    if _MISSING_OBJECT_RE.search(problem):
        # An absent object sits with the other deleted org components — same cause, same
        # (non-)remedy — rather than in a category of its own.
        return "Deleted Org Component", ""
    if _MISSING_FIELD_RE.search(problem):
        return "Deleted Custom Field", ""
    if _MISSING_RT_RE.search(problem):
        return "Deleted Record Type", ""
    m = _GRAMMAR_RE.search(problem)
    if m:
        attr = m.group(1).lower()
        if attr == "gender":
            return "Gender Required", "Gender"
        return "Grammar Required", attr.capitalize()
    if _DELETED_COMP_RE.search(problem):
        return "Deleted Org Component", ""
    if _CANNOT_TRANSLATE_RE.search(problem):
        return "Cannot Translate Language", ""
    return "Other", ""


# ── Language code inference from the CSV `file` column ───────────────────────

_LANG_FROM_FILE_RE = re.compile(
    r"objectTranslations/[^/]+-([a-z]{2,3}(?:_[A-Z]{2})?)/|"
    r"globalValueSetTranslations/[^-]+-([a-z]{2,3}(?:_[A-Z]{2})?)\.globalValueSet|"
    r"standardValueSetTranslations/[^-]+-([a-z]{2,3}(?:_[A-Z]{2})?)\.standardValueSet|"
    r"translations/([a-z]{2,3}(?:_[A-Z]{2})?)\.translation"
)


def _lang_from_file_col(file_col: str) -> str | None:
    m = _LANG_FROM_FILE_RE.search(file_col)
    if m:
        return next(g for g in m.groups() if g)
    return None


# ── Load all per-language CSVs keyed by language code ────────────────────────

def load_csvs(csv_dir: Path) -> dict[str, list[dict]]:
    """Return {lang_code: [row_dict, ...]} for every CSV that has a recognisable language code."""
    result: dict[str, list[dict]] = {}
    for csv_file in sorted(csv_dir.glob("*.csv")):
        rows: list[dict] = []
        with open(csv_file, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                rows.append(row)
        if not rows:
            continue
        lang = _lang_from_file_col(rows[0].get("file", ""))
        if lang:
            result[lang] = rows
    return result


# ── Build lookup indexes for fast matching ────────────────────────────────────

def build_indexes(lang_rows: dict[str, list[dict]]):
    """
    Returns two indexes, both keyed by (lang, lookup_key) -> (source, translation):
      - by_picklist: key = (object_or_gvs, field_or_None, masterLabel)
      - by_field:    key = (object, field)  where field may include a component prefix
    """
    # (lang, component, field, masterLabel) -> (source, translation)
    by_picklist: dict[tuple, tuple[str, str]] = {}
    # (lang, component, field) -> (source, translation)
    by_field: dict[tuple, tuple[str, str]] = {}

    for lang, rows in lang_rows.items():
        for row in rows:
            comp  = row.get("component", "")
            field = row.get("field", "")
            mlabel = row.get("masterLabel", "")
            src    = row.get("source", "")
            trans  = row.get("translation", "")
            if mlabel:
                by_picklist[(lang, comp, field, mlabel)] = (src, trans)
                by_picklist[(lang, comp, "",    mlabel)] = (src, trans)  # GVS match without field
            else:
                by_field[(lang, comp, field)] = (src, trans)

    return by_picklist, by_field


# ── Extract lang + object from SF component fullName ─────────────────────────

def parse_fullname(full_name: str, comp_type: str) -> tuple[str, str]:
    """Return (lang, object_or_gvs_name)."""
    # CustomObjectTranslation: "Account-de" or "Account-nl_NL"
    # GlobalValueSetTranslation: "Size_Set-de"
    m = re.match(r"^(.+)-([a-z]{2,3}(?:_[A-Z]{2})?)$", full_name)
    if m:
        return m.group(2), m.group(1)
    return "", full_name


# ── Look up reviewer-provided source + translation for a failure ─────────────

def lookup_reviewer_value(
    lang: str,
    obj: str,
    problem: str,
    comp_type: str,
    by_picklist: dict,
    by_field: dict,
) -> tuple[str, str, str, str]:
    """
    Returns (field_display, value_display, source, translation).
    Tries to extract field/value from the error message and match to CSV data.
    """
    # Invalid picklist (CustomObjectTranslation format)
    m = _PICKLIST_FIELD_RE.search(problem)
    if m:
        bad_value = m.group(1).strip()
        full_field = m.group(2).strip()
        # full_field is like "Object.FieldName"
        parts = full_field.split(".", 1)
        field = parts[1] if len(parts) == 2 else full_field
        comp  = parts[0] if len(parts) == 2 else obj
        src, trans = by_picklist.get((lang, comp, field, bad_value),
                     by_picklist.get((lang, comp, "", bad_value), ("", "")))
        return full_field, bad_value, src, trans

    # Invalid picklist (GlobalValueSetTranslation format)
    m = _PICKLIST_GVS_RE.search(problem)
    if m:
        bad_value = m.group(1).strip()
        gvs_lang  = m.group(2).strip()
        gvs_name  = gvs_lang.rsplit("-", 1)[0] if "-" in gvs_lang else obj
        src, trans = by_picklist.get((lang, gvs_name, "", bad_value), ("", ""))
        return gvs_name, bad_value, src, trans

    # Missing custom field
    m = _MISSING_FIELD_RE.search(problem)
    if m:
        full_field = m.group(1).strip()
        parts = full_field.split(".", 1)
        field = parts[1] if len(parts) == 2 else full_field
        comp  = parts[0] if len(parts) == 2 else obj
        src, trans = by_field.get((lang, comp, field), ("", ""))
        return full_field, "", src, trans

    # Missing record type
    m = _MISSING_RT_RE.search(problem)
    if m:
        full_rt = m.group(1).strip()
        parts = full_rt.split(".", 1)
        field = parts[1] if len(parts) == 2 else full_rt
        comp  = parts[0] if len(parts) == 2 else obj
        src, trans = by_field.get((lang, comp, field), ("", ""))
        return full_rt, "", src, trans

    return "", "", "", ""


# ── Spreadsheet helpers ───────────────────────────────────────────────────────

HEADER_FILL   = PatternFill("solid", fgColor="1F3864")
HEADER_FONT   = Font(color="FFFFFF", bold=True)
ALT_ROW_FILL  = PatternFill("solid", fgColor="DCE6F1")
ERROR_FONT    = Font(color="C00000")


def _write_sheet(ws, headers: list[str], rows: list[list]):
    ws.append(headers)
    for cell in ws[1]:
        cell.fill   = HEADER_FILL
        cell.font   = HEADER_FONT
        cell.alignment = Alignment(wrap_text=True)

    for i, row in enumerate(rows, start=2):
        ws.append(row)
        if i % 2 == 0:
            for cell in ws[i]:
                cell.fill = ALT_ROW_FILL
        # Colour error column red
        error_col = len(headers)
        ws.cell(row=i, column=error_col).font = ERROR_FONT

    # Auto-width (capped at 60)
    for col_idx, col_cells in enumerate(ws.columns, start=1):
        max_len = max((len(str(c.value or "")) for c in col_cells), default=0)
        ws.column_dimensions[get_column_letter(col_idx)].width = min(max_len + 2, 60)


HEADERS = ["Language", "Salesforce Component", "Component Type", "Field / GVS", "Bad Value",
           "English Source", "Reviewer Translation", "Grammar Attribute", "Error Message"]


# ── Payload-impact gate ──────────────────────────────────────────────────────

_ELEMENT_RE = re.compile(r"<(?:label|translation|name)>[^<]+</(?:label|translation|name)>")


def count_elements(payload_dir: Path, component: str) -> int:
    """Translated elements a component carried in the payload.

    A CustomObjectTranslation deploys all-or-nothing, so a single bad field
    reference discards every translation in that object/language. Counting the
    component's own files is the only way to see what a failure actually cost.
    """
    comp_dir = payload_dir / "objectTranslations" / component
    if not comp_dir.is_dir():
        flat = payload_dir / "translations" / f"{component}.translation-meta.xml"
        files = [flat] if flat.is_file() else []
    else:
        files = list(comp_dir.glob("*.xml"))
    total = 0
    for f in files:
        try:
            total += len(_ELEMENT_RE.findall(f.read_text(encoding="utf-8")))
        except OSError:
            pass
    return total


def report_payload_impact(result: dict, failures: list, payload_dir: Path | None) -> bool:
    """Print what the deploy actually landed. Returns True if anything was lost.

    `SucceededPartial` reads like success and is the dangerous case: a load can
    report hundreds of components OK while most of the objectTranslation payload
    never landed (one bad reference discards the whole object/language file).
    Nothing else in the pipeline says so.
    """
    status = str(result.get("status", "?"))
    failed = sorted({f.get("fullName") for f in failures if f.get("fullName")})
    ok_raw = result.get("details", {}).get("componentSuccesses", []) or []
    if isinstance(ok_raw, dict):
        ok_raw = [ok_raw]
    ok = sorted({s.get("fullName") for s in ok_raw if s.get("fullName")})

    print("\n" + "=" * 68)
    print(f"DEPLOY STATUS: {status}")
    print(f"  components landed : {len(ok)}")
    print(f"  components FAILED : {len(failed)}")

    lost = landed = 0
    if payload_dir and payload_dir.is_dir():
        lost = sum(count_elements(payload_dir, c) for c in failed)
        landed = sum(count_elements(payload_dir, c) for c in ok)
        tot = lost + landed
        print(f"  translated elements landed : {landed:,}")
        print(f"  translated elements LOST   : {lost:,}")
        if tot:
            print(f"  -> {100 * lost / tot:.1f}% of the payload did NOT land")
    else:
        print("  (pass --payload-dir to measure how many translations were lost)")

    if status != "Succeeded" or failed:
        print("\n  *** THIS DEPLOY DID NOT FULLY LAND ***")
        print("  A CustomObjectTranslation is all-or-nothing: one bad field, record type")
        print("  or picklist reference discards EVERY translation in that object/language.")
        print("  Fix the references and redeploy — do not treat this run as complete.")
        if failed:
            print(f"\n  worst-hit components ({min(len(failed), 10)} of {len(failed)}):")
            ranked = sorted(failed, key=lambda c: -count_elements(payload_dir, c)) \
                if payload_dir and payload_dir.is_dir() else failed
            for c in ranked[:10]:
                n = count_elements(payload_dir, c) if payload_dir and payload_dir.is_dir() else 0
                print(f"     {c:34} {n:6,} elements lost" if n else f"     {c}")
        print("=" * 68)
        return True
    print("  all components landed")
    print("=" * 68)
    return False


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("deploy_json",  help="Path to deploy/validate --json output")
    ap.add_argument("csv_dir",      help="Directory containing per-language CSVs (--roundtrip format)")
    ap.add_argument("--out", default="deploy_errors.xlsx", help="Output xlsx file")
    ap.add_argument("--resolved-in-org",
                    help="Retrieved metadata (zip or dir). Grammar rows whose component "
                         "already carries gender/startsWith there are dropped as stale.")
    ap.add_argument("--payload-dir",
                    help="The folder that was deployed (e.g. work\\<run>\\out). Lets the "
                         "run report how many translations the failed components took "
                         "down with them.")
    ap.add_argument("--allow-partial", action="store_true",
                    help="Exit 0 even when the deploy only partially landed. Off by "
                         "default so a SucceededPartial cannot pass unnoticed.")
    args = ap.parse_args()

    # Load deploy JSON
    raw = json.load(open(args.deploy_json, encoding="utf-8-sig"))
    result = raw.get("result", raw)
    failures = result.get("details", {}).get("componentFailures", [])
    if isinstance(failures, dict):
        failures = [failures]

    print(f"Total SF components:  {result.get('numberComponentsTotal', '?')}")
    print(f"Passed:               {result.get('numberComponentsDeployed', '?')}")
    print(f"Failed:               {len(failures)}")

    # Load CSVs
    csv_dir = Path(args.csv_dir)
    lang_rows = load_csvs(csv_dir)
    print(f"Loaded CSVs for {len(lang_rows)} languages: {', '.join(sorted(lang_rows))}")

    by_picklist, by_field = build_indexes(lang_rows)
    org_grammar = load_org_grammar(args.resolved_in_org) if args.resolved_in_org else set()
    if org_grammar:
        print(f"Org already has grammar for {len(org_grammar)} component(s)")
    dropped_stale = 0

    # Build category buckets
    buckets: dict[str, list[list]] = {cat: [] for cat in CATEGORIES}

    for f in failures:
        full_name  = f.get("fullName", "")
        comp_type  = f.get("componentType", "")
        problem    = f.get("problem", "")
        lang, obj         = parse_fullname(full_name, comp_type)
        cat, grammar_attr = categorise(problem)

        field_disp, val_disp, src, trans = lookup_reviewer_value(
            lang, obj, problem, comp_type, by_picklist, by_field
        )

        # Encoding check takes priority: any non-ASCII in the error message means
        # Salesforce echoed back garbled text from the source file
        if any(ord(c) > 127 for c in problem):
            cat = "Invalid Characters"
            grammar_attr = ""
        elif cat == "Invalid Picklist Value":
            cat = "Value Not Found"

        if cat in ("Gender Required", "Grammar Required") and (obj, lang) in org_grammar:
            dropped_stale += 1
            continue

        buckets[cat].append([
            lang, full_name, comp_type, field_disp, val_disp, src, trans, grammar_attr, problem
        ])

    # Build workbook
    wb = openpyxl.Workbook()
    wb.remove(wb.active)  # remove default sheet

    # Summary tab
    ws_sum = wb.create_sheet("Summary")
    ws_sum.append(["Category", "Count"])
    ws_sum["A1"].font = Font(bold=True)
    ws_sum["B1"].font = Font(bold=True)
    total = 0
    for cat in CATEGORIES:
        n = len(buckets[cat])
        total += n
        ws_sum.append([cat, n])
    ws_sum.append(["TOTAL", total])
    ws_sum.cell(row=len(CATEGORIES)+2, column=1).font = Font(bold=True)
    ws_sum.cell(row=len(CATEGORIES)+2, column=2).font = Font(bold=True)
    ws_sum.column_dimensions["A"].width = 30
    ws_sum.column_dimensions["B"].width = 10

    # Category tabs
    for cat in CATEGORIES:
        rows = buckets[cat]
        if not rows:
            continue
        # Sanitise sheet name (Excel limit 31 chars, no special chars)
        sheet_name = cat[:31].replace("/", "-").replace("\\", "-")
        ws = wb.create_sheet(sheet_name)
        _write_sheet(ws, HEADERS, sorted(rows, key=lambda r: (r[0], r[1])))
        print(f"  {cat}: {len(rows)} rows")

    if dropped_stale:
        print(f"  (dropped {dropped_stale} stale grammar row(s) already satisfied in the org)")
    out_path = args.out
    wb.save(out_path)
    print(f"\nSaved: {out_path}")

    lost_anything = report_payload_impact(
        result, failures, Path(args.payload_dir) if args.payload_dir else None
    )
    if lost_anything and not args.allow_partial:
        sys.exit(2)


if __name__ == "__main__":
    main()
