# sf-safe-translation-push

Push translations into a production Salesforce org without overwriting any translation the org
already holds.

The method fills only EMPTY translation slots in the target org, plus overwrites that someone has
explicitly approved by name. Five guards stand between the input file and the deploy, and every one
must pass:

1. **The builder refuses overwrites** (`build_push.py`, lock 1). It reads the target's own retrieve,
   sends a value only into a slot the retrieve shows empty, and proves the payload offline: every
   leaf is either a new value into an empty slot, a named overwrite, or exactly what the target
   already holds.
2. **Negative controls** (`negative_control.py`, `negative_control_stf.py`) plant disguised overwrites
   in copies of the data and prove the builder and the export check refuse every one.
3. **An independent read** (`check_vs_stf.py`, lock 2): every slot the push fills must be
   untranslated in the target's own Translation Workbench Bilingual export, taken after the retrieve.
4. **A pre-deploy gate** (`pre_deploy_check.py`, lock 3): a fresh re-retrieve right before the deploy
   must match the build's retrieve exactly, and the payload must be byte-for-byte the one lock 2
   passed.
5. **Verification after the deploy** (`verify_push.py`, optional `export_diff_check.py`): only empty
   slots changed, every value landed, and nothing else in the org moved.

Two details that are easy to get wrong are handled for you:

- **Carriage returns inside values** (`crsafe.py`). A help text can be stored with a CRLF line break.
  Standard XML parsing and writing silently drop that CR, so a payload that re-sends the value would
  rewrite it, and every parsed-XML check would miss the change. All reads and writes here keep it,
  and payloads are written LF-only with each content CR as `&#13;`.
- **Components returned by more than one retrieve batch** (`retr_merge.py`). An object translation
  can come back from its object batch (with layout sections) and from another batch (with quick
  actions). Both copies are merged, so no block goes missing.

## Why

Most translation types cannot be removed again by a deploy. A test in a sandbox showed that a
blank or omitted field label, picklist value, value-set entry, custom label or renamed field is
ignored by the Metadata API; only layout sections, record types and validation rules can be cleared
that way. So a wrong overwrite in production is effectively permanent. Treat every push as one you
cannot take back, and keep the `before/` snapshot as the record of what was there.

## Prerequisites

- Python 3.10 or later.
- `pip install -r requirements.txt` (openpyxl, for workbook input and the review workbook).
- Salesforce CLI v2 (`sf`), authenticated to the target org: `sf org login web --alias my-prod`.
- Access to Setup > Translation Workbench > Export in the target org (for lock 2).

## Install

Copy this folder anywhere. Nothing to build. Check it works:

```
python tests/run_tests.py
```

## Quick start (offline, on the synthetic example)

The tests build a fake org retrieve and run every step. To see the builder on its own, against the
synthetic retrieve in `tests/fixtures/before` (paths after `--work` are relative to the run folder):

```
mkdir demo
python scripts/make_source.py --input examples/source_long.csv --out demo/source.json
python scripts/build_push.py --work demo --before ../tests/fixtures/before
python scripts/negative_control.py --work demo --before ../tests/fixtures/before
```

Look at `demo/plan.json` (the decision for every row), `demo/payload/` and `demo/push_report.json`.

## Input format

`make_source.py` reads a CSV, TSV or workbook (`.xlsx`/`.xlsm`) and writes `source.json`, the only
input the builder reads. Two layouts:

**Long** (default): one row per value.

| Language | Key | Value |
|---|---|---|
| de | CustomField.Widget__c.Color.FieldLabel | Farbe |
| fr | PicklistValue.Widget__c.Color.Blue | Bleu |

Column names: `--lang-col`, `--key-col`, `--value-col`. Workbook sheet: `--sheet`.

**Wide** (`--wide --langs de,fr`): one row per key, one column per language. Column header from
`--wide-header`, for example `--wide-header "{lang} Translation"`. See `examples/source_wide.csv`.

