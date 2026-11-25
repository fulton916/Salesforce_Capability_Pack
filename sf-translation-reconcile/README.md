# sf-translation-reconcile

Keeps a Salesforce translation workbook honest against what is really live in an org, and
applies targeted translation corrections with an offline proof and a record of who wrote
each value being replaced.

It does five things:

| | Job | Scripts |
|---|---|---|
| a | Compare the workbook's "Existing Value" cells with the org. Apply the resulting change plan, writing a record of every changed cell first. Report what earlier load files actually left live. | `compare_workbook.py`, `apply_change_plan.py`, `loads_vs_org.py`, `overlay_retrieve.py` |
| b | Pull-down: build a review workbook of every translatable value live in an org, and flag items the org has that your template lacks. | `read_manifests.py`, `pulldown.py`, `compare_workbook.py --check` |
| c | Mark each workbook row with whether it really landed. | `mark_landed.py` |
| d | Targeted corrections: turn a decisions file into exact slot changes, prove the payload offline, lock, deploy, then verify. | `scope.py`, `manifest.py`, `locate.py`, `proof.py`, `check_export.py`, `lock.py`, `verify.py`, `export_diff.py` |
| e | Provenance: for every value about to be overwritten, say whether it was there before a baseline snapshot or one of your own pushes wrote it. | `provenance.py` |

Every script reads files. None of them calls Salesforce. You run the `sf` commands
yourself, so nothing is deployed unless you deploy it.

## Why

- A clean deploy report does not prove the values are live. Only reading the org back proves it.
- A metadata retrieve returns translation content only for parents named in the same
  manifest. A retrieve of `CustomObjectTranslation` on its own looks almost empty, and
  if you trust it you will plan thousands of wrong changes. The manifests here always
  name the parents.
- A Bilingual `.stf` export from Translation Workbench is a second, independent read. It
  also shows values a retrieve cannot, such as inactive picklist values.
- Targeted fixes go wrong when a whole-object payload carries stale values. Here the
  payload is built from the org's own current files, and only the scoped values change.
  The proof is whitespace-exact.

## Prerequisites

- Python 3.10+ and `pip install -r requirements.txt` (openpyxl).
- Salesforce CLI v2 (`sf`), authorised to the org (`sf org login web --alias my-sandbox`).
- Optional: a Bilingual export from Setup > Translation Workbench > Export > Bilingual. Unzip
  it into a folder. The files are named `Bilingual_<lang>_<date>.stf`.

## Install

Copy this folder anywhere. There is nothing to build. Run the tests:

```
python tests/run_tests.py
```

## Inputs this toolset understands

**Workbook rows.** Each sheet has the key columns `type`, `component`, `field`,
`masterLabel` and `English`, plus language columns named `<Language> <suffix>`, for example
`German Existing Value` or `German Translation`. A language code works too (`de Translation`).
Rename the key columns with `--cols "item=Section,field=API Name"`. Add languages with
`--lang-map file.json`. A row is data only when its `type` cell holds a known type, so
banner rows ("Do Not Edit") are skipped wherever they sit.

Types: `field-label`, `field-help`, `field-relationship-label`, `field-picklist`,
`record-type`, `validation-rule`, `layout-section` (field = layout name, masterLabel =
section), `web-link`, `global-value` and `standard-value` (component = the value set),
`custom-label`, `custom-tab`, `custom-app`, `quick-action` (field = `Obj.Action` or a global
action name), `report-type`, `report-type-section`, `standard-field` (a renamed standard
field: singular form plus gender).

**Org reads.** These are metadata-format retrieves (`--target-metadata-dir ... --unzip`)
and/or a Bilingual export folder. When both have a value, the retrieve wins.

## Quick start: is my workbook still true?

```
sf org list metadata --metadata-type CustomObject   --target-org my-sandbox --json > lists/list_CustomObject.json
sf org list metadata --metadata-type Layout         --target-org my-sandbox --json > lists/list_Layout.json
sf org list metadata --metadata-type GlobalValueSet --target-org my-sandbox --json > lists/list_GlobalValueSet.json
python scripts/read_manifests.py --lists lists --langs de fr --workbook master.xlsx --out manifests
sf project retrieve start --manifest manifests/obj_1.xml --target-metadata-dir read/obj_1 --unzip --target-org my-sandbox --json > read/obj_1.json
sf project retrieve start --manifest manifests/vs_labels.xml --target-metadata-dir read/vs_labels --unzip --target-org my-sandbox --json > read/vs_labels.json
python scripts/compare_workbook.py master.xlsx --retrieve read/obj_1 read/vs_labels --stf-dir exports/today --plan out/plan.json --report out/compare.xlsx
python scripts/apply_change_plan.py master.xlsx out/plan.json            # dry run
python scripts/apply_change_plan.py master.xlsx out/plan.json --apply --record out/changed_cells.xlsx
```

## Full usage

### (a) Workbook vs org

- `compare_workbook.py WORKBOOK --retrieve DIR... --stf-dir DIR [--plan F] [--report F]`
  sorts each cell as `same`, `whitespace`, `FILL`, `DIFFERENT`, `CLEAR`, `UNREADABLE` or
  `UNRESOLVED`. Only non-English `FILL`/`DIFFERENT`/`CLEAR` cells go into the plan. The
  English column is reported but never changed.
- `apply_change_plan.py WORKBOOK PLAN [--apply]` runs as a dry run by default. With `--apply`
  it stops if any planned cell changed since the plan was made. Then it writes the record,
  a timestamped backup and the workbook, in that order. `--reference NAME=STF_DIR` and
  `--load-file NAME=XLSX` add columns saying where each old value also appears.
