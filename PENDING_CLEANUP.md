# Pending cleanup (deferred edits)

The shared list of edits that were put off on purpose, so they do not get forgotten. Every
session reads this file before planning work (see [CLAUDE.md](CLAUDE.md)).

Add an entry when a brief or task scope says to leave a file alone (for example because another
session is working there) but your work needs a change in that file.

## Entry format

```
### <short title>
- Date: YYYY-MM-DD
- File(s): path(s)
- Change: the exact change or text to apply
- Deferred because: what is blocking it (for example "another session is changing X on branch Y")
- Belongs to: branch or PR
- Added by: session or role
```

## How to clear an entry

Once the blocker is gone (that branch or PR is merged or abandoned), make the change in its own
small commit or PR through the normal developer, tester, manager flow. Delete the entry in the
same change.

## Open items

### Move record-access's cross-tool imports into shared/
- Date: 2026-11-20
- File(s): chrome-extension/tools/record-access/record-access.js, record-access.html, record-access-logic.js, record-access-read.js; chrome-extension/menu.js; chrome-extension/tools/hierarchy/hierarchy-read.js; chrome-extension/tools/user-access/user-access-read.js, user-access-logic.js; chrome-extension/tools/page-details/page-details-logic.js; chrome-extension/shared/; chrome-extension/CLAUDE.md
- Change: move `readRoles` (hierarchy-read), `searchUsers` (user-access-read), `matchUsers` (user-access-logic), `recordIdFromUrl` (record-access-logic) and `cleanUrl` (page-details-logic) into suitably named files in `shared/`, import them from there (record-access and menu.js no longer import from another tool's folder; the shared user-picker styles record-access borrows from user-access.css move to shared too if practical), remove the "Known exceptions" sentence from chrome-extension/CLAUDE.md, and fix the stale comment on line 3 of record-access-logic.js that still names `recordaccessread.js`.
- Deferred because: the folder move kept the record-access files to import-line changes so that uncommitted record-access work in another worktree (branch claude/record-access-speed-labels) can still merge.
- Belongs to: claude/extension-reorg (do it after claude/record-access-speed-labels is merged or abandoned)
- Added by: project manager session
