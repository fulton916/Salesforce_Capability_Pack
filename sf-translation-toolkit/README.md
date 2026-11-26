# sf-translation-toolkit

Translate the Salesforce screens a chosen group of users can see.

The toolkit works out which fields a set of permission set groups (PSGs) can read, puts every
translatable string for that scope into one Excel workbook pre-filled with the translations the
org already holds, and turns the workbook reviewers fill in back into Salesforce Translation
metadata. The deploy payload carries only the rows someone actually translated. After the deploy,
it checks every value against a fresh Translation Workbench Bilingual `.stf` export.

The scripts only read from the org and write files on your computer. Nothing changes in
Salesforce until you run `sf project deploy start` (without `--dry-run`) yourself.

## What gets translated

- field labels
- picklist values, including global and standard value sets
- record type names
- validation rule error messages
- page layout section headings
- custom labels
- app, tab, quick action and report type labels
- object names and renamed standard fields, with the grammar some languages need

Out of scope: field help text, managed-package objects (Salesforce rejects translations for
namespaced objects), and anything Translation Workbench does not hold (record data, email
templates, text hard-coded in components).

## Why scope by permission set group

An org holds far more translatable text than any one user group sees. Translating everything
retrieved sends translators thousands of strings nobody reads, including deleted fields,
integration objects and managed-package items that fail on deploy. Starting from the PSGs of the
users you translate for keeps the workbook to what they can see. The PSG read includes each
group's muting permission set, so the field list reflects net access.

## Prerequisites

| Need | How | Check |
|---|---|---|
| Salesforce CLI v2 (`sf`) | developer.salesforce.com/tools/salesforcecli | `sf version` |
| Sunny Day CLI plugin (PSG field read) | `sf plugins install @chasd00/sunny-day` | `sf plugins` |
| Python 3.10+ | python.org | `python --version` |
| Python packages | `python -m pip install -r requirements.txt` | `python -c "import openpyxl"` |
| Excel | for checking workbooks; reviewers fill them in Excel | |

In each org: a user with API access who can deploy metadata (System Administrator, or Modify
Metadata + Manage Translation + View Setup), Translation Workbench enabled, and the target
languages added and marked Active. A translation deploys into a language that is not enabled,
but nobody sees it.

## Install

Copy this folder into a Salesforce DX project and run every command from the project root:

```
sf project generate --name my-translations
cd my-translations
# copy sf-translation-toolkit/ in here
python sf-translation-toolkit/tests/run_tests.py     # offline, must end "All ... checks passed."
```

Suggested layout:

```
my-translations/
  sfdx-project.json
  sf-translation-toolkit/     this folder
  force-app/main/default/     filled by the retrieves in each run
  exports/                    Translation Workbench .stf exports
  work/<date>/                one folder per run
  snapshots/                  copies of the target taken before each deploy
```

Use one project folder per source org. The scripts read whatever metadata is on disk and
present it as the org's; a folder holding two orgs' files mixes their translations.

## Settings

`settings.json` holds project settings. Every key is optional.

| Key | Default | Change it when |
|---|---|---|
| `probe_language` | `ja` | You translate into Japanese. Must be a language the org has never translated into (used to detect Salesforce-owned layout headings). |
| `banner_to_populate` | `To Populate` | You want other wording on the banner over the columns reviewers fill in. |
| `standard_object_labels` | `{}` | A standard object's English name shows oddly. Example: `{"WorkOrder": ["Work Order", "Work Orders"]}`. Display only. |
| `standard_value_sets` | `{}` | A standard picklist is reported as skipped. Example: `{"Case.Origin": "CaseOrigin"}`. |
| `extra_languages` | `{}` | Salesforce added a language after this toolkit was built. Example: `{"xx": "New Language"}`. |
| `api_version` | `67.0` | You need a newer version. The default is one version for every org, one release behind the newest. |

Languages are chosen per run. All 221 Salesforce language codes are in `scripts/sf_languages.py`.
Use Salesforce's own codes: Dutch is `nl_NL` (plain `nl` is rejected), Hebrew is `iw`,
Indonesian is `in`. The scripts stop on a code Salesforce does not offer and suggest the right one.

`scripts/object_names_cache.json` is an optional pre-fill for the Object Names tab. It ships
empty; see `examples/object_names_cache.example.json` for the format.

## Scripts

