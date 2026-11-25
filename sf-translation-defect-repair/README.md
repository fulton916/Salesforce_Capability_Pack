# sf-translation-defect-repair

Finds and repairs Salesforce translation data defects that a deploy does not report:
mojibake, keys that are slightly off, lost carriage returns, references the target org
cannot resolve, and retrieves that silently miss values.

## Why

A deploy only reports what it rejects. Several defects pass straight through:

| Defect | What the deploy says | Where it shows |
|---|---|---|
| Mojibake in a KEY (`CafÃ©`) | "Invalid picklist value" - looks like a deleted value | error log, misdiagnosed |
| Mojibake in a VALUE | nothing - it succeeds | live in the org UI |
| Mojibake in a global value set value | nothing | live; not in .stf exports at all |
| Key differs by whitespace (`Extra Large ` in the org) | "Invalid picklist value" | error log, misdiagnosed |
| CR inside a help text dropped by an XML round trip | nothing | the line break is gone |
| Deleted field / record type / rule / value in the payload | one error per component, capped | the whole object+language fails |
| Retrieve without the parent metadata | nothing | the retrieve looks empty or partial |

## Prerequisites

- Python 3.10 or later, `pip install -r requirements.txt` (openpyxl, used for .xlsx in/out).
- Salesforce CLI `sf` (v2) for `prevalidate_payload.py` against a live org, and to produce
  inputs. Everything else is offline.

## Inputs

| Input | How to get it |
|---|---|
| Org pull (translation CSVs) | Per-language CSVs of what the org holds now, one row per slot (format below). This is the only input that covers global value sets. |
| Load files | The translation CSVs that were sent for deploy. |
| .stf exports | Setup > Translation Workbench > Export. `Source` (all keys) and `Bilingual` (per language). |
| Retrieve | `sf project retrieve start --manifest package.xml --target-org <alias>`. Name the parents (CustomObject, Layout, GlobalValueSet, StandardValueSet, CustomLabel...) in the same manifest as the translations, or the retrieve comes back near empty. |
| Payload | The folder about to be deployed (holds `objectTranslations/`, `translations/`). |

### Translation CSV format

`translations_<lang>.csv`, one row per slot:

```
file,type,component,field,masterLabel,source,translation
globalValueSetTranslations/Flavor-de.globalValueSetTranslation-meta.xml,global-value,Flavor,,Crème,Crème,Crème
objectTranslations/Widget__c-de/Kind__c.fieldTranslation-meta.xml,field-picklist,Widget__c,Kind__c,Basic,Basic,Einfach
```

`type`: `field-label`, `field-picklist`, `standard-field`, `object-label`, `record-type`,
`validation-rule`, `layout-section`, `custom-label`, `global-value`, `standard-value`.
Extra columns are carried through.

## Install

Copy this folder, then:

```
pip install -r requirements.txt
python tests/run_tests.py
```

## Quick start

```
cd examples
python ../scripts/scan_mojibake.py --csv-dir pull --stf-dir stf --out scan.csv
python ../scripts/build_encoding_fix_payload.py pull --load-dir load --out-dir enc_fix
python ../scripts/build_rekey_payload.py failures.csv pull --out-dir rekey
python ../scripts/prevalidate_payload.py payload --snapshot org_snapshot
python ../scripts/crsafe.py check payload
```

## Scripts

### mojibake.py (library and quick check)

Generic detection and repair of UTF-8 text read as cp1252 or Latin-1. Works on any text.

- `repairable`: the bytes are intact (`CafÃ©`, `â€“`, `Ã\x81`). Re-encoding each run as
  cp1252 and decoding as UTF-8 gives the original. Repeated passes undo double encoding.
  Legitimate accented text around a run is left alone.
- `damaged`: something changed a byte after the damage (autocorrect turned a byte into a
  straight quote or a space, or lower-cased the lead `Ã` to `ã`). Repaired only when a clean
  reference text (the English source or the key) holds exactly one special character and
  the run sits between two words. Otherwise no repair is offered.
- A repair is returned only when the result is fully clean.

```
python scripts/mojibake.py "CafÃ©"
python scripts/mojibake.py --file labels.txt
```

`--euro-is-suspect` treats every euro sign as damage. Use it only on data that never holds
a real one (picklist labels, names).

### scan_mojibake.py

