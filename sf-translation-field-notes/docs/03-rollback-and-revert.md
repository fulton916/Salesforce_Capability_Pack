# Rollback: what a deploy can and cannot take back

**Short version: a deploy can replace a translation, but for most types it cannot remove one.**
Review every push as if it were permanent. For most of what you push, it is.

This comes from one controlled revert test in a sandbox: a handful of samples across every
translation type, a few deploys, all dry-run first, every deploy `Succeeded` with 0 errors. Each
result below is one sample per type and variant, so treat it as "tested once, cleanly", not as
documented Salesforce behaviour.

## What was tested

Three ways to remove a value:

- **Blank**: send the element with empty text (`<label></label>`, `<translation></translation>`).
- **Omit**: for whole-file types (value sets, custom labels), redeploy the whole file without the
  entry. For `CustomObjectTranslation`, leave the entry out of a block that is sent.
- **Delete and redeploy**: in one deploy, `destructiveChangesPre.xml` deleting the translation
  component plus `package.xml` redeploying it from a pre-test copy.

## Results

| Element | Sent blank | Left out | Delete + redeploy in one deploy |
|---|---|---|---|
| Layout section label | cleared | not tried | not tried |
| Record type label | cleared | not tried | not tried |
| Validation rule message | cleared | not tried | not tried |
| Field label | ignored, value stays | not tried | not tried |
| Local picklist value | ignored | ignored (left out of a field block that was sent) | not tried |
| Renamed standard field label | ignored | not tried | not tried |
| Object name case forms | ignored | not tried | not tried |
| Custom label | ignored | ignored (whole `Translations` file without it) | not tried |
| Global value set entry | ignored | ignored (whole file without it) | reported `deleted=true`; values stayed |
| Standard value set entry | ignored | ignored (whole file without it) | reported `deleted=true`; values stayed |

"Ignored" means the deploy succeeded, reported nothing, and the value was still there on the next
retrieve.

Delete-and-redeploy was only tried on value-set translations, and it did not remove anything. No
type was shown to be revertible by delete-and-redeploy. It was not tried on custom labels because
a retrieved `Translations` file is not a complete enough copy to delete safely.

## What this means

- **Layout section labels, record type labels and validation rule messages** can be reverted to
  "untranslated" by deploying the element with empty text. That is also why a payload must never
  carry empty elements by accident ([02](02-deploy-behaviour.md)).
- **Everything else** (field labels, picklist values, value-set entries, custom labels, renamed
  standard fields, object names) can only be **replaced**. An overwrite deploy works for every
  type, including shared global and standard value sets.
- **The closest automatic revert for those types is to deploy the English source text.** Users of
  that language then see English, which is what they saw when the slot was empty. A translation
  equal to the English text is stored as a real translation (observed for every one of over a
  hundred such values), so the slot is not truly empty, and an export will list it as TRANSLATED.
- **To make a slot truly empty**, clear it by hand in Setup > Translation Workbench > Translate.
  This was **not tested**. Try it on one value in a sandbox before you promise it to anyone.
- **Leaving things out is always safe.** Omission never deleted anything, for any type. So
  sending cut-down files, or whole value-set files, cannot remove a translation by accident.
- **The pre-deploy snapshot is essential.** It is the record of what was there, it is the source
  for putting back anything you overwrote, and it tells you exactly what to clear by hand.

## How to test reversibility safely

Run this before a big push to production if you need to know your undo options. Use a sandbox.
Never run it in production.

1. **Pick a language nobody reads** in that sandbox, ideally one that is enabled but has no users.
   Sentinels in that language cannot confuse anyone.
2. **Choose samples.** For each type, either a value you pushed earlier (you know its exact text)
   or a sentinel such as `ZZREVERT_1`, `ZZREVERT_2`, ... placed into a slot that is empty.
   **Confirm each sentinel slot is empty from a fresh retrieve, not from a spreadsheet or the local
   tree.** In one test an "empty" slot held a real translation; the sentinel overwrote it and it
   had to be restored.
3. **Write a scoped manifest** that names every component under test **and its parents**
   (`CustomObject`, its `Layout`s, `GlobalValueSet`, `StandardValueSet`, `CustomLabel`). Without the
   parents the retrieve cannot see most of what you are testing ([01](01-reading-translation-state.md)).
4. **Baseline read.** Retrieve into `r_0`.

   ```bash
   sf project retrieve start --manifest revert/manifest.xml --target-metadata-dir revert/r_0 \
     --unzip --target-org my-sandbox --json > revert/r_0.json
   ```

5. **Phase A: add the sentinels.** Build minimal payload files that set each sentinel. Dry run,
   deploy, retrieve into `r_A`. Check every sentinel is there. This is your positive control: if a
   sentinel did not land, the later "it stayed" results mean nothing.
6. **Phase B: try to remove.** Build a payload that blanks some samples and omits others. Dry run,
   deploy, retrieve into `r_B`. Compare `r_A` and `r_B` leaf by leaf. Record, per sample, whether it
   is gone, empty or unchanged. Also check that **no other leaf changed** in any retrieved file.
7. **Phase C: put real values back.** For any real value that phase B did clear, redeploy its
   original text from `r_0`. Retrieve and confirm it matches `r_0` exactly.
8. **Phase D (optional): delete and redeploy.** In one metadata folder put `package.xml` and
   `destructiveChangesPre.xml` naming the same translation components, plus their pre-test files
   from `r_0`. Deploy and retrieve. Read the values, not the deploy report: the report said
   `deleted=true` while the values stayed.

   ```bash
   sf project deploy start --metadata-dir revert/payload_D --dry-run --test-level NoTestRun \
     --target-org my-sandbox --json
   ```

9. **Phase E: clean up what cannot be cleared.** For every sentinel still present, deploy the
   English source text into that slot (value-set entries: `<translation>` = the `<masterLabel>`;
   custom labels: the label's English value). Retrieve and confirm no `ZZREVERT` text is left.
10. **Write down the end state**: which slots now hold English instead of being empty. They look the
    same to users; clearing them truly needs the Translation Workbench UI.

Keep each phase's payload in its own folder and refuse to overwrite an existing payload folder,
so you can always see exactly what was sent.
