# Translation Workbench through the Connect REST API

Salesforce exposes Translation Workbench export and import jobs under
`/services/data/vXX.X/connect/i18n/translation/`. Replace `vXX.X` with your org's API version
(for example `v62.0`). What was found by testing against a sandbox:

| Step | Status |
|---|---|
| Create an export job | Tested, works |
| Poll the export job | Tested, works |
| Download the exported file | **Blocked**: every OAuth client tried got HTTP 404 |
| Import | **Untested**. Do not treat it as working. |

So the export job can be started and watched from a script, but the `.stf` file still has to be
downloaded by hand from the browser.

## Errors in Salesforce's published docs

Two errors in the prose reference page. Both cause a hard failure, not a silent one:

| The docs say | What the org actually does |
|---|---|
| The request body needs `exportType: "Metadata"` | There is no such field. Sending it returns `JSON_PARSER_ERROR: Unrecognized field "exportType"`. |
| `contentFilter` accepts `Bilingual`, `Untranslated`, `Outdated` | Only `SourceAndTranslations` and `Source` exist. `SourceAndTranslations` is the Bilingual export; the API labels the result `"language": "Bilingual"`. |

The OpenAPI YAML schema for the Connect REST API was right where the prose was wrong. Trust the
schema over the reference page, and check any untested endpoint (import especially) against the
schema before you build on it.

## Export: the request that worked

`body.json`:

```json
{
  "filters": {
    "languages": ["de"],
    "contentFilter": "SourceAndTranslations",
    "statusFilter": "AllRecords"
  },
  "format": "Stf"
}
```

```bash
sf api request rest "/services/data/vXX.X/connect/i18n/translation/export" \
  --method POST --body @body.json --header "Content-Type: application/json" \
  --target-org my-sandbox
```

Response: a `jobId`, `"status": "Pending"`.

Filter fields, from the schema:

| Field | Values | Tested |
|---|---|---|
| `contentFilter` | `SourceAndTranslations`, `Source` | `SourceAndTranslations` only |
| `languages` | list of codes; required with `SourceAndTranslations` | one language only; several untested |
| `statusFilter` | `AllRecords`, ... | `AllRecords` only |
| `setupComponentsFilter` | component API names | untested |
| `timeRangeFilter` | `startDate` / `endDate`, ISO 8601 | untested |
| `format` (top level, **not** inside `filters`) | `Stf`, `Xliff` | `Stf` only |

Use `Stf` if your tooling reads `.stf`; `Xliff` needs a different parser and is untested here.

## Poll the job

```bash
sf api request rest "/services/data/vXX.X/connect/i18n/translation/export/<jobId>/status" \
  --target-org my-sandbox
```

Observed `Pending`, then `InProgress`, then `Completed` in about 20 seconds for one language.
Polling every few seconds is enough. The completed response has `downloadLinks[]` with
`fileName`, `fileSize`, `language` and `url`. The zip held a file named like
`Bilingual_de_<date> <time>.stf`, the same format as a Setup export.

The `url` arrives HTML-escaped (`&amp;`). Unescape it before use.

## Download: blocked

`downloadLinks[].url` points at `/servlet/downloadTranslations`, a UI servlet, not an API resource.
The schema defines no other download route. What was tried:

| Attempt | Result |
|---|---|
| `curl` with `Authorization: Bearer <token>` | 404, 0 bytes |
| `curl` with `Cookie: sid=<token>` | 404 |
| PowerShell `Invoke-WebRequest` with Bearer | 404 |
| with and without the `fromEmail=1` parameter | 404 either way |
| `sf api request rest --stream-to-file` | no file written |
| `sf api request rest` with a shell redirect | corrupted, truncated output (about a fifth of the size) |

It seems to need a browser session rather than an OAuth token. That is an inference, not proven.

## Windows trap: `&` in a URL passed to `sf`

On Windows `sf` is `sf.cmd`, a batch file. `cmd.exe` re-parses the arguments and treats `&` as a
command separator. Symptom:

```
'fromEmail' is not recognized as an internal or external command
```

The CLI then fetches a truncated URL without failing. Any URL with `&` passed to `sf` on Windows
is affected. Avoid such URLs, or call the endpoint with another HTTP client.

## Import: untested

`POST /services/data/vXX.X/connect/i18n/translation/import`, `multipart/form-data`, a binary
`file` part (an unzipped XLIFF or STF, or a zip of several), optional `parameters` query string.
Returns a `jobId`; poll `.../import/<jobId>/status`.

None of this has been run against an org. An import writes translations, so treat it like any
deploy: a throwaway sandbox first, a known small file, a read-back before and after. Nothing about
its overwrite behaviour, or whether it can clear values, is known.
