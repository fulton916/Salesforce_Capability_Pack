// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Looks inside one flow version for a field, or for a piece of text or a record Id. Pure: no browser
// or network APIs. The caller hands in the flow version's Metadata (the Tooling API shape) and, for
// relationship paths, a `describe(objectApiName)` function that returns an object describe
// ({fields: [{name, relationshipName, referenceTo}]}) or null. Nothing here reads or writes the org.
//
// scanFlow() also records, for every record element, which object it touches and what it does
// (get / create / update / delete), and the flow's trigger. That list (`records`, `trigger`) does not
// depend on what was searched for, so a later "which flows touch this object" view can reuse it.

import { toCsv } from "../../shared/csv.js";

export { toCsv };

// ---------- plain words ----------

/** Plain name for each top-level list in the Metadata. */
export const ELEMENT_KINDS = {
  start: "Start",
  recordLookups: "Get Records",
  recordUpdates: "Update Records",
  recordCreates: "Create Records",
  recordDeletes: "Delete Records",
  recordRollbacks: "Roll Back Records",
  decisions: "Decision",
  assignments: "Assignment",
  screens: "Screen",
  actionCalls: "Action",
  apexPluginCalls: "Apex plug-in",
  subflows: "Subflow",
  loops: "Loop",
  waits: "Wait",
  formulas: "Formula",
  textTemplates: "Text template",
  constants: "Constant",
  variables: "Variable",
  choices: "Choice",
  dynamicChoiceSets: "Choice set",
  transforms: "Transform",
  collectionProcessors: "Collection step",
  customErrors: "Custom error",
  steps: "Step",
  orchestratedStages: "Orchestration stage",
};

const ACTION_TYPES = { emailSimple: "Send Email", apex: "Apex action", flow: "Subflow" };

const RECORD_OPS = {
  recordLookups: "get",
  recordCreates: "create",
  recordUpdates: "update",
  recordDeletes: "delete",
};

function humanize(key) {
  return String(key).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

/** Plain-words description of a flow from its FlowDefinitionView row. */
export function plainFlowType(def) {
  const pt = def.processType || "";
  const tt = def.triggerType || "";
  const obj = def.triggerObject ? ` (${def.triggerObject})` : "";
  if (/approval/i.test(pt)) return "Approval flow";
  const when = { Create: "created", Update: "updated", CreateAndUpdate: "created or updated", Delete: "deleted" }[def.recordTriggerType || ""] || "saved";
  if (tt === "RecordAfterSave") return `Runs after a record is ${when}${obj}`;
  if (tt === "RecordBeforeSave") return `Runs before a record is ${when}${obj}`;
  if (tt === "RecordBeforeDelete") return `Runs before a record is deleted${obj}`;
  if (tt === "Scheduled") return `Scheduled${obj}`;
  if (tt === "PlatformEvent") return `Runs when a platform event arrives${obj}`;
  if (pt === "Workflow") return "Process Builder";
  if (pt === "InvocableProcess") return "Process Builder (started by another process)";
  if (pt === "CustomEvent") return "Process Builder (started by an event)";
  if (pt === "Flow") return "Screen flow";
  if (pt === "ApprovalWorkflow") return "Approval flow";
  if (pt === "Orchestrator") return "Orchestration";
  if (pt === "Survey") return "Survey";
  if (pt === "RoutingFlow") return "Routing flow";
  if (pt === "CheckoutFlow") return "Checkout flow";
  if (pt === "AutoLaunchedFlow") {
    if (!tt || tt === "OnDemandNoTrigger") return "Autolaunched flow (started by something else)";
    return `Autolaunched flow (${humanize(tt).toLowerCase()})`;
  }
  return pt ? humanize(pt) : "Flow";
}

// ---------- Ids ----------

const ID_RE = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** True when `text` looks like a Salesforce record Id (15 or 18 letters and digits, a digit in the first 3). */
export function looksLikeId(text) {
  const t = String(text || "").trim();
  return ID_RE.test(t) && /\d/.test(t.slice(0, 3));
}

/** The 15-character and 18-character forms of an Id (the same text twice is never returned). */
export function idForms(text) {
  const t = String(text || "").trim();
  if (!ID_RE.test(t)) return [t];
  if (t.length === 18) return [t, t.slice(0, 15)];
  let suffix = "";
  for (let i = 0; i < 3; i++) {
    let n = 0;
    for (let j = 0; j < 5; j++) if (/[A-Z]/.test(t[i * 5 + j])) n |= 1 << j;
    suffix += "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"[n];
  }
  return [t, t + suffix];
}

// ---------- reading the Metadata ----------

const lc = (s) => String(s ?? "").toLowerCase();
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Every element of the flow: [{key, kind, name, label, node}]. The start element comes first. */
export function elementsOf(meta) {
  const out = [];
  if (isObj(meta?.start)) out.push({ key: "start", kind: "Start", name: "Start", label: "Start", node: meta.start });
  for (const [key, v] of Object.entries(meta || {})) {
    if (key === "start" || !Array.isArray(v)) continue;
    if (key === "processMetadataValues") continue;
    for (const node of v) {
      if (!isObj(node)) continue;
      let kind = ELEMENT_KINDS[key] || humanize(key);
      if (key === "actionCalls" && ACTION_TYPES[node.actionType]) kind = ACTION_TYPES[node.actionType];
      out.push({ key, kind, name: node.name || "", label: node.label || node.name || "", node });
    }
  }
  return out;
}

/** "Get_Account[0].Name" -> ["Get_Account", "Name"]. Brackets (list positions, $EachItem) are dropped. */
export function refSegments(ref) {
  return String(ref || "").replace(/\[[^\]]*\]/g, "").split(".").map((s) => s.trim()).filter(Boolean);
}

