// Reads for "Where does a user get this permission?". GET only: SOQL and describe through shared/sfconn.js.
//
// `readGrants(api, user, spec)` returns the facts that who-grants-logic.js `analyze` turns into an answer. Only the
// user and the assignments are fatal; every other read that fails becomes a plain `problem` (raw text kept for the
// folded Technical details) and the answer is hedged instead of saying "not given anywhere".
//
// The PermissionSet columns the org does not have (older API versions) are left out, judged from describe.

import { soqlString, chunk } from "../../shared/sfconn.js";
import { FACTS_SCHEMA, systemItems, objectItems, PlainError } from "./who-grants-logic.js";

const ID_CHUNK = 200;
const ID_RE = /^[A-Za-z0-9]{15,18}$/;
const OBJECT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/;
const SYSTEM_RE = /^Permissions[A-Za-z0-9_]+$/;

const id15 = (id) => String(id || "").slice(0, 15);
const idList = (ids) => ids.map(soqlString).join(", ");
const qualified = (ns, name) => (ns ? `${ns}__${name}` : name);
const bool = (v) => (typeof v === "boolean" ? v : null);
const rawOf = (e) => (e?.status === 401 ? "" : e?.message || String(e || ""));
const uniq = (a) => [...new Set(a.filter(Boolean))];

// ---------- the API version ----------

/** Use the org's newest API version for this page only (SfApi's shared default is left alone).
 * Falls back to the default when the list cannot be read. Safe to call more than once. */
export function useNewestVersion(api) {
  if (!api.newestVersionPromise) {
    api.newestVersionPromise = (async () => {
      try {
        const list = await api.get("/services/data/");
        const best = Math.max(...(Array.isArray(list) ? list : []).map((v) => Number(v?.version)).filter((n) => Number.isFinite(n)));
        if (Number.isFinite(best) && best > Number(api.apiVersion)) api.apiVersion = best.toFixed(1);
        if (!Number.isFinite(best)) api.versionListFailed = true;
      } catch {
        api.versionListFailed = true; // keep the default version, but a column it lacks may exist in the org's newer one
      }
      return api.apiVersion;
    })();
  }
  return api.newestVersionPromise;
}

/** The field names of an object, or null when its describe cannot be read. */
async function fieldNames(api, sobject) {
  try {
    const d = await api.describe(sobject);
    return new Set((d.fields || []).map((f) => f.name));
  } catch {
    return null;
  }
}

/**
 * Is an optional column there? "yes" (ask for it), "no" (this org's version does not have it: nothing to hedge) or
 * "unknown" (could not be told: the answer must not be a confident No). With a describe it is read from it, except that
 * when the version list could not be read the old version may be the only reason it is missing. Without a describe the
 * column is tried once on its own (`SELECT <column> FROM <object> LIMIT 1`) and left out if Salesforce refuses it.
 */
async function columnState(api, sobject, column, names, { probe = true } = {}) {
  const versionUnknown = api.versionListFailed === true;
  if (names) return names.has(column) ? "yes" : versionUnknown ? "unknown" : "no";
  if (!probe) return "unknown";
  try {
    await api.query(`SELECT ${column} FROM ${sobject} LIMIT 1`);
    return "yes";
  } catch (e) {
    const refused = /INVALID_FIELD|No such column/i.test(`${e?.errorCode || ""} ${e?.message || ""}`);
    return refused && !versionUnknown ? "no" : "unknown";
  }
}

// ---------- the pick lists (describe, cached by SfApi) ----------

export async function readSystemList(api) {
  await useNewestVersion(api);
  return systemItems(await api.describe("PermissionSet"));
}
export async function readObjectList(api) {
  await useNewestVersion(api);
  return objectItems(await api.describe("ObjectPermissions"));
}
/** The FieldPermissions describe: its Field picklist has the fields that field permissions control; its SobjectType the objects. */
export async function readFieldDescribe(api) {
  await useNewestVersion(api);
  return api.describe("FieldPermissions");
}

