// Build Einstein Activity Capture changes as text (issue #42). Pure: no browser or network APIs, and nothing here writes to the org.
//
// The extension only READS. It prepares rows for the admin to load themselves: pasted into Salesforce Inspector's Data Import,
// or downloaded as a CSV for Data Loader.
//   Add     insert  UserEmailCalendarSync    AssignedId, ConfigurationId
//   Remove  delete  PermissionSetAssignment  Id   (the user's own assignments that grant Einstein Activity Capture)
//   Move    Remove, then give the permission back (insert PermissionSetAssignment), then Add to the target
// Why: every UserEmailCalendarSync row has the placeholder Id 000000000000000AAA, so its rows cannot be updated or deleted by
// Id. Per the person who asked for this, a user in a configuration of more than 500 users leaves it when their Einstein
// Activity Capture permission is removed. NOT verified in a real org.
// The output holds only API column names and Ids: never a name, username or email.

import { toCsv } from "../../shared/csv.js";
import { soqlString, chunk } from "../../shared/sfconn.js";
import { unnamedConfig, UNNAMED_CONFIG } from "./user-access-eac.js";

const id15 = (v) => (v ? String(v).slice(0, 15) : "");
const SAFE_ID = /^[A-Za-z0-9]{15,18}$/;
/** An Id that is valid AND real (not the all-zero placeholder that UserEmailCalendarSync rows have). */
export const usableId = (v) => typeof v === "string" && SAFE_ID.test(v) && !/^0{15}/.test(v);
const num = (n) => Number(n).toLocaleString("en-US");
/** The key of a profile assignment row. Not its Id: in real orgs every row has the same placeholder Id. */
export const profileKey = (p) => `${id15(p.profileId)}|${id15(p.configId)}`;
const CONFIG_ID = /^063[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

export const MAX_PASTED = 500;
export const LOOKUP_BATCH = 50;
export const PERMISSION_BATCH = 200;

/** The three changes. `word` goes in every button label. `op` and `object` are Inspector's Action and Object for the (first) load. */
export const ACTIONS = {
  add: { value: "add", label: "Add to", word: "Add", op: "Insert", object: "UserEmailCalendarSync", header: ["AssignedId", "ConfigurationId"], needsTarget: true, needsPermissions: false },
  move: { value: "move", label: "Move to", word: "Move", op: "Delete", object: "PermissionSetAssignment", header: ["Id"], needsTarget: true, needsPermissions: true },
  remove: { value: "remove", label: "Remove from its configuration", word: "Remove", op: "Delete", object: "PermissionSetAssignment", header: ["Id"], needsTarget: false, needsPermissions: true },
};
export const ACTION_LIST = [ACTIONS.add, ACTIONS.move, ACTIONS.remove];

/** Every table that can be loaded: Inspector's Action, Object and the column names. */
export const LOADS = {
  add: { object: "UserEmailCalendarSync", op: "Insert", header: ["AssignedId", "ConfigurationId"], label: "Add to the configuration" },
  delete: { object: "PermissionSetAssignment", op: "Delete", header: ["Id"], label: "Delete the permission assignments" },
  giveSet: { object: "PermissionSetAssignment", op: "Insert", header: ["AssigneeId", "PermissionSetId"], label: "Give back the permission sets" },
  giveGroup: { object: "PermissionSetAssignment", op: "Insert", header: ["AssigneeId", "PermissionSetGroupId"], label: "Give back the permission set groups" },
};

export const CONFIG_ID_HELP = "To use a configuration that has no users yet, copy its Id from Setup > Einstein Activity Capture > Configurations. It starts with 063 and is 15 or 18 characters long.";
export const CONFIG_ID_BAD = "That does not look like a configuration Id. It starts with 063 and has 15 or 18 letters and digits in all.";
export const CHANGE_WARNING = "This changes who captures email and calendar activity. Check the preview first.";
export const NOT_VERIFIED_NOTE = "We have not verified this load in a real org. Try it on one user first.";
export const NO_UNDO_ADD = "To undo an add, read again and use Remove.";
export const AFTER_STEP = "Then click Show everyone again here to check the result.";
export const INSPECTOR_UNVERIFIED = "The menu words are how Salesforce Inspector names them, as far as we know. We have not checked them in your version.";
export const READ_ONLY_NOTE = "This page does not change anything in your org. You load the text yourself, in the step below.";
export const HOW_REMOVE_WORKS = "A user in a configuration of more than 500 users leaves it when their Einstein Activity Capture permission is removed. So Remove deletes the permission assignments that give them that permission. Data Loader cannot remove the configuration row itself.";
export const GIVE_BACK_NOTE = "Giving the permission back does not put them back in the configuration by itself. Add them to the configuration as well.";
export const MOVE_ORDER_NOTE = "Load each step only after the one before has finished. After step 1, click Show everyone to check that they have left the old configuration.";
export const MOVE_UNDO_NOTE = "To undo a move, read again and use Move with their old configuration as the target.";
export const PROFILE_ASSIGNMENT_NOTE = "A profile assigned to a configuration cannot be removed here. Change it in Setup > Einstein Activity Capture > Configurations.";
export const PERMISSION_READ_FAILED = "Which permissions give these users Einstein Activity Capture could not be read. Your user may not have permission to see permission assignments.";

/** What deleting an assignment takes away besides Einstein Activity Capture. */
export const permissionWarning = (kind) =>
  `Deleting this assignment takes away everything else in this permission ${kind === "group" ? "set group" : "set"} from these users, not only Einstein Activity Capture.`;

/** A typed configuration Id: 063 plus 12 or 15 letters or digits. Returns the trimmed Id, or null. */
export function validConfigId(text) {
  const t = String(text ?? "").trim();
  return CONFIG_ID.test(t) ? t : null;
}

/** The on-page steps for loading one table. `load` is a load (op, object), or "add" / "remove" / "move" for the first table of that change. */
export function inspectorSteps(load) {
  const l = typeof load === "string" ? (load === "add" ? LOADS.add : load === "remove" || load === "move" ? LOADS.delete : null) : load;
  if (!l) return [];
  return [
    "Open Salesforce Inspector, then Data Import.",
    `Action: ${l.op}.`,
    `Object: ${l.object}.`,
    "Format: Excel.",
    "Paste the copied text.",
    "Import.",
  ];
}

// ---------- pasted usernames and emails ----------

/** Names or emails from a pasted list, one per line or comma separated. Duplicates (any case) are dropped. */
export function parsePasted(text) {
  const seen = new Set();
  const tokens = [];
  for (const raw of String(text ?? "").split(/[\r\n,;\t]+/)) {
    const t = raw.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    tokens.push(t);
  }
  return { tokens: tokens.slice(0, MAX_PASTED), tooMany: tokens.length > MAX_PASTED };
}

/** The read-only lookup queries, in batches. Values are escaped with soqlString. */
export function userLookupQueries(tokens, size = LOOKUP_BATCH) {
  return chunk(tokens, size).map((part) => {
    const list = part.map(soqlString).join(", ");
    return `SELECT Id, Name, Username, Email, IsActive FROM User WHERE Username IN (${list}) OR Email IN (${list})`;
  });
}

/**
 * Match pasted text to the users found. A username is unique, so it wins. An email can be on several users (common in
 * sandboxes): then nobody is picked and the line is listed as `ambiguous`.
 */
export function matchPasted(tokens, users) {
  const found = [];
  const notFound = [];
  const ambiguous = [];
  const list = users || [];
  for (const token of tokens) {
    const t = token.toLowerCase();
    const byName = list.filter((u) => String(u.Username || "").toLowerCase() === t);
    const hits = byName.length ? byName : list.filter((u) => String(u.Email || "").toLowerCase() === t);
    if (!hits.length) notFound.push(token);
    else if (hits.length > 1) ambiguous.push({ token, count: hits.length });
    else found.push({ token, user: hits[0] });
  }
  return { found, notFound, ambiguous };
}

// ---------- the permission assignments that give Einstein Activity Capture ----------

const PERMISSION_SELECT = "SELECT Id, AssigneeId, PermissionSetId, PermissionSet.Name, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name, " +
  "PermissionSet.Type, PermissionSetGroupId, PermissionSetGroup.DeveloperName, PermissionSetGroup.MasterLabel FROM PermissionSetAssignment";

/**
 * One read-only query: the assignments of these users whose permission set grants Einstein Activity Capture. `cond` is the
 * permission part (for example "PermissionSet.PermissionsAutomaticActivityCapture = true"). The WHERE is on PermissionSetAssignment
 * only (never on the two EAC objects). Ids that do not look like Ids are left out; values go through soqlString.
 */
export function permissionQuery(userIds, cond) {
  const ids = [...new Set((userIds || []).filter((i) => typeof i === "string" && SAFE_ID.test(i)))];
  return `${PERMISSION_SELECT} WHERE AssigneeId IN (${ids.map(soqlString).join(", ")}) AND (${cond})`;
}

/** A PermissionSetAssignment record as the page uses it. A permission set group's assignment has `groupId` filled in. */
export function permissionRowFrom(r) {
  const set = r.PermissionSet || {};
  const group = r.PermissionSetGroup || null;
  return {
    id: r.Id,
    userId: r.AssigneeId,
    setId: r.PermissionSetId || "",
    groupId: r.PermissionSetGroupId || "",
    ownedByProfile: set.IsOwnedByProfile === true || set.Type === "Profile",
    profileName: set.Profile?.Name || "",
    setName: set.Name || "",
    setLabel: set.Label || set.Name || "",
    groupName: group?.DeveloperName || "",
    groupLabel: group?.MasterLabel || group?.DeveloperName || "",
  };
}

// ---------- who and what can be picked ----------

/** The configurations that are known from the data (an assignment row names them): [{id, name, count}], by name. */
export function knownConfigs(rows, profileRows = []) {
  const m = new Map();
  const add = (id, name, n) => {
    if (!id || !SAFE_ID.test(id)) return;
    const k = id15(id);
    const c = m.get(k) || { id, name, count: 0 };
    c.count += n;
    m.set(k, c);
  };
  for (const r of rows || []) if (r.assigned && r.configId) add(r.configId, r.configuration, 1);
  for (const p of profileRows || []) add(p.configId, p.configuration, 0);
  return [...m.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** A selected row: one user, and the configuration of the ticked row (null when picked from a list or a pasted name). */
export const entryFromRow = (r) => ({ userId: r.userId, name: r.name, isActive: r.isActive !== false, configId: r.configId || null });
export const entryFromUser = (u) => ({ userId: u.userId, name: u.name, isActive: u.isActive !== false, configId: null });
export const entryFromRecord = (u) => ({ userId: u.Id, name: u.Name || u.Username || u.Id, isActive: u.IsActive !== false, configId: null });
export const entryKey = (e) => `${id15(e.userId)}|${id15(e.configId)}`;

// ---------- the plan (what the preview shows) ----------

const SKIP_TITLES = {
  badId: "Skipped: an Id that does not look right",
  inactive: "Skipped: inactive users",
  alreadyThere: "Skipped: already in the target configuration",
  useMove: "Skipped: already in another configuration directly (use Move)",
  profileOnly: "Skipped: in only through a profile",
  notIn: "Skipped: not in any configuration",
  severalRows: "Skipped: more than one assignment of their own",
  noPermission: "Skipped: no Einstein Activity Capture permission found",
  profilePermission: "Skipped: their profile gives them Einstein Activity Capture",
};
export const skipTitle = (code) => SKIP_TITLES[code] || "Skipped";

const names = (list) => [...new Set(list)].join(", ");

/**
 * Work out one change. Nothing is output yet: `previewed` stays false until the page has shown the preview.
 *   action        "add" | "move" | "remove"
 *   targetId      the configuration Id (a known one, or typed); not needed for Remove
 *   entries       the picked users (entryFrom...)
 *   rows          buildEacRows rows
 *   permissions   Move and Remove: the permission assignments read for the picked users (permissionRowFrom rows)
 *   notFound      pasted names that matched nobody (shown in the preview)
 * An item of Move or Remove is one user: `removals` lists the assignments to delete (`kind` "set" or "group"), `configs` the
 * configurations they are in directly (for the Add-back text).
 */
export function planChange({ action, targetId = "", entries = [], rows = [], notFound = [], configs = null, permissions = null } = {}) {
  const a = ACTIONS[action];
  const plan = { action, targetId: null, targetName: "", items: [], skipped: [], notFound: [...notFound], duplicates: 0, error: "", previewed: false };
  if (!a) { plan.error = "Pick what to do: Add, Move or Remove."; return plan; }
  const known = configs || knownConfigs(rows);
  const nameOfConfig = (id) => known.find((c) => id15(c.id) === id15(id))?.name || (id ? unnamedConfig(id) : UNNAMED_CONFIG);
  if (a.needsTarget) {
    const tid = validConfigId(targetId);
    if (!tid) { plan.error = String(targetId ?? "").trim() ? CONFIG_ID_BAD : "Pick the configuration, or type its Id."; return plan; }
    plan.targetId = tid;
    plan.targetName = nameOfConfig(tid);
  }
  if (a.needsPermissions && !Array.isArray(permissions)) { plan.error = "The permission assignments were not read, so nothing can be prepared."; return plan; }
  const t15 = id15(plan.targetId);

  const assignedRows = (userId) => rows.filter((r) => id15(r.userId) === id15(userId) && r.assigned);
  const skip = (e, code, detail = "") => plan.skipped.push({ name: e.name, code, detail });
  const goodUser = (e) => typeof e.userId === "string" && SAFE_ID.test(e.userId) && e.userId.startsWith("005");

  const done = new Set();
  const handled = new Set();
  // A pick with no configuration (pasted, or from a list) for a user who also has a ticked row is covered by the ticked row.
  const tickedUsers = new Set(entries.filter((e) => e.configId).map((e) => id15(e.userId)));
  for (const e of entries) {
    if (action !== "add" && !e.configId && tickedUsers.has(id15(e.userId))) { plan.duplicates++; continue; }
    if (action === "add" ? done.has(id15(e.userId)) : done.has(entryKey(e))) continue;
    done.add(action === "add" ? id15(e.userId) : entryKey(e));
    if (!goodUser(e)) { skip(e, "badId"); continue; }
    const all = assignedRows(e.userId);
    const inTarget = t15 && all.some((r) => id15(r.configId) === t15);

    if (action === "add") {
      if (inTarget) { skip(e, "alreadyThere"); continue; }
      if (!e.isActive) { skip(e, "inactive"); continue; }
      const direct = all.filter((r) => r.direct);
      if (direct.length) { skip(e, "useMove", names(direct.map((r) => r.configuration))); continue; }
      if (all.length) { skip(e, "profileOnly", all.map((r) => `${r.configuration} through the profile ${r.profiles.join(", ") || "(name not available)"}`).join("; ")); continue; }
      plan.items.push({ userId: e.userId, name: e.name, configId: plan.targetId });
      continue;
    }

    // Move and Remove: one result per user. Removing the permission takes the user out of every configuration they are in directly.
    if (handled.has(id15(e.userId))) { plan.duplicates++; continue; }
    handled.add(id15(e.userId));
    const own = e.configId ? all.filter((r) => id15(r.configId) === id15(e.configId)) : all;
    if (!own.length) { skip(e, "notIn"); continue; }
    if (action === "move" && inTarget) { skip(e, "alreadyThere"); continue; }
    if (action === "move" && !e.isActive) { skip(e, "inactive"); continue; }
    const direct = own.filter((r) => r.direct);
    if (!direct.length) {
      skip(e, "profileOnly", own.map((r) => `${r.configuration} through the profile ${r.profiles.join(", ") || "(name not available)"}`).join("; "));
      continue;
    }
    const allDirect = all.filter((r) => r.direct);
    if (new Set(allDirect.map((r) => id15(r.configId))).size > 1) { skip(e, "severalRows", names(allDirect.map((r) => r.configuration))); continue; }

    const mine = permissions.filter((p) => id15(p.userId) === id15(e.userId));
    if (!mine.length) { skip(e, "noPermission"); continue; }
    const fromProfile = mine.filter((p) => p.ownedByProfile);
    if (fromProfile.length) { skip(e, "profilePermission", names(fromProfile.map((p) => p.profileName || "(profile name not available)"))); continue; }
    const removals = [];
    const seenAsg = new Set();
    let bad = false;
    for (const p of mine) {
      const group = !!p.groupId;
      if (!SAFE_ID.test(p.id || "") || !SAFE_ID.test((group ? p.groupId : p.setId) || "")) { bad = true; break; }
      if (seenAsg.has(id15(p.id))) continue;
      seenAsg.add(id15(p.id));
      removals.push({ id: p.id, kind: group ? "group" : "set", setId: p.setId, groupId: p.groupId, label: group ? p.groupLabel : p.setLabel, apiName: group ? p.groupName : p.setName });
    }
    if (bad) { skip(e, "badId"); continue; }
    const stillIn = own.filter((r) => r.profiles?.length);
    plan.items.push({
      userId: e.userId, name: e.name, fromConfigId: direct[0].configId, fromName: names(direct.map((r) => r.configuration)),
      configs: [...new Map(direct.map((r) => [id15(r.configId), { id: r.configId, name: r.configuration }])).values()],
      removals,
      note: stillIn.length ? `Still in ${names(stillIn.map((r) => r.configuration))} through the profile ${names(stillIn.flatMap((r) => r.profiles))}.` : "",
    });
  }
  return plan;
}

/** Users counted once, however many rows. */
export const planUserCount = (plan) => new Set(plan.items.map((i) => id15(i.userId))).size;

/** How many permission assignments are to be deleted (Move and Remove). */
export const planRemovalCount = (plan) => plan.items.reduce((n, i) => n + (i.removals?.length || 0), 0);

/**
 * The permission sets and groups involved in a Move or Remove: [{kind, key, label, apiName, users}], by label. `users` is how many
 * picked users lose that assignment.
 */
export function involvedPermissions(plan) {
  const m = new Map();
  for (const i of plan.items) {
    for (const r of i.removals || []) {
      const key = r.kind === "group" ? `group:${id15(r.groupId)}` : `set:${id15(r.setId)}`;
      const c = m.get(key) || { kind: r.kind, key, label: r.label, apiName: r.apiName, users: new Set() };
      c.users.add(id15(i.userId));
      m.set(key, c);
    }
  }
  return [...m.values()].map((c) => ({ kind: c.kind, key: c.key, label: c.label, apiName: c.apiName, users: c.users.size })).sort((x, y) => x.label.localeCompare(y.label));
}

/** The skipped users, grouped by reason: [{code, title, entries: [{name, detail}]}]. */
export function skipGroups(plan) {
  const m = new Map();
  for (const s of plan.skipped) (m.get(s.code) || m.set(s.code, []).get(s.code)).push({ name: s.name, detail: s.detail });
  return [...m].map(([code, list]) => ({ code, title: skipTitle(code), entries: list }));
}

/** Plain words for the reason of a skip group, per action. */
export function skipHelp(action, code) {
  const t = {
    inactive: action === "move" ? "An inactive user cannot be added to the new configuration, so they cannot be moved." : "An inactive user cannot be added.",
    alreadyThere: "They are already in the target configuration (directly or through a profile).",
    useMove: "Use Move for them, so they are not in two configurations.",
    profileOnly: action === "add"
      ? "They are in a configuration only through a profile, and adding them would put them in two. Change the profile's assignment in Setup."
      : "They are in a configuration only through a profile's assignment, which cannot be removed here. Change it in Setup > Einstein Activity Capture > Configurations.",
    notIn: action === "move" ? "They are in no configuration. Use Add for them." : "They are in no configuration, so there is nothing to remove.",
    severalRows: "They are directly in more than one configuration. Removing the permission would take them out of all of them, so they were left out. Change them in Setup > Einstein Activity Capture > Configurations.",
    noPermission: "No Einstein Activity Capture permission was found for them. It may already be removed; click Show everyone to read again.",
    profilePermission: "Their profile gives them Einstein Activity Capture. Deleting assignments would not remove it: change it on the profile, or the user's profile, in Setup.",
    badId: "The Id is missing or does not look right.",
  };
  return t[code] || "";
}

/** "N picks were the same assignment and are listed once", or "" when nothing repeated. */
export function duplicatesText(plan) {
  const n = plan.duplicates || 0;
  return n ? `${num(n)} ${n === 1 ? "pick was" : "picks were"} the same assignment and ${n === 1 ? "is" : "are"} listed once.` : "";
}

/** The sentence at the top of the preview. */
export function previewSummary(plan) {
  const a = ACTIONS[plan.action];
  if (!a || plan.error) return plan.error || "";
  const n = planUserCount(plan);
  const users = `${num(n)} ${n === 1 ? "user" : "users"}`;
  const r = planRemovalCount(plan);
  const asg = `${num(r)} permission ${r === 1 ? "assignment" : "assignments"}`;
  if (plan.action === "add") return `Add ${users} to ${plan.targetName}.`;
  if (plan.action === "move") return `Move ${users} to ${plan.targetName}: delete ${asg}, give the permission back, then add them to the configuration.`;
  return `Remove ${users} from their configuration by deleting ${asg}.`;
}

// ---------- the text to load ----------

const checkTable = (t) => {
  for (const row of t.rows) for (const c of row) if (!usableId(c)) throw new Error("An Id does not look right, so no text was built.");
  const seen = new Set();
  t.rows = t.rows.filter((r) => { const k = r.map(id15).join("|"); if (seen.has(k)) return false; seen.add(k); return true; });
  return t;
};

/** One table to load: {key, label, object, op, header, rows}; null when it has no rows. */
function makeLoad(key, rows) {
  if (!rows.length) return null;
  return checkTable({ key, ...LOADS[key], header: [...LOADS[key].header], rows });
}

const removalRows = (plan) => plan.items.flatMap((i) => (i.removals || []).map((r) => [r.id]));
function giveBackLoads(plan) {
  const sets = [];
  const groups = [];
  for (const i of plan.items) {
    for (const r of i.removals || []) {
      if (r.kind === "group") groups.push([i.userId, r.groupId]);
      else sets.push([i.userId, r.setId]);
    }
  }
  return [makeLoad("giveSet", sets), makeLoad("giveGroup", groups)].filter(Boolean);
}

/**
 * The steps to load, each with its tables: [{title, note, loads}]. Add is one step, Remove one, Move three. A step with no rows is
 * left out.
 */
export function changeSteps(plan) {
  if (plan.action === "add") return [{ title: "Add them to the configuration", note: "", loads: [makeLoad("add", plan.items.map((i) => [i.userId, plan.targetId]))].filter(Boolean) }];
  const del = makeLoad("delete", removalRows(plan));
  if (plan.action === "remove") return [{ title: "Take the permission away (delete the permission assignments)", note: HOW_REMOVE_WORKS, loads: [del].filter(Boolean) }];
  return [
    { title: "Step 1: take the permission away (delete the permission assignments)", note: HOW_REMOVE_WORKS, loads: [del].filter(Boolean) },
    { title: "Step 2: give the permission back", note: GIVE_BACK_NOTE, loads: giveBackLoads(plan) },
    { title: `Step 3: add them to ${plan.targetName}`, note: "", loads: [makeLoad("add", plan.items.map((i) => [i.userId, plan.targetId]))].filter(Boolean) },
  ];
}

/** The steps that reverse a Remove: give the permission back, then put them in their old configuration. Empty for Add and Move. */
export function undoSteps(plan) {
  if (plan.action !== "remove") return [];
  return [
    { title: "Undo step 1: give the permission back", note: GIVE_BACK_NOTE, loads: giveBackLoads(plan) },
    { title: "Undo step 2: put them back in their configuration", note: "", loads: [makeLoad("add", plan.items.flatMap((i) => (i.configs || []).map((c) => [i.userId, c.id])))].filter(Boolean) },
  ];
}

/** Tab-separated text with the API names as the first line: what Excel puts on the clipboard. */
export const tabText = (t) => [t.header, ...t.rows].map((r) => r.join("\t")).join("\n");
// toCsv starts with a byte order mark; Data Loader may then read the first header as "﻿Id", so the change files drop it.
export const csvText = (t) => toCsv([t.header, ...t.rows]).replace(/^﻿/, "");

const withText = (steps) => steps.map((s) => ({ ...s, loads: s.loads.map((l) => ({ ...l, text: tabText(l), csv: csvText(l) })) }));

/**
 * Everything the buttons need: {steps, undoSteps}, each step with `loads` (every load has `text` and `csv`). Throws until the
 * preview has been shown (`plan.previewed`), so no output exists before it. Null when there is nothing to load.
 */
export function outputFor(plan) {
  if (!plan?.previewed) throw new Error("Show the preview first.");
  if (plan.error) throw new Error(plan.error);
  const steps = withText(changeSteps(plan));
  if (!steps.some((s) => s.loads.length)) return null;
  return { steps, undoSteps: withText(undoSteps(plan)) };
}

/** A file name for the CSV (no names or users in it). `part` tells the tables of one change apart. */
export const changeFileName = (action, stamp, part = "") => `eac_${action}${part ? `_${part}` : ""}_${stamp}.csv`;

/** Copy text; on any failure (no clipboard, blocked, rejected) say so and the page shows the text to copy by hand. */
export async function copyWithFallback(text, clipboard) {
  try {
    if (!clipboard || typeof clipboard.writeText !== "function") return { copied: false };
    await clipboard.writeText(text);
    return { copied: true };
  } catch {
    return { copied: false };
  }
}
