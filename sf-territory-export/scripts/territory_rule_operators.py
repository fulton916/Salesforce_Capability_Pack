#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Optional report: territory assignment-rule criteria, with a "contains vs equals" check.

Reads a JSON folder saved by `territory_export.py --save-json` (no org call) and writes:

  Overview            live counts and what each operator means
  Rule Criteria       one row per criteria line: territory, rule, field, operator, value(s)
  Rules by Territory  one row per territory (and rule), in hierarchy order, with how the
                      focus-field lines combine under the rule's filter logic
  Diff <label>        (with --compare LABEL=DIR) where another org's rules differ

Why it matters: an assignment rule line with `contains` matches any value that includes
the text, so a code like R12 also matches R123 and XR12. For ID- or code-style fields,
`equals` is usually what was meant. Pass those fields with --focus-field; the report
colours focus lines green (equals) or orange (anything else) and works out, from the
filter logic, whether ANY one focus line is enough or ALL focus lines must match.

Example:
  python territory_rule_operators.py --json-dir out/json --root-territory North \\
      --focus-field Account.Sales_Rep_Code__c --focus-field Account.Region_Code__c \\
      --compare my-sandbox=out/json_sandbox --output rule_operators.xlsx
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import territory_common as tc  # noqa: E402

OPERATOR_NAMES = {
    "equals": "Equals", "notEqual": "Not equal to", "contains": "Contains", "notContain": "Does not contain",
    "startsWith": "Starts with", "lessThan": "Less than", "greaterThan": "Greater than",
    "lessOrEqual": "Less or equal", "greaterOrEqual": "Greater or equal", "includes": "Includes",
    "excludes": "Excludes", "within": "Within",
}


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--json-dir", type=Path, required=True, help="folder saved by territory_export.py --save-json")
    p.add_argument("--root-territory", help="Name, DeveloperName or Id of the start territory (default: whole model)")
    p.add_argument("--model", help="model Name/DeveloperName/Id (default: the Active model in models.json)")
    p.add_argument("--focus-field", action="append", default=[], metavar="OBJECT.FIELD",
                   help="criteria field where contains-vs-equals matters, e.g. Account.Code__c; repeatable. "
                        "Default: every field is a focus field.")
    p.add_argument("--label", default="Current", help="short name for this org (e.g. my-prod)")
    p.add_argument("--compare", action="append", metavar="LABEL=DIR",
                   help="another org's JSON folder to compare by DeveloperName; repeatable")
    p.add_argument("--output", type=Path, default=Path("territory_rule_operators.xlsx"))
    return p.parse_args(argv)


def status(op: str | None) -> str:
    if op == "equals":
        return "Equals"
    if op == "contains":
        return "Contains"
    return f"Other ({op})"


def split_values(value: str | None) -> list[str]:
    return [v.strip() for v in (value or "").split(",") if v.strip()]


# ---------------------------------------------------------------- filter logic

TOKEN = re.compile(r"\s*(\d+|AND|OR|NOT|\(|\))", re.I)


def eval_filter(logic: str | None, truth: dict[int, bool], n_lines: int) -> bool:
    """Evaluate a rule's BooleanFilter ("1 AND (2 OR 3)") for line truth values.

    No filter logic means every line must match (AND).
    """
    if not logic or not logic.strip():
        return all(truth.get(i, False) for i in range(1, n_lines + 1))
    pos, parts = 0, []
    text = logic.strip()
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m:
            raise ValueError(f"cannot read filter logic {logic!r}")
        tok = m.group(1).upper()
        parts.append(f"t[{tok}]" if tok.isdigit() else {"AND": " and ", "OR": " or ", "NOT": " not "}.get(tok, tok))
        pos = m.end()
    t = defaultdict(bool, truth)
    return bool(eval("".join(parts), {"__builtins__": {}}, {"t": t}))  # tokens are whitelisted above


