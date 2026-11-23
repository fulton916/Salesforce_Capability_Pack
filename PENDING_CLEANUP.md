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

### Mention Einstein Activity Capture in the User access tool's descriptions
- Date: 2026-11-22
- File(s): chrome-extension/shared/tool-list.js (the `user-access` entry's `description`); root README.md and root CLAUDE.md (the `chrome-extension` line that describes "User access summary and comparison")
- Change: add that the tool also shows each user's email and calendar connection (Einstein Activity Capture), and lists who is in each Einstein Activity Capture configuration (past Setup's 500-user limit), who is not connected, and who has access but is in no configuration, for Excel. For example, append: "; also shows Einstein Activity Capture (email and calendar): one user's connection, or who is in each configuration". Keep the menu text short. Issue #42 adds preparing add, move and remove changes as text for Salesforce Inspector or Data Loader (the extension itself stays read-only); a short phrase such as "; prepare add, move and remove text for Inspector" may be added to the same description if it fits.
- Deferred because: those files are being edited by other sessions on the same night (brief for issue #31 put them out of scope)
- Belongs to: claude/issue-31-eac
- Added by: developer

