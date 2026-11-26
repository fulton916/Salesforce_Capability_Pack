# sf-user-access-teardown

For a list of Salesforce user Ids, find their access assignments and, only when you explicitly
ask, remove them in bulk. Query-only by default. Every run keeps CSVs of what it found.

Typical use: users are leaving a business unit or a project, and their permission set groups,
permission sets, licences, territories, groups, queues and role must go, while the users stay.

## What it does

`scripts/user_access_teardown.py` queries these, in this order:

| Step | Key | Object | Removes |
|---|---|---|---|
| 1_PermissionSetGroupAssignments | `psg` | PermissionSetAssignment | permission set group assignments |
| 2_PermissionSetAssignments | `ps` | PermissionSetAssignment | permission set assignments (not the profile's own) |
| 3_PermissionSetLicenseAssignments | `psl` | PermissionSetLicenseAssign | permission set licence assignments |
| 4_TerritoryAssignments | `territory` | UserTerritory2Association | territory assignments |
| 5_PublicGroupMemberships | `groups` | GroupMember (Group.Type = Regular) | public group memberships |
| 6_QueueMemberships | `queues` | GroupMember (Group.Type = Queue) | queue memberships |
| 7_UserRoles | `role` | User (UserRoleId != null) | the role (set to blank; the user is kept) |

Permission set (group) assignments come before licence assignments: Salesforce will not remove
a licence while a permission set that needs it is still assigned.

### Modes

| Mode | Org calls | Changes data |
|---|---|---|
| `--generate-only` | none | no. Writes the SOQL and the bulk commands for review. |
| default (query-only) | read-only queries | no. Writes a CSV per step. |
| `--execute` | queries, then Bulk API jobs, then queries again | **yes**, after confirmation |

`--execute` runs only when:

1. every query succeeded (and none was cut short by the CLI's record limit);
2. the org is a sandbox, or you pass `--allow-production`;
3. you confirm: type the org alias at the prompt, or pass `--confirm N` where N is the total
   number of records it is about to change.

It stops at the first failed bulk job, then queries again and reports what is left.
Your own user (the CLI user) is excluded automatically if it is in the list, and
`--keep-user-id` protects others.

### Output (one folder per run, default `teardown_results/<org>_<UTC time>/`)

| File | Content |
|---|---|
| `users.csv`, `missing_user_ids.txt` | the listed users found in the org, and the Ids not found |
| `<step>.csv` | what was found, with readable columns (username, permission set, group, territory, role) |
| `<step>_ids.csv` / `7_UserRoles_update.csv` | the exact files the bulk jobs use (`Id`; for roles `Id,UserRoleId` = `#N/A`) |
| `QUERIES.txt` | every SOQL query, per chunk (paste into any query tool to check) |
| `BULK_COMMANDS.sh` | the `sf data delete/update bulk` commands `--execute` runs |
| `summary.json`, `summary.csv` | counts per step; with `--execute` also job results and what remains |
| `execute_<step>.json`, `<step>_after.csv` | raw bulk job output, and what the re-query found |

`#N/A` is how Bulk API 2.0 sets a field to null. A blank value would be ignored.

## Why one Python script

This package is **one Python script** (standard library only): one place for the query list, the
same behaviour on Windows, macOS and Linux, and offline tests that mock `sf`.

## Prerequisites

- Python 3.10+ (no extra packages)
- Salesforce CLI v2 (`sf`), logged in: `sf org login web --alias my-sandbox`
- For `--execute`: a user who can manage users and permission set assignments
  (for example "Manage Users" and "Assign Permission Sets"), and territories if that step runs.

## Quick start

```
# 1. offline: see the queries and commands
python scripts/user_access_teardown.py --user-ids examples/user_ids_example.txt -o my-sandbox --generate-only

# 2. read-only: what would be removed
python scripts/user_access_teardown.py --user-ids my_user_ids.txt -o my-sandbox

# 3. review the CSVs, then remove (asks you to type the alias)
python scripts/user_access_teardown.py --user-ids my_user_ids.txt -o my-sandbox --execute
```

## Usage

```
python scripts/user_access_teardown.py --user-ids FILE -o ALIAS [options]
```

| Option | Meaning |
|---|---|
| `--user-ids FILE` | One User Id (`005...`, 15 or 18 characters) per line. Blank lines, `#` comments and a header line are ignored; duplicates are dropped. |
| `-o`, `--target-org` | Required. No default, on purpose. |
| `--out DIR` | Results folder. |
| `--steps a,b` | Only these steps (`psg,ps,psl,territory,groups,queues,role`). They always run in the safe order. |
| `--keep-user-id ID` | Never touch this user. Repeatable. |
| `--chunk-size N` | User Ids per query (default 200, max 800). |
| `--generate-only` | No org call. |
| `--execute` | Remove what was found, after the checks above. |
| `--confirm N` | Non-interactive confirmation: N must equal the total records to change. |
| `--allow-production` | Allow `--execute` on a production org. |
| `--wait MIN` | Minutes to wait per bulk job (default 30). |

Exit codes: 0 done, 1 stopped before changing anything (bad input, failed query, refused
confirmation), 2 a bulk job failed, 3 changes were made but the check afterwards (the second
query) failed. On 3, `summary.json` still lists what was done; re-run without `--execute` to see
what is left.

## Tests

```
python tests/run_tests.py
```

Offline. Query generation from a synthetic Id list, CSV output, and every `--execute` guard,
with `sf` mocked.

## Safety notes

- Run query-only first and read the CSVs. Then run `--execute`; it re-queries, so compare its
  printed counts with the ones you reviewed before you confirm.
- Removing assignments cannot be undone by this tool. The `<step>.csv` files are your record of
  what was there (permission set, group, territory, role names) if you need to re-assign.
- The CSVs hold usernames. Do not commit them; `.gitignore` covers `teardown_results/`.
- Do not include integration or admin users unless you mean to. Use `--keep-user-id`.

## Limitations

- Some assignments (for example, ones a managed package or Salesforce controls) may not be
  deletable; the bulk job reports them as failed rows.
- The role step clears `UserRoleId`. It does not change the profile, deactivate or freeze users.
- Removing a user's role changes record sharing for the records those users own, because
  sharing that came from the role hierarchy goes away with the role.
- Other access (account/opportunity team membership, manual sharing, delegated admin groups,
  user-level licences, Chatter groups) is not covered.
- The CLI's `org-max-query-limit` (default 10,000) caps each query. The script stops if a result
  is cut short; raise the limit or lower `--chunk-size`.

## License

Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify, or
distribute this software without written permission.
