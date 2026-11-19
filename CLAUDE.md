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
- `sf-psg-compare`: Chrome extension (plain ES modules, no build step). "Salesforce Capability Pack" toolbar menu with four read-only tools: "Compare permission set groups" (PSG Compare; compares two groups), "User access summary and comparison" (looks up or compares users' access), "Territory & role hierarchy" (shows the whole territory or role tree, narrows it to one branch, exports it for Excel) and "Why can a user see this record?" (explains how one user, or why one of two users, can see the record open in the tab).

CLI tools are Python 3.10+ scripts using the Salesforce CLI (`sf` v2); most need `openpyxl`
(`pip install -r requirements.txt` in the package). Node is needed only for the extension's tests.

## Package layout

Every package has `README.md` (for people) and `CLAUDE.md` (for you). Beyond that:
- CLI packages: `scripts/` and offline `tests/`, plus synthetic `examples/` where useful (absent in `sf-country-state-codes`).
- `sf-psg-compare`: `extension/`, `tools/` and `tests/` (Node runner); no `scripts/` and no `examples/`.
- `sf-translation-field-notes`: `docs/` only; no scripts, tests or examples.

## Workflow

The main session is the project-manager agent (`.claude/settings.json`). Definitions are in
`.claude/agents/`. The manager plans and writes task briefs; a developer agent codes; a tester
agent checks independently and reports PASS/FAIL with evidence; the manager reads the diff and
approves, commits only with passing tests, and pushes only when the user says so. Developers never
commit or push; testers never edit. Briefs for anything people see or use name a bar (the best
available alternative to compare against, not just the thing being replaced). Small fixes have no
bar. The tester, who is not given the developer's self-assessment, picks ours or the bar and names
the biggest gap (or, if ours wins, our biggest remaining weakness). At most 3 rounds, then the user
decides.

## Deferred edits

`PENDING_CLEANUP.md` lists edits that were put off because a session's scope kept it out of a file.
- Read it before planning any work.
- If an open item's blocker is gone, propose doing it (or do it, if it touches the same files).
- If your own scope forbids a file you need to change, add an entry there. Do not just mention it in a chat report.

## Guardrails

- Org-touching tools are read-only by default. Writes need a dry run, an explicit flag and a confirmation.
- No real org data, credentials, tokens, user lists or snapshots in the repo. Fixtures are synthetic.
- No imports across package folders.
- `sf-psg-compare` (all four tools): read-only, never inserts org data as HTML, no remote code, never stores the
  session id, matches across orgs by API name, not Id.
- `sf-user-password-reset/` is a local one-off tool, not part of the pack. It is git-ignored and never committed.

## Tests

Run from the package folder: `python tests/run_tests.py` (Python packages), `node tests/run_tests.mjs`
(`sf-psg-compare`). All packages from the repo root:

```bash
for d in sf-country-state-codes sf-safe-translation-push sf-territory-export \
         sf-translation-defect-repair sf-translation-deploy-triage \
         sf-translation-reconcile sf-translation-toolkit sf-user-access-teardown; do
  echo "== $d"; (cd "$d" && python tests/run_tests.py) || echo "FAILED: $d"
done
echo "== sf-psg-compare"; (cd sf-psg-compare && node tests/run_tests.mjs) || echo "FAILED: sf-psg-compare"
```

CI (`.github/workflows/tests.yml`) runs every package's offline tests on each push and pull request:
Python packages on 3.10 and 3.12, `sf-psg-compare` on Node 20. No org or secrets needed.

Extension dev server: `python sf-psg-compare/tools/dev_server.py --no-org`, then
`http://127.0.0.1:8765/psg-compare.html?demo=1` (or `--target-org <alias>` with `?dev=1`).
