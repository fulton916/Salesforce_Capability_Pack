"""Build two small synthetic JSON folders, shaped like `sf data query --json` output.

org_a: the "current" org. org_b: a second org for --compare, with a few deliberate differences.
All names and IDs are invented.

    python tests/fixtures/build_fixtures.py <out-dir>      -> <out-dir>/org_a, <out-dir>/org_b
"""
import copy
import json
import sys
from pathlib import Path


def payload(sobject, records):
    recs = [{"attributes": {"type": sobject}, **r} for r in records]
    return {"status": 0, "result": {"records": recs, "totalSize": len(recs), "done": True}}


def terr(id_, name, dev, parent, typ, acc, opp, case, model="MODEL-1"):
    return {"Id": id_, "Name": name, "DeveloperName": dev, "Territory2ModelId": model,
            "ParentTerritory2Id": parent, "Territory2TypeId": "TYPE-" + typ,
            "Territory2Type": {"attributes": {"type": "Territory2Type"}, "MasterLabel": typ},
            "AccountAccessLevel": acc, "OpportunityAccessLevel": opp, "CaseAccessLevel": case,
            "ContactAccessLevel": "Edit", "Description": None, "LastModifiedDate": "2026-01-15T10:00:00.000+0000",
            "LastModifiedBy": {"attributes": {"type": "User"}, "Name": "Admin User"}}


def rule(id_, dev, label, bf, model="MODEL-1"):
    return {"Id": id_, "DeveloperName": dev, "MasterLabel": label, "Territory2ModelId": model,
            "ObjectType": "Account", "IsActive": True, "BooleanFilter": bf,
            "LastModifiedDate": "2026-01-15T10:00:00.000+0000",
            "LastModifiedBy": {"attributes": {"type": "User"}, "Name": "Admin User"}}


def item(id_, rule_id, n, field, op, value):
    return {"Id": id_, "RuleId": rule_id, "SortOrder": n, "Field": field, "Operation": op, "Value": value,
            "LastModifiedDate": "2026-01-16T10:00:00.000+0000",
            "LastModifiedBy": {"attributes": {"type": "User"}, "Name": "Admin User"}}


def user_assignment(id_, user, name, terr_id, role=None):
    return {"Id": id_, "UserId": user, "Territory2Id": terr_id, "RoleInTerritory2": role, "IsActive": True,
            "LastModifiedDate": "2026-01-17T10:00:00.000+0000",
            "User": {"attributes": {"type": "User"}, "Name": name, "Username": f"{name.lower().replace(' ', '.')}@example.com",
                     "IsActive": True, "Profile": {"attributes": {"type": "Profile"}, "Name": "Standard User"}}}


