# CLAUDE.md — sf-psg-compare

## What this is

A Chrome MV3 extension (plain ES modules, no build step, no dependencies) with four read-only tools,
named in the toolbar menu "Compare permission set groups", "User access summary and comparison", "Territory & role hierarchy" and "Why can a user see this record?". It reads the
org through the REST API with the user's existing browser session and never writes to the org.
Visible text says "license"; data keys keep the old `licence` spelling so saved files still load.
Visible text avoids "PSG" and "snapshot" (say "saved group file"); code and developer docs may use them.

- `extension/lib/sfconn.js` — finds the API session from the `sid` cookie; `SfApi.query` pages
  through `nextRecordsUrl`.
- `extension/lib/snapshot.js` — `takeSnapshot(api, psgId)` reads one group into a JSON snapshot
  (`schema: "sf-psg-snapshot/2"`; `/1` files still load, see `ACCEPTED_SCHEMAS`). Permissions come from the group's aggregate permission set
  (`PermissionSet.Type = 'Group'`, `PermissionSetGroupId = <psg>`).
- `extension/lib/compare.js` — `compareSnapshots(a, b)` → `{sections, counts, highlights, gives}`; also `filterRows`, `toRows`, `cardLines` (summary card text) and `sortRows`/`sortGrouped`/`sortSection` (what the page shows and exports). Pure.
- `extension/lib/pick.js` — search words (punctuation is a separator) for the group box and lists. Pure.
- `extension/lib/feedback.js` — `issueUrl({kind, tool, version})` builds the GitHub new-issue link (`bug.yml` / `enhancement.yml` in `.github/ISSUE_TEMPLATE/`; the query keys are the form field ids, the dropdown value is the exact option label). Only tool, extension version and browser go in. Pure. Used by the popup and the header links on all three pages.
- `extension/popup.js` — the toolbar menu: one entry per tool, enabled only on a Salesforce tab.
- `extension/psg-compare.js` — the Compare permission set groups page. Builds DOM with `textContent` only.

## User access summary and comparison (second tool)

A read-only page, `extension/user-access.html`, that shows one user's access (profile and license,
role, permission set groups, permission sets with "directly / through group", permission set
licenses, public groups, queues, territories) and compares two users. Same look as the compare page:
it links `psg-compare.css` and adds a little in `user-access.css`.

- `extension/lib/useraccess.js` — `searchUsers(api, text)` (LIKE search in the org, escaped with
  `soqlString` / `soqlLike`, LIMIT 50) and `readUserAccess(api, userId)` →
  `{schema: "sf-user-access/1", user, sections, unavailable, warnings}`. Reads `User`,
  `PermissionSetAssignment`, `PermissionSetGroup(Component)`, `PermissionSet`, `MutingPermissionSet`,
  `PermissionSetLicenseAssign`, `GroupMember`, `UserTerritory2Association`. Only the user read may
  throw; every other area fails softly into `unavailable` (plain words) and `warnings` (raw).
- `extension/lib/usercompare.js` — pure: rows, `compareUsers(a, b)`, verdict, CSV.
- `extension/user-access.js` — the page. `?host=`, `?dev=1`, `?demo=1` work as in `psg-compare.js`.
  Demo: `http://127.0.0.1:8765/user-access.html?demo=1`.
- Tests: `tests/user_access_tests.mjs`, run from `tests/run_tests.mjs`.
- Rules that matter: matching by API name, never Id; no user snapshots or files (usernames);
  no `innerHTML`, `localStorage` or `chrome.storage` (a test checks); group and queue membership is
  direct only (say so in help text). Not covered: object/field access, nested group membership.

## Territory & role hierarchy (third tool)

A read-only page, `extension/hierarchy.html`, that shows the whole territory tree (Territory2, one
model) or role tree (UserRole), opened out, with a search that narrows the page to one branch and a
CSV export with the tree in the cells. Links `psg-compare.css` and adds `hierarchy.css`.

