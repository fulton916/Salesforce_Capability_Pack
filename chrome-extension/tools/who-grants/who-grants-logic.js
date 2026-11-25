// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Pure logic for "Where does a user get this permission?". No browser, no network.
//
// `analyze(facts, spec)` takes what the reader found (see who-grants-read.js, schema "sf-who-grants/1") and the
// permission the person asked about, and returns the answer in plain words: every place that gives it, what
// muting took away, what only counts after activation, what is no longer active, and what could not be checked.
// Facts hold every level of one object (or field), so changing the level needs no new read.

import { searchWords, matchesWords } from "../../shared/pick.js";
import { isSalesforceHost } from "../../shared/sfconn.js";

export const FACTS_SCHEMA = "sf-who-grants/1";

export const OBJECT_LEVELS = [
  { key: "read", label: "Read" },
  { key: "create", label: "Create" },
  { key: "edit", label: "Edit" },
  { key: "delete", label: "Delete" },
  { key: "viewAll", label: "View All" },
  { key: "modifyAll", label: "Modify All" },
];
export const FIELD_LEVELS = [
  { key: "read", label: "Read" },
  { key: "edit", label: "Edit" },
];

export const KIND_CHOICES = [
  { key: "system", label: "A system permission", hint: "for example Modify All Data or View Setup" },
  { key: "object", label: "Access to an object", hint: "Read, Create, Edit, Delete, View All or Modify All" },
  { key: "field", label: "Access to a field", hint: "Read or Edit one field" },
];

export const NOT_CHECKED_NOTE =
  "Not checked in this version: permission set licenses, sharing, and access to Apex classes and Visualforce pages. The user's license can also limit what a permission does.";
export const ENDED_NOTE = "If an assignment ended recently, Salesforce no longer shows it, so it cannot be listed here.";
export const UNLISTED_FIELD_HINT =
  "A field that is not in this list (for example a required field, Name or a system field) is not controlled by field permissions: everyone with access to the object sees it.";

const SPEC_LEVELS = { object: OBJECT_LEVELS, field: FIELD_LEVELS };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------- the pick lists ----------

const byLabel = (a, b) => a.label.localeCompare(b.label) || a.api.localeCompare(b.api);

/** System permissions: every Permissions... checkbox of PermissionSet, with its label. */
export function systemItems(describe) {
  return (describe?.fields || [])
    .filter((f) => f.type === "boolean" && /^Permissions[A-Za-z0-9_]+$/.test(f.name))
    .map((f) => ({ api: f.name, label: f.label || f.name }))
    .sort(byLabel);
}

function picklist(describe, fieldName) {
  const f = (describe?.fields || []).find((x) => x.name === fieldName);
  return (f?.picklistValues || []).filter((v) => v && v.value);
}

/** Objects that can carry object permissions (or, from FieldPermissions, that have controllable fields). */
export function objectItems(describe) {
  return picklist(describe, "SobjectType").map((v) => ({ api: v.value, label: v.label || v.value })).sort(byLabel);
}

/** Fields of one object that field permissions control, from the FieldPermissions "Field" picklist ("Account.Industry"). */
export function fieldItems(describe, objectApi) {
  const prefix = `${objectApi}.`;
  return picklist(describe, "Field")
    .filter((v) => v.value.startsWith(prefix))
    .filter((v, _i, all) => {
      // "Account.Parent" and "Account.ParentId" are one field in FieldPermissions: keep the "...Id" entry only.
      const twin = all.find((w) => w.value === `${v.value}Id`);
      return !(twin && (twin.label || "") === (v.label || ""));
    })
    .map((v) => ({ api: v.value, short: v.value.slice(prefix.length), label: v.label || v.value.slice(prefix.length) }))
    .sort(byLabel);
}

/** The API name of a system permission as people know it: "PermissionsExportReport" -> "ExportReport". The full name stays in the data. */
export function systemApiShort(api) {
  const a = String(api || "");
  return /^Permissions.+/.test(a) ? a.slice("Permissions".length) : a;
}

/** The field part of "Account.Rating" ("Rating"), when the object is the one named. Anything else is returned whole. */
export function fieldApiShort(field, object) {
  const f = String(field || "");
  const prefix = `${object}.`;
  return object && f.startsWith(prefix) && f.length > prefix.length ? f.slice(prefix.length) : f;
}

