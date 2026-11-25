#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Split the master translations workbook into one CSV per language.

Reads one worksheet of a master translations workbook (--sheet) and writes
`translations-<language>.csv` for every language found in the header row.
Each output keeps the six key columns (A-F: file, type, component, field,
masterLabel, Value to Translate) followed by that language's own columns
("<Lang> Existing Value", "<Lang> Translation", and "<Lang> Gender" if present).

With --roundtrip the output uses the column layout translation_roundtrip.py to-files reads
instead, and --fix-file-lang points each CSV's `file` column at its own language.

Read-only with respect to the org and the workbook -- it only writes CSVs.
"""

from __future__ import annotations

import argparse
import csv
import datetime
import re
import sys
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sf_languages import code_for, require_known  # noqa: E402
from toolkit_settings import BANNER_TEXTS  # noqa: E402

KEY_COLUMN_COUNT = 6
# "<Lang> Gender" is optional -- workbooks that have it carry it through; to-files needs
# it for gendered languages' object/field label rows.
# Longest-first so "Starts With Vowel Sound" (en_US's label) is matched before "Starts With".
LANG_SUFFIXES = ("Existing Value", "Translation", "Gender",
                 "Starts With Vowel Sound", "Starts With", "Article")
REQUIRED_SUFFIXES = ("Existing Value", "Translation")
# Row 2 of the master workbook is a banner ("Do Not Edit" / "To Populate"),
# not data; it is dropped unless --keep-banner is passed.
BANNER_VALUES = set(BANNER_TEXTS)

# The column layout translation_roundtrip.py to-files reads (its COLUMNS constant).
# `startsWith` and `article` must be carried: Salesforce rejects renamed-standard-field /
# object-label rows without them in languages that need them (e.g. fr, it for startsWith;
# da, sv for article; see sf_languages.py). Dropping them here silently reintroduces
# "StartsWith is required for language X" on any workbook split through this path.
ROUNDTRIP_COLUMNS = ["file", "type", "component", "field", "masterLabel", "source",
                     "translation", "gender", "startsWith", "article"]

# Extended roundtrip columns — adds caseType, plural for full caseValues support.
EXTENDED_ROUNDTRIP_COLUMNS = ROUNDTRIP_COLUMNS + ["caseType", "plural"]

# Tab 2 column header pattern: {LanguageName}-{Gender}-{Form} {Existing Value|Translation}
_TAB2_COL_RE = re.compile(
    r'^(.*?)-(Masculine|Feminine|Neuter)-(.*?)\s+(Existing Value|Translation)$'
)

# Maps form label (as used in combine_translations.py LANGUAGE_FORMS) to XML attribute values.
FORM_TO_CV: dict[str, dict[str, str]] = {
    "Singular":                     {"caseType": "",             "article": "",          "plural": "false"},
    "Plural":                       {"caseType": "",             "article": "",          "plural": "true"},
    "Indefinite-Singular":          {"caseType": "",             "article": "Indefinite","plural": "false"},
    "Indefinite-Plural":            {"caseType": "",             "article": "Indefinite","plural": "true"},
    "Definite-Singular":            {"caseType": "",             "article": "Definite",  "plural": "false"},
    "Definite-Plural":              {"caseType": "",             "article": "Definite",  "plural": "true"},
    "Nominative-Singular":          {"caseType": "Nominative",   "article": "",          "plural": "false"},
    "Nominative-Plural":            {"caseType": "Nominative",   "article": "",          "plural": "true"},
    "Accusative-Singular":          {"caseType": "Accusative",   "article": "",          "plural": "false"},
    "Accusative-Plural":            {"caseType": "Accusative",   "article": "",          "plural": "true"},
    "Genitive-Singular":            {"caseType": "Genitive",     "article": "",          "plural": "false"},
    "Genitive-Plural":              {"caseType": "Genitive",     "article": "",          "plural": "true"},
    "Dative-Singular":              {"caseType": "Dative",       "article": "",          "plural": "false"},
    "Dative-Plural":                {"caseType": "Dative",       "article": "",          "plural": "true"},
    "Instrumental-Singular":        {"caseType": "Instrumental", "article": "",          "plural": "false"},
    "Instrumental-Plural":          {"caseType": "Instrumental", "article": "",          "plural": "true"},
    "Prepositional-Singular":       {"caseType": "Prepositional","article": "",          "plural": "false"},
    "Prepositional-Plural":         {"caseType": "Prepositional","article": "",          "plural": "true"},
    "Locative-Singular":            {"caseType": "Locative",     "article": "",          "plural": "false"},
    "Locative-Plural":              {"caseType": "Locative",     "article": "",          "plural": "true"},
    "Definite-Nominative-Singular": {"caseType": "Nominative",   "article": "Definite",  "plural": "false"},
    "Definite-Nominative-Plural":   {"caseType": "Nominative",   "article": "Definite",  "plural": "true"},
    "Definite-Dative-Singular":     {"caseType": "Dative",       "article": "Definite",  "plural": "false"},
    "Definite-Dative-Plural":       {"caseType": "Dative",       "article": "Definite",  "plural": "true"},
}

# Extra language-name spellings (as written in a workbook header) -> Salesforce language
# code, used by --fix-file-lang to rewrite the language token in the `file` column. Every
# Salesforce display name and code ("Portuguese (European)", "pt_PT") already resolves
# through sf_languages.py, so only spellings Salesforce does not use belong here. Add
# others with --lang-code "Name=code".
LANG_CODES = {
    "Chinese Simplified": "zh_CN",
    "Chinese Traditional": "zh_TW",
}



def language_code(lang_codes: dict[str, str], language: str) -> str | None:
    """Code for a workbook header's language name: --lang-code overrides, the table above,
    then any Salesforce language name or code (sf_languages)."""
    return lang_codes.get(language) or code_for(language)


CONTAINER_SUFFIX = ".objectTranslation-meta.xml"
TRANSLATIONS_SUFFIX = ".translation-meta.xml"
VALUE_SET_SUFFIXES = (
    ".globalValueSetTranslation-meta.xml",
    ".standardValueSetTranslation-meta.xml",
)


def cell_text(value) -> str:
    """Render a cell as CSV text (None becomes empty).

    Excel types values like `10` or `2024-01-15` as a number/date, and the naive str() of
    those ("10.0", "2024-01-15 00:00:00") would no longer match the picklist value in
    Salesforce, so render them the way they were typed.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, datetime.datetime):
        return value.date().isoformat() if value.time() == datetime.time() else value.isoformat(" ")
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def slugify(language: str) -> str:
    """'Portuguese (Brazil)' -> 'portuguese-brazil'."""
    slug = re.sub(r"[^0-9a-z]+", "-", language.lower())
    return slug.strip("-")


