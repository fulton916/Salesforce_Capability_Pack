// The object view of "Where is it used in flows?": every flow that runs when records of one object are saved or
// deleted (in the order Salesforce runs them), runs on a schedule over them, or changes or reads them. Pure: no
// browser or network APIs, nothing is read from the org here. The page hands in, for each flow, its FlowDefinitionView
// row (`def`) and, once read, what flowscan.js found (`start` from startInfo(), `records` from scanFlow()).
//
// The object is always matched by API name. FlowDefinitionView.TriggerObjectOrEventLabel is a label and labels repeat
// (two objects can both be called "Account"), so it is only ever shown, never compared.

import { toCsv } from "./compare.js";
import { plainFlowType, stepName, versionWords } from "./flowscan.js";

export { toCsv };

const lc = (s) => String(s ?? "").toLowerCase();

// ---------- when a flow runs ----------

const VERB = { Create: "created", Update: "updated", CreateAndUpdate: "created or updated", Delete: "deleted" };

/** The three groups Salesforce runs record-triggered flows in, in the order it runs them. */
export const GROUPS = [
  { key: "before", title: "Before the record is saved", help: "Fast field updates: they change the record itself before it is written." },
  { key: "after", title: "After the record is saved", help: "They run once the record is saved: related records, emails, actions." },
  { key: "delete", title: "Before the record is deleted", help: "They run just before a record is deleted." },
];

const TRIGGER_GROUP = { RecordBeforeSave: "before", RecordAfterSave: "after", RecordBeforeDelete: "delete" };

/** The part of "Runs when a record is saved" for Process Builder processes: after the record is saved, before the after-save flows. */
export const PROCESS_PART = {
  key: "process",
  title: "Process Builder processes",
  help: "Process Builder processes run after the record is saved, before the flows below. Salesforce does not promise an order among them, so they are not numbered.",
};

/** Which group a flow belongs to: before, after, delete (or null when it is not triggered by a record being saved or deleted).
 *  A Process Builder process (ProcessType Workflow) is "process": it runs after the save and before the after-save flows. */
export function groupOf(def) {
  const g = TRIGGER_GROUP[def?.triggerType || ""];
  if (g) return g;
  return def?.processType === "Workflow" ? "process" : null;
}

/** "when a record is created or updated". `start` (from startInfo) fills in what the list row does not say. */
export function whenWords(def, start) {
  if (def?.triggerType === "Scheduled") return "on a schedule";
  let verb = VERB[def?.recordTriggerType || ""] || VERB[start?.recordTriggerType || ""];
  if (!verb && def?.processType === "Workflow") {
    const p = lc(start?.processTrigger);
    verb = p === "oncreateonly" ? "created" : p === "onallchanges" ? "created or updated" : "";
  }
  return `when a record is ${verb || "saved"}`;
}

/** The words that say how flows are ordered, for the page's Notes. */
export const RUN_ORDER_RULE = "Salesforce runs flows with a trigger order of 1 to 1000 first, lowest number first. Next come flows with no trigger order, in the order they were activated. Last come flows with a trigger order of 1001 to 2000. Flows with the same trigger order run in alphabetical order of their API names. Flows that are not active do not run.";

/** The words for a block of two or more flows with no trigger order (shown once above the block). */
export function noOrderBlockText({ above = false, below = false } = {}) {
  const where = above && below ? " after the flows above and before the flows below," : above ? " after the flows above," : below ? " before the flows below," : "";
  return `No trigger order set. Salesforce runs these${where} in the order they were activated. That date isn't available here, so they are listed by name. To make the order certain, give each flow a trigger order (Flow Trigger Explorer → Edit Order).`;
}

/** Which part of a group a flow is in: "low" = trigger order 1 to 1000, "none" = no trigger order, "high" = 1001 to 2000,
 *  "off" = not active (it does not run, whatever its trigger order). */
export function runBand(def) {
  if (!def.isActive) return "off";
  const o = def.triggerOrder;
  if (o === null || o === undefined || o === "") return "none";
  return Number(o) > 1000 ? "high" : "low";
}
const BAND_RANK = { low: 0, none: 1, high: 2, off: 3 };

