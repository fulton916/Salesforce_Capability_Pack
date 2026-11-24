# Salesforce Capability Pack: Chrome extension

(Formerly the `sf-psg-compare` folder. Saved group files still use the schema ids `sf-psg-snapshot/1` and `/2`.)

A Chrome extension with eight read-only tools: **Compare permission set groups**, **User access summary and
comparison**, **Territory & role hierarchy**, **Why can a user see this record?**, **Where is it used in flows?**,
**Page details for a ticket**, **Error Tracer: read a debug log** and **Where does a user get this permission?**.

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
- Who is in each Einstein Activity Capture configuration (also past the 500 users Setup lists), who is not connected, and can I get those lists into Excel?

Territory & role hierarchy:
- What does the whole territory or role tree look like, and what is under this one branch?
- Can I get a branch into Excel?

Why can a user see this record?:
- How can this user see the record I have open: owner, role hierarchy, a sharing rule, a team, a
  territory, a manual share, the org-wide default, View All?
- Why can one user see it and another can't, and what would change that?

Where is it used in flows?:
- I am about to change how Account records work. Which flows run when one is created, updated or deleted, in what order, and which other flows change or read Account records?
- I am about to change a field. Which flows use it, what does each one do with it (set it, check it, or just use it), and can I get the list into Excel?
- Which flows contain this text, or this record Id?

Page details for a ticket:
- Who am I, which org is this, and which page was I on, in a form I can paste into a support ticket?

Error Tracer: read a debug log:
- What failed, where, and for which user, in a debug log a user's failing action left behind?
- Which validation rule, flow step or line of Apex was it?

Where does a user get this permission?:
- Does this user get Delete on Account (or View Setup, or Edit on a field), and from which profile, permission set or group?
- Which permission set inside a group gives it, and did a muting permission set take it away?

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

Try it: `python dev/dev_server.py --no-org`, then open
<http://127.0.0.1:8765/tools/hierarchy/hierarchy.html?demo=1> (made-up territories, roles and users). Against an org through
the dev server: `?dev=1`. The toolbar menu opens it as `hierarchy.html?host=<org host>`.

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

Try it: `python dev/dev_server.py --no-org`, then open
<http://127.0.0.1:8765/tools/flow-usage/flow-usage.html?demo=1> (made-up flows). Against an org through the dev server: `?dev=1`.
The toolbar menu opens it as `flow-usage.html?host=<org host>` plus `object=` and `field=` from the open Salesforce page.

Checked against a live sandbox (read-only, through the dev server): the flow list and contents reads and the matching on
real flows (about 260 readable flows, read in about a minute), and the object view's list of triggered flows for Account.
Not checked: the toolbar button inside Chrome, opening the CSV in Excel, the "Open in Flow Builder" links, Process Builder (the sandbox has none).

## Page details for a ticket

Use it when something goes wrong and you need to raise a ticket. On any Salesforce page, click the
extension icon, then **Page details for a ticket**. A page opens with plain labelled lines:

- **When**: your local time with time zone, and UTC.
- **Org**: org name, Org Id, production or sandbox (and the sandbox name when the address shows it),
  instance and My Domain host.
- **You**: name, username, profile, role, language, locale, time zone and user type.
- **Page**: record page, list view, Setup page, home or other; the object, and for a record page the
  record Id, name, record type, owner, and who last changed it and when. For a list view, its name.
  A Setup page is named as Salesforce's Setup shows it (for example "Company Information"): the name is read
  from the title on the browser tab (only that name, never the page contents), or from a built-in list when
  the tab cannot be read, or made from the address as a last resort. Object Manager pages read like the
  breadcrumb, for example "Object Manager > Fields & Relationships".
- **Browser and extension**: browser and extension version.

Type what happened in the box at the top (optional; it goes first in the text), then click **Copy**
or **Download (.txt)** and paste or attach it in your ticket. If one part cannot be read (for example
you are not allowed to see the record), the rest still shows, that part says why, and the raw message
is under "Technical details" on the page only. A failure says why in plain words: Salesforce could not be
reached (check your connection, reload the Salesforce tab and try again), your session expired, your user
may not be allowed, or simply that it could not be read.

What it never includes: the session id, cookies, the page contents, or any address parameter other
than the list view name. Only the page's path is used, so tokens and login parameters in the address
are dropped. No field values are read beyond the record's name, type, owner and change dates.
Nothing is sent anywhere and nothing is saved; the note is not kept.

Your own note is left as you typed it, except that anything shaped like a login session id or token
(a `00D...!...` session id, `Bearer ...`, `sid=`, `access_token=` and similar) is removed, and a line
near the buttons says so. Text like "error code=5" is kept. Older addresses of the form
`/one/one.app#/...` hide which record you were on (the part after `#` is never used), so the Page area
says so and asks you to open the record again and use the button from there.

**Privacy note:** the text contains your org's details (org name and Id, your username, record names).
Paste it only into your company's own ticket system.

Try it: `python dev/dev_server.py --no-org`, then open
<http://127.0.0.1:8765/tools/page-details/page-details.html?demo=1> (made-up details). The toolbar menu opens it as
`tools/page-details/page-details.html?host=<org host>&url=<cleaned address>`. Checked read-only against a sandbox (org, user, record pages, a list view, a Setup page and home). Not checked: opening it from the toolbar button in Chrome, and the real clipboard.

## Error Tracer: read a debug log

