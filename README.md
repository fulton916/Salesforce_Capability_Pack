# salesforce-capabilities

Standalone Salesforce admin and translation tools. Each folder is a self-contained package: copy only the one you need. No package imports from another.

Every package has:
- `README.md` for people: what it does, prerequisites, usage, safety notes.
- `CLAUDE.md` for an AI coding assistant: when to use the package, the exact workflow, guardrails and how to verify.
- `scripts/` and offline `tests/` (`python tests/run_tests.py`), plus synthetic examples where useful.

The script packages use the Salesforce CLI (`sf` v2) and Python 3.10+. Most also need `openpyxl`.
`sf-psg-compare` is a browser extension instead: no CLI or Python needed to use it (Node runs its offline tests).

## Translation packages

| Package | What it does |
|---|---|
| [sf-translation-toolkit](sf-translation-toolkit/) | Scopes the fields a set of permission set groups can read. Builds a translator workbook pre-filled from the org, then converts the filled workbook into a deploy payload holding only translated rows and verifies the load against a Bilingual `.stf` export. |
| [sf-safe-translation-push](sf-safe-translation-push/) | Pushes translations into production without overwriting anything already there. A no-overwrite builder, negative controls, a check against the `.stf` export, a "target hasn't moved" gate and after-deploy verification all have to pass. Includes the before/after snapshot procedure. |
| [sf-translation-deploy-triage](sf-translation-deploy-triage/) | Turns deploy/validate results into Excel reports: what failed, why, and who must act. Builds fill-in files for gender and "starts with" grammar, applies the answers back, and scopes the redeploy to only the components that failed. |
| [sf-translation-defect-repair](sf-translation-defect-repair/) | Finds and repairs defects a deploy won't report: mojibake, keys with stray whitespace, lost carriage returns, references the target can't resolve, and retrieves that silently miss values. |
| [sf-translation-reconcile](sf-translation-reconcile/) | Keeps a translation workbook in line with what is live in an org, builds a pull-down of every live value, and applies targeted corrections with an offline proof and a record of where each replaced value came from. |
| [sf-translation-field-notes](sf-translation-field-notes/) | Documentation only. Lessons on Salesforce translation behaviour: reading state, deploy quirks, what can and can't be rolled back, grammar rules, text fidelity and Translation Workbench API limits. |

The translation packages work independently but fit one flow:

```
toolkit (scope + workbook) → defect-repair / triage (fix what fails) → safe-push (production) → reconcile (keep the workbook true)
```

field-notes explains the Salesforce behaviour behind all of them.

## Org administration packages

| Package | What it does |
|---|---|
| [sf-country-state-codes](sf-country-state-codes/) | Exports the org's State and Country/Territory picklists (ISO codes, integration values, active/visible flags) to a formatted Excel mapping. |
| [sf-territory-export](sf-territory-export/) | Read-only Enterprise Territory Management export to Excel, one tab per query. Optional access-level audit and a "contains vs equals" rule-operator check, with org-to-org compare. |
| [sf-psg-compare](sf-psg-compare/) | Chrome extension. Compares two permission set groups side by side: contents, muting, system permissions, object and field access, Apex/pages/apps/custom permissions and tabs, with a plain-language summary and CSV export. Uses your browser login; read-only. Snapshots allow sandbox-vs-production compares. |
| [sf-user-access-teardown](sf-user-access-teardown/) | For a list of user IDs, queries and (only with `--execute` plus a confirmation) bulk-removes permission set groups, permission sets, licences, territories, groups, queues and role. Query-only by default; keeps CSV results. |

## Safety

These tools can change production metadata and user access. Every package that writes defaults to read-only or dry run, and says in its README which step writes to the org. Rehearse in a sandbox first. None of the code has been run against your org; check the "not tested" notes in each README.

## Third-party dependency

`sf-translation-toolkit` uses the community Sunny Day CLI plugin (`sf sday psg2csv`) to list field permissions per permission set group. See that package's README for installation.
