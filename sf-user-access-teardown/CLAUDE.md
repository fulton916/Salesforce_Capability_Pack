# CLAUDE.md — sf-user-access-teardown

## What this is

`scripts/user_access_teardown.py` (Python, standard library only) takes a file of User Ids and
an org alias. It queries, per user: permission set group assignments, permission set
assignments (not profile-owned), permission set licence assignments, territory assignments,
public group and queue memberships, and role. Query-only by default; `--execute` deletes the
assignments and clears the role through Bulk API 2.0 (`sf data delete/update bulk`).

## When to use it

- "Remove all access for these users", "strip these users' permission sets / territories /
  queues", "offboard these users from <business unit> but keep the users".
- "What do these users still have?" → query-only mode, no `--execute`.

Not for deactivating or freezing users, or for changing profiles.

## Workflow (in this order)

1. Get the Id file and the org alias from the user. Never guess the org. Check that the file
   holds User Ids (`005...`), one per line.
2. Check login: `sf org display --target-org <alias> --json`.
3. Optional, offline: show the queries.
   ```
   python scripts/user_access_teardown.py --user-ids <file> -o <alias> --generate-only --out <dir>
   ```
4. Query-only run:
   ```
   python scripts/user_access_teardown.py --user-ids <file> -o <alias> --out <dir>
   ```
   Report: org name and sandbox/production line, users found / not found, the count per step,
   and the total. Point the user to the per-step CSVs.
5. Wait for the user to review and say go. Then ask whether all steps are wanted (`--steps`) and
   whether anyone must be kept (`--keep-user-id`).
6. Execute, only with explicit approval in this conversation:
   ```
   python scripts/user_access_teardown.py --user-ids <file> -o <alias> --out <new dir> --execute --confirm <N>
   ```
   N is the TOTAL the script prints for this run. If it differs from the reviewed total, stop and
   tell the user before confirming. Add `--allow-production` only if the user explicitly approved
   a production run.
7. Report the execute results and the REMAINING count. Non-zero remaining: show the
   `*_after.csv` rows and the failing job's `execute_<step>.json` message.

## Inputs and outputs

Input: Id file (blank lines, `#` comments, one header line allowed; 15/18-char Ids; duplicates
dropped), `--target-org` (required).

Output folder: `users.csv`, `missing_user_ids.txt`, `<step>.csv` (readable), `<step>_ids.csv` or
`7_UserRoles_update.csv` (bulk input; role file uses `#N/A` to null the field), `QUERIES.txt`,
`BULK_COMMANDS.sh`, `summary.json`, `summary.csv`; after `--execute` also `execute_<step>.json`
and `<step>_after.csv`.

Exit codes: 0 ok, 1 stopped before any change, 2 a bulk job failed.

## Guardrails

- Never run `--execute` without a query-only run the user has reviewed, and never without
  their explicit go-ahead.
- Never pass `--allow-production` on your own initiative.
- Never derive `--confirm` from anything other than the TOTAL printed by the run you are
  confirming. Never pipe an answer into the prompt.
- Keep the step order (PS/PSG before licences). Do not add steps that delete users or records
  other than assignments.
- Do not remove the automatic exclusion of the running user, the truncation check, the
  stop-on-first-failed-job rule, or the after-query.
- Never commit Id files or results (`.gitignore` covers `teardown_results/` and `*_user_ids.txt`).
  `examples/user_ids_example.txt` holds fake Ids only.

## Verify success

- `summary.json` → `remaining` is 0 for every executed step.
- Spot-check one user in Setup: no permission set assignments beyond the profile, no role,
  no queues.

## Tests

```
python tests/run_tests.py
```
15 offline tests (sf mocked): Id parsing, SOQL generation and chunking, generate-only files,
query-only CSVs, `#N/A` role file, confirm/production/terminal guards, execute order,
stop on failure, own-user exclusion, truncated query.

## Known pitfalls

- Licence deletes fail if a permission set needing that licence is still assigned (for example,
  one assigned through a group that was not removed). Re-run after fixing the cause.
- Some assignments (for example, ones a managed package or Salesforce controls) may not be
  deletable; they show as failed rows in the bulk job.
- Clearing a role changes role-hierarchy sharing for records those users own. Mention it to the
  user before executing the `role` step.
- The bulk job CSVs are written with LF endings and the commands pass `--line-ending LF`; keep
  both if you edit anything (CRLF breaks Bulk API on Windows).
- A blank `UserRoleId` in a bulk update does nothing; `#N/A` is required to null it.
