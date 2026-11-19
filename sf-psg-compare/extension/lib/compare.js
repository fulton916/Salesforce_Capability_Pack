// Compare two PSG snapshots. Pure functions, no browser or network access.
//
// Every row has a status:
//   same   - both sides identical
//   onlyA  - only A has it (A grants something B does not)
//   onlyB  - only B has it
//   differ - both have it, with different settings (see aExtra / bExtra)

// System permissions worth calling out. A difference in any of these is a headline.
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
// Labels above are fallbacks only; the org's own labels (from describe) are shown when present.

// Object flags, strongest last, with readable labels.
export const OBJECT_FLAGS = ["Read", "Create", "Edit", "Delete", "ViewAllFields", "ViewAllRecords", "ModifyAllRecords"];
export const FLAG_LABELS = {
  Read: "Read", Create: "Create", Edit: "Edit", Delete: "Delete",
  ViewAllFields: "View All Fields", ViewAllRecords: "View All", ModifyAllRecords: "Modify All",
};
const STRONG_OBJECT_FLAGS = new Set(["Delete", "ViewAllRecords", "ModifyAllRecords"]);
const MAX_OBJECT_HIGHLIGHTS = 8;

const TAB_LABELS = { DefaultOn: "Visible (default on)", DefaultOff: "Available (default off)", Hidden: "Hidden" };

function flagsOn(flags) {
  if (!flags) return [];
  const known = OBJECT_FLAGS.filter((f) => flags[f]);
  const extra = Object.keys(flags).filter((f) => flags[f] && !OBJECT_FLAGS.includes(f));
  return [...known, ...extra.sort()];
}

/** Compare two flag maps. Returns {status, aExtra, bExtra}. Missing or all-false counts as no access. */
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

function compareComponents(a, b) {
  const map = (s) => Object.fromEntries((s.components || []).map((c) => [c.name, c]));
  const ma = map(a);
  const mb = map(b);
  const sets = keysOf(ma, mb).map((k) => {
    const ca = ma[k] || null;
    const cb = mb[k] || null;
    const c = ca || cb;
    return {
      key: k,
      label: c.label || k,
      kind: c.isMuting ? "Muting permission set" : "Permission set",
      status: presence(!!ca, !!cb),
      a: ca ? ca.licence || "" : null,
      b: cb ? cb.licence || "" : null,
    };
  });
  // What each muting permission set takes away, matched by permission (not by muting set name).
  const mutedA = mutedItems(a);
  const mutedB = mutedItems(b);
  const muted = keysOf(mutedA, mutedB).map((k) => ({
    key: k,
    label: (mutedA[k] || mutedB[k]).label,
    kind: "Removed by muting",
    status: presence(k in mutedA, k in mutedB),
    a: k in mutedA ? mutedA[k].what : null,
    b: k in mutedB ? mutedB[k].what : null,
  }));
  return [...sets, ...muted];
}

function mutedItems(s) {
  const m = s.muting;
  const out = {};
  if (!m) return out;
  for (const [k, label] of Object.entries(m.userPermissions || {})) out[`muted|user|${k}`] = { label, what: "System permission" };
  for (const [k, flags] of Object.entries(m.objectPermissions || {})) {
    const on = flagsOn(flags);
    if (on.length) out[`muted|object|${k}`] = { label: k, what: on.map((f) => FLAG_LABELS[f] || f).join(", ") };
  }
  for (const [k, flags] of Object.entries(m.fieldPermissions || {})) {
    const on = flagsOn(flags);
    if (on.length) out[`muted|field|${k}`] = { label: k, what: on.join(", ") };
  }
  return out;
}

function compareUserPermissions(a, b) {
  const ua = a.userPermissions || {};
  const ub = b.userPermissions || {};
  return keysOf(ua, ub).map((k) => ({
    key: k,
    label: ua[k] || ub[k] || k,
    highRisk: k in HIGH_RISK,
    status: presence(k in ua, k in ub),
    a: k in ua,
    b: k in ub,
  }));
}

function compareObjects(a, b) {
  const oa = a.objectPermissions || {};
  const ob = b.objectPermissions || {};
  const rows = [];
  for (const k of keysOf(oa, ob)) {
    const { status, aExtra, bExtra } = compareFlags(oa[k], ob[k]);
    if (!flagsOn(oa[k]).length && !flagsOn(ob[k]).length) continue; // all-false rows on both sides
    rows.push({ key: k, label: k, status, a: flagsOn(oa[k]), b: flagsOn(ob[k]), aExtra, bExtra });
  }
  return rows;
}

