# sf-psg-compare

A Chrome extension that compares two Salesforce permission set groups (PSGs): what each one
contains and what each one lets a user do.

It works in any org you can log in to. It uses the Salesforce login you already have in the
browser, so there is nothing to set up in the org: no connected app, no OAuth, no server.

Read-only. It runs SOQL queries and describes. It never writes to the org.

## What it compares

The page is written for admins, not developers. It shows labels ("Account › Annual Revenue"),
not API names; "Show API names" adds them.

At the top it says the result in plain words, with how much: "Each group gives access the other
does not: Sales Rep gives 4 items of access Sales Manager doesn't; Sales Manager gives 21 items of
access Sales Rep doesn't." (An "item of access" is a general permission, object, field,
app/page/code item or tab that only that group gives, or gives more of.) Under that:

- **A card per area**, under "Differences by area" ("A number next to a group's name is what only
  that group has"): a number and the group's name for each group that has items the other lacks,
  "N set up differently", or "✓ Same in both". Click a card to open its list. "What's inside" says
  what it counts: "Permission sets in one group but not the other" and "Things muting takes away in
  one group but not the other" (plus "set up differently" for muted items both remove differently).
  The muting permission set itself is not counted on the card, but is still in the list.
- **Worth a closer look:** powerful general permissions only one group gives (first), then at most
  one line per group for View All / Modify All on objects, such as "Sales Manager has View All or
  Modify All on 938 objects where Sales Rep has less, including Account, Case and Opportunity. See
  Objects." (Where the other group also has View All and this one adds Modify All, that counts too.)
- **Technical notes** (folded away): anything the tool could not read, with what to do.

| List | Shows |
|---|---|
| Summary | org, name, description, status, users assigned, permission sets inside, muting permission set, and how much each group gives |
| General permissions | every system permission (Export Reports, View All Data…). Powerful ones are tagged |
| Objects | Read, Create, Edit, Delete, View All Fields, View All, Modify All per object, and which ones only one group has |
| Fields | No access / Read / Edit per field, in one collapsible block per object ("Account — 212 differences"). Long lists start collapsed; "Expand all / Collapse all"; searching opens the matching objects |
| Apps, pages & code | apps, Visualforce pages, Apex classes, custom permissions, connected apps, named and external credentials, custom settings / metadata types, flows |
| Tabs | shown, available (hidden by default) or hidden |
| What's inside | two parts: "Permission sets in each group" (with licence, and the muting permission set too), and "Taken away by the muting permission set" (what muting removes, by kind: Object, Field, General permission, Tab, App/page/code) |

Each list shows only the differences until you choose "Everything". The search ignores
punctuation ("Account › Annual" finds Account's Annual Revenue). The number on each tab is how
many differences it has. While reading big groups the page shows "Step n of 5".

**Download** saves a CSV that opens in Excel: "This list, as shown" (the differences-only choice
and the search are applied; collapsed objects are still included), the whole comparison with
differences only, or the whole comparison with everything. It can also save a group to a file for
later. The CSV has a "Kind of item" column.

Picking a group: type any part of its name or API name (words in any order) and press Enter or
click it.

### Net access, not the sum of the parts

The permissions come from the group's aggregate permission set (`PermissionSet` with
`Type = 'Group'`). Salesforce keeps that record as the component permission sets combined, minus
the muting permission set. It is what a user assigned to the group actually gets from it.

It is only current when the group's Status is **Updated**. If a group is `Outdated` or `Failed`,
the tool says so at the top. Recalculate the group in Setup and compare again.

### What muting really takes away

A muting permission set can list things no permission set in the group gives, and Salesforce does
not always apply a mute to the aggregate. So "Taken away by muting" lists an item only if it is
muted, at least one permission set in the group gives it, and the aggregate no longer has it. On a
field, Read muted takes away Read and Edit; Edit muted takes away Edit only. The notes add one line
with how many muted items took nothing away. Snapshot files saved before this check
(`sf-psg-snapshot/1`) still load; their muted items are shown under "Muted (may not have been
given)" because they cannot say whether anything was removed.

### Compare across orgs (sandbox vs production)

"Save snapshot A/B" downloads the group as a JSON file. Load that file on either side later, in
another org or with no org at all. Items are matched by API name (namespace included), never by
Id, so a group in a sandbox compares cleanly with the same group in production.

A snapshot holds permission names, object and field API names and counts. It holds no record
data and no user names. It does hold the org name and host; treat it like any other org export.

## Install (unpacked, for your own browser)

1. Copy this folder anywhere.
2. Chrome or Edge: open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode**.
4. **Load unpacked** → choose the `extension/` folder.
5. Pin the extension (puzzle icon → pin).

To share it with a team without the Chrome Web Store, zip the `extension/` folder; each person
loads it unpacked. For a managed rollout, an admin can publish it as an unlisted Web Store item or
push it by policy.

## Use

1. Open any page of the org in Chrome (Lightning, Setup or Classic) and log in as usual.
2. Click the extension → **Compare permission set groups**. A new tab opens, connected to that org.
   The header shows the org name and whether it is a sandbox or production.
3. Pick group A and group B (type in the filter box to narrow the list), or load a snapshot file
   on either side.
4. **Compare**. Each press reads the org again, so the result is current.

### Try it without an org

```
python tools/dev_server.py --no-org
```

Then open <http://127.0.0.1:8765/psg-compare.html?demo=1>. It loads two made-up groups from
`extension/samples/`.

