// Offline tests for the User access page. Called from run_tests.mjs with its shared `test` function.
// Synthetic data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SfApi, soqlLike } from "../extension/lib/sfconn.js";
import { searchUsers, readUserAccess } from "../extension/lib/useraccess.js";
import {
  compareUsers, validateAccess, toRows, toRowsSingle, toCsv, matchUsers, howText, summarize, SECTION_KEYS, plural, countText, detailText,
} from "../extension/lib/usercompare.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = (...p) => path.join(here, "../extension", ...p);
const sample = (n) => JSON.parse(readFileSync(ext("samples", n), "utf-8"));

/** Fake REST API (same idea as run_tests.mjs). A route handler may return {fail: "message"} to answer 400. */
function fakeFetch(routes, log = []) {
  return async (url, opts = {}) => {
    const u = new URL(url);
    if (/\/sobjects\/$/.test(u.pathname)) {
      log.push({ method: opts.method || "GET", path: u.pathname, q: null });
      const sobjects = (globalThis.__sobjects || ["User", "UserTerritory2Association"]).map((name) => ({ name }));
      return { ok: true, status: 200, text: async () => JSON.stringify({ sobjects }) };
    }
    log.push({ method: opts.method || "GET", path: u.pathname, q: u.searchParams.get("q") });
    if (!u.pathname.includes("/query")) throw new Error(`unexpected url ${url}`);
    const q = u.searchParams.get("q");
    const route = routes.find(([re]) => re.test(q));
    if (!route) return { ok: false, status: 400, text: async () => JSON.stringify([{ message: `no route for ${q}`, errorCode: "TEST" }]) };
    const records = route[1](q);
    if (records.fail) return { ok: false, status: 400, text: async () => JSON.stringify([{ message: records.fail, errorCode: records.code || "TEST" }]) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ done: true, totalSize: records.length, records }) };
  };
}

const apiFor = (routes, log) => new SfApi({ apiHost: "test.example.com", sessionId: "sid", fetchImpl: fakeFetch(routes, log) });

// A synthetic org for readUserAccess.
function userRoutes(over = {}) {
  const routes = [
    [/FROM User WHERE Id/, () => [{ Id: "005A", Name: "Alex Example", Username: "alex@example.com", IsActive: true,
      Profile: { Name: "Sales Standard", UserLicense: { Name: "Salesforce" } }, UserRole: { Name: "Sales Rep", DeveloperName: "Sales_Rep" } }]],
    [/FROM PermissionSetAssignment/, () => [
      { PermissionSetId: "0PS1", PermissionSetGroupId: null, PermissionSet: { Name: "Opportunity_Edit", Label: "Opportunity Edit", NamespacePrefix: null, Type: "Regular", IsOwnedByProfile: false, LicenseId: null } },
      { PermissionSetId: "0PS2", PermissionSetGroupId: null, PermissionSet: { Name: "Sales_Reports", Label: "Sales Reports", NamespacePrefix: null, Type: "Regular", IsOwnedByProfile: false, LicenseId: "1PL1" } },
      { PermissionSetId: "0PS3", PermissionSetGroupId: null, PermissionSet: { Name: "X00e_profile", Label: "Profile Set", NamespacePrefix: null, Type: "Profile", IsOwnedByProfile: true, LicenseId: null } },
      { PermissionSetId: "0PS4", PermissionSetGroupId: "0PG1", PermissionSet: { Name: "Sales_Core", Label: "Sales Core", NamespacePrefix: null, Type: "Group", IsOwnedByProfile: false, LicenseId: null } },
    ]],
    [/FROM PermissionSetGroup WHERE/, () => [{ Id: "0PG1", DeveloperName: "Sales_Core", MasterLabel: "Sales Core", NamespacePrefix: null, Status: "Updated" }]],
    [/FROM PermissionSetGroupComponent/, () => [
      { PermissionSetGroupId: "0PG1", PermissionSetId: "0PS1" },
      { PermissionSetGroupId: "0PG1", PermissionSetId: "0PS5" },
      { PermissionSetGroupId: "0PG1", PermissionSetId: "0PS6" },
      { PermissionSetGroupId: "0PG1", PermissionSetId: "0PS7" },
    ]],
    [/FROM PermissionSet WHERE Id IN/, () => [
      { Id: "0PS1", Name: "Opportunity_Edit", Label: "Opportunity Edit", Type: "Regular", NamespacePrefix: null, LicenseId: null },
      { Id: "0PS5", Name: "Lead_Convert", Label: "Lead Convert", Type: "Regular", NamespacePrefix: "acme", LicenseId: null },
      { Id: "0PS6", Name: "Mute_Delete", Label: "Mute Delete", Type: "Muting", NamespacePrefix: null, LicenseId: null },
    ]],
    [/FROM MutingPermissionSet/, () => [{ Id: "0PS7", DeveloperName: "Mute_Export", MasterLabel: "Mute Export" }]],
    [/FROM UserLicense WHERE/, () => []],
    [/FROM PermissionSetLicense WHERE Id/, () => [{ Id: "1PL1", MasterLabel: "Reporting Licence" }]],
    [/FROM PermissionSetLicenseAssign/, () => [{ PermissionSetLicense: { DeveloperName: "EinsteinPsl", MasterLabel: "Einstein" } }]],
    [/FROM GroupMember/, () => [
      { Group: { DeveloperName: "All_Sales", Name: "All Sales", Type: "Regular" } },
      { Group: { DeveloperName: "Lead_Triage", Name: "Lead Triage", Type: "Queue" } },
    ]],
    [/FROM UserTerritory2Association/, () => [{ Territory2: { DeveloperName: "North", Name: "North" } }]],
  ];
  for (const [re, fn] of over.routes || []) routes.unshift([re, fn]);
  return routes;
}

