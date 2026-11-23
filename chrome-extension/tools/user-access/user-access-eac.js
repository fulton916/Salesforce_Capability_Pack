// Einstein Activity Capture (EAC) for the User access page. Pure: no browser or network APIs.
//
// Two objects are read (user-access-eac-read.js):
//   UserEmailCalendarSync        who is assigned to which EAC configuration (AssignedId is a user, or a profile)
//   ActivityUsrConnectionStatus  one row per connected user and configuration, with ConnectivityStatus
// Facts that shape this file (seen in real sandboxes):
//   * COUNT() on either object returns 0 even when rows exist, so every count here is computed from rows.
//   * Neither object can be filtered with a WHERE (a real org answers with a generic server error): the reader
//     reads every row and everything is filtered in memory.
//   * ConnectivityStatus is often blank. Blank means "no status yet", and counts as NOT connected.
//   * ActivityUsrConnectionStatus.UserName is the person's display name (spaces, no @), not a username.
//   * A user can be assigned with no status row at all: "Assigned, not connected yet".
// Only ACTIVE counts as connected. Everything else (including blank) is "not connected".

import { toCsv } from "../../shared/csv.js";

export { toCsv };

export const EAC_KEY = "eac";
export const EAC_TITLE = "Email and calendar (Einstein Activity Capture)";
export const EAC_ONE = "email and calendar setup";
export const EAC_NOUN = "email and calendar setups";
export const EAC_HELP = "Which Einstein Activity Capture configuration the user is on, and whether their email and calendar are connected. Only users whose status is Connected count as connected; a blank status means the user has not connected yet. Configurations are matched by name.";
export const EAC_OFF_TEXT = "Einstein Activity Capture is not turned on in this org, or you can't see it.";

export const EMPTY_CONFIG_NOTE = "Configurations with no users are not shown: Salesforce does not let the extension read the list of configurations. Setup > Einstein Activity Capture > Configurations lists them all, with their Id.";
export const NO_EAC_USER_TEXT = "Not in any Einstein Activity Capture configuration.";
export const NO_STATUS_TEXT = "Not connected yet (no status)";
export const ASSIGNED_ONLY_TEXT = "Assigned, not connected yet";
export const UNNAMED_CONFIG = "Configuration (name not available)";
/** A configuration whose name could not be found. The Id lets the admin match it on Setup's Configurations tab. */
export const unnamedConfig = (id) => (id ? `Unnamed configuration (Id ${id})` : UNNAMED_CONFIG);
export const NO_CONFIG_TITLE = "Has Einstein Activity Capture access but is in no configuration";
export const NOTHING_SYNCED_TEXT = "Connected, nothing synced yet";
export const INACTIVE_TEXT = "Inactive user, still assigned";

/** Plain words for every ConnectivityStatus value. */
export const STATUS_WORDS = {
  ACTIVE: "Connected",
  PENDING: "Waiting to connect",
  INITIALIZING: "Starting up",
  PROCESSING: "Processing",
  NEEDSATTENTION: "Needs attention",
  IDLE_STREAMING: "Idle (not syncing right now)",
  DISABLED: "Turned off",
  NEEDSATTENTIONGLOBAL: "Needs attention (org-wide)",
  NEEDSATTENTIONHYBRID: "Needs attention (hybrid connection)",
};

const GLOBAL_TERMS_WORDS = { PENDING: "Waiting for an answer", DECLINED: "Declined", ACCEPTED: "Accepted" };

const id15 = (v) => (v ? String(v).slice(0, 15) : "");
const sentence = (v) => {
  const t = String(v).toLowerCase().replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};

/** A status in plain words. `hasRow` false (assigned, no status row) and a blank status read differently. */
export function statusWords(status, hasRow = true) {
  if (!hasRow) return ASSIGNED_ONLY_TEXT;
  if (status === null || status === undefined || status === "") return NO_STATUS_TEXT;
  return STATUS_WORDS[status] || sentence(status);
}

/** Only ACTIVE is connected. Blank and every other value is not. */
export const isConnected = (status) => status === "ACTIVE";

export function yesNo(v) {
  return v === true ? "Yes" : v === false ? "No" : typeof v === "number" ? String(v) : "Not known";
}