const SPECIAL_HEADS = { $user: "User", $profile: "Profile", $organization: "Organization" };

/** What each name in the flow stands for: {names: Map(lower-case name -> object API name), plain: Set of names that are not records}. */
function buildNames(meta) {
  const names = new Map();
  const plain = new Set();
  const start = isObj(meta?.start) ? meta.start : {};
  if (start.object) {
    names.set("$record", start.object);
    names.set("$record__prior", start.object);
  }
  const els = elementsOf(meta);
  for (const e of els) {
    const n = e.node;
    if (!e.name) continue;
    if (e.key === "variables") {
      if (n.objectType) names.set(lc(e.name), n.objectType);
      else if (n.dataType !== "SObject") plain.add(lc(e.name));
    } else if (e.key === "recordLookups") {
      if (n.storeOutputAutomatically && n.object) names.set(lc(e.name), n.object);
      else plain.add(lc(e.name));
    } else if (e.key === "transforms") {
      if (n.objectType) names.set(lc(e.name), n.objectType);
    } else if (!["loops", "collectionProcessors"].includes(e.key)) {
      plain.add(lc(e.name));
    }
  }
  // Fields on screens are plain names too.
  const walkFields = (list) => {
    for (const f of list || []) {
      if (f?.name) plain.add(lc(f.name));
      walkFields(f?.fields);
    }
  };
  for (const s of meta?.screens || []) walkFields(s.fields);
  // Loops and collection steps take the type of their collection; they can depend on each other, so repeat.
  for (let pass = 0; pass < 4; pass++) {
    for (const e of els) {
      if (!["loops", "collectionProcessors"].includes(e.key)) continue;
      const segs = refSegments(e.node.collectionReference);
      const obj = segs.length === 1 ? names.get(lc(segs[0])) : null;
      if (!obj) continue;
      names.set(lc(e.name), obj);
      if (e.node.assignNextValueToReference) names.set(lc(e.node.assignNextValueToReference), obj);
    }
  }
  return { names, plain, start };
}

/** What the flow runs on: {object, triggerType, recordTriggerType}. */
function triggerOf(meta) {
  const s = isObj(meta?.start) ? meta.start : {};
  return { object: s.object || null, triggerType: s.triggerType || null, recordTriggerType: s.recordTriggerType || null };
}

/** The record elements of a flow: [{element, label, kind, op: get|create|update|delete, object, objectKnown}].
 *  `object` is the API name (or null when it cannot be told, for example a record variable of no known type).
 *  This version uses the names that need no describe; scanFlow() also follows loops over related lists. */
export function recordElements(meta) {
  return recordElementsFrom(meta, buildNames(meta).names);
}

