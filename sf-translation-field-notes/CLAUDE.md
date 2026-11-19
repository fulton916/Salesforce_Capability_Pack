# CLAUDE.md: Salesforce translation field notes

You are helping someone read, load, fix or revert Salesforce translations. This package is
documentation only. It holds lessons from real work, most of them learned by causing or nearly
causing damage. Read the relevant topic file before you act, and follow the rules below.

## When to read which file

| The task involves... | Read first |
|---|---|
| Finding out what translations an org holds; verifying a deploy; comparing orgs | `docs/01-reading-translation-state.md` |
| Building or deploying a translation payload; a deploy error; `SucceededPartial` | `docs/02-deploy-behaviour.md` |
| "Can we undo this?", rollback plans, removing a translation | `docs/03-rollback-and-revert.md` |
| Values that were overwritten or changed unexpectedly | `docs/04-restoring-overwritten-values.md` (and 03) |
| Automating `.stf` exports or imports; the Connect REST API | `docs/05-translation-workbench-api.md` |
| Layout section headings; deciding what to send translators | `docs/06-layout-section-ownership.md` |
| Object names, gender, startsWith, article, possessive; renamed standard fields; language codes | `docs/07-grammar-and-object-names.md` |
| Line breaks, spaces, accented or garbled characters, BOMs, JSON that will not parse | `docs/08-text-fidelity.md` |
| Global value sets, Task/Event, Knowledge, quick actions, tabs, custom labels, flows, managed packages | `docs/09-metadata-type-quirks.md` |
| Designing checks, handling a translation file someone supplied | `docs/10-working-habits.md` |

If a task touches several areas, read each file. They are short.

## Rules you must never break

1. **Never deploy to any org without the user's explicit go-ahead for that deploy.** If it is not
   clear whether you were asked to run a deploy or to hand over the command, ask. Treat a production
   org as read-only unless the user says otherwise for that specific push.
2. **Always dry-run first** (`--dry-run`), show the result, and stop. The real deploy is a separate
   command after the user confirms.
3. **Never deploy a payload you did not build from a fresh read of the target.** Retrieve with
   parents, copy every leaf as retrieved, change only the target leaves. Never build from a
   spreadsheet's "existing value" columns or from the local project tree.
4. **Never emit empty elements** (`<label/>`, `<translation></translation>`, empty `<errorMessage>`).
   For some types they clear the org value; for the others they do nothing while looking like they
   worked. Skip untranslated cells.
5. **Never overwrite a non-empty slot unless the user named it.** Default to "fill empty slots
   only". For each approved overwrite, record the expected current value and refuse if the org no
   longer holds it.
6. **Never tell the user a push can be rolled back.** For most types it cannot (03). Say what can be
   replaced, what can only be set to English text, and what needs manual clearing (untested).
7. **Never trust a deploy report as proof of what is stored.** Verify with a retrieve that names the
   parents, compare raw text, and diff a Bilingual export taken after the deploy against one taken
   before.
8. **Never trust a negative from a read you have not checked against a known-good value.** A retrieve
   without parents returns empty shells for content that exists.
9. **Never use `--ignore-errors`, and never accept `SucceededPartial` as done.** A partial
   `CustomObjectTranslation` failure loses every translation in that object/language.
10. **Never deploy `--metadata CustomObjectTranslation` (or any broad type) against a whole project.**
    Deploy a scoped folder that contains only what this run changes.
11. **Never run probes, sentinels or revert tests outside a sandbox.** Use a language nobody reads,
    and confirm every sentinel slot is empty from a fresh retrieve first.
12. **Never silently "fix" translations someone supplied** (trim, re-align, drop, re-encode). Report
    defects separately. Apply a cleanup rule only when the owner asks for it.
13. **Never send grammar (`gender`, `startsWith`) without the object-name `caseValues`** for that
    object and language. Salesforce discards it with no error.
14. **Never include `en_US` in a translation payload by accident.** Only send it for a deliberate
    English label fix.

## Standard workflow for a push

Use this order. Each step is described in `docs/02-deploy-behaviour.md`.

1. Confirm scope with the user: which org, which languages, fill-only or named overwrites.
2. **Read**: retrieve the target with parents into a fresh folder (`--target-metadata-dir`).
3. **Snapshot**: copy that read to a dated snapshot folder; check file count and bytes.
4. **Build** from the read. Run the offline proof (every leaf is a fill into an empty slot, equal to
   the read, or a named overwrite at its expected old value). Run a negative control.
