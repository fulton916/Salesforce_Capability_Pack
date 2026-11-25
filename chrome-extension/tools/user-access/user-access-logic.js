// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Turn one user's access into rows, and compare two users. Pure: no browser or network APIs.
//
// A user's access is the plain JSON object user-access-read.js reads from an org
// (schema "sf-user-access/1"). Items are matched across users by API name (key), never by Id.

import { toCsv } from "../../shared/csv.js";
import { EAC_KEY, EAC_TITLE, EAC_ONE, EAC_NOUN, EAC_HELP, eacDetailText } from "./user-access-eac.js";

export { toCsv };
export const ACCESS_SCHEMA = "sf-user-access/1";

/** The areas, in display order. `noun` is for "3 permission sets", `one` for "1 permission set". */
export const SECTIONS = [
  { key: "profile", title: "Profile", one: "profile", noun: "profiles", help: "The profile gives the user their base access and decides which user license they have." },
  { key: "role", title: "Role", one: "role", noun: "roles", help: "The role decides which records the user can see through the role hierarchy (for example, records owned by people below them)." },
  { key: "callCenter", title: "Call center", one: "call center", noun: "call centers", help: "The call center the user is assigned to (for example for a phone system built into Salesforce). Most orgs do not use call centers." },
  { key: "permissionSetGroups", title: "Permission set groups", one: "permission set group", noun: "permission set groups", help: "Groups of permission sets assigned to the user. If a group has a muting permission set, that set removes some access and is listed beside the group." },
  { key: "permissionSets", title: "Permission sets", one: "permission set", noun: "permission sets", help: "Permission sets the user has, assigned directly or through a group. Sets that come built into a profile are not shown." },
  { key: "permissionSetLicenses", title: "Permission set licenses", one: "license", noun: "licenses", help: "Licenses that some permission sets need before they work for this user." },
  { key: "publicGroups", title: "Public groups", one: "public group", noun: "public groups", help: "Only groups the user was added to directly. Groups they get through a role or another group are not shown." },
  { key: "queues", title: "Queues", one: "queue", noun: "queues", help: "Only queues the user was added to directly. Queues they get through a role or a group are not shown." },
  { key: "territories", title: "Territories", one: "territory", noun: "territories", help: "Sales territories the user is assigned to." },
  { key: EAC_KEY, title: EAC_TITLE, one: EAC_ONE, noun: EAC_NOUN, help: EAC_HELP },
  { key: "customSettings", title: "Custom settings", one: "custom setting value", noun: "custom setting values", help: "Custom settings can switch things on or off for one user or one profile, for example a “bypass validation rules” box. This list shows only the values that are different from the org default for this user, including values they get from their profile. Settings that are the same for everyone are not shown." },
];

/** Areas that hold a single value (shown as the name, or "no ..."), not a list. */
export const SINGLE_VALUE_KEYS = ["profile", "role", "callCenter"];
/** Areas that older files may not have; they load as empty. */
const OPTIONAL_KEYS = ["callCenter", "customSettings", EAC_KEY];
/** "1 queue", "3 queues". `one` and `many` are the singular and plural nouns. */
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "1 permission set", "3 permission sets" for an area. */
export function countText(n, sectionKey) {
  const s = SECTIONS.find((x) => x.key === sectionKey);
  return s ? plural(n, s.one, s.noun) : String(n);
}

export const SECTION_KEYS = SECTIONS.map((s) => s.key);
export const SECTION_TITLES = { overview: "Summary", ...Object.fromEntries(SECTIONS.map((s) => [s.key, s.title])) };
export const SECTION_HELP = {
  overview: "A quick look at each area. Click a card above, or a tab, to see the list.",
  ...Object.fromEntries(SECTIONS.map((s) => [s.key, s.help])),
};

// ---------- hierarchy custom settings ----------

const id15 = (v) => (v ? String(v).slice(0, 15) : "");
export const SOURCE_TEXT = { user: "This user", profile: "Their profile", org: "Org default" };

