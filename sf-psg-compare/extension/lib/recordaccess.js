// "Why can a user see this record?" Pure reasoning: no browser, no network.
//
// `explain(facts)` takes facts gathered from the org by recordaccessread.js (schema
// "sf-record-access/1") and works out every route that gives each user access, written as a short
// chain of plain steps. The verdict is NEVER worked out here: it comes only from Salesforce's own
// UserRecordAccess answer in `user.sf`. Routes are our explanation; when they do not match
// Salesforce's answer the result says so (`mismatch`) and lists likely causes, never a guess as fact.

export const ACCESS_SCHEMA = "sf-record-access/1";

// ---------- record Ids and links ----------

const ID_RE = /^(?:[a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})$/;

/** A Salesforce Id: 15 or 18 letters and digits, with at least one digit (so "ProductConsumed" is not an Id). */
export function looksLikeId(s) {
  return typeof s === "string" && ID_RE.test(s) && /\d/.test(s);
}

/** The 18-character form of an Id (the check letters are worked out from the capitals of the 15). */
export function to18(id) {
  if (typeof id !== "string" || id.length !== 15) return id;
  let suffix = "";
  for (let i = 0; i < 3; i++) {
    let n = 0;
    for (let j = 0; j < 5; j++) {
      const c = id[i * 5 + j];
      if (c >= "A" && c <= "Z") n |= 1 << j;
    }
    suffix += "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"[n];
  }
  return id + suffix;
}

const k = (id) => String(id || "").slice(0, 15); // compare Ids by their first 15 characters

/** The record Id in a Salesforce page address, or null. Also accepts a bare Id.
 *  Lightning (/lightning/r/<Object>/<Id>/view, /lightning/r/<Id>/view), Classic (/<Id>), console and
 *  older Lightning addresses (Id in the # part). Setup pages and list pages give null. */
