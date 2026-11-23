# CLAUDE.md — chrome-extension

(This folder was `sf-psg-compare` until the extension became the pack's main toolkit. Saved-file schema ids such as `sf-psg-snapshot/2` keep the old name on purpose.)

## What this is

A Chrome MV3 extension (plain ES modules, no build step, no dependencies) with six read-only tools,
named in the toolbar menu "Compare permission set groups", "User access summary and comparison", "Territory & role hierarchy", "Why can a user see this record?", "Where is it used in flows?" and "Page details for a ticket". It reads the
org through the REST API with the user's existing browser session and never writes to the org.
Visible text says "license"; data keys keep the old `licence` spelling so saved files still load.
Visible text avoids "PSG" and "snapshot" (say "saved group file"); code and developer docs may use them.

## Folder layout and naming

People "Load unpacked" this folder: `manifest.json` sits directly inside it.

```
manifest.json, menu.html, menu.js    the toolbar menu
settings.html, settings.js           the Settings page (manifest `options_ui`): turn tools on or off in the menu
shared/        tool-list.js (TOOLS: the one list the menu and Settings read), menu-settings.js (hidden-tool store; the only chrome.storage user), sfconn.js, sfread.js (readOrg), roles-read.js (readRoles), users-read.js (searchUsers), users-logic.js (matchUsers),
               recordid.js (recordIdFromUrl, looksLikeId), pageurl.js (cleanUrl), csv.js (toCsv), feedback.js, pick.js,
               urlcontext.js, livereload.js, pack.css, user-picker.css (user list and error box styles for user-access and record-access)
tools/<tool>/  one folder per tool: compare-groups, user-access, hierarchy, record-access, flow-usage, page-details
icons/, samples/, tests/, dev/dev_server.py
```

Naming rule: the folder is the tool's short name. `<tool>.html`, `<tool>.js` and `<tool>.css` are the page,
`<tool>-read.js` reads Salesforce, `<tool>-logic.js` is pure logic (no browser, no network), and any further part is
`<tool>-<part>.js` (flow-usage has `-scan` and `-object`). Compare-groups has no css of its own: `shared/pack.css`
is the common stylesheet every page loads first.

A tool does not import from or link to another tool's folder, and `menu.js` and `settings.js` import nothing from `tools/`. Code
several tools need lives in `shared/` (a layout test checks this). Shared reads are named `<what>-read.js`, pure helpers
`<what>-logic.js` or by what they do (`recordid.js`, `pageurl.js`), and styles used by more than one page `<what>.css`.

Chrome refuses to load an unpacked extension that contains any file or folder whose name starts with `_`
(for example `__pycache__`). A test fails if one exists; delete it before loading.
Earlier names, for old notes: `extension/lib/snapshot.js` = compare-groups-read, `compare.js` = compare-groups-logic,
`popup.*` = `menu.*`, `psg-compare.css` = `shared/pack.css`, `issue-snapshot.*` = `tools/page-details/page-details.*`.

## Files

- `shared/sfconn.js` — finds the API session from the `sid` cookie; `SfApi.query` pages
  through `nextRecordsUrl`.
- `tools/compare-groups/compare-groups-read.js` — `takeSnapshot(api, psgId)` reads one group into a JSON snapshot
  (`schema: "sf-psg-snapshot/2"`; `/1` files still load, see `ACCEPTED_SCHEMAS`). Permissions come from the group's aggregate permission set
  (`PermissionSet.Type = 'Group'`, `PermissionSetGroupId = <psg>`).
- `tools/compare-groups/compare-groups-logic.js` — `compareSnapshots(a, b)` → `{sections, counts, highlights, gives}`; also `filterRows`, `toRows`, `cardLines` (summary card text) and `sortRows`/`sortGrouped`/`sortSection` (what the page shows and exports). Pure.
- `shared/sfread.js` — `readOrg(api, apiHost)`: the org's name and edition for each page's header (one SELECT).
- `shared/csv.js` — `toCsv(rows)`: RFC 4180 with a BOM; guards cells starting with = + - @ tab CR. Pure.
- `shared/pick.js` — search words (punctuation is a separator) for the group box and lists. Pure.
- `shared/feedback.js` — `issueUrl({kind, tool, version})` builds the GitHub new-issue link (`bug.yml` / `enhancement.yml` in `.github/ISSUE_TEMPLATE/`; the query keys are the form field ids, the dropdown value is the exact option label). Only tool, extension version and browser go in. Pure. Used by the popup and the header links on all six pages.
- `shared/tool-list.js` — `TOOLS`, the one list of tools: `id` (the folder name, stable: it is what Settings remembers), `page`, `title`, `description`, and the menu flags (`needsRecord`, `context`, `withPageAddress`). To add a tool, add an entry here and ship its page.
- `shared/menu-settings.js` — `visibleTools(tools, hidden)` (pure), `cleanHidden`, `createSettingsStore(tools, storage)` (`storage` is injectable; tests pass a fake). Stores one key, `hiddenTools` (ids of hidden tools, so a new tool is on by default), in `chrome.storage.local` (this computer only; never `chrome.storage.sync`, so the choice is not synced or sent anywhere, and another computer or another loaded copy of the extension starts with every tool on); drops unknown ids on read and write; with no storage every tool shows and changes stay in memory. `getHidden()` never throws: on a failed read it returns the last list read or saved in this page session, or `[]` (every tool shows) if there is none. `setToolOn` reads strictly and throws if that read fails, so a save is never built from a failed read (stored value unchanged). Reads and saves run through one promise queue inside the store, so quick changes each build on the one before; a failed save rejects only its own caller.
- `menu.js` — the toolbar menu: one entry per tool that is on, enabled only on a Salesforce tab. It waits for the setting before drawing (no flash), shows "All tools are hidden" with a link when none is on, and has a Settings link in the footer (`openOptionsPage`, falling back to a new tab).
- `settings.html`, `settings.js` — the Settings page (manifest `options_ui`, `open_in_tab`): one checkbox per tool, saves at once, "Show all tools". DOM by `createElement`/`textContent` only; wires boxes and the button to `settings-logic.js`. Tests: `tests/settings_tests.mjs`.
- `settings-logic.js` — `createSettingsPage(store, {draw, say})` with `load()`, `toggle(id, on)`, `showAll()`; no DOM, no storage of its own. Rule: while saves are in flight the boxes show what was clicked; when the LAST one finishes (worked or failed) it redraws every box from `store.getHidden()` and only then says one status ("Saved" / not-kept wording, or the plain error if any save in the burst failed). Never say "Saved" while a save is running. Switches and Show all go through it the same way; do not call the store from `settings.js`.
- `tools/compare-groups/compare-groups.js` — the Compare permission set groups page. Builds DOM with `textContent` only.

## User access summary and comparison (second tool)

A read-only page, `tools/user-access/user-access.html`, that shows one user's access (profile and license,
role, call center, permission set groups, permission sets with "directly / through group", permission set
licenses, public groups, queues, territories, email and calendar connection (Einstein Activity Capture), and hierarchy custom settings whose value for the user differs from the org default) and compares two users. Same look as the compare page:
it links `shared/pack.css` and `shared/user-picker.css` and adds a little in `user-access.css`.

