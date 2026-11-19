# Deploy behaviour, payload shape and verification

What happens when you deploy translation metadata, how to shape a payload so it changes only
what you intend, and how to prove afterwards that it did.

## How Salesforce treats a translation deploy

- **`CustomObjectTranslation` deploys all-or-nothing per component** (one object + one language).
  One missing field, renamed record type or invalid picklist value fails the whole component.
  Every good translation in it is lost, and no error names that good content.
- **`SucceededPartial` is a failed run.** A minority of failed components can carry most of the
  translated elements, since one bad reference discards a whole object/language file. If the
  error log is filed and the run treated as complete, the loss can go unnoticed for a long time. Gate on `status == Succeeded` and zero component failures, and report how many elements
  the failed components carried.
- **A failed deploy lands nothing** (`rollbackOnError` defaults to true; checked against an org).
- **Never reach for `--ignore-errors`.** It drops the whole component for each bad reference.
  On one payload it would have silently discarded thousands of translated elements.
- **Salesforce caps the errors it lists per component** and adds "There are N invalid picklist
  values". So dry-run, strip, dry-run converges slowly, and the error count is not a defect count.
  Values it names are not proven bad either. Pre-validate the payload against a live describe
  first; reduce errors to distinct (field, value) pairs before you report scope.
- **A successful dry run does not mean the content is stored.** Salesforce accepts and then
  discards: grammar sent without object-name forms ([07](07-grammar-and-object-names.md)),
  headings it owns ([06](06-layout-section-ownership.md)), and (observed once) a translation for a
  standard value whose label had been changed in the org. Read back after every real deploy.
- **A clean deploy does not validate wording.** A file with a whole language column shifted by
  one row deployed with zero errors. So did text in the wrong language. Every string was a valid
  label as far as Salesforce was concerned.
- **The language code is validated, not whether the language is enabled.** `nl` fails with "You
  cannot translate into nl" (Dutch is `nl_NL`). In a dry-run probe, codes for languages that were
  not enabled in the org were accepted with real content. So a translation can land in a language no user can select. Enabling the
  language is a separate admin step.
- **Translations of namespaced (managed-package) objects cannot be deployed**: "Deploying
  CustomObjectTranslation with namespaced language is not allowed". A namespaced object name has
  two `__` separators (`pkg__Thing__c`); a plain custom object has one. Labels of managed-package
  *fields* on your own or standard objects did deploy (observed once).
- **`ClientTimeoutError` is not a failure.** The CLI stopped watching after about half an hour
  while the deploy carried on. One "failed" dry run had in fact succeeded. Recover with
  `sf project deploy report --job-id <id> --target-org my-sandbox --json`.
- **Deploys run one at a time per org.** Check the queue and see who is deploying:

  ```bash
  sf data query --use-tooling-api --target-org my-sandbox \
    --query "SELECT Id, Status, CheckOnly, CreatedBy.Name, CreatedDate FROM DeployRequest ORDER BY CreatedDate DESC LIMIT 20"
  ```

- **Stored state can block a deploy.** Deploying a `CustomObjectTranslation` also validated the
  object's *stored* translations. Objects whose stored translations referenced removed fields or
  values failed any deploy, even a minimal file, until the stored state was cleared (edit and save
  in Setup, or deploy a corrected full translation). Seen on several objects; the mechanism was
  not fully established.

## Triage "invalid value" and "not found" errors

1. **Is the picklist field backed by a global value set?** (`<valueSetName>` in the field
   metadata.) Then its values cannot be translated in `CustomObjectTranslation`; every value fails
   with "Invalid picklist value", which reads as if the value were deleted. Put them in
   `GlobalValueSetTranslation`. Using the API names instead of labels fails just as hard; the key
   is not the problem.
2. **Is the key in the Source export?** If yes, the target exists and the key text is wrong:
   encoding damage, a missing number prefix, a changed developer name, a trailing space in the org
   label. If no, the target is really gone.
3. **Was it renamed rather than deleted?** Picklist labels gained number prefixes
   (`Widget Type A` became `1 - Widget Type A`); record types are keyed by DeveloperName, which
   can be changed; changing a field's type can mean a new API name with the same label
   (`Color__c` replaced by `Colour__c`). Compare labels before you call a field deleted,
   and re-point the translations.
4. **Is it a Task or Event field?** It lives under `Activity` (see [09](09-metadata-type-quirks.md)).

## Payload shape: what you send is what you assert

- **Leaving something out never deletes it.** Tested for every translation type
  ([03](03-rollback-and-revert.md)). So a cut-down `CustomObjectTranslation` that carries only the
  blocks holding your targets is safe, and so is sending a whole value-set file.
- **Every block you send re-asserts all of its children.** A field block carries its label, help
  text and picklist values. If you fill one empty picklist value, the label and help text go along
  at whatever text your file holds. That is how stale wording, lost line breaks and pre-filled
  guesses overwrite newer org content.
- **Build every file from a fresh retrieve of the target**, copy every leaf exactly as retrieved,
  and change only the target leaves. Never build from a spreadsheet pre-filled with "existing
  values": the pre-fill ships as if it were a translation. A protective re-deploy built that way
  once silently wrote an older file's text over hundreds of newer values.
