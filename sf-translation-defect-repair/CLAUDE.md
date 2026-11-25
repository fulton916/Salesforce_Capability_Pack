<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

# CLAUDE.md - sf-translation-defect-repair

## What this is

Tools that detect and repair Salesforce translation data defects a deploy will not report:
mojibake in keys and values, keys that differ from the org's by whitespace only, carriage
returns lost in XML round trips, payload references the target org cannot resolve, and
retrieves that silently miss translations.

Only `prevalidate_payload.py` talks to an org (through `sf`, read-only queries). The rest is offline.

## When to use it

- Translated text shows `Ã©`, `â€“`, `Â ` or similar in the UI or an export.
- A deploy reports "Invalid picklist value" for a value that looks right (encoding or
  whitespace in the key).
- Before deploying a translation payload to an org other than the one it was built from.
- After any script parsed and rewrote translation XML (check CRs survived).
- Before trusting a retrieve as a read of translation state.

## Workflow

1. Scan for mojibake. Include the org pull: global value sets are NOT in .stf exports.
   ```
   python scripts/scan_mojibake.py --csv-dir <org_pull> --stf-dir <exports> --out mojibake.xlsx
   ```
   Exit 2 = findings. Show the user the counts by kind (key / value / source).
2. Build the encoding fix payload (CSVs only):
   ```
   python scripts/build_encoding_fix_payload.py <org_pull> --load-dir <load_csvs> --out-dir <new_dir>
   ```
   Report the "NOT REPAIRED" list to the user. Those go back to a person; do not invent text.
3. Re-key whitespace-only mismatches (from a list of failed rows):
   ```
   python scripts/build_rekey_payload.py <failures.csv|xlsx> <org_pull> --out-dir <new_dir>
   ```
4. Convert payload CSVs to metadata with your CSV-to-metadata tool (outside this package).
   Then check carriage returns: `python scripts/crsafe.py check <payload>`.
5. Prevalidate against the target org. Confirm the alias with the user first; never guess it.
   ```
   python scripts/prevalidate_payload.py <payload> --target-org <alias>            # report
   python scripts/prevalidate_payload.py <payload> --target-org <alias> --apply    # only after the user agrees
   ```
6. Dry-run: `sf project deploy validate --source-dir <payload> --target-org <alias> --json > validate.json`.
   Deploy only with the user's explicit go-ahead.
7. Verify: retrieve the touched components WITH their parents in one manifest, then
   ```
   python scripts/compare_retrieve_stf.py <retrieve_dir> --stf-dir <fresh_exports>
   ```
   or take a fresh Bilingual export and re-run step 1. The repaired rows must be clean.

## Inputs and outputs

| Script | Inputs | Output | Exit |
|---|---|---|---|
| mojibake.py | text or `--file` | verdict and repair per line | 0 clean / 1 found |
| scan_mojibake.py | `--csv-dir`, `--stf-dir`, `--xml-dir` (any mix) | report .csv or .xlsx | 0 clean / 2 found |
| build_encoding_fix_payload.py | org pull CSVs, `--load-dir` CSVs | payload CSVs + `<out>_unrepairable.csv` | 0 / error on clash or unclean |
| build_rekey_payload.py | failed rows (.csv/.xlsx), org pull CSVs | payload CSVs | 0 |
| crsafe.py | `check <paths>`; or import `parse`, `write_xml` | report | 0 / 1 refused files |
| prevalidate_payload.py | payload dir, `--target-org` or `--snapshot` | report; edits only with `--apply`; optional `--report` JSON, `--save-snapshot` | 0 / error |
| compare_retrieve_stf.py | retrieve dir(s), `--stf-dir` | table; optional `--out` JSON | 0 / 2 gaps |

## Guardrails

- Never deploy anything without a dry run and the user's explicit confirmation.
- Never run `prevalidate_payload.py --apply` on `force-app` or any source of truth. It refuses
  inside `force-app`; do not work around that by copying force-app elsewhere and applying.
- Never apply a guessed encoding repair. If the tools say "no exact repair", the text goes
  back to a person. Do not hand-edit a plausible fix into the payload.
- Never use `--euro-is-suspect` on text that may hold real prices or currency.
- Never parse and rewrite translation XML with plain ElementTree. Use `crsafe.parse` and
  `crsafe.write_xml`, or CRs inside values are lost with no error.
- Do not re-key anything that differs by more than whitespace. That is a reviewer's decision.
- Do not treat a scan of .stf files alone as complete. Global value sets are not in them.
- Do not trust a retrieve until `compare_retrieve_stf.py` passes against a known export.

## How to verify success

- `python tests/run_tests.py` passes (offline, no org).
- Encoding: re-scan a fresh org pull and a fresh Bilingual export. Repaired slots show no findings.
- Re-key: the next deploy has no "Invalid picklist value" for those keys.
- CRs: `crsafe.py check` shows the expected "keeps N CR(s)" lines and no REFUSED files;
  `compare_retrieve_stf.py` shows no "CR only" rows.
- Prevalidate: a second report-only run after `--apply` prints "nothing".

## Known pitfalls

- A retrieved `CustomObjectTranslation` with only caseValues does not mean the object has no
  translations. Name the CustomObject (and Layouts) in the same retrieve.
- The .stf format escapes tab, newline and CR as `\t`, `\n`, `\r`. `stf.py` decodes them.
- A value echoed back by a translator carries the same corruption as the English it copied.
  It is the export's defect, not the translator's; the payload builder repairs it against
  the repaired key.
- Autocorrect can damage mojibake further (a straight quote or a space replacing a byte).
  Those runs only repair with a clean reference that holds exactly one special character.
- A proper noun can come back re-cased by the same autocorrect (`CrèME`). Pass
  `--casing-fix BAD=GOOD`; each use is printed.
- On Windows, files written in text mode get CRLF line endings. crsafe refuses them, by design.
- A Task or Event field translation is stored under Activity in some orgs; look there when
  verifying.
