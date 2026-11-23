// Read the facts for "Why can a user see this record?" from an org (schema "sf-record-access/1").
//
// Read-only: every call is a SELECT, a COUNT or a describe through SfApi. Nothing is written to the
// org and nothing is stored. Only the record itself may throw (with a plain message); every other area
// fails softly: it is left out, a plain sentence goes to `notes` and the raw error to `warnings`.

import { chunk, soqlString } from "../../shared/sfconn.js";
import { readRoles } from "../../shared/roles-read.js";
import { ACCESS_SCHEMA, to18, looksLikeId, exactFirst } from "./record-access-logic.js";

const ID_CHUNK = 200;
const MAX_DEPTH = 10; // levels of groups inside groups
const MAX_SHARE_ROWS = 2000;
const MAX_MEMBER_USERS = 3000; // members looked at when working out who is above a group's members
const MAX_MEMBER_GROUPS = 300; // groups inside groups
const IDENT = /^[A-Za-z0-9_]+$/;
// The account's sharing carries one access level for each kind of child record (AccountShare.CaseAccessLevel ...).
const ACCOUNT_CHILD_LEVEL = {
  Case: { share: "CaseAccessLevel", role: "CaseAccessForAccountOwner" },
  Opportunity: { share: "OpportunityAccessLevel", role: "OpportunityAccessForAccountOwner" },
  Contact: { share: "ContactAccessLevel", role: "ContactAccessForAccountOwner" },
};
const list = (ids) => ids.map(soqlString).join(", ");
const uniq = (a) => [...new Set(a.filter(Boolean))];

const isOff = (e) => /INVALID_TYPE|not supported|sObject type|INVALID_FIELD/i.test(`${e?.errorCode || ""} ${e?.message || ""}`);

/** Run `fn`; on failure leave `fallback`, put a plain sentence in notes and the raw error in warnings. */
async function soft(out, what, fn, fallback, { quietIfOff = false } = {}) {
  try {
    return await fn();
  } catch (e) {
    const w = typeof what === "function" ? what() : what;
    out.warnings.push(`${w}: ${e?.message || e}`);
    if (!(quietIfOff && isOff(e))) out.notes.push(`${w} could not be read, so it was not checked. Your user may not have permission to see it.`);
    return fallback;
  }
}

const blank = () => ({ notes: [], warnings: [] });

// ---------- retry a read that failed for a passing reason ----------

const RETRY_STATUS = new Set([500, 502, 503, 504]);
const RETRY_CODES = new Set(["SERVER_UNAVAILABLE"]); // only with a 5xx status (or none)

/** Is this failure one that is worth trying again (the network dropped, or Salesforce or a proxy was briefly unavailable)?
 *  A session that ran out (401), a bad request, no permission, no such thing and every query error are not. */
export function isTransient(e) {
  if (!e) return false;
  if (e.status === undefined || e.status === null) return !e.errorCode; // fetch itself failed: no answer at all
  if (e.status >= 400 && e.status < 500) return false; // any 4xx is never retried, whatever the errorCode
  return RETRY_STATUS.has(e.status) || RETRY_CODES.has(e.errorCode);
}

/** The same api, but each GET is tried again after a short wait when it failed for a passing reason: at most
 *  `delays.length` more tries (default two: 300 ms, then 1 s). Reads only, so trying again changes nothing in the org.
 *  `sleep` is injectable so tests do not wait. The caller's api object is left as it is. */