export function recordIdFromUrl(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (looksLikeId(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const path = u.pathname.split("/").filter(Boolean);
  const first = (path[0] || "").toLowerCase();
  if (first === "lightning") {
    if ((path[1] || "").toLowerCase() !== "r") return null; // lists (o), Setup, pages, apps
    const rest = path.slice(2);
    if (looksLikeId(rest[1])) return rest[1]; // /r/<Object>/<Id>/...
    if (looksLikeId(rest[0])) return rest[0]; // /r/<Id>/...
    return null;
  }
  if (first === "setup") return null;
  if (first === "console" || first === "one") { // classic console, older Lightning: the Id is after the #
    let hash = u.hash;
    try { hash = decodeURIComponent(hash); } catch { /* keep as is */ }
    const hit = hash.split("/").find((p) => looksLikeId(p));
    return hit || null;
  }
  if (path.length >= 1 && path.length <= 2 && looksLikeId(path[0])) return path[0]; // Classic: /001..., /001.../e
  return null;
}

// ---------- levels ----------

const ORDER = ["none", "view", "edit", "full"];
const rank = (l) => Math.max(0, ORDER.indexOf(l));
const tier = (l) => Math.min(rank(l), 2); // edit and full count as the same when checking Salesforce's answer
const higher = (a, b) => (rank(a) >= rank(b) ? a : b);
const lower = (a, b) => (rank(a) <= rank(b) ? a : b);

export const LEVEL_PHRASE = {
  none: "can't see this record",
  view: "can view this record",
  edit: "can edit this record",
  full: "has full access to this record",
};
const LEVEL_SHORT = { none: "can't see it", view: "can view it", edit: "can edit it", full: "has full access to it" };
const SAME_TEXT = {
  none: "Neither user can see this record.",
  view: "Both users can view this record.",
  edit: "Both users can edit this record.",
  full: "Both users have full access to this record.",
};
const GIVES = { view: "view access", edit: "edit access", full: "full access" };

/** What the user can actually do, from Salesforce's own answer (UserRecordAccess): none / view / edit / full;
 *  null when it was not read. "All" counts as full only when the user can also edit and delete (object
 *  permissions can hold a user back even when sharing gives everything). */
export function sfLevel(sf) {
  if (!sf) return null;
  if (!(sf.read || sf.all)) return "none";
  if (!sf.edit) return "view";
  return sf.all && sf.delete ? "full" : "edit";
}

/** What sharing alone gives, from the same answer (HasAllAccess counts, even when the user cannot edit). */
export function sfShareLevel(sf) {
  if (!sf) return null;
  if (sf.all) return "full";
  if (sf.edit) return "edit";
  if (sf.read) return "view";
  return "none";
}

/** Plain-words examples for a list, used in "N members". */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Exact name match first, the rest in their order. */
export function exactFirst(users, text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return users;
  const hit = (u) => String(u.name || "").trim().toLowerCase() === t || String(u.username || "").trim().toLowerCase() === t;
  return [...users.filter(hit), ...users.filter((u) => !hit(u))];
}

/** A share row's access level ("Read", "Edit", "All") as view / edit / full; null when not recognised. */
export function shareLevel(s) {
  const v = String(s || "").toLowerCase();
  if (v === "read") return "view";
  if (v === "edit" || v === "readwrite") return "edit";
  if (v === "all" || v === "full") return "full";
  return null;
}

/** Org-wide default as a level for everyone; null when it gives nothing (Private) or is not recognised. */
function owdLevel(model) {
  switch (model) {
    case "Read": case "ReadSelect": case "ReadOnly": return "view";
    case "ReadWrite": case "ReadWriteTransfer": return "edit";
    case "FullAccess": return "full";
    default: return null;
  }
}

/** The org-wide default in plain words. */
export function owdText(model, plural) {
  const P = plural || "Records";
  switch (model) {
    case "Private": return `${P} are Private: only the owner, people above them in the role hierarchy and people it is shared with can see them.`;
    case "Read": return `${P} are Public Read Only: everyone can see them, but only the owner, people above them and people it is shared with can edit them.`;
    case "ReadWrite": return `${P} are Public Read/Write: everyone can see and edit them.`;
    case "ReadWriteTransfer": return `${P} are Public Read/Write/Transfer: everyone can see, edit and transfer them.`;
    case "FullAccess": return `${P} are Public Full Access: everyone can see, edit and delete them.`;
    case "ControlledByParent": return `${P} get their access from the record they belong to (their parent). Usually, whoever can't see the parent can't see them, but seeing the parent is not always enough: some kinds, such as tasks and events, can also depend on the other records they are linked to.`;
    case undefined: case null: case "": return "The org-wide default could not be read.";
    default: return `The org-wide default for ${P.toLowerCase()} is "${model}".`;
  }
}

// ---------- row causes ----------

const TEAM_WORD = { Account: "account team", Opportunity: "opportunity team", Case: "case team" };

/** What a share row's RowCause means, in plain words. `phrase` is the start of a sentence ("... with X"). */
export function causeInfo(code, objectApi) {
  const c = String(code || "");
  switch (c) {
    case "Owner": return { kind: "owner", phrase: "Owned" };
    case "Manual": return { kind: "manual", phrase: "Shared manually" };
    case "Rule": return { kind: "rule", phrase: "Shared by a sharing rule" };
    case "Team": return { kind: "team", phrase: `Shared through the ${TEAM_WORD[objectApi] || "record team"}` };
    case "ImplicitChild": return { kind: "implicit", phrase: "Shared implicitly", why: "through access to a child record of this record" };
    case "ImplicitParent": return { kind: "implicit", phrase: "Shared implicitly", why: "through access to a related record (the parent of this record)" };
    default:
      if (/territor/i.test(c)) return { kind: "territory", phrase: "Shared through territory assignment" };
      if (/__c$/.test(c)) return { kind: "apex", phrase: `Shared by the Apex sharing reason '${c.replace(/__c$/, "").replace(/_/g, " ")}'` };
      return { kind: "unknown", phrase: `Shared (reason code '${c}')` };
  }
}

// ---------- the facts, indexed ----------

/** Display names for territories: a name used more than once is told apart by where it sits ("EM (under EMEA Region)"),
 *  and by the whole path when that is still not enough. Never by name alone. */
function territoryNames(items) {
  const byId = new Map(items.map((t) => [k(t.id), t]));
  const count = new Map();
  for (const t of items) count.set(t.name, (count.get(t.name) || 0) + 1);
  const path = (t) => {
    const parts = [t.name];
    const seen = new Set([k(t.id)]);
    let cur = byId.get(k(t.parentId));
    while (cur && !seen.has(k(cur.id))) { parts.unshift(cur.name); seen.add(k(cur.id)); cur = byId.get(k(cur.parentId)); }
    return parts;
  };
  const first = new Map();
  for (const t of items) {
    if (count.get(t.name) < 2) { first.set(k(t.id), t.name); continue; }
    const par = byId.get(k(t.parentId));
    first.set(k(t.id), par ? `${t.name} (under ${par.name})` : `${t.name} (top level)`);
  }
  const used = new Map();
  for (const v of first.values()) used.set(v, (used.get(v) || 0) + 1);
  const out = new Map();
  for (const t of items) {
    const v = first.get(k(t.id));
    out.set(k(t.id), used.get(v) > 1 ? `${t.name} (path: ${path(t).join(" > ")})` : v);
  }
  // Whole paths that are still the same (identical names all the way up): number them.
  const again = new Map();
  for (const v of out.values()) again.set(v, (again.get(v) || 0) + 1);
  const seenNo = new Map();
  for (const t of [...items].sort((x, y) => (k(x.id) < k(y.id) ? -1 : 1))) {
    const v = out.get(k(t.id));
    if (again.get(v) > 1) { const n = (seenNo.get(v) || 0) + 1; seenNo.set(v, n); out.set(k(t.id), `${v.replace(/\)$/, "")}, ${n} of ${again.get(v)})`); }
  }
  return out;
}

function buildCtx(facts) {
  const rec = facts.record || {};
  const roles = new Map((facts.roles || []).map((r) => [k(r.id), r]));
  const terrs = new Map((facts.territories?.items || []).map((t) => [k(t.id), t]));
  const groups = new Map((facts.groups || []).map((g) => [k(g.id), g]));
  const shareUsers = new Map((facts.shareUsers || []).map((u) => [k(u.id), u]));
  const memberRoles = new Map(Object.entries(facts.memberRoles || {}).map(([id, v]) => [k(id), v]));
  const terrNames = territoryNames(facts.territories?.items || []);
  return {
    facts, rec, roles, terrs, groups, shareUsers, memberRoles,
    permsApply: facts.object?.permissionsApply !== false,
    plural: facts.object?.plural || facts.object?.label || "records",
    label: facts.object?.label || "record",
    api: facts.object?.api || rec.object || "",
    hierarchy: facts.object?.grantByHierarchy !== false,
    ownerName: rec.ownerName || "the owner",
    roleName: (id) => roles.get(k(id))?.name || "a role",
    terrName: (id) => terrNames.get(k(id)) || "a territory",
  };
}

/** Ids strictly above `id` (parent, grandparent, ...), cycle-safe. */
function above(map, id) {
  const out = [];
  const seen = new Set([k(id)]);
  let cur = map.get(k(id));
  while (cur && cur.parentId) {
    const p = k(cur.parentId);
    if (seen.has(p)) break;
    seen.add(p);
    out.push(p);
    cur = map.get(p);
  }
  return out;
}

const isInternal = (u) => !u.userType || u.userType === "Standard";

function groupName(g, ctx) {
  if (/^Role/.test(g.type)) return ctx.roles.get(k(g.relatedId))?.name || g.name || "a role";
  if (/^Territory/.test(g.type)) return ctx.terrs.has(k(g.relatedId)) ? ctx.terrName(g.relatedId) : g.name || "a territory";
  return g.name || g.developerName || "a group";
}

/** "public group 'X'", "role 'R' and the roles below it", ... */
export function groupLabel(g, ctx) {
  const n = groupName(g, ctx);
  switch (g.type) {
    case "Regular": return `public group '${n}'`;
    case "Queue": return `queue '${n}'`;
    case "Role": return `role '${n}'`;
    case "RoleAndSubordinates": return `role '${n}' and the roles below it`;
    case "RoleAndSubordinatesInternal": return `role '${n}' and the roles below it (internal users)`;
    case "Territory": return `territory '${n}'`;
    case "TerritoryAndSubordinates": return `territory '${n}' and the territories below it`;
    case "Organization": return "all internal users";
    default: return `group '${n}' (type ${g.type})`;
  }
}

/** For one user: every group they are in (directly or through other groups, their role, their territories),
 *  with how they get there. Map of group key -> {kind: user | role | territory | organization | group, ...}. */
function computeReach(u, ctx) {
  const via = new Map();
  const roleChain = u.roleId ? [k(u.roleId), ...above(ctx.roles, u.roleId)] : [];
  const terrChain = new Map(); // territory key (the user's or one above it) -> the user's territory it comes from
  for (const t of u.territoryIds || []) {
    terrChain.set(k(t), k(t));
    for (const a of above(ctx.terrs, t)) if (!terrChain.has(a)) terrChain.set(a, k(t));
  }
  const queue = [];
  const add = (gk, v) => { if (!via.has(gk)) { via.set(gk, v); queue.push(gk); } };

  for (const e of u.memberOf || []) if (k(e.memberId) === k(u.id)) add(k(e.groupId), { kind: "user" });
  for (const g of ctx.groups.values()) {
    const rel = k(g.relatedId);
    const gk = k(g.id);
    if (g.type === "Role" && u.roleId && rel === k(u.roleId)) add(gk, { kind: "role" });
    else if (/^RoleAndSubordinates/.test(g.type) && roleChain.includes(rel)) add(gk, { kind: "role" });
    else if (g.type === "Territory" && terrChain.get(rel) === rel) add(gk, { kind: "territory", territoryId: rel });
    else if (g.type === "TerritoryAndSubordinates" && terrChain.has(rel)) add(gk, { kind: "territory", territoryId: terrChain.get(rel) });
    else if (g.type === "Organization" && isInternal(u)) add(gk, { kind: "organization" });
  }
  const parents = new Map(); // member key -> [group key]
  for (const e of u.memberOf || []) {
    const m = k(e.memberId);
    if (!parents.has(m)) parents.set(m, []);
    parents.get(m).push(k(e.groupId));
  }
  // Breadth-first, so the path kept for each group is the shortest. The visited map makes loops harmless.
  for (let i = 0; i < queue.length; i++) {
    for (const p of parents.get(queue[i]) || []) add(p, { kind: "group", from: queue[i] });
  }
  return via;
}

/** Steps from a group the record is shared with down to the user. */
function chainSteps(gk, u, name, via, ctx) {
  const path = [gk];
  const seen = new Set(path);
  while (via.get(path.at(-1))?.kind === "group") {
    const next = via.get(path.at(-1)).from;
    if (seen.has(next)) break;
    seen.add(next);
    path.push(next);
  }
  const grp = (key) => ctx.groups.get(key) || { type: "Regular", name: "a group" };
  const steps = [];
  for (let i = 0; i < path.length - 1; i++) steps.push(`${cap(groupLabel(grp(path[i]), ctx))} includes ${groupLabel(grp(path[i + 1]), ctx)}`);
  const seed = path.at(-1);
  const v = via.get(seed) || {};
  const sg = grp(seed);
  if (v.kind === "user") steps.push(`${name} is a direct member of ${groupLabel(sg, ctx)}`);
  else if (v.kind === "role") {
    const rel = k(sg.relatedId);
    steps.push(rel === k(u.roleId) ? `${name}'s role is '${ctx.roleName(rel)}'` : `${name}'s role '${u.roleName || ctx.roleName(u.roleId)}' is below '${ctx.roleName(rel)}'`);
  } else if (v.kind === "territory") {
    const rel = k(sg.relatedId);
    steps.push(rel === v.territoryId ? `${name} is assigned to territory '${ctx.terrName(rel)}'` : `${name} is assigned to territory '${ctx.terrName(v.territoryId)}', which is below '${ctx.terrName(rel)}'`);
  } else if (v.kind === "organization") steps.push(`${name} is an internal user`);
  return steps;
}

const CHILD_WORDS = { Opportunity: ["opportunity", "opportunities"], Case: ["case", "cases"], Contact: ["contact", "contacts"] };
const childParts = (counts) => Object.entries(counts).filter(([, n]) => n > 0).map(([o, n]) => `${n} ${(CHILD_WORDS[o] || [o.toLowerCase(), `${o.toLowerCase()}s`])[n === 1 ? 0 : 1]}`);

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------- object access ----------

function objectFlags(u, ctx) {
  // Some objects (Task, Event, ...) have no object permissions at all: a missing row there means "unknown", not "none".
  if (ctx && !ctx.permsApply) return null;
  if (!u.object || !Array.isArray(u.object.sets)) return null;
  const f = { read: [], edit: [], delete: [], viewAll: [], modifyAll: [], viewAllData: [], modifyAllData: [] };
  for (const s of u.object.sets) {
    for (const key of Object.keys(f)) if (s[key]) f[key].push(s);
  }
  return f;
}

const setLabel = (s) => `${s.kind === "profile" ? "profile" : s.kind === "group" ? "permission set group" : "permission set"} '${s.name}'`;
const listLabel = (sets) => {
  const uniq = [...new Set(sets.map(setLabel))];
  return uniq.length <= 1 ? uniq[0] || "" : `${uniq.slice(0, -1).join(", ")} and ${uniq.at(-1)}`;
};

/** The most the user's object permissions allow: none (no Read at all), view, edit or full. null when not read.
 *  Like Salesforce, full access to a record needs Edit and Delete on the object (or Modify All). Edit without
 *  Delete is "edit": the user can change the record but not delete it. */
function objectCap(flags) {
  if (!flags) return null;
  if (flags.modifyAll.length || flags.modifyAllData.length) return "full";
  if (flags.edit.length && flags.delete.length) return "full";
  if (flags.edit.length) return "edit";
  if (flags.read.length || flags.viewAll.length || flags.viewAllData.length) return "view";
  return "none";
}

// ---------- routes ----------

function uniqueNames(users) {
  const names = users.map((u) => u.name);
  return names.map((n, i) => (names.indexOf(n) !== i || names.lastIndexOf(n) !== i ? `${n} (${users[i].username || users[i].id})` : n));
}

/** Members of a group (or queue) whose role is below the user's role, from the facts. null when none or not read. */
function membersBelow(u, gid, ctx) {
  const m = ctx.memberRoles.get(k(gid));
  if (!m || !u.roleId) return null;
  const mine = k(u.roleId);
  const hits = [];
  for (const r of m.roles || []) {
    const i = r.roleId ? above(ctx.roles, r.roleId).indexOf(mine) : -1;
    if (i >= 0) hits.push({ ...r, dist: i });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.dist - b.dist);
  return { example: hits[0], total: hits.reduce((n, r) => n + (r.count || 1), 0) };
}

const memberStep = (hit, where, ctx) =>
  `Member '${hit.example.example || "a user"}' (role '${ctx.roleName(hit.example.roleId)}') is in ${where}, directly or through other groups` +
  (hit.total > 1 ? `; ${plural(hit.total - 1, "other member has", "other members have")} a role below this user's too` : "");

/** Routes that share a topic are the same way in (a group's share row reached as a member or as a manager,
 *  the record's territory reached through a share row or through the territory list), so the other user
 *  is only called "missing" it when they have none of them. */
function shareTopic(target, gk, cause) {
  if (/^Territory/.test(target.type)) return `territory:${target.type}:${k(target.relatedId)}`;
  return `shareGroup:${gk}:${cause}`;
}

const ACCT_CHILD = { Case: "cases", Opportunity: "opportunities" };

/** Cases and Opportunities with an account: what the account's own sharing gives to them. null otherwise. */
function acctScope(ctx) {
  const a = ctx.facts.account;
  const many = ACCT_CHILD[ctx.api];
  if (!many || !a || !a.id) return null;
  const name = a.name || "the account";
  return { key: "acct:", many, name, rows: a.rows || [], lead: `The ${ctx.label.toLowerCase()} belongs to account '${name}'` };
}

function routesFor(u, name, ctx, sf) {
  const routes = [];
  const notes = [];
  const flags = objectFlags(u, ctx);
  let capLevel = flags ? objectCap(flags) : "full";
  // Safety net: Salesforce says the user can see the record, so "no Read on the object" cannot be the reason.
  if (capLevel === "none" && sf && sf !== "none") {
    notes.push(`We found no Read access to ${ctx.plural} for ${name} in the profile or permission sets, yet Salesforce says ${name} can see this record. Object permissions were not used to limit the routes below.`);
    capLevel = "full";
  }
  const gate = capLevel === "none";
  const rec = ctx.rec;
  const add = (r) => {
    const raw = r.access;
    const known = raw !== null && raw !== undefined;
    const base = known ? raw : "view";
    const effective = lower(base, capLevel);
    const prior = routes.find((x) => x.key === r.key);
    const route = { ...r, access: known ? raw : null, effective, limited: known && rank(effective) < rank(raw) };
    if (prior) { if (rank(effective) > rank(prior.effective)) routes[routes.indexOf(prior)] = route; return; }
    routes.push(route);
  };
  if (gate) return { routes, gate, cap: capLevel, notes };

  const via = computeReach(u, ctx);
  const uk = k(u.id);

  // Owner, queue owner, role above the owner. For objects without object permissions (Task, Event) what an owner may do
  // follows the related record, so the level is not known.
  const ownerLevel = ctx.permsApply ? "full" : null;
  if (rec.ownerKind === "user" && k(rec.ownerId) === uk) {
    add({ key: "owner", kind: "owner", access: ownerLevel, summary: "Owner", steps: [`${name} owns this record`], detail: { type: "owner" } });
  } else if (rec.ownerKind === "queue" && rec.ownerId && via.has(k(rec.ownerId))) {
    const g = ctx.groups.get(k(rec.ownerId)) || { type: "Queue", name: rec.ownerName };
    add({
      key: "ownerQueue", topic: "ownerQueue", kind: "owner", access: ownerLevel, summary: `Owner queue '${rec.ownerName}'`,
      steps: [`The record is owned by queue '${rec.ownerName}'`, ...chainSteps(k(rec.ownerId), u, name, via, ctx)],
      detail: { type: "ownerQueue", name: rec.ownerName, group: g },
    });
  } else if (rec.ownerKind === "queue" && rec.ownerId && u.roleId && ctx.hierarchy) {
    // Role hierarchy over a queue owner: someone above a queue member gets what the queue gets.
    const hit = membersBelow(u, rec.ownerId, ctx);
    const r = hit ? ctx.roleName(hit.example.roleId) : "";
    if (hit) {
      add({
        key: "ownerQueueBoss", topic: "ownerQueue", kind: "hierarchy", access: ownerLevel, summary: `Role above a member of the owner queue`,
        steps: [
          `The record is owned by queue '${rec.ownerName}'`,
          memberStep(hit, `queue '${rec.ownerName}'`, ctx),
          `${name}'s role '${u.roleName || ctx.roleName(u.roleId)}' is above '${r}' in the role hierarchy`,
        ],
        detail: { type: "ownerQueueBoss", name: rec.ownerName },
      });
    } else if (ctx.memberRoles.get(k(rec.ownerId))?.capped) {
      notes.push(`Queue '${rec.ownerName}' has many members, so only some were checked for a role-above route for ${name}.`);
    }
  }
  if (rec.ownerKind === "user" && rec.ownerRoleId && u.roleId && k(rec.ownerId) !== uk && ctx.hierarchy && above(ctx.roles, rec.ownerRoleId).includes(k(u.roleId))) {
    const ownerRole = ctx.roleName(rec.ownerRoleId);
    add({
      key: "ownerRole", kind: "hierarchy", access: ownerLevel, summary: `Role above the owner's role`,
      steps: [`The record is owned by ${ctx.ownerName}`, `${ctx.ownerName}'s role is '${ownerRole}'`, `${name}'s role '${u.roleName || ctx.roleName(u.roleId)}' is above '${ownerRole}' in the role hierarchy`],
      detail: { type: "ownerRole", ownerRole },
    });
  }

  // Share rows: the record's own, then (Cases and Opportunities) the rows of its account.
  const sharedTerritoryRoute = { found: false };
  const acct = acctScope(ctx);
  const shareRows = (rows, sc) => {
    const teamRole = sc ? u.accountTeamRole || null : u.teamRole || null;
    const P = sc ? sc.key : "";
    const lead = (steps) => (sc ? [sc.lead, ...steps] : steps);
    const extra = sc ? { acct: true } : {};
    const levelNote = (level) => (sc && level ? `, which gives ${GIVES[level] || "access"} to the account's ${sc.many}` : "");
    for (const row of rows) {
      const info = causeInfo(row.cause, sc ? "Account" : ctx.api);
      if (info.kind === "owner") continue; // the owner has their own route
      if (sc && /^none$/i.test(String(row.level || ""))) continue; // the account gives nothing to its cases or opportunities here
      const level = shareLevel(row.level);
      const who = k(row.who);
      const phrase = sc ? `The account is ${info.phrase[0].toLowerCase()}${info.phrase.slice(1)}` : info.phrase;
      const withWho = (target) => `${phrase} with ${target}${info.why ? `, ${info.why}` : ""}${levelNote(level)}`;
      if (who === uk) {
        let steps = [withWho(name)];
        if (info.kind === "team") steps = [teamRole ? `${name} is on the ${sc ? "account team" : TEAM_WORD[ctx.api] || "record team"} as '${teamRole}'${levelNote(level)}` : withWho(name)];
        if (!sc && info.kind === "implicit" && u.childCounts) {
          const parts = childParts(u.childCounts);
          if (parts.length) steps = [`${name} owns ${parts.join(", ")} on this ${ctx.label.toLowerCase()}, so Salesforce gives ${name} implicit access to it`];
        }
        if (!sc && info.kind === "territory") sharedTerritoryRoute.found = true;
        add({ key: `${P}share:${who}:${row.cause}`, topic: `${P}shareUser:${row.cause}`, kind: info.kind, access: level, summary: withWho(name), steps: lead(steps), detail: { type: "shareUser", cause: info.kind, ...extra } });
        continue;
      }
      const target = ctx.groups.get(who);
      if (!target) {
        const other = ctx.shareUsers.get(who);
        if (other && ctx.hierarchy && other.roleId && u.roleId && above(ctx.roles, other.roleId).includes(k(u.roleId))) {
          add({
            key: `${P}shareBoss:${who}:${row.cause}`, kind: "hierarchy", access: level, summary: `${withWho(other.name)}, who is below ${name} in the role hierarchy`,
            steps: lead([withWho(other.name), `${other.name}'s role is '${ctx.roleName(other.roleId)}'`, `${name}'s role '${u.roleName || ctx.roleName(u.roleId)}' is above '${ctx.roleName(other.roleId)}' in the role hierarchy`]),
            detail: { type: "shareBoss", who: other.name, whoId: other.id, whoRole: ctx.roleName(other.roleId), ...extra },
          });
        }
        continue;
      }
      const gk = k(target.id);
      if (via.has(gk)) {
        if (!sc && info.kind === "territory") sharedTerritoryRoute.found = true;
        add({
          key: `${P}share:${gk}:${row.cause}`, topic: P + shareTopic(target, gk, row.cause), kind: info.kind, access: level, summary: withWho(groupLabel(target, ctx)),
          steps: lead([withWho(groupLabel(target, ctx)), ...chainSteps(gk, u, name, via, ctx)]),
          detail: { type: "shareGroup", group: target, cause: info.kind, ...extra },
        });
      } else if (/^Role/.test(target.type) && ctx.hierarchy && u.roleId && above(ctx.roles, target.relatedId).includes(k(u.roleId))) {
        const r = ctx.roleName(target.relatedId);
        add({
          key: `${P}shareBoss:${gk}:${row.cause}`, topic: P + shareTopic(target, gk, row.cause), kind: "hierarchy", access: level, summary: `${withWho(groupLabel(target, ctx))}, and ${name}'s role is above it`,
          steps: lead([withWho(groupLabel(target, ctx)), `${name}'s role '${u.roleName || ctx.roleName(u.roleId)}' is above '${r}' in the role hierarchy`]),
          detail: { type: "shareBoss", who: groupLabel(target, ctx), whoRole: r, group: target, ...extra },
        });
      } else if (target.type === "Regular" && target.includeBosses) {
        const mr = ctx.memberRoles.get(gk);
        const hit = ctx.hierarchy ? membersBelow(u, gk, ctx) : null;
        const bossWord = sc ? ", and it also gives access to managers" : ", which also gives access to managers";
        if (hit) {
          const r = ctx.roleName(hit.example.roleId);
          add({
            key: `${P}shareBossGroup:${gk}:${row.cause}`, topic: P + shareTopic(target, gk, row.cause), kind: "hierarchy", access: level,
            summary: `${withWho(groupLabel(target, ctx))}${bossWord}`,
            steps: lead([
              `${withWho(groupLabel(target, ctx))}${bossWord}`,
              memberStep(hit, "that group", ctx),
              `${name}'s role '${u.roleName || ctx.roleName(u.roleId)}' is above '${r}' in the role hierarchy`,
            ]),
            detail: { type: "shareBossGroup", group: target, ...extra },
          });
        } else if (!mr) {
          notes.push(`The ${sc ? "account" : "record"} is shared with public group '${groupName(target, ctx)}', which also reaches the managers of its members. Its members could not be read, so that was not checked for ${name}.`);
        } else if (mr.capped) {
          notes.push(`Public group '${groupName(target, ctx)}' also reaches the managers of its members, but it has many members, so only some were checked for ${name}. A manager route may have been missed.`);
        }
      } else if (/^Manager/.test(target.type)) {
        notes.push(`The ${sc ? "account" : "record"} is shared with a manager group (${target.type}). That kind of group was not checked for ${name}.`);
      }
    }
  };
  shareRows(ctx.facts.shares?.rows || [], null);
  if (acct) {
    shareRows(acct.rows, acct);
    // The account's owner: their role's setting for account owners gives them access to the account's cases or opportunities.
    const ow = ctx.facts.account?.owner;
    const ownerLevel2 = ow && ow.id ? shareLevel(ow.level) : null; // "None" and unknown give no route
    if (ownerLevel2) {
      const ownerRoleName = ow.roleId ? ctx.roleName(ow.roleId) : "";
      const setting = (who, role) => `${who}'s role${role ? ` '${role}'` : ""} gives account owners ${GIVES[ownerLevel2]} to the account's ${acct.many}`;
      if (k(ow.id) === uk) {
        add({
          key: "acct:owner", topic: "acct:owner", kind: "owner", access: ownerLevel2, summary: `Owner of the account '${acct.name}'`,
          steps: [acct.lead, `${name} owns the account`, setting(name, u.roleName || ownerRoleName)],
          detail: { type: "acctOwner", acct: true },
        });
      } else if (ctx.hierarchy && ow.roleId && u.roleId && above(ctx.roles, ow.roleId).includes(k(u.roleId))) {
        add({
          key: "acct:ownerRole", topic: "acct:owner", kind: "hierarchy", access: ownerLevel2, summary: "Role above the account owner's role",
          steps: [acct.lead, `The account is owned by ${ow.name || "someone"}`, setting(ow.name || "The owner", ownerRoleName), `${name}'s role '${u.roleName || ctx.roleName(u.roleId)}' is above '${ownerRoleName}' in the role hierarchy`],
          detail: { type: "acctOwnerRole", ownerRole: ownerRoleName, ownerId: ow.id, ownerName: ow.name || "the account owner", acct: true },
        });
      }
    }
  }

  // Territory (Accounts): the record is in a territory the user is assigned to, or one above it.
  if (!sharedTerritoryRoute.found && ctx.facts.territories?.on) {
    for (const rt of ctx.facts.territories.record || []) {
      const chain = [k(rt.id), ...above(ctx.terrs, rt.id)];
      const mine = (u.territoryIds || []).map(k).find((t) => chain.includes(t));
      if (!mine) continue;
      const how = /rule/i.test(rt.cause || "") ? "by an assignment rule" : /manual/i.test(rt.cause || "") ? "added manually" : null;
      // The level comes from the territory share rows on the record (the group of this territory first, then any territory row).
      const terrRows = [];
      for (const row of ctx.facts.shares?.rows || []) {
        if (causeInfo(row.cause, ctx.api).kind !== "territory") continue;
        const g = ctx.groups.get(k(row.who));
        if (g && /^Territory/.test(g.type)) terrRows.push({ level: shareLevel(row.level), own: k(g.relatedId) === k(rt.id) });
      }
      const pickRows = terrRows.some((x) => x.own) ? terrRows.filter((x) => x.own) : terrRows;
      const terrLevel = pickRows.reduce((m, x) => (x.level && (m === null || rank(x.level) > rank(m)) ? x.level : m), null);
      add({
        key: `territory:${k(rt.id)}`, topic: `territory:Territory:${k(rt.id)}`, kind: "territory", access: terrLevel,
        summary: `The record is in territory '${ctx.terrName(rt.id)}'${how ? ` (${how})` : ""}`,
        steps: [
          `The record is in territory '${ctx.terrName(rt.id)}'${how ? ` (${how})` : ""}`,
          mine === k(rt.id) ? `${name} is assigned to territory '${ctx.terrName(mine)}'` : `${name} is assigned to territory '${ctx.terrName(mine)}', which is above '${ctx.terrName(rt.id)}'`,
        ],
        detail: { type: "territory", name: ctx.terrName(rt.id), id: k(rt.id) },
      });
    }
  }

  // Implicit access through child records (Accounts), when no share row names it.
  if (u.childCounts && !routes.some((r) => r.kind === "implicit")) {
    const parts = childParts(u.childCounts);
    if (parts.length) {
      add({ key: "implicitChild", kind: "implicit", access: "view", summary: "Owns child records", steps: [`${name} owns ${parts.join(", ")} on this ${ctx.label.toLowerCase()}, so Salesforce gives ${name} implicit view access to it`], detail: { type: "implicitChild" } });
    }
  }

  // Org-wide default.
  const model = isInternal(u) ? ctx.facts.owd?.internal : ctx.facts.owd?.external;
  if (owdLevel(model)) {
    add({ key: "owd", kind: "owd", access: owdLevel(model), summary: "Org-wide default", steps: [owdText(model, ctx.plural).replace(/\.$/, ""), `That applies to ${name}`], detail: { type: "owd", model } });
  } else if (model === "ControlledByParent" && rec.parentId) {
    const psf = sfLevel(u.parentSf);
    const parentWhat = `${rec.parentObjectLabel || "parent record"} '${rec.parentName || rec.parentId}'`;
    // Salesforce says the user cannot see this record: seeing the parent is then not enough, so it is no route (parentLine says so).
    if (psf && psf !== "none" && sf !== "none") {
      add({
        key: "parent", kind: "parent", access: psf === "full" ? "edit" : psf, summary: `Access depends on the parent ${rec.parentObjectLabel || "record"}`,
        steps: [`${cap(ctx.plural)} depend on the record they belong to: ${parentWhat}`, `Salesforce says ${name} ${LEVEL_SHORT[psf]} (the parent record)`],
        detail: { type: "parent", parentWhat },
      });
    }
  }

  // View All / Modify All, on the object and in the whole org.
  if (flags) {
    if (flags.modifyAll.length || flags.viewAll.length) {
      const all = flags.modifyAll.length > 0;
      add({
        key: "objectAll", kind: "viewall", access: all ? "full" : "view", summary: `'${all ? "Modify All" : "View All"}' on ${ctx.plural}`,
        steps: [`'${all ? "Modify All" : "View All"}' on ${ctx.plural} is turned on in ${listLabel(all ? flags.modifyAll : flags.viewAll)}`, `${name} has ${listLabel(all ? flags.modifyAll : flags.viewAll)}`],
        detail: { type: "objectAll", all },
      });
    }
    if (flags.modifyAllData.length || flags.viewAllData.length) {
      const all = flags.modifyAllData.length > 0;
      add({
        key: "systemAll", kind: "viewall", access: all ? "full" : "view", summary: `'${all ? "Modify All Data" : "View All Data"}'`,
        steps: [`'${all ? "Modify All Data" : "View All Data"}' is turned on in ${listLabel(all ? flags.modifyAllData : flags.viewAllData)}`, `${name} has ${listLabel(all ? flags.modifyAllData : flags.viewAllData)}, which gives access to every record`],
        detail: { type: "systemAll", all },
      });
    }
  }

  // A team route that only restates the owner (the owner is also a team member) is shown once, as the owner route.
  const ownerRoute = routes.find((r) => r.key === "owner");
  if (ownerRoute && ownerRoute.access !== null) {
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i];
      if (r.kind === "team" && r.access !== null && rank(r.effective) <= rank(ownerRoute.effective)) routes.splice(i, 1);
    }
  }

  routes.sort((a, b) => rank(b.effective) - rank(a.effective));
  return { routes, gate, cap: capLevel, notes };
}