const boolOrNull = (v) => (v === true || v === false ? v : null);
/** ContactsSynced / EventsSynced: a yes/no, or a count if an org returns one. */
const syncOrNull = (v) => (v === true || v === false || (typeof v === "number" && Number.isFinite(v)) ? v : null);
/** True only when the value is KNOWN and is false or 0. Blank (null/undefined) means unknown, so it is not "nothing synced". */
const noSync = (v) => v === false || v === 0;
const textOrNull = (v) => (v === null || v === undefined || v === "" ? null : String(v));

/** The choices of the "Show" selector. The last one is a different list (people, not rows): the page handles it. */
export const SHOW_CHOICES = [
  { value: "all", label: "Everyone" },
  { value: "notConnected", label: "Not connected" },
  { value: "inactive", label: "Inactive users still assigned" },
  { value: "nothingSynced", label: "Connected, nothing synced yet" },
  { value: "noConfig", label: "Has access but is in no configuration" },
];

/**
 * Join the raw data into one row per user and configuration.
 *   statuses       ActivityUsrConnectionStatus records (UserName is the person's display name)
 *   assignments    UserEmailCalendarSync records ({AssignedId, ConfigurationId})
 *   configs        {<configuration Id>: name}   (optional; a name missing here is worked out from users who have both rows)
 *   users          [{Id, Name, Username, Email, IsActive}] or a map by Id (optional)
 *   profiles       {<profile Id>: name}   (optional)
 *   profileMembers {<profile Id>: [user Id]}  the members of each assigned profile; each becomes a row "Through the profile X"
 *   accessUserIds  Ids of active users who have an EAC permission (null: not read). Those in no row are returned as `noConfig`.
 *   single         {userId, profileId, profileName}: build the rows of ONE user, where a profile assignment of that
 *                  profile counts for them ("through profile X").
 * Rows are matched by configuration NAME. A user assigned both directly and through a profile is one row with both noted.
 */
