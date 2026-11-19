"""Retrieve manifests (package.xml) for the before/, pre/ and after/ reads, built from source.json.

A translation retrieve only returns the translated text when its parent metadata is in the SAME
request: a CustomObjectTranslation needs its CustomObject and its Layouts (for layout sections), and
an object-specific quick action's translation only comes back with its QuickAction member. Custom
labels, apps, tabs, report types and global quick actions are in Translations, which needs those
members too, and every language code named explicitly. This script writes:

  obj_<n>.xml   CustomObject + CustomObjectTranslation (<Obj>-<lang>) + Layout + object QuickAction,
                --objects-per-batch objects per batch (Activity is added when Task/Event keys appear)
  labels.xml    Translations (<lang>) + CustomLabel / CustomApplication / CustomTab / ReportType /
                global QuickAction + GlobalValueSet(Translation) + StandardValueSet(Translation)
  batches.json  the batch names, and the retrieve command for each

Layouts: by default only the layouts named in LayoutSection keys. Pass --layouts with the output of
    sf org list metadata --metadata-type Layout --target-org <alias> --json > list_layout.json
to include every layout of each object (safer: a section on another layout is then visible too).

    python make_manifests.py --source source.json --out manifests [--langs de,fr] [--layouts list_layout.json]
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import translib as L  # noqa: E402


def package(types, api):
    x = ['<?xml version="1.0" encoding="UTF-8"?>', f'<Package xmlns="{L.NS_URI}">']
    for name in sorted(types):
        ms = sorted(set(types[name]))
        if ms:
            x += ["    <types>"] + [f"        <members>{m}</members>" for m in ms] + [f"        <name>{name}</name>", "    </types>"]
    return "\n".join(x + [f"    <version>{api}</version>", "</Package>"]) + "\n"


def main(argv=None):
    L.utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="source.json")
    ap.add_argument("--out", default="manifests")
    ap.add_argument("--langs", help="comma-separated (default: every language in the source except --exclude-langs)")
    ap.add_argument("--exclude-langs", default="en_US")
    ap.add_argument("--layouts", help="sf org list metadata --metadata-type Layout --json output")
    ap.add_argument("--objects-per-batch", type=int, default=10)
    ap.add_argument("--api-version", default="62.0")
    ap.add_argument("--target-org", default="<alias>", help="only used in the printed retrieve commands")
    a = ap.parse_args(argv)

    rows = L.load_json(a.source)["rows"]
    excl = {x.strip() for x in a.exclude_langs.split(",") if x.strip()}
    langs = [x.strip() for x in a.langs.split(",")] if a.langs else sorted({r["lang"] for r in rows} - excl)
    objs, layouts, oqa = set(), set(), set()
    lab = {k: set() for k in ("CustomLabel", "CustomApplication", "CustomTab", "ReportType", "QuickAction",
                              "GlobalValueSet", "StandardValueSet")}
    unknown = set()
    for r in rows:
        k = r["key"]
        typ, _, rest = k.partition(".")
        if typ == "CustomLabel":
            lab["CustomLabel"].add(rest)
        elif typ == "CustomApp":
            lab["CustomApplication"].add(rest)
        elif typ == "WebTab":
            lab["CustomTab"].add(rest)
        elif typ in ("CustomReportType", "ReportTypeSection"):
            lab["ReportType"].add(rest.rpartition(".")[0] if typ == "CustomReportType" else rest.partition(".")[0])
        elif typ == "QuickAction":
            if "." in rest:
                objs.add(rest.split(".", 1)[0])
                oqa.add(rest)
            else:
                lab["QuickAction"].add(rest)
        elif typ == "PicklistValue" and "__gvs." in k:
            lab["GlobalValueSet"].add(rest.split("__gvs.", 1)[0])
        elif typ == "PicklistValue" and rest.startswith("Standard."):
            lab["StandardValueSet"].add(rest.split(".")[1])
        elif typ in ("CustomField", "PicklistValue", "RecordType", "ValidationFormula", "LayoutSection", "WebLink", "ButtonOrLink"):
            obj = rest.split(".", 1)[0]
            objs.add(obj)
            if obj in L.ACTIVITY_CHILDREN:
                objs.add("Activity")
            if typ == "LayoutSection":
                layouts.add(f"{obj}-{rest.split('.', 2)[1]}")
        else:
            unknown.add(typ)
    if a.layouts:
        listed = L.load_json(a.layouts).get("result") or []
        for x in listed:
            fn = x.get("fullName") or ""
            if fn.split("-", 1)[0] in objs:
                layouts.add(fn)

    os.makedirs(a.out, exist_ok=True)
    batches = []
    ol = sorted(objs)
    for i in range(0, len(ol), max(1, a.objects_per_batch)):
        chunk = ol[i:i + a.objects_per_batch]
        name = f"obj_{len(batches) + 1}"
        types = {"CustomObject": chunk, "CustomObjectTranslation": [f"{o}-{l}" for o in chunk for l in langs],
                 "Layout": [x for x in layouts if x.split("-", 1)[0] in chunk],
                 "QuickAction": [q for q in oqa if q.split(".", 1)[0] in chunk]}
        Path(a.out, f"{name}.xml").write_text(package(types, a.api_version), encoding="utf-8", newline="\n")
        batches.append(name)
    if any(lab.values()):
        types = dict(lab)
        types["Translations"] = langs
        types["GlobalValueSetTranslation"] = [f"{s}-{l}" for s in lab["GlobalValueSet"] for l in langs]
        types["StandardValueSetTranslation"] = [f"{s}-{l}" for s in lab["StandardValueSet"] for l in langs]
        Path(a.out, "labels.xml").write_text(package(types, a.api_version), encoding="utf-8", newline="\n")
        batches.append("labels")
    cmds = [f'sf project retrieve start --manifest "{os.path.join(a.out, b)}.xml" --target-metadata-dir "<dir>/{b}" '
            f'--unzip --target-org {a.target_org} --wait 30 --json > "<dir>/{b}.json"' for b in batches]
    L.dump_json({"langs": langs, "batches": batches, "objects": ol, "layouts": sorted(layouts),
                 "retrieve_commands": cmds}, os.path.join(a.out, "batches.json"))
    print(f"languages: {langs}")
    print(f"batches: {batches}  objects: {len(ol)}  layouts: {len(layouts)}")
    if unknown:
        print(f"NOTE: key types with no manifest route (build_push.py will report them unplaced): {sorted(unknown)}")
    print("retrieve each batch (replace <dir> with before, pre or after):")
    for c in cmds:
        print("   ", c)
    return 0


if __name__ == "__main__":
    sys.exit(main())
