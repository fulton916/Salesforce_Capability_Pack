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
const STRONG_OBJECT_FLAGS = new Set(["Delete", "ViewAllRecords", "ModifyAllRecords"]);
const MAX_OBJECT_HIGHLIGHTS = 8;

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

function compareComponents(a, b, labels, fieldLabels) {
  const map = (s) => Object.fromEntries((s.components || []).map((c) => [c.name, c]));
  const ma = map(a);
  const mb = map(b);
  const sets = keysOf(ma, mb).map((k) => {
    const ca = ma[k] || null;
    const cb = mb[k] || null;
    const c = ca || cb;
    return {
      key: k,
      label: clean(c.label) || humanize(k),
      group: c.isMuting ? "Muting permission set" : "Permission set",
      status: presence(!!ca, !!cb),
      a: ca ? ca.licence || "Included" : null,
      b: cb ? cb.licence || "Included" : null,
    };
  });
  // What each muting permission set takes away, matched by permission (not by muting set name).
  const mutedA = mutedItems(a, labels, fieldLabels);
  const mutedB = mutedItems(b, labels, fieldLabels);
  // Older snapshots do not say whether a mute removed anything, so they cannot claim it did.
  const groupName = mutedA.legacy || mutedB.legacy ? MUTED_LEGACY : MUTED_GROUP;
  const muted = keysOf(mutedA.items, mutedB.items).map((k) => {
    const m = mutedA.items[k] || mutedB.items[k];
    return {
      key: m.key,
      label: m.label,
      group: groupName,
      status: presence(k in mutedA.items, k in mutedB.items),
      a: k in mutedA.items ? mutedA.items[k].what : null,
      b: k in mutedB.items ? mutedB.items[k].what : null,
    };
  });
  return [...sets.sort(byLabel), ...muted.sort(byLabel)];
}

export const MUTED_GROUP = "Taken away by muting";
export const MUTED_LEGACY = "Muted (may not have been given)";

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
  const names = (flags) => flagsOn(flags).map((f) => FLAG_LABELS[f] || f).join(", ");
  const add = (kind, k, label, what) => { items[`muted|${kind}|${k}`] = { key: k, label, what }; };
  const src = e || m;
  for (const [k, label] of Object.entries(src.userPermissions || {})) add("user", k, clean(label), "General permission");
  for (const [k, flags] of Object.entries(src.objectPermissions || {})) {
    if (flagsOn(flags).length) add("object", k, objectName(labels, k), names(flags));
  }
  for (const [k, flags] of Object.entries(src.fieldPermissions || {})) {
    const on = flagsOn(flags);
    if (on.length) add("field", k, fieldName(labels, fieldLabels, k), on.join(", "));
  }
  for (const [k, vis] of Object.entries(src.tabSettings || {})) {
    add("tab", k, `${objectName(labels, k.replace(/^standard-/, ""))} (tab)`, e ? "Tab" : TAB_LABELS[vis] || "Tab");
  }
  for (const [k, entry] of Object.entries(e?.setupAccess || {})) add("setup", k, setupLabel(entry), entry.typeLabel || entry.type);
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
    });
  }
  return rows.sort(byLabel);
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

/** Plain-language findings. kind: verdict | risk | area | note. */
function highlights(a, b, sections) {
  const out = [];
  const A = a.psg.label || a.psg.developerName;
  const B = b.psg.label || b.psg.developerName;
  const push = (kind, level, text) => out.push({ kind, level, text });

  const perm = ["userPermissions", "objectPermissions", "fieldPermissions", "setupAccess", "tabs"];
  const aMore = perm.some((k) => sections[k].some((r) => r.status === "onlyA" || r.aExtra?.length || (k === "tabs" && r.status === "differ")));
  const bMore = perm.some((k) => sections[k].some((r) => r.status === "onlyB" || r.bExtra?.length || (k === "tabs" && r.status === "differ")));
  if (!aMore && !bMore) push("verdict", "good", "Both groups give exactly the same access.");
  else if (aMore && !bMore) push("verdict", "info", `${A} gives everything ${B} gives, and more.`);
  else if (bMore && !aMore) push("verdict", "info", `${B} gives everything ${A} gives, and more.`);
  else push("verdict", "info", "Each group gives some access the other does not.");

  for (const r of sections.userPermissions.filter((x) => x.highRisk && x.status !== "same")) {
    push("risk", "risk", `Only ${r.status === "onlyA" ? A : B} has “${r.label}”.`);
  }
  const objRisks = [];
  for (const r of sections.objectPermissions) {
    for (const [extra, who, other] of [[r.aExtra, A, B], [r.bExtra, B, A]]) {
      const strong = extra.filter((f) => STRONG_OBJECT_FLAGS.has(f));
      if (strong.length) objRisks.push(`${who} can ${strong.map((f) => FLAG_LABELS[f]).join(", ")} ${r.label} records; ${other} cannot.`);
    }
  }
  // Modify All / View All first; keep the list short, the Objects tab has the rest.
  objRisks.sort((x, y) => /Modify All|View All/.test(y) - /Modify All|View All/.test(x));
  for (const t of objRisks.slice(0, MAX_OBJECT_HIGHLIGHTS)) push("risk", "risk", t);
  if (objRisks.length > MAX_OBJECT_HIGHLIGHTS) {
    push("risk", "risk", `…and ${objRisks.length - MAX_OBJECT_HIGHLIGHTS} more object differences in Delete, View All or Modify All. See the Objects tab.`);
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
    push("note", "info", `The groups come from different orgs (${orgLabel(a.org)} and ${orgLabel(b.org)}). Items are matched by API name.`);
  }
  for (const [s, name] of [[a, A], [b, B]]) {
    const n = s.muting?.effective?.nothingToTake;
    if (n) {
      const it = n === 1 ? "it" : "them";
      push("note", "info", `${name}: ${plural(n, "other item")} in the muting permission set had nothing to take away (no permission set in the group gives ${it}, or the group's access still includes ${it}).`);
    }
  }
  for (const [s, name] of [[a, A], [b, B]]) {
    for (const w of s.warnings || []) push("note", "warn", `${name}: ${w}`);
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
  return { a, b, sections, counts, highlights: highlights(a, b, sections) };
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

/** Flatten a comparison (or one section of it) into rows for CSV export. */
export function toRows(result, onlySection = null) {
  const A = result.a.psg.label || result.a.psg.developerName;
  const B = result.b.psg.label || result.b.psg.developerName;
  const header = ["Section", "Group", "Item", "API name", "Difference", A, B, `Only ${A}`, `Only ${B}`];
  const rows = [header];
  for (const [k, list] of Object.entries(result.sections)) {
    if (onlySection && k !== onlySection) continue;
    for (const r of list) {
      rows.push([
        SECTION_TITLES[k],
        r.group || "",
        r.label,
        r.key,
        statusText(r.status, A, B),
        r.a === null ? "No" : cell(r.a),
        r.b === null ? "No" : cell(r.b),
        cell(r.aExtra || []),
        cell(r.bExtra || []),
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