function compareFields(a, b) {
  const fa = a.fieldPermissions || {};
  const fb = b.fieldPermissions || {};
  const rows = [];
  for (const k of keysOf(fa, fb)) {
    const { status, aExtra, bExtra } = compareFlags(fa[k], fb[k]);
    if (!flagsOn(fa[k]).length && !flagsOn(fb[k]).length) continue;
    const dot = k.indexOf(".");
    rows.push({
      key: k,
      label: k,
      object: dot > 0 ? k.slice(0, dot) : "",
      status,
      a: fieldAccess(fa[k]),
      b: fieldAccess(fb[k]),
      aExtra,
      bExtra,
    });
  }
  return rows;
}

function fieldAccess(f) {
  if (!f) return "None";
  if (f.Edit) return "Edit";
  if (f.Read) return "Read";
  return "None";
}

function compareSetup(a, b) {
  const sa = a.setupAccess || {};
  const sb = b.setupAccess || {};
  return keysOf(sa, sb).map((k) => {
    const e = sa[k] || sb[k];
    return {
      key: k,
      label: e.label ? `${e.name} (${e.label})` : e.name,
      group: e.typeLabel || e.type,
      status: presence(k in sa, k in sb),
      a: k in sa,
      b: k in sb,
    };
  }).sort((x, y) => x.group.localeCompare(y.group) || x.label.localeCompare(y.label));
}

function compareTabs(a, b) {
  const ta = a.tabSettings || {};
  const tb = b.tabSettings || {};
  return keysOf(ta, tb).map((k) => {
    const va = ta[k] || null;
    const vb = tb[k] || null;
    let status = "same";
    if (va && !vb) status = "onlyA";
    else if (vb && !va) status = "onlyB";
    else if (va !== vb) status = "differ";
    return { key: k, label: k, status, a: va ? TAB_LABELS[va] || va : null, b: vb ? TAB_LABELS[vb] || vb : null };
  });
}

function overview(a, b, sections) {
  const rows = [];
  const add = (label, va, vb) => rows.push({ key: label, label, a: va ?? "", b: vb ?? "", status: String(va ?? "") === String(vb ?? "") ? "same" : "differ" });
  add("Org", orgLabel(a.org), orgLabel(b.org));
  add("API name", a.psg.developerName, b.psg.developerName);
  add("Label", a.psg.label, b.psg.label);
  add("Description", a.psg.description, b.psg.description);
  add("Status", a.psg.status, b.psg.status);
  add("Component permission sets", (a.components || []).filter((c) => !c.isMuting).length, (b.components || []).filter((c) => !c.isMuting).length);
  add("Muting permission set", a.muting?.name || "None", b.muting?.name || "None");
  add("Assigned users (active / total)", assignLabel(a), assignLabel(b));
  const count = (s, side) => s.filter((r) => side === "a" ? r.status !== "onlyB" : r.status !== "onlyA").length;
  add("System permissions granted", count(sections.userPermissions, "a"), count(sections.userPermissions, "b"));
  add("Objects with access", count(sections.objectPermissions, "a"), count(sections.objectPermissions, "b"));
  add("Fields with access", count(sections.fieldPermissions, "a"), count(sections.fieldPermissions, "b"));
  add("Apex, pages, apps, custom perms…", count(sections.setupAccess, "a"), count(sections.setupAccess, "b"));
  add("Tab settings", count(sections.tabs, "a"), count(sections.tabs, "b"));
  add("Snapshot taken", a.takenAt, b.takenAt);
  for (const r of rows) if (r.label === "Snapshot taken") r.status = "same"; // never a real difference
  return rows;
}

function orgLabel(o) {
  if (!o) return "Unknown org";
  return `${o.name || o.id}${o.isSandbox ? " (sandbox)" : ""}`;
}

