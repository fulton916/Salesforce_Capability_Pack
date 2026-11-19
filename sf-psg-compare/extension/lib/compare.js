import { searchWords, matchesWords } from "./pick.js";

// Compare two PSG snapshots. Pure functions, no browser or network access.
//
// Every row has a status:
//   same   - both sides identical
//   onlyA  - only A has it (A grants something B does not)
//   onlyB  - only B has it
//   differ - both have it, with different settings (see aExtra / bExtra)
//
// Every row has `label` (plain words for people) and `key` (the API name).

// System permissions worth calling out. A difference in any of these is a headline.
// Labels here are fallbacks only; the org's own labels (from describe) are shown when present.
export const HIGH_RISK = {
  PermissionsModifyAllData: "Modify All Data",
  PermissionsViewAllData: "View All Data",
  PermissionsManageUsers: "Manage Users",
  PermissionsManageInternalUsers: "Manage Internal Users",
  PermissionsResetPasswords: "Reset User Passwords and Unlock Users",
  PermissionsAssignPermissionSets: "Assign Permission Sets",
  PermissionsManageProfilesPermissionsets: "Manage Profiles and Permission Sets",
  PermissionsCustomizeApplication: "Customize Application",
  PermissionsAuthorApex: "Author Apex",
  PermissionsModifyMetadata: "Modify Metadata Through Metadata API Functions",
  PermissionsManageSharing: "Manage Sharing",
  PermissionsManageRoles: "Manage Roles",
  PermissionsViewSetup: "View Setup and Configuration",
  PermissionsApiEnabled: "API Enabled",
  PermissionsExportReport: "Export Reports",
  PermissionsManageDataIntegrations: "Manage Data Integrations",
  PermissionsBulkApiHardDelete: "Bulk API Hard Delete",
  PermissionsTransferAnyEntity: "Transfer Record",
  PermissionsViewAllUsers: "View All Users",
  PermissionsManageEncryptionKeys: "Manage Encryption Keys",
  PermissionsViewEncryptedData: "View Encrypted Data",
  PermissionsManageAuthProviders: "Manage Auth. Providers",
  PermissionsManageIpAddresses: "Manage IP Addresses",
  PermissionsManageLoginAccessPolicies: "Manage Login Access Policies",
  PermissionsManagePasswordPolicies: "Manage Password Policies",
  PermissionsManageSessionPermissionSets: "Manage Session Permission Set Activations",
  PermissionsViewEventLogFiles: "View Event Log Files",
  PermissionsInstallPackaging: "Download AppExchange Packages",
  PermissionsDataExport: "Weekly Data Export",
  PermissionsManageCustomPermissions: "Manage Custom Permissions",
  PermissionsManageTranslation: "Manage Translation",
  PermissionsEditReadonlyFields: "Edit Read Only Fields",
  PermissionsFreezeUsers: "Freeze Users",
};

// Object flags, weakest first, with readable labels.
export const OBJECT_FLAGS = ["Read", "Create", "Edit", "Delete", "ViewAllFields", "ViewAllRecords", "ModifyAllRecords"];
export const FLAG_LABELS = {
  Read: "Read", Create: "Create", Edit: "Edit", Delete: "Delete",
  ViewAllFields: "View All Fields", ViewAllRecords: "View All", ModifyAllRecords: "Modify All",
};

const TAB_LABELS = { DefaultOn: "Shown", DefaultOff: "Available (hidden by default)", Hidden: "Hidden" };

export const SECTION_TITLES = {
  overview: "Summary",
  components: "What's inside",
  userPermissions: "General permissions",
  objectPermissions: "Objects",
  fieldPermissions: "Fields",
  setupAccess: "Apps, pages & code",
  tabs: "Tabs",
};

export const SECTION_HELP = {
  overview: "The two groups side by side.",
  components: "The permission sets each group is built from, and anything its muting permission set takes away.",
  userPermissions: "System-wide permissions such as Export Reports or View All Data.",
  objectPermissions: "What users can do with each kind of record: read, create, edit, delete, and see or change everyone's records.",
  fieldPermissions: "Whether users can see (Read) or change (Edit) each field.",
  setupAccess: "Apps, Visualforce pages, Apex classes, custom permissions and other items users are allowed to use.",
  tabs: "Which tabs users see in the app navigation.",
};

