"""Write the synthetic sample snapshots (samples) and the extension icons.

Run from anywhere:  python tests/make_samples.py
Everything here is made up. No org data.
"""
import json
import struct
import zlib
from pathlib import Path

EXT = Path(__file__).resolve().parent.parent

ORG = {"id": "00D000000000001EAA", "name": "Example Corp (sample)", "isSandbox": True,
       "instance": "CS0", "edition": "Enterprise Edition", "host": "example--dev.sandbox.my.salesforce.com"}
FLAGS = ["Read", "Create", "Edit", "Delete", "ViewAllFields", "ViewAllRecords", "ModifyAllRecords"]


def obj(*on):
    return {n: n in on for n in FLAGS}


def comp(name, label, licence="Salesforce", muting=False):
    return {"id": "0PS" + name[:12].ljust(12, "0"), "name": name, "label": label,
            "type": "Muting" if muting else "Regular", "isMuting": muting, "licence": licence, "description": None}


def snap(dev, label, desc, comps, muting, assigned, user, objs, fields, setup, tabs):
    return {
        "schema": "sf-psg-snapshot/2",
        "takenAt": "2026-11-18T15:00:00.000Z",
        "org": ORG,
        "psg": {"id": "0PG00000000000" + dev[:4].upper(), "developerName": dev, "label": label,
                "description": desc, "status": "Updated", "aggregatePermissionSetId": "0PS00000000000" + dev[:4].upper()},
        "components": comps,
        "muting": muting,
        "assignments": assigned,
        "userPermissions": user,
        "objectPermissions": objs,
        "fieldPermissions": fields,
        "setupAccess": {f"{t}|{n}": {"type": t, "typeLabel": tl, "name": n, "label": lab} for t, tl, n, lab in setup},
        "tabSettings": tabs,
        "objectLabels": {o: OBJECT_LABELS[o] for o in objs if o in OBJECT_LABELS},
        "fieldLabels": {f: FIELD_LABELS[f] for f in fields if f in FIELD_LABELS},
        "warnings": [],
    }


OBJECT_LABELS = {"Widget__c": "Widget", "Quota__c": "Sales Quota"}
FIELD_LABELS = {
    "Account.AnnualRevenue": "Annual Revenue", "Account.Rating": "Account Rating", "Account.Industry": "Industry",
    "Widget__c.Color__c": "Shade", "Widget__c.Size__c": "Dimensions", "Quota__c.Target__c": "Quota Target",
}

COMMON_USER = {
    "PermissionsApiEnabled": "API Enabled",
    "PermissionsRunReports": "Run Reports",
    "PermissionsEditTask": "Edit Tasks",
    "PermissionsEditEvent": "Edit Events",
    "PermissionsChatterInternalUser": "Chatter Internal User",
    "PermissionsLightningExperienceUser": "Lightning Experience User",
}
COMMON_FIELDS = {
    "Account.Industry": {"Read": True, "Edit": True},
    "Account.AnnualRevenue": {"Read": True, "Edit": False},
    "Account.Rating": {"Read": True, "Edit": True},
    "Contact.Email": {"Read": True, "Edit": True},
    "Contact.Phone": {"Read": True, "Edit": True},
    "Opportunity.Amount": {"Read": True, "Edit": True},
    "Opportunity.Probability": {"Read": True, "Edit": False},
    "Widget__c.Color__c": {"Read": True, "Edit": True},
    "Widget__c.Size__c": {"Read": True, "Edit": False},
}

REP = snap(
    "Sales_Rep", "Sales Rep", "Day-to-day access for field sales reps.",
    [comp("Sales_Core", "Sales Core"), comp("Report_Runner", "Report Runner"), comp("Widget_User", "Widget User"),
     comp("Sales_Rep_Muting", "Sales Rep Muting", None, True)],
    {"id": "0PS000000000MUTE", "sobject": "PermissionSet", "name": "Sales_Rep_Muting", "label": "Sales Rep Muting",
     "userPermissions": {"PermissionsExportReport": "Export Reports", "PermissionsManageUsers": "Manage Users"},
     "objectPermissions": {"Opportunity": obj("Delete")},
     "fieldPermissions": {"Account.AnnualRevenue": {"Read": False, "Edit": True}},
     "tabSettings": {"standard-Forecasting3": "DefaultOn"},
     # What the muting set really takes away. ManageUsers is muted but no component gives it.
     "effective": {"userPermissions": {"PermissionsExportReport": "Export Reports"},
                   "objectPermissions": {"Opportunity": obj("Delete")},
                   "fieldPermissions": {"Account.AnnualRevenue": {"Read": False, "Edit": True}},
                   "tabSettings": {"standard-Forecasting3": "DefaultOn"},
                   "setupAccess": {}, "nothingToTake": 1}},
    {"total": 412, "active": 398},
    dict(COMMON_USER),
    {"Account": obj("Read", "Create", "Edit"), "Contact": obj("Read", "Create", "Edit"),
     "Opportunity": obj("Read", "Create", "Edit"), "Widget__c": obj("Read", "Create", "Edit"),
     "Campaign": obj("Read")},
    {**COMMON_FIELDS, "Campaign.BudgetedCost": {"Read": True, "Edit": False}},
    [("ApexClass", "Apex class", "QuoteController", None), ("ApexPage", "Visualforce page", "QuotePdf", None),
     ("TabSet", "App", "standard__Sales", "Sales"),
     ("CustomPermission", "Custom permission", "Can_Submit_Quote", "Can Submit Quote")],
    {"standard-Account": "DefaultOn", "standard-Contact": "DefaultOn", "standard-Opportunity": "DefaultOn",
     "Widget__c": "DefaultOff", "standard-Campaign": "DefaultOff"},
)

