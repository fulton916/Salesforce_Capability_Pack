# Restoring values that were overwritten by accident

A restore is a **named overwrite**: you deploy the old text back over the current text, for
exactly the slots you name. You cannot "undo" a deploy ([03](03-rollback-and-revert.md)).

## How accidental overwrites happened in practice

All of these were real, and none raised an error:

- **A payload built from a pre-filled spreadsheet.** The "existing value" columns were shipped as
  if they were translations, so each later deploy re-asserted whatever was in the local tree at
  build time. One protective re-deploy built this way wrote an older load's text over hundreds of
  newer values, shortly after the newer load landed.
- **Re-sent blocks carrying stale text.** Filling one empty picklist value re-sends the whole field
  block. If someone edited the label or help text in Setup after your read, your deploy writes the
  old wording back. A Setup edit leaves no DeployRequest, so you only see it by reading again.
- **Lost carriage returns.** Re-sent help texts lost an invisible CR because the payload file used
  CRLF line endings ([08](08-text-fidelity.md)). Same words, different bytes. Only an export diff
  showed it.
- **A probe or test that touched a slot you thought was empty.**
- **A tool that rebuilt a whole element set from a spreadsheet** and dropped what the spreadsheet
  did not carry.

## Prevention: snapshot before every deploy

Before you build, retrieve the target with parents and copy that read to a dated snapshot folder
(`snapshots/<org>_<YYYY-MM-DD_HHMM>_before_<what>/`). Check file count and bytes after the copy. Add the
deploy ID to the folder name afterwards. Without this you have no reliable record of what was
there, and you will be guessing.

Also take a Bilingual export before and after each push. The pair lets you list every slot that
changed, including ones a retrieve cannot show.

## Step 1: find what changed

- **Before snapshot vs a fresh retrieve**, leaf by leaf and as raw text. Parsed comparisons that
  strip values miss whitespace and CR changes.
- **Export before vs export after.** A key whose text changed outside your intended slots is a
  candidate.
- **Place every deploy on a timeline.** Query `DeployRequest` (see [02](02-deploy-behaviour.md)).
  Export file names are stamped in the org's time zone; convert before comparing. Look for your own
  deploys that nobody recorded; unrecorded probe deploys have turned up this way.

## Step 2: decide what to restore, value by value

The first version of one restore plan was withdrawn after review. It would have:

- written text in the wrong language over good values (a language column in the source file was
  shifted);
- undone deliberate fixes, because "a later deploy changed it" was read as "that deploy broke it";
- let an older source file beat a newer one, because one file was keyed by org key and the others
  by spreadsheet row, and the two were never compared;
- written record-type descriptions into record-type labels.

The rules that held up under review:

1. **Key by the org's key**, resolved the same way the export spells it (Activity, `__gvs`, `_N`
   suffixes). Never by spreadsheet row.
2. **The latest source wins**, and it must supply exactly one value for the key.
3. **The value must have actually landed** in its own deploy (its component succeeded).
4. **The last deploy to write the key must be an accident**, not a deliberate fix. Check what each
   later payload was for.
5. **Hold anything that would make the org worse** on a check you can state: plain English over a
   translation, a spacing-only or trailing-punctuation difference, the wrong regional variant of a
   language, a known typo, any value someone flagged as suspect.

Everything else is HOLD, with a written reason, for a person to decide. Before you call a value
wrong, check whether a later load explains it; one "column swap" finding turned out to be
reviewers converging two languages' wording in a later file.

## Step 3: build the restore

1. Retrieve the current state with parents into a fresh folder.
2. For each file, keep only the top-level blocks that hold a target (a field, a record type, a
   validation rule, a whole layout; for value sets, every translated value). Copy every leaf as the
   org holds it now. Change only the target leaves to their old text. Drop empty placeholders.
3. **Offline proof:** every payload leaf is either a target at its intended value or equal to the
   current org value. Check targets against the intended value from your scope list, never against
   the payload, so a builder bug cannot pass itself. Exit non-zero on any difference.
4. **Second, independent proof:** read the payload with the same key-based reader you use for
   exports and check it against the scope list.
5. **Pre-check:** retrieve again and confirm the org has not moved since the build read.
6. Dry run. Then the real deploy, with a person's go-ahead.
7. **Post-check:** retrieve again. Every target holds its intended value; every other leaf is
   unchanged. Then compare a fresh export with the earlier one.

```bash
sf project deploy start --metadata-dir restore/payload --dry-run --test-level NoTestRun \
  --target-org my-sandbox --json > restore/dryrun.json
```

## If the slot was empty before

You cannot blank most types by deploy. Your options:

- Deploy the English source text. Users see what they saw before; the slot is not truly empty.
- Clear it by hand in Setup > Translation Workbench (untested).
- For layout section labels, record type labels and validation rule messages, deploy the element
  with empty text; that does clear them.

## What has and has not been proven

- **Proven:** putting back a value you overwrote. In the revert test, a real translation that a
  sentinel had overwritten was redeployed from the baseline read and verified identical. Named
  overwrites were used repeatedly for corrections in sandboxes and production and verified exactly
  (whitespace included) afterwards.
- **Not proven end to end:** a large provenance-based restore. One was built, reviewed several
  times and dry-run clean, then not deployed. Soon after, it was already stale: fields had been
  deleted from the org and the payload no longer passed its pre-check. **A restore payload goes stale
  fast. Rebuild it from a fresh read immediately before you deploy.**