export function withRetry(api, { delays = [300, 1000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const wrapped = Object.create(api);
  wrapped.get = async (...args) => {
    for (let i = 0; ; i++) {
      try {
        return await api.get(...args);
      } catch (e) {
        if (i >= delays.length || !isTransient(e)) throw e;
        await sleep(delays[i]);
      }
    }
  };
  return wrapped;
}

// ---------- how many reads run at once, and what is kept for the page session ----------

/** How many requests may be in flight at once. Enough to overlap the waiting, few enough not to flood the org or the browser. */
export const MAX_IN_FLIGHT = 6;

/** The same api, but at most `max` GETs are on their way at once; the rest wait their turn (first come, first served).
 *  Only a single GET holds a place, never a whole query or chain, so waiting cannot deadlock. The caller's api object is left
 *  as it is. An api that is already limited is returned as it is. */
export function withLimit(api, max = MAX_IN_FLIGHT) {
  if (api.__limited) return api;
  const wrapped = Object.create(api);
  wrapped.__limited = true;
  const waiting = [];
  let active = 0;
  const release = () => { active--; const next = waiting.shift(); if (next) { active++; next(); } };
  wrapped.get = async (...args) => {
    if (active >= max) await new Promise((r) => waiting.push(r));
    else active++;
    try {
      return await api.get(...args);
    } finally {
      release();
    }
  };
  return wrapped;
}

/** What the page keeps between two Explains (in page memory only; nothing is stored anywhere). `org` holds the org-wide
 *  lists (roles, territories); `rec` holds the facts of one record and is emptied when another record is explained.
 *  Only reads that worked are kept: a failed read is forgotten at once, so the next Explain tries it again. */
export function createReadCache() {
  return { org: new Map(), rec: new Map(), recId: null, recAt: null, hits: 0 };
}

/** Clear the facts of the record (the org-wide lists stay). */
export function clearRecordFacts(cache) {
  cache.rec.clear();
  cache.recId = null;
  cache.recAt = null;
}

/** Run `load` once per key; later asks get the same answer (a copy, so a caller cannot change what is kept). */
async function remembered(cache, scope, key, load) {
  const store = cache[scope];
  if (!store.has(key)) {
    if (scope === "rec" && cache.recAt === null) cache.recAt = Date.now(); // when this record's facts were first read
    const p = (async () => load())(); // starts at once, so it takes its place in the queue in the order the caller started it
    p.catch(() => { if (store.get(key) === p) store.delete(key); }); // never keep a failure
    store.set(key, p);
  } else cache.hits++;
  return structuredClone(await store.get(key));
}

// ---------- the record ----------

/** Name of the share object and its two field names, from describe. null when the object has no share table. */
async function shareMeta(api, objectApi) {
  const shareName = /__c$/.test(objectApi) ? objectApi.replace(/__c$/, "__Share") : `${objectApi}Share`;
  try {
    const d = await api.describe(shareName);
    const names = new Set((d.fields || []).map((f) => f.name));
    const parentField = ["ParentId", `${objectApi}Id`].find((n) => names.has(n));
    const accessField = ["AccessLevel", `${objectApi}AccessLevel`].find((n) => names.has(n));
    if (!parentField || !accessField) return null;
    return { name: shareName, parentField, accessField };
  } catch {
    return null;
  }
}

async function describeById(api, id) {
  const prefix = id.slice(0, 3);
  const { sobjects = [] } = await api.describeGlobal();
  const o = sobjects.find((s) => s.keyPrefix === prefix);
  if (!o || !IDENT.test(o.name)) return null;
  const d = await api.describe(o.name);
  return { api: o.name, label: d.label || o.label || o.name, plural: d.labelPlural || o.labelPlural || d.label || o.name, describe: d, custom: !!(d.custom ?? o.custom) };
}

async function nameOf(api, obj, id) {
  const nf = obj.describe.fields.find((f) => f.nameField)?.name;
  if (!nf) return id;
  const { records } = await api.query(`SELECT ${nf} FROM ${obj.api} WHERE Id = ${soqlString(id)}`);
  return records[0]?.[nf] || id;
}

/** The record, its object and org-wide default. Throws a plain Error when the record cannot be found. */
export async function readRecordContext(api, recordId) {
  const out = blank();
  if (!looksLikeId(recordId)) throw new Error("That does not look like a record Id or a link to a record.");
  const id = to18(recordId);
  let obj;
  try {
    obj = await describeById(api, id);
  } catch (e) {
    if (e?.status === 401) throw e;
    throw new Error("Could not find out what kind of record this is. If you have been away a while, reload the Salesforce tab and try again.");
  }
  if (!obj) throw new Error("This looks like a record Id, but Salesforce does not know what kind of record it is. Check the link.");

  const owd = { internal: null, external: null };
  await soft(out, "The org-wide default", async () => {
    const { records } = await api.query(`SELECT InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE QualifiedApiName = ${soqlString(obj.api)}`);
    owd.internal = records[0]?.InternalSharingModel || null;
    owd.external = records[0]?.ExternalSharingModel || null;
  }, null);

  const fields = obj.describe.fields;
  const nameField = fields.find((f) => f.nameField)?.name;
  const hasOwner = fields.some((f) => f.name === "OwnerId");
  let parentField = null;
  // Tasks and events point to two records: "Related to" (WhatId) and the person they are about (WhoId).
  const isActivity = fields.some((f) => f.name === "WhatId") && fields.some((f) => f.name === "WhoId");
  if (isActivity) {
    parentField = "WhatId";
  } else if (owd.internal === "ControlledByParent" || !hasOwner) {
    const refs = fields.filter((f) => f.type === "reference" && (f.referenceTo || []).length === 1);
    parentField = (refs.find((f) => f.cascadeDelete) || refs.find((f) => f.name === "AccountId") || refs.find((f) => f.name === "ParentId"))?.name || null;
  }
  // Cases, Opportunities and Contacts also get access through their account (the account's own sharing).
  const acctField = ACCOUNT_CHILD_LEVEL[obj.api] && fields.some((f) => f.name === "AccountId") ? "AccountId" : null;
  const cols = ["Id", nameField, hasOwner ? "OwnerId" : null, parentField, acctField, isActivity ? "WhoId" : null].filter(Boolean);
  const { records } = await api.query(`SELECT ${uniq(cols).join(", ")} FROM ${obj.api} WHERE Id = ${soqlString(id)}`);
  const r = records[0];
  if (!r) throw new Error("Salesforce found no such record, or your own user cannot see it. Check the link.");

  const rec = {
    id: r.Id, object: obj.api, name: (nameField && r[nameField]) || r.Id, ownerId: null, ownerKind: null, ownerName: "", ownerRoleId: null,
    parentId: parentField ? r[parentField] || null : null, parentObject: null, parentObjectLabel: "", parentName: "",
    whoId: null, whoObjectLabel: "", whoName: "",
    accountId: acctField ? r[acctField] || null : null, accountName: "",
  };
  if (isActivity) {
    // With nothing in "Related to", the person is the only related record and counts as the parent.
    if (!rec.parentId && r.WhoId) rec.parentId = r.WhoId;
    else rec.whoId = r.WhoId || null;
  }
  if (hasOwner && r.OwnerId) {
    rec.ownerId = r.OwnerId;
    if (r.OwnerId.startsWith("005")) {
      rec.ownerKind = "user";
      await soft(out, "The owner", async () => {
        const { records: u } = await api.query(`SELECT Name, UserRoleId FROM User WHERE Id = ${soqlString(r.OwnerId)}`);
        rec.ownerName = u[0]?.Name || "";
        rec.ownerRoleId = u[0]?.UserRoleId || null;
      }, null);
    } else if (r.OwnerId.startsWith("00G")) {
      rec.ownerKind = "queue";
      await soft(out, "The owner queue", async () => {
        const { records: g } = await api.query(`SELECT Name FROM Group WHERE Id = ${soqlString(r.OwnerId)}`);
        rec.ownerName = g[0]?.Name || "";
      }, null);
    }
  }
  if (rec.parentId) {
    await soft(out, "The parent record", async () => {
      const po = await describeById(api, rec.parentId);
      if (!po) return;
      rec.parentObject = po.api;
      rec.parentObjectLabel = po.label;
      rec.parentName = await nameOf(api, po, rec.parentId);
    }, null);
  }
  if (rec.accountId) {
    await soft(out, "The account of the record", async () => {
      const { records: a } = await api.query(`SELECT Name FROM Account WHERE Id = ${soqlString(rec.accountId)}`);
      rec.accountName = a[0]?.Name || "";
    }, null);
  }
  if (rec.whoId) {
    await soft(out, "The person the record is about", async () => {
      const po = await describeById(api, rec.whoId);
      if (!po) return;
      rec.whoObjectLabel = po.label;
      rec.whoName = await nameOf(api, po, rec.whoId);
    }, null);
  }
  return {
    record: rec, owd,
    object: { api: obj.api, label: obj.label, plural: obj.plural, custom: obj.custom },
    notes: out.notes, warnings: out.warnings,
  };
}

// ---------- one user ----------

async function readSf(api, userId, recordId) {
  const { records } = await api.query(
    "SELECT RecordId, HasReadAccess, HasEditAccess, HasDeleteAccess, HasTransferAccess, HasAllAccess, MaxAccessLevel FROM UserRecordAccess " +
    `WHERE UserId = ${soqlString(userId)} AND RecordId = ${soqlString(recordId)}`
  );
  const r = records[0];
  if (!r) return null;
  return { read: r.HasReadAccess === true, edit: r.HasEditAccess === true, delete: r.HasDeleteAccess === true, transfer: r.HasTransferAccess === true, all: r.HasAllAccess === true, max: r.MaxAccessLevel || null };
}

/** Object permissions of the user over profile, permission sets and permission set groups (aggregate sets). */
async function readObjectSets(api, userId, objectApi) {
  const { records: psa } = await api.query(
    "SELECT PermissionSetId, PermissionSetGroupId, PermissionSet.Label, PermissionSet.Type, PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name, " +
    "PermissionSet.PermissionsViewAllData, PermissionSet.PermissionsModifyAllData " +
    `FROM PermissionSetAssignment WHERE AssigneeId = ${soqlString(userId)}`
  );
  // The group's own (aggregate) set already has muting applied. A component set of a group is not counted twice.
  const rows = psa.filter((r) => r.PermissionSet && !(r.PermissionSetGroupId && r.PermissionSet.Type !== "Group"));
  const groupNames = new Map();
  const groupIds = uniq(rows.map((r) => r.PermissionSetGroupId));
  for (const part of chunk(groupIds, ID_CHUNK)) {
    try {
      const { records } = await api.query(`SELECT Id, MasterLabel FROM PermissionSetGroup WHERE Id IN (${list(part)})`);
      for (const g of records) groupNames.set(g.Id, g.MasterLabel);
    } catch { /* the permission set label is used instead */ }
  }
  const sets = new Map();
  for (const r of rows) {
    const ps = r.PermissionSet;
    const kind = ps.IsOwnedByProfile ? "profile" : ps.Type === "Group" ? "group" : "permissionSet";
    const name = kind === "profile" ? ps.Profile?.Name || ps.Label : kind === "group" ? groupNames.get(r.PermissionSetGroupId) || ps.Label : ps.Label;
    sets.set(r.PermissionSetId, {
      id: r.PermissionSetId, kind, name: name || "A permission set",
      read: false, create: false, edit: false, delete: false, viewAll: false, modifyAll: false,
      viewAllData: ps.PermissionsViewAllData === true, modifyAllData: ps.PermissionsModifyAllData === true,
    });
  }
  const ids = [...sets.keys()];
  for (const part of chunk(ids, ID_CHUNK)) {
    const { records } = await api.query(
      "SELECT ParentId, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords " +
      `FROM ObjectPermissions WHERE SobjectType = ${soqlString(objectApi)} AND ParentId IN (${list(part)})`
    );
    for (const p of records) {
      const s = sets.get(p.ParentId);
      if (!s) continue;
      Object.assign(s, { read: p.PermissionsRead === true, create: p.PermissionsCreate === true, edit: p.PermissionsEdit === true, delete: p.PermissionsDelete === true, viewAll: p.PermissionsViewAllRecords === true, modifyAll: p.PermissionsModifyAllRecords === true });
    }
  }
  return { sets: [...sets.values()].map(({ id, ...s }) => s) };
}

const GROUP_FIELDS = "Id, Name, DeveloperName, Type, RelatedId, DoesIncludeBosses";
const toGroup = (g) => ({ id: g.Id, name: g.Name || g.DeveloperName || "", type: g.Type, relatedId: g.RelatedId || null, includeBosses: g.DoesIncludeBosses === true });

/** The groups that contain the user, working upward level by level: groups of the user, of their role
 *  (and the roles above it that include subordinates), of their territories; then groups of those groups.
 *  Returns {groups: Map id -> group, edges: [{groupId, memberId}]}. */
async function readGroupsAbove(api, userId, roleChain, terrChain) {
  const groups = new Map();
  const edges = [];
  const seeds = [];
  const relIds = uniq([...roleChain, ...terrChain]);
  for (const part of chunk(relIds, ID_CHUNK)) {
    const { records } = await api.query(
      `SELECT ${GROUP_FIELDS} FROM Group WHERE RelatedId IN (${list(part)}) AND Type IN ('Role', 'RoleAndSubordinates', 'RoleAndSubordinatesInternal', 'Territory', 'TerritoryAndSubordinates')`
    );
    for (const g of records) { groups.set(g.Id, toGroup(g)); seeds.push(g.Id); }
  }
  let frontier = [userId, ...seeds];
  const seen = new Set(frontier);
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next = [];
    for (const part of chunk(frontier, ID_CHUNK)) {
      const { records } = await api.query(`SELECT GroupId, UserOrGroupId FROM GroupMember WHERE UserOrGroupId IN (${list(part)})`);
      for (const m of records) {
        edges.push({ groupId: m.GroupId, memberId: m.UserOrGroupId });
        if (!seen.has(m.GroupId)) { seen.add(m.GroupId); next.push(m.GroupId); }
      }
    }
    const fresh = next.filter((id) => !groups.has(id));
    for (const part of chunk(fresh, ID_CHUNK)) {
      const { records } = await api.query(`SELECT ${GROUP_FIELDS} FROM Group WHERE Id IN (${list(part)})`);
      for (const g of records) groups.set(g.Id, toGroup(g));
    }
    frontier = next;
  }
  return { groups, edges };
}

/** Everything strictly below `id` in a parent map (id -> parentId), cycle-safe, including `id` itself. */
function withBelow(parentMap, id) {
  const kids = new Map();
  for (const [c, p] of parentMap) if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(c); }
  const out = new Set([id]);
  const stack = [id];
  while (stack.length) for (const c of kids.get(stack.pop()) || []) if (!out.has(c)) { out.add(c); stack.push(c); }
  return out;
}