/** A custom setting value in words. A checkbox is never "not set"; an empty value is "Not set". */
export function valueText(type, v) {
  if (type === "boolean") return v === true ? "Checked" : "Not checked";
  if (v === null || v === undefined || v === "") return "Not set";
  return String(v);
}

const normValue = (type, v) => {
  if (type === "boolean") return v === true; // an unset checkbox is the same as unchecked
  return v === null || v === undefined || v === "" ? null : v;
};
/** True when two values of one field mean the same thing. */
export const sameValue = (type, x, y) => normValue(type, x) === normValue(type, y);

export const HIDDEN_TEXT = "Hidden (looks like a key)";
export const HIDDEN_NOTE = "Values of fields named like a key, token, secret or password are hidden.";
const SECRET_WORDS = /key|token|secret|password|passwd|pwd|credential|private/i;

/** True when a field's API name or label looks secret-like. Checkboxes are never hidden. Over-hiding (e.g. "Keyword") is fine. */
export function isSecretLike(field) {
  if (!field || field.type === "boolean") return false;
  return SECRET_WORDS.test(String(field.name || field.api || "")) || SECRET_WORDS.test(String(field.label || ""));
}

/** A short one-way fingerprint, so two hidden values can be told apart without keeping either one. */
function fingerprint(v) {
  if (v === null || v === undefined || v === "") return "";
  const t = String(v);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}${t.length}`;
}

/** True when two items' values are the same. Hidden items are compared by fingerprint (the value itself is not kept). */
function sameItemValue(x, y) {
  if (x.hidden || y.hidden) return !!x.hidden === !!y.hidden && (x.valueId || "") === (y.valueId || "");
  return sameValue(x.type, x.value, y.value);
}

/**
 * Salesforce's hierarchy rule, field by field: the lowest level where the field is not null wins
 * (this user, then their profile, then the org default). `rows` are the setting's rows whose
 * SetupOwnerId is one of the three. A checkbox row always has a value (false counts), so a user
 * row with false beats a profile row with true.
 * Returns one entry per field: {name, label, type, value, source: "user"|"profile"|"org"|null, orgDefault}.
 */
export function resolveHierarchy(fields, rows, { userId, profileId, orgId }) {
  const rowFor = (id) => (id ? rows.find((r) => id15(r.SetupOwnerId) === id15(id)) || null : null);
  const levels = [["user", rowFor(userId)], ["profile", rowFor(profileId)], ["org", rowFor(orgId)]];
  const orgRow = levels[2][1];
  return fields.map((f) => {
    let value = null;
    let source = null;
    for (const [level, row] of levels) {
      const v = row ? row[f.name] : null;
      if (v !== null && v !== undefined) { value = v; source = level; break; }
    }
    const orgDefault = orgRow && orgRow[f.name] !== undefined ? orgRow[f.name] : null;
    return { name: f.name, label: f.label || f.name, type: f.type, value, source, orgDefault };
  });
}

/** A list item for a secret-like field: no value is kept, only the hidden text and a fingerprint for comparing. */
function hiddenItem(setting, r) {
  return {
    key: `${setting.api}.${r.name}`,
    label: `${setting.label}: ${r.label}`,
    setting: { api: setting.api, label: setting.label },
    field: { api: r.name, label: r.label },
    type: r.type,
    hidden: true,
    value: null,
    valueId: fingerprint(r.value),
    valueText: HIDDEN_TEXT,
    source: r.source,
    sourceText: SOURCE_TEXT[r.source] || "",
    orgDefault: null,
    orgDefaultText: HIDDEN_TEXT,
  };
}

/** The fields of one setting whose effective value differs from the org default, as list items. */
export function settingItems(setting, fields, rows, ids) {
  return resolveHierarchy(fields, rows, ids)
    .map((r) => ({ ...r, hidden: isSecretLike(r) }))
    .filter((r) => !sameValue(r.type, r.value, r.orgDefault))
    .map((r) => r.hidden ? hiddenItem(setting, r) : ({
      key: `${setting.api}.${r.name}`,
      label: `${setting.label}: ${r.label}`,
      setting: { api: setting.api, label: setting.label },
      field: { api: r.name, label: r.label },
      type: r.type,
      value: r.value,
      valueText: valueText(r.type, r.value),
      source: r.source,
      sourceText: SOURCE_TEXT[r.source] || "",
      orgDefault: r.orgDefault,
      orgDefaultText: valueText(r.type, r.orgDefault),
    }));
}

/** Count line for the custom settings area of one user. "" when the file has no such information. */
export function customSettingsLine(access) {
  const info = access?.customSettingsInfo;
  if (!info) return "";
  if (!info.hierarchy) {
    return `This org has no custom settings that can differ by user or profile.${info.capped ? ` (Only the first ${info.examined} of ${info.found} custom settings were checked.)` : ""}`;
  }
  const n = new Set(itemsOf(access, "customSettings").map((i) => i.setting?.api)).size;
  const verb = n === 1 || info.hierarchy === 1 ? "has" : "have";
  let line = `${n} of ${plural(info.hierarchy, "custom setting", "custom settings")} ${verb} a value for this user or their profile that differs from the org default.`;
  if (info.capped) line += ` Only the first ${info.examined} of ${info.found} custom settings were checked; the rest are not shown.`;
  return line;
}

/** Plain note: some fields of special types are never shown. "" when there are none. */
export function customSettingsSkippedNote(...accesses) {
  const n = Math.max(0, ...accesses.map((a) => a?.customSettingsInfo?.skippedFields || 0));
  if (!n) return "";
  return `${plural(n, "field", "fields")} of ${n === 1 ? "a special type is" : "special types are"} not shown.`;
}

/** The one-sentence reason for hidden values. "" when nothing is hidden in any of the given users. */
export function customSettingsHiddenNote(...accesses) {
  return accesses.some((a) => itemsOf(a, "customSettings").some((i) => i.hidden)) ? HIDDEN_NOTE : "";
}

/** Plain note: some custom settings could not be read for this user. "" when all could. */
export function customSettingsFailedNote(access) {
  const n = access?.customSettingsInfo?.failed || 0;
  return n ? `${plural(n, "setting", "settings")} could not be read.` : "";
}

/** True when a custom setting's values could not be read for this user (the whole area, or just this setting). */
const settingUnread = (access, api) =>
  !!access?.unavailable?.customSettings || (access?.customSettingsInfo?.failedSettings || []).includes(api);

/** Check the shape of an access object (a sample file, or what readUserAccess returned). */
export function validateAccess(obj) {
  if (!obj || typeof obj !== "object") throw new Error("Not a user access file.");
  if (obj.schema !== ACCESS_SCHEMA) throw new Error(`Unknown schema ${obj.schema}; expected ${ACCESS_SCHEMA}.`);
  if (!obj.user || !obj.user.name) throw new Error("The file has no user.");
  if (!obj.sections || typeof obj.sections !== "object") throw new Error("The file has no sections.");
  for (const k of SECTION_KEYS) {
    if (obj.sections[k] === undefined && OPTIONAL_KEYS.includes(k)) obj.sections[k] = [];
    if (!Array.isArray(obj.sections[k])) throw new Error(`Section ${k} is missing.`);
    for (const it of obj.sections[k]) if (!it || !it.key) throw new Error(`An item in ${k} has no name.`);
  }
  obj.unavailable = obj.unavailable || {};
  obj.warnings = obj.warnings || [];
  return obj;
}

export const itemsOf = (access, key) => access?.sections?.[key] || [];

/** How the user gets a permission set, in words. */
export function howText(item) {
  const groups = (item.groups || []).map((g) => g.label || g.key);
  const through = groups.length ? `the group${groups.length > 1 ? "s" : ""} ${groups.join(", ")}` : "";
  if (item.direct && through) return `Assigned directly and through ${through}`;
  if (item.direct) return "Assigned directly";
  return through ? `Through ${through}` : "";
}

/** Extra words shown next to an item (how it was given, licence, muting). */
export function detailText(sectionKey, item, other = null) {
  if (!item) {
    // A custom setting the other user does not have set differently is at the org default.
    return sectionKey === "customSettings" && other ? `Same as the org default: ${other.orgDefaultText}` : "";
  }
  const parts = [];
  if (sectionKey === "customSettings") {
    parts.push(`Value: ${item.valueText}`, `Comes from: ${(item.sourceText || "").toLowerCase()}`, `Org default: ${item.orgDefaultText}`);
  } else if (sectionKey === "permissionSets") {
    parts.push(howText(item));
    if (item.licence) parts.push(`Needs license: ${item.licence}`);
  } else if (sectionKey === "permissionSetGroups") {
    if (item.muting?.length) parts.push(`Muting permission set${item.muting.length > 1 ? "s" : ""}: ${item.muting.join(", ")}`);
    if (item.status && item.status !== "Updated") parts.push(`Not up to date (${item.status}). In Setup, open this group and wait for its status to say Updated.`);
  } else if (sectionKey === EAC_KEY) {
    parts.push(eacDetailText(item));
  } else if (sectionKey === "profile") {
    if (item.licence) parts.push(`User license: ${item.licence}`);
  }
  return parts.filter(Boolean).join("\n"); // one fact per line (the page keeps the line breaks)
}

/** One user's rows for a list: [{key, label, item, detail}], sorted by label. */
export function singleRows(access, sectionKey) {
  return itemsOf(access, sectionKey)
    .map((item) => ({ key: item.key, label: item.label || item.key, item, detail: detailText(sectionKey, item) }))
    .sort((x, y) => x.label.localeCompare(y.label));
}

/** True when at least one row has something to show in a Details column. */
export const hasDetails = (rows) => rows.some((r) => r.detail);

/** Item count per area for one user. */
export function summarize(access) {
  const counts = {};
  for (const k of SECTION_KEYS) counts[k] = itemsOf(access, k).length;
  return counts;
}

/** The names to show for A and B. Same name twice: add the username. */
export function displayNames(a, b) {
  const x = a.user.name;
  const y = b.user.name;
  if (x !== y) return { a: x, b: y };
  return { a: `${x} (${a.user.username})`, b: `${y} (${b.user.username})` };
}

export function statusText(status, nameA = "A", nameB = "B") {
  return {
    same: "Same", onlyA: `Only ${nameA}`, onlyB: `Only ${nameB}`, differ: "Different",
    unreadA: `Could not be read for ${nameA}`, unreadB: `Could not be read for ${nameB}`,
  }[status] || status;
}

/** Compare two users. Rows are matched by API name, so users from different orgs compare cleanly. */
export function compareUsers(a, b) {
  const names = displayNames(a, b);
  const sections = {};
  const counts = {};
  const unavailable = {};
  for (const k of SECTION_KEYS) {
    const ma = new Map(itemsOf(a, k).map((i) => [i.key, i]));
    const mb = new Map(itemsOf(b, k).map((i) => [i.key, i]));
    const rows = [];
    for (const key of new Set([...ma.keys(), ...mb.keys()])) {
      const ia = ma.get(key) || null;
      const ib = mb.get(key) || null;
      let status = "same";
      if (k === "customSettings" && ia && !ib && settingUnread(b, ia.setting?.api)) status = "unreadB";
      else if (k === "customSettings" && !ia && ib && settingUnread(a, ib.setting?.api)) status = "unreadA";
      else if (ia && !ib) status = "onlyA";
      else if (!ia && ib) status = "onlyB";
      else if (k === "permissionSets" && howText(ia) !== howText(ib)) status = "differ";
      else if (k === "customSettings" && !sameItemValue(ia, ib)) status = "differ";
      else if (k === EAC_KEY && eacDetailText(ia) !== eacDetailText(ib)) status = "differ";
      let detailA = detailText(k, ia, ib);
      let detailB = detailText(k, ib, ia);
      if (status === "unreadA") detailA = `Could not be read for ${names.a}`;
      if (status === "unreadB") detailB = `Could not be read for ${names.b}`;
      rows.push({ key, label: (ia || ib).label || key, a: ia, b: ib, status, detailA, detailB });
    }
    rows.sort((x, y) => x.label.localeCompare(y.label));
    sections[k] = rows;
    const n = (s) => rows.filter((r) => r.status === s).length;
    counts[k] = { onlyA: n("onlyA"), onlyB: n("onlyB"), same: n("same"), differ: n("differ"), unread: n("unreadA") + n("unreadB"), total: rows.length, totalA: ma.size, totalB: mb.size };
    const ua = a.unavailable?.[k] || null;
    const ub = b.unavailable?.[k] || null;
    if (ua || ub) unavailable[k] = { a: ua, b: ub };
  }
  return { a, b, names, sections, counts, unavailable, verdict: verdict(counts, names), notes: notesOf(a, b, names) };
}

const fmt = (n) => Number(n).toLocaleString("en-US");

/**
 * What one card says when two users are compared. Returns lines: {cls, segs: [{text, bold?, side?}]}.
 * `side` is "a" or "b" (the page colours the user's name); cls "same" is the green tick line.
 * List areas always show the shared count and each user's own count, even when 0.
 * Profile and role show the actual value.
 */
export function userCardLines(result, key) {
  const sec = SECTIONS.find((x) => x.key === key);
  const c = result.counts[key];
  const A = result.names.a;
  const B = result.names.b;
  const line = (cls, ...segs) => ({ cls, segs });
  const T = (text) => ({ text });
  if (SINGLE_VALUE_KEYS.includes(key)) {
    const va = itemsOf(result.a, key)[0]?.label || "None";
    const vb = itemsOf(result.b, key)[0]?.label || "None";
    if (va === vb) return [line("same", T(`✓ Same in both: ${va === "None" ? `no ${sec.one}` : va}`))];
    const show = (v) => (v === "None" ? `no ${sec.one}` : v);
    return [line("", { text: A, side: "a" }, T(`: ${show(va)}`)), line("", { text: B, side: "b" }, T(`: ${show(vb)}`))];
  }
  const failed = key !== "customSettings" ? [] : [["a", A, result.a], ["b", B, result.b]]
    .filter(([, , acc]) => customSettingsFailedNote(acc))
    .map(([side, name, acc]) => line("", { text: name, side }, T(`: ${customSettingsFailedNote(acc)}`)));
  if (!c.totalA && !c.totalB) return [line("same", T("Neither has any")), ...failed];
  const lines = [
    line("", { text: fmt(c.same + c.differ), bold: true }, T(` ${c.same + c.differ === 1 ? sec.one : sec.noun} both have`)),
    line("", { text: fmt(c.onlyA), bold: true }, T(" only "), { text: A, side: "a" }, T(" has")),
    line("", { text: fmt(c.onlyB), bold: true }, T(" only "), { text: B, side: "b" }, T(" has")),
  ];
  if (key === "permissionSets") lines.push(line("", { text: fmt(c.differ), bold: true }, T(" of those assigned differently (directly or through a group)")));
  if (key === "customSettings") lines.push(line("", { text: fmt(c.differ), bold: true }, T(" of those with a different value for each")));
  if (key === EAC_KEY) lines.push(line("", { text: fmt(c.differ), bold: true }, T(" of those with a different status or settings")));
  if (c.unread) lines.push(line("", { text: fmt(c.unread), bold: true }, T(` not compared (a setting could not be read for one user)`)));
  if (!c.onlyA && !c.onlyB && !c.differ && !c.unread) lines.push(line("same", T("✓ Same in both")));
  return [...lines, ...failed];
}

/** Header parts for the connected org: [{cls, text}]. Missing values are left out (never "null"). */
export function orgParts(org, host, via) {
  const [kind, cls] = org.isSandbox ? ["Sandbox", "sbx"]
    : /developer|trial/i.test(org.edition || "") ? [org.edition, "sbx"] : ["Production", "prod"];
  return [
    { tag: "strong", cls: "", text: org.name || org.id },
    { tag: "span", cls: `badge ${cls}`, text: kind },
    via ? { tag: "span", cls: "badge demo", text: via } : null,
    host ? { tag: "span", cls: "host", text: host } : null,
  ].filter((p) => p && p.text);
}

function verdict(counts, names) {
  let onlyA = 0, onlyB = 0, differ = 0;
  for (const c of Object.values(counts)) { onlyA += c.onlyA; onlyB += c.onlyB; differ += c.differ; }
  const { a, b } = names;
  if (!onlyA && !onlyB && !differ) return { text: `${a} and ${b} have the same access.`, level: "good" };
  if (!onlyA && !onlyB) return { text: `${a} and ${b} have the same access, but some of it comes to them in different ways.`, level: "good" };
  if (!onlyB) return { text: `${a} has everything ${b} has, and more.`, level: "" };
  if (!onlyA) return { text: `${b} has everything ${a} has, and more.`, level: "" };
  const total = onlyA + onlyB + differ;
  return { text: `${a} and ${b} each have access the other does not (${plural(total, "difference", "differences")} in total).`, level: "" };
}

function notesOf(a, b, names) {
  const notes = [];
  for (const [side, acc] of [["a", a], ["b", b]]) {
    for (const [k, msg] of Object.entries(acc.unavailable || {})) notes.push(`${names[side]}: ${SECTION_TITLES[k]}: ${msg}`);
    for (const w of acc.warnings || []) notes.push(`${names[side]}: ${w}`);
    const failed = customSettingsFailedNote(acc);
    if (failed) notes.push(`${names[side]}: Custom settings: ${failed}`);
  }
  return notes;
}

/** Detail text for a CSV cell: the on-screen line breaks become "; " so every cell is one line. */
function oneLine(text) {
  return String(text || "").replace(/\n/g, "; ");
}

/** Rows for CSV, comparing two users. `onlySection` limits it to one area. */
export function toRows(result, onlySection = null) {
  const { a: A, b: B } = result.names;
  const rows = [["Area", "Item", "API name", "Difference", A, B]];
  for (const k of SECTION_KEYS) {
    if (onlySection && k !== onlySection) continue;
    if (k === "customSettings") {
      const t = SECTION_TITLES[k];
      const line = (x, y) => (x || y) && rows.push([t, "Note", "", "", x, y]);
      line(customSettingsLine(result.a), customSettingsLine(result.b));
      line(customSettingsSkippedNote(result.a, result.b), "");
      line(customSettingsFailedNote(result.a), customSettingsFailedNote(result.b));
      line(customSettingsHiddenNote(result.a, result.b), "");
    }
    for (const r of result.sections[k]) {
      rows.push([SECTION_TITLES[k], r.label, r.key, statusText(r.status, A, B), r.a ? oneLine(r.detailA) || "Yes" : oneLine(r.detailA) || "No", r.b ? oneLine(r.detailB) || "Yes" : oneLine(r.detailB) || "No"]);
    }
  }
  return rows;
}

/** Rows for CSV, one user. */
export function toRowsSingle(access, onlySection = null) {
  const rows = [["User", "Username", "Area", "Item", "API name", "Details"]];
  for (const k of SECTION_KEYS) {
    if (onlySection && k !== onlySection) continue;
    if (k === "customSettings") {
      for (const note of [customSettingsLine(access), customSettingsSkippedNote(access), customSettingsFailedNote(access), customSettingsHiddenNote(access)]) {
        if (note) rows.push([access.user.name, access.user.username, SECTION_TITLES[k], "Note", "", note]);
      }
    }
    for (const r of singleRows(access, k)) rows.push([access.user.name, access.user.username, SECTION_TITLES[k], r.label, r.key, oneLine(r.detail)]);
  }
  return rows;
}
