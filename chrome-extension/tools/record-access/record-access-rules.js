// Restriction rules and scoping rules for "Why can a user see this record?" Pure: no browser, no network.
//
// A rule (Tooling API object RestrictionRule) has a TargetEntity (an object API name), an EnforcementType
// ("Restrict" = restriction rule, "Scoping" = scoping rule), a UserCriteria (who the rule applies to, for example
// `$User.Department = 'Sales'`) and a RecordFilter (which records those users get, for example `OwnerId = $User.Id`
// or `Region__c = 'East'`). Salesforce stores both texts exactly as they were typed (seen in a developer org).
//
// Only simple criteria are checked: one or more `field operator value` conditions joined by AND, or all by OR, where the
// value is a quoted text, a number, true, false, null or a `$User.Field`. Anything else (parentheses, IN, LIKE, dates,
// fields through a relationship, mixed AND and OR) is "too complex to check" and the rule is shown as "may hide it".

const OPS = ["<=", ">=", "!=", "<>", "=", "<", ">"];

/** Split on AND / OR outside quotes. Returns {parts, join} or {error}. */
function splitJoin(text) {
  const parts = [];
  const joins = new Set();
  let cur = "";
  let i = 0;
  const s = text;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") { // a quoted text, kept whole (a backslash escapes the next character)
      let j = i + 1;
      while (j < s.length && s[j] !== "'") j += s[j] === "\\" ? 2 : 1;
      if (j >= s.length) return { error: "an unclosed quote" };
      cur += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "(" || c === ")") return { error: "parentheses" };
    const m = /^\s+(AND|OR)\s+/i.exec(s.slice(i));
    if (m && cur.trim()) {
      joins.add(m[1].toUpperCase());
      parts.push(cur.trim());
      cur = "";
      i += m[0].length;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) parts.push(cur.trim());
  if (joins.size > 1) return { error: "AND and OR mixed" };
  return { parts, join: joins.has("OR") ? "or" : "and" };
}

function parseValue(raw) {
  const t = raw.trim();
  let m = /^'((?:[^'\\]|\\.)*)'$/s.exec(t);
  if (m) return { kind: "text", v: m[1].replace(/\\(.)/g, "$1") };
  if (/^true$/i.test(t)) return { kind: "bool", v: true };
  if (/^false$/i.test(t)) return { kind: "bool", v: false };
  if (/^null$/i.test(t)) return { kind: "null", v: null };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { kind: "number", v: Number(t) };
  m = /^\$User\.(\w+)$/i.exec(t);
  if (m) return { kind: "userRef", v: m[1] };
  return null;
}

/** Parse a UserCriteria (`forUser` true: the left side is `$User.Field`) or a RecordFilter (left side is a plain field).
 *  {ok:true, join, terms:[{field, op, value}]} or {ok:false, reason}. Field names keep the case they were stored in. */
export function parseCriteria(text, forUser) {
  const t = String(text ?? "").trim();
  if (!t) return { ok: false, reason: "it is empty" };
  const sp = splitJoin(t);
  if (sp.error) return { ok: false, reason: `it uses ${sp.error}` };
  const terms = [];
  for (const part of sp.parts) {
    const m = new RegExp(`^([$\\w.]+)\\s*(${OPS.map((o) => o.replace(/[<>=!]/g, (x) => `\\${x}`)).join("|")})\\s*(.+)$`, "s").exec(part);
    if (!m) return { ok: false, reason: `"${part}" is not a simple field and value comparison` };
    let field = m[1];
    if (forUser) {
      const u = /^\$User\.(\w+)$/i.exec(field);
      if (!u) return { ok: false, reason: `"${field}" is not a field of the user` };
      field = u[1];
    } else if (!/^\w+$/.test(field)) return { ok: false, reason: `"${field}" is not a plain field of the record` };
    const value = parseValue(m[3]);
    if (!value) return { ok: false, reason: `the value "${m[3].trim()}" is not a text, number, true, false, null or $User field` };
    terms.push({ field, op: m[2] === "<>" ? "!=" : m[2], value });
  }
  return { ok: true, join: sp.join, terms };
}

