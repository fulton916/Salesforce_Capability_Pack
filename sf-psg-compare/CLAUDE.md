# CLAUDE.md — sf-psg-compare

## What this is

A Chrome MV3 extension (plain ES modules, no build step, no dependencies) with three read-only tools,
named in the toolbar menu "Compare permission set groups", "Look up user access" and "Territory & role hierarchy". It reads the
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

## Look up user access (second tool)

A read-only page, `extension/user-access.html`, that shows one user's access (profile and license,
role, call center, permission set groups, permission sets with "directly / through group", permission set
licenses, public groups, queues, territories, and hierarchy custom settings whose value for the user differs from the org default) and compares two users. Same look as the compare page:
it links `psg-compare.css` and adds a little in `user-access.css`.

- `extension/lib/useraccess.js` — `searchUsers(api, text)` (LIKE search in the org, escaped with
  `soqlString` / `soqlLike`, LIMIT 50) and `readUserAccess(api, userId)` →
  `{schema: "sf-user-access/1", user, sections, unavailable, warnings}`. Reads `User`,
  `PermissionSetAssignment`, `PermissionSetGroup(Component)`, `PermissionSet`, `MutingPermissionSet`,
  `PermissionSetLicenseAssign`, `GroupMember`, `UserTerritory2Association`, `CallCenter` (own query, `SELECT CallCenter.Name ... FROM User`), `EntityDefinition`, `Organization`, describe + read per hierarchy custom setting. Only the user read may
  throw; every other area fails softly into `unavailable` (plain words) and `warnings` (raw).
- `extension/lib/usercompare.js` — pure: rows, `compareUsers(a, b)`, verdict, CSV. Custom settings: `resolveHierarchy` (user, then profile, then org default, per field, first non-null wins; checkbox false counts), `settingItems` (only fields differing from the org default; item key `Setting__c.Field__c`), `customSettingsLine`, `customSettingsSkippedNote`, `customSettingsFailedNote`. `access.customSettingsInfo = {found, examined, hierarchy, failed, failedSettings, skippedFields, capped}`; older files without `callCenter` / `customSettings` still load as empty.
  Custom settings are found with `EntityDefinition WHERE IsCustomSetting = true`; hierarchy vs list is told by `describe` (has `SetupOwnerId`), 6 at a time, cap 300 settings (reported on the page), then one read per hierarchy setting. Custom fields of special types (encrypted, address, location, base64, anyType, complexvalue) are not read; they are counted in `skippedFields` and the page says so once, and a setting whose fields are all skipped is not counted in "N of M". A setting that fails goes to `warnings` and `customSettingsInfo.failedSettings`; the rest is kept and the page shows a note ("2 settings could not be read"). Only when every setting fails (or the list itself cannot be read) is `unavailable.customSettings` set ("Not available"). In a compare, rows of a setting that could not be read for one user get status `unreadA`/`unreadB` ("Could not be read for <name>"), counted as `unread`, never as a difference. The CSV has "Note" rows in the custom settings area (count line with the cap notice, skipped fields, could not be read). The wider "no such field" match (INVALID_FIELD, No such column) applies to the call center only; territories keep their original wording.
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

## When to use it

- "What's the difference between these two PSGs?", "does group X give anything group Y doesn't?",
  "is the sandbox PSG the same as production?" → Compare permission set groups.
- "What can this user access?", "how do these two users differ?" → Look up user access.
- Field-level scoping for translations → `sf-translation-toolkit`, not this.
- Removing assignments → `sf-user-access-teardown`, not this.
- "Show me the whole role or territory tree", "get one branch into Excel" → the hierarchy page.

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
