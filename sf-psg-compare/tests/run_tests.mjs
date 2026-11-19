// Offline tests. No org, no browser, no npm install:  node tests/run_tests.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { findSession, isSalesforceHost, SfApi, chunk, soqlString } from "../extension/lib/sfconn.js";
import { takeSnapshot, listPsgs, validateSnapshot, SNAPSHOT_SCHEMA } from "../extension/lib/snapshot.js";
import { compareSnapshots, toRows, toCsv, humanize, filterRows, givesCounts } from "../extension/lib/compare.js";
import { matchPsgs, searchWords } from "../extension/lib/pick.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = (n) => JSON.parse(readFileSync(path.join(here, "../extension/samples", n), "utf-8"));

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${e.stack.split("\n").slice(0, 3).join("\n       ")}`);
  }
}

// ---------- fakes ----------

function fakeCookies(list) {
  return {
    async get({ url, name }) {
      const host = new URL(url).hostname;
      return list.find((c) => c.name === name && c.domain.replace(/^\./, "") === host) || null;
    },
    async getAll({ name, domain }) {
      return list.filter((c) => c.name === name && c.domain.replace(/^\./, "").endsWith(domain));
    },
  };
}

/** Fake REST API: routes SOQL (decoded) to a handler that returns records. */
function fakeFetch(routes, log = []) {
  return async (url) => {
    const u = new URL(url);
    let body;
    if (u.pathname.endsWith("/sobjects/")) {
      body = { sobjects: [{ name: "Account", label: "Customer Account" }, { name: "Contact", label: "Contact" }] };
    } else if (u.pathname.endsWith("/describe/")) {
      const sobject = u.pathname.split("/").at(-3);
      body = routes.describe(sobject);
    } else if (u.pathname.includes("/query")) {
      const q = u.searchParams.get("q");
      log.push(q);
      const route = routes.query.find(([re]) => re.test(q));
      if (!route) return { ok: false, status: 400, text: async () => JSON.stringify([{ message: `no route for ${q}`, errorCode: "TEST" }]) };
      const records = route[1](q, u.pathname.includes("/tooling/"));
      body = { done: true, totalSize: records.totalSize ?? records.length, records: Array.isArray(records) ? records : [] };
    } else {
      throw new Error(`unexpected url ${url}`);
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

// ---------- sfconn ----------

console.log("sfconn");

await test("recognises Salesforce hosts", () => {
  for (const h of ["acme.lightning.force.com", "acme--dev.sandbox.my.salesforce.com", "acme.my.salesforce-setup.com", "na1.salesforce.com"]) {
    assert.ok(isSalesforceHost(h), h);
  }
  for (const h of ["example.com", "salesforce.com.evil.io", "", null]) assert.ok(!isSalesforceHost(h), String(h));
});

await test("finds the API session for a Lightning tab", async () => {
  const cookies = fakeCookies([
    { name: "sid", domain: "acme.lightning.force.com", value: "00DORG!lightning" },
    { name: "sid", domain: "help.salesforce.com", value: "00DORG!help" },
    { name: "sid", domain: "other.my.salesforce.com", value: "00DOTHER!x" },
    { name: "sid", domain: "acme.my.salesforce.com", value: "00DORG!api" },
  ]);
  const s = await findSession("acme.lightning.force.com", cookies);
  assert.deepEqual(s, { apiHost: "acme.my.salesforce.com", sessionId: "00DORG!api", orgId: "00DORG" });
});

await test("never picks a Lightning or Visualforce cookie as the API session", async () => {
  const cookies = fakeCookies([
    { name: "sid", domain: "acme--c.vf.force.com", value: "00DORG!vf" },
    { name: "sid", domain: "acme.lightning.force.com", value: "00DORG!lightning" },
  ]);
  const s = await findSession("acme--c.vf.force.com", cookies);
  assert.equal(s.apiHost, "acme--c.vf.force.com"); // falls back to the tab's own host
});

await test("explains a missing login", async () => {
  await assert.rejects(findSession("acme.lightning.force.com", fakeCookies([])), /Log in to the org/);
  await assert.rejects(findSession("example.com", fakeCookies([])), /Not a Salesforce host/);
});

await test("query follows nextRecordsUrl", async () => {
  const pages = {
    first: { done: false, totalSize: 3, nextRecordsUrl: "/services/data/v62.0/query/01g-2000", records: [{ n: 1 }, { n: 2 }] },
    next: { done: true, totalSize: 3, records: [{ n: 3 }] },
  };
  const seen = [];
  const api = new SfApi({
    apiHost: "acme.my.salesforce.com", sessionId: "S",
    fetchImpl: async (url, opts) => {
      seen.push([url, opts.headers.Authorization]);
      const body = url.includes("01g-2000") ? pages.next : pages.first;
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });
  const res = await api.query("SELECT Id FROM Account");
  assert.deepEqual(res.records.map((r) => r.n), [1, 2, 3]);
  assert.equal(seen.length, 2);
  assert.ok(seen[1][0].startsWith("https://acme.my.salesforce.com/services/data/v62.0/query/01g-2000"));
  assert.equal(seen[0][1], "Bearer S");
});

await test("401 gives a readable message", async () => {
  const api = new SfApi({
    apiHost: "x.my.salesforce.com", sessionId: "S",
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => JSON.stringify([{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }]) }),
  });
  await assert.rejects(api.query("SELECT Id FROM User"), /Reload the Salesforce tab/);
});

await test("soqlString escapes quotes and backslashes; chunk splits", () => {
  assert.equal(soqlString("O'Brien\\x"), "'O\\'Brien\\\\x'");
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

// ---------- snapshot ----------

console.log("snapshot");

// 250 boolean Permissions* fields, so the user-permission read needs 3 queries of 120.
const PS_FIELDS = Array.from({ length: 250 }, (_, i) => ({ name: `PermissionsP${String(i).padStart(3, "0")}`, label: `Perm ${i}`, type: "boolean" }));
PS_FIELDS.push({ name: "PermissionsModifyAllData", label: "Modify All Data", type: "boolean" });
PS_FIELDS.push({ name: "Name", label: "Name", type: "string" });
const OP_FIELDS = ["Read", "Create", "Edit", "Delete", "ViewAllRecords", "ModifyAllRecords"].map((f) => ({ name: `Permissions${f}`, label: f, type: "boolean" }));

function snapshotRoutes({ status = "Updated" } = {}) {
  const AGG = "0PSAGG000000001AAA";
  const MUTE = "0PSMUTE00000001AAA";
  return {
    describe: (s) => ({ fields: s === "PermissionSet" ? PS_FIELDS : s === "ObjectPermissions" ? OP_FIELDS : [] }),
    query: [
      [/FROM PermissionSetGroup WHERE Id/, () => [{ Id: "0PG1", DeveloperName: "Sales", MasterLabel: "Sales", NamespacePrefix: null, Description: "d", Status: status }]],
      [/FROM PermissionSetGroup ORDER BY/, () => [{ Id: "0PG1", DeveloperName: "Sales", MasterLabel: "Sales", NamespacePrefix: "ns", Status: "Updated" }]],
      [/FROM PermissionSet WHERE PermissionSetGroupId/, () => [{ Id: AGG, Type: "Group" }]],
      [/FROM PermissionSetGroupComponent/, () => [{ PermissionSetId: "0PSC1" }, { PermissionSetId: MUTE }]],
      [/FROM PermissionSet WHERE Id IN/, () => [
        { Id: "0PSC1", Name: "Core", Label: "Core", Type: "Regular", NamespacePrefix: null, LicenseId: "100LIC" },
        { Id: MUTE, Name: "Sales_Muting", Label: "Sales Muting", Type: "Muting", NamespacePrefix: null, LicenseId: null },
      ]],
      [/FROM UserLicense/, () => [{ Id: "100LIC", Name: "Salesforce" }]],
      [/FROM PermissionSetLicense/, () => []],
      [/FROM PermissionSet WHERE Id = /, (q) => {
        const rec = { Id: q.includes(MUTE) ? MUTE : AGG };
        if (q.includes(MUTE)) { if (q.includes("PermissionsP005")) rec.PermissionsP005 = true; }
        else {
          for (const f of ["PermissionsP001", "PermissionsP200", "PermissionsModifyAllData"]) if (q.includes(f)) rec[f] = true;
          if (q.includes("PermissionsP002")) rec.PermissionsP002 = false;
        }
        return [rec];
      }],
      [/FROM ObjectPermissions/, (q) => q.includes(MUTE) ? [] : [
        { SobjectType: "Account", PermissionsRead: true, PermissionsCreate: false, PermissionsEdit: true, PermissionsDelete: false, PermissionsViewAllRecords: false, PermissionsModifyAllRecords: false },
      ]],
      [/FROM FieldPermissions/, (q) => q.includes(MUTE) ? [] : [{ Field: "Account.Industry", PermissionsRead: true, PermissionsEdit: false }]],
      [/FROM SetupEntityAccess/, () => [
        { SetupEntityId: "01pAAA000000001AAA", SetupEntityType: "ApexClass" },
        { SetupEntityId: "0CPAAA000000001AAA", SetupEntityType: "CustomPermission" },
        { SetupEntityId: "0XYAAA000000001AAA", SetupEntityType: "MysteryType" },
      ]],
      [/FROM ApexClass/, () => [{ Id: "01pAAA000000001", Name: "Svc", NamespacePrefix: "acme" }]], // 15-char Id on purpose
      [/FROM CustomPermission/, () => [{ Id: "0CPAAA000000001AAA", DeveloperName: "Can_Do", NamespacePrefix: null, MasterLabel: "Can Do" }]],
      [/FROM PermissionSetTabSetting/, () => [{ Name: "standard-Account", Visibility: "DefaultOn" }]],
      [/SELECT COUNT\(\) FROM PermissionSetAssignment .*IsActive/, () => Object.assign([], { totalSize: 7 })],
      [/SELECT COUNT\(\) FROM PermissionSetAssignment/, () => Object.assign([], { totalSize: 9 })],
    ],
  };
}

function apiWith(routes, log) {
  return new SfApi({ apiHost: "acme.my.salesforce.com", sessionId: "S", fetchImpl: fakeFetch(routes, log) });
}

await test("takeSnapshot reads the aggregate permission set into a plain snapshot", async () => {
  const log = [];
  const steps = [];
  const s = await takeSnapshot(apiWith(snapshotRoutes(), log), "0PG1", { org: { id: "00D1", name: "Acme" }, progress: (t) => steps.push(t) });
  assert.equal(s.schema, SNAPSHOT_SCHEMA);
  assert.equal(s.psg.developerName, "Sales");
  assert.deepEqual(Object.keys(s.userPermissions).sort(), ["PermissionsModifyAllData", "PermissionsP001", "PermissionsP200"]);
  assert.equal(s.userPermissions.PermissionsModifyAllData, "Modify All Data");
  assert.deepEqual(s.objectPermissions.Account, { Read: true, Create: false, Edit: true, Delete: false, ViewAllRecords: false, ModifyAllRecords: false });
  assert.deepEqual(s.fieldPermissions["Account.Industry"], { Read: true, Edit: false });
  assert.deepEqual(s.tabSettings, { "standard-Account": "DefaultOn" });
  assert.deepEqual(s.assignments, { total: 9, active: 7 });
  assert.equal(s.components.length, 2);
  assert.equal(s.components.find((c) => c.name === "Core").licence, "Salesforce");
  assert.equal(s.muting.name, "Sales_Muting");
  assert.deepEqual(Object.keys(s.muting.userPermissions), ["PermissionsP005"]);
  assert.ok(steps.length >= 2);
  // permission fields are split so no single query gets too long
  const userPermQueries = log.filter((q) => q.includes("FROM PermissionSet WHERE Id = '0PSAGG"));
  assert.equal(userPermQueries.length, 3);
  assert.ok(log.every((q) => q.length < 6000), "every SOQL stays short");
});

await test("setup access is named across 15/18-character Ids; unknown types are kept with a warning", async () => {
  const s = await takeSnapshot(apiWith(snapshotRoutes()), "0PG1");
  assert.ok(s.setupAccess["ApexClass|acme__Svc"], JSON.stringify(Object.keys(s.setupAccess)));
  assert.equal(s.setupAccess["CustomPermission|Can_Do"].label, "Can Do");
  assert.ok(s.setupAccess["MysteryType|0XYAAA000000001AAA"]);
  assert.ok(s.warnings.some((w) => /1 mystery type could not be named in this org.*listed by Id/.test(w)), s.warnings.join("; "));
  assert.equal(s.setupAccess["MysteryType|0XYAAA000000001AAA"].byId, true);
});

await test("a group that is not Updated gets a warning", async () => {
  const s = await takeSnapshot(apiWith(snapshotRoutes({ status: "Outdated" })), "0PG1");
  assert.ok(s.warnings.some((w) => w.startsWith("Status is Outdated")));
});

await test("listPsgs qualifies namespaced names", async () => {
  const list = await listPsgs(apiWith(snapshotRoutes()));
  assert.deepEqual(list, [{ id: "0PG1", developerName: "ns__Sales", label: "Sales", status: "Updated" }]);
});

await test("validateSnapshot accepts the samples and rejects other JSON", () => {
  validateSnapshot(sample("sample_a.json"));
  validateSnapshot(sample("sample_b.json"));
  assert.throws(() => validateSnapshot({ hello: 1 }), /Not a PSG snapshot/);
  const broken = sample("sample_a.json");
  delete broken.fieldPermissions;
  assert.throws(() => validateSnapshot(broken), /missing "fieldPermissions"/);
});

// ---------- compare ----------

console.log("compare");

const A = sample("sample_a.json"); // Sales Rep
const B = sample("sample_b.json"); // Sales Manager
const R = compareSnapshots(A, B);
const row = (sec, key) => R.sections[sec].find((r) => r.key === key);
const texts = R.highlights.map((h) => h.text);

await test("system permissions: only-B high-risk permission is a headline", () => {
  assert.equal(row("userPermissions", "PermissionsViewAllData").status, "onlyB");
  assert.equal(row("userPermissions", "PermissionsViewAllData").highRisk, true);
  assert.equal(row("userPermissions", "PermissionsApiEnabled").status, "same");
  assert.ok(texts.includes("Only Sales Manager has “View All Data”."), texts.join("\n"));
});

await test("objects: flag-level differences in both directions", () => {
  const opp = row("objectPermissions", "Opportunity");
  assert.equal(opp.status, "differ");
  assert.deepEqual(opp.bExtra, ["Delete", "ViewAllRecords", "ModifyAllRecords"]);
  assert.deepEqual(opp.aExtra, []);
  assert.equal(row("objectPermissions", "Campaign").status, "onlyA");
  assert.equal(row("objectPermissions", "Quota__c").status, "onlyB");
  assert.equal(row("objectPermissions", "Widget__c").status, "same");
  assert.ok(texts.some((t) => /^Sales Manager has View All or Modify All on 2 objects where Sales Rep has less.*Opportunity/.test(t)), texts.join("\n"));
});

await test("fields: read vs edit", () => {
  const f = row("fieldPermissions", "Account.AnnualRevenue");
  assert.equal(f.status, "differ");
  assert.equal(f.a, "Read");
  assert.equal(f.b, "Edit");
  assert.equal(row("fieldPermissions", "Campaign.BudgetedCost").status, "onlyA");
  assert.equal(row("fieldPermissions", "Account.Industry").status, "same");
});

await test("contents, setup access and tabs", () => {
  assert.equal(row("components", "Team_Oversight").status, "onlyB");
  assert.equal(row("components", "Sales_Rep_Muting").group, "Muting permission set");
  assert.equal(row("components", "Sales_Core").status, "same");
  const muted = R.sections.components.filter((r) => r.part === "muted");
  const mOpp = muted.find((r) => r.key === "Opportunity");
  assert.deepEqual([mOpp.status, mOpp.a, mOpp.label, mOpp.kind], ["onlyA", "Removed: Delete", "Opportunity", "Object"]);
  assert.equal(muted.find((r) => r.label === "Export Reports").a, "Removed");
  assert.equal(muted.find((r) => r.label === "Export Reports").kind, "General permission");
  assert.ok(muted.some((r) => r.label === "Export Reports"));
  assert.equal(muted.find((r) => r.key === "Account.AnnualRevenue").label, "Account › Annual Revenue");
  assert.equal(row("setupAccess", "Approve_Discounts").status, "onlyB");
  assert.equal(row("tabs", "Widget__c").status, "differ");
  assert.equal(row("tabs", "standard-Campaign").status, "onlyA");
});

await test("overview and verdict", () => {
  assert.equal(row("overview", "Users assigned").a, "398 active (412 in total)");
  assert.equal(row("overview", "Muting permission set").b, "None");
  assert.ok(texts.includes(`Each group gives access the other does not: Sales Rep gives ${R.gives.a} items of access Sales Manager doesn't; Sales Manager gives ${R.gives.b} items of access Sales Rep doesn't.`), texts.join("\n"));
  assert.ok(R.gives.a > 0 && R.gives.b > R.gives.a);
  assert.equal(R.counts.userPermissions.onlyB, 5);
});

await test("a group compared with itself is identical", () => {
  const same = compareSnapshots(A, structuredClone(A));
  assert.equal(same.highlights.find((h) => h.level === "good")?.text, "Both groups give exactly the same access.");
  for (const k of ["userPermissions", "objectPermissions", "fieldPermissions", "setupAccess", "tabs", "components"]) {
    assert.equal(same.counts[k].same, same.counts[k].total, k);
  }
});

await test("superset is detected", () => {
  const bigger = structuredClone(A);
  bigger.psg.label = "Rep Plus";
  bigger.userPermissions.PermissionsManageUsers = "Manage Users";
  const r = compareSnapshots(bigger, A);
  assert.ok(r.highlights.some((h) => h.text === "Rep Plus gives everything Sales Rep gives, and more (1 item of access that Sales Rep does not)."));
  assert.ok(r.highlights.some((h) => h.level === "risk" && h.text === "Only Rep Plus has “Manage Users”."));
});

await test("different orgs are called out", () => {
  const other = structuredClone(B);
  other.org = { id: "00D999", name: "Prod", isSandbox: false };
  const r = compareSnapshots(A, other);
  assert.ok(r.highlights.some((h) => h.kind === "note" && h.text.startsWith("The groups come from different orgs")));
});

await test("all-false object rows on both sides are dropped", () => {
  const x = structuredClone(A);
  const y = structuredClone(A);
  x.objectPermissions.Ghost__c = { Read: false, Edit: false };
  assert.equal(compareSnapshots(x, y).sections.objectPermissions.find((r) => r.key === "Ghost__c"), undefined);
});

await test("CSV export: BOM, header, escaping, one section", () => {
  const all = toRows(R);
  assert.deepEqual(all[0].slice(0, 5), ["Section", "Group", "Item", "API name", "Difference"]);
  const csv = toCsv([["a,b", 'say "hi"', "line\nbreak", "plain"]]);
  assert.equal(csv, '﻿"a,b","say ""hi""","line\nbreak",plain\r\n');
  const objs = toRows(R, "objectPermissions");
  assert.ok(objs.slice(1).every((r) => r[0] === "Objects"));
  const opp = objs.find((r) => r[3] === "Opportunity");
  assert.equal(opp[8], "Delete, View All, Modify All");
  assert.equal(opp[4], "Different");
});


// ---------- new on-screen behaviour ----------

console.log("lists, highlights, downloads");

/** Two groups where A has View All / Modify All on many objects, B on none. */
function heavyPair() {
  const mk = (label) => ({
    ...structuredClone(A), psg: { ...A.psg, label, developerName: label.replace(/ /g, "_") },
    userPermissions: {}, objectPermissions: {}, fieldPermissions: {}, setupAccess: {}, tabs: {}, tabSettings: {},
    components: [], muting: null, warnings: [], objectLabels: {}, fieldLabels: {},
  });
  const x = mk("Big Group");
  const y = mk("Small Group");
  for (let i = 0; i < 12; i++) x.objectPermissions[`Thing${i}__c`] = { Read: true, Delete: true, ViewAllRecords: i % 2 === 0, ModifyAllRecords: i === 0 };
  x.objectPermissions.Account = { Read: true, ViewAllRecords: true };
  y.objectPermissions.Account = { Read: true };
  x.objectPermissions.Case = { Read: true, Delete: true }; // Delete alone is not a headline
  y.objectPermissions.Case = { Read: true };
  x.objectPermissions.Lead = { Read: true, ViewAllRecords: true };
  y.objectPermissions.Lead = { Read: true };
  y.objectPermissions.Zed__c = { Read: true, ModifyAllRecords: true };
  for (const k of ["PermissionsExportReport", "PermissionsManageUsers"]) x.userPermissions[k] = k;
  for (const n of ["F1", "F2"]) x.fieldPermissions[`Account.${n}`] = { Read: true, Edit: true };
  y.fieldPermissions["Account.F2"] = { Read: true }; // A has more
  y.fieldPermissions["Account.F3"] = { Read: true }; // only B
  return compareSnapshots(x, y);
}

await test("highlights: general permissions first, objects condensed to one line per side", () => {
  const h = heavyPair().highlights.filter((x) => x.kind === "risk");
  assert.deepEqual(h.map((x) => x.area), ["general", "general", "objects", "objects"]);
  const a = h[2].text;
  // Thing0,2,4,6,8,10 + Account + Lead = 8 objects with View All or Modify All
  assert.ok(a.startsWith("Big Group has View All or Modify All on 8 objects where Small Group has less, including Account, Lead and Thing0"), a);
  assert.ok(a.endsWith("See Objects."));
  assert.ok(!a.includes("Case"));
  assert.equal(h[3].text, "Small Group has View All or Modify All on the object Zed, where Big Group has less. See Objects.");
});

await test("verdict counts what each group gives that the other does not", () => {
  const r = heavyPair();
  // A: 2 general permissions + 14 objects (12 Thing, Account, Case, Lead = 15) + fields F1, F2
  // B: Zed__c + Account.F3
  assert.deepEqual(r.gives, { a: 2 + 15 + 2, b: 2 });
  assert.equal(r.highlights.find((x) => x.kind === "verdict").text,
    "Each group gives access the other does not: Big Group gives 19 items of access Small Group doesn't; Small Group gives 2 items of access Big Group doesn't.");
  assert.deepEqual(givesCounts(compareSnapshots(A, structuredClone(A)).sections), { a: 0, b: 0 });
  assert.ok(compareSnapshots(A, structuredClone(A)).highlights[0].text.startsWith("Both groups"));
});

await test("objects line: Modify All added on top of View All still reads as 'has less'", () => {
  const x = structuredClone(A);
  const y = structuredClone(A);
  x.objectPermissions.Case = { Read: true, ViewAllRecords: true, ModifyAllRecords: true };
  y.objectPermissions.Case = { Read: true, ViewAllRecords: true };
  const t = compareSnapshots(x, y).highlights.find((h) => h.area === "objects").text;
  assert.ok(/^Sales Rep has View All or Modify All on the object Case, where .* has less\./.test(t), t);
});

await test("fields: a difference says which side has more", () => {
  const f2 = heavyPair().sections.fieldPermissions.find((x) => x.key === "Account.F2");
  assert.deepEqual([f2.status, f2.more], ["differ", "a"]);
});

await test("permission sets show Included, licence as secondary text; counts are split", () => {
  const sets = R.sections.components.filter((x) => x.part === "sets");
  assert.ok(sets.every((x) => x.a === null || x.a === "Included"));
  assert.ok(sets.some((x) => x.aSub === "Salesforce licence" || x.bSub === "Salesforce licence"), JSON.stringify(sets));
  const regular = sets.filter((x) => x.group !== "Muting permission set");
  assert.equal(R.counts.componentSets.total, regular.length);
  assert.equal(R.counts.componentMutingSet.total, sets.length - regular.length);
  assert.ok(R.counts.componentMutingSet.total > 0); // the sample groups have a muting permission set
  assert.equal(R.counts.componentSets.total + R.counts.componentMutingSet.total + R.counts.componentMuted.total, R.counts.components.total);
});

await test("muted item on both sides with different values is Different, not Same", () => {
  const x = structuredClone(A);
  const y = structuredClone(A);
  x.muting.effective.fieldPermissions = { "Account.AnnualRevenue": { Read: true, Edit: true } };
  y.muting.effective.fieldPermissions = { "Account.AnnualRevenue": { Read: true } };
  const m = compareSnapshots(x, y).sections.components.find((r) => r.part === "muted" && r.key === "Account.AnnualRevenue");
  assert.deepEqual([m.status, m.a, m.b, m.kind], ["differ", "Removed: Read, Edit", "Removed: Read", "Field"]);
});

await test("filterRows and CSV follow differences-only and search", () => {
  const rows = R.sections.objectPermissions;
  assert.ok(filterRows(rows, { section: "objectPermissions", diffOnly: true }).every((r) => r.status !== "same"));
  assert.ok(filterRows(rows, { section: "objectPermissions" }).length > filterRows(rows, { diffOnly: true }).length);
  assert.equal(filterRows(R.sections.overview, { section: "overview", diffOnly: true }).length, R.sections.overview.length);
  assert.ok(toRows(R, "fieldPermissions", { diffOnly: true }).length < toRows(R, "fieldPermissions").length);
  const s = toRows(R, "fieldPermissions", { search: "account › annual" });
  assert.ok(s.length > 1 && s.slice(1).every((r) => /Annual/.test(r[2])));
  assert.ok(toRows(R, null, { diffOnly: true }).slice(1).every((r) => r[0] === "Summary" || r[4] !== "Same"));
  const kinds = toRows(R, "components").filter((r) => r[1] === "Taken away by muting").map((r) => r[9]);
  assert.ok(kinds.length && kinds.every((k) => ["Object", "Field", "General permission", "Tab", "App, page or code"].includes(k)), kinds.join());
});

await test("search treats punctuation as a separator", () => {
  assert.deepEqual(searchWords("Account › Annual_Revenue"), ["account", "annual", "revenue"]);
  const n = filterRows(R.sections.fieldPermissions, { search: "Account › Annual" }).length;
  assert.ok(n > 0);
  assert.equal(n, filterRows(R.sections.fieldPermissions, { search: "account annual" }).length);
  assert.equal(matchPsgs([{ id: "1", label: "US Sales", developerName: "US_Sales" }], "us-sales").total, 1);
});

// ---------- muting, labels, setup names (snapshot v2) ----------

const AGGID = "0PSAGG000000001AAA";
const MUTEID = "0QMMUTE0000001AAA";
const C1 = "0PSCOMP00000001AAA";
const C2 = "0PSCOMP00000002AAA";

/** A group whose muting set mutes things that are, and are not, really taken away. */
function mutingRoutes() {
  const isMute = (q) => q.includes(`ParentId = '${MUTEID}'`) || q.includes(`Id = '${MUTEID}'`);
  const isAgg = (q) => q.includes(`ParentId = '${AGGID}'`) || q.includes(`Id = '${AGGID}'`);
  return {
    describe: (s) => ({ fields: s === "PermissionSet" || s === "MutingPermissionSet" ? PS_FIELDS : s === "ObjectPermissions" ? OP_FIELDS : [] }),
    query: [
      [/FROM PermissionSetGroup WHERE Id/, () => [{ Id: "0PG1", DeveloperName: "G", MasterLabel: "G", Status: "Updated" }]],
      [/FROM PermissionSet WHERE PermissionSetGroupId/, () => [{ Id: AGGID, Type: "Group" }]],
      [/FROM PermissionSetGroupComponent/, () => [{ PermissionSetId: C1 }, { PermissionSetId: C2 }, { PermissionSetId: MUTEID }]],
      [/SELECT Id, Name, Label.*FROM PermissionSet WHERE Id IN/, () => [
        { Id: C1, Name: "One", Label: " One  ", Type: "Regular" }, { Id: C2, Name: "Two", Label: "Two", Type: "Regular" },
        { Id: MUTEID, Name: "Mute", Label: "Mute", Type: "Muting" },
      ]],
      // what the components give, read for the muted permissions only
      [/FROM PermissionSet WHERE Id IN/, (q) => {
        assert.ok(q.includes(C1) && q.includes(C2) && !q.includes(MUTEID), q);
        assert.ok(!q.includes("PermissionsP002"), "only muted permissions are read: " + q);
        return [{ Id: C1, PermissionsP005: true, PermissionsP001: true, PermissionsModifyAllData: false }, { Id: C2, PermissionsP005: false }];
      }],
      [/FROM PermissionSet WHERE Id = /, (q) => {
        const rec = { Id: isMute(q) ? MUTEID : AGGID };
        const on = isMute(q) ? ["PermissionsP005", "PermissionsP001", "PermissionsModifyAllData"] : ["PermissionsP001"];
        for (const f of on) if (q.includes(f)) rec[f] = true;
        return [rec];
      }],
      [/FROM ObjectPermissions/, (q) => {
        const row = (o, ...on) => ({ SobjectType: o, ...Object.fromEntries(OP_FIELDS.map((f) => [f.name, on.includes(f.name)])) });
        if (isMute(q)) return [row("Account", "PermissionsDelete"), row("Order", "PermissionsEdit")];
        if (isAgg(q)) return [row("Account", "PermissionsRead"), row("Order", "PermissionsRead", "PermissionsEdit")];
        return [row("Account", "PermissionsRead", "PermissionsDelete"), row("Order", "PermissionsRead", "PermissionsEdit")]; // components
      }],
      [/FROM FieldPermissions/, (q) => {
        const f = (Field, PermissionsRead, PermissionsEdit) => ({ Field, PermissionsRead, PermissionsEdit });
        if (isMute(q)) return [f("Account.F1__c", true, true), f("Account.F2__c", false, true), f("Account.F3__c", true, false), f("Account.F4__c", false, true), f("Account.F5__c", true, false)];
        if (isAgg(q)) return [f("Account.F2__c", true, false), f("Account.Plain__c", true, false)];
        return [f("Account.F1__c", true, true), f("Account.F2__c", true, true), f("Account.F4__c", true, true), f("Account.F5__c", true, true)]; // F3 is given by no component
      }],
      [/FROM PermissionSetTabSetting/, (q) => {
        if (isMute(q)) return [{ Name: "LogEntry__c", Visibility: "DefaultOff" }, { Name: "standard-Visit", Visibility: "DefaultOff" }];
        if (isAgg(q)) return [{ Name: "standard-Account", Visibility: "DefaultOn" }];
        return [{ Name: "LogEntry__c", Visibility: "DefaultOn" }];
      }],
      [/FROM SetupEntityAccess/, () => []],
      [/FROM FieldDefinition/, () => [
        { QualifiedApiName: "F1__c", Label: "  Customer   Segmentation ", EntityDefinition: { QualifiedApiName: "Account" } },
        { QualifiedApiName: "Plain__c", Label: "Plain", EntityDefinition: { QualifiedApiName: "Account" } },
        { QualifiedApiName: "NotAsked__c", Label: "Nobody asked", EntityDefinition: { QualifiedApiName: "Account" } },
      ]],
      [/SELECT COUNT\(\) FROM PermissionSetAssignment/, () => Object.assign([], { totalSize: 1 })],
    ],
  };
}

await test("muting: only what is given by a component and missing from the aggregate counts as taken away", async () => {
  const s = await takeSnapshot(apiWith(mutingRoutes()), "0PG1");
  const e = s.muting.effective;
  // general permissions: P005 yes; Modify All Data given by nobody; P001 muted but the aggregate still has it
  assert.deepEqual(Object.keys(e.userPermissions), ["PermissionsP005"]);
  // objects: Account loses Delete only; Order keeps Edit although muted (the Salesforce quirk)
  assert.deepEqual(e.objectPermissions, { Account: { Delete: true } });
  // fields: a Read mute takes Read and Edit; an Edit mute takes Edit only; F3 is given by nobody
  assert.deepEqual(e.fieldPermissions, { "Account.F1__c": { Read: true, Edit: true }, "Account.F2__c": { Read: false, Edit: true },
    // F4: Edit-only mute, aggregate has neither flag: Read must not be reported removed
    "Account.F4__c": { Read: false, Edit: true },
    // F5: Read-only mute, aggregate has neither flag: Edit goes too
    "Account.F5__c": { Read: true, Edit: true } });
  // tabs: LogEntry__c is shown by a component and absent from the aggregate; standard-Visit is given by nobody
  assert.deepEqual(e.tabSettings, { LogEntry__c: "DefaultOn" });
  assert.equal(e.nothingToTake, 5); // Modify All Data, P001, Order, F3, Visit
  assert.deepEqual(Object.keys(s.muting.tabSettings).sort(), ["LogEntry__c", "standard-Visit"]);
  assert.equal(s.components.find((c) => c.name === "One").label, "One");
});

await test("muting: compare lists only effective items, in plain words, plus one line for the rest", async () => {
  const s = await takeSnapshot(apiWith(mutingRoutes()), "0PG1");
  const r = compareSnapshots(s, s);
  const muted = r.sections.components.filter((x) => x.part === "muted");
  const got = muted.map((x) => `${x.label}: ${x.a}`).sort();
  assert.deepEqual(got, [
    "Customer Account: Removed: Delete",
    "Customer Account › Customer Segmentation: Removed: Read, Edit",
    "Customer Account › F2: Removed: Edit",
    "Customer Account › F4: Removed: Edit",
    "Customer Account › F5: Removed: Read, Edit",
    "Log Entry (tab): Removed",
    "Perm 5: Removed",
  ].sort());
  const note = r.highlights.find((h) => h.text.includes("had nothing to take away"));
  assert.ok(note && note.text.includes("5 other items"), JSON.stringify(r.highlights));
});

await test("v1 snapshots still load and compare; their muted items do not claim removal", () => {
  const v1 = structuredClone(sample("sample_a.json"));
  v1.schema = "sf-psg-snapshot/1";
  delete v1.muting.effective;
  delete v1.muting.tabSettings;
  delete v1.fieldLabels;
  validateSnapshot(v1);
  const r = compareSnapshots(v1, sample("sample_b.json"));
  const muted = r.sections.components.filter((x) => x.part === "muted");
  assert.ok(muted.length >= 3);
  // only the old file's side says "may not have been given"
  assert.ok(muted.filter((x) => x.a !== null).every((x) => x.legacy), "A side is legacy");
  assert.ok(muted.filter((x) => x.a === null).every((x) => !x.legacy), "B side is not");
  assert.deepEqual(r.mutedLegacy, { a: true, b: false });
  assert.ok(toRows(r).some((x) => x[1] === "Muted (may not have been given)"));
  assert.equal(r.sections.fieldPermissions.find((x) => x.key === "Account.AnnualRevenue").label, "Annual Revenue");
});

await test("field labels come from the org in one query; a failed read falls back to API names with one warning", async () => {
  const log = [];
  const s = await takeSnapshot(apiWith(mutingRoutes(), log), "0PG1");
  assert.deepEqual(s.fieldLabels, { "Account.F1__c": "Customer Segmentation", "Account.Plain__c": "Plain" });
  assert.equal(log.filter((q) => q.includes("FROM FieldDefinition")).length, 1);
  assert.equal(compareSnapshots(s, s).sections.fieldPermissions.find((x) => x.key === "Account.Plain__c").label, "Plain");

  const routes = mutingRoutes();
  routes.query.unshift([/FROM FieldDefinition/, () => { throw new Error("boom"); }]);
  const bad = await takeSnapshot(apiWith(routes), "0PG1");
  assert.deepEqual(bad.fieldLabels, {});
  assert.equal(bad.warnings.filter((w) => w.includes("field names could not be read")).length, 1);
  assert.equal(compareSnapshots(bad, bad).sections.fieldPermissions.find((x) => x.key === "Account.Plain__c").label, "Plain");
});

await test("component permission sets are read in chunks, not one huge IN list", async () => {
  const ids = Array.from({ length: 450 }, (_, i) => `0PSC${String(i).padStart(11, "0")}AAA`);
  const routes = snapshotRoutes();
  routes.query.unshift([/FROM PermissionSetGroupComponent/, () => ids.map((PermissionSetId) => ({ PermissionSetId }))]);
  routes.query.unshift([/FROM PermissionSet WHERE Id IN/, (q) => {
    const found = q.match(/'\w+'/g) || [];
    assert.ok(found.length <= 200, `${found.length} ids in one query`);
    return found.map((x) => ({ Id: x.slice(1, -1), Name: "N" + x.slice(1, -1), Label: "L", Type: "Regular" }));
  }]);
  const log = [];
  const s = await takeSnapshot(apiWith(routes, log), "0PG1");
  assert.equal(s.components.length, 450);
  assert.equal(log.filter((q) => q.includes("FROM PermissionSet WHERE Id IN")).length, 3);
});

await test("external credential principals are read through the Tooling API; unnamed items are listed by Id with a plain warning", async () => {
  const routes = snapshotRoutes();
  const seen = [];
  routes.query.unshift([/FROM SetupEntityAccess/, () => [
    { SetupEntityId: "0puAAA000000001AAA", SetupEntityType: "ExternalCredentialParameter" },
    { SetupEntityId: "0puAAA000000002AAA", SetupEntityType: "ExternalCredentialParameter" },
    { SetupEntityId: "0puAAA000000003AAA", SetupEntityType: "ExternalCredentialParameter" },
    { SetupEntityId: "0xIAAA000000001AAA", SetupEntityType: "ExternalClientApplication" },
  ]]);
  routes.query.unshift([/FROM ExternalCredentialParameter/, (q, tooling) => {
    seen.push(tooling);
    return [{ Id: "0puAAA000000001AAA", ParameterName: "Auth", ExternalCredential: { DeveloperName: "Cred_One" } }];
  }]);
  routes.query.unshift([/FROM ExternalClientApplication/, (q, tooling) => {
    assert.ok(!tooling);
    return [{ Id: "0xIAAA000000001AAA", DeveloperName: "Sync_App", NamespacePrefix: null, MasterLabel: "Sync App" }];
  }]);
  const s = await takeSnapshot(apiWith(routes), "0PG1");
  assert.deepEqual(seen, [true]);
  assert.equal(s.setupAccess["ExternalCredentialParameter|Cred_One.Auth"].typeLabel, "External credential principal");
  assert.equal(s.setupAccess["ExternalClientApplication|Sync_App"].label, "Sync App");
  assert.equal(Object.values(s.setupAccess).filter((e) => e.byId).length, 2);
  assert.ok(s.warnings.includes("2 external credential principals could not be named in this org; they are listed by Id, which differs between orgs."), s.warnings.join("\n"));
  const row = compareSnapshots(s, s).sections.setupAccess.find((x) => x.key === "0puAAA000000002AAA");
  assert.equal(row.label, "Name not available (Id 0puAAA000000002AAA)");
  assert.equal(row.group, "External credential principal");
});

await test("humanize never splits an Id; namespaces are dropped from setup labels; labels are trimmed", () => {
  assert.equal(humanize("0puZz0000000AbCDEF"), "0puZz0000000AbCDEF");
  assert.equal(humanize("01pZz0000000AbC"), "01pZz0000000AbC");
  assert.equal(humanize("acme__Widget_Page_Nearby"), "Widget Page Nearby");
  assert.equal(humanize("zeta__Phone_Check_Validation"), "Phone Check Validation");
  assert.equal(humanize("Quota__c"), "Quota");
  const a = structuredClone(A);
  a.setupAccess["ApexClass|acme__Nearby_Lookup"] = { type: "ApexClass", typeLabel: "Apex class", name: "acme__Nearby_Lookup", label: null };
  a.objectLabels = { Widget__c: "  Data Action   Job Summary " };
  a.fieldLabels = { "Account.Rating": " Spaced   Out " };
  const r = compareSnapshots(a, B);
  assert.equal(r.sections.setupAccess.find((x) => x.key === "acme__Nearby_Lookup").label, "Nearby Lookup");
  assert.equal(r.sections.objectPermissions.find((x) => x.key === "Widget__c").label, "Data Action Job Summary");
  assert.equal(r.sections.fieldPermissions.find((x) => x.key === "Account.Rating").label, "Spaced Out");
});

await test("CSV export neutralises cells that would run as formulas in Excel", () => {
  const csv = toCsv([["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tx", "\rx", "safe=1", 5, "-"]]);
  assert.equal(csv, "﻿'=1+1,'+cmd,'-2+3,'@SUM(A1),'\tx,\"'\rx\",safe=1,5,'-\r\n");
});

// ---------- friendly names and search ----------

console.log("names and search");

await test("humanize turns API names into words", () => {
  assert.equal(humanize("Account_to_Account_Relation__c"), "Account to Account Relation");
  assert.equal(humanize("AnnualRevenue"), "Annual Revenue");
  assert.equal(humanize("acme__Widget_Size__c"), "Widget Size");
  assert.equal(humanize("GnrcVstKeyPerformanceInd"), "Gnrc Vst Key Performance Ind");
  assert.equal(humanize("Quota__mdt"), "Quota");
});

await test("object labels from the org are used when the snapshot has them", () => {
  const a = structuredClone(A);
  a.objectLabels = { Widget__c: "Gadget" };
  const r = compareSnapshots(a, B);
  assert.equal(r.sections.objectPermissions.find((x) => x.key === "Widget__c").label, "Gadget");
  assert.equal(r.sections.fieldPermissions.find((x) => x.key === "Widget__c.Color__c").group, "Gadget");
  assert.equal(r.sections.tabs.find((x) => x.key === "standard-Account").label, "Account");
});

await test("snapshot reads object labels with one describeGlobal call", async () => {
  const s = await takeSnapshot(apiWith(snapshotRoutes()), "0PG1");
  assert.deepEqual(s.objectLabels, { Account: "Customer Account" });
});

await test("muting permission sets in their own object are read without NamespacePrefix", async () => {
  const routes = snapshotRoutes();
  routes.query.unshift([/FROM PermissionSet WHERE Id IN/, () => [
    { Id: "0PSC1", Name: "Core", Label: "Core", Type: "Regular", NamespacePrefix: null, LicenseId: null },
  ]]);
  routes.query.unshift([/FROM MutingPermissionSet/, (q) => {
    assert.ok(!q.includes("NamespacePrefix"), q);
    return [{ Id: "0PSMUTE00000001AAA", DeveloperName: "Sales_Muting", MasterLabel: "Sales Muting" }];
  }]);
  routes.describe = (s) => ({ fields: s === "PermissionSet" || s === "MutingPermissionSet" ? PS_FIELDS : s === "ObjectPermissions" ? OP_FIELDS : [] });
  const s = await takeSnapshot(apiWith(routes), "0PG1");
  assert.equal(s.muting?.sobject, "MutingPermissionSet");
  assert.ok(!s.warnings.some((w) => w.includes("muting")), s.warnings.join("; "));
});

const PSGS = [
  { id: "1", label: "Acme North Sales PSG", developerName: "Acme_North_Sales_PSG" },
  { id: "2", label: "Acme North / South Service PSG", developerName: "Acme_North_South_Service_PSG" },
  { id: "3", label: "Sales Ops", developerName: "Sales_Ops" },
  { id: "4", label: "US Sales PSG", developerName: "US_Sales_PSG" },
];

await test("search matches every typed word, in any order, label or API name", () => {
  assert.deepEqual(matchPsgs(PSGS, "acme north sales").items.map((p) => p.id), ["1"]);
  assert.deepEqual(matchPsgs(PSGS, "service south").items.map((p) => p.id), ["2"]);
  assert.deepEqual(matchPsgs(PSGS, "US_Sales").items.map((p) => p.id), ["4"]);
  assert.equal(matchPsgs(PSGS, "").total, 4);
  assert.equal(matchPsgs(PSGS, "zzz").total, 0);
});

await test("search puts names that start with the text first, and caps the list", () => {
  assert.deepEqual(matchPsgs(PSGS, "sales").items.map((p) => p.id), ["3", "1", "4"]);
  const many = Array.from({ length: 150 }, (_, i) => ({ id: String(i), label: `Group ${i}`, developerName: `G${i}` }));
  const r = matchPsgs(many, "group");
  assert.equal(r.items.length, 100);
  assert.equal(r.total, 150);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\nAll ${passed} checks passed.`);
process.exit(failures.length ? 1 : 0);
