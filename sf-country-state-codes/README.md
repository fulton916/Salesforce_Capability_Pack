# sf-country-state-codes

Export a Salesforce org's State and Country/Territory picklists to an Excel workbook.

## What it does

When State and Country/Territory picklists are enabled, the list of countries and states lives in
the org's Address settings (`Settings:Address` metadata). Integrations, data loads and
address-cleanup work often need that list: the ISO code, the integration value, and whether each
entry is active and visible.

`scripts/export_country_state_codes.py`:

1. retrieves `Settings:Address` with the Salesforce CLI (read-only);
2. parses `Address.settings-meta.xml`;
3. writes one row per state, or one row per country that has no states, to a formatted workbook
   (header styling, frozen header, filter, Excel table).

| Column group | Columns |
|---|---|
| Country | Country, Country Code, Country Integration Value, Country Active, Country Visible, Country Salesforce Standard, Country Org Default |
| State | State, State Code, State Integration Value, State Active, State Visible, State Salesforce Standard |

Rows are sorted by country, then state.

## Prerequisites

- Python 3.10+
- `openpyxl` (`requirements.txt`)
- Salesforce CLI v2 (`sf`), logged in to the org: `sf org login web --alias my-sandbox`
- State and Country/Territory picklists enabled in the org (otherwise the XML has no
  `countriesAndStates` section and the script says so)

## Install

```
python -m pip install -r requirements.txt
```

## Quick start

```
python scripts/export_country_state_codes.py --target-org my-sandbox
```

This writes `Country_State_Codes.xlsx` in the current folder.

## Usage

```
python scripts/export_country_state_codes.py [--target-org ALIAS] [--output FILE]
                                             [--project-dir DIR] [--xml-path FILE]
                                             [--skip-retrieve] [--api-version N]
```

| Option | Meaning |
|---|---|
| `-o`, `--target-org` | sf alias or username. If omitted, the sf default target org is used. |
| `--output` | Workbook path. Default `Country_State_Codes.xlsx`. |
| `--project-dir` | Retrieve into this existing DX project (needs `sfdx-project.json`). This **overwrites** the project's local `Address.settings-meta.xml`. If omitted, a temporary project is created and deleted afterwards. |
| `--xml-path` | Read this XML instead of searching for it. |
| `--skip-retrieve` | Do not call Salesforce. Use with `--xml-path` (or `--project-dir`). |
| `--api-version` | Passed to the retrieve, for example `62.0`. |

Examples:

```
# sf default org, default output
python scripts/export_country_state_codes.py

# an XML you already have; no org call
python scripts/export_country_state_codes.py --skip-retrieve --xml-path path/to/Address.settings-meta.xml --output codes.xlsx
```

### Optional: CSV without Python

`scripts/convert_address_to_csv.ps1` converts an already-retrieved XML to CSV with the same
columns. It does not call Salesforce.

```
sf project retrieve start --metadata Settings:Address --target-org my-sandbox
pwsh scripts/convert_address_to_csv.ps1 -XmlPath force-app/main/default/settings/Address.settings-meta.xml -OutFile codes.csv
```

## Tests

```
python tests/run_tests.py
```

The tests parse a small synthetic `tests/fixtures/Address.settings-meta.xml` and mock the CLI.
No org is called.

## Safety notes

- The script only retrieves. It never deploys.
- With `--project-dir`, the retrieve replaces the local Address settings file in that project.
  Leave the option out to keep your project untouched.

## Limitations

- Flags come out as the strings `true` / `false`, as stored in the metadata.
- A missing element (for example `orgDefault` on most countries in some orgs) is written as blank.
- Translated country and state names are not included; they live in the translation metadata,
  not in Address settings.
