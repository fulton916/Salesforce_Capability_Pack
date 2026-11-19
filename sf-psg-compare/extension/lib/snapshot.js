// Read one permission set group from an org into a plain, org-independent JSON snapshot.
//
// Read-only: every call is a SOQL query or a describe. Nothing is written to the org.
//
// What a PSG allows is read from its aggregate permission set (PermissionSet.Type = 'Group',
// linked by PermissionSetGroupId). Salesforce keeps that record as the calculated sum of the
// component permission sets minus the muting permission set, so it is the net access a user
// assigned to the group gets from it. It is only current when the group's Status is 'Updated'.

import { chunk, soqlString } from "./sfconn.js";
import { humanize } from "./compare.js";

// v2 adds: fieldLabels, muting.tabSettings and muting.effective (what the muting set really removes).
// v1 files (saved earlier) are still accepted; the comparison falls back for the missing parts.
export const SNAPSHOT_SCHEMA = "sf-psg-snapshot/2";
export const ACCEPTED_SCHEMAS = ["sf-psg-snapshot/1", SNAPSHOT_SCHEMA];

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
    label: "External credential principal", sobject: "ExternalCredentialParameter", tooling: true,
    cols: ["ParameterName", "ExternalCredential.DeveloperName"],
    nameOf: (r) => `${r.ExternalCredential?.DeveloperName ?? "?"}.${r.ParameterName}`,
  },
  ExternalClientApplication: { label: "External client app", sobject: "ExternalClientApplication", name: "DeveloperName", ns: "NamespacePrefix", display: "MasterLabel" },
  ExternalDataSource: { label: "External data source", sobject: "ExternalDataSource", name: "DeveloperName", ns: "NamespacePrefix" },
  CustomEntityDefinition: { label: "Custom setting / metadata type", sobject: "CustomObject", tooling: true, name: "DeveloperName", ns: "NamespacePrefix" },
  FlowDefinition: { label: "Flow", sobject: "FlowDefinition", tooling: true, name: "DeveloperName", ns: "NamespacePrefix" },
  ServicePresenceStatus: { label: "Presence status", sobject: "ServicePresenceStatus", name: "DeveloperName", display: "MasterLabel" },
};

const ID_CHUNK = 200; // Ids per IN (...) clause, keeps the URL short.
const FIELD_CHUNK = 120; // Permission fields per SELECT, same reason.
const KEY_CHUNK = 80; // Field or object names per IN (...) clause.
const OBJECTS_PER_LABEL_QUERY = 20; // Objects per FieldDefinition query.
const LABEL_QUERIES_AT_ONCE = 3;

/** Trim and collapse whitespace in a label from the org. */
function tidy(v) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v;
}

/** Run fn over items, at most n at a time. Results keep their order. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

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

const lowerFirst = (t) => (/^(Apex|Visualforce)\b/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1));

/** Name raw SetupEntityAccess records, as { "<Type>|<name>": {type, typeLabel, name, label, byId?} }. */
async function nameSetup(api, records, warnings) {
  const byType = {};
  for (const r of records) (byType[r.SetupEntityType] ||= []).push(r.SetupEntityId);

  const out = {};
  for (const [type, ids] of Object.entries(byType)) {
    const spec = SETUP_TYPES[type];
    const typeLabel = spec?.label || humanize(type);
    const names = {};
    let reason = spec ? "" : "this tool does not read names for this kind of item";
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
              label: spec.display ? tidy(rec[spec.display]) || null : null,
            };
          }
        }
      } catch (e) {
        reason = e.message;
      }
    }
    let unnamed = 0;
    for (const id of ids) {
      const hit = names[id.slice(0, 15)];
      if (hit?.name) {
        out[`${type}|${hit.name}`] = { type, typeLabel, name: hit.name, label: hit.label };
      } else {
        unnamed++;
        out[`${type}|${id}`] = { type, typeLabel, name: id, label: null, byId: true };
      }
    }
    if (unnamed) {
      const noun = `${spec ? lowerFirst(typeLabel) : typeLabel.toLowerCase()}${unnamed === 1 ? "" : "s"}`;
      warnings.push(
        `${unnamed} ${noun} could not be named in this org${reason ? ` (${reason})` : ""}; ` +
        `${unnamed === 1 ? "it is" : "they are"} listed by Id, which differs between orgs.`
      );
    }
  }
  return out;
}

