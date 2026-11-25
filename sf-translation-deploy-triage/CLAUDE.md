<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

# CLAUDE.md - sf-translation-deploy-triage

## What this is

Offline tools that turn Salesforce deploy/validate results for translation metadata
(CustomObjectTranslation, Translations, GlobalValueSetTranslation, StandardValueSetTranslation)
into triage workbooks and reviewer hand-off files, then apply the answers back to the
translation CSVs and scope the redeploy to only the components that failed.

No script calls Salesforce. You run `sf` yourself to produce inputs and to deploy.

## When to use it

- A translation deploy or validate failed or returned `SucceededPartial`, and someone needs
  to know what failed, why, and who must fix it.
- Several load files were deployed and their errors need one combined report.
- A sandbox validate has many known, irrelevant errors and you need only the new ones.
- Salesforce asked for gender / starts-with values ("Gender is required for language X").
- Picklist keys were sent as labels where the org needs API names.

## Workflow

1. Get the deploy result as JSON. Ask the user for the org alias; never guess it.
   ```
   sf project deploy validate --source-dir <payload> --target-org <alias> --json > deploy.json
   ```
2. Gather evidence (optional but it is what makes the diagnosis useful):
   ```
   sf sobject describe -s <Object> --target-org <alias> --json > describes/<Object>.json
   sf data query -q "SELECT SobjectType, DeveloperName, Name FROM RecordType" --target-org <alias> --json > describes/_recordtypes.json
   ```
   A Source .stf export (Setup > Translation Workbench > Export > Source) is the org's own
   key list. Ask the user for it if available.
3. Triage:
   ```
   python scripts/triage_deploy_errors.py --load "Load 1=deploy.json=<csv_dir>=<payload_dir>" \
       --describes describes/ [--source-stf Source_en_US_*.stf] [--baseline known.txt] --out errors.xlsx
   ```
   Exit 2 means a deploy did not fully land. Report that plainly: say how many components
   failed and how many elements were lost. Do not call such a run done.
4. Re-cut by owner for hand-off: `python scripts/split_by_owner.py errors.xlsx`.
5. Grammar failures:
   ```
   python scripts/make_grammar_file.py deploy.json <csv_dir> --out grammar.xlsx
   ```
   A reviewer fills ANSWER. Then:
   ```
   python scripts/apply_grammar_file.py grammar.xlsx <csv_dir> deploy.json -d <new_dir>
   ```
6. Picklist label/API-name and starts-with Yes/No questions:
   ```
   python scripts/make_action_file.py deploy.json <csv_dir> --describes describes/ --out action.xlsx
   python scripts/apply_action_file.py action.xlsx <csv_dir> -d <new_dir>
   ```
7. Build metadata from the scoped CSVs with your CSV-to-metadata tool (not part of
   this package), dry-run it, show the user the result, and deploy only when they confirm.

Validate-only noise from a drifted sandbox:
```
python scripts/subtract_baseline.py ref.json --write-baseline known.txt   # once
python scripts/subtract_baseline.py new.json known.txt                    # each run
```

## Inputs and outputs

| Script | Inputs | Output | Exit |
|---|---|---|---|
| triage_deploy_errors.py | `--load` specs; optional describes, record types, value sets, .stf, baseline, retrieved metadata | .xlsx: Summary + one tab per category | 0 landed / 2 not fully landed |
| subtract_baseline.py | deploy JSON, baseline file | console report, optional `--json-out` | 0 none new / 1 new errors |
| split_by_owner.py | triage .xlsx | new .xlsx, one tab per party | 0 |
| make_grammar_file.py | deploy JSON, CSV dir, optional `--known` | .xlsx with dropdowns | 0 |
| apply_grammar_file.py | filled .xlsx, CSV dir, deploy JSON | scoped CSVs in a NEW folder | 0 ok / 1 blanks / error on invalid |
| make_action_file.py | deploy JSON, CSV dir, describes | .xlsx, 2 question tabs | 0 |
| apply_action_file.py | filled .xlsx, CSV dir | updated CSVs in a NEW folder | 0 / error on invalid |
| mark_workbook_cells.py | workbook + CSV folders | marked workbook (in place or `--out`) | 0 |

CSV format: `translations_<lang>.csv` with `file,type,component,field,masterLabel,source,translation`
plus optional `gender`, `startsWith`. See README.md.

## Guardrails

- Never deploy without a dry run (`sf project deploy validate`) and the user's go-ahead.
- Never deploy the full CSV set after a grammar or action round. Deploy the scoped output
  folder. Components that already landed must stay out of the redeploy.
- Never treat `SucceededPartial` or exit code 2 as success. Never add `--allow-partial` to
  hide it; use it only when the user wants a report of a known partial run.
- Do not edit the reviewers' translations. Keys may be re-keyed or repaired; translation
  text is carried as supplied (the only exception is the exact mojibake repair, which the
  workbook shows in its own column).
- Do not fill grammar answers yourself. Gender describes the translated word, and that is
  the reviewer's call. Pre-filled answers come only from earlier answers (`--known`).
- Do not override an apply step's validation error by editing the allowed values.
- Do not write outputs into the input folder. The apply steps refuse a non-empty folder.

## How to verify success

- `python tests/run_tests.py` passes (offline).
- After triage: every row has a category; check the Summary totals match the deploy's
  failure count minus the "Not listed" lines.
- After a redeploy: run triage again on the new result. The fixed rows must be gone and the
  exit code must be 0. If a Bilingual .stf export is available, pass `--stf-dir` and confirm
  resolved rows drop out.

## Known pitfalls

- PowerShell `> file.json` writes a UTF-8 BOM; the loader handles it. Other JSON readers may not.
- Salesforce caps the invalid values it lists per component. Fixing every listed value can
  reveal more on the next run. Triage marks valid-but-listed values as collateral.
- Grammar errors report only the first missing attribute per component. French and Italian
  need gender AND starts-with; the grammar file asks both at once.
- Danish, Swedish and Dutch reject Masculine. Their common gender maps to Feminine.
- A global value set is keyed by label, not API name. Use `--startswith-only` when applying
  an action file whose Tab 2 keys are global value set values.
- A near-empty retrieved `CustomObjectTranslation` does not mean "no translations". Retrieve
  it with its parent `CustomObject` named in the same request, or use a .stf export.
- Mojibake in an error message is detected with a generic UTF-8-as-cp1252 test. Real text
  such as "Â°" can trip it; read the Diagnosis before acting.
