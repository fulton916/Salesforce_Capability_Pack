"""Shared helpers for the deploy-triage scripts (this package only).

Covers: reading `sf ... --json` deploy/validate results, classifying component failures,
reading translation CSVs, the per-language grammar rules Salesforce enforces, a minimal
.stf reader, and workbook styling.

Translation CSV layout (one file per language, translations_<lang>.csv):
  file, type, component, field, masterLabel, source, translation[, gender, startsWith, ...]
  `file` is the target metadata path (objectTranslations/Widget__c-de/Color__c.fieldTranslation-meta.xml);
  `type` is field-label | field-picklist | standard-field | object-label | record-type |
  validation-rule | layout-section | custom-label | global-value | standard-value.
"""
from __future__ import annotations

import csv
import json
import re
import sys
import zipfile
from pathlib import Path

# ── Console ──────────────────────────────────────────────────────────────────


def utf8_console() -> None:
    """Make --help and output safe on a Windows cp1252 console."""
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")


# ── Deploy / validate JSON ───────────────────────────────────────────────────


def load_json_multi(path: Path | str):
    """Parse a JSON file written by `sf ... --json > file`.

    Handles a UTF-8 BOM (PowerShell redirection writes one) and a warning object printed
    before the payload: the LAST JSON document in the file is returned.
    """
    t = Path(path).read_text(encoding="utf-8-sig")
    dec, i, last = json.JSONDecoder(), 0, None
    while i < len(t):
        s = t[i:].lstrip()
        if not s:
            break
        try:
            obj, end = dec.raw_decode(t, len(t) - len(s))
        except ValueError:
            break
        last, i = obj, end
    if last is None:
        raise ValueError(f"{path}: no JSON found")
    return last


def _as_list(x) -> list:
    if not x:
        return []
    return [x] if isinstance(x, dict) else list(x)


def load_deploy(path: Path | str) -> tuple[dict, list[dict], list[dict]]:
    """(result, componentFailures, componentSuccesses) from a deploy/validate JSON."""
    raw = load_json_multi(path)
    result = raw.get("result", raw) if isinstance(raw, dict) else {}
    details = result.get("details") or {}
    return result, _as_list(details.get("componentFailures")), _as_list(details.get("componentSuccesses"))


_FULLNAME_RE = re.compile(r"^(.+)-([a-z]{2,3}(?:_[A-Z]{2})?)$")


def parse_fullname(full_name: str) -> tuple[str, str]:
    """'Widget__c-de' -> ('de', 'Widget__c'); 'Country-pt_BR' -> ('pt_BR', 'Country')."""
    m = _FULLNAME_RE.match(full_name or "")
    return (m.group(2), m.group(1)) if m else ("", full_name or "")


def strip_position(problem: str) -> str:
    """Drop the '(12:5)' line:column suffix so the same error matches across runs."""
    return re.sub(r"\s*\(\d+:\d+\)", "", problem or "").strip()


# ── Failure categories ───────────────────────────────────────────────────────

INVALID_CHARS = "Invalid Characters"
VALUE_NOT_FOUND = "Value Not Found"
DELETED_FIELD = "Deleted Custom Field"
DELETED_RT = "Deleted Record Type"
DELETED_COMPONENT = "Deleted Org Component"
GENDER_REQUIRED = "Gender Required"
GRAMMAR_REQUIRED = "Grammar Required"
INVALID_GRAMMAR = "Invalid Grammar Value"
NAMESPACED = "Namespaced Language"
CANNOT_TRANSLATE = "Language Not Enabled"
OTHER = "Other"

CATEGORIES = [INVALID_CHARS, VALUE_NOT_FOUND, DELETED_FIELD, DELETED_RT, DELETED_COMPONENT,
              GENDER_REQUIRED, GRAMMAR_REQUIRED, INVALID_GRAMMAR, NAMESPACED, CANNOT_TRANSLATE,
              OTHER]

PICKLIST_FIELD_RE = re.compile(
    r"Invalid picklist value[:\s]+(.+?)\s+in field[:\s]+(.+?)(?:\s*\(\d+:\d+\))?$", re.I)