- **Never send an empty element.** For layout sections, record types and validation rule
  messages an empty `<label/>` or `<errorMessage/>` **clears** the org value. For other types it is
  ignored, which is worse because it looks like it worked. A retrieved file marks an untranslated
  section with an XML comment; a parser returns `None` for it, and writing that back as an empty
  label would clear a value. Skip untranslated cells; do not emit them.
- **A tool that regenerates a whole element set from a spreadsheet drops whatever the spreadsheet
  lacks.** Object-name forms are the common case. The input must carry everything you want to keep.
- **Leave `en_US` out unless you mean it.** A builder that loops over all languages wrote thousands
  of English "translations" identical to the English source. A real `en_US` case: correcting a
  renamed standard field label.
- **Deploy a scoped folder, never `--metadata CustomObjectTranslation` against a whole repo.** A
  broad deploy picks up every old retrieved file, namespaced objects that cannot deploy and value
  sets you did not mean to touch. It produced hundreds of spurious errors. Value-set translation
  files you generated into the scoped folder are fine.
- **Write payload files LF-only, with a carriage return inside a value written as `&#13;`.** See
  [08](08-text-fidelity.md).
- **Keep element order.** Copy the order of retrieved files (in these types it is alphabetical).
  A wrong position fails with "Element ... invalid at this location". Orders seen:
  - `CustomObjectTranslation` root (subset): `caseValues`, `fields`, `gender`, `layouts`,
    `nameFieldLabel`, `recordTypes`, `startsWith`, `validationRules`.
  - `fields` block: `caseValues`, `description`, `gender`, `help`, `label`, `lookupFilter`, `name`,
    `picklistValues`, `relationshipLabel`, `startsWith`.
  - `caseValues`: `article`, `caseType`, `plural`, `possessive`, `value`.
  - `picklistValues` / `valueTranslation`: `masterLabel`, `translation`.
  - `layouts`: `layout`, `sections`; `sections`: `label`, `section`.

## Overwrite protection: three checks before the deploy

Use these when the rule is "fill empty slots only" or "overwrite only the values I name".

1. **Build proof (offline).** Read a fresh retrieve. Every payload leaf must be one of: a new
   value into a slot the retrieve shows empty; byte-equal to what the retrieve holds; or a named
   overwrite whose current value equals the expected old value you recorded. Anything else stops
   the build. Prove the proof works with a **negative control**: plant one overwrite per file type
   (object, global value set, standard value set, custom label) in a copy and confirm the build
   fails.
2. **Independent read (the target's own export).** Take a Bilingual export *after* the retrieve.
   Every slot you fill must be listed untranslated, under every key spelling the export uses
   (`Activity`, `Knowledge__c`, `_N` suffixes). A key in neither section is UNVERIFIED, not a pass.
   Also check each file's header, that all languages list the same keys, and the export's age.
   Renamed standard fields and object names are in no export; they get checks 1 and 3 only.
3. **Re-read just before the deploy.** Retrieve the same manifests again and require every
   translation file to be identical to the build read, as raw text. A Setup edit leaves no
   DeployRequest, and your payload would write the old wording back. This check has caught real
   changes: a picklist value added in Setup, and a package installed and a field edited while a
   push was being prepared. Each time the right answer was to restart from the read. Also confirm
   no DeployRequest since the build read.

Before the deploy, **copy the build read to a dated snapshot folder** and check its file count and
bytes. It is your record of what was there and the only source for a later repair
([04](04-restoring-overwritten-values.md)).

Keep a person between the dry run and the real deploy. Any automation should default to
check-only and need an explicit flag to commit.

## Verification after the deploy

The deploy report says what Salesforce accepted, not what it stored.

1. **Retrieve again with parents** into a new folder. Compare whole files leaf by leaf, not only
   the targets: every target holds its intended value, and no other leaf changed in any retrieved
   file.
2. **Compare raw text as well as parsed values.** A comparison that parses XML and strips values
   cannot see a lost carriage return or a trimmed space.
3. **Diff a Bilingual export taken after the deploy against the one taken before.** Every pushed
   slot should be TRANSLATED with your text, and nothing else should have changed. This export diff
   is what caught carriage returns lost from two existing help texts that every other check missed.
4. **Treat UNVERIFIED as a failure.** A verifier once reported "0 missing" while well over a thousand rows
   sat in a "could not build a key" bucket, including rows that had never landed.
5. **Look in the right place.** Task/Event field translations come back under `Activity`. A quick
   action on Event stays under `Event`. Salesforce adds `<aspect>Master</aspect>` to a quick action
   when its label translation is saved (seen every time); expect it, but only on quick actions you
   filled.
6. **Record the run**: deploy ID, check-only or not, component counts, time, scope, and anything
   surprising.

## Dry run first, with JSON output

```bash
sf project deploy start --metadata-dir payload --dry-run --test-level NoTestRun \
  --target-org my-sandbox --json > dryrun.json
sf project deploy start --metadata-dir payload --test-level NoTestRun \
  --target-org my-sandbox --json > deploy.json
```

`--json` output redirected by PowerShell 5.1 starts with a UTF-8 BOM. Read it with
`encoding="utf-8-sig"` in Python, or `json.load` fails with "Expecting value: line 1 column 1".
