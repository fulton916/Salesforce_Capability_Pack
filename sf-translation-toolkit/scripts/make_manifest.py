#!/usr/bin/env python3
"""Build the download manifests for a translation run from its field scope.

The scripts build the workbook from a local copy of the org's setup. This writes the
manifests that download what they read, for the objects in your scope, in the shape that
has been proven to return translations completely: a translation only comes back in full
when its object, the object's layouts and its quick actions are named in the SAME request.

  obj_1.xml, obj_2.xml, ...   one per batch of objects (9 by default):
      CustomObject             each object in the batch, by name (Activity is added when
                               Task or Event is in scope: they keep their fields there)
      CustomObjectTranslation  <Object>-<language> for each object and each language, plus
                               en_US (renamed standard labels) and the probe language
                               (so classify_layout_sections.py can check it is unused)
      Layout, QuickAction      the batch's own layouts and object-specific quick actions,
                               by name, read from the org
  labels.xml                   custom labels, apps, tabs, global quick actions, report
                               types, global and standard value sets, and the global
                               Translations file for each language, by name

Reads the org's Layout and QuickAction lists (read-only). Download with:
  Get-ChildItem <out>\\*.xml | ForEach-Object { sf project retrieve start --manifest $_.FullName -o "<org>" --wait 60 }

Usage:
  python make_manifest.py <scope.csv> --langs de,fr,ja --org "<org alias>" -o <run>\\manifests
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parent))
from expand_picklists import STANDARD_VALUE_SETS  # noqa: E402
from sf_languages import require_known  # noqa: E402
from to_translation import read_fields_csv  # noqa: E402
from toolkit_settings import API_VERSION, PROBE_LANG, sf_executable  # noqa: E402

ACTIVITY_GROUP = ("Activity", "Event", "Task")
LABEL_WILDCARDS = ["CustomLabel", "CustomApplication", "CustomTab", "QuickAction",
                   "ReportType", "GlobalValueSet", "GlobalValueSetTranslation",
                   "StandardValueSetTranslation"]


def list_metadata(org: str, mtype: str) -> list[str]:
    """Full names of every component of a type in the org. Stops on any failure: an empty
    list here would silently drop every layout from the download."""
    p = subprocess.run([sf_executable(), "org", "list", "metadata", "--metadata-type", mtype,
                        "-o", org, "--json"], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    try:
        data = json.loads(p.stdout)
    except ValueError:
        sys.exit(f"error: listing {mtype} in {org} gave no readable output (exit {p.returncode})")
    if p.returncode != 0 or data.get("status") != 0:
        sys.exit(f"error: listing {mtype} in {org} failed: {data.get('name')}: {data.get('message')}")
    res = data.get("result") or []
    if isinstance(res, dict):
        res = [res]
    return [r["fullName"] for r in res if r.get("fullName")]


def package(types: list[tuple[str, list[str]]]) -> str:
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<Package xmlns="http://soap.sforce.com/2006/04/metadata">']
    for name, members in types:
        if not members:
            continue
        lines.append("    <types>")
        lines += [f"        <members>{escape(m)}</members>" for m in members]
        lines.append(f"        <name>{escape(name)}</name>")
        lines.append("    </types>")
    lines.append(f"    <version>{escape(API_VERSION)}</version>")
    lines.append("</Package>")
    return "\n".join(lines) + "\n"


def scope_objects(fields: set[str]) -> list[str]:
    objects = {f.split(".", 1)[0] for f in fields}
    if objects & {"Task", "Event"}:
        objects.add("Activity")
    return sorted(objects)


def batches(objects: list[str], size: int) -> list[list[str]]:
    """Batches of `size`, with Activity/Event/Task kept together in the first batch."""
    group = [o for o in ACTIVITY_GROUP if o in objects]
    rest = [o for o in objects if o not in group]
    out, cur = [], list(group)
    for o in rest:
        if len(cur) >= size:
            out.append(cur)
            cur = []
        cur.append(o)
    if cur:
        out.append(cur)
    return out


def build(fields: set[str], langs: list[str], layouts: list[str], quick_actions: list[str],
          batch_size: int = 9) -> dict[str, str]:
    """{file name: manifest XML}."""
    objects = scope_objects(fields)
    trans_langs = sorted(set(langs) | {"en_US", PROBE_LANG})
    by_obj_layout: dict[str, list[str]] = {}
    for full in layouts:
        by_obj_layout.setdefault(full.split("-", 1)[0], []).append(full)
    by_obj_qa: dict[str, list[str]] = {}
    for full in quick_actions:
        if "." in full:
            by_obj_qa.setdefault(full.split(".", 1)[0], []).append(full)

    out: dict[str, str] = {}
    for i, batch in enumerate(batches(objects, batch_size), start=1):
        out[f"obj_{i}.xml"] = package([
            ("CustomObject", batch),
            ("CustomObjectTranslation", [f"{o}-{l}" for o in batch for l in trans_langs]),
            ("Layout", sorted(x for o in batch for x in by_obj_layout.get(o, []))),
            ("QuickAction", sorted(x for o in batch for x in by_obj_qa.get(o, []))),
        ])
    value_sets = sorted({STANDARD_VALUE_SETS[f] for f in fields if f in STANDARD_VALUE_SETS})
    out["labels.xml"] = package(
        [(t, ["*"]) for t in LABEL_WILDCARDS]
        + [("StandardValueSet", value_sets),
           ("Translations", sorted(set(langs) | {"en_US"}))])
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scope_csv", type=Path, help="field list with a Name column (Object.Field)")
    ap.add_argument("--langs", required=True, help="comma-separated language codes, e.g. de,fr")
    ap.add_argument("--org", required=True, help="org alias to read the layout and quick-action lists from")
    ap.add_argument("-o", "--output", type=Path, required=True, help="folder for the manifests")
    ap.add_argument("--batch-size", type=int, default=9, help="objects per manifest (default 9)")
    a = ap.parse_args()

    if not a.scope_csv.is_file():
        sys.exit(f"error: no such file: {a.scope_csv}")
    langs = [l.strip() for l in a.langs.split(",") if l.strip()]
    if not langs:
        sys.exit("error: --langs is empty")
    require_known(langs, "make_manifest --langs")
    fields = read_fields_csv(a.scope_csv)
    if not fields:
        sys.exit(f"error: no Object.Field rows in {a.scope_csv}")

    layouts = list_metadata(a.org, "Layout")
    quick_actions = list_metadata(a.org, "QuickAction")
    if not layouts:
        sys.exit(f"error: {a.org} listed no layouts at all; refusing to build manifests that "
                 "would download translations without their layouts")

    a.output.mkdir(parents=True, exist_ok=True)
    stale = sorted(a.output.glob("*.xml"))
    if stale:
        sys.exit(f"error: {a.output} already holds manifests; use an empty folder")
    files = build(fields, langs, layouts, quick_actions, a.batch_size)
    for name, xml in files.items():
        (a.output / name).write_text(xml, encoding="utf-8")
    objects = scope_objects(fields)
    print(f"wrote {len(files)} manifests to {a.output}: {len(objects)} objects in "
          f"{len(files) - 1} batch(es), {len(langs)} languages (+ en_US and probe {PROBE_LANG})")


if __name__ == "__main__":
    main()