export function buildEacRows({ statuses = [], assignments = [], configs = {}, users = [], profiles = {}, profileMembers = {}, accessUserIds = null, single = null } = {}) {
  const userMap = new Map();
  const list = Array.isArray(users) ? users : Object.values(users);
  for (const u of list) userMap.set(id15(u.Id || u.id), u);
  const cfgMap = new Map(Object.entries(configs).map(([k, v]) => [id15(k), v]));
  const profMap = new Map(Object.entries(profiles).map(([k, v]) => [id15(k), v]));
  const memberMap = new Map(Object.entries(profileMembers).map(([k, v]) => [id15(k), v]));

  // Who is assigned what: direct assignments, and one task per member of an assigned profile.
  const tasks = [];
  const profileAssignments = []; // profiles whose members could not be listed
  for (const a of assignments) {
    const who = String(a.AssignedId || "");
    const cfgId = a.ConfigurationId || null;
    if (who.startsWith("005")) tasks.push({ uid: who, cfgId, kind: "user" });
    else if (who.startsWith("00e")) {
      const pname = profMap.get(id15(who)) || (single && id15(single.profileId) === id15(who) ? single.profileName : null) || null;
      if (single) {
        if (id15(single.profileId) === id15(who)) tasks.push({ uid: single.userId, cfgId, kind: "profile", pname });
      } else if (memberMap.has(id15(who))) {
        for (const uid of memberMap.get(id15(who))) tasks.push({ uid, cfgId, kind: "profile", pname });
      } else {
        profileAssignments.push({ profileId: who, profileName: pname || "A profile", configuration: cfgMap.get(id15(cfgId)) || unnamedConfig(cfgId) });
      }
    }
  }

  // A configuration's name: from the list of names, else from users who have exactly one status row and one assignment.
  const setOf = (map, key) => map.get(key) || map.set(key, new Set()).get(key);
  const idsOf = new Map();
  for (const t of tasks) if (t.cfgId) setOf(idsOf, id15(t.uid)).add(id15(t.cfgId));
  const namesOf = new Map();
  for (const s of statuses) if (s.UserId && s.ConfigurationName) setOf(namesOf, id15(s.UserId)).add(s.ConfigurationName);
  const votes = new Map();
  for (const [uid, ids] of idsOf) {
    const names = namesOf.get(uid);
    if (ids.size !== 1 || !names || names.size !== 1) continue;
    const [cid] = ids;
    const [nm] = names;
    const v = votes.get(cid) || new Map();
    v.set(nm, (v.get(nm) || 0) + 1);
    votes.set(cid, v);
  }
  const inferred = new Map([...votes].map(([cid, v]) => [cid, [...v].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0]]));
  const cfgName = (id) => (id ? cfgMap.get(id15(id)) || inferred.get(id15(id)) || null : null);

  const perUser = new Map(); // id15 -> {userId, rows: []}
  const bucket = (uid) => {
    if (!perUser.has(id15(uid))) perUser.set(id15(uid), { userId: uid, rows: [] });
    return perUser.get(id15(uid));
  };
  for (const s of statuses) {
    if (!s.UserId) continue;
    bucket(s.UserId).rows.push({
      userId: s.UserId,
      fallbackName: s.UserName || "", // the person's display name, not a username
      emailAddress: textOrNull(s.EmailAddress),
      configuration: textOrNull(s.ConfigurationName),
      status: textOrNull(s.ConnectivityStatus), hasRow: true,
      recommendedTitle: textOrNull(s.RecommendedActionTitle),
      recommendedDescription: textOrNull(s.RecommendedActionDescription),
      contactsSynced: syncOrNull(s.ContactsSynced),
      eventsSynced: syncOrNull(s.EventsSynced),
      termsAccepted: boolOrNull(s.IsTermsOfServiceAccepted),
      globalTerms: textOrNull(s.GlobalOauthTermsState),
      onboarding: textOrNull(s.UserOnboardingStatus),
      direct: false, profiles: [], configId: null, assigned: false,
    });
  }

  const blank = (userId, configuration) => ({
    userId, fallbackName: "", emailAddress: null, configuration, status: null, hasRow: false,
    recommendedTitle: null, recommendedDescription: null, contactsSynced: null, eventsSynced: null,
    termsAccepted: null, globalTerms: null, onboarding: null, direct: false, profiles: [], configId: null, assigned: false,
  });
  const attach = ({ uid, cfgId, kind, pname }) => {
    const b = bucket(uid);
    const name = cfgName(cfgId);
    const label = name || (cfgId ? unnamedConfig(cfgId) : null);
    const mark = (r) => {
      r.assigned = true;
      if (kind === "user") r.direct = true;
      else {
        const p = pname || "(name not available)";
        if (!r.profiles.includes(p)) r.profiles.push(p);
      }
      r.configId = r.configId || cfgId;
    };
    // The same configuration for the same user (direct and through a profile, or twice): one row.
    const same = b.rows.find((r) => r.assigned && ((cfgId && r.configId && id15(r.configId) === id15(cfgId)) || (label && r.configuration === label)));
    if (same) return mark(same);
    const free = (r) => r.hasRow && !r.assigned;
    // Same configuration name first; an unknown name joins any status row not yet matched.
    const hit = b.rows.find((r) => free(r) && name && r.configuration === name)
      || (!name ? b.rows.find((r) => free(r)) : null)
      || b.rows.find((r) => free(r) && !r.configuration);
    if (hit) {
      if (!hit.configuration && label) hit.configuration = label;
      return mark(hit);
    }
    const r = blank(uid, label);
    b.rows.push(r);
    return mark(r);
  };
  for (const t of tasks) attach(t);

  const rows = [];
  for (const { userId, rows: rs } of perUser.values()) {
    const u = userMap.get(id15(userId));
    for (const r of rs) {
      const connected = isConnected(r.status);
      rows.push({
        ...r,
        name: u?.Name || u?.name || r.fallbackName || userId,
        username: u?.Username || u?.username || "",
        email: u?.Email || u?.email || r.emailAddress || "",
        isActive: u ? u.IsActive !== false : true,
        configuration: r.configuration || UNNAMED_CONFIG,
        via: r.direct ? "user" : r.profiles.length ? "profile" : null,
        profileName: r.profiles.join(", ") || null,
        statusText: statusWords(r.status, r.hasRow),
        connected,
        nothingSynced: connected && noSync(r.contactsSynced) && noSync(r.eventsSynced),
        fallbackName: undefined, emailAddress: undefined,
      });
    }
  }
  rows.sort((x, y) => x.name.localeCompare(y.name) || x.configuration.localeCompare(y.configuration));
  profileAssignments.sort((x, y) => x.profileName.localeCompare(y.profileName) || x.configuration.localeCompare(y.configuration));

  let noConfig = null;
  if (Array.isArray(accessUserIds)) {
    noConfig = [];
    const seen = new Set();
    for (const id of accessUserIds) {
      const k = id15(id);
      if (!k || seen.has(k) || perUser.has(k)) continue;
      seen.add(k);
      const u = userMap.get(k);
      noConfig.push({ userId: id, name: u?.Name || u?.name || id, username: u?.Username || u?.username || "", email: u?.Email || u?.email || "", isActive: u ? u.IsActive !== false : true });
    }
    noConfig.sort((x, y) => x.name.localeCompare(y.name));
  }
  return { rows, profileAssignments, noConfig };
}

