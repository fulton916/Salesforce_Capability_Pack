# Layout section headings: Salesforce's or yours?

Some page-layout section headings belong to Salesforce. Their translations come from Salesforce's
own language pack, and **a deploy that sets one is accepted, reports success, and stores
nothing**. Others are headings an admin typed; those are yours to translate. Send translators only
yours, or you pay for translations that can never land.

Typical Salesforce-owned headings: `System Information`, `Information`, `Custom Links`,
`Description Information`, `Additional Information`, `Address Information`. They can be most of
the layout-section rows in a workbook.

**Ownership belongs to the section on a given layout, not to the heading text.** The same heading
(`Additional Information`) was the admin's on some layouts and Salesforce's on others, and
`Custom Links` was admin-owned on one object and Salesforce-owned on another.

## Method 1 (best, no deploy): `customLabel` in the Layout metadata

Every `<layoutSections>` element in a retrieved layout carries `<customLabel>`:

- `true`: an admin-typed heading. Yours to translate.
- `false`: Salesforce's built-in heading, rendered from its language pack. Not yours.

```bash
sf project retrieve start --metadata "Layout:Widget__c-Widget Layout" \
  --target-metadata-dir read/layouts --unzip --target-org my-sandbox
```

```xml
<layoutSections>
    <customLabel>false</customLabel>
    <label>System Information</label>
    ...
```

Evidence: against every section that had been tested directly by the two methods below, the flag
agreed in every case (a couple of hundred sections, both directions). It also agreed with
Salesforce's Source export: nearly all `true` sections were keys there, and none of the `false`
ones were. For a few sections the flag was the only evidence available; that is consistent with the
rule but not independently proven for them.

## Method 2: render in a probe language

Render each layout's sections in a language your org has **never loaded translations into** (a
"probe language"). If a heading comes back translated, Salesforce has its own string for it, so it
is Salesforce-owned. If it comes back in English, there is no pack string, so it is yours.

Use `composite/batch` with an `Accept-Language` header and `describe/layouts` sub-requests:

```json
{
  "haltOnError": false,
  "batchRequests": [
    { "method": "GET", "url": "v62.0/sobjects/Widget__c/describe/layouts" },
    { "method": "GET", "url": "v62.0/sobjects/Account/describe/layouts" }
  ]
}
```

```bash
sf api request rest "/services/data/v62.0/composite/batch" --method POST \
  --body @batch.json --header "Content-Type: application/json" \
  --header "Accept-Language: ja" --target-org my-sandbox
```

Compare each section heading with the `en_US` rendering:

| Probe vs English | Verdict |
|---|---|
| differs | Salesforce-owned. Not translatable through your payloads. |
| identical | No pack string. Yours to translate. |

A second probe language that has the opposite property makes a strong cross-check. In a language
where your org *has* translations but Salesforce has no pack strings, the standard headings stay
English while your own headings show your translation. Seen side by side, the two languages give
mirror-image results.

Gotchas:

- **The response is rendered display text.** One response alone cannot tell your override from
  Salesforce's pack text. Only the comparison across languages can. Never use a rendered read to
  pre-fill "existing translation" columns; it writes Salesforce's text in as if it were yours.
- **Choose the probe language carefully.** The first choice turned out to have translation
  folders in the org after all. They held no real section values, so the result stood, but check
  that the org stores no section translations in the probe language before relying on it.
- **`describe/layouts` does not expose every section.** Headings drift at runtime (a section can
  render as `Widget Details` though the layout says `Widget Detail Information`), and
  `Custom Links` is not in `detailLayoutSections` at all. Those sections need method 1 or 3.
- **Strip headings before matching.** One heading rendered with a leading space and was left
  unmatched until the matcher stripped it.
- **Fail loudly on a failed sub-request.** With `haltOnError: false` a sub-request can fail while the
  batch still returns a full-length result. A silent miss reads as "no translation in this language".
- **Record which languages you probed** and only apply verdicts to those language columns.

## Method 3: deploy probe (for what describe cannot see)

Deploy a sentinel heading and see whether Salesforce keeps it, in a sandbox:

1. Pick a language with no Salesforce pack strings for the headings (so nothing masks the result).
2. In one payload for one `CustomObjectTranslation`, set the section under test to a sentinel such
   as `ZZTEST_SECTION`, **and** set a heading you know is yours to a real value. The second one is
   the in-payload control.
3. Dry run, deploy, then read back with a retrieve **that includes the object and its layouts**.
4. Control present, sentinel absent: Salesforce-owned. Both present: yours. Neither present: your
   read is blind; fix the read before concluding anything.

In the probe that settled this, the custom heading's translation persisted and read back, while
the standard heading's sentinel was not stored at all. Same component, same deploy, 0 errors.
Because Salesforce discarded every Salesforce-owned sentinel, no revert was needed.

Rules learned the hard way:

- **Without an in-payload control, a blind read looks like evidence.** The first analysis of one
  probe read back empty shells (it retrieved without layouts) and reported "0 conclusive". Only the
  missing control revealed it.
- **Read the control from a fresh retrieve, never the local tree.** After one probe the local tree
  had absorbed the payload, and the next probe build skipped most targets as "already set".
- **Never emit an empty `<label/>`** when you build probe files from retrieved ones; it clears real
  values.

## What did not work

- **"Not in the Source export" as the rule.** It under-excluded by dozens of rows when measured
  against the org. Worse, the Source export listed **no** layout sections at all for some objects,
  so for those objects absence meant nothing. If you must use it, require at least one section key
  for that object before condemning any of its rows.
- **A UI sighting of a translated heading.** Salesforce's pack renders a translated heading
  whatever you deploy, so seeing one in the UI proves nothing about your deploy.
- **The local tree's copy of a section translation.** It was weeks old and showed a value the org
  did not hold.

## Presenting the result to translators

- Keep Salesforce-owned sections off the translation tab. If you show them for reference, lock or
  grey the columns so nobody types into cells nothing will read.
- Mark sections you could not verify instead of hiding them. Hiding a row you own, without
  evidence, is the worse error.
- For languages with no pack string, users see English. Show that as English, not as blank.
