<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

# Reading translation state

How to find out what translations an org actually holds. Get this wrong and every later
decision (what to push, what was overwritten, did the deploy land) is built on a bad read.

## Short version

- The **Bilingual `.stf` export** (one file per language) is the most complete read of
  translated *content*. Use it to verify a deploy and to compare orgs.
- A **metadata retrieve** reads translations correctly **only when the parent metadata is named
  in the same manifest**. Retrieved alone, `CustomObjectTranslation` returns almost nothing.
- Neither read covers everything. Object-name grammar and renamed standard fields are only in a
  retrieve. Some managed-package and Lightning-tab content is only in the export.
- Your local project tree (`force-app/`) is **not** org state. Never read it as such.

## Why the Bilingual export beats a retrieve

1. **A retrieve only returns content for parents named in the same manifest.** Retrieve
   `CustomObjectTranslation:Account-de` on its own and you get only `caseValues` (object-name
   forms, gender, startsWith) and renamed standard fields. Field labels, picklist values, record
   types, validation rules and layout sections are missing, whether or not they exist. An empty
   `<CustomObjectTranslation/>` of about 100 bytes proves nothing.
2. **The export needs no manifest design.** It lists every translatable key Salesforce knows,
   so you cannot forget a parent type, a layout or a language.
3. **The export shows untranslated slots too.** Each language file has a `TRANSLATED` section and
   an `OUTDATED AND UNTRANSLATED` section. That lets you prove a slot is empty, which a retrieve
   cannot do for content it does not return.
4. **Some things are invisible to every retrieve.** Managed-package custom tab and app
   translations came back empty from every retrieve tried, while the export held them. A retrieve
   could not be trusted to show managed-package field labels either (they did read back after
   they had been set by a deploy; observed once).
5. **The retrieve's answer depends on how you batch it.** The same component can come back from
   two batches (for example once with its layouts, once with its quick actions). If your reader
   keeps one copy per component, it silently loses the blocks that are only in the other copy.
   Merge every copy block by block.
6. **A retrieve can omit languages.** `sf org list metadata --metadata-type Translations` left out
   several languages that did hold custom-label translations (observed in one org). Name every
   language code explicitly in a `Translations` retrieve. Do not build the member list from
   listMetadata.

The export has its own costs: the download is manual (see
[05-translation-workbench-api.md](05-translation-workbench-api.md)), it is a point in time, and
it carries no grammar.

## Export types (Setup > Translation Workbench > Export)

| Type | What it gives |
|---|---|
| Source | Every translatable key, in English. No language choice. |
| Outdated and untranslated | Per language: keys not translated (or out of date). |
| Bilingual | Per language: a TRANSLATED section with the stored text, plus the outdated/untranslated keys. One `.stf` per language, zipped. |

"Source minus untranslated" also gives what is translated, but Bilingual gives the text itself.
Use Bilingual.

### Export gotchas

- **The TRANSLATED section is left out entirely for a language with 0 translations.** A parser
  that requires the section marker fails on those languages. Require it only when the language
  holds something; check instead that every language file lists the same set of keys.
- **All language files from one export list the same keys.** Use that as an integrity check: a
  truncated file, or a file from another org mixed in, breaks it.
- **The file name timestamp is in the org's default time zone**, not yours and not UTC. This was
  proven by matching an export's content to a deploy of known time. Convert before placing an
  export on a deploy timeline.
- **An export cannot tell you which org it came from.** Keep exports in folders named by org and
  date.
- **Some keys repeat.** In one org a few hundred keys were listed twice (for example fields listed
  twice, report-type columns with two labels). Keep them as separate rows; do not dedupe blindly.
- **Exports go stale.** Take a fresh one after any deploy you want to verify. A practical rhythm:
  one export before a push and one after.

## `.stf` key shapes

The export strips `__c` from object and field names.

| Item | Key |
|---|---|
| Field label | `CustomField.Widget.Color.FieldLabel` |
| Field help text | `CustomField.Account.Region.HelpText` |
| Local picklist value | `PicklistValue.Widget.Color.<master label>` |
| Global value set value | `PicklistValue.<Set>__gvs.<master label>` |
| Record type | `RecordType.Widget.<DeveloperName>` |
| Validation rule message | `ValidationFormula.<...>` |
| Layout section | `LayoutSection.Widget.<Layout name>.<Section label>`, sometimes with a positional `_<N>` suffix |
| Custom label | `CustomLabel.<Name>` |
| Custom button / link | `ButtonOrLink.Account.<Name>` |
| Screen flow text | `Flow.Flow.<FlowApi>.<version>.<Screen>.Field.<field>.FieldLabel` (also `.Description`, `.HelpText`, `.ErrorMessage`, `.NextOrFinishButtonLabel`, `.BackButtonLabel`, `Choice.<choice>.FieldLabel`) |
| Record-triggered flow error | `Flow.AutoLaunchedFlow.<FlowApi>.<version>.<element>[.<field>].CustomError` |