def combine(rule: dict, items: list[dict], focus: set[str] | None) -> str:
    """How the focus lines combine, assuming every other line matches."""
    lines = {int(i.get("SortOrder") or n): i for n, i in enumerate(items, 1)}
    fl = [n for n, i in lines.items() if focus is None or i.get("Field") in focus]
    if not fl:
        return "n/a - no focus-field lines"
    others = {n: True for n in lines if n not in fl}
    logic, size = rule.get("BooleanFilter"), max(lines) if lines else 0
    try:
        if len(fl) == 1:
            return "single line"
        needs_all = all(not eval_filter(logic, {**others, **{f: f != x for f in fl}}, size) for x in fl)
        any_one = all(eval_filter(logic, {**others, **{f: f == x for f in fl}}, size) for x in fl)
    except (ValueError, SyntaxError):
        return "unreadable filter logic - check by hand"
    if needs_all:
        return "ALL focus lines must match (AND)"
    if any_one:
        return "ANY one focus line is enough (OR)"
    return "Mixed - see filter logic"


# ---------------------------------------------------------------- data

def load(folder: Path, model_wanted: str | None, root: str | None) -> dict:
    terr = tc.load_records(folder, tc.KEY_TERRITORIES)
    rules = tc.load_records(folder, tc.KEY_RULES)
    models = tc.load_records(folder, tc.KEY_MODELS, required=False)
    if models:
        mid = tc.choose_model(models, model_wanted)["Id"]
        terr = [t for t in terr if t.get("Territory2ModelId") in (None, mid)]
        rules = [r for r in rules if r.get("Territory2ModelId") in (None, mid)]
    walk = tc.hierarchy(terr, root)
    ids = {t["Id"] for t, _ in walk}
    rules = {r["Id"]: r for r in rules}
    items = defaultdict(list)
    for i in tc.load_records(folder, tc.KEY_RULE_ITEMS):
        if i.get("RuleId") in rules:
            items[i["RuleId"]].append(i)
    for v in items.values():
        v.sort(key=lambda i: i.get("SortOrder") or 0)
    assoc = defaultdict(list)
    for a in tc.load_records(folder, tc.KEY_RULE_TERRITORIES):
        if a.get("Territory2Id") in ids and a.get("RuleId") in rules:
            assoc[a["Territory2Id"]].append((a["RuleId"], bool(a.get("IsInherited"))))
    attached = {rid for v in assoc.values() for rid, _ in v}
    unattached = [] if root else [r for rid, r in rules.items() if rid not in attached]
    return dict(terr={t["Id"]: t for t in terr}, walk=walk, rules=rules, items=items, assoc=assoc,
                unattached=unattached)


def index_rules(D: dict, focus: set[str] | None) -> dict:
    out = {}
    for t, _ in D["walk"]:
        tid = t["Id"]
        for rid, inherited in D["assoc"][tid]:
            if inherited:
                continue
            r, its = D["rules"][rid], D["items"][rid]
            out[r["DeveloperName"]] = dict(
                name=r.get("MasterLabel"), terr=D["terr"][tid].get("Name"), bf=r.get("BooleanFilter") or "",
                ops=Counter((i.get("Field"), i.get("Operation")) for i in its),
                lines={(i.get("SortOrder"), i.get("Field")): i.get("Operation") for i in its},
                values={v for i in its if focus is None or i.get("Field") in focus for v in split_values(i.get("Value"))})
    for r in D["unattached"]:
        its = D["items"][r["Id"]]
        out.setdefault(r["DeveloperName"], dict(
            name=r.get("MasterLabel"), terr="(not attached)", bf=r.get("BooleanFilter") or "",
            ops=Counter((i.get("Field"), i.get("Operation")) for i in its),
            lines={(i.get("SortOrder"), i.get("Field")): i.get("Operation") for i in its},
            values={v for i in its if focus is None or i.get("Field") in focus for v in split_values(i.get("Value"))}))
    return out


def ops_text(ops: Counter) -> str:
    return "; ".join(f"{f} {op}" + (f" x{n}" if n > 1 else "") for (f, op), n in sorted(ops.items(), key=str))


