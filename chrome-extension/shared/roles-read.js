// Role read shared by the hierarchy page and the record-access page. Read-only: SELECT and COUNT() only.

const roleRecord = (r) => ({ id: r.Id, parentId: r.ParentRoleId || null, name: r.Name || r.DeveloperName, apiName: r.DeveloperName || "" });

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
