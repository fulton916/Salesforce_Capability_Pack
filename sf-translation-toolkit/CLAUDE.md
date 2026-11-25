<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

# CLAUDE.md: sf-translation-toolkit

Instructions for an AI coding assistant running or changing this toolkit.

## What this is

A Salesforce translation pipeline. It scopes the fields a set of permission set groups (PSGs)
can read, builds a master Excel workbook pre-filled with the org's existing translations, turns
the filled workbook back into Translation metadata (only translated rows), checks the payload
against the target org, and verifies the load against a Translation Workbench Bilingual `.stf`
export. All scripts are in `scripts/`; every one supports `--help`.

Use it when the user wants to: translate Salesforce UI text for a user group; build a translator
workbook; load a filled translation workbook; seed translations into a new org; or verify that
translations landed.

## Hard rules

1. **Never run a committing deploy without explicit user approval** for that org, after the user
   has seen the dry-run result. If it is unclear whether you were asked to deploy or to hand over
   the command, ask. Production needs a fresh yes every time.
2. **Always dry-run first** (`--dry-run`), and always pass `--json` to both dry run and deploy.
3. **Never omit `--skip-untranslated`** on `translation_roundtrip.py to-files`. Without it blank
   cells become empty elements that clear existing org translations.
4. **Deploy only the run's payload folder** (`sf project deploy start -d <payload>`). Never
   `--metadata CustomObjectTranslation`, never all of `force-app`.
5. **Never use `--ignore-errors`.** One bad reference discards a whole object/language file; the
   flag silently drops those files. Run `prevalidate_payload.py` instead.
6. **Treat `SucceededPartial` as a failure.** `make_deploy_error_file.py --payload-dir` exits 2 on
   it. Do not pass `--allow-partial` unless the user has read the loss report and accepted it.
7. **Snapshot the target before every deploy.** Most pushed translations cannot be removed by a
   later deploy, only replaced.
8. **Load reviewer-supplied workbooks exactly as given.** Do not fix, trim, drop or re-align
   their content. Report defects as a separate list.
9. **Always quote the org alias and pass `-o`/`--target-org`.** Never rely on the default org
   (`sf config get target-org`): some scripts and sessions inherit it silently.
10. **New run folder every run.** `combine_translations.py` takes its language set from the
    `translations_*.csv` glob in `--input-dir`; a leftover file injects a language.
11. **Do not run `prevalidate_payload.py --apply` inside `force-app`** (it refuses) and do not pass
    `--force` without reading the report.
12. Do not treat `UNVERIFIED` or an empty result as a pass. Prove a check can see something you
    know is there before trusting "0 missing".

## Inputs you need from the user

- Source org alias (`$ORG`) and target org alias (`$TARGET`), e.g. `my-sandbox`, `my-prod`.
- PSG name pattern (e.g. `MyProj_*`) and any PSGs to exclude (integration / data-only groups).
- Language codes. Must be Salesforce codes: `nl_NL` not `nl`, `iw` not `he`, `in` not `id`.
- Folder of a Bilingual `.stf` export (Setup > Translation Workbench > Export > Bilingual). You
  cannot take this export; the user does it in Setup.

## Workflow (run from the SFDX project root; toolkit at `sf-translation-toolkit/`)

`$TH = sf-translation-toolkit/scripts`, `$RUN = work/<new folder>`.

### Phase A: scope
1. `sf project retrieve start --manifest sf-translation-toolkit/manifest/permissions.xml -o $ORG --wait 60`
2. Compare `SELECT DeveloperName FROM PermissionSetGroup` with `force-app/main/default/permissionsetgroups/`.
   PSGs missing locally are silently skipped by step 3. Report any gap.
3. `python $TH/psg2csv_collect.py "<pattern>" -r fieldPermissions -o $RUN/psg_fields_scoped.csv --readable-only --drop-namespaced [--exclude <PSG>]`
   - Needs the Sunny Day plugin (`sf sday psg2csv`). Output columns: `Name,editable,readable,PSG`.
   - Record field and object counts; a big change from the last run needs explaining.
4. `python $TH/make_manifest.py $RUN/psg_fields_scoped.csv --langs <codes> --org $ORG -o $RUN/manifests`
   then retrieve each `$RUN/manifests/*.xml` with `sf project retrieve start --manifest <file> -o $ORG --wait 60`.
   Translations only come back complete when retrieved with their object, layouts and quick actions.
5. User takes a Bilingual export for every language, same day as the retrieve.

