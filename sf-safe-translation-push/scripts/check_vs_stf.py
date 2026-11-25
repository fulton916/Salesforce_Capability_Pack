# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Lock 2: every slot the push fills must be UNTRANSLATED in the target's own Bilingual export.

build_push.py proves the payload against the target's metadata retrieve. This checks the same slots
against a different read, taken after the retrieve (Setup -> Translation Workbench -> Export ->
Bilingual). It catches a value the retrieve could not see, and a slot translated in the org after
the retrieve. Slots only: the existing values the payload re-sends next to them are guarded by
pre_deploy_check.py (re-retrieve just before the deploy).

Per filled slot, under every key spelling the export may use (see stfread.py):
  CONFLICT    the export holds a translation there         -> the push would overwrite it
  UNVERIFIED  the key is in neither section of the export  -> the export proves nothing
Per named overwrite (only with --allow-named):
  NAMED MISMATCH  the export does not hold exactly the value the build expects to replace
  NOT PROVEN OURS (with --before-stf) the slot was translated in an older export, taken before
                  your first push to this org, so the value it replaces is not yours

Also fails: a pushed language with no export, an export older than --not-before (org time, the
zone the export file names are stamped in), a header that is not a Bilingual export for that
language, a file not ending in a newline (truncated), exports that do not all list the same keys
(one is truncated or from another org), and a language with no positive control (no value the
retrieve holds is shown translated in its export - wrong or empty export).

    python check_vs_stf.py --work <dir> --stf-dir "<export dir>" --not-before "YYYY-MM-DD HHMM"
        [--allow-named] [--before-stf "<older export dir>"] [--lightning-tab-dir before/<batch>/.../tabs]
