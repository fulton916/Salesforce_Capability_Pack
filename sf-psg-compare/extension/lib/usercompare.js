// Turn one user's access into rows, and compare two users. Pure: no browser or network APIs.
//
// A user's access is the plain JSON object lib/useraccess.js reads from an org
// (schema "sf-user-access/1"). Items are matched across users by API name (key), never by Id.

import { toCsv } from "./compare.js";

export { toCsv };
export const ACCESS_SCHEMA = "sf-user-access/1";

/** The areas, in display order. `noun` is for "3 permission sets", `one` for "1 permission set". */
export const SECTIONS = [
  { key: "profile", title: "Profile", one: "profile", noun: "profiles", help: "The profile gives the user their base access and decides which user license they have." },
  { key: "role", title: "Role", one: "role", noun: "roles", help: "The role decides which records the user can see through the role hierarchy (for example, records owned by people below them)." },
  { key: "permissionSetGroups", title: "Permission set groups", one: "permission set group", noun: "permission set groups", help: "Groups of permission sets assigned to the user. If a group has a muting permission set, that set removes some access and is listed beside the group." },
  { key: "permissionSets", title: "Permission sets", one: "permission set", noun: "permission sets", help: "Permission sets the user has, assigned directly or through a group. Sets that come built into a profile are not shown." },
  { key: "permissionSetLicenses", title: "Permission set licenses", one: "license", noun: "licenses", help: "Licenses that some permission sets need before they work for this user." },
  { key: "publicGroups", title: "Public groups", one: "public group", noun: "public groups", help: "Only groups the user was added to directly. Groups they get through a role or another group are not shown." },
  { key: "queues", title: "Queues", one: "queue", noun: "queues", help: "Only queues the user was added to directly. Queues they get through a role or a group are not shown." },
  { key: "territories", title: "Territories", one: "territory", noun: "territories", help: "Sales territories the user is assigned to." },
];
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

/** Check the shape of an access object (a sample file, or what readUserAccess returned). */
export function validateAccess(obj) {
  if (!obj || typeof obj !== "object") throw new Error("Not a user access file.");
  if (obj.schema !== ACCESS_SCHEMA) throw new Error(`Unknown schema ${obj.schema}; expected ${ACCESS_SCHEMA}.`);
  if (!obj.user || !obj.user.name) throw new Error("The file has no user.");
  if (!obj.sections || typeof obj.sections !== "object") throw new Error("The file has no sections.");
  for (const k of SECTION_KEYS) {
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
export function detailText(sectionKey, item) {
  if (!item) return "";
  const parts = [];
  if (sectionKey === "permissionSets") {
    parts.push(howText(item));
    if (item.licence) parts.push(`Needs license: ${item.licence}`);
  } else if (sectionKey === "permissionSetGroups") {
    if (item.muting?.length) parts.push(`Muting permission set${item.muting.length > 1 ? "s" : ""}: ${item.muting.join(", ")}`);
    if (item.status && item.status !== "Updated") parts.push(`Not up to date (${item.status}). In Setup, open this group and wait for its status to say Updated.`);
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

/** Users whose name or username contains every typed word (demo mode searches the samples with this). */
export function matchUsers(users, text, limit = 50) {
  const words = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
  const hits = users.filter((u) => {
    const hay = `${u.name} ${u.username}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return { users: hits.slice(0, limit), more: hits.length > limit };
}

/** The names to show for A and B. Same name twice: add the username. */
export function displayNames(a, b) {
  const x = a.user.name;
  const y = b.user.name;
  if (x !== y) return { a: x, b: y };
  return { a: `${x} (${a.user.username})`, b: `${y} (${b.user.username})` };
}

export function statusText(status, nameA = "A", nameB = "B") {
  return { same: "Same", onlyA: `Only ${nameA}`, onlyB: `Only ${nameB}`, differ: "Different" }[status] || status;
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
      if (ia && !ib) status = "onlyA";
      else if (!ia && ib) status = "onlyB";
      else if (k === "permissionSets" && howText(ia) !== howText(ib)) status = "differ";
      rows.push({ key, label: (ia || ib).label || key, a: ia, b: ib, status, detailA: detailText(k, ia), detailB: detailText(k, ib) });
    }
    rows.sort((x, y) => x.label.localeCompare(y.label));
    sections[k] = rows;
    const n = (s) => rows.filter((r) => r.status === s).length;
    counts[k] = { onlyA: n("onlyA"), onlyB: n("onlyB"), same: n("same"), differ: n("differ"), total: rows.length, totalA: ma.size, totalB: mb.size };
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
  if (key === "profile" || key === "role") {
    const va = itemsOf(result.a, key)[0]?.label || "None";
    const vb = itemsOf(result.b, key)[0]?.label || "None";
    if (va === vb) return [line("same", T(`✓ Same in both: ${va === "None" ? `no ${sec.one}` : va}`))];
    const show = (v) => (v === "None" ? `no ${sec.one}` : v);
    return [line("", { text: A, side: "a" }, T(`: ${show(va)}`)), line("", { text: B, side: "b" }, T(`: ${show(vb)}`))];
  }
  if (!c.totalA && !c.totalB) return [line("same", T("Neither has any"))];
  const lines = [
    line("", { text: fmt(c.same + c.differ), bold: true }, T(` ${c.same + c.differ === 1 ? sec.one : sec.noun} both have`)),
    line("", { text: fmt(c.onlyA), bold: true }, T(" only "), { text: A, side: "a" }, T(" has")),
    line("", { text: fmt(c.onlyB), bold: true }, T(" only "), { text: B, side: "b" }, T(" has")),
  ];
  if (key === "permissionSets") lines.push(line("", { text: fmt(c.differ), bold: true }, T(" of those assigned differently (directly or through a group)")));
  if (!c.onlyA && !c.onlyB && !c.differ) lines.push(line("same", T("✓ Same in both")));
  return lines;
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
    for (const r of result.sections[k]) {
      rows.push([SECTION_TITLES[k], r.label, r.key, statusText(r.status, A, B), r.a ? oneLine(r.detailA) || "Yes" : "No", r.b ? oneLine(r.detailB) || "Yes" : "No"]);
    }
  }
  return rows;
}

/** Rows for CSV, one user. */
export function toRowsSingle(access, onlySection = null) {
  const rows = [["User", "Username", "Area", "Item", "API name", "Details"]];
  for (const k of SECTION_KEYS) {
    if (onlySection && k !== onlySection) continue;
    for (const r of singleRows(access, k)) rows.push([access.user.name, access.user.username, SECTION_TITLES[k], r.label, r.key, oneLine(r.detail)]);
  }
  return rows;
}
