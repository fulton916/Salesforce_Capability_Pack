# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""No-overwrite push builder (lock 1): fill EMPTY target slots only, plus explicitly named overwrites.

Reads source.json (make_source.py) and the TARGET's own retrieve (before/), and:

1. Classifies every source row against the retrieve (written to plan.json):
     NEW              the slot is listed in the retrieve and empty      -> FILL
     SAME             the target already holds exactly this value       -> LIVE (not sent)
     OVERWRITE        the target holds a different value                -> HOLD (never sent) ...
     WHITESPACE ONLY  the target holds it with different whitespace     -> HOLD ...
                      ... unless named in --named with the value the target must still hold ("was"):
                      then NAMED (sent), or HOLD-STALE when the target no longer holds "was".
     UNPLACED         key not placeable, component not retrieved, slot not listed in the retrieve
                      (a slot is never created: what the retrieve does not list cannot be proven
                      empty), or ambiguous (two blocks with one name)
     SKIPPED          excluded language (--exclude-langs, default en_US)
   Task/Event field slots are stored under Activity: they count as empty only if the Activity
   file's slot is empty too (Activity-<lang> must be in the retrieve).

2. Writes the payload (payload/), cut from the target's own retrieve: only blocks that hold a target
   (objectTranslations), or every non-empty block (Translations and value sets), each leaf exactly as
   the target holds it, empty leaves dropped, target leaves set. LF line endings; a CR inside a
   value written as &#13; (crsafe).

3. Proves the payload offline against the RAW retrieved copies (never the merge cache):
     - every payload leaf is an intended value, or exactly the target's own value;
     - every intended value is in the payload, and no empty leaf is shipped;
     - an intended slot the retrieve shows holding a value is an OVERWRITE RISK unless named;
     - a named overwrite replaces exactly the value it was named for;
     - the &#13; count in the payload bytes equals the CRs the payload's values carry.

    python build_push.py --work <dir> [--source source.json] [--named named_overwrites.json]
    python build_push.py --work <dir> --plan-in plan_negctl.json --out payload_negctl --report push_report_negctl.json
--plan-in skips step 1 and builds from a given plan (the negative controls use it to plant
disguised overwrites); the proof in step 3 does not trust the plan.

