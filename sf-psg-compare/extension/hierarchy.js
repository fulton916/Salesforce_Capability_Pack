import { SfApi, findSession } from "./lib/sfconn.js";
import { readOrg } from "./lib/snapshot.js";
import { readTerritoryModels, readTerritories, readRoles, readRoleUsers, readTerritoryUsers } from "./lib/hierarchyread.js";
import {
  NOUNS, USER_FIELDS, buildTree, flatten, statsOf, summaryText, treeNotes, defaultModel, searchNodes, exportRows, exportFileName, toCsv, PATH_SEP,
  attachUsers, listUsers, countUsers, usersSummary,
} from "./lib/hierarchy.js";
import { startLiveReload } from "./lib/livereload.js";
import { issueUrl, FEEDBACK_TOOLS, versionText } from "./lib/feedback.js";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const DEV = params.has("dev"); // served by tools/dev_server.py, which forwards API calls to the org
const HOST = params.get("host");

const $ = (sel, root = document) => root.querySelector(sel);

/** Replace a node's children. null, undefined and false are skipped (replaceChildren would write "null"). */
function setKids(node, ...kids) {
  node.replaceChildren(...kids.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

/** Build an element. Text is always set with textContent (org data is never parsed as HTML). */
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

const state = {
  api: null,
  kind: null, // "territories" | "roles"
  seq: 0, // bumped on every switch, so a slow read cannot draw over a newer view
  territories: { on: null, models: [], modelId: null, trees: new Map(), error: null },
  roles: { tree: null, portalCount: null, error: null },
  failed: false, // the read for the current view failed
  tech: [], // raw messages for Notes
  branch: null, // the node chosen in the search box, or null for the whole hierarchy
  tree: null, // the tree on screen
  rows: [], // one entry per drawn row: {li, btn, node, people, size, folded, expanded, list}
  items: [], // what is on screen: [{node, depth}]
  show: "none", // "none" | "name" | "username" | "email" | "id": what to show for each user
  inactive: false, // include inactive users
  userData: new WeakMap(), // tree -> {status: "loading" | "ok" | "error", byNode, unmatched, error, promise}; in memory only
};
const FIRST_USERS = 10; // users listed on a node before "Show all"

// ---------- where the data comes from: the org, or the made-up samples in demo mode ----------

async function sample(name) {
  const res = await fetch(`samples/${name}`);
  if (!res.ok) throw new Error(`Could not load samples/${name}`);
  return res.json();
}

const source = {
  async models() {
    if (!DEMO) return readTerritoryModels(state.api);
    const d = await sample("hierarchy_territories.json");
    return { on: true, models: d.models.map(({ territories, ...m }) => m) };
  },
  async territories(modelId) {
    if (!DEMO) return readTerritories(state.api, modelId);
    const d = await sample("hierarchy_territories.json");
    return d.models.find((m) => m.id === modelId)?.territories || [];
  },
  async roles() {
    if (!DEMO) return readRoles(state.api);
    const d = await sample("hierarchy_roles.json");
    return { roles: d.roles, portalCount: d.portalCount, warnings: [] };
  },
  async roleUsers() {
    if (!DEMO) return readRoleUsers(state.api);
    const d = await sample("hierarchy_roles.json");
    // Same shape as the live read: people in roles that are not on screen are counted, not returned.
    const ids = new Set(d.roles.map((r) => r.id));
    const users = d.users || [];
    const out = users.filter((u) => ids.has(u.nodeId));
    const portal = users.filter((u) => !ids.has(u.nodeId));
    return { users: out, portalUsers: { active: portal.filter((u) => u.active).length, all: portal.length }, warnings: [] };
  },
  async territoryUsers(modelId) {
    if (!DEMO) return readTerritoryUsers(state.api, modelId);
    const d = await sample("hierarchy_territories.json");
    return { users: d.models.find((m) => m.id === modelId)?.users || [], warnings: [] };
  },
};

// ---------- messages ----------

function showError(msg, raw) {
  const box = $("#error");
  box.hidden = !msg;
  box.replaceChildren();
  if (!msg) return;
  box.append(msg);
  if (raw) box.append(el("details", { class: "tech" }, el("summary", { text: "Technical details" }), el("div", { text: raw })));
}

/** A 401 already has plain wording from sfconn.js. */
const plainError = (e, fallback) => (e?.status === 401 ? e.message : fallback);
const rawOf = (e) => (e?.status === 401 ? "" : e?.message || String(e || ""));
const setProgress = (t) => { $("#progress").textContent = t || ""; };

function renderTech() {
  $("#notesPanel").hidden = !state.tech.length;
  $("#notesTitle").textContent = `Notes (${state.tech.length})`;
  $("#notes").replaceChildren(...state.tech.map((t) => el("li", { text: t })));
}

// ---------- connecting ----------

function orgKind(o) {
  if (o.isSandbox) return ["Sandbox", "sbx"];
  if (/developer|trial/i.test(o.edition || "")) return [o.edition, "sbx"];
  return ["Production", "prod"];
}

function showOrg(o, host, via) {
  const [kind, cls] = orgKind(o);
  setKids($("#org"),
    el("strong", { text: o.name || o.id }), " ",
    el("span", { class: `badge ${cls}`, text: kind }),
    via ? el("span", { class: "badge demo", text: via }) : null,
    el("span", { class: "host", text: host })
  );
  document.title = `Territory & role hierarchy – ${o.name || host}`;
}

async function connect() {
  if (DEMO) {
    $("#org").replaceChildren(el("span", { class: "badge demo", text: "DEMO" }), " Made-up sample territories and roles, no org connected");
    return true;
  }
  try {
    let session;
    if (DEV) {
      // The dev server holds the org login; the page never sees a session id.
      session = { apiHost: location.host, sessionId: "dev", base: `${location.origin}/sf` };
    } else if (HOST && typeof chrome !== "undefined" && chrome.cookies) {
      $("#org").textContent = `Connecting to ${HOST}…`;
      session = await findSession(HOST, chrome.cookies);
    } else {
      $("#org").textContent = "No org connected. Open this page from the extension button on a Salesforce tab.";
      return false;
    }
    state.api = new SfApi(session);
    const org = await readOrg(state.api, DEV ? "local dev server" : session.apiHost);
    showOrg(org, DEV ? "" : session.apiHost, DEV ? "DEV SERVER" : null);
    return true;
  } catch (e) {
    $("#org").textContent = `Could not connect${HOST ? " to " + HOST : ""}.`;
    showError(plainError(e, "Could not connect to the org. If you have been away a while, reload the Salesforce tab and try again."), rawOf(e));
    return false;
  }
}

// ---------- loading one view ----------

/** Read the territory models once. Never throws: a failure becomes `territories.error`. */
async function loadModels() {
  const t = state.territories;
  if (t.on !== null || t.error) return;
  try {
    const { on, models } = await source.models();
    t.on = on;
    t.models = models;
    t.modelId = defaultModel(models)?.id || null;
  } catch (e) {
    t.error = plainError(e, "The territories could not be read. Your user may not be allowed to see them.");
    state.tech.push(`Territories: ${rawOf(e)}`);
  }
}

const currentModel = () => state.territories.models.find((m) => m.id === state.territories.modelId) || null;

/** Make sure the tree for the current view is built. Returns it, or null when there is none. */
async function loadTree() {
  if (state.kind === "territories") {
    const t = state.territories;
    if (!t.on || t.error || !t.modelId) return null;
    if (!t.trees.has(t.modelId)) {
      try {
        t.trees.set(t.modelId, buildTree(await source.territories(t.modelId)));
      } catch (e) {
        state.tech.push(`Territories: ${rawOf(e)}`);
        throw Object.assign(new Error(plainError(e, "The territories could not be read. Your user may not be allowed to see them.")), { raw: rawOf(e) });
      }
    }
    return t.trees.get(t.modelId);
  }
  const r = state.roles;
  if (r.error) return null;
  if (!r.tree) {
    try {
      const res = await source.roles();
      r.tree = buildTree(res.roles);
      r.portalCount = res.portalCount;
      for (const w of res.warnings || []) state.tech.push(`Roles: ${w}`);
    } catch (e) {
      state.tech.push(`Roles: ${rawOf(e)}`);
      throw Object.assign(new Error(plainError(e, "The roles could not be read. If you have been away a while, reload the Salesforce tab and try again.")), { raw: rawOf(e) });
    }
  }
  return r.tree;
}

async function show(kind) {
  const mine = ++state.seq;
  state.kind = kind;
  state.branch = null;
  state.tree = null;
  state.failed = false;
  $("#findRow").hidden = true; // back after the read
  $("#find").value = "";
  closeFind();
  showError("");
  for (const [id, k] of [["#kindTerritories", "territories"], ["#kindRoles", "roles"]]) $(id).setAttribute("aria-pressed", String(k === kind));
  $("#findLabel").textContent = NOUNS[kind].find;
  $("#find").placeholder = "Type part of a name or API name";
  setProgress(`Reading ${NOUNS[kind].many}…`);
  let tree = null;
  let failure = null;
  try {
    if (kind === "territories") { await loadModels(); if (mine !== state.seq) return; }
    renderModelRow();
    tree = await loadTree();
  } catch (e) {
    failure = e;
  }
  if (mine !== state.seq) return;
  if (!failure && kind === "territories" && state.territories.error) failure = new Error(state.territories.error);
  setProgress("");
  renderTech();
  if (failure) { state.failed = true; showError(failure.message, failure.raw); }
  state.tree = tree;
  render();
  if (tree && state.show !== "none") applyUsers();
}

// ---------- drawing ----------

function renderModelRow() {
  const t = state.territories;
  const many = state.kind === "territories" && t.models.length > 1;
  $("#modelRow").hidden = !many;
  if (!many) return;
  $("#model").replaceChildren(...t.models.map((m) => el("option", { value: m.id, text: m.state ? `${m.name} (${m.state})` : m.name })));
  $("#model").value = t.modelId;
}

/** Why there is no tree, in plain words. */
function emptyMessage() {
  const k = state.kind;
  if (state.failed) return `The ${NOUNS[k].many} could not be read. See the message above.${k === "territories" ? " Roles still work." : ""}`;
  if (k === "territories") {
    const t = state.territories;
    if (t.error) return "The territories could not be read. See the message above. Roles still work.";
    if (!t.on) return "Territories are not turned on in this org (Enterprise Territory Management), so there is no territory hierarchy to show. Roles still work: choose Roles above.";
    if (!t.models.length) return "This org has no territory models yet.";
    return "There are no territories in this model.";
  }
  return state.roles.error || "There are no roles to show.";
}

function render() {
  const tree = state.tree;
  const k = state.kind;
  const has = !!tree && tree.count > 0;
  $("#results").hidden = false;
  $("#findRow").hidden = !has;
  $("#summary").hidden = !tree;
  $("#toolbar").hidden = !has;
  $(".treewrap").hidden = !has;
  $("#empty").hidden = has;
  if (!has) {
    $("#empty").textContent = emptyMessage();
    $("#summary").textContent = "";
    $("#treeNotes").replaceChildren();
    $("#branchBar").hidden = true;
    $("#usersMsg").hidden = true;
    return;
  }
  renderBranchBar();
  renderTree();
  refreshUsers();
}

/** Notes under the summary. In a branch, only what applies to the nodes on screen. */
function renderNotes(tree, k) {
  const notes = treeNotes(tree, k, state.branch ? state.items : null);
  const e = shownUsers();
  if (e && !state.branch) {
    const n = k === "roles"
      ? (e.portalUsers ? (state.inactive ? e.portalUsers.all : e.portalUsers.active) : 0)
      : e.unmatched.filter((u) => u.active || state.inactive).length;
    if (n) notes.push(`${n.toLocaleString("en-US")} ${n === 1 ? "user is" : "users are"} ${k === "roles" ? "in roles that are not shown (portal and community roles)" : "assigned to territories that are not shown"}.`);
  }
  if (k === "roles" && !state.branch && state.roles.portalCount) {
    const n = state.roles.portalCount;
    notes.push(`${n.toLocaleString("en-US")} portal and community ${n === 1 ? "role is" : "roles are"} not shown.`);
  }
  $("#treeNotes").replaceChildren(...notes.map((t) => el("li", { text: t })));
}

function renderBranchBar() {
  const bar = $("#branchBar");
  const b = state.branch;
  bar.hidden = !b;
  if (!b) return;
  const above = [];
  for (let n = b.parent; n; n = n.parent) above.unshift(n);
  const crumbs = [];
  above.forEach((n) => crumbs.push(el("button", { class: "link", type: "button", text: n.name, onclick: () => pick(n) }), PATH_SEP));
  crumbs.push(b.name);
  bar.replaceChildren(
    el("span", { class: "what", text: `Showing ${b.name} and everything below it` }),
    el("span", { class: "crumbs" }, "· ", crumbs),
    el("button", { class: "whole", type: "button", text: "Show whole hierarchy", onclick: () => pick(null) })
  );
}

/** Draw every row once, with a DocumentFragment. Folding later only toggles `hidden`. */
function renderTree() {
  const tree = state.tree;
  const k = state.kind;
  const items = state.branch ? flatten([state.branch]) : flatten(tree.roots);
  state.items = items;
  const frag = document.createDocumentFragment();
  const rows = [];
  items.forEach(({ node, depth }, i) => {
    const li = el("li", { class: depth === 0 ? "top" : "" });
    li.style.setProperty("--d", String(depth));
    const size = node.size;
    const lead = size
      ? el("button", { class: "fold", type: "button", "aria-expanded": "true", "aria-label": `Collapse ${node.name}`, "data-i": String(i), text: "▾" })
      : el("span", { class: "spacer" });
    const people = el("div", { class: "people", hidden: true });
    li.append(
      el("span", { class: "indent", "aria-hidden": "true" }),
      lead,
      el("div", { class: "body" },
        el("span", { class: "node" },
          el("span", { class: "nm", text: node.name }),
          size ? el("span", { class: "below", text: `${size.toLocaleString("en-US")} below` }) : null,
          node.orphan ? el("span", { class: "flag", text: "Parent not found" }) : null,
          node.inLoop ? el("span", { class: "flag", text: node.loopCut ? "Parent loop, cut here" : "Parent loop" }) : null,
          node.apiName ? el("span", { class: "api", text: node.apiName }) : null),
        people)
    );
    frag.append(li);
    rows.push({ li, btn: size ? lead : null, name: node.name, node, people, size, folded: false, expanded: false, list: null });
  });
  state.rows = rows;
  $("#tree").replaceChildren(frag);
  renderSummary();
}

function renderSummary() {
  const k = state.kind;
  const text = summaryText(statsOf(state.items), k);
  const model = k === "territories" ? currentModel() : null;
  const e = shownUsers();
  setKids($("#summary"),
    state.branch ? `${state.branch.name} and everything below it: ${text}` : text,
    e ? el("span", { class: "sub", text: `  ·  ${usersSummary(countUsers(e.byNode, state.items), state.inactive, k)}` }) : null,
    model ? el("span", { class: "sub", text: `  ·  Model: ${model.name}${model.state ? ` (${model.state})` : ""}` }) : null
  );
}

// ---------- users in each role / territory ----------

/** The loaded users for the tree on screen, when they are switched on and were read; else null. */
function shownUsers() {
  const e = state.tree && state.userData.get(state.tree);
  return state.show !== "none" && e?.status === "ok" ? e : null;
}

/** Read the users for a tree once (roles: all users that have a role; territories: the model's assignments).
 *  Never throws: a failure is kept on the entry and gives a message about the users only. */
function loadUsers(tree) {
  let e = state.userData.get(tree);
  if (e && e.status !== "error") return e.promise;
  const kind = state.kind;
  const modelId = state.territories.modelId;
  e = { status: "loading", byNode: null, unmatched: [], portalUsers: null, error: "", promise: null };
  e.promise = (async () => {
    try {
      const res = kind === "territories" ? await source.territoryUsers(modelId) : await source.roleUsers();
      const a = attachUsers(tree, res.users);
      e.byNode = a.byNode;
      e.unmatched = a.unmatched;
      e.portalUsers = res.portalUsers || null;
      e.status = "ok";
      for (const w of res.warnings || []) state.tech.push(`Users: ${w}`);
    } catch (err) {
      e.status = "error";
      e.error = plainError(err, "The users could not be read. Your user may not be allowed to see them.");
      state.tech.push(`Users: ${rawOf(err)}`);
    }
    return e;
  })();
  state.userData.set(tree, e);
  return e.promise;
}

/** Called when "Show users" or "Include inactive users" changes, or a view with users on opens. */
async function applyUsers() {
  const tree = state.tree;
  $("#inactiveLabel").hidden = state.show === "none";
  if (!tree) return;
  if (state.show !== "none") {
    const e = state.userData.get(tree);
    if (!e || e.status !== "ok") {
      setProgress("Reading users…");
      await loadUsers(tree);
      renderTech();
      if (state.tree === tree) setProgress("");
      if (state.tree !== tree) return;
    }
  }
  refreshUsers();
}

/** Redraw the people under each row, the summary, the notes and the hint. Nothing is read here. */
function refreshUsers() {
  const tree = state.tree;
  if (!tree) return;
  const e = shownUsers();
  const entry = state.userData.get(tree);
  const msg = $("#usersMsg");
  if (state.show !== "none" && entry?.status === "error") {
    msg.hidden = false;
    msg.className = "usersmsg bad";
    msg.textContent = `${entry.error} The ${NOUNS[state.kind].many} are shown without users.`;
  } else if (e) {
    msg.hidden = false;
    msg.className = "usersmsg";
    msg.textContent = `Download for Excel adds each person's ${USER_FIELDS[state.show].short} in the same row as their ${NOUNS[state.kind].one}, one column per person.`;
  } else {
    msg.hidden = true;
  }
  for (const row of state.rows) { row.list = null; renderPeople(row, e); }
  renderSummary();
  renderNotes(tree, state.kind);
}

/** The count and the users of one row. The first few are listed; "Show all" opens the rest. */
function renderPeople(row, e) {
  const box = row.people;
  if (!e) { box.hidden = true; box.replaceChildren(); return; }
  row.list ??= listUsers(e.byNode, row.node, state.show, state.inactive);
  const list = row.list;
  const n = list.length;
  box.hidden = false;
  if (!n) { setKids(box, el("span", { class: "ucount", text: "No users" })); return; }
  const open = row.expanded || n <= FIRST_USERS;
  const shown = open ? list : list.slice(0, FIRST_USERS);
  const bits = [el("span", { class: "ucount", text: `${n.toLocaleString("en-US")} ${n === 1 ? "user" : "users"}` })];
  bits.push(el("span", { class: "ulist" }, shown.map((u, i) => el("span", { class: "u" }, i ? el("span", { class: "sep", text: "; " }) : null, u.display))));
  if (n > FIRST_USERS) {
    bits.push(el("button", {
      class: "link", type: "button", "aria-expanded": String(open),
      text: open ? "Show fewer" : `Show all ${n.toLocaleString("en-US")}`,
      onclick: () => { row.expanded = !row.expanded; renderPeople(row, shownUsers()); },
    }));
  }
  setKids(box, bits);
}

function setFolded(row, folded) {
  row.folded = folded;
  row.btn.setAttribute("aria-expanded", String(!folded));
  row.btn.setAttribute("aria-label", `${folded ? "Expand" : "Collapse"} ${row.name}`);
  row.btn.textContent = folded ? "▸" : "▾";
}

/** Show or hide the rows below row `i`, keeping folded descendants folded. */
function toggle(i) {
  const rows = state.rows;
  const row = rows[i];
  setFolded(row, !row.folded);
  let blockedUntil = row.folded ? i + row.size : -1;
  for (let j = i + 1; j <= i + row.size; j++) {
    rows[j].li.hidden = j <= blockedUntil;
    if (!rows[j].li.hidden && rows[j].folded) blockedUntil = Math.max(blockedUntil, j + rows[j].size);
  }
}

function expandAll() {
  for (const r of state.rows) { if (r.btn) setFolded(r, false); r.li.hidden = false; }
}

function collapseAll() {
  state.rows.forEach((r, i) => { if (r.btn) setFolded(r, true); r.li.hidden = i > 0 && !r.li.classList.contains("top"); });
}

$("#tree").addEventListener("click", (e) => {
  const b = e.target.closest("button.fold");
  if (b) toggle(Number(b.dataset.i));
});
$("#expandAll").addEventListener("click", expandAll);
$("#collapseAll").addEventListener("click", collapseAll);
$("#showUsers").addEventListener("change", (e) => { state.show = e.target.value; applyUsers(); });
$("#inactive").addEventListener("change", (e) => { state.inactive = e.target.checked; if (shownUsers()) refreshUsers(); });
$("#showApi").addEventListener("change", (e) => $("#tree").classList.toggle("show-api", e.target.checked));
$("#kindTerritories").addEventListener("click", () => { if (state.kind !== "territories") show("territories"); });
$("#kindRoles").addEventListener("click", () => { if (state.kind !== "roles") show("roles"); });
$("#model").addEventListener("change", (e) => {
  state.territories.modelId = e.target.value;
  show("territories");
});

// ---------- search box: the list opens under it, one render per pick ----------

const find = { items: [], active: -1 };

function closeFind() {
  const list = $("#findList");
  list.hidden = true;
  $("#find").setAttribute("aria-expanded", "false");
  $("#find").removeAttribute("aria-activedescendant");
  find.items = [];
  find.active = -1;
}

function openFind() {
  const input = $("#find");
  const list = $("#findList");
  const text = (state.branch && input.value === state.branch.name ? "" : input.value).trim();
  if (!state.tree || !text) { closeFind(); return; }
  const { items, total } = searchNodes(state.tree, text);
  find.items = items;
  find.active = items.length ? 0 : -1;
  const lis = items.map((it, i) => el("li", {
    role: "option", id: `find-opt-${i}`, "aria-selected": String(i === 0),
    onmousedown: (e) => { e.preventDefault(); pick(it.node); },
    onmousemove: () => highlight(i),
  }, el("span", { class: "nm", text: it.node.name }),
     it.node.size ? el("span", { class: "below", text: `${it.node.size.toLocaleString("en-US")} below` }) : null,
     el("span", { class: "path", text: it.pathText })));
  if (!items.length) lis.push(el("li", { class: "none", text: `No ${NOUNS[state.kind].one} matches that.` }));
  else if (total > items.length) lis.push(el("li", { class: "none", text: `Showing the first ${items.length} of ${total.toLocaleString("en-US")} matches. Keep typing to narrow the list.` }));
  list.replaceChildren(...lis);
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  if (items.length) input.setAttribute("aria-activedescendant", "find-opt-0");
}

function highlight(i) {
  if (i < 0 || i >= find.items.length) return;
  find.active = i;
  [...$("#findList").querySelectorAll("li[role=option]")].forEach((li, j) => li.setAttribute("aria-selected", String(j === i)));
  const li = document.getElementById(`find-opt-${i}`);
  if (li) { li.scrollIntoView({ block: "nearest" }); $("#find").setAttribute("aria-activedescendant", li.id); }
}

/** Show one node and everything below it, or (null) the whole hierarchy. */
function pick(node) {
  state.branch = node;
  $("#find").value = node ? node.name : "";
  closeFind();
  render();
}

{
  const input = $("#find");
  input.addEventListener("input", openFind);
  input.addEventListener("focus", () => { input.select(); openFind(); });
  input.addEventListener("click", () => { if ($("#findList").hidden) openFind(); });
  input.addEventListener("blur", () => { closeFind(); input.value = state.branch ? state.branch.name : ""; });
  input.addEventListener("keydown", (e) => {
    const open = !$("#findList").hidden;
    if (e.key === "ArrowDown" && open) { highlight(Math.min(find.active + 1, find.items.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp" && open) { highlight(Math.max(find.active - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter" && open && find.active >= 0) { pick(find.items[find.active].node); e.preventDefault(); }
    else if (e.key === "Escape") closeFind();
  });
}

// ---------- download ----------

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

$("#download").addEventListener("click", () => {
  if (!state.tree) return;
  const e = shownUsers();
  const users = e ? { byNode: e.byNode, field: state.show, includeInactive: state.inactive } : null;
  const csv = toCsv(exportRows(state.tree, state.branch, users));
  const name = exportFileName({
    kind: NOUNS[state.kind].title,
    model: state.kind === "territories" ? currentModel()?.name : "",
    branch: state.branch?.name,
  }, stamp());
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------- start ----------

async function start() {
  if (!(await connect())) { $("#findRow").hidden = true; return; }
  setProgress("Reading…");
  await loadModels();
  setProgress("");
  renderTech();
  const t = state.territories;
  await show(t.on && !t.error && t.models.length ? "territories" : "roles");
}

start();
startLiveReload();

// Header links to GitHub's new-issue form. Only tool, extension version and browser go in the link.
{
  let manifestVersion = "";
  try { manifestVersion = chrome.runtime.getManifest().version; } catch { /* dev server */ }
  const version = versionText(manifestVersion, navigator);
  const link = (text, kind) => el("a", {
    href: issueUrl({ kind, tool: FEEDBACK_TOOLS.hierarchy, version }), target: "_blank", rel: "noopener noreferrer", text,
  });
  $("#feedback").replaceChildren(link("Report a bug", "bug"), " · ", link("Suggest an improvement", "enhancement"));
}