Records the hashes of the payload, push_report.json and this script; pre_deploy_check.py requires
them unchanged. Exit 2 on any failure.
"""
import argparse
import collections
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stfread as S  # noqa: E402
import translib as L  # noqa: E402


def load_exports(d, langs, not_before, fail, tag=""):
    files, out, used = S.find_exports(d), {}, {}
    for lang in sorted(langs):
        if lang not in files:
            fail.append(f"{tag}{lang}: no Bilingual export in {d}")
            continue
        stamp, path = max(files[lang])
        used[lang] = {"file": os.path.basename(path), "stamp_org_time": stamp, "older_copies": len(files[lang]) - 1}
        if not_before and stamp < not_before:
            fail.append(f"{tag}{lang}: newest export {stamp} is older than --not-before {not_before}")
        e = S.Export(path, lang)
        for pr in e.problems:
            fail.append(f"{tag}{lang}: {os.path.basename(path)}: {pr}")
        out[lang] = e
    return out, used


def main(argv=None):
    L.utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", default=".")
    ap.add_argument("--stf-dir", required=True)
    ap.add_argument("--not-before", required=True, help='org time "YYYY-MM-DD HHMM": when the before/ retrieve started')
    ap.add_argument("--report", default="push_report.json")
    ap.add_argument("--payload", default="payload")
    ap.add_argument("--out", default="check_vs_stf.json")
    ap.add_argument("--allow-named", action="store_true",
                    help="the payload may carry named overwrites; each must be TRANSLATED in the export with exactly "
                         "the value the build expects to replace")
    ap.add_argument("--before-stf", help="export taken before your first push to this org: every named slot must be "
                                         "untranslated there (proves the value it replaces is yours)")
    ap.add_argument("--same-from", help="another push_report.json whose same/held rows serve as positive controls")
    ap.add_argument("--lightning-tab-dir", default="",
                    help="the retrieve's tabs/ folder: a custom-tab slot absent from the export is accepted as "
                         "retrieve-only ONLY if its .tab file is a Lightning page tab (<flexiPage>); the export never lists those")
    a = ap.parse_args(argv)
    P = lambda p: p if os.path.isabs(p) else os.path.join(a.work, p)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{4}", a.not_before):
        print(f'--not-before must look like "2026-01-15 0730", got {a.not_before!r}')
        return 2

    rep = L.load_json(P(a.report))
    fail = []
    auth = {(L.sig_tuple(x["sig"]), x["folder"], x["component"]) for x in rep.get("authorized", [])}
    fills = [x for x in rep["targets"] if (L.sig_tuple(x["sig"]), x["folder"], x["component"]) not in auth]
    named = rep.get("authorized", [])
    if any(not x.get("key") for x in fills + named):
        fail.append("a target in push_report.json has no translation key")
    if named and not a.allow_named:
        fail.append(f"{len(named)} named overwrite(s) in the payload - not allowed without --allow-named")
    if rep.get("payload_sha256") != L.dir_sha256(P(a.payload)):
        fail.append("the payload differs from the one push_report.json describes - rebuild")
    langs = {x["lang"] for x in fills + named}
    stf, used = load_exports(a.stf_dir, langs, a.not_before, fail)

    all_keys = set().union(*(e.present for e in stf.values())) if stf else set()
    for lang, e in sorted(stf.items()):
        if e.present != all_keys:
            fail.append(f"{lang}: export lists {len(e.present)} keys, the exports together {len(all_keys)} "
                        f"- truncated, or not the same org's export")

    lt_cache = {}

    def lightning_tab(name):
        if not a.lightning_tab_dir:
            return False
        if name not in lt_cache:
            p = os.path.join(P(a.lightning_tab_dir), f"{name}.tab")
            lt_cache[name] = os.path.isfile(p) and "<flexiPage>" in Path(p).read_text(encoding="utf-8")
        return lt_cache[name]

    conflicts, unverified, retrieve_only = [], [], []
    for x in fills:
        if x["lang"] not in stf or not x.get("key"):
            continue
        st, v = stf[x["lang"]].look(x["key"])
        row = {"lang": x["lang"], "key": x["key"], "push": x["value"]}
        if st == "held":
            conflicts.append({**row, "export_holds": v})
        elif st == "absent" and x["key"].startswith("WebTab.") and lightning_tab(x["key"].split(".", 1)[1]):
            retrieve_only.append(row)
        elif st in ("absent", "ambiguous"):
            unverified.append({**row, "why": st})
    if conflicts:
        fail.append(f"{len(conflicts)} slot(s) the push fills already hold a translation in the export")
    if unverified:
        fail.append(f"{len(unverified)} slot(s) are in neither section of the export - not verified")

    named_bad, named_ok = [], collections.Counter()
    for x in named:
        if x["lang"] not in stf:
            continue
        st, v = stf[x["lang"]].look(x["key"])
        if st != "held":
            named_bad.append({"lang": x["lang"], "key": x["key"], "problem": f"export shows it {st}; build expects {x['expect']!r}"})
        elif L.ws(v) != L.ws(x["expect"]):
            named_bad.append({"lang": x["lang"], "key": x["key"], "problem": f"export holds {v!r}; build expects {x['expect']!r}"})
        else:
            named_ok[x["lang"]] += 1
    if named_bad:
        fail.append(f"{len(named_bad)} named overwrite slot(s) where the export does not hold the value the build replaces")

    before_bad, before_used = [], {}
    if a.before_stf and named:
        bstf, before_used = load_exports(a.before_stf, {x["lang"] for x in named}, None, fail, tag="--before-stf ")
        for x in named:
            if x["lang"] not in bstf:
                continue
            st, v = bstf[x["lang"]].look(x["key"])
            if st == "held":
                before_bad.append({"lang": x["lang"], "key": x["key"], "problem": f"held {v!r} before your first push"})
            elif st != "present":
                before_bad.append({"lang": x["lang"], "key": x["key"], "problem": f"{st} in the before-push export"})
        if before_bad:
            fail.append(f"{len(before_bad)} named overwrite slot(s) not proven yours by the before-push export")
    elif named:
        print("NOTE: no --before-stf - nothing here proves the named overwrites replace only your own values")

    # positive control: values the retrieve holds must show as translated in the same language's export
    controls = rep.get("same", []) + [h for h in rep.get("held", []) if h.get("org_value")]
    if a.same_from:
        other = L.load_json(P(a.same_from))
        controls += other.get("same", []) + [h for h in other.get("held", []) if h.get("org_value")]
    agree = collections.defaultdict(lambda: [0, 0])
    for c in controls:
        if c.get("lang") in stf and c.get("key"):
            agree[c["lang"]][0] += 1
            agree[c["lang"]][1] += stf[c["lang"]].look(c["key"])[0] == "held"
    for lang in sorted(stf):
        if not agree[lang][1] and not named_ok[lang]:
            fail.append(f"{lang}: no value the retrieve holds is shown translated in this export - no positive control "
                        f"(wrong or empty export? pass --same-from with a fuller report)")

    result = {"result": "PASS" if not fail else "FAIL", "stf_dir": os.path.abspath(a.stf_dir), "not_before": a.not_before,
              "exports": used, "export_keys": {k: len(e.present) for k, e in stf.items()},
              "payload_sha256": L.dir_sha256(P(a.payload)), "report_sha256": L.file_sha256(P(a.report)),
              "script_sha256": L.file_sha256(os.path.abspath(__file__)),
              "slots_checked": len(fills), "named_checked": len(named), "allow_named": a.allow_named,
              "conflicts": conflicts, "unverified": unverified, "retrieve_only": retrieve_only,
              "named_mismatch": named_bad, "before_stf": a.before_stf, "before_exports": before_used,
              "named_not_proven_ours": before_bad,
              "positive_control": {k: {"checked": v[0], "seen_translated": v[1]} for k, v in agree.items()},
              "failures": fail}
    L.dump_json(result, P(a.out))
    print(f"exports: {len(used)} language(s), stamps (org time): {sorted({u['stamp_org_time'] for u in used.values()})}")
    print(f"slots checked: {len(fills)}; named overwrites: {len(named)}")
    print("positive control (values the retrieve holds, seen translated in the export): "
          + "  ".join(f"{k} {v[1]}/{v[0]}" for k, v in sorted(agree.items())))
    if retrieve_only:
        print(f"RETRIEVE-ONLY (Lightning page tabs, never in the export): {len(retrieve_only)}")
    print(f"UNVERIFIED - key in neither section of the export: {len(unverified)} (must be 0)")
    for x in unverified[:8]:
        print("   ", x["lang"], x["key"])
    print(f"CONFLICTS - export already holds a translation: {len(conflicts)} (must be 0)")
    for x in conflicts[:10]:
        print("   ", x["lang"], x["key"], "| export:", repr(x["export_holds"]), "| push:", repr(x["push"]))
    if named:
        print(f"NAMED MISMATCH: {len(named_bad)} (must be 0)")
        for x in named_bad[:10]:
            print("   ", x["lang"], x["key"], "|", x["problem"])
    if a.before_stf and named:
        print(f"NOT PROVEN OURS: {len(before_bad)} (must be 0)")
    print("RESULT:", result["result"])
    for f in fail[:30]:
        print("   ", f)
    return 2 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
