// Offline tests for the Territory & role hierarchy page. Called from run_tests.mjs with its shared `test` function.
// Synthetic data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SfApi, SalesforceError } from "../extension/lib/sfconn.js";
import {
  buildTree, flatten, pathOf, branchOf, searchNodes, exportRows, exportFileName, summaryText, treeNotes, statsOf, defaultModel, toCsv,
  attachUsers, listUsers, countUsers, usersSummary,
} from "../extension/lib/hierarchy.js";
import { readTerritoryModels, readTerritories, readRoles, readRoleUsers, readTerritoryUsers } from "../extension/lib/hierarchyread.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = (...p) => path.join(here, "../extension", ...p);
const sample = (n) => JSON.parse(readFileSync(ext("samples", n), "utf-8"));

const rec = (id, parentId, name, apiName = name.replace(/\W+/g, "_")) => ({ id, parentId, name, apiName });
const names = (nodes) => nodes.map((n) => n.name);

/** A small tree:  Global > (EMEA > (UK, Germany), APAC > (Region 10, Region 2)) */
const small = () => [
  rec("1", null, "Global"),
  rec("2", "1", "EMEA"),
  rec("3", "1", "APAC"),
  rec("4", "2", "UK"),
  rec("5", "2", "Germany"),
  rec("6", "3", "Region 10"),
  rec("7", "3", "Region 2"),
];

/** Fake REST API. `objects` is what describeGlobal lists. A route may return {fail, code} to answer 400. */
function fakeApi(routes, { objects = ["Territory2Model", "Territory2"], log = [] } = {}) {
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    log.push({ method: opts.method || "GET", path: u.pathname, q: u.searchParams.get("q") });
    if (/\/sobjects\/$/.test(u.pathname)) return { ok: true, status: 200, text: async () => JSON.stringify({ sobjects: objects.map((name) => ({ name })) }) };
    const q = u.searchParams.get("q");
    const route = routes.find(([re]) => re.test(q));
    if (!route) return { ok: false, status: 400, text: async () => JSON.stringify([{ message: `no route for ${q}`, errorCode: "TEST" }]) };
    const r = route[1](q);
    if (r.fail) return { ok: false, status: 400, text: async () => JSON.stringify([{ message: r.fail, errorCode: r.code || "TEST" }]) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ done: true, totalSize: r.total ?? r.length, records: r.total !== undefined ? [] : r }) };
  };
  return new SfApi({ apiHost: "test.example.com", sessionId: "sid", fetchImpl });
}

