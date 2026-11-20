// Offline tests for the User access page. Called from run_tests.mjs with its shared `test` function.
// Synthetic data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SfApi, soqlLike } from "../extension/lib/sfconn.js";
import { searchUsers, readUserAccess } from "../extension/lib/useraccess.js";
import {
  compareUsers, validateAccess, toRows, toRowsSingle, toCsv, matchUsers, howText, summarize, SECTION_KEYS, plural, countText, detailText, hasDetails, singleRows, statusText, userCardLines, orgParts,
  resolveHierarchy, settingItems, customSettingsLine, valueText, customSettingsSkippedNote, customSettingsFailedNote,
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
    const desc = /\/sobjects\/([\w]+)\/describe\/$/.exec(u.pathname);
    if (desc) {
      log.push({ method: opts.method || "GET", path: u.pathname, q: null });
      const d = (routes.describes || {})[desc[1]];
      if (!d) return { ok: false, status: 404, text: async () => JSON.stringify([{ message: `no describe for ${desc[1]}`, errorCode: "NOT_FOUND" }]) };
      if (d.fail) return { ok: false, status: 403, text: async () => JSON.stringify([{ message: d.fail, errorCode: "INSUFFICIENT_ACCESS" }]) };
      return { ok: true, status: 200, text: async () => JSON.stringify(d) };
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
    [/SELECT CallCenter\.Name/, () => [{ CallCenter: { Name: "Demo Line", InternalName: "Demo_Line" } }]],
    [/FROM EntityDefinition/, () => []],
    [/FROM Organization/, () => [{ Id: "00DORG000000001AAA" }]],
    [/FROM User WHERE Id/, () => [{ Id: "005A", Name: "Alex Example", Username: "alex@example.com", IsActive: true, ProfileId: "00ePROF00000001AAA",
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
  routes.describes = over.describes || {};
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
    assert.equal(howText(by.Opportunity_Edit), "Assigned directly and through the group Sales Core");
    assert.equal(howText(by["acme__Lead_Convert"]), "Through the group Sales Core");
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
    assert.match(b.unavailable.queues, /could not be read\. Your user may not have permission to see this\. Ask an admin to check\./);
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
    assert.equal(plural(1, "license", "licenses"), "1 license");
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
    assert.deepEqual(r.counts.queues, { onlyA: 1, onlyB: 0, same: 1, differ: 0, unread: 0, total: 2, totalA: 2, totalB: 1 });
    assert.deepEqual(r.counts.publicGroups, { onlyA: 1, onlyB: 1, same: 1, differ: 0, unread: 0, total: 3, totalA: 2, totalB: 2 });
    assert.deepEqual(r.counts.permissionSets, { onlyA: 1, onlyB: 1, same: 2, differ: 1, unread: 0, total: 5, totalA: 4, totalB: 4 });
    assert.deepEqual(r.counts.territories, { onlyA: 1, onlyB: 0, same: 0, differ: 0, unread: 0, total: 1, totalA: 1, totalB: 0 });
    assert.match(r.verdict.text, /Alex Example and Blake Sample each have access the other does not \(\d+ differences in total\)\./);
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

  await test("CSV: detail lines are joined with '; ', no line breaks inside cells", () => {
    const set = { key: "P", label: "P", direct: false, groups: [{ key: "G", label: "G" }], licence: "Reporting License" };
    const mk = (items) => ({
      schema: "sf-user-access/1", user: { name: "U", username: "u@example.com" }, unavailable: {}, warnings: [],
      sections: { permissionSets: items },
    });
    const r = compareUsers(mk([set]), mk([]));
    const rows = toRows(r, "permissionSets");
    assert.ok(rows.length > 1);
    const cells = rows.flat();
    assert.ok(cells.every((c) => !String(c).includes("\n")));
    assert.ok(cells.some((c) => String(c).includes("; ")));
    const csv = toCsv(rows);
    assert.ok(!/\n(?!$)/.test(csv.replace(/\r\n/g, "")));
    const single = toRowsSingle(mk([set]), "permissionSets");
    assert.ok(single.flat().every((c) => !String(c).includes("\n")) && single.flat().some((c) => String(c).includes("; ")));
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

  await test("wording: details on separate lines, hidden Details column rule, total in verdict, Different", () => {
    const set = { key: "P", label: "P", direct: true, groups: [{ key: "G", label: "G" }], licence: "Reporting License" };
    assert.equal(detailText("permissionSets", set), "Assigned directly and through the group G\nNeeds license: Reporting License");
    assert.equal(detailText("profile", { key: "p", licence: "Salesforce" }), "User license: Salesforce");
    assert.equal(detailText("permissionSetGroups", { key: "g", muting: [], status: "Outdated" }), "Not up to date (Outdated). In Setup, open this group and wait for its status to say Updated.");
    assert.equal(hasDetails(singleRows(sample("user_a.json"), "queues")), false);
    assert.equal(hasDetails([{ detail: "" }, { detail: "x" }]), true);
    assert.equal(statusText("differ"), "Different");
    const r = compareUsers(sample("user_a.json"), sample("user_b.json"));
    const total = Object.values(r.counts).reduce((n, c) => n + c.onlyA + c.onlyB + c.differ, 0);
    assert.ok(r.verdict.text.includes(`(${total} differences in total)`));
  });

  await test("a missing user gets a plain message", async () => {
    await assert.rejects(readUserAccess(apiFor([[/FROM User WHERE/, () => []]]), "005X"), /could not be found.*Search again/);
  });

  // ---- comparison cards ----
  const mk = (name, sections) => validateAccess({
    schema: "sf-user-access/1", user: { id: name, name, username: `${name}@x.test`, isActive: true },
    sections: Object.fromEntries(SECTION_KEYS.map((k) => [k, (sections[k] || []).map((x) => (typeof x === "string" ? { key: x, label: x } : x))])),
  });
  const say = (lines) => lines.map((l) => l.segs.map((g) => g.text).join(""));
  const five = ["g1", "g2", "g3", "g4", "g5"];

  await test("cards: 5 shared groups and 1 only for the second user", () => {
    const r = compareUsers(mk("Ann", { permissionSetGroups: five }), mk("Bob", { permissionSetGroups: [...five, "g6"] }));
    assert.deepEqual(say(userCardLines(r, "permissionSetGroups")), ["5 permission set groups both have", "0 only Ann has", "1 only Bob has"]);
    const lines = userCardLines(r, "permissionSetGroups");
    assert.equal(lines[1].segs[2].side, "a");
    assert.equal(lines[2].segs[2].side, "b");
    assert.equal(lines[0].segs[0].bold, true);
  });

  await test("cards: singular noun, thousands separators, same-in-both line after the numbers", () => {
    const r = compareUsers(mk("Ann", { queues: ["q"] }), mk("Bob", { queues: ["q"] }));
    assert.deepEqual(say(userCardLines(r, "queues")), ["1 queue both have", "0 only Ann has", "0 only Bob has", "✓ Same in both"]);
    const many = Array.from({ length: 1200 }, (_, i) => `t${i}`);
    const big = compareUsers(mk("Ann", { territories: many }), mk("Bob", {}));
    assert.equal(say(userCardLines(big, "territories"))[1], "1,200 only Ann has");
  });

  await test("cards: permission sets show the assigned-differently line", () => {
    const direct = { key: "ps1", label: "ps1", direct: true, groups: [] };
    const viaGroup = { key: "ps1", label: "ps1", direct: false, groups: [{ key: "g", label: "G" }] };
    const r = compareUsers(mk("Ann", { permissionSets: [direct, "ps2"] }), mk("Bob", { permissionSets: [viaGroup] }));
    assert.deepEqual(say(userCardLines(r, "permissionSets")), [
      "1 permission set both have", "1 only Ann has", "0 only Bob has", "1 of those assigned differently (directly or through a group)"]);
    // other areas never show that line
    assert.equal(userCardLines(r, "queues").length, 1);
  });

  await test("cards: neither has any", () => {
    const r = compareUsers(mk("Ann", {}), mk("Bob", {}));
    assert.deepEqual(say(userCardLines(r, "publicGroups")), ["Neither has any"]);
  });

  await test("cards: profile and role show the value", () => {
    const r = compareUsers(mk("Ann", { profile: ["Standard"], role: ["East"] }), mk("Bob", { profile: ["Standard"], role: [] }));
    assert.deepEqual(say(userCardLines(r, "profile")), ["✓ Same in both: Standard"]);
    assert.deepEqual(say(userCardLines(r, "role")), ["Ann: East", "Bob: no role"]);
    const d = compareUsers(mk("Ann", { profile: ["Standard"] }), mk("Bob", { profile: ["Admin"] }));
    assert.deepEqual(say(userCardLines(d, "profile")), ["Ann: Standard", "Bob: Admin"]);
  });

  await test("cards: neither has a role or profile reads as same", () => {
    const r = compareUsers(mk("Ann", {}), mk("Bob", {}));
    assert.deepEqual(say(userCardLines(r, "role")), ["✓ Same in both: no role"]);
    assert.deepEqual(say(userCardLines(r, "profile")), ["✓ Same in both: no profile"]);
    assert.equal(userCardLines(r, "role")[0].cls, "same");
    assert.equal(r.counts.role.onlyA + r.counts.role.onlyB + r.counts.role.differ, 0);
  });

  await test("cards: one has a role, the other none", () => {
    const r = compareUsers(mk("Ann", { role: ["East"] }), mk("Bob", {}));
    assert.deepEqual(say(userCardLines(r, "role")), ["Ann: East", "Bob: no role"]);
    const r2 = compareUsers(mk("Ann", {}), mk("Bob", { role: ["West"] }));
    assert.deepEqual(say(userCardLines(r2, "role")), ["Ann: no role", "Bob: West"]);
  });

  await test("org header leaves out missing parts instead of printing null", () => {
    const org = { name: "Acme", isSandbox: true };
    assert.deepEqual(orgParts(org, "h.example.com", null).map((p) => p.text), ["Acme", "Sandbox", "h.example.com"]);
    assert.deepEqual(orgParts(org, "", "DEV SERVER").map((p) => p.text), ["Acme", "Sandbox", "DEV SERVER"]);
    for (const p of orgParts(org, null, undefined)) assert.ok(p && p.text && p.text !== "null");
  });

  // ---- call center and custom settings ----
  const IDS = { userId: "005USER00000001AAA", profileId: "00ePROF00000001AAA", orgId: "00DORG000000001AAA" };
  const row = (owner, vals) => ({ SetupOwnerId: owner, ...vals });
  const boolF = { name: "Bypass__c", label: "Bypass validation rules", type: "boolean" };
  const numF = { name: "Size__c", label: "Batch size", type: "double" };
  const textF = { name: "Note__c", label: "Note", type: "string" };
  const by = (r, n) => r.find((x) => x.name === n);

  await test("hierarchy rule: user beats profile beats org, field by field", () => {
    const rows = [
      row(IDS.orgId, { Size__c: 50, Note__c: "org note" }),
      row(IDS.profileId, { Size__c: 100, Note__c: "profile note" }),
      row(IDS.userId, { Size__c: 200, Note__c: "user note" }),
    ];
    const r = resolveHierarchy([numF, textF], rows, IDS);
    assert.deepEqual([by(r, "Size__c").value, by(r, "Size__c").source, by(r, "Size__c").orgDefault], [200, "user", 50]);
    assert.deepEqual([by(r, "Note__c").value, by(r, "Note__c").source], ["user note", "user"]);
  });

  await test("hierarchy rule: a null at a lower level falls through, per field", () => {
    const rows = [
      row(IDS.orgId, { Size__c: 50, Note__c: "org note" }),
      row(IDS.profileId, { Size__c: 100, Note__c: null }),
      row(IDS.userId, { Size__c: null, Note__c: null }),
    ];
    const r = resolveHierarchy([numF, textF], rows, IDS);
    assert.deepEqual([by(r, "Size__c").value, by(r, "Size__c").source], [100, "profile"], "user null falls to profile");
    assert.deepEqual([by(r, "Note__c").value, by(r, "Note__c").source], ["org note", "org"], "both null fall to org");
    // no user or profile row at all
    const r2 = resolveHierarchy([numF], [row(IDS.orgId, { Size__c: 50 })], IDS);
    assert.deepEqual([r2[0].value, r2[0].source], [50, "org"]);
    // nothing set anywhere
    const r3 = resolveHierarchy([numF], [], IDS);
    assert.deepEqual([r3[0].value, r3[0].source, r3[0].orgDefault], [null, null, null]);
  });

  await test("hierarchy rule: a checkbox false at user level beats true at profile level", () => {
    const rows = [row(IDS.orgId, { Bypass__c: false }), row(IDS.profileId, { Bypass__c: true }), row(IDS.userId, { Bypass__c: false })];
    const r = resolveHierarchy([boolF], rows, IDS);
    assert.deepEqual([r[0].value, r[0].source], [false, "user"]);
    // the user's false equals the org default, so nothing is shown for this user
    assert.deepEqual(settingItems({ api: "S__c", label: "S" }, [boolF], rows, IDS), []);
    // ids of 15 and 18 characters match
    const r15 = resolveHierarchy([boolF], [row(IDS.profileId.slice(0, 15), { Bypass__c: true })], IDS);
    assert.equal(r15[0].source, "profile");
  });

  await test("only fields that differ from the org default are listed", () => {
    const rows = [
      row(IDS.orgId, { Bypass__c: false, Size__c: 50, Note__c: "same" }),
      row(IDS.profileId, { Bypass__c: true, Size__c: 50, Note__c: "same" }),
      row(IDS.userId, { Bypass__c: false, Size__c: 75, Note__c: null }),
    ];
    const items = settingItems({ api: "ns__Auto__c", label: "Automation Settings" }, [boolF, numF, textF], rows, IDS);
    assert.deepEqual(items.map((i) => i.key), ["ns__Auto__c.Size__c"]);
    const it = items[0];
    assert.deepEqual([it.label, it.valueText, it.sourceText, it.orgDefaultText], ["Automation Settings: Batch size", "75", "This user", "50"]);
    assert.deepEqual([it.setting.api, it.field.api, it.field.label], ["ns__Auto__c", "Size__c", "Batch size"]);
    // an unchecked checkbox with no org row is the same as the default; checked is not
    const none = settingItems({ api: "S__c", label: "S" }, [boolF], [row(IDS.userId, { Bypass__c: false })], IDS);
    assert.equal(none.length, 0);
    const on = settingItems({ api: "S__c", label: "S" }, [boolF], [row(IDS.profileId, { Bypass__c: true })], IDS);
    assert.deepEqual([on[0].valueText, on[0].sourceText, on[0].orgDefaultText], ["Checked", "Their profile", "Not checked"]);
    assert.equal(valueText("string", null), "Not set");
  });

  const csItem = (api, field, value, source, orgDefault, type = "boolean") => settingItems(
    { api, label: api.replace("__c", "") }, [{ name: field, label: field.replace("__c", ""), type }],
    [row(IDS.orgId, { [field]: orgDefault }), row(source === "user" ? IDS.userId : IDS.profileId, { [field]: value })], IDS)[0];
  const withCs = (name, items, info) => ({ ...mk(name, { customSettings: items }), customSettingsInfo: info });

  await test("compare matches custom setting values by API name and shows who differs", () => {
    const a = withCs("Ann", [csItem("Auto__c", "Bypass__c", true, "user", false), csItem("Integ__c", "Size__c", 200, "user", 50, "double")]);
    const b = withCs("Bob", [csItem("Auto__c", "Bypass__c", true, "profile", false), csItem("Auto__c", "Flows__c", true, "profile", false)]);
    b.user.id = "005OTHERORG000001"; // Ids never matter
    const r = compareUsers(a, b);
    const st = Object.fromEntries(r.sections.customSettings.map((x) => [x.key, x.status]));
    assert.deepEqual(st, { "Auto__c.Bypass__c": "same", "Auto__c.Flows__c": "onlyB", "Integ__c.Size__c": "onlyA" }, "same value from a different level is the same");
    assert.deepEqual(r.counts.customSettings, { onlyA: 1, onlyB: 1, same: 1, differ: 0, unread: 0, total: 3, totalA: 2, totalB: 2 });
    // the user without the row is at the org default, and the row says so
    const flows = r.sections.customSettings.find((x) => x.key === "Auto__c.Flows__c");
    assert.equal(flows.detailA, "Same as the org default: Not checked");
    assert.match(flows.detailB, /Value: Checked\nComes from: their profile\nOrg default: Not checked/);
    // different values for the same field are "Different"
    const c = withCs("Cy", [csItem("Auto__c", "Bypass__c", false, "user", true)]);
    const d = withCs("Di", [csItem("Auto__c", "Bypass__c", true, "profile", false)]);
    assert.equal(compareUsers(c, d).sections.customSettings[0].status, "differ");
    assert.match(compareUsers(a, b).verdict.text, /differences in total/);
    assert.deepEqual(say(userCardLines(r, "customSettings")).slice(0, 3), ["1 custom setting value both have", "1 only Ann has", "1 only Bob has"]);
  });

  await test("the count line says how many custom settings have a value for this user", () => {
    const items = [csItem("Auto__c", "Bypass__c", true, "user", false), csItem("Auto__c", "Flows__c", true, "profile", false), csItem("Integ__c", "Size__c", 200, "user", 50, "double")];
    const acc = withCs("Ann", items, { found: 40, examined: 40, hierarchy: 37, failed: 0, capped: false });
    assert.equal(customSettingsLine(acc), "2 of 37 custom settings have a value for this user or their profile that differs from the org default.");
    assert.match(customSettingsLine(withCs("A", [], { found: 3, examined: 3, hierarchy: 1, failed: 0, capped: false })), /^0 of 1 custom setting has a value/);
    assert.equal(customSettingsLine(withCs("A", [], { found: 5, examined: 5, hierarchy: 0, failed: 0, capped: false })), "This org has no custom settings that can differ by user or profile.");
    assert.match(customSettingsLine(withCs("A", [], { found: 500, examined: 300, hierarchy: 10, failed: 0, capped: true })), /Only the first 300 of 500 custom settings were checked/);
    assert.equal(customSettingsLine(mk("A", {})), "", "old files have no count line");
  });

  await test("CSV has rows for call center and custom settings, single and compare", () => {
    const a = withCs("Ann", [csItem("Auto__c", "Bypass__c", true, "user", false)]);
    a.sections.callCenter = [{ key: "Demo_Line", label: "Demo Line" }];
    const b = withCs("Bob", []);
    const single = toRowsSingle(a);
    const cc = single.find((r) => r[2] === "Call center");
    assert.deepEqual([cc[3], cc[4]], ["Demo Line", "Demo_Line"]);
    const cs = single.find((r) => r[2] === "Custom settings");
    assert.deepEqual([cs[3], cs[4], cs[5]], ["Auto: Bypass", "Auto__c.Bypass__c", "Value: Checked; Comes from: this user; Org default: Not checked"]);
    const rows = toRows(compareUsers(a, b));
    const ccr = rows.find((r) => r[0] === "Call center");
    assert.deepEqual([ccr[3], ccr[4], ccr[5]], ["Only Ann", "Yes", "No"]);
    const csr = rows.find((r) => r[0] === "Custom settings");
    assert.deepEqual([csr[3], csr[4], csr[5]], ["Only Ann", "Value: Checked; Comes from: this user; Org default: Not checked", "Same as the org default: Not checked"]);
    assert.ok(toRows(compareUsers(a, b), "customSettings").every((r, i) => i === 0 || r[0] === "Custom settings"));
    assert.ok(rows.flat().every((c) => !String(c).includes("\n")));
  });

  await test("call center: present, missing and unavailable", async () => {
    const have = await readUserAccess(apiFor(userRoutes()), "005A");
    assert.deepEqual(have.sections.callCenter, [{ key: "Demo_Line", label: "Demo Line" }]);
    assert.equal(have.unavailable.callCenter, undefined);
    const none = await readUserAccess(apiFor(userRoutes({ routes: [[/SELECT CallCenter\.Name/, () => [{ CallCenter: null }]]] })), "005A");
    assert.deepEqual(none.sections.callCenter, []);
    assert.equal(none.unavailable.callCenter, undefined);
    const log = [];
    const gone = await readUserAccess(apiFor(userRoutes({ routes: [[/SELECT CallCenter\.Name/, () => ({ fail: "No such column 'CallCenter' on entity 'User'", code: "INVALID_FIELD" })]] }), log), "005A");
    assert.deepEqual(gone.sections.callCenter, []);
    assert.equal(gone.unavailable.callCenter, "Call centers are not available in this org.");
    assert.ok(gone.warnings.some((w) => w.includes("Call center")));
    assert.equal(gone.sections.permissionSets.length, 3, "other areas still read");
    assert.equal(gone.user.name, "Alex Example");
    const denied = await readUserAccess(apiFor(userRoutes({ routes: [[/SELECT CallCenter\.Name/, () => ({ fail: "denied", code: "INSUFFICIENT_ACCESS" })]] })), "005A");
    assert.match(denied.unavailable.callCenter, /Call center could not be read\. Your user may not have permission/);
    assert.ok(!/denied/.test(denied.unavailable.callCenter));
    validateAccess(gone);
    // its own query, not part of the main user read
    assert.ok(log.some((c) => /SELECT CallCenter\.Name/.test(c.q || "")) && !log.some((c) => /FROM User WHERE Id/.test(c.q || "") && /CallCenter/.test(c.q || "") && /Profile\.Name/.test(c.q || "")));
    // compare card
    const r = compareUsers(mk("Ann", { callCenter: ["East"] }), mk("Bob", {}));
    assert.deepEqual(say(userCardLines(r, "callCenter")), ["Ann: East", "Bob: no call center"]);
    assert.deepEqual(say(userCardLines(compareUsers(mk("A", {}), mk("B", {})), "callCenter")), ["✓ Same in both: no call center"]);
    // an old file without the area still loads
    const old = sample("user_a.json");
    delete old.sections.callCenter;
    delete old.sections.customSettings;
    assert.deepEqual(validateAccess(old).sections.callCenter, []);
  });

  const autoDescribe = {
    fields: [
      { name: "Id", label: "Record ID", type: "id", custom: false },
      { name: "Name", label: "Name", type: "string", custom: false },
      { name: "SetupOwnerId", label: "Location", type: "reference", custom: false },
      { name: "Bypass_Validation__c", label: "Bypass validation rules", type: "boolean", custom: true },
      { name: "Secret__c", label: "Secret", type: "encryptedstring", custom: true },
    ],
  };
  const listDescribe = { fields: [{ name: "Id", type: "id", custom: false }, { name: "Name", type: "string", custom: false }, { name: "Code__c", label: "Code", type: "string", custom: true }] };

  await test("custom settings: finds hierarchy settings, skips list settings, applies the hierarchy rule", async () => {
    const log = [];
    const routes = userRoutes({
      describes: { Auto__c: autoDescribe, Codes__c: listDescribe },
      routes: [
        [/FROM EntityDefinition/, () => [{ QualifiedApiName: "Auto__c", Label: "Automation Settings" }, { QualifiedApiName: "Codes__c", Label: "Code List" }]],
        [/FROM Auto__c WHERE SetupOwnerId IN/, (q) => {
          assert.ok(q.includes("'005A'") && q.includes("'00ePROF00000001AAA'") && q.includes("'00DORG000000001AAA'"), q);
          assert.ok(!/Secret__c/.test(q), "encrypted fields are not read");
          return [{ SetupOwnerId: "00DORG000000001AAA", Bypass_Validation__c: false }, { SetupOwnerId: "00ePROF00000001AAA", Bypass_Validation__c: true }];
        }],
      ],
    });
    const sameApi = apiFor(routes, log);
    const a = await readUserAccess(sameApi, "005A");
    assert.equal(a.sections.customSettings.length, 1);
    const it = a.sections.customSettings[0];
    assert.deepEqual([it.key, it.valueText, it.source, it.orgDefaultText], ["Auto__c.Bypass_Validation__c", "Checked", "profile", "Not checked"]);
    assert.deepEqual(a.customSettingsInfo, { found: 2, examined: 2, hierarchy: 1, failed: 0, failedSettings: [], skippedFields: 1, capped: false });
    assert.equal(customSettingsLine(a), "1 of 1 custom setting has a value for this user or their profile that differs from the org default.");
    assert.ok(!log.some((c) => /FROM Codes__c/.test(c.q || "")), "list setting is never read");
    assert.equal(a.unavailable.customSettings, undefined);
    assert.deepEqual(a.warnings, []);
    for (const c of log) assert.equal(c.method, "GET");
    assert.equal(log.filter((c) => /describe/.test(c.path)).length, 2, "one describe per custom setting");
    // a second user read through the same api reuses the cached describes
    await readUserAccess(sameApi, "005A");
    assert.equal(log.filter((c) => /describe/.test(c.path)).length, 2, "no new describe calls for the second user");
  });

  await test("custom settings: none in the org, and one that cannot be read", async () => {
    const empty = await readUserAccess(apiFor(userRoutes()), "005A");
    assert.deepEqual(empty.sections.customSettings, []);
    assert.deepEqual(empty.customSettingsInfo, { found: 0, examined: 0, hierarchy: 0, failed: 0, failedSettings: [], skippedFields: 0, capped: false });
    assert.match(customSettingsLine(empty), /no custom settings that can differ/);
    const routes = userRoutes({
      describes: { Auto__c: autoDescribe, Bad__c: { fail: "no access" }, Big__c: { fields: [{ name: "SetupOwnerId", type: "reference" }, { name: "X__c", label: "X", type: "string", custom: true }] } },
      routes: [
        [/FROM EntityDefinition/, () => [{ QualifiedApiName: "Auto__c", Label: "Automation Settings" }, { QualifiedApiName: "Bad__c", Label: "Broken Setting" }, { QualifiedApiName: "Big__c", Label: "Big Setting" }]],
        [/FROM Auto__c WHERE/, () => [{ SetupOwnerId: "005A", Bypass_Validation__c: true }, { SetupOwnerId: "00DORG000000001AAA", Bypass_Validation__c: false }]],
        [/FROM Big__c WHERE/, () => ({ fail: "denied", code: "INSUFFICIENT_ACCESS" })],
      ],
    });
    const a = await readUserAccess(apiFor(routes), "005A");
    assert.deepEqual(a.sections.customSettings.map((x) => x.key), ["Auto__c.Bypass_Validation__c"], "the rest is kept");
    assert.equal(a.unavailable.customSettings, undefined, "a partial failure is not 'not available'");
    assert.deepEqual([...a.customSettingsInfo.failedSettings].sort(), ["Bad__c", "Big__c"]);
    assert.equal(customSettingsFailedNote(a), "2 settings could not be read.");
    assert.equal(a.warnings.filter((w) => /Custom setting/.test(w)).length, 2);
    assert.equal(a.customSettingsInfo.failed, 2);
    // every setting failing is a total failure
    const allBad = await readUserAccess(apiFor(userRoutes({ describes: { Bad__c: { fail: "no access" } }, routes: [[/FROM EntityDefinition/, () => [{ QualifiedApiName: "Bad__c", Label: "Broken Setting" }]]] })), "005A");
    assert.match(allBad.unavailable.customSettings, /^The custom settings could not be read/);
    // the whole area failing is soft too
    const off = await readUserAccess(apiFor(userRoutes({ routes: [[/FROM EntityDefinition/, () => ({ fail: "nope", code: "INVALID_TYPE" })]] })), "005A");
    assert.deepEqual(off.sections.customSettings, []);
    assert.match(off.unavailable.customSettings, /Custom settings could not be read/);
    assert.equal(off.customSettingsInfo, undefined);
    assert.equal(off.sections.callCenter.length, 1, "other areas still read");
  });

  await test("custom settings: many settings are read with few calls and a cap is reported", async () => {
    const names = Array.from({ length: 320 }, (_, i) => `S${i}__c`);
    const describes = Object.fromEntries(names.map((n, i) => [n, i % 4 === 0 ? { fields: [{ name: "SetupOwnerId", type: "reference" }, { name: "F__c", label: "F", type: "double", custom: true }] } : listDescribe]));
    const log = [];
    const routes = userRoutes({
      describes,
      routes: [
        [/FROM EntityDefinition/, () => names.map((n) => ({ QualifiedApiName: n, Label: n }))],
        [/FROM S\d+__c WHERE/, () => []],
      ],
    });
    const progress = [];
    const a = await readUserAccess(apiFor(routes, log), "005A", { progress: (t) => progress.push(t) });
    assert.deepEqual(a.customSettingsInfo, { found: 320, examined: 300, hierarchy: 75, failed: 0, failedSettings: [], skippedFields: 0, capped: true });
    assert.equal(log.filter((c) => /describe/.test(c.path)).length, 300, "one describe per setting, capped");
    assert.equal(log.filter((c) => /FROM S\d+__c/.test(c.q || "")).length, 75, "one read per hierarchy setting only");
    assert.ok(progress.some((t) => /Checking custom settings \(300 of 300\)/.test(t)));
    assert.match(customSettingsLine(a), /Only the first 300 of 320 custom settings were checked/);
  });

  await test("the sample users have call centers and custom settings, and stay synthetic", () => {
    const a = validateAccess(sample("user_a.json"));
    const b = validateAccess(sample("user_b.json"));
    assert.equal(a.sections.callCenter.length, 1);
    assert.equal(b.sections.callCenter.length, 0);
    assert.ok(a.sections.customSettings.some((i) => i.source === "user") && b.sections.customSettings.some((i) => i.source === "profile"));
    const r = compareUsers(a, b);
    const st = Object.fromEntries(r.sections.customSettings.map((x) => [x.key, x.status]));
    assert.equal(st["Automation_Settings__c.Bypass_Validation_Rules__c"], "same");
    assert.equal(st["Integration_Settings__c.Batch_Size__c"], "onlyA");
    assert.equal(st["Automation_Settings__c.Bypass_Flows__c"], "onlyB");
    for (const f of ["user_a.json", "user_b.json"]) {
      const text = readFileSync(ext("samples", f), "utf-8");
      assert.ok(!/[\w.]+@(?!example\.com)[\w.-]+/.test(text), "only example.com addresses");
      for (const id of text.match(/"id": "(\w+)"/g) || []) assert.match(id, /DEMO/, "made-up Ids only");
      assert.ok(!/00D[A-Za-z0-9]{12}/.test(text), "no real-looking org Id");
      for (const it of JSON.parse(text).sections.customSettings) assert.match(it.setting.api, /^(Automation|Integration)_Settings__c$/);
    }
  });

  // ---- review fixes ----

  const failInfo = (failedSettings, extra = {}) => ({ found: 5, examined: 5, hierarchy: 3, failed: failedSettings.length, failedSettings, skippedFields: 0, capped: false, ...extra });

  await test("partial failure: card, summary and notes show a note, not 'Not available'", () => {
    const a = withCs("Ann", [csItem("Auto__c", "Bypass__c", true, "user", false)], failInfo(["Bad__c", "Big__c"]));
    assert.equal(a.unavailable.customSettings, undefined);
    const r = compareUsers(a, withCs("Bob", [], failInfo([])));
    assert.ok(say(userCardLines(r, "customSettings")).includes("Ann: 2 settings could not be read."));
    assert.ok(r.notes.some((n) => /Ann: Custom settings: 2 settings could not be read\./.test(n)));
    const ui = readFileSync(ext("user-access.js"), "utf-8");
    assert.match(ui, /customSettingsFailedNote\(access\)/, "summary uses the note");
  });

  await test("compare: a setting that could not be read for one user is not a difference", () => {
    const a = withCs("Ann", [csItem("Auto__c", "Bypass__c", true, "user", false), csItem("Integ__c", "Size__c", 200, "user", 50, "double")], failInfo([]));
    const b = withCs("Blake Sample", [], failInfo(["Auto__c"]));
    const r = compareUsers(a, b);
    const st = Object.fromEntries(r.sections.customSettings.map((x) => [x.key, x.status]));
    assert.deepEqual(st, { "Auto__c.Bypass__c": "unreadB", "Integ__c.Size__c": "onlyA" });
    assert.deepEqual([r.counts.customSettings.onlyA, r.counts.customSettings.unread], [1, 1]);
    const row = r.sections.customSettings.find((x) => x.key === "Auto__c.Bypass__c");
    assert.equal(row.detailB, "Could not be read for Blake Sample");
    assert.equal(statusText("unreadB", "Ann", "Blake Sample"), "Could not be read for Blake Sample");
    assert.ok(say(userCardLines(r, "customSettings")).some((l) => /^1 not compared/.test(l)));
    assert.ok(!say(userCardLines(r, "customSettings")).includes("✓ Same in both"));
    // a total failure for one user: nothing of the other user's is "only" theirs
    const c = withCs("Cy", [], failInfo([]));
    c.unavailable = { customSettings: "x" };
    assert.ok(compareUsers(a, c).sections.customSettings.every((x) => x.status === "unreadB"));
    // unread rows do not change the verdict
    const none = compareUsers(withCs("A1", [csItem("Auto__c", "Bypass__c", true, "user", false)], failInfo([])), withCs("B1", [], failInfo(["Auto__c"])));
    assert.match(none.verdict.text, /same access/);
  });

  await test("skipped field types are noted once, and all-skipped settings leave the denominator", async () => {
    const skipDescribe = { fields: [
      { name: "SetupOwnerId", type: "reference", custom: false },
      { name: "Addr__c", label: "Addr", type: "address", custom: true },
      { name: "Enc__c", label: "Enc", type: "encryptedstring", custom: true },
      { name: "Loc__c", label: "Loc", type: "location", custom: true },
    ] };
    const routes = userRoutes({
      describes: { Auto__c: autoDescribe, Skip__c: skipDescribe },
      routes: [
        [/FROM EntityDefinition/, () => [{ QualifiedApiName: "Auto__c", Label: "Automation Settings" }, { QualifiedApiName: "Skip__c", Label: "Skipped" }]],
        [/FROM Auto__c WHERE/, () => [{ SetupOwnerId: "005A", Bypass_Validation__c: true }]],
        [/FROM Skip__c WHERE/, () => ({ fail: "must not be read" })],
      ],
    });
    const a = await readUserAccess(apiFor(routes), "005A");
    assert.equal(a.customSettingsInfo.hierarchy, 1, "all-skipped setting is not counted");
    assert.equal(a.customSettingsInfo.failed, 0, "and is not read");
    assert.equal(a.customSettingsInfo.skippedFields, 4);
    assert.equal(customSettingsSkippedNote(a), "4 fields of special types are not shown.");
    assert.equal(customSettingsLine(a), "1 of 1 custom setting has a value for this user or their profile that differs from the org default.");
    assert.equal(customSettingsSkippedNote(withCs("A", [], failInfo([], { skippedFields: 1 }))), "1 field of a special type is not shown.");
    assert.equal(customSettingsSkippedNote(mk("A", {})), "");
    assert.equal(customSettingsSkippedNote(withCs("A", [], failInfo([], { skippedFields: 2 })), withCs("B", [], failInfo([], { skippedFields: 2 }))), "2 fields of special types are not shown.", "once, not per user");
  });

  await test("territory errors keep their old wording; the new match is for the call center only", async () => {
    const t = await readUserAccess(apiFor(userRoutes({ routes: [[/FROM UserTerritory2Association/, () => ({ fail: "No such column 'Foo' on entity", code: "INVALID_FIELD" })]] })), "005A");
    assert.match(t.unavailable.territories, /^Territories could not be read\. Your user may not have permission/);
    const cc = await readUserAccess(apiFor(userRoutes({ routes: [[/SELECT CallCenter\.Name/, () => ({ fail: "No such column 'CallCenter'", code: "INVALID_FIELD" })]] })), "005A");
    assert.equal(cc.unavailable.callCenter, "Call centers are not available in this org.");
  });

  await test("CSV carries the custom settings notes, single and compare", () => {
    const info = failInfo(["Bad__c"], { skippedFields: 3, capped: true, examined: 300, found: 320 });
    const a = withCs("Ann", [csItem("Auto__c", "Bypass__c", true, "user", false)], info);
    const b = withCs("Bob", [], failInfo([]));
    const single = toRowsSingle(a).filter((r) => r[3] === "Note");
    assert.deepEqual(single.map((r) => r[5]), [customSettingsLine(a), "3 fields of special types are not shown.", "1 setting could not be read."]);
    assert.ok(single.every((r) => r[2] === "Custom settings" && r[0] === "Ann"));
    assert.match(single[0][5], /Only the first 300 of 320/, "cap notice");
    const rows = toRows(compareUsers(a, b), "customSettings").filter((r) => r[1] === "Note");
    assert.equal(rows.length, 3);
    assert.equal(rows[0][4], customSettingsLine(a));
    assert.equal(rows[0][5], customSettingsLine(b));
    assert.equal(rows[1][4], "3 fields of special types are not shown.");
    assert.deepEqual([rows[2][4], rows[2][5]], ["1 setting could not be read.", ""]);
    assert.equal(toRowsSingle(a, "profile").filter((r) => r[3] === "Note").length, 0, "other areas get no note");
    assert.equal(toRows(compareUsers(mk("A", {}), mk("B", {}))).filter((r) => r[1] === "Note").length, 0, "old files have none");
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