### Phase B: build the workbook
6. `python $TH/translation_roundtrip.py to-csv $RUN/psg_fields_scoped.csv <codes> -o $RUN/translations.csv --retrieve-existing --target-org $ORG`
   Writes `translations_<code>.csv` per language. `--retrieve-existing` reads local `force-app`:
   only safe when that tree holds `$ORG`'s metadata.
7. `python $TH/prefill_from_stf.py $RUN --stf-dir <bilingual folder> --write` (omit `--write` to preview).
   Run both 6 and 7, in that order.
8. `python $TH/combine_translations.py --input-dir $RUN --output $RUN/<wb>.xlsx --org $ORG`
   `--org` pre-fills Gender cells. A timeout on the gender retrieve is a hard error; rerun.
9. `python $TH/classify_layout_sections.py --org $ORG --workbook $RUN/<wb>.xlsx --out $RUN/layout_section_verdicts.json`
   `python $TH/apply_layout_verdicts.py $RUN/<wb>.xlsx --verdicts $RUN/layout_section_verdicts.json`
   Moves Salesforce-owned layout headings off the main tab. Stops if `probe_language`
   (settings.json, default `ja`) is a language the org translates.
10. Sanity check: Existing Value columns populated for languages the org uses; some Gender cells
    filled. All blank = step 6/7 or `--org` failed.

### Phase C: reviewers fill `<Language> Translation` columns (not your job).

### Phase D: reload
11. Split each tab into its own folder (same output names per tab):
    `python $TH/split_master_translations.py <returned.xlsx> --sheet "Fields" --roundtrip --fix-file-lang -d $RUN/out_fields`
    and likewise `"Custom Labels"` -> `out_labels`, `"UI Labels"` -> `out_ui_labels`.
    Read the `N translated` counts. `0 translated` everywhere = wrong sheet/column; stop.
    Unknown language header = hard stop; map with `--lang-code "Header=code"`.
12. `python $TH/merge_label_csvs.py $RUN/out_labels $RUN/out_ui_labels $RUN/out_ui_merged`
    (both tabs write `translations/<lang>.translation-meta.xml`; unmerged, the second wipes the first).
13. `python $TH/translation_roundtrip.py to-files <every csv in out_fields and out_ui_merged> --dir $RUN/out --skip-untranslated`
    Takes a list of files, not a directory. Must run inside an SFDX project (finds `force-app/main/default`).
    Checks: file count > 0; no folder matching `__.*__` (namespaced); no folder ending `-nl`.
    `globalValueSetTranslations/` and `standardValueSetTranslations/` in `out` are correct: GVS-backed
    picklist values are moved there deliberately.
14. Copy `out` to a per-target folder, then
    `python $TH/prevalidate_payload.py <payload> -o $TARGET` (report), then with `--apply`.
    Needs an English-language running user. Keep the report: it lists every stripped translation.
15. Snapshot: retrieve each manifest into `snapshots/<target>_<YYYY-MM-DD_HHMM>_before/` with
    `--target-metadata-dir <dir> --unzip`. Confirm it holds files.
16. `sf project deploy start -d <payload> --dry-run -l NoTestRun -o $TARGET --wait 60 --json > $RUN/dryrun.json`
    (production: omit `-l NoTestRun`).
17. `python $TH/make_deploy_error_file.py $RUN/dryrun.json $RUN/out_fields --payload-dir <payload> --out $RUN/dryrun_errors.xlsx`
    Exit 2 = something would not land. Stop, show the user, fix, rebuild.
18. **Stop and ask for approval.** Then deploy (same command without `--dry-run`) to `$RUN/deploy.json`
    and run step 17 on it (`deploy_errors.xlsx`). Produce the error log even on a clean run; a clean
    one is a small Summary-only workbook with every category at 0.

### Phase E: verify
19. User takes a fresh Bilingual export from the target after the deploy.
20. `python $TH/verify_load.py <returned.xlsx> --stf-dir <after folder> --output $RUN/verification.xlsx`
    Exits 2 on MISSING, UNVERIFIED, or a language with no export (NOT CHECKED). Report every
    DIFFERENT and MISSING. Do not verify by retrieving `CustomObjectTranslation` alone: without its
    parents it returns almost nothing, which looks like data loss but is not.

## Variants

- **Reviewer-supplied workbook**: start at step 11. Load as given (rule 8).
- **Seed a new, empty org from a workbook built on another org**: no Phase A. Add `--from-existing`
  to step 11 (reads `Existing Value`; the Translation columns are empty). Always pass `--sheet`.
  This overwrites target values; refuse it for an org whose own translations must be kept and say
  a fill-empty-slots-only method is needed (not in this toolkit).

## Script inputs and outputs