function recordElementsFrom(meta, names) {
  const out = [];
  for (const e of elementsOf(meta)) {
    const op = RECORD_OPS[e.key];
    if (!op) continue;
    let object = e.node.object || null;
    if (!object && e.node.inputReference) {
      const segs = refSegments(e.node.inputReference);
      object = segs.length === 1 ? names.get(lc(segs[0])) || null : null;
    }
    out.push({ element: e.name, label: e.label, kind: e.kind, op, object, objectKnown: !!object });
  }
  return out;
}

/** The object a related list (child records) or a lookup stands for: "Contacts" on Account -> Contact. */
async function relatedType(obj, rel, describe) {
  const [name, pinned] = String(rel).split(":");
  if (pinned) return pinned;
  const d = await describe(obj);
  const child = (d?.childRelationships || []).find((c) => c.relationshipName && lc(c.relationshipName) === lc(name));
  if (child?.childSObject) return child.childSObject;
  const f = (d?.fields || []).find((x) => x.relationshipName && lc(x.relationshipName) === lc(name));
  return f && (f.referenceTo || []).length === 1 ? f.referenceTo[0] : null;
}

/** Loops over a related list ("$Record.Contacts", "acct.Contacts") take the child object's type, found through the
 *  parent object's describe (childRelationships: relationshipName -> childSObject). Adds to `info.names`. */
async function extendNames(info, meta, describe) {
  const loops = elementsOf(meta).filter((e) => ["loops", "collectionProcessors"].includes(e.key) && e.name);
  const give = (e, obj) => {
    info.names.set(lc(e.name), obj);
    if (e.node.assignNextValueToReference) info.names.set(lc(e.node.assignNextValueToReference), obj);
  };
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const e of loops) {
      if (info.names.has(lc(e.name))) continue;
      const segs = refSegments(e.node.collectionReference);
      if (segs.length < 2) continue;
      let obj = info.names.get(lc(segs[0])) || null;
      for (const rel of segs.slice(1)) {
        if (!obj) break;
        obj = await relatedType(obj, rel, describe);
      }
      if (!obj) continue;
      give(e, obj);
      changed = true;
    }
    if (!changed) break;
    // a loop over a loop that has just been typed
    for (const e of loops) {
      const segs = refSegments(e.node.collectionReference);
      const obj = segs.length === 1 ? info.names.get(lc(segs[0])) : null;
      if (obj && !info.names.has(lc(e.name))) give(e, obj);
    }
  }
}

// ---------- searching for a field ----------

const REF_KEYS = new Set([
  "elementReference", "leftValueReference", "assignToReference", "objectFieldReference",
  "collectionReference", "inputReference", "outputReference", "transformValueReference",
]);
const PART_PARENTS = new Set(["rules", "fields", "waitEvents", "scheduledPaths"]);
const MERGE = /\{!\s*([^}]+?)\s*\}/g;

/** Walk every node of one element. `visit(node, key, path, part)` is called for each string value. */
function walkStrings(node, visit, path = [], part = "") {
  if (Array.isArray(node)) {
    for (const v of node) walkStrings(v, visit, path, part);
    return;
  }
  if (!isObj(node)) return;
  const parent = path[path.length - 1];
  if (PART_PARENTS.has(parent) && (node.label || node.name)) part = node.label || node.name;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "string") visit(v, k, path, part);
    else if (v && typeof v === "object") walkStrings(v, visit, [...path, k], part);
  }
}