// ---------- one read of everything ----------

function setRecordToSet(r, spec, { muting = false, states = {} } = {}) {
  const type = r.Type || (muting ? "Muting" : "");
  const kind = muting || type === "Muting" ? "muting" : r.IsOwnedByProfile === true ? "profile" : type === "Group" ? "group" : "set";
  let target;
  if (spec.kind === "system") target = muting && !(spec.api in r) ? false : bool(r[spec.api]); // a muting set without that column cannot mute it
  return {
    id: r.Id, kind, type,
    label: kind === "profile" ? r.Profile?.Name || r.Label || r.Name : r.Label || r.MasterLabel || r.Name || r.DeveloperName,
    apiName: muting && !r.Name ? r.DeveloperName || "" : qualified(r.NamespacePrefix, r.Name || ""),
    activation: r.HasActivationRequired === true || type === "Session",
    // Not asked for and not known to be absent: whether it is session-based could not be told.
    activationUnknown: !muting && kind !== "profile" && type !== "Session" && typeof r.HasActivationRequired !== "boolean" && states.activation === "unknown",
    groupId: r.PermissionSetGroupId || null,
    profileId: kind === "profile" ? r.ProfileId || null : null, // for the link to the profile's Setup page
    sys: { target, viewAllData: bool(r.PermissionsViewAllData), modifyAllData: bool(r.PermissionsModifyAllData), viewAllFieldsGlobal: viewAllFieldsGlobalOf(r, muting, states) },
    obj: null, fld: null,
  };
}

// null = could not be told; false when the column is known not to exist in this org's version (a muting set is never asked).
function viewAllFieldsGlobalOf(r, muting, states) {
  if (typeof r.PermissionsViewAllFieldsGlobal === "boolean") return r.PermissionsViewAllFieldsGlobal;
  return !muting && states.global === "no" ? false : null;
}

const SET_BASE = ["Id", "Name", "Label", "Type", "IsOwnedByProfile", "NamespacePrefix", "Profile.Name"];

function setColumns(names, spec, states, extra = []) {
  const wanted = ["ProfileId", "HasActivationRequired", "PermissionsViewAllData", "PermissionsModifyAllData", "PermissionsViewAllFieldsGlobal", ...(spec.kind === "system" ? [spec.api] : []), ...extra];
  // The two optional columns are asked for only when they are there (describe, or tried alone when there is no describe);
  // without a describe the rest are the columns that every API version has.
  const have = (c) => {
    if (c === "HasActivationRequired") return states.activation === "yes";
    if (c === "PermissionsViewAllFieldsGlobal") return states.global === "yes";
    return names ? names.has(c) : c === "ProfileId" || c === "PermissionsViewAllData" || c === "PermissionsModifyAllData" || c === spec.api || extra.includes(c);
  };
  // A column named twice is a 400 ("duplicate field selected"): asking about View All Data, Modify All Data or View All
  // Fields (Global) names the same column in `wanted` twice, so the list is made unique.
  return [...new Set([...SET_BASE, ...wanted.filter(have)])];
}

function validate(spec) {
  if (spec.kind === "system" && SYSTEM_RE.test(spec.api || "")) return;
  if (spec.kind === "object" && OBJECT_RE.test(spec.object || "")) return;
  if (spec.kind === "field" && FIELD_RE.test(spec.field || "") && OBJECT_RE.test(spec.object || "") && spec.field.startsWith(`${spec.object}.`)) return;
  throw new PlainError("That permission name does not look right. Pick it again from the list.");
}

// IsActive on an assignment does not say whether a session-based set was activated (seen live: true for a session set
// nobody activated), so a session-based set or group always "needs activation" and is never counted as giving it.
function assignmentStatus(row, activation, now) {
  if (row.IsRevoked === true) return "revoked";
  if (row.ExpirationDate && new Date(row.ExpirationDate).getTime() <= now.getTime()) return "expired";
  if (activation) return "needsActivation";
  return row.IsActive === false ? "inactive" : "active";
}