/** Ids strictly above `id` in a parent map (nearest first), cycle-safe. */
function withAbove(parentMap, id) {
  const out = [];
  const seen = new Set([id]);
  let cur = parentMap.get(id);
  while (cur && !seen.has(cur)) { seen.add(cur); out.push(cur); cur = parentMap.get(cur); }
  return out;
}

/** For groups that give access to managers (and for a queue that owns the record): which roles the members
 *  have, going down through groups inside groups, role groups, role-and-subordinates groups and territory
 *  groups. Loops are safe. Returns {[groupId]: {roles: [{roleId, example, count}], users, capped}}.
 *  At most MAX_MEMBER_USERS members are looked at in total; `capped` says so. */
export async function readMemberRoles(api, targets, roleParent, terrParent, targetInfo = new Map()) {
  const children = new Map(); // group -> member ids
  const meta = new Map(); // group -> {type, relatedId}
  let capped = false;
  let frontier = targets.filter((t) => !targetInfo.has(t)); // territory groups have no member rows
  const seen = new Set(frontier);
  for (let depth = 0; frontier.length; depth++) {
    if (depth >= MAX_DEPTH || seen.size > MAX_MEMBER_GROUPS) { capped = true; break; }
    const next = [];
    for (const part of chunk(frontier, ID_CHUNK)) {
      const { records } = await api.query(`SELECT GroupId, UserOrGroupId FROM GroupMember WHERE GroupId IN (${list(part)})`);
      for (const m of records) {
        if (!children.has(m.GroupId)) children.set(m.GroupId, []);
        children.get(m.GroupId).push(m.UserOrGroupId);
        if (m.UserOrGroupId.startsWith("00G") && !seen.has(m.UserOrGroupId)) { seen.add(m.UserOrGroupId); next.push(m.UserOrGroupId); }
      }
    }
    for (const part of chunk(next, ID_CHUNK)) {
      const { records } = await api.query(`SELECT Id, Type, RelatedId FROM Group WHERE Id IN (${list(part)})`);
      for (const g of records) meta.set(g.Id, { type: g.Type, relatedId: g.RelatedId || null });
    }
    // Role and territory groups have no member rows: their members come from the role or territory.
    frontier = next.filter((id) => !/^(Role|Territory|Organization)/.test(meta.get(id)?.type || ""));
  }

  // Walk each target's tree. A territory group has no member rows: its members are the people assigned to the territory
  // (and, for "and below", to the territories under it). `targetInfo` says which targets are territory groups.
  const per = new Map(); // target -> {userIds, roleIds, terrIds}
  for (const t of targets) {
    const acc = { userIds: new Set(), roleIds: new Set(), terrIds: new Set() };
    const ti = targetInfo.get(t);
    if (ti?.relatedId && /^Territory/.test(ti.type)) {
      // The shared territory first, then each one above it (their people get the access too, so their managers do),
      // and for "and below" the ones under it. The order decides which member is named as the example.
      acc.terrIds.add(ti.relatedId);
      for (const r of withAbove(terrParent, ti.relatedId)) acc.terrIds.add(r);
      if (ti.type === "TerritoryAndSubordinates") for (const r of withBelow(terrParent, ti.relatedId)) acc.terrIds.add(r);
    }
    const visited = new Set();
    const stack = [t];
    while (stack.length) {
      const g = stack.pop();
      if (visited.has(g)) continue;
      visited.add(g);
      for (const m of children.get(g) || []) {
        if (m.startsWith("005")) { acc.userIds.add(m); continue; }
        const mm = meta.get(m);
        if (!mm) { stack.push(m); continue; }
        if (mm.type === "Role" && mm.relatedId) acc.roleIds.add(mm.relatedId);
        else if (/^RoleAndSubordinates/.test(mm.type) && mm.relatedId) for (const r of withBelow(roleParent, mm.relatedId)) acc.roleIds.add(r);
        else if (mm.type === "Territory" && mm.relatedId) acc.terrIds.add(mm.relatedId);
        else if (mm.type === "TerritoryAndSubordinates" && mm.relatedId) for (const r of withBelow(terrParent, mm.relatedId)) acc.terrIds.add(r);
        else if (mm.type === "Organization") continue;
        else stack.push(m);
      }
    }
    per.set(t, acc);
  }

  // Look the users up, once for all targets.
  const users = new Map(); // id -> {name, roleId}
  let budget = MAX_MEMBER_USERS;
  const take = (r) => { if (!users.has(r.Id)) users.set(r.Id, { name: r.Name, roleId: r.UserRoleId || null }); };
  const allUserIds = uniq([...per.values()].flatMap((a) => [...a.userIds]));
  for (const part of chunk(allUserIds, ID_CHUNK)) {
    const { records } = await api.query(`SELECT Id, Name, UserRoleId FROM User WHERE Id IN (${list(part)}) AND IsActive = true`);
    records.forEach(take);
  }
  const roleUsers = new Map(); // role id -> [{id, name}]
  const allRoleIds = uniq([...per.values()].flatMap((a) => [...a.roleIds]));
  for (const part of chunk(allRoleIds, ID_CHUNK)) {
    if (budget <= 0) { capped = true; break; }
    const { records } = await api.query(`SELECT Id, Name, UserRoleId FROM User WHERE UserRoleId IN (${list(part)}) AND IsActive = true LIMIT ${budget}`);
    if (records.length >= budget) capped = true;
    budget -= records.length;
    for (const r of records) { if (!roleUsers.has(r.UserRoleId)) roleUsers.set(r.UserRoleId, []); roleUsers.get(r.UserRoleId).push({ id: r.Id, name: r.Name }); }
  }
  const terrUsers = new Map(); // territory id -> [user id]
  const allTerrIds = uniq([...per.values()].flatMap((a) => [...a.terrIds]));
  for (const part of chunk(allTerrIds, ID_CHUNK)) {
    if (budget <= 0) { capped = true; break; }
    const { records } = await api.query(`SELECT UserId, Territory2Id FROM UserTerritory2Association WHERE Territory2Id IN (${list(part)}) LIMIT ${budget}`);
    if (records.length >= budget) capped = true;
    budget -= records.length;
    for (const r of records) { if (!terrUsers.has(r.Territory2Id)) terrUsers.set(r.Territory2Id, []); terrUsers.get(r.Territory2Id).push(r.UserId); }
  }
  const missing = uniq([...terrUsers.values()].flat()).filter((id) => !users.has(id));
  for (const part of chunk(missing, ID_CHUNK)) {
    const { records } = await api.query(`SELECT Id, Name, UserRoleId FROM User WHERE Id IN (${list(part)}) AND IsActive = true`);
    records.forEach(take);
  }

  const out = {};
  for (const [t, acc] of per) {
    const byRole = new Map(); // role id -> {roleId, example, count}
    const seenUsers = new Set();
    const addUser = (id, name, roleId, terrId) => {
      if (seenUsers.has(id) || !roleId) return;
      seenUsers.add(id);
      const e = byRole.get(roleId);
      if (e) e.count++; else byRole.set(roleId, { roleId, example: name, ...(terrId ? { terrId } : {}), count: 1 }); // terrId: where the example is assigned (territory groups)
    };
    for (const id of acc.userIds) { const u = users.get(id); if (u) addUser(id, u.name, u.roleId); }
    for (const r of acc.roleIds) for (const u of roleUsers.get(r) || []) addUser(u.id, u.name, r);
    for (const tid of acc.terrIds) for (const id of terrUsers.get(tid) || []) { const u = users.get(id); if (u) addUser(id, u.name, u.roleId, tid); }
    out[t] = { roles: [...byRole.values()], users: seenUsers.size, capped };
  }
  return out;
}

