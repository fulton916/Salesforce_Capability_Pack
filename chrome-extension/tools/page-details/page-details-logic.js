// "Page details for a ticket": reading the page address and writing the text a person pastes
// into a support ticket. Pure: no browser or network APIs (Intl is fine), so the tests run in Node.
//
// Safety rules: only the path and the filterName parameter of an address are ever kept; the text
// never carries a session id, a token or anything read from the page body; scrub() is a last
// guard over the finished text.

import { cleanUrl } from "../../shared/pageurl.js";

const ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const NONE = "Not available";

export const looksLikeId = (s) => typeof s === "string" && ID_RE.test(s);

const OBJECT_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** Last checks: an object name from the address must look like an API name (it goes into a request path);
 * and an old `/one/one.app#/...` address (hash already dropped) is flagged so the page can say so. */
function finish(out, path) {
  if (out.objectApi && !OBJECT_RE.test(out.objectApi)) {
    out.kind = "other"; out.objectApi = null; out.recordId = null; out.filterName = null; out.setupPage = null; out.setupSub = null;
  }
  if (out.kind === "other" && path === "/one/one.app") out.hashAddress = true;
  return out;
}

/** What kind of page an address is. Never throws.
 * Returns {kind: "record" | "list" | "setup" | "home" | "other", objectApi, recordId, filterName, setupPage, path}. */
export function parsePageUrl(input) {
  const out = { kind: "other", objectApi: null, recordId: null, filterName: null, setupPage: null, setupSub: null, path: "", hashAddress: false };
  const cleaned = cleanUrl(input);
  if (!cleaned) return out;
  const [path, query] = cleaned.split("?");
  out.path = cleaned;
  const filter = query ? new URLSearchParams(query).get("filterName") : null;
  const seg = path.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const [a, b, c, d, e] = seg;

  if (seg.length === 0 || (seg.length === 1 && /^home/i.test(a))) { out.kind = "home"; return out; }
  if (a === "lightning") {
    if (b === "r") {
      // /lightning/r/<Object>/<Id>/view, or the older /lightning/r/<Id>/view. A 15 or 18 letter
      // object name is told apart from an Id by what follows it.
      if (looksLikeId(d)) { out.kind = "record"; out.objectApi = c; out.recordId = d; }
      else if (looksLikeId(c)) { out.kind = "record"; out.recordId = c; }
    } else if (b === "o") {
      if (c) out.objectApi = c;
      if (d === "list") { out.kind = "list"; out.filterName = filter; }
    } else if (b === "setup") {
      out.kind = "setup";
      out.setupPage = c || null;
      if (c === "ObjectManager" && d && d !== "home") {
        out.objectApi = d;
        if (e && e !== "view" && e !== "home") out.setupSub = e; // the Object Manager sub-page, e.g. FieldsAndRelationships
      }
    } else if (b === "page" && c === "home") {
      out.kind = "home";
    }
    return finish(out, path);
  }
  if (a === "setup") { out.kind = "setup"; out.setupPage = seg.slice(1).join("/") || null; }
  else if (seg.length === 1 && looksLikeId(a)) { out.kind = "record"; out.recordId = a; } // classic /<Id>
  // anything else (Experience Cloud /s/..., Visualforce, API paths) stays "other"
  return finish(out, path);
}

export const KIND_TEXT = {
  record: "Record page",
  list: "List view",
  setup: "Setup page",
  home: "Home page",
  other: "Other page",
};