Keys use the Translation Workbench (.stf) spelling. Supported key types:

| Key | Example |
|---|---|
| Field label / help text / related list label | `CustomField.Widget__c.Color.FieldLabel`, `.HelpText`, `.RelatedListLabel` |
| Local picklist value | `PicklistValue.Widget__c.Color.Blue` |
| Global value set value | `PicklistValue.Colors__gvs.Yellow` |
| Standard value set value | `PicklistValue.Standard.LeadSource.Web` |
| Record type name / description | `RecordType.Widget__c.Big.Name`, `.Description` |
| Validation rule message | `ValidationFormula.Widget__c.Size_Required.ErrorMessage` |
| Layout section | `LayoutSection.Widget__c.Widget Layout.Details` |
| Custom label | `CustomLabel.Farewell` |
| Custom app / tab | `CustomApp.Widget_Console`, `WebTab.Widget__c` |
| Report type name / description | `CustomReportType.Widgets_with_Parts.Name` |
| Report type section (this package's spelling) | `ReportTypeSection.Widgets_with_Parts.Widgets` |
| Quick action (global / object) | `QuickAction.New_Widget`, `QuickAction.Account.Log_Call` |
| Button or link | `WebLink.Widget__c.Open_Map` |

Rules applied by `make_source.py`: blank values are ignored (a blank never clears anything); outer
whitespace is stripped unless `--keep-outer-space`; two different values for one language and key
stop the run; Task and Event rows for the same field must agree (both are one value stored under
Activity). `--overrides` applies approved corrections without editing the input: each override
names the value the input must hold now, so a re-sorted or already-fixed input stops the run.

**Approved overwrites** go in a separate file (`examples/named_overwrites.json`):

```json
[{"lang": "de", "key": "RecordType.Widget__c.Big.Name", "was": "Gross"}]
```

`was` is the value the target must still hold. If the target holds anything else at deploy time, the
builder holds the slot and fails. A CSV with columns `lang,key,was` also works.

## Full procedure

Use one run folder per push, for example `runs/2026-01-15_labels/`. `$W` is that folder, `$S` is this
package's `scripts/` folder, `my-prod` is the org alias. Any failed pass condition stops the run.
Never fix a failure by loosening a flag.

| # | Step | Pass condition |
|---|---|---|
| 1 | `python $S/make_source.py --input <file> --out $W/source.json` | `RESULT: PASS` |
| 2 | `python $S/make_manifests.py --source $W/source.json --out $W/manifests --target-org my-prod` (optional: `--layouts list_layout.json` from `sf org list metadata --metadata-type Layout --target-org my-prod --json`) | manifests and printed retrieve commands |
| 3 | `python $S/snapshot.py mark-start --work $W --org-tz <org time zone>` (or `--org-time "YYYY-MM-DD HHMM"`), then immediately one retrieve per manifest: `sf project retrieve start --manifest $W/manifests/<b>.xml --target-metadata-dir $W/before/<b> --unzip --target-org my-prod --wait 30 --json > $W/before/<b>.json` | each JSON `Succeeded`, no messages |
| 4 | `python $S/build_push.py --work $W` (add `--named named_overwrites.json` only for approved overwrites) | `no-overwrite check: 0`, `offline proof: 0`, `RESULT: PASS` |
| 5 | `python $S/negative_control.py --work $W` (same `--named` / `--exclude-langs` as step 4) | `RESULT: CAUGHT` |
| 6 | **Snapshot:** `python $S/snapshot.py create --root <snapshots folder> --org PROD --what <slug> --work $W` | copy verified |
| 7 | Target org: Setup > Translation Workbench > Export > **Bilingual** (not "Outdated and untranslated"), every pushed language, started after step 3. Save unzipped to an export folder | one `Bilingual_<lang>_<stamp>.stf` per language |
| 8 | `python $S/check_vs_stf.py --work $W --stf-dir <export folder> --not-before "<ORG line of read_start.txt>"` (add `--allow-named` and `--before-stf <export from before your first push>` for named overwrites) | `CONFLICTS 0`, `UNVERIFIED 0`, `RESULT: PASS` |
| 9 | `python $S/negative_control_stf.py --work $W --stf-dir <export folder> --not-before "<same>"` (same flags as step 8) | `RESULT: CAUGHT` |
| 10 | `sf data query --use-tooling-api -q "SELECT Id, Status, CheckOnly, CreatedDate FROM DeployRequest WHERE CreatedDate > <UTC line of read_start.txt>" --target-org my-prod` | no real (`CheckOnly=false`) deploy since step 3 |
| 11 | `sf project deploy start --metadata-dir $W/payload --dry-run --target-org my-prod --wait 60 --json > $W/dryrun.json` | `Succeeded`, 0 errors |
| 12 | The owner of the org approves the deploy on the dry-run numbers, conditional on step 13 passing. Then run steps 13 and 14 back to back | |
| 13 | Repeat step 3's retrieves into `$W/pre/<b>` (and `$W/pre/<b>.json`), then `python $S/pre_deploy_check.py --work $W` | `values changed ... 0`, `RESULT: PASS` |
| 14 | `sf project deploy start --metadata-dir $W/payload --target-org my-prod --wait 60 --json > $W/deploy.json`; copy `payload` to `payload_deployed` | `Succeeded`, 0 errors |
| 15 | `python $S/snapshot.py add --snapshot <snapshot> --work $W check_vs_stf.json pre_deploy_check.json dryrun.json deploy.json`, then `python $S/snapshot.py finish --snapshot <snapshot> --deploy-id <deploy ID>` | folder renamed with the deploy ID |
| 16 | Retrieve into `$W/after/<b>` (as step 3), then `python $S/verify_push.py --work $W`; add `verify_push.json` to the snapshot | `RESULT: PASS`, 0 overwrites, 0 changed outside the push |
| 17 | Optional, recommended: a new Bilingual export after the deploy, then `python $S/export_diff_check.py --before <step 7 export> --after <new export> --report $W/push_report.json` | `RESULT: PASS` |
| 18 | `python $S/review_excel.py --work $W --out $W/review.xlsx --target-label PROD --deploy-id <id>` for the values that were held | |

**If step 13 fails, restart at step 3**: a new `before/` (a real retrieve, not a renamed folder),
a new build, a new export and new checks. Mark the old snapshot with
`snapshot.py supersede --snapshot <dir> --reason lock3-fail`.

### The point-in-time snapshot

Before every production deploy, keep a dated copy of what the target held:

```
<snapshots folder>/
  PROD_2024-01-15_0918_before_labels-push_<deployId>/
    before/                 the target's retrieve: every batch folder and its sf --json result
    read_start.txt          when the retrieve started (UTC and org time)
    source.json  plan.json  push_report.json  named_overwrites.json (if any)
    check_vs_stf.json  pre_deploy_check.json  dryrun.json  deploy.json  verify_push.json
    SNAPSHOT.json           every file's size and sha256, and a log of what was added when
    README.txt
```

1. Create it after the build (step 6), before any deploy: there is no deploy ID yet. `create`
   verifies the copy (file count, bytes and hashes).
2. Add the check results and the deploy JSONs as they are produced (`add`).
3. After the deploy, record the deploy ID (`finish`), which appends it to the folder name.
4. A run that was restarted keeps its snapshot, renamed `..._SUPERSEDED-<reason>` (`supersede`).
5. `verify` re-hashes the folder at any time. Keep the snapshots outside cloud-synced folders and
   never edit them.

## Scripts

| Script | Reads | Writes | Exit 2 when |
|---|---|---|---|
| `make_source.py` | CSV/TSV/xlsx | `source.json` | conflicting duplicates, bad override, no rows |
| `make_manifests.py` | `source.json` | `manifests/*.xml`, `batches.json` | (never) |
| `build_push.py` | `source.json`, `before/`, named file | `plan.json`, `payload/`, `push_report.json` | proof failure, overwrite risk, unplaced row, duplicate, unmatched/stale name |
| `negative_control.py` | `plan.json`, `push_report.json`, `before/` | nothing kept | a plant not caught |
| `check_vs_stf.py` | `push_report.json`, `payload/`, export folder | `check_vs_stf.json` | conflict, unverified, bad/old export, no positive control |
| `negative_control_stf.py` | as above | nothing kept | a plant not caught |
| `pre_deploy_check.py` | `before/`, `pre/`, `check_vs_stf.json`, `read_start.txt` | `pre_deploy_check.json` | anything moved, stale `pre/`, changed payload |
| `verify_push.py` | `before/`, `after/`, `push_report.json` | `verify_push.json` | value missing, overwrite, change outside the push |
| `export_diff_check.py` | two export folders, `push_report.json` | optional JSON | lost/changed/new rows, value not as sent |
| `snapshot.py` | run folder | snapshot folder | copy or verify mismatch |
| `review_excel.py` | `push_report.json`, `verify_push.json` | review workbook | |

Library modules: `crsafe.py` (CR-safe XML), `retr_merge.py` (multi-batch merge), `translib.py`
(leaf model, key placement), `stfread.py` (export reader).

## Safety notes

- Run `build_push.py` without `--named` unless someone approved each overwrite by name. Never add
  `--allow-unmatched-names`, `--allow-unplaced` or `--export-floor` to make a failing run pass; each
  is for a case a person has looked at and decided.
- `--no-export-check` on `pre_deploy_check.py` is for sandboxes only.
- Keep the gap between step 13 and step 14 short. An edit made in the org in between is not caught
  by any lock.
- Lock 2 cannot tell which org an export came from. Download it from the target org's own Setup.
  The same-keys check catches one foreign file mixed into the set, and the positive control catches
  an export that shows none of the values the retrieve holds.
- The payload re-sends the target's existing values in the blocks it touches (whole field blocks,
  whole value sets, whole Translations files). That is why lock 3 exists.