async function setupRecords(api, parentIds, extra = "") {
  const out = [];
  for (const part of chunk(parentIds, ID_CHUNK)) {
    const { records } = await api.query(
      `SELECT SetupEntityId, SetupEntityType FROM SetupEntityAccess WHERE ParentId IN (${part.map(soqlString).join(", ")})${extra}`
    );
    out.push(...records);
  }
  return out;
}

/** Real field labels, as { "Object.Field__c": "Label" }, from FieldDefinition (a few queries, not one describe per object). */
async function readFieldLabels(api, fieldKeys, warnings) {
  const wanted = new Set(fieldKeys);
  const objects = [...new Set(fieldKeys.map((k) => k.split(".")[0]))].filter(Boolean);
  const out = {};
  let failed = false;
  await pool(chunk(objects, OBJECTS_PER_LABEL_QUERY), LABEL_QUERIES_AT_ONCE, async (part) => {
    try {
      const { records } = await api.query(
        `SELECT QualifiedApiName, Label, EntityDefinition.QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName IN (${part.map(soqlString).join(", ")})`
      );
      for (const r of records) {
        const key = `${r.EntityDefinition?.QualifiedApiName}.${r.QualifiedApiName}`;
        if (wanted.has(key) && r.Label) out[key] = tidy(r.Label);
      }
    } catch {
      failed = true;
    }
  });
  if (failed) warnings.push("Some field names could not be read from the org, so those fields are shown with names made from their API names.");
  return out;
}

/** Run `build(componentIds, keys)` for every chunk of components and keys; all results joined. */
async function componentGrants(api, compIds, keys, build) {
  const all = [];
  for (const ids of chunk(compIds, 50)) for (const part of chunk(keys, KEY_CHUNK)) all.push([ids, part]);
  const results = await pool(all, 4, ([ids, part]) => build(ids, part));
  return results.flat();
}

const inList = (xs) => xs.map(soqlString).join(", ");

/**
 * What the muting permission set really takes away: muted AND given by at least one component AND
 * missing from the aggregate. (Salesforce does not always apply a mute to the aggregate, so "muted"
 * alone is not enough.) Returns the effective items plus how many muted items took nothing away.
 */
