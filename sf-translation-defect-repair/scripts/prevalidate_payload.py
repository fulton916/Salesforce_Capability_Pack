#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Strip references the TARGET org cannot resolve from a translation payload, before deploy.

Why: Salesforce fails a CustomObjectTranslation whole for one bad reference (a deleted
field, record type, validation rule or picklist value), and caps how many errors it lists
per component. So dry-run -> strip -> dry-run converges slowly and hides the true count.
This checks every reference against the org in one pass.

Checked against the org:
  objects           (sf sobject describe)           missing -> whole component dropped
  custom fields     (describe)                      missing __c field -> its translation dropped
                                                    (a renamed STANDARD field is not in
                                                    describe under its token, so it is kept)
  picklist values   (describe: label or API value)  unknown masterLabel -> value dropped
  record types      (RecordType query)              unknown -> dropped
  validation rules  (Tooling ValidationRule query)  unknown -> dropped
  custom labels     (Tooling ExternalString query)  unknown -> dropped

Default is REPORT ONLY. Nothing is written without --apply. Files are read and written with
crsafe, so carriage returns that are part of a translation survive the rewrite.

Payload layouts: source format (objectTranslations/<Obj>-<lang>/ with *.fieldTranslation-meta.xml
and <Obj>-<lang>.objectTranslation-meta.xml, translations/*.translation-meta.xml) and
metadata format (objectTranslations/<Obj>-<lang>.objectTranslation, translations/*.translation).

Usage:
  python prevalidate_payload.py <payload_dir> --target-org my-sandbox            # report
  python prevalidate_payload.py <payload_dir> --target-org my-sandbox --apply    # strip
  python prevalidate_payload.py <payload_dir> --snapshot org_snap/               # offline
  python prevalidate_payload.py <payload_dir> --target-org my-sandbox --save-snapshot org_snap/

Point it at the payload folder that holds objectTranslations/, never at force-app (it
refuses to --apply inside a force-app tree: a payload is disposable, the source tree is not).
"""
from __future__ import annotations

import argparse
import collections
import json
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import crsafe  # noqa: E402

NS = crsafe.NS
Q = "{%s}" % NS


class OrgError(RuntimeError):
    pass


def run_sf(args: list[str]) -> dict:
    """Run `sf <args> --json` and return the parsed JSON (status != 0 is returned as-is)."""
    exe = shutil.which("sf")
    if not exe:
        raise OrgError("Salesforce CLI 'sf' not found on PATH")
    p = subprocess.run([exe, *args, "--json"], capture_output=True)
    err = (p.stderr or b"").decode("utf-8", "replace")
    try:
        # sf may print a BOM or a warning line before the JSON: start at the first "{".
        text = (p.stdout or b"").decode("utf-8-sig", "replace").lstrip("\ufeff")
        start = text.find("{")
        if start < 0:
            raise ValueError("no JSON")
        return json.loads(text[start:])
    except ValueError:
        raise OrgError(f"sf {' '.join(args[:3])}: no JSON output. stderr: {err[:300]}")


class OrgIndex:
    """What the target org can resolve. Live (via sf) or from a saved snapshot folder."""

    def __init__(self, org: str | None = None, snapshot: Path | None = None, runner=run_sf):
        self.org, self.snapshot, self.run = org, snapshot, runner
        self._describes: dict[str, dict | None] = {}
        self.record_types: set[tuple[str, str]] = set()
        self.validation_rules: set[tuple[str, str]] = set()
        self.custom_labels: set[str] = set()

    # -- loading --------------------------------------------------------------
    def load_lists(self) -> None:
        if self.snapshot:
            def rd(name):
                p = self.snapshot / name
                return json.loads(p.read_text(encoding="utf-8-sig")) if p.exists() else []
            self.record_types = {tuple(x) for x in rd("_recordtypes.json")}
            self.validation_rules = {tuple(x) for x in rd("_validationrules.json")}
            self.custom_labels = set(rd("_customlabels.json"))
            return
        disp = self.run(["org", "display", "-o", self.org])
        if disp.get("status") != 0:
            raise OrgError(f"cannot reach org {self.org!r}: {disp.get('message', '')}")
        self.record_types = {(r.get("SobjectType"), r.get("DeveloperName"))
                             for r in self._query("SELECT DeveloperName, SobjectType FROM RecordType")}
        self.validation_rules = {((r.get("EntityDefinition") or {}).get("QualifiedApiName"),
                                  r.get("ValidationName"))
                                 for r in self._query("SELECT ValidationName, "
                                                      "EntityDefinition.QualifiedApiName "
                                                      "FROM ValidationRule", tooling=True)}
        self.custom_labels = {r.get("Name") for r in
                              self._query("SELECT Name FROM ExternalString", tooling=True)}

    def _query(self, soql: str, tooling: bool = False) -> list[dict]:
        args = ["data", "query", "-q", soql, "-o", self.org]
        if tooling:
            args.insert(2, "--use-tooling-api")
        res = self.run(args)
        # A failed query must stop the run. Treating it as "the org has none" would strip
        # every record type / rule / label from the payload.
        if res.get("status") != 0:
            raise OrgError(f"query failed ({soql[:40]}...): {res.get('message', '')}")
        return (res.get("result") or {}).get("records") or []

    def describe(self, obj: str) -> dict | None:
        """The describe result, or None if the object does not exist in the org."""
        if obj not in self._describes:
            if self.snapshot:
                p = self.snapshot / f"{obj}.json"
                d = json.loads(p.read_text(encoding="utf-8-sig")) if p.exists() else {}
                self._describes[obj] = d.get("result", d) if d.get("result", d).get("fields") else None
            else:
                res = self.run(["sobject", "describe", "-s", obj, "-o", self.org])
                ok = res.get("status") == 0 and (res.get("result") or {}).get("fields")
                self._describes[obj] = res["result"] if ok else None
        return self._describes[obj]

    def fields(self, obj: str) -> dict[str, dict]:
        d = self.describe(obj) or {}
        return {f["name"]: f for f in d.get("fields") or []}

    def save(self, out: Path) -> None:
        out.mkdir(parents=True, exist_ok=True)
        for obj, d in self._describes.items():
            if d:
                (out / f"{obj}.json").write_text(json.dumps({"result": d}), encoding="utf-8")
        (out / "_recordtypes.json").write_text(json.dumps(sorted(map(list, self.record_types))))
        (out / "_validationrules.json").write_text(
            json.dumps(sorted([list(x) for x in self.validation_rules if all(x)])))
        (out / "_customlabels.json").write_text(json.dumps(sorted(x for x in self.custom_labels if x)))


# ── Checking ─────────────────────────────────────────────────────────────────


class Checker:
    def __init__(self, org: OrgIndex, apply: bool):
        self.org, self.apply = org, apply
        self.stats: collections.Counter = collections.Counter()
        self.detail: collections.Counter = collections.Counter()

    def _drop(self, stat: str, what: str, n: int = 1):
        self.stats[stat] += n
        self.detail[what] += n

    def strip_picklists(self, field_el: ET.Element, obj: str, fld: str, info: dict) -> None:
        pv = info.get("picklistValues") or []
        if not pv:
            return
        ok = {v.get("label") for v in pv} | {v.get("value") for v in pv}
        for e in field_el.findall(Q + "picklistValues"):
            if (e.findtext(Q + "masterLabel") or "").strip() not in ok:
                field_el.remove(e)
                self._drop("picklist values dropped", f"picklist: {obj}.{fld}")

    def check_field_element(self, field_el: ET.Element, obj: str) -> str:
        """'keep' | 'drop' | 'empty' for one <fields> / CustomFieldTranslation element."""
        fld = (field_el.findtext(Q + "name") or "").strip()
        info = self.org.fields(obj).get(fld)
        if info is None:
            if fld.endswith("__c"):
                self._drop("field translations dropped (field absent)", f"field: {obj}.{fld}")
                return "drop"
            return "keep"
        self.strip_picklists(field_el, obj, fld, info)
        has_content = any(len(c) or (c.text or "").strip() for c in field_el
                          if c.tag != Q + "name")
        return "keep" if has_content else "empty"

    def check_object_root(self, root: ET.Element, obj: str) -> bool:
        """Check one CustomObjectTranslation root. True if anything was removed."""
        before = ET.tostring(root)
        for f in list(root.findall(Q + "fields")):          # metadata format
            verdict = self.check_field_element(f, obj)
            if verdict != "keep":
                root.remove(f)
                if verdict == "empty":
                    self.stats["field entries dropped (empty after strip)"] += 1
        for tag, known, label in (("recordTypes", self.org.record_types, "record type"),
                                  ("validationRules", self.org.validation_rules, "validation rule")):
            for e in list(root.findall(Q + tag)):
                nm = (e.findtext(Q + "name") or "").strip()
                if (obj, nm) not in known:
                    root.remove(e)
                    self._drop(f"{label}s dropped", f"{label}: {obj}.{nm}")
        return ET.tostring(root) != before

    def write(self, root: ET.Element, path: Path) -> None:
        if self.apply:
            crsafe.write_xml(root, path, indent="    ")

    def run(self, payload: Path) -> None:
        ot = payload / "objectTranslations"
        entries = sorted(ot.iterdir()) if ot.is_dir() else []
        objs = sorted({p.name.split(".")[0].rsplit("-", 1)[0] for p in entries})
        present = {o for o in objs if self.org.describe(o)}
        if objs and not present:
            raise OrgError("not one object in the payload was found in the org - the org "
                           "connection or snapshot is probably wrong. Nothing was changed.")
        for p in entries:
            obj = p.name.split(".")[0].rsplit("-", 1)[0]
            if obj not in present:
                if self.apply:
                    shutil.rmtree(p) if p.is_dir() else p.unlink()
                self._drop("components dropped (object absent)", f"object: {obj}")
                continue
            if p.is_dir():                                    # source format
                for ff in sorted(p.glob("*.fieldTranslation-meta.xml")):
                    root = crsafe.parse(ff).getroot()
                    before = ET.tostring(root)
                    verdict = self.check_field_element(root, obj)
                    if verdict == "drop" or verdict == "empty":
                        if verdict == "empty":
                            self.stats["field files dropped (empty after strip)"] += 1
                        if self.apply:
                            ff.unlink()
                    elif ET.tostring(root) != before:
                        self.write(root, ff)
                files = list(p.glob("*.objectTranslation-meta.xml"))
            else:                                             # metadata format
                files = [p] if p.name.endswith(".objectTranslation") else []
            for c in files:
                root = crsafe.parse(c).getroot()
                if self.check_object_root(root, obj):
                    self.write(root, c)

        tr = payload / "translations"
        for p in sorted(tr.glob("*")) if tr.is_dir() else []:
            if not (p.name.endswith(".translation-meta.xml") or p.name.endswith(".translation")):
                continue
            root = crsafe.parse(p).getroot()
            changed = False
            for e in list(root.findall(Q + "customLabels")):
                nm = (e.findtext(Q + "name") or "").strip()
                if nm not in self.org.custom_labels:
                    root.remove(e)
                    changed = True
                    self._drop("custom labels dropped", f"customLabel: {nm}")
            if changed:
                self.write(root, p)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("payload", type=Path, help="payload dir containing objectTranslations/")
    ap.add_argument("-o", "--target-org", help="org alias or username to check against")
    ap.add_argument("--snapshot", type=Path, help="check against a saved snapshot instead of a live org")
    ap.add_argument("--save-snapshot", type=Path, help="save what was read from the org here")
    ap.add_argument("--apply", action="store_true",
                    help="actually remove the unresolvable references (default: report only)")
    ap.add_argument("--report", type=Path, help="write the findings as JSON here")
    for _s in (sys.stdout, sys.stderr):
        if hasattr(_s, "reconfigure"):
            _s.reconfigure(encoding="utf-8", errors="replace")
    a = ap.parse_args(argv)
    if bool(a.target_org) == bool(a.snapshot):
        ap.error("give exactly one of --target-org or --snapshot")

    root = a.payload
    if not (root / "objectTranslations").is_dir() and not (root / "translations").is_dir():
        sys.exit(f"error: no objectTranslations/ or translations/ in {root} - point at the "
                 "payload dir, not its parent")
    if a.apply and "force-app" in root.resolve().parts:
        sys.exit("error: refusing to --apply inside force-app; copy the payload out first")

    org = OrgIndex(a.target_org, a.snapshot)
    chk = Checker(org, a.apply)
    try:
        org.load_lists()
        print(f"org: {len(org.record_types)} record types, {len(org.validation_rules)} "
              f"validation rules, {len(org.custom_labels)} custom labels", file=sys.stderr)
        chk.run(root)
    except (OrgError, ValueError) as e:
        sys.exit(f"error: {e}")
    if a.save_snapshot:
        org.save(a.save_snapshot)
        print(f"snapshot saved: {a.save_snapshot}", file=sys.stderr)

    verb = "DROPPED" if a.apply else "WOULD DROP (report only - pass --apply)"
    print(f"\n{verb}:")
    if not chk.stats:
        print("   nothing - every reference resolves in the org")
    for k, v in chk.stats.most_common():
        print(f"   {k:<44}{v:>7}")
    if chk.detail:
        print(f"\ndistinct targets: {len(chk.detail)}")
        for k, v in chk.detail.most_common(30):
            print(f"   {v:>5}  {k}")
        if len(chk.detail) > 30:
            print(f"   ... and {len(chk.detail) - 30} more")
    if a.report:
        a.report.write_text(json.dumps({"applied": a.apply, "stats": chk.stats,
                                        "detail": chk.detail}, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
