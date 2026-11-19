# sf-translation-deploy-triage

Turns Salesforce deploy and validate results for translation metadata into Excel reports
that say what failed, why, and who has to act. Then builds the files reviewers fill
in, applies their answers, and scopes the redeploy to only what failed.

## Why

A raw deploy log is a poor work list:

- One message hides several causes. "Invalid picklist value: X" can mean the value was
  deleted, renamed, given a number prefix, padded with spaces in the org, or that the key
  text is mojibake. Salesforce also caps the values it lists per component, so a named
  value is not proof that it is the bad one.
- Grammar errors name the object, not the field ("Widget__c-de: Gender is required"). Nobody
  can answer that without a list of the fields.
- `SucceededPartial` reads like success. A `CustomObjectTranslation` deploys all or nothing:
  one bad reference discards every translation in that object and language.
- A drifted sandbox fails every validate for the same old reasons, and they bury the new ones.

## Prerequisites

- Python 3.10 or later, and `pip install -r requirements.txt` (openpyxl).
- Salesforce CLI `sf` (v2), only to produce the inputs. The scripts never call it.

## Inputs

| Input | How to get it |
|---|---|
| Deploy or validate result | `sf project deploy start --source-dir <payload> --target-org <alias> --json > deploy.json` (or `deploy validate`). A UTF-8 BOM and a leading CLI warning are handled. |
| Translation CSVs (optional, recommended) | The per-language files the payload was built from. See the format below. They supply the English source and the translation for each failed row. |
| Describes (optional) | `sf sobject describe -s Widget__c --target-org <alias> --json > describes/Widget__c.json`, one per object. |
| Record types (optional) | `sf data query -q "SELECT SobjectType, DeveloperName, Name FROM RecordType" --target-org <alias> --json > describes/_recordtypes.json` |
| Value sets (optional) | A folder holding `globalValueSets/` and `standardValueSets/` metadata. |
| Source .stf (optional) | Setup > Translation Workbench > Export > Source. The org's own list of every translatable key. |
| Bilingual .stf (optional) | Export > Bilingual, per language. Rows already translated there are dropped as resolved. |

### Translation CSV format

One file per language, named `translations_<lang>.csv`, one row per translatable slot:

```
file,type,component,field,masterLabel,source,translation,gender,startsWith
objectTranslations/Widget__c-de/Color__c.fieldTranslation-meta.xml,field-picklist,Widget__c,Color__c,Red,Red,Rot,,
objectTranslations/Widget__c-de/Name.fieldTranslation-meta.xml,standard-field,Widget__c,Name,,Widget Name,Widget-Name,Neuter,
```

`type` is one of `field-label`, `field-picklist`, `standard-field`, `object-label`,
`record-type`, `validation-rule`, `layout-section`, `custom-label`, `global-value`,
`standard-value`. The language comes from the file name, or from the `file` column.
Extra columns are carried through unchanged.

## Install

Copy this folder. Then:

```
pip install -r requirements.txt
python tests/run_tests.py
```

## Quick start

```
cd examples
python ../scripts/triage_deploy_errors.py --load "Example=deploy.json=csv" --describes describes --out errors.xlsx
python ../scripts/split_by_owner.py errors.xlsx
```

`errors.xlsx` has a Summary and one tab per failure category. The run exits 2 because the
example deploy did not fully land. `errors_by_owner.xlsx` has one tab per party.

## Scripts

### triage_deploy_errors.py

One or more deploy results in, one workbook out. Columns: Load, Language, Component,
Component Type, Field / Value Set, Bad Value, English Source, Supplied Translation, Grammar
Attribute, Diagnosis, Suggested Key, Suggested Translation, Who Must Act, Error Message.

```
python scripts/triage_deploy_errors.py --out errors.xlsx \
    --load "Load 1=load1/deploy.json=load1/csv=load1/payload" \
    --load "Load 2=load2/deploy.json=load2/csv" \
    --describes describes/ --source-stf exports/Source_en_US_2026-01-05.stf
```

`--load` is `LABEL=DEPLOY_JSON[=CSV_DIR[=PAYLOAD_DIR]]`, or just a JSON path. With a payload
folder the run counts how many translated elements the failed components took down.

Categories: Invalid Characters, Value Not Found, Deleted Custom Field, Deleted Record Type,
Deleted Org Component, Gender Required, Grammar Required, Invalid Grammar Value, Namespaced
Language, Language Not Enabled, Other.

What the diagnosis checks (when the evidence is given):