/** The fields to read: {user:[...], record:[...]} (API names as stored, no duplicates) for a list of rules. */
export function neededFields(rules) {
  const user = new Map();
  const record = new Map();
  const add = (map, f) => { if (!map.has(f.toLowerCase())) map.set(f.toLowerCase(), f); };
  for (const r of rules || []) {
    const uc = parseCriteria(r.userCriteria, true);
    const rf = parseCriteria(r.recordFilter, false);
    for (const p of [uc, rf]) if (p.ok) for (const t of p.terms) if (t.value.kind === "userRef") add(user, t.value.v);
    if (uc.ok) for (const t of uc.terms) add(user, t.field);
    if (rf.ok) for (const t of rf.terms) add(record, t.field);
  }
  return { user: [...user.values()], record: [...record.values()] };
}

const looksId = (s) => typeof s === "string" && /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(s) && /\d/.test(s);
const UNKNOWN = Symbol("unknown");

function same(a, b) {
  if (a === null || a === undefined || a === "") return b === null || b === undefined || b === "";
  if (b === null || b === undefined || b === "") return false;
  if (typeof a === "boolean" || typeof b === "boolean") return String(a).toLowerCase() === String(b).toLowerCase();
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  if (looksId(a) && looksId(b)) return a.slice(0, 15) === b.slice(0, 15);
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function compare(a, op, b) {
  if (op === "=") return same(a, b);
  if (op === "!=") return !same(a, b);
  if (a === null || a === undefined || b === null || b === undefined || a === "" || b === "") return false;
  const num = typeof a === "number" || typeof b === "number";
  const x = num ? Number(a) : String(a).toLowerCase();
  const y = num ? Number(b) : String(b).toLowerCase();
  if (num && (Number.isNaN(x) || Number.isNaN(y))) return null; // a text against a number: cannot be checked
  return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
}

/** true, false, or null (could not be checked) for a parsed criteria. `valueOf(field)` gives the field's value or UNKNOWN;
 *  `userValueOf(field)` the same for `$User.Field` on the right side. */
function evalParsed(p, valueOf, userValueOf) {
  if (!p.ok) return null;
  const results = p.terms.map((t) => {
    const left = valueOf(t.field);
    const right = t.value.kind === "userRef" ? userValueOf(t.value.v) : t.value.v;
    if (left === UNKNOWN || right === UNKNOWN) return null;
    return compare(left, t.op, right);
  });
  if (p.join === "or") return results.includes(true) ? true : results.includes(null) ? null : false;
  return results.includes(false) ? false : results.includes(null) ? null : true;
}

const lookup = (vals) => (f) => {
  if (!vals) return UNKNOWN;
  const k = f.toLowerCase();
  return Object.prototype.hasOwnProperty.call(vals, k) ? vals[k] : UNKNOWN;
};

/** Lower-case the keys of a values object (so a field is found whatever case the rule used). */
export function valueMap(obj) {
  if (!obj) return null;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
}

const show = (v) => (v === null || v === undefined || v === "" ? "empty" : typeof v === "string" ? `'${v}'` : String(v));

/** What the checked fields hold, in a few words: "Department is 'Sales'". Only fields whose value is known. */
function valuesText(p, vals, only) {
  if (!p.ok || !vals) return "";
  const get = lookup(vals);
  const seen = new Set();
  const out = [];
  const add = (f, label) => {
    if (seen.has(label.toLowerCase())) return;
    seen.add(label.toLowerCase());
    const v = get(f);
    if (v !== UNKNOWN) out.push(`${label} is ${show(v)}`);
  };
  for (const t of p.terms) if (only === "left" || only === undefined) add(t.field, t.field);
  return out.join(", ");
}

/** Check one rule for one user and one record.
 *  `userVals` and `recVals` are objects of field values (any key case) or null when they could not be read.
 *  Returns {kind: "restrict"|"scoping", outcome, applies, passes, userText, recText, why}. outcome is one of
 *  "hides" (restriction rule that applies and the record is outside its filter), "passes" (does not hide this record),
 *  "notApplies", "maybe" (could not be checked), and for scoping rules "scopes" (applies) | "notApplies" | "maybe". */
export function checkRule(rule, userVals, recVals) {
  const kind = /^scop/i.test(rule.type) ? "scoping" : "restrict";
  const uc = parseCriteria(rule.userCriteria, true);
  const rf = parseCriteria(rule.recordFilter, false);
  const uv = valueMap(userVals);
  const rv = valueMap(recVals);
  const applies = evalParsed(uc, lookup(uv), lookup(uv));
  const passes = evalParsed(rf, lookup(rv), lookup(uv));
  let outcome;
  if (applies === false) outcome = "notApplies";
  else if (kind === "scoping") outcome = applies === true ? "scopes" : "maybe";
  else if (applies === true && passes === false) outcome = "hides";
  else if (passes === true) outcome = "passes";
  else outcome = "maybe";
  let why = "";
  if (outcome === "maybe") {
    why = !uc.ok ? `the user criteria could not be checked (${uc.reason})`
      : !rf.ok && applies !== false ? `the record filter could not be checked (${rf.reason})`
        : applies === null ? "the user's own values could not be read"
          : "the record's own values could not be read";
  }
  return {
    kind, outcome, applies, passes, why,
    userText: valuesText(uc, uv, "left"),
    recText: valuesText(rf, rv, "left"),
  };
}

/** The rule's name for a sentence: its label, else its API name. */
export const ruleName = (r) => r.label || r.devName || "(unnamed rule)";

function userTarget(r) { return `users where ${r.userCriteria}`; }

/** Plain sentences for one user, one per rule, plus counts. `plural` is the object's plural label. */
export function ruleSentences(rules, name, userVals, recVals, opts = {}) {
  const noAccess = !!opts.noAccess; // Salesforce already says no access: a hiding rule is not the reason, it "would also hide"
  const lines = [];
  for (const r of rules.items || []) {
    const c = checkRule(r, userVals, recVals);
    const n = ruleName(r);
    const crit = `applies to ${userTarget(r)}`;
    const filt = `records where ${r.recordFilter}`;
    let text;
    if (c.kind === "restrict") {
      const rn = `Restriction rule '${n}'`;
      if (c.outcome === "hides") text = `By its criteria, ${rn.replace(/^R/, "r")} ${noAccess ? "would also hide" : "should hide"} this record from ${name}. It ${crit}${c.userText ? ` (${name}: ${c.userText})` : ""}, and lets those users see only ${filt}; this record does not match${c.recText ? ` (${c.recText})` : ""}.`;
      else if (c.outcome === "passes") text = c.applies === true
        ? `${rn} applies to ${name} but does not hide this record: the record matches ${filt}${c.recText ? ` (${c.recText})` : ""}.`
        : `${rn} does not hide this record from ${name}: the record matches ${filt}${c.recText ? ` (${c.recText})` : ""}. It ${crit}.`;
      else if (c.outcome === "notApplies") text = `${rn} does not apply to ${name}. It ${crit}${c.userText ? ` (${name}: ${c.userText})` : ""}.`;
      else text = `${rn} may hide this record from ${name}: ${c.why}. It ${crit}, and lets those users see only ${filt}.`;
    } else {
      const rn = `Scoping rule '${n}'`;
      if (c.outcome === "scopes") text = `${rn} applies to ${name}: by default ${name} sees only ${filt} in list views and searches. It does not take access away, and ${name} can still open a record outside it (for example from a link).${c.passes === false ? ` This record does not match${c.recText ? ` (${c.recText})` : ""}, so it may not show in ${name}'s default lists and searches.` : c.passes === true ? " This record matches it." : ""}`;
      else if (c.outcome === "notApplies") text = `${rn} does not apply to ${name}. It ${crit}${c.userText ? ` (${name}: ${c.userText})` : ""}.`;
      else text = `${rn} may apply to ${name}: ${c.why}. It ${crit}. It would only change what ${name} sees by default in list views and searches, never take access away.`;
    }
    const short = c.kind === "restrict" ? `Restriction rule '${n}'` : `Scoping rule '${n}'`;
    lines.push({ id: r.id || r.devName, name: n, short, applies: c.applies, type: c.kind, outcome: c.outcome, wouldAlso: noAccess && c.outcome === "hides", text, userCriteria: r.userCriteria, recordFilter: r.recordFilter, description: r.description || "" });
  }
  return lines;
}
