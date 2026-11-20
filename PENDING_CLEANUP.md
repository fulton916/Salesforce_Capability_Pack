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

### Root README: mention call center and custom settings in the user access tool
- Date: 2026-11-20
- File(s): README.md (the sf-psg-compare row in "Org administration packages")
- Change: in the user access tool's description, add that it also shows the user's call center and any
  hierarchy custom settings (such as bypass flags) whose value for the user or their profile differs from
  the org default, and compares both for two users.
- Deferred because: the "Page details for a ticket" branch (claude/issue-snapshot) edits the same row
- Belongs to: claude/user-access-settings
- Added by: project manager
