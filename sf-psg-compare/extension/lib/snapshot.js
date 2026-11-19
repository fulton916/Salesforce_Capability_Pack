// Read one permission set group from an org into a plain, org-independent JSON snapshot.
//
// Read-only: every call is a SOQL query or a describe. Nothing is written to the org.
//
// What a PSG allows is read from its aggregate permission set (PermissionSet.Type = 'Group',
// linked by PermissionSetGroupId). Salesforce keeps that record as the calculated sum of the
// component permission sets minus the muting permission set, so it is the net access a user
// assigned to the group gets from it. It is only current when the group's Status is 'Updated'.

import { chunk, soqlString } from "./sfconn.js";

export const SNAPSHOT_SCHEMA = "sf-psg-snapshot/1";

// SetupEntityAccess types we can name. Anything else is kept by Id with a warning.
export const SETUP_TYPES = {
  ApexClass: { label: "Apex class", sobject: "ApexClass", name: "Name", ns: "NamespacePrefix" },
  ApexPage: { label: "Visualforce page", sobject: "ApexPage", name: "Name", ns: "NamespacePrefix" },
  CustomPermission: { label: "Custom permission", sobject: "CustomPermission", name: "DeveloperName", ns: "NamespacePrefix", display: "MasterLabel" },
  TabSet: { label: "App", sobject: "AppMenuItem", id: "ApplicationId", name: "Name", ns: "NamespacePrefix", display: "Label" },
  ConnectedApplication: { label: "Connected app", sobject: "ConnectedApplication", name: "Name" },
  NamedCredential: { label: "Named credential", sobject: "NamedCredential", name: "DeveloperName", ns: "NamespacePrefix" },
  ExternalCredential: { label: "External credential", sobject: "ExternalCredential", name: "DeveloperName", ns: "NamespacePrefix" },
  ExternalCredentialParameter: {
    label: "External credential principal", sobject: "ExternalCredentialParameter",
    cols: ["ParameterName", "ExternalCredential.DeveloperName"],
    nameOf: (r) => `${r.ExternalCredential?.DeveloperName ?? "?"}.${r.ParameterName}`,
  },
  ExternalDataSource: { label: "External data source", sobject: "ExternalDataSource", name: "DeveloperName", ns: "NamespacePrefix" },
  CustomEntityDefinition: { label: "Custom setting / metadata type", sobject: "CustomObject", tooling: true, name: "DeveloperName", ns: "NamespacePrefix" },
  FlowDefinition: { label: "Flow", sobject: "FlowDefinition", tooling: true, name: "DeveloperName", ns: "NamespacePrefix" },
  ServicePresenceStatus: { label: "Presence status", sobject: "ServicePresenceStatus", name: "DeveloperName", display: "MasterLabel" },
};

const ID_CHUNK = 200; // Ids per IN (...) clause, keeps the URL short.
const FIELD_CHUNK = 120; // Permission fields per SELECT, same reason.

function qualified(ns, name) {
  return ns ? `${ns}__${name}` : name;
}

/** Boolean Permissions* fields of an sObject, as [{name, label}]. */
async function permissionFields(api, sobject) {
  const d = await api.describe(sobject);
  return d.fields
    .filter((f) => f.type === "boolean" && f.name.startsWith("Permissions"))
    .map((f) => ({ name: f.name, label: f.label }));
}

/** Map of permission field -> label for every field that is true on record `id`. */
async function truePermissions(api, sobject, id, fields) {
  const out = {};
  for (const part of chunk(fields, FIELD_CHUNK)) {
    const soql = `SELECT Id, ${part.map((f) => f.name).join(", ")} FROM ${sobject} WHERE Id = ${soqlString(id)}`;
    const { records } = await api.query(soql);
    const rec = records[0];
    if (!rec) continue;
    for (const f of part) if (rec[f.name] === true) out[f.name] = f.label;
  }
  return out;
}

async function objectPermissions(api, parentId, flagFields) {
  const soql = `SELECT SobjectType, ${flagFields.join(", ")} FROM ObjectPermissions WHERE ParentId = ${soqlString(parentId)}`;
  const { records } = await api.query(soql);
  const out = {};
  for (const r of records) {
    const flags = {};
    for (const f of flagFields) flags[f.replace(/^Permissions/, "")] = r[f] === true;
    out[r.SobjectType] = flags;
  }
  return out;
}

async function fieldPermissions(api, parentId) {
  const soql = `SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = ${soqlString(parentId)}`;
  const { records } = await api.query(soql);
  const out = {};
  for (const r of records) out[r.Field] = { Read: r.PermissionsRead === true, Edit: r.PermissionsEdit === true };
  return out;
}