/** Search users by name or username, an exact match first. Wraps searchUsers (the list is sorted, and an exact
 *  name that fell outside the first 50 is added). */
export async function searchUsersExactFirst(api, text, searchUsers) {
  const res = await searchUsers(api, text);
  const t = String(text || "").trim();
  let users = res.users;
  if (t.length >= 2 && !users.some((u) => u.name.toLowerCase() === t.toLowerCase())) {
    try {
      const { records } = await api.query(`SELECT Id, Name, Username, IsActive, Profile.Name FROM User WHERE Name = ${soqlString(t)} LIMIT 5`);
      const extra = records.filter((r) => !users.some((u) => u.id === r.Id)).map((r) => ({ id: r.Id, name: r.Name, username: r.Username, isActive: r.IsActive === true, profile: r.Profile?.Name || "" }));
      users = [...extra, ...users];
    } catch { /* the plain search result is still good */ }
  }
  return { ...res, users: exactFirst(users, t) };
}

/** One user by Id (to put a user back after the page address changed). null when not found or the Id is not valid. */
export async function readUserById(api, id) {
  if (!/^[a-zA-Z0-9]{15,18}$/.test(String(id || ""))) return null;
  const { records } = await api.query(`SELECT Id, Name, Username, IsActive, Profile.Name FROM User WHERE Id = ${soqlString(id)} LIMIT 1`);
  const r = records[0];
  return r ? { id: r.Id, name: r.Name, username: r.Username, isActive: r.IsActive === true, profile: r.Profile?.Name || "" } : null;
}