// ---------- one user ----------

const MAIN_CAUSES = {
  routeButNone: (n) => [
    "A restriction rule or scoping rule hides the record from them (this page does not read those)",
    "Sharing was changed recently and Salesforce has not finished recalculating it",
    n.inactive ? `${n.name} is inactive or frozen` : "The user is frozen or limited in a way this page does not read",
    "Their object access is limited by something we did not read (for example a muting permission set)",
  ],
  noRouteFound: (ctx) => [
    "Access through a related record (a parent or child record, a lookup field or an Experience Cloud sharing set)",
    "A kind of sharing this page does not read (manager groups, portal groups)",
    ...(ctx?.facts?.object?.custom ? ["People above in the role hierarchy may not get access on this custom object"] : []),
    "Object permissions that we may have read wrongly. Check the profile and permission sets in Setup",
  ],
};

function analyse(u, name, ctx, side) {
  const sf = sfLevel(u.sf);
  const sfShare = sfShareLevel(u.sf);
  const inactive = u.isActive === false && u.sf == null;
  const { routes, gate, cap: capLevel, notes } = routesFor(u, name, ctx, sf);
  const known = routes.filter((r) => r.access !== null);
  const unknown = routes.some((r) => r.access === null);
  const best = routes.reduce((m, r) => higher(m, r.effective), "none");
  const bestKnown = known.reduce((m, r) => higher(m, r.effective), "none");
  let mismatch = null;
  if (sf !== null) {
    if (sf === "none" && routes.length) {
      mismatch = {
        kind: "routeButNone",
        text: `We found ${routes.length === 1 ? "a route" : `${routes.length} routes`} that should give ${name} access, but Salesforce says ${name} can't see this record. Salesforce's answer is the one that counts.`,
        causes: MAIN_CAUSES.routeButNone({ name, inactive: u.isActive === false }),
      };
    } else if (sf !== "none" && !routes.length) {
      mismatch = {
        kind: "noRouteFound",
        text: gate
          ? `Salesforce says ${name} ${LEVEL_PHRASE[sf]}, but we found no Read access to ${ctx.plural} for ${name}, so we cannot explain it.`
          : `Salesforce says ${name} ${LEVEL_PHRASE[sf]}, but we found no route that explains it.`,
        causes: MAIN_CAUSES.noRouteFound(ctx),
      };
    } else if (sf !== "none" && !unknown && tier(sf) > tier(bestKnown)) {
      mismatch = {
        kind: "routesLower",
        text: `The routes we found explain only ${GIVES[bestKnown] || "view access"}, but Salesforce says ${name} ${LEVEL_PHRASE[sf]}.`,
        causes: MAIN_CAUSES.noRouteFound(ctx),
      };
    } else if (sf !== "none" && tier(sf) < tier(best) && !routes.every((r) => r.access === null)) {
      mismatch = {
        kind: "routesHigher",
        text: `The routes we found give more than Salesforce says: they point to ${GIVES[best]}, but Salesforce says ${name} ${LEVEL_PHRASE[sf]}.`,
        causes: MAIN_CAUSES.routeButNone({ name, inactive: u.isActive === false }),
      };
    }
  }
  const gateText = gate ? `${name} has no Read access to ${ctx.plural} at all (checked the profile, permission sets and permission set groups), so nothing else can give access.` : null;
  let parentLine = ctx.rec.parentId && (ctx.facts.owd?.internal === "ControlledByParent") && u.parentSf
    ? `On the parent ${ctx.rec.parentObjectLabel || "record"} '${ctx.rec.parentName || ""}', Salesforce says ${name} ${sfLevel(u.parentSf) === "none" ? "can't see it" : LEVEL_SHORT[sfLevel(u.parentSf)]}.` : null;
  if (parentLine && sf === "none" && sfLevel(u.parentSf) !== "none") {
    // The condition "can see the parent" is met but is not enough. Say what else we know, as a likely reason.
    const rr = ctx.rec;
    const whoWhat = `${rr.whoObjectLabel || "record"} '${rr.whoName || ""}'`.replace(" ''", "");
    if (rr.whoId && u.whoSf && sfLevel(u.whoSf) === "none") {
      parentLine += ` That is not enough: ${name} also can't see the ${whoWhat} that this ${ctx.label.toLowerCase()} is about. That is the likely reason, because tasks and events can depend on the other records they are linked to as well.`;
    } else if (rr.whoId && !u.whoSf) {
      parentLine += ` That is not enough on its own. This ${ctx.label.toLowerCase()} is also linked to a ${rr.whoObjectLabel || "person"}, and we could not check whether ${name} can see that.`;
    } else {
      parentLine += ` Seeing the parent is not enough here, so something else stops ${name}. We could not tell what (for example a private item, or another record it is linked to).`;
    }
  }
  // Sharing gives more than the user can use (for example all access, but object permissions allow only viewing).
  let limitText = null;
  if (sf !== null && sfShare === "full" && sf !== "full" && sf !== "none") {
    const can = sf === "view" ? "view" : "edit";
    limitText = capLevel && capLevel !== "full" && tier(capLevel) === tier(sf) && ctx.permsApply
      ? `Sharing gives ${name} full access to this record, but ${name}'s object permissions on ${ctx.plural} only allow ${can === "view" ? "viewing" : "editing, not deleting"}, so ${name} can only ${can} it.`
      : `Sharing gives ${name} full access to this record, but ${name} can only ${can} it. Something other than sharing holds ${name} back (we could not tell what).`;
  }
  const inactiveText = inactive
    ? `${name} is inactive. Salesforce gives no answer for an inactive user, and an inactive user can't log in. The routes below only show what would apply if ${name} were active.`
    : null;
  return {
    key: side, id: u.id, name, username: u.username || "", isActive: u.isActive !== false,
    profile: u.profile || "", roleName: u.roleName || "",
    sfLevel: sf, sfShare, inactive, inactiveText, limitText,
    sfText: inactive ? "Salesforce gives no answer for an inactive user" : sf === null ? "Salesforce's answer could not be read" : LEVEL_PHRASE[sf],
    routes, gate, gateText, cap: capLevel, mismatch, parentLine, notes, raw: u,
  };
}