5. **Independent read**: check every slot against the target's own Bilingual export taken after
   step 2. A key you cannot find is UNVERIFIED, which is a failure.
6. **Dry run** with `--json`. Stop. Show the user the result.
7. **Re-read** just before the deploy; require raw-text identity with step 2. Check no
   `DeployRequest` since step 2. If anything moved, go back to step 2.
8. **Deploy** only on the user's go-ahead.
9. **Verify**: retrieve again; every target holds its value; no other leaf changed in any file; raw
   text compared. Ask the user for a fresh Bilingual export and diff it against the earlier one.
10. **Record** the deploy ID, counts, time, scope and anything surprising.

Commands (replace the alias and paths):

```bash
sf project retrieve start --manifest manifest/read.xml --target-metadata-dir read/before \
  --unzip --target-org my-sandbox --json > read/before.json
sf project deploy start --metadata-dir payload --dry-run --test-level NoTestRun \
  --target-org my-sandbox --json > dryrun.json
sf project deploy report --job-id <id> --target-org my-sandbox --json
sf data query --use-tooling-api --target-org my-sandbox \
  --query "SELECT Id, Status, CheckOnly, CreatedBy.Name, CreatedDate FROM DeployRequest ORDER BY CreatedDate DESC LIMIT 20"
```

## Quick facts to keep in mind

Reading:
- `CustomObjectTranslation` retrieved alone returns only object-name forms and renamed standard
  fields. Add `CustomObject` + all its `Layout`s. Value sets need `GlobalValueSet` /
  `StandardValueSet`. `Translations` needs `CustomLabel`, `CustomApplication`, `CustomTab`,
  `QuickAction`, `ReportType`, `Flow`.
- Name every language explicitly in a `Translations` retrieve; listMetadata can omit some.
- The Bilingual export omits object-name grammar, renamed standard fields and Lightning page tabs.
  It drops the TRANSLATED section entirely for a language with no translations.
- Export file names are stamped in the org's time zone.
- Task/Event field translations live under `Activity`. `Knowledge__kav` appears as `Knowledge__c`.

Deploying:
- Reverts by blank: only layout section labels, record type labels, validation rule messages.
- Omission never deletes. Delete-and-redeploy of value-set translations reported success and
  removed nothing.
- A translation equal to the English text is stored as a real translation.
- Dutch is `nl_NL`. The language code is validated; enablement is not.
- Namespaced (managed-package) object translations cannot be deployed.
- A GVS-backed picklist's values go in `GlobalValueSetTranslation`, keyed by label. The error
  "Invalid picklist value" in an object file usually means this.
- Salesforce caps the errors it lists per component. Pre-validate against a describe.
- `ClientTimeoutError` does not mean failure; use `sf project deploy report`.

Text:
- Write payloads LF-only; write a content CR as `&#13;`.
- Trailing spaces on picklist value translations were trimmed; value-set behaviour is uncertain.
  Check raw text.
- Detect mojibake by a stray `€` (U+20AC). Corrupted keys fail; corrupted values go live silently.
- PowerShell 5.1 redirects add a BOM: read `sf --json` output with `utf-8-sig`.
- On Windows, `&` in a URL passed to `sf` is split by `cmd.exe`.

Ownership and grammar:
- `<customLabel>false</customLabel>` on a layout section means Salesforce owns the heading; deploys
  to it are discarded.
- Gender values: `Feminine`, `Masculine`, `Neuter`, `AnimateMasculine`. `da`, `sv`, `nl_NL` reject
  `Masculine`. Standard objects accept only the language pack's gender.
- Built-in object names are not stored and no API returns their case forms.

API:
- Connect REST export job: works. Download: blocked (404 to OAuth). Import: untested.
- No `exportType` field; `contentFilter` is `SourceAndTranslations` or `Source` only; `format` sits
  at the top level of the body.

## How to talk about evidence

Each note says how strong its evidence is. Carry that into what you tell the user:

- Say "observed once" or "untested" when the note does.
- Where the docs say the sources disagree, say so and suggest a sandbox check.
- Do not upgrade a dry-run result to "stored". Only a read-back after a real deploy shows storage.

## When you find something new

If a sandbox test shows behaviour that contradicts these notes, tell the user, say what you ran and
what you saw, and suggest updating the relevant topic file with the evidence level stated.