function chainAbove(parentMap, id) {
  const out = [];
  const seen = new Set();
  let cur = id;
  while (cur && !seen.has(cur)) { seen.add(cur); out.push(cur); cur = parentMap.get(cur); }
  return out;
}

async function readTeamRole(api, objectApi, recordId, userId) {
  if (objectApi === "Account") {
    const { records } = await api.query(`SELECT TeamMemberRole FROM AccountTeamMember WHERE AccountId = ${soqlString(recordId)} AND UserId = ${soqlString(userId)}`);
    return records[0] ? records[0].TeamMemberRole || "Team member" : null;
  }
  if (objectApi === "Opportunity") {
    const { records } = await api.query(`SELECT TeamMemberRole FROM OpportunityTeamMember WHERE OpportunityId = ${soqlString(recordId)} AND UserId = ${soqlString(userId)}`);
    return records[0] ? records[0].TeamMemberRole || "Team member" : null;
  }
  if (objectApi === "Case") {
    const { records } = await api.query(`SELECT TeamRole.Name FROM CaseTeamMember WHERE ParentId = ${soqlString(recordId)} AND MemberId = ${soqlString(userId)}`);
    return records[0] ? records[0].TeamRole?.Name || "Team member" : null;
  }
  return null;
}

async function readChildCounts(api, recordId, userId) {
  const out = {};
  for (const o of ["Opportunity", "Case", "Contact"]) {
    try {
      out[o] = await api.count(`SELECT COUNT() FROM ${o} WHERE AccountId = ${soqlString(recordId)} AND OwnerId = ${soqlString(userId)}`);
    } catch { /* the object may not be on in this org */ }
  }
  return out;
}

