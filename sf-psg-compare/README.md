# sf-psg-compare

A Chrome extension that compares two Salesforce permission set groups (PSGs): what each one
contains and what each one lets a user do.

It works in any org you can log in to. It uses the Salesforce login you already have in the
browser, so there is nothing to set up in the org: no connected app, no OAuth, no server.

Read-only. It runs SOQL queries and describes. It never writes to the org.

## What it compares

The page is written for admins, not developers. It shows labels ("Account › Annual Revenue"),
not API names. Ticking "Show API names" prints the API name under every row of every list
(even when it is the same as the label, such as Account).

At the top it says the result in plain words, with how much: "Each group gives access the other
does not: Sales Rep gives 4 items of access Sales Manager doesn't; Sales Manager gives 21 items of
access Sales Rep doesn't." (An "item of access" is a system permission, object, field,
app/page/code item or tab that only that group gives, or gives more of.) Under that:

- **A card per area**, under "Differences by area". Every card lists the same kinds of lines, always
  all of them (even when 0), with the group names in their colours and thousands separators:
  - System permissions: "N system permissions A has", "... B has", "N only one group has".
  - Objects: "N objects A can access", "... B can access", "N objects only one group can access",
    "N objects both can access, but with different rights (Read, Create, Edit, Delete...)".
  - Fields: "N fields A can see", "... B can see", "N fields only one group can see", "N fields both
    can see, but one can edit and the other can only read".
  - Apps, pages & code: "N items A can use", "... B can use", "N only one group can use".
  - Tabs: "N tabs A can see" (a tab set to Hidden does not count), "... B can see", "N tabs only
    one group can see", "N tabs both can see, but set differently (shown or hidden by default)".
  - What's inside: "N permission sets in A", "... in B", "N permission sets in only one group",
    "N things muting takes away in only one group", "N things both groups' muting takes away, but
    differently". The muting permission set itself is not counted, but is still in the list.

  "A has" counts everything A has, whether B has it too or not. When a card has nothing that only
  one group has and nothing different, it shows just the two totals and "✓ Same in both". Click a
  card to open its list.
- **Worth a closer look:** one block per group that has something, group A first. Each block has a
  heading in that group's colour, "Only {group} has:", then its powerful system permissions (just
  the permission name), then at most one line for View All / Modify All on objects, such as "View
  All or Modify All on 938 objects where Sales Rep has less, including Account, Case and
  Opportunity. See Objects." (Where the other group also has View All and this one adds Modify All,
  that counts too.) If a group has more than 5 system permissions, its own "Show N more system
  permissions" / "Show fewer" link is the last thing in its block.
- **Technical notes** (folded away): anything the tool could not read, with what to do.

| List | Shows |
|---|---|
| Summary | org, name, description, status, users assigned, permission sets inside, muting permission set, and how much each group gives |
| System permissions | every system permission (Export Reports, View All Data…). Powerful ones are tagged |
| Objects | Read, Create, Edit, Delete, View All Fields, View All, Modify All per object, and which ones only one group has |
| Fields | No access / Read / Edit per field, in one collapsible block per object ("Account — 212 differences"). Long lists start collapsed; "Expand all / Collapse all"; searching opens the matching objects |
| Apps, pages & code | apps, Visualforce pages, Apex classes, custom permissions, connected apps, named and external credentials, custom settings / metadata types, flows |
| Tabs | shown, available (hidden by default) or hidden |
| What's inside | two parts: "Permission sets in each group" (with licence, and the muting permission set too), and "Taken away by the muting permission set" (what muting removes, by kind: Object, Field, System permission, Tab, App/page/code) |

