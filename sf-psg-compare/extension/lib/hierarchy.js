// Territory and role hierarchies: build a tree from flat records, search it, cut a branch, and lay it
// out for Excel. Pure: no DOM, no network, no storage. Every walk is iterative, so a very deep
// chain cannot overflow the stack.
//
// A record is {id, parentId, name, apiName}. Nothing here knows whether it is a territory or a role.

import { searchWords } from "./pick.js";

export { toCsv } from "./compare.js"; // CSV with a BOM; cells starting with = + - @ tab or CR are guarded there

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

/** Plain-words notes about records that did not fit the tree. */
export function treeNotes(tree, kind) {
  const nn = NOUNS[kind];
  const notes = [];
  const n = tree.missingParent;
  if (n) notes.push(`${num(n)} ${n === 1 ? nn.one : nn.many} ${n === 1 ? "has a parent that is not in this list, so it is" : "have a parent that is not in this list, so they are"} shown at the top level.`);
  const l = tree.loopNodes;
  if (l) notes.push(`${num(l)} ${l === 1 ? nn.one : nn.many} ${l === 1 ? "is its own parent" : "have parents that lead back to themselves"}. The loop is cut and one of them is shown at the top level; each one in the loop is marked "Parent loop".`);
  return notes;
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
 *  `top` is a node for one branch, or null for everything. The first row is the header. */
export function exportRows(tree, top = null) {
  const items = top ? flatten([top]) : flatten(tree.roots);
  const above = top ? pathOf(top).slice(0, -1).map((n) => n.name) : [];
  const { levels } = statsOf(items);
  const width = Math.max(levels, 1);
  const rows = [[...Array.from({ length: width }, (_, i) => `Level ${i + 1}`), "API name", "Path"]];
  const names = above.slice();
  for (const { node, depth } of items) {
    const abs = above.length + depth;
    names.length = abs;
    names[abs] = node.name;
    const row = new Array(width + 2).fill("");
    row[depth] = node.name;
    row[width] = node.apiName;
    row[width + 1] = names.join(PATH_SEP);
    rows.push(row);
  }
  return rows;
}

const part = (s) => String(s || "").normalize("NFC").replace(/[^\p{L}\p{N}.-]+/gu, "_").replace(/^[._]+|_+$/g, "").slice(0, 40);

/** A file name that is safe on Windows, macOS and Linux: kind, model, branch, time stamp. */
export function exportFileName({ kind, model, branch }, stamp) {
  const parts = [kind, model, branch ? `from_${branch}` : "", stamp].map(part).filter(Boolean);
  return `${parts.join("_")}.csv`;
}