/** The account behind a Case or Opportunity: its sharing rows with the level they give to the account's cases (or
 *  opportunities), and its owner with the level their role gives account owners. null when the record has no
 *  account or the object is neither. Rows that give "None" are left out (they give nothing). One share query,
 *  one account query, one role query; the share query and the owner query run together. `memo(key, load)` runs a
 *  read once per record (the page keeps what it read). */
async function readAccountAccess(api, rec, objectApi, out, memo) {
  const lv = ACCOUNT_CHILD_LEVEL[objectApi];
  if (!lv || !rec.accountId) return null;
  const acc = { id: rec.accountId, name: rec.accountName || "", rows: [], truncated: false, owner: null };
  const outRows = blank();
  const outOwner = blank();
  let ownerRowLevel = null;
  await Promise.all([
    soft(outRows, "The account's sharing rows", async () => {
      const r = await memo("acctRows", async () => {
        const { records } = await api.query(
          `SELECT UserOrGroupId, RowCause, ${lv.share} FROM AccountShare WHERE AccountId = ${soqlString(rec.accountId)} LIMIT ${MAX_SHARE_ROWS}`
        );
        return { truncated: records.length >= MAX_SHARE_ROWS, rows: records.map((x) => ({ who: x.UserOrGroupId, level: x[lv.share], cause: x.RowCause })) };
      });
      acc.truncated = r.truncated;
      ownerRowLevel = r.rows.find((x) => x.cause === "Owner")?.level || null;
      acc.rows = r.rows.filter((x) => x.cause !== "Owner" && x.level && x.level !== "None");
    }, null),
    soft(outOwner, "The account owner", async () => {
      const a = await memo("acctOwner", async () => {
        const { records } = await api.query(`SELECT OwnerId, Owner.Name, Owner.UserRoleId FROM Account WHERE Id = ${soqlString(rec.accountId)}`);
        return records[0] || null;
      });
      if (!a?.OwnerId) return;
      acc.owner = { id: a.OwnerId, name: a.Owner?.Name || "", roleId: a.Owner?.UserRoleId || null, level: null };
      if (acc.owner.roleId) {
        acc.owner.level = await memo(`acctOwnerRole:${acc.owner.roleId}`, async () => {
          const { records: r } = await api.query(`SELECT ${lv.role} FROM UserRole WHERE Id = ${soqlString(acc.owner.roleId)}`);
          return r[0]?.[lv.role] || null;
        });
      }
    }, null, { quietIfOff: true }),
  ]);
  // The account's Owner sharing row, when it was read, is what Salesforce worked out from the role setting.
  if (acc.owner && ownerRowLevel) acc.owner.level = ownerRowLevel;
  out.notes.push(...outRows.notes, ...outOwner.notes);
  out.warnings.push(...outRows.warnings, ...outOwner.warnings);
  return acc;
}

// ---------- everything ----------

/** Read the facts for one or two users. `users` are {id, name} picks from searchUsers.
 *
 *  Reads that do not need each other run together (at most MAX_IN_FLIGHT requests at a time): the roles, the territories,
 *  the record's sharing rows, the account's sharing, the permission count and each user's own reads, for both users at once.
 *  Only what truly needs something else waits for it (group names need the sharing rows; the members of manager groups need
 *  the groups, the roles and the territories; a user's group walk needs their role and territories). Notes and warnings are
 *  put together in a fixed order, so the answer does not depend on which read finished first.
 *
 *  `cache` (from createReadCache) keeps the org-wide lists and the record's own facts between two Explains; with none given,
 *  nothing is kept. `progress(text)` is told "Reading… (n of m)" each time one of the m parts is done. */