- `shared/users-read.js` — `searchUsers(api, text)` (LIKE search in the org, escaped with `soqlLike`, LIMIT 50); `shared/users-logic.js` — `matchUsers` (demo search). Used by user-access and record-access.
- `tools/user-access/user-access-read.js` — `readUserAccess(api, userId)` →
  `{schema: "sf-user-access/1", user, sections, unavailable, warnings}`. Reads `User`,
  `PermissionSetAssignment`, `PermissionSetGroup(Component)`, `PermissionSet`, `MutingPermissionSet`,
  `PermissionSetLicenseAssign`, `GroupMember`, `UserTerritory2Association`, `CallCenter` (`SELECT CallCenterId FROM User`, then `SELECT Id, Name, InternalName FROM CallCenter WHERE Id = ...`, cached per Id; a path such as `CallCenter.Name` fails in a real org because the field has no relationship name), `EntityDefinition`, `Organization`, describe + read per hierarchy custom setting. Only the user read may
  throw; every other area fails softly into `unavailable` (plain words) and `warnings` (raw).
- `tools/user-access/user-access-logic.js` — pure: rows, `compareUsers(a, b)`, verdict, CSV. Custom settings: `resolveHierarchy` (user, then profile, then org default, per field, first non-null wins; checkbox false counts), `settingItems` (only fields differing from the org default; item key `Setting__c.Field__c`), `customSettingsLine`, `customSettingsSkippedNote`, `customSettingsFailedNote`, `customSettingsHiddenNote`. Secret-like fields are hidden at read time: `isSecretLike(field)` (API name or label matches key/token/secret/password/passwd/pwd/credential/private, case-insensitive; booleans exempt) makes `settingItems` build an item with `hidden: true`, `value`/`orgDefault` null, `valueText`/`orgDefaultText` = "Hidden (looks like a key)" and `valueId` (a one-way fingerprint, only used so compare can tell two hidden values apart). The raw value is never kept, rendered or exported; keep any new display/export path on `valueText`/`orgDefaultText`. The page and CSV show one note sentence when any item is hidden. `access.customSettingsInfo = {found, examined, hierarchy, failed, failedSettings, skippedFields, capped}`; older files without `callCenter` / `customSettings` still load as empty.
  Custom settings are found with `EntityDefinition WHERE IsCustomSetting = true`; hierarchy vs list is told by `describe` (has `SetupOwnerId`), 6 at a time, cap 300 settings (reported on the page), then one read per hierarchy setting. Custom fields of special types (encrypted, address, location, base64, anyType, complexvalue) are not read; they are counted in `skippedFields` and the page says so once, and a setting whose fields are all skipped is not counted in "N of M". A setting that fails goes to `warnings` and `customSettingsInfo.failedSettings`; the rest is kept and the page shows a note ("2 settings could not be read"). Only when every setting fails (or the list itself cannot be read) is `unavailable.customSettings` set ("Not available"). In a compare, rows of a setting that could not be read for one user get status `unreadA`/`unreadB` ("Could not be read for <name>"), counted as `unread`, never as a difference. The CSV has "Note" rows in the custom settings area (count line with the cap notice, skipped fields, could not be read). The wider "no such field" match (INVALID_FIELD, No such column) applies to the call center only (and only to the `CallCenterId` read: a failure reading the CallCenter object gives the plain "could not be read" text); territories keep their original wording.
- `tools/user-access/user-access.js` — the page. `?host=`, `?dev=1`, `?demo=1` work as in `compare-groups.js`.
  Demo: `http://127.0.0.1:8765/tools/user-access/user-access.html?demo=1`.