def retag(token: str, code: str) -> str:
    """'Account-ar' -> 'Account-de'. API names never contain '-', so rsplit is safe."""
    return token.rsplit("-", 1)[0] + "-" + code


def rewrite_file_lang(rel: str, code: str) -> str | None:
    """Swap the language token in a translation file path; None if the shape is unknown.

    Handles the four path shapes to-files understands:
      objectTranslations/<Obj>-<lang>/<Field>.fieldTranslation-meta.xml
      objectTranslations/<Obj>-<lang>/<Obj>-<lang>.objectTranslation-meta.xml
      {global,standard}ValueSetTranslations/<Name>-<lang>.<...>ValueSetTranslation-meta.xml
      translations/<lang>.translation-meta.xml
    """
    if not rel:
        return None
    parts = rel.split("/")
    if parts[0] == "translations" and len(parts) == 2 and rel.endswith(TRANSLATIONS_SUFFIX):
        return f"translations/{code}{TRANSLATIONS_SUFFIX}"
    if parts[0] == "objectTranslations" and len(parts) == 3:
        folder = retag(parts[1], code)
        name = f"{folder}{CONTAINER_SUFFIX}" if parts[2].endswith(CONTAINER_SUFFIX) else parts[2]
        return f"objectTranslations/{folder}/{name}"
    for suffix in VALUE_SET_SUFFIXES:
        if len(parts) == 2 and parts[1].endswith(suffix):
            return f"{parts[0]}/{retag(parts[1][: -len(suffix)], code)}{suffix}"
    return None