| Script | In | Out |
|---|---|---|
| psg2csv_collect | PSG pattern; local permissionsetgroups | CSV `Name,editable,readable,PSG` |
| make_manifest | scope CSV, `--langs`, `--org` (reads Layout/QuickAction lists) | `obj_N.xml`, `labels.xml` |
| translation_roundtrip to-csv | scope CSV, langs, local metadata, optional org retrieve | `translations_<lang>.csv` (cols: file,type,component,field,masterLabel,source,translation,...) |
| translation_roundtrip validate | filled CSVs | report; `--fix`, `--drop-deleted` |
| translation_roundtrip to-files | filled CSVs | `objectTranslations/`, `globalValueSetTranslations/`, `standardValueSetTranslations/`, `translations/` |
| prefill_from_stf | run folder, `.stf` folder | CSVs updated in place (`--write`) |
| combine_translations | `translations_*.csv`, `--org` | master `.xlsx` |
| classify_layout_sections | workbook, `--org` | verdicts JSON |
| apply_layout_verdicts | workbook, verdicts | workbook updated in place + timestamped backup (`--dry-run` available) |
| split_master_translations | workbook, `--sheet` | per-language CSVs |
| merge_label_csvs | two CSV dirs | merged CSV dir |
| prevalidate_payload | payload dir, `-o` | report; strips with `--apply` |
| make_deploy_error_file | deploy JSON, CSV dir, `--payload-dir` | error `.xlsx`; exit 2 on loss |
| verify_load | workbook, `.stf` folder | verification `.xlsx`; exit 2 on gaps |

## Language grammar (object names and renamed standard fields only)

Ordinary labels, picklists and messages need no grammar in any language. Object names and
renamed standard fields do, and the rules differ per language. The reference rules are in
`scripts/sf_languages.py` (`LANGUAGE_GRAMMAR`, `LANGUAGE_CASE_FORMS`, `LANGUAGE_ARTICLE_FORMS`,
`LANGUAGE_POSSESSIVE_FORMS`); read them there, not from memory. The kinds of rule, with examples:

| Group | Example codes | Needs |
|---|---|---|
| Gendered | de, fr, it | `<gender>` |
| Starts-with | en_US; also fr, it (with gender) | `<startsWith>` Vowel/Consonant |
| Article | da, sv | `<article>`; ro needs gender AND article |
| Possessive | fi | `<possessive>`, written as None automatically |
| No gender | fi | none |

Gender values: Feminine, Masculine, Neuter, AnimateMasculine. No `Common`. da, sv, nl_NL reject
Masculine (common gender = Feminine). On a renamed field only article/possessive `None` is
accepted. Grammar must travel with the object name's case forms. Salesforce validates the
language code, not whether the language is enabled. Rules live in `scripts/sf_languages.py`;
languages without an entry get no grammar rows. Confirm rules with a sandbox dry run before relying on them, and only add rules a dry run has confirmed.

## Known pitfalls

| Symptom | Cause / fix |
|---|---|
| `Expecting value: line 1 column 1` reading JSON | BOM or UTF-16 from a PowerShell redirect; read with `utf-8-sig`, set UTF-8 output encoding |
| `to-files`: CSV not found | Passed a directory; pass the file list |
| Extra languages in workbook | Stale CSVs in the run folder |
| `You cannot translate into nl` | Use `nl_NL`; delete any `-nl` folders in the payload |
| `namespaced language is not allowed` | Managed-package object in payload; rerun scope with `--drop-namespaced` |
| `Invalid picklist value` | GVS-backed picklist or value renamed/deleted in target; refresh retrieve, rerun prevalidate |
| `Gender is required` on a standard object | Wrong gender vs Salesforce's language pack |
| `'Consonant' is not a valid value for the enum 'Gender'` | Grammar sent without case forms |
| `Warning: sheet '...' not found` | A tab was renamed; the whole tab was skipped. Restore the name |
| `ClientTimeoutError` | Deploy still running; `sf project deploy report --job-id <id> -o <alias> --json` |
| Translation files ~115 bytes after retrieve | Retrieved without parents; use `make_manifest.py` manifests |
| Many more errors than real problems | Salesforce repeats per language and caps per file; count distinct targets |

## Changing the code

- Keep scripts read-only toward the org. Only `sf project deploy start` typed by a person writes.
- Keep exit-2 behaviour of the check scripts; callers rely on it.
- Do not reintroduce the retired `.stf`-absence rule for layout ownership (`combine_translations.py`).
- Run `python tests/run_tests.py` after any change; it must end with all checks passed. Tests are
  offline; never add a test that calls a real org.
- Fixtures use the synthetic `Widget__c` object. Do not add real org data, IDs or names.