/** Collect, for one flow, every place that could be the target field. Returns candidates still to be checked against describes. */
function collectCandidates(meta, target, info) {
  const { names, plain } = info;
  const want = lc(target.field);
  const cands = [];
  const trigger = info.start.object || null;

  /** A reference such as "$Record.Account.Status__c". */
  const addRef = (elem, ref, action, part) => {
    const segs = refSegments(ref);
    if (segs.length < 2 || lc(segs[segs.length - 1]) !== want) return;
    const head = lc(segs[0]);
    let start;
    let rest = segs.slice(1);
    if (head === "$setup") {
      if (segs.length < 3) return;
      start = [segs[1]];
      rest = segs.slice(2);
    } else if (SPECIAL_HEADS[head]) start = [SPECIAL_HEADS[head]];
    else if (names.has(head)) start = [names.get(head)];
    else if (head.startsWith("$")) {
      if (head !== "$record" && head !== "$record__prior") return; // $Flow, $Label, $Api ... are not records
      start = null;
    } else if (plain.has(head)) return;
    else start = null;
    cands.push({ elem, action, rest, start, ref: segs.join("."), part });
  };

  /** A field name on a known object (record elements). The name may be a path such as "Account.Name". */
  const addField = (elem, object, field, action, part = "") => {
    if (!field || typeof field !== "string") return;
    const segs = refSegments(field);
    if (!segs.length || lc(segs[segs.length - 1]) !== want) return;
    cands.push({ elem, action, rest: segs, start: object ? [object] : null, ref: field, part });
  };

  for (const elem of elementsOf(meta)) {
    const n = elem.node;
    const key = elem.key;
    const recordObject = () => n.object || (n.inputReference && names.get(lc(refSegments(n.inputReference)[0]))) || null;

    // References and merge fields anywhere in the element.
    walkStrings(n, (value, k, path, part) => {
      if (REF_KEYS.has(k)) {
        const action = k === "assignToReference" ? "sets" : k === "leftValueReference" && path.includes("conditions") ? "checks" : "uses";
        addRef(elem, value, action, part);
      }
      if (value.includes("{!")) {
        const action = k === "filterFormula" ? "checks" : "uses";
        for (const m of value.matchAll(MERGE)) addRef(elem, m[1], action, part);
      }
    });

    // Field names the record elements carry.
    if (key in RECORD_OPS || key === "start" || key === "dynamicChoiceSets") {
      const obj = key === "start" ? n.object : recordObject();
      for (const f of n.filters || []) addField(elem, obj, f.field, "checks");
      for (const f of n.inputAssignments || []) if (f.field) addField(elem, obj, f.field, "sets");
      for (const f of n.outputAssignments || []) addField(elem, obj, f.field, "uses");
      for (const f of n.queriedFields || []) addField(elem, obj, f, "uses");
      addField(elem, obj, n.sortField, "uses");
      for (const p of n.scheduledPaths || []) addField(elem, obj, p.recordField, "uses", p.label || p.name || "");
      if (key === "dynamicChoiceSets") {
        addField(elem, obj, n.displayField, "uses");
        addField(elem, obj, n.valueField, "uses");
        addField(elem, n.picklistObject || obj, n.picklistField, "uses");
      }
    }
    if (key === "transforms") {
      walkStrings(n, (value, k) => { if (k === "outputFieldApiName") addField(elem, n.objectType, value, "sets"); });
    }
    if (key === "collectionProcessors") {
      const obj = names.get(lc(elem.name)) || null;
      for (const s of n.sortOptions || []) addField(elem, obj, s.sortField, "uses");
    }
    if (key === "customErrors") {
      for (const m of n.customErrorMessages || []) addField(elem, trigger, m.fieldSelection, "uses");
    }
  }
  return cands;
}

/** A flow-wide cache around the caller's describe, so a name is asked for once. Failures count as "unknown". */
function cachedDescribe(describe) {
  const cache = new Map();
  return async (obj) => {
    const k = lc(obj);
    if (!cache.has(k)) {
      cache.set(k, (async () => {
        try { return (await describe?.(obj)) || null; } catch { return null; }
      })());
    }
    return cache.get(k);
  };
}

/** Follow `rest` (relationship names, then the field) from the object(s) in `start`.
 *  Returns {objects, certain, lost}: the object(s) the final field sits on; `certain` is false when a step was polymorphic
 *  or could not be followed; `lost` is true when some step could not be followed at all. */
async function follow(start, rest, describe) {
  let cur = start;
  let certain = true;
  let lost = false;
  for (const step of rest.slice(0, -1)) {
    // A polymorphic relationship can be pinned to one type: "Parent:Account".
    const [rel, pinned] = step.split(":");
    const next = [];
    for (const o of cur) {
      const d = await describe(o);
      const f = (d?.fields || []).find((x) => x.relationshipName && lc(x.relationshipName) === lc(rel));
      if (!f) { certain = false; lost = true; continue; }
      const to = f.referenceTo || [];
      if (pinned) {
        const hit = to.find((t) => lc(t) === lc(pinned));
        if (hit) next.push(hit);
        else { certain = false; lost = true; }
        continue;
      }
      if (to.length > 1) certain = false;
      next.push(...to);
    }
    cur = [...new Set(next)];
    if (!cur.length) return { objects: [], certain: false, lost: true };
  }
  return { objects: cur, certain, lost };
}

