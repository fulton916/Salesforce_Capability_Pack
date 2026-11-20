// Offline tests for the "Where is it used in flows?" page. Called from run_tests.mjs with its shared `test` function.
// Synthetic data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SfApi } from "../shared/sfconn.js";
import { parseUrlContext, contextQuery, contextFromParams, pickByDeveloperName } from "../shared/urlcontext.js";
import {
  scanFlow, recordElements, elementsOf, idForms, looksLikeId, plainFlowType, buildResults, summaryLine, csvRows, csvText, csvFileName,
  hitText, versionWords, flowKey, startInfo, nameWithApi, uniqueSteps, stepLineText,
} from "../tools/flow-usage/flow-usage-scan.js";
import {
  groupOf, whenWords, compareRunOrder, runBand, runOrderWords, RUN_ORDER_RULE, noOrderBlockText, metaWords, entryConditions, pathWords, scheduleWords, buildObjectView, objectSummary, objectCsvRows, objectCsvText,
  objectCsvFileName, kindWords, OBJECT_CSV_HEADER,
} from "../tools/flow-usage/flow-usage-object.js";
import { readFlowList, versionsToRead, readFlowVersion, readVersions, whyUnreadable, resolveContext } from "../tools/flow-usage/flow-usage-read.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = (...p) => path.join(here, "..", ...p);
const text = (...p) => readFileSync(ext(...p), "utf-8");
const sample = () => JSON.parse(text("samples", "flow_usage.json"));

// ---------- helpers ----------

const flt = (field, ref, s) => ({ field, operator: "EqualTo", value: ref ? { elementReference: ref } : { stringValue: s } });
const cond = (left, s) => ({ leftValueReference: left, operator: "EqualTo", rightValue: { stringValue: s } });
const decision = (name, conds) => ({ name, label: name, rules: [{ name: `${name}_r`, label: `${name} rule`, conditions: conds }] });
const T = (field, object = "Account") => ({ kind: "field", object, field });

/** A fake describe: Contact.Account -> Account, Account.Parent -> Account, Account.Owner -> User, Case.Owner -> User or Group. */
const DESCRIBES = {
  Account: { fields: [{ name: "Status__c" }, { name: "ParentId", relationshipName: "Parent", referenceTo: ["Account"] }, { name: "OwnerId", relationshipName: "Owner", referenceTo: ["User"] }],
    childRelationships: [{ relationshipName: "Contacts", childSObject: "Contact" }, { relationshipName: "Cases", childSObject: "Case" }] },
  Contact: { fields: [{ name: "Status__c" }, { name: "AccountId", relationshipName: "Account", referenceTo: ["Account"] }] },
  Case: { fields: [{ name: "AccountId", relationshipName: "Account", referenceTo: ["Account"] }, { name: "OwnerId", relationshipName: "Owner", referenceTo: ["User", "Group"] }] },
  User: { fields: [{ name: "Status__c" }] },
};
const describe = async (o) => DESCRIBES[o] || null;

const scan = (meta, target, d = describe) => scanFlow(meta, target, { describe: d });
const where = (hits) => hits.map((h) => `${h.kind}|${h.element}|${h.action}|${h.field}`);

