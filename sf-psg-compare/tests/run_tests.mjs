// Offline tests. No org, no browser, no npm install:  node tests/run_tests.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { findSession, isSalesforceHost, SfApi, chunk, soqlString } from "../extension/lib/sfconn.js";
import { takeSnapshot, listPsgs, validateSnapshot, SNAPSHOT_SCHEMA } from "../extension/lib/snapshot.js";
import { compareSnapshots, toRows, toCsv, humanize } from "../extension/lib/compare.js";
import { matchPsgs } from "../extension/lib/pick.js";

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
  assert.ok(s.warnings.some((w) => w.includes("MysteryType")));
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
  assert.ok(texts.includes("Sales Manager can Delete, View All, Modify All Opportunity records; Sales Rep cannot."), texts.join("\n"));
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
  const muted = R.sections.components.filter((r) => r.group === "Taken away by muting");
  const mOpp = muted.find((r) => r.key === "Opportunity");
  assert.deepEqual([mOpp.status, mOpp.a, mOpp.label], ["onlyA", "Delete", "Opportunity"]);
  assert.ok(muted.some((r) => r.label === "Export Reports"));
  assert.equal(muted.find((r) => r.key === "Account.AnnualRevenue").label, "Account › Annual Revenue");
  assert.equal(row("setupAccess", "Approve_Discounts").status, "onlyB");
  assert.equal(row("tabs", "Widget__c").status, "differ");
  assert.equal(row("tabs", "standard-Campaign").status, "onlyA");
});

await test("overview and verdict", () => {
  assert.equal(row("overview", "Users assigned").a, "398 active (412 in total)");
  assert.equal(row("overview", "Muting permission set").b, "None");
  assert.ok(texts.includes("Each group gives some access the other does not."));
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
  assert.ok(r.highlights.some((h) => h.text === "Rep Plus gives everything Sales Rep gives, and more."));
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
