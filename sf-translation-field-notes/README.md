# sf-translation-field-notes

Field notes on Salesforce translations: Translation Workbench, `.stf` exports, and the metadata
types `CustomObjectTranslation`, `Translations`, `GlobalValueSetTranslation` and
`StandardValueSetTranslation`. They record what Salesforce actually did when translations were
read, deployed, overwritten and reverted, so the next team (or the next AI assistant) does not
repeat the same mistakes.

This package is documentation only. There are no scripts to install.

## Who it is for

- Admins and developers who load translations with the Metadata API or the `sf` CLI.
- An AI coding assistant working on translations. Point it at [CLAUDE.md](CLAUDE.md).

## The ten things most worth knowing

1. **Most pushed translations cannot be removed by any deploy.** Only layout section labels,
   record type labels and validation rule messages clear when sent blank. Everything else can only
   be replaced, at best with the English text. See [docs/03](docs/03-rollback-and-revert.md).
2. **A retrieve of translations is blind unless the parents are in the same manifest.** Name the
   object and its layouts, the value set, or the custom labels alongside the translation type.
   See [docs/01](docs/01-reading-translation-state.md).
3. **The Bilingual `.stf` export is the most reliable read of translated content.** It does not
   carry object-name grammar or renamed standard fields.
4. **`CustomObjectTranslation` deploys all-or-nothing per object and language.** `SucceededPartial`
   means lost translations with no error against them. See [docs/02](docs/02-deploy-behaviour.md).
5. **A successful deploy does not mean anything was stored.** Salesforce silently discards grammar
   without name forms and headings it owns. Read back after every deploy.
6. **Every block you send re-asserts all its children.** Build payloads from a fresh retrieve and
   change only the target leaves.
7. **Some layout section headings belong to Salesforce.** Check `<customLabel>` in the layout, or
   render the layout in a probe language. See [docs/06](docs/06-layout-section-ownership.md).
8. **Grammar travels with object-name forms, and gender is validated per language.** See
   [docs/07](docs/07-grammar-and-object-names.md).
9. **Carriage returns, trailing spaces and encoding damage change what is stored** and most
   comparison tools cannot see them. See [docs/08](docs/08-text-fidelity.md).
10. **The Translation Workbench REST export job works; the file download does not; import is
    untested; and the published docs have two errors.** See
    [docs/05](docs/05-translation-workbench-api.md).

## Contents

| File | Covers |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Instructions for an AI assistant: which file to read when, and the rules never to break |
| [docs/01-reading-translation-state.md](docs/01-reading-translation-state.md) | Bilingual export vs retrieve, parents in the manifest, `.stf` key shapes, what each read misses |
| [docs/02-deploy-behaviour.md](docs/02-deploy-behaviour.md) | All-or-nothing components, partial success, error triage, payload shape, overwrite checks, verification after deploy |
| [docs/03-rollback-and-revert.md](docs/03-rollback-and-revert.md) | What can and cannot be reverted, and a safe sandbox method to test it |
| [docs/04-restoring-overwritten-values.md](docs/04-restoring-overwritten-values.md) | How accidental overwrites happen, snapshots, deciding and building a restore |
| [docs/05-translation-workbench-api.md](docs/05-translation-workbench-api.md) | Connect REST API export/import, the doc errors, the blocked download |
| [docs/06-layout-section-ownership.md](docs/06-layout-section-ownership.md) | Telling Salesforce-owned headings from yours: `customLabel`, probe language, deploy probe |
| [docs/07-grammar-and-object-names.md](docs/07-grammar-and-object-names.md) | Gender, startsWith, article, possessive, object names, renamed standard fields, language codes |
| [docs/08-text-fidelity.md](docs/08-text-fidelity.md) | Carriage returns, leading/trailing spaces, mojibake, BOMs |
| [docs/09-metadata-type-quirks.md](docs/09-metadata-type-quirks.md) | Global value sets, Task/Event/Activity, Knowledge, quick actions, tabs, custom labels, flows, managed packages |
| [docs/10-working-habits.md](docs/10-working-habits.md) | General habits: negative controls, provenance, handling supplied translations |

## Prerequisites for the commands shown

- Salesforce CLI v2 (`sf`), authenticated to a **sandbox**. Examples use `--target-org my-sandbox`.
- For the REST examples, `sf api request rest` (part of the CLI).
- Python 3.10+ only if you write your own comparison scripts; none is shipped here.

## How much to trust each note

The notes come from hands-on work in sandboxes and production orgs across several recent API
versions. Check anything you rely on against your org's API version. The wording says how strong
the evidence is:

- **Tested** or a plain statement: reproduced, usually with a control, often more than once.
- **Observed once**: seen in one deploy or one probe. Plausible, not proven general.
- **Untested**: not exercised against an org. Do not rely on it.
- **Sources disagree**: two observations conflict. Verify in your own sandbox.

Salesforce changes behaviour between releases. Before you rely on a note for a production change,
reproduce the relevant part in a sandbox with a read-back.

## Safety notes

- Run probes, sentinels and revert tests only in a sandbox, in a language nobody reads.
- Treat any production translation push as permanent.
- Keep a person between every dry run and every real deploy.

## Limitations

- Org settings, editions and installed packages may change some results.
- Untested: Translation Workbench import (UI or API), clearing values by hand in the Translation
  Workbench UI, the XLIFF format, multi-language API export jobs.
- Not covered: how to choose translation scope, translator workflow, and spreadsheet tooling.

## Example names

Examples use generic names: `Widget__c`, `Color__c`, `Color_Set`, `Account`, and the org alias
`my-sandbox`. Replace them with your own.

## License

Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify, or
distribute this software without written permission.
