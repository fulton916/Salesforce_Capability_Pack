<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

# CLAUDE.md - sf-safe-translation-push

## What this is

A no-overwrite method for pushing translations into a production Salesforce org. It fills only
EMPTY translation slots in the target, plus overwrites a person approved by name. Five guards must
all pass: the builder's offline proof (lock 1), negative controls, the target's Bilingual export
check (lock 2), the pre-deploy freshness gate (lock 3), and verification after the deploy.

Use it when the user wants translations (field labels, picklist values, value sets, record types,
validation messages, layout sections, custom labels, apps, tabs, report types, quick actions,
buttons) loaded into an org where existing translations must survive. Do not use it for object
names (case forms / gender) or renamed standard field labels: not supported, they come out unplaced.

Read `README.md` for the input format and the full step table before the first run.

## Hard rules

- **Never deploy to a production org without every lock passing in this run**: `build_push.py`
  exit 0, `negative_control.py` CAUGHT, `check_vs_stf.py` PASS, `negative_control_stf.py` CAUGHT,
  dry run Succeeded, `pre_deploy_check.py` PASS immediately before the deploy.
- **Every deploy needs the user's explicit go-ahead**, given on the dry-run numbers. Never run
  `sf project deploy start` without `--dry-run` on your own initiative.
- **Never loosen a guard to get a pass.** Do not add `--named`, `--allow-named`,
  `--allow-unmatched-names`, `--allow-unplaced`, `--export-floor/--export-waiver` or
  `--no-export-check` unless the user decided that specific case. Record their words
  (`--export-waiver "<their words>"`; a `NAMED_OVERWRITE_AUTHORITY.txt` in the snapshot for names).
- `--no-export-check` is for sandboxes only.
- Never edit `before/`, `pre/`, `after/`, the export folder, or a snapshot folder. Controls work on
  copies (`*_negctl*`), which they delete.