def parse_languages(header: list[str]) -> list[tuple[str, dict[str, int]]]:
    """Group the post-key header columns by language, preserving header order.

    Returns [(language, {"Existing Value": idx, "Translation": idx}), ...].
    """
    found: dict[str, dict[str, int]] = {}
    order: list[str] = []
    for idx, name in enumerate(header):
        if idx < KEY_COLUMN_COUNT or not name:
            continue
        for suffix in LANG_SUFFIXES:
            if name.endswith(" " + suffix):
                language = name[: -(len(suffix) + 1)].strip()
                if language not in found:
                    found[language] = {}
                    order.append(language)
                found[language][suffix] = idx
                break
        else:
            print(f"warning: ignoring unrecognized column {idx + 1!s} {name!r}", file=sys.stderr)
    return [(language, found[language]) for language in order]


def is_banner_row(row: tuple) -> bool:
    values = {cell_text(c).strip().lower() for c in row if cell_text(c).strip()}
    return bool(values) and values <= BANNER_VALUES


def parse_tab2_cols(header: list[str]) -> dict[str, dict]:
    """Parse Tab 2 column headers into per-language translation/existing-value index maps.

    Returns {language_name: {"translation": {(gender, form): col_idx},
                             "existing":     {(gender, form): col_idx}}}
    """
    langs: dict[str, dict] = {}
    for idx, name in enumerate(header):
        if idx < KEY_COLUMN_COUNT or not name:
            continue
        m = _TAB2_COL_RE.match(name)
        if not m:
            continue
        lang_name, gender, form, suffix = m.group(1), m.group(2), m.group(3), m.group(4)
        if lang_name not in langs:
            langs[lang_name] = {"translation": {}, "existing": {}}
        if suffix == "Translation":
            langs[lang_name]["translation"][(gender, form)] = idx
        else:
            langs[lang_name]["existing"][(gender, form)] = idx
    return langs


def split_tab2_workbook(
    workbook_path: Path,
    out_dir: Path,
    tab2_sheet: str,
    fix_file_lang: bool,
    lang_codes: dict[str, str],
    keep_banner: bool = False,
) -> int:
    """Read the Gender Forms sheet and write extended-format CSVs for each language.

    Output files: translations-{slug}-gender.csv (separate from Tab 1 output).
    Returns number of languages written.
    """
    wb = openpyxl.load_workbook(workbook_path, read_only=True, data_only=True)
    if tab2_sheet not in wb.sheetnames:
        print(f"warning: sheet {tab2_sheet!r} not found in workbook, skipping Tab 2",
              file=sys.stderr)
        wb.close()
        return 0

    ws = wb[tab2_sheet]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()

    if not rows:
        print(f"warning: sheet {tab2_sheet!r} is empty", file=sys.stderr)
        return 0

    header = [cell_text(c).strip() for c in rows[0]]
    lang_cols = parse_tab2_cols(header)
    if not lang_cols:
        print(f"warning: no language columns found in sheet {tab2_sheet!r}", file=sys.stderr)
        return 0

    # Collect data rows (skip header + banner)
    data_rows = []
    for row in rows[2:]:
        if not keep_banner and is_banner_row(row):
            continue
        if not any(cell_text(c).strip() for c in row):
            continue
        data_rows.append(row)

    out_dir.mkdir(parents=True, exist_ok=True)
    written = 0

    for lang_name, col_info in sorted(lang_cols.items()):
        code = language_code(lang_codes, lang_name)
        if code is None:
            print(f"  warning: no Salesforce code for {lang_name!r}, skipping", file=sys.stderr)
            continue

        out_rows = []
        for row in data_rows:
            keys = [cell_text(row[i]) if i < len(row) else "" for i in range(KEY_COLUMN_COUNT)]
            file_val, type_val, component, field, master_label, source = keys

            if fix_file_lang:
                fixed = rewrite_file_lang(file_val, code)
                if fixed:
                    file_val = fixed

            for (gender, form), tr_col in col_info["translation"].items():
                translation = cell_text(row[tr_col]) if tr_col < len(row) else ""
                if not translation.strip():
                    continue
                cv = FORM_TO_CV.get(form)
                if cv is None:
                    print(f"  warning: unknown form {form!r}, skipping", file=sys.stderr)
                    continue
                out_rows.append({
                    "file":        file_val,
                    "type":        type_val,
                    "component":   component,
                    "field":       field,
                    "masterLabel": master_label,
                    "source":      source,
                    "translation": translation,
                    "gender":      gender,
                    "caseType":    cv["caseType"],
                    "article":     cv["article"],
                    "plural":      cv["plural"],
                })

        if not out_rows:
            continue

        stem = slugify(lang_name)
        out_path = out_dir / f"translations-{stem}-gender.csv"
        with open(out_path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=EXTENDED_ROUNDTRIP_COLUMNS)
            writer.writeheader()
            writer.writerows(out_rows)

        filled = sum(1 for r in out_rows if r["translation"].strip())
        print(f"{out_path}  ({len(out_rows)} caseValues rows, {filled} filled)")
        written += 1

    return written


