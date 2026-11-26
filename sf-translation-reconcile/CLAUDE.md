<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

# CLAUDE.md: sf-translation-reconcile

Instructions for an AI coding assistant using this folder.

## What this is

Offline Python tools that (a) compare a translation workbook with what a Salesforce org
really holds, (b) build a review workbook of every live translation, (c) mark rows as
landed or not, (d) make targeted translation corrections with an offline proof, and
(e) report who wrote each value that is about to be overwritten. The scripts never call
Salesforce. You run `sf` yourself, and only when the user has asked for it.

## When to use it

- "Is the master workbook still right?" or "update Existing Value from the org": use (a).
- "Give reviewers a file of everything translated in <org>": use (b).
- "Which of these rows actually went live?": use (c).
- "Push these corrections / decisions to <org>": use (d), plus (e) whenever the org may hold
  values that someone other than us wrote.

## Rules that must never be broken

1. Never deploy without the user saying so for this run and this org. A dry run
   (`--dry-run`) is fine to propose. A real deploy needs explicit approval.
2. Never deploy unless `proof.py --negative-control` printed `PROOF PASS` and two
   `CAUGHT` lines, and `lock.py` printed `LOCK PASS` minutes before the deploy. If lock 3
   fails, rebuild from a new before read (step 3). Never patch the payload by hand.
3. Never trust a retrieve that did not name the parents (CustomObject / Layout / value set /
   CustomLabel) in the same manifest. Use `manifest.py` or `read_manifests.py`.
4. Never overwrite a value that is not ours unless the user has named it. Run `provenance.py`,
   and hold every PRE-EXISTING, OTHER and UNKNOWN overwrite unless its id is in an
   authority file the user approved. Record the user's words in that file.
5. Never trim, re-case or "fix" a value from the decisions file. `scope.py` keeps values
   exact. Show the user its whitespace warnings and let them decide.
6. Never edit the before / pre / after folders. They are evidence.
7. Never treat `UNREADABLE`, `UNRESOLVED`, `NOT FOUND` or `not readable` as a pass. Report them.
8. `apply_change_plan.py --apply` writes the workbook. Run the dry run first and
   show the counts.

## Workflow (d): targeted corrections, in order

```
python scripts/scope.py DECISIONS --out run/scope.json [--wide | --decision-col C ...]
python scripts/manifest.py run/scope.json --out run/manifest.xml
sf project retrieve start --manifest run/manifest.xml --target-metadata-dir run/before --unzip --target-org <alias> --wait 30 --json > run/before.json
python scripts/locate.py --scope run/scope.json --before run/before --out run/located.json
python scripts/provenance.py --located run/located.json --baseline NAME=DIR ... --ours NAME=DIR ... --holds-out run/holds.json --report run/provenance.xlsx
python scripts/locate.py --scope run/located.json --before run/before --out run/located.json --holds run/holds.json --build run/payload
python scripts/proof.py --located run/located.json --before run/before --dir run/payload --negative-control
python scripts/check_export.py --located run/located.json --stf-dir <fresh export>      # optional lock 2
sf project deploy start --metadata-dir run/payload --target-org <alias> --dry-run --wait 60 --json > run/dryrun.json
sf project retrieve start --manifest run/manifest.xml --target-metadata-dir run/pre --unzip --target-org <alias> --wait 30 --json > run/pre.json
python scripts/lock.py --before run/before --pre run/pre --pre-json run/pre.json --payload run/payload
sf project deploy start --metadata-dir run/payload --target-org <alias> --wait 60 --json > run/deploy.json   # only with approval
sf project retrieve start --manifest run/manifest.xml --target-metadata-dir run/after --unzip --target-org <alias> --wait 30 --json > run/after.json
python scripts/verify.py --located run/located.json --before run/before --after run/after
```

Before the build, show the user the locate counts: SAME, CHANGE (fills vs overwrites), NOT
FOUND and HOLD. Resolve every NOT FOUND (wrong name? item missing in this org?), or hold it.
Use `--allow-not-found` only when the user agrees. `--allow-create` creates slots only
for standard-field, quick-action, and inactive value-set values. Say so when you use it.

## Workflows (a), (b), (c)

