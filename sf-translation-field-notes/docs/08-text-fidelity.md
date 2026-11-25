<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

# Text fidelity: carriage returns, spaces, encoding

Invisible characters cause real differences in what Salesforce stores, and most comparison tools
cannot see them.

## Carriage returns

**What happened:** existing help texts stored with a CRLF line break came back with LF after a
push that re-sent their field block. The words were the same; the bytes were not. Every check that
parsed the XML passed, because parsing turns CRLF into LF on both sides. Only a Bilingual export
diff (before vs after) showed the change.

**Why:** the payload files were written with Windows CRLF line endings. An XML parser normalises
every CRLF to LF, so a CR inside a value is indistinguishable from a line ending and is lost.

**Fix:**

- Write payload files with LF line endings only.
- Write a CR that belongs to a value as the character reference `&#13;`.
- Refuse a file that has a raw CR anywhere outside a value.
- Compare **raw text**, not only parsed values, in the build proof and the after-deploy check, so a
  lost CR fails the build. Test it with a planted CR.

**Evidence that `&#13;` survives:** one sandbox probe re-sent a field whose help text contained a
CR, written as `&#13;`; the re-retrieved file was byte-identical. Observed once, for one field.

Check your XML writer's output bytes rather than assuming it escapes a CR for you.

## Leading and trailing spaces

What Salesforce stored, from raw (unstripped) reads after real deploys:

| Sent | Stored | Evidence |
|---|---|---|
| Picklist value translation with a trailing space | trimmed | 3 of 3, one deploy |
| Picklist value translation with a leading space | kept | one deploy |
| Field label with a leading or trailing space | kept as sent | one deploy |
| Global value set translation with a trailing space | trimmed | dozens of values, two orgs, one later push |
| Standard/global value set value with a leading space | kept | one deploy |
| A value with trimmed spaces re-sent | stored trimmed, no re-padding | one deploy |

**The sources disagree on value sets.** An earlier summary said value sets keep trailing spaces; a
later, larger push saw global value set translations trimmed. Assume a trailing space may be trimmed
and verify with a raw read.

Practical rules:

- **Report stray outer spaces in supplied translations; get them fixed at source.** Do not trim
  silently: the deployed text should match the file of record. Trim only when the owner tells you to.
- **A trimmed trailing space reads as "whitespace only" in every later compare.** Expect it.
- **Comparison tools that strip values are blind to whitespace.** A trim reads as "already the
  same", and a value that gains a stray space reads as unchanged. Prove whitespace changes with a raw
  read.
- **Org master labels can carry trailing spaces** (for example a value set entry labelled
  `'Gadget Pro '`). A translation keyed without that space is rejected as an invalid value. Copy the
  master label exactly.
- **Non-breaking spaces count.** Several French values differed from the org only by a trailing NBSP.
- **One org rendered a layout heading with a leading space.** Strip before matching headings.

## Encoding (mojibake)

**Mojibake in a load file can be your own defect.** In one case the corrupted text was in the
"do not edit" English columns that the export tool wrote, not in anything translators typed.
`Widget‑Pro` (with U+2011, a non-breaking hyphen) had become `Widgetâ€‘Pro` through a cp1252 round
trip.

One defect, two outcomes:

| Where the corruption is | Result | Where it shows |
|---|---|---|
| In the **key** (the English master label) | the row fails | the error log, as "Invalid picklist value" |
| In the **value** (the translation) | the row succeeds | **nowhere**: the corruption goes live |

A clean deploy report does not mean clean data. To find live corruption, diff the Bilingual export
against the Source export, or scan translated values.

**Detect on the stray `€` (U+20AC), not on an adjacent `â€` pair.** Excel autocorrect and
translators change the characters around it (`'Größe â € “groß'`,
`'Crème ”€ ”brûlée'`), so the pair is often not adjacent and the lead character is often not
`â`. A detector that looked for `"â€"` passed several corrupt values as clean. Grow the damaged run
outward from the `€`. Exclude U+00A0 to U+00BF from the run so French and Russian guillemets
survive.

**Repairing live corruption.** Byte-level repair does not work once autocorrect has changed a
byte. But the key stays clean in the org, so the right English character is known. Substitute the
English source's own character, copy the spacing from the English source too, and check the repair
against the Source export before shipping it. **Refuse to repair a run not flanked by word characters
on both sides** (trailing, or inside quotes): you cannot know where the character belonged, and
guessing is fabrication. Send those back for retyping by a native speaker.

**When a scan comes back empty, suspect the scan.** A detector that tested for uppercase `Ã` missed
lowercase `ã§` and led to a wrong conclusion that value sets were absent from the export.

To triage "invalid value" errors on accented keys: if the corrupted key is absent from the Source
export and the repaired key is present, fixing the encoding is the whole fix.

## BOMs and Windows

- **PowerShell 5.1 `>` redirect writes a UTF-8 BOM.** `sf ... --json > out.json`, then
  `json.load(open(p, encoding="utf-8"))` fails with `Expecting value: line 1 column 1 (char 0)`,
  which looks like an empty file. Use `encoding="utf-8-sig"`.
- **`Export-Csv -Encoding utf8` in PowerShell 5.1 also adds a BOM.** A strict UTF-8 reader then sees
  the first header as `﻿Name` and the column lookup fails. Write without a BOM:

  ```powershell
  [System.IO.File]::WriteAllLines($path, $lines, (New-Object System.Text.UTF8Encoding($false)))
  ```

- **Keep every read and write explicit about encoding.** Every mojibake case traced back to one
  non-UTF-8 hop.
- **`&` in a URL passed to `sf` on Windows** is split by `cmd.exe`
  ([05](05-translation-workbench-api.md)).
- **Quote org aliases that contain spaces.** Better: use aliases without spaces.
