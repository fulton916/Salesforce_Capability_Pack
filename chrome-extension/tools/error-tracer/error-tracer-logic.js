// Error Tracer: understand one Salesforce debug log. Pure: no browser, no network.
//
// A debug log is text. Each event starts with a clock time, then a number in brackets, then the
// event name and its fields, separated by "|":
//     12:00:00.0 (5000)|FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object
// A line that does not start like that continues the line before it (long messages, stack traces).
// The first line is the API version and what the log recorded (for example
// "62.0 APEX_CODE,FINEST;VALIDATION,INFO;WORKFLOW,INFO").
//
// The reader goes over the lines once, keeps a small stack of "what was running" and turns the
// events that matter into plain findings. Unknown events are ignored and a bad line never throws.
// The formats of some flow and validation events are from the documented shape, not every org's
// log, so each part is read loosely.

export const LEVELS = ["NONE", "ERROR", "WARN", "INFO", "DEBUG", "FINE", "FINER", "FINEST"];
const rank = (l) => LEVELS.indexOf(String(l || "").toUpperCase());

/** What the page needs the log to have recorded before it can say "no errors" about an area. */
export const CATEGORIES = [
  { key: "APEX_CODE", label: "Apex code", needs: "INFO" },
  { key: "DB", label: "Saves to the database", needs: "INFO" },
  { key: "VALIDATION", label: "Validation rules", needs: "INFO" },
  { key: "WORKFLOW", label: "Flows and workflow", needs: "INFO" },
];

const MAX_FINDINGS = 200;
const MAX_EXTRA_LINES = 200; // continuation lines kept per event
const MAX_CONTEXT = 50; // raw lines shown per finding
const MAX_LINE_SHOWN = 400;

const EVENT = /^(\d{1,2}:\d\d:\d\d(?:\.\d+)?) \((\d+)\)\|([A-Z][A-Z0-9_]*)(?:\|(.*))?$/;
const HEADER = /^(\d+(?:\.\d+)?)\s+([A-Z_]+,[A-Z]+(?:;[A-Z_]+,[A-Z]+)*);?\s*$/;
const FRAME = /^([\w.$]+): line (\d+), column (\d+)(?::\s*\[[^\]]*\])?\s*$/;
const ID_LIKE = /^0[0-9A-Za-z]{14}(?:[0-9A-Za-z]{3})?$/;
const USER_ID = /^005[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?$/;
const FIRST_ERROR = /(Insert|Update|Upsert|Delete|Undelete|Merge) failed\.[\s\S]*?first error: ([A-Z][A-Z0-9_]+), ([\s\S]*)$/;

/** True for an ApexLog Id (07L + 12 or 15 letters and digits). */
export function isLogId(id) {
  return typeof id === "string" && /^07L[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id);
}

const aKind = (t) => `a${/^[AEIOU]/i.test(t) ? "n" : ""} ${t}`;
const collapse = (s) => String(s || "").replace(/\s+/g, " ").trim();
const words = (camel) => String(camel).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

// ---------- plain words ----------

const EXCEPTION_HINTS = {
  NullPointerException: "The code tried to use something that was empty (a null value).",
  QueryException: "A query did not return what the code expected (for example no record where one was required).",
  ListException: "The code asked for a list item that does not exist.",
  TypeException: "The code received a value of the wrong type.",
  MathException: "The code did a calculation that is not allowed (for example dividing by zero).",
  SObjectException: "The code used a field that was not loaded for the record, or that does not exist.",
  CalloutException: "A call to an outside system failed.",
  NoAccessException: "The user does not have access to something the code needed.",
  AuraHandledException: "The code stopped on purpose, with a message for the user.",
  JSONException: "Some text could not be read in the format the code expected.",
  StringException: "The code could not work with a piece of text.",
  SecurityException: "A security check in the code blocked the action.",
  AsyncException: "A background job could not be started or run.",
  EmailException: "An email could not be sent.",
  InvalidParameterValueException: "The code was given a value it cannot accept.",
};

const LIMIT_HINTS = [
  [/Too many SOQL queries/i, "The code ran more database queries (SOQL) in one go than Salesforce allows."],
  [/Too many DML statements/i, "The code made more save/update/delete statements in one go than Salesforce allows."],
  [/Too many DML rows/i, "The code changed more records in one go than Salesforce allows."],
  [/Too many query rows/i, "The code read more records in one go than Salesforce allows."],
  [/CPU time/i, "The code used more processing time than Salesforce allows for one request."],
  [/heap size/i, "The code used more memory than Salesforce allows for one request."],
  [/Too many callouts/i, "The code made more calls to outside systems than Salesforce allows."],
  [/Too many future calls|Too many queueable|Too many Email/i, "The code started more background work or emails than Salesforce allows."],
];

const SAVE_CODES = {
  FIELD_CUSTOM_VALIDATION_EXCEPTION: (m) => `A validation rule stopped the save${m ? `: \u201c${m}\u201d` : "."}`,
  REQUIRED_FIELD_MISSING: (m, f) => `A required field was left empty${f ? ` (${f})` : ""}${m ? `: ${m}` : "."}`,
  DUPLICATE_VALUE: (m) => `A value that must be unique already exists${m ? `: ${m}` : "."}`,
  DUPLICATES_DETECTED: (m) => `A duplicate rule blocked the save${m ? `: ${m}` : "."}`,
  CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: (m) => `Something that runs when the record is saved (a trigger, flow or other automation) failed${m ? `: ${m}` : "."}`,
  CANNOT_EXECUTE_FLOW_TRIGGER: (m) => `A flow that runs when the record is saved failed${m ? `: ${m}` : "."}`,
  UNABLE_TO_LOCK_ROW: () => "The record was locked by another process at the same moment. Trying again usually works.",
  STRING_TOO_LONG: (m, f) => `A value is too long for its field${f ? ` (${f})` : ""}${m ? `: ${m}` : "."}`,
  FIELD_INTEGRITY_EXCEPTION: (m, f) => `A field was given a value it does not accept${f ? ` (${f})` : ""}${m ? `: ${m}` : "."}`,
  INVALID_CROSS_REFERENCE_KEY: (m) => `A link points to a record that does not exist or cannot be used${m ? `: ${m}` : "."}`,
  ENTITY_IS_DELETED: () => "The record had been deleted.",
  INVALID_FIELD_FOR_INSERT_UPDATE: (m) => `A field cannot be set when saving${m ? `: ${m}` : "."}`,
};

/** The save failure inside an exception message, or null. `{op, code, message, fields, recordId, plain}` */
export function explainSaveError(text) {
  const m = FIRST_ERROR.exec(collapse(text));
  if (!m) return null;
  const tail = /^([\s\S]*?)(?::\s*\[([^\]]*)\])?\s*$/.exec(m[3]);
  const message = tail ? tail[1].trim() : m[3].trim();
  const fields = tail && tail[2] ? tail[2].trim() : "";
  const rowId = /with id ([A-Za-z0-9]{15,18})/.exec(text);
  let plain;
  if (SAVE_CODES[m[2]]) plain = SAVE_CODES[m[2]](message, fields);
  else if (m[2].startsWith("INSUFFICIENT_ACCESS")) plain = `The user does not have the access needed for this${message ? `: ${message}` : "."} (${m[2]})`;
  else plain = `Salesforce refused the save with ${m[2]}${message ? `: ${message}` : ""}.`;
  return { op: m[1], code: m[2], message, fields, recordId: rowId ? rowId[1] : null, plain };
}

