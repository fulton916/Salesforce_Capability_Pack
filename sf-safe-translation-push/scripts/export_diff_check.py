r"""Independent after-deploy check from the org's own Bilingual exports, before vs after the push.

A metadata retrieve cannot see everything: for example, managed-package tab and app translations
can read as empty in every retrieve while the export holds them. Only the export can show whether
a deploy disturbed them. Compare the export used by lock 2 (before) with a fresh one taken after
the deploy:

    python export_diff_check.py --before <export dir> --after <export dir> --report <work>/push_report.json
        every TRANSLATED row outside the push's slots must be unchanged (none lost, altered or new),
        and every pushed slot the export lists must now hold exactly the value sent
    python export_diff_check.py --before <dir> --after <dir> --managed-only [--namespace-re "[A-Za-z0-9]+__"]
        only managed-package tab / app rows (WebTab.<ns>__*, CustomApp.<ns>__*) - must be identical
Exit 2 on any difference.
"""
import argparse
import collections
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stfread as S  # noqa: E402
import translib as L  # noqa: E402


def main(argv=None):
    L.utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--before", required=True, help="export dir taken before the deploy")
    ap.add_argument("--after", required=True, help="export dir taken after the deploy")
    ap.add_argument("--report", help="push_report.json of the deployed build")
    ap.add_argument("--managed-only", action="store_true")
    ap.add_argument("--namespace-re", default=r"[A-Za-z0-9]+__", help="regex for a managed-package namespace prefix")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    if not a.report and not a.managed_only:
        ap.error("--report is required unless --managed-only")
    managed = re.compile(r"(WebTab|CustomApp)\." + a.namespace_re)

    B = {k: max(v) for k, v in S.find_exports(a.before).items()}
    A = {k: max(v) for k, v in S.find_exports(a.after).items()}
    langs = sorted(set(B) & set(A))
    if set(B) != set(A):
        print("NOTE: languages in only one export:", sorted(set(B) ^ set(A)))
    sent = collections.defaultdict(dict)
    if a.report and not a.managed_only:
        for x in L.load_json(a.report)["targets"]:
            if x.get("key"):
                sent[x["lang"]][x["key"]] = x["value"]
    lost, changed, new_outside, wrong, landed, not_listed, unchanged = [], [], [], [], 0, 0, 0
    for lang in langs:
        eb, ea = S.Export(B[lang][1], lang), S.Export(A[lang][1], lang)
        for pr in eb.problems + ea.problems:
            print(f"NOTE {lang}: {pr}")
        mine = {}
        for key, v in sent.get(lang, {}).items():
            ks = ea.export_keys(key)
            if len(ks) == 1:
                mine[ks[0]] = v
            else:
                not_listed += 1
        keys = set(eb.held) | set(ea.held) | set(mine)
        if a.managed_only:
            keys = {k for k in keys if managed.match(k)}
        for k in sorted(keys):
            if k in mine:
                if L.ws(ea.held.get(k)) == L.ws(mine[k]):
                    landed += 1
                else:
                    wrong.append([lang, k, eb.held.get(k), ea.held.get(k), mine[k]])
            elif k in eb.held and k not in ea.held:
                lost.append([lang, k, eb.held[k]])
            elif k in eb.held and L.ws(eb.held[k]) != L.ws(ea.held[k]):
                changed.append([lang, k, eb.held[k], ea.held[k]])
            elif k not in eb.held and k in ea.held:
                new_outside.append([lang, k, ea.held[k]])
            else:
                unchanged += 1
    print(f"languages compared: {len(langs)}")
    print(f"translated rows unchanged: {unchanged:,}")
    if not a.managed_only:
        print(f"pushed slots the export lists: {sum(len(v) for v in sent.values()) - not_listed}; as sent: {landed}; "
              f"not as sent: {len(wrong)}; pushed slots the export does not list (e.g. Lightning page tabs): {not_listed}")
    print(f"LOST: {len(lost)}   CHANGED outside the push: {len(changed)}   NEW outside the push: {len(new_outside)}")
    for x in (lost[:8] + changed[:8] + new_outside[:8] + wrong[:8]):
        print("   ", x)
    ok = bool(langs) and not lost and not changed and not new_outside and not wrong
    if a.out:
        L.dump_json({"result": "PASS" if ok else "FAIL", "before": {k: v[0] for k, v in B.items()},
                     "after": {k: v[0] for k, v in A.items()}, "landed": landed, "wrong": wrong, "lost": lost,
                     "changed": changed, "new_outside": new_outside}, a.out)
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