- Einstein Activity Capture (EAC), inside this tool (issue #31). `tools/user-access/user-access-eac.js` (pure: `STATUS_WORDS`, `statusWords`, `isConnected`, `buildEacRows`, `eacCounts`, `groupByConfig`, `filterEacRows`, `filterNoConfig`, `eacCsvRows`, `noConfigCsvRows`, `assignedText`, `flagText`, `eacDetailText`, `eacItem`, `SHOW_CHOICES`) and `user-access-eac-read.js` (`readEacRaw`, `readEacAccessUserIds`, `readUserEac`; SELECT and describeGlobal only; own pager so it can report progress). Reads `UserEmailCalendarSync` (`AssignedId`: a `005` user, or a `00e` profile; `ConfigurationId`, prefix `063`) and `ActivityUsrConnectionStatus` (`UserId`, `UserName` = the person's DISPLAY name, not a username; `ConfigurationName`, `ConnectivityStatus`, `RecommendedActionTitle/Description`, `ContactsSynced`, `EventsSynced`, `IsTermsOfServiceAccepted`, `GlobalOauthTermsState`, `UserOnboardingStatus`).
  **`COUNT()` returns 0 on both objects even when rows exist: never use it; count the rows read** (`eacCounts`). **Never put a WHERE on either object** (a real org answers with a generic server error, "An unexpected error occurred... ErrorId"): read all rows, paged, and filter in memory, also for the single-user read (a test makes the fake org refuse any WHERE there). **A blank `ConnectivityStatus` is common (25 of 25 and 33 of 38 rows in two sandboxes) and means "Not connected yet (no status)"; only `ACTIVE` is connected** (so Idle and every other value is "not connected" too). A user assigned with no status row is "Assigned, not connected yet".
  `buildEacRows` joins the objects per user and configuration NAME and returns `{rows, profileAssignments, noConfig}`. Names: `configs` (the describeGlobal try; no queryable object has prefix 063 in the sandbox seen, so it is a harmless extra), else inferred from users who have exactly one assignment and one status row (the status row's `ConfigurationName` names the assignment's Id; majority vote), else "Unnamed configuration (Id 063...)" with the full Id so the admin can match Setup's Configurations tab. A profile assignment (`00e`) becomes one row per member of `profileMembers[profileId]` (the reader reads `User WHERE ProfileId = '<validated id>'`, paged, active and inactive); a user both direct and through a profile, or assigned twice, is ONE row (`direct`, `profiles[]`, `assignedText` = "Directly", "Through the profile X", or "Directly and through the profile X"). A profile whose members could not be read stays in `profileAssignments` (a note). Row flags: `isActive` false = "Inactive user, still assigned"; `nothingSynced` = ACTIVE and both `ContactsSynced` and `EventsSynced` KNOWN and false or 0 (null/blank is unknown, not flagged: uat2 had ACTIVE users with both null and the row showed "Not known"). `noConfig`: `accessUserIds` minus every user with any row; `null` when access could not be read.
  Access: `readEacAccessUserIds` runs `SELECT AssigneeId FROM PermissionSetAssignment WHERE Assignee.IsActive = true AND (PermissionSet.PermissionsAutomaticActivityCapture = true OR PermissionSet.PermissionsStdAutomaticActivityCapture = true)` (paged; profile-owned and group aggregate permission sets are included); if that fails (for example INVALID_FIELD) each permission is asked alone and every answer that works is used; if both fail `ids` is null and `note` is one plain sentence (the page keeps everything else). Not verified live: this query in a real org (the brief asked for it to be checkable live: it is its own exported function).
  One user: area key `eac` (list items keyed by configuration name; compare matches by name, "Different" when status or any shown fact differs; included in the CSV). Everyone: a panel on the page (`#eacPanel`, "Show everyone"), no user needed. Sections per configuration (name, member count, "This configuration (CSV for Excel)"), a "Show" selector (Everyone, Not connected, Inactive users still assigned, Connected nothing synced yet, Has access but is in no configuration), a shared search, "Show API names", downloads (Everyone, What is shown now, Users in no configuration), and counts folded below. Each section draws 200 members and "Show 200 more"; progress reads "Reading... 1,200 connections / users". The reader throws an error with `featureOff = true` when the objects are missing or not visible (INVALID_TYPE); the single-user area then sets `unavailable.eac` to "Einstein Activity Capture is not turned on in this org, or you can't see it." with no warning, and every other area is untouched. If only one object fails, the other is used and the list says it may be incomplete. User Ids from rows are checked (`^[A-Za-z0-9]{15,18}$`) before use in a query; names are read in batches of 200. Ids are compared by their first 15 characters (`id15`): test and demo Ids must differ inside those 15 characters. Demo: `samples/eac_all_demo.json` (raw shape the reader returns, run through `buildEacRows`; includes profile members, an unnamed configuration, an inactive user, a connected-nothing-synced user and users with access in no configuration) and an `eac` section in `user_a.json` / `user_b.json`. Configurations with no members cannot be listed: in a real sandbox no object with prefix 063 was found through the REST sObject list, the Tooling API or any Metadata type, so only configurations with an assignment or status row appear; the panel always shows `EMPTY_CONFIG_NOTE` saying so (the describeGlobal 063 try stays, it is free). `eacCounts` also returns `connectedUsers` / `notConnectedUsers` (distinct users; connected if any row is ACTIVE) and `eacSummaryLine` uses them, never row counts. The download is labelled "Everyone in a configuration" (users in no configuration have their own). A single user with no rows sees `NO_EAC_USER_TEXT`. Demo files agree: Blake Sample is Connected in `eac_all_demo.json` and `user_b.json` (compare differs on events synced). Not verified live: the permission query above, a profile assignment in a real org, the name of the object behind prefix 063 (none found in one sandbox).
- Tests: `tests/user_access_tests.mjs` and `tests/user_access_eac_tests.mjs`, run from `tests/run_tests.mjs`.
- Rules that matter: matching by API name, never Id; no user snapshots or files (usernames);
  no `innerHTML`, `localStorage` or `chrome.storage` (a test checks); group and queue membership is
  direct only (say so in help text). Not covered: object/field access, nested group membership.

## Territory & role hierarchy (third tool)

A read-only page, `tools/hierarchy/hierarchy.html`, that shows the whole territory tree (Territory2, one
model) or role tree (UserRole), opened out, with a search that narrows the page to one branch and a
CSV export with the tree in the cells. Links `shared/pack.css` and adds `hierarchy.css`.

- `tools/hierarchy/hierarchy-logic.js` — pure, tested: `buildTree` (sorted by name, numbers by value; missing
  parent goes to the top level; a loop is cut at its first member by name (`loopCut`), and every member is flagged `inLoop`; iterative walks, so deep
  chains are safe), `flatten`, `pathOf`, `branchOf`, `searchNodes` (pick.js words, limit 50, results carry
  the path), `exportRows` (stepped "Level 1..N", "API name", "Path"), `exportFileName`, `summaryText`,
  `treeNotes` (with a branch's items it counts only the nodes on screen), and the user helpers `attachUsers`,
  `listUsers`, `countUsers`, `usersSummary`, `USER_FIELDS`; `exportRows(tree, top, users)` adds "Users" and
  "User 1..N" columns when `users` is `{byNode, field, includeInactive}`. Re-exports `toCsv` from `shared/csv.js` (which guards cells starting with = + - @ tab CR).
- `shared/roles-read.js` — `readRoles(api)` (roles except portal and community roles, counted with `COUNT()`; returns
  `{roles, portalCount, warnings}`). Used by hierarchy and record-access.
- `tools/hierarchy/hierarchy-read.js` — `readTerritoryModels` (`{on: false}` when the org has no
  territories: the `Territory2Model` query fails with INVALID_TYPE; no describeGlobal call, it was slow), `readTerritories(api,
  modelId)`, and the user reads (SELECT only,
  only when "Show users" is turned on): `readRoleUsers` (`User WHERE UserRoleId != null AND UserRole.PortalType = 'None'`, active and inactive,
  filtered in memory so the tick box needs no new read; portal and community users are not read, only counted
  with two `COUNT()`s, all and `IsActive = true`, each with `UserRoleId != null` because `!= 'None'` alone also matches
  people without a role; returns `portalUsers {active, all}`, or null with the reason in `warnings` if a count fails) and `readTerritoryUsers(api, modelId)`
  (`UserTerritory2Association` with `User.*`; `RoleInTerritory2` is deliberately not read: on real orgs it holds
  bare numbers). `countUsers` returns people (`active`, `inactive`) and assignments (`activeAssignments`,
  `inactiveAssignments`); `usersSummary(counts, includeInactive, kind)` words Territories as people in assignments.
- `tools/hierarchy/hierarchy.js` — the page. Flat rows built once with a DocumentFragment; folding only
  toggles `hidden` on a row range; "Show API names" is a CSS class; the search renders at most 50
  list items. Show users: each row has a `.people` block filled in place (no re-render, no org call) when the
  field or the inactive box changes; users are cached per tree in a `WeakMap`, memory only; a failed user
  read is kept on the entry and shown as a message about users only (raw text in Notes). `?host=`, `?dev=1`, `?demo=1` as elsewhere. Demo:
  `http://127.0.0.1:8765/tools/hierarchy/hierarchy.html?demo=1`.
- Samples: `samples/hierarchy_territories.json`, `hierarchy_roles.json` (made-up, written
  by hand; `make_samples.py` does not rebuild them). Each has made-up users (`users` on the role file and on
  each model: `{id, nodeId, name, username, email, active}`; Ids like `005000000000001AAA`, example.com
  addresses). A test checks they stay synthetic.
- Tests: `tests/hierarchy_tests.mjs`, run from `tests/run_tests.mjs` (includes the no-innerHTML,
  no-storage guard for the new files).
- Rules that matter: reads only; org text only through `textContent` / `el()`; nothing stored (user data
  lives in memory for the page session; the only copy is the CSV the person downloads, which contains
  usernames or emails, so say so); names that repeat are told apart by path, never by name alone; the tree's
  load does not read users.

## Why can a user see this record? (fourth tool)

A read-only page, `tools/record-access/record-access.html`, that explains how one user can see the record open
in the current Salesforce tab, and with two users why one sees it and the other doesn't. Links
`shared/pack.css` and `shared/user-picker.css`, and adds `record-access.css`. The popup button reads the active
tab's address with `recordIdFromUrl` (`shared/recordid.js`) and opens `record-access.html?host=<host>&record=<id>`; with no
record in the address the button stays enabled and the page opens with an empty record box (a box
takes a pasted link or Id, which is also how the dev server is used).

- `tools/record-access/record-access-logic.js` — pure, tested: `to18`, `explain(facts, userIds)`
  (routes per user as chains of plain steps, `mismatch`, `difference`, `verdict`, `notes`),
  `toPlainText`, `owdText`, `causeInfo`. Facts shape: schema `sf-record-access/1` (see the demo file).
- `tools/record-access/record-access-read.js` — `readRecordContext(api, id)` (record, owner, parent, org-wide
  default; throws plain `Error`s) and `readRecordAccess(api, ctx, users)` (everything else; each area fails
  softly into `notes` / `warnings`). SELECT, COUNT and describe only.
- `tools/record-access/record-access.js` — the page. `?host=`, `?dev=1`, `?demo=1`, plus `&record=`. Demo:
  `http://127.0.0.1:8765/tools/record-access/record-access.html?demo=1` (`samples/record_access_demo.json`, made up).
- Tests: `tests/record_access_tests.mjs` (reasoning, mismatches, a faked org, the guard).
- Rules that matter: **the verdict comes only from `UserRecordAccess`**; routes are explanation. When
  they do not agree, `mismatch` says so with likely causes, never as fact. Route levels are capped by
  the user's object permissions. A user with no Read on the object has no routes (`gate`), unless
  `object.permissionsApply === false` (Task, Event: no ObjectPermissions rows exist, the reader checks
  with a COUNT) or Salesforce says the user can see the record (safety net, with a note). Group
  membership is worked out upward with a visited set (loops are safe) and a depth cap. The headline
  is `sfLevel` (what the user can do); `sfShareLevel` (HasAllAccess counts) is what sharing gives, and a
  gap is `limitText`. `objectCap` follows Salesforce: Modify All (or Modify All Data) is full, Edit + Delete is
  full, Edit alone is edit, Read (or View All) is view. Never describe a user with Read, Edit and Delete as
  limited. No UserRecordAccess row (inactive user) is `inactive`, not a mismatch.
- Manager routes: `readMemberRoles` (reader, exported for tests) walks DOWN from groups with
  `DoesIncludeBosses` that the record is shared with, and from an owner queue, through groups, role,
  role-and-subordinates and territory groups (visited set, MAX_DEPTH, MAX_MEMBER_GROUPS,
  MAX_MEMBER_USERS, `capped` flag). Facts: `memberRoles[groupId] = {roles: [{roleId, example, count}],
  users, capped}`. `explain` finds a member whose role is strictly below the user's (`membersBelow`).
- Access through the account (Cases, Opportunities and Contacts with an `AccountId`; `record-access-logic.js` `acctScope`,
  `shareRows(rows, scope)`; reader `readAccountAccess`): the record's own share rows and the parent
  account's share rows go through the same loop, so groups (nested), roles, role-and-subordinates,
  territories, bosses-groups and role-above are reused. Facts: `facts.account = {id, name, rows:[{who,
  level, cause}], truncated, owner:{id, name, roleId, level}}`, and `user.accountTeamRole`. The reader
  selects `UserOrGroupId, RowCause, CaseAccessLevel` (or `OpportunityAccessLevel`, `ContactAccessLevel`) from `AccountShare`
  for the account (one query, LIMIT 2000) and drops None and Owner rows. The owner's level is the Owner
  row's level, with `UserRole.CaseAccessForAccountOwner` / `OpportunityAccessForAccountOwner` / `ContactAccessForAccountOwner` as
  fallback. Routes have keys and topics prefixed `acct:` and `detail.acct`, so they take part in topic
  matching and `hasInFacts`. An account route starts "The case belongs to account 'X'" and says
  "...which gives <level> access to the account's cases". A None row gives no route. The object-permission
  cap applies as for other routes. Extra queries: 1 account name, 1 AccountShare, 1 owner, 1 role, plus 1
  AccountTeamMember per user. Territory routes on the account come only from AccountShare Territory rows.
  A contact whose org-wide default is Controlled by Parent gets no account routes (access follows the account, through the parent flow). An ImplicitChild or ImplicitParent account row is a route only when its level is Read or Edit.
- Confirmed live (sandbox, read-only queries): `AccountShare.CaseAccessLevel`, `OpportunityAccessLevel`,
  `ContactAccessLevel`; `UserRole.*AccessForAccountOwner`; the Owner row equals the role setting; Team,
  Manual, Rule, Territory and Territory2AssociationManual rows carry their own levels; ImplicitParent
  rows are None. Consistent with the data but not proven: people above an account holder or the account
  owner in the role hierarchy get the same level. Not tested: that role-above route for Cases.
- Still not covered: restriction and scoping rules, Experience Cloud sharing sets, which specific
  sharing rule. Access through the account is only as complete as the account's first 2000 share rows.
- Routes may carry a `topic` (same way in reached differently: a territory through a share row or the
  territory list, one group share as member or as manager, the owner queue as member or as boss, a
  direct share of the same RowCause). The difference matches by topic and, before printing any
  "X is not ..." line, `hasInFacts` checks X's own facts. Never print a lack that X's facts disprove. A route
  whose grantee or member is the other user (a share to them, they own the record, they are in the group)
  counts as held by them; `viaOther` then says "X is above Y" (`difference.via`) instead of a missing line.
  Territory names that repeat are shown with their parent ("EM (under EMEA Region)"), never by name alone.
  A team route that only restates the owner is dropped. "Explain the parent record" passes `a=` and `b=`
  (user Ids) in the address; `readUserById` puts them back.
- Territory routes (in `shareRows`, so they work for the record's own rows and the account's rows): a share to a
  Territory (or TerritoryAndSubordinates) group is reached by (1) a user assigned to it (computeReach, as before), (2)
  a user assigned to a territory ABOVE it (`territoryAbove`; key `shareTerrAbove:`, `detail.above`), or (3) a user
  whose role is above the role of someone assigned to it (key `shareBossTerr:`, detail type `shareBossTerritory`;
  territory groups all have `DoesIncludeBosses` true; members come from `readMemberRoles`, which takes
  `targetInfo` so a territory group's members are the people assigned to its territory, to EVERY territory above it
  (they get the access by route 2, so their managers do too; an empty territory under a populated one still has
  managers), and, for "and below", to the territories under it. Each role entry carries `terrId` (where its example
  member is assigned) so the step can say "assigned to territory 'P', which is above 'G'"; without `terrId` the old
  wording is used). Two territory causes (for example `Territory` and `Territory2AssociationManual`) give separate
  routes worded by cause (`causeInfo`: "manual territory assignment" for the manual one); same cause and level is one route.
  All three share the topic `territory:<type>:<territory>`, so one user in the territory and one above it compare by
  level. (2) wins over (3) for the same row. The Account territory-list route (ObjectTerritory2Association) is now
  one route per record territory and is skipped for a territory a share route already covers (topic
  `territory:Territory:<id>`, or a T&S one at or above it). `reachesTerritoryGroup` feeds `hasInFacts`, and
  `missingFor` says "or one above it". Confirmed live (sandbox, read-only): a user in a territory above a territory
  the account is shared with, role not above any member, gets Edit on the opportunity, and an identical user not in
  the territory gets nothing; users with no territory whose role is above territory members are the "Manager of
  Territory Member" rows Salesforce lists (the five missing rows of one case were exactly the five territory rows on
  its account). Not proven: that "and below" groups also give access upward (assumed).
- Reads in this tool go through `withRetry(api)` (record-access-read.js, used by record-access.js only; sfconn.js is
  unchanged): GET failures that are a dropped connection or HTTP 500/502/503/504 or errorCode SERVER_UNAVAILABLE (only with a 5xx
  status or none) are retried twice (300 ms, 1 s; delays and sleep are injectable for tests). Any 4xx is never retried,
  whatever its errorCode; nor are query errors.
- How `readRecordAccess` reads (record-access-read.js): every area is a promise started at once, chained only where it needs
  another (group names need the share rows and account rows; manager-group members need group names, roles and territories;
  a user's group walk needs their role chain and territory chain). Both users run together. `withLimit(api, MAX_IN_FLIGHT = 6)`
  wraps `get` (one GET holds a place, never a whole chain, so no deadlock); an api already limited is not wrapped again. Each
  area collects its notes in its own `blank()` and they are merged in a fixed order (roles, territories, shares, account, names,
  members, permissions, then each user), so notes read the same whatever finished first. Per-user notes are worded with the
  picked name and renamed to Salesforce's name if it differs. The user's territory assignments are asked for while the territory
  list is still loading and used only when territories are on. Progress is "Reading… (n of m)", counted per area (7 + users).
- Page-session cache (`createReadCache()`, `clearRecordFacts(cache)`; the page holds one in `state.cache`): `org` (roles,
  territories) and `rec` (share rows, record territories, account rows/owner/owner role, group and share-user names, manager-group
  members, permission count; keyed by record Id and emptied when the record changes, and by `useRecord`). A read that failed is
  never kept (also not one that makes territories "off": that failing call is made again each time). Cached values are cloned on
  the way out. Memory only: no chrome.storage, localStorage or files. Pass no cache and nothing is kept.
- Salesforce's label next to a route (`sfLabelFor(key)` in record-access-logic.js; `route.sfLabel`, `difference.items[].sfLabel`; page
  `sfLabelNode`, class `sf-label`; plain text "Route n (gives X; Salesforce: LABEL):"). Confirmed on the View Sharing Hierarchy page
  (a sandbox): "Manager of Territory Member" for `shareTerrAbove` and `shareBossTerr` (also `acct:` ones), "Manager of Group Member" for
  `shareBossGroup`, "Manager of Queue Member" for `ownerQueueBoss`, "Manager of User" for `acct:ownerRole` and for the account route
  shared with a specific user (`acct:shareBoss:` whose detail has `type "shareBoss"`, `whoId` and `acct`; `sfLabelFor(key, detail)`
  decides from the detail because both shareBoss variants share a key prefix). Not tagged: `shareBoss` to a role group, the record-level
  `shareBoss` to a user, the record-level `ownerRole`. Do not add a label that was not seen on that page. To add one: add it to
  `SF_LABEL_BY_KIND` or `SF_LABEL_BY_KEY` (or the detail test in `sfLabelFor`), plus a test.
- Kept-facts line: `readRecordAccess` adds `facts.kept = {at}` (ms time of the first read) only when some of the record's own facts came
  from the cache (`cache.recAt` is set at the first read and reset by `clearRecordFacts` or a new record); otherwise no `kept`. The page
  (`#kept`, `renderKept`) shows "Who this record is shared with was read at HH:MM ... Read it again"; the button is `readAgain`
  (clears the record facts, runs Explain again with the same users). Org-wide lists may stay kept; the line is about the record's sharing. A failed run takes away the shown result and says so next to the error.
- A difference item carries `limited` and `effective` like the person's card; `givesText(item)` words it ("Would give
  edit access, limited to view by object permissions"), for the page and the copied text.
- Tasks and events (WhatId and WhoId): the parent is WhatId and the person is WhoId (`whoId`, user
  `whoSf`). The parent route is only added when Salesforce says the user can see the record; otherwise
  `parentLine` says the parent condition is met but not enough, with the unseen person as the likely
  reason (seen in a sandbox: related account visible, related contact not, task not visible), or says
  it could not tell. Do not state "whoever can see the parent can see them" as a general rule.
- The two-user difference compares by what sharing gives first, lists every route the other user
  lacks (even when both have routes) and a `levelNote`.
- Not covered (also in the page's Notes and the README): restriction and scoping rules, Experience
  Cloud sharing sets, field-level access, which sharing rule (the share row does not name it), shares to
  manager groups, the custom-object "Grant Access Using Hierarchies" setting (assumed on), members
  beyond the walk caps. Not verified live: share-table field names,
  RowCause values, territory association values, how group components appear in
  `PermissionSetAssignment` (component sets of a group are skipped; the group's own aggregate set is used).

## Where is it used in flows? (fifth tool)

A read-only page, `tools/flow-usage/flow-usage.html`, that finds the flows using a field (object + field), or containing a
text or record Id, and shows the step in each flow with what it does (sets / checks / uses); and, when only an object
is picked, the object view ("which flows run when an Account is saved, in order, and which others change or read
Account records"). Links `shared/pack.css` and adds `flow-usage.css`.

- `tools/flow-usage/flow-usage-scan.js` — pure, tested: `scanFlow(metadata, target, {describe})` (async only because relationship
  paths ask `describe(objectApiName)`), with target `{kind: "field", object, field}` or `{kind: "text", text}`. Returns
  `{hits, possible, wholeRecord, records, trigger}`. `records` (`[{element, label, kind, op: get|create|update|delete,
  object, objectKnown}]`) and `trigger` (`{object, triggerType, recordTriggerType}`) do not depend on the target:
  the object view uses them with no re-scan (`recordElements(meta)` gives the same list without describe; scanFlow also
  types loops over related lists). `startInfo(meta)` says how a flow starts (object, trigger, entry filters / formula,
  scheduled and async paths, schedule; for Process Builder, `processType: "Workflow"` and its `processMetadataValues`
  `ObjectType` / `TriggerType`, or the `myVariable_current` variable, give the object). Names: `$Record` and
  `$Record__Prior` are the start object; SObject variables (`objectType`, so Process Builder's `myVariable_current` / `_old`);
  Get Records with `storeOutputAutomatically`; loops and collection steps take their collection's type; transforms their
  `objectType`; `$Setup.<Object>.<Field>`, `$User`. `[0]` and `[$EachItem]` are dropped. Relationship paths use describe
  (`relationshipName` -> `referenceTo`; `Parent:Account` pins a polymorphic type). A step that cannot be followed, a
  polymorphic one that includes the target, or a head that is not known (an untyped SObject variable, `$Record` in a flow
  with no start object) is **possible**, never silently dropped; heads that are plainly not records (`$Flow`, `$Label`,
  strings, formulas, screen fields) are skipped. Actions: `sets` = `inputAssignments[].field` of create/update,
  `assignToReference`, transform `outputFieldApiName`; `checks` = filters, a condition's `leftValueReference`, the start
  `filterFormula`; everything else `uses`. A Create or Update step that saves a whole record variable of the target object (no field assignments) is a **possible**
  hit with `detail` ("saves a whole Account record, so it may set this field"); `wholeRecord` still lists them. A loop over a
  related list (`$Record.Contacts`, `acct.Contacts`) takes the child object from the parent's describe
  (`childRelationships`: relationshipName -> childSObject), so its hits are sure. Hits for one step and field are merged (`refs` lists how it was written). Text and
  Id search walks every string; an Id matches in both forms (`idForms`). Also `plainFlowType`, `buildResults`,
  `summaryLine`, `csvRows` / `csvText` (through `toCsv`, which guards cells starting with = + - @ tab CR; one row per
  step, plus one row per flow that could not be looked inside, with the plain reason in "How sure").
- `tools/flow-usage/flow-usage-object.js` — pure, tested: the object view. `buildObjectView(object, entries, {labelOf, objectLabel, partial})`
  with `entries` `[{def, versionId, versionKind, error?, start?, records?}]` (one per flow) returns `{groups: before / after /
  delete (a flow with any create/update/delete step on the object is in `changes` only, with all its steps; `reads` has flows that change nothing; items in run order, each with `band` low / none / high / off, `orderKnown`; the group has `noOrderCount`), process (Process Builder: `{items}`, not numbered, by label), scheduled, changes, reads, unreadable, pending}`. Matching is by API name only
  (`def.triggerObjectName` from `FlowDefinitionView.TriggerObjectOrEvent.QualifiedApiName`, else the start element's
  object); the label (`triggerObject`) is for showing and never compared. `compareRunOrder` is the one place that
  settles order within one group (rule in its comment, from Salesforce Help "Define the Run Order of Record-Triggered Flows for an Object"):
  active flows with trigger order 1-1000 (lowest first, same number by API name), then active flows with none, then 1001-2000
  (same), then inactive flows (they do not run). Flows with no trigger order really run in order of their **activation date**, which
  the page cannot read, so they are listed by API name (as Flow Trigger Explorer does) and shown as an unnumbered block with a note
  (`noOrderBlockText({above, below})`, which mentions flows above only when flows with order 1-1000 are in the group and flows below only when 1001-2000 ones are; only when a group has two or more; a lone one has a certain place). No created-date read exists any more.
  `RUN_ORDER_RULE` is the Notes wording; `runOrderWords(item)` is the CSV "Run order" cell. The CSV has "Trigger order" (blank when
  none) and "Run order" columns instead of a position. Process Builder (`processType`
  Workflow, `groupOf` -> "process") runs after the save but before the after-save flows, in no promised order: it is
  `view.process`, between before and after on the page and in the CSV ("Process Builder processes", no position).
  `entryConditions` (plain words: "Status
  equals Closed", custom logic as `[A] and ([B] or [C])`, a formula as "has a formula condition", more than 6 as "has N
  conditions"), `pathWords(start, labelOf)` (a scheduled path shows the field's label), `scheduleWords`, `metaWords` (the line under a flow's name: "Scheduled flow: runs daily at 06:00, ..."), `whenWords`, `objectSummary`, `objectCsvRows` / `objectCsvText` /
  `objectCsvFileName` (one row per step, or per flow with none; unreadable flows get a row with the reason).
- `tools/flow-usage/flow-usage-read.js` — `readFlowList` (one `FlowDefinitionView` SELECT including `TriggerObjectOrEvent.QualifiedApiName`, `TriggerOrder`,
  `HasAsyncAfterCommitPath`; `DurableId` is the 300 flow Id; a column the org rejects by name is dropped and the query repeated, otherwise
  it falls back to the short list), `versionsToRead` (active version of active flows; with `includeInactive` also the
  latest version where it differs; a version Id that is not a 301 Id, as on some installed packages
  (`MktCloud__Name-1`), becomes `versionId: null`), `readFlowVersion` (Tooling `SELECT Id, Metadata FROM Flow WHERE Id = '301...'`,
  one row per call, or Salesforce returns no Metadata), `readVersions` (5 in flight, progress callback, one failure never
  stops the rest, a version already in the cache is not read again), `whyUnreadable`, `resolveContext` (Tooling
  `CustomField` / `CustomObject` by Id).
- `shared/urlcontext.js` — pure: `parseUrlContext(url)` (Setup field and object pages, `/lightning/r/...`,
  `/lightning/o/...`), `contextQuery`, `contextFromParams` (keeps API names and 00N / 01I Ids, drops anything else), `pickByDeveloperName`. `menu.js` passes only `object` and
  `field`, never the address.
- `tools/flow-usage/flow-usage.js` — the page. `?host=`, `?dev=1`, `?demo=1`, plus `object=` and `field=`. Flow contents live in a
  Map for the page session (memory only), shared by the field search and the object view; describes are cached per object.
  Picking an object runs the object view at once (list facts first, then the trigger flows' contents, then the rest, with
  the progress line); picking a field runs the field search; `object=` alone (record page, list view) runs the object view.
  The Flow Builder link needs the validated `?host=` and a 301 version Id, so flows with no usable Id get no link.
- Sample: `samples/flow_usage.json` (written by hand; made-up flows, objects and describes, Ids like
  `301000000000001AAA`; includes a package flow with no contents and one that failed; Account flows for every object-view group (two before-save flows with
  the same trigger order, one with 1200, one inactive, two after-save flows with no trigger order, an async path, Process Builder, a scheduled flow, a loop over `$Record.Contacts`, flows that change and read
  Account) and `Partner_Account__c`, whose label is also "Account"). A test keeps it synthetic.
- Tests: `tests/flow_usage_tests.mjs`, run from `tests/run_tests.mjs` (includes the no-innerHTML, no-storage, no-write guard).
- Real flows seen on a sandbox: the Metadata is full of null keys; references appear as `elementReference`,
  `leftValueReference`, `assignToReference`, `objectFieldReference`, `collectionReference`, `inputReference` and as
  `{!...}` merge fields in formulas, templates and `filterFormula`; polymorphic references look like
  `$Record.Parent:Account.Field`. On that sandbox `TriggerOrder` was empty on every flow and no Process Builder processes existed, so the trigger-order bands
  and the Process Builder wording are from the documented shape, not from live data. On that sandbox the Account and Opportunity groups listed the flows with no trigger order in API-name order (plain character-code order, capitals before lowercase and "_" after capitals, as Flow Trigger Explorer sorts them; `byApiName` does not use `localeCompare`). Not handled: Apex-defined types.
- Rules that matter: GET and SOQL only; org text only through `textContent` / `el()`; match by API name (Ids only to
  open a flow in Flow Builder); the session id is never stored.

## Page details for a ticket (sixth tool)

A read-only page, `tools/page-details/page-details.html`, that shows who the person is, the org, and the page or
record they were on, and copies it (clipboard or .txt) for a support ticket. Links `shared/pack.css` and
adds `page-details.css`. "Snapshot" is the file/code name only; the visible title is "Page details for a ticket".

- `shared/pageurl.js` — `cleanUrl` (path plus `filterName` only; drops every other parameter, the hash and `;params`).
  `page-details-logic.js` imports it; `menu.js` and `page-details.js` use it too.
- `tools/page-details/page-details-logic.js` — pure, tested: `parsePageUrl` (record / list / setup / home / other; classic `/<Id>`
  has no object; Experience Cloud `/s/` is other), `snapshotText` (the ticket text; note first; missing areas
  worded plainly), `scrub` (last guard against session-like strings), `whenText`, `fileName`, `sandboxNameFromHost`.
  Setup page name, in order: (1) the Salesforce tab's own title: `setupTitleFromTabs(tabs, host, cleanedUrl)` picks the tab
  (same host name, same `cleanUrl`, newest `lastAccessed`, first one whose title survives cleaning) and `cleanTabTitle(title)` strips
  " | Salesforce" / " ~ Salesforce - <edition>", caps at 120 characters and rejects generic or loading titles; (2) the built-in
  `SETUP_TITLES` (Lightning address segment to Salesforce's title) and `OBJECT_MANAGER_SUBPAGES` ("Object Manager > Fields & Relationships";
  `parsePageUrl` keeps the sub-page as `setupSub`); (3) `setupPageName`, the name made from the address. `setupDisplayName(parsed, tabTitle)`
  does the choosing; the tab title is not used on Object Manager object pages (their titles are not known), and the text never says which source was used.
  `cleanTabTitle` also rejects (case-insensitively) error and sign-in titles that name no page: "Page not found", "Login", anything starting
  with "Error", and titles containing "Insufficient privileges", "Something went wrong", "Sorry to interrupt" or "Verify your identity".
  An Object Manager object's own page (`ObjectManager/<Object>/view`) is "Object Manager > Details"; Object Manager's home is "Object Manager".
  Checked live in a developer org on 2026-11-22: every `SETUP_TITLES` entry except `DataManagementCreateTestInstance` (Sandboxes; not in a
  developer org). `SetupOneHome`'s tab title is "Home" (rejected as generic); "Setup Home" is its sidebar name. Object Manager sub-pages checked:
  FieldsAndRelationships, PageLayouts, LightningPages, ButtonsLinksActions, CompactLayouts, FieldSets, RecordTypes, ValidationRules,
  ApexTriggers, MySearchLayouts, AlohaSearchLayouts, Limits, and the Details page (the object's `/view`). Other sub-pages fall back to the
  address-made name. Re-check when touching the table.
- `tools/page-details/page-details-read.js` — `readOrgDetails` (`Organization`), `readCurrentUser`, `readPageDetails`
  (describe, one `SELECT` for a record using only fields the object has, a `ListView` name lookup),
  `readIssueSnapshot` (`{host, url, setupTitle}`). Each area returns `{data, problem, raw}` and never throws. `failureCause(e)` ->
  "session" | "denied" | "unreachable" | "other" is the one classifier; `orgProblem` and the user and record reads word their `problem` by it
  (unreachable: could not be reached, check connection, reload the tab; denied: "may not be allowed"; other: neutral "could not be read";
  session: the 401 message). The who-are-you step keeps the causes of both tries (session first, then unreachable). A record that returns no row is not a failure. Current user: REST
  `chatter/users/me` for the Id, then `/services/oauth2/userinfo` as a fallback, then a `SELECT` on `User`; if
  only the User query fails the Chatter fields are used with a note. Verified read-only against a sandbox through the dev server: org, user, record pages (Account, Case, Opportunity), a list view, a Setup page and home. Not verified: the real popup → browser-session path and the real clipboard.
- `tools/page-details/page-details.js` — the page. `?host=`, `?dev=1`, `?demo=1` as elsewhere; `?url=` is the cleaned
  address from the popup and is cleaned again on the page. For a Setup page (not in dev or demo mode) it calls `chrome.tabs.query({})`
  once and passes only the matching tab's cleaned title on; a failure falls through silently (raw note under Technical details only). The "What happened" note is read at click time and never kept.
- Sample: `samples/page_details_demo.json` (made-up; a test checks it stays synthetic).
- Tests: `tests/page_details_tests.mjs` (includes the no-innerHTML, no-storage guard).
- Rules that matter: reads only; never the session id, cookies or page body (the one tab read is the tab's title, for Setup pages only); no values beyond name, record type,
  owner and dates; the popup passes `cleanUrl(tab.url)` (`shared/pageurl.js`) only; the page says to paste only into the company's own
  ticket system. A hash-based address (old `/one/one.app#/...`) loses its record because the hash is dropped;
  `parsePageUrl` sets `hashAddress` (kind "other" and cleaned path `/one/one.app`) and the Page area says to open the record again.
- The note is cleaned only by `scrubNote` (`00D…!…` session ids, long `Bearer` tokens, `sid=` / `access_token=` /
  `refresh_token=` / `id_token=` / `oauth_token=`); `code=` and bare `token=` stay. When it removes something the page
  shows one line near the buttons. Everything else (org text, address) still goes through the stricter `scrub`.
- An object name from the address must match `^[A-Za-z][A-Za-z0-9_]{0,79}$`, else the page is "other" (no reads). The
  failure texts are worded by cause (`failureCause`, `orgProblem`); the My Domain host shows even when that read fails.

## When to use it

- "What's the difference between these two PSGs?", "does group X give anything group Y doesn't?",
  "is the sandbox PSG the same as production?" → Compare permission set groups.
- "What can this user access?", "how do these two users differ?" → User access summary and comparison.
- Field-level scoping for translations → `sf-translation-toolkit`, not this.
- Removing assignments → `sf-user-access-teardown`, not this.
- "Show me the whole role or territory tree", "get one branch into Excel" → the hierarchy page.
- "Why can (or can't) this user see this record?", "why does A see it and B not?" → the record access page.
- "Which flows use this field?", "what does each flow do with it?", "which flows mention this record Id?",
  "which flows run when an Account is saved, and in what order?", "which flows change or read Accounts?" → Where is it used in flows?
- "I need to raise a ticket and give support my org, user and page" → Page details for a ticket.

## Working on the code

1. Keep `compare-groups-logic.js` free of browser and network APIs; it is what the tests exercise.
2. Keep every org call a read (`query`, `count`, `describe`). Do not add DML, Metadata API
   deploys, or anything that changes the org.
3. Match items across orgs by API name (namespace included), never by Id.
4. Never insert org data with `innerHTML`; use the `el()` helper.
5. If you change the snapshot shape, bump `SNAPSHOT_SCHEMA`, keep `validateSnapshot` in step, and
   regenerate the samples: `python tests/make_samples.py`.
6. Run `node tests/run_tests.mjs`; it must end "All N checks passed."
7. To see the page: `python dev/dev_server.py --no-org`, open
   `http://127.0.0.1:8765/tools/compare-groups/compare-groups.html?demo=1`. Against a live org (read-only, only the org
   the user names): `python dev/dev_server.py --target-org <alias>`, open `?dev=1`. Pages
   reload by themselves on file changes, so there is no need to ask the user to reload Chrome.
8. Write UI text for admins, not developers: labels before API names, plain words, no raw
   error dumps in the main view (they go under "Notes" or a folded "Technical details").

## Guardrails

- No telemetry, no remote code (MV3 forbids it), no requests to any host but the org. The one other thing allowed is opening a github.com new-issue tab (`feedback.js`) that the user submits themselves; no org data in it (no host, org name, user names or page URL), no GitHub API calls, no tokens.
- `chrome.storage` is used only by `shared/menu-settings.js`, only for the list of hidden tool ids (`hiddenTools`, local area only; the sync area is never used). Never store the session id, host, org data or user names; no `localStorage` anywhere. A test checks that the store is the only file that uses browser storage; the other guards still ban it in every other file.
- Do not commit snapshots taken from a real org. `.gitignore` ignores `snapshots/` and
  `psg_*.json` outside `samples/`.
- Verified against a live sandbox (read-only, through the dev server): fields, objects, system
  permissions, tabs, setup-item names, component lists, user counts, and what muting takes away
  for fields, objects, system permissions and tabs. Not verified: muted apps/pages/code, the
  extension's own cookie session path, opening the CSV in Excel. Say so when reporting results.

## Verify against an org

Compare two groups in a sandbox. Spot-check in Setup: one object row (Object Settings), one
system permission, one component permission set, and the assigned-user count.