```
python scripts/read_manifests.py --lists lists --langs de fr --workbook WB --out manifests   # then retrieve each manifest
python scripts/compare_workbook.py WB --retrieve read/obj_1 read/vs_labels --stf-dir EXPORT --plan out/plan.json --report out/compare.xlsx
python scripts/apply_change_plan.py WB out/plan.json                    # dry run, then --apply --record out/changed_cells.xlsx
python scripts/loads_vs_org.py --load "L1=load1.xlsx" --load "L2=load2.xlsx" --retrieve ... --stf-dir EXPORT --out out/loads.xlsx
python scripts/pulldown.py --retrieve read/obj_1 read/vs_labels --stf-dir EXPORT --langs de fr --template WB --out out/review.xlsx
python scripts/compare_workbook.py out/review.xlsx --stf-dir EXPORT --check
python scripts/mark_landed.py WB --suffix Translation --retrieve read_after/... --stf-dir EXPORT_AFTER [--before-stf-dir EXPORT_BEFORE]
```

## Scripts: inputs and outputs

| Script | Reads | Writes | Exit |
|---|---|---|---|
| `read_manifests.py` | `sf org list metadata` JSON, workbook (optional) | `obj_<n>.xml`, `vs_labels.xml`, `read_scope.json` | 0 |
| `compare_workbook.py` | workbook, retrieves and/or export | plan JSON, report xlsx | `--check`: 2 if FILL / DIFFERENT / CLEAR |
| `apply_change_plan.py` | workbook, plan | record xlsx, backup, workbook (only with `--apply`) | 2 if the plan is stale |
| `loads_vs_org.py` | load files, retrieves and/or export, flags | report xlsx/json | 0 |
| `overlay_retrieve.py` | converted retrieve, local tree | local files + backup (only with `--apply`) | 0 |
| `merge_translations.py` | two CSVs | dest CSV + `.bak` (only with `--write`) | 0 |
| `pulldown.py` | retrieve with definitions, export, template | review xlsx | 0 |
| `mark_landed.py` | workbook, after read, before read (optional) | workbook copy with status columns | 2 if any row did not land |
| `scope.py` | decisions csv/xlsx | `scope.json` | 2 on conflict / unknown type or language |
| `manifest.py` | `scope.json` | `manifest.xml` | 0 |
| `locate.py` | scope or located JSON, before read, holds | `located.json`, payload + `.sha256` | 2 if building with NOT FOUND |
| `provenance.py` | located, baselines, our payloads, authority | located (updated), holds, report | 0 |
| `proof.py` | located, before, payload / after | report | 2 on FAIL or a missed control |
| `check_export.py` | located, export | report | 2 on CONFLICT / UNVERIFIED |
| `lock.py` | before, pre, pre JSON, payload | report | 2 on FAIL |
| `verify.py` | located, before, after | report | 0 pass, 1 notes, 2 FAIL |
| `export_diff.py` | export before, export after, located (1+) | report JSON | 2 on WRONG / LOST / CHANGED / NEW |

`reconlib.py` (readers, keys, workbooks) and `slots.py` (slot location, leaf paths,
payload writing) are shared modules, not commands.

## How to verify success

- (d): `verify.py` exits 0, or exits 1 with only `trailing space trimmed`, `not readable`
  (inactive values) or known Salesforce additions, each explained to the user. Optionally run
  `export_diff.py` on exports taken before and after.
- (a): re-run `compare_workbook.py`. Planned categories should drop to zero.
- (b): `compare_workbook.py --check` prints `CHECK PASS`.

## Known pitfalls

- Keep one API version through a whole run. In workflow (d) that is `manifest.py`, the retrieves, and `locate.py --build`; in (a) and (b) it is `read_manifests.py` and its retrieves. The default is 67.0. A run started with an earlier copy (62.0) should be restarted from `manifest.py` (in (a) and (b): from `read_manifests.py`), or finished by passing `--api-version 62.0` to `manifest.py` (if the manifest is made again) and `locate.py --build`. The tools do not detect a mixed run (the locks compare translation files, which do not record the version). Baseline folders read at another version (for `provenance.py`) are evidence as read; they are not re-read.
- Task and Event custom fields are stored under Activity. A Task row and an Event row for
  the same field are one slot, and both must carry the same value. Older payloads may have
  sent them as `Task-<lang>` files. `provenance.py` checks both.
- The export keys layout sections with a position suffix (`_1`) and drops `__c` from field
  names. The readers handle both.
- Inactive picklist values never appear in a retrieve. Read them from an export.
- A language with no translations may have no TRANSLATED section in its `.stf` file.
- A truncated `.stf` download (no final newline) is refused by `check_export.py` and `export_diff.py`.
- Salesforce adds `<aspect>` to a quick action when its label is saved. `verify.py` reports
  it as a known addition.
- Lock 3 can fail because of an unrelated edit, such as a list view filter changed in Setup.
  Restart from the before read anyway, because the payload is built from those files.
- A Bilingual export has no org name in it. Make sure it came from the target org.

## Tests

`python tests/run_tests.py` runs offline on synthetic fixtures (`tests/fixtures.py`).
Run it after any change to `scripts/`.
