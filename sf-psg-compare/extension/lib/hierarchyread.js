// Read territory and role hierarchies from an org. Read-only: every call is a SELECT (or a describe)
// through SfApi, which follows nextRecordsUrl. Nothing is written to the org. Nothing is stored.

import { soqlString } from "./sfconn.js";
import { sortModels } from "./hierarchy.js";

const territoryRecord = (r) => ({ id: r.Id, parentId: r.ParentTerritory2Id || null, name: r.Name || r.DeveloperName, apiName: r.DeveloperName || "" });
const roleRecord = (r) => ({ id: r.Id, parentId: r.ParentRoleId || null, name: r.Name || r.DeveloperName, apiName: r.DeveloperName || "" });

/** Territory models of the org. {on: false} when the territory feature is not turned on: the query
 *  fails with INVALID_TYPE / "sObject type ... is not supported". There is no describeGlobal call
 *  first (it was most of the load time on a large org). Otherwise {on: true, models}, Active first. */
export async function readTerritoryModels(api) {
  try {
    const { records } = await api.query("SELECT Id, Name, DeveloperName, State FROM Territory2Model");
    const models = records.map((r) => ({ id: r.Id, name: r.Name || r.DeveloperName, developerName: r.DeveloperName || "", state: r.State || "" }));
    return { on: true, models: sortModels(models) };
  } catch (e) {
    if (/INVALID_TYPE|not supported|sObject type/i.test(`${e?.errorCode || ""} ${e?.message || ""}`)) return { on: false, models: [] };
    throw e;
  }
}

/** Every territory of one model, as {id, parentId, name, apiName}. */
export async function readTerritories(api, modelId) {
  const { records } = await api.query(
    `SELECT Id, Name, DeveloperName, ParentTerritory2Id FROM Territory2 WHERE Territory2ModelId = ${soqlString(modelId)}`
  );
  return records.map(territoryRecord);
}

/** Roles of the org except portal and community roles. {roles, portalCount, warnings}.
 *  `portalCount` is null when the count could not be read (the reason is in `warnings`). */
export async function readRoles(api) {
  const warnings = [];
  const { records } = await api.query("SELECT Id, Name, DeveloperName, ParentRoleId FROM UserRole WHERE PortalType = 'None'");
  let portalCount = null;
  try {
    portalCount = await api.count("SELECT COUNT() FROM UserRole WHERE PortalType != 'None'");
  } catch (e) {
    warnings.push(`Could not count portal roles (${e.message}).`);
  }
  return { roles: records.map(roleRecord), portalCount, warnings };
}
