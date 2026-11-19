#!/usr/bin/env python3
"""Export Enterprise Territory Management data to Excel, one tab per query.

Read-only. Runs a fixed set of SOQL queries through the Salesforce CLI and writes:

  Index                 every tab, its row count, status (OK / TRUNCATED / ERROR) and query
  Run Info              org, model, root territory, time
  Hierarchy             territories depth-first with level, path, access levels and counts
  1_Models              Territory2Model
  2_Territories         Territory2
  3_Rules               ObjectTerritory2AssignmentRule
  4_RuleItems           ObjectTerritory2AssignmentRuleItem (rule criteria lines)
  5_RuleTerritories     RuleTerritory2Association (which rule sits on which territory)
  6_UserTerritories     UserTerritory2Association
  7_ObjectCounts        ObjectTerritory2Association, counted per territory and object type
  8_ObjectTerritories   (only with --object-detail) every ObjectTerritory2Association row
  F_<Object>            (only with --field-checks) one record per object, FIELDS(ALL), vertical
  <your tabs>           (only with --extra-query TAB=SOQL)

By default only the Active model is exported. --root-territory limits every tab to one
territory and everything below it. --save-json keeps the raw results so the optional
reports (territory_access_audit.py, territory_rule_operators.py) can run without the org,
and --from-json rebuilds the workbook from such a folder.

Examples:
  python territory_export.py --target-org my-prod
  python territory_export.py -o my-prod --root-territory North --save-json out/json
  python territory_export.py --from-json out/json --output territories.xlsx
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import territory_common as tc  # noqa: E402

MAX_EXCEL_ROWS = 1_048_575

QUERIES = [
    # (tab, json key, SOQL; {model_filter} is replaced by a WHERE clause or "")
    ("1_Models", tc.KEY_MODELS,
     "SELECT Id, Name, DeveloperName, State, LastModifiedDate FROM Territory2Model ORDER BY Name"),
    ("2_Territories", tc.KEY_TERRITORIES,
     "SELECT Id, Name, DeveloperName, Territory2ModelId, ParentTerritory2Id, Territory2TypeId, "
     "Territory2Type.MasterLabel, AccountAccessLevel, OpportunityAccessLevel, CaseAccessLevel, "
     "ContactAccessLevel, Description, LastModifiedDate, LastModifiedBy.Name "
     "FROM Territory2{where_model}"),
    ("3_Rules", tc.KEY_RULES,
     "SELECT Id, DeveloperName, MasterLabel, Territory2ModelId, ObjectType, IsActive, BooleanFilter, "
     "LastModifiedDate, LastModifiedBy.Name FROM ObjectTerritory2AssignmentRule{where_model}"),
    ("4_RuleItems", tc.KEY_RULE_ITEMS,
     "SELECT Id, RuleId, SortOrder, Field, Operation, Value, LastModifiedDate, LastModifiedBy.Name "
     "FROM ObjectTerritory2AssignmentRuleItem ORDER BY RuleId, SortOrder"),
    ("5_RuleTerritories", tc.KEY_RULE_TERRITORIES,
     "SELECT Id, RuleId, Territory2Id, IsInherited FROM RuleTerritory2Association{where_territory_model}"),
    ("6_UserTerritories", tc.KEY_USER_TERRITORIES,
     "SELECT Id, UserId, User.Name, User.Username, User.IsActive, User.Profile.Name, Territory2Id, "
     "RoleInTerritory2, IsActive, LastModifiedDate FROM UserTerritory2Association{where_territory_model}"),
    ("7_ObjectCounts", tc.KEY_OBJECT_COUNTS,
     "SELECT Territory2Id, SobjectType, COUNT(Id) n FROM ObjectTerritory2Association"
     "{where_territory_model} GROUP BY Territory2Id, SobjectType"),
]
OBJECT_DETAIL = ("8_ObjectTerritories", tc.KEY_OBJECT_DETAIL,
                 "SELECT Id, ObjectId, SobjectType, Territory2Id, AssociationCause, LastModifiedDate "
                 "FROM ObjectTerritory2Association{where_territory_model}")
FIELD_CHECK_OBJECTS = ["Territory2Model", "Territory2", "ObjectTerritory2AssignmentRule",
                       "ObjectTerritory2AssignmentRuleItem", "RuleTerritory2Association",
                       "UserTerritory2Association", "ObjectTerritory2Association", "Account", "User"]


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-o", "--target-org", help="sf org alias or username (default: the sf default org)")
    p.add_argument("--model", help="territory model Name, DeveloperName or Id (default: the Active model)")
    p.add_argument("--all-models", action="store_true", help="do not filter by model")
    p.add_argument("--root-territory", help="Name, DeveloperName or Id: export only this territory and below")
    p.add_argument("--output", type=Path, help="workbook path (default: territory_export_<date>.xlsx)")
    p.add_argument("--save-json", type=Path, metavar="DIR", help="also save each query result as DIR/<key>.json")
    p.add_argument("--from-json", type=Path, metavar="DIR", help="build from a saved folder; no org call")
    p.add_argument("--field-checks", action="store_true", help="add FIELDS(ALL) LIMIT 1 tabs per object")
    p.add_argument("--object-detail", action="store_true",
                   help="add every ObjectTerritory2Association row (can be very large)")
    p.add_argument("--extra-query", action="append", metavar="TAB=SOQL", default=[],
                   help="add your own query as a tab; repeatable")
    p.add_argument("--list-queries", action="store_true", help="print the queries and exit; no org call")
    a = p.parse_args(argv)
    if a.all_models and a.model:
        p.error("--model and --all-models cannot be combined")
    return a


def build_queries(model_id: str | None, object_detail: bool, field_checks: bool,
                  extra: list[str]) -> list[tuple[str, str, str, bool]]:
    """[(tab, key, soql, vertical)] with the model filter filled in."""
    where_model = f" WHERE Territory2ModelId = {tc.soql_literal(model_id)}" if model_id else ""
    where_tm = f" WHERE Territory2.Territory2ModelId = {tc.soql_literal(model_id)}" if model_id else ""
    base = list(QUERIES) + ([OBJECT_DETAIL] if object_detail else [])
    out = [(tab, key, q.format(where_model=where_model, where_territory_model=where_tm), False)
           for tab, key, q in base]
    if field_checks:
        for obj in FIELD_CHECK_OBJECTS:
            tab = f"F_{obj}"[:31]
            out.append((tab, tab, f"SELECT FIELDS(ALL) FROM {obj} LIMIT 1", True))
    for item in extra:
        if "=" not in item:
            raise tc.TerritoryError(f"--extra-query expects TAB=SOQL, got {item!r}")
        tab, soql = item.split("=", 1)
        tab = tab.strip()[:31]
        out.append((tab, tab, soql.strip(), False))
    return out


# ---------------------------------------------------------------- scoping

def scope(data: dict[str, list], model_id: str | None, root: str | None) -> dict[str, list]:
    """Filter the standard result sets to the model and (optionally) a subtree."""
    terr = data.get(tc.KEY_TERRITORIES, [])
    if model_id:
        terr = [t for t in terr if t.get("Territory2ModelId") in (None, model_id)]
    if root and terr:
        terr = [t for t, _ in tc.hierarchy(terr, root)]
    ids = {t["Id"] for t in terr}
    out = dict(data)
    out[tc.KEY_TERRITORIES] = terr
    if not model_id and not root:
        return out

    rule_terr = [r for r in data.get(tc.KEY_RULE_TERRITORIES, []) if r.get("Territory2Id") in ids]
    rules = data.get(tc.KEY_RULES, [])
    if model_id:
        rules = [r for r in rules if r.get("Territory2ModelId") in (None, model_id)]
    if root:
        attached = {r["RuleId"] for r in rule_terr}
        rules = [r for r in rules if r["Id"] in attached]
    rule_ids = {r["Id"] for r in rules}
    out[tc.KEY_RULE_TERRITORIES] = rule_terr
    out[tc.KEY_RULES] = rules
    out[tc.KEY_RULE_ITEMS] = [i for i in data.get(tc.KEY_RULE_ITEMS, []) if i.get("RuleId") in rule_ids]
    for key in (tc.KEY_USER_TERRITORIES, tc.KEY_OBJECT_COUNTS, tc.KEY_OBJECT_DETAIL):
        if key in data:
            out[key] = [r for r in data[key] if r.get("Territory2Id") in ids]
    return out


# ---------------------------------------------------------------- workbook

def write_rows(ws, records: list[dict], vertical: bool) -> int:
    from openpyxl.styles import Font
    rows = [tc.flatten(r) for r in records]
    if not rows:
        ws.append(["(no rows)"])
        return 0
    cols = list(dict.fromkeys(k for r in rows for k in r))
    if vertical:
        ws.append(["Field", "Value"])
        for c in cols:
            ws.append([c, tc.cell_value(rows[0].get(c))])
    else:
        ws.append(cols)
        for r in rows[:MAX_EXCEL_ROWS]:
            ws.append([tc.cell_value(r.get(c)) for c in cols])
    for cell in ws[1]:
        cell.font = Font(bold=True)
    ws.freeze_panes = "A2"
    return len(rows)


def write_hierarchy(ws, data: dict[str, list], root: str | None):
    from openpyxl.styles import Alignment, Font
    terr = data.get(tc.KEY_TERRITORIES, [])
    by_id = {t["Id"]: t for t in terr}
    users = Counter(u.get("Territory2Id") for u in data.get(tc.KEY_USER_TERRITORIES, []))
    objs = defaultdict(int)
    for r in data.get(tc.KEY_OBJECT_COUNTS, []):
        objs[r.get("Territory2Id")] += int(r.get("n") or r.get("expr0") or 0)
    rules = defaultdict(lambda: [0, 0])
    for r in data.get(tc.KEY_RULE_TERRITORIES, []):
        rules[r.get("Territory2Id")][1 if r.get("IsInherited") else 0] += 1

    head = ["Level", "Territory", "Developer Name", "Type", "Parent", "Account Access", "Opportunity Access",
            "Case Access", "Contact Access", "Users", "Rules (own)", "Rules (inherited)", "Records Assigned",
            "Path", "Territory Id"]
    ws.append(head)
    tc.style_header(ws)
    for t, lvl in tc.hierarchy(terr, root if root and terr else None):
        parent = by_id.get(t.get("ParentTerritory2Id"))
        ws.append([lvl, t.get("Name"), t.get("DeveloperName"), tc.nested(t, "Territory2Type.MasterLabel"),
                   parent.get("Name") if parent else "",
                   tc.ACCOUNT_ACCESS.get(t.get("AccountAccessLevel"), t.get("AccountAccessLevel") or ""),
                   tc.OTHER_ACCESS.get(t.get("OpportunityAccessLevel"), t.get("OpportunityAccessLevel") or ""),
                   tc.OTHER_ACCESS.get(t.get("CaseAccessLevel"), t.get("CaseAccessLevel") or ""),
                   tc.OTHER_ACCESS.get(t.get("ContactAccessLevel"), t.get("ContactAccessLevel") or ""),
                   users[t["Id"]], rules[t["Id"]][0], rules[t["Id"]][1], objs[t["Id"]],
                   tc.path_of(t, by_id), t["Id"]])
        ws.cell(ws.max_row, 2).alignment = Alignment(indent=min(lvl * 2, 15))
        if lvl == 0:
            ws.cell(ws.max_row, 2).font = Font(bold=True)
    tc.set_widths(ws, [7, 40, 36, 16, 30, 12, 12, 12, 12, 8, 8, 8, 10, 70, 20])
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = ws.dimensions


def export(args) -> Path:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    def fetch(key: str, soql: str) -> dict:
        if args.from_json:
            payload = tc.load_payload(args.from_json, key, required=False)
            if payload is None:
                raise tc.TerritoryError(f"{key}.json not in {args.from_json}")
            return payload
        payload = tc.run_query(args.target_org, soql)
        if args.save_json:
            tc.save_payload(args.save_json, key, payload)
        return payload

    results: dict[str, tuple[list, str]] = {}   # key -> (records, status)

    # 1. models first: the other queries need the model Id.
    models_tab, models_key, models_soql = QUERIES[0]
    models_payload = fetch(models_key, models_soql)
    models = tc.records_of(models_payload)
    model = None if args.all_models else tc.choose_model(models, args.model)
    model_id = model["Id"] if model else None
    print(f"Model: {model['Name']} ({model['DeveloperName']}, {model['State']})" if model else "Model: all")

    plan = build_queries(model_id, args.object_detail, args.field_checks, args.extra_query)
    results[models_key] = (models, tc.truncation_note(models_payload) or "OK")
    for tab, key, soql, _ in plan[1:]:
        print(f"{tab} ...", end=" ", flush=True)
        try:
            payload = fetch(key, soql)
            results[key] = (tc.records_of(payload), tc.truncation_note(payload) or "OK")
        except Exception as e:  # keep going: one failed query should not lose the others
            results[key] = ([], f"ERROR: {e}")
        print(results[key][1])

    data = scope({k: v[0] for k, v in results.items()}, model_id, args.root_territory)

    wb = Workbook()
    index = wb.active
    index.title = "Index"
    index.append(["Tab", "Rows", "Status", "Query"])
    info = wb.create_sheet("Run Info")
    for k, v in [("Org", args.target_org or ("(from JSON) " + str(args.from_json) if args.from_json else "(sf default)")),
                 ("Model", f"{model['Name']} ({model['DeveloperName']})" if model else "all models"),
                 ("Root territory", args.root_territory or "(whole model)"),
                 ("Built (UTC)", dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")),
                 ("Mode", "read-only")]:
        info.append([k, v])
    info.column_dimensions["A"].width = 18
    info.column_dimensions["B"].width = 70

    write_hierarchy(wb.create_sheet("Hierarchy"), data, args.root_territory)
    index.append(["Hierarchy", len(data.get(tc.KEY_TERRITORIES, [])), "computed", "from 2_Territories"])

    for tab, key, soql, vertical in plan:
        ws = wb.create_sheet(tab)
        records, status = results[key]
        if status.startswith("ERROR"):
            ws.append([status])
            n = 0
        else:
            n = write_rows(ws, data.get(key, records), vertical)
            if n > MAX_EXCEL_ROWS:
                status = f"CUT: {n} rows, Excel shows {MAX_EXCEL_ROWS}"
        index.append([tab, n, status, soql])
    for cell in index[1]:
        cell.font = Font(bold=True)
    tc.set_widths(index, [24, 9, 40, 120])

    out = args.output or Path(f"territory_export_{dt.date.today():%Y%m%d}.xlsx")
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    errors = [r for r in index.iter_rows(min_row=2, values_only=True) if str(r[2]).startswith("ERROR")]
    print(f"\nSaved: {out.resolve()}" + (f"  ({len(errors)} queries failed; see Index)" if errors else ""))
    return out


def main(argv=None) -> int:
    args = parse_args(argv)
    try:
        if args.list_queries:
            for tab, _, soql, _ in build_queries("<model Id>" if not args.all_models else None,
                                                 args.object_detail, args.field_checks, args.extra_query):
                print(f"{tab}: {soql}")
            return 0
        export(args)
    except tc.TerritoryError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
