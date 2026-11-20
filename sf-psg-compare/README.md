# sf-psg-compare

A Chrome extension with four read-only tools: **Compare permission set groups**, **User access summary and comparison**,
**Territory & role hierarchy**, and **Why can a user see this record?**

It works in any org you can log in to. It uses the Salesforce login you already have in the
browser, so there is nothing to set up in the org. It only reads; it never changes anything.

## What each tool answers

Compare permission set groups:
- What is different between these two groups?
- Does group X have anything group Y doesn't?
- Is the sandbox version of a group the same as production?

User access summary and comparison:
- What can this user access, and how do they get it (directly or through a group)?
- How do two users' access differ?
- Do two users differ in call center, or in a custom setting (such as a bypass flag) that could make Salesforce behave differently for them?

Territory & role hierarchy:
- What does the whole territory or role tree look like, and what is under this one branch?
- Can I get a branch into Excel?

Why can a user see this record?:
- How can this user see the record I have open: owner, role hierarchy, a sharing rule, a team, a
  territory, a manual share, the org-wide default, View All?
- Why can one user see it and another can't, and what would change that?

## Known limits

- Not yet checked from the toolbar button inside Chrome. The checks so far used a local test
  server (see "What has been tested").
- A group is only read correctly when its Status is **Updated**. If it is Outdated or Failed, the
  page says so; recalculate the group in Setup and compare again.
- User access summary and comparison does not cover field or object access, what a permission set contains,
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
- For User access summary and comparison, also access to see users.
- To name Apex classes and pages: read access to them is normal with View Setup. Items it cannot
  name are kept by Id with a note at the top.

## How to use

