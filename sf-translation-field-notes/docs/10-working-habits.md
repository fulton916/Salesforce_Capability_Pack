<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

# Working habits that prevented (or would have prevented) damage

General lessons from translation work that apply to any metadata change.

## Checks

- **Validate a check against a known-good case before trusting a negative.** A read that can only
  say "absent" says it about everything. Hours were lost to a retrieve that could not see the
  values it was asked about.
- **Validate a probe against a known-bad case before trusting a pass.** A language-enablement
  probe passed for every language; adding a code that must fail and codes that should fail showed it
  only measured whether the code was valid.
- **Prove your guards with negative controls.** Plant one defect of each kind (an overwrite per file
  type, a stale expected value, a lost CR, a truncated export) in a copy and confirm the guard stops.
  Several guards in this work passed at first while being blind. A reviewer broke one by passing a
  byte copy of the old read as the "fresh" read.
- **A marker check is not a proof.** A test suite confirmed its own dummy markers were gone and
  passed while it had rewritten thousands of real files. Compare every file (size and timestamp, or
  content) before and after instead.
- **Silent `continue` on a missing lookup turns a rename into data loss.** A loader skipped
  workbook tabs it could not find after the tabs were renamed and loaded only one tab out of four,
  reporting success. Make missing inputs loud, and check the row count actually written.
- **Recognise header or banner rows by content, not position.** A sorted sheet moved its banner
  row into the middle; a reader that skipped row 2 would have dropped real data and read the banner
  as data.
- **Keep negative-control runs out of the real run's output paths.** One overwrote the real report.
- **A `--help` passed through a wrapper can run the real thing.** A control script forwarded
  `--help` to the builder and reported a false result.

## Reads

- **Never cite the local project tree as org state.** Check its timestamps; retrieve fresh.
- **Pull another org's data into an isolated copy**, with that org's translation files absent, so
  anything pre-filled must have come from the target.
- **Put the org name in every output file name** so workbooks from different orgs cannot be
  confused.
- **Use a dated work folder per run.** One tool built its language list from a file glob, and a
  leftover file from a previous run silently added a language to the deploy.
- **Before calling a value wrong, check whether a later load explains it.**
- **Never match by value when you mean by key.** One "these values never landed" finding was a
  coincidence of the same word on different targets.

## Deploys

- **Dry run first, then a person, then the real deploy.** Keep the two as separate commands.
- **Read the org again right before the deploy**, and restart from the read if anything moved.
- **Snapshot before every deploy**, and verify the copy.
- **Verify every deploy independently**: a retrieve with parents, and an export diff.
- **Record every deploy** you make, including probes and tests. Unrecorded probe deploys made a
  later restore investigation much harder.
- **One export before and one after a push** was enough in practice.

## Supplied translations

- **Load files from the translation owner as given.** Do not patch, trim, clean or exclude their
  content, even when it is clearly wrong; report defects separately and hand them back. Otherwise
  the defect is never fixed at source and the org no longer matches the file of record. Skip only
  what is genuinely empty. Ask the owner before applying any rule such as trimming.
- **A clean dry run does not check wording.** Misaligned columns and wrong-language text deploy with
  zero errors. Scan for them before loading, and report them.
- **Separate "what we wrote" from "what was there before us".** Keep provenance (which load wrote
  which key) so you can tell a fill from an overwrite of someone else's value. Ask before overwriting
  a value that pre-dates your work; record who approved each named overwrite.
- **When overwrites are approved, name each one with its expected current value**, and refuse to
  overwrite if the slot no longer holds that value.
