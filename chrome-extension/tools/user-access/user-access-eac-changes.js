// Build Einstein Activity Capture changes as text (issue #42). Pure: no browser or network APIs, and nothing here writes to the org.
//
// The extension only READS. It prepares rows for the admin to load themselves: pasted into Salesforce Inspector's Data Import,
// or downloaded as a CSV for Data Loader. UserEmailCalendarSync fields (read-only describe in a sandbox):
//   Id               not createable, not updateable
//   AssignedId       createable and updateable: a 005 user or a 00e profile
//   ConfigurationId  createable and updateable: a 063 Id
//   ExternalId       left out
// The three changes:
//   Add     insert  AssignedId, ConfigurationId
//   Move    update  Id, ConfigurationId      (Id = the user's own assignment row)
//   Remove  delete  Id                       (describe says deletable=false, but Inspector deletes work; confirmed by the user)
// The output holds only API column names and Ids: never a name, username or email.

import { toCsv } from "../../shared/csv.js";
import { soqlString, chunk } from "../../shared/sfconn.js";
import { unnamedConfig, UNNAMED_CONFIG } from "./user-access-eac.js";

const id15 = (v) => (v ? String(v).slice(0, 15) : "");
const SAFE_ID = /^[A-Za-z0-9]{15,18}$/;
/** An Id that is valid AND real. Real orgs give every UserEmailCalendarSync row the placeholder 000000000000000AAA (all zeros in the first 15 characters). */
export const usableId = (v) => typeof v === "string" && SAFE_ID.test(v) && !/^0{15}/.test(v);
const num = (n) => Number(n).toLocaleString("en-US");
/** The key of a profile assignment row. Not its Id: in real orgs every row has the same placeholder Id. */
export const profileKey = (p) => `${id15(p.profileId)}|${id15(p.configId)}`;
const CONFIG_ID = /^063[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

export const MAX_PASTED = 500;
export const LOOKUP_BATCH = 50;

/** The three changes. `word` goes in every button label; `op` is Salesforce Inspector's Action. */
export const ACTIONS = {
  add: { value: "add", label: "Add to", word: "Add", op: "Insert", header: ["AssignedId", "ConfigurationId"], needsTarget: true },
  move: { value: "move", label: "Move to", word: "Move", op: "Update", header: ["Id", "ConfigurationId"], needsTarget: true },
  remove: { value: "remove", label: "Remove from its configuration", word: "Remove", op: "Delete", header: ["Id"], needsTarget: false },
};
export const ACTION_LIST = [ACTIONS.add, ACTIONS.move, ACTIONS.remove];
export const UNDO_HEADERS = { remove: { op: "Insert", header: ["AssignedId", "ConfigurationId"] }, move: { op: "Update", header: ["Id", "ConfigurationId"] } };

export const CONFIG_ID_HELP = "To use a configuration that has no users yet, copy its Id from Setup > Einstein Activity Capture > Configurations. It starts with 063 and is 15 or 18 characters long.";
export const CONFIG_ID_BAD = "That does not look like a configuration Id. It starts with 063 and has 15 or 18 letters and digits in all.";
export const CHANGE_WARNING = "This changes who captures email and calendar activity. Check the preview first.";
export const NO_UNDO_ADD = "To undo an add, read again and use Remove.";
export const AFTER_STEP = "Then click Show everyone again here to check the result.";
export const INSPECTOR_UNVERIFIED = "The menu words are how Salesforce Inspector names them, as far as we know. We have not checked them in your version.";
export const READ_ONLY_NOTE = "This page does not change anything in your org. You load the text yourself, in the step below.";

/** A typed configuration Id: 063 plus 12 or 15 letters or digits. Returns the trimmed Id, or null. */
export function validConfigId(text) {
  const t = String(text ?? "").trim();
  return CONFIG_ID.test(t) ? t : null;
}

/** The on-page steps for loading one change. `op` is Insert, Update or Delete. */
export function inspectorSteps(action) {
  const a = ACTIONS[action];
  if (!a) return [];
  return [
    "Open Salesforce Inspector, then Data Import.",
    `Action: ${a.op}.`,
    "Object: UserEmailCalendarSync.",
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
  noRealId: "Skipped: Salesforce gives this assignment no real Id",
  sameTarget: "Skipped: the same user is already moving from another row",
};
export const NO_REAL_ID_TEXT = "Salesforce gives this assignment no real Id (every row shows 000000000000000AAA), so it can't be moved or removed with Inspector. Use Setup for now.";
export const NO_REAL_ID_ALL = "Salesforce gives these assignments no real Id (every row shows 000000000000000AAA), so they can't be moved or removed with Inspector. Use Setup for now. Nothing was built.";
export const skipTitle = (code) => SKIP_TITLES[code] || "Skipped";

const names = (list) => [...new Set(list)].join(", ");

/**
 * Work out one change. Nothing is output yet: `previewed` stays false until the page has shown the preview.
 *   action        "add" | "move" | "remove"
 *   targetId      the configuration Id (a known one, or typed); not needed for Remove
 *   entries       the picked users (entryFrom...)
 *   profileItems  Remove only: profile assignment rows (from buildEacRows `profileRows`) to remove whole
 *   rows          buildEacRows rows
 *   notFound      pasted names that matched nobody (shown in the preview)
 */
export function planChange({ action, targetId = "", entries = [], profileItems = [], rows = [], notFound = [], configs = null } = {}) {
  const a = ACTIONS[action];
  const plan = { action, targetId: null, targetName: "", items: [], profileItems: [], skipped: [], notFound: [...notFound], duplicates: 0, error: "", previewed: false };
  if (!a) { plan.error = "Pick what to do: Add, Move or Remove."; return plan; }
  const known = configs || knownConfigs(rows);
  const nameOfConfig = (id) => known.find((c) => id15(c.id) === id15(id))?.name || (id ? unnamedConfig(id) : UNNAMED_CONFIG);
  if (a.needsTarget) {
    const tid = validConfigId(targetId);
    if (!tid) { plan.error = String(targetId ?? "").trim() ? CONFIG_ID_BAD : "Pick the configuration, or type its Id."; return plan; }
    plan.targetId = tid;
    plan.targetName = nameOfConfig(tid);
  }
  const t15 = id15(plan.targetId);

  const assignedRows = (userId) => rows.filter((r) => id15(r.userId) === id15(userId) && r.assigned);
  const skip = (e, code, detail = "") => plan.skipped.push({ name: e.name, code, detail });
  const goodUser = (e) => typeof e.userId === "string" && SAFE_ID.test(e.userId) && e.userId.startsWith("005");

  const done = new Set();
  const seenAsg = new Set();
  const movedUsers = new Set();
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

    // Move and Remove work on the user's own assignment rows.
    const own = e.configId ? all.filter((r) => id15(r.configId) === id15(e.configId)) : all;
    if (!own.length) { skip(e, "notIn"); continue; }
    if (action === "move" && inTarget) { skip(e, "alreadyThere"); continue; }
    const direct = own.filter((r) => r.direct);
    if (!direct.length) {
      skip(e, "profileOnly", own.map((r) => `${r.configuration} through the profile ${r.profiles.join(", ") || "(name not available)"}`).join("; "));
      continue;
    }
    const ids = direct.flatMap((r) => (r.assignmentIds || []).map((id) => ({ id, row: r })));
    if (direct.some((r) => !r.assignmentIds?.length) || ids.some((x) => !usableId(x.id) && SAFE_ID.test(x.id))) { skip(e, "noRealId", names(direct.map((r) => r.configuration))); continue; }
    if (action === "move" && ids.length > 1) { skip(e, "severalRows", names(direct.map((r) => r.configuration))); continue; }
    if (action === "remove" && !e.configId && new Set(direct.map((r) => id15(r.configId))).size > 1) { skip(e, "severalRows", names(direct.map((r) => r.configuration))); continue; }
    if (ids.some((x) => !SAFE_ID.test(x.id))) { skip(e, "badId"); continue; }
    if (action === "move" && movedUsers.has(id15(e.userId))) { skip(e, "sameTarget", names(direct.map((r) => r.configuration))); continue; }
    if (action === "move") movedUsers.add(id15(e.userId));
    const stillIn = own.filter((r) => r.profiles?.length);
    for (const { id, row } of ids) {
      if (seenAsg.has(id15(id))) { plan.duplicates++; continue; }
      seenAsg.add(id15(id));
      plan.items.push({
        userId: e.userId, name: e.name, assignmentId: id, fromConfigId: row.configId, fromName: row.configuration,
        note: action === "remove" && stillIn.length ? `Still in ${names(stillIn.map((r) => r.configuration))} through the profile ${names(stillIn.flatMap((r) => r.profiles))}.` : "",
      });
    }
  }

  if (action === "remove") {
    const seenProfile = new Set();
    for (const p of profileItems) {
      const pname = `Profile ${p.profileName || ""}`.trim();
      if (!p.id || (!usableId(p.id) && SAFE_ID.test(p.id))) { plan.skipped.push({ name: pname, code: "noRealId", detail: "" }); continue; }
      if (!SAFE_ID.test(p.id) || !SAFE_ID.test(p.profileId || "") || !SAFE_ID.test(p.configId || "")) {
        plan.skipped.push({ name: pname, code: "badId", detail: "" });
        continue;
      }
      if (seenProfile.has(id15(p.id))) { plan.duplicates++; continue; }
      seenProfile.add(id15(p.id));
      plan.profileItems.push({ id: p.id, profileId: p.profileId, profileName: p.profileName, configId: p.configId, configuration: p.configuration, members: p.members ?? null });
    }
  }
  return plan;
}

/** Users counted once, however many rows. */
export const planUserCount = (plan) => new Set(plan.items.map((i) => id15(i.userId))).size;

/** The skipped users, grouped by reason: [{code, title, entries: [{name, detail}]}]. */
export function skipGroups(plan) {
  const m = new Map();
  for (const s of plan.skipped) (m.get(s.code) || m.set(s.code, []).get(s.code)).push({ name: s.name, detail: s.detail });
  return [...m].map(([code, list]) => ({ code, title: skipTitle(code), entries: list }));
}

/** Plain words for the reason of a skip group, per action. */
export function skipHelp(action, code) {
  const t = {
    inactive: "An inactive user cannot be added.",
    alreadyThere: "They are already in the target configuration (directly or through a profile).",
    useMove: "Use Move for them, so they are not in two configurations.",
    profileOnly: action === "add"
      ? "They are in a configuration only through a profile, and adding them would put them in two. Change the profile's assignment in Setup."
      : action === "move"
        ? "They have no assignment row of their own, only the profile's, so they cannot be moved here. Change the profile's configuration in Setup."
        : "They have no assignment row of their own. The profile's assignment is removed in Setup, or as its own row in the list below.",
    notIn: action === "move" ? "They are in no configuration. Use Add for them." : "They are in no configuration, so there is nothing to remove.",
    severalRows: "They have more than one assignment of their own. Tick their row in the list for the one you mean.",
    noRealId: NO_REAL_ID_TEXT,
    sameTarget: "Only one assignment per user can go to the same configuration, so this row was left out. The user's other row was moved.",
    badId: "The Id is missing or does not look right.",
  };
  return t[code] || "";
}

/** True when there is nothing to load and every pick was skipped because its assignment has no real Id. */
export const allNoRealId = (plan) => !plan.items.length && !plan.profileItems.length && plan.skipped.length > 0 && plan.skipped.every((s) => s.code === "noRealId");

/** "N picks were the same assignment and are listed once", or "" when nothing repeated. */
export function duplicatesText(plan) {
  const n = plan.duplicates || 0;
  return n ? `${num(n)} ${n === 1 ? "pick was" : "picks were"} the same assignment and ${n === 1 ? "is" : "are"} listed once.` : "";
}

/** The sentence at the top of the preview. */
export function previewSummary(plan) {
  const a = ACTIONS[plan.action];
  if (!a || plan.error) return plan.error || "";
  if (allNoRealId(plan)) return NO_REAL_ID_ALL;
  const n = planUserCount(plan);
  const users = `${num(n)} ${n === 1 ? "user" : "users"}`;
  const parts = [];
  if (n || !plan.profileItems.length) {
    if (plan.action === "add") parts.push(`Add ${users} to ${plan.targetName}`);
    else if (plan.action === "move") parts.push(`Move ${users} to ${plan.targetName}`);
    else parts.push(`Remove ${users} from their configuration`);
  }
  if (plan.profileItems.length) parts.push(`remove ${num(plan.profileItems.length)} whole profile ${plan.profileItems.length === 1 ? "assignment" : "assignments"}`);
  const s = parts.join(" and ");
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}

// ---------- the text to load ----------

const checkTable = (t) => {
  for (const row of t.rows) for (const c of row) if (!usableId(c)) throw new Error("An Id does not look right, so no text was built.");
  const seen = new Set();
  t.rows = t.rows.filter((r) => { const k = r.map(id15).join("|"); if (seen.has(k)) return false; seen.add(k); return true; });
  return t;
};

/** The rows of the change itself: {op, header, rows}. */
export function changeTable(plan) {
  const a = ACTIONS[plan.action];
  let rows;
  if (plan.action === "add") rows = plan.items.map((i) => [i.userId, plan.targetId]);
  else if (plan.action === "move") rows = plan.items.map((i) => [i.assignmentId, plan.targetId]);
  else rows = [...plan.items.map((i) => [i.assignmentId]), ...plan.profileItems.map((p) => [p.id])];
  return checkTable({ op: a.op, header: [...a.header], rows });
}

/** The rows that reverse a Remove or a Move; null for Add (its new Ids exist only after the load). */
export function undoTable(plan) {
  const u = UNDO_HEADERS[plan.action];
  if (!u) return null;
  let rows;
  if (plan.action === "remove") rows = [...plan.items.map((i) => [i.userId, i.fromConfigId]), ...plan.profileItems.map((p) => [p.profileId, p.configId])];
  else rows = plan.items.map((i) => [i.assignmentId, i.fromConfigId]);
  return checkTable({ op: u.op, header: [...u.header], rows });
}

/** Tab-separated text with the API names as the first line: what Excel puts on the clipboard. */
export const tabText = (t) => [t.header, ...t.rows].map((r) => r.join("\t")).join("\n");
// toCsv starts with a byte order mark; Data Loader may then read the first header as "\uFEFFId", so the change files drop it.
export const csvText = (t) => toCsv([t.header, ...t.rows]).replace(/^\uFEFF/, "");

/**
 * Everything the buttons need. Throws until the preview has been shown (`plan.previewed`), so no output exists before it.
 */
export function outputFor(plan) {
  if (!plan?.previewed) throw new Error("Show the preview first.");
  if (plan.error) throw new Error(plan.error);
  const change = changeTable(plan);
  if (!change.rows.length) return null;
  const undo = undoTable(plan);
  return { change, text: tabText(change), csv: csvText(change), undo, undoText: undo ? tabText(undo) : "", undoCsv: undo ? csvText(undo) : "" };
}

/** A file name for the CSV (no names or users in it). */
export const changeFileName = (action, stamp) => `eac_${action}_${stamp}.csv`;

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