| Script | What it does |
|---|---|
| `psg2csv_collect.py` | Lists every field the matching PSGs can read (wraps `sf sday psg2csv`), dedupes, drops namespaced objects with `--drop-namespaced`. |
| `make_manifest.py` | Writes retrieve manifests for the scoped objects, in batches, naming each object with its layouts and quick actions so translations come back complete. Reads the org's layout and quick-action lists. |
| `translation_roundtrip.py` | `to-csv`: one CSV per language of everything to translate, optionally pre-filled from the org. `validate`: checks filled CSVs against metadata on disk. `to-files`: CSVs back to deployable Translation metadata. |
| `prefill_from_stf.py` | Fills the CSVs' `translation` column from a Bilingual `.stf` export. |
| `combine_translations.py` | Builds the master workbook from the per-language CSVs. Also has loaders (`--load-translations`, `--load-object-names`) that write into `force-app`. |
| `classify_layout_sections.py` | Asks the org which layout headings Salesforce owns, by rendering them in the probe language. |
| `apply_layout_verdicts.py` | Moves Salesforce-owned headings to a `Salesforce-Owned` tab. Backs up the workbook first. |
| `split_master_translations.py` | Splits a returned workbook tab into one CSV per language (`--roundtrip` for `to-files` format). |
| `merge_label_csvs.py` | Merges the Custom Labels and UI Labels CSVs, which share one Salesforce file per language. |
| `prevalidate_payload.py` | Checks every reference in the payload against the target org and (with `--apply`) strips what cannot land. Report-only by default. |
| `make_deploy_error_file.py` | Turns a dry-run or deploy `--json` result into an error workbook; exits 2 if anything would not land. |
| `verify_load.py` | Checks the returned workbook against a fresh Bilingual export; exits 2 on MISSING, UNVERIFIED or unchecked languages. |
| `expand_picklists.py`, `to_translation.py` | Lower-level helpers used by the scripts above (one row per picklist value; field metadata readers). |
| `sf_languages.py` | All Salesforce language codes and names, and the grammar rules per language. |
| `toolkit_settings.py` | Reads `settings.json`. |

Every script supports `--help`.

## Quick start

PowerShell, from the project root. On macOS/Linux use `python3`, forward slashes, `\` for line
continuation and shell variables (`RUN=work/run1`).

```powershell
# PowerShell 5.1 only: without these, accented text is garbled and JSON files are unreadable
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'

$ORG    = "my-sandbox"            # org you pull from
$TARGET = "my-sandbox"            # org you deploy to
$RUN    = "work\run-2024-01-15"   # NEW folder every run
$LANGS  = "de,fr,ja"
$WB     = "master_translations.xlsx"
$TH     = "sf-translation-toolkit\scripts"
New-Item -ItemType Directory -Force $RUN | Out-Null
```

### Phase A: scope

```powershell
# 1. Retrieve PSGs and their permission sets (the PSG read uses local files)
sf project retrieve start --manifest sf-translation-toolkit\manifest\permissions.xml -o $ORG --wait 60

# 2. Compare org PSGs with local ones; a PSG missing locally is silently skipped
sf data query -o $ORG -q "SELECT DeveloperName FROM PermissionSetGroup ORDER BY DeveloperName"
(Get-ChildItem force-app\main\default\permissionsetgroups).Name

# 3. Fields the chosen PSGs can read
python $TH\psg2csv_collect.py "MyProj_*" -r fieldPermissions -o "$RUN\psg_fields_scoped.csv" `
  --readable-only --drop-namespaced --exclude MyProj_Integration_PSG

# 4. Retrieve the metadata for that scope
python $TH\make_manifest.py "$RUN\psg_fields_scoped.csv" --langs $LANGS --org $ORG -o "$RUN\manifests"
Get-ChildItem "$RUN\manifests\*.xml" | ForEach-Object {
  sf project retrieve start --manifest $_.FullName -o $ORG --wait 60 }
```

5. Export the org's translations: Setup > Translation Workbench > Export > **Bilingual**, every
language in `$LANGS`. Unzip into a dated folder such as `exports\bilingual-before\`. Take it the
same day as the retrieve.

### Phase B: build the workbook

```powershell
python $TH\translation_roundtrip.py to-csv "$RUN\psg_fields_scoped.csv" $LANGS `
  -o "$RUN\translations.csv" --retrieve-existing --target-org $ORG
python $TH\prefill_from_stf.py $RUN --stf-dir "exports\bilingual-before" --write
python $TH\combine_translations.py --input-dir $RUN --output "$RUN\$WB" --org $ORG
python $TH\classify_layout_sections.py --org $ORG --workbook "$RUN\$WB" `
  --out "$RUN\layout_section_verdicts.json"