/** "Object Manager" from "ObjectManager"; "ManageUsers" -> "Manage Users". */
export function setupPageName(raw) {
  if (!raw) return null;
  return String(raw).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

// Salesforce's own names for common Lightning Setup address segments (used when the tab's title cannot be read).
export const SETUP_TITLES = {
  CompanyProfileInfo: "Company Information", ManageUsers: "Users", EnhancedProfiles: "Profiles",
  PermSets: "Permission Sets", PermSetGroups: "Permission Set Groups", Roles: "Roles", PublicGroups: "Public Groups",
  Queues: "Queues", SecuritySharing: "Sharing Settings", ObjectManager: "Object Manager", Flows: "Flows",
  ApexClasses: "Apex Classes", ApexTriggers: "Apex Triggers", DeployStatus: "Deployment Status",
  CustomMetadata: "Custom Metadata Types", CustomSettings: "Custom Settings", OrgLoginHistory: "Login History",
  AsyncApexJobs: "Apex Jobs", ScheduledJobs: "Scheduled Jobs", ApexDebugLogs: "Debug Logs",
  HealthCheck: "Health Check", NamedCredential: "Named Credentials", ConnectedApplication: "Manage Connected Apps",
  ImportedPackage: "Installed Packages", ExternalStrings: "Custom Labels", StaticResources: "Static Resources",
  CustomTabs: "Tabs", SetupOneHome: "Setup Home",
  Territory2Models: "Territory Models", OrgEmailSettings: "Deliverability", SecurityEvents: "View Setup Audit Trail",
  // Not checked live (developer orgs have no Sandboxes page):
  DataManagementCreateTestInstance: "Sandboxes",
};

/** Salesforce's names for the Object Manager sub-pages (the Object line already names the object). */
export const OBJECT_MANAGER_SUBPAGES = {
  FieldsAndRelationships: "Fields & Relationships", PageLayouts: "Page Layouts", LightningPages: "Lightning Record Pages",
  ButtonsLinksActions: "Buttons, Links, and Actions", CompactLayouts: "Compact Layouts", FieldSets: "Field Sets",
  ValidationRules: "Validation Rules", RecordTypes: "Record Types", ApexTriggers: "Triggers", MySearchLayouts: "Search Layouts",
  AlohaSearchLayouts: "List View Button Layout", Limits: "Object Limits",
};

const GENERIC_TITLES = new Set(["salesforce", "lightning experience", "setup", "loading", "loading...", "loading…", "home",
  "page not found", "error", "login"]); // the last three name no page
// Error and sign-in titles that name no Setup page (matched anywhere in the title, case-insensitively).
const NO_PAGE_TITLES = ["insufficient privileges", "something went wrong", "sorry to interrupt", "verify your identity"];
const MAX_TITLE = 120;

/** A browser tab title as the Setup page name: the " | Salesforce" (Lightning) and " ~ Salesforce - <edition>" (Classic)
 * endings are removed. "" when what is left does not name a page ("Salesforce", "Loading...", empty). */
export function cleanTabTitle(title) {
  if (typeof title !== "string") return "";
  let t = title.replace(/\s+/g, " ").trim();
  t = t.replace(/\s*[|~]\s*Salesforce(?:\s+-\s+[^|~]*)?$/i, "").trim();
  const low = t.toLowerCase();
  if (!t || GENERIC_TITLES.has(low) || low.startsWith("error") || NO_PAGE_TITLES.some((x) => low.includes(x))) return "";
  return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE).trim() : t;
}

/** The cleaned title of the open tab for this page. `tabs` = chrome.tabs.query results ({url, title, lastAccessed}),
 * `host` the page's host name, `cleanedUrl` the page's cleaned address. Most recently used tab wins. "" when none fits. */
export function setupTitleFromTabs(tabs, host, cleanedUrl) {
  if (!Array.isArray(tabs) || !host || !cleanedUrl) return "";
  const want = String(host).toLowerCase();
  const match = tabs.filter((t) => {
    try { return t && new URL(t.url).hostname.toLowerCase() === want && cleanUrl(t.url) === cleanedUrl; } catch { return false; }
  }).sort((x, y) => (y.lastAccessed || 0) - (x.lastAccessed || 0));
  for (const t of match) { const c = cleanTabTitle(t.title); if (c) return c; }
  return "";
}

/** The "Setup page" line: the tab's title when given (and the page is not an Object Manager sub-page), else the built-in
 * name, else the name made from the address. `p` = parsePageUrl result. */
export function setupDisplayName(p, tabTitle) {
  if (!p || p.kind !== "setup") return null;
  if (tabTitle && !p.objectApi) return tabTitle;
  const seg = p.setupPage;
  if (seg === "ObjectManager") {
    if (!p.setupSub) return p.objectApi ? `${SETUP_TITLES.ObjectManager} > Details` : SETUP_TITLES.ObjectManager;
    return `${SETUP_TITLES.ObjectManager} > ${OBJECT_MANAGER_SUBPAGES[p.setupSub] || setupPageName(p.setupSub)}`;
  }
  return (seg && Object.hasOwn(SETUP_TITLES, seg) ? SETUP_TITLES[seg] : null) || setupPageName(seg);
}

/** Sandbox name from a host such as "acme--uat.sandbox.my.salesforce.com" -> "uat"; null when the host does not show one. */
export function sandboxNameFromHost(host) {
  const h = String(host || "").toLowerCase();
  if (!/\.sandbox\./.test(h)) return null;
  const first = h.split(".")[0];
  const i = first.lastIndexOf("--");
  return i >= 0 && first.slice(i + 2) ? first.slice(i + 2) : null;
}

/** "American English (en_US)" for a Salesforce language or locale key. Falls back to the key itself. */
export function localeLabel(key) {
  if (!key) return null;
  try {
    const tag = String(key).replace(/_/g, "-");
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(tag);
    return name && name !== tag ? `${name} (${key})` : String(key);
  } catch { return String(key); }
}

function pad(n) { return String(n).padStart(2, "0"); }

