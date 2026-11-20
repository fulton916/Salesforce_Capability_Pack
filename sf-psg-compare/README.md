# sf-psg-compare

A Chrome extension with four read-only tools: **Compare permission set groups**, **Look up user
access**, **Territory & role hierarchy** and **Where is it used in flows?**.

It works in any org you can log in to. It uses the Salesforce login you already have in the
browser, so there is nothing to set up in the org. It only reads; it never changes anything.

## What each tool answers

Compare permission set groups:
- What is different between these two groups?
- Does group X have anything group Y doesn't?
- Is the sandbox version of a group the same as production?

Look up user access:
- What can this user access, and how do they get it (directly or through a group)?
- How do two users' access differ?

Territory & role hierarchy:
- What does the whole territory or role tree look like, and what is under this one branch?
- Can I get a branch into Excel?

Where is it used in flows?:
- I am about to change how Account records work. Which flows run when one is created, updated or deleted, in what order, and which other flows change or read Account records?
- I am about to change a field. Which flows use it, what does each one do with it (set it, check it, or just use it), and can I get the list into Excel?
- Which flows contain this text, or this record Id?

## Known limits

- Not yet checked from the toolbar button inside Chrome. The checks so far used a local test
  server (see "What has been tested").
- A group is only read correctly when its Status is **Updated**. If it is Outdated or Failed, the
  page says so; recalculate the group in Setup and compare again.
- Look up user access does not cover field or object access, what a permission set contains,
  sharing and record access, login history, or any change to a user.

## Territory & role hierarchy

The third tool shows the whole **territory** tree (Enterprise Territory Management) or the whole **role**
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
- **Show users** (next to "Show API names"): who is in each role or territory. Choose what to show for
  each person: Name, Username, Email or Salesforce ID ("Don't show" is the default, and then the page is
  as above). "Include inactive users" (off by default, shown only when users are shown) adds inactive
  users, marked "(inactive)". Each role or territory shows a count ("3 users", or "No users") and its
  users in muted text, sorted by what is shown; when there are more than 10, "Show all 25" opens the
  rest. Names in a list are separated by "; " (real text, so copying keeps them apart). The summary adds
  "5,812 active users" on Roles. On Territories it counts people and assignments separately, for example
  "2,971 active people in 6,207 territory assignments": a person in two territories is one person but
  appears in both rows, and the rows and the download count assignments. Users are read the first time this is turned on for
  a view and kept only while the page is open; changing the field or the inactive box does not read the
  org again. If the users cannot be read (for example your user may not see users) the page says so
  next to the tree and the tree still works. In a branch, only that branch's users are shown and counted.
  On Roles, people in portal or community roles are not read or shown; a note (whole tree only, not in a branch) gives how many (active ones, or all of them when "Include inactive users" is on). If that count cannot be read, the note is left out and the reason goes under Notes.
- The download, when users are shown, adds after "Path" a "Users" column (the count) and then "User 1",
  "User 2", ... in the same row as their role or territory, as many as the busiest row needs. Each cell
  holds what is chosen on the page, in the same order, with " (inactive)" when inactive users are
  included. **That file contains people's usernames or emails: handle it like the user list it is.** A role or territory with many users makes a wide file, one column per person (one role with about 1,650 users gives about 1,650 columns). This is on purpose: each person sits in their own cell, so Excel functions such as COUNTIF, XLOOKUP and filters work on them.
  With "Don't show" the file is exactly as before.

It reads (all `SELECT`, nothing else): `Territory2Model`, `Territory2` (one model), `UserRole` (roles
that are not portal roles, plus a `COUNT()` of the portal ones). Only when "Show users" is turned on it
also reads `User` (users in roles that are not portal roles, plus two `COUNT()`s of the portal ones; Roles view) or `UserTerritory2Association` with the user's
name, username, email and active flag (the model on screen; Territories view).
Active and inactive users are read together and filtered in the page. Your user needs API Enabled and
View Setup and Configuration, and to be allowed to see users for "Show users". Nothing is saved in the
browser. The only file is the CSV you download.

Try it: `python tools/dev_server.py --no-org`, then open
<http://127.0.0.1:8765/hierarchy.html?demo=1> (made-up territories, roles and users). Against an org through
the dev server: `?dev=1`. The popup opens it as `hierarchy.html?host=<org host>`.