1. Open any page of the org in Chrome (Lightning, Setup or Classic) and log in as usual.
2. Click the Salesforce Capability Pack icon. On a Salesforce tab it shows "Connected to this org:"
   and four buttons: **Compare permission set groups** ("Find out how two permission set groups
   differ"), **User access summary and comparison** ("See what a user can access, or compare two users"),
   **Territory & role hierarchy** ("See the whole territory or role tree; export it for Excel") and
   **Why can a user see this record?** ("Explain who can see the record open in this tab, and why").
   On any other tab the buttons are greyed out; go to a Salesforce tab and click the icon again.
   The record button reads the record Id from the address of the tab. On a Salesforce tab with no
   record open it stays enabled, says "Open a record first", and the page opens with an empty record
   box.
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

### User access summary and comparison

Type part of a name or username (words in any order) and pick the user from the list. Inactive
users are marked "Inactive". Add a second user under "Second user (optional, to compare)" to compare;
"Stop comparing" goes back to one user. It looks and works like the compare tool (cards, tabs,
"Only differences" / "Everything", "Show API names", search, Download).

| Area | What it shows |
|---|---|
| Profile | the profile and its user license |
| Role | the role |
| Call center | the call center the user is assigned to (read from the user's call center field, then the call center itself; "No call center" is a normal result, and the area says "not available" only if the org has no such field) |
| Permission set groups | groups assigned to the user; a muting permission set is shown as "Muting permission set: ..." |
| Permission sets | every permission set the user gets, and how: "Assigned directly", "Through group: ...", or both. Profile-owned sets and the summary sets Salesforce keeps for groups are left out |
| Permission set licenses | the permission set licenses assigned |
| Custom settings | hierarchy custom settings (the kind with values per user or profile, such as a "Bypass validation rules" box) where the user's value differs from the org default. Each row: setting and field, value for this user, where it comes from (this user, their profile, org default), org default. A count line says how many settings are affected, with plain notes for fields of special types that are not shown and for settings that could not be read (only if every setting fails does the area say "Not available"). In a compare, a setting that could not be read for one user is marked "Could not be read for <name>" and is not counted as a difference. The CSV carries these notes as "Note" rows. Salesforce's rule is applied field by field: user first, then profile, then org default, the first value that is not empty wins (an unchecked box counts as a value). In a compare, rows are matched by API name; a user with no row is at the org default |
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

### Why can a user see this record?

Open a record (Lightning or Classic), click the icon and choose **Why can a user see this record?**
The page shows the record (kind, name, owner and the org-wide default in plain words). To look at a
different record, paste its link or Id into the box and click "Use this record". Type a name in
"User" and, to compare, in "Second user (optional, to compare)", then click **Explain**.

- The sentence at the top ("Alice Smith can edit this record. Bob Jones can't see this record.")
  comes only from Salesforce's own answer for that user and record (`UserRecordAccess`).
- Under each user is every route we found that gives access, as a short chain of steps, for
  example "Shared by a sharing rule with public group 'EMEA Sales' -> 'EMEA Sales' includes public
  group 'UK Sales' -> 'UK Sales' includes role 'UK Manager' and the roles below it -> the user's role
  is below 'UK Manager'". Each route says what access it gives (view, edit, full), and says when the
  user's object permissions limit it. Like Salesforce, full access to a record needs Read, Edit and
  Delete on the object (or Modify All); Read and Edit without Delete is "edit", Read alone is "view".
  Territories that share a name are told apart by where they sit, for example "EM (under EMEA Region)".
- With two users, "Why the difference" lists, for each route the user with more access has, what the
  other user is missing and what would change it.
- If the routes we found do not match Salesforce's answer (access but no route, or a route but no
  access, or a different level), the page says so and lists likely reasons. It never presents a guess
  as the reason.
- "Copy explanation" copies the result as plain text for a ticket. Notes (folded) list what was not
  checked; raw errors are under "Technical details".
- If the record follows its parent (Controlled by Parent), the page names the parent, shows each
  user's access on it, and offers "Explain the parent record" (the chosen users stay selected). Seeing the parent is a route only
  when Salesforce says the user can see the record. Tasks and events also point to the person
  (contact or lead) they are about: a user who can see the related account but not that contact
  can still be refused (seen in a sandbox). The page then says the parent condition is met but not
  enough, and names the unseen person as the likely reason, or says it could not tell.
- "Why the difference" only says a user lacks a route after checking that user's own facts
  (territories, groups, share rows, owner). A route both users reach is compared by level, not listed
  as missing. When the user with more access reaches the record through the other user (a share to
  them, or because they own it), the page says the first user is above them instead of listing it as
  missing. A team route that only repeats the owner is shown once, as the owner route.

- **Cases and Opportunities: access through the account.** When the record has an account, the page also
  reads who the account is shared with (sharing rules, manual shares, the account team, territories) and
  who owns it, and shows the routes that give access to the account's cases or opportunities, in plain
  steps such as "The case belongs to account 'X' → the account is shared by a sharing rule with public
  group 'G', which gives view access to the account's cases → Jason is in 'G' through group 'H'". It also
  shows people above the account owner or an account team member in the role hierarchy. If the account
  gives no access to its cases or opportunities, there is no route. Salesforce's own View Sharing
  Hierarchy page may list more reasons for a user than this page does.

Not covered, and the page does not say it cannot exist: access as the manager of a territory member,
contacts, restriction and scoping rules, and Experience Cloud sharing sets.

Routes it looks for: no Read on the object at all (then nothing else matters, but never when
Salesforce says the user can see the record, and not for Task and Event, which have no object
permissions); owner; owner is a queue the user is in (also through groups inside groups), or the
user's role is above the role of a queue member; a role above the owner's role; sharing
rows (manual, sharing rule, account/opportunity/case team, territory, implicit, Apex reasons) given
to the user, to a public group (nested, loops are safe), role, role and subordinates, territory,
territory and subordinates, queue, or all internal users, and to someone below the user in the role
hierarchy; a share to a public group that "grants access using hierarchies" (members found down
through groups inside groups, role groups and territory groups, up to 3000 members, then the page
says it stopped), where the user's role is above a member's role; the record's territories against the user's territories (Accounts); child records the
user owns (Accounts); the org-wide default; the parent record; "View All" / "Modify All" on the
object; "View All Data" / "Modify All Data".

Not checked (also listed in the page's Notes): restriction rules and scoping rules, Experience Cloud
sharing sets, field-level access, and which specific sharing rule gave access (Salesforce's share row
does not name it, so the page says "a sharing rule"). Manager groups are not checked. The headline follows what the
user can actually do (view, edit, full); when sharing gives more than that (for example all access but
only View in the object permissions) the page says so in one line. An inactive user gets no answer from
Salesforce; the page says so and shows the routes as "would give". For a custom object the "Grant Access Using Hierarchies" setting cannot be read; it is
assumed to be on.

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

User access summary and comparison:
- A Developer Edition org (search, permission sets, licenses and compare worked; territories are off
  there and are handled) and a large sandbox with about 6,000 users. On the sandbox, a user with 3
  permission set groups, 18 permission sets (9 only through groups), 11 licenses, 3 public groups,
  24 queues and 1 territory matched the org line by line, including a muting permission set, and a
  compare of two users worked.

Why can a user see this record?:
- Read-only checks on a sandbox (the "Why can a user see this record?" fixes): a manager reaching an
  account through public groups that include managers, a manager over a queue-owned case, an
  activity (Task) with no object permission rows, and an account with all access but view-only object
  permissions, each now explained and agreeing with Salesforce's answer.
- The account rules (Cases and Opportunities) were checked by read-only queries on a sandbox against
  Salesforce's own access answer (UserRecordAccess) on a case and two opportunities.
- Offline tests: the route reasoning (owner, queue owner, role hierarchy, manual share, sharing
  rule to nested groups with loops, role and territory groups, team, org-wide default, parent, View
  All, no object Read), the mismatch with Salesforce's answer both ways, the two-user difference, the
  plain-text export, the record Id from Lightning, Classic and console addresses, and the reads against
  a faked org. The demo page was checked in Chrome (`?demo=1`, one and two users).
- NOT checked against a live org: the real field names of the share tables, which RowCauses really
  appear, the territory association field values, how `PermissionSetAssignment` lists permission set
  group components, and the group queries on a large org. The sandbox checks above covered only the fixes listed there.

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

Why can a user see this record? reads (all `SELECT`, `COUNT()` or describe): the record and its
object (describe, `EntityDefinition` for the org-wide default), `User` and `Group` (owner), the
record's share table (`AccountShare`, `OpportunityShare`, `CaseShare`, `LeadShare`, `ContactShare`,
`<Object>__Share` for custom objects, `<Object>Share` otherwise; the parent and access field names
come from describe), for a Case or Opportunity with an account also the account's `AccountShare` rows,
the account owner and the owner's role settings, and `AccountTeamMember`, `Group`, `GroupMember`, `UserRole`, `Territory2` (active model),
`UserTerritory2Association`, `ObjectTerritory2Association`, `PermissionSetAssignment`,
`PermissionSetGroup`, `ObjectPermissions`, `UserRecordAccess`, the team member objects and `COUNT()`
of child records. The groups a user is in are worked out upward, level by level, with a visited set
and a depth cap of 10, so loops cannot hang it.

User access summary and comparison reads `User`, `PermissionSetAssignment`, `PermissionSetGroup`,
`PermissionSetGroupComponent`, `PermissionSet`, `MutingPermissionSet`, `UserLicense`,
`PermissionSetLicense`, `PermissionSetLicenseAssign`, `GroupMember` (with `Group`),
`UserTerritory2Association`, `CallCenter` (by the Id in `User.CallCenterId`), `EntityDefinition` (custom settings), `Organization` (its Id), a describe of each custom setting and one read of each hierarchy setting. Hierarchy settings are told from list settings by a describe call each (only hierarchy settings have a `SetupOwnerId` field; describes are cached, so a second user costs none), done 6 at a time with progress shown. At most 300 custom settings are checked; if the org has more, the page says so. The user search runs in the org (LIKE, limit 50), so it works with
thousands of users. When the org's territory feature is off, the page does not ask for it.

The session is the browser's `sid` cookie for the org, found the same way Salesforce Inspector finds
it. It is held in memory for that tab only and never stored. Visible text says "license"; data keys
keep the old `licence` spelling so saved files still load. Saved group files use
`sf-psg-snapshot/2`; `/1` files still load.

## Report a bug or suggest an improvement

The popup ends with a small footer line, "Report a bug · Suggest an improvement · v0.4.0", and all four tool pages have the same two links at the top right. They open a new tab on GitHub with a short form already started: which
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
or <http://127.0.0.1:8765/user-access.html?demo=1> (two made-up users) or
<http://127.0.0.1:8765/record-access.html?demo=1> (a made-up account and two made-up users).

## Developing without reloading Chrome

`tools/dev_server.py` serves the pages and forwards their API calls to an org using the login the
Salesforce CLI already has, so a page can be tested against a real org in any browser tab:

```
sf org login web --alias my-sandbox        # once, if the CLI is not logged in to the org
python tools/dev_server.py --target-org my-sandbox
```

Open <http://127.0.0.1:8765/psg-compare.html?dev=1> or `user-access.html?dev=1`, or
`record-access.html?dev=1&record=<record Id>`. The popup opens a tool as `<page>?host=<org host>`
(the record tool adds `&record=<record Id>`).

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
| `extension/user-access.*` | The User access summary and comparison page (html, js, and a little extra css on top of `psg-compare.css`) |
| `extension/lib/useraccess.js` | Reads one user's access from the org (`searchUsers`, `readUserAccess`) |
| `extension/lib/usercompare.js` | Turns user access into rows and compares two users; CSV. Pure, no browser APIs |
| `extension/hierarchy.*` | The Territory & role hierarchy page (html, js, and extra css on top of `psg-compare.css`) |
| `extension/lib/hierarchy.js` | Builds, searches and exports a hierarchy (tree, branch, Excel layout). Pure, no browser APIs |
| `extension/lib/hierarchyread.js` | Reads territory models, territories and roles from the org (`SELECT` only) |
| `extension/record-access.*` | The Why can a user see this record? page (html, js, and extra css on top of `psg-compare.css` and `user-access.css`) |
| `extension/lib/recordaccess.js` | `recordIdFromUrl`, the route reasoning, the two-user difference, the verdict and the plain-text export. Pure, no browser APIs |
| `extension/lib/recordaccessread.js` | Reads the facts for it from the org (`SELECT`, `COUNT()` and describe only; each area fails softly into notes) |
| `extension/lib/sfconn.js` | Session lookup and REST client (query with paging, describe) |
| `extension/lib/snapshot.js` | Reads one group into a snapshot |
| `extension/lib/compare.js` | Compares two snapshots; plain-language labels; CSV export. Pure, no browser APIs |
| `extension/lib/feedback.js` | Builds the GitHub new-issue link (tool, version, browser only). Pure, no browser APIs |
| `extension/lib/pick.js` | Matching for the group search box |
| `extension/lib/livereload.js` | Reloads the page on file changes while the dev server runs (unpacked copies only) |
| `tools/dev_server.py` | Local dev server: pages, read-only org proxy through the `sf` CLI login, live reload |
| `extension/samples/` | Two synthetic snapshots, two synthetic users, a synthetic record with two users for the record demo, and a synthetic territory model set and role list, each with made-up users (example.com addresses), for the demos and the tests (the hierarchy samples are written by hand, not by `make_samples.py`) |
| `tests/` | Offline tests and the sample generator |
