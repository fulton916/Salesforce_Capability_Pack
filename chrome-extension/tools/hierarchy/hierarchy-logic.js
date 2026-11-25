// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Territory and role hierarchies: build a tree from flat records, search it, cut a branch, and lay it
// out for Excel. Pure: no DOM, no network, no storage. Every walk is iterative, so a very deep
// chain cannot overflow the stack.
//
// A record is {id, parentId, name, apiName}. Nothing here knows whether it is a territory or a role.

import { searchWords } from "../../shared/pick.js";

export { toCsv } from "../../shared/csv.js"; // CSV with a BOM; cells starting with = + - @ tab or CR are guarded there

export const PATH_SEP = " › ";

// Case-insensitive, numbers by value: "Region 2" comes before "Region 10".
const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const byName = (a, b) =>
  COLLATOR.compare(a.name, b.name) || COLLATOR.compare(a.apiName, b.apiName) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const NOUNS = {
  territories: { one: "territory", many: "territories", title: "Territories", find: "Find a territory" },
  roles: { one: "role", many: "roles", title: "Roles", find: "Find a role" },
};

/** Build the tree. Returns
 *  {roots, order, count, maxDepth, levels, missingParent, loopNodes}
 *  where `order` is every node in depth-first order. Each node is
 *  {id, name, apiName, parent, children, depth, index, size, orphan, inLoop, loopCut}:
 *  `index` is its place in `order`, `size` how many nodes are below it.
 *  A node whose parent is not in the set goes to the top level (orphan, counted in `missingParent`).
 *  A loop in the parent links is broken at its first member by name, which goes to the top level
 *  (loopCut); every member of a loop is marked inLoop; `loopNodes` counts every node that was in a loop. Duplicate ids keep the first record. */
export function buildTree(records) {
  const byId = new Map();
  for (const r of records || []) {
    const id = String(r.id ?? "");
    if (!id || byId.has(id)) continue;
    const apiName = String(r.apiName ?? "");
    byId.set(id, {
      id, name: String(r.name || apiName || id), apiName,
      parentId: r.parentId ? String(r.parentId) : null,
      parent: null, children: [], depth: 0, index: 0, size: 0, orphan: false, inLoop: false, loopCut: false,
    });
  }
  const list = [...byId.values()];
  let missingParent = 0;
  for (const n of list) {
    if (!n.parentId) continue;
    const p = byId.get(n.parentId);
    if (p) n.parent = p;
    else { n.orphan = true; missingParent++; }
  }

  // Loops: follow parent links from every node; meeting a node of the current walk means a loop.
  const mark = new Map(); // 1 = on the current walk, 2 = done
  let loopNodes = 0;
  for (const start of list) {
    if (mark.has(start)) continue;
    const walk = [];
    let n = start;
    while (n && !mark.has(n)) { mark.set(n, 1); walk.push(n); n = n.parent; }
    if (n && mark.get(n) === 1) {
      const members = [n];
      for (let m = n.parent; m !== n; m = m.parent) members.push(m);
      members.sort(byName);
      members[0].parent = null;
      members[0].loopCut = true;
      for (const m of members) m.inLoop = true;
      loopNodes += members.length;
    }
    for (const w of walk) mark.set(w, 2);
  }

  const roots = [];
  for (const n of list) (n.parent ? n.parent.children : roots).push(n);
  roots.sort(byName);
  for (const n of list) if (n.children.length > 1) n.children.sort(byName);

  const order = [];
  const stack = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i]);
  let maxDepth = -1;
  while (stack.length) {
    const n = stack.pop();
    n.depth = n.parent ? n.parent.depth + 1 : 0;
    n.index = order.length;
    order.push(n);
    if (n.depth > maxDepth) maxDepth = n.depth;
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    if (n.parent) n.parent.size += n.size + 1;
  }
  return { roots, order, count: order.length, maxDepth, levels: maxDepth + 1, missingParent, loopNodes };
}

/** Depth-first (pre-order) list of `tops` and everything below them: [{node, depth}], depth counted
 *  from the top node (0). Children are already sorted by buildTree. */
export function flatten(tops) {
  const out = [];
  const stack = [];
  for (let i = tops.length - 1; i >= 0; i--) stack.push([tops[i], 0]);
  while (stack.length) {
    const [node, depth] = stack.pop();
    out.push({ node, depth });
    for (let i = node.children.length - 1; i >= 0; i--) stack.push([node.children[i], depth + 1]);
  }
  return out;
}

/** Nodes from the top of the whole hierarchy down to `node` (inclusive). */
export function pathOf(node) {
  const out = [];
  for (let n = node; n; n = n.parent) out.push(n);
  return out.reverse();
}

/** A node, everything below it, and the path above it. */
export function branchOf(node) {
  return { top: node, above: pathOf(node).slice(0, -1), items: flatten([node]) };
}

