# sf-psg-compare

A Chrome extension that compares two Salesforce permission set groups (PSGs): what each one
contains and what each one lets a user do.

It works in any org you can log in to. It uses the Salesforce login you already have in the
browser, so there is nothing to set up in the org: no connected app, no OAuth, no server.

Read-only. It runs SOQL queries and describes. It never writes to the org.

## What it compares

| Tab | A vs B |
|---|---|
| Overview | org, API name, label, description, status, number of component permission sets, muting permission set, assigned users (active / total), and how many items each group grants |
| Contents | which permission sets each group is built from (with licence), and what each muting permission set removes |
| System permissions | every user permission the group grants (API Enabled, View All Data, Export Reports…). High-risk permissions are tagged |
| Objects | Read, Create, Edit, Delete, View All Fields, View All, Modify All per object, and exactly which flags only one side has |
| Fields | None / Read / Edit per field |
| Apex, pages, apps & custom perms | Apex classes, Visualforce pages, apps, custom permissions, connected apps, named and external credentials, custom settings / metadata types, flows |
| Tabs | tab visibility (default on, default off, hidden) |

At the top it writes the result in plain words, for example:

- "Sales Manager grants everything Sales Rep grants, and more."
- "Only Sales Manager grants View All Data."
- "Sales Manager has Delete, View All, Modify All on Opportunity; Sales Rep does not."

Each tab shows the differences by default. "Everything" shows the matching rows too. Every tab
exports to CSV (opens in Excel), and "Export all" puts every tab in one CSV.

### Net access, not the sum of the parts

The permissions come from the group's aggregate permission set (`PermissionSet` with
`Type = 'Group'`). Salesforce keeps that record as the component permission sets combined, minus
the muting permission set. It is what a user assigned to the group actually gets from it.

It is only current when the group's Status is **Updated**. If a group is `Outdated` or `Failed`,
the tool says so at the top. Recalculate the group in Setup and compare again.

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

Serve the `extension/` folder and open the demo, which loads two made-up groups from
`extension/samples/`:

```
python -m http.server 8765 --directory extension
```

Then open <http://localhost:8765/psg-compare.html?demo=1>. Opened as a plain web page (not
through the extension) the tool can still compare two snapshot files.

## What your user needs

- API Enabled.
- View Setup and Configuration (to read permission sets, groups and their permissions).
- To name Apex classes and pages: read access to them is normal with View Setup. Items it cannot
  name are kept by Id with a note at the top.

## How it reads the org

All requests go from the extension page straight to `https://<your org>/services/data/v62.0/`.
Nothing is sent anywhere else. Per group it runs about 15 to 25 queries:

| Read | Query |
|---|---|
| Group | `PermissionSetGroup`, its aggregate `PermissionSet` (`PermissionSetGroupId`) |
| Contents | `PermissionSetGroupComponent`, then `PermissionSet` / `MutingPermissionSet`, licence names |
| System permissions | every boolean `Permissions*` field of `PermissionSet` (from describe), in chunks |
| Objects / fields | `ObjectPermissions`, `FieldPermissions` where `ParentId` = aggregate permission set |
| Setup access | `SetupEntityAccess`, then the named object per type (some through the Tooling API) |
| Tabs | `PermissionSetTabSetting` |
| Assignments | `COUNT()` on `PermissionSetAssignment` |

The session is the browser's `sid` cookie for the org, found the same way Salesforce Inspector
finds it. It is held in memory for that tab only and never stored.

## Not tested

The offline tests (below) cover the compare logic, the query and session handling, and the
snapshot shape against faked API responses. **The tool has not yet been run against a live org.**
Before relying on it, compare two groups you know well in a sandbox and check a few rows against
Setup. In particular, check:

- that the aggregate permission set returns object and field permissions in your org;
- the muting section, if your groups use muting permission sets;
- the setup-access names (apps, flows, custom metadata types).

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
| `extension/lib/compare.js` | Compares two snapshots; CSV export. Pure, no browser APIs |
| `extension/samples/` | Two synthetic snapshots for the demo and the tests |
| `tests/` | Offline tests and the sample generator |