def split_workbook(
    workbook_path: Path,
    out_dir: Path,
    sheet: str | None,
    name_style: str,
    keep_banner: bool,
    roundtrip: bool,
    fix_file_lang: bool,
    lang_codes: dict[str, str],
    from_existing: bool = False,
) -> int:
    wb = openpyxl.load_workbook(workbook_path, read_only=True, data_only=True)
    ws = wb[sheet] if sheet else wb[wb.sheetnames[0]]

    rows = ws.iter_rows(values_only=True)
    try:
        header = [cell_text(c).strip() for c in next(rows)]
    except StopIteration:
        sys.exit(f"error: {workbook_path.name} sheet {ws.title!r} is empty")

    if len(header) < KEY_COLUMN_COUNT:
        sys.exit(f"error: sheet {ws.title!r} has fewer than {KEY_COLUMN_COUNT} columns")

    languages = parse_languages(header)
    if not languages:
        sys.exit(f"error: no '<Language> Existing Value'/'Translation' columns in sheet {ws.title!r}")

    data_rows = []
    for row in rows:
        if not keep_banner and is_banner_row(row):
            continue
        if not any(cell_text(c).strip() for c in row):
            continue
        data_rows.append(row)

    out_dir.mkdir(parents=True, exist_ok=True)
    key_header = header[:KEY_COLUMN_COUNT]

    for language, columns in languages:
        # Seeding a new org reads the org's CURRENT values (Existing Value); a translator
        # round-trip reads what they typed (Translation).
        tr_suffix = "Existing Value" if from_existing else "Translation"
        translation_col = columns.get(tr_suffix)
        if roundtrip:
            if translation_col is None:
                print(f"warning: skipping {language}: no {tr_suffix!r} column", file=sys.stderr)
                continue
            # Map each output column BY NAME. A positional append would misplace values
            # whenever an earlier grammar column is absent — en_US and hu have a
            # startsWith column but no Gender, so appending would write their startsWith
            # value into the `gender` field. None means "emit blank".
            source_for = {
                "translation": translation_col,
                "gender":      columns.get("Gender"),
                "startsWith":  columns.get("Starts With")
                               or columns.get("Starts With Vowel Sound"),
                "article":     columns.get("Article"),
            }
            out_header = ROUNDTRIP_COLUMNS
            indexes = [source_for.get(c) for c in ROUNDTRIP_COLUMNS[KEY_COLUMN_COUNT:]]
            pad = 0
        else:
            indexes = [columns[s] for s in LANG_SUFFIXES if s in columns]
            missing = [s for s in REQUIRED_SUFFIXES if s not in columns]
            if missing:
                print(
                    f"warning: {language} is missing column(s): {', '.join(missing)}",
                    file=sys.stderr,
                )
            out_header = key_header + [header[i] for i in indexes]

        code = language_code(lang_codes, language)
        if fix_file_lang and not code:
            sys.exit(
                f"error: no Salesforce language code for the header {language!r}. Without one "
                f"its text would be written into another language's files. Map it with "
                f'--lang-code "{language}=<code>" and run again.')
        if fix_file_lang:
            require_known([code], f"split, header {language!r}")

        stem = slugify(language) if name_style == "slug" else language
        out_path = out_dir / f"translations-{stem}.csv"
        unknown_paths = 0
        with open(out_path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh)
            writer.writerow(out_header)
            for row in data_rows:
                keys = [cell_text(row[i]) if i < len(row) else "" for i in range(KEY_COLUMN_COUNT)]
                if fix_file_lang and code:
                    fixed = rewrite_file_lang(keys[0], code)
                    if fixed is None:
                        unknown_paths += 1
                    else:
                        keys[0] = fixed
                vals = [
                    cell_text(row[i]) if (i is not None and i < len(row)) else ""
                    for i in indexes
                ]
                if roundtrip:
                    vals += [""] * pad
                writer.writerow(keys + vals)
        if unknown_paths:
            print(
                f"warning: {language}: left {unknown_paths} unrecognized file path(s) unchanged",
                file=sys.stderr,
            )
        filled = sum(
            1
            for row in data_rows
            if translation_col is not None
            and translation_col < len(row)
            and cell_text(row[translation_col]).strip()
        )
        tag = f", file column -> {code}" if fix_file_lang and code else ""
        print(f"{out_path}  ({len(data_rows)} rows, {filled} translated{tag})")

    wb.close()
    return len(languages)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("workbook", type=Path, help="master translations .xlsx")
    parser.add_argument("-d", "--out-dir", type=Path, default=Path("."), help="output directory (default: .)")
    parser.add_argument("--sheet", help="worksheet name (default: the first worksheet)")
    parser.add_argument(
        "--name-style",
        choices=("slug", "exact"),
        default="slug",
        help="filename language token: 'slug' (portuguese-brazil) or 'exact' (Portuguese (Brazil))",
    )
    parser.add_argument(
        "--keep-banner",
        action="store_true",
        help="keep the 'Do Not Edit'/'To Populate' banner row instead of dropping it",
    )
    parser.add_argument(
        "--roundtrip",
        action="store_true",
        help="emit the column layout translation_roundtrip.py to-files reads: "
        + ",".join(ROUNDTRIP_COLUMNS)
        + " ('Value to Translate' becomes source, the language's Translation column becomes "
        "translation, and its Existing Value column is dropped)",
    )
    parser.add_argument(
        "--from-existing",
        action="store_true",
        help="with --roundtrip, take `translation` from each language's 'Existing Value' "
        "column instead of its 'Translation' column. Use this to seed a new org from the "
        "values already in the source org, when the Translation columns are still empty "
        "because translators have not returned the workbook.",
    )
    parser.add_argument(
        "--fix-file-lang",
        action="store_true",
        help="rewrite the language code in the file column to match each output language "
        "(a master workbook usually has one language baked into every path)",
    )
    parser.add_argument(
        "--lang-code",
        action="append",
        default=[],
        metavar='"Language=code"',
        help="override or add a language-name to Salesforce-code mapping for "
        '--fix-file-lang, e.g. --lang-code "Deutsch=de". Repeatable.',
    )
    parser.add_argument(
        "--tab2-sheet",
        metavar="SHEET",
        default=None,
        help="also split the Gender Forms sheet (Tab 2) using the extended caseValues format. "
        "Provide the sheet name (default: 'Gender Forms'). "
        "Outputs translations-{lang}-gender.csv files alongside the Tab 1 files.",
    )
    args = parser.parse_args(argv)

    if not args.workbook.is_file():
        sys.exit(f"error: no such file: {args.workbook}")

    lang_codes = dict(LANG_CODES)
    for override in args.lang_code:
        name, _, code = override.partition("=")
        if not name.strip() or not code.strip():
            sys.exit(f'error: --lang-code expects "Language=code", got {override!r}')
        lang_codes[name.strip()] = code.strip()

    if args.roundtrip and not args.fix_file_lang:
        print(
            "note: --roundtrip without --fix-file-lang keeps whatever language is in the "
            "file column, so every language would deploy to the same files",
            file=sys.stderr,
        )

    count = split_workbook(
        args.workbook,
        args.out_dir,
        args.sheet,
        args.name_style,
        args.keep_banner,
        args.roundtrip,
        args.fix_file_lang,
        lang_codes,
        args.from_existing,
    )
    print(f"wrote {count} CSV file(s) to {args.out_dir}")

    if args.tab2_sheet is not None:
        tab2_name = args.tab2_sheet if args.tab2_sheet else "Gender Forms"
        tab2_count = split_tab2_workbook(
            args.workbook,
            args.out_dir,
            tab2_name,
            args.fix_file_lang,
            lang_codes,
        )
        print(f"wrote {tab2_count} Tab 2 CSV file(s) to {args.out_dir}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
