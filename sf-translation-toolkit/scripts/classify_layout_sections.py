#!/usr/bin/env python3
"""Classify every layout-section row as editable or Salesforce-owned, from the ORG.

Some layout section headings come from Salesforce's own language packs. A deploy that sets
one is accepted and then discarded, so they must not be sent to translators.

THE TEST
Render each section in a PROBE language: one the org has never translated into (set
"probe_language" in settings.json; default ja):
    probe differs from en_US  -> Salesforce has its own pack string  -> Salesforce-owned
    probe equals en_US        -> no pack string                      -> editable
That is a positive test whose result would differ if the premise were wrong, not an
inference from something being missing.

Only `composite/batch` honours `Accept-Language`; a direct GET returns English.
Objects with record types expose layouts via `recordTypeMappings[].recordTypeId` — the
top-level `layouts` array is EMPTY for them, which makes such an object look layout-less.
Sections are keyed by `layoutSectionId`, never by position.

Usage:
    python classify_layout_sections.py --org "<org alias>" --workbook <wb>.xlsx \\
        [--langs de,fr,...] [--out verdicts.json]
Without --langs, every non-English language column in the workbook is read.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required: pip install openpyxl")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from combine_translations import EXCLUDED_TAB, MAIN_TAB  # noqa: E402
from sf_languages import code_for, name as lang_name  # noqa: E402
from toolkit_settings import API_PATH, PROBE_LANG, sf_executable  # noqa: E402

API = API_PATH
BATCH = 25


def _sf() -> str:
    return sf_executable()


def probe_translations_in_org(objects: list[str], probe: str) -> tuple[int, int]:
    """(files read, layout-section labels found) for the probe language, from the local
    download (make_manifest.py names <Object>-<probe> for exactly this check). Any label
    found means the org has translated layouts into the probe language, so a heading that
    renders in it is not proof that Salesforce owns it."""
    base = Path.cwd() / "force-app" / "main" / "default" / "objectTranslations"
    ns = "{http://soap.sforce.com/2006/04/metadata}"
    read = found = 0
    for obj in objects:
        f = base / f"{obj}-{probe}" / f"{obj}-{probe}.objectTranslation-meta.xml"
        if not f.is_file():
            continue
        read += 1
        for sec in ET.parse(f).getroot().iter(ns + "sections"):
            if (sec.findtext(ns + "label") or "").strip():
                found += 1
    return read, found


def workbook_languages(wb) -> list[str]:
    """Non-English language codes that have an Existing Value column on the main tab."""
    if MAIN_TAB not in wb.sheetnames:
        return []
    header = next(wb[MAIN_TAB].iter_rows(min_row=1, max_row=1, values_only=True))
    out = []
    for h in header:
        h = str(h or "")
        if h.endswith(" Existing Value"):
            code = code_for(h[:-len(" Existing Value")])
            if code and code != "en_US" and code not in out:
                out.append(code)
    return out


def composite(urls: list[str], lang: str, org: str) -> list[dict]:
    out: list[dict] = []
    for i in range(0, len(urls), BATCH):
        chunk = urls[i:i + BATCH]
        body = {"batchRequests": [{"method": "GET", "url": u} for u in chunk],
                "haltOnError": False}
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(body, f)
        try:
            r = subprocess.run(
                [_sf(), "api", "request", "rest", f"/services/data/{API}/composite/batch",
                 "-o", org, "--method", "POST", "--body", f"@{path}",
                 "-H", f"Accept-Language: {lang.replace('_', '-')}"],
                capture_output=True, timeout=300)
        finally:
            os.unlink(path)
        try:
            res = json.loads(r.stdout.decode("utf-8", "replace")).get("results", [])
        except Exception as exc:
            sys.exit(f"composite/batch failed for {lang}: {exc}. Refusing to continue — "
                     "a swallowed batch error is indistinguishable from 'no sections'.")
        if len(res) != len(chunk):
            sys.exit(f"composite/batch returned {len(res)} results for {len(chunk)} "
                     "requests — refusing to align a partial response.")
        out += res
    return out


def tooling(soql: str, org: str) -> list[dict]:
    r = subprocess.run([_sf(), "data", "query", "--use-tooling-api", "-q", soql,
                        "-o", org, "--json"], capture_output=True, timeout=300)
    return json.loads(r.stdout.decode("utf-8", "replace"))["result"]["records"]


def layout_targets(objects: list[str], org: str) -> list[tuple[str, str]]:
    """[(object, describe-url)] — one per record type, else the bare describe."""
    base = [f"/services/data/{API}/sobjects/{o}/describe/layouts/" for o in objects]
    res = composite(base, "en_US", org)
    targets: list[tuple[str, str]] = []
    for obj, r in zip(objects, res):
        if r.get("statusCode") != 200:
            print(f"   ! {obj}: describe/layouts returned {r.get('statusCode')}",
                  file=sys.stderr)
            continue
        out = r.get("result") or {}
        rtm = [m for m in (out.get("recordTypeMappings") or []) if m.get("available")]
        seen = set()
        if rtm:
            for m in rtm:
                rid = m["recordTypeId"]
                if rid not in seen:
                    seen.add(rid)
                    targets.append(
                        (obj, f"/services/data/{API}/sobjects/{obj}/describe/layouts/{rid}"))
        elif out.get("layouts"):
            targets.append((obj, f"/services/data/{API}/sobjects/{obj}/describe/layouts/"))
    return targets


def collect(targets: list[tuple[str, str]], lang: str, org: str
            ) -> dict[tuple[str, str, str], str]:
    """{(object, layoutId15, sectionId): heading} — object tagged from the call, not guessed.

    `haltOnError: False` means a sub-request can fail while the batch still returns a
    full-length result list. An unchecked failure would contribute no keys and read
    downstream as "this section has no translation in this language" — absence taken as
    proof, in a file that goes to translators. So a non-200 is fatal here.
    """
    res = composite([u for _, u in targets], lang, org)
    out: dict[tuple[str, str, str], str] = {}
    bad: list[str] = []
    for (obj, url), r in zip(targets, res):
        code = r.get("statusCode")
        if code != 200:
            bad.append(f"{obj} ({code}) {url}")
            continue
        body = r.get("result") or {}
        if isinstance(body, list):          # Salesforce error bodies are arrays
            bad.append(f"{obj} (error body) {url}")
            continue
        layouts = body.get("layouts")
        if not layouts:
            layouts = [body] if body.get("detailLayoutSections") else []
        for L in layouts:
            lid = (L.get("id") or "")[:15]
            for s in (L.get("detailLayoutSections") or []):
                sid = s.get("layoutSectionId")
                if lid and sid:
                    # Stripped: an org can render a heading with a leading space (for
                    # example ' Widget Details'), which never matches the workbook and
                    # leaves the row unverified.
                    out[(obj, lid, sid)] = (s.get("heading") or "").strip()
    if bad:
        for b in bad[:10]:
            print(f"   ! {lang}: {b}", file=sys.stderr)
        sys.exit(f"{len(bad)} layout request(s) failed for {lang!r}. Refusing to continue — "
                 "a failed request is indistinguishable from 'no translation exists', and "
                 "that reaches translators as a blank cell.")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--org", required=True)
    ap.add_argument("--workbook", required=True)
    ap.add_argument("--langs")
    ap.add_argument("--out", default="layout_section_verdicts.json")
    ap.add_argument("--allow-no-salesforce-sections", action="store_true",
                    help="accept a result where no heading renders differently in the probe "
                         "language (normally a sign the probe did not render)")
    args = ap.parse_args()

    wb = openpyxl.load_workbook(args.workbook, read_only=True, data_only=True)
    want: set[tuple[str, str, str]] = set()
    for sheet, hdr in ((MAIN_TAB, 1), (EXCLUDED_TAB, 3)):
        if sheet not in wb.sheetnames:
            continue
        ws = wb[sheet]
        it = ws.iter_rows(values_only=True)
        h = None
        for _ in range(hdr):
            h = next(it)
        c = {x: i for i, x in enumerate(h) if x}
        ti, ci, fi, mi = c["type"], c["component"], c["field"], c["masterLabel"]
        for r in it:
            g = lambda i: ("" if i >= len(r) or r[i] is None else str(r[i]).strip())
            if g(ti) == "layout-section":
                want.add((g(ci), g(fi), g(mi)))
    objects = sorted({o for o, _, _ in want})
    print(f"layout-section rows in workbook: {len(want)}  ({len(objects)} objects)",
          file=sys.stderr)

    langs = ([l.strip() for l in args.langs.split(",") if l.strip() and l.strip() != "en_US"]
             if args.langs else workbook_languages(wb))
    if PROBE_LANG in langs:
        sys.exit(f"error: the probe language {PROBE_LANG} ({lang_name(PROBE_LANG)}) is one you "
                 "translate. Set \"probe_language\" in settings.json to a language this org "
                 "has never translated into.")
    print(f"languages: {', '.join(langs)}   probe: {PROBE_LANG}", file=sys.stderr)

    read, found = probe_translations_in_org(objects, PROBE_LANG)
    if found:
        sys.exit(f"error: the org holds {found} layout-section translation(s) in the probe "
                 f"language {PROBE_LANG} ({lang_name(PROBE_LANG)}), so the probe cannot tell "
                 "your headings from Salesforce's. Set \"probe_language\" in settings.json to a "
                 "language this org has never translated into, retrieve again, and rerun.")
    if not read:
        print(f"WARNING: no local {PROBE_LANG} translation files for these objects, so it could "
              "not be confirmed that the org never translated into the probe language. Download "
              "with the make_manifest.py manifests first (they include it).", file=sys.stderr)
    else:
        print(f"probe language unused: {read} local {PROBE_LANG} file(s) hold no layout-section "
              "translations", file=sys.stderr)

    id2name = {r["Id"][:15]: r["Name"]
               for r in tooling("SELECT Id, Name, TableEnumOrId FROM Layout", args.org)}
    targets = layout_targets(objects, args.org)
    print(f"layout describe calls per language: {len(targets)}", file=sys.stderr)

    en = collect(targets, "en_US", args.org)
    ja = collect(targets, PROBE_LANG, args.org)
    print(f"sections: en_US={len(en)}  {PROBE_LANG}={len(ja)}", file=sys.stderr)

    rendered = {l: collect(targets, l, args.org) for l in langs}

    # (object, layoutName, englishHeading) -> verdict + per-language rendering
    verdicts: dict[str, dict] = {}
    for k, eng in en.items():
        obj, lid, sid = k
        name = id2name.get(lid)
        if not name or not eng:
            continue
        probe = ja.get(k)
        if probe is None:
            continue
        rk = f"{obj}|{name}|{eng}"
        verdicts[rk] = {
            "editable": probe == eng,
            "labels": {l: rendered[l].get(k, "") for l in langs},
        }

    # Positive control: some headings must render differently in the probe language, or the
    # probe proved nothing (Salesforce ignored the language, or has no pack for it) and every
    # heading would be passed as yours.
    owned = sum(1 for v in verdicts.values() if not v["editable"])
    if verdicts and not owned and not args.allow_no_salesforce_sections:
        sys.exit(f"error: not one of {len(verdicts)} layout headings renders differently in the "
                 f"probe language {PROBE_LANG}, so the probe did not work. Set \"probe_language\" "
                 "in settings.json to another language this org has never translated into. If "
                 "you are sure none of your headings are Salesforce's, rerun with "
                 "--allow-no-salesforce-sections.")

    matched = sum(1 for o, l, m in want if f"{o}|{l}|{m}" in verdicts)
    print(f"\nworkbook rows matched to the org: {matched} / {len(want)}", file=sys.stderr)
    ed = sum(1 for o, l, m in want if verdicts.get(f"{o}|{l}|{m}", {}).get("editable"))
    sf = sum(1 for o, l, m in want
             if f"{o}|{l}|{m}" in verdicts and not verdicts[f"{o}|{l}|{m}"]["editable"])
    print(f"  editable          : {ed}", file=sys.stderr)
    print(f"  Salesforce-owned  : {sf}", file=sys.stderr)
    print(f"  unmatched         : {len(want) - matched}", file=sys.stderr)

    if len(want) - matched:
        miss = collections.Counter(o for o, l, m in want if f"{o}|{l}|{m}" not in verdicts)
        print("  unmatched by object:", dict(miss.most_common(8)), file=sys.stderr)

    # The probed language list travels WITH the verdicts. Without it, applying a run that
    # probed only some languages to a workbook with more silently blanks every unprobed
    # language column of real org data and reports success.
    payload = {
        "_meta": {
            "org": args.org,
            "probe_language": PROBE_LANG,
            "languages": langs,
            "sections": len(verdicts),
        },
        "verdicts": verdicts,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=0)
    print(f"\nwritten: {args.out}  ({len(verdicts)} sections, "
          f"{len(langs)} languages probed)", file=sys.stderr)


if __name__ == "__main__":
    main()
