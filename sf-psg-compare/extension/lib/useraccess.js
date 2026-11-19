// Read one user's access from an org into a plain JSON object (schema "sf-user-access/1").
//
// Read-only: every call is a SOQL query through SfApi. Nothing is written to the org.
// The object is shown on the page and can be exported as CSV; it is never saved to a file
// because it holds a user name and username.

import { chunk, soqlString, soqlLike } from "./sfconn.js";
import { ACCESS_SCHEMA } from "./usercompare.js";

export { ACCESS_SCHEMA };

const ID_CHUNK = 200; // Ids per IN (...) clause, keeps the URL short.
const MAX_WORDS = 6;

const qualified = (ns, name) => (ns ? `${ns}__${name}` : name);
const byLabel = (x, y) => x.label.localeCompare(y.label);

/** Find users by name or username, in the org. Every typed word must match one of the two.
 * Returns {users, more}; `more` is true when there are more matches than `limit`. */
export async function searchUsers(api, text, limit = 50) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  if (!words.length) return { users: [], more: false };
  const where = words.map((w) => `(Name LIKE '%${soqlLike(w)}%' OR Username LIKE '%${soqlLike(w)}%')`).join(" AND ");
  const soql = `SELECT Id, Name, Username, IsActive, Profile.Name FROM User WHERE ${where} ORDER BY IsActive DESC, Name LIMIT ${limit + 1}`;
  const { records } = await api.query(soql);
  const users = records.slice(0, limit).map((r) => ({
    id: r.Id, name: r.Name, username: r.Username, isActive: r.IsActive === true, profile: r.Profile?.Name || "",
  }));
  return { users, more: records.length > limit };
}

/** Plain-words message for an area that could not be read. The raw error goes to the warnings. */
function plainMessage(e, what, offText) {
  const raw = `${e?.errorCode || ""} ${e?.message || ""}`;
  if (offText && (e?.territoriesOff || /INVALID_TYPE|not supported|sObject type/i.test(raw))) return offText;
  return `${what} could not be read. Your user may not be allowed to see it.`;
}

async function licenceNames(api, ids, warnings) {
  const out = {};
  if (!ids.length) return out;
  const list = ids.map(soqlString).join(", ");
  for (const [sobject, field] of [["UserLicense", "Name"], ["PermissionSetLicense", "MasterLabel"]]) {
    try {
      const { records } = await api.query(`SELECT Id, ${field} FROM ${sobject} WHERE Id IN (${list})`);
      for (const r of records) out[r.Id] = r[field];
    } catch (e) {
      warnings.push(`Could not read ${sobject} names (${e.message}).`);
    }
  }
  return out;
}