def diff(a_label, A: dict, b_label, B: dict, a_terr: dict, b_terr: dict) -> list[list]:
    rows = []
    for dn in sorted(set(a_terr) ^ set(b_terr)):
        rows.append(["Territory", a_terr.get(dn) or b_terr.get(dn), dn,
                     f"In {a_label} only" if dn in a_terr else f"In {b_label} only", "", ""])
    for dn in sorted(set(A) | set(B)):
        a, b = A.get(dn), B.get(dn)
        if not a or not b:
            x = a or b
            rows.append(["Rule", x["name"], dn, f"In {a_label} only" if a else f"In {b_label} only", x["terr"], ""])
            continue
        if a["terr"] != b["terr"]:
            rows.append(["Rule", a["name"], dn, "Attached to a different territory", a["terr"], b["terr"]])
        if a["bf"] != b["bf"]:
            rows.append(["Rule", a["name"], dn, "Filter logic differs", a["bf"] or "(none)", b["bf"] or "(none)"])
        if a["ops"] != b["ops"]:
            rows.append(["Rule", a["name"], dn, "Operators differ", ops_text(a["ops"]), ops_text(b["ops"])])
        if a["values"] != b["values"]:
            oa, ob = sorted(a["values"] - b["values"]), sorted(b["values"] - a["values"])
            rows.append(["Rule", a["name"], dn, "Focus-field values differ",
                         f"{len(oa)} only in {a_label}: " + ", ".join(oa) if oa else "",
                         f"{len(ob)} only in {b_label}: " + ", ".join(ob) if ob else ""])
    return rows


# ---------------------------------------------------------------- workbook