/**
 * Read what the page needs to say where `user` gets the permission `spec`.
 * spec: {kind: "system", api, label} | {kind: "object", object, objectLabel} | {kind: "field", object, objectLabel, field, fieldLabel}.
 * (`level` is not needed here: every level is read, so the page can change it without reading again.)
 * `opts`: {progress(text), now (Date)}.
 */
export async function readGrants(api, user, spec, opts = {}) {
  validate(spec);
  if (!ID_RE.test(user?.id || "")) throw new PlainError("That user does not look right. Pick the user again.");
  const progress = opts.progress || (() => {});
  const now = opts.now || new Date();
  const problems = [];
  const notes = [];
  const problem = (text, e, { blocks = true, short } = {}) => problems.push({ text, raw: rawOf(e), blocks, short: short || text.replace(/\.$/, "") });

  await useNewestVersion(api);

  // 1. The user and the assignments (a failure here stops the read).
  progress("Reading the user and what is assigned to them…");
  const uq = await api.query(`SELECT Id, Name, Username, IsActive, ProfileId, Profile.Name FROM User WHERE Id = ${soqlString(user.id)}`);
  const u = uq.records[0];
  if (!u) throw new PlainError("This user could not be found. They may have been deleted. Search again.");

  const [aNames, setNames, groupNames, mutingNames] = await Promise.all([
    fieldNames(api, "PermissionSetAssignment"), fieldNames(api, "PermissionSet"), fieldNames(api, "PermissionSetGroup"), fieldNames(api, "MutingPermissionSet"),
  ]);
  // The optional columns: asked for only if they are there. A failed describe or version list is never read as "not there".
  const states = {
    activation: await columnState(api, "PermissionSet", "HasActivationRequired", setNames),
    global: await columnState(api, "PermissionSet", "PermissionsViewAllFieldsGlobal", setNames, { probe: spec.kind === "field" }),
    groupActivation: await columnState(api, "PermissionSetGroup", "HasActivationRequired", groupNames),
  };
  const aOpt = ["ExpirationDate", "IsActive", "IsRevoked"].filter((c) => (aNames ? aNames.has(c) : true));
  let rows;
  try {
    rows = (await api.query(`SELECT Id, PermissionSetId, PermissionSetGroupId${aOpt.map((c) => `, ${c}`).join("")} FROM PermissionSetAssignment WHERE AssigneeId = ${soqlString(u.Id)}`)).records;
  } catch (e) {
    if (aNames) throw e; // the columns are known to exist: a real failure
    rows = (await api.query(`SELECT Id, PermissionSetId, PermissionSetGroupId FROM PermissionSetAssignment WHERE AssigneeId = ${soqlString(u.Id)}`)).records;
    notes.push("Expiry dates and whether assignments are active could not be checked.");
  }
  if (aNames && aOpt.length < 3) notes.push("This org's API version does not show every detail of an assignment (expiry, revoked, active), so an assignment that has ended may still be counted.");

  // All rows of one set or group are kept (a person can have the same one twice, for example one expired and one active);
  // the best one is chosen once the set is known. A row with no usable set key stays too, as "could not be checked".
  const directRows = new Map(); // set id15 (or "row:<assignment id>") -> rows
  const groupRows = new Map(); // group id -> rows
  const push = (m, k, r) => { if (!m.has(k)) m.set(k, []); m.get(k).push(r); };
  for (const r of rows) {
    if (r.PermissionSetGroupId) push(groupRows, r.PermissionSetGroupId, r);
    else if (r.PermissionSetId && ID_RE.test(r.PermissionSetId)) push(directRows, id15(r.PermissionSetId), r);
    else push(directRows, `row:${r.Id || directRows.size}`, r);
  }

  const sets = new Map(); // id15 -> set
  const readSets = async (ids, label) => {
    const cols = setColumns(setNames, spec, states);
    for (const part of chunk(ids, ID_CHUNK)) {
      const { records } = await api.query(`SELECT ${cols.join(", ")} FROM PermissionSet WHERE Id IN (${idList(part)})`);
      for (const r of records) sets.set(id15(r.Id), setRecordToSet(r, spec, { states }));
    }
    return label;
  };

  // 2. Permission sets given directly, and the groups (their details, their parts and their combined permission set).
  progress("Reading permission sets and groups…");
  const groups = new Map(); // group id -> group
  const groupIds = [...groupRows.keys()].filter((g) => ID_RE.test(g));
  const directIds = [...directRows.keys()].filter((k) => !k.startsWith("row:"));
  const compRows = [];
  let directReadFailed = false; // the whole read failed: say so once, not once per assignment
  const tasks = [
    readSets(directIds).catch((e) => {
      directReadFailed = true;
      problem("Some permission sets assigned to the user could not be read.", e, { short: "some permission sets could not be read" });
    }),
  ];
  if (groupIds.length) {
    const gCols = ["Id", "DeveloperName", "MasterLabel", "NamespacePrefix", "Status", ...(states.groupActivation === "yes" ? ["HasActivationRequired"] : [])];
    tasks.push((async () => {
      try {
        for (const part of chunk(groupIds, ID_CHUNK)) {
          const { records } = await api.query(`SELECT ${gCols.join(", ")} FROM PermissionSetGroup WHERE Id IN (${idList(part)})`);
          for (const g of records) groups.set(g.Id, { id: g.Id, label: g.MasterLabel || g.DeveloperName, apiName: qualified(g.NamespacePrefix, g.DeveloperName || ""), status: g.Status || null, activation: g.HasActivationRequired === true });
        }
      } catch (e) {
        problem("The details of the user's permission set groups could not be read.", e, { short: "group details could not be read" });
      }
    })());
    tasks.push((async () => {
      try {
        for (const part of chunk(groupIds, ID_CHUNK)) {
          const { records } = await api.query(`SELECT PermissionSetGroupId, PermissionSetId FROM PermissionSetGroupComponent WHERE PermissionSetGroupId IN (${idList(part)})`);
          compRows.push(...records);
        }
        compRows.read = true;
      } catch (e) {
        problem("What is inside the user's permission set groups could not be read.", e, { short: "what is inside the groups could not be read" });
      }
    })());
    tasks.push((async () => {
      const cols = setColumns(setNames, spec, states, ["PermissionSetGroupId"]);
      try {
        for (const part of chunk(groupIds, ID_CHUNK)) {
          const { records } = await api.query(`SELECT ${cols.join(", ")} FROM PermissionSet WHERE PermissionSetGroupId IN (${idList(part)}) AND Type = 'Group'`);
          for (const r of records) sets.set(id15(r.Id), setRecordToSet(r, spec, { states }));
        }
      } catch (e) {
        problem("The combined permissions of the user's groups could not be read.", e, { short: "the groups' combined permissions could not be read" });
      }
    })());
  }
  await Promise.all(tasks);

  // 3. The permission sets inside the groups; ones that are not in PermissionSet are muting permission sets.
  const compIds = uniq(compRows.map((c) => c.PermissionSetId));
  const missing = compIds.filter((i) => !sets.has(id15(i)));
  if (missing.length) {
    progress("Reading what is inside the groups…");
    const inSets = missing.filter((i) => ID_RE.test(i));
    try {
      await readSets(inSets);
    } catch (e) {
      problem("Some permission sets inside the groups could not be read.", e, { short: "some permission sets inside the groups could not be read" });
    }
    const stillMissing = inSets.filter((i) => !sets.has(id15(i)));
    if (stillMissing.length) {
      const cols = ["Id", "DeveloperName", "MasterLabel", ...(spec.kind === "system" && mutingNames?.has(spec.api) ? [spec.api] : [])];
      try {
        for (const part of chunk(stillMissing, ID_CHUNK)) {
          const { records } = await api.query(`SELECT ${cols.join(", ")} FROM MutingPermissionSet WHERE Id IN (${idList(part)})`);
          for (const r of records) sets.set(id15(r.Id), setRecordToSet(r, spec, { muting: true }));
        }
      } catch (e) {
        problem("The muting permission sets of the groups could not be read.", e, { short: "the muting permission sets could not be read" });
      }
    }
  }

  let objectPermissionsApply = spec.kind === "system" ? undefined : null;

  // 4. Object or field permissions of every set we know (muting permission sets included).
  if (spec.kind !== "system") {
    progress("Reading the permissions…");
    const ids = [...sets.values()].map((s) => s.id).filter((i) => ID_RE.test(i));
    const opNames = await fieldNames(api, "ObjectPermissions");
    // View All Fields on an object only matters for a field's Read. "unknown" (not told) is never read as "no".
    const vafState = await columnState(api, "ObjectPermissions", "PermissionsViewAllFields", opNames, { probe: spec.kind === "field" });
    const viewAllFields = vafState === "yes";
    const vafOff = vafState === "no" ? false : null; // the value when the column is not asked
    // Does this object take object permissions at all? Task and Event, for example, are not in ObjectPermissions' object list.
    // null = could not be told (describe unreadable or without a list).
    let applies = null;
    try {
      const listed = objectItems(await api.describe("ObjectPermissions"));
      if (listed.length) applies = listed.some((i) => i.api === spec.object);
    } catch { /* stays null */ }
    objectPermissionsApply = applies;
    const blank = () => ({ read: false, create: false, edit: false, delete: false, viewAll: false, modifyAll: false, viewAllFields: viewAllFields ? false : vafOff });
    try {
      const cols = `ParentId, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords${viewAllFields ? ", PermissionsViewAllFields" : ""}`;
      const found = new Map();
      for (const part of chunk(ids, ID_CHUNK)) {
        const { records } = await api.query(`SELECT ${cols} FROM ObjectPermissions WHERE SobjectType = ${soqlString(spec.object)} AND ParentId IN (${idList(part)})`);
        for (const r of records) {
          found.set(id15(r.ParentId), {
            read: r.PermissionsRead === true, create: r.PermissionsCreate === true, edit: r.PermissionsEdit === true, delete: r.PermissionsDelete === true,
            viewAll: r.PermissionsViewAllRecords === true, modifyAll: r.PermissionsModifyAllRecords === true, viewAllFields: viewAllFields ? r.PermissionsViewAllFields === true : vafOff,
          });
        }
      }
      if (found.size) objectPermissionsApply = true; // a row exists, so the object takes object permissions
      for (const s of sets.values()) s.obj = found.get(id15(s.id)) || blank();
      if (vafState === "unknown" && spec.kind === "field") notes.push(`We could not check "View All Fields" on ${spec.objectLabel || spec.object}, so access that comes only from it may be missing.`);
    } catch (e) {
      problem(`Access to the object ${spec.objectLabel || spec.object} could not be read.`, e, { short: `access to ${spec.objectLabel || spec.object} could not be read` });
    }
    if (spec.kind === "field") {
      try {
        const found = new Map();
        for (const part of chunk(ids, ID_CHUNK)) {
          const { records } = await api.query(`SELECT ParentId, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE SobjectType = ${soqlString(spec.object)} AND Field = ${soqlString(spec.field)} AND ParentId IN (${idList(part)})`);
          for (const r of records) found.set(id15(r.ParentId), { read: r.PermissionsRead === true, edit: r.PermissionsEdit === true });
        }
        for (const s of sets.values()) s.fld = found.get(id15(s.id)) || { read: false, edit: false };
      } catch (e) {
        problem(`Access to the field ${spec.fieldLabel || spec.field} could not be read.`, e, { short: `access to the field ${spec.fieldLabel || spec.field} could not be read` });
      }
    }
  }

  // 5. Put it together.
  const rank = { active: 0, needsActivation: 1, inactive: 2, expired: 3, revoked: 4 };
  const later = (a, b) => (new Date(b.ExpirationDate || "9999-12-31").getTime() || 0) - (new Date(a.ExpirationDate || "9999-12-31").getTime() || 0);
  /** The best of several assignment rows: active beats session-based beats the rest; then the later (or no) expiry. */
  const bestRow = (list, activation) => list
    .map((row) => ({ row, status: assignmentStatus(row, activation, now) }))
    .sort((a, b) => rank[a.status] - rank[b.status] || later(a.row, b.row))[0];
  const units = [];
  for (const [key, list] of directRows) {
    const s = sets.get(key);
    const { row, status } = bestRow(list, s?.activation === true);
    if (!s) {
      // The read failed as a whole: the problem is listed once (and hedges the answer), not once per assignment.
      if (directReadFailed && !key.startsWith("row:")) continue;
      // Not returned although the read worked (for example the user may not see it): keep it, so it is never "not given anywhere".
      const noKey = key.startsWith("row:");
      units.push({
        kind: "set", unnamed: true, label: noKey ? "A permission set that could not be identified" : "A permission set you don't have permission to see", apiName: "",
        setId15: noKey ? null : key, status, expires: row.ExpirationDate || null, sessionBased: false,
      });
      continue;
    }
    units.push({
      kind: s.kind === "profile" ? "profile" : "set", label: s.label, apiName: s.kind === "profile" ? "" : s.apiName, setId15: key, status,
      expires: row.ExpirationDate || null, sessionBased: s.activation, activationUnknown: s.activationUnknown === true,
    });
  }
  const outGroups = {};
  for (const [gid, list] of groupRows) {
    const info = groups.get(gid);
    const agg = [...sets.values()].find((s) => s.kind === "group" && s.groupId && id15(s.groupId) === id15(gid));
    const own = compRows.filter((c) => id15(c.PermissionSetGroupId) === id15(gid)).map((c) => c.PermissionSetId);
    const parts = own.map((i) => sets.get(id15(i)));
    const complete = compRows.read === true && parts.every(Boolean);
    outGroups[gid] = {
      id: gid, label: info?.label || agg?.label || "A permission set group", apiName: info?.apiName || "", status: info?.status || null,
      aggregateId15: agg ? id15(agg.id) : null, componentsRead: complete,
      components: complete ? parts.filter((s) => s.kind !== "muting").map((s) => id15(s.id)) : [],
      muting: complete ? parts.filter((s) => s.kind === "muting").map((s) => id15(s.id)) : [],
    };
    const activation = info?.activation === true || agg?.activation === true;
    // Session-based or not could not be told when neither the group nor its combined set was read with the column.
    const known = (info && states.groupActivation === "yes") || (agg && typeof agg.activationUnknown === "boolean" && !agg.activationUnknown && states.activation === "yes") || (states.groupActivation === "no" && states.activation === "no");
    const activationUnknown = !activation && !known;
    const { row, status } = bestRow(list, activation);
    units.push({
      kind: "group", label: outGroups[gid].label, apiName: outGroups[gid].apiName, groupId: gid, status,
      expires: row.ExpirationDate || null, sessionBased: activation, activationUnknown,
    });
  }
  const order = { profile: 0, set: 1, group: 2 };
  units.sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));

  const outSets = {};
  for (const s of sets.values()) outSets[id15(s.id)] = s;

  return {
    schema: FACTS_SCHEMA,
    readAt: now.toISOString(),
    apiVersion: api.apiVersion,
    user: { id: u.Id, name: u.Name, username: u.Username, isActive: u.IsActive === true, profile: u.Profile?.Name || "" },
    spec: { kind: spec.kind, api: spec.api, object: spec.object, field: spec.field },
    units, sets: outSets, groups: outGroups, problems, notes, objectPermissionsApply,
  };
}