/** Fake REST API: GET only; `routes` are [regex on the query, handler]. Counts calls, and the most in flight at once. */
function fakeApi(routes, log = []) {
  let inFlight = 0;
  log.maxInFlight = 0;
  const fetchImpl = async (url, opts = {}) => {
    inFlight++;
    log.maxInFlight = Math.max(log.maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    const u = new URL(url);
    const q = u.searchParams.get("q");
    log.push({ method: opts.method || "GET", tooling: /\/tooling\//.test(u.pathname), q, path: u.pathname });
    if (/\/sobjects\/$/.test(u.pathname)) return { ok: true, status: 200, text: async () => JSON.stringify({ sobjects: (routes.objects || []).map((name) => ({ name })) }) };
    const m = u.pathname.match(/\/sobjects\/(\w+)\/describe\/$/);
    if (m) return { ok: true, status: 200, text: async () => JSON.stringify(DESCRIBES[m[1]] || { fields: [] }) };
    const route = routes.find?.(([re]) => re.test(q));
    if (!route) return { ok: false, status: 400, text: async () => JSON.stringify([{ message: `no route for ${q}`, errorCode: "TEST" }]) };
    const r = route[1](q);
    if (r && r.fail) return { ok: false, status: 400, text: async () => JSON.stringify([{ message: r.fail, errorCode: r.code || "TEST" }]) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ done: true, totalSize: r.length, records: r }) };
  };
  return new SfApi({ apiHost: "test.example.com", sessionId: "sid", fetchImpl });
}

export async function run(test) {
  // ---------- the address of the page ----------

  await test("flow urlcontext: Setup field page gives object and field (API names and Ids)", () => {
    const b = "https://acme.lightning.force.com";
    assert.deepEqual(parseUrlContext(`${b}/lightning/setup/ObjectManager/Account/FieldsAndRelationships/Status__c/view`), { object: "Account", field: "Status__c" });
    assert.deepEqual(parseUrlContext(`${b}/lightning/setup/ObjectManager/Widget__c/FieldsAndRelationships/00N000000000001AAA/view`), { object: "Widget__c", field: "00N000000000001AAA" });
    assert.deepEqual(parseUrlContext(`${b}/lightning/setup/ObjectManager/01I000000000001AAA/FieldsAndRelationships/00N000000000001/edit`), { object: "01I000000000001AAA", field: "00N000000000001" });
    assert.deepEqual(parseUrlContext(`${b}/lightning/setup/ObjectManager/ns__Thing__c/FieldsAndRelationships/ns__Size__c/view?x=1#top`), { object: "ns__Thing__c", field: "ns__Size__c" });
  });

  await test("flow urlcontext: object pages, record pages and list views give the object only", () => {
    const b = "https://acme.lightning.force.com";
    assert.deepEqual(parseUrlContext(`${b}/lightning/setup/ObjectManager/Account/FieldsAndRelationships/view`), { object: "Account", field: "" });
    assert.deepEqual(parseUrlContext(`${b}/lightning/setup/ObjectManager/Account/Details/view`), { object: "Account", field: "" });
    assert.deepEqual(parseUrlContext(`${b}/lightning/setup/ObjectManager/01I000000000001AAA/Details/view`), { object: "01I000000000001AAA", field: "" });
    assert.deepEqual(parseUrlContext(`${b}/lightning/r/Account/001000000000001AAA/view`), { object: "Account", field: "" });
    assert.deepEqual(parseUrlContext(`${b}/lightning/r/Widget__c/a00000000000001/related/Things__r/view`), { object: "Widget__c", field: "" });
    assert.deepEqual(parseUrlContext(`${b}/lightning/o/Contact/list?filterName=Recent`), { object: "Contact", field: "" });
    assert.deepEqual(parseUrlContext(`${b}/lightning/o/Contact/home`), { object: "Contact", field: "" });
  });

  await test("flow urlcontext: junk, other pages and odd input give null; the page address is never passed on", () => {
    for (const u of [undefined, null, "", "not a url", "https://x.example.com/", "https://x.example.com/lightning/page/home",
      "https://x.example.com/lightning/setup/ObjectManager/home", "https://x.example.com/lightning/setup/Users/home",
      "https://x.example.com/lightning/r/Account/not-an-id/view", "https://x.example.com/lightning/o/%E0%A4%A/list",
      "https://x.example.com/lightning/o/Bad Name!/list", "javascript:alert(1)"]) {
      assert.equal(parseUrlContext(u), null, String(u));
    }
    assert.equal(contextQuery(null), "");
    assert.equal(contextQuery({ object: "", field: "" }), "");
    assert.equal(contextQuery({ object: "Account", field: "" }), "object=Account");
    assert.equal(contextQuery({ object: "Account", field: "Status__c" }), "object=Account&field=Status__c");
    const p = new URLSearchParams("object=Account&field=Status__c&host=x");
    assert.deepEqual(contextFromParams(p), { object: "Account", field: "Status__c" });
    assert.deepEqual(contextFromParams(new URLSearchParams("object=<script>&field=a b")), { object: "", field: "" });
    assert.deepEqual(contextFromParams(new URLSearchParams("")), { object: "", field: "" });
  });

  await test("flow urlcontext: custom names are settled against the names the org has", () => {
    assert.equal(pickByDeveloperName(["Name", "Size__c", "Size__pc"], "", "Size"), "Size__c");
    assert.equal(pickByDeveloperName(["Name", "ns__Size__c"], "ns", "Size"), "ns__Size__c");
    assert.equal(pickByDeveloperName(["Name", "Thing__mdt", "Other__mdt"], "", "Thing"), "Thing__mdt");
    assert.equal(pickByDeveloperName(["Size__b", "Size__x"], "", "Size"), ""); // two fit, so none
    assert.equal(pickByDeveloperName(["Name"], "", "Size"), "");
  });

  // ---------- Ids ----------

  await test("flow ids: 15 and 18 character forms, and what looks like an Id", () => {
    assert.deepEqual(idForms("001000000000001"), ["001000000000001", "001000000000001AAA"]);
    assert.deepEqual(idForms("00100000000000A"), ["00100000000000A", "00100000000000AAAQ"]);
    assert.deepEqual(idForms("001000000000001AAA"), ["001000000000001AAA", "001000000000001"]);
    assert.deepEqual(idForms("hello"), ["hello"]);
    assert.ok(looksLikeId("001000000000001") && looksLikeId("a0B000000000001AAA"));
    assert.ok(!looksLikeId("Account_Status__c") && !looksLikeId("abcdefghijklmno") && !looksLikeId("") && !looksLikeId("00100000000000"));
  });

  // ---------- which object a name stands for ----------

  await test("flow scan: $Record and $Record__Prior stand for the start object; a different object is not a hit", async () => {
    const meta = {
      start: { object: "Account", triggerType: "RecordAfterSave", recordTriggerType: "Update" },
      decisions: [decision("D", [cond("$Record.Status__c", "x"), cond("$Record__Prior.status__C", "y")])],
    };
    const r = await scan(meta, T("Status__c"));
    assert.equal(r.hits.length, 1); // one step, one field: the two ways of writing it are kept together
    assert.deepEqual(r.hits[0].refs, ["$Record.Status__c", "$Record__Prior.status__C"]);
    assert.ok(r.hits.every((h) => h.confidence === "sure" && h.action === "checks" && h.kind === "Decision"));
    const other = await scan(meta, T("Status__c", "Contact")); // same field name on another object
    assert.equal(other.hits.length + other.possible.length, 0);
  });

  await test("flow scan: SObject variables, Process Builder current/old, and typed Get Records output", async () => {
    const meta = {
      variables: [{ name: "acct", dataType: "SObject", objectType: "Account" }, { name: "myVariable_current", dataType: "SObject", objectType: "Account" },
        { name: "myVariable_old", dataType: "SObject", objectType: "Account" }, { name: "con", dataType: "SObject", objectType: "Contact" }],
      recordLookups: [{ name: "Get_Acc", label: "Get Acc", object: "Account", storeOutputAutomatically: true }],
      formulas: [{ name: "f", expression: "{!myVariable_current.Status__c} <> {!myVariable_old.Status__c}" }],
      textTemplates: [{ name: "t", text: "{!Get_Acc.Status__c} and {!con.Status__c}" }],
      assignments: [{ name: "A", label: "A", assignmentItems: [{ assignToReference: "acct.Status__c", operator: "Assign", value: { stringValue: "x" } }] }],
    };
    const r = await scan(meta, T("Status__c"));
    assert.deepEqual(where(r.hits).sort(), [
      "Assignment|A|sets|Status__c", "Formula|f|uses|Status__c", "Text template|t|uses|Status__c",
    ].sort());
    assert.deepEqual(r.hits.find((h) => h.element === "f").refs, ["myVariable_current.Status__c", "myVariable_old.Status__c"]);
    const contact = await scan(meta, T("Status__c", "Contact"));
    assert.deepEqual(where(contact.hits), ["Text template|t|uses|Status__c"]);
  });

  await test("flow scan: loops (and filter steps) take the type of their collection; Get Records without automatic output is not a name", async () => {
    const meta = {
      recordLookups: [{ name: "Get_Cons", label: "Get", object: "Contact", storeOutputAutomatically: true }, { name: "Get_Manual", label: "Get", object: "Account", outputAssignments: [{ field: "Status__c", assignToReference: "v" }] }],
      loops: [{ name: "Loop_Cons", label: "Loop", collectionReference: "Get_Cons" }],
      collectionProcessors: [{ name: "Filter_Cons", label: "Filter", collectionReference: "Get_Cons", assignNextValueToReference: "currentItem_Filter", conditions: [cond("currentItem_Filter.Status__c", "x")] }],
      textTemplates: [{ name: "t", text: "{!Loop_Cons.Status__c}" }, { name: "u", text: "{!Get_Manual.Status__c}" }],
    };
    const contact = await scan(meta, T("Status__c", "Contact"));
    assert.deepEqual(where(contact.hits).sort(), ["Collection step|Filter_Cons|checks|Status__c", "Text template|t|uses|Status__c"]);
    const account = await scan(meta, T("Status__c", "Account"));
    // The manual lookup names the field in its output list (sure); it has no variable of its own, so "Get_Manual.Status__c" is not a record
    assert.deepEqual(where(account.hits), ["Get Records|Get_Manual|uses|Status__c"]);
    assert.equal(account.possible.length, 0);
  });

  await test("flow scan: relationship paths are followed with describe; polymorphic or unfollowable paths are possible", async () => {
    const meta = {
      start: { object: "Contact" },
      textTemplates: [
        { name: "a", text: "{!$Record.Account.Status__c}" }, // Contact -> Account: sure
        { name: "b", text: "{!$Record.Account.Parent.Status__c}" }, // two steps: sure
        { name: "c", text: "{!$Record.Status__c}" }, // Contact's own field: not Account
        { name: "d", text: "{!$Record.Mystery__r.Status__c}" }, // cannot be followed: possible
      ],
    };
    const r = await scan(meta, T("Status__c"));
    assert.deepEqual(where(r.hits).sort(), ["Text template|a|uses|Status__c", "Text template|b|uses|Status__c"]);
    assert.deepEqual(where(r.possible), ["Text template|d|uses|Status__c"]);
    assert.equal(r.hits[0].ref, "$Record.Account.Status__c");

    const caseMeta = { start: { object: "Case" }, textTemplates: [{ name: "o", text: "{!$Record.Owner.Status__c}" }] };
    const poly = await scan(caseMeta, T("Status__c", "User")); // Owner is a User or a Group
    assert.deepEqual(where(poly.possible), ["Text template|o|uses|Status__c"]);
    assert.equal(poly.hits.length, 0);
    const notPoly = await scan(caseMeta, T("Status__c", "Account")); // Owner is never an Account: no hit at all
    assert.equal(notPoly.hits.length + notPoly.possible.length, 0);

    // A polymorphic relationship pinned to one type ("Owner:User") is followed as that type.
    const pinned = { start: { object: "Case" }, textTemplates: [{ name: "p", text: "{!$Record.Owner:User.Status__c}" }, { name: "q", text: "{!$Record.Owner:Group.Status__c}" }] };
    assert.deepEqual(where((await scan(pinned, T("Status__c", "User"))).hits), ["Text template|p|uses|Status__c"]);
    assert.equal((await scan(pinned, T("Status__c", "Account"))).hits.length, 0);

    const noDescribe = await scan(meta, T("Status__c"), async () => { throw new Error("denied"); });
    assert.equal(noDescribe.hits.length, 0);
    assert.equal(noDescribe.possible.length, 4 - 1); // a, b and d cannot be followed; c is Contact's own field and stays out
  });

  await test("flow scan: names that cannot be tied to an object are possible; $Flow, $Label and plain names are not hits", async () => {
    const meta = {
      variables: [{ name: "anyRecord", dataType: "SObject" }, { name: "txt", dataType: "String" }],
      textTemplates: [{ name: "a", text: "{!anyRecord.Status__c} {!txt.Status__c} {!$Flow.Status__c} {!$Label.Status__c} {!mystery.Status__c}" }],
      screens: [{ name: "S", label: "S", fields: [{ name: "Input1", fieldType: "InputField", defaultValue: "{!Input1.Status__c}" }] }],
    };
    const r = await scan(meta, T("Status__c"));
    assert.equal(r.hits.length, 0);
    assert.deepEqual(r.possible.map((h) => h.refs.slice().sort()), [["anyRecord.Status__c", "mystery.Status__c"]]);
    // A flow with no start object: $Record cannot be tied to anything.
    const screenFlow = await scan({ textTemplates: [{ name: "a", text: "{!$Record.Status__c}" }] }, T("Status__c"));
    assert.equal(screenFlow.possible.length, 1);
  });

  await test("flow scan: $Setup, $User and bracketed list references", async () => {
    const meta = {
      start: { object: "Account", filterFormula: "{!$Setup.Bypass__c.Flag__c}" },
      variables: [{ name: "cons", dataType: "SObject", objectType: "Contact" }],
      textTemplates: [{ name: "t", text: "{!$User.Status__c} {!cons[0].Status__c} {!cons[$EachItem].Status__c}" }],
    };
    assert.equal((await scan(meta, T("Flag__c", "Bypass__c"))).hits[0].action, "checks");
    assert.equal((await scan(meta, T("Status__c", "User"))).hits.length, 1);
    assert.equal((await scan(meta, T("Status__c", "Contact"))).hits.length, 1); // [0] and [$EachItem] are the same place
    assert.equal((await scan(meta, T("Flag__c", "Other__c"))).hits.length, 0);
  });

  // ---------- each element kind ----------

  await test("flow scan: record elements - get, create, update, delete, start, choice set, transform, custom error", async () => {
    const meta = {
      start: { object: "Account", filters: [flt("Status__c", null, "A")], scheduledPaths: [{ name: "p", label: "Later", recordField: "Status__c" }] },
      recordLookups: [{ name: "G", label: "G", object: "Account", filters: [flt("Status__c", null, "x")], queriedFields: ["Name", "status__c"], sortField: "Status__c" }],
      recordCreates: [{ name: "C", label: "C", object: "Account", inputAssignments: [flt("Status__c", null, "x")] }],
      recordUpdates: [{ name: "U", label: "U", object: "Account", filters: [flt("Status__c", null, "x")], inputAssignments: [flt("Status__c", null, "y")] }],
      recordDeletes: [{ name: "X", label: "X", object: "Account", filters: [flt("Status__c", null, "gone")] }],
      dynamicChoiceSets: [{ name: "Ch", label: "Ch", object: "Account", displayField: "Status__c", valueField: "Id", filters: [flt("Status__c", null, "x")], picklistObject: "Contact", picklistField: "Status__c" }],
      transforms: [{ name: "Tr", label: "Tr", objectType: "Account", transformValues: [{ transformValueActions: [{ outputFieldApiName: "Status__c", value: { stringValue: "z" } }] }] }],
      customErrors: [{ name: "Ce", label: "Ce", customErrorMessages: [{ fieldSelection: "Status__c", errorMessage: "no" }] }],
    };
    const r = await scan(meta, T("Status__c"));
    const w = where(r.hits).map((x) => x.toLowerCase());
    for (const x of [
      "Start|Start|checks|Status__c", "Start|Start|uses|Status__c", "Get Records|G|checks|Status__c", "Get Records|G|uses|Status__c",
      "Create Records|C|sets|Status__c", "Update Records|U|checks|Status__c", "Update Records|U|sets|Status__c", "Delete Records|X|checks|Status__c",
      "Choice set|Ch|uses|Status__c", "Choice set|Ch|checks|Status__c", "Transform|Tr|sets|Status__c", "Custom error|Ce|uses|Status__c",
    ].map((x) => x.toLowerCase())) assert.ok(w.includes(x), `missing ${x} in ${w.join(", ")}`);
    // The choice set's picklist is on Contact, so it counts for Contact.Status__c, and only that one.
    const c = await scan(meta, T("Status__c", "Contact"));
    assert.deepEqual(where(c.hits), ["Choice set|Ch|uses|Status__c"]);
    // a record update that names an object nothing else uses
    assert.ok(r.hits.find((h) => h.element === "Start" && h.part === "Later"));
  });

  await test("flow scan: sets, checks and uses", async () => {
    const meta = {
      start: { object: "Account", filterFormula: "{!$Record.Status__c} = 'x'" },
      assignments: [{ name: "A", label: "A", assignmentItems: [{ assignToReference: "$Record.Status__c", operator: "Assign", value: { elementReference: "$Record.Name" } }] }],
      decisions: [decision("D", [cond("$Record.Status__c", "x")])],
      actionCalls: [{ name: "Act", label: "Act", actionType: "emailSimple", inputParameters: [{ name: "emailBody", value: { elementReference: "$Record.Status__c" } }] }],
      waits: [{ name: "W", label: "W", waitEvents: [{ name: "ev", label: "Event", conditions: [cond("$Record.Status__c", "x")] }] }],
      subflows: [{ name: "Sub", label: "Sub", flowName: "Other", inputAssignments: [{ name: "status", value: { elementReference: "$Record.Status__c" } }] }],
      screens: [{ name: "Scr", label: "Scr", fields: [{ name: "Ft", fieldText: "Now {!$Record.Status__c}" }] }],
      formulas: [{ name: "F", expression: "TEXT({!$Record.Status__c})" }],
      choices: [{ name: "Cho", choiceText: "{!$Record.Status__c}" }],
      loops: [{ name: "Lp", label: "Lp", collectionReference: "$Record.Status__c" }],
    };
    const r = await scan(meta, T("Status__c"));
    const get = (el) => r.hits.filter((h) => h.element === el).map((h) => h.action);
    assert.deepEqual(get("Start"), ["checks"]);
    assert.deepEqual(get("A"), ["sets"]);
    assert.deepEqual(get("D"), ["checks"]);
    assert.deepEqual(get("Act"), ["uses"]);
    assert.deepEqual(get("W"), ["checks"]);
    assert.deepEqual(get("Sub"), ["uses"]);
    assert.deepEqual(get("Scr"), ["uses"]);
    assert.deepEqual(get("F"), ["uses"]);
    assert.deepEqual(get("Cho"), ["uses"]);
    assert.equal(r.hits.find((h) => h.element === "Act").kind, "Send Email");
    assert.equal(r.hits.find((h) => h.element === "Scr").part, "Ft");
    assert.equal(r.hits.find((h) => h.element === "W").part, "Event");
    assert.equal(hitText(r.hits.find((h) => h.element === "A")), "Assignment 'A': sets Status__c");
  });

  await test("flow scan: Dynamic Forms fields on screens, whole-record saves, and a hit counted once", async () => {
    const meta = {
      variables: [{ name: "rec", dataType: "SObject", objectType: "Account" }],
      screens: [{ name: "S", label: "S", fields: [{ name: "Dyn", fieldType: "ObjectProvided", objectFieldReference: "rec.Status__c" }] }],
      recordUpdates: [{ name: "Save", label: "Save", inputReference: "rec" }],
      textTemplates: [{ name: "t", text: "{!rec.Status__c} {!rec.Status__c}" }],
    };
    const r = await scan(meta, T("Status__c"));
    assert.deepEqual(where(r.hits).sort(), ["Screen|S|uses|Status__c", "Text template|t|uses|Status__c"]);
    assert.deepEqual(r.wholeRecord.map((w) => w.element), ["Save"]);
    assert.equal((await scan(meta, T("Status__c", "Contact"))).wholeRecord.length, 0);
  });

  await test("flow scan: field and object names are not case sensitive; namespaces are kept", async () => {
    const meta = { start: { object: "ns__Thing__c" }, textTemplates: [{ name: "t", text: "{!$Record.NS__Size__C}" }, { name: "u", text: "{!$Record.Size__c}" }] };
    const r = await scan(meta, { kind: "field", object: "NS__THING__C", field: "ns__size__c" });
    assert.deepEqual(where(r.hits), ["Text template|t|uses|NS__Size__C"]);
  });

  // ---------- text and Id search ----------

  await test("flow scan: text search is not case sensitive, covers every string, and names the element", async () => {
    const meta = {
      description: "Created for the Gold Tier project",
      start: { object: "Account" },
      decisions: [decision("D", [cond("$Record.Type", "gold tier")])],
      screens: [{ name: "S", label: "S", fields: [{ name: "F", fieldText: "<p>GOLD TIER welcome</p>" }] }],
      textTemplates: [{ name: "Other", text: "silver" }],
    };
    const r = await scan(meta, { kind: "text", text: "Gold Tier" });
    assert.deepEqual(r.hits.map((h) => `${h.kind}|${h.element}`).sort(), ["Decision|D", "Flow settings|", "Screen|S"]);
    assert.ok(r.hits.every((h) => h.confidence === "sure"));
    assert.equal((await scan(meta, { kind: "text", text: "   " })).hits.length, 0);
  });

  await test("flow scan: a record Id is found in its 15 and 18 character forms", async () => {
    const meta = {
      decisions: [decision("Fifteen", [cond("$Record.AccountId", "001000000000001")]), decision("Eighteen", [cond("$Record.AccountId", "001000000000001AAA")])],
      textTemplates: [{ name: "Inside", text: "see /lightning/r/Account/001000000000001AAA/view" }, { name: "Other", text: "001000000000002" }],
    };
    for (const typed of ["001000000000001", "001000000000001AAA"]) {
      const r = await scan(meta, { kind: "text", text: typed });
      assert.deepEqual(r.hits.map((h) => h.element).sort(), ["Eighteen", "Fifteen", "Inside"], typed);
    }
  });

  await test("flow scan: record elements and the trigger are recorded for every flow, whatever was searched for", async () => {
    const meta = {
      start: { object: "Account", triggerType: "RecordAfterSave", recordTriggerType: "Update" },
      variables: [{ name: "v", dataType: "SObject", objectType: "Contact" }],
      recordLookups: [{ name: "G", label: "Get it", object: "Case" }],
      recordCreates: [{ name: "C", label: "Make it", inputReference: "v" }],
      recordUpdates: [{ name: "U", label: "Change it", object: "Account" }, { name: "U2", label: "Unknown", inputReference: "nobody" }],
      recordDeletes: [{ name: "X", label: "Remove it", object: "Opportunity" }],
    };
    const r = await scan(meta, T("Nothing__c"));
    assert.deepEqual(r.records.map((x) => `${x.element}:${x.op}:${x.object}:${x.objectKnown}`),
      ["G:get:Case:true", "C:create:Contact:true", "U:update:Account:true", "U2:update:null:false", "X:delete:Opportunity:true"]);
    assert.equal(r.records[0].kind, "Get Records");
    assert.deepEqual(r.trigger, { object: "Account", triggerType: "RecordAfterSave", recordTriggerType: "Update" });
    assert.deepEqual((await scan(meta, null)).records, recordElements(meta));
    assert.deepEqual((await scan(meta, { kind: "text", text: "zzz" })).trigger, r.trigger);
    assert.equal(elementsOf(meta)[0].kind, "Start");
    assert.deepEqual(await scan({}, T("X")), { hits: [], possible: [], wholeRecord: [], records: [], trigger: { object: null, triggerType: null, recordTriggerType: null } });
  });

  // ---------- results ----------

  const def = (o) => ({ id: "300000000000001AAA", apiName: "F", label: "F", processType: "AutoLaunchedFlow", triggerType: "", triggerObject: "", recordTriggerType: "", isActive: true, namespace: "", managed: false, ...o });

  await test("flow results: plain flow types", () => {
    assert.equal(plainFlowType(def({ triggerType: "RecordAfterSave", recordTriggerType: "CreateAndUpdate", triggerObject: "Account" })), "Runs after a record is created or updated (Account)");
    assert.equal(plainFlowType(def({ triggerType: "RecordBeforeSave", recordTriggerType: "Update" })), "Runs before a record is updated");
    assert.equal(plainFlowType(def({ triggerType: "RecordBeforeDelete" })), "Runs before a record is deleted");
    assert.equal(plainFlowType(def({ processType: "Flow" })), "Screen flow");
    assert.equal(plainFlowType(def({ triggerType: "Scheduled" })), "Scheduled");
    assert.equal(plainFlowType(def({ triggerType: "PlatformEvent" })), "Runs when a platform event arrives");
    assert.equal(plainFlowType(def({ processType: "Workflow" })), "Process Builder");
    assert.equal(plainFlowType(def({})), "Autolaunched flow (started by something else)");
    assert.equal(plainFlowType(def({ processType: "SomethingNew" })), "Something New");
  });

  await test("flow results: summary line, active count, sections, and the same flow counted once", () => {
    const hit = { kind: "Decision", label: "D", element: "D", action: "checks", field: "Status__c", ref: "$Record.Status__c", part: "" };
    const scans = [
      { def: def({ apiName: "B", label: "B flow", isActive: true }), versionKind: "active", hits: [hit], possible: [] },
      { def: def({ apiName: "A", label: "A flow", isActive: false }), versionKind: "latest", hits: [hit], possible: [hit] },
      { def: def({ apiName: "B", label: "B flow", isActive: true }), versionKind: "latest", hits: [hit], possible: [] }, // a draft of the same flow
      { def: def({ apiName: "C", label: "C flow" }), versionKind: "active", hits: [], possible: [hit] },
      { def: def({ apiName: "E", label: "E flow" }), versionKind: "active", error: { plain: "x", raw: "y" } },
      { def: def({ apiName: "N", label: "N flow" }), versionKind: "active", hits: [], possible: [] },
    ];
    const r = buildResults(scans);
    assert.equal(r.flowsSure, 2);
    assert.equal(r.flowsActive, 1);
    assert.equal(r.flowsPossible, 2);
    assert.deepEqual(r.sure.map((s) => s.def.apiName), ["A", "B", "B"]);
    assert.equal(r.unreadable.length, 1);
    assert.equal(summaryLine(r, T("x")), "Used in 2 flows, 1 of them active. 2 more flows may use it (see Possible matches).");
    assert.equal(summaryLine({ flowsSure: 7, flowsActive: 5, flowsPossible: 0 }, T("x")), "Used in 7 flows, 5 of them active.");
    assert.equal(summaryLine({ flowsSure: 1, flowsActive: 1, flowsPossible: 0 }, T("x")), "Used in 1 flow, and it is active.");
    assert.equal(summaryLine({ flowsSure: 3, flowsActive: 3, flowsPossible: 0 }, T("x")), "Used in 3 flows, all of them active.");
    assert.equal(summaryLine({ flowsSure: 2, flowsActive: 0, flowsPossible: 0 }, T("x")), "Used in 2 flows, none of them active.");
    assert.match(summaryLine({ flowsSure: 0, flowsActive: 0, flowsPossible: 1 }, T("x")), /^No flow that could be read uses it\. 1 more flow may use it/);
    assert.match(summaryLine({ flowsSure: 2, flowsActive: 1, flowsPossible: 0 }, { kind: "text", text: "x" }), /^Found in 2 flows/);
    assert.equal(flowKey({ namespace: "ns", apiName: "Abc" }), "ns__abc");
    assert.match(versionWords("latest", true), /Newer version/);
    assert.match(versionWords("latest", false), /Latest version \(not active\)/);
  });

  await test("flow results: CSV has one row per step, sure before possible, and guards formula cells", () => {
    const hit = (o) => ({ kind: "Update Records", label: "Update", element: "Update_1", action: "sets", field: "Status__c", ref: "Status__c", part: "", ...o });
    const scans = [
      { def: def({ apiName: "A", label: "=HYPERLINK(\"x\")" }), versionKind: "active", hits: [hit({}), hit({ element: "U2", label: "+cmd" })], possible: [hit({ action: "uses" })] },
    ];
    const rows = csvRows(buildResults(scans));
    assert.equal(rows.length, 4);
    assert.equal(rows[0].length, rows[1].length);
    assert.deepEqual(rows.slice(1).map((r) => r[11]), ["Sure", "Sure", "Possible"]);
    const csv = csvText(buildResults(scans));
    assert.ok(csv.includes("\"'=HYPERLINK(\"\"x\"\")\""), csv);
    assert.ok(csv.includes(",'+cmd,"), csv);
    assert.equal(csvFileName(T("Status__c"), "202601011200"), "flows_using_Account.Status__c_202601011200.csv");
    assert.match(csvFileName({ kind: "text", text: "a/b c" }, "1"), /^flows_using_text_a_b_c_1\.csv$/);
  });

  // ---------- reading the org ----------

  await test("flow reads: the list is one SELECT on FlowDefinitionView; a missing optional column falls back", async () => {
    const log = [];
    const rec = { DurableId: "300000000000001AAA", Id: "3dd000000000001AAA", ApiName: "F", Label: "F label", ProcessType: "Flow", IsActive: true, ActiveVersionId: "301000000000001AAA", LatestVersionId: "301000000000002AAA", NamespacePrefix: null, ManageableState: "installed", TriggerObjectOrEventLabel: "Account" };
    const api = fakeApi([[/FROM FlowDefinitionView/, () => [rec]]], log);
    const defs = await readFlowList(api);
    assert.equal(defs[0].id, "300000000000001AAA");
    assert.equal(defs[0].managed, true);
    assert.equal(defs[0].triggerObject, "Account");
    assert.ok(/^SELECT .*DurableId.* FROM FlowDefinitionView$/.test(log[0].q));
    const log2 = [];
    const api2 = fakeApi([[/TriggerOrder/, () => ({ fail: "No such column 'TriggerOrder'", code: "INVALID_FIELD" })], [/FROM FlowDefinitionView/, () => [rec]]], log2);
    assert.equal((await readFlowList(api2)).length, 1);
    assert.equal(log2.length, 2);
    const api3 = fakeApi([[/FROM FlowDefinitionView/, () => ({ fail: "boom", code: "OTHER" })]]);
    await assert.rejects(() => readFlowList(api3), /boom/);
  });

  await test("flow reads: active versions by default; with the tick box also the newest version where it differs", () => {
    const d = (o) => def({ activeVersionId: null, latestVersionId: "301000000000009AAA", ...o });
    const defs = [
      d({ apiName: "On", isActive: true, activeVersionId: "301000000000001AAA", latestVersionId: "301000000000001AAA" }),
      d({ apiName: "OnDraft", isActive: true, activeVersionId: "301000000000002AAA", latestVersionId: "301000000000003AAA" }),
      d({ apiName: "Off", isActive: false }),
      d({ apiName: "Pkg", isActive: true, activeVersionId: "Pkg__Thing-1", latestVersionId: "Pkg__Thing-1" }),
    ];
    const plain = versionsToRead(defs);
    assert.deepEqual(plain.map((j) => `${j.def.apiName}:${j.versionKind}:${j.versionId}`), ["On:active:301000000000001AAA", "OnDraft:active:301000000000002AAA", "Pkg:active:null"]);
    assert.equal(plain[2].badId, "Pkg__Thing-1");
    const all = versionsToRead(defs, { includeInactive: true });
    assert.deepEqual(all.map((j) => `${j.def.apiName}:${j.versionKind}`), ["On:active", "OnDraft:active", "OnDraft:latest", "Off:latest", "Pkg:active"]);
  });

  await test("flow reads: one Tooling query per version, SELECT only, GET only", async () => {
    const log = [];
    const api = fakeApi([[/FROM Flow WHERE Id = '301000000000001AAA'/, () => [{ Id: "301000000000001AAA", Metadata: { start: {} } }]],
      [/FROM Flow WHERE Id = '301000000000002AAA'/, () => [{ Id: "301000000000002AAA", Metadata: null }]]], log);
    assert.deepEqual(await readFlowVersion(api, "301000000000001AAA"), { metadata: { start: {} } });
    assert.deepEqual(await readFlowVersion(api, "301000000000002AAA"), { metadata: null });
    assert.ok(log.every((c) => c.tooling && c.method === "GET" && /^SELECT Id, Metadata FROM Flow WHERE Id = '301\w+'$/.test(c.q)));
    assert.equal(api.calls, 2);
  });

  await test("flow reads: a few at a time, progress reported, one failure does not stop the rest, nothing read twice", async () => {
    const log = [];
    const ids = Array.from({ length: 23 }, (_, i) => `301000000000${String(i).padStart(3, "0")}AAA`);
    const api = fakeApi([[/FROM Flow/, (q) => (q.includes(ids[7]) ? { fail: "INSUFFICIENT_ACCESS", code: "INSUFFICIENT_ACCESS" } : [{ Metadata: { id: q.match(/'(\w+)'/)[1] } }])]], log);
    const cache = new Map();
    const progress = [];
    const jobs = ids.map((id) => ({ versionId: id }));
    const made = await readVersions((id) => readFlowVersion(api, id), jobs, cache, { concurrency: 5, onProgress: (d, t) => progress.push(`${d}/${t}`) });
    assert.equal(made, 23);
    assert.ok(log.maxInFlight <= 5 && log.maxInFlight > 1, `in flight: ${log.maxInFlight}`);
    assert.equal(progress[0], "0/23");
    assert.equal(progress.at(-1), "23/23");
    assert.equal(cache.size, 23);
    assert.match(cache.get(ids[7]).error.message, /INSUFFICIENT_ACCESS/);
    assert.equal(cache.get(ids[8]).metadata.id, ids[8]);
    const before = log.length;
    assert.equal(await readVersions((id) => readFlowVersion(api, id), jobs, cache), 0);
    assert.equal(log.length, before);
  });

  await test("flow reads: flows we cannot look inside are explained in plain words, with the raw text kept separate", () => {
    const job = (o) => ({ def: def({}), versionId: "301000000000001AAA", ...o });
    assert.equal(whyUnreadable(job({}), { metadata: { start: {} } }), null);
    const pkg = whyUnreadable(job({ def: def({ managed: true }) }), { metadata: null });
    assert.match(pkg.plain, /installed package/);
    assert.match(whyUnreadable(job({ versionId: null, badId: "Pkg__Thing-1" }), null).plain, /installed package/);
    const err = whyUnreadable(job({}), { error: new Error("INSUFFICIENT_ACCESS: no") });
    assert.match(err.plain, /would not let us read/);
    assert.equal(err.raw, "INSUFFICIENT_ACCESS: no");
    assert.match(whyUnreadable(job({}), { metadata: null }).plain, /did not return/);
  });

  await test("flow reads: Ids from a Setup address become API names (Tooling CustomField / CustomObject, then the org's names)", async () => {
    const log = [];
    const api = fakeApi([
      [/FROM CustomField WHERE Id = '00N000000000001AAA'/, () => [{ DeveloperName: "Size", NamespacePrefix: null, TableEnumOrId: "01I000000000001AAA" }]],
      [/FROM CustomField WHERE Id = '00N000000000002AAA'/, () => [{ DeveloperName: "Status", NamespacePrefix: null, TableEnumOrId: "Account" }]],
      [/FROM CustomObject WHERE Id = '01I000000000001AAA'/, () => [{ DeveloperName: "Thing", NamespacePrefix: null }]],
    ], log);
    api.describeGlobal = async () => ({ sobjects: [{ name: "Account" }, { name: "Thing__c" }] });
    api.describe = async (o) => (o === "Thing__c" ? { fields: [{ name: "Name" }, { name: "Size__c" }] } : DESCRIBES[o]);
    assert.deepEqual(await resolveContext(api, { object: "01I000000000001AAA", field: "00N000000000001AAA" }), { object: "Thing__c", field: "Size__c", notes: [] });
    assert.deepEqual(await resolveContext(api, { object: "", field: "00N000000000002AAA" }), { object: "Account", field: "Status__c", notes: [] });
    assert.deepEqual(await resolveContext(api, { object: "Account", field: "Status__c" }), { object: "Account", field: "Status__c", notes: [] });
    assert.ok(log.every((c) => c.method === "GET" && (!c.tooling || /^SELECT /.test(c.q))));
    const bad = await resolveContext(fakeApi([[/CustomField/, () => ({ fail: "denied" })]]), { object: "01I000000000001AAA", field: "00N000000000009AAA" });
    assert.equal(bad.field, "");
    assert.equal(bad.notes.length, 1);
  });

  // ---------- the demo sample ----------

  await test("flow sample: sure hits, possible hits and flows we cannot look inside, found by the same code the page uses", async () => {
    const s = sample();
    const defs = s.flows.map((f) => f.def);
    const read = (id) => { for (const f of s.flows) if (id in f.versions) return f.versions[id]; return { error: new Error("missing") }; };
    const desc = async (o) => s.objects[o] || null;
    const search = async (target, includeInactive) => {
      const jobs = versionsToRead(defs, { includeInactive });
      const scans = [];
      for (const job of jobs) {
        const entry = job.versionId ? read(job.versionId) : null;
        const why = whyUnreadable(job, entry);
        const base = { def: job.def, versionKind: job.versionKind };
        scans.push(why ? { ...base, error: why } : { ...base, ...(await scanFlow(entry.metadata, target, { describe: desc })) });
      }
      return buildResults(scans);
    };
    const r = await search(T("Status__c"), false);
    assert.deepEqual(r.sure.map((x) => x.def.apiName).sort(), ["Account_Status_Process", "Account_Status_Router", "Contact_Welcome", "Opportunity_Stage_Notify"]);
    // Generic_Record_Helper cannot say its object; the other two save a whole Account record, so they may set the field
    assert.deepEqual(r.possible.map((x) => x.def.apiName).sort(), ["Account_Bulk_Save", "Account_Nightly_Review", "Generic_Record_Helper"]);
    assert.match(r.possible.find((x) => x.def.apiName === "Account_Bulk_Save").possible[0].detail, /saves a whole Account record, so it may set this field/);
    assert.deepEqual(r.unreadable.map((x) => x.def.apiName).sort(), ["Locked_Down_Flow", "pkg__Packaged_Sync"]);
    assert.equal(r.flowsActive, 4);
    const router = r.sure.find((x) => x.def.apiName === "Account_Status_Router");
    assert.ok(router.hits.some((h) => h.action === "sets" && h.kind === "Update Records"));
    assert.ok(router.hits.some((h) => h.action === "checks" && h.kind === "Start"));
    assert.ok(!router.hits.some((h) => h.element === "Get_Contacts"), "Contact.Status__c is another field");
    const opp = r.sure.find((x) => x.def.apiName === "Opportunity_Stage_Notify");
    assert.deepEqual(opp.hits.map((h) => h.ref).sort(), ["$Record.Account.Parent.Status__c", "$Record.Account.Status__c"]);
    // with the tick box: the inactive flow and the newer draft come in
    const more = await search(T("Status__c"), true);
    assert.ok(more.sure.some((x) => x.def.apiName === "Old_Status_Cleanup" && x.versionKind === "latest"));
    assert.ok(more.sure.some((x) => x.def.apiName === "Account_Owner_Check" && x.versionKind === "latest"));
    assert.ok(!r.sure.some((x) => x.def.apiName === "Account_Owner_Check"));
    // Contact's field of the same name finds the flows that look at Contacts, not the Account ones
    const con = await search(T("Status__c", "Contact"), false);
    // Account_Contact_Sync loops over $Record.Contacts: its loop item is a Contact because Account's describe says so
    assert.deepEqual(con.sure.map((x) => x.def.apiName).sort(), ["Account_Contact_Sync", "Account_Status_Router"]);
    // text and Id search
    const id = await search({ kind: "text", text: "001000000000001AAA" }, false);
    assert.deepEqual(id.sure.map((x) => x.def.apiName), ["Case_Routing"]);
    const owner = await search(T("Name", "User"), false);
    assert.ok(owner.possible.some((x) => x.def.apiName === "Case_Routing"), "a polymorphic Owner might be a User");
  });

  await test("flow sample: stays synthetic (made-up names, placeholder Ids, no org host or address)", () => {
    const raw = text("samples", "flow_usage.json");
    assert.ok(!/\.(my\.)?salesforce\.com|force\.com|@(?!example\.com)\w+\.\w+/i.test(raw), "a real-looking host or address");
    const ids = [...new Set(raw.match(/"[0-9a-zA-Z]{15}(?:[0-9a-zA-Z]{3})?"/g) || [])].map((x) => x.slice(1, -1)).filter(looksLikeId);
    for (const id of ids) assert.match(id, /^(00[0-9A-Z]|30[01]|01I)0{8,12}\d{1,3}(AAA|BAA)?$/, `not a placeholder Id: ${id}`);
    const s = sample();
    assert.ok(s.flows.length >= 8);
    assert.equal(s.org.isSandbox, true);
    assert.ok(s.flows.every((f) => /^300000000000\d{3}AAA$/.test(f.def.id)));
    assert.ok(s.flows.some((f) => Object.values(f.versions).some((v) => v.metadata === null)), "a flow with no contents");
    assert.ok(s.flows.some((f) => Object.values(f.versions).some((v) => v.error)), "a flow that failed");
  });

  // ---------- Part A fixes ----------

  await test("flow prefill: a Setup page of a custom object and field gets through every step to API names", async () => {
    const url = "https://acme.lightning.force.com/lightning/setup/ObjectManager/01I000000000001AAA/FieldsAndRelationships/00N000000000001AAA/view";
    const ctx = parseUrlContext(url);
    assert.deepEqual(ctx, { object: "01I000000000001AAA", field: "00N000000000001AAA" });
    const q = contextQuery(ctx);
    const back = contextFromParams(new URLSearchParams(q)); // what the flow page reads from its own address
    assert.deepEqual(back, ctx, "the Ids must survive the page address");
    const api = fakeApi([
      [/FROM CustomField WHERE Id = '00N000000000001AAA'/, () => [{ DeveloperName: "Size", NamespacePrefix: null, TableEnumOrId: "01I000000000001AAA" }]],
      [/FROM CustomObject WHERE Id = '01I000000000001AAA'/, () => [{ DeveloperName: "Thing", NamespacePrefix: null }]],
    ]);
    api.describeGlobal = async () => ({ sobjects: [{ name: "Account" }, { name: "Thing__c" }] });
    api.describe = async () => ({ fields: [{ name: "Name" }, { name: "Size__c" }] });
    assert.deepEqual(await resolveContext(api, back), { object: "Thing__c", field: "Size__c", notes: [] });
    // a standard object with a custom field Id
    const std = parseUrlContext("https://acme.lightning.force.com/lightning/setup/ObjectManager/Account/FieldsAndRelationships/00N000000000002/view");
    assert.deepEqual(std, { object: "Account", field: "00N000000000002" });
    const api2 = fakeApi([[/FROM CustomField WHERE Id = '00N000000000002'/, () => [{ DeveloperName: "Status", NamespacePrefix: null, TableEnumOrId: "Account" }]]]);
    api2.describe = async (o) => DESCRIBES[o];
    assert.deepEqual(await resolveContext(api2, contextFromParams(new URLSearchParams(contextQuery(std)))), { object: "Account", field: "Status__c", notes: [] });
    // anything else is still refused
    assert.deepEqual(contextFromParams(new URLSearchParams("object=001000000000001AAA&field=001000000000001AAA")), { object: "", field: "" });
  });

  await test("flow scan: a step that saves a whole record on the target object is a possible match, with plain words", async () => {
    const meta = {
      variables: [{ name: "rec", dataType: "SObject", objectType: "Account" }, { name: "c", dataType: "SObject", objectType: "Contact" }],
      recordUpdates: [{ name: "Save", label: "Save it", inputReference: "rec" }],
      recordCreates: [{ name: "Make", label: "Make it", inputReference: "c" }, { name: "Fields", label: "Fields", inputReference: "rec", inputAssignments: [flt("Status__c", null, "x")] }],
    };
    const r = await scan(meta, T("Status__c"));
    assert.deepEqual(r.possible.map((h) => `${h.element}|${h.confidence}`), ["Save|possible"]);
    assert.equal(r.possible[0].detail, "saves a whole Account record, so it may set this field");
    assert.equal(hitText(r.possible[0]), "Update Records 'Save it': saves a whole Account record, so it may set this field");
    assert.deepEqual(r.hits.map((h) => h.element), ["Fields"]); // field-by-field is still a sure hit
    const results = buildResults([{ def: def({ apiName: "W" }), versionKind: "active", ...r }]);
    assert.equal(results.flowsPossible, 1);
    const rows = csvRows(results);
    const row = rows.find((x) => x[7] === "Save");
    assert.equal(row[11], "Possible");
    assert.match(row[10], /saves a whole Account record/);
  });

  await test("flow results: the CSV has a row for every flow that could not be looked inside, with the plain reason", () => {
    const hit = { kind: "Decision", label: "D", element: "D", action: "checks", field: "Status__c", ref: "$Record.Status__c", part: "" };
    const r = buildResults([
      { def: def({ apiName: "A" }), versionKind: "active", hits: [hit], possible: [] },
      { def: def({ apiName: "Pkg", label: "Packaged", isActive: true }), versionKind: "active", error: { plain: "This flow comes from an installed package, and Salesforce does not let us look inside it.", raw: "Version id: x" } },
      { def: def({ apiName: "Locked", label: "Locked", isActive: false }), versionKind: "latest", error: { plain: "Salesforce would not let us read this flow.", raw: "denied" } },
    ]);
    const rows = csvRows(r);
    assert.equal(rows.length, 4);
    const pkg = rows.find((x) => x[1] === "Pkg");
    assert.equal(pkg[11], "Could not look inside: This flow comes from an installed package, and Salesforce does not let us look inside it.");
    assert.equal(pkg[5], "");
    assert.match(rows.find((x) => x[1] === "Locked")[11], /^Could not look inside: Salesforce would not let us read/);
    assert.ok(rows.every((x) => x.length === rows[0].length));
    assert.ok(!csvText(r).includes("Version id")); // the raw text stays out of the Excel list
  });

  await test("flow scan: a loop over a related list takes the child object's type from the parent's describe, so its hits are sure", async () => {
    const meta = {
      start: { object: "Account" },
      variables: [{ name: "acct", dataType: "SObject", objectType: "Account" }],
      loops: [
        { name: "Loop_Rec", label: "Loop", collectionReference: "$Record.Contacts", assignNextValueToReference: "oneContact" },
        { name: "Loop_Var", label: "Loop 2", collectionReference: "acct.Cases" },
        { name: "Loop_Unknown", label: "Loop 3", collectionReference: "$Record.Mystery__r" },
      ],
      textTemplates: [{ name: "a", text: "{!Loop_Rec.Status__c} {!oneContact.Status__c}" }, { name: "b", text: "{!Loop_Var.Status__c}" }, { name: "c", text: "{!Loop_Unknown.Status__c}" }],
      recordUpdates: [{ name: "Save_Contact", label: "Save", inputReference: "Loop_Rec" }, { name: "Save_Case", label: "Save case", inputReference: "oneContact2" }],
    };
    const con = await scan(meta, T("Status__c", "Contact"));
    assert.deepEqual(where(con.hits), ["Text template|a|uses|Status__c"]);
    assert.deepEqual(con.hits[0].refs.sort(), ["Loop_Rec.Status__c", "oneContact.Status__c"]);
    assert.deepEqual(where(con.possible).sort(), ["Text template|c|uses|Status__c", "Update Records|Save_Contact|sets|Status__c"]); // an untyped loop stays possible; a whole-record save is possible
    assert.ok(!where(con.hits).some((x) => x.includes("|b|")));
    const kase = await scan(meta, { kind: "field", object: "Case", field: "Status__c" });
    assert.deepEqual(where(kase.hits), ["Text template|b|uses|Status__c"]);
    // the same typing reaches the record steps
    const recs = (await scan(meta, null)).records;
    assert.equal(recs.find((x) => x.element === "Save_Contact").object, "Contact");
    assert.equal(recs.find((x) => x.element === "Save_Case").object, null);
    // without a describe the loop is simply untyped (possible), nothing breaks
    const none = await scan(meta, T("Status__c", "Contact"), async () => { throw new Error("denied"); });
    assert.equal(none.hits.length, 0);
  });

  await test("flow page: unreadable flows get the Flow Builder link only where there is a version Id, and no duplicate raw lines in Notes", () => {
    const page = text("tools/flow-usage/flow-usage.js");
    const fn = page.slice(page.indexOf("function unreadableItem"), page.indexOf("const unreadableHelp"));
    assert.match(fn, /openLink\(s\.versionId\)/);
    assert.match(page, /const builderLink = \(versionId\) => \(HOST && isSalesforceHost\(HOST\) && versionId/); // no Id, no link
    assert.ok(!/notes\.push\(`\$\{job\.def\.label\}: \$\{why\.raw\}`\)/.test(page));
    assert.ok(!page.includes("Version id"));
    assert.match(page, /unreadableHelp\(list\)|const unreadableHelp = \(list\) => \(list\.some\(\(s\) => builderLink\(s\.versionId\)\)/);
    const html = text("tools/flow-usage/flow-usage.html");
    assert.ok(!html.includes("Open them in Flow Builder to check"));
    // a package flow has no usable Id, so there is nothing to link
    const pkg = versionsToRead([def({ isActive: true, activeVersionId: "Pkg__Thing-1", latestVersionId: "Pkg__Thing-1" })])[0];
    assert.equal(pkg.versionId, null);
    assert.equal(whyUnreadable(pkg, null).raw, "Version id: Pkg__Thing-1");
  });

  // ---------- Part B: the object view ----------

  const FD = (o) => def({
    triggerType: "RecordAfterSave", recordTriggerType: "CreateAndUpdate", triggerObject: "Account", triggerObjectName: "Account",
    triggerOrder: null, lastModified: "2026-01-15T10:00:00.000+0000", hasAsyncPath: false, activeVersionId: "301000000000001AAA", latestVersionId: "301000000000001AAA", ...o,
  });
  const entry = (d, extra = {}) => ({ def: d, versionId: "301000000000001AAA", versionKind: "active", ...extra });
  const startOf = (o = {}) => startInfo({ start: { object: "Account", triggerType: "RecordAfterSave", recordTriggerType: "Update", ...o } });

  await test("flow object: the group and the 'when it runs' words", () => {
    assert.equal(groupOf(FD({ triggerType: "RecordBeforeSave" })), "before");
    assert.equal(groupOf(FD({ triggerType: "RecordAfterSave" })), "after");
    assert.equal(groupOf(FD({ triggerType: "RecordBeforeDelete" })), "delete");
    assert.equal(groupOf(FD({ triggerType: "", processType: "Workflow" })), "process"); // Process Builder: after the save, before the after-save flows
    assert.equal(groupOf(FD({ triggerType: "Scheduled" })), null);
    assert.equal(groupOf(FD({ triggerType: "", processType: "Flow" })), null);
    const w = (rtt) => whenWords(FD({ recordTriggerType: rtt }));
    assert.equal(w("Create"), "when a record is created");
    assert.equal(w("Update"), "when a record is updated");
    assert.equal(w("CreateAndUpdate"), "when a record is created or updated");
    assert.equal(w("Delete"), "when a record is deleted");
    assert.equal(whenWords(FD({ recordTriggerType: "" })), "when a record is saved");
    assert.equal(whenWords(FD({ recordTriggerType: "" }), { recordTriggerType: "Update" }), "when a record is updated");
    const pb = (t) => whenWords(FD({ triggerType: "", processType: "Workflow", recordTriggerType: "" }), { processTrigger: t });
    assert.equal(pb("onCreateOnly"), "when a record is created");
    assert.equal(pb("onAllChanges"), "when a record is created or updated");
    assert.equal(whenWords(FD({ triggerType: "Scheduled" })), "on a schedule");
    assert.equal(kindWords(FD({ triggerType: "", processType: "Workflow" })), "Process Builder");
    assert.equal(kindWords(FD({})), "Record-triggered flow");
  });

  await test("flow object: entry conditions in plain words; a formula, many conditions and none are said as such", () => {
    const f = (field, op, v) => ({ field, operator: op, value: v });
    const labelOf = (a) => ({ Status__c: "Account Status" }[a]);
    const one = entryConditions({ filters: [f("Status__c", "EqualTo", { stringValue: "Closed" })] }, labelOf);
    assert.deepEqual([one.has, one.simple, one.text], [true, true, "Account Status equals Closed"]);
    assert.equal(entryConditions({ filters: [f("Status__c", "EqualTo", { stringValue: "Closed" })] }).text, "Status__c equals Closed");
    const and = entryConditions({ filterLogic: "and", filters: [f("Type", "NotEqualTo", { stringValue: "Gold" }), f("AnnualRevenue", "GreaterThan", { numberValue: 1000 })] });
    assert.equal(and.text, "Type does not equal Gold and AnnualRevenue is greater than 1000");
    assert.equal(entryConditions({ filterLogic: "or", filters: [f("Type", "EqualTo", { stringValue: "A" }), f("Type", "EqualTo", { stringValue: "B" })] }).text, "Type equals A or Type equals B");
    assert.equal(entryConditions({ filterLogic: "1 AND (2 OR 3)", filters: [f("A", "EqualTo", { stringValue: "1" }), f("B", "IsNull", { booleanValue: true }), f("C", "IsChanged", { booleanValue: true })] }).text,
      "[A equals 1] and ([B is blank] or [C has changed])");
    assert.equal(entryConditions({ filters: [f("Done__c", "EqualTo", { booleanValue: true }), f("Name", "Contains", { stringValue: "x" }), f("Ref", "EqualTo", { elementReference: "$Record.Name" })] }).text,
      "Done__c equals true and Name contains x and Ref equals {!$Record.Name}");
    const formula = entryConditions({ filterLogic: "formula_evaluates_to_true", filterFormula: "{!$Record.A} = 1" });
    assert.deepEqual([formula.has, formula.simple, formula.text], [true, false, "has a formula condition"]);
    const none = entryConditions({ filters: [] });
    assert.deepEqual([none.has, none.simple], [false, true]);
    assert.match(none.text, /^No entry conditions/);
    assert.equal(entryConditions({ filters: Array.from({ length: 8 }, () => f("A", "EqualTo", { stringValue: "x" })) }).text, "has 8 conditions");
    assert.equal(entryConditions({ requireChange: true, filters: [f("A", "EqualTo", { stringValue: "x" })] }).changeOnly, true);
  });

  await test("flow object: scheduled and run-asynchronously paths, and schedules, in words", () => {
    const st = startInfo({ start: { object: "Account", scheduledPaths: [
      { name: "a", label: "Async", pathType: "AsyncAfterCommit" },
      { name: "b", label: "Chase", offsetNumber: 3, offsetUnit: "Days", timeSource: "RecordTriggerEvent" },
      { name: "c", label: "Before renewal", offsetNumber: -1, offsetUnit: "Hours", timeSource: "RecordField", recordField: "Renewal__c" },
    ], schedule: { frequency: "Daily", startDate: "2026-02-01", startTime: "06:00:00.000Z" } } });
    assert.deepEqual(pathWords(st), [
      "Runs asynchronously, after the record is saved", "Chase: 3 days after the time the record is saved", "Before renewal: 1 hour before Renewal__c",
    ]);
    assert.equal(scheduleWords(st), "Runs daily at 06:00, starting 2026-02-01");
    assert.equal(scheduleWords(startInfo({ start: { schedule: { frequency: "Once", startDate: "2026-03-01", startTime: "09:30:00.000Z" } } })), "Runs once on 2026-03-01 at 09:30");
    assert.equal(scheduleWords(startInfo({})), "");
    assert.deepEqual(pathWords(startInfo({})), []);
    // a path with no name has no "Name:" (and no double colon)
    const unnamed = startInfo({ start: { object: "Account", scheduledPaths: [
      { pathType: "AsyncAfterCommit" }, { offsetNumber: 2, offsetUnit: "Hours", timeSource: "RecordTriggerEvent" }, { offsetNumber: 0 },
    ] } });
    assert.deepEqual(pathWords(unnamed), [
      "Runs asynchronously, after the record is saved", "2 hours after the time the record is saved", "at the time the record is saved",
    ]);
    assert.ok(!pathWords(unnamed).some((x) => x.includes(": ")));
    // the async path is said once, even when its own name says it too
    const dup = startInfo({ start: { object: "Account", scheduledPaths: [{ label: "Run asynchronously", pathType: "AsyncAfterCommit" }] } });
    assert.deepEqual(pathWords(dup), ["Runs asynchronously, after the record is saved"]);
    // a scheduled path shows the field's label; without a label it falls back to the API name
    const labels = { Renewal__c: "Renewal Date" };
    assert.equal(pathWords(st, (f) => labels[f])[2], "Before renewal: 1 hour before Renewal Date");
    assert.equal(pathWords(st, () => "")[2], "Before renewal: 1 hour before Renewal__c");
    assert.equal(pathWords(st)[2], "Before renewal: 1 hour before Renewal__c");
  });

  await test("flow object: a scheduled flow reads as one sentence", () => {
    const it = { kind: "Scheduled flow", placed: true, schedule: "Runs daily at 06:00, starting 2026-02-01", when: "on a schedule" };
    assert.equal(metaWords(it), "Scheduled flow: runs daily at 06:00, starting 2026-02-01");
    assert.equal(metaWords({ kind: "Record-triggered flow", placed: true, schedule: "", when: "when a record is created", band: "off" }),
      "Record-triggered flow, runs when a record is created, Not active (does not run)");
    assert.equal(metaWords({ kind: "Record-triggered flow", placed: false }), "Record-triggered flow");
  });

  await test("flow object: run order - 1 to 1000, then no trigger order by API name, then 1001 to 2000, then inactive; the same number by API name", () => {
    const e = (o) => ({ def: FD(o) });
    const sorted = (list) => list.sort(compareRunOrder).map((x) => x.def.apiName);
    // the three bands, whatever order they come in
    assert.deepEqual(sorted([
      e({ apiName: "late", triggerOrder: 1001 }), e({ apiName: "none", triggerOrder: null }),
      e({ apiName: "o1000", triggerOrder: 1000 }), e({ apiName: "o5", triggerOrder: 5 }), e({ apiName: "o2000", triggerOrder: 2000 }),
    ]), ["o5", "o1000", "none", "late", "o2000"]);
    assert.deepEqual([1001, null, 1000].map((o) => runBand(FD({ triggerOrder: o }))), ["high", "none", "low"]);
    // the same number: alphabetical by API name
    assert.deepEqual(sorted([e({ apiName: "B", triggerOrder: 10 }), e({ apiName: "A", triggerOrder: 10 })]), ["A", "B"]);
    assert.deepEqual(sorted([e({ apiName: "Y", triggerOrder: 1500 }), e({ apiName: "X", triggerOrder: 1500 })]), ["X", "Y"]);
    // no trigger order: by API name, whatever the last-changed dates say (activation dates are not available)
    assert.deepEqual(sorted([
      e({ apiName: "Z_old", lastModified: "2026-01-28T00:00:00.000+0000" }), e({ apiName: "A_new", lastModified: "2026-01-01T00:00:00.000+0000" }),
    ]), ["A_new", "Z_old"]);
    // 0 counts as a number (first band), not as blank
    assert.deepEqual(sorted([e({ apiName: "a", triggerOrder: null }), e({ apiName: "b", triggerOrder: 0 })]), ["b", "a"]);
    // flows that are not active come last, whatever their trigger order
    assert.deepEqual(sorted([
      e({ apiName: "Off_1", isActive: false, triggerOrder: 1 }), e({ apiName: "On_late", triggerOrder: 1500 }), e({ apiName: "Off_0", isActive: false }), e({ apiName: "On_none" }),
    ]), ["On_none", "On_late", "Off_0", "Off_1"]);
    assert.equal(runBand(FD({ isActive: false, triggerOrder: 5 })), "off");
  });

  await test("flow object: in a group, bands, trigger order values, an unnumbered block of flows with no order, inactive flows last", () => {
    const view = buildObjectView("Account", [
      entry(FD({ apiName: "Off_Flow", isActive: false, triggerOrder: 5 })), entry(FD({ apiName: "High_B", triggerOrder: 1500 })), entry(FD({ apiName: "None_Z" })),
      entry(FD({ apiName: "Low_20", triggerOrder: 20 })), entry(FD({ apiName: "None_A" })), entry(FD({ apiName: "Low_10_B", triggerOrder: 10 })),
      entry(FD({ apiName: "Low_10_A", triggerOrder: 10 })), entry(FD({ apiName: "High_A", triggerOrder: 1001 })),
      entry(FD({ apiName: "Before_Only", triggerType: "RecordBeforeSave" })),
    ], { objectLabel: "Account" });
    const after = view.groups[1];
    assert.deepEqual(after.items.map((i) => i.apiName), ["Low_10_A", "Low_10_B", "Low_20", "None_A", "None_Z", "High_A", "High_B", "Off_Flow"]);
    assert.deepEqual(after.items.map((i) => i.band), ["low", "low", "low", "none", "none", "high", "high", "off"]);
    assert.deepEqual(after.items.map((i) => i.order), [10, 10, 20, null, null, 1001, 1500, 5]);
    assert.ok(after.items.every((i) => i.position === undefined), "no computed positions");
    assert.equal(after.noOrderCount, 2);
    assert.deepEqual(after.items.map((i) => i.orderKnown), [true, true, true, false, false, true, true, false]);
    // a lone flow with no trigger order: its place is certain
    const lone = view.groups[0].items[0];
    assert.deepEqual([lone.apiName, lone.band, lone.orderKnown, view.groups[0].noOrderCount], ["Before_Only", "none", true, 1]);
    assert.equal(view.unconfirmed, undefined);
    // the words
    const tail = "in the order they were activated\\. That date isn't available here, so they are listed by name\\. .*Flow Trigger Explorer";
    assert.match(noOrderBlockText({ above: true }), new RegExp(`^No trigger order set\\. Salesforce runs these after the flows above, ${tail}`));
    assert.match(noOrderBlockText({ below: true }), new RegExp(`^No trigger order set\\. Salesforce runs these before the flows below, ${tail}`));
    assert.match(noOrderBlockText({ above: true, below: true }), new RegExp(`^No trigger order set\\. Salesforce runs these after the flows above and before the flows below, ${tail}`));
    assert.match(noOrderBlockText({}), new RegExp(`^No trigger order set\\. Salesforce runs these ${tail}`));
    assert.ok(!/above|below/.test(noOrderBlockText()), "nothing above or below: no mention");
    assert.match(RUN_ORDER_RULE, /activated/);
    assert.ok(!/created/i.test(RUN_ORDER_RULE));
    // the CSV: the trigger order value and the run-order words
    const rows = objectCsvRows(view);
    const col = (n) => OBJECT_CSV_HEADER.indexOf(n);
    assert.ok(rows.every((r) => r.length === OBJECT_CSV_HEADER.length));
    assert.ok(!OBJECT_CSV_HEADER.includes("Position"));
    const of = (api) => rows.find((r) => r[col("Flow API name")] === api);
    assert.deepEqual(["Low_10_A", "None_A", "High_B", "Off_Flow", "Before_Only"].map((n) => [of(n)[col("Trigger order")], of(n)[col("Run order")]]), [
      [10, "Runs in this order"], ["", "No trigger order: order not known"], [1500, "Runs in this order"], [5, "Not active"], ["", "Runs in this order"],
    ]);
    assert.equal(runOrderWords({}), "");
  });

  await test("flow object: a flow that reads and changes the object is listed once, under change; only-read has flows that change nothing", () => {
    const rec = (element, op) => ({ element, label: element, kind: "Get Records", op, object: "Account", objectKnown: true });
    const other = (n, records) => entry(FD({ apiName: n, label: n, triggerType: "", triggerObjectName: "", triggerObject: "", processType: "AutoLaunchedFlow" }), { start: startOf(), records });
    const view = buildObjectView("Account", [
      other("Both", [rec("g", "get"), rec("u", "update")]), other("OnlyRead", [rec("g", "get")]), other("OnlyChange", [rec("d", "delete")]),
    ], { objectLabel: "Account" });
    assert.deepEqual(view.changes.map((i) => i.apiName), ["Both", "OnlyChange"]);
    assert.deepEqual(view.reads.map((i) => i.apiName), ["OnlyRead"]);
    assert.deepEqual(view.changes[0].steps.map((x) => x.op), ["get", "update"]);
    assert.match(objectSummary(view), /2 more change them and 1 more only reads them\.$/);
    const rows = objectCsvRows(view).slice(1);
    const sectionsOf = (api) => rows.filter((r) => r[OBJECT_CSV_HEADER.indexOf("Flow API name")] === api).map((r) => r[0]);
    assert.deepEqual(sectionsOf("Both"), ["Other flows that change these records", "Other flows that change these records"]);
    assert.deepEqual(sectionsOf("OnlyRead"), ["Other flows that only read these records"]);
  });

  await test("flow object: API names run in plain character order, as Flow Trigger Explorer sorts them", () => {
    const e = (n) => ({ def: FD({ apiName: n }) });
    const sorted = (list) => list.sort(compareRunOrder).map((x) => x.def.apiName);
    assert.deepEqual(sorted([e("Thing_alpha_flow"), e("Thing_Zeta_Flow")]), ["Thing_Zeta_Flow", "Thing_alpha_flow"]);
    assert.deepEqual(sorted([e("Thing_Auto"), e("ThingIntegration")]), ["ThingIntegration", "Thing_Auto"]);
    assert.deepEqual(sorted([e("b_flow"), e("B_flow"), e("a_flow")]), ["B_flow", "a_flow", "b_flow"]);
    assert.deepEqual(sorted([e("X"), e("X")]), ["X", "X"]);
  });

  await test("flow results: names show the API name only when it differs; identical step lines show once", () => {
    assert.equal(nameWithApi("Rating", "Rating"), "Rating");
    assert.equal(nameWithApi("rating", "Rating"), "rating");
    assert.equal(nameWithApi("Close Date", "CloseDate"), "Close Date (CloseDate)");
    assert.equal(nameWithApi("", "CloseDate"), "CloseDate");
    const t = { kind: "field", object: "Account", field: "Rating" };
    const h = (label, action, extra = {}) => ({ kind: "Decision", label, action, field: "Rating", ref: "Rating", ...extra });
    const hits = [h("Check", "checks"), h("Check", "checks"), h("Check", "checks"), h("Check", "sets"), h("Other", "checks")];
    assert.deepEqual(uniqueSteps(hits, t).map((x) => stepLineText(x, t)), [
      "Decision 'Check': checks Rating", "Decision 'Check': sets Rating", "Decision 'Other': checks Rating",
    ]);
    const tt = { kind: "text", text: "x" };
    assert.equal(uniqueSteps([h("A", "uses", { ref: "x" }), h("A", "uses", { ref: "x" }), h("A", "uses", { ref: "y" })], tt).length, 2);
  });

  await test("flow object: approval flows get a plain type in both views", () => {
    assert.equal(plainFlowType(def({ processType: "ApprovalWorkflow" })), "Approval flow");
    assert.equal(plainFlowType(def({ processType: "ApprovalWorkflow", triggerType: "RecordAfterSave" })), "Approval flow");
    assert.equal(kindWords(FD({ processType: "ApprovalWorkflow", triggerType: "" })), "Approval flow");
    assert.equal(kindWords(FD({ processType: "ApprovalWorkflow" })), "Approval flow");
  });

  await test("flow object: Process Builder processes are their own part, between before and after, unnumbered", () => {
    const pb = (n) => FD({ apiName: n, label: n, triggerType: "", processType: "Workflow", triggerOrder: null });
    const view = buildObjectView("Account", [
      entry(FD({ apiName: "After_One" })), entry(pb("Zeta_Process")), entry(FD({ apiName: "Before_One", triggerType: "RecordBeforeSave" })), entry(pb("Alpha_Process")),
    ], { objectLabel: "Account" });
    assert.deepEqual(view.groups.map((g) => g.key), ["before", "after", "delete"]);
    assert.deepEqual(view.process.items.map((i) => i.apiName), ["Alpha_Process", "Zeta_Process"]);
    assert.ok(view.process.items.every((i) => i.band === undefined && i.isProcess));
    assert.deepEqual(view.groups[1].items.map((i) => i.apiName), ["After_One"]);
    assert.match(view.process.help, /run after the record is saved, before the flows below\. Salesforce does not promise an order among them/);
    assert.match(objectSummary(view), /^4 flows run when Account records are saved or deleted/);
    // the CSV: before, then the processes with no position, then after
    const rows = objectCsvRows(view).slice(1);
    assert.deepEqual(rows.map((r) => r[0]), ["Before the record is saved", "Process Builder processes", "Process Builder processes", "After the record is saved"]);
    assert.deepEqual(rows.slice(1, 3).map((r) => [r[1], r[2]]), [["", ""], ["", ""]]);
    // an unreadable process still has its place when its object is known
    const bad = buildObjectView("Account", [entry(pb("Locked"), { error: { plain: "p", raw: "" } })], { objectLabel: "Account" });
    assert.deepEqual(bad.process.items.map((i) => i.apiName), ["Locked"]);
  });

  /** The same steps the page takes: read what the list says, then what the contents say. */
  function entriesFrom(s, { includeInactive = false, read = true } = {}) {
    const defs = s.flows.map((f) => f.def);
    const jobs = versionsToRead(defs, { includeInactive });
    const seen = new Map();
    for (const j of jobs) if (!seen.has(j.def.id) || j.versionKind === "active") seen.set(j.def.id, j);
    const out = [];
    return (async () => {
      for (const j of seen.values()) {
        const v = j.versionId ? s.flows.map((f) => f.versions[j.versionId]).find(Boolean) : null;
        const base = { def: j.def, versionId: j.versionId, versionKind: j.versionKind };
        if (!read) { out.push(base); continue; }
        const why = whyUnreadable(j, v);
        if (why) { out.push({ ...base, error: why }); continue; }
        const r = await scanFlow(v.metadata, null, { describe: async (o) => s.objects[o] || null });
        out.push({ ...base, start: startInfo(v.metadata), records: r.records });
      }
      return out;
    })();
  }

  await test("flow object: the sample's groups, in run order, Process Builder between before and after, and API-name matching", async () => {
    const s = sample();
    const view = buildObjectView("Account", await entriesFrom(s), { objectLabel: "Account" });
    const names = (g) => g.items.map((i) => i.apiName);
    const g = (k) => view.groups.find((x) => x.key === k);
    assert.deepEqual(names(g("before")), ["Account_Defaults_Before_Save", "Account_Validate_Before_Save", "Account_Owner_Check", "Account_Late_Before_Save"]); // both 10: by API name; then none; then 1200
    assert.deepEqual(names(g("after")), ["Account_Notify_After_Save", "Account_Contact_Sync", "Account_Status_Router"]); // 20; then no order, by API name
    assert.deepEqual(names(g("delete")), ["Account_Delete_Guard"]);
    assert.deepEqual(g("after").items.map((i) => i.band), ["low", "none", "none"]);
    assert.equal(g("after").noOrderCount, 2, "the demo shows a block of flows with no trigger order");
    assert.equal(g("before").noOrderCount, 1);
    assert.deepEqual(names(view.process), ["Account_Status_Process"]); // Process Builder: its own part, no position
    assert.equal(view.process.items[0].kind, "Process Builder");
    assert.equal(view.process.items[0].band, undefined);
    assert.equal(view.process.items[0].when, "when a record is created or updated");
    assert.deepEqual(view.scheduled.map((i) => i.apiName), ["Account_Nightly_Review"]);
    assert.equal(view.scheduled[0].schedule, "Runs daily at 06:00, starting 2026-02-01");
    assert.deepEqual(view.changes.map((i) => i.apiName), ["Account_Bulk_Save", "Account_Cleanup_Remove", "Opportunity_Closed_Update_Account"]);
    assert.deepEqual(view.changes.find((i) => i.apiName === "Opportunity_Closed_Update_Account").steps.map((x) => x.op).sort(), ["get", "update"]);
    assert.ok(view.reads.some((i) => i.apiName === "Contact_Welcome"));
    // a flow that both reads and changes Account is listed once, under "change", with its read step too
    assert.ok(!view.reads.some((i) => i.apiName === "Opportunity_Closed_Update_Account"));
    assert.ok(view.reads.every((i) => i.steps.every((x) => x.op === "get")));
    assert.ok(!view.groups.some((x) => names(x).includes("Partner_Account_Welcome")), "another object with the same label is not Account");
    assert.ok(![...view.changes, ...view.reads, ...view.scheduled].some((i) => i.apiName === "Partner_Account_Welcome"));
    assert.deepEqual(view.unreadable.map((i) => i.apiName).sort(), ["Locked_Down_Flow", "pkg__Packaged_Sync"]);
    // the entry conditions
    const cond = (n) => view.groups.flatMap((x) => x.items).find((i) => i.apiName === n).conditions;
    assert.equal(cond("Account_Defaults_Before_Save").text, "Industry is blank");
    assert.equal(cond("Account_Validate_Before_Save").text, "[Type equals Customer] and ([Rating equals Hot] or [Industry equals Banking])");
    assert.equal(cond("Account_Notify_After_Save").text, "has a formula condition");
    assert.equal(cond("Account_Contact_Sync").has, false);
    assert.deepEqual(view.groups.flatMap((x) => x.items).find((i) => i.apiName === "Account_Notify_After_Save").paths,
      ["Follow up: 3 days after the time the record is saved", "Runs asynchronously, after the record is saved"]);
    // inactive flows are left out unless the tick box is on
    assert.ok(!names(g("before")).includes("Old_Status_Cleanup"), "an inactive flow is left out");
    const withInactive = buildObjectView("Account", await entriesFrom(s, { includeInactive: true }), { objectLabel: "Account" });
    const before = withInactive.groups.find((x) => x.key === "before").items;
    assert.deepEqual(before.map((i) => i.apiName), ["Account_Defaults_Before_Save", "Account_Validate_Before_Save", "Account_Owner_Check", "Account_Late_Before_Save", "Old_Status_Cleanup"]);
    assert.ok(before.at(-1).apiName === "Old_Status_Cleanup" && before.at(-1).band === "off" && !before.at(-1).isActive, "the inactive flow shows last, marked not active");
    assert.ok(before.find((i) => i.apiName === "Account_Owner_Check").versionKind === "active");
    // Partner_Account__c has its own flow
    const partner = buildObjectView("Partner_Account__c", await entriesFrom(s), { objectLabel: "Account" });
    assert.deepEqual(partner.groups.flatMap((x) => x.items).map((i) => i.apiName), ["Partner_Account_Welcome"]);
    assert.equal(partner.changes.length + partner.reads.length, 0);
    // the whole-record save of Account_Bulk_Save counts as a change, and the loop item's save is a Contact change
    assert.deepEqual((await buildObjectViewFor(s, "Contact")).changes.map((i) => i.apiName), ["Account_Contact_Sync"]);
  });

  async function buildObjectViewFor(s, object) {
    return buildObjectView(object, await entriesFrom(s), { objectLabel: object });
  }

  await test("flow object: matched by API name, never by label, even when two objects share a label", () => {
    const a = FD({ id: "300000000000001AAA", apiName: "On_Account", triggerObject: "Account", triggerObjectName: "Account" });
    const b = FD({ id: "300000000000002AAA", apiName: "On_Partner", triggerObject: "Account", triggerObjectName: "Partner_Account__c" });
    const c = FD({ id: "300000000000003AAA", apiName: "Label_Only", triggerObject: "Account", triggerObjectName: "" }); // an old org: no API name in the list
    const view = buildObjectView("Account", [entry(a), entry(b), entry(c)], { objectLabel: "Account", partial: true });
    assert.deepEqual(view.groups.flatMap((g) => g.items).map((i) => i.apiName), ["On_Account"]);
    assert.equal(view.pending, 1); // Label_Only waits for its contents; its label is never used to place it
    // when the contents say Account, it is placed by the start element's object
    const full = buildObjectView("Account", [entry(a), entry(b), entry(c, { start: startOf(), records: [] })], { objectLabel: "Account" });
    assert.deepEqual(full.groups.flatMap((g) => g.items).map((i) => i.apiName).sort(), ["Label_Only", "On_Account"]);
    // case does not matter in API names
    assert.equal(buildObjectView("ACCOUNT", [entry(a)], {}).groups[1].items.length, 1);
  });

  await test("flow object: before the contents are read only the list's facts show; an unreadable flow keeps its place when the list names its object", () => {
    const d1 = FD({ apiName: "A1", hasAsyncPath: true });
    const d2 = FD({ apiName: "A2", triggerType: "RecordBeforeSave" });
    const view = buildObjectView("Account", [entry(d1), entry(d2, { error: { plain: "Salesforce would not let us read this flow.", raw: "x" } })], { partial: true, objectLabel: "Account" });
    const after = view.groups[1].items[0];
    assert.equal(after.detailsKnown, false);
    assert.equal(after.conditions, null);
    assert.deepEqual(after.paths, ["Has a path that runs asynchronously"]);
    assert.equal(after.pathsPartial, true);
    const before = view.groups[0].items[0];
    assert.equal(before.unreadable.plain, "Salesforce would not let us read this flow.");
    assert.deepEqual(view.changes.concat(view.reads), []);
    assert.equal(objectSummary(view), "2 flows run when Account records are saved or deleted (2 active).");
    const pend = buildObjectView("Account", [entry(FD({ triggerType: "", triggerObjectName: "", triggerObject: "" }))], { partial: true });
    assert.match(objectSummary(pend), /No flow runs when Account records are saved or deleted\. Still reading 1 other flow to find the rest\.$/);
    // an unreadable flow of no known object is listed apart; one that names another object is not our business
    const other = buildObjectView("Account", [entry(FD({ triggerObjectName: "Case" }), { error: { plain: "p", raw: "" } }), entry(FD({ apiName: "Unk", triggerType: "", triggerObjectName: "" }), { error: { plain: "p", raw: "" } })], { objectLabel: "Account" });
    assert.deepEqual(other.unreadable.map((i) => i.apiName), ["Unk"]);
  });

  await test("flow object: summary line", async () => {
    const view = buildObjectView("Account", await entriesFrom(sample()), { objectLabel: "Account" });
    assert.equal(objectSummary(view), "9 flows run when Account records are saved or deleted (9 active), 1 runs on a schedule, 3 more change them and 1 more only reads them.");
  });

  await test("flow object: the CSV has one row per step, a row for a flow with none, and a row for each flow we could not look inside", async () => {
    const view = buildObjectView("Account", await entriesFrom(sample()), { objectLabel: "Account" });
    const rows = objectCsvRows(view);
    assert.deepEqual(rows[0], OBJECT_CSV_HEADER);
    assert.ok(rows.every((r) => r.length === OBJECT_CSV_HEADER.length));
    const col = (n) => OBJECT_CSV_HEADER.indexOf(n);
    const of = (api) => rows.filter((r) => r[col("Flow API name")] === api);
    assert.equal(of("Account_Defaults_Before_Save").length, 1); // no step on Account: one row for the flow
    assert.deepEqual(of("Account_Defaults_Before_Save")[0].slice(0, 10), [
      "Before the record is saved", 10, "Runs in this order", "Account Defaults (before save)", "Account_Defaults_Before_Save", "Record-triggered flow", "Yes", "When a record is created", "Industry is blank", "",
    ]);
    const nightly = of("Account_Nightly_Review");
    assert.equal(nightly.length, 1);
    assert.equal(nightly[0][col("Section")], "Runs on a schedule");
    assert.equal(nightly[0][col("Runs")], "Runs daily at 06:00, starting 2026-02-01");
    assert.equal(nightly[0][col("What it does")], "updates");
    assert.equal(of("Account_Status_Process")[0][col("Flow type")], "Process Builder");
    const opp = of("Opportunity_Closed_Update_Account");
    assert.deepEqual(opp.map((r) => r[col("Section")]), ["Other flows that change these records", "Other flows that change these records"]); // reads and changes: once, under change
    assert.deepEqual(opp.map((r) => r[col("What it does")]).sort(), ["reads", "updates"]);
    assert.match(of("pkg__Packaged_Sync")[0][col("Note")], /^Could not look inside: This flow comes from an installed package/);
    assert.equal(of("pkg__Packaged_Sync")[0][col("Section")], "Could not look inside (may also use these records)");
    // the order in the file is the order on the page
    const order = rows.slice(1).filter((r) => r[col("Section")] === "After the record is saved").map((r) => [r[col("Flow API name")], r[col("Trigger order")], r[col("Run order")]]);
    assert.deepEqual(order, [
      ["Account_Notify_After_Save", 20, "Runs in this order"], ["Account_Contact_Sync", "", "No trigger order: order not known"], ["Account_Status_Router", "", "No trigger order: order not known"],
    ]);
    assert.equal(of("Account_Status_Process")[0][col("Section")], "Process Builder processes");
    assert.equal(of("Account_Status_Process")[0][col("Run order")], "");
    // a formula-looking flow name is guarded
    const evil = buildObjectView("Account", [entry(FD({ label: "=cmd()", apiName: "E" }), { start: startOf(), records: [] })], {});
    assert.ok(objectCsvText(evil).includes("'=cmd()"));
    assert.equal(objectCsvFileName("Account", "202601011200"), "flows_on_Account_202601011200.csv");
  });

  await test("flow object: Process Builder and scheduled flows give their object from their own contents", () => {
    const pb = startInfo({ processType: "Workflow", processMetadataValues: [{ name: "ObjectType", value: { stringValue: "Contact" } }, { name: "TriggerType", value: { stringValue: "onCreateOnly" } }] });
    assert.deepEqual([pb.object, pb.isProcess, pb.processTrigger], ["Contact", true, "onCreateOnly"]);
    assert.equal(startInfo({ processType: "Workflow", variables: [{ name: "myVariable_current", objectType: "Case" }] }).object, "Case");
    assert.equal(startInfo({ start: { object: "Lead", triggerType: "Scheduled" } }).object, "Lead");
    assert.equal(startInfo({ variables: [{ name: "myVariable_current", objectType: "Case" }] }).object, null); // not a process: not guessed
    assert.equal(startInfo(null).object, null);
  });

  await test("flow reads: the list asks for the trigger object's API name and the async-path flag, and drops a column the org rejects", async () => {
    const rec = { DurableId: "300000000000001AAA", ApiName: "F", Label: "F", ProcessType: "AutoLaunchedFlow", TriggerType: "RecordAfterSave", RecordTriggerType: "Update", IsActive: true,
      TriggerObjectOrEventLabel: "Account", TriggerObjectOrEvent: { QualifiedApiName: "Partner_Account__c" }, HasAsyncAfterCommitPath: true, TriggerOrder: 7, LastModifiedDate: "2026-01-01T00:00:00.000+0000" };
    const log = [];
    const defs = await readFlowList(fakeApi([[/FROM FlowDefinitionView/, () => [rec]]], log));
    assert.match(log[0].q, /TriggerObjectOrEvent\.QualifiedApiName/);
    assert.deepEqual([defs[0].triggerObject, defs[0].triggerObjectName, defs[0].hasAsyncPath, defs[0].triggerOrder], ["Account", "Partner_Account__c", true, 7]);
    const log2 = [];
    const api = fakeApi([[/TriggerObjectOrEvent\.Qualified/, () => ({ fail: "No such column 'TriggerObjectOrEvent' on entity 'FlowDefinitionView'", code: "INVALID_FIELD" })], [/FROM FlowDefinitionView/, () => [rec]]], log2);
    const again = await readFlowList(api);
    assert.equal(again.length, 1);
    assert.ok(log2.at(-1).q.includes("TriggerOrder") && !log2.at(-1).q.includes("TriggerObjectOrEvent."), "only the rejected column is left out");
    assert.equal(log2.length, 2);
  });

  await test("flow page: the object view runs when an object is picked, shares the cache, follows the tick box, and downloads its own CSV", () => {
    const page = text("tools/flow-usage/flow-usage.js");
    assert.match(page, /if \(it\.kind === "object"\) \{ setObject\(it\.o\); runObject\(it\.o\)/);
    assert.match(page, /kind: "object", object: o\.name/);
    assert.match(page, /target\.kind === "object" \? doRunObject/);
    assert.match(page, /readVersions\(\(id\) => source\.version\(id\), list, state\.cache/); // the same cache as the field search
    assert.match(page, /versionsToRead\(state\.defs, \{ includeInactive: \$\("#inactive"\)\.checked \}\)/);
    assert.ok(!/[Cc]reatedDate|state\.created|unconfirmed/.test(page + text("tools/flow-usage/flow-usage-object.js") + text("tools/flow-usage/flow-usage-read.js")), "no created-date read");
    assert.match(page, /objectCsvText\(state\.objectView\)/);
    assert.match(page, /if \(!field\) \{ runObject\(obj\)/); // from a record page or list view
    assert.ok(!/TriggerObjectOrEventLabel|\.triggerObject\b/.test(page), "the page never matches on a label");
    const lib = text("tools/flow-usage/flow-usage-object.js");
    assert.ok(!/\.triggerObject\b(?!Name)/.test(lib.replace(/\/\/.*$/gm, "").replace(/\/\*\*[\s\S]*?\*\//g, "")), "flow-usage-object.js never reads the label");
    const html = text("tools/flow-usage/flow-usage.html");
    for (const id of ["objectView", "objSummary", "objSections", "objDownload", "fieldView"]) assert.ok(html.includes(`id="${id}"`), id);
  });

  // ---------- guards ----------

  await test("flow files: no innerHTML, no storage, no write verbs, no outside hosts; the pure files stay pure", () => {
    const files = [["tools/flow-usage/flow-usage.js"], ["tools/flow-usage/flow-usage.html"], ["tools/flow-usage/flow-usage.css"], ["tools/flow-usage/flow-usage-scan.js"], ["tools/flow-usage/flow-usage-read.js"], ["shared/urlcontext.js"], ["tools/flow-usage/flow-usage-object.js"]];
    for (const f of files) {
      const t = text(...f);
      for (const bad of ["innerHTML", "insertAdjacentHTML", "outerHTML", "localStorage", "sessionStorage", "chrome.storage", "document.write", "eval("]) {
        assert.ok(!t.includes(bad), `${f.join("/")} uses ${bad}`);
      }
    }
    for (const f of ["tools/flow-usage/flow-usage-scan.js", "shared/urlcontext.js", "tools/flow-usage/flow-usage-object.js"]) {
      const t = text(...f.split("/"));
      for (const bad of ["document.", "window.", "fetch(", "chrome.", "location.", "XMLHttpRequest"]) assert.ok(!t.includes(bad), `${f} contains ${bad}`);
    }
    const read = text("tools/flow-usage/flow-usage-read.js");
    assert.ok(!/\b(INSERT|UPDATE|DELETE|UPSERT|POST|PATCH|PUT)\b/.test(read.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "flow-usage-read.js has a write verb");
    const page = text("tools/flow-usage/flow-usage.js");
    assert.ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)/i.test(page));
    assert.ok(!/https?:\/\/(?!\$\{HOST\})/.test(page.replace(/\/\/.*$/gm, "")), "the page names a host other than the org's");
    assert.ok(!/session/i.test(page.replace(/sessionId: "dev"/, "")) || !/(store|save|persist)/i.test(page.match(/.*session.*/gi).join(" ")));
  });

  await test("flow page: links, menu entry, feedback tool and version", () => {
    const popup = text("menu.js");
    assert.match(popup, /page: "tools\/flow-usage\/flow-usage\.html"[\s\S]*?title: "Where is it used in flows\?"[\s\S]*?description: "Find the flows that use an object, a field or a record Id"/);
    assert.match(popup, /contextQuery\(parseUrlContext\(tab\?\.url\)\)/);
    const html = text("tools/flow-usage/flow-usage.html");
    assert.ok(html.indexOf("shared/pack.css") < html.indexOf("flow-usage.css"));
    assert.ok(html.includes('id="feedback"'));
    const page = text("tools/flow-usage/flow-usage.js");
    assert.match(page, /FEEDBACK_TOOLS\.flows/);
    assert.match(page, /isSalesforceHost\(HOST\)/);
    assert.match(page, /builder_platform_interaction\/flowBuilder\.app\?flowId=/);
    assert.match(JSON.parse(text("manifest.json")).version, /^0\.([5-9]|\d\d)\.\d+$/);
    assert.match(JSON.parse(text("manifest.json")).description, /flow/);
    const run = readFileSync(path.join(here, "run_tests.mjs"), "utf-8");
    assert.ok(run.includes("flow_usage_tests.mjs"));
  });
}