/** A 15 or 18 character Salesforce Id (letters and digits, at least one digit). */
export function looksLikeId(v) {
  return /^(?=.*\d)[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(String(v || ""));
}

/** Trim a label from the org and collapse inner whitespace. */
export function clean(v) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v;
}

/** Turn an API name into words: "Account_to_Account_Relation__c" -> "Account to Account Relation". */
export function humanize(api) {
  const raw = String(api || "");
  if (looksLikeId(raw)) return raw; // never split an Id into word pieces
  return raw
    .replace(/^[A-Za-z0-9]+__(?!(c|r|mdt|e|x|b|kav|ka|share|history|feed)$)(?=.)/i, "") // namespace prefix
    .replace(/__(c|r|mdt|e|x|b|kav|ka|share|history|feed)$/i, "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function objectName(labels, api) {
  return clean(labels && labels[api]) || humanize(api);
}

/** The field's label from the snapshot, or words made from its API name. */
function fieldLabel(fieldLabels, key) {
  const dot = key.indexOf(".");
  return clean(fieldLabels && fieldLabels[key]) || humanize(dot < 0 ? key : key.slice(dot + 1));
}

function flagsOn(flags) {
  if (!flags) return [];
  const known = OBJECT_FLAGS.filter((f) => flags[f]);
  const extra = Object.keys(flags).filter((f) => flags[f] && !OBJECT_FLAGS.includes(f));
  return [...known, ...extra.sort()];
}

/** Compare two flag maps. Missing or all-false counts as no access. */
function compareFlags(a, b) {
  const aOn = new Set(flagsOn(a));
  const bOn = new Set(flagsOn(b));
  const aExtra = [...aOn].filter((f) => !bOn.has(f));
  const bExtra = [...bOn].filter((f) => !aOn.has(f));
  let status = "same";
  if (aOn.size && !bOn.size) status = "onlyA";
  else if (bOn.size && !aOn.size) status = "onlyB";
  else if (aExtra.length || bExtra.length) status = "differ";
  return { status, aExtra, bExtra };
}

function keysOf(...objs) {
  return [...new Set(objs.flatMap((o) => Object.keys(o || {})))].sort((x, y) => x.localeCompare(y));
}

function presence(inA, inB) {
  if (inA && inB) return "same";
  return inA ? "onlyA" : "onlyB";
}

function tally(rows) {
  const t = { same: 0, onlyA: 0, onlyB: 0, differ: 0, total: rows.length };
  for (const r of rows) t[r.status]++;
  return t;
}

const byLabel = (x, y) => (x.group || "").localeCompare(y.group || "") || x.label.localeCompare(y.label);

export const MUTED_GROUP = "Taken away by muting";
export const MUTED_LEGACY = "Muted (may not have been given)";
export const PART_SETS = "Permission sets in each group";
export const PART_MUTED = "Taken away by the muting permission set";

const KIND_WORDS = { user: "General permission", object: "Object", field: "Field", tab: "Tab", setup: "App, page or code" };
const KIND_ORDER = Object.values(KIND_WORDS);

function compareComponents(a, b, labels, fieldLabels) {
  const map = (s) => Object.fromEntries((s.components || []).map((c) => [c.name, c]));
  const ma = map(a);
  const mb = map(b);
  const sets = keysOf(ma, mb).map((k) => {
    const ca = ma[k] || null;
    const cb = mb[k] || null;
    const c = ca || cb;
    const sub = (x) => (x && x.licence ? `${x.licence} licence` : "");
    return {
      key: k,
      label: clean(c.label) || humanize(k),
      group: c.isMuting ? "Muting permission set" : "Permission set",
      part: "sets",
      status: presence(!!ca, !!cb),
      a: ca ? "Included" : null,
      b: cb ? "Included" : null,
      aSub: sub(ca),
      bSub: sub(cb),
    };
  });
  // What each muting permission set takes away, matched by permission (not by muting set name).
  const mutedA = mutedItems(a, labels, fieldLabels);
  const mutedB = mutedItems(b, labels, fieldLabels);
  const muted = keysOf(mutedA.items, mutedB.items).map((k) => {
    const x = mutedA.items[k];
    const y = mutedB.items[k];
    const m = x || y;
    let status = presence(!!x, !!y);
    if (x && y && x.what !== y.what) status = "differ"; // same item, different things removed
    return {
      key: m.key,
      label: m.label,
      group: m.kind,
      kind: m.kind,
      part: "muted",
      // Older (v1) snapshots cannot say the item was really given, so only their side says "may not have been given".
      legacy: (!!x && mutedA.legacy) || (!!y && mutedB.legacy),
      status,
      a: x ? x.what : null,
      b: y ? y.what : null,
    };
  });
  const kindRank = (r) => KIND_ORDER.indexOf(r.kind);
  muted.sort((p, q) => kindRank(p) - kindRank(q) || p.label.localeCompare(q.label));
  return [...sets.sort(byLabel), ...muted];
}

/**
 * Items of a snapshot's muting permission set, as { items, legacy }.
 * With `muting.effective` (snapshot v2) only what muting really removes is listed.
 * Without it (v1) every muted item is listed and `legacy` is true.
 */
function mutedItems(s, labels, fieldLabels) {
  const m = s.muting;
  const items = {};
  if (!m) return { items, legacy: false };
  const e = m.effective;
  const names = (flags) => flagsOn(flags).map((f) => FLAG_LABELS[f] || f);
  const add = (kind, k, label, list) => {
    items[`muted|${kind}|${k}`] = { key: k, label, kind: KIND_WORDS[kind], what: list.length ? `Removed: ${list.join(", ")}` : "Removed" };
  };
  const src = e || m;
  for (const [k, label] of Object.entries(src.userPermissions || {})) add("user", k, clean(label), []);
  for (const [k, flags] of Object.entries(src.objectPermissions || {})) {
    if (flagsOn(flags).length) add("object", k, objectName(labels, k), names(flags));
  }
  for (const [k, flags] of Object.entries(src.fieldPermissions || {})) {
    const on = names(flags);
    if (on.length) add("field", k, fieldName(labels, fieldLabels, k), on);
  }
  for (const [k, vis] of Object.entries(src.tabSettings || {})) {
    add("tab", k, `${objectName(labels, k.replace(/^standard-/, ""))} (tab)`, []);
  }
  for (const [k, entry] of Object.entries(e?.setupAccess || {})) add("setup", k, setupLabel(entry), []);
  return { items, legacy: !e };
}

function fieldName(labels, fieldLabels, key) {
  const dot = key.indexOf(".");
  if (dot < 0) return humanize(key);
  return `${objectName(labels, key.slice(0, dot))} › ${fieldLabel(fieldLabels, key)}`;
}

function compareUserPermissions(a, b) {
  const ua = a.userPermissions || {};
  const ub = b.userPermissions || {};
  return keysOf(ua, ub).map((k) => ({
    key: k,
    label: clean(ua[k] || ub[k]) || HIGH_RISK[k] || humanize(k.replace(/^Permissions/, "")),
    highRisk: k in HIGH_RISK,
    status: presence(k in ua, k in ub),
    a: k in ua,
    b: k in ub,
  })).sort((x, y) => y.highRisk - x.highRisk || x.label.localeCompare(y.label));
}

function compareObjects(a, b, labels) {
  const oa = a.objectPermissions || {};
  const ob = b.objectPermissions || {};
  const rows = [];
  for (const k of keysOf(oa, ob)) {
    if (!flagsOn(oa[k]).length && !flagsOn(ob[k]).length) continue; // all-false rows on both sides
    const { status, aExtra, bExtra } = compareFlags(oa[k], ob[k]);
    rows.push({ key: k, label: objectName(labels, k), status, a: flagsOn(oa[k]), b: flagsOn(ob[k]), aExtra, bExtra });
  }
  return rows.sort(byLabel);
}

function fieldAccess(f) {
  if (!f) return "No access";
  if (f.Edit) return "Edit";
  if (f.Read) return "Read";
  return "No access";
}

function compareFields(a, b, labels, fieldLabels) {
  const fa = a.fieldPermissions || {};
  const fb = b.fieldPermissions || {};
  const rows = [];
  for (const k of keysOf(fa, fb)) {
    if (!flagsOn(fa[k]).length && !flagsOn(fb[k]).length) continue;
    const { status, aExtra, bExtra } = compareFlags(fa[k], fb[k]);
    const dot = k.indexOf(".");
    const obj = dot > 0 ? k.slice(0, dot) : "";
    rows.push({
      key: k,
      label: fieldLabel(fieldLabels, k),
      group: objectName(labels, obj),
      status,
      a: fieldAccess(fa[k]),
      b: fieldAccess(fb[k]),
      aExtra,
      bExtra,
      more: status === "differ" ? moreSide(fa[k], fb[k]) : null,
    });
  }
  return rows.sort(byLabel);
}

const ACCESS_RANK = { "No access": 0, Read: 1, Edit: 2 };
/** Which side has more access to a field: "a", "b", or null when equal. */
function moreSide(fa, fb) {
  const d = ACCESS_RANK[fieldAccess(fa)] - ACCESS_RANK[fieldAccess(fb)];
  return d > 0 ? "a" : d < 0 ? "b" : null;
}

/** Label of a setup item: its own label, a plain note when only the Id is known, or words from its name. */
function setupLabel(e) {
  if (e.byId || looksLikeId(e.name)) return `Name not available (Id ${e.name})`;
  return clean(e.label) || humanize(e.name);
}

function compareSetup(a, b) {
  const sa = a.setupAccess || {};
  const sb = b.setupAccess || {};
  return keysOf(sa, sb).map((k) => {
    const e = sa[k] || sb[k];
    return {
      key: e.name,
      label: setupLabel(e),
      group: e.typeLabel || e.type,
      status: presence(k in sa, k in sb),
      a: k in sa,
      b: k in sb,
    };
  }).sort(byLabel);
}

function compareTabs(a, b, labels) {
  const ta = a.tabSettings || {};
  const tb = b.tabSettings || {};
  return keysOf(ta, tb).map((k) => {
    const va = ta[k] || null;
    const vb = tb[k] || null;
    let status = "same";
    if (va && !vb) status = "onlyA";
    else if (vb && !va) status = "onlyB";
    else if (va !== vb) status = "differ";
    return {
      key: k,
      label: objectName(labels, k.replace(/^standard-/, "")),
      status,
      a: va ? TAB_LABELS[va] || va : null,
      b: vb ? TAB_LABELS[vb] || vb : null,
    };
  }).sort(byLabel);
}

function orgLabel(o) {
  if (!o) return "Unknown org";
  return `${o.name || o.id}${o.isSandbox ? " (sandbox)" : ""}`;
}

function overview(a, b, sections) {
  const rows = [];
  const add = (label, va, vb, key = label) =>
    rows.push({ key, label, a: va ?? "", b: vb ?? "", status: String(va ?? "") === String(vb ?? "") ? "same" : "differ" });
  const has = (list, side) => list.filter((r) => (side === "a" ? r.status !== "onlyB" : r.status !== "onlyA")).length;
  const assigned = (s) => (s.assignments ? `${s.assignments.active ?? "?"} active (${s.assignments.total ?? "?"} in total)` : "");
  add("Org", orgLabel(a.org), orgLabel(b.org));
  add("Name", a.psg.label, b.psg.label);
  add("API name", a.psg.developerName, b.psg.developerName);
  add("Description", a.psg.description, b.psg.description);
  add("Status", a.psg.status, b.psg.status);
  add("Users assigned", assigned(a), assigned(b));
  add("Permission sets inside", (a.components || []).filter((c) => !c.isMuting).length, (b.components || []).filter((c) => !c.isMuting).length);
  add("Muting permission set", a.muting?.label || a.muting?.name || "None", b.muting?.label || b.muting?.name || "None");
  add("General permissions", has(sections.userPermissions, "a"), has(sections.userPermissions, "b"));
  add("Objects", has(sections.objectPermissions, "a"), has(sections.objectPermissions, "b"));
  add("Fields", has(sections.fieldPermissions, "a"), has(sections.fieldPermissions, "b"));
  add("Apps, pages & code", has(sections.setupAccess, "a"), has(sections.setupAccess, "b"));
  add("Tabs", has(sections.tabs, "a"), has(sections.tabs, "b"));
  return rows;
}

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/**
 * How many things each group gives that the other does not, as { a, b }.
 * Counts rows in permissions, objects, fields, apps/pages/code and tabs. A row counts once for a
 * side when only that side has it, or when that side has more of it (for example Edit where the
 * other has Read). A tab shown differently counts for both sides.
 */
export function givesCounts(sections) {
  const t = { a: 0, b: 0 };
  for (const k of ["userPermissions", "objectPermissions", "fieldPermissions", "setupAccess", "tabs"]) {
    for (const r of sections[k]) {
      if (r.status === "same") continue;
      const tabDiffers = k === "tabs" && r.status === "differ";
      if (r.status === "onlyA" || r.aExtra?.length || tabDiffers) t.a++;
      if (r.status === "onlyB" || r.bExtra?.length || tabDiffers) t.b++;
    }
  }
  return t;
}

/** Plain-language findings. kind: verdict | risk | area | note. */
function highlights(a, b, sections) {
  const out = [];
  const A = a.psg.label || a.psg.developerName;
  const B = b.psg.label || b.psg.developerName;
  const push = (kind, level, text) => out.push({ kind, level, text });

  const gives = givesCounts(sections);
  const num = (n) => n.toLocaleString("en-US");
  const things = (n) => `${num(n)} ${n === 1 ? "thing" : "things"}`;
  if (!gives.a && !gives.b) push("verdict", "good", "Both groups give exactly the same access.");
  else if (gives.a && !gives.b) push("verdict", "info", `${A} gives everything ${B} gives, and more (${things(gives.a)} that ${B} does not).`);
  else if (gives.b && !gives.a) push("verdict", "info", `${B} gives everything ${A} gives, and more (${things(gives.b)} that ${A} does not).`);
  else push("verdict", "info", `Each group gives access the other does not: ${A} gives ${things(gives.a)} ${B} doesn't; ${B} gives ${things(gives.b)} ${A} doesn't.`);

  // General permissions first, one line each.
  for (const r of sections.userPermissions.filter((x) => x.highRisk && x.status !== "same")) {
    out.push({ kind: "risk", area: "general", level: "risk", text: `Only ${r.status === "onlyA" ? A : B} has “${r.label}”.` });
  }
  // Objects: at most one line per side, only for View All / Modify All.
  for (const [side, who, other] of [["a", A, B], ["b", B, A]]) {
    const hits = sections.objectPermissions.filter((r) => (side === "a" ? r.aExtra : r.bExtra).some((f) => f === "ViewAllRecords" || f === "ModifyAllRecords"));
    if (!hits.length) continue;
    // Standard objects make the clearest examples; then alphabetical.
    const ex = [...hits].sort((x, y) => /__/.test(x.key) - /__/.test(y.key) || x.label.localeCompare(y.label)).slice(0, 3).map((r) => r.label);
    const list = ex.length > 1 ? `${ex.slice(0, -1).join(", ")} and ${ex.at(-1)}` : ex[0];
    const text = hits.length === 1
      ? `${who} can View All or Modify All records of the object ${list}; ${other} cannot. See Objects.`
      : `${who} can View All or Modify All records of ${num(hits.length)} objects that ${other} cannot${hits.length > ex.length ? ", including" : ":"} ${list}. See Objects.`;
    out.push({ kind: "risk", area: "objects", level: "risk", text });
  }

  const n = (k, st) => sections[k].filter((r) => r.status === st).length;
  const summary = [
    ["userPermissions", "general permission"],
    ["objectPermissions", "object"],
    ["fieldPermissions", "field"],
    ["setupAccess", "app, page or code item", "apps, pages or code items"],
  ];
  for (const [k, one, many] of summary) {
    const bits = [];
    if (n(k, "onlyA")) bits.push(`${plural(n(k, "onlyA"), one, many)} only in ${A}`);
    if (n(k, "onlyB")) bits.push(`${plural(n(k, "onlyB"), one, many)} only in ${B}`);
    if (n(k, "differ")) bits.push(`${plural(n(k, "differ"), one, many)} with different access`);
    if (bits.length) push("area", "info", bits.join("; ") + ".");
  }

  if (a.org?.id && b.org?.id && a.org.id !== b.org.id) {
    push("note", "info", `The groups come from different orgs (${orgLabel(a.org)} and ${orgLabel(b.org)}). Items are matched by their API names, so a renamed item shows up as two separate items. No action needed.`);
  }
  for (const [s, name] of [[a, A], [b, B]]) {
    const n = s.muting?.effective?.nothingToTake;
    if (n) {
      push("note", "info", `${name}: ${plural(n, "other item")} in the muting permission set had nothing to take away, so ${n === 1 ? "it is" : "they are"} not listed. No action needed.`);
    }
  }
  for (const [s, name] of [[a, A], [b, B]]) {
    for (const w of s.warnings || []) push("note", "warn", `${name}: ${w}${/^Could not/.test(w) ? " That part of the result may be incomplete. Try Compare again; if it keeps happening, check that your user can see permission sets in Setup." : ""}`);
  }
  return out;
}

export function compareSnapshots(a, b) {
  const labels = { ...(b.objectLabels || {}), ...(a.objectLabels || {}) };
  const fieldLabels = { ...(b.fieldLabels || {}), ...(a.fieldLabels || {}) };
  const sections = {
    components: compareComponents(a, b, labels, fieldLabels),
    userPermissions: compareUserPermissions(a, b),
    objectPermissions: compareObjects(a, b, labels),
    fieldPermissions: compareFields(a, b, labels, fieldLabels),
    setupAccess: compareSetup(a, b),
    tabs: compareTabs(a, b, labels),
  };
  sections.overview = overview(a, b, sections);
  const counts = Object.fromEntries(Object.entries(sections).map(([k, rows]) => [k, tally(rows)]));
  counts.componentSets = tally(sections.components.filter((r) => r.part === "sets"));
  counts.componentMuted = tally(sections.components.filter((r) => r.part === "muted"));
  const mutedLegacy = { a: !!a.muting && !a.muting.effective, b: !!b.muting && !b.muting.effective };
  return { a, b, sections, counts, gives: givesCounts(sections), mutedLegacy, highlights: highlights(a, b, sections) };
}

export function statusText(status, nameA = "A", nameB = "B") {
  return { same: "Same", onlyA: `Only ${nameA}`, onlyB: `Only ${nameB}`, differ: "Different" }[status];
}

function cell(v) {
  if (v === null || v === undefined) return "";
  if (v === true) return "Yes";
  if (v === false) return "No";
  if (Array.isArray(v)) return v.map((f) => FLAG_LABELS[f] || f).join(", ");
  return String(v);
}

/**
 * Rows of one section as shown on screen: optionally only differences, and only those matching
 * every word of `search` (punctuation such as "›" counts as a separator). The Summary list always
 * keeps its rows when differences-only is on.
 */
export function filterRows(rows, { section = "", diffOnly = false, search = "" } = {}) {
  const words = searchWords(search);
  return rows.filter((r) => {
    if (diffOnly && section !== "overview" && r.status === "same") return false;
    if (!words.length) return true;
    return matchesWords([r.key, r.label, r.group].filter(Boolean).join(" "), words);
  });
}

/**
 * Flatten a comparison (or one section of it) into rows for CSV export.
 * `diffOnly` and `search` narrow the rows the same way the page does.
 */
export function toRows(result, onlySection = null, { diffOnly = false, search = "" } = {}) {
  const A = result.a.psg.label || result.a.psg.developerName;
  const B = result.b.psg.label || result.b.psg.developerName;
  const header = ["Section", "Group", "Item", "API name", "Difference", A, B, `Only ${A}`, `Only ${B}`, "Kind of item"];
  const rows = [header];
  const withSub = (v, sub) => (v === null ? "No" : sub ? `${cell(v)} · ${sub}` : cell(v));
  for (const [k, all] of Object.entries(result.sections)) {
    if (onlySection && k !== onlySection) continue;
    for (const r of filterRows(all, { section: k, diffOnly, search })) {
      const muted = r.part === "muted";
      rows.push([
        SECTION_TITLES[k],
        muted ? (r.legacy ? MUTED_LEGACY : MUTED_GROUP) : r.group || "",
        r.label,
        r.key,
        r.status === "differ" && r.more ? `Different (more in ${r.more === "a" ? A : B})` : statusText(r.status, A, B),
        withSub(r.a, r.aSub),
        withSub(r.b, r.bSub),
        cell(r.aExtra || []),
        cell(r.bExtra || []),
        r.kind || "",
      ]);
    }
  }
  return rows;
}

/** RFC 4180 CSV with a BOM so Excel opens UTF-8 correctly. */
export function toCsv(rows) {
  const esc = (v) => {
    let s = String(v ?? "");
    // Org text opened in Excel: a leading = + - @ tab or CR would run as a formula.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}
