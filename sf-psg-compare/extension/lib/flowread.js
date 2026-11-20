// Read flows from an org. Read-only: every call is a GET (a SOQL query or a describe) through SfApi.
// Nothing is written to the org and nothing is stored. The flow contents live in a Map the caller owns,
// in memory, for the page session only.

import { soqlString } from "./sfconn.js";
import { pickByDeveloperName, isObjectId, isFieldId } from "./urlcontext.js";

const FLOW_VERSION_ID = /^301[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

const LIST_FIELDS = [
  "Id", "DurableId", "ApiName", "Label", "ProcessType", "TriggerType", "TriggerObjectOrEventLabel", "RecordTriggerType",
  "IsActive", "ActiveVersionId", "LatestVersionId", "NamespacePrefix", "ManageableState", "TriggerOrder", "LastModifiedDate",
  "HasAsyncAfterCommitPath", "TriggerObjectOrEvent.QualifiedApiName", // the trigger object's API name (the label above is not unique)
];
const MIN_FIELDS = ["Id", "DurableId", "ApiName", "Label", "ProcessType", "IsActive", "ActiveVersionId", "LatestVersionId", "NamespacePrefix", "ManageableState"];

const flowDef = (r) => ({
  id: r.DurableId || r.Id,
  apiName: r.ApiName || "",
  label: r.Label || r.ApiName || "",
  processType: r.ProcessType || "",
  triggerType: r.TriggerType || "",
  triggerObject: r.TriggerObjectOrEventLabel || "", // a label: for showing, never for matching
  triggerObjectName: r.TriggerObjectOrEvent?.QualifiedApiName || "", // the API name: what objects are matched by
  hasAsyncPath: !!r.HasAsyncAfterCommitPath,
  recordTriggerType: r.RecordTriggerType || "",
  isActive: !!r.IsActive,
  activeVersionId: r.ActiveVersionId || null,
  latestVersionId: r.LatestVersionId || null,
  namespace: r.NamespacePrefix || "",
  managed: r.ManageableState === "installed",
  triggerOrder: r.TriggerOrder ?? null,
  lastModified: r.LastModifiedDate || "",
});

/** Every flow of the org, as plain objects. One query (the answer is paged). If the org rejects an optional column
 *  (the error names it), that column is left out and the query is asked again; if the error does not name one, a short list is asked for. */
export async function readFlowList(api) {
  let cols = [...LIST_FIELDS];
  let records;
  for (let attempt = 0; ; attempt++) {
    try {
      ({ records } = await api.query(`SELECT ${cols.join(", ")} FROM FlowDefinitionView`));
      break;
    } catch (e) {
      const msg = `${e?.errorCode || ""} ${e?.message || ""}`;
      if (!/INVALID_FIELD|No such column/i.test(msg)) throw e;
      const named = msg.match(/column '([\w.]+)'/i)?.[1]?.toLowerCase();
      const next = named ? cols.filter((c) => c.toLowerCase() !== named && !c.toLowerCase().startsWith(`${named}.`)) : null;
      if (next && next.length < cols.length && next.length >= MIN_FIELDS.length && attempt < 5) { cols = next; continue; }
      ({ records } = await api.query(`SELECT ${MIN_FIELDS.join(", ")} FROM FlowDefinitionView`));
      break;
    }
  }
  return records.map(flowDef);
}

/** Which flow versions to read: the active version of each active flow; with `includeInactive`, also the
 *  latest version of each flow where that is not the active one (drafts, and flows that are off).
 *  Returns [{def, versionId, versionKind: "active" | "latest"}]. A flow whose version has no usable Id
 *  (some installed packages) is kept with `versionId: null`, so it can be listed as "could not look inside". */
export function versionsToRead(defs, { includeInactive = false } = {}) {
  const jobs = [];
  for (const def of defs) {
    if (def.isActive && def.activeVersionId) jobs.push({ def, versionId: def.activeVersionId, versionKind: "active" });
    if (includeInactive && def.latestVersionId && def.latestVersionId !== def.activeVersionId) {
      jobs.push({ def, versionId: def.latestVersionId, versionKind: "latest" });
    }
  }
  return jobs.map((j) => (FLOW_VERSION_ID.test(j.versionId) ? j : { ...j, versionId: null, badId: j.versionId }));
}

/** The contents of one flow version (Tooling API). `metadata` is null when Salesforce does not return them
 *  (flows from installed packages). One call per version: Salesforce returns Metadata only for a single row. */
export async function readFlowVersion(api, versionId) {
  const { records } = await api.query(`SELECT Id, Metadata FROM Flow WHERE Id = ${soqlString(versionId)}`, { tooling: true });
  const m = records[0]?.Metadata;
  return { metadata: m && typeof m === "object" ? m : null };
}

/** Read the given jobs (`read(versionId)` returns {metadata}; for the org it is readFlowVersion) a few at a time into `cache` (Map of version Id -> {metadata} or {error}). Versions already in the
 *  cache are not read again. One failure never stops the rest. `onProgress(done, total)` is called after each one.
 *  Returns how many reads were made. */
export async function readVersions(read, jobs, cache, { concurrency = 5, onProgress } = {}) {
  const todo = [...new Set(jobs.map((j) => j.versionId).filter((id) => id && !cache.has(id)))];
  const total = todo.length;
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const id = todo[next++];
      try {
        cache.set(id, await read(id));
      } catch (e) {
        cache.set(id, { error: e });
      }
      done++;
      onProgress?.(done, total);
    }
  };
  onProgress?.(0, total);
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return total;
}