Use it when a user hit an error and you want to know **what failed, where, and for which user**
without reading a debug log by hand. The page does not turn logging on (you do that in Setup, see
below); it reads logs Salesforce has already written.

1. In Setup, type **Debug Logs** in Quick Find. Under User Trace Flags choose **New**. The traced user must be
   the person who does the failing action: for **Traced Entity Type** choose User, and for **Traced Entity Name** pick that person. Set **Start Date** and
   **Expiration Date** to cover the action (a trace flag lasts up to 24 hours). **Debug Level** is a
   lookup: typing a name finds nothing, so use the search icon to pick an existing level, or **New Debug
   Level** (a small window) to make one. Set Apex Code at Debug or finer, and Database, Validation and
   Workflow at Info or finer (flows are only recorded when Workflow is at Info or finer). Logs made by
   running Apex from the Developer Console or the command line use their own levels, so some areas may
   not be recorded.
2. Ask the user to repeat what failed.
3. Open **Error Tracer: read a debug log** from the toolbar menu, press **Refresh the list**, and pick the log.

The list shows the newest logs first: when (your local time, with the time zone named), the result, whose log, what ran and the
size. You can show only logs whose result is not Success (ticked, the box hides logs whose result is Success, and a save stopped by a validation rule can still say Success), or only one user's. Picking a log shows a
headline ("2 problems found in this log" or "No errors found in this log"), who and when, and one card per
finding with the message in plain words, how long after the log started it happened (the log's own clock stays in the folded lines), where it happened (for example "Apex trigger AccountTrigger,
line 3"), what was running at the time, and a folded **Log lines** block with the raw lines around it.
**Copy what failed** copies the same thing as plain text for a ticket.

What it picks out: unhandled Apex errors (with the stack trace turned into "Apex class X, method y, line
n"), saves that failed (a validation rule, a required field, a duplicate, a locked record, missing
access and so on, with the kind of record being saved), validation rules (which rule, on which
object, the message the user saw), flows that failed (the flow, the failing step; to find other
flows that use the same flow, open "Where is it used in flows?" from the menu), Salesforce limits (too
many queries, CPU time), and errors that were raised but may have been handled by the code (listed
separately, never as the cause). The line under the headline says once when the log was cut off, or when a category was not
recorded at a level high enough; Notes say what to change in Setup (so "no flow errors" is never claimed when flows were not recorded).

What it reads: `ApexLog` (one `SELECT` for the list, newest 100, and one `GET` of a log's body). GET and
`SELECT` only. It never creates or changes a trace flag, a debug level or anything else.

Known limits: Salesforce keeps logs only for a limited time (system debug logs about 24 hours) and cuts
off very large logs (the part after the cut, which may hold the error, is missing). Seeing other
people's logs may need extra permission in the org. Some flow and validation messages are read from the
documented log layout and have not been checked against every org's logs. Nothing is kept after you
close the page.

Try it: `python dev/dev_server.py --no-org`, then open
<http://127.0.0.1:8765/tools/error-tracer/error-tracer.html?demo=1> (five made-up logs: a trigger error, a
validation rule, a failed flow, a clean log and a cut-off one). Not checked against a real org's logs.

## Where does a user get this permission?

Use it when you need to know **where one user gets one permission**: which profile, permission set or permission
set group gives it, which permission set inside a group, and what muting took away. It is the question behind
Setup's "User Access Summary" and its "Access Granted By" action, answered on one page and copyable for a ticket.

1. Open **Where does a user get this permission?** from the toolbar menu and pick the user (type part of a name or username; inactive users are tagged).
2. Choose the kind: **A system permission** (search by name, for example Modify All Data or View Setup), **Access to an object** (search the object, then a level: Read, Create, Edit, Delete, View All or Modify All) or **Access to a field** (the object, then the field, then Read or Edit). Lists show up to 100 matches; keep typing to narrow them. Every list works with the keyboard (arrow keys, Enter, Escape).
3. Press **Find where it comes from**.

The answer starts with one sentence ("Yes. Casey Sample gets Delete on Account from 2 places.", "No. ... does not get ...: not given anywhere.", "No. ... the group "X" would give it, but its muting permission set removes it."). It never says "not given anywhere" when something could not be read: it says "Not sure" and what could not be checked. Then, as cards (a label first, the API name small):

- **Gives it**: the profile, a permission set assigned directly, or a permission set group (naming each permission set inside it that gives it). A permission set that is both direct and in a group shows both. An assignment that ends on a date shows the date and time in your own time zone (with its abbreviation, also in the copied text). A source that is listed outright and also covered by View All Data (or another permission that includes it) says so: 'It is also covered by "View All Data", which it includes.' A source that gives it outright and by implication is one card with the reason.
- **Also covers it**: counted as giving it, because another permission covers this one: View All Data covers object Read and View All, Modify All Data covers Create, Edit, Delete and Modify All too, and View All Fields (on the object, or Global) covers field Read. Modify All Data and View All Data do not override field permissions, and nothing covers field Edit.
- **Removed by muting**: the group, the permission sets inside it that give it, and the muting permission set that takes it away. Not counted.
- **In a group but not passed on**: a permission set inside a group has it, nothing muted it, but the group's combined permissions do not have it (the page says a likely reason is that muting removes something it depends on). If the group is still being recalculated (status not Updated) the page says it is not sure instead.
- **Needs session activation**: session-based permission sets or groups that contain it. Not counted as giving it.
- **Not active**: assignments that have expired, were revoked or are not active and contain it. Not counted. Salesforce deletes an expired assignment soon after it expires, so this is rare. If a person has the same set or group assigned twice, the better one counts (an active one beats one that has ended).
- **Could not be checked**: what could not be read (a group's parts, a group still being recalculated, a directly assigned permission set you are not allowed to see).
- For a field, **Access to the object**: Read (or Edit, for Edit on the field) on the object is needed for field access to work, and the page says whether the user has it and from where. A field the user is "given" without that object access says it does not work. Some objects (for example Task and Event) have fields that field permissions control but are not set by object permissions at all: for those the page says access to the object is not checked here, and does not say the field does not work.
- An inactive user is said to be inactive: they cannot log in, so nothing applies now.

After an answer, changing the **Level** redraws it from what was already read, with no new read. Changing the user or the permission clears the answer. **Copy the answer** puts the org name, the user's name and username, the permission (label and API name), the answer, every section, the notes and the date and time with its time zone on the clipboard as plain text (if the browser blocks copying, a box with the text appears to select and copy).

If you type a field that is not in the list, the list says that fields not listed (required fields, Name, system fields) are not controlled by field permissions and everyone with access to the object sees them. A field listed twice by Salesforce under the same label (Account.Parent and Account.ParentId) is one field and appears once.

What it reads (GET and `SELECT` only; nothing is written and nothing is kept after you close the page): the org's API versions (it asks for the newest one for this page only), `describe` of `PermissionSet`, `ObjectPermissions` and `FieldPermissions` (for the lists; the first read of the field list is about 1 MB in a large org), then `User`, `PermissionSetAssignment`, `PermissionSet`, `PermissionSetGroup`, `PermissionSetGroupComponent`, `MutingPermissionSet`, `ObjectPermissions` and `FieldPermissions` for the one user and permission. A group's combined permission set (which has muting applied) is the truth for what the group gives. Only the user and the assignments are required: if something else cannot be read the page says so in plain words and the raw Salesforce text is under "Technical details".

Not checked in this version: permission set licenses, sharing, and access to Apex classes and Visualforce pages. The user's license can also limit what a permission does. On an API version without expiry or revoked details for assignments, an assignment that has ended may still be counted (a note says so). A session-based set or group is always listed under "Needs session activation": Salesforce does not tell this page whether it was activated.

Try it: `python dev/dev_server.py --no-org`, then open
<http://127.0.0.1:8765/tools/who-grants/who-grants.html?demo=1>. The demo has a made-up org with three users (one inactive) and a list of things to try at the top of the page. Checked read-only in a developer org through the dev server: the lists (system permissions, objects, fields), a profile, a directly assigned set, a group with a muting permission set, a session-based set, an expiry date and access from View All Fields. Checked again after a fix for asking about Modify All Data, View All Data or View All Fields (Global), for a test user and an administrator in a developer org: system permissions, object levels and fields all matched a separate query. Not checked in a real org: a group that is not Updated, an expired or revoked assignment, an inactive user, and View All Data or Modify All Data covering an object. Not checked: opening it from the toolbar button in Chrome and the real clipboard.

## Install (unpacked, for your own browser)

New to GitHub or to loading an extension? Follow the [step-by-step instructions](../README.md#install-the-chrome-extension-developer-mode-about-2-minutes) in the main README.

1. Copy this folder anywhere (it must not contain a file or folder whose name starts with `_`, such as `__pycache__`; Chrome refuses to load it).
2. Chrome or Edge: open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode**.
4. **Load unpacked** → choose this `chrome-extension` folder (the one with `manifest.json` directly inside).
5. Pin the extension (puzzle icon → pin).

To share it with a team without the Chrome Web Store, zip this folder; each person
loads it unpacked. For a managed rollout, an admin can publish it as an unlisted Web Store item or
push it by policy.

## What your user needs

- API Enabled.
- View Setup and Configuration (to read permission sets, groups and their permissions).
- For User access summary and comparison, also access to see users.
- For Error Tracer, permission to see debug logs (seeing other people's logs may need more; ask your administrator).
- For Where does a user get this permission?, access to see users, permission sets, groups and their object and field permissions (View Setup and Configuration is normal).
- To name Apex classes and pages: read access to them is normal with View Setup. Items it cannot
  name are kept by Id with a note at the top.

## How to use

1. Open any page of the org in Chrome (Lightning, Setup or Classic) and log in as usual.
2. Click the Salesforce Capability Pack icon. On a Salesforce tab it shows "Connected to this org:"
   and eight buttons: **Compare permission set groups** ("Find out how two permission set groups
   differ"), **User access summary and comparison** ("See what a user can access, or compare two users"),
   **Territory & role hierarchy** ("See the whole territory or role tree; export it for Excel"),
   **Why can a user see this record?** ("Explain who can see the record open in this tab, and why"),
   **Where is it used in flows?** ("Find the flows that use an object, a field or a record Id") and
   **Page details for a ticket** ("Copy who you are, which org and which page, to paste into a
   ticket"), **Error Tracer: read a debug log** ("See what failed, where and for which user, from a
   debug log") and **Where does a user get this permission?** ("Find every profile, permission set and group that
   gives a user one permission"). On any other tab the buttons are greyed out; go to a Salesforce tab and click the icon again.
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
| Custom settings | hierarchy custom settings (the kind with values per user or profile, such as a "Bypass validation rules" box) where the user's value differs from the org default. Each row: setting and field, value for this user, where it comes from (this user, their profile, org default), org default. A count line says how many settings are affected, with plain notes for fields of special types that are not shown and for settings that could not be read (only if every setting fails does the area say "Not available"). In a compare, a setting that could not be read for one user is marked "Could not be read for <name>" and is not counted as a difference. The CSV carries these notes as "Note" rows. Salesforce's rule is applied field by field: user first, then profile, then org default, the first value that is not empty wins (an unchecked box counts as a value). In a compare, rows are matched by API name; a user with no row is at the org default. Values of fields whose name or label looks like a key, token, secret, password or credential (or "private") are shown as "Hidden (looks like a key)" on the page and in the CSV, so an exported file is safe to share; a note says so. Checkboxes are never hidden |
| Email and calendar (Einstein Activity Capture) | the user's configuration (by name), connection status in plain words (Connected, Waiting to connect, Starting up, Processing, Needs attention, Idle, Turned off, ...), the recommended action, whether contacts and events are synced, whether the terms were accepted, and whether the user is assigned "Directly" or "Through the profile X" (or both). A blank status reads "Not connected yet (no status)"; a user who is assigned but has no status row reads "Assigned, not connected yet". Only users whose status is Connected count as connected. In a compare, setups are matched by configuration name. The status's API name shows under "Show API names". If the org has no Einstein Activity Capture (or you cannot see it) the area says "Einstein Activity Capture is not turned on in this org, or you can't see it" and the rest of the page works |
| Public groups, Queues | direct membership only. Membership through roles or groups inside groups is not shown |
| Territories | the territories the user is assigned to |

**Who is in each email and calendar configuration (Einstein Activity Capture).** A panel on the same page, which does not need a user picked first. Setup lists only the first 500 users of a configuration and has no export; this panel reads everything (paged, with a count of what has been read so far) and groups the users by configuration: one section per configuration with its name, the number of members, and a button "This configuration (CSV for Excel)". Columns: name, username, email, active, how assigned ("Directly" or "Through the profile X", or both), connection status in plain words, contacts synced and events synced. When a configuration is assigned to a profile, every user of that profile (active and inactive) is a member, once, even if the user is also assigned directly. A configuration whose name cannot be found reads "Unnamed configuration (Id 063...)" with the full Id, so you can match it on Setup's Configurations tab (which shows the Id). The **Show** selector switches the lists: Everyone, Not connected, Inactive users still assigned (a clean-up list), Connected but nothing synced yet (status Connected, and both contacts and events are known to be not synced; a blank answer is unknown and is not flagged), and "Has access but is in no configuration". The last one lists active users who have the permission "Use Einstein Activity Capture" or "Use Einstein Activity Capture Standard" (from their permission sets, profile or permission set groups) and are in no configuration, directly or through a profile; if one of the two permissions does not exist in the org the other is used, and if neither can be read a plain note says so and the rest still works. The search box (name, username, email, configuration, status; every word must match) and "Show API names" apply to all lists. At the top: users connected and not connected, how many inactive users are still assigned, how many are connected with nothing synced, and how many have access but are in no configuration; counts by configuration and by status are folded below. **Download** gives Everyone in a configuration, What is shown now, and Users in no configuration, as CSV for Excel. The summary counts people, not rows: a user in two configurations counts once, and is connected if any of their rows is Connected. A configuration with no users is not shown: Salesforce does not let the extension read the list of configurations (no such object was found in a real sandbox through REST, Tooling or Metadata), so Setup > Einstein Activity Capture > Configurations lists them all, with their Id; the panel says so. For one user with no setup the area reads "Not in any Einstein Activity Capture configuration." Only ACTIVE counts as connected, so a user whose status is Idle also appears under "not connected". Each configuration shows its first 200 members and a "Show 200 more" button so a large org does not freeze the page; the downloads always have everyone.

**Prepare a change: add, move or remove users (issue #42).** The extension stays read-only: it never changes your org. This part of the panel builds the text of an Einstein Activity Capture change, and you load it yourself, with Salesforce Inspector (Data Import) or Data Loader. Open "Prepare a change" in the panel after "Show everyone".
- *Pick users:* tick boxes on the member rows (one row is one user in one configuration), "Select all N shown" on each section, "Select everything shown" for the current Show filter, a pasted list of usernames or emails (one per line or separated by commas; looked up read-only on User, in batches; names that match nobody are listed, and an email that is on several users picks nobody), or the "Has access but is in no configuration" list. Your picks stay when you change the Show filter. A new "Show everyone" clears them.
- *Pick the change:* **Add to** (insert `AssignedId`, `ConfigurationId` on `UserEmailCalendarSync`), **Move to** or **Remove from its configuration**. Add and Move need a target configuration: choose a known one, or type an Id (063 plus 12 or 15 letters or digits, 15 or 18 characters in all) for a configuration that has no users yet. Copy the Id from Setup > Einstein Activity Capture > Configurations. The page says so next to the box.
- *How Remove works.* Every `UserEmailCalendarSync` row has the placeholder Id `000000000000000AAA` in real orgs, so those rows cannot be updated or deleted by Id, and Data Loader cannot remove a user from a configuration that way. In a configuration of more than 500 users, a user leaves it when their Einstein Activity Capture permission is removed. So Remove reads each picked user's permission assignments that grant it (`PermissionSetAssignment` where the permission set has "Use Einstein Activity Capture" or "... Standard"; read only; one permission field is enough if the other does not exist in the org) and builds a Delete of those assignments: Inspector Action **Delete**, Object **PermissionSetAssignment**, one column `Id`. Per user:
  - every granting assignment can be deleted (none is owned by a profile): they are listed, and the preview says that a user with more than one loses access only when all are deleted;
  - one of them comes from their profile: the user is skipped ("Their profile gives them Einstein Activity Capture ... change it on the profile, or the user's profile, in Setup"), and none of their assignments is listed;
  - none found: skipped ("No Einstein Activity Capture permission was found ... it may already be removed; click Show everyone to read again");
  - a user in a configuration only through a profile's assignment is skipped (change it in Setup > Einstein Activity Capture > Configurations), and so is a user who is directly in more than one configuration, because removing the permission takes them out of all of them.
  Inactive users can be removed (but not moved: they could not be added to the new configuration). A permission set group's assignment is named by the group's label.
- *Move* is three steps, each with its own copy and download buttons and its own Inspector steps: (1) the Remove text above, (2) give the permission back (Insert on `PermissionSetAssignment`, in one table for permission sets, `AssigneeId, PermissionSetId`, and one for groups, `AssigneeId, PermissionSetGroupId`, so no cell is blank), (3) Add to the target configuration (`AssignedId, ConfigurationId`). Load each step only after the one before has finished, and click "Show everyone" after step 1 to check that they left the old configuration. Giving the permission back does not put them back in the configuration by itself; step 3 does. Move no longer updates `UserEmailCalendarSync` rows by Id.
- *Preview first.* Nothing is built until the preview is shown: counts of users and of assignments to delete, the names, every permission set and group involved with how many picked users it affects and a warning for each (deleting the assignment takes away everything else in that permission set or group from those users, not only Einstein Activity Capture), and what is skipped and why. Add skips users already in the target, inactive users, users who are already directly in another configuration (use Move) and users who are in only through a profile. Move also skips users already in the target and inactive users. Pasted names that match nobody are listed. The same user picked twice is listed once ("N picks were the same assignment and are listed once"). Move and Remove show "This changes who captures email and calendar activity. Check the preview first." and a note that we have not verified the load in a real org.
- *Output:* "Copy for Salesforce Inspector" (tab-separated, API field names as the first line: Excel paste format; if the browser refuses to copy, the text shows in a box with "Select all and copy") and "Download CSV (Data Loader)", for every table. The output holds only API names and Ids, never names, usernames or emails.
- *Files:* the Data Loader CSV has no byte order mark, so the first header is read as `Id`, not `﻿Id`.
- *Undo of a Remove,* two steps in this order: (a) give the permission back (Insert on `PermissionSetAssignment`: one table for sets, one for groups), then (b) put them back in the configuration (the Add text, `AssignedId, ConfigurationId`, to their original configuration). Giving the permission back does not put them back in the configuration by itself. A Move is undone by Move with the old configuration as the target. An add cannot be undone this way: read again and use Remove.
- *Steps shown on the page:* Salesforce Inspector, Data Import; Action: Insert or Delete; Object: `PermissionSetAssignment` or `UserEmailCalendarSync`; Format: Excel; paste; Import; then click "Show everyone" again to check the result. The menu words are how Salesforce Inspector names them as far as we know; we have not checked them in a real Inspector.
- Not verified live: the permission query, the load itself (our sandboxes are read-only for us), whether removing the permission takes a user out of a configuration of 500 or fewer users, and whether a group assignment needs `PermissionSetId` besides `PermissionSetGroupId` in an Inspector insert (we send only `PermissionSetGroupId`).

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
- Where Salesforce's own View Sharing Hierarchy page words the reason, a small grey tag such as
  "Salesforce: Manager of Territory Member" sits next to the route (and is in the copied text), so the two pages
  can be compared. Our wording stays as it is. Tags are shown only for reasons checked on that page
  ("Manager of Territory Member", "Manager of Group Member", "Manager of User", "Manager of Queue Member"); other routes have no tag.
- When you explain the same record again on the page, who it is shared with is not read again. The results then say
  so in one small line ("Who this record is shared with was read at 14:32 ... Read it again"); "Read it again" reads it afresh.
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

- **Cases, Opportunities and Contacts: access through the account.** When the record has an account, the page also
  reads who the account is shared with (sharing rules, manual shares, the account team, territories) and
  who owns it, and shows the routes that give access to the account's cases, opportunities or contacts, in plain
  steps such as "The case belongs to account 'X' → the account is shared by a sharing rule with public
  group 'G', which gives view access to the account's cases → Jason is in 'G' through group 'H'". It also
  shows people above the account owner or an account team member in the role hierarchy. If the account
  gives no access to those records, there is no route. A contact whose org-wide default is Controlled by Parent gets no account routes: its access follows the account itself, as shown by the parent. Salesforce's own View Sharing
  Hierarchy page may list more reasons for a user than this page does.

Restriction rules and scoping rules: the page reads the active ones on the record's object and names them for each user. A
restriction rule that applies to the user and whose filter leaves the record out is worded by its criteria ("should hide"; the page
only reads the rule, nobody checked by logging in as the user), with its criteria as Salesforce stores them. When Salesforce already says the
user cannot see the record, such a rule "would also hide" it and is not offered as the reason; a rule that applies but lets the record through, or does not apply to the
user, is said so. Scoping rules are shown as changing what the user sees by default in list views and searches, never as taking access
away. Rules with criteria too complex to check (parentheses, IN, dates, fields through a relationship) are shown as "may hide it". An
object with no active rules says so; if the rules could not be read the page says that instead of "none". Salesforce's own answer at
the top may not include restriction rules (in a test it still said "can view" for a user a rule should hide), so when it says "can view" the
headline says so in the same sentence ("Salesforce says M can view this record, but restriction rule 'X' should hide it from them."). With two
users, a rule that hides the record for one and not the other shows in "Why the difference" (short form), and the headline does not say
"They have the same access" but that Salesforce gives them the same access and the rule should hide it from one only. A text compared
with a number in a rule is "could not be checked" (may hide).

Not covered, and the page does not say it cannot exist: Experience Cloud sharing sets.

Routes it looks for: no Read on the object at all (then nothing else matters, but never when
Salesforce says the user can see the record, and not for Task and Event, which have no object
permissions); owner; owner is a queue the user is in (also through groups inside groups), or the
user's role is above the role of a queue member; a role above the owner's role; sharing
rows (manual, sharing rule, account/opportunity/case team, territory, implicit, Apex reasons) given
to the user, to a public group (nested, loops are safe), role, role and subordinates, territory,
territory and subordinates, queue, or all internal users, and to someone below the user in the role
hierarchy; a share to a public group that "grants access using hierarchies" (members found down
through groups inside groups, role groups and territory groups, up to 3000 members, then the page
says it stopped), where the user's role is above a member's role; a share to a territory (and, for Cases and Opportunities,
the account's share to a territory) reached by a user assigned to a territory above it, or by a user whose role is
above the role of someone assigned to that territory, to any territory above it (and, for "and below" shares, to
territories under it), so an empty territory under a populated one still has managers ("Manager of Territory Member" in Salesforce's View Sharing
Hierarchy page); the record's territories against the user's territories, one route for each territory the user is
in or above (Accounts); child records the
user owns (Accounts); the org-wide default; the parent record; "View All" / "Modify All" on the
object; "View All Data" / "Modify All Data".

A read that fails for a passing reason (the connection drops, or Salesforce answers 500, 502, 503, 504 or
"server unavailable") is tried again up to twice, after 0.3 and 1 second. An expired session, a bad request, no
permission and query errors are not tried again. Only reads are repeated, so nothing changes in the org.

Not checked (also listed in the page's Notes): Experience Cloud
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
- Manager of a territory member (read-only queries on a sandbox, against Salesforce's View Sharing Hierarchy
  page and UserRecordAccess): a user assigned to a territory above a territory the record's account is shared
  with, whose role was not above anyone in it, can edit an opportunity, while a user with the same role and profile
  and no territory cannot. Users with no territory at all, whose role is above people assigned to the territories
  an account is shared with, are listed by Salesforce as "Manager of Territory Member". Both are now routes. The
  "and below" territory groups are assumed to work the same way upward (not tested on its own).
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
The reads that do not need each other run together (at most 6 requests at a time; the two users are read at
the same time), and what does not change between two users is kept in the page's memory while the page is
open: the roles and territories, and the record's own sharing, account sharing, group names and permission
count. A second Explain on the same record, with other users, reads only the user-specific parts. Choosing
another record empties the record's part; reload the page to read everything again. Nothing is stored
in the browser or on disk.

User access summary and comparison reads `User`, `UserEmailCalendarSync`, `ActivityUsrConnectionStatus` (Einstein Activity Capture; see below), `PermissionSetAssignment`, `PermissionSetGroup`,
`PermissionSetGroupComponent`, `PermissionSet`, `MutingPermissionSet`, `UserLicense`,
`PermissionSetLicense`, `PermissionSetLicenseAssign`, `GroupMember` (with `Group`),
`UserTerritory2Association`, `CallCenter` (by the Id in `User.CallCenterId`), `EntityDefinition` (custom settings), `Organization` (its Id), a describe of each custom setting and one read of each hierarchy setting. Hierarchy settings are told from list settings by a describe call each (only hierarchy settings have a `SetupOwnerId` field; describes are cached, so a second user costs none), done 6 at a time with progress shown. At most 300 custom settings are checked; if the org has more, the page says so. The user search runs in the org (LIKE, limit 50), so it works with
thousands of users. When the org's territory feature is off, the page does not ask for it.

Einstein Activity Capture is read with plain queries only (never `COUNT()`: it returns 0 on both objects even when rows exist, so the page counts the rows it reads). **Neither EAC object is ever filtered with a `WHERE`**: a real org answers with a generic server error, so every row is read (page by page) and filtered in memory, for one user as well. `UserEmailCalendarSync` gives who is assigned to which configuration (`AssignedId` is a user, or a profile, `00e`; `ConfigurationId` has the `063` prefix), and `ActivityUsrConnectionStatus` gives one row per connected user with `ConnectivityStatus` (ACTIVE, PENDING, INITIALIZING, PROCESSING, NEEDSATTENTION, IDLE_STREAMING, DISABLED, NEEDSATTENTIONGLOBAL, NEEDSATTENTIONHYBRID, or blank). A blank status is common in real data and means the user has not connected yet. Its `UserName` holds the person's display name, not a username. The configuration name comes from the status row's `ConfigurationName`, joined through users who have both a status row and an assignment; a try with describeGlobal for an object with the `063` prefix is kept but finds nothing in some orgs. If no name is found the configuration reads "Unnamed configuration (Id 063...)". A profile assignment is expanded by reading `User WHERE ProfileId = <id>` (active and inactive). Who has access comes from `PermissionSetAssignment` where the assignee is active and the permission set has `PermissionsAutomaticActivityCapture` or `PermissionsStdAutomaticActivityCapture`. User names are read from `User` by Id in batches of 200 (Ids are checked before they go into a query), and profile names from `Profile`. Orgs without Einstein Activity Capture do not have these objects; the area then says so in plain words.

The session is the browser's `sid` cookie for the org, found the same way Salesforce Inspector finds
it. It is held in memory for that tab only and never stored. Visible text says "license"; data keys
keep the old `licence` spelling so saved files still load. Saved group files use
`sf-psg-snapshot/2`; `/1` files still load.

## Choose which tools show in the menu

Not every tool applies to everyone. Open **Settings** (the link at the bottom of the toolbar menu, or right-click the
extension icon and choose **Options**) and untick the tools you do not use. They disappear from the toolbar menu; tick
one again, or press **Show all tools**, to bring it back. Each change saves at once and says "Saved".

- Hiding a tool only removes it from the menu. It changes nothing in Salesforce and does not stop anyone opening the tool.
- Your choice is kept by Chrome on this computer only. It is never synced or sent anywhere, so on another computer (or
  another loaded copy of the extension) you choose again. Only the
  names of the tools you hid are stored; nothing from Salesforce, no login and no user names.
- Tools added in a later version show up by default.
- If Chrome cannot read the choice, every tool shows. When the page is opened from the dev server instead of the
  extension (`http://127.0.0.1:8765/settings.html`), changes are not kept.

## Report a bug or suggest an improvement

The popup ends with a small footer line, "Report a bug · Suggest an improvement · Settings · v0.10.0", and all eight pages have the same two links at the top right. They open a new tab on GitHub with a short form already started: which
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
python dev/dev_server.py --no-org
```

Open <http://127.0.0.1:8765/tools/compare-groups/compare-groups.html?demo=1> (two made-up groups from `samples/`)
or <http://127.0.0.1:8765/tools/user-access/user-access.html?demo=1> (two made-up users) or
<http://127.0.0.1:8765/tools/record-access/record-access.html?demo=1> (a made-up account and two made-up users) or
<http://127.0.0.1:8765/tools/error-tracer/error-tracer.html?demo=1> (five made-up debug logs) or
<http://127.0.0.1:8765/tools/who-grants/who-grants.html?demo=1> (a made-up org and three users).

## Developing without reloading Chrome

`dev/dev_server.py` serves the pages and forwards their API calls to an org using the login the
Salesforce CLI already has, so a page can be tested against a real org in any browser tab:

```
sf org login web --alias my-sandbox        # once, if the CLI is not logged in to the org
python dev/dev_server.py --target-org my-sandbox
```

Open <http://127.0.0.1:8765/tools/compare-groups/compare-groups.html?dev=1> or `tools/user-access/user-access.html?dev=1`, or
`tools/record-access/record-access.html?dev=1&record=<record Id>`. The toolbar menu opens a tool as `tools/<tool>/<tool>.html?host=<org host>`
(the record tool adds `&record=<record Id>`).

- **Read-only.** Only GET requests to `/services/data/` are forwarded; anything else gets 405.
- **The token stays in the server.** The page never sees it. The server listens on 127.0.0.1 only
  and refuses requests addressed to any other host name.
- **Live reload.** Pages reload by themselves within about two seconds of a file change in the
  extension. This also works for the unpacked extension loaded in Chrome: unpacked extensions
  read their pages from disk, so page, JS and CSS edits need no "Reload" click while the dev
  server runs. Changes to `manifest.json` still need one.

## Files

Each tool has its own folder under `tools/`: `<tool>.html/.js/.css` is the page, `<tool>-read.js` reads Salesforce, `<tool>-logic.js` is pure logic. What several tools use is in `shared/`.

| Path | What |
|---|---|
| `manifest.json` | Chrome MV3 manifest (permissions: cookies, activeTab, tabs, storage; Salesforce hosts only; registers the Settings page as the options page) |
| `menu.html`, `menu.js` | The toolbar menu: a menu of the tools that are turned on. Detects the org in the current tab and opens the chosen page |
| `settings.html`, `settings.js` | The Settings page: turn each tool on or off in the menu |
| `settings-logic.js` | What the Settings page does on a click: keeps the boxes in step with what is saved, then shows one status |
| `shared/tool-list.js` | The one list of tools (id, page, title, description) that the menu and Settings both read. Add a tool here |
| `shared/menu-settings.js` | The only file that uses `chrome.storage`: keeps the list of hidden tool ids (`hiddenTools`) in Chrome's local storage (this computer only); falls back to showing every tool |
| `tools/compare-groups/compare-groups.*` | The Compare permission set groups page |
| `tools/user-access/user-access.*` | The User access summary and comparison page (html, js, and a little extra css on top of `shared/pack.css` and `shared/user-picker.css`) |
| `tools/user-access/user-access-read.js` | Reads one user's access from the org (`readUserAccess`) |
| `tools/user-access/user-access-logic.js` | Turns user access into rows and compares two users; CSV. Pure, no browser APIs |
| `tools/user-access/user-access-eac.js`, `user-access-eac-read.js` | Einstein Activity Capture: status words, joining the two objects into rows, counts, filter and CSV (pure); and the reads (`SELECT` and one describeGlobal) |
| `tools/user-access/user-access-eac-changes.js` | Einstein Activity Capture changes as text: picks, skip rules, the preview plan, tab-separated text, CSV and undo text, the typed configuration Id check, pasted-name matching (pure; nothing is loaded into the org by the extension) |
| `tools/page-details/page-details.*` | The Page details for a ticket page (html, js, extra css) |
| `tools/page-details/page-details-logic.js`, `page-details-read.js` | The ticket text and page kinds (pure; address cleaning is `cleanUrl` in `shared/pageurl.js`), and the org reads (`SELECT`/describe/GET only) |
| `tools/hierarchy/hierarchy.*` | The Territory & role hierarchy page (html, js, and extra css on top of `shared/pack.css`) |
| `tools/hierarchy/hierarchy-logic.js` | Builds, searches and exports a hierarchy (tree, branch, Excel layout). Pure, no browser APIs |
| `tools/hierarchy/hierarchy-read.js` | Reads territory models and territories from the org (`SELECT` only; roles come from `shared/roles-read.js`) |
| `tools/record-access/record-access.*` | The Why can a user see this record? page (html, js, and extra css on top of `shared/pack.css` and `shared/user-picker.css`) |
| `tools/record-access/record-access-logic.js` | The route reasoning, the two-user difference, the verdict and the plain-text export. Pure, no browser APIs |
| `tools/record-access/record-access-read.js` | Reads the facts for it from the org (`SELECT`, `COUNT()` and describe only; each area fails softly into notes) |
| `tools/flow-usage/flow-usage.*` | The Where is it used in flows? page (html, js, and extra css on top of `shared/pack.css`) |
| `tools/flow-usage/flow-usage-scan.js` | Looks inside one flow version for a field, text or an Id; also lists each record element's object and operation (get, create, update, delete), the trigger and how the flow starts (`startInfo`). Pure, no browser APIs |
| `tools/flow-usage/flow-usage-object.js` | The object view: groups, run order, entry conditions in words, changes and reads, CSV. Pure, no browser APIs |
| `tools/flow-usage/flow-usage-read.js` | Reads the flow list (`FlowDefinitionView`) and one flow version at a time (Tooling `Flow.Metadata`), `SELECT` only |
| `tools/error-tracer/error-tracer.*` | The Error Tracer: read a debug log page (html, js, extra css on top of `shared/pack.css`) |
| `tools/error-tracer/error-tracer-logic.js` | Reads one debug log text in a single pass into plain findings (what failed, where, which rule or flow step, notes); Copy text. Pure, no browser APIs |
| `tools/error-tracer/error-tracer-read.js` | Reads the log list (one `SELECT` on `ApexLog`) and one log's body (`GET`). GET only; never touches a trace flag or debug level |
| `tools/who-grants/who-grants.*` | The "Where does a user get this permission?" page (html, js, extra css on top of `shared/pack.css` and `shared/user-picker.css`) |
| `tools/who-grants/who-grants-logic.js` | Turns what was read into the answer: places, muting, implied access, session and expired assignments, the copy text, the pick lists. Pure, no browser APIs |
| `tools/who-grants/who-grants-read.js` | Reads the user's assignments, groups, parts, muting sets and the object or field permissions for one permission (GET and `SELECT` only; the newest API version for this page only) |
| `shared/urlcontext.js` | Turns a Salesforce page address into an object and field. Pure |
| `shared/sfread.js` | `readOrg`: the org name and edition shown in each page's header |
| `shared/csv.js` | `toCsv`: CSV with a BOM, formula-guarded. Pure |
| `shared/pack.css` | The stylesheet every page loads first |
| `shared/sfconn.js` | Session lookup and REST client (query with paging, describe, and `getText` for a plain-text GET such as a log body) |
| `tools/compare-groups/compare-groups-read.js` | Reads one group into a snapshot |
| `tools/compare-groups/compare-groups-logic.js` | Compares two snapshots; plain-language labels; CSV export. Pure, no browser APIs |
| `shared/feedback.js` | Builds the GitHub new-issue link (tool, version, browser only). Pure, no browser APIs |
| `shared/roles-read.js` | `readRoles`: the role list (portal roles left out), used by the hierarchy and record-access pages |
| `shared/users-read.js` | `searchUsers`: the user search used by the user-access, record-access and who-grants pages |
| `shared/users-logic.js` | `matchUsers`: the user search for the demos. Pure |
| `shared/recordid.js` | `recordIdFromUrl`, `looksLikeId`: find a record Id in an address or pasted text. Pure |
| `shared/pageurl.js` | `cleanUrl`: keeps only the path and list view name of a page address. Pure |
| `shared/user-picker.css` | The user list, inactive tag and error details styles used by the user-access, record-access and who-grants pages |
| `shared/pick.js` | Matching for the group search box |
| `shared/livereload.js` | Reloads the page on file changes while the dev server runs (unpacked copies only) |
| `dev/dev_server.py` | Local dev server: pages, read-only org proxy through the `sf` CLI login, live reload |
| `samples/` | Two synthetic snapshots, two synthetic users, a synthetic record with two users for the record demo, and a synthetic territory model set and role list, each with made-up users (example.com addresses), plus a synthetic set of flows (`flow_usage.json`), five made-up debug logs (`error_tracer_demo.json`) and a made-up org for the permission lookup (`who_grants_demo.json`), for the demos and the tests (the hierarchy and flow samples are written by hand, not by `make_samples.py`) |
| `tests/` | Offline tests and the sample generator |