// ---------- the difference ----------

/** What `y` is missing on a route that `x` has. {missing, change}. */
function missingFor(route, y, yName, ctx) {
  const d = route.detail || {};
  const u = y.raw;
  const yRole = u.roleName || (u.roleId ? ctx.roleName(u.roleId) : "");
  switch (d.type) {
    case "owner":
      return { missing: `${yName} is not the owner (the owner is ${ctx.ownerName}).`, change: `${yName} would have to be the owner.` };
    case "ownerQueue":
      return { missing: `${yName} is not a member of queue '${d.name}', directly or through another group.`, change: `${yName} would have to be added to queue '${d.name}'.` };
    case "ownerRole":
      return u.roleId
        ? { missing: `${yName}'s role '${yRole}' is not above the owner's role '${d.ownerRole}' in the role hierarchy.`, change: `${yName} would need a role above '${d.ownerRole}'.` }
        : { missing: `${yName} has no role, so the role hierarchy cannot give access.`, change: `${yName} would need a role above '${d.ownerRole}'.` };
    case "ownerQueueBoss":
      return { missing: `${yName} is not a member of queue '${d.name}' and has no role above the role of one of its members.`, change: `Adding ${yName} to queue '${d.name}', or giving ${yName} a role above its members, would change it.` };
    case "shareBossGroup":
      return { missing: `${yName} is not in ${groupLabel(d.group, ctx)} and has no role above the role of one of its members.`, change: `Adding ${yName} to ${groupLabel(d.group, ctx)}, or giving ${yName} a role above its members, would change it.` };
    case "acctOwner":
      return { missing: `${yName} does not own the account (it is owned by ${ctx.facts.account?.owner?.name || "someone else"}).`, change: `${yName} would have to own the account.` };
    case "acctOwnerRole":
      return u.roleId
        ? { missing: `${yName}'s role '${yRole}' is not above the account owner's role '${d.ownerRole}' in the role hierarchy.`, change: `${yName} would need a role above '${d.ownerRole}'.` }
        : { missing: `${yName} has no role, so the role hierarchy cannot give access.`, change: `${yName} would need a role above '${d.ownerRole}'.` };
    case "shareUser":
      if (d.acct && d.cause === "team") return { missing: `${yName} is not on the account team with access to its ${ACCT_CHILD[ctx.api] || "records"}.`, change: `Adding ${yName} to the account team with access to its ${ACCT_CHILD[ctx.api] || "records"} would change it.` };
      if (d.acct) return { missing: `The account is not shared with ${yName} in a way that gives access to its ${ACCT_CHILD[ctx.api] || "records"}.`, change: `Sharing the account with ${yName}, with access to its ${ACCT_CHILD[ctx.api] || "records"}, would change it.` };
      return { missing: `The record is not shared directly with ${yName}.`, change: `Sharing the record with ${yName} would change it.` };
    case "shareBoss":
      return u.roleId
        ? { missing: `${yName}'s role '${yRole}' is not above '${d.whoRole}', so ${yName} does not reach the ${d.acct ? "account" : "record"} through ${d.who}.`, change: `${yName} would need a role above '${d.whoRole}'.` }
        : { missing: `${yName} has no role, so the role hierarchy cannot give access.`, change: `${yName} would need a role above '${d.whoRole}'.` };
    case "shareGroup": {
      const g = d.group;
      const label = groupLabel(g, ctx);
      const rel = groupName(g, ctx);
      switch (g.type) {
        case "Regular": case "Queue":
          return { missing: `${yName} is not in ${label}, directly or through another group.`, change: `Adding ${yName} to ${label} would change it.` };
        case "Role":
          return { missing: u.roleId ? `${yName}'s role '${yRole}' is not '${rel}'.` : `${yName} has no role.`, change: `${yName} would need the role '${rel}'.` };
        case "RoleAndSubordinates": case "RoleAndSubordinatesInternal":
          return { missing: u.roleId ? `${yName}'s role '${yRole}' is not '${rel}' or below it.` : `${yName} has no role.`, change: `${yName} would need the role '${rel}' or a role below it.` };
        case "Territory":
          return { missing: `${yName} is not assigned to territory '${rel}'.`, change: `Assigning ${yName} to territory '${rel}' would change it.` };
        case "TerritoryAndSubordinates":
          return { missing: `${yName} is not assigned to territory '${rel}' or one below it.`, change: `Assigning ${yName} to territory '${rel}' or one below it would change it.` };
        case "Organization":
          return { missing: `${yName} is not an internal user.`, change: "The record would have to be shared with a group that includes them." };
        default:
          return { missing: `${yName} is not in ${label}.`, change: `${yName} would have to be in ${label}.` };
      }
    }
    case "owd":
      return { missing: `The org-wide default does not give ${yName} this access.`, change: "The org-wide default would have to change." };
    case "parent":
      if (!u.parentSf) return { missing: `We could not read whether ${yName} can see the parent ${ctx.rec.parentObjectLabel || "record"}.`, change: "" };
      return { missing: `${yName} cannot see the parent ${ctx.rec.parentObjectLabel || "record"} ${d.parentWhat ? `(${d.parentWhat})` : ""}, and this record follows it.`.replace(/\s+\./, "."), change: `${yName} would need access to the parent record.` };
    case "objectAll":
      return { missing: `${yName} has no '${d.all ? "Modify All" : "View All"}' on ${ctx.plural} in a profile or permission set.`, change: `A permission set with '${d.all ? "Modify All" : "View All"}' on ${ctx.plural} would change it.` };
    case "systemAll":
      return { missing: `${yName} does not have '${d.all ? "Modify All Data" : "View All Data"}'.`, change: `A permission set with '${d.all ? "Modify All Data" : "View All Data"}' would change it.` };
    case "territory":
      return { missing: `${yName} is not assigned to territory '${d.name}' or one above it.`, change: `Assigning ${yName} to territory '${d.name}' (or one above it) would change it.` };
    case "implicitChild":
      return { missing: `${yName} owns no child records (opportunities, cases or contacts) on this record.`, change: "Owning a child record on it would give read access." };
    default:
      return { missing: `${yName} does not have this route.`, change: "" };
  }
}