python $TH\apply_layout_verdicts.py "$RUN\$WB" --verdicts "$RUN\layout_section_verdicts.json"
```

Run `to-csv` and `prefill_from_stf` both, in that order. They cover different ground: the
export sees picklist values and field labels the retrieve misses; the retrieve sees layout
headings whose export keys carry a positional suffix. Where both have a value, the export wins.

`--org` on `combine_translations.py` pre-fills the Gender cells. Without it every Gender cell is
blank and translators must supply values they cannot know.

### Phase C: reviewers fill it in

Workbook tabs:

| Tab | Holds | Reviewers fill |
|---|---|---|
| Fields | Field labels, picklist values, record types, validation messages, layout headings | `<Language> Translation` |
| Standard Field Grammar | Renamed standard fields and object labels (rows with a gender) | Blank grammar cells; see Limitations |
| Object Names | Object names in every case form each language needs | Review only |
| Custom Labels | Custom labels (URL, ID and numeric values left out) | `<Language> Translation` |
| UI Labels | Quick actions, tabs, apps, report types | `<Language> Translation` |
| Salesforce-Owned | Layout headings Salesforce owns | Nothing |

Instructions for translators:

- `<Language> Existing Value` is what Salesforce shows today. Read only.
- `<Language> Translation` is what you want. Blank means "keep what is there".
- Never change the grey key columns (A-F), tab names or column headers. Do not insert, delete or
  sort rows. Filtering is fine; clear filters before sending back.
- Keep leading numbers and placeholders (`1 - Widget Type A` -> `1 - Widget-Typ A`; keep `{0}`).
- Keep UI labels about as short as the English.
- Use the drop-downs in Gender / Starts-with cells. Danish, Swedish and Dutch have no Masculine;
  their common gender is Feminine.

### Phase D: reload and deploy

```powershell
$WBR = "$RUN\returned\<returned file>.xlsx"     # save the returned file unchanged

# 1. Split each content tab into its own folder (file names collide across tabs)
foreach ($tab in @(@("Fields","out_fields"), @("Custom Labels","out_labels"),
                   @("UI Labels","out_ui_labels"))) {
  python $TH\split_master_translations.py $WBR --sheet $tab[0] --roundtrip --fix-file-lang `
    -d "$RUN\$($tab[1])" }
# Read the "N translated" counts. 0 for every language = wrong tab or column.

# 2. Merge the two label tabs, then build the payload with ONLY translated rows
python $TH\merge_label_csvs.py "$RUN\out_labels" "$RUN\out_ui_labels" "$RUN\out_ui_merged"
$csvs = @((Get-ChildItem "$RUN\out_fields\*.csv").FullName) + @((Get-ChildItem "$RUN\out_ui_merged\*.csv").FullName)
python $TH\translation_roundtrip.py to-files $csvs --dir "$RUN\out" --skip-untranslated

# 3. Check the payload against the target (one copy per target org)
$OUT = "$RUN\out_target"; Copy-Item "$RUN\out" $OUT -Recurse
python $TH\prevalidate_payload.py $OUT -o $TARGET            # report only
python $TH\prevalidate_payload.py $OUT -o $TARGET --apply    # strip what cannot land

# 4. Snapshot the target (deploys cannot be undone)
$SNAP = "snapshots\target_$(Get-Date -Format yyyy-MM-dd_HHmm)_before"   # YYYY-MM-DD_HHMM
Get-ChildItem "$RUN\manifests\*.xml" | ForEach-Object {
  sf project retrieve start --manifest $_.FullName --target-metadata-dir "$SNAP\$($_.BaseName)" `
    --unzip -o $TARGET --wait 60 }

# 5. Dry run and review: this is the gate
sf project deploy start -d $OUT --dry-run -l NoTestRun -o $TARGET --wait 60 --json > "$RUN\dryrun.json"
python $TH\make_deploy_error_file.py "$RUN\dryrun.json" "$RUN\out_fields" --payload-dir $OUT `
  --out "$RUN\dryrun_errors.xlsx"

# 6. Only after a person approves: real deploy, then the error log
sf project deploy start -d $OUT -l NoTestRun -o $TARGET --wait 60 --json > "$RUN\deploy.json"
python $TH\make_deploy_error_file.py "$RUN\deploy.json" "$RUN\out_fields" --payload-dir $OUT `
  --out "$RUN\deploy_errors.xlsx"
