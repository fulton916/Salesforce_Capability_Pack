// Read Einstein Activity Capture data (read-only: SOQL queries and one describeGlobal, no writes).
//
// Never use COUNT() on UserEmailCalendarSync or ActivityUsrConnectionStatus: it returns 0 even when rows
// exist. Never filter either object with a WHERE: a real org answers with a generic server error. Every row is
// read (paged) and filtered in memory, also for one user.

import { chunk, soqlString } from "../../shared/sfconn.js";
import { EAC_OFF_TEXT, buildEacRows, eacItem } from "./user-access-eac.js";
import { userLookupQueries } from "./user-access-eac-changes.js";

const ID_CHUNK = 200;
const OFF_PATTERN = /INVALID_TYPE|not supported|sObject type/i;
const SAFE_ID = /^[A-Za-z0-9]{15,18}$/;
const id15 = (v) => (v ? String(v).slice(0, 15) : "");
const fmt = (n) => Number(n).toLocaleString("en-US");

// UserName is the person's display name (it has spaces and no @), not a username.
const STATUS_FIELDS = "Id, UserId, UserName, ConfigurationName, EmailAddress, ConnectivityStatus, RecommendedActionTitle, RecommendedActionDescription, " +
  "IsTermsOfServiceAccepted, GlobalOauthTermsState, ContactsSynced, EventsSynced, UserOnboardingStatus";
const USER_FIELDS = "Id, Name, Username, Email, IsActive";

/** The two permissions that give access to Einstein Activity Capture ("Use Einstein Activity Capture" and "... Standard"). */
export const EAC_PERMISSION_FIELDS = ["PermissionsAutomaticActivityCapture", "PermissionsStdAutomaticActivityCapture"];

/** Only Ids that look like Ids go into a query. */
const safeIds = (ids) => [...new Set(ids.filter((i) => typeof i === "string" && SAFE_ID.test(i)))];

function featureOff(e) {
  const err = new Error(EAC_OFF_TEXT);
  err.featureOff = true; // a feature that is off is not a problem: no warning
  err.cause = e;
  return err;
}

/** Run a query and follow every page; `onCount(n)` is told the rows read so far after each page. */
async function queryPaged(api, soql, onCount = () => {}) {
  let page = await api.get(`/services/data/v${api.apiVersion}/query/?q=${encodeURIComponent(soql)}`);
  const records = [...(page.records || [])];
  onCount(records.length);
  while (!page.done && page.nextRecordsUrl) {
    page = await api.get(page.nextRecordsUrl);
    records.push(...(page.records || []));
    onCount(records.length);
  }
  return records;
}

async function readInChunks(api, ids, build, onCount = () => {}) {
  const out = [];
  for (const part of chunk(ids, ID_CHUNK)) {
    out.push(...(await queryPaged(api, build(part.map(soqlString).join(", ")))));
    onCount(out.length);
  }
  return out;
}

/**
 * The name of each configuration Id, from the object behind the 063 prefix. A harmless try: no queryable object has that
 * prefix in some orgs. The main source of names is the status rows (see buildEacRows).
 */
async function readConfigNames(api, assignments) {
  const wanted = new Set(assignments.map((a) => a.ConfigurationId).filter(Boolean));
  if (!wanted.size) return {};
  try {
    const { sobjects = [] } = await api.describeGlobal();
    const obj = sobjects.find((o) => o.keyPrefix === "063")?.name;
    if (!obj || !/^[A-Za-z0-9_]+$/.test(obj)) return {};
    const { records } = await api.query(`SELECT Id, Name FROM ${obj}`);
    return Object.fromEntries(records.map((r) => [r.Id, r.Name]));
  } catch {
    return {}; // not a problem: the names come from the status rows
  }
}

/**
 * Ids of the active users who have Einstein Activity Capture access: a permission set (also a profile's own, or a group's
 * combined one) with "Use Einstein Activity Capture" or "... Standard". If one permission field does not exist in this
 * org, the other is used; if both fail, `ids` is null and `note` says so in plain words. Read-only; paged.
 */
export async function readEacAccessUserIds(api, { onCount = () => {} } = {}) {
  const [a, b] = EAC_PERMISSION_FIELDS;
  const sql = (cond) => `SELECT AssigneeId FROM PermissionSetAssignment WHERE Assignee.IsActive = true AND (${cond})`;
  const attempts = [
    sql(`PermissionSet.${a} = true OR PermissionSet.${b} = true`),
    sql(`PermissionSet.${a} = true`),
    sql(`PermissionSet.${b} = true`),
  ];
  let first = null;
  try {
    return { ids: safeIds((await queryPaged(api, attempts[0], onCount)).map((r) => r.AssigneeId)), note: "", error: null };
  } catch (e) { first = e; }
  // One of the two fields may not exist in this org: ask each alone and use every answer that works.
  const got = [];
  let worked = false;
  for (const s of attempts.slice(1)) {
    try { got.push(...(await queryPaged(api, s, onCount)).map((r) => r.AssigneeId)); worked = true; } catch { /* the other field may still work */ }
  }
  if (worked) return { ids: safeIds(got), note: "", error: first };
  return { ids: null, note: "Who has Einstein Activity Capture access could not be read, so the list of users in no configuration is not shown.", error: first };
}

/**
 * The raw EAC data. `forUser` ({userId, profileId}) limits it to one user (and their profile); without it,
 * every row is read. Throws a `featureOff` error when the objects are not there (or not visible); if only one of
 * the two objects fails the other is still used and the problem goes to `warnings`.
 */