MGR = snap(
    "Sales_Manager", "Sales Manager", "Sales reps plus team oversight and forecasting.",
    [comp("Sales_Core", "Sales Core"), comp("Report_Runner", "Report Runner"), comp("Widget_User", "Widget User"),
     comp("Team_Oversight", "Team Oversight"), comp("Forecast_Manager", "Forecast Manager"),
     comp("Data_Steward", "Data Steward")],
    None,
    {"total": 37, "active": 35},
    {**COMMON_USER, "PermissionsExportReport": "Export Reports", "PermissionsViewAllData": "View All Data",
     "PermissionsManageDashboards": "Manage Dashboards in Public Folders",
     "PermissionsTransferAnyEntity": "Transfer Record", "PermissionsViewSetup": "View Setup and Configuration"},
    {"Account": obj("Read", "Create", "Edit", "Delete", "ViewAllRecords"),
     "Contact": obj("Read", "Create", "Edit", "Delete"),
     "Opportunity": obj("Read", "Create", "Edit", "Delete", "ViewAllRecords", "ModifyAllRecords"),
     "Widget__c": obj("Read", "Create", "Edit"), "ForecastingItem": obj("Read"),
     "Quota__c": obj("Read", "Create", "Edit", "Delete")},
    {**COMMON_FIELDS, "Account.AnnualRevenue": {"Read": True, "Edit": True},
     "Opportunity.Probability": {"Read": True, "Edit": True},
     "Quota__c.Target__c": {"Read": True, "Edit": True}, "Quota__c.Period__c": {"Read": True, "Edit": True},
     "Widget__c.Size__c": {"Read": True, "Edit": True}},
    [("ApexClass", "Apex class", "QuoteController", None), ("ApexClass", "Apex class", "TeamReassignService", None),
     ("ApexPage", "Visualforce page", "QuotePdf", None), ("TabSet", "App", "standard__Sales", "Sales"),
     ("TabSet", "App", "Forecasting_Console", "Forecasting Console"),
     ("CustomPermission", "Custom permission", "Can_Submit_Quote", "Can Submit Quote"),
     ("CustomPermission", "Custom permission", "Approve_Discounts", "Approve Discounts")],
    {"standard-Account": "DefaultOn", "standard-Contact": "DefaultOn", "standard-Opportunity": "DefaultOn",
     "Widget__c": "DefaultOn", "standard-Forecasting3": "DefaultOn", "Quota__c": "DefaultOn"},
)


def png(size):
    """Two overlapping squares: A blue, B orange."""
    a, b, both, bg = (31, 111, 235, 255), (230, 126, 34, 255), (20, 40, 80, 255), (0, 0, 0, 0)
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            in_a = 0.08 * size <= x < 0.62 * size and 0.08 * size <= y < 0.62 * size
            in_b = 0.38 * size <= x < 0.92 * size and 0.38 * size <= y < 0.92 * size
            raw += bytes(both if in_a and in_b else b if in_b else a if in_a else bg)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    (EXT / "samples").mkdir(exist_ok=True)
    (EXT / "samples/sample_a.json").write_text(json.dumps(REP, indent=2) + "\n", encoding="utf-8")
    (EXT / "samples/sample_b.json").write_text(json.dumps(MGR, indent=2) + "\n", encoding="utf-8")
    (EXT / "icons").mkdir(exist_ok=True)
    for n in (16, 48, 128):
        (EXT / f"icons/icon{n}.png").write_bytes(png(n))
    print(f"Wrote samples and icons under {EXT}")