export async function readRecordAccess(rawApi, ctx, users, { progress = () => {}, cache = createReadCache() } = {}) {
  const api = withLimit(rawApi);
  const rec = ctx.record;
  const objectApi = ctx.object.api;
  const isAccount = objectApi === "Account";
  if (cache.recId !== rec.id) { cache.rec.clear(); cache.recId = rec.id; cache.recAt = null; }
  let keptUsed = false; // true when any of the record's facts came from an earlier Explain
  const orgWide = (key, load) => remembered(cache, "org", key, load);
  const ofRecord = (key, load) => { if (cache.rec.has(key)) keptUsed = true; return remembered(cache, "rec", key, load); };

  const total = 7 + users.length;
  let done = 0;
  // Once the run has ended (answered or failed) no more progress is told: reads still under way after an early failure
  // must not write "Reading… (7 of 8)" next to the error.
  let open = true;
  const say = (t) => { if (open) progress(t); };
  const tick = (p) => p.then((v) => { done++; say(`Reading… (${done} of ${total})`); return v; });
  say(`Reading… (0 of ${total})`);

  // Org-wide lists.
  const rolesU = tick((async () => {
    const o = blank();
    const res = await soft(o, "Roles", () => orgWide("roles", () => readRoles(api)), { roles: [] });
    const roles = res.roles.map((r) => ({ id: r.id, parentId: r.parentId, name: r.name }));
    return { o, roles, roleParent: new Map(roles.map((r) => [r.id, r.parentId])) };
  })());
  const terrU = tick((async () => {
    const o = blank();
    let territories = { on: false, items: [], record: [] };
    await soft(o, "Territories", async () => {
      const items = await orgWide("territories", async () => {
        const { records } = await api.query("SELECT Id, Name, ParentTerritory2Id FROM Territory2 WHERE Territory2Model.State = 'Active'");
        return records.map((t) => ({ id: t.Id, parentId: t.ParentTerritory2Id || null, name: t.Name }));
      });
      territories = { on: true, items, record: [] };
      if (isAccount) {
        territories.record = await ofRecord("recordTerritories", async () => {
          const { records: ot } = await api.query(`SELECT Territory2Id, AssociationCause FROM ObjectTerritory2Association WHERE ObjectId = ${soqlString(rec.id)}`);
          return ot.map((t) => ({ id: t.Territory2Id, cause: t.AssociationCause || "" }));
        });
      }
    }, null, { quietIfOff: true });
    return { o, territories, terrParent: new Map(territories.items.map((t) => [t.id, t.parentId])), activeTerr: new Set(territories.items.map((t) => t.id)) };
  })());

  // The record's own sharing rows.
  const sharesU = tick((async () => {
    const o = blank();
    const shares = { available: false, rows: [], truncated: false };
    const sm = await shareMeta(api, objectApi);
    if (!sm) {
      o.notes.push(`${ctx.object.plural} have no sharing table (this is normal when everyone already has access, or when the parent record decides), so there are no manual shares, sharing rules or teams to show.`);
    } else {
      await soft(o, "The record's sharing rows", async () => {
        const r = await ofRecord("shareRows", async () => {
          const { records } = await api.query(
            `SELECT UserOrGroupId, ${sm.accessField}, RowCause FROM ${sm.name} WHERE ${sm.parentField} = ${soqlString(rec.id)} LIMIT ${MAX_SHARE_ROWS}`
          );
          return { truncated: records.length >= MAX_SHARE_ROWS, rows: records.map((x) => ({ who: x.UserOrGroupId, level: x[sm.accessField], cause: x.RowCause })) };
        });
        shares.available = true;
        shares.truncated = r.truncated;
        shares.rows = r.rows;
      }, null);
      if (shares.truncated) o.notes.push(`The record has more than ${MAX_SHARE_ROWS} sharing rows. Only the first ${MAX_SHARE_ROWS} were read.`);
    }
    return { o, shares };
  })());

  // Cases and Opportunities: what the parent account's own sharing gives to its cases or opportunities.
  const accountU = tick((async () => {
    const o = blank();
    const account = await readAccountAccess(api, rec, objectApi, o, ofRecord);
    if (account?.truncated) o.notes.push(`The account has more than ${MAX_SHARE_ROWS} sharing rows. Only the first ${MAX_SHARE_ROWS} were read.`);
    return { o, account };
  })());

  // Do object permissions exist for this kind of record at all? (Task and Event have none.)
  const permU = tick((async () => {
    const o = blank();
    let permissionsApply = null;
    await soft(o, "Whether object permissions apply", async () => {
      permissionsApply = await ofRecord(`permissionsApply:${objectApi}`, async () => (await api.count(`SELECT COUNT() FROM ObjectPermissions WHERE SobjectType = ${soqlString(objectApi)}`)) > 0);
    }, null);
    return { o, permissionsApply };
  })());

  // Names of the groups and users the record is shared with (they need the sharing rows).
  const namesU = tick((async () => {
    const [{ shares }, { account }] = await Promise.all([sharesU, accountU]);
    const o1 = blank();
    const o2 = blank();
    const groups = new Map();
    const shareUsers = [];
    const allRows = [...shares.rows, ...(account?.rows || [])];
    const groupIds = uniq([...allRows.map((r) => r.who).filter((w) => w.startsWith("00G")), rec.ownerKind === "queue" ? rec.ownerId : null]);
    const userIds = uniq(allRows.map((r) => r.who).filter((w) => w.startsWith("005")));
    await Promise.all([
      soft(o1, "The groups the record is shared with", async () => {
        const found = await ofRecord(`groupNames:${groupIds.join(",")}`, async () => {
          const all = [];
          for (const part of chunk(groupIds, ID_CHUNK)) {
            const { records } = await api.query(`SELECT ${GROUP_FIELDS} FROM Group WHERE Id IN (${list(part)})`);
            all.push(...records.map(toGroup));
          }
          return all;
        });
        for (const g of found) groups.set(g.id, g);
      }, null),
      soft(o2, "The users the record is shared with", async () => {
        const found = await ofRecord(`shareUsers:${userIds.join(",")}`, async () => {
          const all = [];
          for (const part of chunk(userIds, ID_CHUNK)) {
            const { records } = await api.query(`SELECT Id, Name, UserRoleId FROM User WHERE Id IN (${list(part)})`);
            for (const u of records) all.push({ id: u.Id, name: u.Name, roleId: u.UserRoleId || null });
          }
          return all;
        });
        shareUsers.push(...found);
      }, null),
    ]);
    return { o: { notes: [...o1.notes, ...o2.notes], warnings: [...o1.warnings, ...o2.warnings] }, groups, shareUsers, allRows };
  })());

  // Groups that give access to managers, and a queue that owns the record: which roles their members have.
  const membersU = tick((async () => {
    const [{ groups, allRows }, { roles, roleParent }, { terrParent, territories }] = await Promise.all([namesU, rolesU, terrU]);
    const o = blank();
    const memberRoles = {};
    const isTerrGroup = (g) => /^Territory/.test(g.type) && g.relatedId && g.includeBosses;
    const bossTargets = uniq([
      ...[...groups.values()].filter((g) => (g.type === "Regular" || isTerrGroup(g)) && g.includeBosses && allRows.some((r) => r.who === g.id)).map((g) => g.id),
      rec.ownerKind === "queue" ? rec.ownerId : null,
    ]);
    const targetInfo = new Map([...groups.values()].filter(isTerrGroup).map((g) => [g.id, { type: g.type, relatedId: g.relatedId }]));
    if (bossTargets.length && roles.length) {
      const found = await soft(o, "The members of the groups that give access to managers", () =>
        ofRecord(`members:${bossTargets.join(",")}:${roles.length}:${territories.items.length}`, () => readMemberRoles(api, bossTargets, roleParent, terrParent, targetInfo)), null);
      if (found) Object.assign(memberRoles, found);
    }
    return { o, memberRoles };
  })());

  // One user. Their own reads start at once; only the group walk waits for their role and territories.
  async function readUser(pick) {
    const uo = blank();
    const soft2 = (what, fn, fb, o) => soft(uo, () => `${pick.name}: ${what}`, fn, fb, o);
    const userP = api.query(
      `SELECT Id, Name, Username, IsActive, UserType, Profile.Name, UserRoleId, UserRole.Name FROM User WHERE Id = ${soqlString(pick.id)}`
    ).then((r) => r.records[0]);
    userP.catch(() => {}); // the failure is raised below; do not report it twice
    const user = {
      id: pick.id, name: pick.name, username: "", isActive: false, userType: "Standard",
      profile: "", roleId: null, roleName: "",
      sf: null, parentSf: null, whoSf: null, object: null, memberOf: [], territoryIds: [], teamRole: null, accountTeamRole: null, childCounts: null,
    };
    const upGroups = new Map();
    // The assignments are asked for while the territory list is still coming in (the answer is only used when territories are on).
    const assignedQ = api.query(`SELECT Territory2Id FROM UserTerritory2Association WHERE UserId = ${soqlString(pick.id)}`);
    assignedQ.catch(() => {}); // an org without territories fails this on purpose; it is looked at only when territories are on
    const terrAssignP = soft2("Territory assignments", async () => {
      const { territories, activeTerr } = await terrU;
      if (!territories.on) return [];
      const { records: a } = await assignedQ;
      return a.map((x) => x.Territory2Id).filter((id) => activeTerr.has(id));
    }, [], { quietIfOff: true });
    const hasAccount = !!(ACCOUNT_CHILD_LEVEL[objectApi] && rec.accountId);
    const parts = [
      soft2("Salesforce's own access answer", async () => { user.sf = await readSf(api, pick.id, rec.id); }, null),
      rec.parentId && ctx.owd.internal === "ControlledByParent"
        ? soft2("Access on the parent record", async () => { user.parentSf = await readSf(api, pick.id, rec.parentId); }, null)
        : null,
      rec.whoId && ctx.owd.internal === "ControlledByParent"
        ? soft2("Access on the person the record is about", async () => { user.whoSf = await readSf(api, pick.id, rec.whoId); }, null)
        : null,
      soft2("Object access (profile and permission sets)", async () => { user.object = await readObjectSets(api, pick.id, objectApi); }, null),
      soft2("Groups and queues", async () => {
        const [u, { roleParent }, ids, { terrParent }] = await Promise.all([userP, rolesU, terrAssignP, terrU]);
        if (!u) return; // reported as "not found" below
        const roleChain = u.UserRoleId ? chainAbove(roleParent, u.UserRoleId) : [];
        const terrChain = uniq(ids.flatMap((t) => chainAbove(terrParent, t)));
        const up = await readGroupsAbove(api, pick.id, roleChain, terrChain);
        user.memberOf = up.edges;
        for (const [id, g] of up.groups) upGroups.set(id, g);
      }, null),
      soft2("Team membership", async () => { user.teamRole = await readTeamRole(api, objectApi, rec.id, pick.id); }, null, { quietIfOff: true }),
      hasAccount ? soft2("Account team membership", async () => { user.accountTeamRole = await readTeamRole(api, "Account", rec.accountId, pick.id); }, null, { quietIfOff: true }) : null,
      isAccount ? soft2("Child records", async () => { user.childCounts = await readChildCounts(api, rec.id, pick.id); }, null) : null,
    ].filter(Boolean);
    const [u, terrIds] = await Promise.all([userP, terrAssignP]);
    await Promise.all(parts);
    if (!u) throw new Error("This user could not be found. They may have been deleted. Search again.");
    if (u.Name !== pick.name) { // notes were worded with the picked name; use the name Salesforce holds
      const fix = (t) => (t.startsWith(`${pick.name}: `) ? `${u.Name}: ${t.slice(pick.name.length + 2)}` : t);
      uo.notes = uo.notes.map(fix);
      uo.warnings = uo.warnings.map(fix);
    }
    Object.assign(user, {
      id: u.Id, name: u.Name, username: u.Username, isActive: u.IsActive === true, userType: u.UserType || "Standard",
      profile: u.Profile?.Name || "", roleId: u.UserRoleId || null, roleName: u.UserRole?.Name || "", territoryIds: terrIds,
    });
    return { user, uo, upGroups };
  }
  const userUs = users.map((pick) => tick(readUser(pick)));

  // Everything is under way. Gather it, always in the same order, so the notes read the same way every time.
  let gathered;
  try {
    gathered = await Promise.all([rolesU, terrU, sharesU, accountU, namesU, membersU, permU, ...userUs]);
  } finally {
    open = false;
  }
  const [R, T, S, A, N, M, P, ...U] = gathered;
  const out = blank();
  out.notes.push(...ctx.notes);
  out.warnings.push(...ctx.warnings);
  for (const x of [R, T, S, A, N, M, P]) { out.notes.push(...x.o.notes); out.warnings.push(...x.o.warnings); }
  const groups = N.groups;
  for (const x of U) {
    for (const [id, g] of x.upGroups) if (!groups.has(id)) groups.set(id, g);
    out.notes.push(...x.uo.notes);
    out.warnings.push(...x.uo.warnings);
  }
  const object = { ...ctx.object, grantByHierarchy: null, permissionsApply: P.permissionsApply === false ? false : true };
  return {
    schema: ACCESS_SCHEMA,
    record: rec, owd: ctx.owd, object,
    roles: R.roles, territories: T.territories, shares: S.shares, account: A.account, groups: [...groups.values()], shareUsers: N.shareUsers, memberRoles: M.memberRoles,
    users: U.map((x) => x.user), notes: out.notes, warnings: out.warnings,
    ...(keptUsed && cache.recAt !== null ? { kept: { at: cache.recAt } } : {}), // record facts served from an earlier Explain, and when they were first read
  };
}
