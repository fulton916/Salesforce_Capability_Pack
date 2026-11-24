// Offline tests for "Where does a user get this permission?". Called from run_tests.mjs with its shared `test` function.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SfApi, API_VERSION } from "../shared/sfconn.js";
import { TOOLS } from "../shared/tool-list.js";
import { FEEDBACK_TOOLS } from "../shared/feedback.js";
import {
  analyze, sectionsOf, copyText, copyWithFallback, matchItems, systemItems, objectItems, fieldItems, factsFromModel, whenStamp, dateWords, expiryWords,
  permissionWords, NOT_CHECKED_NOTE, UNLISTED_FIELD_HINT, OBJECT_LEVELS, FIELD_LEVELS, KIND_CHOICES,
} from "../tools/who-grants/who-grants-logic.js";
import { readGrants, readSystemList, readObjectList, readFieldDescribe, useNewestVersion } from "../tools/who-grants/who-grants-read.js";

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
    sets: Object.fromEntries(sets.map((s) => [s.id, s])),
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
    PermissionSet: ["Id", "Name", "Label", "Type", "IsOwnedByProfile", "NamespacePrefix", "ProfileId", "PermissionSetGroupId", "HasActivationRequired", ...perms],
    PermissionSetAssignment: ["Id", "AssigneeId", "PermissionSetId", "PermissionSetGroupId", ...(v >= 61 ? ["ExpirationDate", "IsActive", "IsRevoked"] : [])],
    PermissionSetGroup: ["Id", "DeveloperName", "MasterLabel", "NamespacePrefix", "Status", "HasActivationRequired"],
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
    const m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.*))?$/.exec(q);
    assert.ok(m, `cannot read ${q}`);
    const cols = m[1].split(", ");
    const sobject = m[2];
    const where = m[3] || "";
    if (org.fail[sobject]) return err(500, `${sobject} is down`, "UNKNOWN_EXCEPTION");
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
    assert.match(lines[2], /these permission sets inside the group: "Inner A", "Inner B"/);
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
    assert.match(r.notPassed[0].text, /inside the group have it, but the group does not pass it on\. A likely reason is that muting removes something it depends on\./);
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
    assert.match(copyText(analyze(facts({}), SYS), {}), /Permission: Modify All Data \(system permission, API name PermissionsModifyAllData\)/);
    assert.match(copyText(analyze(facts({}), FLD("edit")), {}), /Permission: Edit on the field Industry of Account \(API name Account\.Industry\)/);
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
    assert.ok(org.log.filter((l) => l.includes("/query/")).every((l) => l.startsWith("/services/data/v62.0/")));
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
    assert.ok(f.notes.some((n) => /View All Fields/.test(n)), "the page says that part could not be checked");
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

  await test("grants: registered last in the tool list, with the exact feedback label in the code and in both issue forms", () => {
    const last = TOOLS[TOOLS.length - 1];
    assert.equal(last.id, "who-grants");
    assert.equal(last.page, "tools/who-grants/who-grants.html");
    assert.equal(last.title, "Where does a user get this permission?");
    assert.equal(last.description, "Find every profile, permission set and group that gives a user one permission");
    assert.equal(FEEDBACK_TOOLS.grants, "Where does a user get this permission? (extension)");
    for (const f of ["bug.yml", "enhancement.yml"]) {
      const y = read(path.join(here, "../..", ".github/ISSUE_TEMPLATE", f)).replace(/\r\n/g, "\n");
      assert.ok(y.includes("- Error Tracer: read a debug log (extension)\n        - Where does a user get this permission? (extension)\n"), f);
    }
    const js = read(ext("tools/who-grants/who-grants.js"));
    assert.ok(js.includes("FEEDBACK_TOOLS.grants"));
    const html = read(ext("tools/who-grants/who-grants.html"));
    assert.ok(html.includes("<title>Where does a user get this permission?</title>"));
    assert.ok(html.includes('id="feedback"') && html.includes("../../shared/pack.css") && html.includes("../../shared/user-picker.css"));
    const manifest = JSON.parse(read(ext("manifest.json")));
    assert.equal(manifest.version, "0.10.0");
    assert.ok(manifest.description.length <= 132, `manifest description is ${manifest.description.length} characters (Chrome allows 132)`);
    assert.match(manifest.description, /permission/);
    assert.match(read(ext("package.json")), /eight read-only tools/);
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
}