```

Production rejects `-l NoTestRun`; leave it off. A translation-only payload has no Apex, so no
tests run.

### Phase E: verify

Take a fresh Bilingual export from the target after the deploy, then:

```powershell
python $TH\verify_load.py $WBR --stf-dir "exports\bilingual-after" --output "$RUN\verification.xlsx"
```

| Result | Meaning |
|---|---|
| LANDED | The org holds exactly the workbook value |
| DIFFERENT | The org holds something else. Investigate each one. |
| MISSING | The key exists but has no translation. Usually a component that failed. |
| UNVERIFIED | The checker could not build a key. Not a pass. |

## Variant: reviewer-supplied workbook

If reviewers send a filled master workbook, skip Phases A-C and start at Phase D. Check its
language headers first; map any unusual spelling with `--lang-code "Header Name=code"`.

Load the reviewers' file exactly as given. Do not fix, trim or drop their content, even if it
looks wrong. Report defects back as a separate list. A clean dry run does not validate the words:
Salesforce checks that keys exist, not that the text is right.

## Variant: seeding a new org from an existing workbook

To copy the source org's existing translations into a new, empty org, read the `Existing Value`
columns instead of `Translation`: add `--from-existing` to `split_master_translations.py`. Skip
Phase A; the workbook is the scope. Always pass `--sheet` explicitly.

This overwrites whatever the target holds in those slots. Do not use it on an org whose own
translations must be kept; that needs a fill-empty-slots-only method which is not in this toolkit.

## Safety notes

- Nothing writes to Salesforce until a person has read the dry-run result and approved the deploy.
- Never leave off `--skip-untranslated`. Blank cells otherwise become empty elements, and
  deploying those clears existing translations.
- Deploy the run's own payload folder (`-d $OUT`), never a broad
  `--metadata CustomObjectTranslation` and never the whole `force-app`.
- Treat every deploy as permanent. Sending a blank clears only layout headings, record types and
  validation messages; field labels, picklists, value sets, custom labels and object names can
  only be replaced. Snapshot the target first.
- One bad reference fails a whole object/language file. `SucceededPartial` is a failed deploy.
  Do not use `--ignore-errors`: it drops whole files silently. Pre-validate instead.
- A new run folder every run. Languages come from the `translations_*.csv` files present, so a
  leftover file silently adds a language to the workbook and the deploy.
- `--retrieve-existing` reads the local `force-app` tree. Only use it when that tree holds the
  same org you pass as `--target-org`.
- Quote the org alias and pass `-o` on every command. Never rely on a default org.
- Parse `sf --json` files with `encoding="utf-8-sig"`; PowerShell redirects can add a BOM.
- If the CLI exits with `ClientTimeoutError`, the deploy is still running. Get the result with
  `sf project deploy report --job-id <id> -o <alias> --json`.

## Tests

```
python tests/run_tests.py
```

Runs both offline suites against synthetic `Widget__c` fixtures. No org needed.

`examples/` holds a synthetic scope CSV, the `to-csv` output for it, and a partly filled copy.
`to-files --skip-untranslated` on the filled copy writes 3 files with 4 translated slots.

## Limitations

- **Standard Field Grammar** and **Object Names** are not loaded by the Phase D path. Enter
  changes in Setup > User Interface > Rename Tabs and Labels. `combine_translations.py
  --load-translations / --load-object-names` exist but write into `force-app`, and
  `--load-object-names` rewrites each object's `<caseValues>`: an object absent from the tab
  loses its name translations.
- Grammar rules (gender, articles, case forms) are configured only for the languages that have
  an entry in `LANGUAGE_GRAMMAR` in `scripts/sf_languages.py` (a general reference; confirm with a sandbox dry run).
  Other languages work for all labels, picklists and messages, but get no grammar columns, and
  their object-name / renamed-field rows are never loaded. To add one, copy the closest entry
  and prove it with a sandbox dry run.
- The Bilingual export is a manual Setup step.
- Field help text is not covered.
- Not run end to end on macOS.

## License

Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify, or
distribute this software without written permission.