/** Permission sets and permission set groups of one user, and how each permission set is reached. */
async function readPermissionSets(api, userId, warnings) {
  const { records: psa } = await api.query(
    "SELECT PermissionSetId, PermissionSetGroupId, PermissionSet.Name, PermissionSet.Label, PermissionSet.NamespacePrefix, " +
    "PermissionSet.Type, PermissionSet.IsOwnedByProfile, PermissionSet.LicenseId " +
    `FROM PermissionSetAssignment WHERE AssigneeId = ${soqlString(userId)} AND PermissionSet.IsOwnedByProfile = false`
  );
  const keep = (ps) => ps && ps.IsOwnedByProfile !== true && ps.Type !== "Group" && ps.Type !== "Profile" && ps.Type !== "Muting";

  const sets = new Map(); // key -> permission set item
  const licenceIds = new Set();
  const setItem = (key, label, licenceId) => {
    if (!sets.has(key)) sets.set(key, { key, label: label || key, licence: null, licenceId: licenceId || null, direct: false, groups: [] });
    if (licenceId) licenceIds.add(licenceId);
    return sets.get(key);
  };

  const groupIds = [...new Set(psa.map((r) => r.PermissionSetGroupId).filter(Boolean))];
  for (const r of psa) {
    if (r.PermissionSetGroupId || !keep(r.PermissionSet)) continue; // group rows are handled below
    const p = r.PermissionSet;
    setItem(qualified(p.NamespacePrefix, p.Name), p.Label, p.LicenseId).direct = true;
  }

  // The groups the user is assigned to.
  const groups = new Map(); // id -> group item
  for (const part of chunk(groupIds, ID_CHUNK)) {
    const { records } = await api.query(
      `SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, Status FROM PermissionSetGroup WHERE Id IN (${part.map(soqlString).join(", ")})`
    );
    for (const g of records) {
      groups.set(g.Id, { key: qualified(g.NamespacePrefix, g.DeveloperName), label: g.MasterLabel || g.DeveloperName, status: g.Status || null, muting: [] });
    }
  }
  for (const id of groupIds) if (!groups.has(id)) groups.set(id, { key: id, label: "A group your user cannot see", status: null, muting: [] });

  // What each group is made of. Muting permission sets are shown on the group, not as a permission set.
  const components = [];
  for (const part of chunk(groupIds, ID_CHUNK)) {
    const { records } = await api.query(
      `SELECT PermissionSetGroupId, PermissionSetId FROM PermissionSetGroupComponent WHERE PermissionSetGroupId IN (${part.map(soqlString).join(", ")})`
    );
    components.push(...records);
  }
  const compIds = [...new Set(components.map((c) => c.PermissionSetId))];
  const compSets = new Map(); // id (15 chars) -> record
  for (const part of chunk(compIds, ID_CHUNK)) {
    const { records } = await api.query(
      `SELECT Id, Name, Label, Type, NamespacePrefix, LicenseId FROM PermissionSet WHERE Id IN (${part.map(soqlString).join(", ")})`
    );
    for (const p of records) compSets.set(p.Id.slice(0, 15), p);
  }
  // Muting permission sets can also live in their own object (it has no NamespacePrefix).
  const missing = compIds.filter((id) => !compSets.has(id.slice(0, 15)));
  const mutingSets = new Map();
  for (const part of chunk(missing, ID_CHUNK)) {
    try {
      const { records } = await api.query(
        `SELECT Id, DeveloperName, MasterLabel FROM MutingPermissionSet WHERE Id IN (${part.map(soqlString).join(", ")})`
      );
      for (const m of records) mutingSets.set(m.Id.slice(0, 15), m.MasterLabel || m.DeveloperName);
    } catch (e) {
      warnings.push(`Could not read the muting permission sets (${e.message}).`);
    }
  }

  for (const c of components) {
    const g = groups.get(c.PermissionSetGroupId);
    if (!g) continue;
    const id = c.PermissionSetId.slice(0, 15);
    const p = compSets.get(id);
    if (mutingSets.has(id) || p?.Type === "Muting") {
      const label = mutingSets.get(id) || p.Label || p.Name;
      if (!g.muting.includes(label)) g.muting.push(label);
    } else if (p && keep({ ...p, IsOwnedByProfile: false })) {
      const item = setItem(qualified(p.NamespacePrefix, p.Name), p.Label, p.LicenseId);
      if (!item.groups.some((x) => x.key === g.key)) item.groups.push({ key: g.key, label: g.label });
    }
  }

  const lic = await licenceNames(api, [...licenceIds], warnings);
  const permissionSets = [...sets.values()].map(({ licenceId, ...it }) => ({ ...it, licence: licenceId ? lic[licenceId] || null : null }));
  permissionSets.forEach((p) => p.groups.sort(byLabel));
  return { permissionSets: permissionSets.sort(byLabel), permissionSetGroups: [...groups.values()].sort(byLabel) };
}

async function readLicences(api, userId) {
  const { records } = await api.query(
    `SELECT PermissionSetLicense.DeveloperName, PermissionSetLicense.MasterLabel FROM PermissionSetLicenseAssign WHERE AssigneeId = ${soqlString(userId)}`
  );
  return records.filter((r) => r.PermissionSetLicense).map((r) => ({
    key: r.PermissionSetLicense.DeveloperName, label: r.PermissionSetLicense.MasterLabel || r.PermissionSetLicense.DeveloperName,
  })).sort(byLabel);
}