- If `pre_deploy_check.py` fails, restart at the retrieve (new `before/`, build, export, checks). Do
  not re-run only the Python on an old `pre/` (it fails on age anyway), and do not rename an old
  folder into `before/` (each batch JSON's `zipFilePath` must point inside its own folder).
- Keep steps 13 (re-retrieve + lock 3) and 14 (deploy) back to back. An org edit between them is the
  one thing no lock catches.
- Never put a real org alias, username, record ID or deploy ID into this package's files.

## Workflow (commands in order)

`$S` = this package's `scripts/`, `$W` = the run folder (one per push), `<alias>` = target org.

1. `python $S/make_source.py --input <file> --out $W/source.json` (long or `--wide --langs ...`;
   `--sheet` for a workbook; `--overrides` for approved corrections). Pass: `RESULT: PASS`.
2. `python $S/make_manifests.py --source $W/source.json --out $W/manifests --target-org <alias>`
   (better with `--layouts` from `sf org list metadata --metadata-type Layout --target-org <alias> --json`).
3. `python $S/snapshot.py mark-start --work $W --org-tz <IANA zone>` (or `--org-time "YYYY-MM-DD HHMM"`),
   then for each batch `b` in `manifests/batches.json`:
   `sf project retrieve start --manifest $W/manifests/<b>.xml --target-metadata-dir $W/before/<b> --unzip --target-org <alias> --wait 30 --json > $W/before/<b>.json`
   Create `$W/before` first. Pass: every JSON `"status": "Succeeded"`, no messages.
4. `python $S/build_push.py --work $W [--named named_overwrites.json]`.
   Pass: `no-overwrite check: 0`, `offline proof: 0`, `RESULT: PASS`. Read the decisions line and
   the unplaced/held lists out to the user.
5. `python $S/negative_control.py --work $W` with the same `--named`/`--exclude-langs` as step 4.
   Pass: `RESULT: CAUGHT`. A path printed as "NOT exercised" is a gap to mention, not a failure.
6. `python $S/snapshot.py create --root <snapshots folder> --org <label> --what <slug> --work $W`.
7. Ask the user for a **Bilingual** export of the target (Setup > Translation Workbench > Export),
   every pushed language, started after step 3, saved unzipped.
8. `python $S/check_vs_stf.py --work $W --stf-dir <export> --not-before "<ORG line of read_start.txt>"`
   (+ `--allow-named --before-stf <export from before the first push>` when named overwrites exist;
   `--lightning-tab-dir $W/before/<b>/unpackaged/unpackaged/tabs` if Lightning page tabs are pushed).
   Pass: `CONFLICTS 0`, `UNVERIFIED 0`, `RESULT: PASS`.
9. `python $S/negative_control_stf.py --work $W --stf-dir <export> --not-before "<same>"` (same flags). Pass: CAUGHT.
10. `sf data query --use-tooling-api -q "SELECT Id, Status, CheckOnly, CreatedDate FROM DeployRequest WHERE CreatedDate > <UTC line>" --target-org <alias>`.
    Pass: no `CheckOnly=false` deploy since step 3. If there is one, restart at step 3.
11. `sf project deploy start --metadata-dir $W/payload --dry-run --target-org <alias> --wait 60 --json > $W/dryrun.json`.
12. Show the user the numbers (fills, named overwrites, held, components, dry-run result) and ask
    for the go-ahead. Stop here until they answer.
13. Retrieve every batch again into `$W/pre/<b>` (+ `.json`), then `python $S/pre_deploy_check.py --work $W`.
    Pass: `RESULT: PASS`. On FAIL: stop, report what changed, restart at step 3.
14. `sf project deploy start --metadata-dir $W/payload --target-org <alias> --wait 60 --json > $W/deploy.json`;
    copy `payload` to `payload_deployed`.
15. `python $S/snapshot.py add --snapshot <dir> --work $W check_vs_stf.json pre_deploy_check.json dryrun.json deploy.json`,
    then `python $S/snapshot.py finish --snapshot <dir> --deploy-id <id>`.
16. Retrieve into `$W/after/<b>`, then `python $S/verify_push.py --work $W`. Pass: `RESULT: PASS`.
    Add `verify_push.json` to the snapshot.
17. Recommended: a new export after the deploy, then
    `python $S/export_diff_check.py --before <step 7 export> --after <new> --report $W/push_report.json`.
18. `python $S/review_excel.py --work $W --out $W/review.xlsx --target-label <label> --deploy-id <id>`.

Sandbox rehearsal: same steps against a sandbox alias; lock 2 may be skipped there only with
`pre_deploy_check.py --no-export-check` (it is recorded).

## Inputs and outputs

| Script | Inputs | Outputs | Exit 2 when |
|---|---|---|---|
| make_source.py | csv/tsv/xlsx, optional overrides json | source.json | duplicate conflict, Task/Event disagree, bad override |
| make_manifests.py | source.json, optional Layout list | manifests/obj_N.xml, labels.xml, batches.json | - |
| build_push.py | source.json, before/, optional named file (json lang/key/was or csv) | plan.json, payload/ (+package.xml), push_report.json, _merged_before/ | proof failure, overwrite risk, unplaced, duplicate, unmatched or stale name |
| build_push.py --plan-in | a plan json (controls) | payload and report at the paths given | same |
| negative_control.py | plan.json, push_report.json, before/ | nothing kept | any plant not caught |
| check_vs_stf.py | push_report.json, payload/, export dir | check_vs_stf.json (hashes recorded) | conflict, unverified, bad/old/truncated export, no positive control |
| negative_control_stf.py | same as check | nothing kept | plant not caught |
| pre_deploy_check.py | before/, pre/, check_vs_stf.json, read_start.txt, payload/ | pre_deploy_check.json | any change, stale/copied pre/, payload or check script changed |
| verify_push.py | before/, after/, push_report.json | verify_push.json | value not live, overwrite, change outside push |
| export_diff_check.py | 2 export dirs, push_report.json | optional --out json | lost/changed/new rows, value not as sent |
| snapshot.py | run folder | snapshot folder, SNAPSHOT.json | copy/verify mismatch |
| review_excel.py | push_report.json, verify_push.json | xlsx (ACTION / Pushed / Unplaced) | - |

Decisions in plan.json: `FILL` (empty slot), `NAMED` (approved overwrite, target still holds `was`),
`LIVE` (target already holds this exact value), `HOLD` (target holds another value; not sent),
`HOLD-STALE` (named, but the target no longer holds `was`), `UNPLACED`, `SKIPPED` (excluded language,
default en_US).

## How to verify success

- push_report.json: `proof_failures`, `overwrite_risk`, `duplicates`, `named_not_found`, `named_stale`
  all empty.
- check_vs_stf.json: `result` PASS; `positive_control` shows at least one translated value per language.
- pre_deploy_check.json: PASS, `changed` empty, `pre_age_min` small.
- verify_push.json: `landed == total`, `overwrote`, `problems`, `outside` empty.
- Snapshot: `snapshot.py verify` PASS, folder name ends with the deploy ID.

## Known pitfalls

- Keep one API version through a whole run. The default is 67.0 in both `make_manifests.py` (step 2) and `build_push.py` (step 4); the retrieves in steps 3, 13 and 16 reuse the step 2 manifests. A run started with an earlier copy of the tools (62.0) should be restarted from step 2 (`make_manifests.py`), or finished by passing `--api-version 62.0` to `build_push.py`, and to `make_manifests.py` only if the manifests are made again. The tools do not detect a mixed run (the locks compare translation files, which do not record the version).
- Run the offline tests after any code change: `python tests/run_tests.py` (no org calls).
- Paths given after `--work` are relative to the run folder.
- The export must be **Bilingual**. "Outdated and untranslated" fails the header check. An export
  started before the retrieve fails the age check: ask for a new one, or the user may waive it.
- Export file stamps are org time. Confirm the zone on the first export and pass `--not-before` in it.
- A Bilingual export never lists Lightning page tabs; pass `--lightning-tab-dir`, which accepts only
  `.tab` files containing `<flexiPage>`.
- A Task or Event field slot looks empty in `Task-<lang>`; the value lives in `Activity-<lang>`.
  `make_manifests.py` adds Activity; without it those rows are unplaced (safe).
- Inactive picklist values, deleted fields and slots the retrieve does not list come out unplaced.
  Explain them to the user; drop them from the input or, if the user agrees, pass `--allow-unplaced`.
- Salesforce trims trailing spaces on picklist translations: verify reports these as live but not
  byte-exact. Fix stray spaces in the input instead.
- A deploy cannot blank most translation types. Treat the push as permanent; the snapshot's
  `before/` is the only record of the old values.
- Managed-package tab/app translations can be invisible to retrieves; only an export shows them
  (`export_diff_check.py --managed-only`).