def build(args) -> Path:
    import openpyxl
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    focus = set(args.focus_field) or None
    D = load(args.json_dir, args.model, args.root_territory)
    if not D["walk"]:
        raise tc.TerritoryError("No territories in the JSON folder.")
    compares = []
    for label, folder in tc.parse_labeled_dirs(args.compare):
        O = load(folder, None, None)
        sub = O
        if args.root_territory:
            start = D["terr"][D["walk"][0][0]["Id"]].get("DeveloperName")
            if any(t.get("DeveloperName") == start for t in O["terr"].values()):
                sub = load(folder, None, start)
        compares.append((label, sub))
    terr = D["terr"]

    def parent(t):
        p = terr.get(t.get("ParentTerritory2Id"))
        return p.get("Name") if p else ""

    cmp_lines = [(label, {(O["rules"][rid]["DeveloperName"], i.get("SortOrder"), i.get("Field")): i.get("Operation")
                          for rid in O["rules"] for i in O["items"][rid]}) for label, O in compares]

    lines, by_terr = [], []

    def add_rule_lines(lvl, t, r, its):
        for n, i in enumerate(its, 1):
            is_focus = focus is None or i.get("Field") in focus
            vals = split_values(i.get("Value"))
            row = [lvl, t.get("Name") if t else "(not attached)", t.get("DeveloperName") if t else "",
                   tc.nested(t, "Territory2Type.MasterLabel") if t else "", parent(t) if t else "",
                   r.get("MasterLabel"), r.get("DeveloperName"), "Yes" if r.get("IsActive") else "No",
                   r.get("ObjectType") or "", r.get("BooleanFilter") or "(none)", i.get("SortOrder") or n,
                   i.get("Field"), "Yes" if is_focus else "No", OPERATOR_NAMES.get(i.get("Operation"), i.get("Operation")),
                   status(i.get("Operation")), i.get("Value") or "", len(vals),
                   (i.get("LastModifiedDate") or "")[:10], tc.nested(i, "LastModifiedBy.Name")]
            for _, m in cmp_lines:
                row.append(m.get((r.get("DeveloperName"), i.get("SortOrder"), i.get("Field")), "(no such line)"))
            lines.append(row)

    for t, lvl in D["walk"]:
        if not D["assoc"][t["Id"]]:
            by_terr.append([lvl, "    " * lvl + t.get("Name", ""), t.get("DeveloperName"),
                            tc.nested(t, "Territory2Type.MasterLabel"), parent(t), "(no assignment rule)",
                            "", "", "", "", "", 0, "", ""])
            continue
        for rid, inherited in D["assoc"][t["Id"]]:
            r, its = D["rules"][rid], D["items"][rid]
            if not inherited:
                add_rule_lines(lvl, t, r, its)
            focus_ops = {i.get("Operation") for i in its if focus is None or i.get("Field") in focus}
            focus_status = "n/a" if not focus_ops else status(next(iter(focus_ops))) if len(focus_ops) == 1 else "Mixed"
            how = combine(r, its, focus)
            other = "; ".join(f"{i.get('Field')} {i.get('Operation')} {i.get('Value')}" for i in its
                              if focus is not None and i.get("Field") not in focus)
            n_vals = len({v for i in its if focus is None or i.get("Field") in focus for v in split_values(i.get("Value"))})
            note = ""
            if how.startswith("ALL") and focus is not None:
                note = "A record matches only if every focus field holds one of the listed values."
            if focus_status not in ("Equals", "n/a"):
                note = (note + " " if note else "") + "Focus lines are not all 'equals': partial matches are possible."
            by_terr.append([lvl, "    " * lvl + t.get("Name", ""), t.get("DeveloperName"),
                            tc.nested(t, "Territory2Type.MasterLabel"), parent(t), r.get("MasterLabel"),
                            r.get("DeveloperName"), r.get("BooleanFilter") or "(none)", focus_status, how, other,
                            n_vals, "Yes" if inherited else "No", note])
    for r in D["unattached"]:
        add_rule_lines("", None, r, D["items"][r["Id"]])

    wb = openpyxl.Workbook()
    hdr = PatternFill("solid", fgColor="1F497D")
    green, amber, grey = (PatternFill("solid", fgColor=c) for c in ("E2EFDA", "FCE4D6", "F2F2F2"))
    base, bold = Font(size=10), Font(size=10, bold=True)

    def sheet(ws, headers, rows, widths, wrap=(), fill=None):
        for c, h in enumerate(headers, 1):
            cell = ws.cell(row=1, column=c, value=h)
            cell.fill, cell.font = hdr, Font(size=10, bold=True, color="FFFFFF")
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        for r, row in enumerate(rows, 2):
            f = fill(row) if fill else None
            for c, v in enumerate(row, 1):
                cell = ws.cell(row=r, column=c, value=tc.cell_value(v))
                cell.font = base
                cell.alignment = Alignment(vertical="top", wrap_text=c in wrap)
                if f:
                    cell.fill = f
        tc.set_widths(ws, widths + [14] * (len(headers) - len(widths)))
        ws.row_dimensions[1].height = 30
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows) + 1}"

    ov = wb.active
    ov.title = "Overview"
    ws = wb.create_sheet("Rule Criteria")
    sheet(ws, ["Level", "Territory", "Territory API Name", "Territory Type", "Parent Territory", "Rule Name",
               "Rule API Name", "Rule Active?", "Object", "Filter Logic", "Line #", "Criteria Field",
               "Focus Field?", "Operator", "Contains vs Equals", "Value(s)", "# Values in Line",
               "Line Last Modified", "Line Last Modified By"] + [f"Operator in {lb}" for lb, _ in compares],
          lines, [7, 34, 36, 16, 30, 40, 42, 9, 10, 26, 7, 38, 9, 14, 12, 60, 10, 12, 20], wrap=(16,),
          fill=lambda row: (green if row[14] == "Equals" else amber) if row[12] == "Yes" else None)
    ws = wb.create_sheet("Rules by Territory")
    sheet(ws, ["Level", "Territory (indented by level)", "Territory API Name", "Territory Type", "Parent Territory",
               "Rule Name", "Rule API Name", "Filter Logic", "Focus-Field Operator", "How the Focus Lines Combine",
               "Other Criteria", "# Distinct Focus Values", "Inherited from Parent?", "Note"],
          by_terr, [7, 46, 36, 16, 30, 40, 42, 30, 12, 34, 44, 11, 11, 60], wrap=(14,),
          fill=lambda row: grey if row[5] == "(no assignment rule)" else (amber if row[13] else None))

    a_idx = index_rules(D, focus)
    a_terr = {t.get("DeveloperName"): t.get("Name") for t, _ in D["walk"]}
    for label, O in compares:
        b_terr = {t.get("DeveloperName"): t.get("Name") for t, _ in O["walk"]}
        rows = diff(args.label, a_idx, label, index_rules(O, focus), a_terr, b_terr)
        sheet(wb.create_sheet(f"Diff {label}"[:31]), ["Item", "Name", "API Name", "Difference", args.label, label],
              rows, [10, 40, 42, 30, 70, 70], wrap=(5, 6))

    RC, RT = "'Rule Criteria'", "'Rules by Territory'"
    n_l, n_t = len(lines) + 1, len(by_terr) + 1
    fc, st = f"{RC}!$M$2:$M${n_l}", f"{RC}!$O$2:$O${n_l}"
    start_names = ", ".join(sorted({t.get("Name") for t, lvl in D["walk"] if lvl == 0}))
    focus_desc = ", ".join(sorted(focus)) if focus else "all criteria fields"
    content = [
        (f"Territory assignment rules - {start_names}" + (" and below" if args.root_territory else ""), None, "title"),
        (f"Source: {args.label}, read from {args.json_dir} (territory_export.py JSON). Read-only.", None, "note"),
        (f"Focus fields: {focus_desc}.", None, "note"),
        ("", None, None),
        ("Scope", None, "head"),
        ("Territories in scope", f"=SUMPRODUCT(1/COUNTIF({RT}!$C$2:$C${n_t},{RT}!$C$2:$C${n_t}))", None),
        ("  rows with an assignment rule", f"=COUNTIF({RT}!$F$2:$F${n_t},\"<>(no assignment rule)\")", None),
        ("  without an assignment rule", f"=COUNTIF({RT}!$F$2:$F${n_t},\"(no assignment rule)\")", None),
        ("Criteria lines (all fields)", f"=COUNTA({RC}!$K$2:$K${n_l})", None),
        ("", None, None),
        ("Focus-field criteria lines", None, "head"),
        ("Focus lines", f"=COUNTIF({fc},\"Yes\")", None),
        ("  Equals", f"=COUNTIFS({fc},\"Yes\",{st},\"Equals\")", None),
        ("  Contains", f"=COUNTIFS({fc},\"Yes\",{st},\"Contains\")", None),
        ("  Any other operator", f"=COUNTIFS({fc},\"Yes\",{st},\"Other*\")", None),
        ("Rules where ALL focus lines must match", f"=COUNTIF({RT}!$J$2:$J${n_t},\"ALL*\")", None),
        ("", None, None),
        ("What the operator means", None, "head"),
        ("Equals", "The field must hold exactly one of the listed values. Comma-separated values = any one of them.", "text"),
        ("Contains", "The field only has to include the text, so 'R12' also matches 'R123' and 'XR12'.", "text"),
        ("Starts with", "The field must begin with the text, so 'R12' also matches 'R123'.", "text"),
        ("", None, None),
        ("Tabs", None, "head"),
        ("Rule Criteria", "One row per criteria line. Green = focus line on equals; orange = focus line on anything else. "
                          "Rules attached to no territory are listed at the end with Territory '(not attached)'.", "text"),
        ("Rules by Territory", "One row per territory and rule, in hierarchy order, with how the focus lines combine "
                               "(read from the filter logic, assuming the other lines match). Grey = no rule.", "text"),
    ] + [(f"Diff {lb}", f"Where {lb} differs from {args.label} for this scope, matched by DeveloperName.", "text")
         for lb, _ in compares]
    for r, (a, b, kind) in enumerate(content, 1):
        ca, cb = ov.cell(row=r, column=1, value=a), ov.cell(row=r, column=2, value=b)
        ca.font = cb.font = base
        if kind == "title":
            ca.font = Font(size=14, bold=True, color="1F497D")
        elif kind == "head":
            ca.font = bold
            ca.fill = cb.fill = PatternFill("solid", fgColor="DDEBF7")
        elif kind == "note":
            ov.merge_cells(start_row=r, start_column=1, end_row=r, end_column=2)
            ca.alignment = Alignment(wrap_text=True, vertical="top")
        elif kind == "text":
            cb.alignment = Alignment(wrap_text=True, vertical="top")
        if isinstance(b, str) and b.startswith("="):
            cb.alignment = Alignment(horizontal="left")
    ov.column_dimensions["A"].width = 50
    ov.column_dimensions["B"].width = 90

    args.output.parent.mkdir(parents=True, exist_ok=True)
    wb.save(args.output)
    fl = [l for l in lines if l[12] == "Yes"]
    print(f"Saved {args.output.resolve()}: {len(lines)} criteria lines, {len(fl)} focus lines "
          f"{dict(Counter(l[14] for l in fl))}, {len(by_terr)} territory rows")
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