export async function readEacRaw(api, { forUser = null, progress = () => {} } = {}) {
  const warnings = [];
  const failures = [];
  const ownerIds = forUser ? safeIds([forUser.userId, forUser.profileId]) : [];
  const run = async (what, fn) => {
    try { return await fn(); } catch (e) { failures.push(e); warnings.push(`${what}: ${e.message}`); return null; }
  };

  // Both EAC objects are read whole (no WHERE) and narrowed in memory.
  let statuses = await run("Einstein Activity Capture connection status", () =>
    queryPaged(api, `SELECT ${STATUS_FIELDS} FROM ActivityUsrConnectionStatus`, (n) => progress(`Reading… ${fmt(n)} connections`)));
  if (statuses && forUser) statuses = statuses.filter((s) => id15(s.UserId) === id15(forUser.userId));

  let assignments = await run("Einstein Activity Capture assignments", () =>
    queryPaged(api, "SELECT Id, AssignedId, ConfigurationId FROM UserEmailCalendarSync", (n) => progress(`Reading… ${fmt(n)} assignments`)));
  if (assignments && forUser) assignments = assignments.filter((r) => ownerIds.some((id) => id15(id) === id15(r.AssignedId)));

  if (statuses === null && assignments === null) {
    const e = failures[0];
    if (failures.every((f) => OFF_PATTERN.test(`${f?.errorCode || ""} ${f?.message || ""}`))) throw featureOff(e);
    throw e;
  }
  if (statuses === null && failures.some((f) => OFF_PATTERN.test(`${f?.errorCode || ""} ${f?.message || ""}`)) && !assignments.length) throw featureOff(failures[0]);
  assignments = assignments || [];

  const configs = await readConfigNames(api, assignments);
  const users = new Map(); // id15 -> user record
  const addUsers = (list) => { for (const u of list) users.set(id15(u.Id), u); };
  let profiles = {};
  const profileMembers = {};
  let accessUserIds = null;
  let accessNote = "";
  if (!forUser) {
    progress("Reading… the users' names");
    const userIds = safeIds([...(statuses || []).map((s) => s.UserId), ...assignments.map((a) => a.AssignedId).filter((i) => String(i).startsWith("005"))]);
    try {
      addUsers(await readInChunks(api, userIds, (list) => `SELECT ${USER_FIELDS} FROM User WHERE Id IN (${list})`, (n) => progress(`Reading… ${fmt(n)} users`)));
    } catch (e) { warnings.push(`Could not read the user names (${e.message}).`); }

    // Everyone on an assigned profile is a member, so read each profile's users (active and inactive).
    const profileIds = safeIds(assignments.map((a) => a.AssignedId).filter((i) => String(i).startsWith("00e")));
    try {
      profiles = Object.fromEntries((await readInChunks(api, profileIds, (list) => `SELECT Id, Name FROM Profile WHERE Id IN (${list})`)).map((p) => [p.Id, p.Name]));
    } catch (e) { warnings.push(`Could not read the profile names (${e.message}).`); }
    let readSoFar = users.size;
    for (const pid of profileIds) {
      try {
        const list = await queryPaged(api, `SELECT ${USER_FIELDS} FROM User WHERE ProfileId = ${soqlString(pid)}`, (n) => progress(`Reading… ${fmt(readSoFar + n)} users`));
        readSoFar += list.length;
        addUsers(list);
        profileMembers[pid] = list.map((u) => u.Id);
      } catch (e) { warnings.push(`Could not read the users of the profile ${profiles[pid] || pid} (${e.message}).`); }
    }

    // Who has EAC access, so the ones who are in no configuration can be listed.
    progress("Reading… who has Einstein Activity Capture access");
    const access = await readEacAccessUserIds(api, { onCount: (n) => progress(`Reading… ${fmt(n)} users with access`) });
    accessNote = access.note;
    if (access.ids) {
      accessUserIds = access.ids;
      const inConfig = new Set([...(statuses || []).map((s) => id15(s.UserId)), ...userIds.map(id15), ...Object.values(profileMembers).flat().map(id15)]);
      const need = access.ids.filter((i) => !inConfig.has(id15(i)) && !users.has(id15(i)));
      try {
        addUsers(await readInChunks(api, need, (list) => `SELECT ${USER_FIELDS} FROM User WHERE Id IN (${list})`));
      } catch (e) { warnings.push(`Could not read the names of users with access (${e.message}).`); }
    }
  }
  const partial = failures.length ? "Part of the Einstein Activity Capture data could not be read, so the list may be incomplete." : "";
  return { statuses: statuses || [], assignments, configs, users: [...users.values()], profiles, profileMembers, accessUserIds, accessNote, warnings, partial };
}

/** One user's EAC list items for the summary (matched later by configuration name). */
export async function readUserEac(api, { userId, profileId, profileName }) {
  const raw = await readEacRaw(api, { forUser: { userId, profileId } });
  const { rows } = buildEacRows({ ...raw, single: { userId, profileId, profileName } });
  return { items: rows.map(eacItem), warnings: raw.warnings, partial: raw.partial };
}

/**
 * Look up pasted usernames or emails (issue #42): SELECT only, on User (a WHERE on User is fine; never on the two EAC
 * objects), in batches, values escaped by soqlString inside userLookupQueries. Returns the User records found.
 */
export async function readPastedUsers(api, tokens, { onCount = () => {} } = {}) {
  const out = [];
  for (const soql of userLookupQueries(tokens)) {
    out.push(...(await queryPaged(api, soql)));
    onCount(out.length);
  }
  return out;
}
