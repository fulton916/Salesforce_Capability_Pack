// Offline tests for the "Why can a user see this record?" page. Called from run_tests.mjs with its shared `test` function.
// Synthetic data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SfApi } from "../extension/lib/sfconn.js";
import { recordIdFromUrl, looksLikeId, to18, explain, toPlainText, causeInfo, owdText, sfLevel, shareLevel, exactFirst } from "../extension/lib/recordaccess.js";
import { readRecordContext, readRecordAccess, readMemberRoles, readUserById } from "../extension/lib/recordaccessread.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = (...p) => path.join(here, "../extension", ...p);

// ---------- synthetic facts ----------

const ID = {
  rec: "001000000000001AAA",
  alice: "005000000000001AAA", bob: "005000000000002AAA", maria: "005000000000003AAA", carl: "005000000000004AAA",
  top: "00E000000000001AAA", mid: "00E000000000002AAA", low: "00E000000000003AAA", other: "00E000000000004AAA",
  gEmea: "00G000000000001AAA", gUk: "00G000000000002AAA", gRole: "00G000000000003AAA", gQueue: "00G000000000004AAA",
  gTerr: "00G000000000005AAA", gTerrSub: "00G000000000006AAA", gOrg: "00G000000000007AAA", gBosses: "00G000000000008AAA",
  t1: "0MI000000000001AAA", t2: "0MI000000000002AAA",
};

const SF_NONE = { read: false, edit: false, delete: false, transfer: false, all: false, max: "None" };
const SF_VIEW = { read: true, edit: false, delete: false, transfer: false, all: false, max: "Read" };
const SF_EDIT = { read: true, edit: true, delete: false, transfer: false, all: false, max: "Edit" };
const SF_ALL = { read: true, edit: true, delete: true, transfer: true, all: true, max: "All" };

const PROFILE = (over = {}) => ({ kind: "profile", name: "Standard User", read: true, create: true, edit: true, delete: false, viewAll: false, modifyAll: false, viewAllData: false, modifyAllData: false, ...over });

const user = (id, name, over = {}) => ({
  id, name, username: `${name.split(" ")[0].toLowerCase()}${id.slice(12, 15)}@example.invalid`, isActive: true, userType: "Standard", profile: "Standard User",
  roleId: null, roleName: "", sf: SF_NONE, parentSf: null, object: { sets: [PROFILE()] }, memberOf: [], territoryIds: [], teamRole: null, childCounts: null, ...over,
});

const grp = (id, type, name, relatedId = null, includeBosses = false) => ({ id, type, name, relatedId, includeBosses });

/** top > mid > low, and `other` under top. */
function facts(over = {}) {
  const base = {
    schema: "sf-record-access/1",
    record: { id: ID.rec, object: "Account", name: "Contoso (sample)", ownerId: ID.maria, ownerKind: "user", ownerName: "Maria Keller", ownerRoleId: ID.low, parentId: null, parentObjectLabel: "", parentName: "" },
    owd: { internal: "Private", external: "Private" },
    object: { api: "Account", label: "Account", plural: "Accounts", custom: false, grantByHierarchy: null },
    roles: [
      { id: ID.top, parentId: null, name: "Sales Director" },
      { id: ID.mid, parentId: ID.top, name: "UK Manager" },
      { id: ID.low, parentId: ID.mid, name: "UK Rep" },
      { id: ID.other, parentId: ID.top, name: "France Rep" },
    ],
    territories: { on: false, items: [], record: [] },
    shares: { available: true, truncated: false, rows: [{ who: ID.maria, level: "All", cause: "Owner" }] },
    groups: [], shareUsers: [], users: [], notes: [], warnings: [],
  };
  return { ...base, ...over };
}

const only = (res, i = 0) => res.users[i];
const kinds = (u) => u.routes.map((r) => r.key);

