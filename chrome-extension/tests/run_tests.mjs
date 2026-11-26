// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Offline tests. No org, no browser, no npm install:  node tests/run_tests.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { findSession, isSalesforceHost, SfApi, chunk, soqlString, API_VERSION, useNewestVersion } from "../shared/sfconn.js";
import { takeSnapshot, listPsgs, validateSnapshot, SNAPSHOT_SCHEMA } from "../tools/compare-groups/compare-groups-read.js";
import { toCsv } from "../shared/csv.js";
import { SECTION_TITLES, SECTION_HELP, versionNumber, compareSnapshots, toRows, humanize, filterRows, givesCounts, cardCounts, cardLines, tabDiffCount, groupStatus, tabDiffText, sortRows, sortGrouped, sortSection } from "../tools/compare-groups/compare-groups-logic.js";
import { matchPsgs, searchWords } from "../shared/pick.js";

const STORE_FILE = "shared/menu-settings.js"; // the only file allowed to use chrome.storage
const here = path.dirname(fileURLToPath(import.meta.url));
const sample = (n) => JSON.parse(readFileSync(path.join(here, "../samples", n), "utf-8"));

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

await (await import("./user_access_tests.mjs")).run(test);
await (await import("./user_access_eac_tests.mjs")).run(test);
await (await import("./feedback_tests.mjs")).run(test);
await (await import("./hierarchy_tests.mjs")).run(test);
await (await import("./record_access_tests.mjs")).run(test);
await (await import("./flow_usage_tests.mjs")).run(test);
await (await import("./page_details_tests.mjs")).run(test);
await (await import("./error_tracer_tests.mjs")).run(test);
await (await import("./who_grants_tests.mjs")).run(test);
await (await import("./audit_trail_tests.mjs")).run(test);
await (await import("./settings_tests.mjs")).run(test);

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
    routes.urls?.push(u.pathname);
    if (u.pathname === "/services/data/") {
      // The org's version list (routes.versions), or a failure (routes.versionsFail: an HTTP status).
      if (routes.versionsFail) return { ok: false, status: routes.versionsFail, text: async () => JSON.stringify([{ message: routes.versionsFail === 401 ? "Session expired or invalid" : "down", errorCode: "X" }]) };
      body = (routes.versions || ["60.0", "67.0", "68.0"]).map((v) => ({ version: v, label: v, url: `/services/data/v${v}` }));
    } else if (u.pathname.endsWith("/sobjects/")) {
      body = { sobjects: [{ name: "Account", label: "Customer Account" }, { name: "Contact", label: "Contact" }] };
    } else if (u.pathname.endsWith("/describe/")) {
      const sobject = u.pathname.split("/").at(-3);
      body = routes.describe(sobject, /\/v(\d+\.\d)\//.exec(u.pathname)?.[1]);
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

await test("401 keeps the plain text on top and the raw text in detail", async () => {
  const api = new SfApi({
    apiHost: "x.my.salesforce.com", sessionId: "S",
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => JSON.stringify([{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }]) }),
  });
  await assert.rejects(api.query("SELECT Id FROM User"), (e) =>
    e.message === "Your Salesforce session has expired. Reload the Salesforce tab, then try again." && e.detail === "Session expired or invalid" && e.status === 401);
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

await test("a group that is missing or not set up gives a plain message", async () => {
  const none = snapshotRoutes();
  none.query.unshift([/FROM PermissionSetGroup WHERE Id/, () => []]);
  await assert.rejects(takeSnapshot(apiWith(none), "0PGX"), (e) => e.plain === true && e.message === "This group could not be found. It may have been deleted. Reload the page and pick it again.");
  const noAgg = snapshotRoutes();
  noAgg.query.unshift([/FROM PermissionSet WHERE PermissionSetGroupId/, () => []]);
  await assert.rejects(takeSnapshot(apiWith(noAgg), "0PG1"), (e) => e.plain === true && e.message.startsWith("Salesforce has not finished setting up this group yet."));
});

await test("a group that is not Updated gets a warning", async () => {
  const s = await takeSnapshot(apiWith(snapshotRoutes({ status: "Outdated" })), "0PG1");
  assert.ok(s.warnings.some((w) => w.startsWith("Not up to date (Outdated)")));
});

await test("listPsgs qualifies namespaced names", async () => {
  const list = await listPsgs(apiWith(snapshotRoutes()));
  assert.deepEqual(list, [{ id: "0PG1", developerName: "ns__Sales", label: "Sales", status: "Updated" }]);
});

await test("validateSnapshot accepts the samples and rejects other JSON", () => {
  validateSnapshot(sample("sample_a.json"));
  validateSnapshot(sample("sample_b.json"));
  assert.throws(() => validateSnapshot({ hello: 1 }), /Not a saved group file/);
  const broken = sample("sample_a.json");
  delete broken.fieldPermissions;
  assert.throws(() => validateSnapshot(broken), /missing "fieldPermissions"/);
});

// ---------- API version ----------

console.log("api version");

/** snapshotRoutes plus a permission and an object flag that only API 68.0 and newer describe; calls are noted in `urls`. */
function versionedRoutes(extra = {}) {
  const base = snapshotRoutes();
  base.urls = [];
  Object.assign(base, extra);
  const newer = (v) => Number(v) >= 68;
  base.describe = (s, v) => ({
    fields: s === "PermissionSet" ? [...PS_FIELDS, ...(newer(v) ? [{ name: "PermissionsNewOnly", label: "New Only", type: "boolean" }] : [])]
      : s === "ObjectPermissions" ? [...OP_FIELDS, ...(newer(v) ? [{ name: "PermissionsViewAllFields", label: "View All Fields", type: "boolean" }] : [])] : [],
  });
  base.query = base.query.map(([re, fn]) => [re, (q, tooling) => {
    const r = fn(q, tooling);
    if (/FROM PermissionSet WHERE Id = '0PSAGG/.test(q) && q.includes("PermissionsNewOnly")) r[0].PermissionsNewOnly = true;
    if (/FROM ObjectPermissions/.test(q) && q.includes("PermissionsViewAllFields") && !q.includes("MUTE")) r.forEach((x) => { x.PermissionsViewAllFields = true; });
    return r;
  }]);
  return base;
}
const versioned = (p) => p.filter((x) => x !== "/services/data/");

await test("the default API version is 67.0 and a new client starts there", () => {
  assert.equal(API_VERSION, "67.0");
  assert.equal(new SfApi({ apiHost: "x", sessionId: "S" }).apiVersion, "67.0");
  assert.equal(typeof useNewestVersion, "function");
});

await test("compare groups reads at the org's newest version: a permission and View All Fields that only it describes show up", async () => {
  const routes = versionedRoutes();
  const api = apiWith(routes);
  const s = await takeSnapshot(api, "0PG1", { org: { id: "00D1", name: "Acme" } });
  assert.equal(s.apiVersion, "68.0");
  assert.equal(s.userPermissions.PermissionsNewOnly, "New Only");
  assert.equal(s.objectPermissions.Account.ViewAllFields, true);
  assert.ok(versioned(routes.urls).length > 5 && versioned(routes.urls).every((p) => p.startsWith("/services/data/v68.0/")), "nothing is described or queried at the default version");
  // The same group read by a copy that only sees 67.0 lacks them, so two such groups would have looked the same.
  const old = await takeSnapshot(apiWith(versionedRoutes({ versions: ["60.0", "67.0"] })), "0PG1", { org: { id: "00D1", name: "Acme" } });
  assert.equal(old.apiVersion, "67.0");
  assert.ok(!("PermissionsNewOnly" in old.userPermissions) && !("ViewAllFields" in old.objectPermissions.Account));
  const r = compareSnapshots(s, old);
  assert.equal(r.sections.userPermissions.find((x) => x.key === "PermissionsNewOnly").status, "onlyA");
  assert.deepEqual(r.sections.objectPermissions.find((x) => x.key === "Account").aExtra, ["ViewAllFields"]);
});

await test("an org whose newest version is below the default is read at its own newest version", async () => {
  const routes = versionedRoutes({ versions: ["60.0", "66.0"] });
  const api = apiWith(routes);
  const s = await takeSnapshot(api, "0PG1");
  assert.equal(s.apiVersion, "66.0");
  assert.equal(api.versionListFailed, undefined);
  assert.ok(versioned(routes.urls).length > 5 && versioned(routes.urls).every((p) => p.startsWith("/services/data/v66.0/")), routes.urls.join(","));
  const direct = apiWith(versionedRoutes({ versions: ["66.0"] }));
  assert.equal(await useNewestVersion(direct), "66.0");
  assert.equal(direct.apiVersion, "66.0");
  const junk = apiWith(versionedRoutes({ versions: ["0.0", "-5.0"] }));
  await useNewestVersion(junk);
  assert.equal(junk.apiVersion, "67.0");
  assert.equal(junk.versionListFailed, true);
});

await test("listPsgs asks for the version list first, then reads at the newest version", async () => {
  const routes = versionedRoutes();
  const list = await listPsgs(apiWith(routes));
  assert.equal(list.length, 1);
  assert.equal(routes.urls[0], "/services/data/");
  assert.ok(routes.urls.slice(1).every((p) => p.startsWith("/services/data/v68.0/")), routes.urls.join(","));
});

await test("the version list is asked once per client, however many groups are read", async () => {
  const routes = versionedRoutes();
  const api = apiWith(routes);
  await listPsgs(api);
  await Promise.all([takeSnapshot(api, "0PG1"), takeSnapshot(api, "0PG1")]);
  assert.equal(routes.urls.filter((p) => p === "/services/data/").length, 1);
});

await test("when the version list cannot be read, it still reads at 67.0 and the group says what may be missing", async () => {
  for (const versionsFail of [500, 404]) {
    const routes = versionedRoutes({ versionsFail });
    const api = apiWith(routes);
    const s = await takeSnapshot(api, "0PG1");
    assert.equal(api.versionListFailed, true);
    assert.equal(s.apiVersion, "67.0");
    assert.ok(versioned(routes.urls).every((p) => p.startsWith("/services/data/v67.0/")));
    const w = s.warnings.filter((x) => /newest releases/.test(x));
    assert.deepEqual(w, ["This tool could not ask Salesforce which versions it offers, so permissions added in the newest releases may be missing. Reload the page, then read this group again."]);
    // On the page it reads well: no "Try Compare again" (it would not help), and no "snapshot" or "PSG".
    const note = compareSnapshots(s, s).highlights.find((h) => h.text.includes("newest releases"));
    assert.equal(note.level, "warn");
    assert.equal(note.text, `Sales: ${w[0]}`);
    assert.ok(!/snapshot|PSG|Try Compare again/i.test(note.text));
  }
});

await test("a list with no usable versions also keeps 67.0 with the warning", async () => {
  const routes = versionedRoutes({ versions: [] });
  const s = await takeSnapshot(apiWith(routes), "0PG1");
  assert.equal(s.apiVersion, "67.0");
  assert.ok(s.warnings.some((x) => /newest releases/.test(x)));
});

await test("an expired session (401) still shows the session message, also when the version list is what failed", async () => {
  const dead = () => new SfApi({ apiHost: "x.my.salesforce.com", sessionId: "S", fetchImpl: async () => ({ ok: false, status: 401, text: async () => JSON.stringify([{ message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" }]) }) });
  for (const run of [(api) => listPsgs(api), (api) => takeSnapshot(api, "0PG1")]) {
    const api = dead();
    await assert.rejects(run(api), (e) => e.status === 401 && e.message === "Your Salesforce session has expired. Reload the Salesforce tab, then try again.");
    assert.equal(api.apiVersion, "67.0");
  }
  // Only the list answers 401 (the later reads work): the group is read, not blocked by the list.
  const s = await takeSnapshot(apiWith(versionedRoutes({ versionsFail: 401 })), "0PG1");
  assert.equal(s.apiVersion, "67.0");
});

await test("a saved group file records apiVersion as a string and survives a save and load", async () => {
  const s = await takeSnapshot(apiWith(versionedRoutes()), "0PG1");
  assert.equal(s.schema, "sf-psg-snapshot/3");
  assert.equal(typeof s.apiVersion, "string");
  const back = validateSnapshot(JSON.parse(JSON.stringify(s)));
  assert.equal(back.apiVersion, "68.0");
  assert.equal(versionNumber(back), 68);
  for (const n of ["sample_a.json", "sample_b.json"]) assert.equal(sample(n).apiVersion, "67.0");
  assert.equal(compareSnapshots(sample("sample_a.json"), sample("sample_b.json")).highlights.filter((h) => /API version|earlier copy/.test(h.text)).length, 0, "the demo shows no version note");
});

await test("saved files of schema /1 and /2 still load and compare as before", () => {
  for (const schema of ["sf-psg-snapshot/1", "sf-psg-snapshot/2", "sf-psg-snapshot/3"]) {
    const f = structuredClone(sample("sample_a.json"));
    f.schema = schema;
    if (schema !== "sf-psg-snapshot/3") delete f.apiVersion;
    assert.equal(validateSnapshot(f), f);
  }
  assert.throws(() => validateSnapshot({ ...sample("sample_a.json"), schema: "sf-psg-snapshot/4" }), /Not a saved group file/);
  const two = structuredClone(sample("sample_a.json"));
  two.schema = "sf-psg-snapshot/2";
  delete two.apiVersion;
  const same = compareSnapshots(two, sample("sample_b.json"));
  const plain = compareSnapshots(sample("sample_a.json"), sample("sample_b.json"));
  assert.deepEqual(same.sections, plain.sections);
  assert.deepEqual(same.counts, plain.counts);
});

const withVersion = (v, name) => {
  const s = structuredClone(sample("sample_a.json"));
  if (v === undefined) delete s.apiVersion; else s.apiVersion = v;
  if (name) s.psg.label = name;
  return s;
};
const versionNotes = (r) => r.highlights.filter((h) => h.kind === "note" && /API version|earlier copy/.test(h.text));

await test("version note: two known and different versions name which group used which and how to fix it", () => {
  const r = compareSnapshots(withVersion("67.0", "Older"), withVersion("68.0", "Newer"));
  const n = versionNotes(r);
  assert.equal(n.length, 1);
  assert.equal(n[0].level, "warn");
  assert.equal(n[0].text, "Older was read with Salesforce API version 67.0 and Newer with 68.0. Permissions that exist only in the newer version can look like a difference when they are not (they show as only in Newer). To fix this, read Older again from its org (and save its file again if you use a file), then compare.");
  const flipped = versionNotes(compareSnapshots(withVersion("68.0", "Newer"), withVersion("67.0", "Older")));
  assert.equal(flipped[0].text, n[0].text, "the older group is named whichever side it is on");
  assert.equal(versionNotes(compareSnapshots(withVersion("68", "A1"), withVersion("68.0", "B1"))).length, 0, "68 equals 68.0");
  assert.equal(versionNotes(compareSnapshots(withVersion("67.0"), withVersion("67.0"))).length, 0, "same version, no note");
  assert.equal(versionNotes(compareSnapshots(withVersion("9.0", "Low"), withVersion("10.0", "High")))[0].text.startsWith("Low was read with Salesforce API version 9.0 and High with 10.0."), true, "compared as numbers, not as text");
});

await test("version note: groups from different orgs say the note stays while the older org is on an older release", () => {
  const org = (id, name) => ({ id, name, isSandbox: false });
  const mk = (v, name, o) => Object.assign(withVersion(v, name), { org: o });
  const n = versionNotes(compareSnapshots(mk("67.0", "Older", org("00D1", "Prod")), mk("68.0", "Newer", org("00D2", "Dev"))));
  assert.equal(n.length, 1);
  assert.equal(n[0].text, "Older was read with Salesforce API version 67.0 and Newer with 68.0. Permissions that exist only in the newer version can look like a difference when they are not (they show as only in Newer). If the org of Older now offers a newer version, read Older again (and save its file again if you use a file). If that org is on an older Salesforce release, the note stays until both orgs are on the same release.");
});

await test("version note: the same group label on both sides is told apart by org name, else by first and second", () => {
  const org = (id, name) => ({ id, name, isSandbox: false });
  const mk = (v, o) => Object.assign(withVersion(v, "Sales"), { org: o });
  const t = versionNotes(compareSnapshots(mk("67.0", org("00D1", "Prod")), mk("68.0", org("00D2", "Dev"))))[0].text;
  assert.ok(t.startsWith("Sales (Prod) was read with Salesforce API version 67.0 and Sales (Dev) with 68.0."), t);
  assert.ok(t.includes("only in Sales (Dev)") && t.includes("read Sales (Prod) again"), t);
  const u = versionNotes(compareSnapshots(mk("68.0", org("00D1", "Prod")), mk("67.0", org("00D1", "Prod"))))[0].text;
  assert.ok(u.startsWith("Sales (second group) was read with Salesforce API version 67.0 and Sales (first group) with 68.0."), u);
  assert.ok(u.includes("To fix this, read Sales (second group) again from its org"), u);
});

await test("version note: one file without a version says it was saved by an earlier copy", () => {
  const expected = (old, other) => `The file for ${old} was saved by an earlier copy of this tool, which did not see the newest Salesforce permissions. Permissions that exist only in newer versions can look like a difference when they are not (they show as only in ${other}). To fix this, read ${old} again from its org and save its file again, then compare.`;
  const a = versionNotes(compareSnapshots(withVersion(undefined, "Old file"), withVersion("68.0", "Fresh")));
  assert.deepEqual(a.map((h) => [h.level, h.text]), [["warn", expected("Old file", "Fresh")]]);
  const b = versionNotes(compareSnapshots(withVersion("68.0", "Fresh"), withVersion(undefined, "Old file")));
  assert.deepEqual(b.map((h) => h.text), [expected("Old file", "Fresh")]);
});

await test("version note: both without a version says some differences may be missing", () => {
  const n = versionNotes(compareSnapshots(withVersion(undefined, "One"), withVersion(undefined, "Two")));
  assert.deepEqual(n.map((h) => [h.level, h.text]), [["warn", "Both files were saved by an earlier copy of this tool, which did not see the newest Salesforce permissions, so some differences may be missing. To fix this, read both groups again from their orgs and save their files again, then compare."]]);
});

await test("version note: odd or hand-edited values count as not recorded and never break the page", () => {
  const odd = [null, 68, true, [], {}, "", " ", "garbage", "68.0.1", "v68.0", "NaN", "Infinity", "-1", "68,0", "1e3", "<b>x</b>", "9".repeat(5000)];
  for (const v of odd) {
    assert.equal(versionNumber({ apiVersion: v }), null, JSON.stringify(v));
    const f = withVersion(v);
    validateSnapshot(f);
    const r = compareSnapshots(f, withVersion("68.0"));
    assert.equal(versionNotes(r).length, 1, JSON.stringify(v));
    assert.ok(toRows(r).length > 1);
  }
  assert.equal(versionNumber(null), null);
  assert.equal(versionNumber(undefined), null);
  assert.equal(versionNumber({ apiVersion: "68" }), 68);
  assert.equal(versionNumber({ apiVersion: " 67.0 " }), 67);
});

await test("version note: a result with no differences still carries the note, and no note text says snapshot or PSG", () => {
  const r = compareSnapshots(withVersion("67.0", "Same Name"), withVersion(undefined, "Same Name 2"));
  assert.equal(r.highlights.find((h) => h.kind === "verdict").text, "Both groups have exactly the same access.");
  const n = versionNotes(r);
  assert.equal(n.length, 1);
  assert.equal(n[0].level, "warn");
  for (const h of [...n, ...versionNotes(compareSnapshots(withVersion("67.0"), withVersion("68.0"))), ...versionNotes(compareSnapshots(withVersion(undefined), withVersion(undefined)))]) assert.ok(!/snapshot|PSG/i.test(h.text), h.text);
  const page = readFileSync(path.join(here, "../tools/compare-groups/compare-groups.js"), "utf-8");
  assert.ok(/kind === "note"/.test(page) && /h\.level === "warn"/.test(page), "the page lists every note and raises the alert for warn notes, whatever the verdict");
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
  assert.ok(texts.includes("Only Sales Manager has View All Data."), texts.join("\n"));
});

await test("objects: flag-level differences in both directions", () => {
  const opp = row("objectPermissions", "Opportunity");
  assert.equal(opp.status, "differ");
  assert.deepEqual(opp.bExtra, ["Delete", "ViewAllRecords", "ModifyAllRecords"]);
  assert.deepEqual(opp.aExtra, []);
  assert.equal(row("objectPermissions", "Campaign").status, "onlyA");
  assert.equal(row("objectPermissions", "Quota__c").status, "onlyB");
  assert.equal(row("objectPermissions", "Widget__c").status, "same");
  assert.ok(texts.some((t) => /^Sales Manager can view or change every record on 2 objects \(.*Opportunity.*\), where .+ has less\. See Objects\.$/.test(t)), texts.join("\n"));
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
  assert.deepEqual([mOpp.status, mOpp.a, mOpp.label, mOpp.kind], ["onlyA", "Delete removed", "Opportunity", "Object"]);
  assert.equal(muted.find((r) => r.label === "Export Reports").a, "Removed");
  assert.equal(muted.find((r) => r.label === "Export Reports").kind, "System permission");
  assert.ok(muted.some((r) => r.label === "Export Reports"));
  assert.equal(muted.find((r) => r.key === "Account.AnnualRevenue").label, "Account › Annual Revenue");
  assert.equal(row("setupAccess", "Approve_Discounts").status, "onlyB");
  assert.equal(row("tabs", "Widget__c").status, "differ");
  assert.equal(row("tabs", "standard-Campaign").status, "onlyA");
});

await test("overview and verdict", () => {
  assert.equal(row("overview", "Users assigned").a, "398 active (412 in total)");
  assert.equal(row("overview", "Muting permission set").b, "None");
  assert.ok(texts.includes(`Sales Rep has ${R.gives.a} things Sales Manager doesn't. Sales Manager has ${R.gives.b} things Sales Rep doesn't.`), texts.join("\n"));
  assert.ok(R.gives.a > 0 && R.gives.b > R.gives.a);
  assert.equal(R.counts.userPermissions.onlyB, 5);
});

await test("a group compared with itself is identical", () => {
  const same = compareSnapshots(A, structuredClone(A));
  assert.equal(same.highlights.find((h) => h.level === "good")?.text, "Both groups have exactly the same access.");
  for (const k of ["userPermissions", "objectPermissions", "fieldPermissions", "setupAccess", "tabs", "components"]) {
    assert.equal(same.counts[k].same, same.counts[k].total, k);
  }
});

await test("superset is detected", () => {
  const bigger = structuredClone(A);
  bigger.psg.label = "Rep Plus";
  bigger.userPermissions.PermissionsManageUsers = "Manage Users";
  const r = compareSnapshots(bigger, A);
  assert.ok(r.highlights.some((h) => h.text === "Rep Plus has everything Sales Rep has, and 1 more."));
  assert.ok(r.highlights.some((h) => h.level === "risk" && h.text === "Only Rep Plus has Manage Users."));
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
  assert.equal(a, "Big Group can view or change every record on 8 objects (Account, Lead, Thing0 and 5 more), where Small Group has less. See Objects.");
  assert.ok(!a.includes("Case"));
  assert.equal(h[3].text, "Small Group can view or change every record on 1 object (Zed), where Big Group has less. See Objects.");
});

await test("highlights: every risk carries its side and a short text for the grouped view", () => {
  const h = heavyPair().highlights.filter((x) => x.kind === "risk");
  assert.deepEqual(h.map((x) => x.side), ["a", "a", "a", "b"]);
  assert.ok(!/[“”]/.test(h[0].short) && !h[0].short.includes("Big Group"), h[0].short);
  assert.equal(h[2].short, "More access to every record on 8 objects (Account, Lead, Thing0 and 5 more) than Small Group. See Objects.");
  assert.equal(h[3].short, "More access to every record on 1 object (Zed) than Big Group. See Objects.");
  // A system permission only in B gets side "b" and no group name in the short text.
  const x = structuredClone(A);
  const y = structuredClone(A);
  y.userPermissions.PermissionsAssignPermissionSets = "Assign Permission Sets";
  const g = compareSnapshots(x, y).highlights.find((r) => r.area === "general" && r.text.includes("Assign Permission Sets"));
  assert.ok(g, "expected a general risk for Assign Permission Sets");
  assert.equal(g.side, "b");
  assert.equal(g.short, "Assign Permission Sets");
  assert.ok(g.text.startsWith("Only ") && g.text.endsWith("has Assign Permission Sets."));
});

await test("verdict counts what each group gives that the other does not", () => {
  const r = heavyPair();
  // A: 2 general permissions + 14 objects (12 Thing, Account, Case, Lead = 15) + fields F1, F2
  // B: Zed__c + Account.F3
  assert.deepEqual(r.gives, { a: 2 + 15 + 2, b: 2 });
  assert.equal(r.highlights.find((x) => x.kind === "verdict").text,
    "Big Group has 19 things Small Group doesn't. Small Group has 2 things Big Group doesn't.");
  // the second, muted line says what is counted
  assert.ok(r.highlights.find((x) => x.kind === "verdict").detail ===
    "Counts system permissions, objects, fields, apps and other access, and tabs (not permission sets). If both groups have an item but one has more, such as Edit instead of Read, it counts for that group.");
  assert.deepEqual(givesCounts(compareSnapshots(A, structuredClone(A)).sections), { a: 0, b: 0 });
  assert.ok(compareSnapshots(A, structuredClone(A)).highlights[0].text.startsWith("Both groups"));
});

await test("objects line: Modify All added on top of View All still counts", () => {
  const x = structuredClone(A);
  const y = structuredClone(A);
  x.objectPermissions.Case = { Read: true, ViewAllRecords: true, ModifyAllRecords: true };
  y.objectPermissions.Case = { Read: true, ViewAllRecords: true };
  const t = compareSnapshots(x, y).highlights.find((h) => h.area === "objects").text;
  assert.ok(/^Sales Rep can view or change every record on 1 object \(Case\), where .+ has less\. See Objects\.$/.test(t), t);
});

await test("fields: a difference says which side has more", () => {
  const f2 = heavyPair().sections.fieldPermissions.find((x) => x.key === "Account.F2");
  assert.deepEqual([f2.status, f2.more], ["differ", "a"]);
});

await test("permission sets show In this group, license as secondary text; counts are split", () => {
  const sets = R.sections.components.filter((x) => x.part === "sets");
  assert.ok(sets.every((x) => x.a === null || x.a === "In this group"));
  assert.ok(sets.some((x) => x.aSub === "needs Salesforce license" || x.bSub === "needs Salesforce license"), JSON.stringify(sets));
  const regular = sets.filter((x) => x.group !== "Muting permission set");
  assert.equal(R.counts.componentSets.total, regular.length);
  assert.equal(R.counts.componentMutingSet.total, sets.length - regular.length);
  assert.ok(R.counts.componentMutingSet.total > 0); // the sample groups have a muting permission set
  assert.equal(R.counts.componentSets.total + R.counts.componentMutingSet.total + R.counts.componentMuted.total, R.counts.components.total);
});

await test("card counts match the What's inside list (muting set excluded)", () => {
  const rows = R.sections.components;
  const n = (f, st) => rows.filter((r) => f(r) && r.status === st).length;
  const sets = (r) => r.part === "sets" && r.group !== "Muting permission set";
  const muted = (r) => r.part === "muted";
  for (const st of ["onlyA", "onlyB", "differ"]) {
    assert.equal(R.counts.componentSets[st], n(sets, st));
    assert.equal(R.counts.componentMuted[st], n(muted, st));
  }
});

await test("muted item on both sides with different values is Different, not Same", () => {
  const x = structuredClone(A);
  const y = structuredClone(A);
  x.muting.effective.fieldPermissions = { "Account.AnnualRevenue": { Read: true, Edit: true } };
  y.muting.effective.fieldPermissions = { "Account.AnnualRevenue": { Read: true } };
  const m = compareSnapshots(x, y).sections.components.find((r) => r.part === "muted" && r.key === "Account.AnnualRevenue");
  assert.deepEqual([m.status, m.a, m.b, m.kind], ["differ", "Read, Edit removed", "Read removed", "Field"]);
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
  const kinds = toRows(R, "components").filter((r) => r[1] === "Removed by muting").map((r) => r[9]);
  assert.ok(kinds.length && kinds.every((k) => ["Object", "Field", "System permission", "Tab", "App or other access"].includes(k)), kinds.join());
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
    "Customer Account: Delete removed",
    "Customer Account › Customer Segmentation: Read, Edit removed",
    "Customer Account › F2: Edit removed",
    "Customer Account › F4: Edit removed",
    "Customer Account › F5: Read, Edit removed",
    "Log Entry: Removed",
    "Perm 5: Removed",
  ].sort());
  const note = r.highlights.find((h) => h.text.includes("removes nothing") || h.text.includes("remove nothing"));
  assert.ok(note && note.text === "G: the muting permission set has 5 more items, but they remove nothing, so they are not listed.", JSON.stringify(r.highlights));
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
  // only the old file's side says "not confirmed"
  assert.ok(muted.filter((x) => x.a !== null).every((x) => x.legacy), "A side is legacy");
  assert.ok(muted.filter((x) => x.a === null).every((x) => !x.legacy), "B side is not");
  assert.deepEqual(r.mutedLegacy, { a: true, b: false });
  assert.ok(toRows(r).some((x) => x[1] === "Removed by muting (not confirmed, older saved file)"));
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
  assert.equal(bad.warnings.filter((w) => w.includes("Could not read the names of some fields")).length, 1);
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
  assert.ok(s.warnings.includes("2 external credential principals could not be named in this org, so they are listed by Id, which differs between orgs."), s.warnings.join("\n"));
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

// ---------- summary cards and sorting ----------

const fake = (sections) => ({ sections: { components: [], userPermissions: [], objectPermissions: [], fieldPermissions: [], setupAccess: [], tabs: [], ...sections } });
const text = (res, k) => cardLines(res, k).lines.map((l) => `${l.n.toLocaleString("en-US")} ${l.before}${l.side ? ` <${l.side}>` : ""}${l.after ? ` ${l.after}` : ""}`);
const totals = (res, k) => { const t = cardLines(res, k).totals; return `${t.a}/${t.b} ${t.noun}`; };

await test("cards: system permissions, apps and objects count what each side has", () => {
  const res = fake({
    userPermissions: [
      { status: "same", a: true, b: true }, { status: "onlyA", a: true, b: false }, { status: "onlyA", a: true, b: false }, { status: "onlyB", a: false, b: true },
    ],
    objectPermissions: [
      { status: "same", a: ["Read"], b: ["Read"] }, { status: "onlyB", a: [], b: ["Read", "Edit"] }, { status: "differ", a: ["Read"], b: ["Read", "Edit"] },
    ],
    setupAccess: [{ status: "onlyA", a: true, b: false }],
  });
  assert.deepEqual(text(res, "userPermissions"), ["3 system permissions only one group has"]);
  assert.equal(totals(res, "userPermissions"), "3/2 system permissions");
  assert.deepEqual(text(res, "objectPermissions"), ["1 object only one group can access", "1 object with different rights"]);
  assert.equal(totals(res, "objectPermissions"), "2/3 objects");
  assert.deepEqual(text(res, "setupAccess"), ["1 item only one group can use"]);
  assert.equal(totals(res, "setupAccess"), "1/0 items");
});

await test("cards: fields count Read or Edit; tabs ignore Hidden; zero lines stay", () => {
  const res = fake({
    fieldPermissions: [
      { status: "differ", a: "Edit", b: "Read" }, { status: "same", a: "Read", b: "Read" }, { status: "onlyA", a: "Read", b: "No access" },
    ],
    tabs: [
      { status: "same", a: "Shown", b: "Shown" },
      { status: "differ", a: "Shown", b: "Hidden" },
      { status: "onlyB", a: null, b: "Available (hidden by default)" },
      { status: "onlyA", a: "Hidden", b: null },
    ],
  });
  assert.deepEqual(text(res, "fieldPermissions"), ["1 field only one group can see", "1 field where one group can edit and the other can only read"]);
  assert.equal(totals(res, "fieldPermissions"), "3/2 fields");
  assert.deepEqual(text(res, "tabs"), ["2 tabs only one group can see", "0 tabs set up differently (shown or hidden by default)"]);
  assert.equal(totals(res, "tabs"), "2/2 tabs");
  assert.deepEqual(cardCounts(fake({})).tabs, { a: 0, b: 0, only: 0, differ: 0 });
});

await test("cards: tab counts follow who can see the tab (Hidden cannot be seen)", () => {
  const tabs = (...rows) => cardCounts(fake({ tabs: rows.map(([status, a, b]) => ({ status, a, b })) })).tabs;
  // Hidden in one group, absent in the other: nobody can see it, not counted
  assert.deepEqual(tabs(["onlyA", "Hidden", null]), { a: 0, b: 0, only: 0, differ: 0 });
  assert.deepEqual(tabs(["onlyB", null, "Hidden"]), { a: 0, b: 0, only: 0, differ: 0 });
  // Hidden in both, or Hidden vs Hidden: not counted
  assert.deepEqual(tabs(["same", "Hidden", "Hidden"]), { a: 0, b: 0, only: 0, differ: 0 });
  // Shown in one, Hidden in the other: only one group can see it
  assert.deepEqual(tabs(["differ", "Shown", "Hidden"]), { a: 1, b: 0, only: 1, differ: 0 });
  assert.deepEqual(tabs(["differ", "Hidden", "Available (hidden by default)"]), { a: 0, b: 1, only: 1, differ: 0 });
  // Shown in one, absent in the other: only one group
  assert.deepEqual(tabs(["onlyA", "Shown", null]), { a: 1, b: 0, only: 1, differ: 0 });
  // Shown vs Available (DefaultOn vs DefaultOff): both can see, set differently
  assert.deepEqual(tabs(["differ", "Shown", "Available (hidden by default)"]), { a: 1, b: 1, only: 0, differ: 1 });
});

await test("cards: What is inside leaves out the muting permission set; singular words", () => {
  const set = (status, group = "Permission set") => ({ part: "sets", group, status });
  const muted = (status) => ({ part: "muted", status });
  const res = fake({
    components: [set("same"), set("onlyA"), set("onlyB", "Muting permission set"), set("onlyB"), muted("onlyA"), muted("differ"), muted("same")],
  });
  assert.deepEqual(cardCounts(res).components, { a: 2, b: 2, only: 2, mutedOnly: 1, mutedDiffer: 1 });
  assert.deepEqual(text(res, "components"), [
    "2 permission sets in only one group",
    "1 item removed by muting in only one group", "1 item removed by muting in both, but differently"]);
  assert.equal(totals(res, "components"), "2/2 permission sets");
  assert.equal(text(fake({ components: [set("onlyA")] }), "components")[0], "1 permission set in only one group");
  // no card line says "things"
  assert.ok(!["userPermissions", "objectPermissions", "fieldPermissions", "setupAccess", "tabs", "components"].some((k) => text(res, k).some((t) => /thing/.test(t))));
});

await test("cards: identical groups show the two totals and Same in both", () => {
  const res = fake({ tabs: [{ status: "same", a: "Shown", b: "Shown" }], components: [{ part: "sets", group: "Permission set", status: "same" }] });
  assert.equal(cardLines(res, "tabs").same, true);
  assert.deepEqual(text(res, "tabs"), []);
  assert.equal(totals(res, "tabs"), "1/1 tabs");
  assert.equal(cardLines(res, "components").same, true);
  assert.equal(cardLines(fake({ userPermissions: [{ status: "onlyA", a: true, b: false }] }), "userPermissions").same, false);
});

await test("group status wording: Updated is Up to date, anything else says what to do", () => {
  assert.equal(groupStatus("Updated"), "Up to date");
  assert.equal(groupStatus("Outdated"), "Not up to date (Outdated). In Setup, open this group and wait for its status to say Updated.");
  assert.ok(groupStatus(null).startsWith("Not up to date (unknown)"));
  assert.equal(R.sections.overview.find((r) => r.key === "Status").a, "Up to date");
});

await test("tab set differently says what differs; other rows get no text", () => {
  const r = { status: "differ", a: "Shown", b: "Hidden" };
  assert.equal(tabDiffText(r, "Sales Rep", "Sales Manager"), "Different: shown by default in Sales Rep, hidden in Sales Manager");
  assert.equal(tabDiffText({ status: "differ", a: "Available (hidden by default)", b: "Shown" }, "A", "B"), "Different: available but hidden by default in A, shown by default in B");
  assert.equal(tabDiffText({ status: "onlyA", a: "Shown", b: null }), null);
  assert.equal(tabDiffText({ status: "differ", a: ["Read"], b: ["Edit"] }), null);
  assert.equal(sortRows([r], "diff", "asc", "Sales Rep", "Sales Manager").length, 1);
});

await test("visible wording: license (US), area names, no PSG or snapshot words", () => {
  const titles = Object.values(SECTION_TITLES).join("|");
  assert.ok(titles.includes("Apps and other access") && titles.includes("Tab settings"));
  assert.ok(!/PSG|snapshot|licence/i.test(titles + Object.values(SECTION_HELP).join("|")));
  assert.ok(R.sections.components.filter((r) => r.part === "muted").every((r) => !/\(tab\)/.test(r.label)));
});

await test("cards on the sample result agree with the list rows", () => {
  const c = cardCounts(R);
  const rows = R.sections.objectPermissions;
  assert.equal(c.objectPermissions.only, rows.filter((r) => r.status === "onlyA" || r.status === "onlyB").length);
  assert.equal(c.objectPermissions.a, rows.filter((r) => r.a.length).length);
  assert.equal(c.userPermissions.a, R.sections.userPermissions.filter((r) => r.a).length);
});

await test("sort: A to Z, Z to A, natural numbers, no case, empty last", () => {
  const rows = ["item 10", "Item 2", "banana", "", "Apple"].map((label, i) => ({ label, a: i % 2 ? "Read" : null, status: "same" }));
  assert.deepEqual(sortRows(rows, "item").map((r) => r.label), ["Apple", "banana", "Item 2", "item 10", ""]);
  assert.deepEqual(sortRows(rows, "item", "desc").map((r) => r.label), ["item 10", "Item 2", "banana", "Apple", ""]);
  // Text columns (here with a part, like What's inside) keep empty last.
  const parts = rows.map((r) => ({ ...r, part: "sets" }));
  assert.deepEqual(sortRows(parts, "a").map((r) => r.a), ["Read", "Read", null, null, null]);
  assert.deepEqual(sortRows(parts, "a", "desc").map((r) => r.a), ["Read", "Read", null, null, null]);
  assert.equal(rows[0].label, "item 10"); // input untouched
  assert.deepEqual(sortRows(rows, null), rows);
});

await test("sort: object flags and the Difference column sort by what is shown", () => {
  const rows = [
    { label: "O1", status: "differ", a: ["Read"], b: ["Read", "Edit"], aExtra: [], bExtra: ["Edit"] },
    { label: "O2", status: "onlyA", a: ["Read"], b: [], aExtra: ["Read"], bExtra: [] },
    { label: "O3", status: "same", a: ["Read"], b: ["Read"] },
  ];
  assert.deepEqual(sortRows(rows, "diff", "asc", "Sales", "Service").map((r) => r.label), ["O2", "O1", "O3"]);
  assert.deepEqual(sortRows(rows, "b").map((r) => r.label), ["O2", "O3", "O1"]); // least rights first
});

await test("sort: grouped lists sort inside each object, and the item column orders the objects", () => {
  const rows = [
    { group: "Contact", label: "Zip", a: "Read" }, { group: "Contact", label: "Age", a: "Edit" },
    { group: "Account", label: "Name", a: "Read" }, { group: "Account", label: "Fax", a: null },
  ];
  const names = (list) => list.map((r) => `${r.group}.${r.label}`);
  assert.deepEqual(names(sortGrouped(rows, "item")), ["Account.Fax", "Account.Name", "Contact.Age", "Contact.Zip"]);
  assert.deepEqual(names(sortGrouped(rows, "item", "desc")), ["Contact.Zip", "Contact.Age", "Account.Name", "Account.Fax"]);
  // Another column: the objects stay in their original order.
  assert.deepEqual(names(sortGrouped(rows, "a")), ["Contact.Zip", "Contact.Age", "Account.Fax", "Account.Name"]);
  assert.deepEqual(names(sortGrouped(rows, "a", "desc")), ["Contact.Age", "Contact.Zip", "Account.Name", "Account.Fax"]);
});

await test("sort: What is inside keeps its two parts; the CSV follows the sort", () => {
  const rows = [
    { part: "sets", label: "B", status: "same" }, { part: "muted", label: "A", status: "same", kind: "Field" },
    { part: "sets", label: "A", status: "same" }, { part: "muted", label: "C", status: "same", kind: "Tab" },
  ];
  assert.deepEqual(sortSection(rows, "components", { col: "item", dir: "desc" }).map((r) => r.label), ["B", "A", "C", "A"]);
  const sorted = toRows(R, "objectPermissions", { sort: { col: "item", dir: "desc" } }).slice(1).map((r) => r[2]);
  assert.deepEqual(sorted, sortRows(R.sections.objectPermissions, "item", "desc").map((r) => r.label));
});

await test("sort: tick columns put the tick first, then the dash, each by name", () => {
  const rows = [
    { label: "Zeta", a: true }, { label: "Beta", a: false }, { label: "alpha", a: true }, { label: "Gamma", a: false },
  ];
  assert.deepEqual(sortRows(rows, "a").map((r) => r.label), ["alpha", "Zeta", "Beta", "Gamma"]);
  assert.deepEqual(sortRows(rows, "a", "desc").map((r) => r.label), ["Beta", "Gamma", "alpha", "Zeta"]);
});

await test("sort: object rights go from least to most, by count then strongest right", () => {
  const rows = [
    { label: "Modify", a: ["Read", "Create", "Edit", "Delete", "ViewAllRecords", "ModifyAllRecords"] },
    { label: "None", a: [] },
    { label: "TwoB", a: ["Read", "Edit"] },
    { label: "One", a: ["Read"] },
    { label: "TwoA", a: ["Read", "Create"] },
    { label: "OneDel", a: ["Delete"] },
  ];
  assert.deepEqual(sortRows(rows, "a").map((r) => r.label), ["None", "One", "OneDel", "TwoA", "TwoB", "Modify"]);
  assert.deepEqual(sortRows(rows, "a", "desc").map((r) => r.label), ["Modify", "TwoB", "TwoA", "OneDel", "One", "None"]);
  const tie = [{ label: "B", a: ["Read"] }, { label: "A", a: ["Read"] }];
  assert.deepEqual(sortRows(tie, "a", "desc").map((r) => r.label), ["A", "B"]);
});

await test("sort: field access is No access, Read, Edit; fields stay inside their objects", () => {
  const rows = [
    { group: "Account", label: "Y", a: "Edit" }, { group: "Account", label: "X", a: "No access" }, { group: "Account", label: "Z", a: "Read" },
    { group: "Case", label: "C", a: "Read" }, { group: "Case", label: "B", a: "Edit" },
  ];
  const names = (list) => list.map((r) => r.label);
  assert.deepEqual(names(sortGrouped(rows, "a")), ["X", "Z", "Y", "C", "B"]);
  assert.deepEqual(names(sortGrouped(rows, "a", "desc")), ["Y", "Z", "X", "B", "C"]);
});

await test("sort: tab settings go Hidden or not set, Available, Shown", () => {
  const rows = [
    { label: "T1", a: "Shown" }, { label: "T2", a: null }, { label: "T3", a: "Available (hidden by default)" },
    { label: "T4", a: "Hidden" }, { label: "T0", a: "Shown" },
  ];
  assert.deepEqual(sortRows(rows, "a").map((r) => r.label), ["T2", "T4", "T3", "T0", "T1"]);
  assert.deepEqual(sortRows(rows, "a", "desc").map((r) => r.label), ["T0", "T1", "T3", "T2", "T4"]);
});

await test("sort: What is inside Removed values and other text columns keep text order, empty last", () => {
  const rows = [
    { part: "muted", label: "F1", a: "Removed: Edit", kind: "Field" }, { part: "muted", label: "F2", a: null, kind: "Tab" },
    { part: "muted", label: "F3", a: "Removed", kind: "Tab" }, { part: "muted", label: "F4", a: "Removed: Read", kind: "Field" },
  ];
  assert.deepEqual(sortRows(rows, "a").map((r) => r.label), ["F3", "F1", "F4", "F2"]);
  assert.deepEqual(sortRows(rows, "a", "desc").map((r) => r.label), ["F4", "F1", "F3", "F2"]);
  assert.deepEqual(sortRows(rows, "type").map((r) => r.label), ["F1", "F4", "F2", "F3"]);
});

await test("tab number equals the card's difference lines (muting set, Hidden tab)", () => {
  const res = fake({
    components: [
      { part: "sets", group: "Permission set", status: "onlyA" },
      { part: "sets", group: "Muting permission set", status: "onlyB" }, // left out of the card
      { part: "muted", status: "onlyA" }, { part: "muted", status: "differ" }, { part: "muted", status: "same" },
    ],
    tabs: [
      { status: "onlyA", a: "Hidden", b: null },      // nobody can see it: not a difference
      { status: "differ", a: "Hidden", b: "Shown" },  // one side can see it
      { status: "differ", a: "Shown", b: "Available (hidden by default)" },
      { status: "same", a: "Shown", b: "Shown" },
    ],
    objectPermissions: [{ status: "onlyA", a: ["Read"], b: [] }, { status: "differ", a: ["Read"], b: ["Edit"] }, { status: "same", a: ["Read"], b: ["Read"] }],
    userPermissions: [{ status: "onlyB", a: false, b: true }, { status: "same", a: true, b: true }],
  });
  assert.equal(tabDiffCount(res, "components"), 3); // 1 set + 1 muted only + 1 muted differ
  assert.equal(tabDiffCount(res, "tabs"), 2);
  assert.equal(tabDiffCount(res, "objectPermissions"), 2);
  assert.equal(tabDiffCount(res, "userPermissions"), 1);
  assert.equal(tabDiffCount(res, "setupAccess"), 0);
  assert.equal(tabDiffCount(res, "overview"), 0);
});

await test("sort: 2,000 rows sort quickly", () => {
  const rows = Array.from({ length: 2000 }, (_, i) => ({ label: `Field ${(i * 7919) % 2000}`, a: i % 3 ? "Read" : null, status: "same" }));
  const t0 = performance.now();
  sortRows(rows, "item");
  sortRows(rows, "a", "desc");
  assert.ok(performance.now() - t0 < 500, `took ${performance.now() - t0} ms`);
});

// ---------- folder layout ----------

/** Every file under the extension folder (what "Load unpacked" sees), as paths relative to it. */
function walk(dir, rel = "") {
  const out = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    out.push({ path: r, dir: e.isDirectory() });
    if (e.isDirectory()) out.push(...walk(dir, r));
  }
  return out;
}
const extRoot = path.join(here, "..");

await test("layout: nothing in the extension folder starts with an underscore (Chrome refuses to load it)", () => {
  const bad = walk(extRoot).filter((e) => e.path.split("/").some((part) => part.startsWith("_")));
  assert.deepEqual(bad.map((e) => e.path), []);
});

await test("layout: every tool folder has its page, and the manifest and menu point at real files", () => {
  const tools = ["compare-groups", "user-access", "hierarchy", "record-access", "flow-usage", "page-details", "error-tracer", "who-grants", "audit-trail"];
  const files = walk(extRoot).filter((e) => !e.dir).map((e) => e.path);
  for (const t of tools) {
    for (const f of [`${t}.html`, `${t}.js`, `${t}-read.js`]) assert.ok(files.includes(`tools/${t}/${f}`), `tools/${t}/${f}`);
  }
  assert.deepEqual(readdirSync(path.join(extRoot, "tools")).sort(), [...tools].sort());
  const manifest = JSON.parse(readFileSync(path.join(extRoot, "manifest.json"), "utf-8"));
  assert.ok(files.includes(manifest.action.default_popup));
  const list = readFileSync(path.join(extRoot, "shared/tool-list.js"), "utf-8");
  const pages = [...list.matchAll(/page: "([^"]+)"/g)].map((m) => m[1]);
  const ids = [...list.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, tools, "tool ids are the folder names, in menu order");
  assert.equal(pages.length, tools.length);
  assert.ok(!/page: "/.test(readFileSync(path.join(extRoot, "menu.js"), "utf-8")), "menu.js keeps no tool list of its own");
  for (const p of pages) assert.ok(files.includes(p), p);
});

await test("layout: no page or script loads remote code, or writes org data as HTML", () => {
  const files = walk(extRoot).filter((e) => !e.dir && /^(menu\.|settings[.-]|shared\/|tools\/)/.test(e.path) && /\.(js|html)$/.test(e.path));
  assert.ok(files.length >= 34, `only ${files.length} files scanned`);
  for (const f of files) {
    const text = readFileSync(path.join(extRoot, f.path), "utf-8");
    for (const bad of ["innerHTML", "insertAdjacentHTML", "outerHTML", "eval(", "new Function", "localStorage", "chrome.storage"]) {
      if (bad === "chrome.storage" && f.path === STORE_FILE) continue; // the one file allowed to use it
      assert.ok(!text.includes(bad), `${f.path} uses ${bad}`);
    }
    assert.ok(!/<script[^>]+src=["']https?:/i.test(text), `${f.path} loads a remote script`);
    assert.ok(!/import\s*(\(|[^"']*from\s*)["']https?:/.test(text), `${f.path} imports remote code`);
  }
});

await test("layout: no tool imports or links a file from another tool's folder, and menu.js imports nothing from tools/", () => {
  const files = walk(extRoot).filter((e) => !e.dir && /^tools\/[^/]+\/.+\.(js|html|css)$/.test(e.path));
  assert.ok(files.length >= 30, `only ${files.length} tool files scanned`);
  const refs = (text) => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\bsrc=|\bhref=|@import\s+(?:url\()?\s*)["']([^"']+)["']/g)].map((m) => m[1]);
  for (const f of files) {
    const own = f.path.split("/")[1];
    const dir = path.posix.dirname(f.path);
    for (const r of refs(readFileSync(path.join(extRoot, f.path), "utf-8"))) {
      if (/^https?:/.test(r) || r.startsWith("data:")) continue;
      const target = path.posix.normalize(path.posix.join(dir, r));
      const m = /^tools\/([^/]+)\//.exec(target);
      assert.ok(!m || m[1] === own, `${f.path} reaches into tools/${m && m[1]}: ${r}`);
    }
  }
  for (const top of ["menu.js", "settings.js", "settings-logic.js", "settings.html"]) {
    const text = readFileSync(path.join(extRoot, top), "utf-8");
    assert.deepEqual(refs(text).filter((r) => /(^|\/)tools\//.test(r)), [], `${top} imports from tools/`);
  }
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\nAll ${passed} checks passed.`);
process.exit(failures.length ? 1 : 0);