| Case | Diagnosis | Suggested |
|---|---|---|
| Value is valid in the org | Collateral in the capped error list | no action |
| Org value has a number prefix (`1 - Open`) | Same value, renumbered | prefixed key and translation |
| Org value differs only by whitespace (`Open `) | Key must match byte for byte | the org key |
| Value not found under any spelling | Removed or renamed | reviewer decision |
| Key text is mojibake | Encoding defect | repaired key and translation |
| Field gone, one org field has the same label | Recreated under a new API name | the new field |
| Record type gone, one exists with the same name | Renamed | new developer name |

Options: `--baseline` (subtract known errors), `--stf-dir` (drop rows already translated),
`--resolved-in-org` (drop grammar rows the org already satisfies), `--hide-diagnosis CATEGORY`,
`--only-tab`, `--drop-column`, `--note`, `--title`, `--developer-name`, `--reviewer-name`,
`--admin-name`, `--allow-partial`.

Exit code: 0 when every deploy fully landed, 2 when any did not (unless `--allow-partial`).

### subtract_baseline.py

```
python scripts/subtract_baseline.py validate_ref.json --write-baseline known_errors.txt
python scripts/subtract_baseline.py validate_new.json known_errors.txt
```

Signature per failure: `<fullName> :: <problem>`, with the `(line:col)` removed. Prints the
new errors by category. Exit 1 if any new error remains.

### split_by_owner.py

```
python scripts/split_by_owner.py errors.xlsx [--out by_owner.xlsx] [--per-category]
```

Groups rows by the party before ` - ` in "Who Must Act" (Developer, Reviewer, Admin,
Investigate, No action). Writes a new workbook; the input is not changed.

### make_grammar_file.py / apply_grammar_file.py

```
python scripts/make_grammar_file.py deploy.json csv/ --out grammar.xlsx [--known last_round.xlsx]
# a reviewer fills the ANSWER column
python scripts/apply_grammar_file.py grammar.xlsx csv/ deploy.json -d redeploy_csv/
```

The make step expands each failing object + language into its renamed standard fields
(`--types` to change which rows) and asks for gender and/or "starts with a vowel sound",
with a dropdown of the values Salesforce accepts for that language. Languages that need
both are asked both at once. `--grammar-rules rules.json` extends the per-language table.

The apply step validates every answer, converts "Vowel sound" / "Consonant sound" to the
`Vowel` / `Consonant` enum, and writes only the failing components to the output folder.
Blank answers stop it unless `--allow-incomplete`.

### make_action_file.py / apply_action_file.py

```
python scripts/make_action_file.py deploy.json csv/ --describes describes/ --out action.xlsx
python scripts/apply_action_file.py action.xlsx csv/ -d updated_csv/ [--startswith-only]
```

Tab 1 asks Yes/No "does this word start with a vowel sound?". Tab 2 lists picklist keys sent
as a display label where the org needs the API name: Already correct, Sent LABEL (suggestion
to confirm), or NOT FOUND (give a value or DROP). Apply validates the answers, remaps keys,
drops DROP rows and sets `startsWith`. Use `--startswith-only` when the keys belong to a
global value set, which is keyed by label.

### mark_workbook_cells.py

```
python scripts/mark_workbook_cells.py grey-skipped master.xlsx --translator-dir returned_csv/
python scripts/mark_workbook_cells.py flag-prior-skips master.xlsx --org-pull pull/ --prior-dir round1/
```

For a workbook with `type`, `component`, `field`, `masterLabel` and per-language
"<Language> Translation" (and optional "<Language> Existing Value") columns.
`grey-skipped` greys cells the translator left blank where the org has nothing either.
`flag-prior-skips` marks red the blanks reviewers already saw, filled in another
language, and left empty, and adds a Summary tab that says red means "confirm".

## Safety notes

- No script deploys or contacts an org. Deploy only after a dry run (`sf project deploy validate`).
- Apply steps never modify their input CSVs. They write to a new, empty folder.
- Apply steps stop on an invalid answer instead of writing a value Salesforce will reject.
- A deploy that did not fully land makes triage exit 2, so automation cannot treat it as done.
- Diagnoses are evidence-based but not infallible. Rows marked Investigate need a person.

## Limitations

- The scripts read the translation CSV format above. They do not build metadata XML from it.
- Grammar rows default to `standard-field`. Object-name grammar (caseValues on the object
  label) needs `--types standard-field,object-label` and the right rows in the CSVs.
- Field-rename detection compares labels only. Two fields with the same label are reported
  as uncertain, not guessed.
- Mojibake detection targets UTF-8 read as cp1252/Latin-1. Other code page mix-ups are not
  detected.
