# sf-psg-compare

A Chrome extension that compares two Salesforce permission set groups (PSGs): what each one
contains and what each one lets a user do.

It works in any org you can log in to. It uses the Salesforce login you already have in the
browser, so there is nothing to set up in the org: no connected app, no OAuth, no server.

Read-only. It runs SOQL queries and describes. It never writes to the org.

## What it compares

The page is written for admins, not developers. It shows labels ("Account › Annual Revenue"),
not API names; "Show API names" adds them.

At the top it says the result in plain words, for example "Sales Manager gives everything Sales
Rep gives, and more." Under that:

- **A card per area** with how many items only one group has, or "✓ Same in both". Click a card
  to open its list.
- **Worth a closer look:** powerful access only one group gives, such as "Only Sales Manager has
  “View All Data”" or "Sales Manager can Delete, View All, Modify All Opportunity records; Sales
  Rep cannot."
- **Technical notes** (folded away): anything the tool could not read.

| List | Shows |
|---|---|
| Summary | org, name, description, status, users assigned, permission sets inside, muting permission set, and how much each group gives |
| General permissions | every system permission (Export Reports, View All Data…). Powerful ones are tagged |
| Objects | Read, Create, Edit, Delete, View All Fields, View All, Modify All per object, and which ones only one group has |
| Fields | No access / Read / Edit per field, grouped by object |
| Apps, pages & code | apps, Visualforce pages, Apex classes, custom permissions, connected apps, named and external credentials, custom settings / metadata types, flows |
| Tabs | shown, available (hidden by default) or hidden |
| What's inside | the permission sets each group is built from (with licence), and what each muting permission set takes away |

Each list shows only the differences until you choose "Everything". **Download** saves the list
or the full comparison as a CSV that opens in Excel, or saves a group to a file for later.

Picking a group: type any part of its name or API name (words in any order) and press Enter or
click it.

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

## User access

A second page, **User access**, shows what one user has, in plain words, and can set two users side
by side. It is read-only, like the compare page, and looks and works the same way (same
stylesheet, cards, tabs, "Only differences / Everything", "Show API names", search box, Download).

Type part of a name or username (words in any order) and pick the user from the list that opens
under the box. Inactive users are marked "Inactive". The search runs in the org, so it works in orgs
with thousands of users. Add a second user under "Compare with another user (optional)" to compare;
"Remove this user" goes back to one user.

It shows, for each user:

| Area | What it shows |
|---|---|
| Profile | the profile and its user licence |
| Role | the role |
| Permission set groups | groups assigned to the user; a muting permission set is shown as "Muting permission set: ..." |
| Permission sets | every permission set the user gets, and how: "Assigned directly", "Through group: ...", or both. Profile-owned sets and the summary sets Salesforce keeps for groups are left out |
| Permission set licences | the permission set licences assigned |
| Public groups, Queues | direct membership only. Membership through roles or groups inside groups is not shown |
| Territories | the territories the user is assigned to |

With two users, each card says how many items only one has, or "✓ Same in both". A permission set
one user has directly and the other gets through a group counts as "assigned differently". Items are
matched by API name, never by Id. **Download** saves "This list" or "Everything" as a CSV for Excel.
Nothing about users is saved: there are no user snapshots, because they hold usernames.

If an area cannot be read, only that area says so in plain words (for example "Territories are not
turned on in this org") and the raw error goes to "Technical notes". When the org's territory feature is off, the page does not even ask for it. A failed search or read shows a plain message, with the raw Salesforce message folded under "Technical details".

Objects it reads (all with `SELECT`, nothing else): `User`, `PermissionSetAssignment`,
`PermissionSetGroup`, `PermissionSetGroupComponent`, `PermissionSet`, `MutingPermissionSet`,
`UserLicense`, `PermissionSetLicense`, `PermissionSetLicenseAssign`, `GroupMember` (with `Group`),
`UserTerritory2Association`. Your user needs API Enabled and View Setup and Configuration, and
access to see users.

Try it: `python tools/dev_server.py --no-org`, then open
<http://127.0.0.1:8765/user-access.html?demo=1> (two made-up users). Against an org through the dev
server: `?dev=1`. The popup opens it as `user-access.html?host=<org host>`.

Does not cover: field-level or object-level access, what a permission set contains, sharing and
record access, group or queue membership through roles or nested groups, login history, or any
change to a user. For removing access use `sf-user-access-teardown`.

Run against live orgs so far (read-only): a Developer Edition org (search, permission sets,
licences and compare worked; territories are off there and are handled) and a large sandbox with
about 6,000 users. On the sandbox, a user with 3 permission set groups, 18 permission sets (9 only
through groups), 11 licences, 3 public groups, 24 queues and 1 territory matched the org line by
line, including a muting permission set, and a compare of two users worked. Not yet checked inside
Chrome from the toolbar button (only through the dev server).

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
2. Click the extension. It is a menu of tools: choose **Compare permission set groups** or
   **User access**. A new tab opens, connected to that org. The compare page's header shows the org
   name and whether it is a sandbox or production.
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
snapshot shape against faked API responses.

Run against live orgs so far (read-only):

- A Developer Edition org with 22 groups. For every group, the aggregate permission set's object
  permissions matched its component permission sets. Spot-checked rows matched Setup. A compare
  of two groups takes about 4 seconds.
- A larger org (about 1,300 field permissions and 300 Apex/app items per group). It showed
  that `MutingPermissionSet` has no `NamespacePrefix` field (fixed), and that
  `ExternalCredentialParameter` items needed naming (added).

Not yet checked against a live org: field permissions and Apex/app names line by line, and what a
muting permission set takes away. Before relying on those, compare two groups you know well and
check a few rows against Setup.

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
| `extension/popup.*` | Toolbar popup: a menu of tools. Detects the org in the current tab and opens the chosen page |
| `extension/psg-compare.*` | The compare page |
| `extension/user-access.*` | The User access page (html, js, and a little extra css on top of `psg-compare.css`) |
| `extension/lib/useraccess.js` | Reads one user's access from the org (`searchUsers`, `readUserAccess`) |
| `extension/lib/usercompare.js` | Turns user access into rows and compares two users; CSV. Pure, no browser APIs |
| `extension/lib/sfconn.js` | Session lookup and REST client (query with paging, describe) |
| `extension/lib/snapshot.js` | Reads one group into a snapshot |
| `extension/lib/compare.js` | Compares two snapshots; plain-language labels; CSV export. Pure, no browser APIs |
| `extension/lib/pick.js` | Matching for the group search box |
| `extension/lib/livereload.js` | Reloads the page on file changes while the dev server runs (unpacked copies only) |
| `tools/dev_server.py` | Local dev server: pages, read-only org proxy through the `sf` CLI login, live reload |
| `extension/samples/` | Two synthetic snapshots and two synthetic users for the demos and the tests |
| `tests/` | Offline tests and the sample generator |