async function mutedEffect(api, muting, compIds, agg, opFields, warnings) {
  try {
    const eff = { userPermissions: {}, objectPermissions: {}, fieldPermissions: {}, tabSettings: {}, setupAccess: {}, nothingToTake: 0 };
    const fldMuted = Object.entries(muting.fieldPermissions || {}).filter(([, f]) => f.Read || f.Edit);
    const objMuted = Object.entries(muting.objectPermissions || {}).filter(([, f]) => Object.values(f).some(Boolean));
    const permMuted = Object.keys(muting.userPermissions || {});
    const tabMuted = Object.keys(muting.tabSettings || {});
    let total = fldMuted.length + objMuted.length + permMuted.length + tabMuted.length;
    const none = () => Promise.resolve([]);
    const has = compIds.length > 0;

    const [fRecs, oRecs, pRecs, tRecs, sMuted] = await Promise.all([
      has ? componentGrants(api, compIds, fldMuted.map(([k]) => k), async (ids, part) =>
        (await api.query(`SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId IN (${inList(ids)}) AND Field IN (${inList(part)})`)).records) : none(),
      has ? componentGrants(api, compIds, objMuted.map(([k]) => k), async (ids, part) =>
        (await api.query(`SELECT SobjectType, ${opFields.join(", ")} FROM ObjectPermissions WHERE ParentId IN (${inList(ids)}) AND SobjectType IN (${inList(part)})`)).records) : none(),
      (async () => {
        const out = [];
        if (!has) return out;
        for (const part of chunk(permMuted, FIELD_CHUNK)) {
          for (const ids of chunk(compIds, 100)) {
            const { records } = await api.query(`SELECT Id, ${part.join(", ")} FROM PermissionSet WHERE Id IN (${inList(ids)})`);
            out.push(...records);
          }
        }
        return out;
      })(),
      has ? componentGrants(api, compIds, tabMuted, async (ids, part) =>
        (await api.query(`SELECT Name, Visibility FROM PermissionSetTabSetting WHERE ParentId IN (${inList(ids)}) AND Name IN (${inList(part)})`)).records) : none(),
      setupRecords(api, [muting.id]),
    ]);

    // Fields: Read=true mutes Read and Edit; Edit=true mutes Edit only.
    const fGiven = {};
    for (const r of fRecs) {
      const g = (fGiven[r.Field] ||= { Read: false, Edit: false });
      g.Read ||= r.PermissionsRead === true;
      g.Edit ||= r.PermissionsEdit === true;
    }
    for (const [k, m] of fldMuted) {
      const g = fGiven[k] || {};
      const a = agg.fldPerms[k] || {};
      const Read = !!(m.Read && g.Read && !a.Read);
      const Edit = !!((m.Read || m.Edit) && g.Edit && !a.Edit);
      if (Read || Edit) eff.fieldPermissions[k] = { Read, Edit };
    }
    // Objects: the flags a component gives that the aggregate does not have.
    const oGiven = {};
    for (const r of oRecs) {
      const g = (oGiven[r.SobjectType] ||= {});
      for (const f of opFields) if (r[f] === true) g[f.replace(/^Permissions/, "")] = true;
    }
    for (const [k] of objMuted) {
      const removed = {};
      for (const f of Object.keys(oGiven[k] || {})) if (!agg.objPerms[k]?.[f]) removed[f] = true;
      if (Object.keys(removed).length) eff.objectPermissions[k] = removed;
    }
    // General permissions.
    for (const k of permMuted) {
      if (pRecs.some((r) => r[k] === true) && !(k in agg.userPermissions)) eff.userPermissions[k] = muting.userPermissions[k];
    }
    // Tabs.
    const tGiven = {};
    for (const r of tRecs) if (r.Visibility && r.Visibility !== "Hidden") tGiven[r.Name] ||= r.Visibility;
    for (const k of tabMuted) {
      const inAgg = agg.tabs[k] && agg.tabs[k] !== "Hidden";
      if (tGiven[k] && !inAgg) eff.tabSettings[k] = tGiven[k];
    }
    // Apps, pages and code (only if the muting set has any).
    if (sMuted.length) {
      total += sMuted.length;
      const given = new Set();
      if (has) {
        for (const part of chunk(sMuted.map((r) => r.SetupEntityId), ID_CHUNK)) {
          for (const ids of chunk(compIds, 50)) {
            for (const r of await setupRecords(api, ids, ` AND SetupEntityId IN (${inList(part)})`)) given.add(r.SetupEntityId.slice(0, 15));
          }
        }
      }
      const inAgg = new Set((agg.setupRecs || []).map((r) => r.SetupEntityId.slice(0, 15)));
      const removed = sMuted.filter((r) => given.has(r.SetupEntityId.slice(0, 15)) && !inAgg.has(r.SetupEntityId.slice(0, 15)));
      Object.assign(eff.setupAccess, await nameSetup(api, removed, warnings));
    }
    const effective = Object.keys(eff.fieldPermissions).length + Object.keys(eff.objectPermissions).length +
      Object.keys(eff.userPermissions).length + Object.keys(eff.tabSettings).length + Object.keys(eff.setupAccess).length;
    eff.nothingToTake = Math.max(0, total - effective);
    return eff;
  } catch (e) {
    warnings.push(`Could not work out what the muting permission set really takes away (${e.message}).`);
    return null;
  }
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
    const ps = [];
    for (const part of chunk(compIds, ID_CHUNK)) {
      const { records } = await api.query(
        `SELECT Id, Name, Label, Type, NamespacePrefix, LicenseId, Description FROM PermissionSet WHERE Id IN (${part.map(soqlString).join(", ")})`
      );
      ps.push(...records);
    }
    const seen = new Set(ps.map((p) => p.Id.slice(0, 15)));
    const lic = await licenceNames(api, [...new Set(ps.map((p) => p.LicenseId).filter(Boolean))], warnings);
    for (const p of ps) {
      const c = {
        id: p.Id,
        name: qualified(p.NamespacePrefix, p.Name),
        label: tidy(p.Label),
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
      [muting.userPermissions, muting.objectPermissions, muting.fieldPermissions, muting.tabSettings] = await Promise.all([
        truePermissions(api, muting.sobject, muting.id, mFields),
        objectPermissions(api, muting.id, opFields),
        fieldPermissions(api, muting.id),
        tabSettings(api, muting.id),
      ]);
    } catch (e) {
      muting.userPermissions = muting.objectPermissions = muting.fieldPermissions = muting.tabSettings = undefined;
      warnings.push(`Could not read what the muting permission set removes (${e.message}).`);
    }
  };
  const readGlobal = api.describeGlobal().catch((e) => {
    warnings.push(`Could not read object names; API names are shown instead (${e.message}).`);
    return { sobjects: [] };
  });

  // Field labels start as soon as the field lists are known, while the other reads finish.
  const fldP = fieldPermissions(api, agg.Id);
  const mutingP = readMuting();
  const labelsP = Promise.all([fldP, mutingP]).then(([f]) =>
    readFieldLabels(api, [...Object.keys(f), ...Object.keys(muting?.fieldPermissions || {})], warnings));
  const [userPermissions, objPerms, fldPerms, setupRead, tabs, assigned, assignedActive, global] = await Promise.all([
    truePermissions(api, "PermissionSet", agg.Id, psFields),
    objectPermissions(api, agg.Id, opFields),
    fldP,
    setupRecords(api, [agg.Id]).then(async (recs) => ({ recs, named: await nameSetup(api, recs, warnings) })),
    tabSettings(api, agg.Id),
    api.count(`SELECT COUNT() FROM PermissionSetAssignment WHERE PermissionSetGroupId = ${idLit}`),
    api.count(`SELECT COUNT() FROM PermissionSetAssignment WHERE PermissionSetGroupId = ${idLit} AND Assignee.IsActive = true`),
    readGlobal,
    mutingP,
  ]);

  const setup = setupRead.named;
  const setupRecs = setupRead.recs;
  progress("Checking what muting takes away");
  const aggregate = { userPermissions, objPerms, fldPerms, tabs, setupRecs };
  const [effective, fieldLabels] = await Promise.all([
    muting?.userPermissions
      ? mutedEffect(api, muting, components.filter((c) => !c.isMuting).map((c) => c.id), aggregate, opFields, warnings)
      : null,
    labelsP,
  ]);
  if (muting && effective) muting.effective = effective;

  progress("Putting it together");
  const wanted = new Set([
    ...Object.keys(objPerms),
    ...Object.keys(fldPerms).map((f) => f.split(".")[0]),
    ...Object.keys(tabs).map((t) => t.replace(/^standard-/, "")),
    ...Object.keys(muting?.objectPermissions || {}),
    ...Object.keys(muting?.fieldPermissions || {}).map((f) => f.split(".")[0]),
    ...Object.keys(muting?.tabSettings || {}).map((t) => t.replace(/^standard-/, "")),
  ]);
  const objectLabels = {};
  for (const o of global.sobjects || []) if (wanted.has(o.name)) objectLabels[o.name] = tidy(o.label);

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
    fieldLabels,
    warnings,
  };
}

/** Check that a parsed JSON file is a snapshot this tool can read. */
export function validateSnapshot(s) {
  if (!s || typeof s !== "object" || !ACCEPTED_SCHEMAS.includes(s.schema)) {
    throw new Error(`Not a PSG snapshot (expected schema "${SNAPSHOT_SCHEMA}").`);
  }
  for (const k of ["psg", "components", "userPermissions", "objectPermissions", "fieldPermissions", "setupAccess", "tabSettings"]) {
    if (!(k in s)) throw new Error(`Snapshot is missing "${k}".`);
  }
  return s;
}
