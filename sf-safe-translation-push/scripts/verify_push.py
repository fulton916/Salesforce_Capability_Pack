"""After the deploy: prove the push changed only the slots it filled (plus named overwrites), and
every value landed.

Compares the target's retrieve BEFORE the deploy with a retrieve AFTER it (same manifests), leaf by
leaf, on the RAW retrieved copies:
  - every intended value is live (whitespace-collapsed match; exact matches are counted separately,
    because Salesforce trims a trailing space on some types);
  - no intended slot held a value before, except the named overwrites;
  - every other leaf of the pushed components is unchanged (raw text, whitespace included);
  - every OTHER retrieved file is unchanged too (nothing moved outside the push).
Task/Event field translations are stored under Activity, and are checked there too. Salesforce adds
<aspect>Master</aspect> to a quick action when its label is saved: accepted only on quick actions
this push filled.

    python verify_push.py --work <dir> [--before before --after after --report push_report.json]
Exit 2 on any failure.
"""
import argparse
import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import translib as L  # noqa: E402


def main(argv=None):
    L.utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", default=".")
    ap.add_argument("--report", default="push_report.json")
    ap.add_argument("--before", default="before")
    ap.add_argument("--after", default="after")
    ap.add_argument("--out", default="verify_push.json")
    a = ap.parse_args(argv)
    P = lambda x: x if os.path.isabs(x) else os.path.join(a.work, x)

    rep = L.load_json(P(a.report))
    TG = collections.defaultdict(dict)
    for x in rep["targets"]:
        TG[(x["folder"], x["component"])][L.sig_tuple(x["sig"])] = x["value"]
    AUTH = {(x["folder"], x["component"], L.sig_tuple(x["sig"])) for x in rep.get("authorized", [])}
    A, B = L.component_sources(P(a.before)), L.component_sources(P(a.after))
    cache = {}

    def lv(side, k):
        if (side, k) not in cache:
            cache[(side, k)] = L.raw_union((A if side == "A" else B).get(k, []))
        return cache[(side, k)]

    # a Task/Event field value may land under Activity: expected there, not "changed outside"
    expected_alias = collections.defaultdict(set)
    for k, tg in TG.items():
        for s, v in tg.items():
            al = L.activity_alias(k[0], k[1], s)
            if al:
                expected_alias[(al, s)].add(L.ws(v))
    pushed = set(TG) | {al for (al, s) in expected_alias}
    qa_filled = {(k, s[0]) for k, tg in TG.items() for s in tg if s and isinstance(s[0], tuple) and s[0][0] == "quickActions"}

    landed, exact, bad, overwrote, outside, aspect_added = 0, 0, [], [], [], []
    for k in sorted(pushed):
        if k not in A or k not in B:
            bad.append([k[1], "component missing from a retrieve"])
            continue
        la, lb, tg = lv("A", k), lv("B", k), TG.get(k, {})
        for s, v in tg.items():
            al = L.activity_alias(k[0], k[1], s)
            prev = la.get(s, "") if not L.is_empty(la.get(s, "")) else (lv("A", al).get(s, "") if al else "")
            if not L.is_empty(prev) and (k[0], k[1], s) not in AUTH:
                overwrote.append([k[1], str(s), prev])
            got = [lb.get(s)] + ([lv("B", al).get(s)] if al else [])
            if any(L.ws(g) == L.ws(v) for g in got if g is not None):
                landed += 1
                exact += any(g == v for g in got)
            else:
                bad.append([k[1], str(s), f"not live: {got!r} (intended {v!r})"])
        for s in set(la) | set(lb):
            if s in tg or la.get(s, "") == lb.get(s, ""):
                continue
            if L.is_empty(la.get(s, "")) and L.ws(lb.get(s)) in expected_alias.get((k, s), set()):
                continue
            if (len(s) == 2 and s[-1] == "aspect" and (k, s[0]) in qa_filled and L.is_empty(la.get(s, ""))
                    and lb.get(s) == "Master"):
                aspect_added.append([k[1], str(s)])
                continue
            bad.append([k[1], str(s), f"CHANGED {la.get(s)!r} -> {lb.get(s)!r}"])
    for k in sorted(set(A) | set(B)):
        if k in pushed:
            continue
        if k not in A or k not in B:
            outside.append([k[1], "present in only one retrieve"])
            continue
        la, lb = lv("A", k), lv("B", k)
        diff = sorted((s for s in set(la) | set(lb) if la.get(s, "") != lb.get(s, "")), key=str)
        if diff:
            outside.append([k[1], f"{len(diff)} leaf/leaves changed, e.g. {diff[0]}: {la.get(diff[0])!r} -> {lb.get(diff[0])!r}"])

    total = sum(len(v) for v in TG.values())
    ok = landed == total and not bad and not overwrote and not outside
    print(f"intended values live: {landed} / {total}  (byte-exact: {exact}; the rest differ only in whitespace)")
    print(f"slots that held a value before (named overwrites excepted): {len(overwrote)}  (must be 0)")
    print(f"named overwrites: {len(AUTH)}")
    print(f"pushed components: {len(pushed)} - other problems: {len(bad)}")
    print(f"other retrieved files: {len(set(A) | set(B)) - len(pushed)} - changed outside the push: {len(outside)}")
    if qa_filled:
        print(f"quick actions filled: {len(qa_filled)} - Salesforce added <aspect>Master</aspect> to {len(aspect_added)} (expected)")
    for x in (overwrote[:5] + bad[:15] + outside[:10]):
        print("   ", x)
    L.dump_json({"result": "PASS" if ok else "FAIL", "landed": landed, "exact": exact, "total": total,
                 "authorized": len(AUTH), "aspect_added_by_salesforce": aspect_added, "overwrote": overwrote,
                 "problems": bad, "outside": outside, "files_compared": len(set(A) | set(B))}, P(a.out))
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