async function tabSettings(api, parentId) {
  const { records } = await api.query(`SELECT Name, Visibility FROM PermissionSetTabSetting WHERE ParentId = ${soqlString(parentId)}`);
  const out = {};
  for (const r of records) out[r.Name] = r.Visibility;
  return out;
}

/** Setup entity access, as { "<Type>|<name>": {type, typeLabel, name, label} }. */
async function setupAccess(api, parentId, warnings) {
  const { records } = await api.query(`SELECT SetupEntityId, SetupEntityType FROM SetupEntityAccess WHERE ParentId = ${soqlString(parentId)}`);
  const byType = {};
  for (const r of records) (byType[r.SetupEntityType] ||= []).push(r.SetupEntityId);

  const out = {};
  for (const [type, ids] of Object.entries(byType)) {
    const spec = SETUP_TYPES[type];
    const names = {};
    if (spec) {
      const idField = spec.id || "Id";
      const cols = [...new Set([idField, spec.name, spec.ns, spec.display, ...(spec.cols || [])].filter(Boolean))];
      try {
        for (const part of chunk(ids, ID_CHUNK)) {
          const soql = `SELECT ${cols.join(", ")} FROM ${spec.sobject} WHERE ${idField} IN (${part.map(soqlString).join(", ")})`;
          const { records: recs } = await api.query(soql, { tooling: !!spec.tooling });
          for (const rec of recs) {
            names[rec[idField].slice(0, 15)] = {
              name: spec.nameOf ? spec.nameOf(rec) : qualified(spec.ns && rec[spec.ns], rec[spec.name]),
              label: spec.display ? rec[spec.display] : null,
            };
          }
        }
      } catch (e) {
        warnings.push(`Could not read names for ${type} (${e.message}); kept by Id.`);
      }
    } else {
      warnings.push(`Setup access type ${type} is not named by this tool; ${ids.length} item(s) kept by Id. Ids differ between orgs.`);
    }
    for (const id of ids) {
      const hit = names[id.slice(0, 15)];
      const name = hit?.name || id;
      out[`${type}|${name}`] = { type, typeLabel: spec?.label || type, name, label: hit?.label || null };
    }
  }
  return out;
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

/** Permission set groups in the org, for the picker. */
export async function listPsgs(api) {
  const { records } = await api.query(
    "SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, Status FROM PermissionSetGroup ORDER BY MasterLabel"
  );
  return records.map((r) => ({
    id: r.Id,
    developerName: qualified(r.NamespacePrefix, r.DeveloperName),
    label: r.MasterLabel,
    status: r.Status,
  }));
}

export async function readOrg(api, apiHost) {
  const { records } = await api.query("SELECT Id, Name, IsSandbox, InstanceName, OrganizationType FROM Organization");
  const o = records[0] || {};
  return { id: o.Id, name: o.Name, isSandbox: o.IsSandbox === true, instance: o.InstanceName, edition: o.OrganizationType, host: apiHost };
}

/** Read one PSG into a snapshot. `progress(text)` is called before each step. */
export async function takeSnapshot(api, psgId, { org, progress = () => {} } = {}) {
  const warnings = [];
  const idLit = soqlString(psgId);

  progress("Reading the group");
  const psgRes = await api.query(
    `SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, Description, Status FROM PermissionSetGroup WHERE Id = ${idLit}`
  );
  const g = psgRes.records[0];
  if (!g) throw new Error(`Permission set group ${psgId} not found.`);

  const aggRes = await api.query(`SELECT Id, Type FROM PermissionSet WHERE PermissionSetGroupId = ${idLit}`);
  const agg = aggRes.records.find((r) => r.Type === "Group") || aggRes.records[0];
  if (!agg) throw new Error(`No aggregate permission set found for group ${g.DeveloperName}.`);
  if (g.Status !== "Updated") {
    warnings.push(`Status is ${g.Status}, not Updated: Salesforce has not finished recalculating this group, so its permissions may not match its components yet.`);
  }

  progress("Reading component permission sets");
  const compRes = await api.query(`SELECT PermissionSetId FROM PermissionSetGroupComponent WHERE PermissionSetGroupId = ${idLit}`);
  const compIds = compRes.records.map((r) => r.PermissionSetId);
  const components = [];
  let muting = null;
  if (compIds.length) {
    const list = compIds.map(soqlString).join(", ");
    const { records: ps } = await api.query(
      `SELECT Id, Name, Label, Type, NamespacePrefix, LicenseId, Description FROM PermissionSet WHERE Id IN (${list})`
    );
    const seen = new Set(ps.map((p) => p.Id.slice(0, 15)));
    const lic = await licenceNames(api, [...new Set(ps.map((p) => p.LicenseId).filter(Boolean))], warnings);
    for (const p of ps) {
      const c = {
        id: p.Id,
        name: qualified(p.NamespacePrefix, p.Name),
        label: p.Label,
        type: p.Type || "Regular",
        isMuting: p.Type === "Muting",
        licence: p.LicenseId ? lic[p.LicenseId] || p.LicenseId : null,
        description: p.Description || null,
      };
      components.push(c);
      if (c.isMuting) muting = { id: p.Id, sobject: "PermissionSet", name: c.name, label: c.label };
    }
    // Muting permission sets can also live in their own object.
    const rest = compIds.filter((id) => !seen.has(id.slice(0, 15)));
    if (rest.length) {
      try {
        const { records: mps } = await api.query(
          // MutingPermissionSet has no NamespacePrefix field.
          `SELECT Id, DeveloperName, MasterLabel FROM MutingPermissionSet WHERE Id IN (${rest.map(soqlString).join(", ")})`
        );
        for (const m of mps) {
          const name = m.DeveloperName;
          components.push({ id: m.Id, name, label: m.MasterLabel, type: "Muting", isMuting: true, licence: null, description: null });
          muting = { id: m.Id, sobject: "MutingPermissionSet", name, label: m.MasterLabel };
        }
      } catch (e) {
        warnings.push(`Could not read the muting permission set (${e.message}).`);
      }
    }
  }
  components.sort((x, y) => x.name.localeCompare(y.name));

  // The reads below do not depend on each other, so they run at the same time.
  progress("Reading permissions");
  const [psFields, opDesc] = await Promise.all([permissionFields(api, "PermissionSet"), permissionFields(api, "ObjectPermissions")]);
  const opFields = opDesc.map((f) => f.name);

  const readMuting = async () => {
    if (!muting) return;
    try {
      const mFields = muting.sobject === "PermissionSet" ? psFields : await permissionFields(api, muting.sobject);
      [muting.userPermissions, muting.objectPermissions, muting.fieldPermissions] = await Promise.all([
        truePermissions(api, muting.sobject, muting.id, mFields),
        objectPermissions(api, muting.id, opFields),
        fieldPermissions(api, muting.id),
      ]);
    } catch (e) {
      warnings.push(`Could not read what the muting permission set removes (${e.message}).`);
    }
  };
  const readGlobal = api.describeGlobal().catch((e) => {
    warnings.push(`Could not read object names; API names are shown instead (${e.message}).`);
    return { sobjects: [] };
  });

  const [userPermissions, objPerms, fldPerms, setup, tabs, assigned, assignedActive, global] = await Promise.all([
    truePermissions(api, "PermissionSet", agg.Id, psFields),
    objectPermissions(api, agg.Id, opFields),
    fieldPermissions(api, agg.Id),
    setupAccess(api, agg.Id, warnings),
    tabSettings(api, agg.Id),
    api.count(`SELECT COUNT() FROM PermissionSetAssignment WHERE PermissionSetGroupId = ${idLit}`),
    api.count(`SELECT COUNT() FROM PermissionSetAssignment WHERE PermissionSetGroupId = ${idLit} AND Assignee.IsActive = true`),
    readGlobal,
    readMuting(),
  ]);

  progress("Putting it together");
  const wanted = new Set([
    ...Object.keys(objPerms),
    ...Object.keys(fldPerms).map((f) => f.split(".")[0]),
    ...Object.keys(tabs).map((t) => t.replace(/^standard-/, "")),
  ]);
  const objectLabels = {};
  for (const o of global.sobjects || []) if (wanted.has(o.name)) objectLabels[o.name] = o.label;

  if (!Object.keys(userPermissions).length && !Object.keys(objPerms).length && components.length) {
    warnings.push("The aggregate permission set returned no permissions although the group has components. Check the group's Status in Setup.");
  }

  return {
    schema: SNAPSHOT_SCHEMA,
    takenAt: new Date().toISOString(),
    org: org || null,
    psg: {
      id: g.Id,
      developerName: qualified(g.NamespacePrefix, g.DeveloperName),
      label: g.MasterLabel,
      description: g.Description || null,
      status: g.Status,
      aggregatePermissionSetId: agg.Id,
    },
    components,
    muting,
    assignments: { total: assigned, active: assignedActive },
    userPermissions,
    objectPermissions: objPerms,
    fieldPermissions: fldPerms,
    setupAccess: setup,
    tabSettings: tabs,
    objectLabels,
    warnings,
  };
}

/** Check that a parsed JSON file is a snapshot this tool can read. */
export function validateSnapshot(s) {
  if (!s || typeof s !== "object" || s.schema !== SNAPSHOT_SCHEMA) {
    throw new Error(`Not a PSG snapshot (expected schema "${SNAPSHOT_SCHEMA}").`);
  }
  for (const k of ["psg", "components", "userPermissions", "objectPermissions", "fieldPermissions", "setupAccess", "tabSettings"]) {
    if (!(k in s)) throw new Error(`Snapshot is missing "${k}".`);
  }
  return s;
}