def org_a():
    return {
        "models": [
            {"Id": "MODEL-1", "Name": "Sales Model", "DeveloperName": "Sales_Model", "State": "Active",
             "LastModifiedDate": "2026-01-01T00:00:00.000+0000"},
            {"Id": "MODEL-2", "Name": "Planning Model", "DeveloperName": "Planning_Model", "State": "Planning",
             "LastModifiedDate": "2026-01-01T00:00:00.000+0000"},
        ],
        "territories": [
            terr("T-0", "All Regions", "All_Regions", None, "Global", "Read", "Read", "Read"),
            terr("T-1", "North", "North", "T-0", "Region", "Edit", "Edit", "Edit"),
            terr("T-11", "Northeast", "Northeast", "T-1", "District", "Edit", "Edit", "Edit"),
            terr("T-111", "Northeast Retail", "Northeast_Retail", "T-11", "Sales", "Edit", "Edit", "Edit"),
            terr("T-12", "Northwest", "Northwest", "T-1", "District", "Edit", "Edit", "Edit"),
            terr("T-13", "Strategic Accounts North", "Strategic_Accounts_North", "T-1", "Strategic", "Read", "Read", "Read"),
            terr("T-2", "South", "South", "T-0", "Region", "Edit", "Edit", "Edit"),
            terr("T-21", "Southwest", "Southwest", "T-2", "District", "Read", "Read", "Edit"),
            terr("T-211", "Southwest", "Southwest_Child_1", "T-21", "Sales", "Read", "Read", "Edit"),
            terr("T-22", "Southeast", "Southeast", "T-2", "District", "Read", "Read", "Edit"),
            terr("T-9", "Planning Top", "Planning_Top", None, "Global", "Read", "Read", "Read", model="MODEL-2"),
        ],
        "rules": [
            rule("R-1", "Northeast_Rule", "Northeast Rule", "1 AND (2 OR 3)"),
            rule("R-2", "Northwest_Rule", "Northwest Rule", None),
            rule("R-3", "South_Rule", "South Rule", None),
            rule("R-4", "Unused_Rule", "Unused Rule", None),
            rule("R-9", "Planning_Rule", "Planning Rule", None, model="MODEL-2"),
        ],
        "rule_items": [
            item("I-1", "R-1", 1, "Account.Region__c", "equals", "NE"),
            item("I-2", "R-1", 2, "Account.Sales_Code__c", "contains", "R12"),
            item("I-3", "R-1", 3, "Account.Alt_Code__c", "equals", "R12,R13"),
            item("I-4", "R-2", 1, "Account.Sales_Code__c", "equals", "C1,C2"),
            item("I-5", "R-2", 2, "Account.Alt_Code__c", "equals", "C1"),
            item("I-6", "R-3", 1, "Account.Region__c", "equals", "SW,SE"),
            item("I-7", "R-4", 1, "Account.Sales_Code__c", "startsWith", "X"),
            item("I-9", "R-9", 1, "Account.Sales_Code__c", "equals", "P1"),
        ],
        "rule_territories": [
            {"Id": "A-1", "RuleId": "R-1", "Territory2Id": "T-11", "IsInherited": False},
            {"Id": "A-2", "RuleId": "R-2", "Territory2Id": "T-12", "IsInherited": False},
            {"Id": "A-3", "RuleId": "R-3", "Territory2Id": "T-2", "IsInherited": False},
            {"Id": "A-4", "RuleId": "R-3", "Territory2Id": "T-21", "IsInherited": True},
            {"Id": "A-9", "RuleId": "R-9", "Territory2Id": "T-9", "IsInherited": False},
        ],
        "user_territories": [
            user_assignment("U-1", "USER-1", "Alex Example", "T-11"),
            user_assignment("U-2", "USER-2", "Blair Example", "T-11", role="Owner"),
            user_assignment("U-3", "USER-3", "Casey Example", "T-2"),
            user_assignment("U-4", "USER-4", "Drew Example", "T-0"),
            user_assignment("U-9", "USER-9", "Eli Example", "T-9"),
        ],
        "object_territory_counts": [
            {"Territory2Id": "T-0", "SobjectType": "Account", "n": 100},
            {"Territory2Id": "T-11", "SobjectType": "Account", "n": 20},
            {"Territory2Id": "T-11", "SobjectType": "Opportunity", "n": 5},
            {"Territory2Id": "T-12", "SobjectType": "Account", "n": 7},
            {"Territory2Id": "T-9", "SobjectType": "Account", "n": 3},
        ],
    }


def org_b():
    """Second org: Strategic Accounts North missing, Northwest access differs, North Central added, operators/values differ."""
    d = copy.deepcopy(org_a())
    d["territories"] = [t for t in d["territories"] if t["Id"] != "T-13"]
    for t in d["territories"]:
        if t["Id"] == "T-12":
            t["AccountAccessLevel"] = t["OpportunityAccessLevel"] = t["CaseAccessLevel"] = "Read"
    d["territories"].append(terr("T-14", "North Central", "North_Central", "T-1", "District", "Edit", "Edit", "Edit"))
    for i in d["rule_items"]:
        if i["Id"] == "I-2":
            i["Operation"] = "equals"
        if i["Id"] == "I-4":
            i["Value"] = "C1,C3"
    return d


SOBJECT = {"models": "Territory2Model", "territories": "Territory2", "rules": "ObjectTerritory2AssignmentRule",
           "rule_items": "ObjectTerritory2AssignmentRuleItem", "rule_territories": "RuleTerritory2Association",
           "user_territories": "UserTerritory2Association", "object_territory_counts": "AggregateResult"}


def write(folder: Path, data: dict):
    folder.mkdir(parents=True, exist_ok=True)
    for key, recs in data.items():
        (folder / f"{key}.json").write_text(json.dumps(payload(SOBJECT[key], recs), indent=1), encoding="utf-8")


def build(out: Path) -> tuple[Path, Path]:
    write(out / "org_a", org_a())
    write(out / "org_b", org_b())
    return out / "org_a", out / "org_b"


if __name__ == "__main__":
    a, b = build(Path(sys.argv[1] if len(sys.argv) > 1 else "."))
    print(f"wrote {a} and {b}")
