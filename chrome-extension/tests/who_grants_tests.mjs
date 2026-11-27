// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Offline tests for "Where does a user get this permission?". Called from run_tests.mjs with its shared `test` function.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SfApi, API_VERSION, useNewestVersion } from "../shared/sfconn.js";
import { TOOLS } from "../shared/tool-list.js";
import { FEEDBACK_TOOLS } from "../shared/feedback.js";
import {
  analyze, sectionsOf, copyText, copyWithFallback, matchItems, systemItems, objectItems, fieldItems, factsFromModel, whenStamp, dateWords, expiryWords,
  permissionWords, setupUrl, systemApiShort, fieldApiShort, NOT_CHECKED_NOTE, UNLISTED_FIELD_HINT, OBJECT_LEVELS, FIELD_LEVELS, KIND_CHOICES, PlainError, errorWords, notPassedText, connectErrorWords, SessionLookupError, andList,
} from "../tools/who-grants/who-grants-logic.js";
import { readGrants, readSystemList, readObjectList, readFieldDescribe } from "../tools/who-grants/who-grants-read.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = (...p) => path.join(here, "..", ...p);
const read = (f) => readFileSync(f, "utf-8");
const demo = () => JSON.parse(read(ext("samples", "who_grants_demo.json")));

// ---------- facts built by hand, for the logic ----------

const flags = (o = {}) => ({ read: false, create: false, edit: false, delete: false, viewAll: false, modifyAll: false, viewAllFields: false, ...o });
/** A permission set the way the reader returns it. */
function S(id, label, o = {}) {
  return {
    id, kind: o.kind || "set", label, apiName: o.apiName || label.replace(/\W+/g, "_"),
    sys: { target: o.target ?? false, viewAllData: o.vad ?? false, modifyAllData: o.mad ?? false, viewAllFieldsGlobal: o.vafg ?? false },
    obj: o.obj === null ? null : flags(o.obj), fld: o.fld === null ? null : { read: false, edit: false, ...o.fld },
  };
}
const unit = (kind, label, o = {}) => ({ kind, label, apiName: o.apiName || "", setId15: o.set, groupId: o.group, status: o.status || "active", expires: o.expires || null });
const group = (id, label, o = {}) => ({ id, label, apiName: o.apiName || "", status: o.status === undefined ? "Updated" : o.status, aggregateId15: o.agg, componentsRead: o.read !== false, components: o.comps || [], muting: o.mute || [] });
/** facts = {units, sets: [S...], groups: [group...], user, problems, notes} */
function facts({ units = [], sets = [], groups = [], user = {}, problems = [], notes = [] }) {
  return {
    schema: "sf-who-grants/1", units, problems, notes,
    sets: Object.fromEntries(sets.map((s) => [s.key ?? s.id, s])),
    groups: Object.fromEntries(groups.map((g) => [g.id, g])),
    user: { id: "005000000000001", name: "Casey Sample", username: "casey@example.com", isActive: true, ...user },
  };
}
const SYS = { kind: "system", api: "PermissionsModifyAllData", label: "Modify All Data" };
const OBJ = (level) => ({ kind: "object", object: "Account", objectLabel: "Account", level });
const FLD = (level) => ({ kind: "field", object: "Account", objectLabel: "Account", field: "Account.Industry", fieldLabel: "Industry", level });

// ---------- a fake org served through a GET-only fetch (the real SfApi runs on top of it) ----------

const pad = (p, n) => `${p}${String(n).padStart(12, "0")}AAA`;
const USER = pad("005", 1);
const PS = (n) => pad("0PS", n);
const PG = (n) => pad("0PG", n);
const MU = (n) => pad("0QM", n);

const columnsFor = (sobject, version) => {
  const v = Number(version);
  const perms = ["PermissionsViewAllData", "PermissionsModifyAllData", "PermissionsViewSetup", "PermissionsApiEnabled", ...(v >= 63 ? ["PermissionsViewAllFieldsGlobal"] : [])];
  return {
    PermissionSet: ["Id", "Name", "Label", "Type", "IsOwnedByProfile", "NamespacePrefix", "ProfileId", "PermissionSetGroupId", ...(v >= 45 ? ["HasActivationRequired"] : []), ...perms],
    PermissionSetAssignment: ["Id", "AssigneeId", "PermissionSetId", "PermissionSetGroupId", ...(v >= 61 ? ["ExpirationDate", "IsActive", "IsRevoked"] : [])],
    PermissionSetGroup: ["Id", "DeveloperName", "MasterLabel", "NamespacePrefix", "Status", ...(v >= 45 ? ["HasActivationRequired"] : [])],
    PermissionSetGroupComponent: ["Id", "PermissionSetGroupId", "PermissionSetId"],
    // Many, but not all, of the PermissionSet permissions (the real describe has these three, seen live in a developer org).
    MutingPermissionSet: ["Id", "DeveloperName", "MasterLabel", "PermissionsViewSetup", "PermissionsViewAllData", "PermissionsModifyAllData", ...(v >= 63 ? ["PermissionsViewAllFieldsGlobal"] : [])],
    ObjectPermissions: ["Id", "ParentId", "SobjectType", "PermissionsRead", "PermissionsCreate", "PermissionsEdit", "PermissionsDelete", "PermissionsViewAllRecords", "PermissionsModifyAllRecords", ...(v >= 63 ? ["PermissionsViewAllFields"] : [])],
    FieldPermissions: ["Id", "ParentId", "SobjectType", "Field", "PermissionsRead", "PermissionsEdit"],
    User: null,
  }[sobject];
};

function makeOrg(cfg = {}) {
  const org = {
    versions: cfg.versions || ["60.0", "62.0", "68.0"],
    users: cfg.users || [{ Id: USER, Name: "Casey Sample", Username: "casey@example.com", IsActive: true, ProfileId: pad("00e", 1), Profile: { Name: "Standard Sales" } }],
    assignments: cfg.assignments || [], sets: cfg.sets || [], groups: cfg.groups || [], components: cfg.components || [], muting: cfg.muting || [],
    objPerms: cfg.objPerms || [], fldPerms: cfg.fldPerms || [], fail: cfg.fail || {}, failVersions: cfg.failVersions === true,
    log: [], queries: [], methods: [],
  };
  const same = (a, b) => String(a).slice(0, 15) === String(b).slice(0, 15);
  const ids = (text) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const err = (status, message, errorCode) => json(status, [{ message, errorCode }]);
  const nest = (rec, cols) => {
    const out = {};
    for (const c of cols) {
      if (c.includes(".")) { const [a, b] = c.split("."); out[a] = { ...(out[a] || {}), [b]: rec[a]?.[b] }; } else out[c] = rec[c] === undefined ? null : rec[c];
    }
    return out;
  };
  org.fetch = async (url, opts = {}) => {
    org.methods.push(opts.method);
    assert.ok(opts.method === undefined || opts.method === "GET", `non-GET call: ${opts.method} ${url}`);
    assert.equal(opts.body, undefined, "a body was sent");
    const u = new URL(url);
    org.log.push(u.pathname + u.search);
    if (u.pathname === "/services/data/") {
      return org.failVersions ? err(500, "versions down", "SERVER_UNAVAILABLE") : json(200, org.versions.map((v) => ({ version: v, label: v, url: `/services/data/v${v}` })));
    }
    const ver = /\/v(\d+\.\d)\//.exec(u.pathname)?.[1];
    const d = /\/sobjects\/(\w+)\/describe\/$/.exec(u.pathname);
    if (d) {
      const sobject = d[1];
      if (org.fail[`describe:${sobject}`]) return err(500, `describe ${sobject} failed`, "UNKNOWN_EXCEPTION");
      if (cfg.describes?.[sobject]) return json(200, cfg.describes[sobject]);
      const cols = columnsFor(sobject, cfg.columnVersion || ver);
      if (!cols) return err(404, "no such object", "NOT_FOUND");
      return json(200, { fields: cols.map((name) => ({ name, label: name.replace(/^Permissions/, "").replace(/([a-z])([A-Z])/g, "$1 $2"), type: name.startsWith("Permissions") ? "boolean" : "string", picklistValues: [] })) });
    }
    const q = u.searchParams.get("q");
    assert.ok(q && u.pathname.endsWith("/query/"), `unexpected path ${u.pathname}`);
    org.queries.push(q);
    const m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.*?))?(?: LIMIT \d+)?$/.exec(q);
    assert.ok(m, `cannot read ${q}`);
    const cols = m[1].split(", ");
    const sobject = m[2];
    const where = m[3] || "";
    if (org.fail[sobject]) return err(500, `${sobject} is down`, "UNKNOWN_EXCEPTION");
    if (org.failIf && org.failIf(q, sobject)) return err(500, `${sobject} is down for this read`, "UNKNOWN_EXCEPTION");
    // Salesforce answers 400 to a column named twice; so does this fake org.
    const dup = cols.find((c, i) => cols.indexOf(c) !== i);
    if (dup) return err(400, `duplicate field selected: ${dup}`, "INVALID_FIELD");
    // The columns this fake org's describe lists (a describe given in `cfg.describes` wins), and nothing else.
    const known = cfg.describes?.[sobject] ? cfg.describes[sobject].fields.map((f) => f.name) : columnsFor(sobject, cfg.columnVersion || ver);
    if (known) {
      for (const c of cols) {
        const bad = c.includes(".") ? !(sobject === "PermissionSet" && c === "Profile.Name") : !known.includes(c);
        if (bad) return err(400, `No such column '${c}' on entity '${sobject}'`, "INVALID_FIELD");
      }
    }
    const list = ids(where);
    let rows;
    if (sobject === "User") rows = org.users.filter((x) => same(x.Id, list[0]));
    else if (sobject === "PermissionSetAssignment") rows = org.assignments.filter((x) => same(x.AssigneeId, list[0]));
    else if (sobject === "PermissionSetGroup") rows = org.groups.filter((x) => list.some((i) => same(i, x.Id)));
    else if (sobject === "PermissionSetGroupComponent") rows = org.components.filter((x) => list.some((i) => same(i, x.PermissionSetGroupId)));
    else if (sobject === "PermissionSet") {
      rows = /PermissionSetGroupId IN/.test(where)
        ? org.sets.filter((x) => x.Type === "Group" && list.some((i) => same(i, x.PermissionSetGroupId)))
        : org.sets.filter((x) => list.some((i) => same(i, x.Id)));
    } else if (sobject === "MutingPermissionSet") rows = org.muting.filter((x) => list.some((i) => same(i, x.Id)));
    else if (sobject === "ObjectPermissions") rows = org.objPerms.filter((x) => x.SobjectType === list[0] && list.slice(1).some((i) => same(i, x.ParentId)));
    else if (sobject === "FieldPermissions") rows = org.fldPerms.filter((x) => x.SobjectType === list[0] && x.Field === list[1] && list.slice(2).some((i) => same(i, x.ParentId)));
    else return err(400, `unknown object ${sobject}`, "INVALID_TYPE");
    const records = rows.map((r) => nest(r, cols));
    return json(200, { totalSize: records.length, done: true, records });
  };
  org.api = () => new SfApi({ apiHost: "x.example.com", sessionId: "S", fetchImpl: org.fetch });
  return org;
}

const setRec = (n, name, o = {}) => ({
  Id: PS(n), Name: name, Label: o.label || name.replace(/_/g, " "), Type: o.type || "Regular", IsOwnedByProfile: !!o.profile, NamespacePrefix: null,
  Profile: o.profile ? { Name: o.profile === true ? "Standard Sales" : o.profile } : null, ProfileId: o.profile ? pad("00e", 1) : null,
  PermissionSetGroupId: o.groupId || null, HasActivationRequired: o.session === true,
  PermissionsViewAllData: false, PermissionsModifyAllData: false, PermissionsViewSetup: false, PermissionsApiEnabled: false, PermissionsViewAllFieldsGlobal: false, ...(o.perms || {}),
});
const assign = (n, setN, o = {}) => ({ Id: pad("0Pa", n), AssigneeId: USER, PermissionSetId: PS(setN), PermissionSetGroupId: o.group || null, ExpirationDate: o.expires || null, IsActive: o.active ?? true, IsRevoked: o.revoked ?? false });
const objRow = (parent, sobject, o = {}) => ({ ParentId: parent, SobjectType: sobject, PermissionsRead: false, PermissionsCreate: false, PermissionsEdit: false, PermissionsDelete: false, PermissionsViewAllRecords: false, PermissionsModifyAllRecords: false, PermissionsViewAllFields: false, ...o });

/** One org with a profile, a direct set, a group (with muting in the MutingPermissionSet object), a session set and an expired set. */
function bigOrg(extra = {}) {
  return makeOrg({
    sets: [
      setRec(1, "X00e000000000001", { profile: "Standard Sales", label: "Standard Sales" }),
      setRec(2, "Direct_Set", { perms: { PermissionsViewSetup: true } }),
      setRec(3, "Inner_A", { perms: { PermissionsViewSetup: true } }),
      setRec(4, "Inner_B"),
      setRec(5, "Group_Agg", { type: "Group", groupId: PG(1), perms: { PermissionsViewSetup: false } }),
      setRec(6, "Session_Set", { type: "Session", session: true, perms: { PermissionsViewSetup: true } }),
      setRec(7, "Expired_Set", { perms: { PermissionsViewSetup: true } }),
    ],
    groups: [{ Id: PG(1), DeveloperName: "Sales_Ops", MasterLabel: "Sales Ops", NamespacePrefix: null, Status: "Updated", HasActivationRequired: false }],
    components: [{ PermissionSetGroupId: PG(1), PermissionSetId: PS(3) }, { PermissionSetGroupId: PG(1), PermissionSetId: PS(4) }, { PermissionSetGroupId: PG(1), PermissionSetId: MU(1) }],
    muting: [{ Id: MU(1), DeveloperName: "Sales_Mute", MasterLabel: "Sales Mute", PermissionsViewSetup: true, PermissionsViewAllData: false, PermissionsModifyAllData: false, PermissionsViewAllFieldsGlobal: false }],
    assignments: [
      assign(1, 1), assign(2, 2), assign(3, 5, { group: PG(1) }), assign(4, 6), assign(5, 7, { expires: "2026-01-01T00:00:00.000+0000" }),
    ],
    objPerms: [
      objRow(PS(1), "Account", { PermissionsRead: true, PermissionsEdit: true }),
      objRow(PS(3), "Account", { PermissionsRead: true, PermissionsDelete: true }),
      objRow(PS(5), "Account", { PermissionsRead: true }),
      objRow(MU(1), "Account", { PermissionsDelete: true }),
    ],
    fldPerms: [
      { ParentId: PS(3), SobjectType: "Account", Field: "Account.Industry", PermissionsRead: true, PermissionsEdit: true },
      { ParentId: PS(5), SobjectType: "Account", Field: "Account.Industry", PermissionsRead: true, PermissionsEdit: true },
    ],
    ...extra,
  });
}
const NOW = new Date("2026-11-23T12:00:00Z");
const userPick = { id: USER, name: "Casey Sample" };

