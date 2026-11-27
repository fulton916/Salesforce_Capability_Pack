<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

# Salesforce Capability Pack (repo guide for AI assistants)

A set of standalone Salesforce admin and translation tools. Each `sf-*` folder is a self-contained
package. Read the package's own `README.md` and `CLAUDE.md` before changing anything in it; this
file does not repeat package specifics.

## Packages

Translation (CLI tools unless noted):
- `sf-translation-toolkit`: scope fields by permission set group, build and convert the translator workbook.
- `sf-safe-translation-push`: push translations to production without overwriting existing ones.
- `sf-translation-deploy-triage`: turn deploy/validate results into reports and scoped redeploys.
- `sf-translation-defect-repair`: find and repair defects a deploy does not report.
- `sf-translation-reconcile`: keep a workbook in line with the live org; targeted corrections.
- `sf-translation-field-notes`: documentation only (no code, no tests).

Org administration:
- `sf-country-state-codes`: CLI. Export State and Country/Territory picklists to Excel.
- `sf-territory-export`: CLI. Read-only Territory Management export to Excel.
- `sf-user-access-teardown`: CLI. Query, and only with `--execute` plus confirmation, remove user access.
- `chrome-extension`: the pack's main toolkit (formerly `sf-psg-compare`). Chrome extension (plain ES modules, no build step). "Salesforce Capability Pack" toolbar menu with nine read-only tools: "Compare permission set groups" (PSG Compare; compares two groups), "User access summary and comparison" (looks up or compares users' access, in one org or the same person across two orgs open in the browser; also shows Einstein Activity Capture (email and calendar): who is in each configuration, who is not connected, and text to paste into Salesforce Inspector to add users to a configuration (move and remove work through the Einstein Activity Capture permission assignments, not verified in a real org), the extension itself staying read-only), "Territory & role hierarchy" (shows the whole territory or role tree, narrows it to one branch, exports it for Excel), "Why can a user see this record?" (explains how one user, or why one of two users, can see the record open in the tab), "Where is it used in flows?" (finds the flows that use an object, a field or a record Id), "Page details for a ticket" (copies who you are, which org and which page, as plain text for a support ticket), "Error Tracer: read a debug log" (reads an existing debug log and says what failed, where and for which user; never sets a trace flag), and "Where does a user get this permission?" (for one user and one permission, lists every profile, permission set and group that gives it, what muting removes and what only counts after activation, and copies the answer for a ticket), and "Search the Setup Audit Trail" (reads Setup's audit trail for a period and lets you search and filter it on the page, so no file download is needed; copies one entry or the shown list for a ticket, or downloads it as CSV).

CLI tools are Python 3.10+ scripts using the Salesforce CLI (`sf` v2); most need `openpyxl`
(`pip install -r requirements.txt` in the package). Node is needed only for the extension's tests.

## Package layout

Every package has `README.md` (for people) and `CLAUDE.md` (for you). Beyond that:
- CLI packages: `scripts/` and offline `tests/`, plus synthetic `examples/` where useful (absent in `sf-country-state-codes`).
- `chrome-extension`: `manifest.json`, `menu.*`, `settings.*`, `shared/`, `tools/<tool>/` (page, `-read`, `-logic`), `dev/`, `samples/` and `tests/` (Node runner); no `scripts/` and no `examples/`.
- `sf-translation-field-notes`: `docs/` only; no scripts, tests or examples.

## Workflow

The main session is the project-manager agent (`.claude/settings.json`). Definitions are in
`.claude/agents/`. The manager plans and writes task briefs; a developer agent codes; a tester agent
checks independently and reports PASS/FAIL with evidence; the manager reads the diff and approves,
and commits only with passing tests. Work goes in through a pull request. The manager merges it
itself, without asking, once the tester passed it, the manager approved the diff, the branch is up
to date and re-tested, and CI is green; it stops and asks the user first for deletions, permission
or security changes, production or shared orgs, secrets, unfixable failures or conflicts, work
beyond its issue, or doubt (full list in `.claude/agents/project-manager.md`). It then tells the
user in one line what merged. The user can say "wait" in the chat and that wins. Direct pushes to
main happen only when the user asks.
Planned work is one GitHub issue per feature, labelled `enhancement` (bugs: `bug`) plus
`group: <area>` for the part of the pack it touches, and its pull request closes it.
Developers never commit or push; testers never edit. Briefs for anything people see or use name a
bar (the best available alternative to compare against, not just the thing being replaced). Small
fixes have no bar. The tester, who is not given the developer's self-assessment, picks ours or the
bar and names the biggest gap (or, if ours wins, our biggest remaining weakness). At most 3
rounds, then the user decides.

Releasing: bump `version` in `chrome-extension/manifest.json`, merge, then push a tag `vX.Y.Z` equal to it.
`.github/workflows/release.yml` builds `salesforce-capability-pack-extension.zip` (extension files at the zip root,
plus LICENSE; no `tests/` or `dev/`) and attaches it to that tag's release, and fails if tag and version differ.
It never deletes old releases; that cleanup stays manual.

## Deferred edits

`PENDING_CLEANUP.md` lists edits that were put off because a session's scope kept it out of a file.
- Read it before planning any work.
- If an open item's blocker is gone, propose doing it (or do it, if it touches the same files).
- If your own scope forbids a file you need to change, add an entry there. Do not just mention it in a chat report.

## Guardrails

- Org-touching tools are read-only by default. Writes need a dry run, an explicit flag and a confirmation.
- No real org data, credentials, tokens, user lists or snapshots in the repo. Fixtures are synthetic.
- No imports across package folders.
- `chrome-extension` (all nine tools): read-only, never inserts org data as HTML, no remote code, never stores the
  session id, matches across orgs by API name, not Id.
- `sf-user-password-reset/` is a local one-off tool, not part of the pack. It is git-ignored and never committed.

## Tests

Run from the package folder: `python tests/run_tests.py` (Python packages), `node tests/run_tests.mjs`
(`chrome-extension`). All packages from the repo root:

```bash
for d in sf-country-state-codes sf-safe-translation-push sf-territory-export \
         sf-translation-defect-repair sf-translation-deploy-triage \
         sf-translation-reconcile sf-translation-toolkit sf-user-access-teardown; do
  echo "== $d"; (cd "$d" && python tests/run_tests.py) || echo "FAILED: $d"
done
echo "== chrome-extension"; (cd chrome-extension && node tests/run_tests.mjs) || echo "FAILED: chrome-extension"
```

CI (`.github/workflows/tests.yml`) runs every package's offline tests on each pull request and on pushes to main:
Python packages on Ubuntu with 3.10 and 3.12, plus Windows with 3.12 (UTF-8 mode off), all packages in each job; `chrome-extension` on Node 20. No org or secrets needed.

Extension dev server: `python chrome-extension/dev/dev_server.py --no-org`, then
`http://127.0.0.1:8765/tools/compare-groups/compare-groups.html?demo=1` (or `--target-org <alias>` with `?dev=1`).