/** How many things and how many levels a flattened list has. */
export function statsOf(items) {
  let levels = 0;
  for (const it of items) if (it.depth + 1 > levels) levels = it.depth + 1;
  return { count: items.length, levels };
}

const num = (n) => n.toLocaleString("en-US");

/** "412 territories, 7 levels" */
export function summaryText({ count, levels }, kind) {
  const nn = NOUNS[kind];
  if (!count) return `No ${nn.many}`;
  return `${num(count)} ${count === 1 ? nn.one : nn.many}, ${levels} ${levels === 1 ? "level" : "levels"}`;
}

/** Plain-words notes about records that did not fit the tree. With `items` (the flattened list of a
 *  branch), only the nodes on screen are counted, so a branch does not report problems elsewhere. */
export function treeNotes(tree, kind, items = null) {
  const nn = NOUNS[kind];
  const notes = [];
  let n = tree.missingParent;
  let l = tree.loopNodes;
  if (items) {
    n = 0; l = 0;
    for (const { node } of items) { if (node.orphan) n++; if (node.inLoop) l++; }
  }
  if (n) notes.push(`${num(n)} ${n === 1 ? nn.one : nn.many} ${n === 1 ? "has a parent that is not in this list, so it is" : "have a parent that is not in this list, so they are"} shown at the top level.`);
  if (l) notes.push(`${num(l)} ${l === 1 ? nn.one : nn.many} ${l === 1 ? "is its own parent" : "have parents that lead back to themselves"}. The loop is cut and one of them is shown at the top level; each one in the loop is marked "Parent loop".`);
  return notes;
}

// ---------- users in each role / territory ----------

/** What the person can choose to show for each user. */
export const USER_FIELDS = {
  name: { label: "Name", short: "name" },
  username: { label: "Username", short: "username" },
  email: { label: "Email", short: "email" },
  id: { label: "Salesforce ID", short: "Salesforce ID" },
};

const USER_COLLATOR = new Intl.Collator("en", { sensitivity: "base" });

/** The text shown (and exported) for one user in the chosen field. */
export function userValue(u, field) {
  const v = String(u[field] ?? "").trim();
  return v || `(no ${USER_FIELDS[field]?.short || field})`;
}

/** Put users on the nodes of a tree. `records` are {id, nodeId, name, username, email, active}:
 *  one per person per role/territory (a person in two territories appears twice). Records for a node that
 *  is not in the tree are not attached; they come back in `unmatched` (one entry per person).
 *  A person listed twice for the same node is kept once. Returns {byNode: Map(nodeId -> users[]), unmatched}.
 *  The tree itself is not changed. */
