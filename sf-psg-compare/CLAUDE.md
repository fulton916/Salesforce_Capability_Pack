# CLAUDE.md — sf-psg-compare

## What this is

A Chrome MV3 extension (plain ES modules, no build step, no dependencies) that compares two
Salesforce permission set groups. It reads the org through the REST API with the user's existing
browser session and never writes to the org.

- `extension/lib/sfconn.js` — finds the API session from the `sid` cookie; `SfApi.query` pages
  through `nextRecordsUrl`.
- `extension/lib/snapshot.js` — `takeSnapshot(api, psgId)` reads one group into a JSON snapshot
  (`schema: "sf-psg-snapshot/1"`). Permissions come from the group's aggregate permission set
  (`PermissionSet.Type = 'Group'`, `PermissionSetGroupId = <psg>`).
- `extension/lib/compare.js` — `compareSnapshots(a, b)` → `{sections, counts, highlights}`. Pure.
- `extension/psg-compare.js` — the page. Builds DOM with `textContent` only.

## When to use it

- "What's the difference between these two PSGs?", "does group X give anything group Y doesn't?",
  "is the sandbox PSG the same as production?" → this tool.
- Field-level scoping for translations → `sf-translation-toolkit`, not this.
- Removing assignments → `sf-user-access-teardown`, not this.

## Working on the code

1. Keep `compare.js` free of browser and network APIs; it is what the tests exercise.
2. Keep every org call a read (`query`, `count`, `describe`). Do not add DML, Metadata API
   deploys, or anything that changes the org.
3. Match items across orgs by API name (namespace included), never by Id.
4. Never insert org data with `innerHTML`; use the `el()` helper.
5. If you change the snapshot shape, bump `SNAPSHOT_SCHEMA`, keep `validateSnapshot` in step, and
   regenerate the samples: `python tests/make_samples.py`.
6. Run `node tests/run_tests.mjs`; it must end "All N checks passed."
7. To see the page: `python -m http.server 8765 --directory extension`, open
   `http://localhost:8765/psg-compare.html?demo=1`.

## Guardrails

- No telemetry, no remote code (MV3 forbids it), no requests to any host but the org.
- Do not store the session id (no `chrome.storage`, no `localStorage`).
- Do not commit snapshots taken from a real org. `.gitignore` ignores `snapshots/` and
  `psg_*.json` outside `extension/samples/`.
- The tool has not been run against a live org. Say so when reporting results, until it has.

## Verify against an org

Compare two groups in a sandbox. Spot-check in Setup: one object row (Object Settings), one
system permission, one component permission set, and the assigned-user count.