Not checked against a live org yet: the reads were tested only against faked answers, and the page only
in the demo.

## Where is it used in flows?

Finds the flows that use an object, a field, a piece of text or a record Id, and shows the step inside each flow.

- One search box. Type an object (label or API name) and pick it: the page at once shows the **object view** (below).
  Then type a field of that object and pick it to see which flows use that field. Suggestions show the label first and
  the API name second. To look for a piece of text or a record Id instead, type it and choose "Find this text in flows".
  A record Id matches in its 15 and 18 character forms.
- From the toolbar menu the box starts filled in: on a field's page in Setup (Object Manager) the object and field (the
  field search runs), on a record page, an object's list view or an object's Setup page the object (the object view runs).
  Ids in a Setup address (01I objects, 00N fields) are turned into names with two small reads.
- By default it reads the active version of each active flow. "Also look in inactive flows and drafts" adds the latest
  version of every flow where that is not the active one (it applies to the object view too). Contents are read a few at a
  time, with "Reading flows: 37 of 212" shown, kept in memory for the page session, and reused for every search: a field
  search after the object view (or the reverse) reads nothing again.

**Object view** ("I am about to change how Account records work"):
- **Before the record is saved**, **After the record is saved** and **Before the record is deleted**: the record-triggered
  flows of that object, in the order Salesforce documents: active flows with a trigger order of 1 to 1000 first (lowest
  first, each showing "Trigger order 10"), then the flows with no trigger order, then 1001 to 2000. Flows with the same
  trigger order run in alphabetical order of their API names. Salesforce runs the flows with no trigger order in the order
  they were activated; that date is not available to the page, so they sit in a marked block, listed by API name in plain
  character order (capitals before lowercase, as Setup's Flow Trigger Explorer sorts them) and not numbered, with a plain note that their real order is not known. Flows that are
  not active do not run: they come last in their group, unnumbered, marked "Not active (does not run)", and show when
  "Also look in inactive flows and drafts" is ticked. Each flow shows its label, when it runs
  (created, updated, created or updated, deleted), active or not, its entry conditions in words ("Account Status equals
  Closed"; a formula is "has a formula condition"; none is "No entry conditions") and any scheduled or run-asynchronously
  paths. **Process Builder processes** on the object have their own part between "before" and "after": they run after the
  record is saved, before the after-save flows, and Salesforce does not promise an order among them, so they are listed
  by name and not numbered.
- **Runs on a schedule over these records**: scheduled flows whose start element names the object.
- **Other flows that change these records** (create, update or delete steps) and **other flows that only read them** (Get
  Records), each with its steps. A flow that both reads and changes the records is listed once, under "change", with
  all its steps; "only read" holds flows that change nothing.
- The object is matched by API name, never by label (two objects can share a label). The trigger object comes from the
  flow list's `TriggerObjectOrEvent.QualifiedApiName`, or from the flow's own start element when the list does not say.
- What the flow list alone says (the triggered flows, their order, when they run) shows first; the entry conditions, the
  schedules and the other flows fill in as the contents are read. "Download for Excel (.csv)" is available once everything
  is read: one row per flow step, or one row for a flow with none.
- No created or activation date is read, so the object view makes no extra call. Give each flow a trigger order in Setup
  (Flow Trigger Explorer, Edit Order) when the order matters. The CSV has a "Trigger order" column (blank when none) and a
  "Run order" column ("Runs in this order", "No trigger order: order not known" or "Not active").

**Field view**:
- Results: a summary ("Used in 7 flows, 5 of them active"), then one entry per flow with its type in plain words, active or
  not, which version was read, an "Open in Flow Builder" link, and its steps: "Update Records 'Update Account': sets Status__c".
  **sets** is a value put into the field (create or update records, an assignment), **checks** is a filter, a decision
  condition or an entry condition, anything else is **uses** (formulas, text, screens, actions). The field is found through
  `$Record`, `$Record__Prior`, record variables (Process Builder's current and old too), what Get Records stored, loop
  items (also loops over a related list such as `$Record.Contacts`, typed from the object's describe) and relationship
  paths such as `$Record.Account.Owner.Email`.
- **Possible matches** lists steps where a field of that name appears but the flow does not say which object it belongs to
  (for example a record variable with no type, or a relationship that can point at several objects), and steps that save a
  whole record from a variable ("saves a whole Account record, so it may set this field"). **Could not look inside**
  lists the flows whose contents Salesforce did not return, mainly flows from installed packages, so nothing is skipped
  silently; flows with a version Id have an "Open in Flow Builder" link. Raw error text is folded under "Technical details" and "Notes".
- "Download for Excel (.csv)": one row per flow step, with "How sure" saying Sure or Possible, and one row for each flow
  that could not be looked inside.
- Not covered: Apex, validation rules, workflow rules, page layouts and anything else that is not a flow; Apex-defined types.

Try it: `python tools/dev_server.py --no-org`, then open
<http://127.0.0.1:8765/flow-usage.html?demo=1> (made-up flows). Against an org through the dev server: `?dev=1`.
The popup opens it as `flow-usage.html?host=<org host>` plus `object=` and `field=` from the open Salesforce page.

Checked against a live sandbox (read-only, through the dev server): the flow list and contents reads and the matching on
real flows (about 260 readable flows, read in about a minute), and the object view's list of triggered flows for Account.
Not checked: the toolbar button inside Chrome, opening the CSV in Excel, the "Open in Flow Builder" links, Process Builder (the sandbox has none).

## Install (unpacked, for your own browser)

1. Copy this folder anywhere.
2. Chrome or Edge: open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode**.
4. **Load unpacked** → choose the `extension/` folder.
5. Pin the extension (puzzle icon → pin).

To share it with a team without the Chrome Web Store, zip the `extension/` folder; each person
loads it unpacked. For a managed rollout, an admin can publish it as an unlisted Web Store item or
push it by policy.

## What your user needs

- API Enabled.
- View Setup and Configuration (to read permission sets, groups and their permissions).
- For Look up user access, also access to see users.
- To name Apex classes and pages: read access to them is normal with View Setup. Items it cannot
  name are kept by Id with a note at the top.

## How to use

1. Open any page of the org in Chrome (Lightning, Setup or Classic) and log in as usual.
2. Click the Salesforce Capability Pack icon. On a Salesforce tab it shows "Connected to this org:"
   and four buttons: **Compare permission set groups** ("Find out how two permission set groups
   differ"), **Look up user access** ("See what a user can access, or compare two users"),
   **Territory & role hierarchy** ("See the whole territory or role tree; export it for Excel") and
   **Where is it used in flows?** ("Find the flows that use an object, a field or a record Id"). On
   any other tab the buttons are greyed out; go to a Salesforce tab and click the icon again.
3. The tool opens in a new tab, connected to that org.

### Compare permission set groups

1. Pick group A and group B: type any part of the name or API name (words in any order), then press
   Enter or click it. Or load a saved group file on either side.
2. Click **Compare**. Each press reads the org again, so the result is current. While reading big
   groups the page shows "Step n of 5".

The result starts with a sentence saying who has what, for example "Sales Rep has 4 things Sales
Manager doesn't. Sales Manager has 21 things Sales Rep doesn't." or "Sales Manager has everything
Sales Rep has, and 21 more." (or "Both groups have exactly the same access."). A muted line under it
says what is counted: system permissions, objects, fields, apps and other access, and tabs, not
permission sets. Under that:

- **Where the groups differ:** one card per area, each with totals for both groups and the number of
  things only one group has or that are set up differently. A card with no differences says
  "✓ Same in both". Click a card to open its list.
- **Worth a closer look:** broad access that only one group has (powerful system permissions, View
  All / Modify All on objects). Check these first.
- **Notes** (folded away): anything the tool could not read, with what to do.

The tabs, one list each:

| Tab | Shows |
|---|---|
| Summary | org, name, API name, description, status, users assigned, permission sets in the group, muting permission set, and how many system permissions, objects, fields, apps and other access items, and tabs each group has |
| System permissions | every system permission (Export Reports, View All Data…). Powerful ones are tagged |
| Objects | Read, Create, Edit, Delete, View All Fields, View All, Modify All per object |
| Fields | No access / Read / Edit per field, in one collapsible block per object |
| Apps and other access | apps, Visualforce pages, Apex classes, custom permissions, connected apps, named and external credentials, custom settings / metadata types, flows |
| Tab settings | shown, available (hidden by default) or hidden |
| What's inside | "Permission sets in each group" (with license, and the muting permission set too), and "Removed by muting" (what muting removes, by kind) |

Working with a list:
- Each list shows **Only differences** until you choose **Everything**. Status words are "Only
  <group name>", "Different" and "Same".
- Click a column heading to sort (A to Z; click again for Z to A). Text ignores case, numbers sort by
  value, empty cells come last, and access columns sort from least to most access. The sort is
  remembered per list and is kept when you switch views or search.
- Search ignores punctuation ("Account › Annual" finds Account's Annual Revenue) and opens matching
  objects in Fields.
- "Show API names" prints the API name under every row. Labels are shown by default.
- The number on each tab matches its card: things only one group has, plus things set up
  differently.

**Download** saves a CSV that opens in Excel (it has a "Kind of item" column):
- "This list, as shown (CSV for Excel)": the current view, with search and sort applied
- "All differences (CSV for Excel)": the whole comparison, differences only
- "Everything (CSV for Excel)": the whole comparison
- "Save <group name> to a file": saves a group so you can load it later

**Compare across orgs (sandbox vs production).** Save a group to a file, then load that saved group
file on either side later, in another org or with no org at all. Items are matched by API name
(namespace included), never by Id. The file holds permission names, object and field API names and
counts. It holds no record data and no user names, but it does hold the org name and host, so treat
it like any other org export.

**Net access, not the sum of the parts.** The result is what a user assigned to the group actually
gets: the component permission sets combined, minus the muting permission set.

**What muting removes.** "Removed by muting" lists an item only if it is muted, at least one
permission set in the group has it, and the group no longer has it. On a field, Read muted removes
Read and Edit; Edit muted removes Edit only. Saved group files from before this check still load;
their muted items are shown as "Removed by muting (not confirmed, older saved file)" because they
cannot say whether anything was removed.

### Look up user access

Type part of a name or username (words in any order) and pick the user from the list. Inactive
users are marked "Inactive". Add a second user under "Second user (optional, to compare)" to compare;
"Stop comparing" goes back to one user. It looks and works like the compare tool (cards, tabs,
"Only differences" / "Everything", "Show API names", search, Download).

| Area | What it shows |
|---|---|
| Profile | the profile and its user license |
| Role | the role |
| Permission set groups | groups assigned to the user; a muting permission set is shown as "Muting permission set: ..." |
| Permission sets | every permission set the user gets, and how: "Assigned directly", "Through group: ...", or both. Profile-owned sets and the summary sets Salesforce keeps for groups are left out |
| Permission set licenses | the permission set licenses assigned |
| Public groups, Queues | direct membership only. Membership through roles or groups inside groups is not shown |
| Territories | the territories the user is assigned to |

With two users, each list card always shows how many items both users have, how many only the first
has and how many only the second has (for example "5 permission set groups both have", "0 only Ann
has", "1 only Bob has"), then "✓ Same in both" when nothing differs. Profile and role cards show the
actual value for each user. The tab numbers count differences only, and the list starts on "Only
differences". A permission set one user has directly and the other gets through a group is marked
"Different".
**Download** offers "This list, as shown (CSV for Excel)" and "Everything (CSV for Excel)". Nothing
about users is saved: there are no user files, because they hold usernames.

If an area cannot be read, only that area says so in plain words (for example "Territories are not
turned on in this org"), and the raw error goes under "Technical details" or "Notes". For removing
access use `sf-user-access-teardown`.

## What has been tested

The offline tests cover the compare logic, the query and session handling, and the saved-file shape
against faked API responses. Everything below was read-only.

Compare permission set groups:
- A Developer Edition org with 22 groups. For every group, the aggregate permission set's object
  permissions matched its component permission sets. Spot-checked rows matched Setup. A compare of
  two groups takes about 4 seconds.
- A customer sandbox (Nov 2026) with 120 groups and 66 muting permission sets. Two groups had about
  2,000 field permissions, 120 objects and 340 apps/pages/code items each, both with muting sets;
  another pair had about 1,000 objects.
  - Field rows (Read/Edit), object rows, system permissions, tabs, the names of Apex classes,
    Visualforce pages, apps, custom permissions, connected apps, custom metadata and external
    credential principals, the component lists and the user counts matched independent SOQL, line
    by line.
  - What a muting permission set removes was checked item by item: the aggregate equals the
    components minus the effective mutes, for fields, objects, system permissions and tabs. One
    Salesforce quirk showed up (a muted object Edit that stayed in the aggregate); the tool does
    not report that as removed by muting.
  - Timing: about 4 to 5 seconds per large group, about 10 to 15 seconds to compare two large groups.

Look up user access:
- A Developer Edition org (search, permission sets, licenses and compare worked; territories are off
  there and are handled) and a large sandbox with about 6,000 users. On the sandbox, a user with 3
  permission set groups, 18 permission sets (9 only through groups), 11 licenses, 3 public groups,
  24 queues and 1 territory matched the org line by line, including a muting permission set, and a
  compare of two users worked.

Not tested:
- Muted apps, pages and code (no muting permission set in that org mutes any).
- The extension's own cookie session from the toolbar button inside Chrome (all live checks used the
  dev server).
- Opening the CSV in Excel.

Before relying on those, compare two groups you know well and check a few rows against Setup.

---

# For developers

## How it reads the org

All requests go from the extension page straight to `https://<your org>/services/data/v62.0/`.
Nothing is sent anywhere else. Everything is a read (`SELECT`, describe, `COUNT()`); nothing writes.

The permissions of a group come from its aggregate permission set (`PermissionSet` with
`Type = 'Group'`). Salesforce keeps that record as the component permission sets combined, minus the
muting permission set. It is only current when the group's Status is `Updated`. A muting permission
set can list things no permission set in the group gives, and Salesforce does not always apply a
mute to the aggregate, hence the "Removed by muting" check above. Per group it runs about 25 to 30 queries:

| Read | Query |
|---|---|
| Group | `PermissionSetGroup`, its aggregate `PermissionSet` (`PermissionSetGroupId`) |
| Contents | `PermissionSetGroupComponent`, then `PermissionSet` / `MutingPermissionSet`, license names |
| System permissions | every boolean `Permissions*` field of `PermissionSet` (from describe), in chunks |
| Objects / fields | `ObjectPermissions`, `FieldPermissions` where `ParentId` = aggregate permission set |
| Field labels | `FieldDefinition` (real field labels), one query per 20 objects, at most 3 at a time. Labels are the ones Setup shows, which can occasionally differ from the label in a page layout or describe (for example a standard field renamed in one place). Fields the reading user cannot see keep a name made from the API name. If the query fails, labels are made from API names and the notes say so |
| Setup access | `SetupEntityAccess`, then the named object per type (external credential principals through the Tooling API). Items that cannot be named are listed as "Name not available (Id …)" with a count in the notes |
| Tabs | `PermissionSetTabSetting` |
| Muting | the muting set's own permissions, fields, objects and tabs; then, for those items only, what the other permission sets give (`FieldPermissions`, `ObjectPermissions`, `PermissionSetTabSetting`, the muted `Permissions*` fields, `SetupEntityAccess`) |
| Assignments | `COUNT()` on `PermissionSetAssignment` |

Look up user access reads `User`, `PermissionSetAssignment`, `PermissionSetGroup`,
`PermissionSetGroupComponent`, `PermissionSet`, `MutingPermissionSet`, `UserLicense`,
`PermissionSetLicense`, `PermissionSetLicenseAssign`, `GroupMember` (with `Group`),
`UserTerritory2Association`. The user search runs in the org (LIKE, limit 50), so it works with
thousands of users. When the org's territory feature is off, the page does not ask for it.

The session is the browser's `sid` cookie for the org, found the same way Salesforce Inspector finds
it. It is held in memory for that tab only and never stored. Visible text says "license"; data keys
keep the old `licence` spelling so saved files still load. Saved group files use
`sf-psg-snapshot/2`; `/1` files still load.

## Report a bug or suggest an improvement

The popup ends with a small footer line, "Report a bug · Suggest an improvement · v0.4.0", and all four pages have the same two links at the top right. They open a new tab on GitHub with a short form already started: which
tool, the extension version and your browser (for example "Chrome 131"). You read it, add what
happened, and press Submit yourself.

- Nothing is sent from the extension. It only opens the GitHub page. It never puts your org name,
  address, user names or anything from the org into the link.
- You need a GitHub account with access to this repository (it is private). If GitHub shows a "not
  found" page, you are not signed in with an account that has access.
- Describe problems with made-up names. Do not paste usernames, record data, org IDs, session IDs
  or screenshots that show org data.

## Tests

Offline, Node 18 or later, nothing to install:

```
node tests/run_tests.mjs
```

`python tests/make_samples.py` rebuilds the sample files and the icons.

## Try it without an org

```
python tools/dev_server.py --no-org
```

Open <http://127.0.0.1:8765/psg-compare.html?demo=1> (two made-up groups from `extension/samples/`)
or <http://127.0.0.1:8765/user-access.html?demo=1> (two made-up users).

## Developing without reloading Chrome

`tools/dev_server.py` serves the pages and forwards their API calls to an org using the login the
Salesforce CLI already has, so a page can be tested against a real org in any browser tab:

```
sf org login web --alias my-sandbox        # once, if the CLI is not logged in to the org
python tools/dev_server.py --target-org my-sandbox
```

Open <http://127.0.0.1:8765/psg-compare.html?dev=1> or `user-access.html?dev=1`. The popup opens a
tool as `<page>?host=<org host>`.

- **Read-only.** Only GET requests to `/services/data/` are forwarded; anything else gets 405.
- **The token stays in the server.** The page never sees it. The server listens on 127.0.0.1 only
  and refuses requests addressed to any other host name.
- **Live reload.** Pages reload by themselves within about two seconds of a file change under
  `extension/`. This also works for the unpacked extension loaded in Chrome: unpacked extensions
  read their pages from disk, so page, JS and CSS edits need no "Reload" click while the dev
  server runs. Changes to `manifest.json` still need one.

## Files

| Path | What |
|---|---|
| `extension/manifest.json` | Chrome MV3 manifest (permissions: cookies, activeTab, tabs; Salesforce hosts only) |
| `extension/popup.*` | Toolbar popup: a menu of tools. Detects the org in the current tab and opens the chosen page |
| `extension/psg-compare.*` | The Compare permission set groups page |
| `extension/user-access.*` | The Look up user access page (html, js, and a little extra css on top of `psg-compare.css`) |
| `extension/lib/useraccess.js` | Reads one user's access from the org (`searchUsers`, `readUserAccess`) |
| `extension/lib/usercompare.js` | Turns user access into rows and compares two users; CSV. Pure, no browser APIs |
| `extension/hierarchy.*` | The Territory & role hierarchy page (html, js, and extra css on top of `psg-compare.css`) |
| `extension/lib/hierarchy.js` | Builds, searches and exports a hierarchy (tree, branch, Excel layout). Pure, no browser APIs |
| `extension/lib/hierarchyread.js` | Reads territory models, territories and roles from the org (`SELECT` only) |
| `extension/flow-usage.*` | The Where is it used in flows? page (html, js, and extra css on top of `psg-compare.css`) |
| `extension/lib/flowscan.js` | Looks inside one flow version for a field, text or an Id; also lists each record element's object and operation (get, create, update, delete), the trigger and how the flow starts (`startInfo`). Pure, no browser APIs |
| `extension/lib/flowobject.js` | The object view: groups, run order, entry conditions in words, changes and reads, CSV. Pure, no browser APIs |
| `extension/lib/flowread.js` | Reads the flow list (`FlowDefinitionView`) and one flow version at a time (Tooling `Flow.Metadata`), `SELECT` only |
| `extension/lib/urlcontext.js` | Turns a Salesforce page address into an object and field. Pure |
| `extension/lib/sfconn.js` | Session lookup and REST client (query with paging, describe) |
| `extension/lib/snapshot.js` | Reads one group into a snapshot |
| `extension/lib/compare.js` | Compares two snapshots; plain-language labels; CSV export. Pure, no browser APIs |
| `extension/lib/feedback.js` | Builds the GitHub new-issue link (tool, version, browser only). Pure, no browser APIs |
| `extension/lib/pick.js` | Matching for the group search box |
| `extension/lib/livereload.js` | Reloads the page on file changes while the dev server runs (unpacked copies only) |
| `tools/dev_server.py` | Local dev server: pages, read-only org proxy through the `sf` CLI login, live reload |
| `extension/samples/` | Two synthetic snapshots, two synthetic users, a synthetic territory model set and role list, each with made-up users (example.com addresses), and a synthetic set of flows (`flow_usage.json`), for the demos and the tests (the hierarchy and flow samples are written by hand, not by `make_samples.py`) |
| `tests/` | Offline tests and the sample generator |
