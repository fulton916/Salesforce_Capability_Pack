import { searchWords, matchesWords } from "../../shared/pick.js";

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
  userPermissions: "System permissions",
  objectPermissions: "Objects",
  fieldPermissions: "Fields",
  setupAccess: "Apps and other access",
  tabs: "Tab settings",
};

export const SECTION_HELP = {
  overview: "The two groups side by side.",
  components: "The permission sets each group is built from, and anything its muting permission set removes.",
  userPermissions: "System-wide permissions such as Export Reports or View All Data.",
  objectPermissions: "What users can do with each kind of record: read, create, edit, delete, and see or change everyone's records.",
  fieldPermissions: "Whether users can see (Read) or change (Edit) each field.",
  setupAccess: "Apps, custom permissions, Visualforce pages, Apex classes and other things users are allowed to use.",
  tabs: "How each tab is set for users: shown, available but hidden by default, or hidden.",
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

export const MUTED_GROUP = "Removed by muting";
export const MUTED_LEGACY = "Removed by muting (not confirmed, older saved file)";
export const PART_SETS = "Permission sets in each group";
export const PART_SETS_HELP = "The permission sets each group is built from. A user in the group has everything these allow, minus what the muting permission set removes.";
const MUTING_SET_GROUP = "Muting permission set";
export const PART_MUTED = "Removed by muting";

const KIND_WORDS = { user: "System permission", object: "Object", field: "Field", tab: "Tab", setup: "App or other access" };
const KIND_ORDER = Object.values(KIND_WORDS);

function compareComponents(a, b, labels, fieldLabels) {
  const map = (s) => Object.fromEntries((s.components || []).map((c) => [c.name, c]));
  const ma = map(a);
  const mb = map(b);
  const sets = keysOf(ma, mb).map((k) => {
    const ca = ma[k] || null;
    const cb = mb[k] || null;
    const c = ca || cb;
    const sub = (x) => (x && x.licence ? `needs ${x.licence} license` : "");
    return {
      key: k,
      label: clean(c.label) || humanize(k),
      group: c.isMuting ? MUTING_SET_GROUP : "Permission set",
      part: "sets",
      status: presence(!!ca, !!cb),
      a: ca ? "In this group" : null,
      b: cb ? "In this group" : null,
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
    items[`muted|${kind}|${k}`] = { key: k, label, kind: KIND_WORDS[kind], what: list.length ? `${list.join(", ")} removed` : "Removed" };
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
    add("tab", k, objectName(labels, k.replace(/^standard-/, "")), []);
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

/**
 * Plain words for a group's Status. "Updated" is fine; anything else means Salesforce is still
 * recalculating the group, so what the page shows may be out of date.
 */
export function groupStatus(status) {
  if (status === "Updated") return "Up to date";
  return `Not up to date (${status || "unknown"}). In Setup, open this group and wait for its status to say Updated.`;
}

const TAB_PHRASES = { [TAB_LABELS.DefaultOn]: "shown by default", [TAB_LABELS.DefaultOff]: "available but hidden by default", [TAB_LABELS.Hidden]: "hidden" };

/** For a tab set differently in the two groups: "Different: shown by default in A, hidden in B". Otherwise null. */
export function tabDiffText(r, nameA = "A", nameB = "B") {
  if (r.status !== "differ" || !(r.a in TAB_PHRASES) || !(r.b in TAB_PHRASES)) return null;
  return `Different: ${TAB_PHRASES[r.a]} in ${nameA}, ${TAB_PHRASES[r.b]} in ${nameB}`;
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
  add("Status", groupStatus(a.psg.status), groupStatus(b.psg.status));
  add("Users assigned", assigned(a), assigned(b));
  add("Permission sets in the group", (a.components || []).filter((c) => !c.isMuting).length, (b.components || []).filter((c) => !c.isMuting).length);
  add("Muting permission set", a.muting?.label || a.muting?.name || "None", b.muting?.label || b.muting?.name || "None");
  add("System permissions turned on", has(sections.userPermissions, "a"), has(sections.userPermissions, "b"));
  add("Objects with access", has(sections.objectPermissions, "a"), has(sections.objectPermissions, "b"));
  add("Fields with access", has(sections.fieldPermissions, "a"), has(sections.fieldPermissions, "b"));
  add("Apps and other access items", has(sections.setupAccess, "a"), has(sections.setupAccess, "b"));
  add("Tabs with a setting", has(sections.tabs, "a"), has(sections.tabs, "b"));
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


// ---------- summary cards ----------

const pl = (n, one, many = one + "s") => (n === 1 ? one : many);
const hasTab = (v) => !!v && v !== TAB_LABELS.Hidden;

/**
 * Numbers for the six summary cards. "X has" counts rows where side X has the item, whether the
 * other side has it too or not; `only` is what exactly one group has; `differ` is both with
 * different settings. What's inside leaves out the muting permission set itself.
 */
export function cardCounts(result) {
  const S = result.sections;
  const side = (rows, has) => ({
    a: rows.filter((r) => r.status !== "onlyB" && has(r.a)).length,
    b: rows.filter((r) => r.status !== "onlyA" && has(r.b)).length,
    only: rows.filter((r) => r.status === "onlyA" || r.status === "onlyB").length,
    differ: rows.filter((r) => r.status === "differ").length,
  });
  const present = (v) => !!v;
  const sets = S.components.filter((r) => r.part === "sets" && r.group !== MUTING_SET_GROUP);
  const muted = S.components.filter((r) => r.part === "muted");
  return {
    userPermissions: side(S.userPermissions, present),
    objectPermissions: side(S.objectPermissions, (v) => Array.isArray(v) && v.length > 0),
    fieldPermissions: side(S.fieldPermissions, (v) => v === "Read" || v === "Edit"),
    setupAccess: side(S.setupAccess, present),
    // A Hidden tab cannot be seen, so judge by what each side can see, not by the row status.
    tabs: {
      a: S.tabs.filter((r) => hasTab(r.a)).length,
      b: S.tabs.filter((r) => hasTab(r.b)).length,
      only: S.tabs.filter((r) => hasTab(r.a) !== hasTab(r.b)).length,
      differ: S.tabs.filter((r) => hasTab(r.a) && hasTab(r.b) && r.a !== r.b).length,
    },
    components: {
      a: sets.filter((r) => r.status !== "onlyB").length,
      b: sets.filter((r) => r.status !== "onlyA").length,
      only: sets.filter((r) => r.status === "onlyA" || r.status === "onlyB").length,
      mutedOnly: muted.filter((r) => r.status === "onlyA" || r.status === "onlyB").length,
      mutedDiffer: muted.filter((r) => r.status === "differ").length,
    },
  };
}

/**
 * The number on a tab: the sum of that card's difference lines (what only one group has, plus what
 * is set up differently; for What's inside also what muting takes away). The Summary tab has none.
 */
export function tabDiffCount(result, key) {
  const c = cardCounts(result)[key];
  if (!c) return 0;
  if (key === "components") return c.only + c.mutedOnly + c.mutedDiffer;
  return c.only + (c.differ || 0);
}

/**
 * One card, in the words shown on the page: `{ totals, lines, same }`.
 * `totals` is { noun, a, b }: how many each group has, for a small muted line.
 * `lines` are only the differences, each { n, side, before, after }: the page prints
 * "{n} {before} {group name for side} {after}" (`side` is null on every line today).
 * When the groups are the same for that card `lines` is empty and `same` is true.
 */
export function cardLines(result, key) {
  const c = cardCounts(result)[key];
  const L = (n, before, side = null, after = "") => ({ n, side, before, after });
  let noun;
  let lines;
  let same;
  if (key === "userPermissions") {
    noun = "system permissions";
    lines = [L(c.only, `system ${pl(c.only, "permission")} only one group has`)];
    same = !c.only;
  } else if (key === "objectPermissions") {
    noun = "objects";
    lines = [L(c.only, `${pl(c.only, "object")} only one group can access`),
      L(c.differ, `${pl(c.differ, "object")} with different rights`)];
    same = !c.only && !c.differ;
  } else if (key === "fieldPermissions") {
    noun = "fields";
    lines = [L(c.only, `${pl(c.only, "field")} only one group can see`),
      L(c.differ, `${pl(c.differ, "field")} where one group can edit and the other can only read`)];
    same = !c.only && !c.differ;
  } else if (key === "setupAccess") {
    noun = "items";
    lines = [L(c.only, `${pl(c.only, "item")} only one group can use`)];
    same = !c.only;
  } else if (key === "tabs") {
    noun = "tabs";
    lines = [L(c.only, `${pl(c.only, "tab")} only one group can see`),
      L(c.differ, `${pl(c.differ, "tab")} set up differently (shown or hidden by default)`)];
    same = !c.only && !c.differ;
  } else {
    noun = "permission sets";
    lines = [L(c.only, `${pl(c.only, "permission set")} in only one group`),
      L(c.mutedOnly, `${pl(c.mutedOnly, "item")} removed by muting in only one group`),
      L(c.mutedDiffer, `${pl(c.mutedDiffer, "item")} removed by muting in both, but differently`)];
    same = !c.only && !c.mutedOnly && !c.mutedDiffer;
  }
  return { totals: { noun, a: c.a, b: c.b }, lines: same ? [] : lines, same };
}

// ---------- sorting ----------

const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** The text a column shows for a row, for sorting. "" means empty (shown as a dash). */
export function sortText(r, col, nameA = "A", nameB = "B") {
  const flags = (v) => v.map((f) => FLAG_LABELS[f] || f).join(", ");
  const val = (v) => (v === null || v === undefined || v === false || (Array.isArray(v) && !v.length) ? "" : v === true ? "Yes" : Array.isArray(v) ? flags(v) : String(v));
  switch (col) {
    case "item": return String(r.label ?? "");
    case "type": return String((r.kind ?? r.group) || "");
    case "a": return val(r.a);
    case "b": return val(r.b);
    case "diff": {
      if (r.status === "same") return "Same";
      if (Array.isArray(r.a) && (r.aExtra?.length || r.bExtra?.length)) {
        return [r.aExtra?.length ? `Only ${nameA}: ${flags(r.aExtra)}` : "", r.bExtra?.length ? `Only ${nameB}: ${flags(r.bExtra)}` : ""].filter(Boolean).join(" ");
      }
      if (r.status === "differ" && r.more) return `Different: ${r.more === "a" ? nameA : nameB} has more`;
      const tabText = tabDiffText(r, nameA, nameB);
      if (tabText) return tabText;
      return statusText(r.status, nameA, nameB);
    }
    default: return "";
  }
}

const FIELD_RANK = { "No access": 0, Read: 1, Edit: 2 };
const TAB_RANK = { [TAB_LABELS.Hidden]: 0, [TAB_LABELS.DefaultOff]: 1, [TAB_LABELS.DefaultOn]: 2 };

/**
 * How a group column (a or b) of these rows should sort: "tick" (yes/no), "object" (rights held),
 * "field" (No access, Read, Edit), "tab" (Hidden, Available, Shown), or null for plain text
 * (What's inside rows, and anything else).
 */
function accessKind(rows, col) {
  if (col !== "a" && col !== "b") return null;
  if (rows.some((r) => r.part)) return null;
  const vals = rows.flatMap((r) => [r.a, r.b]).filter((v) => v !== null && v !== undefined);
  if (!vals.length) return null;
  if (vals.every((v) => typeof v === "boolean")) return "tick";
  if (vals.every((v) => Array.isArray(v))) return "object";
  if (vals.every((v) => v in FIELD_RANK)) return "field";
  if (vals.every((v) => v in TAB_RANK)) return "tab";
  return null;
}

/** Amount of access in one cell: higher means more. Used for tick, object, field and tab columns. */
function accessRank(kind, v) {
  if (kind === "tick") return v === true ? 1 : 0;
  if (kind === "field") return FIELD_RANK[v] ?? 0;
  if (kind === "tab") return TAB_RANK[v] ?? 0;
  // Object rights: how many are held, then the strongest one. [count, strongest].
  const list = Array.isArray(v) ? v : [];
  const strongest = list.reduce((m, f) => Math.max(m, OBJECT_FLAGS.indexOf(f) + 1), 0);
  return list.length * 100 + strongest;
}

/**
 * Sort rows by a column, `dir` "asc" (A to Z) or "desc". Case does not matter and numbers sort by
 * value (Item 2 before Item 10). Empty values always come last. Returns a new array; ties keep their order.
 * Group columns showing access (yes/no, object rights, field access, tab setting) sort by amount of
 * access instead: "asc" puts a tick first, otherwise the least access first, and "desc" the reverse;
 * no access is a value there, not empty. Rows with the same amount are ordered by item name A to Z.
 */
export function sortRows(rows, col, dir = "asc", nameA = "A", nameB = "B") {
  if (!col) return rows;
  const sign = dir === "desc" ? -1 : 1;
  const kind = accessKind(rows, col);
  if (kind) {
    // A tick is the "most" access but A to Z shows it first, so the tick column runs the other way.
    const flip = kind === "tick" ? -1 : 1;
    const keyed = rows.map((r, i) => ({ r, i, n: accessRank(kind, r[col]), t: String(r.label ?? "") }));
    keyed.sort((x, y) => sign * flip * (x.n - y.n) || COLLATOR.compare(x.t, y.t) || x.i - y.i);
    return keyed.map((k) => k.r);
  }
  const keyed = rows.map((r, i) => ({ r, i, t: sortText(r, col, nameA, nameB) }));
  keyed.sort((x, y) => {
    if (!x.t !== !y.t) return x.t ? -1 : 1;
    return sign * COLLATOR.compare(x.t, y.t) || x.i - y.i;
  });
  return keyed.map((k) => k.r);
}

/** Like sortRows for rows grouped by `group` (Fields by object): sort inside each group; the item column also orders the groups. */
export function sortGrouped(rows, col, dir = "asc", nameA = "A", nameB = "B") {
  if (!col) return rows;
  const groups = new Map();
  for (const r of rows) {
    const g = r.group || "Other";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  let names = [...groups.keys()];
  if (col === "item") {
    const sign = dir === "desc" ? -1 : 1;
    names = names.map((n, i) => ({ n, i })).sort((x, y) => sign * COLLATOR.compare(x.n, y.n) || x.i - y.i).map((x) => x.n);
  }
  return names.flatMap((n) => sortRows(groups.get(n), col, dir, nameA, nameB));
}

/** Sort one section's rows as its list does: What's inside keeps its two parts, Fields keep their objects. */
export function sortSection(rows, section, sort, nameA = "A", nameB = "B") {
  if (!sort || !sort.col || section === "overview") return rows;
  const { col, dir } = sort;
  if (section === "components") {
    return [...sortRows(rows.filter((r) => r.part !== "muted"), col, dir, nameA, nameB), ...sortRows(rows.filter((r) => r.part === "muted"), col, dir, nameA, nameB)];
  }
  return section === "fieldPermissions" ? sortGrouped(rows, col, dir, nameA, nameB) : sortRows(rows, col, dir, nameA, nameB);
}

/**
 * The Salesforce API version a saved group was read with, as a number, or null when it is not recorded
 * (a file saved by an earlier copy, or a hand-edited value that is not a version such as "68.0" or "68").
 */
export function versionNumber(s) {
  const v = s && typeof s === "object" ? s.apiVersion : null;
  if (typeof v !== "string") return null;
  const m = /^\s*(\d{1,3})(?:\.(\d{1,2}))?\s*$/.exec(v);
  return m ? Number(`${m[1]}.${m[2] || "0"}`) : null;
}

/**
 * A plain-words note when the two groups were not read with the same API version, or null.
 * When both groups have the same label the sides are told apart by org name, else "first" / "second".
 */
function versionNote(a, b, A, B) {
  const va = versionNumber(a);
  const vb = versionNumber(b);
  const words = (n) => n.toFixed(1);
  const diffOrgs = !!(a.org?.id && b.org?.id && a.org.id !== b.org.id);
  if (A === B) {
    if (diffOrgs && orgLabel(a.org) !== orgLabel(b.org)) [A, B] = [`${A} (${orgLabel(a.org)})`, `${B} (${orgLabel(b.org)})`];
    else [A, B] = [`${A} (first group)`, `${B} (second group)`];
  }
  if (va !== null && vb !== null) {
    if (va === vb) return null;
    const [older, newer, vo, vn] = va < vb ? [A, B, va, vb] : [B, A, vb, va];
    const fix = diffOrgs
      ? `If the org of ${older} now offers a newer version, read ${older} again (and save its file again if you use a file). If that org is on an older Salesforce release, the note stays until both orgs are on the same release.`
      : `To fix this, read ${older} again from its org (and save its file again if you use a file), then compare.`;
    return `${older} was read with Salesforce API version ${words(vo)} and ${newer} with ${words(vn)}. Permissions that exist only in the newer version can look like a difference when they are not (they show as only in ${newer}). ${fix}`;
  }
  if (va === null && vb === null) {
    return "Both files were saved by an earlier copy of this tool, which did not see the newest Salesforce permissions, so some differences may be missing. To fix this, read both groups again from their orgs and save their files again, then compare.";
  }
  const [old, other] = va === null ? [A, B] : [B, A];
  return `The file for ${old} was saved by an earlier copy of this tool, which did not see the newest Salesforce permissions. Permissions that exist only in newer versions can look like a difference when they are not (they show as only in ${other}). To fix this, read ${old} again from its org and save its file again, then compare.`;
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
  if (!gives.a && !gives.b) push("verdict", "good", "Both groups have exactly the same access.");
  else if (gives.a && !gives.b) push("verdict", "info", `${A} has everything ${B} has, and ${num(gives.a)} more.`);
  else if (gives.b && !gives.a) push("verdict", "info", `${B} has everything ${A} has, and ${num(gives.b)} more.`);
  else push("verdict", "info", `${A} has ${things(gives.a)} ${B} doesn't. ${B} has ${things(gives.b)} ${A} doesn't.`);
  // Second, muted line under the verdict: what the numbers count (they do not match one card).
  out.at(-1).detail = "Counts system permissions, objects, fields, apps and other access, and tabs (not permission sets). If both groups have an item but one has more, such as Edit instead of Read, it counts for that group.";

  // System permissions first, one line each.
  for (const r of sections.userPermissions.filter((x) => x.highRisk && x.status !== "same")) {
    const side = r.status === "onlyA" ? "a" : "b";
    out.push({ kind: "risk", area: "general", level: "risk", side, text: `Only ${side === "a" ? A : B} has ${r.label}.`, short: r.label });
  }
  // Objects: at most one line per side, only for View All / Modify All.
  for (const [side, who, other] of [["a", A, B], ["b", B, A]]) {
    const hits = sections.objectPermissions.filter((r) => (side === "a" ? r.aExtra : r.bExtra).some((f) => f === "ViewAllRecords" || f === "ModifyAllRecords"));
    if (!hits.length) continue;
    // Standard objects make the clearest examples; then alphabetical.
    const ex = [...hits].sort((x, y) => /__/.test(x.key) - /__/.test(y.key) || x.label.localeCompare(y.label)).slice(0, 3).map((r) => r.label);
    const list = hits.length > ex.length ? `${ex.join(", ")} and ${num(hits.length - ex.length)} more` : ex.join(", ");
    const what = `every record on ${num(hits.length)} ${hits.length === 1 ? "object" : "objects"} (${list})`;
    out.push({ kind: "risk", area: "objects", level: "risk", side, text: `${who} can view or change ${what}, where ${other} has less. See Objects.`, short: `More access to ${what} than ${other}. See Objects.` });
  }

  const n = (k, st) => sections[k].filter((r) => r.status === st).length;
  const summary = [
    ["userPermissions", "system permission"],
    ["objectPermissions", "object"],
    ["fieldPermissions", "field"],
    ["setupAccess", "app or other access item", "apps or other access items"],
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
      push("note", "info", `${name}: the muting permission set has ${plural(n, "more item")}, but ${n === 1 ? "it removes" : "they remove"} nothing, so ${n === 1 ? "it is" : "they are"} not listed.`);
    }
  }
  const note = versionNote(a, b, A, B);
  if (note) push("note", "warn", note);
  for (const [s, name] of [[a, A], [b, B]]) {
    for (const w of s.warnings || []) push("note", "warn", `${name}: ${w}${/^Could not/.test(w) ? " These results may be incomplete. Try Compare again." : ""}`);
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
  // Regular permission sets and the muting permission set itself are counted apart.
  counts.componentSets = tally(sections.components.filter((r) => r.part === "sets" && r.group !== MUTING_SET_GROUP));
  counts.componentMutingSet = tally(sections.components.filter((r) => r.part === "sets" && r.group === MUTING_SET_GROUP));
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
 * `diffOnly` and `search` narrow the rows the same way the page does; `sort` ({ col, dir }) orders one section.
 */
export function toRows(result, onlySection = null, { diffOnly = false, search = "", sort = null } = {}) {
  const A = result.a.psg.label || result.a.psg.developerName;
  const B = result.b.psg.label || result.b.psg.developerName;
  const header = ["Section", "Group", "Item", "API name", "Difference", A, B, `Only ${A}`, `Only ${B}`, "Kind of item"];
  const rows = [header];
  const withSub = (v, sub) => (v === null ? "No" : sub ? `${cell(v)} · ${sub}` : cell(v));
  for (const [k, all] of Object.entries(result.sections)) {
    if (onlySection && k !== onlySection) continue;
    for (const r of sortSection(filterRows(all, { section: k, diffOnly, search }), k, onlySection ? sort : null, A, B)) {
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