/** Why a flow could not be looked into, in plain words, and the raw text for "Technical details".
 *  Returns null when the contents are there. */
export function whyUnreadable(job, entry) {
  if (!job.versionId) {
    return { plain: "This flow comes from an installed package, and Salesforce does not let us look inside it.", raw: job.badId ? `Version id: ${job.badId}` : "" };
  }
  if (entry?.error) {
    return { plain: "Salesforce would not let us read this flow.", raw: String(entry.error.message || entry.error) };
  }
  if (!entry?.metadata) {
    return job.def.managed
      ? { plain: "This flow comes from an installed package, and Salesforce does not let us look inside it.", raw: "" }
      : { plain: "Salesforce did not return the contents of this flow.", raw: "" };
  }
  return null;
}

/** Turn what a Setup address held (API names or Ids) into API names, using the org. Reads: Tooling CustomObject and CustomField
 *  by Id, then the org's own list of names to settle the suffix. Returns {object, field, notes}; a part that cannot be
 *  turned into a name comes back "". */
export async function resolveContext(api, { object = "", field = "" } = {}) {
  const notes = [];
  let obj = object;
  let fld = field;
  let parts = null; // developer name and namespace of a custom field given by Id
  try {
    if (isFieldId(fld)) {
      const { records } = await api.query(
        `SELECT DeveloperName, NamespacePrefix, TableEnumOrId FROM CustomField WHERE Id = ${soqlString(fld)}`, { tooling: true });
      const r = records[0];
      fld = "";
      if (r) {
        parts = { dev: r.DeveloperName, ns: r.NamespacePrefix || "" };
        if (r.TableEnumOrId && (!obj || isObjectId(obj))) obj = r.TableEnumOrId; // an object name, or an 01I Id
      }
    }
    if (isObjectId(obj)) {
      const { records } = await api.query(
        `SELECT DeveloperName, NamespacePrefix FROM CustomObject WHERE Id = ${soqlString(obj)}`, { tooling: true });
      const r = records[0];
      const names = r ? (await api.describeGlobal()).sobjects.map((s) => s.name) : [];
      obj = r ? pickByDeveloperName(names, r.NamespacePrefix || "", r.DeveloperName) : "";
    }
    if (parts && obj) {
      const d = await api.describe(obj);
      fld = pickByDeveloperName(d.fields.map((f) => f.name), parts.ns, parts.dev);
    }
  } catch (e) {
    notes.push(`Could not turn the address of this Setup page into names (${e.message}).`);
    if (isObjectId(obj)) obj = "";
    if (isFieldId(fld)) fld = "";
  }
  return { object: obj, field: fld, notes };
}