// Plain character-code order, as Setup's Flow Trigger Explorer sorts API names (uppercase before lowercase, "_" after capitals).
const byApiName = (a, b) => {
  const x = String(a.def.apiName);
  const y = String(b.def.apiName);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Salesforce's run order within one group (before save, after save, before delete). This is the one place that settles order.
 *  The rule (Salesforce Help, "Define the Run Order of Record-Triggered Flows for an Object"):
 *    1. active flows with a trigger order of 1 to 1000, lowest first; the same number runs in alphabetical order of API name;
 *    2. active flows with no trigger order, in the order they were ACTIVATED. We cannot read activation dates, so they are listed
 *       by API name (as Setup's Flow Trigger Explorer does) and the page says their real order is not known;
 *    3. active flows with a trigger order of 1001 to 2000, lowest first; the same number by API name.
 *  Flows that are not active do not run: they come last, by API name. Works on anything with a `def`. */
export function compareRunOrder(a, b) {
  const ba = runBand(a.def);
  const bb = runBand(b.def);
  if (ba !== bb) return BAND_RANK[ba] - BAND_RANK[bb];
  if (ba === "low" || ba === "high") {
    const d = Number(a.def.triggerOrder) - Number(b.def.triggerOrder);
    if (d) return d;
  }
  return byApiName(a, b);
}

// ---------- entry conditions in plain words ----------

const OPERATORS = {
  EqualTo: "equals", NotEqualTo: "does not equal", GreaterThan: "is greater than", GreaterThanOrEqualTo: "is at least",
  LessThan: "is less than", LessThanOrEqualTo: "is at most", Contains: "contains", StartsWith: "starts with", EndsWith: "ends with",
  In: "is one of", NotIn: "is not one of", WasSet: "was set", WasSelected: "was selected", WasVisited: "was visited",
};

function valueWords(v) {
  if (!v || typeof v !== "object") return "";
  if (v.stringValue !== undefined && v.stringValue !== null) return v.stringValue === "" ? "blank" : String(v.stringValue);
  if (v.numberValue !== undefined && v.numberValue !== null) return String(v.numberValue);
  if (v.booleanValue !== undefined && v.booleanValue !== null) return v.booleanValue ? "true" : "false";
  if (v.dateValue) return String(v.dateValue).slice(0, 10);
  if (v.dateTimeValue) return String(v.dateTimeValue);
  if (v.elementReference) return `{!${v.elementReference}}`;
  return "";
}

/** One condition as a sentence: "Status equals Closed", "Industry is blank". */
export function conditionWords(f, labelOf) {
  const name = (labelOf && labelOf(f.field)) || f.field || "A field";
  const v = f.value || f.rightValue;
  if (f.operator === "IsNull") return `${name} is ${v?.booleanValue === false ? "not blank" : "blank"}`;
  if (f.operator === "IsChanged") return `${name} has ${v?.booleanValue === false ? "not changed" : "changed"}`;
  const op = OPERATORS[f.operator] || String(f.operator || "matches");
  const val = valueWords(v);
  return val === "" ? `${name} ${op}` : `${name} ${op} ${val}`;
}

/** What has to be true for the flow to start: {has, simple, text, changeOnly}.
 *  No conditions: has is false. A formula (or too many conditions to say in a line): "has a formula condition" / "has N conditions".
 *  Otherwise the conditions in words, joined the way the flow joins them (all, any, or its own "1 AND (2 OR 3)"). */
export function entryConditions(start, labelOf) {
  const s = start || {};
  const changeOnly = !!s.requireChange;
  const filters = s.filters || [];
  if (s.filterFormula || s.filterLogic === "formula_evaluates_to_true") return { has: true, simple: false, text: "has a formula condition", changeOnly };
  if (!filters.length) return { has: false, simple: true, text: "No entry conditions: it runs for every record", changeOnly: false };
  if (filters.length > 6) return { has: true, simple: false, text: `has ${filters.length} conditions`, changeOnly };
  const parts = filters.map((f) => conditionWords(f, labelOf));
  const logic = String(s.filterLogic || "and");
  let text;
  if (/^and$/i.test(logic) || /^no_conditions$/i.test(logic) || !logic) text = parts.join(" and ");
  else if (/^or$/i.test(logic)) text = parts.join(" or ");
  else text = logic.replace(/\d+/g, (n) => `[${parts[Number(n) - 1] ?? n}]`).replace(/\bAND\b/gi, "and").replace(/\bOR\b/gi, "or");
  return { has: true, simple: true, text, changeOnly };
}

/** The scheduled and run-asynchronously paths of a record-triggered flow, in words. */
export function pathWords(start, labelOf) {
  return (start?.scheduledPaths || []).map((p) => {
    // A path with no name has no "Name:" in front of its words.
    const name = String(p.label || p.name || "").trim();
    const lead = name ? `${name}: ` : "";
    if (p.pathType === "AsyncAfterCommit") return "Runs asynchronously, after the record is saved"; // said once; the path's own name would repeat it
    const field = p.timeSource === "RecordField" && p.recordField ? ((labelOf && labelOf(p.recordField)) || p.recordField) : "";
    const n = Number(p.offsetNumber);
    const unit = String(p.offsetUnit || "days").toLowerCase();
    const from = field || "the time the record is saved";
    if (!n) return `${lead}at ${from}`;
    const one = Math.abs(n) === 1 ? unit.replace(/s$/, "") : unit;
    return `${lead}${Math.abs(n)} ${one} ${n < 0 ? "before" : "after"} ${from}`;
  });
}

/** "Runs daily at 06:00, starting 2026-02-01". (metaWords puts it after the kind: "Scheduled flow: runs daily at 06:00, starting 2026-02-01".) */
export function scheduleWords(start) {
  const s = start?.schedule;
  if (!s) return "";
  const time = s.startTime ? ` at ${String(s.startTime).slice(0, 5)}` : "";
  const date = s.startDate ? String(s.startDate).slice(0, 10) : "";
  const freq = lc(s.frequency);
  if (freq === "once") return `Runs once${date ? ` on ${date}` : ""}${time}`;
  return `Runs ${freq || "on a schedule"}${time}${date ? `, starting ${date}` : ""}`;
}

// ---------- building the view ----------

const OP_WORDS = { get: "reads", create: "creates", update: "updates", delete: "deletes" };
export const CHANGE_OPS = new Set(["create", "update", "delete"]);

const byLabel = (a, b) => (a.def.label || a.def.apiName).localeCompare(b.def.label || b.def.apiName);

/** The line under a flow's name: "Scheduled flow: runs daily at 06:00, starting 2026-02-01", or "Record-triggered flow, runs when a record
 *  is created", then "Not active (does not run)" / "no trigger order set" where they apply. No final full stop. */
export function metaWords(it) {
  let head = it.kind;
  if (it.placed) {
    head = it.schedule ? `${it.kind}: ${it.schedule.replace(/^R/, "r")}` : `${it.kind}, runs ${it.when}`;
  }
  const meta = [head];
  if (it.band === "off") meta.push("Not active (does not run)");
  else if (it.band === "none" && it.orderKnown) meta.push("no trigger order set"); // a block of them says so once, above the block
  return meta.join(", ");
}

/** The object (API name) a flow is about: the list row's trigger object, or the start element's. Never a label. */
export function entryObject(entry) {
  return entry.def.triggerObjectName || entry.start?.object || "";
}

/** Plain name of what kind of flow this is, for the list. */
export function kindWords(def) {
  if (/approval/i.test(def.processType || "")) return "Approval flow";
  if (def.processType === "Workflow") return "Process Builder";
  if (def.triggerType === "Scheduled") return "Scheduled flow";
  if (TRIGGER_GROUP[def.triggerType || ""]) return "Record-triggered flow";
  return plainFlowType(def);
}

/** Build what the page shows for one object.
 *  `object`: API name. `entries`: one per flow: {def, versionId, versionKind, error?, start?, records?}. `start` and `records` are missing
 *  until the flow has been read. `labelOf(fieldApiName)` gives a field's label (optional). `objectLabel` is only for wording.
 *  With `partial: true` (the rest of the flows are still being read) the sections that need the contents are left out and `pending` counts them. */
export function buildObjectView(object, entries, { labelOf, objectLabel, partial = false } = {}) {
  const view = {
    object, objectLabel: objectLabel || object, partial,
    groups: GROUPS.map((g) => ({ ...g, items: [] })),
    process: { ...PROCESS_PART, items: [] },
    scheduled: [], changes: [], reads: [], unreadable: [], pending: 0,
  };
  const group = (key) => (key === "process" ? view.process : view.groups.find((g) => g.key === key));
  for (const e of entries) {
    const def = e.def;
    const obj = entryObject(e);
    const key = groupOf(def);
    const known = !!e.start;
    const base = {
      def, versionId: e.versionId ?? null, versionKind: e.versionKind, label: def.label || def.apiName, apiName: def.apiName,
      isActive: !!def.isActive, kind: kindWords(def), isProcess: def.processType === "Workflow", order: def.triggerOrder ?? null,
      when: whenWords(def, e.start), detailsKnown: known, conditions: null, paths: [], pathsPartial: false, schedule: "", steps: [],
    };
    // `placed`: the flow runs on this object's records (a group or the schedule), so how it starts matters.
    const detail = (placed = false) => {
      base.placed = placed;
      if (placed && known) {
        base.conditions = entryConditions(e.start, labelOf);
        base.paths = pathWords(e.start, labelOf);
        base.schedule = scheduleWords(e.start);
      } else if (placed && def.hasAsyncPath) {
        base.paths = ["Has a path that runs asynchronously"];
        base.pathsPartial = true;
      }
      base.steps = (e.records || [])
        .filter((r) => r.object && lc(r.object) === lc(object))
        .map((r) => ({ kind: r.kind, label: r.label, element: r.element, op: r.op, text: `${stepName(r)} ${OP_WORDS[r.op]} ${view.objectLabel} records` }));
    };
    const mine = obj && lc(obj) === lc(object);
    if (e.error) {
      // A flow we could not look inside: if its list row already says it is about this object, it still has a place.
      if (mine && (key || def.triggerType === "Scheduled")) {
        detail(true);
        const item = { ...base, unreadable: e.error };
        if (def.triggerType === "Scheduled") view.scheduled.push(item);
        else group(key).items.push(item);
      } else if (!obj) {
        view.unreadable.push({ ...base, unreadable: e.error });
      }
      continue;
    }
    if (!obj && !known) { if (partial) view.pending++; continue; }
    if (mine && key) { detail(true); group(key).items.push(base); continue; }
    if (mine && def.triggerType === "Scheduled") { detail(true); view.scheduled.push(base); continue; }
    if (!known || partial) continue;
    detail();
    const changes = base.steps.filter((s) => CHANGE_OPS.has(s.op));
    // A flow that changes the records goes only under "change", with all its steps (reads too); "only read" is flows that change nothing.
    if (changes.length) view.changes.push(base);
    else if (base.steps.some((s) => s.op === "get")) view.reads.push(base);
  }
  for (const g of view.groups) {
    g.items.sort(compareRunOrder);
    // Where each flow stands: "low" / "none" / "high" (it runs) or "off" (it does not). The order of the flows with no trigger order is
    // only known when there is one of them, so `orderKnown` is false for each flow of a block of two or more.
    const blank = g.items.filter((it) => runBand(it.def) === "none").length;
    g.noOrderCount = blank;
    for (const it of g.items) {
      it.band = runBand(it.def);
      it.orderKnown = it.band === "low" || it.band === "high" || (it.band === "none" && blank === 1);
    }
  }
  view.process.items.sort(byLabel); // no order: alphabetical so the list does not shuffle
  view.scheduled.sort(byLabel);
  view.changes.sort(byLabel);
  view.reads.sort(byLabel);
  view.unreadable.sort(byLabel);
  return view;
}

const distinct = (items) => new Set(items.map((i) => `${i.def.namespace || ""}|${i.def.apiName}`.toLowerCase())).size;

/** "7 flows run when Account records are saved or deleted (5 active), 1 runs on a schedule, 3 more change them and 2 more only read them." */
export function objectSummary(view) {
  const triggered = [...view.groups.flatMap((g) => g.items), ...view.process.items];
  const active = triggered.filter((i) => i.isActive);
  const n = distinct(triggered);
  const name = view.objectLabel;
  const parts = [];
  parts.push(n
    ? `${n} ${n === 1 ? "flow runs" : "flows run"} when ${name} records are saved or deleted (${distinct(active)} active)`
    : `No flow runs when ${name} records are saved or deleted`);
  if (!view.partial) {
    const s = distinct(view.scheduled);
    if (s) parts.push(`${s} ${s === 1 ? "runs" : "run"} on a schedule`);
    const c = distinct(view.changes);
    const r = distinct(view.reads);
    parts.push(`${c} more ${c === 1 ? "changes" : "change"} them`);
    parts.push(`${r} more only ${r === 1 ? "reads" : "read"} them`);
  }
  const last = parts.length > 1 ? parts.pop() : null;
  let text = `${parts.join(", ")}${last ? ` and ${last}` : ""}.`;
  if (view.partial && view.pending) text += ` Still reading ${view.pending} other ${view.pending === 1 ? "flow" : "flows"} to find the rest.`;
  return text;
}

// ---------- CSV ----------

export const OBJECT_CSV_HEADER = [
  "Section", "Trigger order", "Run order", "Flow", "Flow API name", "Flow type", "Active", "Runs", "Entry conditions", "Scheduled or asynchronous paths",
  "Step type", "Step", "Step API name", "What it does", "Note",
];

/** The "Run order" cell: only for flows in a before-save, after-save or before-delete group. */
export function runOrderWords(it) {
  if (it.band === "off") return "Not active";
  if (!it.band) return "";
  return it.orderKnown ? "Runs in this order" : "No trigger order: order not known";
}

/** One row per flow step; a triggered or scheduled flow with no step on this object gets one row of its own, and a flow
 *  that could not be looked inside gets one row that says so. */
export function objectCsvRows(view) {
  const rows = [OBJECT_CSV_HEADER];
  const flowCells = (it) => [
    it.label, it.apiName, it.kind, it.isActive ? "Yes" : "No",
  ];
  const add = (section, it, withRuns) => {
    const runs = withRuns && it.placed ? (it.schedule ? it.schedule : it.when.replace(/^w/, "W")) : "";
    const cond = it.conditions ? (it.conditions.has ? `${it.conditions.text}${it.conditions.changeOnly ? " (only when the record changes to meet them)" : ""}` : "No entry conditions") : "";
    const paths = it.paths.join("; ");
    const note = it.unreadable ? `Could not look inside: ${it.unreadable.plain || "the flow could not be read"}` : it.versionKind ? versionWords(it.versionKind, it.isActive) : "";
    const common = [section, it.band ? (it.order ?? "") : "", runOrderWords(it), ...flowCells(it), runs, cond, paths];
    if (!it.steps.length) rows.push([...common, "", "", "", "", note]);
    for (const s of it.steps) rows.push([...common, s.kind, s.label, s.element, OP_WORDS[s.op], note]);
  };
  const parts = [view.groups[0], view.process, ...view.groups.slice(1)];
  for (const g of parts) for (const it of g.items) add(g.title, it, true);
  for (const it of view.scheduled) add("Runs on a schedule", it, true);
  for (const it of view.changes) add("Other flows that change these records", it, false);
  for (const it of view.reads) add("Other flows that only read these records", it, false);
  for (const it of view.unreadable) add("Could not look inside (may also use these records)", it, false);
  return rows;
}

export function objectCsvText(view) {
  return toCsv(objectCsvRows(view));
}

/** For example "flows_on_Account_202611191530.csv". */
export function objectCsvFileName(object, stamp) {
  return `flows_on_${String(object || "object").replace(/[^\w.-]+/g, "_").slice(0, 60)}_${stamp}.csv`;
}