export async function run(test) {
  await test("hierarchy: tree is built, children sorted by name with numbers by value", () => {
    const t = buildTree(small());
    assert.deepEqual(names(t.roots), ["Global"]);
    assert.deepEqual(names(t.order), ["Global", "APAC", "Region 2", "Region 10", "EMEA", "Germany", "UK"]);
    assert.equal(t.count, 7);
    assert.equal(t.levels, 3);
    assert.equal(t.order[0].size, 6);
    assert.equal(t.order[1].size, 2);
    assert.equal(t.missingParent + t.loopNodes, 0);
    assert.equal(t.order[3].depth, 2);
  });

  await test("hierarchy: sort ignores case; equal names fall back to API name", () => {
    const t = buildTree([rec("1", null, "b"), rec("2", null, "A"), rec("3", null, "a", "a_x"), rec("4", null, "Item 9"), rec("5", null, "item 10")]);
    assert.deepEqual(t.roots.map((n) => n.id), ["2", "3", "1", "4", "5"]);
  });

  await test("hierarchy: a record whose parent is missing goes to the top level and is counted", () => {
    const t = buildTree([...small(), rec("9", "nope", "Lost"), rec("10", "9", "Lost child")]);
    assert.deepEqual(names(t.roots), ["Global", "Lost"]);
    assert.equal(t.missingParent, 1);
    assert.equal(t.roots[1].orphan, true);
    assert.equal(t.roots[1].size, 1);
    assert.match(treeNotes(t, "territories")[0], /1 territory has a parent that is not in this list/);
  });

  await test("hierarchy: loops do not hang; the loop is cut at its first member and counted", () => {
    const t = buildTree([
      rec("1", "3", "Charlie"), rec("2", "1", "Bravo"), rec("3", "2", "Alpha"), // 1 > 3 > 2 > 1 loop
      rec("4", "3", "Below loop"),
      rec("5", "5", "Self"),
      rec("6", null, "Fine"),
    ]);
    assert.equal(t.count, 6); // nothing is lost
    assert.equal(t.loopNodes, 4); // three in the loop, one that points at itself
    assert.deepEqual(names(t.roots), ["Alpha", "Fine", "Self"]);
    assert.equal(t.roots[0].inLoop, true);
    assert.equal(t.roots[0].loopCut, true);
    // every member of the loop is flagged, only one is cut; a node below the loop and a fine node are not flagged
    const byName = Object.fromEntries(t.order.map((n) => [n.name, n]));
    assert.deepEqual(["Alpha", "Bravo", "Charlie", "Self"].map((k) => byName[k].inLoop), [true, true, true, true]);
    assert.deepEqual(["Alpha", "Bravo", "Charlie", "Self"].map((k) => byName[k].loopCut), [true, false, false, true]);
    assert.equal(byName["Below loop"].inLoop, false);
    assert.equal(byName.Fine.inLoop, false);
    assert.equal(t.order.filter((n) => n.inLoop).length, t.loopNodes);
    assert.deepEqual(names(flatten([t.roots[0]]).map((x) => x.node)), ["Alpha", "Below loop", "Charlie", "Bravo"]);
    assert.match(treeNotes(t, "roles")[0], /4 roles have parents that lead back to themselves/);
    assert.match(treeNotes(t, "roles")[0], /marked "Parent loop"/);
  });

  await test("hierarchy: a 2,000-deep chain does not overflow the stack", () => {
    const recs = [];
    for (let i = 0; i < 2000; i++) recs.push(rec(String(i), i ? String(i - 1) : null, `Level ${i}`));
    const t = buildTree(recs);
    assert.equal(t.levels, 2000);
    const last = t.order[1999];
    assert.equal(pathOf(last).length, 2000);
    assert.equal(flatten(t.roots).length, 2000);
    assert.equal(t.roots[0].size, 1999);
    const rows = exportRows(t);
    assert.equal(rows.length, 2001);
    assert.equal(rows[0].length, 2002);
    assert.equal(rows[2000][1999], "Level 1999");
    // a 2,000-deep loop is also fine
    recs[0].parentId = "1999";
    const t2 = buildTree(recs);
    assert.equal(t2.count, 2000);
    assert.equal(t2.loopNodes, 2000);
  });

  await test("hierarchy: 5,000 nodes build, flatten, search and export well under a second", () => {
    const recs = [];
    for (let i = 0; i < 5000; i++) recs.push(rec(String(i), i ? String(Math.floor((i - 1) / 3)) : null, `Node ${(i * 31) % 5000}`, `Node_${i}`));
    const t0 = performance.now();
    const t = buildTree(recs);
    const flat = flatten(t.roots);
    const hits = searchNodes(t, "node 12");
    const rows = exportRows(t);
    const ms = performance.now() - t0;
    assert.equal(flat.length, 5000);
    assert.equal(rows.length, 5001);
    assert.ok(hits.items.length <= 50 && hits.total > 50);
    assert.equal(t.levels, 9);
    assert.ok(ms < 800, `took ${ms.toFixed(0)} ms`);
  });

  await test("hierarchy: branch is the node, everything below it, and the path above", () => {
    const t = buildTree(small());
    const emea = t.order.find((n) => n.name === "EMEA");
    const b = branchOf(emea);
    assert.deepEqual(names(b.above), ["Global"]);
    assert.deepEqual(b.items.map((x) => [x.node.name, x.depth]), [["EMEA", 0], ["Germany", 1], ["UK", 1]]);
    assert.deepEqual(statsOf(b.items), { count: 3, levels: 2 });
    const leaf = t.order.find((n) => n.name === "UK");
    assert.deepEqual(branchOf(leaf).items.map((x) => x.node.name), ["UK"]);
    assert.deepEqual(branchOf(t.roots[0]).above, []);
  });

  await test("hierarchy: search uses words in any order, punctuation as a separator, API names, limit 50", () => {
    const t = buildTree([
      rec("1", null, "Global"),
      rec("2", "1", "EMEA"), rec("3", "1", "APAC"),
      rec("4", "2", "Key Accounts", "Key_Accounts_UK"),
      rec("5", "3", "Key Accounts", "Key_Accounts_AU"),
      rec("6", "2", "Accounts Key East"),
      rec("7", "3", "Sales"),
    ]);
    const r = searchNodes(t, "accounts key");
    assert.equal(r.total, 3);
    // the two with the same name can be told apart by their path
    const same = r.items.filter((x) => x.node.name === "Key Accounts").map((x) => x.pathText);
    assert.deepEqual(same, ["Global › APAC › Key Accounts", "Global › EMEA › Key Accounts"]);
    assert.deepEqual(r.items[1].path, ["Global", "APAC", "Key Accounts"]);
    assert.equal(searchNodes(t, "key-accounts_au").items[0].node.id, "5"); // punctuation, API name
    assert.equal(searchNodes(t, "global › emea").total, 0); // names only, not paths
    assert.equal(searchNodes(t, "").total, 0);
    assert.equal(searchNodes(t, "   ").items.length, 0);
    assert.equal(searchNodes(t, "zzz").total, 0);
    // names that start with the text come first
    assert.equal(searchNodes(t, "accounts").items[0].node.name, "Accounts Key East");
    const many = buildTree(Array.from({ length: 120 }, (_, i) => rec(String(i), null, `Team ${i}`)));
    const m = searchNodes(many, "team");
    assert.equal(m.items.length, 50);
    assert.equal(m.total, 120);
  });

  await test("hierarchy: export lays the tree out in the cells (whole tree)", () => {
    const t = buildTree(small());
    assert.deepEqual(exportRows(t), [
      ["Level 1", "Level 2", "Level 3", "API name", "Path"],
      ["Global", "", "", "Global", "Global"],
      ["", "APAC", "", "APAC", "Global › APAC"],
      ["", "", "Region 2", "Region_2", "Global › APAC › Region 2"],
      ["", "", "Region 10", "Region_10", "Global › APAC › Region 10"],
      ["", "EMEA", "", "EMEA", "Global › EMEA"],
      ["", "", "Germany", "Germany", "Global › EMEA › Germany"],
      ["", "", "UK", "UK", "Global › EMEA › UK"],
    ]);
  });

  await test("hierarchy: export of a branch starts at Level 1 but keeps the full path", () => {
    const t = buildTree(small());
    const apac = t.order.find((n) => n.name === "APAC");
    assert.deepEqual(exportRows(t, apac), [
      ["Level 1", "Level 2", "API name", "Path"],
      ["APAC", "", "APAC", "Global › APAC"],
      ["", "Region 2", "Region_2", "Global › APAC › Region 2"],
      ["", "Region 10", "Region_10", "Global › APAC › Region 10"],
    ]);
    const leaf = t.order.find((n) => n.name === "UK");
    assert.deepEqual(exportRows(t, leaf), [["Level 1", "API name", "Path"], ["UK", "UK", "Global › EMEA › UK"]]);
  });

  await test("hierarchy: export with several top-level nodes and an empty tree", () => {
    const t = buildTree([rec("1", null, "B"), rec("2", "x", "A"), rec("3", "2", "A1")]);
    assert.deepEqual(exportRows(t).map((r) => r.join("|")), ["Level 1|Level 2|API name|Path", "A||A|A", "|A1|A1|A › A1", "B||B|B"]);
    assert.deepEqual(exportRows(buildTree([])), [["Level 1", "API name", "Path"]]);
  });

  await test("hierarchy: CSV guards cells that Excel would run as a formula", () => {
    const t = buildTree([rec("1", null, "=SUM(A1)"), rec("2", "1", "-5"), rec("3", "1", "Say \"hi\", ok")]);
    const csv = toCsv(exportRows(t));
    assert.ok(csv.startsWith("﻿Level 1,Level 2,API name,Path\r\n"));
    assert.ok(csv.includes("'=SUM(A1)"));
    assert.ok(csv.includes(",'-5,"));
    assert.ok(csv.includes('"Say ""hi"", ok"'));
  });

  await test("hierarchy: summary text, models and file names", () => {
    assert.equal(summaryText({ count: 412, levels: 7 }, "territories"), "412 territories, 7 levels");
    assert.equal(summaryText({ count: 1, levels: 1 }, "roles"), "1 role, 1 level");
    assert.equal(summaryText({ count: 0, levels: 0 }, "roles"), "No roles");
    assert.equal(summaryText({ count: 12345, levels: 3 }, "roles"), "12,345 roles, 3 levels");
    const models = [{ id: "a", name: "Zed", state: "Archived" }, { id: "b", name: "Draft", state: "Planning" }, { id: "c", name: "Live", state: "Active" }];
    assert.equal(defaultModel(models).id, "c");
    assert.equal(defaultModel([models[1], models[0]]).id, "b");
    assert.equal(defaultModel([]), null);
    assert.equal(exportFileName({ kind: "Territories", model: "FY26 / Main", branch: "UK: North*" }, "202611191030"), "Territories_FY26_Main_from_UK_North_202611191030.csv");
    assert.equal(exportFileName({ kind: "Roles" }, "x"), "Roles_x.csv");
    assert.ok(!/[\\/:*?"<>|]/.test(exportFileName({ kind: "Roles", branch: 'a\\b/c:d*e?f"g<h>i|j' }, "s")));
    assert.ok(exportFileName({ kind: "Roles", branch: "x".repeat(300) }, "s").length < 80);
  });

  await test("hierarchy reads: territory models are a SELECT, Active first; territories escape the model id", async () => {
    const log = [];
    const api = fakeApi([
      [/FROM Territory2Model$/, () => [
        { Id: "0Mo2", Name: "Draft", DeveloperName: "Draft", State: "Planning" },
        { Id: "0Mo1", Name: "Live", DeveloperName: "Live", State: "Active" },
      ]],
      [/FROM Territory2 WHERE/, () => [
        { Id: "0MI1", Name: "Global", DeveloperName: "Global", ParentTerritory2Id: null },
        { Id: "0MI2", Name: "EMEA", DeveloperName: "EMEA", ParentTerritory2Id: "0MI1" },
      ]],
    ], { log });
    const m = await readTerritoryModels(api);
    assert.equal(m.on, true);
    assert.deepEqual(m.models.map((x) => [x.id, x.state]), [["0Mo1", "Active"], ["0Mo2", "Planning"]]);
    const t = await readTerritories(api, "0Mo1' OR Name != '");
    assert.deepEqual(t[1], { id: "0MI2", parentId: "0MI1", name: "EMEA", apiName: "EMEA" });
    const q = log.filter((l) => l.q).map((l) => l.q);
    assert.ok(q.every((s) => /^SELECT /.test(s)));
    assert.ok(q.includes("SELECT Id, Name, DeveloperName, State FROM Territory2Model"));
    assert.ok(q.includes("SELECT Id, Name, DeveloperName, ParentTerritory2Id FROM Territory2 WHERE Territory2ModelId = '0Mo1\\' OR Name != \\''"));
    assert.ok(log.every((l) => l.method === "GET"));
  });

  await test("hierarchy reads: territories turned off are handled, with no describeGlobal call", async () => {
    // an org without territories answers the query the way SfApi reports it: 400, INVALID_TYPE
    const log = [];
    const api = fakeApi([[/Territory2Model/, () => ({ fail: "sObject type 'Territory2Model' is not supported. If you are attempting to use a custom object, be sure to append the '__c' after the entity name.", code: "INVALID_TYPE" })]], { log });
    assert.deepEqual(await readTerritoryModels(api), { on: false, models: [] });
    assert.ok(!log.some((l) => /\/sobjects\/$/.test(l.path)), "describeGlobal was called");
    assert.equal(log.length, 1);
    // same, with the error SfApi throws (SalesforceError in sfconn.js: message, status, errorCode, url)
    const thrower = { query: async () => { throw new SalesforceError("sObject type 'Territory2Model' is not supported.", { status: 400, errorCode: "INVALID_TYPE", url: "x" }); } };
    assert.deepEqual(await readTerritoryModels(thrower), { on: false, models: [] });
    // the error code alone, or the message alone, is enough
    for (const opts of [{ errorCode: "INVALID_TYPE" }, {}]) {
      const t = { query: async () => { throw new SalesforceError(opts.errorCode ? "x" : "sObject type 'Territory2Model' is not supported.", { status: 400, ...opts }); } };
      assert.equal((await readTerritoryModels(t)).on, false);
    }
    // another failure is not hidden
    const bad = fakeApi([[/Territory2Model/, () => ({ fail: "boom", code: "INSUFFICIENT_ACCESS" })]]);
    await assert.rejects(() => readTerritoryModels(bad), /boom/);
  });

  await test("hierarchy reads: roles still load when the territory read fails", async () => {
    const api = fakeApi([
      [/Territory2Model/, () => ({ fail: "boom", code: "INSUFFICIENT_ACCESS" })],
      [/COUNT\(\)/, () => ({ total: 0 })],
      [/FROM UserRole/, () => [{ Id: "00E1", Name: "CEO", DeveloperName: "CEO", ParentRoleId: null }]],
    ]);
    await assert.rejects(() => readTerritoryModels(api), /boom/);
    assert.equal((await readRoles(api)).roles.length, 1); // readRoles does not depend on the territory read
    // the page catches the territory failure in loadModels (so start() goes on to Roles)
    const page = readFileSync(ext("hierarchy.js"), "utf-8");
    assert.match(page, /async function loadModels\(\) \{[\s\S]*?try \{[\s\S]*?catch \(e\)/);
  });

  await test("hierarchy reads: roles leave out portal roles and count them", async () => {
    const log = [];
    const api = fakeApi([
      [/COUNT\(\) FROM UserRole WHERE PortalType != 'None'/, () => ({ total: 7 })],
      [/FROM UserRole WHERE PortalType = 'None'/, () => [
        { Id: "00E1", Name: "CEO", DeveloperName: "CEO", ParentRoleId: null },
        { Id: "00E2", Name: "VP", DeveloperName: "VP", ParentRoleId: "00E1" },
      ]],
    ], { log });
    const r = await readRoles(api);
    assert.equal(r.portalCount, 7);
    assert.deepEqual(r.roles.map((x) => [x.id, x.parentId, x.name, x.apiName]), [["00E1", null, "CEO", "CEO"], ["00E2", "00E1", "VP", "VP"]]);
    assert.deepEqual(r.warnings, []);
    assert.ok(log.filter((l) => l.q).every((l) => /^SELECT /.test(l.q)));
    assert.ok(log.some((l) => l.q === "SELECT Id, Name, DeveloperName, ParentRoleId FROM UserRole WHERE PortalType = 'None'"));
    // the count failing does not stop the roles
    const api2 = fakeApi([
      [/COUNT\(\)/, () => ({ fail: "no count" })],
      [/FROM UserRole/, () => [{ Id: "00E1", Name: "CEO", DeveloperName: "CEO", ParentRoleId: null }]],
    ]);
    const r2 = await readRoles(api2);
    assert.equal(r2.portalCount, null);
    assert.equal(r2.roles.length, 1);
    assert.match(r2.warnings[0], /no count/);
  });

  await test("hierarchy reads: more than one page is followed", async () => {
    let page = 0;
    const fetchImpl = async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/next")) {
        page++;
        return { ok: true, status: 200, text: async () => JSON.stringify({ done: true, totalSize: 2, records: [{ Id: "0MI2", Name: "B", DeveloperName: "B", ParentTerritory2Id: null }] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ done: false, nextRecordsUrl: "/services/data/v62.0/query/next", totalSize: 2, records: [{ Id: "0MI1", Name: "A", DeveloperName: "A", ParentTerritory2Id: null }] }) };
    };
    const api = new SfApi({ apiHost: "x.example.com", sessionId: "s", fetchImpl });
    assert.equal((await readTerritories(api, "0Mo1")).length, 2);
    assert.equal(page, 1);
  });

  await test("hierarchy samples: territories show the cases the demo is for", () => {
    const d = sample("hierarchy_territories.json");
    assert.equal(d.models.length, 2);
    const live = d.models.find((m) => m.state === "Active");
    assert.ok(live.territories.length >= 50);
    const t = buildTree(live.territories);
    assert.ok(t.levels >= 8, `levels ${t.levels}`);
    assert.equal(t.missingParent, 1);
    assert.equal(t.loopNodes, 0);
    assert.equal(t.roots.length, 2);
    const sameName = new Map();
    for (const n of t.order) sameName.set(n.name, (sameName.get(n.name) || 0) + 1);
    assert.ok([...sameName.values()].some((c) => c > 1), "a name used in two branches");
    const region = t.order.filter((n) => /^Region \d+$/.test(n.name)).map((n) => n.name);
    assert.deepEqual(region, ["Region 1", "Region 2", "Region 10"]);
    assert.equal(searchNodes(t, "key accounts").total, 3);
    assert.equal(defaultModel(d.models).state, "Active");
  });

  await test("hierarchy samples: roles", () => {
    const d = sample("hierarchy_roles.json");
    assert.ok(d.roles.length >= 30);
    assert.ok(d.portalCount > 0);
    const t = buildTree(d.roles);
    assert.equal(t.missingParent + t.loopNodes, 0);
    assert.equal(t.roots.length, 1);
    const reps = t.order.filter((n) => /^Sales Rep West/.test(n.name)).map((n) => n.name);
    assert.deepEqual(reps, ["Sales Rep West 1", "Sales Rep West 2", "Sales Rep West 10"]);
  });

  await test("hierarchy: the new files never use innerHTML, localStorage or chrome.storage, and only read", () => {
    const files = [["hierarchy.js"], ["hierarchy.html"], ["hierarchy.css"], ["lib", "hierarchy.js"], ["lib", "hierarchyread.js"]];
    for (const f of files) {
      const text = readFileSync(ext(...f), "utf-8");
      for (const bad of ["innerHTML", "insertAdjacentHTML", "outerHTML", "localStorage", "sessionStorage", "chrome.storage", "document.write", "eval("]) {
        assert.ok(!text.includes(bad), `${f.join("/")} contains ${bad}`);
      }
      assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(text.replace(/https:\/\/\$\{/g, "")), `${f.join("/")} mentions a remote URL`);
    }
    // the pure module has no browser or network APIs
    const pure = readFileSync(ext("lib", "hierarchy.js"), "utf-8");
    for (const bad of ["document.", "window.", "fetch(", "chrome.", "location."]) assert.ok(!pure.includes(bad), `lib/hierarchy.js contains ${bad}`);
    // the org reads are SELECTs and describes only
    const read = readFileSync(ext("lib", "hierarchyread.js"), "utf-8");
    assert.ok(!/\b(INSERT|UPDATE|DELETE|UPSERT|POST|PATCH|PUT)\b/.test(read), "hierarchyread.js has a write verb");
    const page = readFileSync(ext("hierarchy.js"), "utf-8");
    assert.ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)/i.test(page));
  });

  await test("hierarchy: the page never hands null to replaceChildren, and fold buttons say what they do", () => {
    const page = readFileSync(ext("hierarchy.js"), "utf-8");
    assert.ok(!/replaceChildren\([^;]*\?[^;]*:\s*null/.test(page), "a ternary with null passed to replaceChildren");
    assert.match(page, /"aria-label": `Collapse \$\{node\.name\}`/);
    assert.match(page, /folded \? "Expand" : "Collapse"/);
  });

  await test("hierarchy: the tool is in the popup menu and the manifest version moved on", () => {
    assert.match(readFileSync(ext("popup.js"), "utf-8"), /page: "hierarchy\.html"[\s\S]*?title: "Territory & role hierarchy"/);
    assert.match(JSON.parse(readFileSync(ext("manifest.json"), "utf-8")).version, /^0\.[3-9]\.\d+$/); // moved on from 0.2
  });

  // ---------- users in each role / territory ----------

  const U = (id, nodeId, name, active = true) => ({
    id, nodeId, name, username: `${name.split(" ")[0].toLowerCase()}@demo.example.com`, email: `${name.split(" ")[0].toLowerCase()}@example.com`, active,
  });
  /** On the small tree: UK (id 4) has three people (one inactive), Global (id 1) has one of the same people. */
  const smallUsers = () => [
    U("U1", "4", "Zoe Zane"),
    U("U2", "4", "adam Able"),
    U("U3", "4", "Bea Baker", false),
    U("U1", "1", "Zoe Zane"), // the same person in a second node
    U("U4", "999", "Nobody Known"), // a node that is not in the tree
    U("U2", "4", "adam Able"), // listed twice for one node
  ];

  await test("hierarchy users: attached to nodes; a person in two nodes; unknown nodes and repeats ignored", () => {
    const t = buildTree(small());
    const { byNode, unmatched } = attachUsers(t, smallUsers());
    assert.deepEqual([...byNode.keys()].sort(), ["1", "4"]);
    assert.deepEqual(byNode.get("4").map((u) => u.id), ["U1", "U2", "U3"]);
    assert.deepEqual(byNode.get("1").map((u) => u.id), ["U1"]);
    assert.deepEqual(unmatched.map((u) => u.id), ["U4"]);
    assert.equal(t.order[0].users, undefined, "the tree is not changed");
    // counts: people, not rows
    const all = flatten(t.roots);
    assert.deepEqual(countUsers(byNode, all), { active: 2, inactive: 1, activeAssignments: 3, inactiveAssignments: 1 });
    assert.equal(usersSummary(countUsers(byNode, all), false, "territories"), "2 active people in 3 territory assignments");
    assert.equal(usersSummary(countUsers(byNode, all), true, "territories"), "2 active and 1 inactive people in 4 territory assignments");
    assert.equal(usersSummary({ active: 1, inactive: 0, activeAssignments: 1, inactiveAssignments: 0 }, false, "territories"), "1 active person in 1 territory assignment");
    assert.equal(usersSummary({ active: 5812, inactive: 0 }, false), "5,812 active users");
    assert.equal(usersSummary({ active: 1, inactive: 3 }, false), "1 active user");
    assert.equal(usersSummary({ active: 2, inactive: 3 }, true), "2 active users, 3 inactive");
    // a branch counts only its own nodes
    const emea = t.order.find((n) => n.name === "EMEA");
    assert.deepEqual(countUsers(byNode, flatten([emea])), { active: 2, inactive: 1, activeAssignments: 2, inactiveAssignments: 1 });
    const apac = t.order.find((n) => n.name === "APAC");
    assert.deepEqual(countUsers(byNode, flatten([apac])), { active: 0, inactive: 0, activeAssignments: 0, inactiveAssignments: 0 });
    // records without an id or node are skipped, active defaults to true
    const odd = attachUsers(t, [{ id: "", nodeId: "4" }, { id: "X", nodeId: "" }, { id: "Y", nodeId: "4", name: "Yan" }]);
    assert.deepEqual(odd.byNode.get("4").map((u) => [u.id, u.active]), [["Y", true]]);
  });

  await test("hierarchy users: inactive filter, sorting by the chosen field, nothing to show", () => {
    const t = buildTree(small());
    const { byNode } = attachUsers(t, smallUsers());
    const uk = t.order.find((n) => n.name === "UK");
    const names = (inc, field = "name") => listUsers(byNode, uk, field, inc).map((u) => u.display);
    assert.deepEqual(names(false), ["adam Able", "Zoe Zane"]); // case-insensitive: adam before Zoe
    assert.deepEqual(names(true), ["adam Able", "Bea Baker (inactive)", "Zoe Zane"]);
    assert.deepEqual(names(true, "email"), ["adam@example.com", "bea@example.com (inactive)", "zoe@example.com"]);
    assert.deepEqual(names(true, "username"), ["adam@demo.example.com", "bea@demo.example.com (inactive)", "zoe@demo.example.com"]);
    assert.deepEqual(names(true, "id"), ["U1", "U2", "U3 (inactive)"]);
    assert.equal(listUsers(byNode, uk, "name", true)[1].text, "Bea Baker");
    assert.equal(listUsers(byNode, uk, "name", true)[1].active, false);
    const emea = t.order.find((n) => n.name === "EMEA");
    assert.deepEqual(listUsers(byNode, emea, "name", true), []);
    // an empty value says so, so the cell is never blank
    const blank = attachUsers(t, [{ id: "B1", nodeId: "4", name: "", email: "" }]);
    assert.equal(listUsers(blank.byNode, uk, "email")[0].display, "(no email)");
    assert.equal(listUsers(blank.byNode, uk, "name")[0].display, "(no name)");
    // sorted the same way for the same people, whatever order they came in
    const rev = attachUsers(t, smallUsers().reverse());
    assert.deepEqual(listUsers(rev.byNode, uk, "name", true).map((u) => u.id), listUsers(byNode, uk, "name", true).map((u) => u.id));
  });

  await test("hierarchy users: export cells, whole tree, each field, inactive marked, header width", () => {
    const t = buildTree(small());
    const { byNode } = attachUsers(t, smallUsers());
    const head = ["Level 1", "Level 2", "Level 3", "API name", "Path"];
    // users off: exactly as before
    assert.deepEqual(exportRows(t, null, null), exportRows(t));
    assert.deepEqual(exportRows(t)[0], head);
    // name, active only: most on one row is 2
    const rows = exportRows(t, null, { byNode, field: "name", includeInactive: false });
    assert.deepEqual(rows, [
      [...head, "Users", "User 1", "User 2"],
      ["Global", "", "", "Global", "Global", "1", "Zoe Zane", ""],
      ["", "APAC", "", "APAC", "Global › APAC", "0", "", ""],
      ["", "", "Region 2", "Region_2", "Global › APAC › Region 2", "0", "", ""],
      ["", "", "Region 10", "Region_10", "Global › APAC › Region 10", "0", "", ""],
      ["", "EMEA", "", "EMEA", "Global › EMEA", "0", "", ""],
      ["", "", "Germany", "Germany", "Global › EMEA › Germany", "0", "", ""],
      ["", "", "UK", "UK", "Global › EMEA › UK", "2", "adam Able", "Zoe Zane"],
    ]);
    // inactive included: a third column and the marker
    const inc = exportRows(t, null, { byNode, field: "email", includeInactive: true });
    assert.deepEqual(inc[0].slice(5), ["Users", "User 1", "User 2", "User 3"]);
    assert.deepEqual(inc[7].slice(5), ["3", "adam@example.com", "bea@example.com (inactive)", "zoe@example.com"]);
    assert.deepEqual(inc[1].slice(5), ["1", "zoe@example.com", "", ""]);
    assert.ok(inc.every((r) => r.length === inc[0].length));
    const ids = exportRows(t, null, { byNode, field: "id", includeInactive: true });
    assert.deepEqual(ids[7].slice(5), ["3", "U1", "U2", "U3 (inactive)"]);
    const un = exportRows(t, null, { byNode, field: "username", includeInactive: false });
    assert.deepEqual(un[7].slice(5), ["2", "adam@demo.example.com", "zoe@demo.example.com"]);
    // nobody anywhere: just the count column
    const none = exportRows(t, null, { byNode: new Map(), field: "name", includeInactive: false });
    assert.deepEqual(none[0], [...head, "Users"]);
    assert.deepEqual(none[1].slice(5), ["0"]);
  });

  await test("hierarchy users: export of a branch has only that branch's users and a header sized to it", () => {
    const t = buildTree(small());
    const { byNode } = attachUsers(t, smallUsers());
    const emea = t.order.find((n) => n.name === "EMEA");
    assert.deepEqual(exportRows(t, emea, { byNode, field: "name", includeInactive: false }), [
      ["Level 1", "Level 2", "API name", "Path", "Users", "User 1", "User 2"],
      ["EMEA", "", "EMEA", "Global › EMEA", "0", "", ""],
      ["", "Germany", "Germany", "Global › EMEA › Germany", "0", "", ""],
      ["", "UK", "UK", "Global › EMEA › UK", "2", "adam Able", "Zoe Zane"],
    ]);
    // a branch where the most is 1: one User column (Global's person is not in this branch)
    const apac = t.order.find((n) => n.name === "APAC");
    assert.deepEqual(exportRows(t, apac, { byNode, field: "name", includeInactive: false })[0], ["Level 1", "Level 2", "API name", "Path", "Users"]);
    const global = t.order[0];
    assert.deepEqual(exportRows(t, global, { byNode, field: "name", includeInactive: false })[0].slice(-4), ["Path", "Users", "User 1", "User 2"]);
    // a person's name that looks like a formula is guarded by toCsv
    const evil = attachUsers(t, [U("E1", "4", "=HYPERLINK(x)")]);
    const csv = toCsv(exportRows(t, emea, { byNode: evil.byNode, field: "name", includeInactive: false }));
    assert.ok(csv.includes("'=HYPERLINK(x)"), csv);
  });

  await test("hierarchy notes: in a branch only the nodes on screen are counted", () => {
    const recs = [rec("1", null, "Top"), rec("2", "1", "Mid"), rec("3", "1", "Leaf"), rec("8", "MISSING", "Lost A"), rec("9", "MISSING2", "Lost B"),
      rec("10", "11", "Loop A"), rec("11", "10", "Loop B")];
    const t = buildTree(recs);
    assert.equal(treeNotes(t, "territories").length, 2);
    assert.match(treeNotes(t, "territories")[0], /^2 territories have a parent that is not in this list/);
    // a branch with no problems says nothing
    const top = t.order.find((n) => n.name === "Top");
    assert.deepEqual(treeNotes(t, "territories", flatten([top])), []);
    // a branch with one problem counts one
    const lostA = t.order.find((n) => n.name === "Lost A");
    const notes = treeNotes(t, "territories", flatten([lostA]));
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^1 territory has a parent that is not in this list/);
    // a branch with part of the loop
    const loop = t.order.find((n) => n.inLoop && n.loopCut);
    const ln = treeNotes(t, "roles", flatten([loop]));
    assert.equal(ln.length, 1);
    assert.match(ln[0], /^2 roles have parents that lead back to themselves/);
    // the whole tree (no items) is unchanged
    assert.equal(treeNotes(t, "roles", null).length, 2);
  });

  await test("hierarchy users reads: SELECT only, model id escaped, no role in territory read", async () => {
    const log = [];
    const api = fakeApi([
      [/FROM UserTerritory2Association/, () => [
        { UserId: "005A", Territory2Id: "0MI1", User: { Name: "Ann Example", Username: "ann@demo.example.com", Email: "ann@example.com", IsActive: true } },
        { UserId: "005B", Territory2Id: "0MI2", User: { Name: "Ben Sample", Username: "ben@demo.example.com", Email: "ben@example.com", IsActive: false } },
      ]],
      [/COUNT\(\) FROM User WHERE UserRoleId != null AND UserRole\.PortalType != 'None' AND IsActive = true/, () => ({ total: 4 })],
      [/COUNT\(\) FROM User WHERE UserRoleId != null AND UserRole\.PortalType != 'None'/, () => ({ total: 9 })],
      [/^SELECT Id, Name.* FROM User WHERE UserRoleId != null AND UserRole\.PortalType = 'None'/, () => [
        { Id: "005A", Name: "Ann Example", Username: "ann@demo.example.com", Email: "ann@example.com", IsActive: true, UserRoleId: "00E1" },
      ]],
    ], { log });
    const tu = await readTerritoryUsers(api, "0Mo1' OR Name != '");
    assert.deepEqual(tu.users, [
      { id: "005A", nodeId: "0MI1", name: "Ann Example", username: "ann@demo.example.com", email: "ann@example.com", active: true },
      { id: "005B", nodeId: "0MI2", name: "Ben Sample", username: "ben@demo.example.com", email: "ben@example.com", active: false },
    ]);
    assert.deepEqual(tu.warnings, []);
    const ru = await readRoleUsers(api);
    assert.deepEqual(ru.users, [{ id: "005A", nodeId: "00E1", name: "Ann Example", username: "ann@demo.example.com", email: "ann@example.com", active: true }]);
    assert.deepEqual(ru.portalUsers, { active: 4, all: 9 });
    assert.deepEqual(ru.warnings, []);
    const q = log.filter((l) => l.q).map((l) => l.q);
    assert.ok(q.every((s) => /^SELECT /.test(s)));
    assert.ok(log.every((l) => l.method === "GET"));
    assert.ok(!q.some((s) => /RoleInTerritory2/.test(s)));
    assert.ok(q.includes("SELECT UserId, Territory2Id, User.Name, User.Username, User.Email, User.IsActive FROM UserTerritory2Association WHERE Territory2.Territory2ModelId = '0Mo1\\' OR Name != \\''"));
    assert.ok(q.includes("SELECT Id, Name, Username, Email, IsActive, UserRoleId FROM User WHERE UserRoleId != null AND UserRole.PortalType = 'None'"));
    assert.ok(q.includes("SELECT COUNT() FROM User WHERE UserRoleId != null AND UserRole.PortalType != 'None'"));
    assert.ok(q.includes("SELECT COUNT() FROM User WHERE UserRoleId != null AND UserRole.PortalType != 'None' AND IsActive = true"));
    // the count fails: the users still come back, no count, the reason is kept
    const api3 = fakeApi([
      [/COUNT\(\)/, () => ({ fail: "Unsupported filter", code: "INVALID_FIELD" })],
      [/FROM User WHERE UserRoleId != null/, () => [{ Id: "005A", Name: "Ann Example", Username: "a@demo.example.com", Email: "a@example.com", IsActive: true, UserRoleId: "00E1" }]],
    ]);
    const ru3 = await readRoleUsers(api3);
    assert.equal(ru3.users.length, 1);
    assert.equal(ru3.portalUsers, null);
    assert.match(ru3.warnings[0], /Unsupported filter/);
    // a real failure is thrown (the page turns it into a message about the users only)
    const bad = fakeApi([[/FROM UserTerritory2Association/, () => ({ fail: "insufficient access", code: "INSUFFICIENT_ACCESS" })]]);
    await assert.rejects(() => readTerritoryUsers(bad, "0Mo1"), /insufficient access/);
    const bad2 = fakeApi([[/FROM User /, () => ({ fail: "insufficient access", code: "INSUFFICIENT_ACCESS" })]]);
    await assert.rejects(() => readRoleUsers(bad2), /insufficient access/);
  });

  await test("hierarchy users: the page reads users only on request and a failure stays soft", () => {
    const page = readFileSync(ext("hierarchy.js"), "utf-8");
    // loadUsers catches, keeps the message on the entry, and nothing in show()/loadTree() reads users
    assert.match(page, /function loadUsers\(tree\) \{[\s\S]*?try \{[\s\S]*?catch \(err\)[\s\S]*?status = "error"/);
    assert.ok(!/source\.(roleUsers|territoryUsers)/.test(page.slice(page.indexOf("async function loadTree"), page.indexOf("async function show"))), "loadTree reads users");
    assert.match(page, /state\.show !== "none"/);
    // no whole-org portal-role note in a branch; names are separated by real text
    assert.match(page, /k === "roles" && !state\.branch && state\.roles\.portalCount/);
    assert.match(page, /class: "sep", text: "; "/);
    assert.ok(!/RoleInTerritory2/.test(readFileSync(ext("lib/hierarchyread.js"), "utf-8").replace(/\/\*\*[\s\S]*?\*\//g, "")));
    // the field change does not read: "change" on the select goes to applyUsers, which reads only when nothing is loaded
    assert.match(page, /if \(!e \|\| e\.status !== "ok"\) \{[\s\S]*?await loadUsers\(tree\)/);
    // the file download uses the same field, order and inactive choice as the page
    assert.match(page, /exportRows\(state\.tree, state\.branch, users\)/);
    const html = readFileSync(ext("hierarchy.html"), "utf-8");
    for (const t of ["Don't show", ">Name<", ">Username<", ">Email<", ">Salesforce ID<", "Include inactive users", "Show users"]) assert.ok(html.includes(t), t);
    assert.match(html, /<option value="none">/);
  });

  await test("hierarchy users: 6,000 users on 3,600 nodes attach, sort and export quickly", () => {
    const recs = [];
    for (let i = 0; i < 3600; i++) recs.push(rec(String(i), i ? String(Math.floor((i - 1) / 4)) : null, `Terr ${(i * 7) % 3600}`, `T_${i}`));
    const t = buildTree(recs);
    const users = [];
    for (let i = 0; i < 6000; i++) users.push({ id: `005${String(i).padStart(12, "0")}AAA`, nodeId: String(i % 3 ? (i * 13) % 3600 : 5), name: `User ${(i * 17) % 6000}`, username: `u${i}@demo.example.com`, email: `u${i}@example.com`, active: i % 20 !== 0 });
    const t0 = performance.now();
    const { byNode } = attachUsers(t, users);
    for (const field of ["name", "username", "email", "id"]) {
      for (const { node } of t.order.map((node) => ({ node }))) listUsers(byNode, node, field, true);
    }
    const rows = exportRows(t, null, { byNode, field: "email", includeInactive: false });
    const ms = performance.now() - t0;
    assert.equal(rows.length, 3601);
    assert.ok(rows[0].includes("Users"));
    assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  });

  await test("hierarchy samples: users are synthetic and cover the cases the demo is for", () => {
    const roles = sample("hierarchy_roles.json");
    const terr = sample("hierarchy_territories.json");
    const sets = [["roles", roles.roles, roles.users]];
    for (const m of terr.models) sets.push([m.name, m.territories, m.users]);
    const NAME = /^[A-Z][a-z]+ (Example|Sample|Demo|Testfield|Placeholder|Mockridge|Fakeman|Sandbox)\d*$/;
    for (const [label, nodes, users] of sets) {
      assert.ok(users && users.length, `${label} has users`);
      const ids = new Set(nodes.map((n) => n.id));
      for (const u of users) {
        assert.match(u.id, /^005\d{12}AAA$/, `${label} id ${u.id}`);
        assert.match(u.name, NAME, `${label} name ${u.name}`);
        assert.match(u.email, /^[a-z]+\.[a-z0-9]+@example\.com$/, `${label} email ${u.email}`);
        assert.match(u.username, /^[a-z]+\.[a-z0-9]+@demo\.example\.com$/, `${label} username ${u.username}`);
        assert.equal(typeof u.active, "boolean");
        assert.ok(ids.has(u.nodeId) || label === "roles", `${label} node ${u.nodeId}`);
      }
    }
    // the demo cases
    const live = terr.models.find((m) => m.state === "Active");
    const count = (users) => { const c = new Map(); for (const u of users) c.set(u.nodeId, (c.get(u.nodeId) || 0) + 1); return c; };
    for (const [label, nodes, users] of [["roles", roles.roles, roles.users], ["territories", live.territories, live.users]]) {
      const c = count(users);
      assert.ok([...c.values()].some((n) => n >= 25), `${label}: a node with 25 or more users`);
      assert.ok(users.some((u) => !u.active), `${label}: inactive users`);
      assert.ok(nodes.some((n) => !c.has(n.id)), `${label}: nodes with none`);
    }
    const per = new Map();
    for (const u of live.users) per.set(u.id, (per.get(u.id) || new Set()).add(u.nodeId));
    assert.ok([...per.values()].some((s) => s.size >= 2), "a user in two territories");
    assert.ok(roles.users.some((u) => !roles.roles.some((r) => r.id === u.nodeId)), "a user whose role is not shown");
    // the sample works end to end
    const t = buildTree(live.territories);
    const { byNode, unmatched } = attachUsers(t, live.users);
    assert.equal(unmatched.length, 0);
    const rows = exportRows(t, null, { byNode, field: "name", includeInactive: true });
    assert.ok(rows[0].length >= 5 + 1 + 27);
  });
}