/** Does `y` have this kind of route in its own facts? Checked before any "y is not ..." line is printed. */
function hasInFacts(route, y, ctx) {
  const d = route.detail || {};
  const u = y.raw;
  if (d.type === "owner") return ctx.rec.ownerKind === "user" && k(ctx.rec.ownerId) === k(u.id);
  const mine = (u.territoryIds || []).map(k);
  if (d.type === "territory") return mine.some((t) => [d.id, ...above(ctx.terrs, d.id)].includes(t));
  if (d.type === "shareGroup" && d.group && d.group.type === "Territory") return mine.includes(k(d.group.relatedId));
  if (d.type === "shareGroup" && d.group && d.group.type === "TerritoryAndSubordinates") return mine.some((t) => [t, ...above(ctx.terrs, t)].includes(k(d.group.relatedId)));
  if (d.type === "shareGroup" && d.group) return computeReach(u, ctx).has(k(d.group.id));
  if (d.type === "parent") return !!u.parentSf && sfLevel(u.parentSf) !== "none";
  // Routes that go through a person or group y is part of: y already has the direct form of that route.
  if (d.type === "shareBoss" && d.whoId) return k(d.whoId) === k(u.id); // shared with y, and the other user is above y
  if (d.type === "shareBoss" && d.group) return computeReach(u, ctx).has(k(d.group.id));
  if (d.type === "shareBossGroup" && d.group) return computeReach(u, ctx).has(k(d.group.id));
  if (d.type === "ownerRole") return ctx.rec.ownerKind === "user" && k(ctx.rec.ownerId) === k(u.id);
  if (d.type === "acctOwner" || d.type === "acctOwnerRole") return !!ctx.facts.account?.owner?.id && k(ctx.facts.account.owner.id) === k(u.id);
  if (d.type === "ownerQueue" || d.type === "ownerQueueBoss") return ctx.rec.ownerKind === "queue" && !!ctx.rec.ownerId && computeReach(u, ctx).has(k(ctx.rec.ownerId));
  return false;
}