/** Look for a field of an object. `target` is {kind: "field", object, field}. */
async function scanField(meta, target, describe, info) {
  const cands = collectCandidates(meta, target, info);
  const sure = [];
  const possible = [];
  const seen = new Map();
  const push = (list, c, confidence) => {
    // The same step doing the same thing with the same field is one hit; the different ways it was written are kept in `refs`.
    const k = `${c.elem.key}|${c.elem.name}|${c.action}|${confidence}|${c.part}`;
    const same = seen.get(k + "|" + lc(c.rest[c.rest.length - 1]));
    if (same) {
      if (!same.refs.some((r) => lc(r) === lc(c.ref))) same.refs.push(c.ref);
      return;
    }
    const hit = {
      element: c.elem.name, label: c.elem.label, kind: c.elem.kind, action: c.action, ref: c.ref, refs: [c.ref],
      field: c.rest[c.rest.length - 1], part: c.part || "", confidence,
    };
    seen.set(k + "|" + lc(hit.field), hit);
    list.push(hit);
  };
  for (const c of cands) {
    if (!c.start) { push(possible, c, "possible"); continue; }
    const { objects, certain, lost } = await follow(c.start, c.rest, describe);
    if (!objects.length) { push(possible, c, "possible"); continue; }
    const onTarget = objects.some((o) => lc(o) === lc(target.object));
    if (!onTarget) {
      if (lost) push(possible, c, "possible"); // a step we could not follow: it might still end on the target
      continue;
    }
    if (certain && objects.length === 1) push(sure, c, "sure");
    else push(possible, c, "possible");
  }
  const wholeRecord = [];
  for (const e of elementsOf(meta)) {
    if ((e.key === "recordCreates" || e.key === "recordUpdates") && e.node.inputReference && !(e.node.inputAssignments || []).length) {
      const obj = info.names.get(lc(refSegments(e.node.inputReference)[0]));
      if (obj && lc(obj) === lc(target.object)) {
        wholeRecord.push({ element: e.name, label: e.label, kind: e.kind });
        // The step names no fields, so it is a possible match, never a sure one.
        possible.push({
          element: e.name, label: e.label, kind: e.kind, action: "sets", ref: e.node.inputReference, refs: [e.node.inputReference],
          field: target.field, part: "", confidence: "possible", detail: `saves a whole ${obj} record, so it may set this field`,
        });
      }
    }
  }
  return { hits: sure, possible, wholeRecord };
}

// ---------- searching for text ----------

function snippet(value, at, len) {
  const from = Math.max(0, at - 30);
  const s = value.slice(from, at + len + 30).replace(/\s+/g, " ").trim();
  return (from > 0 ? "…" : "") + s + (at + len + 30 < value.length ? "…" : "");
}

/** Find text (or a record Id, in both its 15- and 18-character forms) in every string of the flow. Not case sensitive. */
function scanText(meta, text) {
  const needles = (looksLikeId(text) ? idForms(text) : [String(text).trim()]).filter(Boolean).map(lc);
  const hits = [];
  if (!needles.length) return { hits, possible: [], wholeRecord: [] };
  const seen = new Map();
  const check = (elem, value, k, part) => {
    const low = lc(value);
    for (const nd of needles) {
      const at = low.indexOf(nd);
      if (at < 0) continue;
      const key = `${elem.key}|${elem.name}|${k}|${part}`;
      if (seen.has(key)) return;
      const hit = { element: elem.name, label: elem.label, kind: elem.kind, action: "uses", ref: snippet(value, at, nd.length), field: k, part: part || "", confidence: "sure" };
      seen.set(key, hit);
      hits.push(hit);
      return;
    }
  };
  for (const elem of elementsOf(meta)) walkStrings(elem.node, (v, k, _p, part) => check(elem, v, k, part));
  const flowLevel = { key: "", kind: "Flow settings", name: "", label: "Flow settings" };
  for (const [k, v] of Object.entries(meta || {})) if (typeof v === "string") check(flowLevel, v, k, "");
  return { hits, possible: [], wholeRecord: [] };
}

