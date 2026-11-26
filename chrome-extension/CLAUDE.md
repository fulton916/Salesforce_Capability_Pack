<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

# CLAUDE.md — chrome-extension

(This folder was `sf-psg-compare` until the extension became the pack's main toolkit. Saved-file schema ids such as `sf-psg-snapshot/3` keep the old name on purpose.)

## What this is

A Chrome MV3 extension (plain ES modules, no build step, no dependencies) with nine read-only tools,
named in the toolbar menu "Compare permission set groups", "User access summary and comparison", "Territory & role hierarchy", "Why can a user see this record?", "Where is it used in flows?", "Page details for a ticket", "Error Tracer: read a debug log", "Where does a user get this permission?" and "Search the Setup Audit Trail". It reads the
org through the REST API with the user's existing browser session and never writes to the org.
Visible text says "license"; data keys keep the old `licence` spelling so saved files still load.
Visible text avoids "PSG" and "snapshot" (say "saved group file"); code and developer docs may use them.

## Folder layout and naming

People "Load unpacked" this folder: `manifest.json` sits directly inside it.

```
manifest.json, menu.html, menu.js    the toolbar menu
settings.html, settings.js           the Settings page (manifest `options_ui`): turn tools on or off in the menu
shared/        tool-list.js (TOOLS: the one list the menu and Settings read), menu-settings.js (hidden-tool store; the only chrome.storage user), sfconn.js, sfread.js (readOrg), roles-read.js (readRoles), users-read.js (searchUsers; user-access, record-access, who-grants), users-logic.js (matchUsers),
               recordid.js (recordIdFromUrl, looksLikeId), pageurl.js (cleanUrl), csv.js (toCsv), feedback.js, pick.js,
               urlcontext.js, livereload.js, pack.css, user-picker.css (user list and error box styles for user-access, record-access and who-grants)
tools/<tool>/  one folder per tool: compare-groups, user-access, hierarchy, record-access, flow-usage, page-details, error-tracer, who-grants, audit-trail
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

- `shared/sfconn.js` — `API_VERSION` is `"67.0"` (one tested version for every org, one release behind the newest). `useNewestVersion(api)` (GET `/services/data/`; sets the org's newest listed version (higher or lower than the default; non-positive entries are ignored) on that `SfApi` instance only, one shared promise per instance; sets `api.versionListFailed` and keeps the default when the list cannot be read) lives here; who-grants and compare-groups call it, other tools stay at the default. Call it before the first versioned read: the describe cache is not keyed by version. Finds the API session from the `sid` cookie; `SfApi.query` pages
  through `nextRecordsUrl`; `SfApi.getText(path)` is a GET-only read that returns plain text (used for a debug log body).
  Both share one failure builder, so the 401 wording is the same.
- `tools/compare-groups/compare-groups-read.js` — `takeSnapshot(api, psgId)` reads one group into a JSON snapshot
  (`schema: "sf-psg-snapshot/3"`; `/1` and `/2` files still load, see `ACCEPTED_SCHEMAS`). It awaits `useNewestVersion(api)` first (and `listPsgs` does too, before its query), so the group is read at the org's newest API version, and records `apiVersion` (string such as `"68.0"`) at the top level. When the version list could not be read it still reads at the default and adds one warning ("This tool could not ask Salesforce which versions it offers, ... Reload the page, then read this group again."; reloading is the fix because `useNewestVersion` remembers the failure on that `SfApi` until the page reloads, so "Try Compare again" would not help; the text does not start with "Could not", so the page adds no "Try Compare again"); a 401 on the list does not block anything, the next read shows the usual session-expired message. Permissions come from the group's aggregate permission set
  (`PermissionSet.Type = 'Group'`, `PermissionSetGroupId = <psg>`).
- `tools/compare-groups/compare-groups-logic.js` — `compareSnapshots(a, b)` → `{sections, counts, highlights, gives}` (`highlights` carries one `warn` note when the two groups were read with different API versions or a file records none, via `versionNumber(s)`: only a string like "68" or "68.0" counts, anything else is "not recorded"; versions compare as numbers; same version gives no note; the fix sentence depends on the orgs: groups from different orgs (both `org.id` present and different) get "If the org of X now offers a newer version, read X again (and save its file again if you use a file). If that org is on an older Salesforce release, the note stays until both orgs are on the same release.", same or unknown org get "To fix this, read X again from its org (and save its file again if you use a file), then compare."; when both groups have the same label the note names them "Label (org name)", or "Label (first group)" / "Label (second group)" when the org names are also the same or unknown (other notes already prefix the group name, and the verdict and overview lines are left as they are); the note shows in Notes and raises the page's warning alert ("These results may be incomplete or misleading. See Notes below.", worded so it also fits a version-only note, where nothing failed), also when the verdict is "exactly the same access"; the exports do not include notes); also `filterRows`, `toRows`, `cardLines` (summary card text) and `sortRows`/`sortGrouped`/`sortSection` (what the page shows and exports). Pure.
- `shared/sfread.js` — `readOrg(api, apiHost)`: the org's name and edition for each page's header (one SELECT).
- `shared/csv.js` — `toCsv(rows)`: RFC 4180 with a BOM; guards cells starting with = + - @ tab CR. Pure.
- `shared/pick.js` — search words (punctuation is a separator) for the group box and lists. Pure.
- `shared/feedback.js` — `issueUrl({kind, tool, version})` builds the GitHub new-issue link (`bug.yml` / `enhancement.yml` in `.github/ISSUE_TEMPLATE/`; the query keys are the form field ids, the dropdown value is the exact option label). Only tool, extension version and browser go in. Pure. Used by the popup and the header links on all nine pages.
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

- `shared/users-read.js` — `searchUsers(api, text)` (LIKE search in the org, escaped with `soqlLike`, LIMIT 50; opt-in `{emailAndId: true}` for the audit trail page); `shared/users-logic.js` — `matchUsers` (demo search). Used by user-access, record-access and who-grants.
- `tools/user-access/user-access-read.js` — `readUserAccess(api, userId)` →
  `{schema: "sf-user-access/1", user, sections, unavailable, warnings}`. Reads `User`,
  `PermissionSetAssignment`, `PermissionSetGroup(Component)`, `PermissionSet`, `MutingPermissionSet`,
  `PermissionSetLicenseAssign`, `GroupMember`, `UserTerritory2Association`, `CallCenter` (`SELECT CallCenterId FROM User`, then `SELECT Id, Name, InternalName FROM CallCenter WHERE Id = ...`, cached per Id; a path such as `CallCenter.Name` fails in a real org because the field has no relationship name), `EntityDefinition`, `Organization`, describe + read per hierarchy custom setting. Only the user read may
  throw; every other area fails softly into `unavailable` (plain words) and `warnings` (raw).
- `tools/user-access/user-access-logic.js` — pure: rows, `compareUsers(a, b)`, verdict, CSV. Custom settings: `resolveHierarchy` (user, then profile, then org default, per field, first non-null wins; checkbox false counts), `settingItems` (only fields differing from the org default; item key `Setting__c.Field__c`), `customSettingsLine`, `customSettingsSkippedNote`, `customSettingsFailedNote`, `customSettingsHiddenNote`. Secret-like fields are hidden at read time: `isSecretLike(field)` (API name or label matches key/token/secret/password/passwd/pwd/credential/private, case-insensitive; booleans exempt) makes `settingItems` build an item with `hidden: true`, `value`/`orgDefault` null, `valueText`/`orgDefaultText` = "Hidden (looks like a key)" and `valueId` (a one-way fingerprint, only used so compare can tell two hidden values apart). The raw value is never kept, rendered or exported; keep any new display/export path on `valueText`/`orgDefaultText`. The page and CSV show one note sentence when any item is hidden. `access.customSettingsInfo = {found, examined, hierarchy, failed, failedSettings, skippedFields, capped}`; older files without `callCenter` / `customSettings` still load as empty.
  Custom settings are found with `EntityDefinition WHERE IsCustomSetting = true`; hierarchy vs list is told by `describe` (has `SetupOwnerId`), 6 at a time, cap 300 settings (reported on the page), then one read per hierarchy setting. Custom fields of special types (encrypted, address, location, base64, anyType, complexvalue) are not read; they are counted in `skippedFields` and the page says so once, and a setting whose fields are all skipped is not counted in "N of M". A setting that fails goes to `warnings` and `customSettingsInfo.failedSettings`; the rest is kept and the page shows a note ("2 settings could not be read"). Only when every setting fails (or the list itself cannot be read) is `unavailable.customSettings` set ("Not available"). In a compare, rows of a setting that could not be read for one user get status `unreadA`/`unreadB` ("Could not be read for <name>"), counted as `unread`, never as a difference. The CSV has "Note" rows in the custom settings area (count line with the cap notice, skipped fields, could not be read). The wider "no such field" match (INVALID_FIELD, No such column) applies to the call center only (and only to the `CallCenterId` read: a failure reading the CallCenter object gives the plain "could not be read" text); territories keep their original wording.
- `tools/user-access/user-access.js` — the page. `?host=`, `?dev=1`, `?demo=1` work as in `compare-groups.js`.
  Demo: `http://127.0.0.1:8765/tools/user-access/user-access.html?demo=1`.
- Einstein Activity Capture (EAC), inside this tool (issue #31). `tools/user-access/user-access-eac.js` (pure: `STATUS_WORDS`, `statusWords`, `isConnected`, `buildEacRows`, `eacCounts`, `groupByConfig`, `filterEacRows`, `filterNoConfig`, `eacCsvRows`, `noConfigCsvRows`, `assignedText`, `flagText`, `eacDetailText`, `eacItem`, `SHOW_CHOICES`) and `user-access-eac-read.js` (`readEacRaw`, `readEacAccessUserIds`, `readUserEac`, `readPastedUsers`; SELECT and describeGlobal only; own pager so it can report progress). Reads `UserEmailCalendarSync` (`AssignedId`: a `005` user, or a `00e` profile; `ConfigurationId`, prefix `063`) and `ActivityUsrConnectionStatus` (`UserId`, `UserName` = the person's DISPLAY name, not a username; `ConfigurationName`, `ConnectivityStatus`, `RecommendedActionTitle/Description`, `ContactsSynced`, `EventsSynced`, `IsTermsOfServiceAccepted`, `GlobalOauthTermsState`, `UserOnboardingStatus`).
  **`COUNT()` returns 0 on both objects even when rows exist: never use it; count the rows read** (`eacCounts`). **Never put a WHERE on either object** (a real org answers with a generic server error, "An unexpected error occurred... ErrorId"): read all rows, paged, and filter in memory, also for the single-user read (a test makes the fake org refuse any WHERE there). **A blank `ConnectivityStatus` is common (25 of 25 and 33 of 38 rows in two sandboxes) and means "Not connected yet (no status)"; only `ACTIVE` is connected** (so Idle and every other value is "not connected" too). A user assigned with no status row is "Assigned, not connected yet".
  `buildEacRows` joins the objects per user and configuration NAME and returns `{rows, profileAssignments, noConfig}`. Names: `configs` (the describeGlobal try; no queryable object has prefix 063 in the sandbox seen, so it is a harmless extra), else inferred from users who have exactly one assignment and one status row (the status row's `ConfigurationName` names the assignment's Id; majority vote), else "Unnamed configuration (Id 063...)" with the full Id so the admin can match Setup's Configurations tab. A profile assignment (`00e`) becomes one row per member of `profileMembers[profileId]` (the reader reads `User WHERE ProfileId = '<validated id>'`, paged, active and inactive); a user both direct and through a profile, or assigned twice, is ONE row (`direct`, `profiles[]`, `assignedText` = "Directly", "Through the profile X", or "Directly and through the profile X"). A profile whose members could not be read stays in `profileAssignments` (a note). Row flags: `isActive` false = "Inactive user, still assigned"; `nothingSynced` = ACTIVE and both `ContactsSynced` and `EventsSynced` KNOWN and false or 0 (null/blank is unknown, not flagged: uat2 had ACTIVE users with both null and the row showed "Not known"). `noConfig`: `accessUserIds` minus every user with any row; `null` when access could not be read.
  Access: `readEacAccessUserIds` runs `SELECT AssigneeId FROM PermissionSetAssignment WHERE Assignee.IsActive = true AND (PermissionSet.PermissionsAutomaticActivityCapture = true OR PermissionSet.PermissionsStdAutomaticActivityCapture = true)` (paged; profile-owned and group aggregate permission sets are included); if that fails (for example INVALID_FIELD) each permission is asked alone and every answer that works is used; if both fail `ids` is null and `note` is one plain sentence (the page keeps everything else). Not verified live: this query in a real org (the brief asked for it to be checkable live: it is its own exported function).
  One user: area key `eac` (list items keyed by configuration name; compare matches by name, "Different" when status or any shown fact differs; included in the CSV). Everyone: a panel on the page (`#eacPanel`, "Show everyone"), no user needed. Sections per configuration (name, member count, "This configuration (CSV for Excel)"), a "Show" selector (Everyone, Not connected, Inactive users still assigned, Connected nothing synced yet, Has access but is in no configuration), a shared search, "Show API names", downloads (Everyone, What is shown now, Users in no configuration), and counts folded below. Each section draws 200 members and "Show 200 more"; progress reads "Reading... 1,200 connections / users". The reader throws an error with `featureOff = true` when the objects are missing or not visible (INVALID_TYPE); the single-user area then sets `unavailable.eac` to "Einstein Activity Capture is not turned on in this org, or you can't see it." with no warning, and every other area is untouched. If only one object fails, the other is used and the list says it may be incomplete. User Ids from rows are checked (`^[A-Za-z0-9]{15,18}$`) before use in a query; names are read in batches of 200. Ids are compared by their first 15 characters (`id15`): test and demo Ids must differ inside those 15 characters. Demo: `samples/eac_all_demo.json` (raw shape the reader returns, run through `buildEacRows`; includes profile members, an unnamed configuration, an inactive user, a connected-nothing-synced user and users with access in no configuration) and an `eac` section in `user_a.json` / `user_b.json`. Configurations with no members cannot be listed: in a real sandbox no object with prefix 063 was found through the REST sObject list, the Tooling API or any Metadata type, so only configurations with an assignment or status row appear; the panel always shows `EMPTY_CONFIG_NOTE` saying so (the describeGlobal 063 try stays, it is free). `eacCounts` also returns `connectedUsers` / `notConnectedUsers` (distinct users; connected if any row is ACTIVE) and `eacSummaryLine` uses them, never row counts. The download is labelled "Everyone in a configuration" (users in no configuration have their own). A single user with no rows sees `NO_EAC_USER_TEXT`. Demo files agree: Blake Sample is Connected in `eac_all_demo.json` and `user_b.json` (compare differs on events synced). Not verified live: the permission query above, a profile assignment in a real org, the name of the object behind prefix 063 (none found in one sandbox).
- EAC changes as text (issue #42), `tools/user-access/user-access-eac-changes.js` (pure) plus `readPastedUsers` and `readEacPermissionAssignments` in `user-access-eac-read.js`. **The extension never writes**: it builds text that the admin loads in Salesforce Inspector (Data Import) or Data Loader. Output has only API names and Ids (`checkTable` refuses any cell that is not `^[A-Za-z0-9]{15,18}$` and real, `usableId`).
  **Why Remove goes through permission assignments:** every `UserEmailCalendarSync` row and every `ActivityUsrConnectionStatus` row has `Id = 000000000000000AAA` and `ExternalId` null in real orgs (two sandboxes, read-only), so those rows cannot be updated or deleted by Id. The person who asked for the feature says: in a configuration with more than 500 users you remove someone by removing their Einstein Activity Capture permission, which takes them out of the configuration (Data Loader cannot do it on `UserEmailCalendarSync`). Not verified in a real org. **Never key anything by the assignment Id: all rows collide** (the members logic keys by user and configuration; `profileKey` = profile + configuration).
  - Add = insert `UserEmailCalendarSync` `AssignedId`, `ConfigurationId` (works; unchanged).
  - Remove = delete `PermissionSetAssignment` `Id` for the picked users' assignments that grant EAC. `readEacPermissionAssignments(api, userIds)` runs `permissionQuery(ids, cond)`: `SELECT Id, AssigneeId, PermissionSetId, PermissionSet.Name, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name, PermissionSet.Type, PermissionSetGroupId, PermissionSetGroup.DeveloperName, PermissionSetGroup.MasterLabel FROM PermissionSetAssignment WHERE AssigneeId IN (<batch of 200 validated Ids>) AND (PermissionSet.PermissionsAutomaticActivityCapture = true OR PermissionSet.PermissionsStdAutomaticActivityCapture = true)` (a WHERE on PermissionSetAssignment is fine; never on the two EAC objects). If it fails, each field is asked alone and every answer that works is used (the combined query is not tried again for later batches); if both fail it throws an error with the plain `PERMISSION_READ_FAILED` message and the raw text in `raw`. Rows go through `permissionRowFrom` (`{id, userId, setId, groupId, ownedByProfile, profileName, setLabel, setName, groupLabel, groupName}`). A permission set GROUP assignment is expected as a row whose `PermissionSet` is the group's combined set (`Type` Group) with `PermissionSetGroupId` filled in (not verified live); it is named by the group's `MasterLabel`.
  - `planChange({action, targetId, entries, rows, permissions, notFound})` returns `{items, skipped:[{name, code, detail}], notFound, duplicates, error, previewed:false}`. For Move and Remove `permissions` (an array from the reader) is required, else `error`. An item is one user: `{userId, name, fromConfigId, fromName, configs, removals:[{id, kind: "set"|"group", setId, groupId, label, apiName}], note}`. One result per user (`duplicates` counts repeated picks). Per user, in order: not in a configuration (`notIn`), Move only: already in the target (`alreadyThere`) and inactive (`inactive`), in only through a profile's assignment (`profileOnly`: the profile assignment cannot be removed here, change it in Setup > Einstein Activity Capture > Configurations), directly in more than one configuration (`severalRows`: removing the permission would remove them from all), no EAC-granting assignment (`noPermission`), any granting assignment owned by their profile (`profilePermission`, detail = the profile name; none of their rows is listed), else every granting assignment is listed (inactive users can be removed). Add's skips: `alreadyThere`, `inactive`, `useMove`, `profileOnly`, `badId`. The old `noRealId`, `sameTarget`, `allNoRealId` and the profile-assignment items are gone. `involvedPermissions(plan)` lists each set and group with how many picked users lose it; `permissionWarning(kind)` is the per-item warning; `planRemovalCount`.
  - Output: `changeSteps(plan)`: Add one step; Remove one step (Delete `Id`); Move three: (1) the Remove delete, (2) give back (`giveSet`: Insert `PermissionSetAssignment` `AssigneeId, PermissionSetId`; `giveGroup`: `AssigneeId, PermissionSetGroupId`; separate tables so no cell is blank), (3) Add to the target. `undoSteps(plan)` is only for Remove: give back (same two tables), then Add back to the original configuration(s). Move has no undo text (`MOVE_UNDO_NOTE`: Move back). `outputFor(plan)` returns `{steps, undoSteps}` (each step `{title, note, loads}`, each load `{key, label, object, op, header, rows, text, csv}`), throws until `plan.previewed` is true (the page sets it after drawing the preview), and is null when nothing is left to load. `inspectorSteps(load)` gives the on-page Inspector steps for one load. The page reads the permission assignments (async) in `runPreview` before calling `planChange`; demo mode reads `permissionAssignments` (API-shaped `PermissionSetAssignment` records) from `samples/eac_all_demo.json`. Profile assignments (`profileRows`) are only listed with the Setup pointer (`PROFILE_ASSIGNMENT_NOTE`).
  Typed target configuration: `validConfigId` = `063` + 12 or 15 letters/digits. A target can be a known configuration (from assignment rows) or typed, because empty configurations cannot be listed. Pasted names: `parsePasted` (lines, commas; case-insensitive duplicates dropped; 500 max), `userLookupQueries` (`SELECT Id, Name, Username, Email, IsActive FROM User WHERE Username IN (...) OR Email IN (...)`, 50 per batch, values through `soqlString`; a WHERE on User is fine, never on the two EAC objects), `matchPasted` (a username wins; an email on several users picks nobody: `ambiguous`). Clipboard: `copyWithFallback(text, navigator.clipboard)` returns `{copied}`; on false the page shows a read-only textarea set through `.value` with "Select all and copy". Not verified live: the permission query, loading the text in a real Inspector or Data Loader, whether a group insert needs only `PermissionSetGroupId` (we send no `PermissionSetId`), Inspector's menu wording, and the "more than 500 users" removal rule (the page says so). The change CSV is built with `toCsv` and then its leading BOM is stripped in `csvText` (`shared/csv.js` is unchanged), so Data Loader reads the first header as `Id`. Move and Remove keep the warning "This changes who captures email and calendar activity. Check the preview first." and add "We have not verified this load in a real org." Preview numbers use `toLocaleString("en-US")` (2,558). `Element.append(null)` prints "null": filter nulls before `append` (done in `findPasted`; `el()` already skips them).
  `buildEacRows` returns `{rows, profileAssignments, noConfig, profileRows}`; rows carry `assignmentIds` (the user's own `UserEmailCalendarSync` Ids; placeholders in real orgs, no longer used by the plan).
  Demo Ids in `samples/eac_all_demo.json` are 15 or 18 characters like real Ids (the change builder refuses anything else). Its `permissionAssignments` has one user with one set, one with a set and a group (two rows), group-only users (the group affects two users), one user whose access comes from their profile, and users with none.
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
- `tools/record-access/record-access-rules.js` — pure, tested: restriction and scoping rules. `parseCriteria(text, forUser)` (one or more
  `field op value` joined by AND, or all by OR; ops = != < <= > >=; value a quoted text, number, true/false/null or `$User.Field`; anything
  else, such as parentheses, IN, LIKE, mixed AND/OR, `Owner.Name` paths, is "too complex" and gives `ok: false` with a reason),
  `neededFields(rules)`, `checkRule(rule, userVals, recVals)` (outcome `hides` / `passes` / `notApplies` / `maybe` for restriction rules,
  `scopes` / `notApplies` / `maybe` for scoping rules; text compares ignore case, 15 and 18 character Ids are equal), `ruleSentences`.
- Restriction and scoping rules: `readRecordAccess` reads, once per Explain (org-wide cache key `rules:<object>`), Tooling API
  `SELECT Id, DeveloperName, MasterLabel, IsActive, TargetEntity, EnforcementType, UserCriteria, RecordFilter, Description FROM
  RestrictionRule WHERE TargetEntity = '<API name>' AND IsActive = true` (`api.query(soql, {tooling: true})`). Facts:
  `facts.rules = {read, error, items:[{id, devName, label, type: "Restrict"|"Scoping", userCriteria, recordFilter, description}],
  recordValues}` and `user.ruleValues` (one extra SELECT on User per user and one on the object for the record, only fields the rules use,
  validated against describe and limited to comparable types). A failed read is `read: false` with the cause, never "none". `explain`
  gives each user `rules = {state: none|found|failed|unread, header, lines}` and `ruleSfNote`; a user Salesforce says cannot see the record
  gets the hiding (or may-hide) restriction rules as the first causes instead of the old generic one (omitted when the rules were read and
  none can hide it); `difference.rules` lists a rule that hides or may hide the record for one user and not the other (and turns "same
  access" into a difference). Scoping rules are only ever worded as changing the default list views and searches, never as hiding.
  Confirmed live (developer org `sf-dev-org`, custom object `ZZ_Test_Rec__c`, 2026-11-22): `EnforcementType` is `Restrict` or `Scoping`;
  `UserCriteria` and `RecordFilter` are stored exactly as typed in the metadata (for example `$User.Department = 'X'`, `Region__c = 'East'`,
  `OwnerId = $User.Id`); the Metadata API accepted only a single condition on each side in that org (AND, OR, !=, IN, parentheses, dates all
  failed on deploy), so the AND / OR / other-operator support is written for what Salesforce documents, not seen live. And
  `UserRecordAccess` did NOT reflect a restriction rule: for a user matching the rule's criteria, on a record outside its filter, it still
  said the user can read the record. The page therefore says "Salesforce's answer above may not include restriction rules (in a test it still said 'can view' ...)" (only when a
  rule hides it by its criteria), and the headline carries the same caveat in one sentence. Wording is always "by its criteria" / "should hide",
  never observed fact; when Salesforce already says no access the rule "would also hide" and is not a likely reason (`wouldAlso`); with two users
  the headline never says "same access" when the rules differ; a text-vs-number comparison (`<`, `>`) is `maybe`, not false. Not confirmed: that the rule really hid the record for that user (no way to run a query as that user from
  the CLI here).
- Tests: `tests/record_access_tests.mjs` (reasoning, mismatches, a faked org, rules, the guard).
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
- Still not covered: Experience Cloud sharing sets, which specific sharing rule. Access through the account is only as complete as the account's first 2000 share rows.
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
  list is still loading and used only when territories are on. Progress is "Reading… (n of m)", counted per area (8 + users).
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
- Not covered (also in the page's Notes and the README): Experience
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

## Error Tracer: read a debug log (seventh tool)

A read-only page, `tools/error-tracer/error-tracer.html`, for an admin chasing an error a user hit. The page
lists the steps for turning on a debug log in Setup (done by the person, never by the page), reads the list of
`ApexLog` rows and one log's body, and shows what failed, where and for which user in plain words, with the raw
lines folded under each finding. Links `shared/pack.css` and adds `error-tracer.css`.

- `shared/sfconn.js` `SfApi.getText(path)` — a GET that returns the body as text (a log body is not JSON). Same
  Bearer header and the same errors as `get` (401 wording, Salesforce message in `detail`); never sets a method.
- `tools/error-tracer/error-tracer-read.js` — `readLogList(api)` (one SELECT on `ApexLog`, `ORDER BY StartTime
  DESC LIMIT 100`, rows `{id, userId, userName, operation, request, application, status, location, startTime,
  durationMs, length}`), `readLogBody(api, id)` (checks `isLogId` first, then `getText` on
  `/sobjects/ApexLog/<id>/Body`), `plainProblem(e, what)` -> `ReadProblem` (plain `message`, raw Salesforce text
  in `raw` for the folded Technical details; the 403 wording says seeing logs, especially other people's, may need
  extra permission and names no permission).
- `tools/error-tracer/error-tracer-logic.js` — pure. `analyzeLog(text, {length})` is one pass over the lines with
  a code-unit stack (no per-line work beyond one regex, so a 20 MB log is fine); returns `{version, levels,
  coverage, user, findings, problemCount, handledCount, notes, cutOff, headline, subline, lines}`. Finding kinds:
  `apex`, `save`, `validation`, `flow`, `limit`; each has `title`, `message`, `where`, `steps`, `time`,
  `elapsedMs`, `handled`, `count`, and `start`/`end` line numbers for `rawAround(analysis, finding)`. Other
  exports: `explainSaveError`, `frameWords`, `flowPointer`, `summaryText`, `isLogId`, `filterLogs`,
  `userChoices`, `whatRan`, `statusWords`, `humanSize`.
- `tools/error-tracer/error-tracer.js` — the page. `?host=`, `?dev=1`, `?demo=1`. Log lines are built when a "Log
  lines" block is first opened. Nothing is kept beyond the page session.
- Sample: `samples/error_tracer_demo.json` (five hand-written made-up logs, Ids `07L000000000001AAA`, example.com).
- Tests: `tests/error_tracer_tests.mjs` (includes the GET-only guard: a recording fake fetch that fails on any
  method but GET, and a static scan of the tool's files for write words and trace flag / debug level API names).
- Rules that matter: **GET only. The tool never creates or changes a TraceFlag or DebugLevel** (the guard test fails
  on those names and on `method:`); the steps text tells the person to do it in Setup. Org text only through
  `textContent` / `el()`. The same error is one finding: an `EXCEPTION_THROWN` that is later followed by a
  `FATAL_ERROR` with the same message is folded into it; thrown errors with no fatal error are shown as "may have
  been handled", listed after the problems and never counted in the headline; a rule that fails and the save
  error it causes are one card; a flow step error and the interview error after it are one card. "No errors found"
  always says what the log recorded (`coverage`, from the levels line) and says what it did not record, so "no
  flow errors" is never claimed when Workflow was below Info. The flow pointer is words only ("open Where is it
  used in flows? from the toolbar menu"): no import or link into `tools/flow-usage/`.
- Guessed or unchecked log layouts (not verified against a real org): `FLOW_ELEMENT_ERROR|message|type|name`,
  `FLOW_START_INTERVIEW_BEGIN|orgId|flowName`, `FLOW_CREATE_INTERVIEW_END|interviewId|flowName`, `VALIDATION_ERROR|message`
  (the page also copes when the rule's message only comes from the save error), the exact `CODE_UNIT_STARTED` shapes
  for flows and validation, and the Setup wording in the steps. The log's own clock (user's time zone) is shown only in the folded
  raw lines; cards say "N seconds after the log started" (from the nanosecond field; under 1 ms, "At the start of the log") so the page has one clock. Times from the list ("When", the result fact, Copy text) are the browser's time and always carry "(your time, <zone>)" (`whenText`); the user's own zone is the separate fact "User's time zone". An area the levels line says is too low but that the log itself shows (a `Validation:` code unit, flow events, `DML_BEGIN`) gets `coverage[].partial` and is worded "recorded only in part", never "not recorded". The coverage and cut-off warnings are said once, in the line under the headline (`subline`, labels such as "Validation rules"); Notes keep only one sentence of Setup advice for all missing or partial areas ("To record what is missing, edit the debug level in Setup and set the categories named above (Database, Validation, Workflow) to Info or finer, then repeat the action."; Setup names inside it only), never one note per area, and never restate an area or the cut-off. A quoted message that already ends in . ! or ? gets no extra full stop after the closing quote (`quoted()`). A validation save error takes its record type from an earlier `Validation:` unit only if no other code unit and no `DML_BEGIN` ran since (`valClean`). One label for handled errors: "May have been handled". The list stacks into cards under 640px (CSS `data-label`), Result right after When. A flow code unit
  that names only an object is worded "a flow on Case records" until a FLOW_START_INTERVIEW_BEGIN gives the flow's name. Text with no
  header and no events gets `notLog` and the headline "This does not look like a debug log". When adding native `append`/`replaceChildren`
  calls, never pass null (it becomes the text "null").

## Where does a user get this permission? (eighth tool)

A read-only page, `tools/who-grants/who-grants.html` (GitHub issue 32), for one user and one permission: every
profile, permission set and group that gives it, including what muting removes, and a copyable answer. Links
`shared/pack.css` and `shared/user-picker.css` and adds `who-grants.css`. The bar it was built against: Setup > Users > a user > View Summary
(User Access Summary) with its row action "Access Granted By", and PSG Compare.

- `tools/who-grants/who-grants-read.js` -- `readGrants(api, user, spec, {progress, now})` returns facts (`schema: "sf-who-grants/1"`:
  `user`, `units` (profile, a permission set assigned directly, or a group; each with `status` active / needsActivation / expired / revoked / inactive and `expires`),
  `objectPermissionsApply` (object or field asks only: `false` when the object is not in the `ObjectPermissions` `SobjectType` list, so no object permissions exist for it (Task, Event and 23 more; `true` when it is listed or a row was found; `null` when that describe could not be read or has no list; absent for a system permission),
  `sets` (by 15-character Id: `id` (full), `profileId` (for a profile's permission set, for its Setup link), `sys {target, viewAllData, modifyAllData, viewAllFieldsGlobal}`, `obj` (every object level) and `fld` (Read, Edit)), `groups` (aggregate set, parts, muting sets, `componentsRead`, `status`), `problems`, `notes`).
  spec = `{kind: "system", api, label}` | `{kind: "object", object, objectLabel}` | `{kind: "field", object, objectLabel, field, fieldLabel}`;
  **the level is not part of the read**: every level is read, so the page redraws a new level from the same facts. Names are validated
  (`^Permissions...`, `Object`, `Object.Field`, Ids) before they go into SOQL. Several assignment rows for one set or group are all read and the best one counts (active, then session-based, then inactive, expired, revoked; the later expiry wins a tie). A directly assigned set (or a row with no usable set Id) that the `PermissionSet` query did not return is kept as a unit (`unnamed: true`, labelled "A permission set you don't have permission to see", or "A permission set that could not be identified" for a row with no set Id; shown without a kind prefix or quotes) and is "Could not be checked" when active (never silently dropped). When the whole read of the assigned sets failed, the read problem is listed once and those units are left out. Every SELECT names each column once (the PermissionSet column list is made unique: asking about View All Data, Modify All Data or View All Fields (Global) used to select the column twice, a 400 "duplicate field selected", so every set failed); the fake org in the tests refuses duplicate columns and columns its describe does not list. `FieldPermissions` is read with `SobjectType = '<object>' AND Field = '<object>.<field>'`.
  Only the user and the assignments throw; every other read becomes a `problem`
  (`text`, `short`, `raw`, `blocks`) and hedges the answer. Calls `useNewestVersion(api)` from `shared/sfconn.js` first (falls back silently). It also exports
  `readSystemList`, `readObjectList`, `readFieldDescribe` (the picker lists, from `describe` of `PermissionSet`, `ObjectPermissions` and `FieldPermissions`, cached by `SfApi.describe`).
  Columns are asked for only if describe shows them (`HasActivationRequired`, `PermissionsViewAllFieldsGlobal`, `ObjectPermissions.PermissionsViewAllFields`, assignment `ExpirationDate` / `IsActive` / `IsRevoked`); without a describe only the columns every version has.
  The group's combined permission set is found with `PermissionSet WHERE PermissionSetGroupId IN (...) AND Type = 'Group'`; the parts from `PermissionSetGroupComponent`; a part not in `PermissionSet` is read from `MutingPermissionSet` (a muting set can also be a `PermissionSet` of Type `Muting`). Ids are chunked 200 at a time; `ObjectPermissions` / `FieldPermissions` are read with `ParentId IN (...)` including the muting set Ids.
- `tools/who-grants/who-grants-logic.js` -- pure. `analyze(facts, spec)` (spec adds `level`), `sectionsOf(result)` (what the page and the copy text show), `copyText`, `copyWithFallback`,
  `systemItems` / `objectItems` / `fieldItems` (drops `X` when `XId` exists with the same label: one field) / `matchItems` (pick lists; ranked: label starts with the text, then a label word starts with each typed word, then API-name words (split at capitals) too, then any other substring match, last; ties by label), `systemApiShort` ("PermissionsExportReport" -> "ExportReport", used for the small API name in lists and in the copy text; the data keeps the full name) / `fieldApiShort(field, object)` ("Account.Rating" -> "Rating"), `setupUrl(host, kind, id, {groupId})` (pure: `https://<host>/lightning/setup/PermSets|PermSetGroups|EnhancedProfiles/page?address=%2F<Id>`; null unless the host is a Salesforce host that also passes `^[A-Za-z0-9][A-Za-z0-9.-]*$` (`isSalesforceHost` only checks the end of the text, so `evil.com/x.salesforce.com` would pass it) and the Id passes `^[A-Za-z0-9]{15,18}$` with the expected prefix 0PS / 0PG / 00e / 0QM; a muting set (0QM) opens through its group's page and needs a 0PG `groupId`; the Id is never changed, a profile uses `ProfileId` from its permission set), `sectionsOf` items carry `links` (`{kind, id, groupId, own, caption, text, label}` for the card's own thing and each named permission set or muting set; `text` is the visible words, `label` the accessible name and starts with it; none for an unnamed set or one with no Id; the copy text has no links or Ids), `factsFromModel` (demo only; `model.noObjectPermissions` lists objects with none), `whenStamp`, `dateWords` (UTC date), `expiryWords(iso, timeZone)` (the person's local date and time with the zone abbreviation; `sectionsOf(r, {timeZone})` and `copyText(r, {timeZone})` pass an optional IANA zone so tests are stable), `permissionWords`. A `notActive` item's `why` is data (`{code: expired|revoked|inactive, expires}`), worded in `sectionsOf`.
- `tools/who-grants/who-grants.js` -- the page. `?host=`, `?dev=1`, `?demo=1`. One `makeCombo` helper serves the four search boxes (user, system permission, object, field): arrow keys, Enter, Escape, only the newest search may draw, lists capped at 100. While a box with a chosen row says something else (typed over, or emptied) the answer is hidden and Find is disabled (`isDirty`, `syncView`; the facts and the run token are untouched, so no read starts and one in flight is not dropped). Blur or Escape (`leave`) puts the chosen text back and the same answer shows again; an emptied box that is left clears that choice (`onClear`, which also clears the answer). "Open in Setup" links (`setupLink`) are built only when `?host=` is a Salesforce host (`LINK_HOST`; `?dev=1&host=` works for the links), never in demo mode, `target=_blank rel="noopener noreferrer"`, `aria-label` = the link's `label`, text via `textContent`.
- Sample: `samples/who_grants_demo.json` (a made-up org: three users, one inactive; sets, groups, muting; hints for what to try are shown on the page). Tests: `tests/who_grants_tests.mjs` (fake org behind a recording GET-only fetch, so the real `SfApi` runs; static scan of the tool's files).
- Rules (decided in the brief, checked live where noted):
  - **The group's combined (aggregate) permission set is the truth for what a group gives.** Aggregate has it: gives, naming the parts that have it (none readable: "could not tell which permission set inside"; a muting set that lists it while the aggregate still has it: a note). Aggregate lacks it and a part has it: muting takes it (system: the flag; field: Read muted removes Read and Edit, Edit muted removes Edit; object: any muted flag the level depends on, `DEPENDS`) -> "Removed by muting"; no muting and Status not Updated -> "not sure" (recalculating); otherwise "In a group but not passed on" (hedged). Parts or the group unreadable -> "Could not be checked" and a hedged headline. Never any "No." headline (muted, not passed on, session, ended, not given anywhere, "no Read on the object") when a needed read failed: `analyze` answers "unsure" ("Not sure. ...") first whenever nothing gives it and something needed was not checked (blocking problem or a "could not be checked" source), and a muted group is then only named as a known part ("What we do know: the group \"X\" would give it, but its muting permission set removes it."). A field that is given while the object access could not be checked (blocking problem, or `objectPermissionsApply` null with no object row) is "Yes. ... but whether they have Read on X could not be checked." (`objectAccess.has` is null); only a fully read org says "no Read on X, so it does not work". `tests/who_grants_tests.mjs` has a property test that takes each read away in turn (every kind and level, nine situations) and checks that a Yes never becomes a No and a No never becomes a Yes.
  - Implied access ("Also covers it", counted as giving it): object Read and View All by View All Data or Modify All Data; Create, Edit, Delete, Modify All by Modify All Data; field Read by View All Fields on the object or View All Fields (Global); field Edit by nothing; Modify All Data and View All Data do not override field permissions. One source that gives it both ways is one place.
  - **A session-based set or group (`HasActivationRequired` or Type `Session`) is always "Needs session activation" and never counted.** Seen live: `PermissionSetAssignment.IsActive` was true for a session set nobody had activated, so it says nothing about activation. Expired (`ExpirationDate` past, only for the moment before Salesforce hides the row), `IsRevoked` and `IsActive = false` go to "Not active". Every answer that is not Yes carries the note `ENDED_NOTE` ("If an assignment ended recently, Salesforce no longer shows it, so it cannot be listed here."), also in the copied text. On an API version without those columns an ended assignment may still be counted (a note says so).
  - **A column that could not be asked for never gives a confident No** (`columnState` in the reader: "yes", "no" or "unknown"). Optional columns: `ObjectPermissions.PermissionsViewAllFields`, `PermissionSet.PermissionsViewAllFieldsGlobal` (only a field's Read), `PermissionSet.HasActivationRequired` and `PermissionSetGroup.HasActivationRequired` (session-based). With a readable describe the column is "yes" if listed; if not listed it is "no" (the org's version has no such feature, no hedge) unless `/services/data/` could not be read (`api.versionListFailed`, set by `useNewestVersion`), then "unknown". With a failed describe the column is tried alone (`SELECT <column> FROM <object> LIMIT 1`) and used if it works; if Salesforce refuses it (INVALID_FIELD / No such column) it is "no", otherwise (or with a failed version list) "unknown". Unknown shows as a `null` flag in the facts (`obj.viewAllFields`, `sys.viewAllFieldsGlobal`) and `activationUnknown` on the set, unit and group; `analyze` decides per level: a field Read with a null implier and nothing else giving it is "Not sure" ("... \"View All Fields on X\" could not be checked"); field Edit and object and system asks are not affected. A source that gives it but may be session-based gets a hedge sentence in the Yes headline and in the notes (never counted as session-based, never dropped). A Yes whose only source is a group not `Updated` says in the headline that it may change (with other sources the note is enough). Checked only offline (fake org that refuses columns its describe lacks); live runs on the developer org are listed below.
  - Checked live (developer org, 2026-11-23, read-only): group status seen Updated, Outdated, Updating, Updated with correct answers each time; muting only (only a muted group gives Delete on an object) answers "No ... its muting permission set removes it"; failed reads of groups, parts, muting sets, permission sets, object and field permissions give Yes or Not sure, never a wrong No; a platform license refuses View All Data, so implied-only access was not seen live (Salesforce writes explicit rows). Not tested live: an inactive user (none in the org), revoked or inactive assignment rows (none), a Failed group.
  - The "Access to the object" line for a field also says why when the access exists but does not count: only in a session-based assignment ("Edit on X: not right now; permission set "Y" gives it only after session activation."), only muted, or only ended ("... would give it, but muting removes it." / "... but the assignment has ended or is not active.").
  - Checked live (developer org, 2026-11-23): the only permission set with Modify All Data (the System Administrator profile's) also has View All Data, and no set has Modify All Data without it, so Modify All Data was NOT added as an implier of View All Data (it would change nothing seen). Salesforce documents that Modify All Data includes View All Data; one set is thin evidence.
  - A field answer also checks object access (Read; Edit for field Edit). Given without it: "No. ... is given ... but has no Read on X, so it does not work". **Not when the object takes no object permissions** (`facts.objectPermissionsApply === false`): then `objectAccess.notControlled` and the text "Access to X is not set by object permissions, so it is not checked here." (answer unchanged, never `notWorking`). `null` (describe unreadable) with no object row found hedges ("could not be checked"); a found row still counts.
  - Fields in the `FieldPermissions` `Field` picklist are the only ones field permissions control; an unlisted name gets the hint `UNLISTED_FIELD_HINT`. Checked live (developer org, API 68): the list holds both `Account.Parent` and `Account.ParentId` (also `OperatingHours` / `OperatingHoursId`, `DandbCompany` / `DandbCompanyId`; 170 such pairs, all with the same label), but they are ONE field: filtering `Field = 'Account.Parent'` returns rows whose Field is `Account.ParentId`. So `fieldItems` drops `X` when `XId` exists with the same label. `Account.BillingAddress` (135 rows) and `Account.ShippingAddress` (93) are listed; `BillingStreet` is not. The API name is shown small under each label.
  - Checked live (API 68): 25 objects have fields in the `FieldPermissions` list but are not in the `ObjectPermissions` `SobjectType` list (they take no object permissions): Task, Event, OpportunityLineItem, OrderItem, AssetRelationship, AssignedResource, AppointmentInvitee, ApprovalSubmissionDetail, ChangeRequestRelatedItem, ConsumptionRate, CreditMemoLine, IncidentRelatedItem, InvoiceLine, ProblemRelatedItem, ResourceAbsence, ReturnOrderLineItem, ServiceResourceSkill, ServiceTerritoryMember, ShiftWorkTopic, ShipmentItem, SkillRequirement, TimeSlot, WorkOrderLineItem, WorkPlanTemplateEntry, WorkStep. (The FieldPermissions `SobjectType` list has 76 more objects than the ObjectPermissions one, but only those 25 have fields in the Field list.)
  - Checked live: a permission set with View All Data has explicit `ObjectPermissions` rows (Read and View All) for every object, and View All Fields on an object auto-creates `FieldPermissions` Read rows for its fields. So implied access usually shows as an explicit row plus "also covered by" on the same card; the "Also covers it" section appears mainly for groups, or where a row is missing. The implied logic stays. Muting Account Delete requires muting Modify All Records too; muting Account.Rating Edit carried Read=true and Edit=true in the muting row, and the aggregate lost both Read and Edit. Salesforce hides an expired `PermissionSetAssignment` from SOQL (also ALL ROWS) within about 10 seconds of its expiry (proven live), so "Not active" shows an expired one only in that moment; revoked and `IsActive = false` rows are the other cases.
  - Checked live (developer org, API 68.0, read-only, through the dev server and the reader): profile, direct set, group with a part and a muting permission set (`MutingPermissionSet`, parts of a group that are not in `PermissionSet`), session set, an expiry date, field access, object access (all levels), `ViewAllFields` on an object (`PermissionsViewAllFields`), system permission, 672 system permissions and 3,215 objects in the lists, 228 objects and 40 Account fields in the field list. Re-checked live after the duplicate-column fix (developer org, 2026-11-23, through the dev server, read-only): the test user and a System Administrator, Modify All Data, View All Data, View All Fields (Global), View Setup, Export Reports, Account Delete, View All, Modify All and Read, Account.Rating Read and Edit and a custom field: every answer matched my own SOQL on the same assignments, and no response was an error. Not checked live: a group with Status not Updated, an inactive user. Checked by a tester on 2026-11-24 in real Chromium 141 with a made-up org: the real toolbar popup (`chrome.action.openPopup`, not a physical click), the cookie session lookup, all 8 menu entries, the answer pages, the real Windows clipboard, the Setup link opening, Settings on/off, nothing stored, the 401 and no-cookie messages. Still not checked: the toolbar path against a real org's session and in the user's own Chrome. Expiry dates are shown in the person's own time zone (`expiryWords`).
  - Setup links: built from `?host=` (`?dev=1&host=<my.salesforce.com or lightning.force.com host>` for tests). Address checked in a headless browser, and the Setup pages themselves were opened live by a tester on 2026-11-23 in one developer org: a profile, a permission set, a permission set group, a permission set inside a group and a session-based permission set. A muting set has no page of its own in these links: its link (visible text "Open the group in Setup") opens its group's page. Not checked in other orgs or editions. On the page each card has its own link on a line under the title and API name; each permission set a card names is listed once (`item.body` entries `{label, items: [{text, link}]}`: "Given inside the group by:", "Taken away by:", "Held inside the group by:", "Contained in the group by:") and no sentence on the page repeats them; `item.lines` stay the full sentences for the copied text. With no host or no Ids the same lists show without links. The search-box rules (hide answer and Find while typed over, blur and Escape restore, empty and leave clears) were checked in demo mode at 1200px and 375px. Items looked at and left alone: the "Needs session activation" section lines (a profile cannot be session-based; a set says "Assigned directly." and a group names the parts that contain it) are correct as they are.
- Errors: `errorWords(e, fallback)` -> `{message, raw}` (logic). Only a 401 and a `PlainError` (the reader's deliberate messages, and `findSession`'s, wrapped in `connect`) keep their own words; any other error (a TypeError included) shows the fallback and its text goes only under the folded Technical details. A failed `connect()` sets `state.api = null`, hides every `.org-only` part (boxes, kinds, hint, the Find row), keeps `#error` (its own panel part, not org-only) visible with "Log in to the org in this browser, then reload this page.", and focuses nothing. Sentences that join names use the right singular or plural (`pick`, `notPassedText`).
- Rules that matter: GET only; org text only through `textContent` / `el()`; matching by API name (the answer is for one org); nothing stored; the session id is never touched. The tests include a recording fetch that fails on any method but GET and a static scan for write words.

## Search the Setup Audit Trail (ninth tool)

A read-only page, `tools/audit-trail/audit-trail.html` (GitHub issue 60), so an admin can find who changed what in Setup
without downloading the audit trail CSV that Setup's "View Setup Audit Trail" page asks for. Links `shared/pack.css` and
`shared/user-picker.css` and adds `audit-trail.css`. The bar it was built against: the audit trail CSV (Date, User, Source
Namespace Prefix, Action, Section, Delegate User) opened in Excel with AutoFilter. The job: from several days with a lot of
noise, find every change about one thing (a permission set, field or user), see who and when, and paste the proof in a ticket.

- `tools/audit-trail/audit-trail-read.js` -- `buildWhere` / `buildQuery` / `buildCountQuery` (period bounds as UTC date-time literals, `CreatedById` through `soqlString` after `isUserId`; with `delegateUser` the person part is `(CreatedById = '<Id>' OR DelegateUser = '<username>')`, both through `soqlString`, and without a username just `CreatedById = ...`; **never Section or Display in a WHERE**: Salesforce refuses them), `readAuditTrail(api, {from, to, userId, delegateUser}, {control, onTotal, onPage, max})` (own pager over `api.get`, so rows show as they arrive; `SfApi.query` is untouched and not used), `plainProblem`, `MAX_ENTRIES = 50000` (= `READ_STEP`; one read keeps at most this many, the newest) and `MAX_HELD = 250000` (re-exported from the logic file: the most the page holds in memory). **A continuation ("Read older entries")** is the same read with `olderOrEqualMs` in the query: `buildWhere` adds `CreatedDate <= <that second as a UTC literal>` after the period bounds, newest first, own pager again (never one deep `nextRecordsUrl` chain); `readAuditTrail(..., {continuation: {total, held, skipIds, seqStart}, max})` makes no new COUNT (the total is the first read's), drops records whose Id is in `skipIds` (the held entries of the boundary second: neither lost nor doubled; dropped ones do not count against `max`) and continues `seq`; `read` then counts only the new entries and `short` compares `held + read` with the total. It never throws for a failed read: it returns `{status, read, total, problem?}` with status `complete`, `capped` (newest 50,000 kept), `stopped` (`control.stop`, keeps rows), `failed` (rows already delivered are kept), `short` (fewer than `SELECT COUNT()` said, never called complete), or `cancelled` (`control.cancel`, set by the page when a newer read starts: nothing more is delivered, so stale pages never mix in). A failed COUNT only means no total. Facts checked live in three real orgs (and brief, not re-derived): `CreatedById` is always filled, `CreatedBy` is null for a few Ids (2 to 4 per org; the label is "A user you can't see (005...)", "No user recorded" only without an Id), `DelegateUser` holds a username (login entry: maker and delegate are the same admin; entries made while logged in as someone: the maker appears to be the person used and the delegate the admin, inferred, not proven by a live login, so wording stays neutral), DelegateUser equality is case-insensitive, who was CHANGED is only in Display (not filterable; assignments carry name and 15-character Id, some field changes 18-character Ids, some entries a username, email or name only).  `SELECT COUNT()` works (`COUNT(Id)` and `MIN()` are refused), `ORDER BY CreatedDate DESC, Id DESC` works, only CreatedDate, CreatedById, Action, DelegateUser and ResponsibleNamespacePrefix are filterable, CreatedByContext and CreatedByIssuer are empty (not read). Checked live (read-only, two large orgs): reading past 2,000 rows through `nextRecordsUrl`, up to the 50,000 cap (the page stops there). The whole page was also checked read-only through the dev server against three real orgs (a small developer org and two large sandboxes): totals per kind and section, 7-day and chosen-date counts, "made by" with delegate entries, and "made to" matches equalled direct queries or independent matching; the 50,000 cap showed its warning. Not checked: the real toolbar button in the user's own Chrome, a live Login-As, Excel itself, reading beyond 50,000 in a real org (the continuation is tested offline and in demo mode only).
- `tools/audit-trail/audit-trail-logic.js` -- pure. `periodBounds(period, now, {from, to})` (local days; "to" inclusive by querying `CreatedDate <` the next local midnight, so a daylight-saving day is exact; rolling periods keep the wall-clock time), `kindLabel` (only splits words and capitalises: no meanings invented), `entryFromRecord` (precomputes the lower-case search text `hay`; `seq` = Salesforce's order), `parseSearch` / `searchMatches` / `highlightParts` (words in any order, "phrases", leading minus excludes, a hyphen inside a word is part of the word, a lone minus is ignored, plain substring so `Region__c` is found as typed), the person: `personMatcher` / `matchMadeTo(display, matcher)` (Id as a whole 15 or 18 character token, first 15 exactly; then username or email as a whole address, also with ".invalid" added or dropped, never inside a longer address; then the full name as whole words, Unicode-aware, apostrophe and hyphen variants; a name directly followed by `(UserID: [<other Id>])` or `(User, <other Id>)` is skipped per occurrence; no name-only match for an empty name or a one-word name under 4 characters; `matchMadeTo` looks only at the text, never at the maker: `personView` decides the maker rule per choice, see HOW_NAME_ALSO below), `madeBy` (recorded maker by first 15 of the Id, or delegate by username, case-insensitive), `personView(entries, {person, choice})` (copies with `how` and `viaDelegate`), `coverageFits(cover, who)` / `readFor(who)` (only "made by" is read with the person; a read of everyone covers every person and choice; otherwise `STALE_TEXT` and no list), `idAlternates` (an 18-character Id typed in the search also finds its 15-character form; the reverse is plain substring), `hiddenLabel` / `whoLabel`, `CHOICE_LABELS`, `HOW_*` wording; `emptyFilters` (with `who`, a chip), `runFilters` (one pass: shown rows plus counts per list that ignore only that list's own choice), `facetOptions` (a chosen option stays listed at 0), `toggleChoice` (include, exclude, only), `filterChips` / `removeChip` / `clearFilters`, `buildPeople` (two people with one name get their username added; no user = "No user recorded", never "automated"), `sortEntries` (stable; ties keep `seq`; nothing recorded sorts last), `partialNote` (status `reading` for an export taken mid-read, `continuing` on screen while older entries arrive) / `statusLine` / `readingStatusLine` / `emptyText` / `progressText` (the honest wording; every one uses the COMBINED coverage: `buildCoverage({status, read, total, oldestMs}, {step, maxHeld})` returns `{..., cap, maxHeld, canMore}` where `read` is everything held, `oldestMs` the oldest held, and `canMore` is true only for a capped, stopped or failed read with entries below `maxHeld`; `coverageWords` is the one-phrase version used by the status line and "0 found"; at `maxHeld` the note says the page holds at most 250,000 and to choose a shorter period or one person; complete after a continuation gives no note at all), `olderLabel` ("Read the next 50,000 older entries (12,060 left)", "Read the remaining 12,060", "Read 50,000 older entries" when the total is unknown; the limit shortens the step), `olderProgressText` ("Reading older entries... 112,000 of 626,000", the whole held count against the whole period's total), `continuationStart(entries)` (oldest second held and the held Ids in it), `searchLimitNote(step, maxHeld)` / `SEARCH_LIMIT_NOTE` (the "made to" hint), `matchCounts` / `matchBreakdown` (entries from `personView` carry `nameOnly`, true only when no maker, delegate, Id, username or email matched; counts of matches split certain from name-only). The maker rule, per choice: "Changes made by them" and "Either" count an entry made by them (maker or delegate) as certain, and one whose text also has their name says "...; their name is also in the text" (`HOW_NAME_ALSO`) with no warning; "Changes made to them" does not look at the maker at all (being the maker does not prove the name in the text is them), so an entry they made whose text has only their name stays `nameOnly` ("Matched by name only: may be another person"). A test pins all three. Only `nameOnly` entries carry "may be another person" (the page decides from the flag, never from the words of `how`). The status line says "entries that may be about them" when any match is name-only, else "about them", `chooseFocus` (pure: which control gets the keyboard after a redraw), `ticketText`, `shownText` (100 entries at most), `csvRows` (notes first: period, time zone, person, filters, entries read, and a Note row for a partial list), `copyWithFallback` (a local copy: the others live inside two other tools), `demoRecords` / `demoApi` (a fake org with `get` only, so demo mode runs through the real reader). Loops only (no spread of big arrays).
- `shared/users-logic.js` also holds `sfId18` (Salesforce checksum), `isSalesforceId`, `pastedUserId` (prefix 005); `searchUsers(api, text, limit, {emailAndId: true})` (opt-in: Email in the select and each word's condition, a pasted valid user Id as `OR Id = ...`, `email` on the result) and `matchUsers(users, text, limit, {emailAndId: true})`; without the option the query and result are exactly as before for the other tools.
- `tools/audit-trail/audit-trail.js` -- the page. The person lives in `filters.who` ({person, choice}) only; "What to find" is a select shown only with a person; Stop can be tried in demo mode because the fake org waits `delayMs` between pages; a first-page failure with nothing read hides the results. **Read older entries** (`readOlder`, button `#readOlder` in `#older`, drawn by `drawOlder` from `drawPartial`): continues the stored `state.readQuery` (the query asked, not the boxes), only while `state.cov.canMore`; refused (the button is replaced by `OLDER_STALE_TEXT`) when `periodSig()` differs from `state.readSig` (period or dates changed after the read) or when `coverageFits(state.cover, who)` is false; the person or choice are not read from the boxes. It uses the same `state.run` token and `state.control` as a first read: a new "Show the audit trail" cancels it and a stale pass delivers nothing; Stop keeps what was read; a failure keeps the entries and `canMore` stays true so the same button retries. It appends to `state.entries` (`seq` continues), schedules refilters like a first read (the delay grows to three times the last redraw so typing stays responsive at 250,000), and the focus goes from the button to Stop and, when Stop goes away, to the button or the status line. Held limit: `HELD_MAX` (250,000; no button, the note says so). Demo only: `?cap=N` makes a read take N entries and the limit 3 x N (`?cap=200`: 200, 400, then the remaining 80; `?cap=100`: stops at the limit of 300). A failed person search shows `plainUserSearchProblem` ("Could not search for users...", raw text folded) in its own `#personError` box under the Person box, never touching the results; the next good search or a read clears it. `?host=`, `?dev=1`, `?demo=1`. Nothing is read until "Show the audit trail". Typing is debounced and asks the org nothing; 200 rows are drawn, "Show 200 more" adds 200; the three lists are folded `details` that draw only when open. Controls that get rebuilt carry `data-fk`; `keepFocus` puts the keyboard back on the same one, else a neighbour (`chooseFocus`), else the search box or the status line (`preventScroll`). Exports first bring the list up to date (`exportReady`) and use status `reading` while a read runs. DOM by `el()` / `textContent`; matches are `<mark>` nodes. No connection message like who-grants has: the header says what it could not do.
- Demo: `http://127.0.0.1:8765/tools/audit-trail/audit-trail.html?demo=1` (add `&cap=200` to try "Read older entries"; `samples/audit_trail_demo.json`, 480 made-up entries stored as `secondsAgo`, so the default period always shows some; written by a one-off script, not by `make_samples.py`; includes a noisy kind at about 50%, null section and user, delegates, a package, same-second entries, two people named Sam Rivera, a very long sentence, a text that starts with `=` and one with `<img ...>`).
- Tests: `tests/audit_trail_tests.mjs` (the query, daylight-saving bounds with `process.env.TZ` set and restored, the pager with a fake client, the continuation (query text, boundary-second duplicates, capped, stopped, failed and retried, short, cancelled, the stale and limit guards, the combined wording in notes, status, "0 found", CSV and copy), the search, lists, sort, wording, CSV, copy, 50,000 and 250,000 entries, the demo, the guards).
- Rules that matter: GET and `SELECT` only; org text only through `textContent`; nothing stored (no storage of any kind) and nothing from the org in the page address or the feedback link; whenever the list is not the whole period a line says so above the results and in the CSV and the copied text, with the combined numbers (read N of M, back to when, whether more can be read); memory is bounded at 250,000 entries.

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
- "A user hit an error: what failed, where, and for which user?" (from a debug log) → Error Tracer: read a debug log.
- "Does this user get Delete on Account / View Setup / Edit on this field, and from where? Did muting remove it?" → Where does a user get this permission?
- "Who changed this permission set, field or user in Setup, and when?" (without downloading the audit trail file) → Search the Setup Audit Trail.

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