PICKLIST_GVS_RE = re.compile(
    r"Invalid picklist value[:\s]+(.+?)\s+in picklist value set translations[:\s]+(.+?)"
    r"(?:\s*\(\d+:\d+\))?$", re.I)
PICKLIST_BATCH_RE = re.compile(r"There are \d+ invalid picklist values", re.I)
MISSING_OBJECT_RE = re.compile(r"Invalid object name:\s*(.+)", re.I)
MISSING_FIELD_RE = re.compile(r"no (?:Custom)?[Ff]ield named (.+?) found", re.I)
MISSING_RT_RE = re.compile(r"no RecordType named (.+?) found", re.I)
GRAMMAR_RE = re.compile(r"(gender|article|possessive|startsWith) is required", re.I)
INVALID_ENUM_RE = re.compile(r"not a valid value for the enum|Invalid (gender|article|startsWith)", re.I)
DELETED_COMP_RE = re.compile(
    r"no (ValidationRule|Flow|WorkflowRule|WebLink|CustomTab|ApexClass|ApexTrigger|Layout|"
    r"QuickAction|CustomLabel|ExternalString) named (.+?) found", re.I)
NAMESPACED_RE = re.compile(r"namespaced language", re.I)
CANNOT_TRANSLATE_RE = re.compile(r"cannot translate into|not a valid language|"
                                 r"language .* is not (?:enabled|supported)", re.I)


def categorise(problem: str) -> tuple[str, str]:
    """(category, grammar attribute or '') for one componentFailure 'problem' text."""
    import mojibake
    if mojibake.is_mojibake(problem):
        return INVALID_CHARS, ""
    if PICKLIST_FIELD_RE.search(problem) or PICKLIST_GVS_RE.search(problem) \
            or PICKLIST_BATCH_RE.search(problem):
        return VALUE_NOT_FOUND, ""
    if MISSING_OBJECT_RE.search(problem):
        return DELETED_COMPONENT, ""
    if MISSING_FIELD_RE.search(problem):
        return DELETED_FIELD, ""
    if MISSING_RT_RE.search(problem):
        return DELETED_RT, ""
    m = GRAMMAR_RE.search(problem)
    if m:
        attr = m.group(1).lower()
        if attr == "gender":
            return GENDER_REQUIRED, "Gender"
        return GRAMMAR_REQUIRED, {"startswith": "StartsWith"}.get(attr, attr.capitalize())
    if INVALID_ENUM_RE.search(problem):
        return INVALID_GRAMMAR, ""
    if DELETED_COMP_RE.search(problem):
        return DELETED_COMPONENT, ""
    if NAMESPACED_RE.search(problem):
        return NAMESPACED, ""
    if CANNOT_TRANSLATE_RE.search(problem):
        return CANNOT_TRANSLATE, ""
    return OTHER, ""


def grammar_pairs(failures: list[dict], attrs=("gender", "startsWith")) -> dict[tuple[str, str], set[str]]:
    """{(component, lang): {attributes Salesforce asked for}} for grammar failures."""
    want = {a.lower() for a in attrs}
    out: dict[tuple[str, str], set[str]] = {}
    for f in failures:
        m = GRAMMAR_RE.search(f.get("problem", "") or "")
        if not m or m.group(1).lower() not in want:
            continue
        lang, comp = parse_fullname(f.get("fullName", ""))
        if lang:
            attr = "startsWith" if m.group(1).lower() == "startswith" else "gender"
            out.setdefault((comp, lang), set()).add(attr)
    return out


# ── Translation CSVs ─────────────────────────────────────────────────────────

_LANG_FROM_FILE_RE = re.compile(
    r"objectTranslations/[^/]+-([a-z]{2,3}(?:_[A-Z]{2})?)/|"
    r"objectTranslations/[^/]+-([a-z]{2,3}(?:_[A-Z]{2})?)\.objectTranslation|"
    r"(?:global|standard)ValueSetTranslations/[^/]+-([a-z]{2,3}(?:_[A-Z]{2})?)\.|"
    r"translations/([a-z]{2,3}(?:_[A-Z]{2})?)\.translation"
)
_LANG_FROM_NAME_RE = re.compile(r"^translations_([A-Za-z]{2,3}(?:_[A-Za-z]{2})?)\.csv$")