## Developing without reloading Chrome

`tools/dev_server.py` serves the page and forwards its API calls to an org using the login the
Salesforce CLI already has, so the page can be tested against a real org in any browser tab:

```
sf org login web --alias my-sandbox        # once, if the CLI is not logged in to the org
python tools/dev_server.py --target-org my-sandbox
```

Open <http://127.0.0.1:8765/psg-compare.html?dev=1>.

- **Read-only.** Only GET requests to `/services/data/` are forwarded; anything else gets 405.
- **The token stays in the server.** The page never sees it. The server listens on 127.0.0.1 only
  and refuses requests addressed to any other host name.
- **Live reload.** Pages reload by themselves within about two seconds of a file change under
  `extension/`. This also works for the unpacked extension loaded in Chrome: unpacked extensions
  read their pages from disk, so page, JS and CSS edits need no "Reload" click while the dev
  server runs. Changes to `manifest.json` still need one.

## What your user needs

- API Enabled.
- View Setup and Configuration (to read permission sets, groups and their permissions).
- To name Apex classes and pages: read access to them is normal with View Setup. Items it cannot
  name are kept by Id with a note at the top.

## How it reads the org

All requests go from the extension page straight to `https://<your org>/services/data/v62.0/`.
Nothing is sent anywhere else. Per group it runs about 25 to 30 queries (all reads):

| Read | Query |
|---|---|
| Group | `PermissionSetGroup`, its aggregate `PermissionSet` (`PermissionSetGroupId`) |
| Contents | `PermissionSetGroupComponent`, then `PermissionSet` / `MutingPermissionSet`, licence names |
| System permissions | every boolean `Permissions*` field of `PermissionSet` (from describe), in chunks |
| Objects / fields | `ObjectPermissions`, `FieldPermissions` where `ParentId` = aggregate permission set |
| Field labels | `FieldDefinition` (real field labels), one query per 20 objects, at most 3 at a time. Labels are the ones Setup shows, which can occasionally differ from the label in a page layout or describe (for example a standard field renamed in one place). Fields the reading user cannot see keep a name made from the API name. If the query fails, labels are made from API names and the notes say so |
| Setup access | `SetupEntityAccess`, then the named object per type (external credential principals through the Tooling API). Items that cannot be named are listed as "Name not available (Id …)" with a count in the notes |
| Tabs | `PermissionSetTabSetting` |
| Muting | the muting set's own permissions, fields, objects and tabs; then, for those items only, what the other permission sets give (`FieldPermissions`, `ObjectPermissions`, `PermissionSetTabSetting`, the muted `Permissions*` fields, `SetupEntityAccess`) |
| Assignments | `COUNT()` on `PermissionSetAssignment` |

The session is the browser's `sid` cookie for the org, found the same way Salesforce Inspector
finds it. It is held in memory for that tab only and never stored.

## Not tested

The offline tests (below) cover the compare logic, the query and session handling, and the
snapshot shape against faked API responses.

Run against live orgs so far (read-only):

- A Developer Edition org with 22 groups. For every group, the aggregate permission set's object
  permissions matched its component permission sets. Spot-checked rows matched Setup. A compare
  of two groups takes about 4 seconds.
- A customer sandbox (Nov 2026) with 120 groups and 66 muting permission sets. Two groups had about
  2,000 field permissions, 120 objects and 340 apps/pages/code items each, both with muting sets;
  another pair had about 1,000 objects.
  - Field rows (Read/Edit), object rows, general permissions, tabs, the names of Apex classes,
    Visualforce pages, apps, custom permissions, connected apps, custom metadata and external
    credential principals, the component lists and the user counts matched independent SOQL, line
    by line.
  - What a muting permission set takes away was checked item by item: the aggregate equals the
    components minus the effective mutes, for fields, objects, general permissions and tabs. One
    Salesforce quirk showed up (a muted object Edit that stayed in the aggregate); the tool does
    not report that as taken away.
  - Timing: about 4 to 5 seconds per large group, about 10 to 15 seconds to compare two large groups.

Not checked: muted apps, pages and code (no muting permission set in that org mutes any); the
Chrome extension's own cookie session (those checks used the dev server); opening the CSV in
Excel. Before relying on those, compare two groups you know well and check a few rows against
Setup.

## Tests

Offline, Node 18 or later, nothing to install:

```
node tests/run_tests.mjs
```

`python tests/make_samples.py` rebuilds the sample snapshots and the icons.

## Files

| Path | What |
|---|---|
| `extension/manifest.json` | Chrome MV3 manifest (permissions: cookies, activeTab, tabs; Salesforce hosts only) |
| `extension/popup.*` | Toolbar popup: detects the org in the current tab, opens the compare page |
| `extension/psg-compare.*` | The compare page |
| `extension/lib/sfconn.js` | Session lookup and REST client (query with paging, describe) |
| `extension/lib/snapshot.js` | Reads one group into a snapshot |
| `extension/lib/compare.js` | Compares two snapshots; plain-language labels; CSV export. Pure, no browser APIs |
| `extension/lib/pick.js` | Matching for the group search box |
| `extension/lib/livereload.js` | Reloads the page on file changes while the dev server runs (unpacked copies only) |
| `tools/dev_server.py` | Local dev server: pages, read-only org proxy through the `sf` CLI login, live reload |
| `extension/samples/` | Two synthetic snapshots for the demo and the tests |
| `tests/` | Offline tests and the sample generator |
