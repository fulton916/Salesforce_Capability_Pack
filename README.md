# salesforce-capabilities

Standalone Salesforce admin and translation tools. Each folder is a self-contained package: copy only the one you need. No package imports from another.

**Want the Chrome extension?** Follow [Install the Chrome extension (developer mode, about 2 minutes)](#install-the-chrome-extension-developer-mode-about-2-minutes).

**Roadmap:** [open features](https://github.com/fulton916/Salesforce_Capability_Pack/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement)

## What's in the pack

There are two kinds of tool:

| Type | What you need | Packages |
|---|---|---|
| Chrome extension | Just Chrome and a Salesforce login you already have. No CLI or Python. | [chrome-extension](chrome-extension/) |
| Command-line (CLI) tool | The Salesforce CLI (`sf` v2), Python 3.10+, and for most packages `openpyxl` (`pip install -r requirements.txt` inside the package). | Every other package below, except the documentation-only `sf-translation-field-notes`. |

Every package folder has:
- `README.md` for people: what it does, prerequisites, usage, safety notes.
- `CLAUDE.md` for an AI coding assistant: when to use the package, the exact workflow, guardrails and how to verify.

Beyond those two files:
- The CLI packages have `scripts/` and offline `tests/` (`python tests/run_tests.py`). Most also have synthetic examples in `examples/` (not `sf-country-state-codes`).
- `chrome-extension` has `shared/`, `tools/` (one folder per tool), `dev/` and `tests/` (run with Node: `node tests/run_tests.mjs`), and no `scripts/`.
- `sf-translation-field-notes` has only `docs/`: no scripts and no tests.

## Install the Chrome extension (developer mode, about 2 minutes)

The **Salesforce Capability Pack** extension (the `chrome-extension` folder) adds a toolbar menu to Chrome with read-only Salesforce admin tools, such as comparing permission set groups, checking a user's access and finding where a field is used in flows. It uses the login you already have in Salesforce and never changes anything. You do not need to know code.

1. Get the zip. First sign in to GitHub at <https://github.com> with your own account. The repository is private, so a "404 / Page not found" means you are not signed in. Then open <https://github.com/fulton916/Salesforce_Capability_Pack>, click the green **Code** button, then **Download ZIP**. Unzip it into a folder you will keep (Windows: right-click, **Extract All**): Chrome loads the extension from that folder, so moving or deleting it removes the extension. The zip holds the whole pack. The folder to pick in step 4 is `Salesforce_Capability_Pack-main\chrome-extension`. On Windows, Extract All puts `Salesforce_Capability_Pack-main` inside another `Salesforce_Capability_Pack-main`, so keep opening folders until you see `chrome-extension`.
2. Open `chrome://extensions` in Chrome (in Edge, `edge://extensions`).
3. Turn on **Developer mode** (top right; in Edge, the menu on the left). On a company-managed browser, IT policy can block Developer mode or **Load unpacked**. If so, ask IT.
4. Click **Load unpacked** and pick the `chrome-extension` folder (the one that holds `manifest.json`). "Manifest file is missing or unreadable" means you picked the folder above it. **Salesforce Capability Pack** now shows in the list.
5. Pin the extension: puzzle-piece menu, then the pin next to **Salesforce Capability Pack**.
6. Open a Salesforce tab where you are already logged in.
7. Click the **Salesforce Capability Pack** icon and pick a tool. It opens in a new tab. If the tools are greyed out, the tab you are on is not a Salesforce page.

To update to a newer version: download the new zip and unzip it over the same folder (replace the files). Click reload (the circular arrow) on **Salesforce Capability Pack** in `chrome://extensions`; the version shows on its card. Then open the tool again from the icon. Tool tabs left open from before the reload stop working. For what each tool does and what access your Salesforce user needs, see the [extension's README](chrome-extension/README.md).

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
| [chrome-extension](chrome-extension/) | Chrome extension | The "Salesforce Capability Pack" extension: a toolbar menu with eight tools. **Compare permission set groups** compares two permission set groups side by side (contents, muting, system permissions, object and field access, Apex/pages/apps/custom permissions and tabs) with a plain-language summary, CSV export and saved group files for sandbox-vs-production compares. **User access summary and comparison** searches a user and shows their profile and user license, role, permission set groups, permission sets (direct or through a group), permission set licenses, public groups, queues and territories, plus their call center and any hierarchy custom settings (such as bypass flags) whose value for the user or their profile differs from the org default, or compares two users side by side (both included), with CSV export. It also shows Einstein Activity Capture (email and calendar): who is in each configuration and who is not connected, plus text to paste into Salesforce Inspector to add users to a configuration (move and remove work by deleting and giving back the Einstein Activity Capture permission assignments, not verified in a real org; the extension itself stays read-only). **Territory & role hierarchy** shows the whole territory or role tree fully expanded, narrows it to one branch with a search, and exports what is shown to Excel (.csv) with the tree in the cells (Level columns, API name, Path). **Why can a user see this record?** works on the record open in the tab: it explains how a user can see it (owner, role hierarchy, sharing rule, team, territory, manual share, org-wide default, View All) and, for two users, why one sees it and the other doesn't, checked against Salesforce's own answer. **Where is it used in flows?** finds the flows that use an object, a field or a record Id (or contain a piece of text): for an object it lists the flows that run when its records are saved or deleted in run order, the scheduled ones, and the other flows that change or read those records; for a field it shows the step in each flow and whether it sets, checks or just uses the field; both export to Excel (.csv). **Page details for a ticket** shows who you are, which org and which page or record you were on, and copies it as plain text (or a .txt file) to paste into your own company's support ticket. **Error Tracer: read a debug log** reads a debug log that already exists (you turn logging on in Setup) and says in plain words what failed, where (the Apex line, the validation rule, the flow step) and for which user, with the raw lines folded away. **Where does a user get this permission?** takes one user and one permission (a system permission, access to an object, or access to a field) and lists every profile, permission set and permission set group that gives it, naming the permission set inside a group, what muting takes away, what only counts after a session-based set is activated, assignments that were revoked or are not active (an expired assignment is hidden by Salesforce within seconds, so it is not shown), and access that is covered by View All Data, Modify All Data or View All Fields; **Copy the answer** puts it in plain text for a ticket. Uses your browser login; read-only. |
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
- Run the package's offline tests before committing, from the package folder: `python tests/run_tests.py` (needs `openpyxl`), or `node tests/run_tests.mjs` for `chrome-extension`.
- CI (an automatic test check, set up in `.github/workflows/tests.yml`) runs on GitHub's own servers, not on your PC, each time someone opens or updates a pull request in this repository, and when a change lands on the main branch. It uses made-up data, never connects to a Salesforce org and needs no passwords or secrets. It is only for people changing this repository: you do not need it to use the tools, and it is not part of a package folder you copy or download.
- Changes are made with AI assistant roles: a project manager plans the work, a developer makes the change, a tester checks it separately, and the project manager reviews it before anything is saved to the repo (committed). Nothing lands on main unless the owner merges it. See [CLAUDE.md](CLAUDE.md) for the full guide and [.claude/agents/](.claude/agents/) for the agent definitions.
- `sf-user-password-reset` is a local one-off tool. It is not part of the pack and is never committed.