/** Direct membership of public groups and queues. */
async function readMemberships(api, userId) {
  const { records } = await api.query(
    `SELECT Group.DeveloperName, Group.Name, Group.Type FROM GroupMember WHERE UserOrGroupId = ${soqlString(userId)} AND Group.Type IN ('Regular', 'Queue')`
  );
  const publicGroups = [];
  const queues = [];
  for (const r of records) {
    const g = r.Group;
    if (!g) continue;
    const item = { key: g.DeveloperName || g.Name, label: g.Name || g.DeveloperName };
    if (g.Type === "Queue") queues.push(item);
    else if (g.Type === "Regular") publicGroups.push(item);
  }
  return { publicGroups: publicGroups.sort(byLabel), queues: queues.sort(byLabel) };
}

/** True when the org has the territory feature (the object is listed in describeGlobal, one cached call). */
async function territoriesOn(api) {
  const { sobjects = [] } = await api.describeGlobal();
  return sobjects.some((o) => o.name === "UserTerritory2Association");
}

async function readTerritories(api, userId) {
  if (!(await territoriesOn(api))) {
    const e = new Error("UserTerritory2Association is not in this org.");
    e.territoriesOff = true;
    throw e;
  }
  const { records } = await api.query(
    `SELECT Territory2.DeveloperName, Territory2.Name FROM UserTerritory2Association WHERE UserId = ${soqlString(userId)}`
  );
  return records.filter((r) => r.Territory2).map((r) => ({ key: r.Territory2.DeveloperName, label: r.Territory2.Name || r.Territory2.DeveloperName })).sort(byLabel);
}

/** Read one user's access. Only the user itself is required; every other area fails softly:
 * its list stays empty, `unavailable[area]` gets a plain message and `warnings` gets the raw error. */
export async function readUserAccess(api, userId, { progress = () => {} } = {}) {
  const warnings = [];
  const unavailable = {};

  progress("Reading the user");
  const { records } = await api.query(
    "SELECT Id, Name, Username, IsActive, Profile.Name, Profile.UserLicense.Name, UserRole.Name, UserRole.DeveloperName " +
    `FROM User WHERE Id = ${soqlString(userId)}`
  );
  const u = records[0];
  if (!u) throw new Error(`User ${userId} not found.`);

  const sections = { profile: [], role: [], permissionSetGroups: [], permissionSets: [], permissionSetLicenses: [], publicGroups: [], queues: [], territories: [] };
  if (u.Profile) sections.profile.push({ key: u.Profile.Name, label: u.Profile.Name, licence: u.Profile.UserLicense?.Name || null });
  if (u.UserRole) sections.role.push({ key: u.UserRole.DeveloperName || u.UserRole.Name, label: u.UserRole.Name });

  const soft = async (keys, what, fn, offText) => {
    try {
      Object.assign(sections, await fn());
    } catch (e) {
      const msg = plainMessage(e, what, offText);
      for (const k of keys) unavailable[k] = msg;
      if (!e.territoriesOff) warnings.push(`${what}: ${e.message}`); // a feature that is off is not a problem
    }
  };

  progress("Reading permission sets, groups, licences and territories");
  await Promise.all([
    soft(["permissionSets", "permissionSetGroups"], "Permission sets and groups", () => readPermissionSets(api, userId, warnings)),
    soft(["permissionSetLicenses"], "Permission set licences", async () => ({ permissionSetLicenses: await readLicences(api, userId) })),
    soft(["publicGroups", "queues"], "Public groups and queues", () => readMemberships(api, userId)),
    soft(["territories"], "Territories", async () => ({ territories: await readTerritories(api, userId) }), "Territories are not turned on in this org."),
  ]);

  return {
    schema: ACCESS_SCHEMA,
    takenAt: new Date().toISOString(),
    user: { id: u.Id, name: u.Name, username: u.Username, isActive: u.IsActive === true },
    sections,
    unavailable,
    warnings,
  };
}