// "OperatingHours" -> "Operating Hours", so the words of an API name can be told apart.
const camelWords = (s) => String(s || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

/** 0 label starts with the text, 1 a word of the label starts with each typed word, 2 same with the API name's words too, 3 any other match. */
function rankOf(item, words) {
  const labelWords = searchWords(item.label);
  if (labelWords.join(" ").startsWith(words.join(" "))) return 0;
  const starts = (list, w) => list.some((x) => x.startsWith(w));
  if (words.every((w) => starts(labelWords, w))) return 1;
  const apiWords = searchWords(camelWords(systemApiShort(item.api)));
  if (words.every((w) => starts(labelWords, w) || starts(apiWords, w))) return 2;
  return 3;
}

/** Items whose label or API name contains every typed word (any order). Best matches first (see rankOf); other substring matches are listed last. */
export function matchItems(items, text, limit = 100) {
  const words = searchWords(text);
  const hits = words.length ? items.filter((i) => matchesWords(`${i.label} ${i.api}`, words)) : items.slice();
  if (words.length) {
    const rank = new Map(hits.map((i) => [i, rankOf(i, words)]));
    hits.sort((x, y) => rank.get(x) - rank.get(y) || byLabel(x, y));
  }
  return { items: hits.slice(0, limit), total: hits.length };
}

// ---------- links to Setup ----------

const SETUP_PAGES = {
  set: { page: "PermSets", prefix: "0PS" },
  group: { page: "PermSetGroups", prefix: "0PG" },
  profile: { page: "EnhancedProfiles", prefix: "00e" },
  muting: { prefix: "0QM" }, // no page of its own is used: it is opened through its group
};
const SETUP_ID = /^[A-Za-z0-9]{15,18}$/;
const SETUP_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/; // isSalesforceHost only looks at the end of the text, so a path or a user@ part must be refused here

/**
 * The Lightning Setup address of a profile, permission set, permission set group, or (through its group) a muting permission set.
 * `host` is the validated `?host=` of the page. Returns null unless the host and every Id look right (so no link is shown). Pure.
 * `kind`: "profile" | "set" | "group" | "muting"; a muting set needs `opts.groupId`.
 */
export function setupUrl(host, kind, id, opts = {}) {
  if (typeof host !== "string" || !SETUP_HOST.test(host) || host.includes("..") || !isSalesforceHost(host)) return null;
  const def = SETUP_PAGES[kind];
  if (!def) return null;
  const idOk = (v, prefix) => typeof v === "string" && SETUP_ID.test(v) && v.startsWith(prefix);
  if (!idOk(id, def.prefix)) return null;
  let target = def;
  let targetId = id;
  if (kind === "muting") {
    if (!idOk(opts.groupId, SETUP_PAGES.group.prefix)) return null;
    target = SETUP_PAGES.group;
    targetId = opts.groupId;
  }
  return `https://${host}/lightning/setup/${target.page}/page?address=%2F${targetId}`;
}

// ---------- words ----------

export function levelLabel(spec) {
  const list = SPEC_LEVELS[spec?.kind] || [];
  return (list.find((l) => l.key === spec.level) || {}).label || "";
}

/** The permission as one phrase, for the headline: "Delete on Account", "Modify All Data". */
export function permissionWords(spec) {
  if (spec.kind === "system") return spec.label || spec.api;
  const obj = spec.objectLabel || spec.object;
  if (spec.kind === "object") return `${levelLabel(spec)} on ${obj}`;
  return `${levelLabel(spec)} on the field ${spec.fieldLabel || spec.field} (${obj})`;
}

/** "Oct 1, 2026" from an ISO date or date-time (UTC date). */
export function dateWords(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** An expiry as the person's own date and time with the time zone ("Nov 23, 2026, 8:00 PM EST"). `timeZone` is an IANA name (browser's when omitted). */
export function expiryWords(iso, timeZone) {
  const d = new Date(String(iso || ""));
  if (!iso || Number.isNaN(d.getTime())) return dateWords(iso);
  try {
    const opts = { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
    if (timeZone) opts.timeZone = timeZone;
    return d.toLocaleString("en-US", opts);
  } catch {
    return dateWords(iso);
  }
}

const places = (n) => `${n} place${n === 1 ? "" : "s"}`;
const kindWord = (k) => (k === "profile" ? "Profile" : k === "group" ? "Permission set group" : "Permission set");
/** "A", "A and B", "A, B and C" (the items are already worded, quotes included). Pure. */
export const andList = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const namesList = (names) => andList(names.map((n) => `"${n}"`));

/** The date and time with its time zone, for the copied text. `timeZone` is an IANA name (or undefined for the browser's). */
export function whenStamp(date, timeZone) {
  try {
    const opts = { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
    if (timeZone) opts.timeZone = timeZone;
    return date.toLocaleString("en-US", opts);
  } catch {
    return date.toISOString();
  }
}

// ---------- what a source holds ----------

// A level needs these flags to stay on: if muting takes any of them away, the level goes too.
const DEPENDS = {
  read: ["read"],
  create: ["create", "read"],
  edit: ["edit", "read"],
  delete: ["delete", "read", "edit"],
  viewAll: ["viewAll", "read"],
  modifyAll: ["modifyAll", "read", "edit", "delete", "viewAll"],
};

/** true / false, or null when the set is unknown or its flags could not be read. */
function flagOf(set, spec) {
  if (!set) return null;
  let v;
  if (spec.kind === "system") v = set.sys?.target;
  else if (spec.kind === "object") v = set.obj?.[spec.level];
  else v = set.fld?.[spec.level];
  return typeof v === "boolean" ? v : null;
}

/** True when this muting permission set takes the permission (or one it depends on) away. */
function mutes(muting, spec) {
  if (!muting) return false;
  if (spec.kind === "system") return muting.sys?.target === true;
  if (spec.kind === "object") return (DEPENDS[spec.level] || [spec.level]).some((k) => muting.obj?.[k] === true);
  return muting.fld?.read === true || (spec.level === "edit" && muting.fld?.edit === true);
}

/** Other permissions that cover the one asked about. Each has a `get(set)`: true, false or null. */
function impliers(spec) {
  const vad = { text: "View All Data", get: (s) => s.sys?.viewAllData };
  const mad = { text: "Modify All Data", get: (s) => s.sys?.modifyAllData };
  if (spec.kind === "object") return spec.level === "read" || spec.level === "viewAll" ? [vad, mad] : [mad];
  if (spec.kind === "field" && spec.level === "read") {
    return [
      { text: `View All Fields on ${spec.objectLabel || spec.object}`, get: (s) => s.obj?.viewAllFields },
      { text: "View All Fields (all objects)", get: (s) => s.sys?.viewAllFieldsGlobal },
    ];
  }
  return [];
}
/** The covering permissions that could not be read for this set (null flags), so "no" cannot be said for sure. Only a field's Read has any. */
const impliedUnknown = (set, spec) => (set && set.kind !== "muting" ? impliers(spec).filter((i) => i.get(set) === null).map((i) => i.text) : []);
const impliedReasons = (set, spec) => (set ? impliers(spec).filter((i) => i.get(set) === true).map((i) => i.text) : []);

// ---------- one source ----------

/** The Id a Setup link for this assignment needs: the profile's Id (from its permission set), the set's Id or the group's Id. */
function unitId(u, facts) {
  if (u.kind === "group") return u.groupId || null;
  const set = (facts.sets || {})[u.setId15];
  if (!set) return null;
  return u.kind === "profile" ? set.profileId || null : set.id || null;
}
const ref = (u, facts) => ({ kind: u.kind, kindWord: kindWord(u.kind), label: u.label, apiName: u.apiName || "", unnamed: u.unnamed === true, id: unitId(u, facts), groupId: u.kind === "group" ? u.groupId || null : null });
const setRef = (s, groupId) => ({ label: s.label, apiName: s.apiName || "", kind: s.kind === "muting" ? "muting" : "set", id: s.id || null, groupId: groupId || null });

/** What one assignment holds for the permission, plus which covering permissions could not be read (`unknownImplied`). */
function evalUnit(u, facts, spec) {
  const e = evalUnitCore(u, facts, spec);
  if (e.unreadable) return e;
  const sets = facts.sets || {};
  const holder = u.kind === "group" ? sets[(facts.groups?.[u.groupId] || {}).aggregateId15] : sets[u.setId15];
  return { ...e, unknownImplied: impliedUnknown(holder, spec) };
}

function evalUnitCore(u, facts, spec) {
  const sets = facts.sets || {};
  if (u.kind !== "group") {
    const set = sets[u.setId15];
    const explicit = flagOf(set, spec);
    if (explicit === null && u.unnamed) return { unreadable: `${u.label} could not be checked.`, short: `${u.label.charAt(0).toLowerCase() + u.label.slice(1)} could not be checked`, own: true };
    if (explicit === null) return { unreadable: `${kindWord(u.kind)} "${u.label}" could not be checked.`, short: `${kindWord(u.kind).toLowerCase()} "${u.label}" could not be checked` };
    return { explicit, implied: impliedReasons(set, spec), via: [], viaUnknown: false, notes: [] };
  }

  const g = (facts.groups || {})[u.groupId] || {};
  const agg = sets[g.aggregateId15];
  const aggExplicit = flagOf(agg, spec);
  if (aggExplicit === null) {
    return { unreadable: `The group "${u.label}" could not be checked: its combined permissions could not be read.`, short: `group "${u.label}" could not be checked` };
  }
  const comps = g.componentsRead && Array.isArray(g.components) ? g.components.map((id) => sets[id]).filter(Boolean) : null;
  const mutings = (g.muting || []).map((id) => sets[id]).filter(Boolean);
  const notes = [];
  const compHas = comps ? comps.filter((c) => flagOf(c, spec) === true) : [];

  // Implied access comes from the group's combined permissions; the permission sets inside are named when they can be read.
  const implied = impliedReasons(agg, spec);
  const impliedVia = comps ? comps.filter((c) => impliedReasons(c, spec).length).map((s) => setRef(s)) : [];

  if (aggExplicit) {
    const mutingListsIt = mutings.filter((m) => mutes(m, spec));
    if (mutingListsIt.length) notes.push(`${pick(mutingListsIt.length, "A muting permission set", "Muting permission sets")} in this group (${andList(mutingListsIt.map((m) => `"${m.label}"`))}) ${pick(mutingListsIt.length, "lists", "list")} it, but the group still has it, so muting does not remove it here.`);
    return { explicit: true, implied, impliedVia, via: compHas.map((s) => setRef(s)), viaUnknown: !comps || !compHas.length, viaUnreadable: !comps, notes };
  }

  // The combined permissions do not have it.
  if (!comps) {
    return {
      explicit: false, implied, impliedVia, via: [], viaUnknown: false, notes,
      notSure: { text: `The permission sets inside the group "${u.label}" could not be read, so we cannot say why the group does not give it.`, short: `we could not see inside the group "${u.label}"` },
    };
  }
  if (compHas.length) {
    const mutedBy = mutings.filter((m) => mutes(m, spec));
    if (mutedBy.length) {
      return { explicit: false, implied, impliedVia, via: [], viaUnknown: false, notes, muted: { sets: compHas.map((s) => setRef(s)), mutingSets: mutedBy.map((m) => setRef(m, u.groupId)) } };
    }
    if (g.status && g.status !== "Updated") {
      return {
        explicit: false, implied, impliedVia, via: [], viaUnknown: false, notes,
        notSure: { text: `The group "${u.label}" is still being recalculated (status ${g.status}), so we cannot say yet whether it gives this.`, short: `the group "${u.label}" is still being recalculated`, own: true },
      };
    }
    return {
      explicit: false, implied, impliedVia, via: [], viaUnknown: false, notes,
      notPassed: {
        sets: compHas.map((s) => setRef(s)),
        text: notPassedText(compHas.map((s) => s.label)),
        // On the page the sets are named once, in a list with their links, so this sentence does not repeat them.
        pageText: `The group's combined permissions do not have it, although ${compHas.length === 1 ? "a permission set inside the group has" : "permission sets inside the group have"} it. A likely reason is that muting removes something it depends on.`,
      },
    };
  }
  return { explicit: false, implied, impliedVia, via: [], viaUnknown: false, notes };
}

function expiryLine(u, tz) {
  return u.expires ? `Expires ${expiryWords(u.expires, tz)}.` : null;
}

// The reason is kept as data (not text) so the time zone is applied when it is shown.
function whyNotActive(u) {
  if (u.status === "expired") return { code: "expired", expires: u.expires || null };
  if (u.status === "revoked") return { code: "revoked" };
  return { code: "inactive" };
}
function whyText(why, tz) {
  if (why.code === "expired") return `The assignment expired on ${expiryWords(why.expires, tz)}.`;
  if (why.code === "revoked") return "The assignment was removed (revoked).";
  return "The assignment is not active.";
}

/** Everything one run finds for one permission, as lists of sources. Used for the answer and for the object-access check. */
function collect(facts, spec) {
  const c = { gives: [], implied: [], muted: [], activation: [], notActive: [], notPassed: [], notSure: [], notes: [], unknownActivation: [] };
  for (const u of facts.units || []) {
    const e = evalUnit(u, facts, spec);
    const base = ref(u, facts);
    const g = (facts.groups || {})[u.groupId];
    if (u.kind === "group" && g && g.status && g.status !== "Updated" && !e.notSure) {
      c.notes.push(`The group "${u.label}" is still being recalculated (status ${g.status}). The answer may change when it finishes.`);
    }
    if (e.unreadable) {
      if (u.status === "active") c.notSure.push({ ...base, text: e.unreadable, short: e.short, own: !!e.own }); // an assignment that is not active does not matter
      continue;
    }
    const covers = e.explicit === true || e.implied.length > 0;
    const recalc = u.kind === "group" && g && g.status && g.status !== "Updated" ? g.status : null;
    if (u.status === "active" && !covers && e.unknownImplied?.length) {
      // A covering permission was not read: it could give this, so "not given anywhere" cannot be said.
      const what = andList(e.unknownImplied.map((t) => `"${t}"`));
      c.notSure.push({ ...base, text: `We could not check whether ${what} gives it for ${u.unnamed ? u.label.charAt(0).toLowerCase() + u.label.slice(1) : `${kindWord(u.kind).toLowerCase()} "${u.label}"`}.`, short: `${what} could not be checked` });
    }
    if (u.status === "active" && covers && u.activationUnknown && !u.sessionBased) c.unknownActivation.push(base);
    const viaLabels = e.explicit ? e.via : e.impliedVia || [];

    if (u.status === "active") {
      if (e.explicit) {
        c.gives.push({
          ...base, direct: u.kind === "set", via: e.via, viaUnknown: !!e.viaUnknown, viaUnreadable: !!e.viaUnreadable,
          expires: u.expires || null, alsoImplied: e.implied, recalc,
        });
        c.notes.push(...e.notes);
      } else if (e.implied.length) {
        c.implied.push({ ...base, direct: u.kind === "set", via: e.impliedVia || [], reasons: e.implied, expires: u.expires || null, recalc });
      }
      if (e.muted) c.muted.push({ ...base, sets: e.muted.sets, mutingSets: e.muted.mutingSets });
      if (e.notPassed) c.notPassed.push({ ...base, sets: e.notPassed.sets, text: e.notPassed.text, pageText: e.notPassed.pageText });
      if (e.notSure) c.notSure.push({ ...base, text: e.notSure.text, short: e.notSure.short, own: !!e.notSure.own });
    } else if (covers) {
      if (u.status === "needsActivation") c.activation.push({ ...base, direct: u.kind === "set", via: viaLabels });
      else c.notActive.push({ ...base, direct: u.kind === "set", via: viaLabels, why: whyNotActive(u) });
    }
  }
  return c;
}

// ---------- the answer ----------

// ---------- errors ----------

/** An error whose message is already plain words for the person (thrown on purpose by the reader). Anything else is shown as the fallback sentence, with its text folded under Technical details. */
export class PlainError extends Error {
  constructor(message) { super(message); this.name = "PlainError"; }
}

/** What to show for a failure: `message` (plain) and `raw` (for the folded Technical details; "" when none). A 401 and a PlainError keep their own wording; a TypeError and the like never reach the main view. Pure. */
export function errorWords(e, fallback) {
  if (e?.status === 401) return { message: e.message, raw: "" };
  if (e instanceof PlainError) return { message: e.message, raw: "" };
  return { message: fallback, raw: e?.message || String(e || "") };
}

/** Raised by the page when finding the session fails, so the connect message can tell it from other failures. */
export class SessionLookupError extends Error {
  constructor(message) { super(message); this.name = "SessionLookupError"; }
}

const LOG_IN_RELOAD = "Log in to the org in this browser, then reload this page.";

/** What to show when the connection fails: `message` (one sentence of what happened, then what to do once) and `raw` (for Technical details). `host` is the host this page was opened for. Pure. */
export function connectErrorWords(e, host) {
  if (e?.status === 401) return { message: "Your Salesforce session has expired. Reload the Salesforce tab (log in if it asks), then reload this page.", raw: "" };
  if (e instanceof SessionLookupError) {
    const m = String(e.message || "").trim();
    if (!m || /^No Salesforce session found/.test(m)) return { message: `No Salesforce session found for ${host || "this org"}. ${LOG_IN_RELOAD}`, raw: "" };
    return { message: `${m} ${LOG_IN_RELOAD}`, raw: "" };
  }
  return { message: `Could not connect to the org. Check your connection, log in to the org in this browser, then reload this page.`, raw: e?.message || String(e || "") };
}

/** `one` for a single thing, `many` for several: "gives" / "give", so a sentence is right whatever the count. */
const pick = (n, one, many) => (n === 1 ? one : many);

/** The "inside the group" sentence for a group whose parts have it but which does not pass it on. `names` are the labels. Pure. */
export function notPassedText(names) {
  const one = names.length === 1;
  return `${one ? "The permission set" : "The permission sets"} ${namesList(names)} inside the group ${one ? "has" : "have"} it, but the group does not pass it on. A likely reason is that muting removes something it depends on.`;
}

function joinNames(items) {
  const names = items.map((i) => (i.unnamed ? i.label.charAt(0).toLowerCase() + i.label.slice(1) : `${i.kindWord.toLowerCase()} "${i.label}"`));
  if (names.length > 3) return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  if (names.length < 2) return names.join("");
  return andList(names);
}

/** The object access a field needs (Read, or Edit for Edit on the field), or null for other kinds. */
function objectAccessFor(facts, spec) {
  if (spec.kind !== "field") return null;
  const level = spec.level === "edit" ? "edit" : "read";
  const needed = { kind: "object", object: spec.object, objectLabel: spec.objectLabel, level };
  const c = collect(facts, needed);
  const from = [...c.gives, ...c.implied];
  const obj = spec.objectLabel || spec.object;
  const word = level === "edit" ? "Edit" : "Read";
  // Some objects (for example Task and Event) have fields that field permissions control but no object permissions at all.
  if (facts.objectPermissionsApply === false && !from.length) {
    return { level, has: null, notControlled: true, text: `Access to ${obj} is not set by object permissions, so it is not checked here.`, from: [] };
  }
  // A read that failed could be the one that holds the object access, so "no Read" is only said when everything needed was read.
  const blocked = (facts.problems || []).some((p) => p && p.blocks);
  let has = from.length ? true : c.notSure.length || blocked || facts.objectPermissionsApply === null ? null : false;
  let text;
  if (has === true) text = `${word} on ${obj}: yes, from ${joinNames(from)}. ${level === "edit" ? "Edit on a field only works with Edit on its object." : "Field access only works with Read on its object."}`;
  else if (has === false) {
    // Say why, when the object access exists but does not count right now.
    const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
    const parts = [];
    if (c.activation.length) parts.push(`${joinNames(c.activation)} ${pick(c.activation.length, "gives", "give")} it only after session activation.`);
    if (c.muted.length) parts.push(`${joinNames(c.muted)} would give it, but muting removes it.`);
    if (c.notActive.length) parts.push(`${joinNames(c.notActive)} would give it, but ${pick(c.notActive.length, "the assignment has", "the assignments have")} ended or ${pick(c.notActive.length, "is", "are")} not active.`);
    if (c.activation.length) text = `${word} on ${obj}: not right now; ${parts.join(" ")}`;
    else if (parts.length) text = `${word} on ${obj}: no. ${parts.map(cap).join(" ")}`;
    else text = `${word} on ${obj}: no. ${level === "edit" ? "Edit on a field also needs Edit on its object" : "Field access only works with Read on its object"}, so this field access does not work for this user.`;
  }
  else text = `${word} on ${obj}: could not be checked.`;
  return { level, has, text, from: from.map((f) => ({ kindWord: f.kindWord, label: f.label })) };
}

/** Turn the reader's facts and the chosen permission into the answer. Pure. */
export function analyze(facts, spec) {
  const name = facts.user?.name || "This user";
  const perm = permissionWords(spec);
  const problems = (facts.problems || []).filter(Boolean);
  const blocking = problems.filter((p) => p.blocks);
  const c = collect(facts, spec);
  const objectAccess = objectAccessFor(facts, spec);

  const n = c.gives.length + c.implied.length;
  const unsure = blocking.length > 0 || c.notSure.length > 0;
  // Failed reads first; a source is left out of the headline when a failed read already explains it (it stays in the cards and the copied text).
  const sourceReasons = c.notSure.filter((x) => !blocking.length || x.own).map((x) => x.short).filter(Boolean);
  const allReasons = [...new Set([...blocking.map((p) => p.short || p.text.replace(/\.$/, "")), ...sourceReasons])];
  const reasons = allReasons.length > 3 ? [...allReasons.slice(0, 3), `and ${allReasons.length - 3} more`] : allReasons;
  let answer;
  let headline;
  // Hedges for a Yes: the only source is a group still being recalculated, or whether a source is session-based was not read.
  const sources = [...c.gives, ...c.implied];
  const hedges = [];
  if (sources.length === 1 && sources[0].recalc) hedges.push(`The group "${sources[0].label}" is still being recalculated, so this may change.`);
  if (c.unknownActivation.length) hedges.push((c.unknownActivation.length === 1
    ? `We could not check whether ${joinNames(c.unknownActivation)} is session-based; if it is, it only counts after the person activates it.`
    : `We could not check whether ${joinNames(c.unknownActivation)} are session-based; if they are, they only count after the person activates them.`));
  const more = unsure ? " Some access could not be checked, so there may be more." : "";

  const lvlWord = objectAccess ? (objectAccess.level === "edit" ? "Edit" : "Read") : "";
  if (n > 0 && objectAccess && objectAccess.has === false) {
    answer = "notWorking";
    headline = `No. ${name} is given ${perm} in ${places(n)}, but has no ${lvlWord} on ${spec.objectLabel || spec.object}, so it does not work.${more}`;
  } else if (n > 0 && objectAccess && objectAccess.has === null && !objectAccess.notControlled) {
    answer = "yes";
    headline = `Yes. ${name} gets ${perm} from ${places(n)}, but whether they have ${lvlWord} on ${spec.objectLabel || spec.object} could not be checked.${hedges.map((h) => ` ${h}`).join("")}${more}`;
  } else if (n > 0) {
    answer = "yes";
    headline = `Yes. ${name} gets ${perm} from ${places(n)}.${hedges.map((h) => ` ${h}`).join("")}${more}`;
  } else if (unsure) {
    // Something needed could not be read: never a "No", whatever else is known (a muted group, an ended assignment ...).
    answer = "unsure";
    const known = c.muted.length
      ? ` What we do know: ${c.muted.length === 1 ? `the group "${c.muted[0].label}" would give it, but its muting permission set removes it` : `${c.muted.length} groups would give it, but their muting permission sets remove it`}.`
      : "";
    headline = `Not sure. We could not check everything, so we cannot say whether ${name} gets ${perm}: ${reasons.join("; ")}.${known}`;
  } else if (c.muted.length) {
    answer = "muted";
    const one = c.muted.length === 1;
    const who = one ? `the group "${c.muted[0].label}"` : `${c.muted.length} groups`;
    headline = `No. ${name} does not get ${perm}: ${who} would give it, but ${one ? "its muting permission set removes" : "their muting permission sets remove"} it.`;
  } else if (c.notPassed.length) {
    answer = "no";
    headline = `No. ${name} does not get ${perm}: ${c.notPassed.length === 1 ? `the group "${c.notPassed[0].label}" has it inside but does not pass it on` : `${c.notPassed.length} groups have it inside but do not pass it on`}.`;
  } else if (c.activation.length) {
    answer = "no";
    headline = `No. ${name} does not get ${perm} right now: it is in a session-based ${c.activation.length === 1 ? "assignment" : "assignments"} that ${c.activation.length === 1 ? "has" : "have"} to be activated first.`;
  } else if (c.notActive.length) {
    answer = "no";
    headline = c.notActive.length === 1
      ? `No. ${name} does not get ${perm}: the only assignment that included it has ended or is not active.`
      : `No. ${name} does not get ${perm}: the ${c.notActive.length} assignments that included it have ended or are not active.`;
  } else {
    answer = "no";
    headline = `No. ${name} does not get ${perm}: not given anywhere.`;
  }

  const notes = [...new Set([...c.notes, ...hedges.slice(sources.length === 1 && sources[0].recalc ? 1 : 0), ...(facts.notes || [])])];
  if (facts.objectPermissionsApply === false && spec.kind === "object") notes.push(`${spec.objectLabel || spec.object} is not controlled by object permissions, so no permission set or profile lists it. Its access is set another way (for example by the record it belongs to).`);
  for (const p of problems) notes.push(p.text);
  if (answer !== "yes") notes.push(ENDED_NOTE);
  notes.push(NOT_CHECKED_NOTE);

  return {
    answer, headline, places: n, spec,
    user: facts.user || {},
    inactiveUser: facts.user?.isActive === false,
    inactiveNote: facts.user?.isActive === false ? `${name} is an inactive user. They cannot log in, so nothing here applies right now.` : "",
    gives: c.gives, implied: c.implied, muted: c.muted, activation: c.activation, notActive: c.notActive, notPassed: c.notPassed, notSure: c.notSure,
    objectAccess, notes, problems,
  };
}

// ---------- what the page and the copied text show ----------

const LINK_WORDS = { profile: "profile", set: "permission set", group: "permission set group", muting: "muting permission set" };
const LINK_CAPTION = { profile: "Profile", set: "Permission set", group: "Permission set group", muting: "Muting permission set" };

/** One link description for a named thing, or null (unnamed, no Id, unknown kind): {kind, id, groupId, own, caption, text, label}. `text` is what the link says; `label` is the accessible name (it starts with `text`); the page adds the address. */
function linkOf(t) {
  if (!t || t.unnamed || !t.id || !LINK_WORDS[t.kind]) return null;
  const muting = t.kind === "muting"; // a muting set has no page of its own: its group's page opens
  const text = muting ? "Open the group in Setup" : "Open in Setup";
  const label = muting ? `${text}: the permission set group that holds the muting permission set ${t.label}` : `${text}: ${LINK_WORDS[t.kind]} ${t.label}`;
  return { kind: t.kind, id: t.id, groupId: t.groupId || null, own: t.own === true, caption: `${LINK_CAPTION[t.kind]} "${t.label}"`, text, label };
}

/** One link description per named thing (no repeats). */
function linksOf(things) {
  const seen = new Set();
  const out = [];
  for (const t of things) {
    const l = linkOf(t);
    if (!l) continue;
    const key = `${l.kind}:${l.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

const viaText = (via) => andList(via.map((v) => `"${v.label}"`));

/**
 * The sections in the order they are shown. Each item has a title, a small API name and `lines` (plain sentences: what the copied text uses).
 * For the page an item also has `body`: the same facts in order, as a sentence (string) or a named list `{label, items: [{text, link}]}`
 * (each permission set or muting set named once, with its "Open in Setup" link when it has one), and `links` (the card's own link first). Pure.
 */
export function sectionsOf(r, opts = {}) {
  const tz = opts.timeZone;
  const out = [];
  const title = (x) => (x.unnamed ? x.label : `${x.kindWord}: ${x.label}`); // an unnamed set is a sentence, not a name
  // The things a card names, as data for "Open in Setup" links (the page adds the host; no Ids or links go into the copied text).
  const links = (x, more = []) => linksOf([{ ...x, own: true }, ...more.map((m) => ({ ...m, own: false }))]);
  const list = (label, things) => ({ label, items: things.map((t) => ({ text: `"${t.label}"`, link: linkOf({ ...t, own: false }) })) });
  /** A card: `add(copySentence, pageEntry)` adds to the copied lines and to the page's body (the page entry defaults to the sentence; null leaves it out of the page). */
  const card = (x, more = []) => {
    const lines = [];
    const body = [];
    const add = (sentence, entry) => {
      if (sentence) lines.push(sentence);
      const e = entry === undefined ? sentence : entry;
      if (e) body.push(e);
    };
    return { add, build: () => ({ title: title(x), apiName: x.apiName, lines, body, links: links(x, more) }) };
  };

  if (r.gives.length) {
    out.push({
      key: "gives", title: "Gives it",
      items: r.gives.map((x) => {
        const c = card(x, x.via);
        if (x.kind === "profile") c.add("The user's profile.");
        else if (x.kind === "set") c.add("Assigned directly.");
        else if (x.via.length) c.add(`Through ${x.via.length === 1 ? "this permission set" : "these permission sets"} inside the group: ${viaText(x.via)}.`, list("Given inside the group by:", x.via));
        else c.add(x.viaUnreadable ? "The group gives it. We could not read the permission sets inside, so we cannot tell which one." : "The group gives it, but we could not tell which permission set inside.");
        if (x.alsoImplied?.length) c.add(`It is also covered by ${andList(x.alsoImplied.map((t) => `"${t}"`))}, which it includes.`);
        c.add(expiryLine(x, tz));
        return c.build();
      }),
    });
  }
  if (r.implied.length) {
    out.push({
      key: "implied", title: "Also covers it", hint: "These do not list it, but another permission they include covers it. They count as giving it.",
      items: r.implied.map((x) => {
        const c = card(x, x.via);
        c.add(`Covered by ${x.reasons.join(" and ")}.`);
        if (x.kind === "group" && x.via.length) c.add(`That permission is in ${x.via.length === 1 ? "this permission set" : "these permission sets"} inside the group: ${viaText(x.via)}.`, list("Held inside the group by:", x.via));
        if (x.kind === "set") c.add("Assigned directly.");
        c.add(expiryLine(x, tz));
        return c.build();
      }),
    });
  }
  if (r.muted.length) {
    out.push({
      key: "muted", title: "Removed by muting", hint: r.answer === "unsure"
        ? "These would give it, but a muting permission set takes it away. They do not count, but something else might give it."
        : "These would give it, but a muting permission set takes it away. They do not count.",
      items: r.muted.map((x) => {
        const c = card(x, [...x.sets, ...x.mutingSets]);
        c.add(`${x.sets.length === 1 ? "This permission set inside the group gives it" : "These permission sets inside the group give it"}: ${viaText(x.sets)}.`, list("Given inside the group by:", x.sets));
        c.add(`${x.mutingSets.length === 1 ? "This muting permission set takes it away" : "These muting permission sets take it away"}: ${viaText(x.mutingSets)}.`, list("Taken away by:", x.mutingSets));
        return c.build();
      }),
    });
  }
  if (r.notPassed.length) {
    out.push({
      key: "notPassed", title: "In a group but not passed on", hint: "The permission set inside has it, but the group's combined permissions do not. They do not count.",
      items: r.notPassed.map((x) => {
        const c = card(x, x.sets);
        c.add(x.text, x.pageText || x.text);
        c.add(null, list("Held inside the group by:", x.sets));
        return c.build();
      }),
    });
  }
  if (r.activation.length) {
    out.push({
      key: "activation", title: "Needs session activation", hint: "Session-based: it only counts after the person activates it in their session. Not counted as giving it.",
      items: r.activation.map((x) => {
        const c = card(x, x.via);
        if (x.kind === "group") {
          if (x.via.length) c.add(`Contains it through: ${viaText(x.via)}.`, list("Contained in the group by:", x.via));
          else c.add("The group contains it.");
        } else if (x.direct) c.add("Assigned directly.");
        return c.build();
      }),
    });
  }
  if (r.notActive.length) {
    out.push({
      key: "notActive", title: "Not active", hint: "These contain it, but the assignment has ended or is not active. They do not count.",
      items: r.notActive.map((x) => {
        const c = card(x, x.via);
        c.add(whyText(x.why, tz));
        if (x.kind === "group" && x.via.length) c.add(`Contains it through: ${viaText(x.via)}.`, list("Contained in the group by:", x.via));
        return c.build();
      }),
    });
  }
  if (r.notSure.length) {
    out.push({
      key: "notSure", title: "Could not be checked", hint: "The answer above may change once these are known.",
      items: r.notSure.map((x) => { const c = card(x); c.add(x.text); return c.build(); }),
    });
  }
  return out;
}

/** The plain text for a ticket. `ctx` = {orgName, when (a ready-made date and time with its time zone), timeZone (IANA, for expiry dates; the browser's when omitted)}. */
export function copyText(r, ctx = {}) {
  const lines = [];
  const u = r.user || {};
  lines.push("Where does a user get this permission?");
  if (ctx.orgName) lines.push(`Org: ${ctx.orgName}`);
  lines.push(`User: ${u.name || ""}${u.username ? ` (${u.username})` : ""}${r.inactiveUser ? " - inactive" : ""}`);
  const s = r.spec;
  if (s.kind === "system") lines.push(`Permission: ${s.label || s.api} (system permission, API name ${systemApiShort(s.api)})`);
  else if (s.kind === "object") lines.push(`Permission: ${levelLabel(s)} on ${s.objectLabel || s.object} (object, API name ${s.object})`);
  else lines.push(`Permission: ${levelLabel(s)} on the field ${s.fieldLabel || s.field} of ${s.objectLabel || s.object} (API name ${fieldApiShort(s.field, s.object)})`);
  if (ctx.when) lines.push(`Checked: ${ctx.when}`);
  lines.push("", r.headline);
  if (r.inactiveNote) lines.push(r.inactiveNote);
  for (const sec of sectionsOf(r, { timeZone: ctx.timeZone })) {
    lines.push("", `${sec.title.toUpperCase()}${sec.hint ? ` (${sec.hint})` : ""}`);
    for (const it of sec.items) {
      lines.push(`- ${it.title}${it.apiName ? ` [${it.apiName}]` : ""}`);
      for (const l of it.lines) lines.push(`    ${l}`);
    }
  }
  if (r.objectAccess) lines.push("", "OBJECT ACCESS", `- ${r.objectAccess.text}`);
  if (r.notes.length) {
    lines.push("", "NOTES");
    for (const n of r.notes) lines.push(`- ${n}`);
  }
  return lines.join("\n");
}

/** Clipboard write with a plain "not copied" answer instead of an error (`clipboard` is navigator.clipboard). */
export async function copyWithFallback(text, clipboard) {
  try {
    if (!clipboard || typeof clipboard.writeText !== "function") return { copied: false };
    await clipboard.writeText(text);
    return { copied: true };
  } catch {
    return { copied: false };
  }
}

// ---------- demo: facts from a made-up org ----------

const flagsOf = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] === true]));

/**
 * Demo mode only. Builds the same facts the reader returns, for any permission, from a small made-up org
 * (samples/who_grants_demo.json): `model.sets` (each with `sys`, `obj` and `fld` flags), `model.groups`, and per user `units`.
 * Anything the model does not list is "off".
 */
export function factsFromModel(model, userId, spec) {
  const u = (model.users || []).find((x) => x.id === userId);
  if (!u) throw new Error("This demo user was not found.");
  const sets = {};
  for (const [key, s] of Object.entries(model.sets || {})) {
    const sys = s.sys || {};
    sets[key] = {
      id: key, kind: s.kind || "set", label: s.label, apiName: s.apiName || "",
      sys: { target: spec.kind === "system" ? sys[spec.api] === true : undefined, viewAllData: sys.PermissionsViewAllData === true, modifyAllData: sys.PermissionsModifyAllData === true, viewAllFieldsGlobal: sys.PermissionsViewAllFieldsGlobal === true },
      obj: spec.kind === "system" ? null : { ...flagsOf(s.obj?.[spec.object], ["read", "create", "edit", "delete", "viewAll", "modifyAll", "viewAllFields"]) },
      fld: spec.kind === "field" ? flagsOf(s.fld?.[spec.field], ["read", "edit"]) : null,
    };
  }
  const groups = {};
  for (const [key, g] of Object.entries(model.groups || {})) {
    groups[key] = { id: key, label: g.label, apiName: g.apiName || "", status: g.status || "Updated", aggregateId15: g.aggregate, componentsRead: g.componentsRead !== false, components: g.components || [], muting: g.muting || [] };
  }
  const units = (u.units || []).map((x) => {
    if (x.kind === "group") {
      const g = groups[x.ref];
      return { kind: "group", label: g.label, apiName: g.apiName, groupId: x.ref, status: x.status || "active", expires: x.expires || null, sessionBased: x.status === "needsActivation" };
    }
    const s = sets[x.ref];
    return { kind: x.kind, label: s.label, apiName: x.kind === "profile" ? "" : s.apiName, setId15: x.ref, status: x.status || "active", expires: x.expires || null, sessionBased: x.status === "needsActivation" };
  });
  return {
    schema: FACTS_SCHEMA, readAt: model.readAt || "2026-11-23T12:00:00Z", apiVersion: "demo",
    user: { id: u.id, name: u.name, username: u.username, isActive: u.isActive !== false, profile: u.profile || "" },
    spec: { kind: spec.kind, api: spec.api, object: spec.object, field: spec.field },
    units, sets, groups, problems: [], notes: [], objectPermissionsApply: !(model.noObjectPermissions || []).includes(spec.object),
  };
}
