<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

# Metadata type quirks

Where each kind of translation lives, and the surprises found per type.

## Map of types

| What users see | Metadata type and place |
|---|---|
| Field label, help text, local picklist values | `CustomObjectTranslation` `<Object>-<lang>`, `<fields>` |
| Record type label | same file, `<recordTypes>` (keyed by DeveloperName) |
| Validation rule message | same file, `<validationRules>` |
| Layout section heading | same file, `<layouts><sections>` |
| Object name forms, renamed standard field labels | same file, `<caseValues>` (object) or `<fields><caseValues>` |
| Quick action label | same file, `<quickActions>` (not `Translations`) |
| Global value set value | `GlobalValueSetTranslation` `<Set>-<lang>` |
| Standard value set value | `StandardValueSetTranslation` `<Set>-<lang>` |
| Custom label, custom tab, app, report type, flow text | `Translations` `<lang>` |

## Global value sets

- **A picklist field backed by a global value set** (`<valueSetName>` in its field metadata) takes
  its value translations in `GlobalValueSetTranslation`, never in `CustomObjectTranslation`. Sent in
  the object file, every value fails "Invalid picklist value: X in field: Widget__c.Color__c".
- **The value set keys off the API name; its translation keys off the label.**
  `globalValueSets/Color_Set` has `<fullName>RED</fullName>`;
  `globalValueSetTranslations/Color_Set-de` has `<masterLabel>Red</masterLabel>`. A file that supplies
  display labels is already right for the translation; converting labels to API names breaks it.
- **One set can back fields on several objects.** Dedupe when you re-point values from field rows to
  the set, or the same `valueTranslation` appears twice in one file.
- **Shared sets are shared.** Overwriting a value set translation changes it for every field and
  every team that uses the set. Treat such changes as decisions for every owner of the set.

## Task, Event and Activity

- Task and Event do not own their custom fields; both are views over Activity. Field metadata is in
  `objects/Activity/fields/`, and **field translations are stored once, under `Activity-<lang>`**.
  Checked three ways: Tooling `CustomField` (every custom activity field is on Activity), the
  Bilingual export (all keys under `Activity`), and retrieves (`Task-xx` / `Event-xx` carry empty
  field shells).
- A field translation sent in `Task-<lang>` or `Event-<lang>` was stored under `Activity-<lang>`.
  Verify there.
- When a source file has a Task row and an Event row for the same field with different wording,
  **only one wording can be stored**. Decide which before pushing.
- Anything that reads field metadata by object name needs the Activity fallback, or it silently
  reports "unknown" for every Task/Event field.
- **Not everything moves to Activity:** a quick action on Event stays in `Event-<lang>`.

## Knowledge

`Knowledge__kav` translations appear in the export under `Knowledge__c`. Map the key both ways.

## Quick actions, tabs, apps, report types

- Quick action label translations are stored in the object's `CustomObjectTranslation` under
  `<quickActions>`, not in `Translations`.
- **Salesforce adds `<aspect>Master</aspect>` to a quick action when its label translation is
  saved** (seen on every one filled). Expect it in after-deploy reads.
- A report type translation payload with only `<name>` and the translated `<sections>` (no report
  type label) was accepted and stored.
- **Lightning page tabs are never listed in the Bilingual export.** Verify them by retrieve only.
- **Managed-package tab and app translations are invisible to every retrieve**; the export holds
  them. Sending your own `customTabs` / `customApplications` entries in a `Translations` file left
  the managed ones unchanged (checked by export diff).

## Custom labels

- Stored in `Translations` `<lang>` as `<customLabels><label>...</label><name>...</name></customLabels>`.
- **Name every language explicitly in a retrieve.** listMetadata omitted languages that held labels.
- Include `CustomLabel` in the same manifest so the retrieve returns translation content.
- **Finding where a label is used:** Tooling `MetadataComponentDependency` missed many real
  references (in one check, about half the labels used by a set of flows). Scan the source instead:
  `$Label.X`, `@salesforce/label/c.X`, `Label.X`, `Label.get(...)` across Apex, triggers, LWC, Aura,
  Visualforce, FlexiPages, flows and email templates.
- **Label references are case-insensitive.** `$Label.account` refers to the label `Account`.
- A label referenced in code but never imported (in an LWC) can never show; do not pay to translate it.
- Exclude values that are not words (URLs, IDs, email addresses, numbers) and labels used only in
  logic (comparisons, decisions); translating a logic-only label can break the logic.
- New labels created after your export are not in it. Check the export date against label creation.

## Flows

- **The Bilingual export lists flow text per flow version**: `Flow.Flow.<Api>.<version>...` for
  screen flows, `Flow.AutoLaunchedFlow.<Api>.<version>...CustomError` for record-triggered custom
  errors. It is the best list of what can be translated.
- **In metadata, flow translations live in `Translations` under `<flowDefinitions>`, keyed by flow
  name with no version.** Observed in one deploy.
- **`Flow:<Api>` in a retrieve returns the latest version**, which may be a Draft while an older
  version is active. Retrieve `Flow:<Api>-<n>` to read a specific version. Check the active version
  first:

  ```bash
  sf data query --use-tooling-api --target-org my-sandbox \
    --query "SELECT Definition.DeveloperName, VersionNumber, Status FROM Flow WHERE Definition.DeveloperName = 'Widget_Screen_Flow'"
  ```

- **A `Translations` retrieve whose `Flow` member is `<Api>-<n>` for a version that is not the
  latest returned no translation block.** To read stored flow translations, name `Flow:<Api>`.
  Observed once.
- **Unproven:** when a draft version sits above the active one, whether users of the active version
  see the translations. Check with an export or by running the flow as a user of that language.
- Rich-text display texts are HTML. Put the translation back inside the English HTML and keep
  `{!merge}` fields intact.
- Not translatable through the Workbench (users see English): text hard-coded in an LWC, data table
  column headings (they sit in JSON), screen titles, default Previous/Pause buttons.
- A screen text that only shows `{!$Label.X}` is translated through the custom label.
- Translations are tied to versions in the export; re-check keys after a new version is activated.

## Picklist values

- **Local picklist values key off the label**, not the API name. Record types key off DeveloperName.
- **A picklist translation replaces the whole displayed label.** If the English label gained a
  prefix (`1 - Widget Type A`), the translation must carry it too (`1 - Widget-Typ A`), or the prefix
  disappears for that language. Copy the separator exactly; it can differ per field.
- **Inactive picklist values were not readable by retrieve.** Translations sent to inactive values
  were accepted; reading them back was not possible.

## Managed packages

- Translations of namespaced objects cannot be deployed ("namespaced language is not allowed").
  Filter them out of scope before anything downstream sees them.
- Managed-package field labels on non-namespaced objects did deploy (observed once). Prove the slot
  empty with the target's export first, because a retrieve may not show their current translation.

## English-equal translations

A translation identical to the English text is stored as a real translation. It is the deployable
way to replace a wrong value with "what an untranslated slot shows", but the export then lists the
slot as TRANSLATED.
