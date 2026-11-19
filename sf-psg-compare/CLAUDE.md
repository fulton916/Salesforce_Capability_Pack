# CLAUDE.md — sf-psg-compare

## What this is

A Chrome MV3 extension (plain ES modules, no build step, no dependencies) that compares two
Salesforce permission set groups. It reads the org through the REST API with the user's existing
browser session and never writes to the org.

- `extension/lib/sfconn.js` — finds the API session from the `sid` cookie; `SfApi.query` pages
  through `nextRecordsUrl`.
- `extension/lib/snapshot.js` — `takeSnapshot(api, psgId)` reads one group into a JSON snapshot
  (`schema: "sf-psg-snapshot/2"`; `/1` files still load, see `ACCEPTED_SCHEMAS`). Permissions come from the group's aggregate permission set
  (`PermissionSet.Type = 'Group'`, `PermissionSetGroupId = <psg>`).
- `extension/lib/compare.js` — `compareSnapshots(a, b)` → `{sections, counts, highlights, gives}`; also `filterRows`, `toRows`, `cardLines` (summary card text) and `sortRows`/`sortGrouped`/`sortSection` (what the page shows and exports). Pure.
- `extension/lib/pick.js` — search words (punctuation is a separator) for the group box and lists. Pure.
- `extension/psg-compare.js` — the page. Builds DOM with `textContent` only.

## User access (second tool)

A read-only page, `extension/user-access.html`, that shows one user's access (profile and licence,
role, permission set groups, permission sets with "directly / through group", permission set
licences, public groups, queues, territories) and compares two users. Same look as the compare page:
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
  `treeNotes`. Re-exports `toCsv` from `compare.js` (which guards cells starting with = + - @ tab CR).
- `extension/lib/hierarchyread.js` — `readTerritoryModels` (`{on: false}` when the org has no
  territories: the `Territory2Model` query fails with INVALID_TYPE; no describeGlobal call, it was slow), `readTerritories(api,
  modelId)`, `readRoles` (portal roles left out, counted with `COUNT()`).
- `extension/hierarchy.js` — the page. Flat rows built once with a DocumentFragment; folding only
  toggles `hidden` on a row range; "Show API names" is a CSS class; the search renders at most 50
  list items. `?host=`, `?dev=1`, `?demo=1` as elsewhere. Demo:
  `http://127.0.0.1:8765/hierarchy.html?demo=1`.
- Samples: `extension/samples/hierarchy_territories.json`, `hierarchy_roles.json` (made-up, written
  by hand; `make_samples.py` does not rebuild them).
- Tests: `tests/hierarchy_tests.mjs`, run from `tests/run_tests.mjs` (includes the no-innerHTML,
  no-storage guard for the new files).
- Rules that matter: reads only; org text only through `textContent` / `el()`; nothing stored; names
  that repeat are told apart by path, never by name alone.

## When to use it

- "What's the difference between these two PSGs?", "does group X give anything group Y doesn't?",
  "is the sandbox PSG the same as production?" → this tool.
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
   error dumps in the main view (they go to Technical notes).

## Guardrails

- No telemetry, no remote code (MV3 forbids it), no requests to any host but the org.
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