/** Where a stack-trace line says: "Trigger.AccountTrigger: line 3, column 1" -> words. */
export function frameWords(frame) {
  const m = FRAME.exec(String(frame || "").trim());
  if (!m) return "";
  const [, name, line] = m;
  if (name.startsWith("Trigger.")) return `Apex trigger ${name.slice(8)}, line ${line}`;
  if (name.startsWith("Class.")) {
    const parts = name.slice(6).split(".");
    if (parts.length === 1) return `Apex class ${parts[0]}, line ${line}`;
    return `Apex class ${parts.slice(0, -1).join(".")}, method ${parts[parts.length - 1]}, line ${line}`;
  }
  if (/^(AnonymousBlock|execute_anonymous_apex|ExecuteAnonymous)/.test(name)) return `anonymous Apex, line ${line}`;
  return `${name}, line ${line}`;
}

/** Split an error text into its message and the stack-trace frames. */
function splitFrames(text) {
  const frames = [];
  const message = [];
  for (const raw of String(text || "").split("\n")) {
    const l = raw.trim();
    if (!l || /^External entry point$/i.test(l)) continue;
    if (FRAME.test(l)) frames.push(l); else message.push(l);
  }
  return { message: message.join(" "), frames };
}

function describeUnit(rawFields) {
  let f = rawFields.filter((x) => x !== "");
  if (f.length && /^\[.*\]$/.test(f[0])) f = f.slice(1);
  if (f.length && ID_LIKE.test(f[0])) f = f.slice(1);
  const name = f[0] || "";
  let m;
  if ((m = /^(\w+) on (\w+) trigger event (\w+)/.exec(name))) {
    return { kind: "trigger", text: `Apex trigger ${m[1]} (${words(m[3])} of ${m[2]})` };
  }
  if ((m = /^Validation:(\w+)(?::(\w+))?/.exec(name))) {
    return { kind: "validation", object: m[1], recordId: m[2] || null, text: `validation rules on ${m[1]}` };
  }
  // A flow code unit usually names only the object ("Flow:Case"); the flow's own name comes later.
  if ((m = /^Flow:(.+)$/.exec(name))) { const generic = `a flow on ${m[1]} records`; return { kind: "flow", text: generic, generic }; }
  if ((m = /^Workflow:(.+)$/.exec(name))) return { kind: "workflow", text: `workflow rules on ${m[1]}` };
  if (/^execute_anonymous_apex$/i.test(name)) return { kind: "anonymous", text: "anonymous Apex" };
  if ((m = /^VF:\s*(.*)$/.exec(name))) return { kind: "page", text: `Visualforce page ${m[1]}` };
  if ((m = /^([\w.]+?)\.(\w+)\(/.exec(name))) return { kind: "class", text: `Apex class ${m[1]}, method ${m[2]}` };
  return { kind: "other", text: name || "something that ran" };
}

// ---------- the one pass ----------

function parseHeader(line) {
  const m = HEADER.exec(String(line || "").trim());
  if (!m) return null;
  const levels = {};
  for (const part of m[2].split(";")) {
    const [k, v] = part.split(",");
    if (k && v) levels[k] = v;
  }
  return { version: m[1], levels };
}

const ENDS_STOP = /[.!?]\s*$/;
/** A message in curly quotes, closed by a full stop only when the message does not already end in one. */
function quoted(m) { return `“${m}”${ENDS_STOP.test(m) ? "" : "."}`; }

function coverageOf(levels) {
  return CATEGORIES.map((c) => {
    const level = levels ? levels[c.key] || null : null;
    const known = !!levels;
    return { key: c.key, label: c.label, level, ok: known ? rank(level) >= rank(c.needs) : null };
  });
}

/** Read a whole log. `meta` may carry `{userName, length}` from the log list. Never throws. */
export function analyzeLog(text, meta = {}) {
  const lines = String(text == null ? "" : text).split("\n");
  const out = {
    version: null, levels: null, coverage: coverageOf(null), user: { id: null, username: null, timeZone: null },
    findings: [], handledCount: 0, problemCount: 0, moreFindings: 0, notes: [],
    cutOff: false, lineCount: lines.length, lines, headline: "", subline: "",
  };
  const st = {
    stack: [], dml: null, lastValObject: null, valClean: false, rule: null, lastVal: null, pendingValMsg: null, valFindings: [],
    flowStack: [], interviewFlow: new Map(), lastElementInterview: null, flowFindings: [],
    excByKey: new Map(), handledByKey: new Map(), flowByKey: new Map(),
    seen: new Set(), // areas the log itself shows activity for, whatever its levels line says
  };
  const findings = [];
  let eventCount = 0;

  const add = (f) => {
    if (findings.length >= MAX_FINDINGS) { out.moreFindings++; return null; }
    findings.push(f);
    return f;
  };
  const base = (ev, kind, handled) => ({
    kind, handled, count: 1, time: ev.time, elapsedMs: ev.elapsedMs, start: ev.idx, end: ev.endIdx,
    steps: st.stack.slice(-6).map((u) => u.text), where: "", message: "", rawMessage: "", absorbed: false,
  });
  const dmlWords = () => {
    if (!st.dml) return null;
    return { op: st.dml.op, type: st.dml.type, rows: st.dml.rows };
  };
  const innermost = () => st.stack.length ? st.stack[st.stack.length - 1] : null;

  function onException(ev, fatal) {
    const full = ev.extra ? `${ev.rest}\n${ev.extra.join("\n")}` : ev.rest;
    let line = null;
    let body = full;
    if (!fatal) {
      const m = /^\[(\d+|EXTERNAL)\]\|([\s\S]*)$/.exec(full);
      if (m) { line = m[1] === "EXTERNAL" ? null : Number(m[1]); body = m[2]; }
    }
    const { message, frames } = splitFrames(body);
    const key = collapse(message).slice(0, 300);
    const isLimit = /System\.LimitException|CPU time limit|Too many (SOQL|DML|query)/i.test(message);
    const save = isLimit ? null : explainSaveError(message);
    const kind = isLimit ? "limit" : save || /DmlException/.test(message) ? "save" : "apex";

    // The same error is thrown at each level it passes through; an unhandled one then ends as a fatal error.
    if (!fatal) {
      const again = st.handledByKey.get(key);
      if (again && !again.absorbed) { again.count++; return; }
    }
    const f = base(ev, kind, !fatal);
    f.rawMessage = message;
    f.frames = frames;
    f.line = line;
    f.dml = dmlWords();
    f.unitObject = st.valClean ? st.lastValObject : null;
    if (save) f.save = { code: save.code, message: save.message, fields: save.fields, op: save.op, recordId: save.recordId, plain: save.plain };
    if (fatal) {
      const earlier = st.excByKey.get(key);
      if (earlier) {
        for (const e of earlier) {
          if (e.absorbed) continue;
          e.absorbed = true;
          if (f.line == null) f.line = e.line;
          if (!f.dml) f.dml = e.dml;
          if (!f.unitObject) f.unitObject = e.unitObject;
          if (!f.rule && e.rule) { f.rule = e.rule; f.object = e.object; f.recordId = e.recordId; }
          if (e.kind === "validation" && f.kind === "save") f.kind = "validation";
          f.start = Math.min(f.start, e.start);
          f.count = Math.max(f.count, 1);
        }
        st.excByKey.delete(key);
      }
    }
    // A save stopped by a validation rule: the rule's own finding is folded into this one.
    if (save && save.code === "FIELD_CUSTOM_VALIDATION_EXCEPTION") {
      for (let i = st.valFindings.length - 1, seen = 0; i >= 0 && seen < 20; i--, seen++) {
        const v = st.valFindings[i];
        if (v.absorbed || v.linked) continue;
        if (!v.rawMessage || collapse(save.message) === collapse(v.rawMessage)) {
          v.linked = true; v.absorbed = true;
          f.rule = v.rule; f.object = v.object; f.recordId = v.recordId; f.kind = "validation";
          f.start = Math.min(f.start, v.start);
          break;
        }
      }
    }
    // A failure the flow already reported: keep the flow's own finding.
    const flowOf = st.flowFindings.slice(-10).reverse().find((x) => !x.absorbed && x.rawMessage.length >= 12 && collapse(message).includes(collapse(x.rawMessage).slice(0, 80)));
    if (flowOf) {
      if (fatal) flowOf.handled = false;
      flowOf.end = Math.max(flowOf.end, f.end);
      return;
    }
    const kept = add(f);
    if (!kept) return;
    if (!fatal) {
      (st.excByKey.get(key) || st.excByKey.set(key, []).get(key)).push(f);
      st.handledByKey.set(key, f);
    }
    finish(f);
  }

  /** Words for "what failed" and "where", once the pieces are known. */
  function finish(f) {
    const firstFrame = f.frames && f.frames.length ? frameWords(f.frames[0]) : "";
    const unit = f.steps.length ? f.steps[f.steps.length - 1] : "";
    f.where = firstFrame || (unit ? `${unit}${f.line ? `, line ${f.line}` : ""}` : (f.line ? `line ${f.line}` : ""));
    if (f.frames && f.frames.length > 1) f.callers = f.frames.slice(1, 6).map(frameWords).filter(Boolean);
    const what = f.dml ? `${f.dml.type ? aKind(f.dml.type) : "a record"} (${f.dml.op ? f.dml.op.toLowerCase() : "save"}${f.dml.rows > 1 ? `, ${f.dml.rows} rows` : ""})` : "";
    if (f.kind === "limit") {
      const hint = (LIMIT_HINTS.find(([re]) => re.test(f.rawMessage)) || [])[1] || "The code went over a limit Salesforce sets for one request.";
      f.title = "A Salesforce limit was hit";
      f.message = `${hint} Salesforce said: ${quoted(f.rawMessage.replace(/^System\.LimitException:\s*/, ""))}`;
    } else if (f.kind === "validation" && f.save) {
      f.title = f.handled ? "A validation rule stopped a save" : "A validation rule stopped the save";
      if (!f.object && f.dml && f.dml.type) f.object = f.dml.type;
      if (!f.object && f.unitObject) f.object = f.unitObject;
      f.message = `${f.rule ? `The rule \u201c${f.rule}\u201d` : "A validation rule"} refused the save${f.object ? ` of ${aKind(f.object)} record` : ""}${f.save.message ? `. The message was: \u201c${f.save.message}\u201d` : ""}${f.save.fields ? ` (field: ${f.save.fields})` : ""}${!f.save.fields && f.save.message && ENDS_STOP.test(f.save.message) ? "" : "."}`;
    } else if (f.kind === "save") {
      f.title = f.handled ? "A save failed" : "A save failed";
      const unitWhat = !what && f.unitObject && f.save && f.save.code === "FIELD_CUSTOM_VALIDATION_EXCEPTION" ? aKind(f.unitObject) : "";
      if (unitWhat) f.object = f.unitObject;
      f.message = `${what ? `Saving ${what} failed. ` : unitWhat ? `Saving ${unitWhat} record failed. ` : ""}${f.save ? f.save.plain : `Salesforce said: ${quoted(f.rawMessage)}`}`;
    } else {
      const cls = /^([A-Za-z_][\w.]*(?:Exception|Error)):\s*([\s\S]*)$/.exec(f.rawMessage);
      const short = cls ? cls[1].split(".").pop() : "";
      const hint = EXCEPTION_HINTS[short];
      f.title = f.handled ? "An error was raised in Apex" : "Apex code stopped with an error";
      f.message = `${hint || (f.handled ? "The code raised an error." : "The code stopped with an error.")} Salesforce said: ${quoted(f.rawMessage)}`;
    }
  }

  function onFlowError(ev, name, fields) {
    const msgAll = ev.extra ? `${ev.rest}\n${ev.extra.join("\n")}` : ev.rest;
    const parts = msgAll.split("|");
    const message = collapse(parts[0]);
    const fault = /_FAULT$/.test(name);
    let flowName = st.flowStack.length ? st.flowStack[st.flowStack.length - 1] : (st.interviewFlow.get(st.lastElementInterview) || "");
    let elementType = null, element = null;
    if (/ELEMENT/.test(name)) { elementType = collapse(parts[1] || "") || null; element = collapse(parts[2] || "") || null; }
    else if (!flowName && parts[1] && /^\w+$/.test(parts[1].trim()) && !ID_LIKE.test(parts[1].trim())) flowName = parts[1].trim();
    const key = `${flowName}|${message.slice(0, 200)}`;
    // "The interview could not start/finish" and a failed step of the same interview are one failure,
    // whichever comes first. A step error never merges with a different step's error.
    const lastFlow = st.flowFindings.length ? st.flowFindings[st.flowFindings.length - 1] : null;
    const sameFlow = st.flowFindings.slice().reverse().find((x) => !x.absorbed
      && (!element || !x.element)
      && ((x.flow || "") === (flowName || "") || ((!x.flow || !flowName) && x === lastFlow))) || null;
    const old = st.flowByKey.get(key) || sameFlow;
    if (old) {
      if (old.handled && !fault) old.handled = false;
      if (!old.element && element) { old.element = element; old.elementType = elementType; old.rawMessage = message; old.save = explainSaveError(message) || old.save; }
      if (!old.flow && flowName) old.flow = flowName;
      old.end = Math.max(old.end, ev.endIdx);
      finishFlow(old);
      return;
    }
    const f = base(ev, "flow", fault);
    f.rawMessage = message;
    f.flow = flowName || null;
    f.element = element;
    f.elementType = elementType;
    f.save = explainSaveError(message) || null;
    const kept = add(f);
    if (!kept) return;
    st.flowByKey.set(key, f);
    st.flowFindings.push(f);
    finishFlow(f);
  }

  function finishFlow(f) {
    f.title = f.handled ? "A flow step failed (the flow has a path for failures)" : "A flow failed";
    const nm = f.flow ? `The flow \u201c${f.flow}\u201d` : "A flow";
    const at = f.element ? ` at the step \u201c${f.element}\u201d${f.elementType ? ` (${words(f.elementType.replace(/^Flow/, ""))})` : ""}` : "";
    f.message = `${nm} failed${at}. ${f.save ? f.save.plain : `Salesforce said: ${quoted(f.rawMessage)}`}`;
  f.where = f.flow ? `Flow ${f.flow}${f.element ? `, step ${f.element}` : ""}` : (f.steps.length ? f.steps[f.steps.length - 1] : "");
    if (f.flow) f.flowPointer = flowPointer(f.flow);
  }

  const flowUnit = () => { for (let i = st.stack.length - 1; i >= 0; i--) if (st.stack[i].kind === "flow") return st.stack[i]; return null; };

  function onEvent(ev) {
    eventCount++;
    const name = ev.name;
    switch (name) {
      case "USER_INFO": {
        const f = ev.rest.split("|");
        const i = f.findIndex((x) => USER_ID.test(x));
        if (i >= 0 && !out.user.id) {
          out.user = { id: f[i], username: f[i + 1] || null, timeZone: collapse(f[i + 2] || "") || null };
        }
        break;
      }
      case "CODE_UNIT_STARTED": {
        const u = describeUnit(ev.rest.split("|"));
        st.stack.push(u);
        // The record type of a validation unit counts only while nothing else has run since.
        if (u.kind === "validation") { st.seen.add("VALIDATION"); st.lastValObject = u.object; st.valClean = true; }
        else { st.valClean = false; if (u.kind === "flow" || u.kind === "workflow") st.seen.add("WORKFLOW"); }
        break;
      }
      case "CODE_UNIT_FINISHED": st.stack.pop(); break;
      case "DML_BEGIN": {
        st.valClean = false;
        const f = ev.rest.split("|");
        const get = (p) => { const x = f.find((s) => s.startsWith(p)); return x ? x.slice(p.length) : null; };
        st.dml = { op: get("Op:"), type: get("Type:"), rows: Number(get("Rows:")) || null };
        st.seen.add("DB");
        break;
      }
      case "DML_END": st.dml = null; break;
      case "EXCEPTION_THROWN": onException(ev, false); break;
      case "FATAL_ERROR": onException(ev, true); break;
      case "VALIDATION_RULE": {
        st.seen.add("VALIDATION");
        const f = ev.rest.split("|");
        st.rule = { id: f[0] || null, name: collapse(f[1] || "") || null };
        st.lastVal = null;
        break;
      }
      case "VALIDATION_ERROR": {
        const msg = collapse(ev.extra ? `${ev.rest}\n${ev.extra.join("\n")}` : ev.rest);
        if (st.lastVal && !st.lastVal.rawMessage) { st.lastVal.rawMessage = msg; finishValidation(st.lastVal); }
        else st.pendingValMsg = msg;
        break;
      }
      case "VALIDATION_FAIL": {
        st.seen.add("VALIDATION");
        let unit = null;
        for (let i = st.stack.length - 1, n = 0; i >= 0 && n < 10; i--, n++) if (st.stack[i].kind === "validation") { unit = st.stack[i]; break; }
        const f = base(ev, "validation", false);
        f.rule = st.rule ? st.rule.name : null;
        f.ruleId = st.rule ? st.rule.id : null;
        f.object = (unit && unit.object) || (st.dml && st.dml.type) || null;
        f.recordId = unit && unit.recordId && unit.recordId !== "new" ? unit.recordId : null;
        f.rawMessage = st.pendingValMsg || "";
        st.pendingValMsg = null;
        const kept = add(f);
        if (kept) { st.valFindings.push(f); st.lastVal = f; finishValidation(f); }
        break;
      }
      case "FLOW_START_INTERVIEW_BEGIN": {
        st.seen.add("WORKFLOW");
        const f = ev.rest.split("|");
        const flowName = collapse(f[f.length - 1] || "");
        st.flowStack.push(flowName);
        const unit = flowUnit();
        if (unit && flowName) unit.text = `flow ${flowName}`;
        break;
      }
      case "FLOW_START_INTERVIEW_END": {
        const f = ev.rest.split("|");
        if (f[0] && f[1]) st.interviewFlow.set(f[0], collapse(f[1]));
        st.flowStack.pop();
        { const unit = flowUnit(); if (unit) unit.text = unit.generic; }
        break;
      }
      case "FLOW_CREATE_INTERVIEW_END": {
        const f = ev.rest.split("|");
        if (f[0] && f[1]) st.interviewFlow.set(f[0], collapse(f[1]));
        break;
      }
      case "FLOW_ELEMENT_BEGIN": st.lastElementInterview = ev.rest.split("|")[0] || null; break;
      default:
        if (/^VALIDATION_/.test(name)) st.seen.add("VALIDATION");
        else if (/^(FLOW|WF)_/.test(name)) st.seen.add("WORKFLOW");
        else if (/^(SOQL|DML)_/.test(name)) st.seen.add("DB");
        if (/^FLOW_.*_(ERROR|FAULT)$/.test(name)) onFlowError(ev, name);
        break;
    }
  }

  function finishValidation(f) {
    f.title = "A validation rule stopped the save";
    f.message = `${f.rule ? `The rule \u201c${f.rule}\u201d` : "A validation rule"} refused the save${f.object ? ` of ${aKind(f.object)} record` : ""}${f.rawMessage ? `. The message was: \u201c${f.rawMessage}\u201d` : ""}${f.rawMessage && ENDS_STOP.test(f.rawMessage) ? "" : "."}`;
    f.where = `Validation rule ${f.rule || "(name not in the log)"}${f.object ? ` on ${f.object}` : ""}`;
  }

  // header
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  const head = lines[first] !== undefined ? parseHeader(lines[first]) : null;
  if (head) { out.version = head.version; out.levels = head.levels; out.coverage = coverageOf(head.levels); first++; }

  let cur = null;
  const flush = () => { if (cur) { cur.endIdx = cur.lastIdx; onEvent(cur); cur = null; } };
  let cutIdx = -1;
  for (let i = first; i < lines.length; i++) {
    let line = lines[i];
    if (line.length && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    // quick test first: a clock time has its first colon at position 1 or 2
    const m = line.length > 10 && (line.charCodeAt(2) === 58 || line.charCodeAt(1) === 58) ? EVENT.exec(line) : null;
    if (m) {
      flush();
      cur = { time: m[1], nanos: m[2], name: m[3], rest: m[4] || "", extra: null, idx: i, lastIdx: i, endIdx: i, elapsedMs: Number(m[2]) / 1e6 };
    } else {
      if (cutIdx < 0 && line.length < 300 && /MAXIMUM DEBUG LOG SIZE REACHED|Skipped \d+ bytes of detailed log/.test(line)) cutIdx = i;
      if (cur) {
        cur.lastIdx = i;
        if (line.trim() !== "" || cur.extra) {
          if (!cur.extra) cur.extra = [];
          if (cur.extra.length < MAX_EXTRA_LINES) cur.extra.push(line);
        }
      }
    }
  }
  flush();

  out.findings = findings.filter((f) => !f.absorbed);
  out.cutOff = cutIdx >= 0 || (Number(meta.length) >= 19900000);
  out.problemCount = out.findings.filter((f) => !f.handled).length;
  out.handledCount = out.findings.length - out.problemCount;
  out.findings.forEach((f, i) => { f.number = i + 1; });
  out.notLog = !head && eventCount === 0;
  for (const c of out.coverage) c.partial = c.ok === false && st.seen.has(c.key);
  buildNotes(out, meta);
  return out;
}

// ---------- notes and headline ----------

/** Plain pointer to the flow-usage tool. Words only: tools never link to each other. */
export function flowPointer(name) {
  return `To see which other flows use \u201c${name}\u201d, open \u201cWhere is it used in flows?\u201d from the toolbar menu and search for ${name}.`;
}

const SETUP_NAME = { APEX_CODE: "Apex Code", DB: "Database", VALIDATION: "Validation", WORKFLOW: "Workflow" };

function levelWords(c) { return `${c.label} (${c.level ? c.level.toLowerCase() : "not recorded"})`; }

function buildNotes(out, meta) {
  const notes = out.notes;
  const cov = out.coverage;
  const missing = cov.filter((c) => c.ok === false);
  if (out.notLog) {
    out.headline = "This does not look like a debug log";
    out.subline = "The text is empty or is not debug log text, so nothing could be checked. This is not a result of \u201cno errors\u201d.";
    notes.push("The log looks empty or is not a debug log.");
    return;
  }
  if (!out.levels) notes.push("This log has no recording-levels line at the top, so the page cannot tell which areas were recorded. Do not read \u201cno errors\u201d as proof.");
  // The headline line (subline) is the only place that names missing or partial areas.
  // Notes gives one instruction, with the Setup names inside it.
  if (missing.length) {
    const names = missing.map((c) => SETUP_NAME[c.key] || c.label).join(", ");
    notes.push(`To record what is missing, edit the debug level in Setup and set the categories named above (${names}) to Info or finer, then repeat the action.`);
  }
  if (out.cutOff) notes.push("To get the missing end, turn the debug level down, repeat the action and read the new log. Salesforce keeps only part of a very large log, and the error itself may be in the part it dropped.");
  if (out.moreFindings) notes.push(`${out.moreFindings} more problems were left out to keep this page quick (the first ${MAX_FINDINGS} are shown).`);
  if (out.handledCount) notes.push(out.handledCount === 1
    ? "1 error was raised but may have been handled by the code. It is listed after the problems and is usually not the cause."
    : `${out.handledCount} errors were raised but may have been handled by the code. They are listed after the problems and are usually not the cause.`);
  if (out.user.timeZone) notes.push(`The raw lines under \u201cLog lines\u201d show the log's own clock, which is in the user's time zone, ${out.user.timeZone}. The cards say how long after the log started each problem happened.`);
  const n = out.problemCount;
  if (n > 0) {
    out.headline = `${n} problem${n === 1 ? "" : "s"} found in this log`;
    const none = missing.filter((c) => !c.partial), part = missing.filter((c) => c.partial);
    out.subline = [
      none.length ? `Not recorded well enough to show errors: ${none.map((c) => c.label).join(", ")}.` : "",
      part.length ? `Recorded only in part: ${part.map((c) => c.label).join(", ")}.` : "",
      out.cutOff ? "The log was cut off, so the end is missing." : "",
      missing.length || out.cutOff ? "There may be more." : "",
    ].filter(Boolean).join(" ");
  } else {
    out.headline = out.handledCount ? "No unhandled errors found in this log" : "No errors found in this log";
    const rec = cov.filter((c) => c.ok === true).map(levelWords);
    out.subline = out.levels
      ? `${rec.length ? `Recorded: ${rec.join(", ")}. ` : ""}${missing.some((c) => !c.partial) ? `Not recorded: ${missing.filter((c) => !c.partial).map((c) => c.label).join(", ")}, so errors there would not appear.` : ""}${missing.some((c) => c.partial) ? `${missing.some((c) => !c.partial) ? " " : ""}Recorded only in part: ${missing.filter((c) => c.partial).map((c) => c.label).join(", ")}, so some errors there may not appear.` : ""}${out.cutOff ? " The log was cut off, so the end is missing." : ""}`.trim()
      : "The log does not say what it recorded.";
  }
}

// ---------- showing it ----------

/** The raw lines around a finding: `[{text, hit}]`, long lines shortened. */
export function rawAround(analysis, f) {
  const lines = analysis.lines || [];
  const from = Math.max(0, f.start - 3);
  let to = Math.min(lines.length - 1, f.end + 1);
  if (to - from + 1 > MAX_CONTEXT) to = from + MAX_CONTEXT - 1;
  const out = [];
  for (let i = from; i <= to; i++) {
    let t = String(lines[i] || "").replace(/\r$/, "");
    if (t.length > MAX_LINE_SHOWN) t = `${t.slice(0, MAX_LINE_SHOWN)}\u2026`;
    out.push({ text: t, hit: i >= f.start && i <= f.end });
  }
  return out;
}

export function elapsedWords(ms) {
  if (!Number.isFinite(ms)) return "";
  if (ms < 1) return "At the start of the log";
  if (ms < 100) return `${Math.round(ms)} ms after the log started`;
  const s = Math.round(ms / 100) / 10;
  return `${s} ${s === 1 ? "second" : "seconds"} after the log started`;
}

/** A time with its zone named, so it cannot be mistaken for the user's own clock. */
export function whenText(iso, zone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "Not stated");
  let z = zone;
  if (!z) { try { z = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { z = ""; } }
  let txt;
  try { txt = d.toLocaleString(undefined, z ? { timeZone: z } : undefined); } catch { txt = d.toLocaleString(); z = ""; }
  return `${txt} (your time${z ? `, ${z}` : ""})`;
}

export function humanSize(bytes) {
  const n = bytes === null || bytes === undefined || bytes === "" ? NaN : Number(bytes);
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / 104857.6) / 10} MB`;
}

const REQUEST_WORDS = { Api: "an API call", Application: "a page in Salesforce" };

/** What ran, in plain words, from a log list row. */
export function whatRan(row) {
  const op = collapse(row && row.operation);
  const req = row && row.request ? (REQUEST_WORDS[row.request] || collapse(row.request)) : "";
  if (op && req) return `${op} (${req})`;
  return op || req || "Not stated";
}

export function statusWords(row) {
  const s = collapse(row && row.status);
  if (!s) return { ok: null, text: "Not stated" };
  if (/^success$/i.test(s)) return { ok: true, text: "Success" };
  return { ok: false, text: s };
}

/** Narrow the list: only logs whose result is not Success, and/or one user (by Id). */
export function filterLogs(rows, { problemsOnly = false, userId = "" } = {}) {
  return (rows || []).filter((r) => (!problemsOnly || statusWords(r).ok === false) && (!userId || r.userId === userId));
}

/** The people who have logs in the list: `[{id, name, count}]` by name. */
export function userChoices(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const k = r.userId || "";
    const e = m.get(k) || { id: k, name: r.userName || "Unknown user", count: 0 };
    e.count++;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Plain text for the Copy button: what failed, where, who, when. */
export function summaryText(analysis, meta = {}) {
  const out = [];
  out.push(analysis.headline);
  if (analysis.subline) out.push(analysis.subline);
  out.push("");
  const who = meta.userName || analysis.user.username || "Not stated";
  out.push(`Who: ${who}${analysis.user.username && meta.userName ? ` (${analysis.user.username})` : ""}`);
  if (meta.startTime) out.push(`When: ${meta.startTimeText || `${meta.startTime} (UTC)`}`);
  if (analysis.user.timeZone) out.push(`User's time zone: ${analysis.user.timeZone}`);
  if (meta.what) out.push(`What ran: ${meta.what}`);
  if (meta.status) out.push(`Result: ${meta.status}`);
  for (const f of analysis.findings) {
    out.push("");
    out.push(`${f.number}. ${f.title}`);
    out.push(`   ${f.message}`);
    if (f.where) out.push(`   Where: ${f.where}`);
    if (f.steps && f.steps.length) out.push(`   Running at the time: ${f.steps.join(" > ")}`);
    if (Number.isFinite(f.elapsedMs)) out.push(`   When: ${elapsedWords(f.elapsedMs)}`);
    if (f.count > 1) out.push(`   Raised ${f.count} times.`);
    if (f.flowPointer) out.push(`   ${f.flowPointer}`);
  }
  if (analysis.notes.length) {
    out.push("");
    out.push("Notes:");
    for (const n of analysis.notes) out.push(`- ${n}`);
  }
  return out.join("\n");
}