/** When x's route goes through y itself (a share to y, y as the owner), x gets it because x is above y.
 *  Returns that sentence, or null. Only said when the route itself proves it. */
function viaOther(route, x, y, ctx) {
  const d = route.detail || {};
  const u = y.raw;
  if (d.type === "shareBoss" && d.whoId && k(d.whoId) === k(u.id)) return `${x.name} also reaches this record because ${x.name} is above ${y.name} in the role hierarchy, and ${d.acct ? "the account is shared with" : "the record is shared with"} ${y.name}.`;
  if (d.type === "ownerRole" && ctx.rec.ownerKind === "user" && k(ctx.rec.ownerId) === k(u.id)) return `${x.name} also reaches this record because ${x.name} is above ${y.name}, who owns it.`;
  if (d.type === "acctOwnerRole" && ctx.facts.account?.owner?.id && k(ctx.facts.account.owner.id) === k(u.id)) return `${x.name} also reaches this record because ${x.name} is above ${y.name}, who owns its account.`;
  return null;
}

function difference(x, y, ctx, via) {
  const items = [];
  const topicOf = (r) => r.topic || r.key;
  const keys = new Set(y.routes.map(topicOf));
  for (const r of x.routes) {
    if (keys.has(topicOf(r))) {
      const mine = y.routes.filter((q) => topicOf(q) === topicOf(r)).reduce((m, q) => (rank(q.effective) > rank(m.effective) ? q : m));
      if (rank(mine.effective) >= rank(r.effective)) continue;
      items.push({
        route: r.summary, gives: r.access ? GIVES[r.access] : null,
        missing: [mine.limited
          ? `${y.name} has this route too, but ${y.name}'s object permissions limit it to ${GIVES[mine.effective] || "no access"}.`
          : `${y.name} has this route too, but it gives only ${GIVES[mine.effective] || "no access"}.`], change: [],
      });
      continue;
    }
    if (hasInFacts(r, y, ctx)) { const v = viaOther(r, x, y, ctx); if (v && via) via.push(v); continue; } // y has it after all (for example it was left out of y's routes): never say they lack it
    const m = missingFor(r, y, y.name, ctx);
    items.push({ route: r.summary, gives: r.access ? GIVES[r.access] : null, missing: [m.missing], change: m.change ? [m.change] : [] });
  }
  return items;
}