/** Counts worked out from the rows (never from COUNT(), which reads 0 on these objects). */
export function eacCounts(rows) {
  const users = new Set(rows.map((r) => id15(r.userId)));
  const byConfig = new Map();
  const byStatus = new Map();
  for (const r of rows) {
    const c = byConfig.get(r.configuration) || { name: r.configuration, count: 0, notConnected: 0 };
    c.count++;
    if (!r.connected) c.notConnected++;
    byConfig.set(r.configuration, c);
    const s = byStatus.get(r.statusText) || { text: r.statusText, count: 0 };
    s.count++;
    byStatus.set(r.statusText, s);
  }
  const bigFirst = (x, y) => y.count - x.count || String(x.name || x.text).localeCompare(String(y.name || y.text));
  const connected = rows.filter((r) => r.connected).length;
  // Distinct users: connected when any of their rows is ACTIVE.
  const connectedIds = new Set(rows.filter((r) => r.connected).map((r) => id15(r.userId)));
  return {
    rows: rows.length, users: users.size, connectedUsers: connectedIds.size, notConnectedUsers: users.size - connectedIds.size, connected, notConnected: rows.length - connected,
    inactive: rows.filter((r) => !r.isActive).length, nothingSynced: rows.filter((r) => r.nothingSynced).length,
    byConfig: [...byConfig.values()].sort(bigFirst), byStatus: [...byStatus.values()].sort(bigFirst),
  };
}

/** The rows grouped by configuration: [{name, rows}], by name. */
export function groupByConfig(rows) {
  const m = new Map();
  for (const r of rows) (m.get(r.configuration) || m.set(r.configuration, []).get(r.configuration)).push(r);
  return [...m].map(([name, rs]) => ({ name, rows: rs })).sort((x, y) => x.name.localeCompare(y.name));
}

const searchWords = (search) => String(search).trim().toLowerCase().split(/\s+/).filter(Boolean);

export function assignedText(r) {
  const direct = r.direct || (r.direct === undefined && r.via === "user");
  const profs = r.profiles?.length ? r.profiles.join(", ") : r.via === "profile" ? r.profileName || "(name not available)" : "";
  const through = profs ? `${direct ? "through" : "Through"} the profile ${profs}` : "";
  return [direct ? "Directly" : "", through].filter(Boolean).join(" and ");
}

/** Flags worth a clean-up or a look, in words. */
export function flagText(r) {
  const f = [];
  if (!r.isActive) f.push(INACTIVE_TEXT);
  if (r.nothingSynced) f.push(NOTHING_SYNCED_TEXT);
  return f.join("; ");
}

/** The "Show" selector and the search box. Search needs every word, in any column the table shows. */
export function filterEacRows(rows, { show = "all", onlyNotConnected = false, search = "" } = {}) {
  const w = searchWords(search);
  return rows.filter((r) => {
    if ((onlyNotConnected || show === "notConnected") && r.connected) return false;
    if (show === "inactive" && r.isActive) return false;
    if (show === "nothingSynced" && !r.nothingSynced) return false;
    if (!w.length) return true;
    const hay = [r.name, r.username, r.email, r.configuration, r.statusText, r.recommendedTitle, assignedText(r), flagText(r)].filter(Boolean).join(" ").toLowerCase();
    return w.every((x) => hay.includes(x));
  });
}

