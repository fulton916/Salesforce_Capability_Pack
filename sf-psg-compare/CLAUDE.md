# CLAUDE.md — sf-psg-compare

## What this is

A Chrome MV3 extension (plain ES modules, no build step, no dependencies) with four read-only tools,
named in the toolbar menu "Compare permission set groups", "Look up user access", "Territory & role hierarchy" and "Where is it used in flows?". It reads the
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
- `extension/lib/feedback.js` — `issueUrl({kind, tool, version})` builds the GitHub new-issue link (`bug.yml` / `enhancement.yml` in `.github/ISSUE_TEMPLATE/`; the query keys are the form field ids, the dropdown value is the exact option label). Only tool, extension version and browser go in. Pure. Used by the popup and the header links on all four pages.
- `extension/popup.js` — the toolbar menu: one entry per tool, enabled only on a Salesforce tab.
- `extension/psg-compare.js` — the Compare permission set groups page. Builds DOM with `textContent` only.

## Look up user access (second tool)

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

## Where is it used in flows? (fourth tool)

A read-only page, `extension/flow-usage.html`, that finds the flows using a field (object + field), or containing a
text or record Id, and shows the step in each flow with what it does (sets / checks / uses); and, when only an object
is picked, the object view ("which flows run when an Account is saved, in order, and which others change or read
Account records"). Links `psg-compare.css` and adds `flow-usage.css`.

- `extension/lib/flowscan.js` — pure, tested: `scanFlow(metadata, target, {describe})` (async only because relationship
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
- `extension/lib/flowobject.js` — pure, tested: the object view. `buildObjectView(object, entries, {labelOf, objectLabel, partial})`
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
- `extension/lib/flowread.js` — `readFlowList` (one `FlowDefinitionView` SELECT including `TriggerObjectOrEvent.QualifiedApiName`, `TriggerOrder`,
  `HasAsyncAfterCommitPath`; `DurableId` is the 300 flow Id; a column the org rejects by name is dropped and the query repeated, otherwise
  it falls back to the short list), `versionsToRead` (active version of active flows; with `includeInactive` also the
  latest version where it differs; a version Id that is not a 301 Id, as on some installed packages
  (`MktCloud__Name-1`), becomes `versionId: null`), `readFlowVersion` (Tooling `SELECT Id, Metadata FROM Flow WHERE Id = '301...'`,
  one row per call, or Salesforce returns no Metadata), `readVersions` (5 in flight, progress callback, one failure never
  stops the rest, a version already in the cache is not read again), `whyUnreadable`, `resolveContext` (Tooling
  `CustomField` / `CustomObject` by Id).
- `extension/lib/urlcontext.js` — pure: `parseUrlContext(url)` (Setup field and object pages, `/lightning/r/...`,
  `/lightning/o/...`), `contextQuery`, `contextFromParams` (keeps API names and 00N / 01I Ids, drops anything else), `pickByDeveloperName`. `popup.js` passes only `object` and
  `field`, never the address.
- `extension/flow-usage.js` — the page. `?host=`, `?dev=1`, `?demo=1`, plus `object=` and `field=`. Flow contents live in a
  Map for the page session (memory only), shared by the field search and the object view; describes are cached per object.
  Picking an object runs the object view at once (list facts first, then the trigger flows' contents, then the rest, with
  the progress line); picking a field runs the field search; `object=` alone (record page, list view) runs the object view.
  The Flow Builder link needs the validated `?host=` and a 301 version Id, so flows with no usable Id get no link.
- Sample: `extension/samples/flow_usage.json` (written by hand; made-up flows, objects and describes, Ids like
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

## When to use it

- "What's the difference between these two PSGs?", "does group X give anything group Y doesn't?",
  "is the sandbox PSG the same as production?" → Compare permission set groups.
- "What can this user access?", "how do these two users differ?" → Look up user access.
- Field-level scoping for translations → `sf-translation-toolkit`, not this.
- Removing assignments → `sf-user-access-teardown`, not this.
- "Show me the whole role or territory tree", "get one branch into Excel" → the hierarchy page.
- "Which flows use this field?", "what does each flow do with it?", "which flows mention this record Id?",
  "which flows run when an Account is saved, and in what order?", "which flows change or read Accounts?" → Where is it used in flows?

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
