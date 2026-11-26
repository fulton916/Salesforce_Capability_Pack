<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

# CLAUDE.md — sf-country-state-codes

## What this is

A read-only exporter. It retrieves a Salesforce org's Address settings (`Settings:Address`) and
writes the State and Country/Territory picklists to Excel: ISO codes, integration values,
active / visible flags, Salesforce-standard flag and the org default country.

## When to use it

- Someone asks for "the country and state codes", "the country picklist", "integration values for
  states", or a mapping of ISO codes for an org.
- Before an address data load or integration mapping, to see which codes are active and visible.

Do not use it to change the picklists. It has no deploy path, and none should be added here.

## Workflow

1. Confirm the org alias with the user. Do not guess. If they say "the default org", omit
   `--target-org`.
2. Check the CLI login: `sf org display --target-org <alias> --json` (status 0 means logged in).
3. Run:
   ```
   python scripts/export_country_state_codes.py --target-org <alias> --output <file>.xlsx
   ```
4. Report the summary line it prints (countries, active countries, states, active states) and the
   output path.

Offline variant (an XML is already on disk):
```
python scripts/export_country_state_codes.py --skip-retrieve --xml-path <path>/Address.settings-meta.xml --output <file>.xlsx
```

CSV variant, no Python (XML must already be retrieved):
```
pwsh scripts/convert_address_to_csv.ps1 -XmlPath <xml> -OutFile <file>.csv   # or: powershell -File ...
```
The CSV is UTF-8 with a BOM in both Windows PowerShell 5.1 and PowerShell 7.

## Inputs and outputs

| Script | Input | Output |
|---|---|---|
| `scripts/export_country_state_codes.py` | org alias (or sf default), or an `Address.settings-meta.xml` | one `.xlsx`, sheet `Country_State_Codes`, table `CountryStateCodes`; summary on stdout; exit 1 with `ERROR:` on failure |
| `scripts/convert_address_to_csv.ps1` | an `Address.settings-meta.xml` | one UTF-8 `.csv` with the same columns |

Columns: Country, Country Code, Country Integration Value, Country Active, Country Visible,
Country Salesforce Standard, Country Org Default, State, State Code, State Integration Value,
State Active, State Visible, State Salesforce Standard. One row per state; a country with no
states gets one row with blank state columns.

## Guardrails

- Never deploy Address settings from this package.
- Prefer the default temporary project. Only pass `--project-dir` when the user wants the XML in
  their project, and tell them it overwrites the local `Address.settings-meta.xml`.
- Never commit the generated workbook or retrieved XML (`.gitignore` covers `*.xlsx` and `.sf/`).
- Do not hardcode an org alias in the script.

## Verify success

- Exit code 0 and a `Created: <path>` line.
- The printed country count is plausible (an org with picklists enabled usually has about 240
  countries).
- Spot-check one known country in the workbook (for example `US`, its states, and the default
  flag).

## Tests

```
python tests/run_tests.py
```
Offline. Uses `tests/fixtures/Address.settings-meta.xml` (synthetic) and mocks `sf`.

## Known pitfalls

- "No countriesAndStates section": State and Country/Territory picklists are not enabled in that
  org, or the retrieve returned an empty settings file.
- "sfdx-project.json not found": `--project-dir` points at a folder that is not a DX project. Drop
  the option.
- `PermissionError` on save: the workbook is open in Excel.
- The retrieve needs a user with "View Setup and Configuration" (or Modify Metadata) access.
