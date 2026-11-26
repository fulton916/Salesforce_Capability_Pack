# Salesforce Capability Pack

Read-only Chrome tools for Salesforce admins (compare permission set groups, check user access, trace errors and more), plus command-line tools for translations and org exports.

## Get the Chrome extension

[**Download the extension (zip)**](https://github.com/fulton916/Salesforce_Capability_Pack/releases/latest/download/salesforce-capability-pack-extension.zip). No sign-in is needed.

1. Unzip it into a folder you will keep (Windows: right-click, **Extract All**). Chrome loads the extension from that folder, so do not move or delete it. You should see `manifest.json` directly inside the folder.
2. In Chrome, open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right). A company-managed browser may block it; if so, ask IT.
4. Click **Load unpacked** and pick the folder from step 1.
5. Pin it: puzzle-piece menu, then the pin next to **Salesforce Capability Pack**.
6. Open a Salesforce tab where you are logged in, click the icon and pick a tool.

- "Manifest file is missing or unreadable" means you picked a folder that does not have `manifest.json` directly inside.
- If the tools are greyed out, the tab you are on is not a Salesforce page.

To update: download the zip again, unzip it over the same folder, then click the reload arrow on the extension in `chrome://extensions`. Tool tabs left open from before the reload stop working, so open the tool again from the icon.

### The nine tools

They use the Salesforce login you already have and never change anything in the org.

- **Compare permission set groups**: find out how two groups differ.
- **User access summary and comparison**: see what a user can access, compare two users (or the same person in two orgs), or see who is in each Einstein Activity Capture configuration.
- **Territory & role hierarchy**: see the whole tree, narrow it to one branch, export it for Excel.
- **Why can a user see this record?**: explain who can see the record open in the tab, and why.
- **Where is it used in flows?**: find the flows that use an object, a field or a record Id.
- **Page details for a ticket**: copy who you are, which org and which page, to paste into a ticket.
- **Error Tracer: read a debug log**: see what failed, where and for which user.
- **Where does a user get this permission?**: find every profile, permission set and group that gives a user one permission.
- **Search the Setup Audit Trail**: find who changed what in Setup, without downloading a file.

More detail, and the access your Salesforce user needs, is in the [extension README](chrome-extension/README.md).

## Command-line tools

Each folder is self-contained. They need the Salesforce CLI (`sf` v2) and Python 3.10+; most also need `pip install -r requirements.txt` inside the folder. Each README says which step, if any, writes to the org (default is read-only or dry run).

| Package | What it does |
|---|---|
| [sf-translation-toolkit](sf-translation-toolkit/) | Scope fields by permission set group; build the translator workbook and turn it into a deploy payload. Needs the community Sunny Day CLI plugin (`sf sday psg2csv`); see its README. |
| [sf-safe-translation-push](sf-safe-translation-push/) | Push translations to production without overwriting existing ones. |
| [sf-translation-deploy-triage](sf-translation-deploy-triage/) | Turn deploy results into reports and redeploy only what failed. |
| [sf-translation-defect-repair](sf-translation-defect-repair/) | Find and repair defects a deploy does not report. |
| [sf-translation-reconcile](sf-translation-reconcile/) | Keep a workbook in line with the live org; targeted corrections. |
| [sf-translation-field-notes](sf-translation-field-notes/) | Documentation only: lessons on Salesforce translation behaviour. |
| [sf-country-state-codes](sf-country-state-codes/) | Export State and Country/Territory picklists to Excel. |
| [sf-territory-export](sf-territory-export/) | Read-only Territory Management export to Excel. |
| [sf-user-access-teardown](sf-user-access-teardown/) | Query user access and, only with `--execute` plus confirmation, remove it. |

The translation tools fit one flow: toolkit, then defect-repair and triage, then safe-push, then reconcile.

## Report a bug or suggest an improvement

A free GitHub account is needed to file.

- [Report a bug](https://github.com/fulton916/Salesforce_Capability_Pack/issues/new?template=bug.yml)
- [Suggest an improvement](https://github.com/fulton916/Salesforce_Capability_Pack/issues/new?template=enhancement.yml)

The extension has the same two links built in. Describe problems with made-up names. Do not paste usernames, record data, org IDs, session IDs or screenshots that show org data.

## Safety

The Chrome extension is read-only. Command-line tools that can write (production metadata, user access) default to read-only or dry run, and their READMEs say which step writes. Rehearse in a sandbox first; check the "not tested" notes in each README.

## For contributors

- Each `sf-*` folder is a self-contained package with a `README.md` (people) and `CLAUDE.md` (AI assistants). `chrome-extension` has `shared/`, `tools/` and `tests/`. No package imports from another.
- Test data is made up. No real org data, credentials, tokens or user lists in the repo.
- Offline tests: `python tests/run_tests.py` in a Python package (needs `openpyxl`), `node tests/run_tests.mjs` in `chrome-extension`. CI runs them all on every pull request.
- The work is done with AI assistant roles (manager, developer, tester); see [CLAUDE.md](CLAUDE.md). Releases are built by `.github/workflows/release.yml`.
- `sf-user-password-reset` is a local one-off tool. It is not part of the pack and is never committed.

## License

Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify, or
distribute this software without written permission. See [LICENSE](LICENSE).