Exit 2 on any proof failure, overwrite risk, unplaced row (unless --allow-unplaced), conflicting
duplicate, or a named overwrite that matched nothing or was stale (unless --allow-unmatched-names).
"""
import argparse
import collections
import copy
import os
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crsafe  # noqa: E402
import retr_merge  # noqa: E402
import translib as L  # noqa: E402

NS = L.NS
SEND = ("FILL", "NAMED")


def has_content(e):
    ids = L.ID_KEYS.get(L.local(e.tag), ())
    for c in e:
        if not isinstance(c.tag, str):
            continue
        if len(c):
            if has_content(c):
                return True
        elif L.local(c.tag) not in ids and not L.is_empty(c.text):
            return True
    return False


def prune(e, prefix, tg):
    """Set target leaves; drop empty leaves and blocks left with no content and no target."""
    ids = L.ID_KEYS.get(L.local(e.tag), ())
    for c, node in L.child_nodes(e):
        if len(c):
            p = prefix + (node,)
            prune(c, p, tg)
            if not has_content(c) and not any(s[:len(p)] == p for s in tg):
                e.remove(c)
        elif node[0] in ids:
            continue
        else:
            sig = prefix + (node[0],)
            if sig in tg:
                c.text = tg[sig]
            elif L.is_empty(c.text):
                e.remove(c)


def load_named(path):
    """{(lang, normalised key): was} from a json list [{lang, key, was}] or a csv with those columns."""
    if not path:
        return {}
    if path.lower().endswith(".csv"):
        import csv
        with open(path, encoding="utf-8-sig", newline="") as f:
            items = list(csv.DictReader(f))
    else:
        items = L.load_json(path)
    out = {}
    for x in items:
        if not x.get("lang") or not x.get("key") or x.get("was") is None:
            raise SystemExit(f"{path}: every named overwrite needs lang, key and was: {x}")
        out[(x["lang"], L.norm_key(x["key"]))] = x["was"]
    return out


def decide(row, named):
    b = row["bucket"]
    if b in ("UNPLACED", "SKIPPED"):
        return b
    if b == "NEW":
        return "FILL"
    if b == "SAME":
        return "LIVE"
    nk = (row["lang"], L.norm_key(row["key"]))
    if nk in named:
        return "NAMED" if L.ws(row.get("org_value")) == L.ws(named[nk]) else "HOLD-STALE"
    return "HOLD"


class Target:
    """Cached reads of one retrieve dir: merged view for placement, raw copies for every check."""

    def __init__(self, before, cache):
        self.files = retr_merge.component_files(before, cache)
        self.raw = L.component_sources(before)
        self.svs = sorted({c.rsplit("-", 1)[0] for f, c in self.files if f == "standardValueSetTranslations"})
        self._lv, self._rv, self._fn = {}, {}, {}

    def merged_leaves(self, k):
        if k not in self._lv:
            self._lv[k] = L.leaves(self.files[k])
        return self._lv[k]

    def raw_values(self, k):
        if k not in self._rv:
            self._rv[k] = L.raw_values(self.raw.get(k, []))
        return self._rv[k]

    def field_names(self, obj, lang):
        k = ("objectTranslations", f"{obj}-{lang}")
        if k not in self._fn:
            self._fn[k] = ({e.findtext(NS + "name") or "" for e in crsafe.parse(self.files[k]).getroot().findall(NS + "fields")}
                           if k in self.files else set())
        return self._fn[k]

    def held(self, folder, comp, sig):
        """Non-empty values the raw retrieve holds at this slot (Activity's too, for a Task/Event field)."""
        vals = {v for v in self.raw_values((folder, comp)).get(sig, ()) if not L.is_empty(v)}
        al = L.activity_alias(folder, comp, sig)
        if al and al in self.raw:
            vals |= {v for v in self.raw_values(al).get(sig, ()) if not L.is_empty(v)}
        return vals


def classify(rows, T, exclude):
    plan = []
    for r in rows:
        row = {"lang": r["lang"], "key": r["key"], "value": r["value"], "origin": r.get("origin")}
        plan.append(row)
        if r["lang"] in exclude:
            row.update(bucket="SKIPPED", why=f"language {r['lang']} excluded")
            continue
        pl, why = L.placement(r["key"], r["lang"], T.svs, T.field_names)
        if pl is None:
            row.update(bucket="UNPLACED", why=why)
            continue
        folder, comp, sig = pl
        row.update(folder=folder, component=comp, sig=L.sig_json(sig))
        if (folder, comp) not in T.files:
            row.update(bucket="UNPLACED", why="component not in the retrieve")
            continue
        base = T.merged_leaves((folder, comp))
        if sig not in base:
            row.update(bucket="UNPLACED", why="slot not listed in the retrieve - never created")
            continue
        if L.ambiguous(sig, base):
            row.update(bucket="UNPLACED", why="two blocks with this name in the retrieve - refused")
            continue
        al = L.activity_alias(folder, comp, sig)
        if al and al not in T.raw:
            row.update(bucket="UNPLACED", why=f"{al[1]} not in the retrieve - the slot cannot be proven empty")
            continue
        vals = T.held(folder, comp, sig)
        if len(vals) > 1:
            row.update(bucket="UNPLACED", why=f"retrieved copies disagree: {sorted(vals)!r}")
            continue
        org = next(iter(vals), "")
        row["org_value"] = org
        row["bucket"] = ("NEW" if not vals else "SAME" if r["value"] == org else
                         "WHITESPACE ONLY" if L.ws(r["value"]) == L.ws(org) else "OVERWRITE")
    return plan


def main(argv=None):
    L.utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", default=".", help="run folder; relative paths below are inside it")
    ap.add_argument("--source", default="source.json")
    ap.add_argument("--before", default="before", help="the target's retrieve (one sub-folder per batch)")
    ap.add_argument("--named", help="approved overwrites: json [{lang, key, was}] or csv lang,key,was")
    ap.add_argument("--plan-out", default="plan.json")
    ap.add_argument("--plan-in", help="build from this plan instead of classifying (negative controls)")
    ap.add_argument("--out", default="payload")
    ap.add_argument("--report", default="push_report.json")
    ap.add_argument("--exclude-langs", default="en_US", help='comma-separated; "" to exclude none')
    ap.add_argument("--api-version", default="62.0")
    ap.add_argument("--allow-unplaced", action="store_true", help="unplaced rows are reported but do not fail the build")
    ap.add_argument("--allow-unmatched-names", action="store_true",
                    help="a named overwrite that matched no held value, or was stale, does not fail the build")
    a = ap.parse_args(argv)
    P = lambda x: x if os.path.isabs(x) else os.path.join(a.work, x)

    before = P(a.before)
    cache = os.path.join(os.path.abspath(a.work), "_merged_" + os.path.basename(os.path.abspath(before)))
    shutil.rmtree(cache, ignore_errors=True)
    T = Target(before, cache)
    named = load_named(P(a.named) if a.named else None)
    exclude = {x.strip() for x in a.exclude_langs.split(",") if x.strip()}

    if a.plan_in:
        plan = L.load_json(P(a.plan_in))["rows"]
    else:
        src = L.load_json(P(a.source))
        plan = classify(src["rows"], T, exclude)

    # ---- decisions -----------------------------------------------------------------------------
    tg = collections.defaultdict(dict)          # (folder, comp) -> {sig: value}
    authorized, dup, named_used = [], [], set()
    slot_owner = {}                             # (folder, comp, sig) incl. Activity alias -> value
    for row in plan:
        row["decision"] = decide(row, named)
        nk = (row["lang"], L.norm_key(row["key"]))
        if row["bucket"] in ("OVERWRITE", "WHITESPACE ONLY") and nk in named:
            named_used.add(nk)
        if row["decision"] not in SEND:
            continue
        k, sig = (row["folder"], row["component"]), L.sig_tuple(row["sig"])
        slots = [(k, sig)] + ([(L.activity_alias(*k, sig), sig)] if L.activity_alias(*k, sig) else [])
        clash = next((slot_owner[s] for s in slots if s in slot_owner and slot_owner[s] != row["value"]), None)
        if clash is not None:
            dup.append([row["lang"], row["key"], clash, row["value"]])
            continue
        for s in slots:
            slot_owner[s] = row["value"]
        tg[k][sig] = row["value"]
        if row["decision"] == "NAMED" and not any(x["folder"] == k[0] and x["component"] == k[1] and
                                                 L.sig_tuple(x["sig"]) == sig for x in authorized):
            authorized.append({"folder": k[0], "component": k[1], "sig": row["sig"], "lang": row["lang"],
                               "key": row["key"], "was": row.get("org_value"), "now": row["value"],
                               "expect": named[nk]})

    if not a.plan_in:
        L.dump_json({"source": P(a.source), "source_sha256": L.file_sha256(P(a.source)), "before": before,
                     "named": P(a.named) if a.named else None, "rows": plan}, P(a.plan_out))

    # ---- payload ---------------------------------------------------------------------------------
    OUT = P(a.out)
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT, exist_ok=True)
    members, proof, risk = collections.defaultdict(list), [], []
    auth_sigs = {(x["folder"], x["component"], L.sig_tuple(x["sig"])) for x in authorized}
    for (folder, comp) in sorted(tg):
        t = tg[(folder, comp)]
        root = crsafe.parse(T.files[(folder, comp)]).getroot()
        new = ET.Element(root.tag)
        keep_all = folder != "objectTranslations"
        for block, node in L.child_nodes(root):
            if len(block) == 0:                           # top-level leaf (gender, startsWith, ...)
                if (node[0],) in t:
                    b = copy.deepcopy(block)
                    b.text = t[(node[0],)]
                    new.append(b)
                continue
            wanted = any(s[0] == node for s in t)
            if not wanted and not keep_all:
                continue
            b = copy.deepcopy(block)
            prune(b, (node,), t)
            if wanted or has_content(b):
                new.append(b)
        order = L.TR_ORDER if folder == "translations" else L.ROOT_ORDER
        kids = list(new)
        for k_ in kids:
            new.remove(k_)
        for k_ in sorted(kids, key=lambda e: order.index(L.local(e.tag)) if L.local(e.tag) in order else 99):
            new.append(k_)
        ET.indent(new, space="    ")                     # whitespace between elements only; values untouched
        path = os.path.join(OUT, folder, f"{comp}.{L.FOLDER_EXT[folder]}")
        crsafe.write_xml(new, path)
        members[L.FOLDER_TYPE[folder]].append(comp)

        # ---- offline proof against the RAW retrieve ------------------------------------------------
        rbase = T.raw_values((folder, comp))
        pl = L.leaves(path)
        for s, v in pl.items():
            if s in t:
                if v != t[s]:
                    proof.append([comp, str(s), f"value {v!r} != intended {t[s]!r}"])
                if T.held(folder, comp, s) and (folder, comp, s) not in auth_sigs:
                    risk.append([comp, str(s), sorted(T.held(folder, comp, s)), v])
            elif L.is_empty(v):
                proof.append([comp, str(s), "EMPTY leaf"])
            elif v not in rbase.get(s, ()):
                proof.append([comp, str(s), f"{v!r} is neither intended nor the target's {sorted(rbase.get(s, []))!r}"])
        proof += [[comp, str(s), "intended value missing from payload"] for s in t if s not in pl]
        for x in authorized:
            if (x["folder"], x["component"]) == (folder, comp):
                s_ = L.sig_tuple(x["sig"])
                have = {L.ws(v) for v in T.held(folder, comp, s_)}
                if have != {L.ws(x["expect"])}:
                    proof.append([comp, str(s_), f"named overwrite: the retrieve holds {sorted(have)!r}, "
                                                 f"not the expected {x['expect']!r}"])
        want_cr = sum(v.count("\r") for v in pl.values())
        got_cr = Path(path).read_bytes().count(b"&#13;")
        if got_cr != want_cr:
            proof.append([comp, "(carriage returns)", f"payload bytes carry {got_cr} &#13; but its values hold {want_cr} CR"])

    pkg = ['<?xml version="1.0" encoding="UTF-8"?>', f'<Package xmlns="{L.NS_URI}">']
    for t_, ms in sorted(members.items()):
        pkg += ["    <types>"] + [f"        <members>{m}</members>" for m in sorted(ms)] + [f"        <name>{t_}</name>", "    </types>"]
    pkg += [f"    <version>{a.api_version}</version>", "</Package>"]
    with open(os.path.join(OUT, "package.xml"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(pkg) + "\n")

    # ---- report ----------------------------------------------------------------------------------
    dec = collections.Counter(r["decision"] for r in plan)
    unplaced = [r for r in plan if r["decision"] == "UNPLACED"]
    held = [r for r in plan if r["decision"] in ("HOLD", "HOLD-STALE")]
    stale = [r for r in plan if r["decision"] == "HOLD-STALE"]
    not_found = sorted(map(list, set(named) - named_used))
    targets = [{"folder": f, "component": c, "sig": L.sig_json(s), "value": v} for (f, c), t in sorted(tg.items())
               for s, v in t.items()]
    keyed = {(r["folder"], r["component"], L.sig_tuple(r["sig"])): r for r in plan if r["decision"] in SEND}
    for x in targets:
        r = keyed.get((x["folder"], x["component"], L.sig_tuple(x["sig"])))
        x["lang"], x["key"] = (r["lang"], r["key"]) if r else (L.lang_of(x["folder"], x["component"]), None)
    fills = [x for x in targets if (x["folder"], x["component"], L.sig_tuple(x["sig"])) not in auth_sigs]
    report = {
        "work": os.path.abspath(a.work), "before": before, "payload": OUT,
        "source_sha256": L.file_sha256(P(a.source)) if not a.plan_in else None,
        "plan": P(a.plan_in or a.plan_out), "plan_sha256": L.file_sha256(P(a.plan_in or a.plan_out)),
        "named_file": P(a.named) if a.named else None, "named_sha256": L.file_sha256(P(a.named)) if a.named else None,
        "payload_sha256": L.dir_sha256(OUT),
        "counts": {"fills": len(fills), "named_overwrites": len(authorized), "values": len(targets),
                   "components": {k: len(v) for k, v in members.items()}, "decisions": dict(dec)},
        "targets": targets, "authorized": authorized,
        "same": [{k: r.get(k) for k in ("lang", "key", "org_value")} for r in plan if r["decision"] == "LIVE"],
        "held": [{k: r.get(k) for k in ("lang", "key", "value", "org_value", "bucket", "decision")} for r in held],
        "unplaced": [{k: r.get(k) for k in ("lang", "key", "value", "why")} for r in unplaced],
        "duplicates": dup, "overwrite_risk": risk, "named_not_found": not_found,
        "named_stale": [{k: r.get(k) for k in ("lang", "key", "org_value")} for r in stale],
        "proof_failures": proof,
    }
    L.dump_json(report, P(a.report))

    print(f"source rows: {len(plan)}  decisions: {dict(dec)}")
    print(f"fills: {len(fills)}   named overwrites written: {len(authorized)}   components: {dict(report['counts']['components'])}")
    print(f"held (target already holds a value - not sent): {len(held)}  unplaced: {len(unplaced)}  "
          f"conflicting duplicates: {len(dup)}")
    if named:
        print(f"named overwrites given: {len(named)}  matched a held value: {len(named_used)}  "
              f"stale: {len(stale)}  not found: {len(not_found)}")
    for r in unplaced[:5]:
        print("    UNPLACED:", r["lang"], r["key"], "-", r.get("why"))
    for r in stale[:5]:
        print("    STALE NAME:", r["lang"], r["key"], "- target holds", repr(r.get("org_value")))
    for x in not_found[:5]:
        print("    NAME NOT FOUND:", x[0], x[1])
    print(f"no-overwrite check: {len(risk)} position(s) where the target already holds a value (must be 0)")
    print(f"offline proof: {len(proof)} failure(s)")
    for x in (risk[:5] + proof[:8]):
        print("   ", x)
    names_bad = bool(not_found or stale) and not a.allow_unmatched_names
    bad = proof or risk or dup or names_bad or (unplaced and not a.allow_unplaced)
    print("RESULT:", "FAIL" if bad else "PASS", f"-> {OUT}")
    return 2 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