- `extension/lib/hierarchy.js` — pure, tested: `buildTree` (sorted by name, numbers by value; missing
  parent goes to the top level; a loop is cut at its first member by name (`loopCut`), and every member is flagged `inLoop`; iterative walks, so deep
  chains are safe), `flatten`, `pathOf`, `branchOf`, `searchNodes` (pick.js words, limit 50, results carry
  the path), `exportRows` (stepped "Level 1..N", "API name", "Path"), `exportFileName`, `summaryText`,
  `treeNotes` (with a branch's items it counts only the nodes on screen), and the user helpers `attachUsers`,
  `listUsers`, `countUsers`, `usersSummary`, `USER_FIELDS`; `exportRows(tree, top, users)` adds "Users" and
  "User 1..N" columns when `users` is `{byNode, field, includeInactive}`. Re-exports `toCsv` from `compare.js` (which guards cells starting with = + - @ tab CR).
- `extension/lib/hierarchyread.js` — `readTerritoryModels` (`{on: false}` when the org has no
  territories: the `Territory2Model` query fails with INVALID_TYPE; no describeGlobal call, it was slow), `readTerritories(api,
  modelId)`, `readRoles` (portal roles left out, counted with `COUNT()`), and the user reads (SELECT only,
  only when "Show users" is turned on): `readRoleUsers` (`User WHERE UserRoleId != null AND UserRole.PortalType = 'None'`, active and inactive,
  filtered in memory so the tick box needs no new read; portal and community users are not read, only counted
  with two `COUNT()`s, all and `IsActive = true`, each with `UserRoleId != null` because `!= 'None'` alone also matches
  people without a role; returns `portalUsers {active, all}`, or null with the reason in `warnings` if a count fails) and `readTerritoryUsers(api, modelId)`
  (`UserTerritory2Association` with `User.*`; `RoleInTerritory2` is deliberately not read: on real orgs it holds
  bare numbers). `countUsers` returns people (`active`, `inactive`) and assignments (`activeAssignments`,
  `inactiveAssignments`); `usersSummary(counts, includeInactive, kind)` words Territories as people in assignments.
- `extension/hierarchy.js` — the page. Flat rows built once with a DocumentFragment; folding only
  toggles `hidden` on a row range; "Show API names" is a CSS class; the search renders at most 50
  list items. Show users: each row has a `.people` block filled in place (no re-render, no org call) when the
  field or the inactive box changes; users are cached per tree in a `WeakMap`, memory only; a failed user
  read is kept on the entry and shown as a message about users only (raw text in Notes). `?host=`, `?dev=1`, `?demo=1` as elsewhere. Demo:
  `http://127.0.0.1:8765/hierarchy.html?demo=1`.
- Samples: `extension/samples/hierarchy_territories.json`, `hierarchy_roles.json` (made-up, written
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

A read-only page, `extension/record-access.html`, that explains how one user can see the record open
in the current Salesforce tab, and with two users why one sees it and the other doesn't. Links
`psg-compare.css` and `user-access.css`, and adds `record-access.css`. The popup button reads the active
tab's address with `recordIdFromUrl` and opens `record-access.html?host=<host>&record=<id>`; with no
record in the address the button stays enabled and the page opens with an empty record box (a box
takes a pasted link or Id, which is also how the dev server is used).

- `extension/lib/recordaccess.js` — pure, tested: `recordIdFromUrl`, `to18`, `explain(facts, userIds)`
  (routes per user as chains of plain steps, `mismatch`, `difference`, `verdict`, `notes`),
  `toPlainText`, `owdText`, `causeInfo`. Facts shape: schema `sf-record-access/1` (see the demo file).
- `extension/lib/recordaccessread.js` — `readRecordContext(api, id)` (record, owner, parent, org-wide
  default; throws plain `Error`s) and `readRecordAccess(api, ctx, users)` (everything else; each area fails
  softly into `notes` / `warnings`). SELECT, COUNT and describe only.
- `extension/record-access.js` — the page. `?host=`, `?dev=1`, `?demo=1`, plus `&record=`. Demo:
  `http://127.0.0.1:8765/record-access.html?demo=1` (`samples/record_access_demo.json`, made up).
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
- Access through the account (Cases and Opportunities with an `AccountId`; `recordaccess.js` `acctScope`,
  `shareRows(rows, scope)`; reader `readAccountAccess`): the record's own share rows and the parent
  account's share rows go through the same loop, so groups (nested), roles, role-and-subordinates,
  territories, bosses-groups and role-above are reused. Facts: `facts.account = {id, name, rows:[{who,
  level, cause}], truncated, owner:{id, name, roleId, level}}`, and `user.accountTeamRole`. The reader
  selects `UserOrGroupId, RowCause, CaseAccessLevel` (or `OpportunityAccessLevel`) from `AccountShare`
  for the account (one query, LIMIT 2000) and drops None and Owner rows. The owner's level is the Owner
  row's level, with `UserRole.CaseAccessForAccountOwner` / `OpportunityAccessForAccountOwner` as
  fallback. Routes have keys and topics prefixed `acct:` and `detail.acct`, so they take part in topic
  matching and `hasInFacts`. An account route starts "The case belongs to account 'X'" and says
  "...which gives <level> access to the account's cases". A None row gives no route. The object-permission
  cap applies as for other routes. Extra queries: 1 account name, 1 AccountShare, 1 owner, 1 role, plus 1
  AccountTeamMember per user. Territory routes on the account come only from AccountShare Territory rows.
  Contacts are not covered.
- Confirmed live (sandbox, read-only queries): `AccountShare.CaseAccessLevel`, `OpportunityAccessLevel`,
  `ContactAccessLevel`; `UserRole.*AccessForAccountOwner`; the Owner row equals the role setting; Team,
  Manual, Rule, Territory and Territory2AssociationManual rows carry their own levels; ImplicitParent
  rows are None. Consistent with the data but not proven: people above an account holder or the account
  owner in the role hierarchy get the same level. Not tested: that role-above route for Cases.
- Still not covered: contacts through the account, restriction and scoping rules, Experience Cloud sharing sets, which specific
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
- Reads in this tool go through `withRetry(api)` (recordaccessread.js, used by record-access.js only; sfconn.js is
  unchanged): GET failures that are a dropped connection or HTTP 500/502/503/504 or errorCode SERVER_UNAVAILABLE (only with a 5xx
  status or none) are retried twice (300 ms, 1 s; delays and sleep are injectable for tests). Any 4xx is never retried,
  whatever its errorCode; nor are query errors.
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

## When to use it

- "What's the difference between these two PSGs?", "does group X give anything group Y doesn't?",
  "is the sandbox PSG the same as production?" → Compare permission set groups.
- "What can this user access?", "how do these two users differ?" → User access summary and comparison.
- Field-level scoping for translations → `sf-translation-toolkit`, not this.
- Removing assignments → `sf-user-access-teardown`, not this.
- "Show me the whole role or territory tree", "get one branch into Excel" → the hierarchy page.
- "Why can (or can't) this user see this record?", "why does A see it and B not?" → the record access page.

## Working on the code

1. Keep `compare.js` free of browser and network APIs; it is what the tests exercise.
2. Keep every org call a read (`query`, `count`, `describe`). Do not add DML, Metadata API
   deploys, or anything that changes the org.
3. Match items across orgs by API name (namespace included), never by Id.
4. Never insert org data with `innerHTML`; use the `el()` helper.
5. If you change the snapshot shape, bump `SNAPSHOT_SCHEMA`, keep `validateSnapshot` in step, and
   regenerate the samples: `python tests/make_samples.py`.
6. Run `node tests/run_tests.mjs`; it must end "All N checks passed."
7. To see the page: `python tools/dev_server.py --no-org`, open
   `http://127.0.0.1:8765/psg-compare.html?demo=1`. Against a live org (read-only, only the org
   the user names): `python tools/dev_server.py --target-org <alias>`, open `?dev=1`. Pages
   reload by themselves on file changes, so there is no need to ask the user to reload Chrome.
8. Write UI text for admins, not developers: labels before API names, plain words, no raw
   error dumps in the main view (they go under "Notes" or a folded "Technical details").

## Guardrails

- No telemetry, no remote code (MV3 forbids it), no requests to any host but the org. The one other thing allowed is opening a github.com new-issue tab (`feedback.js`) that the user submits themselves; no org data in it (no host, org name, user names or page URL), no GitHub API calls, no tokens.
- Do not store the session id (no `chrome.storage`, no `localStorage`).
- Do not commit snapshots taken from a real org. `.gitignore` ignores `snapshots/` and
  `psg_*.json` outside `extension/samples/`.
- Verified against a live sandbox (read-only, through the dev server): fields, objects, system
  permissions, tabs, setup-item names, component lists, user counts, and what muting takes away
  for fields, objects, system permissions and tabs. Not verified: muted apps/pages/code, the
  extension's own cookie session path, opening the CSV in Excel. Say so when reporting results.

## Verify against an org

Compare two groups in a sandbox. Spot-check in Setup: one object row (Object Settings), one
system permission, one component permission set, and the assigned-user count.