// ---------- explain ----------

/** Work out the routes for one or two users and, with two, why they differ.
 *  `userIds` picks (and orders) users from `facts.users`; without it the first two are used. */
export function explain(facts, userIds) {
  const ctx = buildCtx(facts);
  const all = facts.users || [];
  const chosen = (userIds && userIds.length ? userIds.map((id) => all.find((u) => k(u.id) === k(id))).filter(Boolean) : all).slice(0, 2);
  const names = uniqueNames(chosen);
  const users = chosen.map((u, i) => analyse(u, names[i], ctx, i === 0 ? "a" : "b"));
  const rec = facts.record || {};
  const model = facts.owd?.internal;

  let verdict;
  const said = users.map((u) => (u.inactive
    ? `${u.name} is inactive. Salesforce gives no answer for inactive users, and they can't log in.`
    : u.sfLevel === null ? `Salesforce did not say whether ${u.name} can see this record.` : `${u.name} ${LEVEL_PHRASE[u.sfLevel]}.`));
  verdict = said.join(" ");
  if (users.length === 2 && users.every((u) => u.sfLevel !== null) && users[0].sfLevel === users[1].sfLevel) verdict += " They have the same access.";
  for (const u of users) if (u.limitText) verdict += ` ${u.limitText}`;

  let diff = null;
  if (users.length === 2) {
    const [a, b] = users;
    const best = (u) => u.routes.reduce((m, r) => higher(m, r.effective), "none");
    const shareRank = (u) => rank(u.sfShare);
    if (a.inactive || b.inactive) {
      const who = [a, b].filter((u) => u.inactive).map((u) => u.name).join(" and ");
      diff = { same: false, text: `${who} ${a.inactive && b.inactive ? "are" : "is"} inactive, and Salesforce gives no answer for inactive users, so there is nothing to compare. The routes in each card still show what would apply.`, more: null, less: null, items: [], gate: null, levelNote: null };
    } else if (a.sfLevel === null || b.sfLevel === null) {
      diff = { same: false, text: "Salesforce's answer could not be read for both users, so the difference cannot be explained.", more: null, less: null, items: [], gate: null, levelNote: null };
    } else if (a.sfLevel === b.sfLevel && a.sfShare === b.sfShare) {
      diff = { same: true, text: SAME_TEXT[a.sfLevel], more: null, less: null, items: [], gate: null, levelNote: null };
    } else {
      // Order by what sharing gives, then by what the user can do.
      const [x, y] = shareRank(a) !== shareRank(b) ? (shareRank(a) > shareRank(b) ? [a, b] : [b, a]) : rank(a.sfLevel) > rank(b.sfLevel) ? [a, b] : [b, a];
      const via = [];
      const items = y.gate ? [] : difference(x, y, ctx, via);
      const sameDo = x.sfLevel === y.sfLevel;
      const limitedY = y.routes.filter((r) => r.limited);
      const levelNote = !y.gate && (x.routes.length || y.routes.length)
        ? `${x.name}'s routes give up to ${GIVES[best(x)] || "no access"}; ${y.name}'s give ${y.routes.length ? `only ${GIVES[best(y)] || "no access"}` : "nothing we could find"}.` +
          (limitedY.length ? ` ${y.name} has a route that would give ${GIVES[limitedY.reduce((m, r) => higher(m, r.access), "view")]}, but ${y.name}'s object permissions on ${ctx.plural} hold ${y.name} to ${GIVES[best(y)] || "no access"}.` : "")
        : null;
      diff = {
        same: false, more: x.name, less: y.name, gate: y.gate ? y.gateText : null, levelNote,
        text: sameDo
          ? `${x.name} and ${y.name} can both ${x.sfLevel === "view" ? "view" : x.sfLevel === "none" ? "do nothing with" : "edit"} this record, but sharing gives ${x.name} more (${GIVES[x.sfShare] || "no access"} against ${GIVES[y.sfShare] || "no access"} for ${y.name}).${x.limitText ? ` ${x.limitText}` : ""}`
          : `${x.name} ${LEVEL_SHORT[x.sfLevel]}; ${y.name} ${LEVEL_SHORT[y.sfLevel]}.`,
        items, via,
        unexplained: !y.gate && !items.length
          ? (x.routes.length ? `${x.name}'s routes are all ones ${y.name} has too, so we cannot say from them what ${y.name} is missing.` : `We found no route that gives ${x.name} more access, so we cannot say what ${y.name} is missing.`)
          : null,
      };
    }
  }

  const notes = [
    ...(facts.notes || []),
    ...users.flatMap((u) => u.notes),
    ...(ctx.hierarchy && facts.object?.custom ? ["We could not read whether people above in the role hierarchy get access on this custom object (the 'Grant Access Using Hierarchies' setting). We assumed they do."] : []),
    ...(!ctx.permsApply ? [`Salesforce keeps no object permissions for ${ctx.plural.toLowerCase()} (access follows the owner and the related record), so Read and Edit on the object were not used.`] : []),
    ...(users.some((u) => u.mismatch) ? ["Salesforce's answer is the one shown at the top. Routes are our explanation, and they did not match it for everyone (see the lists above)."] : []),
    "Not checked: restriction rules and scoping rules, Experience Cloud sharing sets, field-level access, and which specific sharing rule gave access (Salesforce only says 'a sharing rule').",
    ...(acctScope(ctx) ? [
      `Access through the account is checked for ${ctx.plural.toLowerCase()}: the account's own sharing (sharing rules, manual shares, the account team, territories) and the account owner, including people above them in the role hierarchy. Not checked: contacts, and managers of territory members. Salesforce's "View Sharing Hierarchy" page is the place to confirm a route we could not explain.`,
      ...(ctx.facts.account?.truncated ? ["The account has a very long list of sharing rows. Only the first part was read, so a route through the account may be missing."] : []),
    ] : []),
    "Not checked: manager groups (groups made of a user's manager). People above a group's members in the role hierarchy are checked for groups that give access to managers, but only up to a limit on members.",
  ];
  const seen = new Set();
  const uniqNotes = notes.filter((n) => (seen.has(n) ? false : seen.add(n)));

  return {
    schema: ACCESS_SCHEMA,
    record: {
      id: rec.id, objectLabel: facts.object?.label || rec.object || "Record", objectPlural: ctx.plural, name: rec.name || rec.id,
      ownerName: rec.ownerName || "", ownerKind: rec.ownerKind || null,
      owdText: owdText(model, ctx.plural), owdModel: model || null,
      parentId: model === "ControlledByParent" ? rec.parentId || null : null,
      parentLabel: rec.parentObjectLabel || "", parentName: rec.parentName || "",
    },
    users, verdict, difference: diff, notes: uniqNotes, warnings: facts.warnings || [],
  };
}