Spelling traps that make live data look missing:

- **Task and Event custom fields are filed under `Activity`.** A row keyed
  `Task.Status__c` is `PicklistValue.Activity.Status.<value>` in the export.
- **A picklist field backed by a global value set is filed under the set**, not the field:
  `PicklistValue.Color_Set__gvs.Red`, not `PicklistValue.Widget.Color.Red`.
- **`Knowledge__kav` appears as `Knowledge__c`.**
- **Layout section keys may carry `_<N>`.** Prefix matching on the label alone often misses them.
- String flow input parameters are quoted in the export (for example `"Data Table"`).

## What the Bilingual export does not contain

- Object-name case forms, gender, startsWith, article, possessive.
- Renamed standard field labels (they are `caseValues` too).
- Lightning page tabs (observed: never listed).
- Inactive picklist values (not seen in the reads used here; not tested further).
- Anything created after the export.

For object names and renamed standard fields, a lone `CustomObjectTranslation` retrieve is the
right read. It does return them.

## Retrieve: name the parents

| Translation type | Put these in the same manifest |
|---|---|
| `CustomObjectTranslation` | `CustomObject` for the object, and every `Layout` of the object; `QuickAction` if you need quick-action labels |
| `GlobalValueSetTranslation` | `GlobalValueSet` |
| `StandardValueSetTranslation` | `StandardValueSet` |
| `Translations` | `CustomLabel`, `CustomApplication`, `CustomTab`, `QuickAction`, `ReportType`, and `Flow` for flow text |

Proof this works: a full-scope retrieve built this way (dozens of objects with all their
layouts, value sets and labels, every language in use) matched that org's Bilingual exports on
tens of thousands of values with 0 different. The only gaps were managed-package content, the `Knowledge__c` key
spelling and a handful of outdated translations.

Example manifest (`manifest/read-widget.xml`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types><members>Widget__c</members><name>CustomObject</name></types>
  <types><members>Widget__c-Widget Layout</members><name>Layout</name></types>
  <types>
    <members>Widget__c-de</members>
    <members>Widget__c-fr</members>
    <name>CustomObjectTranslation</name>
  </types>
  <types><members>Color_Set</members><name>GlobalValueSet</name></types>
  <types>
    <members>Color_Set-de</members>
    <members>Color_Set-fr</members>
    <name>GlobalValueSetTranslation</name>
  </types>
  <types><members>*</members><name>CustomLabel</name></types>
  <types><members>de</members><members>fr</members><name>Translations</name></types>
  <version>62.0</version>
</Package>
```

Retrieve into a scratch folder, never into the project tree:

```bash
sf project retrieve start --manifest manifest/read-widget.xml \
  --target-metadata-dir read/before --unzip --target-org my-sandbox --json > read/before.json
```

Check that the JSON says `Succeeded` with no messages before you use the files. List layout names
with `sf org list metadata --metadata-type Layout --target-org my-sandbox --json`.

## Which read for what

| Need | Use |
|---|---|
| Field labels, picklist values, record types, validation rules, layout sections, custom labels | Bilingual export, or a retrieve with parents |
| Global / standard value set values | Bilingual export, or a retrieve with the value set |
| Object-name forms, gender, startsWith; renamed standard fields | Retrieve (`CustomObjectTranslation`). Not in any export. |
| Managed-package tab/app labels | Bilingual export only |
| Flow text | Bilingual export (keys per version); retrieve `Translations` with the `Flow` in the request (see [09](09-metadata-type-quirks.md)) |
| What users actually see for a layout heading | Rendered read with `Accept-Language` (see [06](06-layout-section-ownership.md)) |
| Proof that a slot is empty before you fill it | Both: a retrieve, and the export listing the key as untranslated |

## The local tree is not org state

Three separate ways a local `force-app` tree was wrong in practice:

- It was weeks old, and a value read from it was presented as current.
- A pre-fill tool read another org's translations out of it and presented them as the target
  org's. It did this both when its own retrieve failed and when it succeeded (the retrieve
  without parents never overwrote the stale files).
- A test run wrote its own payload into it, and the next build treated that as org content.

Rules: retrieve into a fresh `--target-metadata-dir` for every read; check file timestamps before
you cite a local file; never pre-fill one org's workbook from a tree that holds another org's
data.

## Validate a read before trusting a negative

A long diagnosis ("the org silently discarded the deploy") turned out to be a read that
could only ever say "absent": the retrieve without parents. Deploys had worked all along.
Before you trust "missing", run the same read against one value you know exists. A check that
can only say "absent" will say it about everything.