export async function run(test) {
  console.log("user access");

  await test("soqlLike escapes backslash, %, _ and quotes", () => {
    assert.equal(soqlLike("50%_off"), "50\\%\\_off");
    assert.equal(soqlLike("a\\b"), "a\\\\b");
    assert.equal(soqlLike("O'Neil"), "O\\'Neil");
  });

  await test("searchUsers builds a safe query and needs every word", async () => {
    const log = [];
    const api = apiFor([[/FROM User WHERE/, () => []]], log);
    await searchUsers(api, `o'neil 100%  a_b \\x`);
    const q = log[0].q;
    assert.ok(q.includes("Name LIKE '%o\\'neil%'") && q.includes("Username LIKE '%o\\'neil%'"), q);
    assert.ok(q.includes("'%100\\%%'"), q);
    assert.ok(q.includes("'%a\\_b%'"), q);
    assert.ok(q.includes("'%\\\\x%'"), q);
    assert.equal(q.split(" AND ").length, 4, "one condition per word, joined by AND");
    assert.match(q, /LIMIT 51$/);
    assert.deepEqual(await searchUsers(api, "   "), { users: [], more: false });
    assert.equal(log.length, 1, "empty text must not query");
  });

  await test("searchUsers maps users, keeps inactive ones marked and reports more", async () => {
    const recs = Array.from({ length: 4 }, (_, i) => ({ Id: `005${i}`, Name: `User ${i}`, Username: `u${i}@example.com`, IsActive: i !== 1, Profile: { Name: "Std" } }));
    const api = apiFor([[/FROM User WHERE/, () => recs]]);
    const r = await searchUsers(api, "user", 3);
    assert.equal(r.users.length, 3);
    assert.equal(r.more, true);
    assert.equal(r.users[1].isActive, false);
    assert.equal(r.users[0].profile, "Std");
  });

  await test("readUserAccess reads profile, role, licences, groups, queues and territories", async () => {
    const a = await readUserAccess(apiFor(userRoutes()), "005A");
    assert.equal(a.schema, "sf-user-access/1");
    assert.deepEqual(a.user, { id: "005A", name: "Alex Example", username: "alex@example.com", isActive: true });
    assert.equal(a.sections.profile[0].label, "Sales Standard");
    assert.equal(a.sections.profile[0].licence, "Salesforce");
    assert.equal(a.sections.role[0].label, "Sales Rep");
    assert.deepEqual(a.sections.permissionSetLicenses.map((x) => x.key), ["EinsteinPsl"]);
    assert.deepEqual(a.sections.publicGroups.map((x) => x.key), ["All_Sales"]);
    assert.deepEqual(a.sections.queues.map((x) => x.key), ["Lead_Triage"]);
    assert.deepEqual(a.sections.territories.map((x) => x.key), ["North"]);
    assert.deepEqual(a.warnings, []);
    validateAccess(a);
  });

  await test("readUserAccess leaves out profile-owned and Group-type sets, and shows how each is reached", async () => {
    const a = await readUserAccess(apiFor(userRoutes()), "005A");
    const keys = a.sections.permissionSets.map((p) => p.key);
    assert.deepEqual(keys, ["acme__Lead_Convert", "Opportunity_Edit", "Sales_Reports"]);
    const by = Object.fromEntries(a.sections.permissionSets.map((p) => [p.key, p]));
    assert.equal(by.Opportunity_Edit.direct, true);
    assert.deepEqual(by.Opportunity_Edit.groups.map((g) => g.label), ["Sales Core"]);
    assert.equal(howText(by.Opportunity_Edit), "Assigned directly, and through group: Sales Core");
    assert.equal(howText(by["acme__Lead_Convert"]), "Through group: Sales Core");
    assert.equal(howText(by.Sales_Reports), "Assigned directly");
    assert.equal(by.Sales_Reports.licence, "Reporting Licence");
  });

  await test("readUserAccess shows muting permission sets on the group and does not crash", async () => {
    const a = await readUserAccess(apiFor(userRoutes()), "005A");
    assert.equal(a.sections.permissionSetGroups.length, 1);
    assert.deepEqual(a.sections.permissionSetGroups[0].muting.sort(), ["Mute Delete", "Mute Export"]);
    assert.ok(!a.sections.permissionSets.some((p) => /Mute/.test(p.key)));
    // A muting object the user cannot read only adds a warning.
    const b = await readUserAccess(apiFor(userRoutes({ routes: [[/FROM MutingPermissionSet/, () => ({ fail: "No access to MutingPermissionSet" })]] })), "005A");
    assert.ok(b.warnings.some((w) => /muting/i.test(w)));
    assert.deepEqual(b.sections.permissionSetGroups[0].muting, ["Mute Delete"]);
  });

  await test("a territory query failure becomes a plain message and a warning, not a throw", async () => {
    const off = userRoutes({ routes: [[/FROM UserTerritory2Association/, () => ({ fail: "sObject type 'UserTerritory2Association' is not supported.", code: "INVALID_TYPE" })]] });
    const a = await readUserAccess(apiFor(off), "005A");
    assert.deepEqual(a.sections.territories, []);
    assert.equal(a.unavailable.territories, "Territories are not turned on in this org.");
    assert.ok(a.warnings.some((w) => w.includes("UserTerritory2Association")));
    assert.equal(a.sections.permissionSets.length, 3, "other areas still read");
    const denied = userRoutes({ routes: [[/FROM GroupMember/, () => ({ fail: "insufficient access", code: "INSUFFICIENT_ACCESS" })]] });
    const b = await readUserAccess(apiFor(denied), "005A");
    assert.match(b.unavailable.queues, /could not be read/);
    assert.ok(!/insufficient/.test(b.unavailable.queues), "raw error stays out of the plain message");
    validateAccess(b);
  });

  await test("territories are skipped, with no query, when the org does not list UserTerritory2Association", async () => {
    const log = [];
    globalThis.__sobjects = ["User", "Account"];
    try {
      const a = await readUserAccess(apiFor(userRoutes(), log), "005A");
      assert.deepEqual(a.sections.territories, []);
      assert.equal(a.unavailable.territories, "Territories are not turned on in this org.");
      assert.deepEqual(a.warnings, []);
      assert.ok(!log.some((c) => /UserTerritory2Association/.test(c.q || "")), "no territory query");
      assert.equal(log.filter((c) => /\/sobjects\/$/.test(c.path)).length, 1, "one describeGlobal call");
      assert.equal(a.sections.permissionSets.length, 3, "other areas still read");
    } finally { delete globalThis.__sobjects; }
  });

  await test("plural helper: 1 is singular, 0 and many are plural", () => {
    assert.equal(plural(1, "licence", "licences"), "1 licence");
    assert.equal(plural(0, "territory", "territories"), "0 territories");
    assert.equal(countText(1, "permissionSetGroups"), "1 permission set group");
    assert.equal(countText(3, "permissionSetGroups"), "3 permission set groups");
    assert.equal(countText(1, "territories"), "1 territory");
    assert.equal(countText(2, "queues"), "2 queues");
  });

  await test("a group shows its muting permission set as \"Muting permission set: ...\"", () => {
    const g = { key: "G", label: "G", muting: ["Delete Muted"] };
    assert.equal(detailText("permissionSetGroups", g), "Muting permission set: Delete Muted");
    assert.equal(detailText("permissionSetGroups", { ...g, muting: ["A", "B"] }), "Muting permission sets: A, B");
    assert.ok(!/Muted by/.test(detailText("permissionSetGroups", g)));
  });

  await test("readUserAccess sends only GET requests to /services/data/", async () => {
    const log = [];
    await readUserAccess(apiFor(userRoutes(), log), "005A");
    assert.ok(log.length > 8);
    for (const c of log) {
      assert.equal(c.method, "GET");
      assert.ok(c.path.startsWith("/services/data/"), c.path);
    }
  });

  await test("compareUsers matches by API name even when the Ids differ", () => {
    const a = sample("user_a.json");
    const b = sample("user_b.json");
    // Same items, different Ids and labels, as if the user came from another org.
    const b2 = structuredClone(b);
    b2.user.id = "005OTHERORG00000X";
    const r = compareUsers(a, b2);
    const row = (k, key) => r.sections[k].find((x) => x.key === key);
    assert.equal(row("permissionSets", "Sales_Reports").status, "same");
    assert.equal(row("permissionSets", "Quote_Approver").status, "onlyA");
    assert.equal(row("permissionSets", "Campaign_Manager").status, "onlyB");
    assert.equal(row("permissionSets", "Opportunity_Edit").status, "differ", "direct and via group for A, group only for B");
    assert.equal(row("publicGroups", "All_Sales_Staff").status, "same");
    assert.equal(row("territories", "Northeast_Region").status, "onlyA");
  });

  await test("compareUsers counts only-A, only-B and same, and writes a verdict", () => {
    const r = compareUsers(sample("user_a.json"), sample("user_b.json"));
    assert.deepEqual(r.counts.queues, { onlyA: 1, onlyB: 0, same: 1, differ: 0, total: 2, totalA: 2, totalB: 1 });
    assert.deepEqual(r.counts.publicGroups, { onlyA: 1, onlyB: 1, same: 1, differ: 0, total: 3, totalA: 2, totalB: 2 });
    assert.deepEqual(r.counts.permissionSets, { onlyA: 1, onlyB: 1, same: 2, differ: 1, total: 5, totalA: 4, totalB: 4 });
    assert.deepEqual(r.counts.territories, { onlyA: 1, onlyB: 0, same: 0, differ: 0, total: 1, totalA: 1, totalB: 0 });
    assert.match(r.verdict.text, /Alex Example and Blake Sample each have access the other does not\./);
    const twin = structuredClone(sample("user_a.json"));
    twin.user.username = "alex.two@example.com";
    const same = compareUsers(sample("user_a.json"), twin);
    assert.match(same.verdict.text, /same access/);
    assert.equal(same.verdict.level, "good");
    assert.notEqual(same.names.a, same.names.b, "same name twice gets the username added");
    const lessA = structuredClone(sample("user_a.json"));
    for (const k of SECTION_KEYS) lessA.sections[k] = [];
    assert.match(compareUsers(sample("user_a.json"), lessA).verdict.text, /has everything .* has, and more/);
  });

  await test("CSV: header row, quoting, Excel BOM", () => {
    const r = compareUsers(sample("user_a.json"), sample("user_b.json"));
    const rows = toRows(r);
    assert.deepEqual(rows[0].slice(0, 4), ["Area", "Item", "API name", "Difference"]);
    assert.equal(rows[0][4], "Alex Example");
    assert.ok(toRows(r, "queues").every((x, i) => i === 0 || x[0] === "Queues"));
    const single = toRowsSingle(sample("user_a.json"), "territories");
    assert.deepEqual(single[0], ["User", "Username", "Area", "Item", "API name", "Details"]);
    assert.equal(single.length, 2);
    const csv = toCsv([["Item", "Details"], ['He said "hi", ok', "line\nbreak"], ["plain", ""]]);
    assert.ok(csv.startsWith("﻿Item,Details\r\n"));
    assert.ok(csv.includes('"He said ""hi"", ok","line\nbreak"\r\n'));
    assert.ok(csv.endsWith("plain,\r\n"));
  });

  await test("both sample files load and validate, and overlap", () => {
    const a = validateAccess(sample("user_a.json"));
    const b = validateAccess(sample("user_b.json"));
    assert.ok(a.user.username.endsWith("@example.com") && b.user.username.endsWith("@example.com"));
    assert.ok(summarize(a).permissionSets > 0);
    assert.throws(() => validateAccess({ schema: "nope" }), /schema/i);
    assert.throws(() => validateAccess({ schema: "sf-user-access/1", user: { name: "x" }, sections: {} }), /missing/);
    const r = compareUsers(a, b);
    const some = (k, s) => r.sections[k].some((x) => x.status === s);
    assert.ok(some("permissionSets", "same") && some("permissionSets", "onlyA") && some("permissionSets", "onlyB"));
    assert.ok(r.sections.territories.length === 1);
  });

  await test("demo search matches every word of name or username", () => {
    const users = [sample("user_a.json"), sample("user_b.json")].map((x) => x.user);
    assert.deepEqual(matchUsers(users, "example alex").users.map((u) => u.name), ["Alex Example"]);
    assert.equal(matchUsers(users, "example.com").users.length, 2);
    assert.equal(matchUsers(users, "zzz").users.length, 0);
  });

  await test("the new files never use innerHTML, localStorage or chrome.storage", () => {
    for (const f of [["user-access.js"], ["lib", "useraccess.js"], ["lib", "usercompare.js"]]) {
      const text = readFileSync(ext(...f), "utf-8");
      for (const bad of ["innerHTML", "insertAdjacentHTML", "outerHTML", "localStorage", "chrome.storage"]) {
        assert.ok(!text.includes(bad), `${f.join("/")} contains ${bad}`);
      }
    }
  });
}