def lang_from_file_col(file_col: str) -> str | None:
    m = _LANG_FROM_FILE_RE.search((file_col or "").replace("\\", "/"))
    return next((g for g in m.groups() if g), None) if m else None


def row_lang(row: dict, default: str | None = None) -> str | None:
    return lang_from_file_col(row.get("file", "")) or default


def read_csv(path: Path) -> tuple[list[str], list[dict]]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        rd = csv.DictReader(f)
        return list(rd.fieldnames or []), list(rd)


def write_csv(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def file_language(path: Path, rows: list[dict]) -> str | None:
    m = _LANG_FROM_NAME_RE.match(path.name)
    if m:
        return m.group(1)
    return next((lg for lg in (lang_from_file_col(r.get("file", "")) for r in rows) if lg), None)


def load_csv_dir(csv_dir: Path | str | None) -> dict[str, list[dict]]:
    """{lang: rows} for every translation CSV in csv_dir (each row gets '_lang')."""
    out: dict[str, list[dict]] = {}
    if not csv_dir:
        return out
    for p in sorted(Path(csv_dir).glob("*.csv")):
        _hdr, rows = read_csv(p)
        default = file_language(p, rows)
        for r in rows:
            lg = row_lang(r, default)
            if lg:
                r["_lang"] = lg
                out.setdefault(lg, []).append(r)
    return out


# ── Languages and the grammar Salesforce enforces ────────────────────────────

# Display names for Salesforce language codes, as Translation Workbench shows them. A
# reference, not a list of languages any org must have: a code missing here is shown as
# the code itself.
LANGUAGE_NAMES = {
    "en_US": "English", "en_CA": "English (Canada)", "en_GB": "English (UK)",
    "en_IN": "English (India)", "ar": "Arabic", "bg": "Bulgarian",
    "ca": "Catalan", "cs": "Czech", "cy": "Welsh", "da": "Danish", "de": "German",
    "de_AT": "German (Austria)", "de_CH": "German (Switzerland)", "el": "Greek",
    "es": "Spanish", "es_MX": "Spanish (Mexico)", "et": "Estonian", "fi": "Finnish",
    "fr": "French", "fr_BE": "French (Belgium)", "fr_CA": "French (Canada)",
    "fr_CH": "French (Switzerland)", "ga": "Irish", "hi": "Hindi", "hr": "Croatian",
    "hu": "Hungarian", "in": "Indonesian", "it": "Italian",
    "it_CH": "Italian (Switzerland)", "iw": "Hebrew", "ja": "Japanese", "kk": "Kazakh",
    "ko": "Korean", "lt": "Lithuanian", "lv": "Latvian", "ms": "Malay", "mt": "Maltese",
    "nl_BE": "Dutch (Belgium)", "nl_NL": "Dutch", "no": "Norwegian", "pl": "Polish",
    "pt_BR": "Portuguese (Brazil)", "pt_PT": "Portuguese (European)", "ro": "Romanian",
    "ru": "Russian", "sh": "Serbian (Latin)", "sk": "Slovak", "sl": "Slovenian",
    "sr": "Serbian (Cyrillic)", "sv": "Swedish", "th": "Thai", "tr": "Turkish",
    "uk": "Ukrainian", "vi": "Vietnamese", "zh_CN": "Chinese (Simplified)",
    "zh_TW": "Chinese (Traditional)",
}

STARTS_WITH_VALUES = ["Vowel sound", "Consonant sound"]
_SW_TO_METADATA = {"vowel sound": "Vowel", "consonant sound": "Consonant",
                   "vowel": "Vowel", "consonant": "Consonant",
                   "yes": "Vowel", "no": "Consonant"}

# Reference of the grammar Salesforce enforces on translated labels: the gender values it
# accepts per language, and whether the language also needs a startsWith. It covers the
# common gendered languages and is not exhaustive; a language missing here is treated as
# needing no grammar. Validated per LANGUAGE: Masculine is a real enum member but Dutch
# rejects it. Danish, Swedish and Dutch common gender maps to Feminine (Salesforce has no
# "Common"). The regional variants listed carry the same rules as their base language.
# Extend or override with --grammar-rules <json> ({"xx": {"gender": [...], "startsWith": true}}).
GRAMMAR_RULES: dict[str, dict] = {
    "en_US": {"gender": [], "startsWith": True},
    "hu":    {"gender": [], "startsWith": True},
    "cs":    {"gender": ["Neuter", "Feminine", "Masculine", "AnimateMasculine"]},
    "pl":    {"gender": ["Neuter", "Feminine", "Masculine", "AnimateMasculine"]},
    "ru":    {"gender": ["Neuter", "Feminine", "Masculine", "AnimateMasculine"]},
    "sk":    {"gender": ["Neuter", "Feminine", "Masculine", "AnimateMasculine"]},
    "da":    {"gender": ["Feminine", "Neuter"]},
    "sv":    {"gender": ["Feminine", "Neuter"]},
    "nl_NL": {"gender": ["Feminine", "Neuter"]},
    "de":    {"gender": ["Masculine", "Feminine", "Neuter"]},
    "ro":    {"gender": ["Masculine", "Feminine", "Neuter"]},
    "fr":    {"gender": ["Masculine", "Feminine"], "startsWith": True},
    "fr_BE": {"gender": ["Masculine", "Feminine"], "startsWith": True},
    "fr_CA": {"gender": ["Masculine", "Feminine"], "startsWith": True},
    "it":    {"gender": ["Masculine", "Feminine"], "startsWith": True},
    "es":    {"gender": ["Masculine", "Feminine"]},
    "es_MX": {"gender": ["Masculine", "Feminine"]},
    "pt_PT": {"gender": ["Masculine", "Feminine"]},
    "pt_BR": {"gender": ["Masculine", "Feminine"]},
    "lv":    {"gender": ["Masculine", "Feminine"]},
    "lt":    {"gender": ["Masculine", "Feminine"]},
}


def load_grammar_rules(path: str | None) -> dict[str, dict]:
    rules = {k: dict(v) for k, v in GRAMMAR_RULES.items()}
    if path:
        rules.update(json.loads(Path(path).read_text(encoding="utf-8")))
    return rules


def grammar_attrs(lang: str, rules: dict, asked: set[str] = frozenset()) -> list[tuple[str, list[str]]]:
    """[(attribute, valid values)] a language needs: 'gender' and/or 'startsWith'.

    Salesforce reports only the FIRST missing attribute per component, so a language that
    needs both is asked for both at once, whatever the error named.
    """
    r = rules.get(lang) or {}
    out = []
    if r.get("gender") or ("gender" in asked and not r.get("startsWith")):
        out.append(("gender", list(r.get("gender") or [])))
    if r.get("startsWith") or "startsWith" in asked:
        out.append(("startsWith", list(STARTS_WITH_VALUES)))
    return out


def sw_metadata(value: str) -> str:
    """What a person picked ('Vowel sound', 'Yes') -> the Salesforce enum ('Vowel')."""
    return _SW_TO_METADATA.get((value or "").strip().lower(), (value or "").strip())


def sw_display(value: str) -> str:
    v = sw_metadata(value)
    return {"Vowel": "Vowel sound", "Consonant": "Consonant sound"}.get(v, v)


# ── Org evidence ─────────────────────────────────────────────────────────────


def load_org_grammar(path: str | None) -> set[tuple[str, str]]:
    """{(object, language)} whose translation already carries a gender/startsWith in the org.

    Re-running an old load file re-reports "Gender is required" for components fixed since
    from a separate file. Those rows are stale, not outstanding. Reads retrieved metadata:
    a Metadata API zip, or a folder of objectTranslation files.
    """
    done: set[tuple[str, str]] = set()
    if not path:
        return done

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
        for f in p.rglob("*"):
            if not f.is_file():
                continue
            if ".objectTranslation" in f.name:
                note(f.name.split(".")[0], f.read_text(encoding="utf-8", errors="replace"))
            elif ".fieldTranslation" in f.name:       # source format: grammar sits per field
                note(f.parent.name, f.read_text(encoding="utf-8", errors="replace"))
            elif f.suffix == ".zip":
                done |= load_org_grammar(str(f))
    return done


def stf_language(path: Path) -> str | None:
    m = re.match(r"^(?:Bilingual|Source)_(.+?)_\d{4}-\d{2}-\d{2}", path.name)
    return m.group(1) if m else None


def read_stf_rows(path: Path) -> list[tuple[str, str, str, str]]:
    """[(section, key, label, translation)] from a .stf export. Source rows: section 'SOURCE'."""
    out, section = [], "SOURCE"
    for line in Path(path).read_bytes().decode("utf-8-sig", "replace").splitlines():
        if not line or line.startswith("#"):
            continue
        if line.startswith("-") and line.strip("- ").strip():
            section = line.strip("- ").strip().upper()
            continue
        parts = line.split("\t")
        if len(parts) < 2 or "." not in parts[0]:
            continue
        out.append((section, parts[0], parts[1], parts[2] if len(parts) > 2 else ""))
    return out


def load_stf_translated(stf_dir: str | None) -> dict[str, set[str]]:
    """{language: {keys that HAVE a translation}} from Bilingual_<lang>_*.stf exports."""
    out: dict[str, set[str]] = {}
    if not stf_dir:
        return out
    for p in sorted(Path(stf_dir).rglob("Bilingual_*.stf")):
        lang = stf_language(p)
        if lang:
            out[lang] = {k for sec, k, _l, tr in read_stf_rows(p)
                         if sec == "TRANSLATED" and tr.strip()}
    return out


def load_source_keys(path: str | None) -> set[str]:
    """Every translatable key in a Source_<lang>_*.stf export: the org's own key list."""
    if not path:
        return set()
    return {k for _s, k, _l, _t in read_stf_rows(Path(path))}


# ── Workbook styling ─────────────────────────────────────────────────────────


def styles():
    from openpyxl.styles import Alignment, Font, PatternFill
    return {
        "hdr_fill": PatternFill("solid", fgColor="1F3864"),
        "hdr_font": Font(color="FFFFFF", bold=True),
        "alt_fill": PatternFill("solid", fgColor="DCE6F1"),
        "err_font": Font(color="C00000"),
        "act_fill": PatternFill("solid", fgColor="FFF2CC"),
        "in_font": Font(bold=True, color="7F6000"),
        "wrap": Alignment(wrap_text=True, vertical="center"),
        "bold": Font(bold=True),
        "title": Font(bold=True, size=14),
    }


def style_header(ws, row: int = 1) -> None:
    st = styles()
    for c in ws[row]:
        c.fill, c.font, c.alignment = st["hdr_fill"], st["hdr_font"], st["wrap"]


def safe_sheet_name(name: str, taken: set[str] | None = None) -> str:
    """Excel limits: 31 characters, none of []:*?/\\, unique in the workbook."""
    base = re.sub(r"[\[\]:*?/\\]", "-", name)[:31]
    taken = taken if taken is not None else set()
    out, n = base, 2
    while out.lower() in {t.lower() for t in taken}:
        suffix = f" ({n})"
        out = base[: 31 - len(suffix)] + suffix
        n += 1
    taken.add(out)
    return out


def sheet_rows(ws) -> tuple[list[str], list[dict]]:
    """(headers, [row dict]) for a worksheet whose first row is the header."""
    it = ws.iter_rows(values_only=True)
    try:
        hdr = [str(h) if h is not None else "" for h in next(it)]
    except StopIteration:
        return [], []
    rows = []
    for r in it:
        if r is None or all(v is None for v in r):
            continue
        rows.append({h: ("" if v is None else str(v)) for h, v in zip(hdr, r)})
    return hdr, rows