## Salesforce behaviour this relies on

- A `CustomObjectTranslation` retrieve returns translated text only when its `CustomObject` and
  `Layout`s are in the same request; an object quick action's translation only with its
  `QuickAction` member. `make_manifests.py` builds requests that way.
- Name every language in a `Translations` retrieve; listMetadata can omit languages that hold labels.
- Task and Event custom fields are Activity fields: their translations are one value, stored in
  `Activity-<lang>`. The builder treats a Task/Event slot as empty only if Activity's is empty too.
- Inactive picklist values are left out of translation files. They show as unplaced (not provably
  empty) and are never written.
- Salesforce trims a trailing space from picklist value translations, and keeps a CR sent as `&#13;`.
  `verify_push.py` counts byte-exact and whitespace-only matches separately.
- Saving a quick action label adds `<aspect>Master</aspect>`; `verify_push.py` accepts it only on
  quick actions the push filled.
- A Bilingual export leaves out the TRANSLATED section for a language with no translations, and never
  lists Lightning page tabs (`--lightning-tab-dir` accepts those as retrieve-only).
- Managed-package tab and app translations can read empty in every retrieve. Only an export shows
  them; use `export_diff_check.py --managed-only` to prove a push left them alone.

## Limitations

- Object names (case forms, gender, articles) and renamed standard field labels are not supported:
  they need per-language grammar rules. Their keys are reported unplaced.
- Flow translations (`flowDefinitions`) are not placed by key.
- A slot is never created: a value whose slot the retrieve does not list is reported unplaced.
- The export file time stamp is read as org time. Confirm the zone with your first export.
- The tests use a synthetic org. Rehearse a real push in a full-copy sandbox first.

## License

Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify, or
distribute this software without written permission.
