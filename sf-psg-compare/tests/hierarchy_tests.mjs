// Offline tests for the Territory & role hierarchy page. Called from run_tests.mjs with its shared `test` function.
// Synthetic data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SfApi, SalesforceError } from "../extension/lib/sfconn.js";
import {
  buildTree, flatten, pathOf, branchOf, searchNodes, exportRows, exportFileName, summaryText, treeNotes, statsOf, defaultModel, toCsv,
} from "../extension/lib/hierarchy.js";
import { readTerritoryModels, readTerritories, readRoles } from "../extension/lib/hierarchyread.js";

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
    assert.equal(JSON.parse(readFileSync(ext("manifest.json"), "utf-8")).version, "0.3.0");
  });
}