export async function run(test) {
  // ===== the answer: places, headline wording =====

  await test("grants: a permission from the profile, a directly assigned set and a group is three places, each named", () => {
    const f = facts({
      units: [unit("profile", "Standard Sales", { set: "p1" }), unit("set", "Cleanup", { set: "d1", apiName: "Cleanup" }), unit("group", "Sales Ops", { group: "g1", apiName: "Sales_Ops" })],
      sets: [S("p1", "Standard Sales", { kind: "profile", target: true }), S("d1", "Cleanup", { target: true }), S("agg", "Sales Ops", { kind: "group", target: true }), S("c1", "Inner A", { target: true }), S("c2", "Inner B", { target: true }), S("c3", "Inner C")],
      groups: [group("g1", "Sales Ops", { agg: "agg", comps: ["c1", "c2", "c3"] })],
    });
    const r = analyze(f, SYS);
    assert.equal(r.answer, "yes");
    assert.equal(r.headline, "Yes. Casey Sample gets Modify All Data from 3 places.");
    assert.equal(r.places, 3);
    assert.deepEqual(r.gives.map((x) => [x.kindWord, x.label]), [["Profile", "Standard Sales"], ["Permission set", "Cleanup"], ["Permission set group", "Sales Ops"]]);
    assert.deepEqual(r.gives[2].via.map((v) => v.label), ["Inner A", "Inner B"], "only the permission sets inside that give it are named");
    const lines = sectionsOf(r)[0].items.map((i) => i.lines.join(" "));
    assert.match(lines[2], /these permission sets inside the group: "Inner A" and "Inner B"/);
  });

  await test("grants: one place says '1 place' and the headline names the permission, an object level and a field", () => {
    const f = facts({ units: [unit("profile", "P", { set: "p1" })], sets: [S("p1", "P", { kind: "profile", target: true, obj: { delete: true, read: true }, fld: { read: true } })] });
    assert.equal(analyze(f, SYS).headline, "Yes. Casey Sample gets Modify All Data from 1 place.");
    assert.equal(analyze(f, OBJ("delete")).headline, "Yes. Casey Sample gets Delete on Account from 1 place.");
    assert.equal(analyze(f, FLD("read")).headline, "Yes. Casey Sample gets Read on the field Industry (Account) from 1 place.");
    assert.equal(permissionWords({ kind: "object", object: "Opp__c", level: "modifyAll" }), "Modify All on Opp__c");
  });

  await test("grants: not given anywhere says so, only when every read worked", () => {
    const f = facts({ units: [unit("profile", "P", { set: "p1" })], sets: [S("p1", "P", { kind: "profile" })] });
    const r = analyze(f, SYS);
    assert.equal(r.answer, "no");
    assert.equal(r.headline, "No. Casey Sample does not get Modify All Data: not given anywhere.");
    assert.equal(r.gives.length, 0);
    const failed = analyze(facts({ units: f.units, sets: [S("p1", "P", { kind: "profile" })], problems: [{ text: "Some permission sets assigned to the user could not be read.", short: "some permission sets could not be read", blocks: true, raw: "boom" }] }), SYS);
    assert.equal(failed.answer, "unsure");
    assert.ok(!/not given anywhere/.test(failed.headline));
    assert.match(failed.headline, /^Not sure\. We could not check everything, so we cannot say whether Casey Sample gets Modify All Data: some permission sets could not be read\.$/);
  });

  await test("grants: a set both direct and inside a group shows both, and the same permission set is not counted twice inside one group", () => {
    const f = facts({
      units: [unit("set", "Cleanup", { set: "d1" }), unit("group", "Crew", { group: "g1" })],
      sets: [S("d1", "Cleanup", { target: true }), S("agg", "Crew", { kind: "group", target: true }), S("d1", "Cleanup", { target: true })],
      groups: [group("g1", "Crew", { agg: "agg", comps: ["d1"] })],
    });
    const r = analyze(f, SYS);
    assert.equal(r.places, 2);
    assert.equal(r.gives[0].direct, true);
    assert.deepEqual(r.gives[1].via.map((v) => v.label), ["Cleanup"]);
  });

  await test("grants: an expiry date is shown on what gives it, and an assignment that expires later still counts", () => {
    const f = facts({ units: [unit("set", "Temp", { set: "d1", expires: "2026-12-31T23:59:00.000+0000" })], sets: [S("d1", "Temp", { target: true })] });
    const r = analyze(f, SYS);
    assert.equal(r.places, 1);
    assert.match(sectionsOf(r, { timeZone: "UTC" })[0].items[0].lines.join(" "), /Expires Dec 31, 2026, 11:59 PM UTC\./);
    // the person's own date: late on Nov 23 in New York is already Nov 24 in UTC
    assert.equal(expiryWords("2026-11-24T02:30:00Z", "America/New_York"), "Nov 23, 2026, 9:30 PM EST");
    assert.equal(expiryWords("2026-11-24T02:30:00Z", "UTC"), "Nov 24, 2026, 2:30 AM UTC");
    assert.equal(dateWords("2026-03-05T10:00:00Z"), "Mar 5, 2026");
  });

  // ===== groups and muting =====

  const mutedFacts = (o = {}) => facts({
    units: [unit("group", "Sales Ops", { group: "g1", apiName: "Sales_Ops" })],
    sets: [S("agg", "Sales Ops", { kind: "group", target: o.aggHas ?? false, obj: { read: true, delete: o.aggHas ?? false } }), S("c1", "Deleters", { target: true, obj: { read: true, delete: true } }), S("c2", "Readers", { obj: { read: true } }), S("m1", "Sales Muting", { kind: "muting", target: o.mutes ?? true, obj: o.muteObj || { delete: true } })],
    groups: [group("g1", "Sales Ops", { agg: "agg", comps: ["c1", "c2"], mute: ["m1"], status: o.status === undefined ? "Updated" : o.status, read: o.read })],
  });

  await test("grants: muted in a group is 'Removed by muting', names the set inside and the muting set, and is not counted", () => {
    for (const spec of [SYS, OBJ("delete")]) {
      const r = analyze(mutedFacts(), spec);
      assert.equal(r.answer, "muted");
      assert.equal(r.places, 0);
      assert.equal(r.headline, `No. Casey Sample does not get ${permissionWords(spec)}: the group "Sales Ops" would give it, but its muting permission set removes it.`);
      const sec = sectionsOf(r).find((s) => s.key === "muted");
      assert.equal(sec.title, "Removed by muting");
      assert.match(sec.items[0].lines.join(" "), /This permission set inside the group gives it: "Deleters"\./);
      assert.match(sec.items[0].lines.join(" "), /This muting permission set takes it away: "Sales Muting"\./);
    }
  });

  await test("grants: two muted groups use plural words; a muted group plus another place is a Yes that still lists the muting", () => {
    const f = mutedFacts();
    f.units.push(unit("group", "Other Ops", { group: "g2" }));
    f.groups.g2 = group("g2", "Other Ops", { agg: "agg", comps: ["c1"], mute: ["m1"] });
    const two = analyze(f, SYS);
    assert.match(two.headline, /^No\. Casey Sample does not get Modify All Data: 2 groups would give it, but their muting permission sets remove it\.$/);
    f.units.push(unit("profile", "P", { set: "p1" }));
    f.sets.p1 = S("p1", "P", { kind: "profile", target: true });
    const yes = analyze(f, SYS);
    assert.equal(yes.answer, "yes");
    assert.equal(yes.muted.length, 2);
  });

  await test("grants: muting that lists the permission while the group still has it is a note, and the group still gives it", () => {
    const r = analyze(mutedFacts({ aggHas: true }), SYS);
    assert.equal(r.answer, "yes");
    assert.deepEqual(r.gives[0].via.map((v) => v.label), ["Deleters"]);
    assert.ok(r.notes.some((n) => /muting does not remove it here/.test(n)), r.notes.join("|"));
  });

  await test("grants: an object level is muted when a flag it depends on is muted (Read muted removes Delete, Create muted does not remove Read)", () => {
    const f = (mute) => facts({
      units: [unit("group", "G", { group: "g1" })],
      sets: [S("agg", "G", { kind: "group", obj: {} }), S("c1", "C", { obj: { read: true, edit: true, delete: true, create: true } }), S("m1", "M", { kind: "muting", obj: mute })],
      groups: [group("g1", "G", { agg: "agg", comps: ["c1"], mute: ["m1"] })],
    });
    assert.equal(analyze(f({ read: true }), OBJ("delete")).answer, "muted");
    assert.equal(analyze(f({ read: true }), OBJ("create")).answer, "muted");
    assert.equal(analyze(f({ edit: true }), OBJ("delete")).answer, "muted", "Delete depends on Edit");
    assert.equal(analyze(f({ create: true }), OBJ("read")).answer, "no", "Create muted does not touch Read: the group simply does not pass it on");
    assert.equal(analyze(f({ create: true }), OBJ("read")).notPassed.length, 1);
  });

  await test("grants: a field is muted when Read is muted (Read and Edit go), Edit muted removes only Edit", () => {
    const f = (mute) => facts({
      units: [unit("group", "G", { group: "g1" })],
      sets: [S("agg", "G", { kind: "group" }), S("c1", "C", { fld: { read: true, edit: true } }), S("m1", "M", { kind: "muting", fld: mute })],
      groups: [group("g1", "G", { agg: "agg", comps: ["c1"], mute: ["m1"] })],
    });
    assert.equal(analyze(f({ read: true }), FLD("edit")).answer, "muted");
    assert.equal(analyze(f({ read: true }), FLD("read")).answer, "muted");
    assert.equal(analyze(f({ edit: true }), FLD("edit")).answer, "muted");
    assert.notEqual(analyze(f({ edit: true }), FLD("read")).answer, "muted", "Edit muted leaves Read");
  });

  await test("grants: a muting set that cannot mute this permission (not in its fields) does not count as muting", () => {
    const r = analyze(mutedFacts({ mutes: false }), SYS);
    assert.equal(r.answer, "no");
    assert.equal(r.muted.length, 0);
    assert.equal(r.notPassed.length, 1);
    assert.match(r.notPassed[0].text, /inside the group has it, but the group does not pass it on\. A likely reason is that muting removes something it depends on\./);
    assert.match(r.headline, /has it inside but does not pass it on/);
  });

  await test("grants: a group that is not Updated is 'not sure', never a confident No, and always adds a note", () => {
    for (const status of ["Outdated", "Updating", "Failed"]) {
      const r = analyze(mutedFacts({ mutes: false, status }), SYS);
      assert.equal(r.answer, "unsure", status);
      assert.match(r.headline, /still being recalculated/);
      assert.ok(!/not given anywhere/.test(r.headline));
      assert.ok(r.notSure[0].text.includes(`status ${status}`), "the status is said once, in the card");
    }
    const g = analyze(facts({ units: [unit("group", "G", { group: "g1" })], sets: [S("agg", "G", { kind: "group" })], groups: [group("g1", "G", { agg: "agg", status: "Outdated" })] }), SYS);
    assert.ok(g.notes.some((n) => /still being recalculated/.test(n)), "a note even when nothing inside gives it");
  });

  await test("grants: group parts that cannot be read hedge the answer; a group that has it but whose parts are unreadable still gives it", () => {
    const lacks = analyze(mutedFacts({ read: false }), SYS);
    assert.equal(lacks.answer, "unsure");
    assert.match(lacks.notSure[0].text, /could not be read, so we cannot say why the group does not give it/);
    const has = analyze(mutedFacts({ aggHas: true, read: false }), SYS);
    assert.equal(has.answer, "yes");
    assert.equal(has.places, 1);
    assert.match(sectionsOf(has)[0].items[0].lines[0], /We could not read the permission sets inside, so we cannot tell which one/);
    const unreadableAgg = analyze(facts({ units: [unit("group", "G", { group: "g1" })], sets: [], groups: [group("g1", "G", { agg: "missing" })] }), SYS);
    assert.equal(unreadableAgg.answer, "unsure");
  });

  await test("grants: the combined permissions have it but no readable part does: still gives it, 'could not tell which permission set inside'", () => {
    const f = facts({ units: [unit("group", "G", { group: "g1" })], sets: [S("agg", "G", { kind: "group", target: true }), S("c1", "C")], groups: [group("g1", "G", { agg: "agg", comps: ["c1"] })] });
    const r = analyze(f, SYS);
    assert.equal(r.places, 1);
    assert.deepEqual(r.gives[0].via, []);
    assert.equal(r.gives[0].viaUnknown, true);
    assert.match(sectionsOf(r)[0].items[0].lines[0], /could not tell which permission set inside/);
  });

  // ===== session, expired, inactive =====

  await test("grants: session-based and no-longer-active assignments that contain it are listed but not counted", () => {
    const f = facts({
      units: [
        unit("set", "Session Set", { set: "s1", status: "needsActivation" }),
        unit("group", "Session Group", { group: "g1", status: "needsActivation" }),
        unit("set", "Old", { set: "o1", status: "expired", expires: "2026-01-02T00:00:00Z" }),
        unit("set", "Gone", { set: "r1", status: "revoked" }),
        unit("set", "Off", { set: "i1", status: "inactive" }),
        unit("set", "Not Holding", { set: "n1", status: "expired" }),
      ],
      sets: [S("s1", "Session Set", { target: true }), S("agg", "Session Group", { kind: "group", target: true }), S("k1", "Kid", { target: true }), S("o1", "Old", { target: true }), S("r1", "Gone", { target: true }), S("i1", "Off", { target: true }), S("n1", "Not Holding")],
      groups: [group("g1", "Session Group", { agg: "agg", comps: ["k1"] })],
    });
    const r = analyze(f, SYS);
    assert.equal(r.places, 0);
    assert.equal(r.activation.length, 2);
    assert.equal(r.notActive.length, 3, "an assignment that does not contain it is not listed");
    assert.deepEqual(r.notActive.map((x) => x.why.code), ["expired", "revoked", "inactive"]);
    assert.deepEqual(sectionsOf(r, { timeZone: "UTC" }).find((x) => x.key === "notActive").items.map((i) => i.lines[0]), ["The assignment expired on Jan 2, 2026, 12:00 AM UTC.", "The assignment was removed (revoked).", "The assignment is not active."]);
    assert.match(r.headline, /^No\. Casey Sample does not get Modify All Data right now: it is in a session-based assignments? that /);
    assert.deepEqual(sectionsOf(r).map((s) => s.title), ["Needs session activation", "Not active"]);
    const only = analyze(facts({ units: f.units.filter((u) => u.status !== "needsActivation"), sets: Object.values(f.sets), groups: [] }), SYS);
    assert.match(only.headline, /^No\. Casey Sample does not get Modify All Data: the 3 assignments that included it have ended or are not active\.$/);
  });

  await test("grants: an inactive user is said to be inactive, in the answer and in the copied text", () => {
    const f = facts({ units: [unit("profile", "P", { set: "p1" })], sets: [S("p1", "P", { kind: "profile", target: true })], user: { isActive: false } });
    const r = analyze(f, SYS);
    assert.equal(r.inactiveUser, true);
    assert.match(r.inactiveNote, /Casey Sample is an inactive user\. They cannot log in, so nothing here applies right now\./);
    assert.match(copyText(r, {}), /inactive user/);
    assert.equal(analyze(facts({}), SYS).inactiveNote, "");
  });

  // ===== implied access =====

  await test("grants: object Read and View All are covered by View All Data or Modify All Data; Create, Edit, Delete and Modify All only by Modify All Data", () => {
    const f = facts({
      units: [unit("set", "Auditor", { set: "a1" }), unit("set", "Boss", { set: "b1" })],
      sets: [S("a1", "Auditor", { vad: true }), S("b1", "Boss", { mad: true })],
    });
    assert.deepEqual(analyze(f, OBJ("read")).implied.map((x) => x.reasons), [["View All Data"], ["Modify All Data"]]);
    assert.deepEqual(analyze(f, OBJ("viewAll")).implied.map((x) => x.label), ["Auditor", "Boss"]);
    for (const l of ["create", "edit", "delete", "modifyAll"]) assert.deepEqual(analyze(f, OBJ(l)).implied.map((x) => x.label), ["Boss"], l);
    const r = analyze(f, OBJ("read"));
    assert.equal(r.places, 2, "implied sources count as giving it");
    assert.match(r.headline, /^Yes\. Casey Sample gets Read on Account from 2 places\.$/);
    const sec = sectionsOf(r)[0];
    assert.equal(sec.title, "Also covers it");
    assert.match(sec.items[0].lines[0], /Covered by View All Data\./);
  });

  await test("grants: a field Read is covered by View All Fields on the object or View All Fields (Global); a field Edit is never implied", () => {
    const f = facts({
      units: [unit("set", "ObjAll", { set: "a1" }), unit("set", "Global", { set: "b1" }), unit("set", "Admin", { set: "c1" })],
      sets: [S("a1", "ObjAll", { obj: { viewAllFields: true } }), S("b1", "Global", { vafg: true }), S("c1", "Admin", { mad: true, vad: true })],
    });
    const r = analyze(f, FLD("read"));
    assert.deepEqual(r.implied.map((x) => x.reasons[0]), ["View All Fields on Account", "View All Fields (all objects)"]);
    assert.equal(analyze(f, FLD("edit")).implied.length, 0, "Edit is not implied");
    assert.equal(r.implied.some((x) => x.label === "Admin"), false, "Modify All Data and View All Data do not override field permissions");
  });

  await test("grants: a source that gives it both outright and by implication is one place, with the reason mentioned", () => {
    const f = facts({ units: [unit("set", "Both", { set: "a1" })], sets: [S("a1", "Both", { obj: { read: true }, vad: true })] });
    const r = analyze(f, OBJ("read"));
    assert.equal(r.places, 1);
    assert.equal(r.gives.length, 1);
    assert.equal(r.implied.length, 0);
    assert.match(sectionsOf(r)[0].items[0].lines.join(" "), /It is also covered by "View All Data", which it includes\./);
  });

  await test("grants: a group's implied access comes from its combined permissions and names the set inside; a muted group's View All Data is not counted", () => {
    const f = facts({
      units: [unit("group", "G", { group: "g1" })],
      sets: [S("agg", "G", { kind: "group", vad: true }), S("c1", "Auditor", { vad: true }), S("c2", "Plain")],
      groups: [group("g1", "G", { agg: "agg", comps: ["c1", "c2"] })],
    });
    const r = analyze(f, OBJ("read"));
    assert.equal(r.implied.length, 1);
    assert.deepEqual(r.implied[0].via.map((v) => v.label), ["Auditor"]);
    const muted = facts({ units: f.units, sets: [S("agg", "G", { kind: "group" }), S("c1", "Auditor", { vad: true })], groups: [group("g1", "G", { agg: "agg", comps: ["c1"] })] });
    assert.equal(analyze(muted, OBJ("read")).places, 0, "the combined permissions are the truth");
  });

  // ===== fields need the object =====

  await test("grants: a field answer says whether the user has Read on the object, and from where", () => {
    const f = facts({ units: [unit("profile", "P", { set: "p1" }), unit("set", "Cols", { set: "d1" })], sets: [S("p1", "P", { kind: "profile", obj: { read: true } }), S("d1", "Cols", { fld: { read: true, edit: true } })] });
    const r = analyze(f, FLD("read"));
    assert.equal(r.objectAccess.has, true);
    assert.match(r.objectAccess.text, /^Read on Account: yes, from profile "P"\./);
    assert.equal(r.answer, "yes");
    const e = analyze(f, FLD("edit"));
    assert.equal(e.objectAccess.has, false, "Edit on the field also needs Edit on the object");
    assert.equal(e.answer, "notWorking");
    assert.match(e.objectAccess.text, /^Edit on Account: no\./);
  });

  await test("grants: the object line for a field says when the access exists only in a session-based assignment, or only muted, or only ended", () => {
    const base = (extraUnit, extraSets, groups = []) => facts({
      units: [unit("set", "Cols", { set: "d1" }), extraUnit], sets: [S("d1", "Cols", { fld: { read: true, edit: true } }), ...extraSets], groups,
    });
    const sess = analyze(base(unit("set", "Edit Session", { set: "s1", status: "needsActivation" }), [S("s1", "Edit Session", { obj: { read: true, edit: true } })]), FLD("edit"));
    assert.equal(sess.objectAccess.has, false);
    assert.equal(sess.objectAccess.text, 'Edit on Account: not right now; permission set "Edit Session" gives it only after session activation.');
    const ended = analyze(base(unit("set", "Old Edit", { set: "s1", status: "expired", expires: "2026-01-01T00:00:00Z" }), [S("s1", "Old Edit", { obj: { read: true, edit: true } })]), FLD("edit"));
    assert.equal(ended.objectAccess.text, 'Edit on Account: no. Permission set "Old Edit" would give it, but the assignment has ended or is not active.');
    const muted = analyze(base(unit("group", "G", { group: "g1" }), [S("agg", "G", { kind: "group", obj: {} }), S("c1", "C", { obj: { read: true, edit: true } }), S("m1", "M", { kind: "muting", obj: { edit: true } })], [group("g1", "G", { agg: "agg", comps: ["c1"], mute: ["m1"] })]), FLD("edit"));
    assert.equal(muted.objectAccess.text, 'Edit on Account: no. Permission set group "G" would give it, but muting removes it.');
    assert.match(copyText(sess, {}), /OBJECT ACCESS\n- Edit on Account: not right now;/);
  });

  await test("grants: a field given without access to its object says it does not work", () => {
    const f = facts({ units: [unit("set", "Cols", { set: "d1" })], sets: [S("d1", "Cols", { fld: { read: true } })] });
    const r = analyze(f, FLD("read"));
    assert.equal(r.answer, "notWorking");
    assert.equal(r.headline, "No. Casey Sample is given Read on the field Industry (Account) in 1 place, but has no Read on Account, so it does not work.");
    assert.equal(r.places, 1, "the field is still listed");
    assert.match(copyText(r, {}), /OBJECT ACCESS\n- Read on Account: no\./);
    const blind = analyze(facts({ units: f.units, sets: [S("d1", "Cols", { fld: { read: true }, obj: null })] }), FLD("read"));
    assert.equal(blind.objectAccess.has, null);
    assert.match(blind.objectAccess.text, /could not be checked/);
  });

  await test("grants: changing the level only re-reads the facts already held (every level is in one facts object)", () => {
    const f = facts({ units: [unit("profile", "P", { set: "p1" })], sets: [S("p1", "P", { kind: "profile", obj: { read: true, edit: true } })] });
    const before = JSON.stringify(f);
    const answers = OBJECT_LEVELS.map((l) => analyze(f, OBJ(l.key)).answer);
    assert.deepEqual(answers, ["yes", "no", "yes", "no", "no", "no"]);
    assert.equal(JSON.stringify(f), before, "analyze does not change the facts");
    assert.deepEqual(OBJECT_LEVELS.map((l) => l.label), ["Read", "Create", "Edit", "Delete", "View All", "Modify All"]);
    assert.deepEqual(FIELD_LEVELS.map((l) => l.label), ["Read", "Edit"]);
    assert.deepEqual(KIND_CHOICES.map((k) => k.label), ["A system permission", "Access to an object", "Access to a field"]);
  });

  await test("grants: some places could not be checked: a Yes says there may be more", () => {
    const f = facts({
      units: [unit("profile", "P", { set: "p1" })], sets: [S("p1", "P", { kind: "profile", target: true })],
      problems: [{ text: "x could not be read.", short: "x could not be read", blocks: true, raw: "raw one" }],
    });
    const r = analyze(f, SYS);
    assert.match(r.headline, /^Yes\. .* from 1 place\. Some access could not be checked, so there may be more\.$/);
    assert.ok(r.notes.includes("x could not be read."));
  });

  // ===== copy text =====

  await test("grants: the copied text has org, user, username, the permission with its API name, the headline, every section, notes and the time", () => {
    const f = mutedFacts();
    f.units.push(unit("profile", "Standard Sales", { set: "p1" }), unit("set", "Late", { set: "s1", status: "expired", expires: "2026-02-03T00:00:00Z" }));
    f.sets.p1 = S("p1", "Standard Sales", { kind: "profile", obj: { read: true, delete: true } });
    f.sets.s1 = S("s1", "Late", { obj: { read: true, delete: true } });
    const t = copyText(analyze(f, OBJ("delete")), { orgName: "Demo Org", when: "Nov 23, 2026, 3:04 PM UTC", timeZone: "UTC" });
    for (const s of [
      "Org: Demo Org", "User: Casey Sample (casey@example.com)", "Permission: Delete on Account (object, API name Account)", "Checked: Nov 23, 2026, 3:04 PM UTC",
      "Yes. Casey Sample gets Delete on Account from 1 place.", "GIVES IT", "- Profile: Standard Sales", "REMOVED BY MUTING", "- Permission set group: Sales Ops [Sales_Ops]",
      'This muting permission set takes it away: "Sales Muting".', "NOT ACTIVE", "The assignment expired on Feb 3, 2026, 12:00 AM UTC.", "NOTES", NOT_CHECKED_NOTE,
    ]) assert.ok(t.includes(s), `missing: ${s}\n${t}`);
    assert.match(copyText(analyze(facts({}), SYS), {}), /Permission: Modify All Data \(system permission, API name ModifyAllData\)/);
    assert.match(copyText(analyze(facts({}), FLD("edit")), {}), /Permission: Edit on the field Industry of Account \(API name Industry\)/);
  });

  await test("grants: whenStamp names the time zone; copyWithFallback never throws", async () => {
    const s = whenStamp(new Date("2026-11-23T20:04:00Z"), "America/New_York");
    assert.match(s, /Nov 23, 2026/);
    assert.match(s, /(EST|GMT-5)/);
    assert.match(whenStamp(new Date("2026-07-23T20:04:00Z"), "UTC"), /UTC/);
    assert.deepEqual(await copyWithFallback("x", { writeText: async () => {} }), { copied: true });
    assert.deepEqual(await copyWithFallback("x", { writeText: async () => { throw new Error("blocked"); } }), { copied: false });
    assert.deepEqual(await copyWithFallback("x", undefined), { copied: false });
  });

  // ===== review fixes =====

  await test("grants: an object with no object permissions (Task) does not make a field 'not working'", () => {
    const f = facts({ units: [unit("set", "Cols", { set: "d1" })], sets: [S("d1", "Cols", { fld: { read: true } })] });
    const task = { kind: "field", object: "Task", objectLabel: "Task", field: "Task.Subject", fieldLabel: "Subject", level: "read" };
    const no = analyze({ ...f, objectPermissionsApply: false }, task);
    assert.equal(no.answer, "yes");
    assert.equal(no.objectAccess.has, null);
    assert.equal(no.objectAccess.notControlled, true);
    assert.equal(no.objectAccess.text, "Access to Task is not set by object permissions, so it is not checked here.");
    assert.match(no.headline, /^Yes\./);
    assert.equal(analyze({ ...f, objectPermissionsApply: true }, task).answer, "notWorking", "an object that takes object permissions still needs them");
    assert.equal(analyze(f, task).answer, "notWorking", "older facts without the key keep the old behaviour");
    // could not be told, and no object row found: hedge instead of claiming no
    const unknown = analyze({ ...f, objectPermissionsApply: null }, task);
    assert.equal(unknown.objectAccess.has, null);
    assert.equal(unknown.answer, "yes");
    assert.match(unknown.objectAccess.text, /could not be checked/);
    // an object row on the user's side still counts as access
    const withRow = facts({ units: [unit("set", "Cols", { set: "d1" })], sets: [S("d1", "Cols", { fld: { read: true }, obj: { read: true } })] });
    assert.equal(analyze({ ...withRow, objectPermissionsApply: null }, task).objectAccess.has, true);
  });

  await test("grants reader: objectPermissionsApply is false for an object missing from the ObjectPermissions list, true when listed, null when unreadable", async () => {
    const op = (values) => ({ fields: [{ name: "SobjectType", picklistValues: values.map((v) => ({ value: v, label: v })) }, ...["ParentId", "PermissionsRead", "PermissionsCreate", "PermissionsEdit", "PermissionsDelete", "PermissionsViewAllRecords", "PermissionsModifyAllRecords", "PermissionsViewAllFields"].map((name) => ({ name, label: name, type: "boolean" }))] });
    const spec = (object) => ({ kind: "field", object, objectLabel: object, field: `${object}.Subject`, fieldLabel: "Subject" });
    const read = async (object, cfg) => readGrants(bigOrg(cfg).api(), userPick, spec(object), { now: NOW });
    assert.equal((await read("Task", { describes: { ObjectPermissions: op(["Account"]) } })).objectPermissionsApply, false);
    assert.equal((await read("Account", { describes: { ObjectPermissions: op(["Account"]) } })).objectPermissionsApply, true);
    assert.equal((await read("Task", { fail: { "describe:ObjectPermissions": true } })).objectPermissionsApply, null);
    const f = await read("Task", { describes: { ObjectPermissions: op(["Account"]) } });
    assert.notEqual(analyze(f, { ...spec("Task"), level: "read" }).answer, "notWorking");
    assert.equal((await readGrants(bigOrg().api(), userPick, { kind: "system", api: "PermissionsViewSetup", label: "x" }, { now: NOW })).objectPermissionsApply, undefined);
  });

  await test("grants reader: a directly assigned set the query does not return is 'could not be checked', never 'not given anywhere'", async () => {
    const org = bigOrg();
    const API = { kind: "system", api: "PermissionsViewSetup", label: "View Setup and Configuration" };
    org.assignments.push(assign(20, 20)); // PS(20) is not in org.sets: the user may not see it
    org.assignments.push({ Id: pad("0Pa", 21), AssigneeId: USER, PermissionSetId: null, PermissionSetGroupId: null, ExpirationDate: null, IsActive: true, IsRevoked: false });
    const f = await readGrants(org.api(), userPick, API, { now: NOW });
    const lost = f.units.filter((u) => u.unnamed);
    assert.equal(lost.length, 2);
    assert.deepEqual(lost.map((u) => u.setId15).sort(), [PS(20).slice(0, 15), null].sort());
    const r = analyze(f, API);
    assert.equal(r.notSure.length, 2, "both lost assignments are listed as could not be checked");
    assert.match(r.headline, /Some access could not be checked, so there may be more\./);
    assert.deepEqual(r.notSure.map((x) => x.text).sort(), ["A permission set that could not be identified could not be checked.", "A permission set you don't have permission to see could not be checked."]);
    assert.ok(!copyText(r, {}).includes('"A permission set'), "no quotes around it as though it were a name");
    assert.ok(!lost.some((u) => /Unknown/.test(u.label)));
    const only = analyze({ ...f, units: lost, sets: {}, groups: {} }, API);
    assert.equal(only.answer, "unsure", "with nothing else giving it, the answer is not a flat no");
    // an ended assignment of a set we cannot see does not matter
    const org2 = bigOrg();
    org2.assignments.push(assign(20, 20, { expires: "2026-01-01T00:00:00.000+0000" }));
    const r2 = analyze(await readGrants(org2.api(), userPick, API, { now: NOW }), API);
    assert.equal(r2.notSure.length, 0);
  });

  await test("grants reader: when the whole permission set read failed, it is listed once, not once per assignment", async () => {
    const VS = { kind: "system", api: "PermissionsViewSetup", label: "View Setup and Configuration" };
    const org = bigOrg({ fail: { PermissionSet: true } });
    const f = await readGrants(org.api(), userPick, VS, { now: NOW });
    assert.equal(f.problems.filter((p) => /permission sets assigned to the user/.test(p.text)).length, 1);
    assert.ok(!f.units.some((u) => u.unnamed || /Unknown/.test(u.label)), f.units.map((u) => u.label).join("|"));
    assert.deepEqual(f.units.map((u) => u.kind), ["group"], "only the group, whose own read is reported by its own problem");
    const r = analyze(f, VS);
    assert.equal(r.answer, "unsure");
    assert.ok(!r.notSure.some((x) => /permission set you don't/.test(x.text)));
    assert.match(r.headline, /some permission sets could not be read/);
  });

  await test("grants reader: a group whose combined set is not returned, or with a part that neither query returns, is hedged", async () => {
    const API = { kind: "system", api: "PermissionsViewSetup", label: "View Setup and Configuration" };
    const org = bigOrg();
    org.sets = org.sets.filter((x) => x.Id !== PS(5)); // the combined set is gone
    const r = analyze(await readGrants(org.api(), userPick, API, { now: NOW }), API);
    assert.ok(r.notSure.some((x) => x.kind === "group"), "the group could not be checked");
    const org2 = bigOrg();
    org2.components.push({ PermissionSetGroupId: PG(1), PermissionSetId: pad("0PS", 99) }); // in neither PermissionSet nor MutingPermissionSet
    const f2 = await readGrants(org2.api(), userPick, API, { now: NOW });
    assert.equal(Object.values(f2.groups)[0].componentsRead, false, "the group's details are incomplete");
  });

  await test("grants reader: two assignments of the same set or group keep the best one", async () => {
    const API = { kind: "system", api: "PermissionsViewSetup", label: "View Setup and Configuration" };
    const org = bigOrg();
    org.assignments.push(assign(31, 7, { expires: "2026-12-31T00:00:00.000+0000" })); // Expired_Set: assign 5 is expired, this one is later
    org.assignments.push(assign(32, 5, { group: PG(1), revoked: true }));
    const f = await readGrants(org.api(), userPick, API, { now: NOW });
    const u = f.units.filter((x) => x.label === "Expired Set");
    assert.equal(u.length, 1, "one unit per set");
    assert.equal(u[0].status, "active");
    assert.equal(u[0].expires, "2026-12-31T00:00:00.000+0000");
    assert.equal(f.units.filter((x) => x.kind === "group").length, 1);
    assert.equal(f.units.find((x) => x.kind === "group").status, "active", "the active group assignment beats the revoked one");
    const org2 = bigOrg();
    org2.assignments.unshift(assign(33, 5, { group: PG(1), revoked: true })); // revoked one first
    assert.equal((await readGrants(org2.api(), userPick, API, { now: NOW })).units.find((x) => x.kind === "group").status, "active");
  });

  await test("grants: the one-place card says plainly that the permission is also covered, and the notActive headline reads well", () => {
    const f = facts({ units: [unit("profile", "P", { set: "p1" })], sets: [S("p1", "P", { kind: "profile", obj: { read: true }, vad: true })] });
    const lines = sectionsOf(analyze(f, OBJ("read")))[0].items[0].lines;
    assert.ok(lines.includes('It is also covered by "View All Data", which it includes.'), lines.join(" | "));
    const one = analyze(facts({ units: [unit("set", "Old", { set: "o1", status: "expired", expires: "2026-01-02T00:00:00Z" })], sets: [S("o1", "Old", { target: true })] }), SYS);
    assert.equal(one.headline, "No. Casey Sample does not get Modify All Data: the only assignment that included it has ended or is not active.");
  });

  // ===== the pick lists =====

  await test("grants: pick lists come from describe; duplicate labels stay, with their API names", () => {
    const sys = systemItems({ fields: [{ name: "PermissionsModifyAllData", label: "Modify All Data", type: "boolean" }, { name: "Name", label: "Name", type: "string" }, { name: "PermissionsApiEnabled", label: "API Enabled", type: "boolean" }] });
    assert.deepEqual(sys.map((i) => i.api), ["PermissionsApiEnabled", "PermissionsModifyAllData"]);
    const objs = objectItems({ fields: [{ name: "Id" }, { name: "SobjectType", picklistValues: [{ value: "Contact", label: "Contact" }, { value: "Account", label: "Account" }] }] });
    assert.deepEqual(objs.map((i) => i.api), ["Account", "Contact"]);
    const fd = { fields: [{ name: "Field", picklistValues: [{ value: "Account.Parent", label: "Parent Account" }, { value: "Account.ParentId", label: "Parent Account" }, { value: "Account.Industry", label: "Industry" }, { value: "Contact.Email", label: "Email" }] }] };
    const f = fieldItems(fd, "Account");
    assert.deepEqual(f.map((i) => i.api), ["Account.Industry", "Account.ParentId"], "Account.Parent is the same field as Account.ParentId");
    const keep = fieldItems({ fields: [{ name: "Field", picklistValues: [{ value: "Account.Owner", label: "Owner" }, { value: "Account.OwnerId", label: "Account Owner" }, { value: "Account.Site", label: "Site" }] }] }, "Account");
    assert.equal(keep.length, 3, "different labels are different fields");
    assert.deepEqual(fieldItems(fd, "Acc"), [], "the object name must match whole");
  });

  await test("grants: matching takes words in any order from the label or API name, label starts first, and caps the list", () => {
    const items = [{ api: "PermissionsModifyAllData", label: "Modify All Data" }, { api: "PermissionsModifyMetadata", label: "Customize Application" }, { api: "PermissionsViewSetup", label: "View Setup and Configuration" }];
    assert.deepEqual(matchItems(items, "all modify").items.map((i) => i.api), ["PermissionsModifyAllData"]);
    assert.deepEqual(matchItems(items, "nothing like it").items, []);
    assert.deepEqual(matchItems(items, "view setup").items.map((i) => i.label), ["View Setup and Configuration"]);
    assert.deepEqual(matchItems(items, "modify").items.map((i) => i.api), ["PermissionsModifyAllData", "PermissionsModifyMetadata"]);
    const many = Array.from({ length: 250 }, (_, i) => ({ api: `Obj${i}__c`, label: `Thing ${i}` }));
    const r = matchItems(many, "thing", 100);
    assert.equal(r.items.length, 100);
    assert.equal(r.total, 250);
    assert.equal(matchItems(many, "").total, 250);
  });

  // ===== links to Setup, short API names, ranking =====

  const PROFILE_ID = pad("00e", 7);
  await test("grants: setupUrl builds Lightning Setup addresses for a profile, a set, a group and (through its group) a muting set", () => {
    const h = "acme.my.salesforce.com";
    assert.equal(setupUrl(h, "set", PS(1)), `https://${h}/lightning/setup/PermSets/page?address=%2F${PS(1)}`);
    assert.equal(setupUrl(h, "group", PG(2)), `https://${h}/lightning/setup/PermSetGroups/page?address=%2F${PG(2)}`);
    assert.equal(setupUrl(h, "profile", PROFILE_ID), `https://${h}/lightning/setup/EnhancedProfiles/page?address=%2F${PROFILE_ID}`);
    assert.equal(setupUrl("acme.lightning.force.com", "set", PS(1)), `https://acme.lightning.force.com/lightning/setup/PermSets/page?address=%2F${PS(1)}`);
    assert.equal(setupUrl(h, "set", "0PS000000000001"), `https://${h}/lightning/setup/PermSets/page?address=%2F0PS000000000001`, "a 15-character Id is fine");
    assert.equal(setupUrl(h, "muting", MU(3), { groupId: PG(2) }), `https://${h}/lightning/setup/PermSetGroups/page?address=%2F${PG(2)}`, "a muting set is opened through its group");
    assert.equal(setupUrl(h, "muting", MU(3)), null, "a muting set with no group has no link");
    assert.equal(setupUrl(h, "muting", MU(3), { groupId: PS(1) }), null, "the group Id must be a group Id");
  });

  await test("grants: setupUrl returns null for a hostile or missing host, a wrong Id or the wrong kind of Id", () => {
    const h = "acme.my.salesforce.com";
    for (const bad of [undefined, null, "", "evil.com", "evil.com/x.salesforce.com", "evil.com\\@acme.salesforce.com", "user@acme.my.salesforce.com", "acme.my.salesforce.com:8443", "acme.my.salesforce.com/path",
      "https://acme.my.salesforce.com", "acme.my.salesforce.com?x=1", "acme.my.salesforce.com#x", " acme.my.salesforce.com", "a..salesforce.com", "javascript:alert(1)//.salesforce.com", "evil.com%2f.salesforce.com", 42]) {
      assert.equal(setupUrl(bad, "set", PS(1)), null, `host ${JSON.stringify(bad)}`);
    }
    for (const bad of [undefined, null, "", "0PS", "0PS00000000000", `${PS(1)}A`, `${PS(1).slice(0, 15)}/../x`, `${PS(1).slice(0, 14)}%2F`, `${PS(1).slice(0, 14)}?x`, "<script>", PG(1), pad("00e", 1), 5]) {
      assert.equal(setupUrl(h, "set", bad), null, `id ${JSON.stringify(bad)}`);
    }
    assert.equal(setupUrl(h, "group", PS(1)), null, "a set Id is not a group Id");
    assert.equal(setupUrl(h, "profile", PS(1)), null, "a set Id is not a profile Id");
    assert.equal(setupUrl(h, "flow", PS(1)), null);
    assert.equal(setupUrl(h, "__proto__", PS(1)), null);
  });

  await test("grants: every card names the things it mentions as link data (profile, set, group, sets inside, muting sets), and the copy text has no Ids or links", () => {
    const f = facts({
      units: [unit("profile", "Standard Sales", { set: "p1" }), unit("set", "Cleanup", { set: "d1", apiName: "Cleanup" }), unit("group", "Sales Ops", { group: PG(1), apiName: "Sales_Ops" }), unit("group", "Muted Group", { group: PG(2) })],
      sets: [
        { key: "p1", ...S("p1", "Standard Sales", { kind: "profile", target: true }), id: PS(9), profileId: PROFILE_ID },
        { key: "d1", ...S("d1", "Cleanup", { target: true }), id: PS(1) },
        { key: "agg1", ...S("agg1", "Sales Ops", { kind: "group", target: true }), id: PS(5) },
        { key: "c1", ...S("c1", "Inner A", { target: true }), id: PS(2) },
        { key: "agg2", ...S("agg2", "Muted Group", { kind: "group", target: false }), id: PS(6) },
        { key: "c2", ...S("c2", "Inner B", { target: true }), id: PS(3) },
        { key: "m1", ...S("m1", "Mute It", { kind: "muting", target: true }), id: MU(4) },
      ],
      groups: [group(PG(1), "Sales Ops", { agg: "agg1", comps: ["c1"] }), group(PG(2), "Muted Group", { agg: "agg2", comps: ["c2"], mute: ["m1"] })],
    });
    const r = analyze(f, SYS);
    const secs = sectionsOf(r);
    const gives = secs.find((s) => s.key === "gives").items;
    assert.deepEqual(gives[0].links.map((l) => [l.kind, l.id, l.own]), [["profile", PROFILE_ID, true]], "a profile links by the profile's Id, not its permission set's Id");
    assert.deepEqual(gives[1].links.map((l) => [l.kind, l.id, l.own]), [["set", PS(1), true]]);
    assert.deepEqual(gives[2].links.map((l) => [l.kind, l.id, l.own]), [["group", PG(1), true], ["set", PS(2), false]]);
    assert.equal(gives[1].links[0].label, "Open in Setup: permission set Cleanup");
    assert.equal(gives[0].links[0].label, "Open in Setup: profile Standard Sales");
    assert.equal(gives[2].links[0].label, "Open in Setup: permission set group Sales Ops");
    for (const sec of secs) for (const it of sec.items) for (const l of it.links) assert.ok(l.label.startsWith(l.text), "the accessible name starts with the visible text");
    const muted = secs.find((s) => s.key === "muted").items[0];
    assert.deepEqual(muted.links.map((l) => [l.kind, l.id, l.groupId, l.own]), [["group", PG(2), PG(2), true], ["set", PS(3), null, false], ["muting", MU(4), PG(2), false]]);
    assert.equal(muted.links[2].text, "Open the group in Setup", "a muting set says it opens the group");
    assert.equal(muted.links[2].label, "Open the group in Setup: the permission set group that holds the muting permission set Mute It");
    assert.ok(secs.flatMap((sec) => sec.items).flatMap((it) => it.links).filter((l) => l.kind !== "muting").every((l) => l.text === "Open in Setup"));
    const text = copyText(r, { orgName: "Demo", when: "x" });
    assert.ok(!/0PS|0PG|0QM|00e0|lightning\/setup|https?:/.test(text), "no Ids or links in the copied text");
    assert.ok(!text.includes("Open in Setup"));
  });

  await test("grants: no Id, no link; an unnamed set never gets one; the same thing is linked once per card", () => {
    const f = facts({
      units: [unit("profile", "P", { set: "p1" }), { kind: "set", unnamed: true, label: "A permission set you do not have permission to see", apiName: "", setId15: "x1", status: "active" }],
      sets: [S("p1", "P", { kind: "profile", target: true })], // no profileId
    });
    const items = sectionsOf(analyze(f, SYS)).flatMap((s) => s.items);
    assert.ok(items.every((i) => i.links.length === 0), JSON.stringify(items.map((i) => i.links)));
    const g = facts({
      units: [unit("group", "G", { group: PG(1) })],
      sets: [{ key: "agg", ...S("agg", "G", { kind: "group", target: true }), id: PS(5) }, { key: "c1", ...S("c1", "Same", { target: true }), id: PS(2) }, { key: "c2", ...S("c2", "Same", { target: true }), id: PS(2) }],
      groups: [group(PG(1), "G", { agg: "agg", comps: ["c1", "c2"] })],
    });
    assert.equal(sectionsOf(analyze(g, SYS))[0].items[0].links.length, 2);
  });

  await test("grants reader: the profile Id comes with the permission set, and sets and groups keep their full Ids", async () => {
    const org = bigOrg();
    const f = await readGrants(org.api(), userPick, { kind: "system", api: "PermissionsViewSetup", label: "View Setup" }, { now: NOW });
    for (const u of f.units) {
      if (u.kind === "group") assert.match(u.groupId, /^0PG[A-Za-z0-9]{15}$/);
      else assert.match(f.sets[u.setId15].id, /^0PS[A-Za-z0-9]{15}$/);
    }
    const all = Object.values(f.sets);
    assert.ok(all.every((s) => "profileId" in s));
    assert.ok(all.filter((s) => s.kind !== "profile").every((s) => s.profileId === null));
  });

  await test("grants: API names in lists and the copy text drop the leading Permissions; the data keeps the full name", () => {
    assert.equal(systemApiShort("PermissionsExportReport"), "ExportReport");
    assert.equal(systemApiShort("PermissionsViewAllData"), "ViewAllData");
    assert.equal(systemApiShort("Permissions"), "Permissions", "nothing left to show: keep it");
    assert.equal(systemApiShort("MyPermissionsThing__c"), "MyPermissionsThing__c");
    assert.equal(fieldApiShort("Account.Rating", "Account"), "Rating");
    assert.equal(fieldApiShort("Account.Rating", "Contact"), "Account.Rating", "another object: keep the object");
    assert.equal(fieldApiShort("Account.", "Account"), "Account.");
    const sys = systemItems({ fields: [{ name: "PermissionsExportReport", label: "Export Reports", type: "boolean" }] });
    assert.equal(sys[0].api, "PermissionsExportReport", "the data keeps the full API name");
    const spec = { kind: "system", api: "PermissionsExportReport", label: "Export Reports" };
    assert.match(copyText(analyze(facts({}), spec), {}), /Permission: Export Reports \(system permission, API name ExportReport\)/);
    assert.equal(analyze(facts({}), spec).spec.api, "PermissionsExportReport");
  });

  await test("grants: typing 'rating' lists Rating first and Operating Hours last; word starts beat other matches; both names still match", () => {
    const items = [
      { api: "Account.OperatingHours", label: "Operating Hours" },
      { api: "Account.Rating", label: "Rating" },
      { api: "Account.CustomerRating__c", label: "Customer Priority" },
      { api: "Account.Score__c", label: "Account Rating" },
      { api: "Account.Rating2__c", label: "Rating Level" },
      { api: "Account.Narrating__c", label: "Narrating" },
    ];
    const out = matchItems(items, "rating").items.map((i) => i.label);
    assert.deepEqual(out, ["Rating", "Rating Level", "Account Rating", "Customer Priority", "Narrating", "Operating Hours"], out.join(" | "));
    assert.equal(matchItems(items, "rating").total, 6, "other substring matches are still listed");
    const sys = [
      { api: "PermissionsViewAllData", label: "View All Data" }, { api: "PermissionsExportReport", label: "Export Reports" },
      { api: "PermissionsReportBuilder", label: "Create and Customize Reports" }, { api: "PermissionsXreportx", label: "Zzz" },
    ];
    assert.deepEqual(matchItems(sys, "report").items.map((i) => i.api), ["PermissionsReportBuilder", "PermissionsExportReport", "PermissionsXreportx"]);
    assert.deepEqual(matchItems(sys, "exportreport").items.map((i) => i.api), ["PermissionsExportReport"], "the short API name matches");
    assert.deepEqual(matchItems(sys, "PermissionsExportReport").items.map((i) => i.api), ["PermissionsExportReport"], "the full API name matches too");
    assert.deepEqual(matchItems(sys, "builder report").items.map((i) => i.api), ["PermissionsReportBuilder"]);
    assert.equal(matchItems(sys, "").total, 4);
  });

  await test("grants page: links open in a new tab safely, only on a validated host; a typed-over search box hides the answer and Find without a new read", () => {
    const js = read(ext("tools/who-grants/who-grants.js"));
    assert.match(js, /target: "_blank", rel: "noopener noreferrer", "aria-label": l\.label/);
    assert.ok(/LINK_HOST = !DEMO && HOST && isSalesforceHost\(HOST\)/.test(js), "no links in demo mode, and only for a Salesforce host");
    assert.ok(js.includes("setupUrl(LINK_HOST"), "the address comes from the pure function");
    assert.ok(/\$\("#find"\)\.disabled = [^;]*anyDirty\(\)/.test(js), "Find is disabled while a box is typed over");
    assert.ok(/\$\("#results"\)\.hidden = !state\.facts \|\| anyDirty\(\)/.test(js));
    assert.ok(/addEventListener\("blur", leave\)/.test(js) && /e\.key === "Escape"\) leave\(\)/.test(js));
    const leave = js.slice(js.indexOf("function leave()"), js.indexOf("c.open = "));
    assert.ok(/onClear\?\.\(\)/.test(leave) && !/run\(|readGrants|clearResult/.test(leave), "leaving does not read again; only an emptied box clears the choice");
    const sync = js.slice(js.indexOf("function syncView()"), js.indexOf("// ---------- the answer"));
    assert.ok(!/state\.run\+\+|readGrants|run\(/.test(sync), "showing the answer again never starts a read or drops one in flight");
  });

  // ===== the reader =====

  await test("grants reader: it asks the org for its newest API version for itself, and the shared default stays", async () => {
    const org = bigOrg();
    const api = org.api();
    assert.equal(api.apiVersion, API_VERSION);
    await useNewestVersion(api);
    assert.equal(api.apiVersion, "68.0");
    assert.equal(new SfApi({ apiHost: "x", sessionId: "S" }).apiVersion, API_VERSION, "a new client still starts at the shared default");
    await readGrants(api, userPick, { kind: "system", api: "PermissionsViewSetup", label: "View Setup" }, { now: NOW });
    assert.ok(org.log.filter((l) => l.includes("/query/")).every((l) => l.startsWith("/services/data/v68.0/")), "every read uses the newest version");
  });

  await test("grants reader: when the version list cannot be read, the default version is used", async () => {
    const org = bigOrg({ failVersions: true });
    const api = org.api();
    const facts1 = await readGrants(api, userPick, { kind: "system", api: "PermissionsViewSetup", label: "View Setup" }, { now: NOW });
    assert.equal(api.apiVersion, API_VERSION);
    assert.equal(facts1.apiVersion, API_VERSION);
    assert.ok(org.log.filter((l) => l.includes("/query/")).every((l) => l.startsWith(`/services/data/v${API_VERSION}/`)));
  });

  const VIEW_SETUP = { kind: "system", api: "PermissionsViewSetup", label: "View Setup and Configuration" };

  await test("grants reader: a system permission from the profile, a direct set, a group (muting in MutingPermissionSet), session and expired sets", async () => {
    const org = bigOrg();
    const f = await readGrants(org.api(), userPick, VIEW_SETUP, { now: NOW });
    assert.deepEqual(f.problems, []);
    assert.deepEqual(f.units.map((u) => [u.kind, u.label, u.status]), [
      ["profile", "Standard Sales", "active"], ["set", "Direct Set", "active"], ["set", "Expired Set", "expired"], ["set", "Session Set", "needsActivation"], ["group", "Sales Ops", "active"],
    ]);
    const r = analyze(f, { ...VIEW_SETUP });
    assert.equal(r.answer, "yes");
    assert.deepEqual(r.gives.map((x) => x.label), ["Direct Set"]);
    assert.deepEqual(r.activation.map((x) => x.label), ["Session Set"]);
    assert.deepEqual(r.notActive.map((x) => x.label), ["Expired Set"]);
    assert.equal(r.muted.length, 1);
    assert.equal(r.muted[0].label, "Sales Ops");
    assert.deepEqual(r.muted[0].sets.map((s) => s.label), ["Inner A"]);
    assert.deepEqual(r.muted[0].mutingSets.map((s) => s.label), ["Sales Mute"]);
    assert.match(r.headline, /^Yes\. Casey Sample gets View Setup and Configuration from 1 place\.$/);
  });

  await test("grants reader: for a system permission only the needed Permissions column is asked for, and no object or field reads are made", async () => {
    const org = bigOrg();
    await readGrants(org.api(), userPick, VIEW_SETUP, { now: NOW });
    const setQueries = org.queries.filter((q) => /FROM PermissionSet WHERE/.test(q));
    assert.ok(setQueries.length >= 2);
    for (const q of setQueries) {
      const cols = q.slice(7, q.indexOf(" FROM "));
      assert.ok(cols.includes("PermissionsViewSetup"));
      assert.ok(!cols.includes("PermissionsApiEnabled"), "no other permission is read");
    }
    assert.ok(!org.queries.some((q) => /FROM (ObjectPermissions|FieldPermissions)/.test(q)));
    const mq = org.queries.find((q) => /FROM MutingPermissionSet/.test(q));
    assert.match(mq, /SELECT Id, DeveloperName, MasterLabel, PermissionsViewSetup FROM MutingPermissionSet/);
  });

  await test("grants reader: a system permission the muting object does not have means it cannot be muted there", async () => {
    const org = bigOrg({ describes: { MutingPermissionSet: { fields: ["Id", "DeveloperName", "MasterLabel", "PermissionsViewSetup"].map((name) => ({ name })) } } });
    org.sets.find((s) => s.Name === "Inner_A").PermissionsModifyAllData = true;
    org.sets.find((s) => s.Name === "Group_Agg").PermissionsModifyAllData = false;
    const f = await readGrants(org.api(), userPick, SYS, { now: NOW });
    const mq = org.queries.find((q) => /FROM MutingPermissionSet/.test(q));
    assert.ok(!mq.includes("PermissionsModifyAllData"), "the muting object has no such column, so it is not asked for");
    const r = analyze(f, SYS);
    assert.equal(r.muted.length, 0);
    assert.equal(r.notPassed.length, 1, "the group does not pass it on, and nothing explains it");
  });

  await test("grants reader: a muting permission set that is a PermissionSet of Type Muting is found too", async () => {
    const org = bigOrg();
    org.sets.push(setRec(9, "Type_Mute", { type: "Muting", perms: { PermissionsViewSetup: true } }));
    org.components = org.components.map((c) => (c.PermissionSetId === MU(1) ? { ...c, PermissionSetId: PS(9) } : c));
    const f = await readGrants(org.api(), userPick, VIEW_SETUP, { now: NOW });
    const r = analyze(f, VIEW_SETUP);
    assert.deepEqual(r.muted[0].mutingSets.map((s) => s.label), ["Type Mute"]);
    assert.ok(!org.queries.some((q) => /FROM MutingPermissionSet/.test(q)), "nothing is missing from PermissionSet, so no second read");
  });

  await test("grants reader: object permissions are read for every set, muting ids included, in chunks of 200", async () => {
    const org = makeOrg();
    const n = 450;
    for (let i = 1; i <= n; i++) {
      org.sets.push(setRec(i, `Set_${i}`));
      org.assignments.push(assign(i, i));
    }
    org.objPerms.push(objRow(PS(n), "Account", { PermissionsRead: true, PermissionsDelete: true }));
    const f = await readGrants(org.api(), userPick, { kind: "object", object: "Account", objectLabel: "Account" }, { now: NOW });
    const oq = org.queries.filter((q) => /FROM ObjectPermissions/.test(q));
    assert.equal(oq.length, 3, "450 sets are three reads");
    for (const q of oq) assert.match(q, /WHERE SobjectType = 'Account' AND ParentId IN \(/);
    assert.ok(oq.every((q) => (q.match(/'/g).length / 2) <= 201));
    assert.equal(analyze(f, OBJ("delete")).places, 1);
    assert.equal(f.units.length, n);
    const org2 = bigOrg();
    await readGrants(org2.api(), userPick, { kind: "object", object: "Account", objectLabel: "Account" }, { now: NOW });
    assert.ok(org2.queries.find((q) => /FROM ObjectPermissions/.test(q)).includes(`'${MU(1)}'`), "the muting set's Id is in the list");
  });

  await test("grants reader: an object answer for a group with muting, every level from one read", async () => {
    const org = bigOrg();
    const f = await readGrants(org.api(), userPick, { kind: "object", object: "Account", objectLabel: "Account" }, { now: NOW });
    const del = analyze(f, OBJ("delete"));
    assert.equal(del.answer, "muted");
    assert.deepEqual(del.muted[0].sets.map((s) => s.label), ["Inner A"]);
    assert.deepEqual(analyze(f, OBJ("edit")).gives.map((x) => x.label), ["Standard Sales"]);
    const read = analyze(f, OBJ("read"));
    assert.equal(read.places, 2, "profile and group");
    assert.deepEqual(read.gives.find((x) => x.kind === "group").via.map((v) => v.label), ["Inner A"]);
    assert.equal(org.queries.filter((q) => /FROM ObjectPermissions/.test(q)).length, 1);
  });

  await test("grants reader: a field reads FieldPermissions by field name, and the object's permissions for the note", async () => {
    const org = bigOrg();
    const spec = { kind: "field", object: "Account", objectLabel: "Account", field: "Account.Industry", fieldLabel: "Industry" };
    const f = await readGrants(org.api(), userPick, spec, { now: NOW });
    assert.ok(org.queries.some((q) => /FROM FieldPermissions WHERE SobjectType = 'Account' AND Field = 'Account.Industry' AND ParentId IN/.test(q)));
    const r = analyze(f, { ...spec, level: "edit" });
    assert.equal(r.answer, "yes");
    assert.equal(r.objectAccess.has, true, "the profile has Edit on the object");
    assert.equal(analyze(f, { ...spec, level: "read" }).answer, "yes");
  });

  await test("grants reader: View All Fields is asked for only when the API version's describe has it", async () => {
    const newer = bigOrg();
    await readGrants(newer.api(), userPick, { kind: "field", object: "Account", objectLabel: "Account", field: "Account.Industry" }, { now: NOW });
    assert.ok(newer.queries.find((q) => /FROM ObjectPermissions/.test(q)).includes("PermissionsViewAllFields"));
    assert.ok(newer.queries.find((q) => /FROM PermissionSet WHERE Id IN/.test(q)).includes("PermissionsViewAllFieldsGlobal"));
    const older = bigOrg({ versions: ["62.0"] });
    const f = await readGrants(older.api(), userPick, { kind: "field", object: "Account", objectLabel: "Account", field: "Account.Industry" }, { now: NOW });
    assert.ok(!older.queries.find((q) => /FROM ObjectPermissions/.test(q)).includes("PermissionsViewAllFields"));
    assert.ok(!older.queries.find((q) => /FROM PermissionSet WHERE Id IN/.test(q)).includes("PermissionsViewAllFieldsGlobal"));
    assert.deepEqual(f.problems, []);
    assert.ok(!f.notes.some((n) => /View All Fields/.test(n)), "the version list was read, so an org on an old version simply has no View All Fields: nothing to hedge");
  });

  await test("grants reader: an old API version without ExpirationDate, IsActive and IsRevoked still reads, and says so", async () => {
    const org = bigOrg({ columnVersion: "57.0" });
    const f = await readGrants(org.api(), userPick, VIEW_SETUP, { now: NOW });
    const aq = org.queries.find((q) => /FROM PermissionSetAssignment/.test(q));
    assert.ok(!/ExpirationDate|IsActive|IsRevoked/.test(aq), aq);
    assert.ok(f.notes.some((n) => /expiry, revoked, active/.test(n)));
    assert.equal(f.units.find((u) => u.label === "Session Set").status, "needsActivation", "a session-based set is still not counted");
    assert.equal(analyze(f, VIEW_SETUP).places, 2, "without expiry data an ended assignment cannot be told apart, and the note says so");
  });

  // ===== every permission the page can ask about, end to end (the fake org refuses duplicate and unlisted columns) =====

  await test("grants reader: the fake org refuses a column named twice and a column its describe does not list", async () => {
    const org = makeOrg();
    await assert.rejects(() => org.api().query("SELECT Id, Id FROM PermissionSet WHERE Id IN ('x')"), /duplicate field selected/);
    await assert.rejects(() => org.api().query("SELECT Id, PermissionsNotThere FROM PermissionSet WHERE Id IN ('x')"), /No such column/);
    const small = makeOrg({ describes: { PermissionSet: { fields: [{ name: "Id" }, { name: "Name" }] } } });
    await assert.rejects(() => small.api().query("SELECT Id, Label FROM PermissionSet WHERE Id IN ('x')"), /No such column 'Label'/);
  });

  for (const [api, label, field] of [["PermissionsModifyAllData", "Modify All Data", "modifyAllData"], ["PermissionsViewAllData", "View All Data", "viewAllData"], ["PermissionsViewAllFieldsGlobal", "View All Fields (Global)", "viewAllFieldsGlobal"]]) {
    await test(`grants reader: ${label} end to end, from a profile and from a group with a muting permission set, with no failed read`, async () => {
      const spec = { kind: "system", api, label };
      const org = makeOrg({
        sets: [
          setRec(1, "X00e000000000001", { profile: "Standard Sales", label: "Standard Sales", perms: { [api]: true } }),
          setRec(3, "Inner_A", { perms: { [api]: true } }),
          setRec(5, "Group_Agg", { type: "Group", groupId: PG(1) }),
        ],
        groups: [{ Id: PG(1), DeveloperName: "Sales_Ops", MasterLabel: "Sales Ops", NamespacePrefix: null, Status: "Updated", HasActivationRequired: false }],
        components: [{ PermissionSetGroupId: PG(1), PermissionSetId: PS(3) }, { PermissionSetGroupId: PG(1), PermissionSetId: MU(1) }],
        muting: [{ Id: MU(1), DeveloperName: "Sales_Mute", MasterLabel: "Sales Mute", PermissionsViewSetup: false, PermissionsViewAllData: false, PermissionsModifyAllData: false, PermissionsViewAllFieldsGlobal: false, [api]: true }],
        assignments: [assign(1, 1), assign(3, 5, { group: PG(1) })],
      });
      const f = await readGrants(org.api(), userPick, spec, { now: NOW });
      assert.deepEqual(f.problems, [], "no 400: every SELECT names each column once");
      for (const q of org.queries) {
        const cols = q.slice(7, q.indexOf(" FROM ")).split(", ");
        assert.equal(new Set(cols).size, cols.length, q);
      }
      const r = analyze(f, spec);
      assert.equal(r.answer, "yes");
      assert.deepEqual(r.gives.map((x) => x.label), ["Standard Sales"]);
      assert.deepEqual(r.muted.map((x) => x.label), ["Sales Ops"]);
      assert.deepEqual(r.muted[0].mutingSets.map((x) => x.label), ["Sales Mute"]);
      assert.equal(f.sets[PS(1).slice(0, 15)].sys[field], true);
    });
  }

  await test("grants reader: asking every kind and level reads without a problem on the newest and an older API version", async () => {
    const specs = [
      ...["PermissionsModifyAllData", "PermissionsViewAllData", "PermissionsViewAllFieldsGlobal", "PermissionsViewSetup", "PermissionsApiEnabled"].map((api) => ({ kind: "system", api, label: api })),
      { kind: "object", object: "Account", objectLabel: "Account" },
      { kind: "field", object: "Account", objectLabel: "Account", field: "Account.Industry", fieldLabel: "Industry" },
    ];
    for (const versions of [["68.0"], ["62.0"]]) {
      for (const spec of specs) {
        const org = bigOrg({ versions });
        let f;
        try {
          f = await readGrants(org.api(), userPick, spec, { now: NOW });
        } catch (e) {
          assert.fail(`${versions[0]} ${spec.api || spec.kind}: ${e.message}`);
        }
        // An older version has no View All Fields (Global) column at all, so it cannot be asked about there.
        const levels = spec.kind === "object" ? OBJECT_LEVELS : spec.kind === "field" ? FIELD_LEVELS : [{ key: undefined }];
        if (!(versions[0] === "62.0" && spec.api === "PermissionsViewAllFieldsGlobal")) assert.deepEqual(f.problems, [], `${versions[0]} ${spec.api || spec.kind}`);
        for (const l of levels) {
          const r = analyze(f, { ...spec, level: l.key });
          assert.ok(["yes", "no", "muted", "notWorking", "unsure"].includes(r.answer), `${spec.api || spec.kind} ${l.key}`);
          assert.ok(sectionsOf(r) && copyText(r, {}));
        }
      }
    }
  });

  await test("grants reader: expired, revoked and inactive assignments and an expiry in the future", async () => {
    const org = bigOrg();
    org.sets.push(setRec(10, "Revoked_Set", { perms: { PermissionsViewSetup: true } }), setRec(11, "Off_Set", { perms: { PermissionsViewSetup: true } }), setRec(12, "Later_Set", { perms: { PermissionsViewSetup: true } }));
    org.assignments.push(assign(10, 10, { revoked: true }), assign(11, 11, { active: false }), assign(12, 12, { expires: "2026-12-31T00:00:00.000+0000" }));
    const f = await readGrants(org.api(), userPick, VIEW_SETUP, { now: NOW });
    const status = Object.fromEntries(f.units.map((u) => [u.label, u.status]));
    assert.deepEqual([status["Revoked Set"], status["Off Set"], status["Later Set"], status["Expired Set"]], ["revoked", "inactive", "active", "expired"]);
    const r = analyze(f, VIEW_SETUP);
    assert.deepEqual(r.gives.map((x) => x.label), ["Direct Set", "Later Set"]);
    assert.equal(r.gives[1].expires, "2026-12-31T00:00:00.000+0000");
    assert.deepEqual(r.notActive.map((x) => x.why.code).sort(), ["expired", "inactive", "revoked"]);
  });

  await test("grants reader: a group whose parts cannot be read is hedged, never a confident answer", async () => {
    const org = bigOrg({ fail: { PermissionSetGroupComponent: true } });
    const f = await readGrants(org.api(), userPick, VIEW_SETUP, { now: NOW });
    assert.ok(f.problems.some((p) => /inside the user's permission set groups could not be read/.test(p.text) && /PermissionSetGroupComponent is down/.test(p.raw)));
    assert.equal(f.groups[PG(1)].componentsRead, false);
    const r = analyze(f, VIEW_SETUP);
    assert.equal(r.answer, "yes", "the direct set still gives it");
    assert.match(r.headline, /Some access could not be checked/);
    assert.equal(r.notSure.length, 1);
    const none = bigOrg({ fail: { PermissionSetGroupComponent: true } });
    none.assignments = none.assignments.filter((a) => a.PermissionSetGroupId);
    const g = analyze(await readGrants(none.api(), userPick, VIEW_SETUP, { now: NOW }), VIEW_SETUP);
    assert.equal(g.answer, "unsure");
    assert.ok(!/not given anywhere/.test(g.headline));
  });

  await test("grants reader: unreadable group details, permission sets or object access become problems with the raw text, and the answer is hedged", async () => {
    for (const [fail, spec, re] of [
      ["PermissionSetGroup", VIEW_SETUP, /details of the user's permission set groups/],
      ["PermissionSet", VIEW_SETUP, /permission sets assigned to the user/],
      ["ObjectPermissions", { kind: "object", object: "Account", objectLabel: "Account" }, /Access to the object Account could not be read/],
      ["FieldPermissions", { kind: "field", object: "Account", objectLabel: "Account", field: "Account.Industry", fieldLabel: "Industry" }, /Access to the field Industry could not be read/],
    ]) {
      const org = bigOrg({ fail: { [fail]: true } });
      const f = await readGrants(org.api(), userPick, spec, { now: NOW });
      assert.ok(f.problems.some((p) => re.test(p.text) && p.raw.includes(fail)), `${fail}: ${JSON.stringify(f.problems.map((p) => p.text))}`);
      const r = analyze(f, { ...spec, level: spec.kind === "system" ? undefined : "read" });
      assert.notEqual(r.answer, "no", `${fail}: no confident No`);
      assert.ok(!/not given anywhere/.test(r.headline), fail);
    }
  });

  await test("grants reader: only the user and the assignments are fatal", async () => {
    await assert.rejects(() => readGrants(makeOrg({ users: [] }).api(), userPick, VIEW_SETUP), /could not be found/);
    await assert.rejects(() => readGrants(makeOrg({ fail: { User: true } }).api(), userPick, VIEW_SETUP), /User is down/);
    await assert.rejects(() => readGrants(makeOrg({ fail: { PermissionSetAssignment: true } }).api(), userPick, VIEW_SETUP), /PermissionSetAssignment is down/);
    const ok = await readGrants(makeOrg({ fail: { PermissionSet: true, PermissionSetGroup: true, ObjectPermissions: true } }).api(), userPick, VIEW_SETUP);
    assert.equal(ok.units.length, 0);
  });

  await test("grants reader: a describe that cannot be read falls back to the columns every version has", async () => {
    const org = bigOrg({ fail: { "describe:PermissionSetAssignment": true, "describe:PermissionSet": true, "describe:PermissionSetGroup": true, "describe:MutingPermissionSet": true } });
    const f = await readGrants(org.api(), userPick, VIEW_SETUP, { now: NOW });
    assert.ok(f.units.length >= 4);
    assert.ok(analyze(f, VIEW_SETUP).places >= 1);
  });

  await test("grants reader: a name that does not look right is refused before any call, so nothing can be injected", async () => {
    const org = bigOrg();
    for (const spec of [
      { kind: "system", api: "PermissionsX' OR Id != '" }, { kind: "object", object: "Account' --" }, { kind: "field", object: "Account", field: "Account.Industry'" },
      { kind: "field", object: "Account", field: "Contact.Email" }, { kind: "other" },
    ]) await assert.rejects(() => readGrants(org.api(), userPick, spec), /does not look right/);
    await assert.rejects(() => readGrants(org.api(), { id: "x' OR 1=1" }, VIEW_SETUP), /user does not look right/);
    assert.equal(org.log.length, 0);
  });

  await test("grants reader: the picker lists come from describe, once each", async () => {
    const org = makeOrg({
      describes: {
        PermissionSet: { fields: [{ name: "PermissionsApiEnabled", label: "API Enabled", type: "boolean" }] },
        ObjectPermissions: { fields: [{ name: "SobjectType", picklistValues: [{ value: "Account", label: "Account" }] }] },
        FieldPermissions: { fields: [{ name: "SobjectType", picklistValues: [{ value: "Account", label: "Account" }] }, { name: "Field", picklistValues: [{ value: "Account.Industry", label: "Industry" }] }] },
      },
    });
    const api = org.api();
    assert.deepEqual((await readSystemList(api)).map((i) => i.api), ["PermissionsApiEnabled"]);
    assert.deepEqual((await readObjectList(api)).map((i) => i.api), ["Account"]);
    const fd = await readFieldDescribe(api);
    await readFieldDescribe(api);
    assert.deepEqual(fieldItems(fd, "Account").map((i) => i.api), ["Account.Industry"]);
    assert.equal(org.log.filter((l) => l.includes("FieldPermissions")).length, 1, "cached");
  });

  // ===== a stale answer must not win (the page's rule, tested on the pieces it uses) =====

  await test("grants page: a late answer is dropped and changing the user or the permission clears the old one (checked in the page code)", () => {
    const js = read(ext("tools/who-grants/who-grants.js"));
    assert.ok(js.includes("if (token !== state.run) return;"));
    assert.ok(/function clearResult\(\) \{\s*state\.run\+\+;/.test(js), "clearResult invalidates an answer still being read");
    for (const re of [/onPick: \(u\) => \{ state\.user = u; clearResult\(\)/, /onPick: \(i\) => \{ state\.system = i; clearResult\(\)/, /state\.field = f; clearResult\(\)/]) assert.match(js, re);
    assert.ok(/state\.object = i;[\s\S]{0,200}clearResult\(\)/.test(js));
    assert.ok(/\$\("#level"\)\.addEventListener\("change"[\s\S]{0,200}renderResult\(\)/.test(js), "a level change redraws without reading");
    assert.equal((js.match(/addEventListener\("keydown"/g) || []).length, 1, "one combo helper, not four copies");
    assert.ok(/function makeCombo/.test(js) && (js.match(/= makeCombo\(\{/g) || []).length === 4);
  });

  // ===== the demo =====

  await test("grants demo: synthetic org covers profile, direct, group via inner set, muting, session, expired, implied, nothing, and a field without object access", () => {
    const m = demo();
    const casey = m.users.find((u) => u.name === "Casey Sample");
    const riley = m.users.find((u) => u.name === "Riley Sample");
    const jordan = m.users.find((u) => u.name === "Jordan Sample");
    const run1 = (u, spec) => analyze(factsFromModel(m, u.id, spec), spec);

    const del = run1(casey, { kind: "object", object: "Account", objectLabel: "Account", level: "delete" });
    assert.equal(del.headline, "Yes. Casey Sample gets Delete on Account from 2 places.");
    assert.deepEqual(del.gives.map((x) => [x.kind, x.label]), [["set", "Account Cleanup"], ["group", "Cleanup Crew"]]);
    assert.deepEqual(del.gives[1].via.map((v) => v.label), ["Account Cleanup"], "the same set is direct and inside a group");
    assert.deepEqual(del.muted.map((x) => x.label), ["Sales Operations"]);
    assert.deepEqual(del.muted[0].sets.map((s) => s.label), ["Sales Deleters"]);
    assert.deepEqual(del.activation.map((x) => x.label), ["Support Escalation"]);
    assert.deepEqual(del.notActive.map((x) => x.label), ["Quarter End Access"]);
    assert.deepEqual(sectionsOf(del).map((s) => s.title), ["Gives it", "Removed by muting", "Needs session activation", "Not active"]);

    const opp = run1(casey, { kind: "object", object: "Opportunity", objectLabel: "Opportunity", level: "read" });
    assert.equal(opp.headline, "Yes. Casey Sample gets Read on Opportunity from 1 place.");
    assert.deepEqual(opp.implied.map((x) => x.reasons), [["View All Data"]]);

    const rev = run1(casey, { kind: "field", object: "Account", objectLabel: "Account", field: "Account.AnnualRevenue", fieldLabel: "Annual Revenue", level: "read" });
    assert.deepEqual(rev.implied.map((x) => x.label), ["Field Auditor"]);
    const ind = run1(casey, { kind: "field", object: "Account", objectLabel: "Account", field: "Account.Industry", fieldLabel: "Industry", level: "edit" });
    assert.equal(ind.answer, "yes");
    assert.deepEqual(ind.gives.find((x) => x.kind === "group" && x.label === "Sales Operations").via.map((v) => v.label), ["Sales Data Editors"]);

    const mute = run1(riley, { kind: "object", object: "Account", objectLabel: "Account", level: "delete" });
    assert.equal(mute.answer, "muted");
    assert.equal(run1(riley, VIEW_SETUP).headline, "No. Riley Sample does not get View Setup and Configuration: not given anywhere.");
    const amount = run1(riley, { kind: "field", object: "Opportunity", objectLabel: "Opportunity", field: "Opportunity.Amount", fieldLabel: "Amount", level: "read" });
    assert.equal(amount.answer, "notWorking");

    const j = run1(jordan, { kind: "object", object: "Account", objectLabel: "Account", level: "delete" });
    assert.equal(j.inactiveUser, true);
    assert.deepEqual(j.implied.map((x) => x.reasons), [["Modify All Data"]]);
    assert.equal(run1(jordan, VIEW_SETUP).answer, "unsure", "the group is Outdated");
    assert.ok(m.hints.length >= 5);
    assert.ok(m.objects.length && m.systemPermissions.length && m.fields.Account.length);
  });

  await test("grants demo: the sample is synthetic (example.com, made-up Ids, no tokens)", () => {
    const text = read(ext("samples/who_grants_demo.json"));
    for (const e of text.match(/[\w.+-]+@[\w.-]+/g) || []) assert.ok(/@example\.com$/.test(e), e);
    assert.ok(!/00D[A-Za-z0-9]{12,15}!|Bearer|sessionId|access_token/.test(text));
    for (const u of demo().users) assert.ok(/^005\d{12}$/.test(u.id), u.id);
    const ids = text.match(/\b0[A-Za-z0-9]{2}[A-Za-z0-9]{12,15}\b/g) || [];
    assert.deepEqual(ids.filter((i) => /^(0PS|0PG|0QM|00e)/.test(i)), [], "no real-looking permission set, group or profile Ids");
  });

  // ===== registration, files and the read-only guards =====

  await test("grants: registered in the tool list, with the exact feedback label in the code and in both issue forms", () => {
    const last = TOOLS.find((t) => t.id === "who-grants");
    assert.equal(last.page, "tools/who-grants/who-grants.html");
    assert.equal(last.title, "Where does a user get this permission?");
    assert.equal(last.description, "Find every profile, permission set and group that gives a user one permission");
    assert.equal(FEEDBACK_TOOLS.grants, "Where does a user get this permission? (extension)");
    for (const f of ["bug.yml", "enhancement.yml"]) {
      const y = read(path.join(here, "../..", ".github/ISSUE_TEMPLATE", f)).replace(/\r\n/g, "\n");
      assert.ok(y.includes("- Error Tracer: read a debug log (extension)\n        - Where does a user get this permission? (extension)\n        - Search the Setup Audit Trail (extension)\n"), f);
    }
    const js = read(ext("tools/who-grants/who-grants.js"));
    assert.ok(js.includes("FEEDBACK_TOOLS.grants"));
    const html = read(ext("tools/who-grants/who-grants.html"));
    assert.ok(html.includes("<title>Where does a user get this permission?</title>"));
    assert.ok(html.includes('id="feedback"') && html.includes("../../shared/pack.css") && html.includes("../../shared/user-picker.css"));
    const manifest = JSON.parse(read(ext("manifest.json")));
    assert.equal(manifest.version, "0.12.0");
    assert.ok(manifest.description.length <= 132, `manifest description is ${manifest.description.length} characters (Chrome allows 132)`);
    assert.match(manifest.description, /permission/);
    assert.match(read(ext("package.json")), /nine read-only tools/);
  });

  await test("grants: visible text avoids PSG and snapshot, and uses American 'license'", () => {
    const html = read(ext("tools/who-grants/who-grants.html"));
    const visible = [html, read(ext("tools/who-grants/who-grants.js")), read(ext("tools/who-grants/who-grants-logic.js")), JSON.stringify(demo().hints)].join("\n");
    assert.ok(!/\bPSGs?\b/.test(visible.replace(/\/\/.*$/gm, "")), "no PSG in visible text");
    assert.ok(!/snapshot/i.test(visible));
    assert.ok(!/licence/i.test(visible));
    assert.match(NOT_CHECKED_NOTE, /license/);
    assert.match(UNLISTED_FIELD_HINT, /not controlled by field permissions: everyone with access to the object sees it/);
  });

  await test("grants: the tool folder has exactly its files, and imports nothing from another tool", () => {
    const dir = ext("tools", "who-grants");
    assert.deepEqual(readdirSync(dir).sort(), ["who-grants-logic.js", "who-grants-read.js", "who-grants.css", "who-grants.html", "who-grants.js"]);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".js") || x.endsWith(".html") || x.endsWith(".css"))) {
      const text = read(path.join(dir, f));
      for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\bsrc=|\bhref=)["']([^"']+)["']/g)) {
        const ref = m[1];
        assert.ok(!/tools\/(?!who-grants)/.test(ref) && !/\.\.\/(?!\.\.\/shared)[a-z-]+\//.test(ref.replace(/^\.\.\/\.\.\/shared\//, "")) || ref.startsWith("../../shared/"), `${f} reaches ${ref}`);
      }
    }
  });

  // ===== a column that could not be asked for never gives a confident No (describe, version list, refused column) =====

  const REGION = { kind: "field", object: "Region__c", objectLabel: "Region", field: "Region__c.Code__c", fieldLabel: "Code" };
  const regionOrg = (extra = {}) => makeOrg({
    sets: [setRec(2, "Direct_Set", { perms: extra.setPerms || {} })],
    assignments: [assign(1, 2)],
    objPerms: [objRow(PS(2), "Region__c", { PermissionsRead: true, PermissionsEdit: true, PermissionsViewAllFields: extra.vaf !== false })],
    ...extra.org,
  });
  const lvl = (f, level) => analyze(f, { ...REGION, level });
  const VSET = { kind: "system", api: "PermissionsViewSetup", label: "View Setup" };

  await test("grants columns: nothing failed: a Read from View All Fields only is Yes, and Edit is a plain No", async () => {
    const f = await readGrants(regionOrg().api(), userPick, REGION, { now: NOW });
    assert.equal(lvl(f, "read").answer, "yes");
    assert.equal(lvl(f, "edit").answer, "no");
  });

  await test("grants columns: the ObjectPermissions describe fails: the column is tried anyway, so the answer is still right", async () => {
    const org = regionOrg({ org: { fail: { "describe:ObjectPermissions": true } } });
    const f = await readGrants(org.api(), userPick, REGION, { now: NOW });
    assert.ok(org.queries.some((q) => /FROM ObjectPermissions WHERE SobjectType/.test(q) && q.includes("PermissionsViewAllFields")));
    assert.equal(lvl(f, "read").answer, "yes");
    assert.equal(lvl(f, "edit").answer, "no");
  });

  await test("grants columns: describe fails and Salesforce refuses the column (old version, version list read): no View All Fields exists, a plain No", async () => {
    const org = regionOrg({ vaf: false, org: { fail: { "describe:ObjectPermissions": true }, columnVersion: "62.0" } });
    const f = await readGrants(org.api(), userPick, REGION, { now: NOW });
    assert.deepEqual(f.problems, []);
    assert.equal(lvl(f, "read").answer, "no");
  });

  await test("grants columns: the version list cannot be read: a Read that could come from View All Fields is Not sure, Edit stays No, with a reason", async () => {
    const org = regionOrg({ org: { failVersions: true, columnVersion: "62.0" } });
    const f = await readGrants(org.api(), userPick, REGION, { now: NOW });
    const read = lvl(f, "read");
    assert.equal(read.answer, "unsure");
    assert.match(read.headline, /^Not sure\. .*View All Fields on Region/);
    assert.match(read.headline, /could not be checked/);
    assert.ok(read.notSure.length >= 1);
    assert.ok(f.notes.some((n) => /View All Fields/.test(n)));
    const edit = lvl(f, "edit");
    assert.equal(edit.answer, "no", "field Edit is not covered by View All Fields");
    assert.match(edit.headline, /not given anywhere/);
    assert.equal(analyze(f, { kind: "object", object: "Region__c", objectLabel: "Region", level: "delete" }).answer, "no", "an object level is not affected either");
  });

  await test("grants columns: the describe fails and the version list too: refused column, still Not sure", async () => {
    const org = regionOrg({ org: { fail: { "describe:ObjectPermissions": true }, failVersions: true, columnVersion: "62.0" } });
    const f = await readGrants(org.api(), userPick, REGION, { now: NOW });
    assert.equal(lvl(f, "read").answer, "unsure");
    assert.equal(lvl(f, "edit").answer, "no");
  });

  await test("grants columns: View All Fields (Global): describe fails, column refused, version list fails, old version", async () => {
    const mk = (org) => regionOrg({ vaf: false, setPerms: { PermissionsViewAllFieldsGlobal: true }, org });
    const ok = await readGrants(mk({ fail: { "describe:PermissionSet": true } }).api(), userPick, REGION, { now: NOW });
    assert.equal(lvl(ok, "read").answer, "yes", "the column is tried anyway");
    const refused = await readGrants(mk({ fail: { "describe:PermissionSet": true }, columnVersion: "62.0" }).api(), userPick, REGION, { now: NOW });
    assert.equal(lvl(refused, "read").answer, "no", "this version has no such column");
    const unk = await readGrants(mk({ fail: { "describe:PermissionSet": true }, failVersions: true, columnVersion: "62.0" }).api(), userPick, REGION, { now: NOW });
    const read = lvl(unk, "read");
    assert.equal(read.answer, "unsure");
    assert.match(read.headline, /View All Fields \(all objects\)/);
    assert.equal(lvl(unk, "edit").answer, "no");
    const old = await readGrants(mk({ versions: ["62.0"] }).api(), userPick, REGION, { now: NOW });
    assert.equal(lvl(old, "read").answer, "no", "readable describe, readable version list, column absent: no hedge");
  });

  await test("grants columns: a system permission never hedges for View All Fields", async () => {
    const org = regionOrg({ org: { failVersions: true, columnVersion: "62.0" } });
    const f = await readGrants(org.api(), userPick, VSET, { now: NOW });
    assert.equal(analyze(f, VSET).answer, "no");
  });

  await test("grants columns: HasActivationRequired unreadable: tried anyway; refused with an unreadable version list: counted, with a hedge", async () => {
    const mk = (org) => makeOrg({ sets: [setRec(2, "Session_Like", { session: true, perms: { PermissionsViewSetup: true } })], assignments: [assign(1, 2)], ...org });
    const tried = analyze(await readGrants(mk({ fail: { "describe:PermissionSet": true } }).api(), userPick, VSET, { now: NOW }), VSET);
    assert.equal(tried.answer, "no");
    assert.equal(tried.activation.length, 1, "known session-based");
    const r = analyze(await readGrants(mk({ fail: { "describe:PermissionSet": true }, columnVersion: "30.0", failVersions: true }).api(), userPick, VSET, { now: NOW }), VSET);
    assert.equal(r.answer, "yes");
    assert.match(r.headline, /could not check whether permission set "Session Like" is session-based/);
    assert.ok(r.notes.some((n) => /session-based/.test(n)));
    const absent = analyze(await readGrants(mk({ fail: { "describe:PermissionSet": true }, columnVersion: "30.0" }).api(), userPick, VSET, { now: NOW }), VSET);
    assert.equal(absent.headline, "Yes. Casey Sample gets View Setup from 1 place.", "version list read: no such feature, nothing to hedge");
  });

  await test("grants columns: a group whose HasActivationRequired could not be read hedges the same way", async () => {
    const org = makeOrg({
      sets: [setRec(5, "Group_Agg", { type: "Group", groupId: PG(1), perms: { PermissionsViewSetup: true } })],
      groups: [{ Id: PG(1), DeveloperName: "G", MasterLabel: "G", NamespacePrefix: null, Status: "Updated", HasActivationRequired: false }],
      assignments: [assign(1, 5, { group: PG(1) })], failVersions: true, columnVersion: "30.0", fail: { "describe:PermissionSet": true, "describe:PermissionSetGroup": true },
    });
    const r = analyze(await readGrants(org.api(), userPick, VSET, { now: NOW }), VSET);
    assert.match(r.headline, /^Yes\. .* from 1 place\. We could not check whether permission set group "G" is session-based/);
  });

  // ===== ended assignments, a recalculating group =====

  await test("grants: every answer that is not Yes says an assignment that ended recently cannot be listed, also in the copied text", () => {
    const no = analyze(facts({ units: [unit("profile", "P", { set: "p1" })], sets: [S("p1", "P", { kind: "profile" })] }), SYS);
    assert.equal(no.answer, "no");
    assert.ok(no.notes.includes("If an assignment ended recently, Salesforce no longer shows it, so it cannot be listed here."));
    assert.ok(copyText(no, {}).includes("If an assignment ended recently"));
    const yes = analyze(facts({ units: [unit("profile", "P", { set: "p1" })], sets: [S("p1", "P", { kind: "profile", target: true })] }), SYS);
    assert.equal(yes.answer, "yes");
    assert.ok(!yes.notes.some((n) => /ended recently/.test(n)));
    const unsure = analyze(facts({ units: [], problems: [{ text: "x could not be read.", short: "x", blocks: true }] }), SYS);
    assert.equal(unsure.answer, "unsure");
    assert.ok(unsure.notes.some((n) => /ended recently/.test(n)));
  });

  await test("grants: a Yes whose only source is a group that is not Updated says it may change; with another source the note is enough", () => {
    const base = (extra = []) => facts({
      units: [unit("group", "Crew", { group: "g1" }), ...extra],
      sets: [S("agg", "Crew", { kind: "group", target: true }), S("c1", "Inner", { target: true }), S("d1", "Direct", { target: true })],
      groups: [group("g1", "Crew", { agg: "agg", comps: ["c1"], status: "Outdated" })],
    });
    const one = analyze(base(), SYS);
    assert.equal(one.answer, "yes");
    assert.equal(one.headline, 'Yes. Casey Sample gets Modify All Data from 1 place. The group "Crew" is still being recalculated, so this may change.');
    const two = analyze(base([unit("set", "Direct", { set: "d1" })]), SYS);
    assert.equal(two.headline, "Yes. Casey Sample gets Modify All Data from 2 places.");
    assert.ok(two.notes.some((n) => /still being recalculated/.test(n)));
    const updated = analyze(facts({ units: [unit("group", "Crew", { group: "g1" })], sets: [S("agg", "Crew", { kind: "group", target: true })], groups: [group("g1", "Crew", { agg: "agg", comps: [] })] }), SYS);
    assert.equal(updated.headline, "Yes. Casey Sample gets Modify All Data from 1 place.");
  });

  await test("grants: read-only guard (a) every call the reader makes is a GET with no body", async () => {
    const org = bigOrg();
    const api = org.api();
    await readSystemList(api);
    await readObjectList(api);
    await readFieldDescribe(api);
    await readGrants(api, userPick, VIEW_SETUP, { now: NOW });
    await readGrants(api, userPick, { kind: "field", object: "Account", objectLabel: "Account", field: "Account.Industry" }, { now: NOW });
    assert.ok(org.methods.length > 10);
    assert.ok(org.methods.every((m) => m === undefined), `methods used: ${[...new Set(org.methods)]}`);
  });

  await test("grants: read-only guard (b) no file of the tool can write, store, or put org text in as HTML", () => {
    const banned = ["method:", "method =", "\"POST\"", "'POST'", "\"PATCH\"", "'PATCH'", "\"PUT\"", "'PUT'", "\"DELETE\"", "'DELETE'", "composite", "/tooling", "XMLHttpRequest", "sendBeacon", "chrome.storage", "localStorage", "sessionStorage", "innerHTML", "insertAdjacentHTML", "outerHTML", "eval(", "new Function", "TraceFlag", "DebugLevel"];
    const dir = ext("tools", "who-grants");
    for (const f of readdirSync(dir)) {
      const text = read(path.join(dir, f));
      for (const b of banned) assert.ok(!text.includes(b), `${f} contains ${b}`);
      assert.ok(!/\bfetch\s*\([^)]*,/.test(text), `${f} calls fetch with options`);
      assert.ok(!/<script[^>]+src=["']https?:/i.test(text), `${f} loads a remote script`);
    }
    const js = read(path.join(dir, "who-grants.js"));
    assert.ok(!/api\.(post|put|patch|delete)\s*\(/i.test(js));
    assert.ok(!/\bapi\.(post|put|patch|delete|request)\b/.test(read(path.join(dir, "who-grants-read.js"))));
    assert.ok(js.includes("textContent"), "org text is set with textContent");
    assert.ok(!/sessionId/.test(read(path.join(dir, "who-grants-read.js")) + read(path.join(dir, "who-grants-logic.js"))), "the session id is never touched by the reader or the logic");
    assert.ok(/^\s*\/\/ Reads for/m.test(read(path.join(dir, "who-grants-read.js"))));
  });

  // ===== a failed read never turns a Yes into a No (issue 32, review round) =====

  const readProblem = { text: "Some permission sets assigned to the user could not be read.", short: "some permission sets could not be read", blocks: true, raw: "x" };

  await test("grants: when something needed could not be read, a muted group never gives a 'No.' headline", () => {
    const r = analyze({ ...mutedFacts(), problems: [readProblem] }, SYS);
    assert.equal(r.answer, "unsure");
    assert.equal(r.headline, 'Not sure. We could not check everything, so we cannot say whether Casey Sample gets Modify All Data: some permission sets could not be read. What we do know: the group "Sales Ops" would give it, but its muting permission set removes it.');
    // two muted groups
    const two = mutedFacts();
    two.units.push(unit("group", "Other Group", { group: "g2" }));
    two.sets.agg2 = S("agg2", "Other Group", { kind: "group", target: false });
    two.sets.c3 = S("c3", "Has It", { target: true });
    two.sets.m2 = S("m2", "Other Muting", { kind: "muting", target: true });
    two.groups.g2 = group("g2", "Other Group", { agg: "agg2", comps: ["c3"], mute: ["m2"] });
    assert.equal(analyze(two, SYS).answer, "muted", "all reads worked: still a plain No");
    const twoBad = analyze({ ...two, problems: [readProblem] }, SYS);
    assert.match(twoBad.headline, /^Not sure\..* What we do know: 2 groups would give it, but their muting permission sets remove it\.$/);
  });

  await test("grants: Not sure headline reasons are clauses, failed reads first, explained sources left out, cap 3 then 'and N more'", () => {
    const base = { text: "x", blocks: true, raw: "" };
    const regionRead = { ...base, short: "access to ZZ Region could not be read" };
    const mutingRead = { ...base, short: "the muting permission sets could not be read" };
    // a group whose insides were not read, no failed read: its own clause
    const inside = facts({ units: [unit("group", "ZZ WG Group", { group: "g1" })], sets: [S("agg", "ZZ WG Group", { kind: "group" })], groups: [group("g1", "ZZ WG Group", { agg: "agg", read: false })] });
    assert.match(analyze(inside, SYS).headline, /: we could not see inside the group "ZZ WG Group"\.$/);
    // with a failed read the group is not listed again, the read comes first and reads alone
    const both = analyze({ ...inside, problems: [mutingRead] }, SYS);
    assert.match(both.headline, /: the muting permission sets could not be read\.$/);
    assert.ok(!both.headline.includes("inside the group"), both.headline);
    assert.ok(both.notSure.length === 1, "the card is still there");
    // unreadable profile: a clause alone, and dropped when a read failed
    const prof = facts({ units: [unit("profile", "A", { set: "p1" })], sets: [] });
    assert.match(analyze(prof, SYS).headline, /: profile "A" could not be checked\.$/);
    assert.match(analyze({ ...prof, problems: [regionRead] }, SYS).headline, /: access to ZZ Region could not be read\.$/);
    // a recalculating group is its own reason and stays listed after the failed read
    const recalc = facts({ units: [unit("group", "G", { group: "g1" })], sets: [S("agg", "G", { kind: "group" }), S("c1", "C", { target: true })], groups: [group("g1", "G", { agg: "agg", comps: ["c1"], status: "Updating" })] });
    assert.match(analyze({ ...recalc, problems: [regionRead] }, SYS).headline, /: access to ZZ Region could not be read; the group "G" is still being recalculated\.$/);
    // cap of 3, then "and N more", failed reads first
    const many = facts({ units: ["A", "B", "C", "D"].map((n, i) => unit("profile", n, { set: `p${i}` })), sets: [] });
    assert.match(analyze(many, SYS).headline, /: profile "A" could not be checked; profile "B" could not be checked; profile "C" could not be checked; and 1 more\.$/);
    const twoReads = analyze({ ...many, problems: [regionRead, mutingRead] }, SYS);
    assert.match(twoReads.headline, /: access to ZZ Region could not be read; the muting permission sets could not be read\.$/);
    // the muted card hint does not contradict an unsure headline
    const hintOf = (r) => sectionsOf(r).find((s) => s.key === "muted").hint;
    assert.equal(hintOf(analyze({ ...mutedFacts(), problems: [readProblem] }, SYS)), "These would give it, but a muting permission set takes it away. They do not count, but something else might give it.");
    assert.equal(hintOf(analyze(mutedFacts(), SYS)), "These would give it, but a muting permission set takes it away. They do not count.");
  });

  await test("grants: no 'No.' headline of any branch while a needed read failed", () => {
    const cases = [
      mutedFacts(),
      facts({ units: [unit("group", "G", { group: "g1" })], sets: [S("agg", "G", { kind: "group" }), S("c1", "C", { target: true })], groups: [group("g1", "G", { agg: "agg", comps: ["c1"] })] }), // not passed on
      facts({ units: [unit("set", "Sess", { set: "d1", status: "needsActivation" })], sets: [S("d1", "Sess", { target: true })] }),
      facts({ units: [unit("set", "Old", { set: "d1", status: "expired", expires: "2026-01-01T00:00:00Z" })], sets: [S("d1", "Old", { target: true })] }),
      facts({ units: [unit("profile", "P", { set: "p1" })], sets: [S("p1", "P", { kind: "profile" })] }),
    ];
    for (const f of cases) {
      assert.ok(/^No\./.test(analyze(f, SYS).headline), "without a problem each is a plain No");
      const r = analyze({ ...f, problems: [readProblem] }, SYS);
      assert.equal(r.answer, "unsure", r.headline);
      assert.ok(r.headline.startsWith("Not sure."), r.headline);
    }
  });

  await test("grants: a field that is given but whose object access could not be read is a Yes that says so, never 'no Read on the object'", () => {
    const problem = { text: "Access to the object Account could not be read.", short: "access to Account could not be read", blocks: true, raw: "" };
    const profile = (obj) => ({ units: [unit("profile", "P", { set: "p1" })], sets: [S("p1", "P", { kind: "profile", obj, fld: { read: true, edit: true } })] });
    const r = analyze(facts({ ...profile(null), problems: [problem] }), FLD("read"));
    assert.equal(r.objectAccess.has, null);
    assert.match(r.headline, /^Yes\. Casey Sample gets Read on the field Industry \(Account\) from 1 place, but whether they have Read on Account could not be checked\./);
    // nothing listed at all (the permission set read failed): still not "no Read"
    assert.equal(analyze(facts({ units: [], sets: [], problems: [problem] }), FLD("read")).objectAccess.has, null);
    // the object list could not be read and no object row was found
    const nulls = analyze({ ...facts(profile({ read: false })), objectPermissionsApply: null }, FLD("read"));
    assert.equal(nulls.objectAccess.has, null);
    assert.match(nulls.headline, /^Yes\..*could not be checked\./);
    // everything read, no object access: still the plain No
    const no = analyze({ ...facts(profile({ read: false })), objectPermissionsApply: true }, FLD("read"));
    assert.match(no.headline, /^No\. Casey Sample is given .* but has no Read on Account, so it does not work\.$/);
    // an object that takes no object permissions is left as it was
    const task = analyze({ ...facts({ ...profile({ read: false }), problems: [problem] }), objectPermissionsApply: false }, FLD("read"));
    assert.equal(task.objectAccess.notControlled, true);
    assert.match(task.headline, /^Yes\. Casey Sample gets Read on the field Industry \(Account\) from 1 place\./);
    assert.ok(!/gets Read on the field Industry \(Account\) from 1 place, but/.test(task.headline));
  });

  // ---- the property: take one read away at a time, from an org where the truth is known ----
  const ALLOBJ = { PermissionsRead: true, PermissionsCreate: true, PermissionsEdit: true, PermissionsDelete: true, PermissionsViewAllRecords: true, PermissionsModifyAllRecords: true };
  const FLDALL = (parent) => ({ ParentId: parent, SobjectType: "Account", Field: "Account.Industry", PermissionsRead: true, PermissionsEdit: true });
  const VS = { PermissionsViewSetup: true };
  const GROUP1 = { Id: PG(1), DeveloperName: "Sales_Ops", MasterLabel: "Sales Ops", NamespacePrefix: null, Status: "Updated", HasActivationRequired: false };
  const MUTE1 = { Id: MU(1), DeveloperName: "Mute_All", MasterLabel: "Mute All", PermissionsViewSetup: true, PermissionsViewAllData: false, PermissionsModifyAllData: false, PermissionsViewAllFieldsGlobal: false };
  /** One org per situation (what the source holds, and where). */
  const SITUATIONS = {
    profile: () => ({ sets: [setRec(1, "X00e000000000001", { profile: "Standard Sales", label: "Standard Sales", perms: VS })], assignments: [assign(1, 1)], objPerms: [objRow(PS(1), "Account", ALLOBJ)], fldPerms: [FLDALL(PS(1))] }),
    direct: () => ({ sets: [setRec(2, "Direct_Set", { perms: VS })], assignments: [assign(1, 2)], objPerms: [objRow(PS(2), "Account", ALLOBJ)], fldPerms: [FLDALL(PS(2))] }),
    group: () => ({
      sets: [setRec(3, "Part_A", { perms: VS }), setRec(5, "Group_Agg", { type: "Group", groupId: PG(1), perms: VS })], groups: [GROUP1],
      components: [{ PermissionSetGroupId: PG(1), PermissionSetId: PS(3) }], assignments: [assign(1, 5, { group: PG(1) })],
      objPerms: [objRow(PS(3), "Account", ALLOBJ), objRow(PS(5), "Account", ALLOBJ)], fldPerms: [FLDALL(PS(3)), FLDALL(PS(5))],
    }),
    mutedGroupOnly: () => ({
      sets: [setRec(3, "Part_A", { perms: VS }), setRec(5, "Group_Agg", { type: "Group", groupId: PG(1) })], groups: [GROUP1],
      components: [{ PermissionSetGroupId: PG(1), PermissionSetId: PS(3) }, { PermissionSetGroupId: PG(1), PermissionSetId: MU(1) }], muting: [MUTE1],
      assignments: [assign(1, 5, { group: PG(1) })],
      objPerms: [objRow(PS(3), "Account", ALLOBJ), objRow(MU(1), "Account", ALLOBJ)], fldPerms: [FLDALL(PS(3)), FLDALL(MU(1))],
    }),
    sessionOnly: () => ({ sets: [setRec(6, "Session_Set", { type: "Session", session: true, perms: VS })], assignments: [assign(1, 6)], objPerms: [objRow(PS(6), "Account", ALLOBJ)], fldPerms: [FLDALL(PS(6))] }),
    endedRow: () => ({ sets: [setRec(7, "Expired_Set", { perms: VS })], assignments: [assign(1, 7, { expires: "2026-01-01T00:00:00.000+0000" })], objPerms: [objRow(PS(7), "Account", ALLOBJ)], fldPerms: [FLDALL(PS(7))] }),
    // the field is given by the profile; the object access only comes from a group (so the failed part matters)
    fieldObjectFromPart: () => ({
      sets: [setRec(1, "X00e000000000001", { profile: "Standard Sales", label: "Standard Sales" }), setRec(3, "Part_A"), setRec(5, "Group_Agg", { type: "Group", groupId: PG(1) })], groups: [GROUP1],
      components: [{ PermissionSetGroupId: PG(1), PermissionSetId: PS(3) }], assignments: [assign(1, 1), assign(2, 5, { group: PG(1) })],
      objPerms: [objRow(PS(3), "Account", ALLOBJ), objRow(PS(5), "Account", ALLOBJ)], fldPerms: [FLDALL(PS(1))],
    }),
    fieldNoObject: () => ({ sets: [setRec(1, "X00e000000000001", { profile: "Standard Sales", label: "Standard Sales" })], assignments: [assign(1, 1)], objPerms: [], fldPerms: [FLDALL(PS(1))] }),
    profileAndMutedGroup: () => {
      const a = SITUATIONS.profile();
      const b = SITUATIONS.mutedGroupOnly();
      return { sets: [...a.sets, ...b.sets], groups: b.groups, components: b.components, muting: b.muting, assignments: [assign(1, 1), assign(2, 5, { group: PG(1) })], objPerms: [...a.objPerms, ...b.objPerms], fldPerms: [...a.fldPerms, ...b.fldPerms] };
    },
  };
  // Every read taken away in turn (the user and the assignments are fatal on purpose and have their own tests).
  const takeAway = [
    ...["PermissionSet", "PermissionSetGroup", "PermissionSetGroupComponent", "MutingPermissionSet", "ObjectPermissions", "FieldPermissions"].map((n) => ({ name: `query ${n}`, apply: (cfg) => ({ ...cfg, fail: { [n]: true } }) })),
    ...["PermissionSetAssignment", "PermissionSet", "PermissionSetGroup", "MutingPermissionSet", "ObjectPermissions"].map((n) => ({ name: `describe ${n}`, apply: (cfg) => ({ ...cfg, fail: { [`describe:${n}`]: true } }) })),
    { name: "version list", apply: (cfg) => ({ ...cfg, failVersions: true }) },
    { name: "the groups' combined sets only", apply: (cfg) => ({ ...cfg, failIf: (q) => /FROM PermissionSet WHERE PermissionSetGroupId/.test(q) }) },
    ...[1, 2].map((k) => ({ name: `the PermissionSet-by-Id read number ${k}`, apply: (cfg) => { let n = 0; return { ...cfg, failIf: (q) => /FROM PermissionSet WHERE Id IN/.test(q) && ++n === k }; } })),
    { name: "two describes and the version list", apply: (cfg) => ({ ...cfg, fail: { "describe:PermissionSet": true, "describe:ObjectPermissions": true }, failVersions: true }) },
  ];
  const SPEC_BASES = [
    { spec: { kind: "system", api: "PermissionsViewSetup", label: "View Setup" }, levels: [undefined] },
    { spec: { kind: "object", object: "Account", objectLabel: "Account" }, levels: OBJECT_LEVELS.map((l) => l.key) },
    { spec: { kind: "field", object: "Account", objectLabel: "Account", field: "Account.Industry", fieldLabel: "Industry" }, levels: FIELD_LEVELS.map((l) => l.key) },
  ];

  await test("grants property: taking away any one read never turns a Yes into a No, and never turns a No into a Yes (every kind, level and situation)", async () => {
    let checked = 0;
    const seen = { yes: 0, notYes: 0, unsure: 0 };
    for (const [sitName, build] of Object.entries(SITUATIONS)) {
      for (const base of SPEC_BASES) {
        const baseFacts = await readGrants(makeOrg(build()).api(), userPick, base.spec, { now: NOW });
        for (const level of base.levels) {
          const spec = level ? { ...base.spec, level } : base.spec;
          const truth = analyze(baseFacts, spec);
          assert.ok(truth.answer !== "unsure", `${sitName}/${spec.kind}/${level}: the whole org must be readable: ${truth.headline}`);
          for (const t of takeAway) {
            const cfg = t.apply(build());
            const org = makeOrg(cfg);
            org.failIf = cfg.failIf;
            const got = analyze(await readGrants(org.api(), userPick, base.spec, { now: NOW }), spec);
            const where = `${sitName} / ${spec.kind} ${level || ""} / without ${t.name}: truth "${truth.headline}" -> "${got.headline}"`;
            checked++;
            if (truth.answer === "yes") {
              seen.yes++;
              assert.ok(!/^No[.]/.test(got.headline), where);
              assert.ok(!["no", "muted", "notWorking"].includes(got.answer), where);
            } else if (truth.answer === "notWorking") {
              // given, but no object access: a Yes is only acceptable when it says the object access could not be checked
              seen.notYes++;
              assert.ok(!/^Yes\./.test(got.headline) || /could not be checked\./.test(got.headline), where);
            } else {
              seen.notYes++;
              assert.ok(got.answer !== "yes" && !/^Yes/.test(got.headline), where);
            }
            if (got.answer === "unsure") seen.unsure++;
            // a plain "No" (not the object-access one) only when nothing needed failed to read
            if (/^No\./.test(got.headline) && got.answer !== "notWorking") assert.ok(!got.problems.some((p) => p.blocks) && got.notSure.length === 0, where);
          }
        }
      }
    }
    assert.ok(checked > 1200, `checked ${checked}`);
    assert.ok(seen.yes > 300 && seen.notYes > 300 && seen.unsure > 100, JSON.stringify(seen));
  });

  await test("grants: a muted group with a failed read elsewhere still says what muting does for the known part", async () => {
    const cfg = SITUATIONS.profileAndMutedGroup();
    const spec = { kind: "system", api: "PermissionsViewSetup", label: "View Setup" };
    const org = makeOrg({ ...cfg, fail: { PermissionSetGroupComponent: true } });
    const r = analyze(await readGrants(org.api(), userPick, spec, { now: NOW }), spec);
    assert.ok(!/^No[.]/.test(r.headline), r.headline);
    const only = SITUATIONS.mutedGroupOnly();
    assert.match(analyze(await readGrants(makeOrg(only).api(), userPick, spec, { now: NOW }), spec).headline, /^No\. Casey Sample does not get View Setup: the group "Sales Ops" would give it, but its muting permission set removes it\.$/);
  });

  await test("grants links: each named permission set appears once on a card, with its link; the copied text keeps the sentences", () => {
    const sets = (withIds) => [
      { key: "agg2", ...S("agg2", "Muted Group", { kind: "group", target: false }), id: withIds ? PS(6) : undefined },
      { key: "c2", ...S("c2", "Inner B", { target: true }), id: withIds ? PS(3) : undefined },
      { key: "m1", ...S("m1", "Mute It", { kind: "muting", target: true }), id: withIds ? MU(4) : undefined },
    ];
    const build = (withIds) => facts({ units: [unit("group", "Muted Group", { group: withIds ? PG(2) : "gx" })], sets: sets(withIds), groups: [group(withIds ? PG(2) : "gx", "Muted Group", { agg: "agg2", comps: ["c2"], mute: ["m1"] })] });
    const r = analyze(build(true), SYS);
    const item = sectionsOf(r).find((s) => s.key === "muted").items[0];
    assert.deepEqual(item.body.map((b) => (typeof b === "string" ? b : b.label)), ["Given inside the group by:", "Taken away by:"], "no sentence repeats the named sets");
    assert.deepEqual(item.body[0].items.map((i) => [i.text, i.link?.kind, i.link?.text]), [['"Inner B"', "set", "Open in Setup"]]);
    assert.deepEqual(item.body[1].items.map((i) => [i.text, i.link?.kind, i.link?.text]), [['"Mute It"', "muting", "Open the group in Setup"]]);
    assert.deepEqual(item.lines, ['This permission set inside the group gives it: "Inner B".', 'This muting permission set takes it away: "Mute It".']);
    const text = copyText(r, {});
    assert.ok(text.includes('This permission set inside the group gives it: "Inner B".') && !text.includes("Given inside the group by:"));
    // no Ids (demo, no host): the same words, no links
    const bare = sectionsOf(analyze(build(false), SYS)).find((s) => s.key === "muted").items[0];
    assert.deepEqual(bare.body.map((b) => (typeof b === "string" ? b : [b.label, b.items.map((i) => [i.text, i.link])])), [["Given inside the group by:", [['"Inner B"', null]]], ["Taken away by:", [['"Mute It"', null]]]]);
    // no sentence on the page names a set that a list names
    for (const sec of sectionsOf(analyze(build(true), SYS))) for (const it of sec.items) for (const b of it.body) if (typeof b === "string") assert.ok(!/"Inner B"|"Mute It"/.test(b), b);
  });

  await test("grants words: one permission set inside a group that does not pass it on is singular, two are plural", () => {
    assert.equal(notPassedText(["Inner A"]), 'The permission set "Inner A" inside the group has it, but the group does not pass it on. A likely reason is that muting removes something it depends on.');
    assert.match(notPassedText(["Inner A", "Inner B"]), /^The permission sets "Inner A" and "Inner B" inside the group have it, but the group/);
    assert.match(notPassedText(["A", "B", "C"]), /^The permission sets "A", "B" and "C" inside the group have it/);
    assert.equal(andList([]), "");
    assert.equal(andList(['"A"']), '"A"');
    assert.equal(andList(['"A"', '"B"']), '"A" and "B"');
    assert.equal(andList(['"A"', '"B"', '"C"']), '"A", "B" and "C"');
    const one = facts({
      units: [unit("group", "G", { group: "g1" })],
      sets: [S("agg", "G", { kind: "group" }), S("c1", "Inner A", { target: true })],
      groups: [group("g1", "G", { agg: "agg", comps: ["c1"] })],
    });
    const r = analyze(one, SYS);
    assert.equal(r.notPassed.length, 1);
    assert.match(copyText(r, {}), /The permission set "Inner A" inside the group has it, but the group does not pass it on\./);
    assert.ok(!/permission sets "Inner A"/.test(copyText(r, {})));
  });

  await test("grants words: sentences that join names agree with how many names there are", () => {
    // session-based and ended sources on the object a field needs: one and several
    const mk = (n, status) => facts({
      units: [unit("set", "Cols", { set: "d1" }), ...Array.from({ length: n }, (_, i) => unit("set", `Edit ${i}`, { set: `s${i}`, status }))],
      sets: [S("d1", "Cols", { fld: { read: true, edit: true } }), ...Array.from({ length: n }, (_, i) => S(`s${i}`, `Edit ${i}`, { obj: { read: true, edit: true } }))],
    });
    const sessOne = analyze(mk(1, "needsActivation"), FLD("edit")).objectAccess.text;
    const sessMany = analyze(mk(2, "needsActivation"), FLD("edit")).objectAccess.text;
    assert.match(sessOne, /gives it only after session activation/);
    assert.match(sessMany, /and permission set "Edit 0".* give it only after session activation|"Edit 0" and permission set "Edit 1" give it only after/);
    assert.ok(!/ gives it/.test(sessMany), sessMany);
    const endOne = analyze(mk(1, "expired"), FLD("edit")).objectAccess.text;
    const endMany = analyze(mk(2, "expired"), FLD("edit")).objectAccess.text;
    assert.match(endOne, /would give it, but the assignment has ended or is not active\./);
    assert.match(endMany, /would give it, but the assignments have ended or are not active\./);
    // two muting sets that list it while the group still has it
    const g = facts({
      units: [unit("group", "G", { group: "g1" })],
      sets: [S("agg", "G", { kind: "group", target: true }), S("c1", "C", { target: true }), S("m1", "M1", { kind: "muting", target: true }), S("m2", "M2", { kind: "muting", target: true })],
      groups: [group("g1", "G", { agg: "agg", comps: ["c1"], mute: ["m1", "m2"] })],
    });
    assert.ok(analyze(g, SYS).notes.some((n) => /^Muting permission sets in this group \("M1" and "M2"\) list it, but/.test(n)));
    const g1 = facts({
      units: [unit("group", "G", { group: "g1" })],
      sets: [S("agg", "G", { kind: "group", target: true }), S("c1", "C", { target: true }), S("m1", "M1", { kind: "muting", target: true })],
      groups: [group("g1", "G", { agg: "agg", comps: ["c1"], mute: ["m1"] })],
    });
    assert.ok(analyze(g1, SYS).notes.some((n) => /^A muting permission set in this group \("M1"\) lists it, but/.test(n)));
  });

  await test("grants errors: the three connect messages say what to do once", () => {
    const noSession = connectErrorWords(new SessionLookupError("No Salesforce session found for acme.lightning.force.com. Log in to the org in this browser, then try again."), "acme.lightning.force.com").message;
    const expired = connectErrorWords(Object.assign(new Error("Your Salesforce session has expired. Reload the Salesforce tab, then try again."), { status: 401 }), "h").message;
    const other = connectErrorWords(new TypeError("fetch failed"), "h");
    const notHost = connectErrorWords(new SessionLookupError("Not a Salesforce host: evil.com"), "evil.com").message;
    console.log(`    connect: ${noSession}
    connect: ${expired}
    connect: ${other.message}
    connect: ${notHost}`);
    assert.equal(noSession, "No Salesforce session found for acme.lightning.force.com. Log in to the org in this browser, then reload this page.");
    assert.equal(expired, "Your Salesforce session has expired. Reload the Salesforce tab (log in if it asks), then reload this page.");
    assert.equal(other.message, "Could not connect to the org. Check your connection, log in to the org in this browser, then reload this page.");
    assert.equal(other.raw, "fetch failed");
    assert.equal(notHost, "Not a Salesforce host: evil.com Log in to the org in this browser, then reload this page.");
    for (const m of [noSession, expired, other.message, notHost]) assert.equal(m.split("reload this page").length - 1, 1, m);
  });

  await test("grants errors: a TypeError and other raw errors show the fallback with the raw text folded; plain errors and the 401 keep their words", () => {
    const fb = "Could not connect to the org.";
    const te = errorWords(new TypeError("Cannot read properties of null (reading 'query')"), fb);
    assert.equal(te.message, fb);
    assert.match(te.raw, /Cannot read properties of null/);
    assert.deepEqual(errorWords(new PlainError("This user could not be found."), fb), { message: "This user could not be found.", raw: "" });
    const e401 = Object.assign(new Error("Your Salesforce session has expired."), { status: 401 });
    assert.deepEqual(errorWords(e401, fb), { message: "Your Salesforce session has expired.", raw: "" });
    const e400 = Object.assign(new Error("MALFORMED_QUERY: x"), { status: 400 });
    assert.deepEqual(errorWords(e400, fb), { message: fb, raw: "MALFORMED_QUERY: x" });
    assert.deepEqual(errorWords(new Error("some other"), fb), { message: fb, raw: "some other" });
    assert.deepEqual(errorWords(undefined, fb), { message: fb, raw: "" });
  });

  await test("grants errors: the reader's deliberate messages are PlainError, so they stay plain on the page", async () => {
    const org = makeOrg({});
    await assert.rejects(readGrants(org.api(), { id: "bad" }, { kind: "system", api: "PermissionsViewSetup" }), (e) => e instanceof PlainError && errorWords(e, "x").message === "That user does not look right. Pick the user again.");
    await assert.rejects(readGrants(org.api(), { id: USER }, { kind: "system", api: "nope" }), (e) => e instanceof PlainError);
  });

  await test("grants page: a failed connect hides the org-only parts, keeps the error visible and focuses nothing hidden", () => {
    const js = read(ext("tools/who-grants/who-grants.js"));
    const html = read(ext("tools/who-grants/who-grants.html"));
    const catchPart = js.slice(js.indexOf("state.api = null;"), js.indexOf("connect().then("));
    assert.match(catchPart, /state\.api = null/);
    assert.match(catchPart, /hideOrgParts\(\)/);
    assert.match(catchPart, /connectErrorWords\(e, HOST\)/);
    assert.match(catchPart, /#panelUser"\)\.hidden = true/);
    assert.match(catchPart, /#panelPermission"\)\.hidden = true/);
    assert.match(catchPart, /prepend\(\$\("#error"\)\)/);
    assert.match(catchPart, /return false/);
    assert.match(js, /connect\(\)\.then\(\(ok\) => \{ if \(ok\) combos\.user\.input\.focus\(\)/);
    assert.match(html, /id="panelUser"/);
    assert.match(html, /id="panelPermission"/);
    // the error box and its panel are not org-only; every box, the kinds and Find are
    assert.ok(!/id="error"[^>]*org-only|org-only[^>]*id="error"/.test(html));
    for (const id of ["userInput", "systemInput", "find"]) assert.ok(html.indexOf(`id="${id}"`) > 0);
    assert.match(html, /<div class="actions org-only">/);
    assert.match(html, /<p class="hint org-only">/);
  });

}