/** Scan one flow version.
 *  `target` is {kind: "field", object, field} or {kind: "text", text}.
 *  Returns {hits, possible, wholeRecord, records, trigger}. `records` and `trigger` do not depend on the target. */
export async function scanFlow(meta, target, { describe } = {}) {
  const cd = cachedDescribe(describe);
  const info = buildNames(meta);
  await extendNames(info, meta, cd);
  const base = { records: recordElementsFrom(meta, info.names), trigger: triggerOf(meta) };
  if (!target) return { hits: [], possible: [], wholeRecord: [], ...base };
  if (target.kind === "text") return { ...scanText(meta, target.text), ...base };
  const found = await scanField(meta, target, cd, info);
  return { ...found, ...base };
}

// ---------- how a flow starts (for the object view) ----------

/** What a flow's start element says, in one plain object: the object, the trigger, the entry conditions, scheduled
 *  or asynchronous paths and the schedule. For Process Builder (ProcessType Workflow) the object and the trigger come from
 *  the process's own values. Nothing is read from the org. */
export function startInfo(meta) {
  const s = isObj(meta?.start) ? meta.start : {};
  const pv = {};
  for (const m of Array.isArray(meta?.processMetadataValues) ? meta.processMetadataValues : []) {
    if (m?.name) pv[m.name] = m.value?.stringValue ?? m.value?.booleanValue ?? null;
  }
  const isProcess = lc(meta?.processType) === "workflow" || !!pv.ObjectType;
  let object = s.object || (isProcess ? pv.ObjectType : null) || null;
  if (!object && isProcess) {
    const v = (meta?.variables || []).find((x) => lc(x?.name) === "myvariable_current" && x.objectType);
    object = v?.objectType || null;
  }
  const sched = isObj(s.schedule) ? s.schedule : null;
  return {
    object,
    triggerType: s.triggerType || null,
    recordTriggerType: s.recordTriggerType || null,
    isProcess,
    processTrigger: isProcess ? String(pv.TriggerType || "") : "",
    filterLogic: s.filterLogic || "",
    filters: Array.isArray(s.filters) ? s.filters.filter(isObj) : [],
    filterFormula: s.filterFormula || "",
    requireChange: !!s.doesRequireRecordChangedToMeetCriteria,
    scheduledPaths: (Array.isArray(s.scheduledPaths) ? s.scheduledPaths : []).filter(isObj).map((p) => ({
      name: p.name || "", label: p.label || p.name || "", pathType: p.pathType || "", offsetNumber: p.offsetNumber ?? null,
      offsetUnit: p.offsetUnit || "", timeSource: p.timeSource || "", recordField: p.recordField || "",
    })),
    schedule: sched ? { frequency: sched.frequency || "", startDate: sched.startDate || "", startTime: sched.startTime || "" } : null,
  };
}

// ---------- results ----------

/** Flows are told apart by namespace and API name, never by Id. */
export const flowKey = (def) => `${def.namespace ? def.namespace + "__" : ""}${def.apiName}`.toLowerCase();

/** "Update Records 'Update Account'" (the start element has no name of its own). */
export const stepName = (h) => (h.kind === "Start" ? "Start" : `${h.kind} '${h.label}'`);

/** What a hit says in plain words: "Update Records 'Update Account': sets Status". */
export function hitText(h) {
  if (h.detail) return `${stepName(h)}: ${h.detail}`;
  const where = h.part ? ` (in ${h.part})` : "";
  return `${stepName(h)}${where}: ${h.action} ${h.field}`;
}

/** Group scans into what the page shows.
 *  `scans`: [{def, versionId, versionKind: "active" | "latest", hits, possible, wholeRecord, error?}].
 *  Returns {sure, possible, unreadable, flowsSure, flowsActive, flowsPossible}. */
export function buildResults(scans) {
  const sure = scans.filter((s) => !s.error && s.hits?.length);
  const possible = scans.filter((s) => !s.error && s.possible?.length);
  const unreadable = scans.filter((s) => s.error);
  const distinct = (list) => new Set(list.map((s) => flowKey(s.def)));
  const flows = distinct(sure);
  const active = new Set(sure.filter((s) => s.def.isActive).map((s) => flowKey(s.def)));
  const byName = (a, b) => (a.def.label || a.def.apiName).localeCompare(b.def.label || b.def.apiName);
  return {
    sure: sure.sort(byName),
    possible: possible.sort(byName),
    unreadable: unreadable.sort(byName),
    flowsSure: flows.size,
    flowsActive: active.size,
    flowsPossible: distinct(possible).size,
  };
}