// ---------- plain text for a ticket ----------

export function toPlainText(res) {
  const L = [];
  const r = res.record;
  L.push("Why can a user see this record?");
  L.push(`Record: ${r.objectLabel} "${r.name}"${r.ownerName ? `, owner: ${r.ownerName}` : ""}`);
  L.push(`Default access: ${r.owdText}`);
  L.push("");
  L.push(res.verdict);
  for (const u of res.users) {
    L.push("");
    L.push(`${u.name} ${u.inactive ? "(inactive, no answer from Salesforce)" : u.sfLevel === null ? "(Salesforce's answer not read)" : LEVEL_PHRASE[u.sfLevel]}`);
    if (u.inactiveText) L.push(`  ${u.inactiveText}`);
    if (u.limitText) L.push(`  ${u.limitText}`);
    if (u.gateText) L.push(`  ${u.gateText}`);
    else if (!u.routes.length) L.push("  No route found that gives access.");
    u.routes.forEach((rt, i) => {
      L.push(`  Route ${i + 1} (${rt.access ? `${u.inactive ? "would give" : "gives"} ${GIVES[rt.access]}${rt.limited ? `, limited to ${GIVES[rt.effective] || "no access"} by object permissions` : ""}` : "how much access it gives is not known"}):`);
      L.push(`    ${rt.steps.join(" -> ")}`);
    });
    if (u.parentLine) L.push(`  ${u.parentLine}`);
    if (u.mismatch) {
      L.push(`  Does not match Salesforce: ${u.mismatch.text}`);
      L.push("  Possible reasons:");
      for (const c of u.mismatch.causes) L.push(`    - ${c}`);
    }
  }
  const d = res.difference;
  if (d) {
    L.push("");
    L.push("Why the difference");
    L.push(`  ${d.text}`);
    if (d.gate) L.push(`  ${d.gate}`);
    if (d.levelNote) L.push(`  ${d.levelNote}`);
    for (const it of d.items) {
      L.push(`  - ${it.route}${it.gives ? ` (gives ${it.gives})` : ""}`);
      for (const m of it.missing) L.push(`      Missing: ${m}`);
      for (const c of it.change) L.push(`      What would change it: ${c}`);
    }
    for (const v of d.via || []) L.push(`  ${v}`);
    if (d.unexplained) L.push(`  ${d.unexplained}`);
  }
  L.push("");
  L.push("Notes");
  for (const n of res.notes) L.push(`  - ${n}`);
  return L.join("\n");
}
