#!/usr/bin/env python3
"""Optional report: territory access-level audit workbook.

Reads a JSON folder saved by `territory_export.py --save-json` (no org call) and writes:

  Summary            what to look at, live counts, the access patterns in use, and
                     automatic checks (see below)
  Territory Access   one row per territory, depth-first. Three yellow "Should be" columns
                     (Account / Opportunity / Case, with dropdowns) sit left of the territory
                     name, the current access levels to the right, and a Result formula
                     (OK / CHECK / not set) that recomputes when you edit a yellow cell.
  User Assignments   who is assigned to each territory in scope

"Should be" is pre-filled with a proposal: each territory should match the most common
access pattern in its branch (the ancestor at --branch-level below the start territory).
Use --no-proposal to leave it blank for a reviewer to fill.

Automatic checks on the Summary tab:
  - territories that differ from their branch's usual pattern
  - territories whose access differs from every one of their direct children
  - records assigned directly to the start territory
  - repeated territory names
  - user assignments with no Role in Territory
  - with --compare LABEL=DIR: territories that differ from, or are missing in, another org

Example:
  python territory_access_audit.py --json-dir out/json --root-territory North \\
      --label my-prod --compare my-sandbox=out/json_sandbox --output access_audit.xlsx
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import territory_common as tc  # noqa: E402

TOP = "(top)"


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--json-dir", type=Path, required=True, help="folder saved by territory_export.py --save-json")
    p.add_argument("--root-territory", help="Name, DeveloperName or Id of the start territory (default: whole model)")
    p.add_argument("--model", help="model Name/DeveloperName/Id (default: the Active model in models.json)")
    p.add_argument("--branch-level", type=int, default=1,
                   help="level that defines a branch for the proposal (default 1 = children of the start)")
    p.add_argument("--label", default="Current", help="short name for this org in column headers (e.g. my-prod)")
    p.add_argument("--compare", action="append", metavar="LABEL=DIR",
                   help="another org's JSON folder to compare by DeveloperName; repeatable")
    p.add_argument("--no-proposal", action="store_true", help="leave the Should be columns empty")
    p.add_argument("--output", type=Path, default=Path("territory_access_audit.xlsx"))
    return p.parse_args(argv)


def access(t: dict) -> tuple:
    return (t.get("AccountAccessLevel"), t.get("OpportunityAccessLevel"), t.get("CaseAccessLevel"))


def show(t: tuple) -> tuple:
    return (tc.ACCOUNT_ACCESS.get(t[0], t[0] or ""),
            tc.OTHER_ACCESS.get(t[1], t[1] or ""),
            tc.OTHER_ACCESS.get(t[2], t[2] or ""))


def model_territories(folder: Path, wanted: str | None) -> list[dict]:
    terr = tc.load_records(folder, tc.KEY_TERRITORIES)
    models = tc.load_records(folder, tc.KEY_MODELS, required=False)
    if models:
        model = tc.choose_model(models, wanted)
        terr = [t for t in terr if t.get("Territory2ModelId") in (None, model["Id"])]
    return terr


def analyse(terr: list[dict], root: str | None, branch_level: int):
    """Rows with level, branch and proposal. Pure function (no Excel), so it is easy to test."""
    by_id = {t["Id"]: t for t in terr}
    walk = tc.hierarchy(terr, root)
    start_of = {}
    for t, lvl in walk:
        start_of[t["Id"]] = t["Id"] if lvl == 0 else start_of[t["ParentTerritory2Id"]]

    def chain(t):
        c = tc.ancestors(t, by_id)
        ids = [x["Id"] for x in c]
        return c[ids.index(start_of[t["Id"]]):]

    rows = []
    for t, lvl in walk:
        c = chain(t)
        branch = c[branch_level].get("Name") if len(c) > branch_level else TOP
        rows.append({"t": t, "level": lvl, "branch": branch, "start": c[0],
                     "path": " > ".join(x.get("Name", "") for x in c)})

    patterns = {}
    for b in {r["branch"] for r in rows if r["branch"] != TOP}:
        cnt = Counter(access(r["t"]) for r in rows if r["branch"] == b)
        (best, n), *rest = cnt.most_common()
        tie = bool(rest) and rest[0][1] == n
        patterns[b] = (best, n, sum(cnt.values()), tie)

    for r in rows:
        if r["branch"] == TOP:
            r["want"] = access(r["t"])
            r["why"] = "Above the branch level (start of the scope). Kept as it is today."
            continue
        best, n, tot, tie = patterns[r["branch"]]
        r["want"] = best
        r["why"] = f"{r['branch']} pattern: {n} of {tot} territories in this branch use it."
        if tie:
            r["why"] += " Two patterns are equally common; the first one found was used."
        if access(r["t"]) != best:
            r["why"] += " This territory differs from that pattern."

    kids = defaultdict(list)
    in_scope = {r["t"]["Id"] for r in rows}
    for r in rows:
        p = r["t"].get("ParentTerritory2Id")
        if p in in_scope and r["level"] > 0:
            kids[p].append(r["t"])
    parent_differs = [r["t"] for r in rows
                      if kids[r["t"]["Id"]] and all(access(k) != access(r["t"]) for k in kids[r["t"]["Id"]])]
    return rows, patterns, parent_differs


def compare_status(t: dict, other: dict[str, dict] | None) -> str:
    if other is None:
        return ""
    o = other.get(t.get("DeveloperName"))
    if o is None:
        return "not there"
    if access(o) != access(t):
        return "differs (" + " / ".join(show(access(o))) + ")"
    return "same"


def build(args) -> Path:
    from openpyxl import Workbook
    from openpyxl.formatting.rule import CellIsRule, FormulaRule
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.datavalidation import DataValidation

    terr = model_territories(args.json_dir, args.model)
    if not terr:
        raise tc.TerritoryError("No territories in the JSON folder.")
    rows, patterns, parent_differs = analyse(terr, args.root_territory, args.branch_level)
    ids = {r["t"]["Id"] for r in rows}
    by_id = {t["Id"]: t for t in terr}

    users = [u for u in tc.load_records(args.json_dir, tc.KEY_USER_TERRITORIES, required=False)
             if u.get("Territory2Id") in ids]
    ucount = Counter(u["Territory2Id"] for u in users)
    acct, allrec = Counter(), Counter()
    for a in tc.load_records(args.json_dir, tc.KEY_OBJECT_COUNTS, required=False):
        if a.get("Territory2Id") in ids:
            n = int(a.get("n") or a.get("expr0") or 0)
            allrec[a["Territory2Id"]] += n
            if a.get("SobjectType") == "Account":
                acct[a["Territory2Id"]] += n

    compares = []
    for label, folder in tc.parse_labeled_dirs(args.compare):
        other = model_territories(folder, None)
        compares.append((label, {t.get("DeveloperName"): t for t in other}))

    # ---- styles
    font, bold = Font(size=10), Font(size=10, bold=True)
    hfont = Font(size=10, bold=True, color="FFFFFF")
    navy, grey, olive = (PatternFill("solid", fgColor=c) for c in ("1F3864", "595959", "7F6000"))
    yellow, lgrey = PatternFill("solid", fgColor="FFF2CC"), PatternFill("solid", fgColor="F2F2F2")
    side = Side(style="thin", color="BFBFBF")
    box = Border(left=side, right=side, top=side, bottom=side)
    wrap = Alignment(wrap_text=True, vertical="top")

    wb = Workbook()
    ws = wb.active
    ws.title = "Territory Access"
    L = args.label
    cols = [("Should be: Account Access", 14, "S"), ("Should be: Opportunity Access", 14, "S"),
            ("Should be: Case Access", 14, "S"), ("Territory Name", 42, "T"),
            (f"{L}: Account Access", 14, "P"), (f"{L}: Opportunity Access", 14, "P"), (f"{L}: Case Access", 14, "P"),
            ("Result", 9, "R"), ("Differs on", 16, "R"), ("Why this 'should be' value", 60, "W"),
            ("Level (0 = start)", 8, "D"), ("Territory Type", 18, "D"), ("Parent Territory", 30, "D"),
            ("Branch", 22, "D"), ("Users assigned", 9, "D"), ("Accounts assigned", 11, "D"),
            ("Records assigned (all objects)", 11, "D"), (f"{L}: Contact Access", 12, "D"),
            ("Last Modified", 12, "D"), ("Last Modified By", 16, "D"), ("Developer Name", 40, "D"),
            ("Territory Id", 20, "D"), ("Hierarchy Path", 70, "D")]
    cols += [(f"{label}: access", 24, "C") for label, _ in compares]
    groups = {"S": ("SHOULD BE (edit these)", olive), "T": ("TERRITORY", navy), "P": (f"{L} NOW", grey),
              "R": ("CHECK", navy), "W": ("NOTE", navy), "D": ("DETAILS", grey), "C": ("OTHER ORGS", navy)}
    c0 = 1
    for g in "STPRWDC":
        n = sum(1 for c in cols if c[2] == g)
        if not n:
            continue
        ws.cell(1, c0, groups[g][0])
        if n > 1:
            ws.merge_cells(start_row=1, start_column=c0, end_row=1, end_column=c0 + n - 1)
        for c in range(c0, c0 + n):
            ws.cell(1, c).fill, ws.cell(1, c).font = groups[g][1], hfont
        c0 += n
    for i, (h, w, g) in enumerate(cols, 1):
        c = ws.cell(2, i, h)
        c.font, c.fill, c.border = hfont, groups[g][1], box
        c.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.row_dimensions[2].height = 42

    first = 3
    for n, r in enumerate(rows):
        x, t = first + n, r["t"]
        want = ("", "", "") if args.no_proposal else show(r["want"])
        now = show(access(t))
        parent = by_id.get(t.get("ParentTerritory2Id"))
        vals = [*want, t.get("Name"), *now,
                f'=IF(COUNTA(A{x}:C{x})<3,"not set",IF(AND(A{x}=E{x},B{x}=F{x},C{x}=G{x}),"OK","CHECK"))',
                f'=IF(H{x}<>"CHECK","",TRIM(IF(A{x}<>E{x},"Account ","")&IF(B{x}<>F{x},"Opportunity ","")'
                f'&IF(C{x}<>G{x},"Case","")))',
                "" if args.no_proposal else r["why"], r["level"], tc.nested(t, "Territory2Type.MasterLabel"),
                parent.get("Name") if parent and r["level"] > 0 else "", r["branch"], ucount[t["Id"]],
                acct[t["Id"]], allrec[t["Id"]],
                tc.OTHER_ACCESS.get(t.get("ContactAccessLevel"), t.get("ContactAccessLevel") or ""),
                (t.get("LastModifiedDate") or "")[:10], tc.nested(t, "LastModifiedBy.Name"),
                t.get("DeveloperName"), t["Id"], r["path"]]
        vals += [compare_status(t, other) for _, other in compares]
        for i, v in enumerate(vals, 1):
            c = ws.cell(x, i, v)
            c.font, c.border = font, box
            c.alignment = Alignment(vertical="top", wrap_text=i in (10, 23))
        for i in (1, 2, 3):
            ws.cell(x, i).fill = yellow
        for i in (5, 6, 7):
            ws.cell(x, i).fill = lgrey
        ws.cell(x, 4).alignment = Alignment(indent=min(r["level"] * 2, 15), vertical="top")
        ws.cell(x, 4).font = bold if r["level"] <= 1 else font
    last = first + len(rows) - 1

    dv_a = DataValidation(type="list", formula1='"Read Only,Read/Write,Owner"', allow_blank=True)
    dv_o = DataValidation(type="list", formula1='"Private,Read Only,Read/Write"', allow_blank=True)
    ws.add_data_validation(dv_a)
    ws.add_data_validation(dv_o)
    dv_a.add(f"A{first}:A{last}")
    dv_o.add(f"B{first}:C{last}")
    red, green = PatternFill("solid", fgColor="F8CBAD"), PatternFill("solid", fgColor="C6EFCE")
    ws.conditional_formatting.add(f"H{first}:H{last}", CellIsRule(operator="equal", formula=['"CHECK"'], fill=red,
                                                                   font=Font(bold=True, color="9C0006")))
    ws.conditional_formatting.add(f"H{first}:H{last}", CellIsRule(operator="equal", formula=['"OK"'], fill=green))
    for col, want in (("E", "A"), ("F", "B"), ("G", "C")):
        ws.conditional_formatting.add(f"{col}{first}:{col}{last}",
                                      FormulaRule(formula=[f'AND({want}{first}<>"",{col}{first}<>{want}{first})'],
                                                  fill=red))
    ws.freeze_panes = "E3"
    ws.auto_filter.ref = f"A2:{get_column_letter(len(cols))}{last}"

    # ---- Summary
    sm = wb.create_sheet("Summary", 0)
    sm.column_dimensions["A"].width = 5
    sm.column_dimensions["B"].width = 110
    for c in "CDEF":
        sm.column_dimensions[c].width = 14
    T = "'Territory Access'!"

    def rng(c):
        return f"{T}${c}${first}:${c}${last}"

    line = [1]

    def put(a=None, b=None, f=None, fill=None):
        x = line[0]
        if a is not None:
            sm.cell(x, 1, a).font = f or font
        if b is not None:
            c = sm.cell(x, 2, b)
            c.font, c.alignment = f or font, wrap
            if fill:
                c.fill = fill
        line[0] += 1
        return x

    start_names = sorted({r["start"].get("Name") for r in rows})
    put(None, "Territory access audit: " + ", ".join(start_names)
        + (" and every territory below it" if args.root_territory else ""), Font(size=14, bold=True))
    put(None, f"Source: {L}, read from {args.json_dir} (territory_export.py JSON). Read-only; nothing was changed.")
    put(None, "Setup shows Account, Opportunity and Case access per territory. Contact access only matters when "
              "Contact sharing is not 'Controlled by Parent'; it is listed in the details.")
    line[0] += 1
    put(None, "How to use the 'Territory Access' tab", bold)
    put(None, "Columns A-C (yellow) say what each territory SHOULD be. "
              + ("They are empty: fill them from the dropdowns." if args.no_proposal else
                 "They hold a proposal: each territory matches the most common pattern in its branch. Column J says why.")
              + " Edit any yellow cell and columns H-I recompute; current values that differ turn red.", fill=yellow)
    line[0] += 1
    put(None, "Counts (live formulas)", bold)
    for label, f in (("Territories", f"=COUNTA({rng('D')})"),
                     ("OK - matches 'should be'", f'=COUNTIF({rng("H")},"OK")'),
                     ("CHECK - differs from 'should be'", f'=COUNTIF({rng("H")},"CHECK")'),
                     ("'Should be' not filled in", f'=COUNTIF({rng("H")},"not set")')):
        x = put(None, label)
        sm.cell(x, 3, f).font = bold
    line[0] += 1

    put(None, "Access patterns in use (live counts)", bold)
    x = line[0]
    for i, h in enumerate(("Branch / Territory Type", "Account", "Opportunity", "Case", "Territories"), 2):
        c = sm.cell(x, i, h)
        c.font, c.fill, c.border = hfont, navy, box
    line[0] += 1
    combos = sorted({(r["branch"], tc.nested(r["t"], "Territory2Type.MasterLabel"), show(access(r["t"])))
                     for r in rows}, key=lambda k: (k[0] != TOP, k[0], k[1]))
    for b, typ, a in combos:
        x = line[0]
        vals = [f"{b}  /  {typ}", *a,
                f'=COUNTIFS({rng("N")},"{b}",{rng("L")},"{typ}",{rng("E")},"{a[0]}",'
                f'{rng("F")},"{a[1]}",{rng("G")},"{a[2]}")']
        for i, v in enumerate(vals, 2):
            c = sm.cell(x, i, v)
            c.font, c.border = font, box
        line[0] += 1
    line[0] += 1

    def names(ts, limit=25):
        ts = list(ts)
        s = ", ".join(t.get("Name", "") for t in ts[:limit])
        return s + (f", and {len(ts) - limit} more" if len(ts) > limit else "")

    put(None, "Automatic checks", bold)
    off = [r["t"] for r in rows if r["branch"] != TOP and access(r["t"]) != r["want"]]
    put("1.", f"{len(off)} territories differ from their branch's usual pattern"
        + (f": {names(off)}." if off else "."))
    put("2.", f"{len(parent_differs)} territories have access that differs from every one of their direct "
              "children" + (f": {names(parent_differs)}. Decide which is right: the parent or the children."
                            if parent_differs else "."))
    starts = [r["t"] for r in rows if r["level"] == 0]
    direct = sum(acct[t["Id"]] for t in starts)
    put("3.", f"{direct:,} accounts are assigned directly to the start territor{'y' if len(starts) == 1 else 'ies'} "
              f"(of {sum(acct.values()):,} account assignments in scope). Users in territories below do not get "
              "access to them through that assignment.")
    dupes = {k: v for k, v in Counter(r["t"].get("Name") for r in rows).items() if v > 1}
    put("4.", "Repeated territory names: " + (", ".join(f"{k} x{v}" for k, v in sorted(dupes.items())) or "none") + ".")
    blank_role = sum(1 for u in users if not u.get("RoleInTerritory2"))
    put("5.", f"Role in Territory is blank on {blank_role:,} of {len(users):,} user assignments.")
    for i, (label, other) in enumerate(compares, 6):
        st = Counter(compare_status(r["t"], other).split(" (")[0] for r in rows)
        here = {r["t"].get("DeveloperName") for r in rows}
        dev_start = {r["start"].get("DeveloperName") for r in rows}
        other_by_id = {x["Id"]: x for x in other.values()}
        only_other = [t for d, t in other.items() if d not in here and any(
            a.get("DeveloperName") in dev_start for a in tc.ancestors(t, other_by_id))]
        put(f"{i}.", f"Compared with {label}: {st['same']} same, {st['differs']} differ, {st['not there']} not in "
                     f"{label}; {len(only_other)} territories under the same start exist only in {label}"
                     + (f" ({names(only_other, 10)})." if only_other else "."))

    # ---- User Assignments
    ua = wb.create_sheet("User Assignments")
    heads = [("Territory Name", 36), ("Developer Name", 36), ("Branch", 22), ("Territory Type", 18),
             ("User", 30), ("Username", 34), ("User Active", 8), ("Profile", 30), ("Role in Territory", 14),
             ("Assignment Last Modified", 14)]
    ua.append([h for h, _ in heads])
    tc.style_header(ua, fill_hex="1F3864")
    tc.set_widths(ua, [w for _, w in heads])
    order = {r["t"]["Id"]: n for n, r in enumerate(rows)}
    branch_of = {r["t"]["Id"]: r["branch"] for r in rows}
    for u in sorted(users, key=lambda u: (order[u["Territory2Id"]], tc.nested(u, "User.Name"))):
        t = by_id[u["Territory2Id"]]
        active = tc.nested(u, "User.IsActive", None)
        ua.append([t.get("Name"), t.get("DeveloperName"), branch_of[t["Id"]], tc.nested(t, "Territory2Type.MasterLabel"),
                   tc.nested(u, "User.Name"), tc.nested(u, "User.Username"),
                   "" if active is None else ("Yes" if active else "No"), tc.nested(u, "User.Profile.Name"),
                   u.get("RoleInTerritory2") or "", (u.get("LastModifiedDate") or "")[:10]])
    ua.freeze_panes = "A2"
    ua.auto_filter.ref = f"A1:J{len(users) + 1}"

    args.output.parent.mkdir(parents=True, exist_ok=True)
    wb.save(args.output)
    print(f"Saved {args.output.resolve()}: {len(rows)} territories, {len(users)} user assignments, "
          f"{len(off)} differ from their branch pattern, {len(parent_differs)} differ from all children.")
    return args.output


def main(argv=None) -> int:
    args = parse_args(argv)
    try:
        build(args)
    except tc.TerritoryError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
