<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

# CLAUDE.md — sf-territory-export

## What this is

Read-only tooling for Enterprise Territory Management (ETM):

- `scripts/territory_export.py` — runs a fixed set of SOQL queries through `sf data query` and
  writes one Excel tab per query, plus Index, Run Info and a computed Hierarchy tab. Can save the
  raw results as JSON (`--save-json`) and rebuild from them (`--from-json`).
- `scripts/territory_access_audit.py` — optional report from a JSON folder: per-territory access
  levels with editable "Should be" columns and automatic checks.
- `scripts/territory_rule_operators.py` — optional report from a JSON folder: every assignment
  rule criteria line with its operator, flagging `contains` where `equals` was likely meant.
- `scripts/territory_common.py` — shared helpers (CLI call, JSON folders, hierarchy walk).

## When to use it

- "Pull the territory hierarchy / rules / user assignments from <org>."
- "Which territories have different access levels from the rest?" → access audit.
- "Are the territory rules using contains or equals?" → rule operators report.
- "Is UAT the same as production for territories?" → export both with `--save-json`, then a
  report with `--compare`.

## Workflow

1. Confirm the org alias and the scope with the user: model (default Active), and the top
   territory if they care about one branch (`--root-territory`, by DeveloperName when names
   repeat).
2. Check login: `sf org display --target-org <alias> --json`.
3. Optional: `python scripts/territory_export.py --list-queries` to show the SOQL.
4. Export and keep JSON:
   ```
   python scripts/territory_export.py -o <alias> [--root-territory <DevName>] --save-json out/<alias>_json --output out/<alias>_territories.xlsx
   ```
5. Read the Index tab (or stdout): every status should be `OK`. Handle `ERROR` / `TRUNCATED`
   (see pitfalls) before reporting numbers.
6. Reports, if asked:
   ```
   python scripts/territory_access_audit.py --json-dir out/<alias>_json --label <alias> [--root-territory <DevName>] [--compare <other>=out/<other>_json] --output out/access_audit.xlsx
   python scripts/territory_rule_operators.py --json-dir out/<alias>_json --label <alias> [--focus-field Account.<Code__c> ...] [--compare <other>=out/<other>_json] --output out/rule_operators.xlsx
   ```
7. Report the printed summary lines. Do not restate findings the workbook does not support.

## Inputs and outputs

| Script | Input | Output |
|---|---|---|
| `territory_export.py` | org alias (or `--from-json DIR`) | `.xlsx`; with `--save-json DIR`: `models.json`, `territories.json`, `rules.json`, `rule_items.json`, `rule_territories.json`, `user_territories.json`, `object_territory_counts.json` (+ `object_territories.json`, `F_*.json`, extra tabs) |
| `territory_access_audit.py` | JSON folder (needs `territories.json`; uses `models.json`, `user_territories.json`, `object_territory_counts.json` when present) | `.xlsx` with Summary, Territory Access, User Assignments |
| `territory_rule_operators.py` | JSON folder (needs `territories.json`, `rules.json`, `rule_items.json`, `rule_territories.json`) | `.xlsx` with Overview, Rule Criteria, Rules by Territory, Diff <label> |

JSON files use the exact shape of `sf data query --json`, so a file saved by hand with that
command also works.

Exit code: 0 on success, 1 with `ERROR:` on a user-fixable problem.

## Guardrails

- Read-only. Never add DML, deploys or `sf data update/delete` to this package.
- Do not hardcode org aliases, territory names or custom field names in the scripts. They are
  arguments (`--root-territory`, `--focus-field`, `--extra-query`).
- The workbook and JSON hold user names and usernames: keep them out of git (`.gitignore` covers
  `out/`, `*.xlsx`). The JSON folder under `examples/` is synthetic; never replace it with real data.
- The access audit's "Should be" values are a proposal (branch majority). Say so when you share
  it; do not present them as decisions.

## Verify success

- Index: every query `OK`; Hierarchy row count equals `2_Territories` rows.
- With `--root-territory`, the first Hierarchy row is that territory at level 0.
- Reports print one summary line each; open the Summary/Overview tab to check counts.
- Run `python tests/run_tests.py` after any code change (offline, 17 tests).

## Known pitfalls

- `--root-territory` by Name fails when the name is used twice. Use the DeveloperName.
- "N active territory models found": no Active model (or the org has none). Pass `--model`.
- `TRUNCATED`: the CLI stopped at `org-max-query-limit`. Run
  `sf config set org-max-query-limit=200000` (or a value above the total) and export again.
- `7_ObjectCounts` ERROR mentioning aggregate / queryMore: more than 2,000 territory-object
  groups. Narrow with `--root-territory` or use `--object-detail`.
- `FIELDS(ALL)` (field checks) needs `LIMIT 200` or less; the script uses `LIMIT 1`.
- Rule items have no model field, so the script fetches all items and keeps those of the
  model's rules.
- Formulas in the report workbooks calculate when opened in Excel; openpyxl does not compute them.