/** The users with access but in no configuration, narrowed by the search box. */
export function filterNoConfig(list, { search = "" } = {}) {
  const w = searchWords(search);
  return (list || []).filter((u) => !w.length || w.every((x) => [u.name, u.username, u.email].join(" ").toLowerCase().includes(x)));
}

/** One line per fact for a user's list item (the page keeps the line breaks; the CSV joins them with "; "). */
export function eacDetailText(item) {
  if (!item) return "";
  const parts = [`Status: ${item.statusText}`];
  if (item.recommendedTitle) parts.push(`Recommended action: ${item.recommendedTitle}`);
  if (item.recommendedDescription) parts.push(`About the action: ${item.recommendedDescription}`);
  if (item.hasRow) {
    parts.push(`Contacts synced: ${yesNo(item.contactsSynced)}`, `Events synced: ${yesNo(item.eventsSynced)}`, `Terms accepted: ${yesNo(item.termsAccepted)}`);
    if (item.globalTerms) parts.push(`Org-wide terms: ${GLOBAL_TERMS_WORDS[item.globalTerms] || sentence(item.globalTerms)}`);
  }
  const how = assignedText(item);
  if (how) parts.push(`Assigned: ${how}`);
  return parts.join("\n");
}

/** The status's API name, for "Show API names". */
export const eacApiLine = (item) => (item?.hasRow ? `API name of the status: ${item.status || "(blank)"}` : "");

/** A section item (for sections.eac) from a row. The key is the configuration NAME, so users match across orgs. */
export function eacItem(r) {
  return {
    key: r.configuration, label: r.configuration,
    status: r.status, statusText: r.statusText, hasRow: r.hasRow, connected: r.connected,
    recommendedTitle: r.recommendedTitle, recommendedDescription: r.recommendedDescription,
    contactsSynced: r.contactsSynced, eventsSynced: r.eventsSynced, termsAccepted: r.termsAccepted,
    globalTerms: r.globalTerms, via: r.via, profileName: r.profileName, direct: r.direct, profiles: r.profiles,
  };
}

/** A synced answer in the table: "Yes", "No", a count, or blank when there is no status row. */
export const syncCell = (r, v) => (r.hasRow ? yesNo(v) : "");

/** Rows for a CSV (one configuration's members, what is shown, or everyone): one line per user and configuration. */
export function eacCsvRows(rows) {
  const out = [["Configuration", "Name", "Username", "Email", "Active", "How assigned", "Connection status", "Connected", "Contacts synced", "Events synced", "Note", "Status (API name)", "Recommended action", "About the action", "Terms accepted"]];
  for (const r of rows) {
    out.push([r.configuration, r.name, r.username, r.email || "", r.isActive ? "Yes" : "No", assignedText(r), r.statusText, r.connected ? "Yes" : "No",
      syncCell(r, r.contactsSynced), syncCell(r, r.eventsSynced), flagText(r), r.hasRow ? r.status || "" : "", r.recommendedTitle || "", r.recommendedDescription || "", r.hasRow ? yesNo(r.termsAccepted) : ""]);
  }
  return out;
}

/** CSV rows of the users who have EAC access but are in no configuration. */
export function noConfigCsvRows(list) {
  const out = [["Name", "Username", "Email", "Active", "Note"]];
  for (const u of list) out.push([u.name, u.username, u.email || "", u.isActive ? "Yes" : "No", NO_CONFIG_TITLE]);
  return out;
}

/** The sentence at the top of the everyone view. */
export function eacSummaryLine(c) {
  return `${c.users} ${c.users === 1 ? "user" : "users"}: ${c.connectedUsers} connected, ${c.notConnectedUsers} not connected.`;
}

/** Note about profile assignments whose members could not be listed. "" when none. */
export function profileNote(profileAssignments) {
  if (!profileAssignments?.length) return "";
  const parts = profileAssignments.map((p) => `${p.configuration} for everyone on the profile ${p.profileName}`);
  return `The members of these profiles could not be listed, so they are missing here: ${parts.join("; ")}.`;
}