export function attachUsers(tree, records) {
  const ids = new Set(tree.order.map((n) => n.id));
  const byNode = new Map();
  const seen = new Set();
  const unmatchedIds = new Set();
  const unmatched = [];
  for (const r of records || []) {
    const id = String(r.id ?? "");
    const nodeId = String(r.nodeId ?? "");
    if (!id || !nodeId) continue;
    const user = { id, name: String(r.name ?? ""), username: String(r.username ?? ""), email: String(r.email ?? ""), active: r.active !== false };
    if (!ids.has(nodeId)) {
      if (!unmatchedIds.has(id)) { unmatchedIds.add(id); unmatched.push(user); }
      continue;
    }
    const key = `${nodeId}|${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byNode.has(nodeId)) byNode.set(nodeId, []);
    byNode.get(nodeId).push(user);
  }
  return { byNode, unmatched };
}

/** The users of one node as they are shown: inactive ones only when `includeInactive`, sorted by the chosen
 *  field (case-insensitive, then by Id). Each is {id, text, active, display}; `display` is `text`
 *  with " (inactive)" added for an inactive user. */
export function listUsers(byNode, node, field, includeInactive = false) {
  const users = byNode.get(node.id) || [];
  const out = [];
  for (const u of users) {
    if (!u.active && !includeInactive) continue;
    const text = userValue(u, field);
    out.push({ id: u.id, text, active: u.active, display: u.active ? text : `${text} (inactive)` });
  }
  out.sort((a, b) => USER_COLLATOR.compare(a.text, b.text) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** On the listed nodes: {active, inactive} count different people (a person in two nodes counts once);
 *  {activeAssignments, inactiveAssignments} count person-in-node pairs (what the rows and the CSV show). */
export function countUsers(byNode, items) {
  const active = new Set();
  const inactive = new Set();
  let activeAssignments = 0;
  let inactiveAssignments = 0;
  for (const { node } of items) {
    for (const u of byNode.get(node.id) || []) {
      (u.active ? active : inactive).add(u.id);
      if (u.active) activeAssignments++; else inactiveAssignments++;
    }
  }
  return { active: active.size, inactive: inactive.size, activeAssignments, inactiveAssignments };
}

/** Roles: "5,812 active users" (and ", 40 inactive" when inactive users are included).
 *  Territories: "2,971 active people in 6,207 territory assignments" (a person in two territories is one
 *  person and two assignments; with inactive included: "2,971 active and 40 inactive people in 6,300 ..."). */
export function usersSummary({ active, inactive, activeAssignments = 0, inactiveAssignments = 0 }, includeInactive, kind = "roles") {
  if (kind === "territories") {
    const a = activeAssignments + (includeInactive ? inactiveAssignments : 0);
    const who = includeInactive ? `${num(active)} active and ${num(inactive)} inactive people` : `${num(active)} active ${active === 1 ? "person" : "people"}`;
    return `${who} in ${num(a)} territory ${a === 1 ? "assignment" : "assignments"}`;
  }
  let t = `${num(active)} active ${active === 1 ? "user" : "users"}`;
  if (includeInactive) t += `, ${num(inactive)} inactive`;
  return t;
}

/** Territory models, Active first, then Planning, then Archived, then by name. */
export function sortModels(models) {
  const rank = (m) => ({ Active: 0, Planning: 1, Archived: 2 }[m.state] ?? 3);
  return [...models].sort((a, b) => rank(a) - rank(b) || COLLATOR.compare(a.name, b.name));
}

/** The model to open first: the Active one, else the first. */
export function defaultModel(models) {
  return sortModels(models)[0] || null;
}

const hayOf = (n) => (n._hay ??= searchWords(`${n.name} ${n.apiName}`).join(" "));

/** Find nodes by name or API name: every word typed must appear, in any order; punctuation is a
 *  separator (the same words as pick.js). Names that start with the typed text come first, then
 *  tree order. Each hit has the path from the top, so equal names can be told apart.
 *  Returns {items: [{node, path: [names], pathText}], total}. */
export function searchNodes(tree, text, limit = 50) {
  const words = searchWords(text);
  if (!words.length) return { items: [], total: 0 };
  const q = words.join(" ");
  const hits = [];
  for (const n of tree.order) {
    const hay = hayOf(n);
    if (words.every((w) => hay.includes(w))) hits.push(n);
  }
  const starts = (n) => (searchWords(n.name).join(" ").startsWith(q) ? 0 : 1);
  const ranked = hits.map((n) => [starts(n), n]).sort((x, y) => x[0] - y[0] || x[1].index - y[1].index);
  const items = ranked.slice(0, limit).map(([, node]) => {
    const path = pathOf(node).map((p) => p.name);
    return { node, path, pathText: path.join(PATH_SEP) };
  });
  return { items, total: hits.length };
}

/** Rows for Excel, a stepped layout: "Level 1" ... "Level N" (N = deepest level exported), "API name",
 *  "Path". Each row has its name in the column for its depth (the exported top is Level 1) and the
 *  other level columns empty. "Path" is the full path from the top of the whole hierarchy.
 *  `top` is a node for one branch, or null for everything. The first row is the header.
 *  `users` (optional) is {byNode, field, includeInactive}: then "Users" (the count) follows "Path", and
 *  then "User 1", "User 2", ... up to the most users on one row; each cell holds the chosen field, in the
 *  order shown on the page, with " (inactive)" for an inactive user. Without `users` the rows are unchanged. */
export function exportRows(tree, top = null, users = null) {
  const items = top ? flatten([top]) : flatten(tree.roots);
  const above = top ? pathOf(top).slice(0, -1).map((n) => n.name) : [];
  const { levels } = statsOf(items);
  const width = Math.max(levels, 1);
  const rows = [[...Array.from({ length: width }, (_, i) => `Level ${i + 1}`), "API name", "Path"]];
  const names = above.slice();
  const lists = [];
  let most = 0;
  for (const { node, depth } of items) {
    const abs = above.length + depth;
    names.length = abs;
    names[abs] = node.name;
    const row = new Array(width + 2).fill("");
    row[depth] = node.name;
    row[width] = node.apiName;
    row[width + 1] = names.join(PATH_SEP);
    rows.push(row);
    if (users) {
      const list = listUsers(users.byNode, node, users.field, users.includeInactive).map((u) => u.display);
      lists.push(list);
      if (list.length > most) most = list.length;
    }
  }
  if (users) {
    rows[0].push("Users", ...Array.from({ length: most }, (_, i) => `User ${i + 1}`));
    lists.forEach((list, i) => {
      rows[i + 1].push(String(list.length), ...list, ...new Array(most - list.length).fill(""));
    });
  }
  return rows;
}

const part = (s) => String(s || "").normalize("NFC").replace(/[^\p{L}\p{N}.-]+/gu, "_").replace(/^[._]+|_+$/g, "").slice(0, 40);

/** A file name that is safe on Windows, macOS and Linux: kind, model, branch, time stamp. */
export function exportFileName({ kind, model, branch }, stamp) {
  const parts = [kind, model, branch ? `from_${branch}` : "", stamp].map(part).filter(Boolean);
  return `${parts.join("_")}.csv`;
}
