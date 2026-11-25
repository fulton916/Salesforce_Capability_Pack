<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

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

None.