/** "Rating on Account": the API name goes in brackets only when it differs from the label. */
export function nameWithApi(label, api) {
  const l = String(label ?? "").trim();
  const a = String(api ?? "").trim();
  if (!l) return a;
  return !a || l.toLowerCase() === a.toLowerCase() ? l : `${l} (${a})`;
}

/** The words of one step line in the field or text view (the page draws the same words). */
export function stepLineText(h, target) {
  if (target?.kind === "text") return `${stepName(h)}${h.part ? ` (in ${h.part})` : ""}: found “${h.ref}”`;
  if (h.detail) return `${stepName(h)}: ${h.detail}`;
  const low = (r) => String(r).toLowerCase();
  const written = (h.refs || [h.ref]).filter((r) => low(r) !== low(h.field));
  return `${stepName(h)}${h.part ? ` (in ${h.part})` : ""}: ${h.action} ${h.field}${written.length ? ` (written as ${written.join(", ")})` : ""}`;
}

/** The hits of one flow with identical step lines shown once. */
export function uniqueSteps(hits, target) {
  const seen = new Set();
  return hits.filter((h) => {
    const k = stepLineText(h, target);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** "Used in 7 flows, 5 of them active." */
export function summaryLine(r, target) {
  const n = r.flowsSure;
  let s;
  if (!n) s = target?.kind === "text" ? "That text was not found in any flow that could be read." : "No flow that could be read uses it.";
  else {
    const flowWord = n === 1 ? "flow" : "flows";
    const act = r.flowsActive === n ? (n === 1 ? ", and it is active" : ", all of them active") : r.flowsActive === 0 ? ", none of them active" : `, ${r.flowsActive} of them active`;
    s = target?.kind === "text" ? `Found in ${n} ${flowWord}${act}.` : `Used in ${n} ${flowWord}${act}.`;
  }
  if (r.flowsPossible) s += ` ${r.flowsPossible} more ${r.flowsPossible === 1 ? "flow" : "flows"} may use it (see Possible matches).`;
  return s;
}

export const CSV_HEADER = [
  "Flow", "Flow API name", "Flow type", "Active", "Version read", "Step type", "Step", "Step API name",
  "Inside", "What it does", "Field or text", "How sure",
];

export const versionWords = (versionKind, isActive) =>
  versionKind === "active" ? "Active version" : isActive ? "Newer version (not active yet)" : "Latest version (not active)";

/** One row per flow step. Sure matches first, then possible ones, then one row for each flow that could not be looked inside
 *  (so the Excel list says what it is missing). */
export function csvRows(r) {
  const rows = [CSV_HEADER];
  const add = (scan, list, how) => {
    for (const h of list) {
      rows.push([
        scan.def.label || scan.def.apiName, scan.def.apiName, plainFlowType(scan.def), scan.def.isActive ? "Yes" : "No",
        versionWords(scan.versionKind, scan.def.isActive), h.kind, h.label, h.element, h.part || "", h.action, h.detail || (h.refs || [h.ref || h.field]).join("; "), how,
      ]);
    }
  };
  for (const s of r.sure) add(s, s.hits, "Sure");
  for (const s of r.possible) add(s, s.possible, "Possible");
  for (const s of r.unreadable || []) {
    rows.push([
      s.def.label || s.def.apiName, s.def.apiName, plainFlowType(s.def), s.def.isActive ? "Yes" : "No",
      versionWords(s.versionKind, s.def.isActive), "", "", "", "", "", "", `Could not look inside: ${s.error?.plain || "the flow could not be read"}`,
    ]);
  }
  return rows;
}

export function csvText(r) {
  return toCsv(csvRows(r));
}

/** File name for the download, for example "flows_using_Account.Status__c_202611191530.csv". */
export function csvFileName(target, stamp) {
  const what = target?.kind === "text" ? `text_${target.text}` : `${target?.object || "object"}.${target?.field || "field"}`;
  return `flows_using_${what.replace(/[^\w.-]+/g, "_").slice(0, 60)}_${stamp}.csv`;
}