Each list shows only the differences until you choose "Everything". Click a column heading to sort
by it (A to Z; click again for Z to A; each heading shows small up and down arrows, and after a click one arrow shows the direction). Text sorts without regard to
case and numbers by value ("Item 2" before "Item 10"); empty text cells ("—") always come last.
Columns that show access sort by how much access there is: a tick column puts ✓ first, then —;
the Objects, Fields and Tabs columns go from least to most access (click again for most first), and
items with the same access are in name order. In Fields
the rows sort inside each object, and the Field heading also orders the objects; What's inside keeps
its two parts. The sort stays while you switch between "Only differences" and "Everything" or
search, is remembered per list, and is used by "This list, as shown". Without a click the lists
keep their usual order. The search ignores
punctuation ("Account › Annual" finds Account's Annual Revenue). The number on each tab is the same
as its card: things only one group has, plus things set up differently. While reading big groups the page shows "Step n of 5".

**Download** saves a CSV that opens in Excel: "This list, as shown" (the differences-only choice,
the search and the sort are applied; collapsed objects are still included), the whole comparison with
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

## Territory & role hierarchy

A third page shows the whole **territory** tree (Enterprise Territory Management) or the whole **role**
tree, already open, so there is no clicking of plus signs as in Setup. It is read-only and looks and
works like the other pages (same stylesheet, org name with Sandbox or Production, "Show API names").

- **Territories / Roles** switch at the top. It opens on Territories, or on Roles when the org has no
  territories (the page says so in plain words and Roles still work).
- **Territory model:** the Active model opens first. A "Territory model" list appears only when the
  org has more than one model, with each model's state (Active, Planning, Archived).
- **The tree** opens fully expanded, with guide lines so the level is easy to follow. Each node that
  has others below it has a button to fold it and says how many are below it. "Expand all" and
  "Collapse all" do the whole tree. "Show API names" shows the API name next to each name.
- **Find a territory / Find a role:** type part of a name or API name (words in any order). The matches
  list under the box with the path above each ("Global › EMEA › UK"), so two nodes with the same name
  can be told apart. Press Enter or click one: the page shows only that node and everything below it,
  with "Showing UK and everything below it" and the path above it (each step is a link that goes up to
  that level). "Show whole hierarchy" goes back.
- **Summary** such as "412 territories, 7 levels", plus short notes: records whose parent is not in the
  list (shown at the top level), parents that loop back on themselves (the loop is cut and one of them
  is shown at the top level, and every one in the loop is marked "Parent loop"), and how many portal and community roles are left out.
- **Download for Excel (.csv)** saves what is shown (the whole tree, or the chosen branch), including
  folded nodes. The tree is in the cells: columns "Level 1" to "Level N", one name per row in the
  column for its level, then "API name" and "Path" (the full path from the top of the whole hierarchy).
  The file name has Territories or Roles, the model, and the branch name.

It reads (all `SELECT`, nothing else): `Territory2Model`, `Territory2` (one model), `UserRole` (roles
that are not portal roles, plus a `COUNT()` of the portal ones). Your user needs API Enabled and View
Setup and Configuration. Nothing is saved, in the browser or in a file.

Try it: `python tools/dev_server.py --no-org`, then open
<http://127.0.0.1:8765/hierarchy.html?demo=1> (made-up territories and roles). Against an org through
the dev server: `?dev=1`. The popup opens it as `hierarchy.html?host=<org host>`.

Not checked against a live org yet: the reads were tested only against faked answers, and the page only
in the demo.

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
2. Click the extension. It is a menu of tools: choose **Compare permission set groups**,
   **User access** or **Territory & role hierarchy**. A new tab opens, connected to that org. The compare page's header shows the org
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
  - Field rows (Read/Edit), object rows, system permissions, tabs, the names of Apex classes,
    Visualforce pages, apps, custom permissions, connected apps, custom metadata and external
    credential principals, the component lists and the user counts matched independent SOQL, line
    by line.
  - What a muting permission set takes away was checked item by item: the aggregate equals the
    components minus the effective mutes, for fields, objects, system permissions and tabs. One
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
| `extension/popup.*` | Toolbar popup: a menu of tools. Detects the org in the current tab and opens the chosen page |
| `extension/psg-compare.*` | The compare page |
| `extension/user-access.*` | The User access page (html, js, and a little extra css on top of `psg-compare.css`) |
| `extension/lib/useraccess.js` | Reads one user's access from the org (`searchUsers`, `readUserAccess`) |
| `extension/lib/usercompare.js` | Turns user access into rows and compares two users; CSV. Pure, no browser APIs |
| `extension/hierarchy.*` | The Territory & role hierarchy page (html, js, and extra css on top of `psg-compare.css`) |
| `extension/lib/hierarchy.js` | Builds, searches and exports a hierarchy (tree, branch, Excel layout). Pure, no browser APIs |
| `extension/lib/hierarchyread.js` | Reads territory models, territories and roles from the org (`SELECT` only) |
| `extension/lib/sfconn.js` | Session lookup and REST client (query with paging, describe) |
| `extension/lib/snapshot.js` | Reads one group into a snapshot |
| `extension/lib/compare.js` | Compares two snapshots; plain-language labels; CSV export. Pure, no browser APIs |
| `extension/lib/pick.js` | Matching for the group search box |
| `extension/lib/livereload.js` | Reloads the page on file changes while the dev server runs (unpacked copies only) |
| `tools/dev_server.py` | Local dev server: pages, read-only org proxy through the `sf` CLI login, live reload |
| `extension/samples/` | Two synthetic snapshots, two synthetic users, and a synthetic territory model set and role list for the demos and the tests (the hierarchy samples are written by hand, not by `make_samples.py`) |
| `tests/` | Offline tests and the sample generator |
