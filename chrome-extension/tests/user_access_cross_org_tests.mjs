// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Offline tests for comparing one person across two orgs (issue #27). Synthetic data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { readUserAccess } from "../tools/user-access/user-access-read.js";
import {
  compareUsers, compareAcrossOrgs, validateAccess, toRows, toCsv, settingItems, SECTION_KEYS, HIDDEN_TEXT, howKey, howText,
} from "../tools/user-access/user-access-logic.js";
import {
  groupTabsByOrg, hostOfTab, sameOrg, choiceLabel, orgSideNames, SAME_ORG_TEXT, NO_OTHER_ORG_TEXT, CROSS_ORG_NOTE,
  crossPickerLabels, orgListMessage, SAME_DEV_ORG_TEXT,
} from "../tools/user-access/user-access-orgs.js";
import { apiFor, userRoutes } from "./user_access_tests.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = (...p) => path.join(here, "..", ...p);

const ORG_A = { id: "00DDEMOPRD00001", name: "Example Production", host: "example.my.example.com" };
const ORG_B = { id: "00DDEMOSBX00001AAA", name: "Example Sandbox", host: "example--qa.sandbox.my.example.com" };

/** The same person in a second fake org: same API names, but other Ids and labels, and some items in one org only. */
function orgBRoutes() {
  return userRoutes({ routes: [
    [/FROM User WHERE Id/, () => [{ Id: "005QA0000000001AAA", Name: "Alex Example", Username: "alex.example@example.com.qa", IsActive: true, ProfileId: "00ePROFQA000001AAA",
      Profile: { Name: "Sales Standard", UserLicense: { Name: "Salesforce" } }, UserRole: { Name: "Sales Representative (QA)", DeveloperName: "Sales_Rep" } }]],
    [/FROM PermissionSetAssignment/, () => [
      { PermissionSetId: "0PSQ1", PermissionSetGroupId: null, PermissionSet: { Name: "Opportunity_Edit", Label: "Opportunity Edit (QA)", NamespacePrefix: null, Type: "Regular", IsOwnedByProfile: false, LicenseId: null } },
      { PermissionSetId: "0PSQ2", PermissionSetGroupId: null, PermissionSet: { Name: "Sales_Reports", Label: "Sales Reports (QA)", NamespacePrefix: null, Type: "Regular", IsOwnedByProfile: false, LicenseId: "1PLQ1" } },
      { PermissionSetId: "0PSQ4", PermissionSetGroupId: "0PGQ1", PermissionSet: { Name: "Sales_Core", Label: "Sales Core", NamespacePrefix: null, Type: "Group", IsOwnedByProfile: false, LicenseId: null } },
    ]],
    [/FROM PermissionSetGroup WHERE/, () => [{ Id: "0PGQ1", DeveloperName: "Sales_Core", MasterLabel: "Sales Core (QA)", NamespacePrefix: null, Status: "Updated" }]],
    [/FROM PermissionSetGroupComponent/, () => [{ PermissionSetGroupId: "0PGQ1", PermissionSetId: "0PSQ1" }]],
    [/FROM PermissionSet WHERE Id IN/, () => [{ Id: "0PSQ1", Name: "Opportunity_Edit", Label: "Opportunity Edit (QA)", Type: "Regular", NamespacePrefix: null, LicenseId: null }]],
    [/FROM PermissionSetLicense WHERE Id/, () => [{ Id: "1PLQ1", MasterLabel: "Reporting Licence (QA)" }]],
    [/FROM PermissionSetLicenseAssign/, () => [{ PermissionSetLicense: { DeveloperName: "EinsteinPsl", MasterLabel: "Einstein (QA)" } }]],
    [/FROM GroupMember/, () => [
      { Group: { DeveloperName: "All_Sales", Name: "Everyone in Sales", Type: "Regular" } },
      { Group: { DeveloperName: "QA_Testers", Name: "QA Testers", Type: "Regular" } },
      { Group: { DeveloperName: "Lead_Triage", Name: "Lead Triage Queue", Type: "Queue" } },
    ]],
    [/FROM UserTerritory2Association/, () => [{ Territory2: { DeveloperName: "South", Name: "South" } }]],
  ] });
}