export async function run(test) {
  // ---------- record Id from an address ----------

  await test("record access: Id from Lightning addresses", () => {
    const base = "https://acme.lightning.force.com";
    assert.equal(recordIdFromUrl(`${base}/lightning/r/Account/001000000000001AAA/view`), "001000000000001AAA");
    assert.equal(recordIdFromUrl(`${base}/lightning/r/Account/001000000000001AAA/edit`), "001000000000001AAA");
    assert.equal(recordIdFromUrl(`${base}/lightning/r/Account/001000000000001AAA/related/Contacts/view?ws=%2Flightning`), "001000000000001AAA");
    assert.equal(recordIdFromUrl(`${base}/lightning/r/001000000000001/view`), "001000000000001");
    assert.equal(recordIdFromUrl(`${base}/lightning/r/My_Thing__c/a0B000000000001AAA/view`), "a0B000000000001AAA");
    assert.equal(recordIdFromUrl(`${base}/lightning/r/ProductConsumed/a0B000000000001AAA/view`), "a0B000000000001AAA");
  });

  await test("record access: Id from Classic and console addresses", () => {
    assert.equal(recordIdFromUrl("https://acme.my.salesforce.com/001000000000001AAA"), "001000000000001AAA");
    assert.equal(recordIdFromUrl("https://acme.my.salesforce.com/001000000000001?retURL=%2Fhome"), "001000000000001");
    assert.equal(recordIdFromUrl("https://acme.my.salesforce.com/001000000000001AAA/e"), "001000000000001AAA");
    assert.equal(recordIdFromUrl("https://na1.salesforce.com/console#%2F001000000000001AAA"), "001000000000001AAA");
    assert.equal(recordIdFromUrl("https://acme.lightning.force.com/one/one.app#/sObject/001000000000001AAA/view"), "001000000000001AAA");
    assert.equal(recordIdFromUrl("  001000000000001AAA "), "001000000000001AAA"); // a pasted Id
  });

  await test("record access: Setup, list and other pages give no Id", () => {
    const base = "https://acme.lightning.force.com";
    for (const u of [
      `${base}/lightning/setup/ObjectManager/Account/Details/view`,
      `${base}/lightning/setup/PermSetGroups/page?address=%2F0PG000000000001AAA`,
      `${base}/lightning/o/Account/list?filterName=Recent`,
      `${base}/lightning/page/home`,
      `${base}/lightning/r/Account/view`,
      "https://acme.my.salesforce.com/setup/forcecomHomepage.apexp",
      "https://acme.my.salesforce.com/001/o",
      "https://acme.my.salesforce.com/home/home.jsp",
      "chrome://extensions", "", null, undefined, "not a url",
    ]) assert.equal(recordIdFromUrl(u), null, String(u));
  });

  await test("record access: bad Ids are refused", () => {
    for (const bad of ["001000000000001A", "00100000000000", "001-00000000001AAA", "ProductConsumed", "001000000000001AAAA", "0010000000000 1AAA"]) {
      assert.equal(looksLikeId(bad), false, bad);
      assert.equal(recordIdFromUrl(bad), null, bad);
    }
    assert.equal(recordIdFromUrl("https://acme.lightning.force.com/lightning/r/Account/00100000000000/view"), null);
  });

  await test("record access: 15 to 18 character Ids", () => {
    assert.equal(to18("001000000000001"), "001000000000001AAA");
    assert.equal(to18("001D000000IqhSL"), "001D000000IqhSLIAZ");
    assert.equal(to18("001000000000001AAA"), "001000000000001AAA");
  });

  // ---------- each route ----------

  await test("record access: the owner has a route with full access", () => {
    const f = facts({ users: [user(ID.maria, "Maria Keller", { sf: SF_ALL })] });
    const u = only(explain(f));
    assert.deepEqual(kinds(u), ["owner"]);
    assert.equal(u.routes[0].access, "full");
    assert.match(u.routes[0].steps[0], /Maria Keller owns this record/);
    assert.equal(u.mismatch, null);
    assert.match(explain(f).verdict, /Maria Keller has full access to this record\./);
  });

  await test("record access: a queue owner, directly and through a group inside the queue", () => {
    const rec = { ...facts().record, ownerId: ID.gQueue, ownerKind: "queue", ownerName: "Support Queue", ownerRoleId: null };
    const groups = [grp(ID.gQueue, "Queue", "Support Queue"), grp(ID.gEmea, "Regular", "Support Team")];
    const direct = facts({ record: rec, groups, users: [user(ID.alice, "Alice Smith", { sf: SF_EDIT, memberOf: [{ groupId: ID.gQueue, memberId: ID.alice }] })] });
    let u = only(explain(direct));
    assert.deepEqual(kinds(u), ["ownerQueue"]);
    assert.match(u.routes[0].steps.join(" | "), /owned by queue 'Support Queue' \| .*is a direct member of queue 'Support Queue'/);
    const nested = facts({ record: rec, groups, users: [user(ID.alice, "Alice Smith", { sf: SF_EDIT, memberOf: [{ groupId: ID.gEmea, memberId: ID.alice }, { groupId: ID.gQueue, memberId: ID.gEmea }] })] });
    u = only(explain(nested));
    assert.deepEqual(kinds(u), ["ownerQueue"]);
    assert.match(u.routes[0].steps.join(" | "), /Queue 'Support Queue' includes public group 'Support Team'/);
    const outside = facts({ record: rec, groups, users: [user(ID.bob, "Bob Jones", { sf: SF_NONE })] });
    assert.deepEqual(kinds(only(explain(outside))), []);
  });

  await test("record access: a role above the owner's role (and not when it is not above, or the hierarchy is off)", () => {
    const mk = (roleId, extra = {}) => facts({ ...extra, users: [user(ID.alice, "Alice Smith", { sf: SF_EDIT, roleId, roleName: roleId === ID.mid ? "UK Manager" : "x" })] });
    let u = only(explain(mk(ID.mid)));
    assert.deepEqual(kinds(u), ["ownerRole"]);
    assert.match(u.routes[0].steps.at(-1), /role 'UK Manager' is above 'UK Rep' in the role hierarchy/);
    assert.deepEqual(kinds(only(explain(mk(ID.other)))), []); // another branch
    assert.deepEqual(kinds(only(explain(mk(ID.low)))), []); // same level is not above
    const off = mk(ID.mid, { object: { api: "Thing__c", label: "Thing", plural: "Things", custom: true, grantByHierarchy: false } });
    assert.deepEqual(kinds(only(explain(off))), []);
  });

  await test("record access: a manual share to the user, and to someone below them in the hierarchy", () => {
    const rows = [{ who: ID.alice, level: "Edit", cause: "Manual" }, { who: ID.carl, level: "Read", cause: "Manual" }];
    const f = facts({
      shares: { available: true, rows },
      shareUsers: [{ id: ID.carl, name: "Carl Brown", roleId: ID.low }],
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_EDIT }),
        user(ID.bob, "Bob Jones", { sf: SF_VIEW, roleId: ID.mid, roleName: "UK Manager" }),
      ],
    });
    const res = explain(f);
    const alice = res.users[0];
    assert.equal(alice.routes[0].steps[0], "Shared manually with Alice Smith");
    assert.equal(alice.routes[0].access, "edit");
    const bob = res.users[1];
    assert.ok(bob.routes.some((r) => r.key.startsWith("shareBoss") && /Carl Brown/.test(r.steps[0]) && /is above 'UK Rep'/.test(r.steps[2])), JSON.stringify(bob.routes.map((r) => r.steps)));
  });

  await test("record access: a sharing rule to a nested public group, even when the groups include each other", () => {
    const f = facts({
      shares: { available: true, rows: [{ who: ID.gEmea, level: "Read", cause: "Rule" }] },
      groups: [grp(ID.gEmea, "Regular", "EMEA Sales"), grp(ID.gUk, "Regular", "UK Sales"), grp(ID.gRole, "RoleAndSubordinates", "", ID.mid)],
      users: [user(ID.alice, "Alice Smith", {
        sf: SF_VIEW, roleId: ID.low, roleName: "UK Rep",
        memberOf: [
          { groupId: ID.gUk, memberId: ID.gRole }, { groupId: ID.gEmea, memberId: ID.gUk },
          { groupId: ID.gUk, memberId: ID.gEmea }, // loop
        ],
      })],
    });
    const u = only(explain(f));
    assert.deepEqual(kinds(u), [`share:${k15(ID.gEmea)}:Rule`]);
    assert.deepEqual(u.routes[0].steps, [
      "Shared by a sharing rule with public group 'EMEA Sales'",
      "Public group 'EMEA Sales' includes public group 'UK Sales'",
      "Public group 'UK Sales' includes role 'UK Manager' and the roles below it",
      "Alice Smith's role 'UK Rep' is below 'UK Manager'",
    ]);
    assert.equal(u.routes[0].access, "view");
    assert.equal(u.mismatch, null);
  });

  await test("record access: a group the user is directly in, and a loop that never reaches the user", () => {
    const f = facts({
      shares: { available: true, rows: [{ who: ID.gEmea, level: "Edit", cause: "Manual" }] },
      groups: [grp(ID.gEmea, "Regular", "A"), grp(ID.gUk, "Regular", "B")],
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_EDIT, memberOf: [{ groupId: ID.gEmea, memberId: ID.alice }] }),
        user(ID.bob, "Bob Jones", { sf: SF_NONE, memberOf: [{ groupId: ID.gUk, memberId: ID.gEmea }, { groupId: ID.gEmea, memberId: ID.gUk }] }),
      ],
    });
    const res = explain(f);
    assert.match(res.users[0].routes[0].steps.at(-1), /Alice Smith is a direct member of public group 'A'/);
    assert.deepEqual(kinds(res.users[1]), []);
  });

  await test("record access: role, role-and-subordinates and role-above groups", () => {
    const groups = [grp(ID.gRole, "Role", "", ID.low), grp(ID.gUk, "RoleAndSubordinates", "", ID.mid), grp(ID.gEmea, "RoleAndSubordinatesInternal", "", ID.low)];
    const rows = [
      { who: ID.gRole, level: "Read", cause: "Rule" }, { who: ID.gUk, level: "Edit", cause: "Rule" }, { who: ID.gEmea, level: "Read", cause: "Manual" },
    ];
    const f = facts({
      shares: { available: true, rows }, groups,
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_EDIT, roleId: ID.low, roleName: "UK Rep" }), // in all of them
        user(ID.bob, "Bob Jones", { sf: SF_VIEW, roleId: ID.top, roleName: "Sales Director" }), // above all of them
        user(ID.carl, "Carl Brown", { sf: SF_NONE, roleId: ID.other, roleName: "France Rep" }),
      ],
    });
    const res = explain(f, [ID.alice, ID.bob]);
    const a = res.users[0];
    assert.ok(a.routes.some((r) => r.steps.join("|").includes("Shared by a sharing rule with role 'UK Rep'") && /Alice Smith's role is 'UK Rep'/.test(r.steps.at(-1))));
    assert.ok(a.routes.some((r) => r.steps[0] === "Shared by a sharing rule with role 'UK Manager' and the roles below it" && /is below 'UK Manager'/.test(r.steps.at(-1))));
    const b = res.users[1];
    assert.ok(b.routes.length >= 3 && b.routes.every((r) => r.kind === "hierarchy" || r.key.startsWith("shareBoss")), JSON.stringify(b.routes.map((r) => r.key)));
    assert.match(b.routes[0].steps.at(-1), /is above/);
    assert.deepEqual(kinds(explain(f, [ID.carl]).users[0]), []);
  });

  await test("record access: territory and territory-and-subordinates groups, and the record's own territories", () => {
    const territories = {
      on: true,
      items: [{ id: ID.t1, parentId: null, name: "EMEA" }, { id: ID.t2, parentId: ID.t1, name: "UK" }],
      record: [{ id: ID.t2, cause: "Territory2AssignmentRule" }],
    };
    const groups = [grp(ID.gTerr, "Territory", "", ID.t2), grp(ID.gTerrSub, "TerritoryAndSubordinates", "", ID.t1)];
    const f = facts({
      territories, groups,
      shares: { available: true, rows: [{ who: ID.gTerr, level: "Read", cause: "TerritoryRule" }, { who: ID.gTerrSub, level: "Read", cause: "Territory2AssociationManual" }] },
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_VIEW, territoryIds: [ID.t2] }),
        user(ID.bob, "Bob Jones", { sf: SF_VIEW, territoryIds: [ID.t1] }), // assigned above the record's territory
        user(ID.carl, "Carl Brown", { sf: SF_NONE }),
      ],
    });
    const res = explain(f, [ID.alice, ID.bob]);
    const a = res.users[0];
    assert.ok(a.routes.some((r) => r.steps[0] === "Shared through territory assignment with territory 'UK'" && r.steps.at(-1) === "Alice Smith is assigned to territory 'UK'"));
    assert.ok(a.routes.some((r) => r.steps[0].endsWith("territory 'EMEA' and the territories below it") && /territory 'UK', which is below 'EMEA'/.test(r.steps.at(-1))));
    // Bob's territory is above the record's, so only the standalone territory route and the subordinates group apply
    const b = res.users[1];
    assert.ok(b.routes.some((r) => r.key.startsWith("share:") && /territories below it/.test(r.steps[0])));
    assert.ok(a.routes.every((r) => !r.key.startsWith("territory:")), "a share row already proves it");
    // no territory share row at all: the record's territory and the user's assignment give a route
    const noRows = facts({ territories, shares: { available: true, rows: [] }, users: [user(ID.bob, "Bob Jones", { sf: SF_VIEW, territoryIds: [ID.t1] })] });
    const r = only(explain(noRows)).routes[0];
    assert.equal(r.key, `territory:${k15(ID.t2)}`);
    assert.deepEqual(r.steps, ["The record is in territory 'UK' (by an assignment rule)", "Bob Jones is assigned to territory 'EMEA', which is above 'UK'"]);
    assert.deepEqual(kinds(explain(f, [ID.carl]).users[0]), []);
  });

  await test("record access: a team share names the team role; implicit child access counts the records", () => {
    const f = facts({
      shares: { available: true, rows: [{ who: ID.alice, level: "Edit", cause: "Team" }, { who: ID.bob, level: "Read", cause: "ImplicitChild" }] },
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_EDIT, teamRole: "Sales Rep" }),
        user(ID.bob, "Bob Jones", { sf: SF_VIEW, childCounts: { Opportunity: 2, Case: 0, Contact: 1 } }),
      ],
    });
    const res = explain(f);
    assert.equal(res.users[0].routes[0].steps[0], "Alice Smith is on the account team as 'Sales Rep'");
    assert.equal(res.users[1].routes[0].steps[0], "Bob Jones owns 2 opportunities, 1 contact on this account, so Salesforce gives Bob Jones implicit access to it");
    // no share row but child records: a route of its own
    const g = facts({ shares: { available: true, rows: [] }, users: [user(ID.bob, "Bob Jones", { sf: SF_VIEW, childCounts: { Opportunity: 1, Case: 0, Contact: 0 } })] });
    assert.deepEqual(kinds(only(explain(g))), ["implicitChild"]);
  });

  await test("record access: causes in plain words, Apex reasons and unknown codes", () => {
    assert.match(causeInfo("Rule", "Account").phrase, /sharing rule/);
    assert.match(causeInfo("Manual", "Account").phrase, /manually/);
    assert.match(causeInfo("Team", "Opportunity").phrase, /opportunity team/);
    assert.match(causeInfo("Team", "Case").phrase, /case team/);
    assert.equal(causeInfo("Territory2AssociationManual", "Account").kind, "territory");
    assert.equal(causeInfo("ImplicitParent", "Contact").kind, "implicit");
    assert.equal(causeInfo("Partner_Access__c", "Thing__c").phrase, "Shared by the Apex sharing reason 'Partner Access'");
    assert.equal(causeInfo("Weird", "Account").phrase, "Shared (reason code 'Weird')");
  });

  await test("record access: public org-wide default, internal and external", () => {
    const f = facts({
      owd: { internal: "Read", external: "Private" },
      users: [user(ID.alice, "Alice Smith", { sf: SF_VIEW }), user(ID.bob, "Bob Jones", { sf: SF_NONE, userType: "PowerPartner" })],
    });
    const res = explain(f);
    assert.deepEqual(kinds(res.users[0]), ["owd"]);
    assert.equal(res.users[0].routes[0].access, "view");
    assert.match(res.users[0].routes[0].steps[0], /Accounts are Public Read Only/);
    assert.deepEqual(kinds(res.users[1]), []);
    assert.match(owdText("Private", "Accounts"), /^Accounts are Private: only the owner, people above them/);
    assert.match(owdText("ReadWrite", "Accounts"), /Public Read\/Write/);
    const rw = explain(facts({ owd: { internal: "ReadWrite", external: "Private" }, users: [user(ID.alice, "Alice Smith", { sf: SF_EDIT })] }));
    assert.equal(rw.users[0].routes[0].access, "edit");
  });

  await test("record access: controlled by parent names the parent and uses the user's access on it", () => {
    const f = facts({
      owd: { internal: "ControlledByParent", external: "ControlledByParent" },
      object: { api: "Contact", label: "Contact", plural: "Contacts", custom: false },
      record: { ...facts().record, ownerId: null, ownerKind: null, ownerName: "", parentId: ID.rec, parentObjectLabel: "Account", parentName: "Contoso (sample)" },
      users: [user(ID.alice, "Alice Smith", { sf: SF_EDIT, parentSf: SF_EDIT }), user(ID.bob, "Bob Jones", { sf: SF_NONE, parentSf: SF_NONE })],
    });
    const res = explain(f);
    assert.equal(res.record.parentId, ID.rec);
    assert.equal(res.record.parentName, "Contoso (sample)");
    assert.deepEqual(kinds(res.users[0]), ["parent"]);
    assert.equal(res.users[0].routes[0].access, "edit");
    assert.match(res.users[0].routes[0].steps.join(" "), /Contacts depend on the record they belong to: Account 'Contoso \(sample\)'/);
    assert.match(res.users[1].parentLine, /Bob Jones can't see it/);
    assert.deepEqual(kinds(res.users[1]), []);
    assert.match(res.record.owdText, /get their access from the record they belong to/);
    assert.doesNotMatch(res.record.owdText, /whoever can see the parent can see them/);
  });

  await test("record access: the difference never says a user lacks a territory route they have (second user assigned to the record's territory)", () => {
    const territories = {
      on: true,
      items: [{ id: ID.t1, parentId: null, name: "Traffic" }, { id: ID.t2, parentId: ID.t1, name: "69 - Rep" }],
      record: [{ id: ID.t2, cause: "Territory2AssignmentRule" }],
    };
    const f = facts({
      territories, groups: [grp(ID.gTerr, "Territory", "", ID.t2)],
      shares: { available: true, rows: [{ who: ID.gTerr, level: "Edit", cause: "Territory" }] },
      users: [
        user(ID.alice, "Scott Above", { sf: SF_ALL, territoryIds: [ID.t1] }), // above the record's territory: no territory share group reaches him
        user(ID.bob, "April Own", { sf: SF_VIEW, territoryIds: [ID.t2], object: { sets: [PROFILE({ edit: false })] } }),
      ],
    });
    const res = explain(f, [ID.alice, ID.bob]);
    const [a, b] = res.users;
    assert.ok(a.routes.some((r) => r.key.startsWith("territory:")), "the user above gets the record-territory route");
    assert.ok(b.routes.some((r) => r.key.startsWith("share:")), "the assigned user gets the share-row route");
    assert.doesNotMatch(toPlainText(res), /April Own is not assigned to territory/);
    const terrItem = res.difference.items.find((i) => /territory/.test(i.route));
    assert.match(terrItem.missing[0], /April Own has this route too, but April Own's object permissions limit it to view access/);
    // the record-in-territory line is one line, not two
    const r = a.routes.find((x) => x.key.startsWith("territory:"));
    assert.equal(r.summary, r.steps[0]);
    // the other user's route is the one capped by object permissions, and the note says so
    assert.match(res.difference.levelNote, /April Own has a route that would give edit access, but April Own's object permissions on Accounts hold April Own to view access/);
  });

  await test("record access: object permissions cap sharing like Salesforce (Read / Edit / Delete, Modify All)", () => {
    const run = (setOver, sf) => only(explain(facts({ users: [user(ID.maria, "Maria Keller", { sf, object: { sets: [PROFILE(setOver)] } })] })));
    // Read + Edit + Delete and full sharing: not limited
    const full = run({ delete: true }, SF_ALL);
    assert.equal(full.cap, "full");
    assert.equal(full.routes[0].limited, false);
    assert.equal(full.limitText, null);
    assert.equal(full.mismatch, null);
    // Delete from a second permission set counts too
    const f2 = facts({ users: [user(ID.maria, "Maria Keller", { sf: SF_ALL, object: { sets: [PROFILE(), PROFILE({ kind: "permissionSet", name: "Deleter", read: false, edit: false, delete: true })] } })] });
    assert.equal(only(explain(f2)).routes[0].limited, false);
    // No Delete: limited to edit
    const noDel = run({ delete: false }, SF_EDIT);
    assert.equal(noDel.cap, "edit");
    assert.equal(noDel.routes[0].limited, true);
    assert.equal(noDel.routes[0].effective, "edit");
    // Read only: limited to view
    const ro = run({ edit: false, delete: false }, SF_VIEW);
    assert.equal(ro.cap, "view");
    assert.equal(ro.routes[0].effective, "view");
    // Modify All needs no Delete flag
    assert.equal(run({ edit: false, modifyAll: true }, SF_ALL).cap, "full");
    // Sharing is full (HasAllAccess) but Read only on the object: the wording names what is held back
    const res = explain(facts({ users: [user(ID.maria, "Maria Keller", { sf: { read: true, edit: false, delete: false, transfer: false, all: true }, object: { sets: [PROFILE({ edit: false })] } })] }));
    assert.match(res.users[0].limitText, /only allow viewing/);
  });

  await test("record access: full access needs delete too (all + edit, no delete is edit)", () => {
    const sfAllEditNoDelete = { read: true, edit: true, delete: false, transfer: false, all: true, max: "All" };
    const run = (setOver, sf) => explain(facts({ users: [user(ID.maria, "Maria Keller", { sf, object: { sets: [PROFILE(setOver)] } })] }));
    // all + edit + no delete: "can edit", sharing still full, and the limit line says why
    const res = run({ delete: false }, sfAllEditNoDelete);
    const u = only(res);
    assert.equal(u.sfLevel, "edit");
    assert.equal(u.sfShare, "full");
    assert.match(u.sfText, /can edit/);
    assert.match(res.verdict, /can edit this record/);
    assert.doesNotMatch(res.verdict, /full access to this record\.\s*$/);
    assert.match(u.limitText, /Sharing gives Maria Keller full access to this record, but Maria Keller's object permissions on .* only allow editing, not deleting, so Maria Keller can only edit it/);
    // the route capped to edit matches Salesforce's answer of edit: no mismatch
    assert.equal(u.routes[0].effective, "edit");
    assert.equal(u.mismatch, null);
    // all + edit + delete: full, no limit line
    const full = only(run({ delete: true }, SF_ALL));
    assert.equal(full.sfLevel, "full");
    assert.equal(full.limitText, null);
    // read only: view
    assert.equal(sfLevel({ read: true, edit: false, delete: false, transfer: false, all: false }), "view");
    assert.equal(sfLevel(sfAllEditNoDelete), "edit");
  });

  await test("record access: a route that goes through the other user is not listed as missing for that user", () => {
    // Bob has a manual share; Alice is above Bob in the role hierarchy and so reaches the record through that share.
    const f = facts({
      shares: { available: true, rows: [{ who: ID.bob, level: "Edit", cause: "Manual" }] },
      shareUsers: [{ id: ID.bob, name: "Bob Jones", roleId: ID.low }],
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_ALL, roleId: ID.mid, roleName: "UK Manager", object: { sets: [PROFILE({ delete: true })] } }),
        user(ID.bob, "Bob Jones", { sf: SF_EDIT, roleId: ID.low, roleName: "UK Rep" }),
      ],
    });
    const res = explain(f, [ID.alice, ID.bob]);
    assert.ok(res.users[0].routes.some((r) => r.key.startsWith("shareBoss:")), "Alice has the role-above route");
    assert.ok(res.users[1].routes.some((r) => r.key.startsWith("share:")), "Bob has the direct share");
    const text = toPlainText(res);
    assert.doesNotMatch(text, /does not reach the record through Bob Jones/);
    assert.ok(res.difference.items.every((i) => !/who is below/.test(i.route)));
    assert.match(res.difference.via.join(" "), /Alice Smith also reaches this record because Alice Smith is above Bob Jones/);
    assert.match(text, /Alice Smith is above Bob Jones/);
    // the owner's role route is held by the owner themself
    const g = facts({ users: [
      user(ID.alice, "Alice Smith", { sf: SF_ALL, roleId: ID.mid, roleName: "UK Manager" }),
      user(ID.maria, "Maria Keller", { sf: SF_EDIT, roleId: ID.low, roleName: "UK Rep" }),
    ] });
    assert.doesNotMatch(toPlainText(explain(g, [ID.alice, ID.maria])), /Maria Keller's role .* is not above/);
    assert.doesNotMatch(toPlainText(explain(g, [ID.maria, ID.alice])), /Maria Keller is not the owner/);
    // a group the other user is in, reached by Alice as a manager of its members, is not a gap either
    const h = facts({
      groups: [grp(ID.gBosses, "Regular", "Field Teams", null, true)],
      shares: { available: true, rows: [{ who: ID.gBosses, level: "Edit", cause: "Manual" }] },
      memberRoles: { [ID.gBosses]: { roles: [{ roleId: ID.low, example: "Zed Low", count: 1 }], users: 1, capped: false } },
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_ALL, roleId: ID.mid, roleName: "UK Manager" }),
        user(ID.bob, "Bob Jones", { sf: SF_EDIT, roleId: ID.other, roleName: "France Rep", memberOf: [{ groupId: ID.gBosses, memberId: ID.bob }] }),
      ],
    });
    assert.doesNotMatch(toPlainText(explain(h, [ID.alice, ID.bob])), /Bob Jones is not in public group 'Field Teams'/);
  });

  await test("record access: implicit shares are written plainly", () => {
    const f = facts({
      shares: { available: true, rows: [{ who: ID.bob, level: "Read", cause: "ImplicitParent" }, { who: ID.alice, level: "Read", cause: "ImplicitChild" }] },
      users: [user(ID.bob, "Dana Fields", { sf: SF_VIEW }), user(ID.alice, "Alice Smith", { sf: SF_VIEW })],
    });
    const res = explain(f);
    assert.equal(res.users[0].routes[0].steps[0], "Shared implicitly with Dana Fields, through access to a related record (the parent of this record)");
    assert.equal(res.users[1].routes[0].steps[0], "Shared implicitly with Alice Smith, through access to a child record of this record");
    assert.doesNotMatch(toPlainText(res), /the user has access/);
    const g = facts({
      shares: { available: true, rows: [{ who: ID.bob, level: "Read", cause: "ImplicitParent" }] },
      users: [user(ID.bob, "Dana Fields", { sf: SF_VIEW, childCounts: { Contact: 1 } })],
    });
    assert.equal(only(explain(g)).routes[0].steps[0], "Dana Fields owns 1 contact on this account, so Salesforce gives Dana Fields implicit access to it");
  });

  await test("record access: territories with the same name are told apart by where they sit", () => {
    const T3 = "0MI000000000003AAA", T4 = "0MI000000000004AAA";
    const territories = {
      on: true,
      items: [{ id: ID.t1, parentId: null, name: "EMEA Region" }, { id: ID.t2, parentId: ID.t1, name: "EM" }, { id: T3, parentId: null, name: "APAC Region" }, { id: T4, parentId: T3, name: "EM" }],
      record: [{ id: ID.t2, cause: "Territory2AssignmentRule" }, { id: T4, cause: "Territory2AssignmentRule" }],
    };
    const f = facts({ territories, users: [user(ID.bob, "Bob Jones", { sf: SF_VIEW, territoryIds: [ID.t2, T4] })] });
    const steps = only(explain(f)).routes.map((r) => r.steps[0]).sort();
    assert.deepEqual(steps, ["The record is in territory 'EM (under APAC Region)' (by an assignment rule)", "The record is in territory 'EM (under EMEA Region)' (by an assignment rule)"]);
    // same name under same-named parents: the whole path
    const g = facts({
      territories: { on: true, items: [
        { id: ID.t1, parentId: null, name: "North" }, { id: T3, parentId: null, name: "North" },
        { id: ID.t2, parentId: ID.t1, name: "EM" }, { id: T4, parentId: T3, name: "EM" },
      ], record: [{ id: ID.t2, cause: "" }, { id: T4, cause: "" }] },
      users: [user(ID.bob, "Bob Jones", { sf: SF_VIEW, territoryIds: [ID.t2, T4] })],
    });
    const names = only(explain(g)).routes.map((r) => r.steps[0]);
    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1]);
    // a unique name stays plain
    const h = facts({ territories: { on: true, items: [{ id: ID.t1, parentId: null, name: "Traffic" }], record: [{ id: ID.t1, cause: "" }] }, users: [user(ID.bob, "Bob Jones", { sf: SF_VIEW, territoryIds: [ID.t1] })] });
    assert.match(only(explain(h)).routes[0].steps[0], /territory 'Traffic'$/);
  });

  await test("record access: a team route that only restates the owner is shown once", () => {
    const f = facts({
      record: { ...facts().record, ownerId: ID.alice, ownerName: "Alice Smith" },
      shares: { available: true, rows: [{ who: ID.alice, level: "Edit", cause: "Team" }, { who: ID.bob, level: "Edit", cause: "Team" }] },
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_ALL, teamRole: "Sales Rep", object: { sets: [PROFILE({ delete: true })] } }),
        user(ID.bob, "Bob Jones", { sf: SF_EDIT, teamRole: "Sales Rep" }),
      ],
    });
    const res = explain(f, [ID.alice, ID.bob]);
    assert.deepEqual(kinds(res.users[0]), ["owner"]);
    assert.equal(res.users[1].routes.length, 1, "a real team route stays");
  });

  await test("record access: every 'X is not ...' line is checked against X's own facts", () => {
    // Both have a manual share row: neither lacks "shared directly"
    const both = facts({
      shares: { available: true, rows: [{ who: ID.alice, level: "Edit", cause: "Manual" }, { who: ID.bob, level: "Read", cause: "Manual" }] },
      users: [user(ID.alice, "Alice Smith", { sf: SF_EDIT }), user(ID.bob, "Bob Jones", { sf: SF_VIEW })],
    });
    const r1 = explain(both, [ID.alice, ID.bob]);
    assert.doesNotMatch(toPlainText(r1), /not shared directly with Bob Jones/);
    assert.match(r1.difference.items[0].missing[0], /Bob Jones has this route too, but it gives only view access/);
    // Alice is a member of the owner queue, Bob is above a member: Bob does not lack the queue route
    const q = facts({
      record: { ...facts().record, ownerKind: "queue", ownerId: ID.gQueue, ownerName: "Support Queue" },
      groups: [grp(ID.gQueue, "Queue", "Support Queue")],
      memberRoles: { [ID.gQueue]: { roles: [{ roleId: ID.low, example: "Maria Keller", count: 1 }], users: 1, capped: false } },
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_EDIT, memberOf: [{ groupId: ID.gQueue, memberId: ID.alice }] }),
        user(ID.bob, "Bob Jones", { sf: SF_VIEW, roleId: ID.top, roleName: "Sales Director" }),
      ],
    });
    assert.doesNotMatch(toPlainText(explain(q, [ID.alice, ID.bob])), /Bob Jones is not a member of queue/);
    // A statement that is true is still printed
    const lacks = explain(facts({
      shares: { available: true, rows: [{ who: ID.alice, level: "Edit", cause: "Manual" }] },
      users: [user(ID.alice, "Alice Smith", { sf: SF_EDIT }), user(ID.bob, "Bob Jones", { sf: SF_NONE })],
    }), [ID.alice, ID.bob]);
    assert.match(lacks.difference.items[0].missing[0], /not shared directly with Bob Jones/);
  });

  await test("record access: a task whose parent is readable but is not visible states no parent route as fact", () => {
    const task = (users, over = {}) => facts({
      owd: { internal: "ControlledByParent", external: "ControlledByParent" },
      object: { api: "Task", label: "Task", plural: "Tasks", custom: false, permissionsApply: false },
      record: { ...facts().record, object: "Task", name: "Call", ownerId: null, ownerKind: null, ownerName: "", parentId: ID.rec, parentObjectLabel: "Account", parentName: "Contoso (sample)", whoId: ID.carl, whoObjectLabel: "Contact", whoName: "Pat Doe", ...over },
      users,
    });
    const none = explain(task([user(ID.alice, "Alice Smith", { sf: SF_NONE, parentSf: SF_ALL, whoSf: SF_NONE })]));
    const u = none.users[0];
    assert.deepEqual(u.routes, [], "no 'gives view access' route when Salesforce says no");
    assert.equal(u.mismatch, null);
    assert.match(u.parentLine, /On the parent Account 'Contoso \(sample\)', Salesforce says Alice Smith has full access to it\./);
    assert.match(u.parentLine, /That is not enough: Alice Smith also can't see the Contact 'Pat Doe' that this task is about\. That is the likely reason/);
    assert.doesNotMatch(none.record.owdText, /whoever can see the parent can see them/);
    // person not checked: say so, do not guess
    const unknown = explain(task([user(ID.alice, "Alice Smith", { sf: SF_NONE, parentSf: SF_VIEW })])).users[0];
    assert.match(unknown.parentLine, /we could not check whether Alice Smith can see that/);
    // no linked person at all: still no route, and no claimed reason
    const plain = explain(task([user(ID.alice, "Alice Smith", { sf: SF_NONE, parentSf: SF_VIEW })], { whoId: null })).users[0];
    assert.deepEqual(plain.routes, []);
    assert.match(plain.parentLine, /We could not tell what/);
    // when Salesforce says the user can see it, the parent route still explains it
    const yes = explain(task([user(ID.alice, "Alice Smith", { sf: SF_VIEW, parentSf: SF_VIEW, whoSf: SF_VIEW })])).users[0];
    assert.deepEqual(kinds(yes), ["parent"]);
  });

  await test("record access: two users with the same access read plainly", () => {
    const f = (lvl) => explain(facts({ owd: { internal: "Read", external: "Read" }, users: [user(ID.alice, "Alice Smith", { sf: lvl }), user(ID.bob, "Bob Jones", { sf: lvl })] })).difference.text;
    assert.equal(f(SF_ALL), "Both users have full access to this record.");
    assert.equal(f(SF_EDIT), "Both users can edit this record.");
    assert.equal(f(SF_VIEW), "Both users can view this record.");
    assert.equal(f(SF_NONE), "Neither user can see this record.");
  });

  await test("record access: View All, Modify All, View All Data name the profile, permission set or group", () => {
    const f = facts({
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_VIEW, object: { sets: [PROFILE({ name: "Support", viewAll: true }), { ...PROFILE({ kind: "group", name: "Support Lead Group", viewAll: true }) }] } }),
        user(ID.bob, "Bob Jones", { sf: SF_ALL, object: { sets: [PROFILE({ name: "System Administrator", viewAllData: true, modifyAllData: true }), PROFILE({ kind: "permissionSet", name: "Extra", read: false, edit: false })] } }),
      ],
    });
    const res = explain(f);
    const a = res.users[0].routes.find((r) => r.key === "objectAll");
    assert.equal(a.access, "view");
    assert.match(a.steps[0], /'View All' on Accounts is turned on in profile 'Support' and permission set group 'Support Lead Group'/);
    const b = res.users[1].routes.find((r) => r.key === "systemAll");
    assert.equal(b.access, "full");
    assert.match(b.steps[0], /'Modify All Data' is turned on in profile 'System Administrator'/);
  });

  await test("record access: no Read on the object means nothing else counts", () => {
    const f = facts({
      owd: { internal: "Read", external: "Read" },
      shares: { available: true, rows: [{ who: ID.alice, level: "Edit", cause: "Manual" }] },
      users: [user(ID.alice, "Alice Smith", { sf: SF_NONE, object: { sets: [PROFILE({ read: false, create: false, edit: false })] } })],
    });
    const u = only(explain(f));
    assert.equal(u.gate, true);
    assert.deepEqual(u.routes, []);
    assert.match(u.gateText, /Alice Smith has no Read access to Accounts at all \(checked the profile, permission sets and permission set groups\)/);
    assert.equal(u.mismatch, null);
    const text = toPlainText(explain(f));
    assert.match(text, /no Read access to Accounts at all/);
  });

  await test("record access: object permissions cap what a share gives", () => {
    const f = facts({
      shares: { available: true, rows: [{ who: ID.alice, level: "Edit", cause: "Manual" }] },
      users: [user(ID.alice, "Alice Smith", { sf: SF_VIEW, object: { sets: [PROFILE({ edit: false })] } })],
    });
    const u = only(explain(f));
    assert.equal(u.routes[0].access, "edit");
    assert.equal(u.routes[0].effective, "view");
    assert.equal(u.routes[0].limited, true);
    assert.equal(u.mismatch, null);
    assert.match(toPlainText(explain(f)), /gives edit access, limited to view access by object permissions/);
  });

  // ---------- Salesforce's answer wins ----------

  await test("record access: the verdict comes only from Salesforce's answer", () => {
    // Routes say the owner has access, Salesforce says none: the verdict says none.
    const f = facts({ users: [user(ID.maria, "Maria Keller", { sf: SF_NONE })] });
    const res = explain(f);
    assert.equal(res.verdict, "Maria Keller can't see this record.");
    assert.equal(res.users[0].mismatch.kind, "routeButNone");
    assert.match(res.users[0].mismatch.text, /Salesforce's answer is the one that counts/);
    assert.ok(res.users[0].mismatch.causes.some((c) => /restriction rule/.test(c)));
    assert.ok(!res.users[0].mismatch.causes.some((c) => /inactive/.test(c)));
    const inactive = explain(facts({ users: [user(ID.maria, "Maria Keller", { sf: SF_NONE, isActive: false })] }));
    assert.ok(inactive.users[0].mismatch.causes.some((c) => /inactive or frozen/.test(c)));
    assert.match(toPlainText(res), /Does not match Salesforce/);
  });

  await test("record access: Salesforce says access but no route is found", () => {
    const f = facts({ users: [user(ID.bob, "Bob Jones", { sf: SF_EDIT })] });
    const res = explain(f);
    assert.equal(res.verdict, "Bob Jones can edit this record.");
    assert.equal(res.users[0].mismatch.kind, "noRouteFound");
    assert.match(res.users[0].mismatch.text, /Salesforce says Bob Jones can edit this record, but we found no route that explains it/);
    assert.ok(res.users[0].mismatch.causes.some((c) => /related record/.test(c)));
    assert.match(res.notes.join(" "), /did not match/);
  });

  await test("record access: routes that explain less or more than Salesforce says", () => {
    const rows = [{ who: ID.alice, level: "Read", cause: "Manual" }];
    const lower = explain(facts({ shares: { available: true, rows }, users: [user(ID.alice, "Alice Smith", { sf: SF_EDIT })] }));
    assert.equal(lower.users[0].mismatch.kind, "routesLower");
    assert.match(lower.users[0].mismatch.text, /explain only view access/);
    const higher = explain(facts({ shares: { available: true, rows: [{ who: ID.alice, level: "Edit", cause: "Manual" }] }, users: [user(ID.alice, "Alice Smith", { sf: SF_VIEW })] }));
    assert.equal(higher.users[0].mismatch.kind, "routesHigher");
    // Salesforce's answer missing: no verdict is invented
    const unknown = explain(facts({ users: [user(ID.maria, "Maria Keller", { sf: null })] }));
    assert.equal(unknown.verdict, "Salesforce did not say whether Maria Keller can see this record.");
    assert.equal(unknown.users[0].mismatch, null);
  });

  // ---------- two users ----------

  await test("record access: the difference says what the other user is missing on each route", () => {
    const f = facts({
      shares: { available: true, rows: [{ who: ID.maria, level: "All", cause: "Owner" }, { who: ID.gEmea, level: "Read", cause: "Rule" }] },
      groups: [grp(ID.gEmea, "Regular", "EMEA Sales"), grp(ID.gUk, "Regular", "UK Sales"), grp(ID.gRole, "RoleAndSubordinates", "", ID.mid)],
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_EDIT, roleId: ID.mid, roleName: "UK Manager", memberOf: [{ groupId: ID.gUk, memberId: ID.gRole }, { groupId: ID.gEmea, memberId: ID.gUk }] }),
        user(ID.bob, "Bob Jones", { sf: SF_NONE, roleId: ID.other, roleName: "France Rep" }),
      ],
    });
    const res = explain(f);
    assert.equal(res.verdict, "Alice Smith can edit this record. Bob Jones can't see this record.");
    const d = res.difference;
    assert.equal(d.more, "Alice Smith");
    assert.equal(d.less, "Bob Jones");
    const missing = d.items.flatMap((i) => i.missing);
    assert.ok(missing.includes("Bob Jones is not in public group 'EMEA Sales', directly or through another group."), missing.join("\n"));
    assert.ok(missing.includes("Bob Jones's role 'France Rep' is not above the owner's role 'UK Rep' in the role hierarchy."), missing.join("\n"));
    assert.ok(d.items.every((i) => i.change.length === 1));
    // swapping the pickers does not change who is described as having more
    const swapped = explain(f, [ID.bob, ID.alice]);
    assert.equal(swapped.difference.more, "Alice Smith");
    assert.equal(swapped.users[0].name, "Bob Jones");
  });

  await test("record access: the difference names missing object access first, and a limit on a shared route", () => {
    const f = facts({
      shares: { available: true, rows: [{ who: ID.maria, level: "All", cause: "Owner" }, { who: ID.alice, level: "Edit", cause: "Manual" }, { who: ID.bob, level: "Edit", cause: "Manual" }] },
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_EDIT }),
        user(ID.bob, "Bob Jones", { sf: SF_NONE, object: { sets: [PROFILE({ read: false, create: false, edit: false })] } }),
      ],
    });
    const d = explain(f).difference;
    assert.match(d.gate, /Bob Jones has no Read access to Accounts at all/);
    // a user who has the same share but whose profile only reads
    const g = facts({
      shares: { available: true, rows: [{ who: ID.alice, level: "Edit", cause: "Manual" }] },
      users: [user(ID.alice, "Alice Smith", { sf: SF_EDIT }), user(ID.carl, "Carl Brown", { sf: SF_VIEW, object: { sets: [PROFILE({ edit: false })] } })],
    });
    const items = explain(g).difference.items;
    assert.equal(items.length, 1);
    assert.match(items[0].missing[0], /The record is not shared directly with Carl Brown/);
  });

  await test("record access: same access gives no difference list; no route for the better-off user is said plainly", () => {
    const same = explain(facts({ owd: { internal: "Read", external: "Read" }, users: [user(ID.alice, "Alice Smith", { sf: SF_VIEW }), user(ID.bob, "Bob Jones", { sf: SF_VIEW })] }));
    assert.equal(same.difference.same, true);
    assert.match(same.verdict, /They have the same access\./);
    const none = explain(facts({ users: [user(ID.alice, "Alice Smith", { sf: SF_EDIT }), user(ID.bob, "Bob Jones", { sf: SF_NONE })] }));
    assert.deepEqual(none.difference.items, []);
    assert.match(none.difference.unexplained, /We found no route that gives Alice Smith more access/);
    const one = explain(facts({ users: [user(ID.alice, "Alice Smith", { sf: SF_NONE })] }));
    assert.equal(one.difference, null);
    const twins = explain(facts({ users: [user(ID.alice, "Sam Lee", { sf: SF_NONE }), user(ID.bob, "Sam Lee", { sf: SF_NONE })] }));
    assert.notEqual(twins.users[0].name, twins.users[1].name);
  });

  await test("record access: shares to groups that include managers are noted, not guessed", () => {
    const f = facts({
      shares: { available: true, rows: [{ who: ID.gBosses, level: "Read", cause: "Manual" }] },
      groups: [grp(ID.gBosses, "Regular", "Field Teams", null, true)],
      users: [user(ID.alice, "Alice Smith", { sf: SF_VIEW })],
    });
    const res = explain(f);
    assert.deepEqual(res.users[0].routes, []);
    assert.ok(res.notes.some((n) => /Field Teams.*managers of its members.*not checked/.test(n)));
    assert.equal(res.users[0].mismatch.kind, "noRouteFound");
  });

  await test("record access: plain text for a ticket", () => {
    const f = facts({
      shares: { available: true, rows: [{ who: ID.maria, level: "All", cause: "Owner" }, { who: ID.gEmea, level: "Read", cause: "Rule" }] },
      groups: [grp(ID.gEmea, "Regular", "EMEA Sales")],
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_VIEW, memberOf: [{ groupId: ID.gEmea, memberId: ID.alice }] }),
        user(ID.bob, "Bob Jones", { sf: SF_NONE }),
      ],
    });
    const text = toPlainText(explain(f));
    assert.match(text, /^Why can a user see this record\?\nRecord: Account "Contoso \(sample\)", owner: Maria Keller\nDefault access: Accounts are Private/);
    assert.match(text, /Alice Smith can view this record\. Bob Jones can't see this record\./);
    assert.match(text, /Route 1 \(gives view access\):\n {4}Shared by a sharing rule with public group 'EMEA Sales' -> Alice Smith is a direct member of public group 'EMEA Sales'/);
    assert.match(text, /Bob Jones can't see this record\n {2}No route found/);
    assert.match(text, /Why the difference\n.*\n(?: {2}.*\n)* {2}- Shared by a sharing rule/);
    assert.match(text, /Missing: Bob Jones is not in public group 'EMEA Sales'/);
    assert.match(text, /What would change it: Adding Bob Jones to public group 'EMEA Sales' would change it\./);
    assert.match(text, /\nNotes\n {2}- /);
    assert.ok(!/undefined|\[object/.test(text));
  });

  await test("record access: small helpers", () => {
    assert.equal(sfLevel(null), null);
    assert.equal(sfLevel(SF_NONE), "none");
    assert.equal(sfLevel(SF_VIEW), "view");
    assert.equal(sfLevel(SF_EDIT), "edit");
    assert.equal(sfLevel(SF_ALL), "full");
    assert.deepEqual(["Read", "Edit", "All", "None", "x"].map(shareLevel), ["view", "edit", "full", null, null]);
  });

  // ---------- fixes from independent testing ----------

  const NO_PERMS = { sets: [PROFILE({ read: false, create: false, edit: false })] };

  await test("record access: Task and Event have no object permissions, so a missing row is not 'no Read'", () => {
    const f = facts({
      object: { api: "Task", label: "Task", plural: "Tasks", custom: false, grantByHierarchy: null, permissionsApply: false },
      record: { ...facts().record, object: "Task" },
      shares: { available: false, rows: [] },
      users: [user(ID.maria, "Maria Keller", { sf: SF_VIEW, object: NO_PERMS }), user(ID.bob, "Bob Jones", { sf: SF_NONE, object: NO_PERMS })],
    });
    const res = explain(f);
    assert.equal(res.users[0].gate, false);
    assert.equal(res.users[0].gateText, null);
    assert.deepEqual(kinds(res.users[0]), ["owner"]);
    assert.equal(res.users[1].gateText, null);
    assert.ok(!/no Read access/.test(JSON.stringify(res)), "never says 'no Read' for Tasks");
    assert.ok(res.notes.some((n) => /no object permissions for tasks/.test(n)));
    // safety net: even where permissions apply, a user Salesforce says can see it never gets 'no Read'
    const g = facts({ users: [user(ID.maria, "Maria Keller", { sf: SF_VIEW, object: NO_PERMS })] });
    const r2 = explain(g);
    assert.equal(r2.users[0].gate, false);
    assert.equal(r2.users[0].gateText, null);
    assert.deepEqual(kinds(r2.users[0]), ["owner"]);
    assert.ok(r2.notes.some((n) => /yet Salesforce says Maria Keller can see this record/.test(n)));
    assert.ok(!/no Read access to Accounts at all/.test(toPlainText(r2)));
  });

  await test("record access: all access through sharing but only view allowed gives a headline that agrees with the card", () => {
    const f = facts({
      owd: { internal: "Read", external: "Read" },
      users: [
        user(ID.alice, "Alice Smith", { sf: { read: true, edit: false, delete: false, transfer: false, all: true, max: "All" }, roleId: ID.top, roleName: "Sales Director", object: { sets: [PROFILE({ edit: false })] } }),
        user(ID.bob, "Bob Jones", { sf: SF_VIEW }),
      ],
    });
    const res = explain(f);
    const a = res.users[0];
    assert.equal(a.sfLevel, "view");
    assert.ok(!/Alice Smith has full access/.test(res.verdict), res.verdict);
    assert.match(res.verdict, /Alice Smith can view this record\./);
    assert.match(res.verdict, /Sharing gives Alice Smith full access to this record, but Alice Smith's object permissions on Accounts only allow viewing, so Alice Smith can only view it\./);
    assert.equal(a.mismatch, null);
    // the second user has less from sharing: the difference lists what Bob lacks even though both can only view
    const d = res.difference;
    assert.equal(d.same, false);
    assert.equal(d.more, "Alice Smith");
    assert.match(d.text, /can both view this record, but sharing gives Alice Smith more/);
    assert.ok(d.items.some((i) => /Role above the owner's role/.test(i.route)), JSON.stringify(d.items.map((i) => i.route)));
    assert.match(d.levelNote, /Alice Smith's routes give up to view access/);
  });

  await test("record access: the difference lists every route the other user lacks, even when both have routes", () => {
    const f = facts({
      owd: { internal: "Read", external: "Read" },
      shares: { available: true, rows: [{ who: ID.maria, level: "All", cause: "Owner" }, { who: ID.gEmea, level: "Read", cause: "Rule" }] },
      groups: [grp(ID.gEmea, "Regular", "EMEA Sales")],
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_ALL, roleId: ID.top, roleName: "Sales Director", memberOf: [{ groupId: ID.gEmea, memberId: ID.alice }] }),
        user(ID.bob, "Bob Jones", { sf: SF_VIEW, roleId: ID.other, roleName: "France Rep", memberOf: [{ groupId: ID.gEmea, memberId: ID.bob }] }),
      ],
    });
    const res = explain(f);
    assert.ok(res.users[1].routes.length >= 2, "both have routes");
    const d = res.difference;
    assert.equal(d.unexplained, null);
    const routes = d.items.map((i) => i.route);
    assert.ok(routes.includes("Role above the owner's role"), routes.join(" | "));
    assert.ok(d.items.find((i) => i.route === "Role above the owner's role").missing[0].includes("France Rep"));
    assert.match(d.levelNote, /Alice Smith's routes give up to edit access; Bob Jones's give only view access\./);
    assert.ok(!routes.some((r) => /EMEA Sales/.test(r)), "a route both have is not listed");
    assert.match(toPlainText(res), /Alice Smith's routes give up to edit access/);
  });

  await test("record access: a territory route takes its level from the territory share rows; unknown levels are said plainly", () => {
    const territories = { on: true, items: [{ id: ID.t1, parentId: null, name: "EMEA" }, { id: ID.t2, parentId: ID.t1, name: "UK" }], record: [{ id: ID.t2, cause: "Territory2AssignmentRule" }] };
    const groups = [grp(ID.gTerr, "Territory", "", ID.t2), grp(ID.gTerrSub, "TerritoryAndSubordinates", "", ID.t2)];
    const rows = [{ who: ID.gTerr, level: "Edit", cause: "TerritoryRule" }, { who: ID.gTerrSub, level: "Edit", cause: "TerritoryRule" }];
    const f = facts({ territories, groups, shares: { available: true, rows }, users: [user(ID.alice, "Alice Smith", { sf: SF_EDIT, territoryIds: [ID.t1] })] });
    const r = only(explain(f)).routes.find((x) => x.key.startsWith("territory:"));
    assert.ok(r, "the user above the record's territory gets a territory route");
    assert.equal(r.access, "edit");
    assert.equal(only(explain(f)).mismatch, null);
    const none = facts({ territories, groups, shares: { available: true, rows: [] }, users: [user(ID.alice, "Alice Smith", { sf: SF_EDIT, territoryIds: [ID.t1] })] });
    const text = toPlainText(explain(none));
    assert.ok(!/Access level not read|access level not read/.test(text));
    assert.match(text, /how much access it gives is not known/);
    assert.ok(!/Access level not read/.test(readFileSync(ext("record-access.js"), "utf-8")));
  });

  await test("record access: an inactive user is said to be inactive, with no answer from Salesforce", () => {
    const f = facts({ users: [user(ID.maria, "Maria Keller", { sf: null, isActive: false }), user(ID.bob, "Bob Jones", { sf: SF_VIEW })] });
    const res = explain(f);
    const m = res.users[0];
    assert.equal(m.inactive, true);
    assert.match(m.inactiveText, /^Maria Keller is inactive\. Salesforce gives no answer for an inactive user, and an inactive user can't log in\./);
    assert.match(res.verdict, /Maria Keller is inactive\. Salesforce gives no answer for inactive users, and they can't log in\./);
    assert.equal(m.mismatch, null);
    assert.match(res.difference.text, /Maria Keller is inactive/);
    const text = toPlainText(res);
    assert.match(text, /Maria Keller \(inactive, no answer from Salesforce\)\n {2}Maria Keller is inactive/);
    assert.match(text, /would give full access/);
    assert.equal(explain(facts({ users: [user(ID.maria, "Maria Keller", { sf: null })] })).users[0].inactive, false);
  });

  /** An in-memory org for the member walk: GroupMember, Group, User and UserTerritory2Association. */
  function memberOrg(tables) {
    const inList = (q) => [...(q.match(/IN \(([^)]*)\)/)?.[1] || "").matchAll(/'([^']*)'/g)].map((m) => m[1]);
    const queries = [];
    return {
      queries,
      query: async (q) => {
        queries.push(q);
        const ids = inList(q);
        if (/FROM GroupMember/.test(q)) return { records: tables.members.filter((m) => ids.includes(m.GroupId)) };
        if (/FROM Group /.test(q)) return { records: tables.groups.filter((g) => ids.includes(g.Id)) };
        if (/FROM UserTerritory2Association/.test(q)) return { records: tables.terr.filter((t) => ids.includes(t.Territory2Id)) };
        if (/FROM User WHERE UserRoleId IN/.test(q)) return { records: tables.users.filter((u) => ids.includes(u.UserRoleId)) };
        if (/FROM User WHERE Id IN/.test(q)) return { records: tables.users.filter((u) => ids.includes(u.Id)) };
        throw new Error(`unexpected ${q}`);
      },
    };
  }
  const U5 = (n) => `005000000000${String(n).padStart(3, "0")}AAA`;

  await test("record access: managers through a group that includes bosses (nested, role groups, a loop)", async () => {
    const tables = {
      members: [
        { GroupId: ID.gBosses, UserOrGroupId: ID.gUk }, // nested public group
        { GroupId: ID.gUk, UserOrGroupId: ID.gBosses }, // loop
        { GroupId: ID.gUk, UserOrGroupId: ID.gRole }, // role-and-subordinates group inside it
        { GroupId: ID.gUk, UserOrGroupId: U5(10) }, // a direct member (UK Rep)
      ],
      groups: [{ Id: ID.gUk, Type: "Regular", RelatedId: null }, { Id: ID.gRole, Type: "RoleAndSubordinates", RelatedId: ID.mid }, { Id: ID.gBosses, Type: "Regular", RelatedId: null }],
      users: [
        { Id: U5(10), Name: "Una Member", UserRoleId: ID.low },
        { Id: U5(11), Name: "Max Mid", UserRoleId: ID.mid },
        { Id: U5(12), Name: "Lou Low", UserRoleId: ID.low },
      ],
      terr: [],
    };
    const api = memberOrg(tables);
    const roleParent = new Map([[ID.top, null], [ID.mid, ID.top], [ID.low, ID.mid], [ID.other, ID.top]]);
    const found = await readMemberRoles(api, [ID.gBosses], roleParent, new Map());
    const m = found[ID.gBosses];
    assert.equal(m.capped, false);
    const byRole = Object.fromEntries(m.roles.map((r) => [r.roleId, r]));
    assert.deepEqual(Object.keys(byRole).sort(), [ID.low, ID.mid].sort());
    assert.equal(byRole[ID.mid].count, 1);
    assert.equal(byRole[ID.low].count, 2); // Una (direct) and Lou (below the role group's role)
    assert.ok(api.queries.every((q) => /^SELECT /.test(q)));
    // and the explanation
    const rows = [{ who: ID.gBosses, level: "Edit", cause: "Rule" }];
    const f = facts({
      shares: { available: true, rows },
      groups: [grp(ID.gBosses, "Regular", "Field Teams", null, true)],
      memberRoles: found,
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_EDIT, roleId: ID.top, roleName: "Sales Director" }),
        user(ID.bob, "Bob Jones", { sf: SF_NONE, roleId: ID.other, roleName: "France Rep" }),
      ],
    });
    const res = explain(f);
    const r = res.users[0].routes.find((x) => x.key.startsWith("shareBossGroup:"));
    assert.ok(r, JSON.stringify(res.users[0].routes.map((x) => x.key)));
    assert.equal(r.access, "edit");
    assert.equal(r.steps[0], "Shared by a sharing rule with public group 'Field Teams', which also gives access to managers");
    assert.match(r.steps[1], /^Member '.+' \(role 'UK Manager'\) is in that group, directly or through other groups; 2 other members have a role below this user's too$/);
    assert.equal(r.steps[2], "Alice Smith's role 'Sales Director' is above 'UK Manager' in the role hierarchy");
    assert.equal(res.users[0].mismatch, null);
    assert.deepEqual(kinds(res.users[1]), []); // France Rep is not above any member
    assert.match(res.difference.items.find((i) => /Field Teams/.test(i.route)).missing[0], /Bob Jones is not in public group 'Field Teams' and has no role above the role of one of its members\./);
    assert.ok(!res.notes.some((n) => /not checked for Alice/.test(n)));
  });

  await test("record access: member walk stops at its cap and says so; territory groups give members too", async () => {
    const tables = {
      members: [{ GroupId: ID.gBosses, UserOrGroupId: ID.gTerr }],
      groups: [{ Id: ID.gTerr, Type: "TerritoryAndSubordinates", RelatedId: ID.t1 }],
      users: [{ Id: U5(20), Name: "Tia Terr", UserRoleId: ID.low }],
      terr: [{ Territory2Id: ID.t2, UserId: U5(20) }],
    };
    const found = await readMemberRoles(memberOrg(tables), [ID.gBosses], new Map(), new Map([[ID.t1, null], [ID.t2, ID.t1]]));
    assert.deepEqual(found[ID.gBosses].roles.map((r) => r.roleId), [ID.low]);
    // a chain of 40 groups inside groups is cut at the depth limit
    const chainG = Array.from({ length: 40 }, (_, i) => `00G0000000${String(i).padStart(5, "0")}AAA`);
    const deep = { members: chainG.slice(0, -1).map((g, i) => ({ GroupId: g, UserOrGroupId: chainG[i + 1] })), groups: chainG.map((g) => ({ Id: g, Type: "Regular", RelatedId: null })), users: [], terr: [] };
    const cut = await readMemberRoles(memberOrg(deep), [chainG[0]], new Map(), new Map());
    assert.equal(cut[chainG[0]].capped, true);
    // the explanation says a cut walk may have missed a manager route
    const f = facts({
      shares: { available: true, rows: [{ who: ID.gBosses, level: "Read", cause: "Rule" }] },
      groups: [grp(ID.gBosses, "Regular", "Field Teams", null, true)],
      memberRoles: { [ID.gBosses]: { roles: [], users: 0, capped: true } },
      users: [user(ID.alice, "Alice Smith", { sf: SF_VIEW, roleId: ID.top, roleName: "Sales Director" })],
    });
    assert.ok(explain(f).notes.some((n) => /many members, so only some were checked for Alice Smith/.test(n)));
  });

  await test("record access: role hierarchy over a queue owner uses the roles of the queue's members", async () => {
    const rec = { ...facts().record, ownerId: ID.gQueue, ownerKind: "queue", ownerName: "Support Queue", ownerRoleId: null };
    const tables = { members: [{ GroupId: ID.gQueue, UserOrGroupId: U5(30) }, { GroupId: ID.gQueue, UserOrGroupId: ID.gEmea }, { GroupId: ID.gEmea, UserOrGroupId: ID.gQueue }], groups: [{ Id: ID.gEmea, Type: "Regular", RelatedId: null }], users: [{ Id: U5(30), Name: "Quinn Queue", UserRoleId: ID.low }], terr: [] };
    const roleParent = new Map([[ID.top, null], [ID.mid, ID.top], [ID.low, ID.mid]]);
    const found = await readMemberRoles(memberOrg(tables), [ID.gQueue], roleParent, new Map());
    const f = facts({
      record: rec, groups: [grp(ID.gQueue, "Queue", "Support Queue")], memberRoles: found,
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_ALL, roleId: ID.top, roleName: "Sales Director" }),
        user(ID.bob, "Bob Jones", { sf: SF_NONE, roleId: ID.other, roleName: "France Rep" }),
      ],
    });
    const res = explain(f);
    const r = res.users[0].routes.find((x) => x.key === "ownerQueueBoss");
    assert.ok(r, JSON.stringify(res.users[0].routes.map((x) => x.key)));
    assert.deepEqual(r.steps, [
      "The record is owned by queue 'Support Queue'",
      "Member 'Quinn Queue' (role 'UK Rep') is in queue 'Support Queue', directly or through other groups",
      "Alice Smith's role 'Sales Director' is above 'UK Rep' in the role hierarchy",
    ]);
    assert.equal(res.users[0].mismatch, null);
    assert.deepEqual(kinds(res.users[1]), []);
    assert.match(res.difference.items[0].missing[0], /Bob Jones is not a member of queue 'Support Queue' and has no role above/);
    // a user in the same role as the member is not above it
    const same = facts({ record: rec, groups: [grp(ID.gQueue, "Queue", "Support Queue")], memberRoles: found, users: [user(ID.carl, "Carl Brown", { sf: SF_NONE, roleId: ID.low, roleName: "UK Rep" })] });
    assert.deepEqual(kinds(explain(same).users[0]), []);
  });

  await test("record access: an exact name match is listed first", () => {
    const users = [{ name: "Ann Smithson", username: "a@example.invalid" }, { name: "Ann Smith", username: "b@example.invalid" }, { name: "Joann Smith", username: "c@example.invalid" }];
    assert.deepEqual(exactFirst(users, "ann smith").map((u) => u.name), ["Ann Smith", "Ann Smithson", "Joann Smith"]);
    assert.deepEqual(exactFirst(users, "c@example.invalid").map((u) => u.name)[0], "Joann Smith");
    assert.equal(exactFirst(users, ""), users);
  });

  await test("record access: reading a fake org marks Task-like objects (no object permission rows) as not subject to them", async () => {
    const { api } = fakeOrg();
    const orig = api.query.bind(api);
    api.query = async (q) => (/COUNT\(\) FROM ObjectPermissions/.test(q) ? { records: [], totalSize: 0 } : orig(q));
    api.count = async (q) => (/FROM ObjectPermissions/.test(q) ? 0 : 0);
    const ctx = await readRecordContext(api, ID.rec);
    const facts2 = await readRecordAccess(api, ctx, [{ id: ID.alice, name: "Alice Smith" }]);
    assert.equal(facts2.object.permissionsApply, false);
  });

  // ---------- the demo ----------

  await test("record access: the demo file explains one user through a nested group and the hierarchy, the other not at all", () => {
    const demo = JSON.parse(readFileSync(ext("samples", "record_access_demo.json"), "utf-8"));
    const res = explain(demo);
    assert.match(res.verdict, /^Alice Smith can edit this record\. Bob Jones can't see this record\.$/);
    assert.ok(res.users[0].routes.length >= 2);
    assert.deepEqual(res.users[1].routes, []);
    assert.equal(res.users[0].mismatch, null);
    assert.equal(res.users[1].mismatch, null);
    assert.ok(res.difference.items.length >= 2);
    assert.ok(!/@(?!example\.invalid)/.test(JSON.stringify(demo)), "demo usernames must be example.invalid");
  });

  // ---------- reading from the org ----------

  /** A fake org: describe, describeGlobal and a few tables that SELECTs are answered from. */
  function fakeOrg({ failOn = [] } = {}) {
    const log = [];
    const inList = (q) => [...(q.match(/IN \(([^)]*)\)/)?.[1] || "").matchAll(/'([^']*)'/g)].map((m) => m[1]);
    const groupsTable = [
      { Id: ID.gEmea, Name: "EMEA Sales", DeveloperName: "EMEA_Sales", Type: "Regular", RelatedId: null, DoesIncludeBosses: false },
      { Id: ID.gUk, Name: "UK Sales", DeveloperName: "UK_Sales", Type: "Regular", RelatedId: null, DoesIncludeBosses: false },
      { Id: ID.gRole, Name: "", DeveloperName: "UKMgr", Type: "RoleAndSubordinates", RelatedId: ID.mid, DoesIncludeBosses: false },
    ];
    const members = [
      { GroupId: ID.gUk, UserOrGroupId: ID.gRole }, { GroupId: ID.gEmea, UserOrGroupId: ID.gUk }, { GroupId: ID.gUk, UserOrGroupId: ID.gEmea },
    ];
    const describes = {
      Account: {
        label: "Account", labelPlural: "Accounts", custom: false,
        fields: [{ name: "Id", type: "id" }, { name: "Name", type: "string", nameField: true }, { name: "OwnerId", type: "reference", referenceTo: ["User"] }],
      },
      AccountShare: { fields: [{ name: "AccountId" }, { name: "AccountAccessLevel" }, { name: "RowCause" }, { name: "UserOrGroupId" }] },
    };
    const route = (q) => {
      if (failOn.some((re) => re.test(q))) return { fail: "INSUFFICIENT_ACCESS", code: "INSUFFICIENT_ACCESS" };
      if (/FROM EntityDefinition/.test(q)) return [{ InternalSharingModel: "Private", ExternalSharingModel: "Private" }];
      if (/FROM Account WHERE Id/.test(q)) return [{ Id: ID.rec, Name: "Contoso (sample)", OwnerId: ID.maria }];
      if (/FROM User WHERE Id = '005000000000003AAA'/.test(q)) return [{ Name: "Maria Keller", UserRoleId: ID.low }];
      if (/FROM User WHERE Id = '005000000000001AAA'/.test(q)) return [{ Id: ID.alice, Name: "Alice Smith", Username: "alice@example.invalid", IsActive: true, UserType: "Standard", Profile: { Name: "Standard User" }, UserRoleId: ID.mid, UserRole: { Name: "UK Manager" } }];
      if (/FROM User WHERE Id IN/.test(q)) return [];
      if (/FROM UserRole/.test(q)) return /COUNT/.test(q) ? { total: 0 } : [
        { Id: ID.top, Name: "Sales Director", DeveloperName: "SD", ParentRoleId: null }, { Id: ID.mid, Name: "UK Manager", DeveloperName: "UKM", ParentRoleId: ID.top },
        { Id: ID.low, Name: "UK Rep", DeveloperName: "UKR", ParentRoleId: ID.mid },
      ];
      if (/FROM Territory2 /.test(q)) return { fail: "sObject type 'Territory2' is not supported.", code: "INVALID_TYPE" };
      if (/FROM AccountShare/.test(q)) return [{ UserOrGroupId: ID.maria, AccountAccessLevel: "All", RowCause: "Owner" }, { UserOrGroupId: ID.gEmea, AccountAccessLevel: "Read", RowCause: "Rule" }];
      if (/FROM Group WHERE RelatedId IN/.test(q)) return groupsTable.filter((g) => inList(q).includes(g.RelatedId) && /RoleAndSubordinates/.test(g.Type));
      if (/FROM Group WHERE Id IN/.test(q)) return groupsTable.filter((g) => inList(q).includes(g.Id));
      if (/FROM GroupMember/.test(q)) return members.filter((m) => inList(q).includes(m.UserOrGroupId));
      if (/FROM UserRecordAccess/.test(q)) return [{ RecordId: ID.rec, HasReadAccess: true, HasEditAccess: true, HasDeleteAccess: false, HasTransferAccess: false, HasAllAccess: false, MaxAccessLevel: "Edit" }];
      if (/FROM PermissionSetAssignment/.test(q)) return [{ PermissionSetId: "0PS000000000001AAA", PermissionSetGroupId: null, PermissionSet: { Label: "X", Type: "Profile", IsOwnedByProfile: true, Profile: { Name: "Standard User" }, PermissionsViewAllData: false, PermissionsModifyAllData: false } }];
      if (/FROM ObjectPermissions/.test(q)) return [{ ParentId: "0PS000000000001AAA", PermissionsRead: true, PermissionsCreate: true, PermissionsEdit: true, PermissionsDelete: false, PermissionsViewAllRecords: false, PermissionsModifyAllRecords: false }];
      if (/FROM AccountTeamMember/.test(q)) return [];
      if (/COUNT\(\)/.test(q)) return { total: 0 };
      return { fail: `no route for ${q}`, code: "TEST" };
    };
    const fetchImpl = async (url, opts = {}) => {
      const u = new URL(url);
      log.push({ method: opts.method || "GET", path: u.pathname, q: u.searchParams.get("q") });
      const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
      if (/\/sobjects\/$/.test(u.pathname)) return ok({ sobjects: [{ name: "Account", keyPrefix: "001", label: "Account", labelPlural: "Accounts" }, { name: "Contact", keyPrefix: "003" }] });
      const m = u.pathname.match(/\/sobjects\/(\w+)\/describe\/$/);
      if (m) return describes[m[1]] ? ok(describes[m[1]]) : { ok: false, status: 404, text: async () => JSON.stringify([{ message: "not found", errorCode: "NOT_FOUND" }]) };
      const r = route(u.searchParams.get("q"));
      if (r.fail) return { ok: false, status: 400, text: async () => JSON.stringify([{ message: r.fail, errorCode: r.code || "TEST" }]) };
      if (r.total !== undefined) return ok({ done: true, totalSize: r.total, records: [] });
      return ok({ done: true, totalSize: r.length, records: r });
    };
    return { api: new SfApi({ apiHost: "test.example.com", sessionId: "sid", fetchImpl }), log };
  }

  await test("record access: reading the record and a user from a fake org, then explaining it", async () => {
    const { api, log } = fakeOrg();
    const ctx = await readRecordContext(api, "001000000000001");
    assert.equal(ctx.record.id, ID.rec); // 15 characters in, 18 used
    assert.equal(ctx.record.name, "Contoso (sample)");
    assert.equal(ctx.record.ownerName, "Maria Keller");
    assert.equal(ctx.owd.internal, "Private");
    assert.equal(ctx.object.plural, "Accounts");
    const facts = await readRecordAccess(api, ctx, [{ id: ID.alice, name: "Alice Smith" }]);
    assert.equal(facts.shares.rows.length, 2);
    assert.equal(facts.users[0].sf.edit, true);
    assert.ok(facts.users[0].memberOf.length >= 3, "groups were read upward, loop included");
    assert.equal(facts.territories.on, false); // territories off: not a problem
    assert.ok(!facts.notes.some((n) => /Territor/.test(n)), facts.notes.join("\n"));
    const res = explain(facts);
    assert.equal(res.verdict, "Alice Smith can edit this record.");
    assert.ok(res.users[0].routes.some((r) => r.steps.join(" ").includes("EMEA Sales") && r.steps.join(" ").includes("UK Manager")));
    assert.equal(res.users[0].mismatch, null);
    // read-only: only GETs, only SELECTs
    assert.ok(log.every((l) => l.method === "GET"));
    for (const l of log.filter((x) => x.q)) assert.match(l.q, /^SELECT /);
    assert.ok(log.some((l) => /FROM UserRecordAccess WHERE UserId = '005000000000001AAA' AND RecordId = '001000000000001AAA'/.test(l.q || "")));
  });

  await test("record access: an area that fails is left out with a plain note, the raw error is kept apart", async () => {
    const { api } = fakeOrg({ failOn: [/FROM AccountShare/, /FROM UserRecordAccess/] });
    const ctx = await readRecordContext(api, ID.rec);
    const facts = await readRecordAccess(api, ctx, [{ id: ID.alice, name: "Alice Smith" }]);
    assert.equal(facts.users[0].sf, null);
    assert.ok(facts.notes.some((n) => /sharing rows could not be read, so it was not checked/.test(n)));
    assert.ok(facts.warnings.some((w) => /INSUFFICIENT_ACCESS/.test(w)));
    const res = explain(facts);
    assert.equal(res.verdict, "Salesforce did not say whether Alice Smith can see this record.");
    assert.ok(!res.notes.some((n) => /INSUFFICIENT_ACCESS/.test(n)), "raw errors stay out of the notes");
  });

  await test("record access: a record that cannot be read gives a plain message", async () => {
    await assert.rejects(readRecordContext(fakeOrg().api, "not an id"), /does not look like a record Id/);
    await assert.rejects(readRecordContext(fakeOrg().api, "a1B000000000001AAA"), /does not know what kind of record/);
    const { api } = fakeOrg();
    api.query = async (q) => (/FROM Account WHERE Id/.test(q) ? { records: [] } : { records: [{ InternalSharingModel: "Private" }] });
    await assert.rejects(readRecordContext(api, ID.rec), /no such record, or your own user cannot see it/);
  });

  await test("record access: a user is read back by Id (parent page keeps the two users); bad Ids are refused", async () => {
    const queries = [];
    const api = { query: async (q) => { queries.push(q); return { records: [{ Id: ID.bob, Name: "Bob Jones", Username: "bob@example.invalid", IsActive: true, Profile: { Name: "Standard User" } }] }; } };
    const u = await readUserById(api, ID.bob);
    assert.deepEqual(u, { id: ID.bob, name: "Bob Jones", username: "bob@example.invalid", isActive: true, profile: "Standard User" });
    assert.match(queries[0], /^SELECT .* FROM User WHERE Id = '005000000000002AAA' LIMIT 1$/);
    assert.equal(await readUserById(api, "x' OR Name != '"), null);
    assert.equal(queries.length, 1);
    const page = readFileSync(ext("record-access.js"), "utf-8");
    assert.match(page, /p\.set\(side, u\.id\)/);
    assert.match(page, /params\.get\(side\)/);
  });

  // ---------- guards ----------

  // ---------- access through the account (Cases and Opportunities) ----------

  /** A Case or Opportunity whose account is "Contoso (sample)": the account's own sharing is in `account`. */
  function acctFacts(object, { rows = [], owner = null, users = [], territories, groups = [], shareUsers = [], memberRoles } = {}) {
    const plural = object === "Case" ? "Cases" : "Opportunities";
    return facts({
      record: { id: "500000000000001AAA", object, name: "Sample record", ownerId: ID.carl, ownerKind: "user", ownerName: "Carl Brown", ownerRoleId: ID.other, accountId: ID.rec, accountName: "Contoso (sample)", parentId: null, parentObjectLabel: "", parentName: "" },
      object: { api: object, label: object, plural, custom: false, grantByHierarchy: null },
      shares: { available: true, truncated: false, rows: [{ who: ID.carl, level: "All", cause: "Owner" }] },
      account: { id: ID.rec, name: "Contoso (sample)", rows, owner, truncated: false },
      ...(territories ? { territories } : {}), groups, shareUsers, ...(memberRoles ? { memberRoles } : {}), users,
    });
  }
  const chainText = (r) => r.steps.join(" -> ");

  await test("record access: a case is reached through an account sharing rule with a group that contains the user's group", () => {
    const f = acctFacts("Case", {
      rows: [{ who: ID.gEmea, level: "Read", cause: "Rule" }, { who: ID.gUk, level: "None", cause: "Manual" }],
      groups: [grp(ID.gEmea, "Regular", "EMEA Sales"), grp(ID.gUk, "Regular", "UK Sales")],
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_VIEW, memberOf: [{ groupId: ID.gUk, memberId: ID.alice }, { groupId: ID.gEmea, memberId: ID.gUk }] }),
        user(ID.bob, "Bob Jones", { sf: SF_NONE }),
      ],
    });
    const res = explain(f);
    const a = res.users[0];
    assert.equal(a.routes.length, 1);
    assert.equal(a.routes[0].access, "view");
    assert.equal(a.routes[0].steps[0], "The case belongs to account 'Contoso (sample)'");
    assert.equal(a.routes[0].steps[1], "The account is shared by a sharing rule with public group 'EMEA Sales', which gives view access to the account's cases");
    assert.match(chainText(a.routes[0]), /Public group 'EMEA Sales' includes public group 'UK Sales' -> Alice Smith is a direct member of public group 'UK Sales'/);
    assert.equal(a.mismatch, null, "a user who sees a case only through its account is explained, not flagged");
    assert.deepEqual(res.users[1].routes, []);
    assert.equal(res.users[1].mismatch, null);
    // the difference names the account route and what would change it
    assert.equal(res.difference.items.length, 1);
    assert.match(res.difference.items[0].route, /^The account is shared by a sharing rule with public group 'EMEA Sales'/);
    assert.equal(res.difference.items[0].missing[0], "Bob Jones is not in public group 'EMEA Sales', directly or through another group.");
    assert.match(res.difference.items[0].change[0], /Adding Bob Jones to public group 'EMEA Sales'/);
    assert.ok(!/AccountShare|CaseAccessLevel/.test(JSON.stringify(res)), "plain words only");
    assert.ok(res.notes.some((n) => /Access through the account is checked for cases/.test(n)));
  });

  await test("record access: an opportunity is reached through the account's territory, and says which territory", () => {
    const f = acctFacts("Opportunity", {
      rows: [{ who: ID.gTerr, level: "Edit", cause: "Territory" }, { who: ID.gTerrSub, level: "Read", cause: "Territory2AssociationManual" }],
      groups: [grp(ID.gTerr, "Territory", "", ID.t1), grp(ID.gTerrSub, "TerritoryAndSubordinates", "", ID.t2)],
      territories: { on: true, items: [{ id: ID.t1, parentId: null, name: "EMEA" }, { id: ID.t2, parentId: ID.t1, name: "UK" }], record: [] },
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_EDIT, territoryIds: [ID.t1] }),
        user(ID.bob, "Bob Jones", { sf: SF_NONE }),
      ],
    });
    const res = explain(f);
    const a = res.users[0];
    const edit = a.routes.find((r) => r.access === "edit");
    assert.ok(edit);
    assert.equal(edit.steps[0], "The opportunity belongs to account 'Contoso (sample)'");
    assert.equal(edit.steps[1], "The account is shared through territory assignment with territory 'EMEA', which gives edit access to the account's opportunities");
    assert.equal(edit.steps[2], "Alice Smith is assigned to territory 'EMEA'");
    assert.equal(a.mismatch, null);
    // Alice is in EMEA, which is above UK: the "and below" row does not reach her
    assert.equal(a.routes.length, 1);
    assert.equal(res.difference.items[0].missing[0], "Bob Jones is not assigned to territory 'EMEA'.");
    // a second user assigned to the territory is never told they lack it
    const g = acctFacts("Opportunity", {
      rows: f.account.rows, groups: f.groups, territories: f.territories,
      users: [user(ID.alice, "Alice Smith", { sf: SF_EDIT, territoryIds: [ID.t1] }), user(ID.bob, "Bob Jones", { sf: SF_VIEW, territoryIds: [ID.t1] })],
    });
    const d = explain(g).difference;
    for (const it of d.items) assert.ok(!/not assigned to territory 'EMEA'/.test(it.missing.join(" ")), JSON.stringify(it));
  });

  await test("record access: an account team member with case access None gets no route, with Read gets one", () => {
    const f = acctFacts("Case", {
      rows: [{ who: ID.alice, level: "None", cause: "Team" }, { who: ID.bob, level: "Read", cause: "Team" }],
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_NONE, accountTeamRole: "Support" }),
        user(ID.bob, "Bob Jones", { sf: SF_VIEW, accountTeamRole: "Sales Rep" }),
      ],
    });
    const res = explain(f);
    assert.deepEqual(res.users[0].routes, []);
    assert.equal(res.users[0].mismatch, null, "no route and no access: nothing to flag");
    assert.equal(res.users[1].routes.length, 1);
    assert.equal(res.users[1].routes[0].steps[1], "Bob Jones is on the account team as 'Sales Rep', which gives view access to the account's cases");
    assert.equal(res.users[1].mismatch, null);
    // Alice sits on the account team (case level None): the difference must not say anything false about her
    assert.equal(res.difference.items.length, 1);
    assert.equal(res.difference.items[0].missing[0], "Alice Smith is not on the account team with access to its cases.");
    assert.ok(!/is not on the account team\.$/.test(res.difference.items[0].missing[0]));
  });

  await test("record access: the account owner's role setting gives the owner and the roles above them access to the account's cases", () => {
    const owner = { id: ID.maria, name: "Maria Keller", roleId: ID.low, level: "Read" };
    const f = acctFacts("Case", {
      owner,
      users: [
        user(ID.maria, "Maria Keller", { sf: SF_VIEW, roleId: ID.low, roleName: "UK Rep" }),
        user(ID.alice, "Alice Smith", { sf: SF_VIEW, roleId: ID.mid, roleName: "UK Manager" }),
        user(ID.bob, "Bob Jones", { sf: SF_NONE, roleId: ID.other, roleName: "France Rep" }),
      ],
    });
    const res = explain(f, [ID.maria, ID.alice]);
    const m = res.users[0].routes[0];
    assert.equal(m.kind, "owner");
    assert.deepEqual(m.steps, ["The case belongs to account 'Contoso (sample)'", "Maria Keller owns the account", "Maria Keller's role 'UK Rep' gives account owners view access to the account's cases"]);
    const al = res.users[1].routes[0];
    assert.equal(al.kind, "hierarchy");
    assert.match(chainText(al), /The account is owned by Maria Keller -> .*gives account owners view access to the account's cases -> Alice Smith's role 'UK Manager' is above 'UK Rep' in the role hierarchy/);
    assert.equal(res.users[1].mismatch, null);
    // Bob has no role above the owner's
    assert.deepEqual(explain(f, [ID.bob]).users[0].routes, []);
    // the level None (the usual setting) gives nothing
    const none = acctFacts("Case", { owner: { ...owner, level: "None" }, users: [user(ID.maria, "Maria Keller", { sf: SF_NONE, roleId: ID.low })] });
    assert.deepEqual(explain(none).users[0].routes, []);
    // the difference: Alice is above the owner; Bob is not, and Alice is not asked to own the account
    const d = explain(f, [ID.alice, ID.bob]).difference;
    assert.match(d.items[0].missing[0], /Bob Jones's role 'France Rep' is not above the account owner's role 'UK Rep'/);
    const own = explain(f, [ID.maria, ID.bob]).difference;
    assert.match(own.items[0].missing[0], /Bob Jones does not own the account \(it is owned by Maria Keller\)/);
    // the owner's boss route is not listed as missing for the owner, whose own route covers it
    const back = explain(f, [ID.alice, ID.maria]).difference;
    for (const it of back.items || []) assert.ok(!/not above the account owner/.test(it.missing.join(" ")));
  });

  await test("record access: account access with case level None gives no route and no false missing line", () => {
    const f = acctFacts("Case", {
      rows: [{ who: ID.bob, level: "None", cause: "Manual" }, { who: ID.alice, level: "Read", cause: "Manual" }],
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_VIEW }),
        user(ID.bob, "Bob Jones", { sf: SF_NONE }),
      ],
    });
    const res = explain(f);
    assert.deepEqual(res.users[1].routes, []);
    assert.equal(res.users[1].mismatch, null);
    assert.equal(res.users[0].routes.length, 1);
    const line = res.difference.items[0].missing[0];
    assert.equal(line, "The account is not shared with Bob Jones in a way that gives access to its cases.");
    assert.ok(!/not shared at all|has no access to the account/.test(line));
    // The level None row never becomes an "unknown level" route.
    assert.ok(res.users[1].routes.every((r) => r.access !== null));
  });

  await test("record access: account routes join topic matching, so a route both users have is not listed, and a lower level is", () => {
    const f = acctFacts("Opportunity", {
      rows: [{ who: ID.gEmea, level: "Edit", cause: "Rule" }],
      groups: [grp(ID.gEmea, "Regular", "EMEA Sales")],
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_EDIT, memberOf: [{ groupId: ID.gEmea, memberId: ID.alice }] }),
        user(ID.bob, "Bob Jones", { sf: SF_VIEW, memberOf: [{ groupId: ID.gEmea, memberId: ID.bob }], object: { sets: [PROFILE({ edit: false })] } }),
      ],
    });
    const res = explain(f);
    assert.equal(res.users[1].routes[0].limited, true);
    assert.match(res.difference.items[0].missing[0], /Bob Jones has this route too, but Bob Jones's object permissions limit it to view access/);
    // the object-permission cap applies: Bob has Read only
    assert.equal(res.users[1].routes[0].effective, "view");
    // a user who is in the group through the role is never called "not in" it
    const g = acctFacts("Opportunity", {
      rows: [{ who: ID.gRole, level: "Read", cause: "Rule" }, { who: ID.gEmea, level: "Edit", cause: "Rule" }],
      groups: [grp(ID.gEmea, "Regular", "EMEA Sales"), grp(ID.gRole, "RoleAndSubordinates", "", ID.mid)],
      users: [
        user(ID.alice, "Alice Smith", { sf: SF_EDIT, memberOf: [{ groupId: ID.gEmea, memberId: ID.alice }] }),
        user(ID.bob, "Bob Jones", { sf: SF_VIEW, roleId: ID.low, roleName: "UK Rep", memberOf: [{ groupId: ID.gEmea, memberId: ID.gRole }] }),
      ],
    });
    const d = explain(g).difference;
    for (const it of d.items) assert.ok(!/EMEA Sales/.test(it.missing.join(" ")), `false missing line: ${JSON.stringify(it)}`);
  });

  await test("record access: a group on the account that also reaches managers gives the boss a route, in one sentence", () => {
    const f = acctFacts("Case", {
      rows: [{ who: ID.gBosses, level: "Edit", cause: "Rule" }],
      groups: [grp(ID.gBosses, "Regular", "Field Reps", null, true)],
      memberRoles: { [ID.gBosses]: { roles: [{ roleId: ID.low, example: "Maria Keller", count: 1 }], users: 1, capped: false } },
      users: [user(ID.alice, "Alice Smith", { sf: SF_EDIT, roleId: ID.mid, roleName: "UK Manager" }), user(ID.bob, "Bob Jones", { sf: SF_NONE, roleId: ID.other, roleName: "France Rep" })],
    });
    const res = explain(f);
    assert.equal(res.users[0].routes[0].steps[1], "The account is shared by a sharing rule with public group 'Field Reps', which gives edit access to the account's cases, and it also gives access to managers");
    assert.match(res.users[0].routes[0].steps[3], /Alice Smith's role 'UK Manager' is above 'UK Rep'/);
    assert.equal(res.users[0].mismatch, null);
    assert.match(res.difference.items[0].missing[0], /Bob Jones is not in public group 'Field Reps' and has no role above the role of one of its members/);
  });

  await test("record access: a case with no account has no account route and no account note", () => {
    const f = acctFacts("Case", { users: [user(ID.alice, "Alice Smith", { sf: SF_NONE })] });
    delete f.account;
    const res = explain(f);
    assert.deepEqual(res.users[0].routes, []);
    assert.ok(!res.notes.some((n) => /through the account/.test(n)));
  });

  await test("record access: reading a case reads its account's sharing with one extra share query, and nothing is written", async () => {
    const log = [];
    const inList = (q) => [...(q.match(/IN \(([^)]*)\)/)?.[1] || "").matchAll(/'([^']*)'/g)].map((m) => m[1]);
    const route = (q) => {
      if (/FROM EntityDefinition/.test(q)) return [{ InternalSharingModel: "Private", ExternalSharingModel: "Private" }];
      if (/FROM Case WHERE Id/.test(q)) return [{ Id: "500000000000001AAA", CaseNumber: "0001", OwnerId: ID.carl, AccountId: ID.rec }];
      if (/SELECT Name FROM Account/.test(q)) return [{ Name: "Contoso (sample)" }];
      if (/SELECT OwnerId, Owner.Name, Owner.UserRoleId FROM Account/.test(q)) return [{ OwnerId: ID.maria, Owner: { Name: "Maria Keller", UserRoleId: ID.low } }];
      if (/SELECT CaseAccessForAccountOwner FROM UserRole/.test(q)) return [{ CaseAccessForAccountOwner: "None" }];
      if (/FROM User WHERE Id = '005000000000004AAA'/.test(q)) return [{ Name: "Carl Brown", UserRoleId: ID.other }];
      if (/FROM User WHERE Id = '005000000000001AAA'/.test(q)) return [{ Id: ID.alice, Name: "Alice Smith", Username: "alice@example.invalid", IsActive: true, UserType: "Standard", Profile: { Name: "Standard User" }, UserRoleId: ID.mid, UserRole: { Name: "UK Manager" } }];
      if (/FROM User WHERE Id IN/.test(q)) return [];
      if (/FROM UserRole/.test(q)) return [{ Id: ID.top, Name: "Sales Director", DeveloperName: "SD", ParentRoleId: null }, { Id: ID.mid, Name: "UK Manager", DeveloperName: "UKM", ParentRoleId: ID.top }, { Id: ID.low, Name: "UK Rep", DeveloperName: "UKR", ParentRoleId: ID.mid }, { Id: ID.other, Name: "France Rep", DeveloperName: "FR", ParentRoleId: ID.top }];
      if (/FROM Territory2 /.test(q)) return { fail: "sObject type 'Territory2' is not supported.", code: "INVALID_TYPE" };
      if (/FROM CaseShare/.test(q)) return [{ UserOrGroupId: ID.carl, CaseAccessLevel: "All", RowCause: "Owner" }];
      if (/FROM AccountShare/.test(q)) return [
        { UserOrGroupId: ID.maria, RowCause: "Owner", CaseAccessLevel: "None" },
        { UserOrGroupId: ID.gEmea, RowCause: "Rule", CaseAccessLevel: "Read" },
        { UserOrGroupId: ID.gUk, RowCause: "ImplicitParent", CaseAccessLevel: "None" },
      ];
      if (/FROM Group WHERE RelatedId IN/.test(q)) return [];
      if (/FROM Group WHERE Id IN/.test(q)) return [{ Id: ID.gEmea, Name: "EMEA Sales", DeveloperName: "EMEA", Type: "Regular", RelatedId: null, DoesIncludeBosses: false }].filter((g) => inList(q).includes(g.Id));
      if (/FROM GroupMember/.test(q)) return inList(q).includes(ID.alice) ? [{ GroupId: ID.gEmea, UserOrGroupId: ID.alice }] : [];
      if (/FROM UserRecordAccess/.test(q)) return [{ RecordId: "500000000000001AAA", HasReadAccess: true, HasEditAccess: false, HasDeleteAccess: false, HasTransferAccess: false, HasAllAccess: false, MaxAccessLevel: "Read" }];
      if (/FROM PermissionSetAssignment/.test(q)) return [{ PermissionSetId: "0PS000000000001AAA", PermissionSetGroupId: null, PermissionSet: { Label: "X", Type: "Profile", IsOwnedByProfile: true, Profile: { Name: "Standard User" }, PermissionsViewAllData: false, PermissionsModifyAllData: false } }];
      if (/FROM ObjectPermissions/.test(q)) return [{ ParentId: "0PS000000000001AAA", PermissionsRead: true, PermissionsCreate: true, PermissionsEdit: true, PermissionsDelete: false, PermissionsViewAllRecords: false, PermissionsModifyAllRecords: false }];
      if (/FROM AccountTeamMember/.test(q)) return [];
      if (/COUNT\(\)/.test(q)) return { total: 0 };
      return { fail: `no route for ${q}`, code: "TEST" };
    };
    const describes = {
      Case: { label: "Case", labelPlural: "Cases", custom: false, fields: [{ name: "Id", type: "id" }, { name: "CaseNumber", type: "string", nameField: true }, { name: "OwnerId", type: "reference", referenceTo: ["User"] }, { name: "AccountId", type: "reference", referenceTo: ["Account"] }] },
      Account: { label: "Account", labelPlural: "Accounts", custom: false, fields: [{ name: "Id", type: "id" }, { name: "Name", type: "string", nameField: true }] },
      CaseShare: { fields: [{ name: "CaseId" }, { name: "CaseAccessLevel" }, { name: "RowCause" }, { name: "UserOrGroupId" }] },
    };
    const fetchImpl = async (url, opts = {}) => {
      const u = new URL(url);
      log.push({ method: opts.method || "GET", q: u.searchParams.get("q") });
      const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
      if (/\/sobjects\/$/.test(u.pathname)) return ok({ sobjects: [{ name: "Case", keyPrefix: "500", label: "Case", labelPlural: "Cases" }, { name: "Account", keyPrefix: "001", label: "Account", labelPlural: "Accounts" }] });
      const m = u.pathname.match(/\/sobjects\/(\w+)\/describe\/$/);
      if (m) return describes[m[1]] ? ok(describes[m[1]]) : { ok: false, status: 404, text: async () => JSON.stringify([{ message: "not found", errorCode: "NOT_FOUND" }]) };
      const r = route(u.searchParams.get("q"));
      if (r.fail) return { ok: false, status: 400, text: async () => JSON.stringify([{ message: r.fail, errorCode: r.code || "TEST" }]) };
      if (r.total !== undefined) return ok({ done: true, totalSize: r.total, records: [] });
      return ok({ done: true, totalSize: r.length, records: r });
    };
    const api = new SfApi({ apiHost: "test.example.com", sessionId: "sid", fetchImpl });
    const ctx = await readRecordContext(api, "500000000000001AAA");
    assert.equal(ctx.record.accountId, ID.rec);
    assert.equal(ctx.record.accountName, "Contoso (sample)");
    const f = await readRecordAccess(api, ctx, [{ id: ID.alice, name: "Alice Smith" }]);
    assert.equal(f.account.id, ID.rec);
    assert.deepEqual(f.account.rows, [{ who: ID.gEmea, level: "Read", cause: "Rule" }], "Owner and None rows are left out");
    assert.deepEqual(f.account.owner, { id: ID.maria, name: "Maria Keller", roleId: ID.low, level: "None" });
    assert.equal(log.filter((l) => /FROM AccountShare/.test(l.q || "")).length, 1, "one share query for the account");
    assert.match(log.find((l) => /FROM AccountShare/.test(l.q || "")).q, /SELECT UserOrGroupId, RowCause, CaseAccessLevel FROM AccountShare WHERE AccountId = '001000000000001AAA'/);
    assert.ok(log.some((l) => /FROM AccountTeamMember WHERE AccountId = '001000000000001AAA' AND UserId = '005000000000001AAA'/.test(l.q || "")));
    const res = explain(f);
    assert.equal(res.users[0].mismatch, null);
    assert.equal(res.users[0].routes[0].steps[1], "The account is shared by a sharing rule with public group 'EMEA Sales', which gives view access to the account's cases");
    assert.ok(log.every((l) => l.method === "GET"));
    for (const l of log.filter((x) => x.q)) assert.match(l.q, /^SELECT /);
  });

  await test("record access: the new files never use innerHTML, storage or remote code, and only read", () => {
    const files = [["record-access.js"], ["record-access.html"], ["record-access.css"], ["lib", "recordaccess.js"], ["lib", "recordaccessread.js"], ["popup.js"]];
    for (const f of files) {
      const text = readFileSync(ext(...f), "utf-8");
      for (const bad of ["innerHTML", "insertAdjacentHTML", "outerHTML", "localStorage", "sessionStorage", "chrome.storage", "document.write", "eval("]) {
        assert.ok(!text.includes(bad), `${f.join("/")} contains ${bad}`);
      }
      assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(text.replace(/https:\/\/\$\{/g, "")), `${f.join("/")} mentions a remote URL`);
    }
    const pure = readFileSync(ext("lib", "recordaccess.js"), "utf-8");
    for (const bad of ["document.", "window.", "fetch(", "chrome.", "location.", "import "]) assert.ok(!pure.includes(bad), `lib/recordaccess.js contains ${bad}`);
    const read = readFileSync(ext("lib", "recordaccessread.js"), "utf-8");
    assert.ok(!/\b(INSERT|UPDATE|DELETE|UPSERT|POST|PATCH|PUT)\b/.test(read.replace(/Delete|Update/g, "")), "recordaccessread.js has a write verb");
    assert.ok(!/api\.(post|patch|put|delete)\b|method:/i.test(read));
    const page = readFileSync(ext("record-access.js"), "utf-8");
    assert.ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)/i.test(page));
    assert.ok(!/replaceChildren\([^;]*\?[^;]*:\s*null/.test(page));
    assert.match(page, /navigator\.clipboard\.writeText/);
  });

  await test("record access: popup entry, record Id in the address, and the manifest version", () => {
    const popup = readFileSync(ext("popup.js"), "utf-8");
    assert.match(popup, /page: "record-access\.html"[\s\S]*?title: "Why can a user see this record\?"[\s\S]*?description: "Explain who can see the record open in this tab, and why"/);
    assert.match(popup, /&record=\$\{encodeURIComponent\(recordId\)\}/);
    assert.match(popup, /Open a record first/);
    assert.ok(!/btn\.disabled = !inOrg \|\| /.test(popup), "the button stays enabled when no record is open");
    assert.match(popup, /btn\.disabled = !inOrg;/);
    const manifest = JSON.parse(readFileSync(ext("manifest.json"), "utf-8"));
    assert.equal(manifest.version, "0.4.0");
    assert.match(manifest.description, /why a user can see a record/);
  });
}

function k15(id) { return id.slice(0, 15); }
