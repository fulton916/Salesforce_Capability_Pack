# salesforce-capabilities

Standalone Salesforce admin and translation tools. Each folder is a self-contained package: copy only the one you need. No package imports from another.

**Want the Chrome extension?** Follow [Install the Chrome extension (step by step)](#install-the-chrome-extension-step-by-step).

## What's in the pack

There are two kinds of tool:

| Type | What you need | Packages |
|---|---|---|
| Chrome extension | Just Chrome and a Salesforce login you already have. No CLI or Python. | [sf-psg-compare](sf-psg-compare/) |
| Command-line (CLI) tool | The Salesforce CLI (`sf` v2), Python 3.10+, and for most packages `openpyxl` (`pip install -r requirements.txt` inside the package). | Every other package below, except the documentation-only `sf-translation-field-notes`. |

Every package folder has:
- `README.md` for people: what it does, prerequisites, usage, safety notes.
- `CLAUDE.md` for an AI coding assistant: when to use the package, the exact workflow, guardrails and how to verify.

Beyond those two files:
- The CLI packages have `scripts/` and offline `tests/` (`python tests/run_tests.py`). Most also have synthetic examples in `examples/` (not `sf-country-state-codes`).
- `sf-psg-compare` has `extension/`, `tools/` and `tests/` (run with Node: `node tests/run_tests.mjs`), and no `scripts/`.
- `sf-translation-field-notes` has only `docs/`: no scripts and no tests.

## Install the Chrome extension (step by step)

This is for the **Salesforce Capability Pack** extension (the `sf-psg-compare` folder). You do not need to know GitHub or code. It takes a few minutes.

**Before you start:** this page is private. You can only see it if the owner has invited your GitHub account and you have accepted the invitation (GitHub sends an email, and it also shows at <https://github.com/notifications>). If you see "404 / Page not found", even though the link is right, you are not signed in to GitHub with the invited account yet. Sign in, or ask the owner to invite you. If someone sent you the ZIP file directly, start at step 3.

1. Open the page in your browser and sign in to GitHub: <https://github.com/fulton916/Salesforce_Capability_Pack>
2. Click the green **Code** button, then **Download ZIP**. A file named `Salesforce_Capability_Pack-main.zip` goes to your Downloads folder.
3. Open your Downloads folder (or wherever the ZIP file is) and unzip it:
   - **Windows:** right-click the ZIP file, choose **Extract All...**, then click **Extract**.
   - **Mac:** double-click the ZIP file.
4. Move the unzipped folder `Salesforce_Capability_Pack-main` to a place you will keep, such as your Documents folder. Chrome reads the extension from this folder every time it starts, so do not delete it or leave it in Downloads.
5. Open the folders until you find `sf-psg-compare`, then open it, then open the folder named `extension`. On Windows the folder name may appear twice (`Salesforce_Capability_Pack-main` inside `Salesforce_Capability_Pack-main`); just keep opening. You have the right folder when you can see a file named `manifest.json` directly inside it. Keep this window open, or remember where this folder is.
6. In Chrome, type `chrome://extensions` in the address bar and press Enter. (Or click the three dots at the top right, then **Extensions**, then **Manage Extensions**.) In Microsoft Edge, use `edge://extensions` instead.
7. Turn on the **Developer mode** switch. In Chrome it is at the top right of the page; in Edge it is usually in the menu on the left.
8. Click **Load unpacked**. A window opens for choosing a folder.
9. Choose the `extension` folder from step 5 (the one with `manifest.json` inside it) and click **Select Folder**. **Salesforce Capability Pack** now appears in your list of extensions.
10. Pin it so it is easy to reach: click the puzzle-piece icon in the top right of the browser, then click the pin next to **Salesforce Capability Pack**.
11. Open a Salesforce page in a tab where you are already logged in (any page in your org). Click the **Salesforce Capability Pack** icon and pick a tool from the menu. It opens in a new tab.

There is nothing to set up in Salesforce. The tools use the login your browser already has, and they only read; they never change anything.

**Update to a newer version**
1. Download the ZIP again (steps 1 to 3).
2. Replace the old folder with the new one in the same place (same name, same location).
3. Go to `chrome://extensions` (Edge: `edge://extensions`) and click the **Reload** button (a circular arrow) on the **Salesforce Capability Pack** card. If you put the new folder somewhere else, click **Remove** on the old card and repeat steps 8 and 9 with the new folder.

**If something does not work**
- **"Manifest file is missing or unreadable":** you chose the wrong folder. Choose the `extension` folder that has `manifest.json` directly inside it (step 5).
- **No Developer mode switch, or Load unpacked is missing or greyed out:** your browser is probably managed by your company, which can block this. Ask your IT team.
- **The tools in the menu are greyed out:** the tab you are on is not a Salesforce page. Switch to a Salesforce tab and click the icon again.
- **Something else:** see the [extension's own README](sf-psg-compare/README.md) for what each tool does and what access your Salesforce user needs.

## Translation packages

Five tool packages and one set of reference notes.

| Package | Type | What it does |
|---|---|---|
| [sf-translation-toolkit](sf-translation-toolkit/) | CLI | Scopes the fields a set of permission set groups can read. Builds a translator workbook pre-filled from the org, then converts the filled workbook into a deploy payload holding only translated rows and verifies the load against a Bilingual `.stf` export. |
| [sf-safe-translation-push](sf-safe-translation-push/) | CLI | Pushes translations into production without overwriting anything already there. A no-overwrite builder, negative controls, a check against the `.stf` export, a "target hasn't moved" gate and after-deploy verification all have to pass. Includes the before/after snapshot procedure. |
| [sf-translation-deploy-triage](sf-translation-deploy-triage/) | CLI | Turns deploy/validate results into Excel reports: what failed, why, and who must act. Builds fill-in files for gender and "starts with" grammar, applies the answers back, and scopes the redeploy to only the components that failed. |
| [sf-translation-defect-repair](sf-translation-defect-repair/) | CLI | Finds and repairs defects a deploy won't report: mojibake, keys with stray whitespace, lost carriage returns, references the target can't resolve, and retrieves that silently miss values. |
| [sf-translation-reconcile](sf-translation-reconcile/) | CLI | Keeps a translation workbook in line with what is live in an org, builds a pull-down of every live value, and applies targeted corrections with an offline proof and a record of where each replaced value came from. |

The translation tools work independently but fit one flow:

```
toolkit (scope + workbook) → defect-repair / triage (fix what fails) → safe-push (production) → reconcile (keep the workbook true)
```

Reference documentation (no code, nothing to run):

| Package | Type | What it covers |
|---|---|---|
| [sf-translation-field-notes](sf-translation-field-notes/) | Docs only | Lessons on Salesforce translation behaviour: reading state, deploy quirks, what can and can't be rolled back, grammar rules, text fidelity and Translation Workbench API limits. It explains the Salesforce behaviour behind all the translation tools. |

## Org administration packages

| Package | Type | What it does |
|---|---|---|
| [sf-country-state-codes](sf-country-state-codes/) | CLI | Exports the org's State and Country/Territory picklists (ISO codes, integration values, active/visible flags) to a formatted Excel mapping. |
| [sf-territory-export](sf-territory-export/) | CLI | Read-only Enterprise Territory Management export to Excel, one tab per query. Optional access-level audit and a "contains vs equals" rule-operator check, with org-to-org compare. |
| [sf-psg-compare](sf-psg-compare/) | Chrome extension | The "Salesforce Capability Pack" extension: a toolbar menu with six tools. **Compare permission set groups** compares two permission set groups side by side (contents, muting, system permissions, object and field access, Apex/pages/apps/custom permissions and tabs) with a plain-language summary, CSV export and saved group files for sandbox-vs-production compares. **User access summary and comparison** searches a user and shows their profile and user license, role, permission set groups, permission sets (direct or through a group), permission set licenses, public groups, queues and territories, or compares two users side by side, with CSV export. **Territory & role hierarchy** shows the whole territory or role tree fully expanded, narrows it to one branch with a search, and exports what is shown to Excel (.csv) with the tree in the cells (Level columns, API name, Path). **Why can a user see this record?** works on the record open in the tab: it explains how a user can see it (owner, role hierarchy, sharing rule, team, territory, manual share, org-wide default, View All) and, for two users, why one sees it and the other doesn't, checked against Salesforce's own answer. **Where is it used in flows?** finds the flows that use an object, a field or a record Id (or contain a piece of text): for an object it lists the flows that run when its records are saved or deleted in run order, the scheduled ones, and the other flows that change or read those records; for a field it shows the step in each flow and whether it sets, checks or just uses the field; both export to Excel (.csv). **Page details for a ticket** shows who you are, which org and which page or record you were on, and copies it as plain text (or a .txt file) to paste into your own company's support ticket. Uses your browser login; read-only. |
| [sf-user-access-teardown](sf-user-access-teardown/) | CLI | For a list of user IDs, queries and (only with `--execute` plus a confirmation) bulk-removes permission set groups, permission sets, licences, territories, groups, queues and role. Query-only by default; keeps CSV results. |

## Report a bug or suggest an improvement

Use these forms for any tool in the pack (you need a GitHub account with access to this private repository):

- [Report a bug](https://github.com/fulton916/Salesforce_Capability_Pack/issues/new?template=bug.yml)
- [Suggest an improvement](https://github.com/fulton916/Salesforce_Capability_Pack/issues/new?template=enhancement.yml)

The Chrome extension has the same two links built in. Describe problems with made-up names. Do not paste usernames, record data, org IDs, session IDs or screenshots that show org data.

## Safety

These tools can change production metadata and user access. Every package that writes defaults to read-only or dry run, and says in its README which step writes to the org. Rehearse in a sandbox first. None of the code has been run against your org; check the "not tested" notes in each README.

## Third-party dependency

`sf-translation-toolkit` uses the community Sunny Day CLI plugin (`sf sday psg2csv`) to list field permissions per permission set group. See that package's README for installation.

## Contributing / how we work

- Each package is self-contained. No package imports from another package folder.
- Test data and examples use made-up (synthetic) data only. No real org data, credentials, tokens, user lists or snapshots go in the repo.
- Tools that touch an org are read-only by default. Anything that writes needs a dry run (a preview that changes nothing), an explicit flag and a confirmation.
- Run the package's offline tests before committing, from the package folder: `python tests/run_tests.py` (needs `openpyxl`), or `node tests/run_tests.mjs` for `sf-psg-compare`.
- CI (an automatic test check, set up in `.github/workflows/tests.yml`) runs on GitHub's own servers, not on your PC, each time someone pushes a change or opens a pull request in this repository. It uses made-up data, never connects to a Salesforce org and needs no passwords or secrets. It is only for people changing this repository: you do not need it to use the tools, and it is not part of a package folder you copy or download.
- Changes are made with AI assistant roles: a project manager plans the work, a developer makes the change, a tester checks it separately, and the project manager reviews it before anything is saved to the repo (committed). Nothing lands on main unless the owner merges it. See [CLAUDE.md](CLAUDE.md) for the full guide and [.claude/agents/](.claude/agents/) for the agent definitions.
- `sf-user-password-reset` is a local one-off tool. It is not part of the pack and is never committed.
