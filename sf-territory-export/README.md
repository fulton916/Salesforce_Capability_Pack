# sf-territory-export

Export Enterprise Territory Management (ETM) data from a Salesforce org to Excel, one tab per
query. Two optional reports build on the same data: an access-level audit and a rule-operator
("contains vs equals") check.

Everything here is read-only. Nothing is written to the org.

## What it does

`scripts/territory_export.py` runs these queries through the Salesforce CLI:

| Tab | Object | What it shows |
|---|---|---|
| `1_Models` | Territory2Model | models and their state |
| `2_Territories` | Territory2 | territories, parent, type, access levels |
| `3_Rules` | ObjectTerritory2AssignmentRule | assignment rules and filter logic |
| `4_RuleItems` | ObjectTerritory2AssignmentRuleItem | criteria lines: field, operator, value |
| `5_RuleTerritories` | RuleTerritory2Association | which rule is on which territory (own or inherited) |
| `6_UserTerritories` | UserTerritory2Association | user assignments, role in territory |
| `7_ObjectCounts` | ObjectTerritory2Association | assigned records, counted per territory and object |
| `8_ObjectTerritories` | ObjectTerritory2Association | every assignment row (only with `--object-detail`) |
| `F_<Object>` | any | one record, `FIELDS(ALL)`, listed vertically (only with `--field-checks`) |

It also writes `Index` (row count, status and SOQL of every tab), `Run Info`, and `Hierarchy`
(territories depth-first with level, path, access levels, users, rules and assigned records).

By default it exports only the Active model. Filters are arguments:

- `--model` picks another model (Name, DeveloperName or Id); `--all-models` drops the filter.
- `--root-territory` limits every tab to one territory and everything below it.
- `--extra-query TAB=SOQL` adds your own tab (for example, the users of one business unit).

A failed query does not stop the run. Its tab and the Index say `ERROR` with the message.
A result cut short by the CLI's record limit says `TRUNCATED`.

### Optional reports

Both read a JSON folder saved with `--save-json`. They make no org call.

| Script | Output |
|---|---|
| `scripts/territory_access_audit.py` | One row per territory with Account / Opportunity / Case access. Three yellow "Should be" columns (dropdowns), pre-filled with the most common pattern in the territory's branch, and a Result formula (OK / CHECK) that recomputes when you edit them. A Summary tab lists automatic checks: territories that differ from their branch, parents that differ from all their children, records assigned directly to the start territory, repeated names, blank roles. `--compare LABEL=DIR` adds a column per other org. |
| `scripts/territory_rule_operators.py` | One row per rule criteria line, with the operator and an Equals / Contains / Other status. `--focus-field` names the fields where this matters (ID or code fields); for each rule it works out from the filter logic whether ANY focus line is enough or ALL must match. `--compare LABEL=DIR` adds a diff tab per other org. |

Why "contains vs equals" matters: a `contains R12` line also matches `R123` and `XR12`. For code
fields, `equals` is usually what was meant.

## Prerequisites

- Python 3.10+, `openpyxl` (`requirements.txt`)
- Salesforce CLI v2 (`sf`), logged in: `sf org login web --alias my-prod`
- The running user needs read access to the territory objects (for example "View Setup and
  Configuration" plus Territory Management access).

## Install

```
python -m pip install -r requirements.txt
```

## Quick start

```
python scripts/territory_export.py --target-org my-prod --save-json out/json --output out/territories.xlsx
python scripts/territory_access_audit.py --json-dir out/json --label my-prod --output out/access_audit.xlsx
python scripts/territory_rule_operators.py --json-dir out/json --focus-field Account.Sales_Code__c --output out/rule_operators.xlsx
```

Try it without an org, on the synthetic sample:

```
python scripts/territory_export.py --from-json examples/sample_json/org_a --output out/sample.xlsx
python scripts/territory_access_audit.py --json-dir examples/sample_json/org_a --compare other=examples/sample_json/org_b --output out/sample_audit.xlsx
```

## Usage

### territory_export.py

| Option | Meaning |
|---|---|
| `-o`, `--target-org` | sf alias or username. Default: the sf default org. |
| `--model` | Model Name, DeveloperName or Id. Default: the Active model. |
| `--all-models` | No model filter. |
| `--root-territory` | Name, DeveloperName or Id. Only this territory and below. |
| `--output` | Workbook path. Default `territory_export_<date>.xlsx`. |
| `--save-json DIR` | Also save each result as `DIR/<key>.json` (the shape `sf data query --json` prints). |
| `--from-json DIR` | Build from a saved folder. No org call. |
| `--field-checks` | Add `FIELDS(ALL) LIMIT 1` tabs for the territory objects, Account and User. |
| `--object-detail` | Add every ObjectTerritory2Association row. Can be very large. |
| `--extra-query TAB=SOQL` | Add your own query as a tab. Repeatable. |
| `--list-queries` | Print the queries and exit. |

To compare two orgs, export each with its own `--save-json` folder, then pass the second folder
to a report with `--compare <label>=<folder>`.

### territory_access_audit.py

`--json-dir` (required), `--root-territory`, `--model`, `--branch-level` (default 1: the children
of the start territory define the branches), `--label`, `--compare LABEL=DIR` (repeatable),
`--no-proposal`, `--output`.

### territory_rule_operators.py

`--json-dir` (required), `--root-territory`, `--model`, `--focus-field OBJECT.FIELD`
(repeatable; default: every field), `--label`, `--compare LABEL=DIR` (repeatable), `--output`.

## Tests

```
python tests/run_tests.py
```

The tests build two synthetic JSON folders (`tests/fixtures/build_fixtures.py`, the same data as
`examples/sample_json`) and mock `sf`.

## Safety notes

- Read-only. The scripts only run SELECT queries.
- The output holds user names and usernames. Treat the workbook and the JSON folder as org data;
  do not commit them.

## Limitations

- `sf data query` returns at most the CLI's `org-max-query-limit` (default 10,000) records. Raise
  it for large orgs: `sf config set org-max-query-limit=200000`. The Index flags a truncated tab.
- `7_ObjectCounts` is an aggregate query. Salesforce allows at most 2,000 groups; above that the
  query fails (marked `ERROR` in the Index). Use `--root-territory` to narrow it, or
  `--object-detail`.
- Excel holds about 1 million rows per sheet; larger tabs are cut and flagged.
- The access audit's proposal is a starting point (majority pattern per branch), not a rule.
- The filter-logic reading in the rule report assumes the non-focus lines match.

## License

Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify, or
distribute this software without written permission.
