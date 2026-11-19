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

### "null" in the org header of the first three tools
- Date: 2026-11-19
- File(s): sf-psg-compare/extension/psg-compare.js, sf-psg-compare/extension/user-access.js, sf-psg-compare/extension/hierarchy.js (function `showOrg`)
- Change: `showOrg` passes `via ? el(...) : null` to `replaceChildren`; with no `via` (opened from the toolbar against a real org) the browser inserts the text "null". Leave the null out (e.g. build the list and filter out falsy items) in all three files, as `record-access.js` already does; add a test.
- Deferred because: found while building the record-access tool; those pages were outside that task's scope.
- Belongs to: branch claude/record-visibility-comparison-5a2175
- Added by: project-manager session