/** Local time with its zone, and UTC. `date` is a Date; `timeZone` an IANA name (the browser's when omitted). */
export function whenText(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return { local: NONE, utc: NONE };
  let local;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
    }).formatToParts(d).map((p) => [p.type, p.value]));
    local = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}${timeZone ? ` (${timeZone})` : ""}`;
  } catch { local = NONE; }
  const utc = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
  return { local, utc };
}

/** Last guard over finished text: removes anything shaped like a session id or a token parameter. */
export function scrub(text) {
  return String(text)
    .replace(/\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._-]{20,}/g, "[removed]")
    .replace(/\b(sid|token|access_token|refresh_token|id_token|session_?id|code|oauth_token)=[^\s&#]+/gi, "$1=[removed]")
    .replace(/\bBearer\s+[A-Za-z0-9._!-]{20,}/gi, "Bearer [removed]");
}

/** The person's own note: removes only strings that really look like a session or token (a `00D...!...`
 * session id, `Bearer <long token>`, sid= / access_token= / refresh_token= / id_token= / oauth_token=).
 * "code=5" and "token=abc" stay. Returns {text, removed}. */
export function scrubNote(text) {
  const src = String(text ?? "");
  const out = src
    .replace(/\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._-]{20,}/g, "[removed]")
    .replace(/\bBearer\s+[A-Za-z0-9._!-]{20,}/gi, "Bearer [removed]")
    .replace(/\b(sid|access_token|refresh_token|id_token|oauth_token)=[^\s&#]+/gi, "$1=[removed]");
  return { text: out, removed: out !== src };
}

export const NOTE_REMOVED_TEXT = "A login session id was removed from your note.";
export const HASH_HINT = "This page's address doesn't show which record you were on. Open the record again and use the button from there.";

/** "Account", or "Account Plan (Account_Plan__c)" only when the label and API name differ. */
export function objectText(pg) {
  const label = pg?.objectLabel, api = pg?.objectApi;
  if (label && api && label !== api) return `${label} (${api})`;
  return label || api || null;
}

const show = (v) => (v === null || v === undefined || String(v).trim() === "" ? NONE : String(v));

/** The ticket text. `s` = {note, when (Date), timeZone, org, user, page, browser, extensionVersion, problems: {org, user, record}}.
 * `org` and `user` may be null (that area could not be read); `problems.<area>` says why in plain words. */
export function snapshotText(s = {}) {
  const lines = [];
  const section = (title, rows, problem) => {
    lines.push("", title.toUpperCase());
    for (const [label, value] of rows) lines.push(`${label}: ${show(value)}`);
    if (problem) lines.push(problem);
  };
  const p = s.problems || {};

  const note = scrubNote(String(s.note || "").trim()).text;

  const w = whenText(s.when || new Date(), s.timeZone);
  section("When", [["Local time", w.local], ["UTC", w.utc]]);

  const o = s.org;
  if (o) {
    const rows = [["Org name", o.name], ["Org Id", o.id], ["Type", o.kind]];
    if (o.kind === "Sandbox") rows.push(["Sandbox name", o.sandboxName]);
    rows.push(["Instance", o.instance], ["My Domain host", o.host || s.host]);
    section("Org", rows);
  } else {
    section("Org", s.host ? [["My Domain host", s.host]] : [], `The org details could not be read. ${p.org || ""}`.trim());
  }

  const u = s.user;
  if (u) {
    section("You", [
      ["Name", u.name], ["Username", u.username], ["User Id", u.id], ["Profile", u.profile], ["Role", u.role || "No role"],
      ["Language", u.language], ["Locale", u.locale], ["Time zone", u.timeZone], ["User type", u.userType],
    ], p.user);
  } else {
    section("You", [], `Your user details could not be read. ${p.user || ""}`.trim());
  }

  const pg = s.page || {};
  const rows = [["Kind", KIND_TEXT[pg.kind] || KIND_TEXT.other], ["Address", pg.url || NONE]];
  if (pg.kind === "setup") rows.push(["Setup page", pg.setupPage]);
  if (pg.objectApi || pg.objectLabel) rows.push(["Object", objectText(pg)]);
  if (pg.kind === "list") rows.push(["List view", pg.listView || pg.filterName]);
  if (pg.kind === "record") {
    rows.push(["Record Id", pg.recordId], ["Record name", pg.recordName], ["Record type", pg.recordType],
      ["Owner", pg.owner], ["Last modified by", pg.modifiedBy], ["Last modified", pg.modifiedAt]);
  }
  section("Page", rows, [pg.hashAddress ? HASH_HINT : "", p.record || ""].filter(Boolean).join("\n"));

  section("Browser and extension", [["Browser", s.browser], ["Extension version", s.extensionVersion]]);
  lines.push("");
  const rest = scrub(lines.join("\n"));
  // The person's own note is only cleaned of session-like strings (scrubNote), never run through scrub().
  return note ? `WHAT HAPPENED\n${note}\n${rest}` : rest.replace(/^\n/, "");
}

/** Safe file name, dated: "page-details-2026-11-19-1403.txt". */
export function fileName(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return `page-details-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
}