- `loads_vs_org.py --load NAME=XLSX ... --retrieve ... --stf-dir ...` sorts each value a load
  file supplied as `LIVE`, `LIVE-OLDER` (a later load never landed), `NOT LIVE` (a redeploy
  candidate), `OTHER` or `NO TARGET`. `--flags` lists known-bad values, which are never
  redeploy candidates.
- `overlay_retrieve.py --src CONVERTED --dest force-app/main/default` copies a verified
  retrieve over a local tree, after `sf project convert mdapi`. It only overwrites and
  never deletes. It runs as a dry run by default. `--apply` needs `--backup`.
- `merge_translations.py SRC.csv DEST.csv [--write]` copies a translation column between
  CSVs, matching rows on key columns.

### (b) Pull-down

```
python scripts/pulldown.py --retrieve read/obj_1 read/vs_labels --stf-dir exports/today --langs de fr --template master.xlsx --out out/review.xlsx
python scripts/compare_workbook.py out/review.xlsx --stf-dir exports/today --check
```

The retrieve must hold the definitions too, which the `read_manifests.py` manifests include.
Salesforce-owned layout section headings, inactive values (unless you pass
`--include-inactive`) and protected or non-text labels are left out. Blue rows are new
compared with the template. `--check` is an independent check against the export and
exits 2 on any disagreement.

### (c) Did it land?

```
python scripts/mark_landed.py corrections.xlsx --suffix Translation --retrieve read_after/obj_1 --stf-dir exports/after --before-stf-dir exports/before
```

This adds `Landed status` and `Landed detail` columns to a copy of the workbook. The
statuses are LANDED, ALREADY HELD, LANDED (spacing), DIFFERENT, NOT LANDED, UNREADABLE and
NO TARGET. It exits 2 if any row did not land.

### (d) Targeted corrections

Keep each run in its own folder (`run/`).

1. `python scripts/scope.py decisions.xlsx --out run/scope.json`. Values are kept exactly as
   given. It refuses conflicting values for one slot. Whitespace oddities produce warnings.
2. `python scripts/manifest.py run/scope.json --out run/manifest.xml`
3. `sf project retrieve start --manifest run/manifest.xml --target-metadata-dir run/before --unzip --target-org my-sandbox --wait 30 --json > run/before.json`
4. `python scripts/locate.py --scope run/scope.json --before run/before --out run/located.json`
   gives each slot a status of SAME, CHANGE, NOT FOUND or HOLD.
5. On an org that already holds values you care about, run `provenance.py` (step (e)) and get the holds file.
6. `python scripts/locate.py --scope run/located.json --before run/before --out run/located.json --holds run/holds.json --build run/payload`
7. `python scripts/proof.py --located run/located.json --before run/before --dir run/payload --negative-control` (lock 1)
8. Optional lock 2: take a fresh Bilingual export, then run `python scripts/check_export.py --located run/located.json --stf-dir exports/today`
9. `sf project deploy start --metadata-dir run/payload --target-org my-sandbox --dry-run --wait 60 --json > run/dryrun.json`
10. Lock 3: re-retrieve into `run/pre` with the same manifest, then run `python scripts/lock.py --before run/before --pre run/pre --pre-json run/pre.json --payload run/payload`.
    Deploy straight away: `sf project deploy start --metadata-dir run/payload --target-org my-sandbox --wait 60 --json > run/deploy.json`
11. Re-retrieve into `run/after`, then run `python scripts/verify.py --located run/located.json --before run/before --after run/after`.
    Optionally, compare exports taken before and after: `python scripts/export_diff.py --before exports/before --after exports/after --located run/located.json`.

### (e) Provenance

```
python scripts/provenance.py --located run/located.json --baseline snapshot=snapshots/before_first_push --ours push1=runs/push1/payload --authority run/authority.txt --holds-out run/holds.json --report run/provenance.xlsx
```

Each overwrite gets one of these labels:

- **PRE-EXISTING**: a baseline already held a value there.
- **OURS**: no baseline held a value, and one of your payloads wrote the current value.
- **OTHER**: nobody you know of wrote it.
- **UNKNOWN**: no baseline covers the file.

Only OURS is released by default. Everything else is held, unless its entry id is listed in
`--authority`.

## Safety notes

- Nothing here deploys. Each step's output is a file that a person can read.
- Dry runs are the default (`apply_change_plan.py`, `overlay_retrieve.py`, `merge_translations.py`).
  `mark_landed.py` writes a copy.
- The payload is whole files from the before read, with only scoped leaves changed.
  Comments for untranslated items are kept, and a carriage return is written as `&#13;`.
- Do not deploy unless the proof passes, both negative controls are CAUGHT, and lock 3
  passes. If lock 3 fails, start again from the before read.
- Salesforce has been seen to trim trailing spaces on some value-set and picklist translations.
  `verify.py` reports this as `trailing space trimmed` (exit 1), not as a pass.

## Limitations

- Reads metadata-format (mdapi) retrieves only. To use a source-format tree, convert it first.
- Language columns are matched by display name or code. Add any missing names with `--lang-map`.
- `.stf` reading turns `\n`, `\r` and `\t` written inside values back into control
  characters. No other escape sequence is decoded.
- Object names (the object's own singular/plural forms, articles, cases), flows and
  managed-package values a retrieve cannot show are not handled by `locate.py`.
- `pulldown.py` lists items from the definitions in the retrieve. Anything the manifest did
  not name will not appear.

## License

Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify, or
distribute this software without written permission.