export async function run(test) {
  console.log("user access across orgs");

  const readBoth = async () => ({
    a: await readUserAccess(apiFor(userRoutes()), "005A"),
    b: await readUserAccess(apiFor(orgBRoutes()), "005QA0000000001AAA"),
  });

  await test("across orgs: the same API name with other Ids and labels is the same; one-org-only items are differences", async () => {
    const { a, b } = await readBoth();
    assert.notEqual(a.user.id, b.user.id);
    const r = compareAcrossOrgs(a, b, ORG_A, ORG_B);
    const st = (k) => Object.fromEntries(r.sections[k].map((x) => [x.key, x.status]));
    assert.deepEqual(st("profile"), { "Sales Standard": "same" });
    assert.deepEqual(st("role"), { Sales_Rep: "same" }, "role label differs, DeveloperName is the same");
    assert.deepEqual(st("permissionSetGroups"), { Sales_Core: "same" }, "group label differs");
    assert.equal(st("permissionSets").Opportunity_Edit, "same", "label differs, assigned the same way (by API name)");
    assert.equal(st("permissionSets").Sales_Reports, "same");
    assert.equal(st("permissionSets").acme__Lead_Convert, "onlyA", "only in org A (and the namespace is part of the name)");
    assert.deepEqual(st("permissionSetLicenses"), { EinsteinPsl: "same" });
    assert.deepEqual(st("publicGroups"), { All_Sales: "same", QA_Testers: "onlyB" });
    assert.deepEqual(st("queues"), { Lead_Triage: "same" });
    assert.deepEqual(st("territories"), { North: "onlyA", South: "onlyB" });
    assert.equal(r.counts.permissionSets.onlyA, 1);
  });

  await test("across orgs: the sides are named by org, the verdict and CSV say which org, and a note says how items match", async () => {
    const { a, b } = await readBoth();
    const r = compareAcrossOrgs(a, b, ORG_A, ORG_B);
    assert.deepEqual(r.names, { a: "Example Production", b: "Example Sandbox" });
    assert.match(r.verdict.text, /^Each org gives Alex Example access the other does not \(\d+ differences in total\)\.$/);
    assert.ok(r.notes.includes(CROSS_ORG_NOTE));
    const rows = toRows(r);
    assert.deepEqual(rows[0], ["Area", "Item", "API name", "Difference", "Example Production (Alex Example)", "Example Sandbox (Alex Example)"]);
    const terr = rows.find((x) => x[2] === "South");
    assert.deepEqual(terr.slice(0, 4), ["Territories", "South", "South", "Only Example Sandbox"]);
    assert.equal(terr[4], "No");
    const text = toCsv(rows); // one CSV with everything
    assert.ok(text.includes("QA_Testers") && text.includes("acme__Lead_Convert"));
    assert.equal(r.crossOrg.a.id, ORG_A.id);
  });

  await test("across orgs: 'assigned differently' is judged by group API names, not labels (same-org behaviour is unchanged)", () => {
    const item = (label) => ({ key: "PS", label: "PS", direct: false, groups: [{ key: "Grp", label }] });
    assert.equal(howKey(item("Sales Core")), howKey(item("Sales Core (QA)")));
    assert.notEqual(howText(item("Sales Core")), howText(item("Sales Core (QA)")));
    const mk = (label) => validateAccess({
      schema: "sf-user-access/1", user: { id: label, name: "Pat", username: "pat@example.com", isActive: true },
      sections: Object.fromEntries(SECTION_KEYS.map((k) => [k, k === "permissionSets" ? [item(label)] : []])),
    });
    const x = mk("Sales Core");
    const y = mk("Sales Core (QA)");
    assert.equal(compareAcrossOrgs(x, y, ORG_A, ORG_B).sections.permissionSets[0].status, "same");
    assert.equal(compareUsers(x, y).sections.permissionSets[0].status, "differ", "two users in one org: unchanged");
    assert.equal(compareUsers(x, y).crossOrg, undefined);
  });

  await test("across orgs: picking the same org on both sides is refused with a plain sentence", async () => {
    const { a, b } = await readBoth();
    assert.throws(() => compareAcrossOrgs(a, b, ORG_A, { ...ORG_A }), (e) => e.message === SAME_ORG_TEXT);
    // the 15 and 18 character forms of one Id are the same org
    assert.throws(() => compareAcrossOrgs(a, b, { ...ORG_A, id: "00DDEMOPRD00001AAA" }, { ...ORG_A, id: "00DDEMOPRD00001" }), /same org/);
    assert.throws(() => compareUsers(a, b, { crossOrg: { a: ORG_A, b: ORG_A } }), /same org/);
    assert.equal(sameOrg("00DDEMOPRD00001AAA", "00DDEMOPRD00001"), true);
    assert.equal(sameOrg("00DDEMOPRD00001", "00DDEMOSBX00001"), false);
    assert.equal(sameOrg("", ""), false, "a missing Id is never the same");
    assert.doesNotThrow(() => compareAcrossOrgs(a, b, ORG_A, ORG_B));
  });

  await test("orgSideNames: orgs with the same name are told apart by host", () => {
    assert.deepEqual(orgSideNames({ name: "Acme", host: "a.example.com" }, { name: "acme", host: "b.example.com" }), { a: "Acme (a.example.com)", b: "acme (b.example.com)" });
    assert.deepEqual(orgSideNames({ name: "Acme" }, { name: "Acme" }), { a: "Acme (A)", b: "Acme (B)" });
  });

  await test("picker labels tell same-named orgs apart by host, like the results", () => {
    const l = crossPickerLabels({ name: "PPG", host: "ppg.my.salesforce.com" }, { name: "PPG", host: "ppg--dv2.sandbox.my.salesforce.com" });
    assert.equal(l.a, "Person in PPG (ppg.my.salesforce.com)");
    assert.equal(l.b, "The same person in PPG (ppg--dv2.sandbox.my.salesforce.com)");
    assert.notEqual(l.a.replace("Person in ", ""), l.b.replace("The same person in ", ""));
    const n = orgSideNames({ name: "PPG", host: "x" }, { name: "PPG", host: "y" });
    assert.equal(l.a.length > 0 && crossPickerLabels({ name: "PPG", host: "x" }, { name: "PPG", host: "y" }).b, `The same person in ${n.b}`);
    assert.deepEqual(crossPickerLabels({ name: "Example Production" }, { name: "Example Sandbox" }), { a: "Person in Example Production", b: "The same person in Example Sandbox" });
    assert.deepEqual(crossPickerLabels({ name: "PPG" }, null), { a: "Person in PPG", b: "The same person in the other org" });
    // the org list entries keep name + host
    assert.notEqual(choiceLabel({ name: "PPG", host: "a" }), choiceLabel({ name: "PPG", host: "b" }));
  });

  await test("an org whose session was found but could not be read is named; a tab with no session stays quiet", () => {
    const skipped = [
      { host: "help.salesforce.com", reason: "No Salesforce session found for help.salesforce.com." },
      { host: "old.sandbox.my.salesforce.com", reason: "401", unreadable: true },
    ];
    const t = orgListMessage(0, skipped);
    assert.equal(t, "old.sandbox.my.salesforce.com is open, but its session has expired or could not be read. Reload that tab (log in again if asked), then click Refresh.");
    assert.ok(!t.includes("help.salesforce.com") && !t.includes("401"));
    assert.equal(orgListMessage(0, skipped.slice(0, 1)), NO_OTHER_ORG_TEXT, "no-session tabs only: the usual text");
    assert.equal(orgListMessage(0, []), NO_OTHER_ORG_TEXT);
    assert.equal(orgListMessage(2, skipped.slice(0, 1)), "");
    const two = orgListMessage(1, [{ host: "a.my.salesforce.com", unreadable: true }, { host: "b.my.salesforce.com", unreadable: true }]);
    assert.equal(two.split("\n").length, 2, "one line per org");
    assert.equal(orgListMessage(0, [], "dev text"), "dev text");
  });

  await test("dev mode: the same org as the only second org gets its own sentence", () => {
    assert.match(SAME_DEV_ORG_TEXT, /second dev server org is the same org as this one/);
    assert.match(SAME_DEV_ORG_TEXT, /different --second-org/);
    assert.ok(!/Pick the other org/.test(SAME_DEV_ORG_TEXT));
    assert.match(SAME_ORG_TEXT, /Pick the other org\./, "the real-browser refusal is unchanged");
  });

  // ---- tabs to orgs ----

  const sess = (orgId, apiHost) => ({ apiHost, sessionId: `SECRET-SESSION-${orgId}`, orgId });
  const SESSIONS = {
    "prod.lightning.force.com": sess("00DPROD00000001", "prod.my.salesforce.com"),
    "prod.my.salesforce.com": sess("00DPROD00000001", "prod.my.salesforce.com"),
    "qa.lightning.force.com": sess("00DQA0000000001", "qa.sandbox.my.salesforce.com"),
    "qa2.lightning.force.com": sess("00DQA0000000001", "qa.sandbox.my.salesforce.com"),
    "uat.lightning.force.com": sess("00DUAT000000001", "uat.sandbox.my.salesforce.com"),
  };
  const tab = (url) => ({ url });

  await test("groupTabsByOrg: distinct orgs, org A dropped, failed tabs skipped, other tabs ignored", async () => {
    const calls = [];
    const finder = async (host) => {
      calls.push(host);
      if (host === "broken.lightning.force.com") throw new Error("No Salesforce session found for broken.lightning.force.com.");
      return SESSIONS[host];
    };
    const tabs = [
      tab("https://prod.lightning.force.com/lightning/page/home"), // org A (its Id is passed as skipOrgId)
      tab("https://prod.my.salesforce.com/setup"),
      tab("https://qa.lightning.force.com/lightning/setup/Home/home"),
      tab("https://qa2.lightning.force.com/x"), // a second host of the same org
      tab("https://qa.lightning.force.com/another-tab"), // the same host twice
      tab("https://uat.lightning.force.com/"),
      tab("https://broken.lightning.force.com/"),
      tab("https://example.com/not-salesforce"),
      tab("chrome://extensions"),
      { id: 7 }, // a tab with no address
    ];
    const g = await groupTabsByOrg(tabs, finder, { skipOrgId: "00DPROD00000001AAA" });
    assert.deepEqual(g.orgs.map((o) => [o.orgId, o.apiHost, o.uiHosts.sort()]), [
      ["00DQA0000000001", "qa.sandbox.my.salesforce.com", ["qa.lightning.force.com", "qa2.lightning.force.com"]],
      ["00DUAT000000001", "uat.sandbox.my.salesforce.com", ["uat.lightning.force.com"]],
    ], "several tabs of one org are one choice; org A is gone");
    assert.deepEqual(g.skipped.map((s) => s.host), ["broken.lightning.force.com"]);
    assert.match(g.skipped[0].reason, /No Salesforce session found/);
    assert.equal(calls.filter((h) => h === "qa.lightning.force.com").length, 1, "one lookup per host");
    assert.ok(!calls.includes("example.com"), "a non-Salesforce tab is never looked up");
    const none = await groupTabsByOrg([tab("https://example.com/")], finder); // nothing open
    assert.deepEqual([none.orgs, none.skipped], [[], []]);
    assert.match(NO_OTHER_ORG_TEXT, /Open the other org in another tab and log in, then click Refresh\./);
    // a session without an org Id cannot be told from another one: skipped
    const noId = await groupTabsByOrg([tab("https://uat.lightning.force.com/")], async () => ({ apiHost: "x", sessionId: "S" }));
    assert.equal(noId.orgs.length, 0);
    assert.equal(noId.skipped.length, 1);
    assert.equal(hostOfTab({ url: "http://qa.lightning.force.com/" }), null, "https only");
  });

  await test("a choice is named by the org's name and host and never shows the session", async () => {
    const g = await groupTabsByOrg([tab("https://uat.lightning.force.com/")], async (h) => SESSIONS[h]);
    const c = { id: g.orgs[0].orgId, name: "Example UAT", host: g.orgs[0].apiHost, api: { sessionId: "SECRET" } };
    assert.equal(choiceLabel(c), "Example UAT (uat.sandbox.my.salesforce.com)");
    assert.ok(!choiceLabel(c).includes("SECRET"));
    assert.equal(choiceLabel({ id: "00DX" }), "00DX");
  });

  // ---- hidden values ----

  await test("hidden custom setting values stay hidden across orgs, and equal hidden values still match", () => {
    const RAW1 = "RAWSECRET-ONE-0123456789";
    const RAW2 = "RAWSECRET-TWO-9876543210";
    const f = { name: "Api_Token__c", label: "Api Token", type: "string" };
    const mkOrg = (user, ids, val, orgVal) => {
      const items = settingItems({ api: "Int__c", label: "Int" }, [f],
        [{ SetupOwnerId: ids.orgId, Api_Token__c: orgVal }, { SetupOwnerId: ids.userId, Api_Token__c: val }], ids);
      return validateAccess({
        schema: "sf-user-access/1", user: { id: user, name: "Alex Example", username: `${user}@example.com`, isActive: true },
        sections: { ...Object.fromEntries(SECTION_KEYS.map((k) => [k, []])), customSettings: items },
        customSettingsInfo: { found: 1, examined: 1, hierarchy: 1, failed: 0, failedSettings: [], skippedFields: 0, capped: false },
      });
    };
    const idsA = { userId: "005AAA000000001", profileId: "00eAAA000000001", orgId: "00DAAA000000001" };
    const idsB = { userId: "005BBB000000001", profileId: "00eBBB000000001", orgId: "00DBBB000000001" };
    const a = mkOrg("u1", idsA, RAW1, "ORGDEFAULT-A");
    const same = mkOrg("u2", idsB, RAW1, "ORGDEFAULT-B");
    const other = mkOrg("u3", idsB, RAW2, "ORGDEFAULT-B");
    const rSame = compareAcrossOrgs(a, same, ORG_A, ORG_B);
    const rOther = compareAcrossOrgs(a, other, ORG_A, ORG_B);
    assert.equal(rSame.sections.customSettings[0].status, "same", "the same hidden value in both orgs");
    assert.equal(rOther.sections.customSettings[0].status, "differ", "different hidden values differ");
    for (const r of [rSame, rOther]) {
      const everything = JSON.stringify(r) + toCsv(toRows(r)) + r.sections.customSettings.map((x) => `${x.detailA}|${x.detailB}`).join("|");
      for (const raw of [RAW1, RAW2, "ORGDEFAULT-A", "ORGDEFAULT-B"]) assert.ok(!everything.includes(raw), `${raw} must not appear`);
      assert.ok(everything.includes(HIDDEN_TEXT));
    }
  });

  // ---- the demo sample ----

  await test("the made-up second org for the demo has the same person, some matching items and some in one org only, and stays synthetic", () => {
    const text = readFileSync(ext("samples", "user_access_other_org.json"), "utf-8");
    assert.ok(!/[\w.]+@(?!example\.com)[\w.-]+/.test(text), "only example.com addresses");
    const org = JSON.parse(text).orgs[0];
    assert.ok(/^00DDEMO/.test(org.id) && /example\.com$/.test(org.host), "made-up org Id and host");
    const demoA = JSON.parse(readFileSync(ext("samples", "user_a.json"), "utf-8"));
    const users = org.users.map(validateAccess);
    const same = users.find((u) => u.user.name === demoA.user.name);
    assert.ok(same, "the same person is in the other org");
    const taken = new Set([demoA.user.id.slice(0, 15), "005DEMO00000BBB"]);
    for (const u of users) {
      assert.match(u.user.id, /DEMO/, "made-up user Ids");
      assert.ok(!taken.has(u.user.id.slice(0, 15)), "user Ids differ inside the first 15 characters from org A's");
    }
    assert.ok(!sameOrg(org.id, "00DDEMOPRD00001"), "a different org Id than the demo's org A");
    const r = compareAcrossOrgs(validateAccess(demoA), same, { id: "00DDEMOPRD00001", name: "Example Production" }, org);
    const all = Object.values(r.sections).flat();
    for (const s of ["same", "onlyA", "onlyB", "differ"]) assert.ok(all.some((x) => x.status === s), `the demo has a row that is ${s}`);
    const profile = r.sections.profile[0];
    assert.ok(profile.status === "same" && profile.a.label !== profile.b.label, "same API name, other label");
  });

  await test("the cross-org code uses only reads: no POST, no PATCH, no storage, no HTML strings", () => {
    for (const f of ["user-access.js", "user-access-orgs.js", "user-access-logic.js", "user-access-read.js"]) {
      const t = readFileSync(ext("tools", "user-access", f), "utf-8");
      for (const bad of ["method:", "POST", "PATCH", "DELETE", "innerHTML", "insertAdjacentHTML", "localStorage", "chrome.storage", "XMLHttpRequest", "eval("]) {
        assert.ok(!t.includes(bad), `${f} contains ${bad}`);
      }
    }
    const page = readFileSync(ext("tools", "user-access", "user-access.js"), "utf-8");
    assert.ok(page.includes("chrome.tabs.query({})"), "the other org comes from the browser's open tabs");
    const manifest = JSON.parse(readFileSync(ext("manifest.json"), "utf-8"));
    assert.ok(manifest.permissions.includes("tabs") && manifest.permissions.includes("cookies"));
  });

  await test("the dev server forwards the second org read-only under /sf2/", () => {
    const py = readFileSync(ext("dev", "dev_server.py"), "utf-8");
    assert.match(py, /--second-org/);
    assert.match(py, /startswith\("\/sf2\/"\)/);
    assert.match(py, /Only \/services\/data\/ is forwarded/);
    assert.ok(!/method="(POST|PUT|PATCH|DELETE)"/.test(py));
  });
}