```
python scripts/scan_mojibake.py --csv-dir pull/ --stf-dir exports/ --xml-dir retrieve/ --out report.xlsx
```

Reports every finding with kind (`key` = row cannot deploy, `value` = damage is live,
`source` = English source damaged), status and the exact repair if one exists. Exit 2 if
anything was found. Warns when only .stf files are scanned, because global value sets are
not in them.

### build_encoding_fix_payload.py

```
python scripts/build_encoding_fix_payload.py pull/ --load-dir load/ --out-dir enc_fix/ [--casing-fix "BAD=GOOD"]
```

Overlays repaired translations on the org pull rows, so keys, types and target paths come
from the org. Covers damaged live values (including global value sets) and corrupted keys
in load files (the repaired key must exist in the pull; an echoed corrupted translation is
repaired too). Writes only rows whose text changes. Rows with no exact repair go to
`enc_fix_unrepairable.csv` and stay out of the payload. Conflicting repairs or an unclean
result stop the run.

### build_rekey_payload.py

```
python scripts/build_rekey_payload.py failures.csv pull/ --out-dir rekey/ [--component Sizes]
```

For rows rejected because the key differs from the org's only by whitespace (trailing,
doubled or non-breaking spaces). The key is taken from the org exactly; the translation is
carried byte for byte. Anything else (prefixes, punctuation, renames) is listed as needing
a decision. Input columns: `language, component, field, masterLabel, translation`; map
other names with `--col-*` and read an .xlsx with `--sheet`.

### crsafe.py (library and check)

Reading XML normalises CR and CRLF to LF, and ElementTree's writer emits CRLF on Windows.
Either loses a carriage return that is part of a value. `crsafe.parse()` keeps it and
refuses files whose CRs are not all inside values (CRLF line endings). `crsafe.write_xml()`
writes LF line endings with each content CR as `&#13;`.

```
python scripts/crsafe.py check payload/      # exit 1 if any file would be refused
```

### prevalidate_payload.py

```
python scripts/prevalidate_payload.py payload/ --target-org my-sandbox                 # report only
python scripts/prevalidate_payload.py payload/ --target-org my-sandbox --apply         # strip
python scripts/prevalidate_payload.py payload/ --target-org my-sandbox --save-snapshot snap/
python scripts/prevalidate_payload.py payload/ --snapshot snap/                        # offline
```

Checks objects, custom fields, picklist values, record types, validation rules and custom
labels against the target org in one pass, and removes what it cannot resolve. Report only
unless `--apply`. Rewrites use crsafe, so CRs survive. Source and metadata formats.

### compare_retrieve_stf.py

```
python scripts/compare_retrieve_stf.py retrieve/ --stf-dir exports/ [--langs de,fr] [--out report.json]
```

Compares every translated .stf key whose parent is in the retrieve: exact, same
(whitespace), CR only, MISSING, DIFFERENT, plus EXTRA values only the retrieve has. Keys it
cannot map are "not compared", never a pass. Exit 2 on any MISSING, DIFFERENT or CR only.

## Safety notes

- Nothing here deploys. The payload builders write CSVs; prevalidate edits XML only with `--apply`.
- prevalidate refuses `--apply` inside a `force-app` tree, stops if any org query fails, and
  stops if no object in the payload is found in the org (a wrong org or a broken login would
  otherwise strip everything).
- Payload builders refuse a non-empty output folder unless `--force`.
- Repairs are exact or not made. Guessed repairs look authoritative and are worse than a blank.
- Always dry-run (`sf project deploy validate`) before a deploy, and verify after it
  (a fresh .stf export or `compare_retrieve_stf.py`).

## Limitations

- Payloads are CSVs. Turning them into metadata XML needs a CSV-to-metadata tool, which is
  not part of this package.
- Mojibake handling covers UTF-8 read as cp1252/Latin-1, the common case. Other code page
  mix-ups (for example UTF-8 read as cp1251) are not detected.
- Detection can flag real text that puts a Latin-1 letter right before a symbol (`Â°`).
  Review findings before deploying a repair.
- crsafe protects `crsafe.parse(path)`; `ET.iterparse` and parsing from file objects are not
  covered.
- compare_retrieve_stf.py maps the common key types (fields, picklists, value sets, record
  types, validation rules, layout sections, buttons, custom labels, apps, tabs). Others are
  counted as not compared.

## License

Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify, or
distribute this software without written permission.