function assignLabel(s) {
  const a = s.assignments;
  return a ? `${a.active ?? "?"} / ${a.total ?? "?"}` : "";
}

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function highlights(a, b, sections) {
  const out = [];
  const A = a.psg.label || a.psg.developerName;
  const B = b.psg.label || b.psg.developerName;
  const push = (level, text) => out.push({ level, text });

  if (a.org?.id && b.org?.id && a.org.id !== b.org.id) {
    push("info", `A and B come from different orgs (${orgLabel(a.org)} vs ${orgLabel(b.org)}). Items are matched by API name.`);
  }
  for (const [side, s] of [["A", a], ["B", b]]) {
    for (const w of s.warnings || []) push("warn", `${side}: ${w}`);
  }

  const perm = ["userPermissions", "objectPermissions", "fieldPermissions", "setupAccess", "tabs"];
  const aMore = perm.some((k) => sections[k].some((r) => r.status === "onlyA" || (r.aExtra && r.aExtra.length) || (k === "tabs" && r.status === "differ")));
  const bMore = perm.some((k) => sections[k].some((r) => r.status === "onlyB" || (r.bExtra && r.bExtra.length) || (k === "tabs" && r.status === "differ")));
  if (!aMore && !bMore) push("good", "Both groups grant exactly the same access.");
  else if (aMore && !bMore) push("info", `${A} grants everything ${B} grants, and more.`);
  else if (bMore && !aMore) push("info", `${B} grants everything ${A} grants, and more.`);
  else push("info", "Each group grants something the other does not.");

  for (const r of sections.userPermissions.filter((x) => x.highRisk && x.status !== "same")) {
    push("risk", `Only ${r.status === "onlyA" ? A : B} grants ${r.label}.`);
  }
  const objRisks = [];
  for (const r of sections.objectPermissions) {
    for (const [extra, who, other] of [[r.aExtra, A, B], [r.bExtra, B, A]]) {
      const strong = extra.filter((f) => STRONG_OBJECT_FLAGS.has(f));
      if (strong.length) objRisks.push(`${who} has ${strong.map((f) => FLAG_LABELS[f]).join(", ")} on ${r.key}; ${other} does not.`);
    }
  }
  // Modify All / View All first; keep the list short, the Objects tab has the rest.
  objRisks.sort((x, y) => /Modify All|View All/.test(y) - /Modify All|View All/.test(x));
  for (const t of objRisks.slice(0, MAX_OBJECT_HIGHLIGHTS)) push("risk", t);
  if (objRisks.length > MAX_OBJECT_HIGHLIGHTS) {
    push("risk", `…and ${objRisks.length - MAX_OBJECT_HIGHLIGHTS} more Delete / View All / Modify All differences. See the Objects tab.`);
  }

  const n = (k, st) => sections[k].filter((r) => r.status === st).length;
  const summary = [
    ["userPermissions", "system permission"],
    ["objectPermissions", "object"],
    ["fieldPermissions", "field"],
    ["setupAccess", "Apex class, page, app or custom permission", "Apex classes, pages, apps or custom permissions"],
  ];
  for (const [k, one, many] of summary) {
    const oa = n(k, "onlyA");
    const ob = n(k, "onlyB");
    const d = n(k, "differ");
    const bits = [];
    if (oa) bits.push(`${plural(oa, one, many)} only in ${A}`);
    if (ob) bits.push(`${plural(ob, one, many)} only in ${B}`);
    if (d) bits.push(`${plural(d, one, many)} with different access`);
    if (bits.length) push("info", bits.join("; ") + ".");
  }
  return out;
}

export function compareSnapshots(a, b) {
  const sections = {
    components: compareComponents(a, b),
    userPermissions: compareUserPermissions(a, b),
    objectPermissions: compareObjects(a, b),
    fieldPermissions: compareFields(a, b),
    setupAccess: compareSetup(a, b),
    tabs: compareTabs(a, b),
  };
  sections.overview = overview(a, b, sections);
  const counts = Object.fromEntries(Object.entries(sections).map(([k, rows]) => [k, tally(rows)]));
  return { a, b, sections, counts, highlights: highlights(a, b, sections) };
}

export const SECTION_TITLES = {
  overview: "Overview",
  components: "Contents",
  userPermissions: "System permissions",
  objectPermissions: "Objects",
  fieldPermissions: "Fields",
  setupAccess: "Apex, pages, apps & custom perms",
  tabs: "Tabs",
};

const STATUS_TEXT = { same: "Same", onlyA: "Only A", onlyB: "Only B", differ: "Different" };

function cell(v) {
  if (v === null || v === undefined) return "";
  if (v === true) return "Yes";
  if (v === false) return "No";
  if (Array.isArray(v)) return v.map((f) => FLAG_LABELS[f] || f).join(", ");
  return String(v);
}

/** Flatten a comparison (or one section of it) into rows for CSV export. */
export function toRows(result, onlySection = null) {
  const header = ["Section", "Group", "Item", "Status", `A: ${result.a.psg.developerName}`, `B: ${result.b.psg.developerName}`, "Only in A", "Only in B"];
  const rows = [header];
  for (const [k, list] of Object.entries(result.sections)) {
    if (onlySection && k !== onlySection) continue;
    for (const r of list) {
      rows.push([
        SECTION_TITLES[k],
        r.group || r.object || r.kind || "",
        r.label,
        STATUS_TEXT[r.status],
        r.a === null ? "—" : cell(r.a),
        r.b === null ? "—" : cell(r.b),
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
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}
