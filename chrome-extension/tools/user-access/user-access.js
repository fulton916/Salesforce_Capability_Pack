// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

import { SfApi, findSession } from "../../shared/sfconn.js";
import { readOrg } from "../../shared/sfread.js";
import { searchUsers } from "../../shared/users-read.js";
import { matchUsers } from "../../shared/users-logic.js";
import { readUserAccess } from "./user-access-read.js";
import { readEacRaw, readPastedUsers, readEacPermissionAssignments } from "./user-access-eac-read.js";
import {
  ACTION_LIST, ACTIONS, CONFIG_ID_HELP, CONFIG_ID_BAD, CHANGE_WARNING, NO_UNDO_ADD, AFTER_STEP, INSPECTOR_UNVERIFIED, READ_ONLY_NOTE,
  NOT_VERIFIED_NOTE, MOVE_ORDER_NOTE, MOVE_UNDO_NOTE, PROFILE_ASSIGNMENT_NOTE, GIVE_BACK_NOTE,
  validConfigId, inspectorSteps, parsePasted, matchPasted, knownConfigs, entryFromRow, entryFromUser, entryFromRecord, entryKey,
  planChange, planUserCount, planRemovalCount, involvedPermissions, permissionWarning, permissionRowFrom, skipGroups, skipHelp, previewSummary,
  outputFor, changeFileName, copyWithFallback, duplicatesText,
} from "./user-access-eac-changes.js";
import {
  buildEacRows, eacCounts, filterEacRows, filterNoConfig, groupByConfig, eacCsvRows, noConfigCsvRows, eacSummaryLine, profileNote,
  eacApiLine, assignedText, flagText, syncCell, SHOW_CHOICES, NO_CONFIG_TITLE, INACTIVE_TEXT, EAC_KEY, EAC_OFF_TEXT, EMPTY_CONFIG_NOTE, NO_EAC_USER_TEXT,
} from "./user-access-eac.js";
import {
  SECTIONS, SECTION_KEYS, SECTION_TITLES, SECTION_HELP, validateAccess, compareUsers, singleRows,
  statusText, plural, countText, toRows, toRowsSingle, toCsv, itemsOf, hasDetails,
  userCardLines, orgParts, SINGLE_VALUE_KEYS, customSettingsLine, customSettingsSkippedNote, customSettingsFailedNote, customSettingsHiddenNote,
} from "./user-access-logic.js";
import { startLiveReload } from "../../shared/livereload.js";
import { issueUrl, FEEDBACK_TOOLS, versionText } from "../../shared/feedback.js";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const DEV = params.has("dev"); // served by dev/dev_server.py, which forwards API calls to the org
const HOST = params.get("host");
const MAX_ROWS = 2000; // rows drawn per list; downloads have everything
const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

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
  demoUsers: [], // demo mode: the sample access objects
  sides: { a: { user: null, access: null, token: 0 }, b: { user: null, access: null, token: 0 } },
  result: null, // compare result when both users are loaded
  tab: "overview",
  diffOnly: true,
  showApi: false,
  search: "",
  eac: { rows: [], profileAssignments: [], profileRows: [], noConfig: null, sel: new Map(), plan: null, notFound: [], demoUsers: [], demoPermissions: [], accessNote: "", note: "", show: "all", search: "", showApi: false, loaded: false, limits: new Map() },
};

const compareMode = () => !!(state.sides.a.access && state.sides.b.access);
const nameOf = (side) => (state.result ? state.result.names[side] : state.sides[side].access?.user.name || side.toUpperCase());

/** Show a plain message in the error box. The raw Salesforce message goes in a folded "Technical details". */
function showError(msg, raw) {
  const box = $("#error");
  box.hidden = !msg;
  box.replaceChildren();
  if (!msg) return;
  box.append(msg);
  if (raw) box.append(el("details", { class: "tech" }, el("summary", { text: "Technical details" }), el("div", { text: raw })));
}

/** Plain wording for a failure. A 401 already has plain wording from sfconn.js. */
const plainError = (e, fallback) => (e?.status === 401 ? e.message : fallback);
const rawOf = (e, fallback) => (e?.status === 401 ? "" : e?.message || String(e || fallback));

function setProgress(text) {
  $("#progress").textContent = text || "";
}

// ---------- connecting ----------

function showOrg(o, host, via) {
  // Built from orgParts() so a missing value is left out: replaceChildren(null) would print "null".
  const parts = orgParts(o, host, via).map((p) => el(p.tag, { class: p.cls, text: p.text }));
  $("#org").replaceChildren(...parts.flatMap((n, i) => (i ? [" ", n] : [n])));
  document.title = `User access summary and comparison – ${o.name || host}`;
}

async function connect() {
  if (DEMO) {
    $("#org").replaceChildren(el("span", { class: "badge demo", text: "DEMO" }), " Made-up sample users, no org connected");
    await loadDemo();
    return;
  }
  let session = null;
  try {
    if (DEV) {
      // The dev server holds the org login; the page never sees a session id.
      session = { apiHost: location.host, sessionId: "dev", base: `${location.origin}/sf` };
    } else if (HOST && typeof chrome !== "undefined" && chrome.cookies) {
      $("#org").textContent = `Connecting to ${HOST}…`;
      session = await findSession(HOST, chrome.cookies);
    } else {
      $("#org").textContent = "No org connected. Open this page from the Salesforce Capability Pack button on a Salesforce tab.";
      $$(".org-only").forEach((n) => (n.hidden = true));
      return;
    }
    state.api = new SfApi(session);
    const org = await readOrg(state.api, DEV ? "local dev server" : session.apiHost);
    showOrg(org, DEV ? "" : session.apiHost, DEV ? "Local dev server" : null);
    $("#input-a").focus();
  } catch (e) {
    $("#org").textContent = `Could not connect${HOST ? " to " + HOST : ""}.`;
    showError(plainError(e, "Could not connect to the org. If you have been away a while, reload the Salesforce tab and try again."), rawOf(e));
  }
}

async function loadDemo() {
  for (const side of ["a", "b"]) {
    const res = await fetch(`../../samples/user_${side}.json`);
    state.demoUsers.push(validateAccess(await res.json()));
  }
  await pick("a", summaryOf(state.demoUsers[0]), { quiet: true });
  await pick("b", summaryOf(state.demoUsers[1]), { quiet: true });
}

const summaryOf = (acc) => ({
  id: acc.user.id, name: acc.user.name, username: acc.user.username, isActive: acc.user.isActive,
  profile: itemsOf(acc, "profile")[0]?.label || "",
});

// ---------- user search box (one input, list opens under it) ----------

const combos = {};

function setupCombo(side) {
  const root = $(`.picker[data-side="${side}"]`);
  const input = $(".psg-input", root);
  const list = $(".psg-list", root);
  const c = (combos[side] = { input, list, items: [], active: -1, timer: null, seq: 0 });

  // Draw the list for what is typed. Org searches wait for a pause in typing and run in the org.
  c.open = () => {
    clearTimeout(c.timer);
    const chosen = state.sides[side].user;
    const text = (chosen && input.value === chosen.name ? "" : input.value).trim();
    c.seq++;
    if (DEMO) { draw(matchUsers(state.demoUsers.map((a) => summaryOf(a)), text)); return; }
    if (text.length < MIN_CHARS) { c.items = []; c.active = -1; drawMessage(`Type at least ${MIN_CHARS} letters of a name or username.`); return; }
    drawMessage("Searching…");
    const mine = c.seq;
    c.timer = setTimeout(async () => {
      try {
        const res = await searchUsers(state.api, text);
        if (mine === c.seq) draw(res);
      } catch (e) {
        if (mine === c.seq) {
          const plain = plainError(e, "The search did not work. If you have been away a while, reload the Salesforce tab and try again.");
          drawMessage(plain);
          showError(plain, rawOf(e));
        }
      }
    }, DEBOUNCE_MS);
  };

  function drawMessage(msg) {
    c.items = [];
    c.active = -1;
    list.replaceChildren(el("li", { class: "none", text: msg }));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function draw({ users, more }) {
    c.items = users;
    c.active = users.length ? 0 : -1;
    const lis = users.map((u, i) => el("li", {
      role: "option", id: `${side}-opt-${i}`, "aria-selected": String(i === c.active),
      onmousedown: (e) => { e.preventDefault(); pick(side, u); },
      onmousemove: () => highlight(side, i),
    }, el("span", { class: "nm", text: u.name }),
       u.isActive ? null : el("span", { class: "tag-inactive", text: "Inactive" }),
       el("span", { class: "dev plain", text: [u.username, u.profile].filter(Boolean).join(" · ") })));
    if (!users.length) lis.push(el("li", { class: "none", text: "No user found. Try a different part of the name or username." }));
    if (more) lis.push(el("li", { class: "none", text: `Showing the first ${users.length}. Keep typing to narrow the list.` }));
    list.replaceChildren(...lis);
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (c.active >= 0) input.setAttribute("aria-activedescendant", `${side}-opt-0`);
  }

  c.close = () => {
    clearTimeout(c.timer);
    c.seq++;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  input.addEventListener("focus", () => { input.select(); c.open(); });
  input.addEventListener("click", () => { if (list.hidden) c.open(); });
  input.addEventListener("input", c.open);
  input.addEventListener("blur", () => {
    c.close();
    // Leaving the box without picking puts the chosen user's name back.
    input.value = state.sides[side].user?.name || "";
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) { c.open(); e.preventDefault(); return; }
    if (e.key === "ArrowDown") { highlight(side, Math.min(c.active + 1, c.items.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { highlight(side, Math.max(c.active - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter" && !list.hidden && c.active >= 0) { pick(side, c.items[c.active]); e.preventDefault(); }
    else if (e.key === "Escape") c.close();
  });
}

function highlight(side, i) {
  const c = combos[side];
  if (i < 0) return;
  c.active = i;
  $$("li[role=option]", c.list).forEach((li, j) => li.setAttribute("aria-selected", String(j === i)));
  const li = document.getElementById(`${side}-opt-${i}`);
  if (li) { li.scrollIntoView({ block: "nearest" }); c.input.setAttribute("aria-activedescendant", li.id); }
}

/** Choose a user for side A or B and read their access from the org. */
async function pick(side, u, { quiet = false } = {}) {
  const s = state.sides[side];
  const token = ++s.token;
  Object.assign(s, { user: u, access: null });
  combos[side].input.value = u.name;
  combos[side].close();
  showError("");
  renderChosen(side);
  try {
    let access;
    if (DEMO) {
      access = state.demoUsers.find((a) => a.user.id === u.id);
    } else {
      setProgress(`Reading ${u.name}…`);
      access = await readUserAccess(state.api, u.id, { progress: (t) => setProgress(`${u.name}: ${t.toLowerCase()}…`) });
    }
    if (token !== s.token) return; // another pick replaced this one
    s.access = access;
  } catch (e) {
    if (token !== s.token) return;
    Object.assign(s, { user: null, access: null });
    combos[side].input.value = "";
    showError(plainError(e, `Could not read ${u.name}. If you have been away a while, reload the Salesforce tab and try again.`), rawOf(e));
  } finally {
    if (token === s.token) setProgress("");
  }
  renderChosen(side);
  refresh();
  if (!quiet && side === "a" && s.access && !state.sides.b.user) combos.b.input.focus();
}

function removeSide(side) {
  state.sides[side].token++;
  Object.assign(state.sides[side], { user: null, access: null });
  combos[side].input.value = "";
  renderChosen(side);
  refresh();
}

function renderChosen(side) {
  const s = state.sides[side];
  const box = $(`.picker[data-side="${side}"] .chosen`);
  if (!s.user) { box.replaceChildren(); return; }
  const nodes = [];
  if (side === "b") nodes.push(el("button", { class: "link", text: "Stop comparing", onclick: () => removeSide("b") }));
  if (side === "b" && !state.sides.a.access) nodes.push(el("div", { class: "sub", text: "Choose the first user to see the comparison." }));
  box.replaceChildren(...nodes);
}

for (const side of ["a", "b"]) setupCombo(side);

// ---------- results ----------

const TAB_ORDER = ["overview", ...SECTION_KEYS];

function refresh() {
  const a = state.sides.a.access;
  const b = state.sides.b.access;
  state.result = a && b ? compareUsers(a, b) : null;
  $("#results").hidden = !a;
  renderChosen("b");
  if (!a) return;
  if (!TAB_ORDER.includes(state.tab)) state.tab = "overview";
  state.search = "";
  $("#search").value = "";
  renderHero();
  renderCards();
  renderNotes();
  renderTabs();
  renderTable();
}

function who(access, side) {
  const u = access.user;
  const profile = itemsOf(access, "profile")[0]?.label;
  const role = itemsOf(access, "role")[0]?.label;
  return [
    el("div", { class: "who-name" }, nameOf(side), el("span", { class: u.isActive ? "tag-active" : "tag-inactive", text: u.isActive ? "Active" : "Inactive" })),
    el("div", { class: "who-sub", text: u.username }),
    el("div", { class: "who-line", text: `Profile: ${profile || "No profile"} · ${role ? `Role: ${role}` : "No role"}` }),
  ];
}

function renderHero() {
  const cmp = compareMode();
  $("#vs").classList.toggle("single", !cmp);
  $("#vsMid").hidden = !cmp;
  $("#whoB").hidden = !cmp;
  $("#whoA").replaceChildren(...who(state.sides.a.access, "a"));
  if (cmp) $("#whoB").replaceChildren(...who(state.sides.b.access, "b"));
  const v = state.result?.verdict;
  $("#verdict").hidden = !cmp;
  $("#verdict").textContent = v?.text || "";
  $("#verdict").className = `verdict ${v?.level || ""}`;
}

function unavailableMsg(k) {
  if (state.result) {
    const u = state.result.unavailable[k];
    if (!u) return null;
    return [u.a ? `${nameOf("a")}: ${u.a}` : null, u.b ? `${nameOf("b")}: ${u.b}` : null].filter(Boolean).join(" ");
  }
  return state.sides.a.access.unavailable?.[k] || null;
}

function renderCards() {
  // One user: the Summary tab already lists every count, so the cards would only repeat it.
  $("#cards").hidden = !state.result;
  if (!state.result) { $("#cards").replaceChildren(); return; }
  $("#cards").replaceChildren(...SECTIONS.map((s) => {
    const k = s.key;
    const na = unavailableMsg(k);
    const lines = [];
    let ok = true;
    if (na) {
      lines.push(el("div", { class: "na", text: "Not available" }));
    } else if (state.result) {
      for (const l of userCardLines(state.result, k)) {
        lines.push(el("div", { class: l.cls }, l.segs.map((g) => g.bold ? el("b", { text: g.text }) : g.side ? el("span", { class: `who-${g.side}`, text: g.text }) : g.text)));
      }
      const c = state.result.counts[k];
      ok = !(c.onlyA + c.onlyB + c.differ + (c.unread || 0));
    } else {
      const rows = singleRows(state.sides.a.access, k);
      if (SINGLE_VALUE_KEYS.includes(k)) lines.push(el("div", { class: "one", text: rows[0]?.label || `No ${s.one}` }));
      else lines.push(el("div", {}, el("b", { text: rows.length }), ` ${rows.length === 1 ? s.one : s.noun}`));
    }
    return el("button", { class: `card${ok ? " ok" : ""}`, onclick: () => openTab(k, true) }, el("div", { class: "card-title", text: s.title }), ...lines);
  }));
}

function renderNotes() {
  const notes = state.result ? state.result.notes : [
    ...Object.entries(state.sides.a.access.unavailable || {}).map(([k, m]) => `${SECTION_TITLES[k]}: ${m}`),
    ...(state.sides.a.access.warnings || []),
  ];
  $("#notesPanel").hidden = !notes.length;
  $("#notesTitle").textContent = `Notes (${notes.length})`;
  $("#notes").replaceChildren(...notes.map((t) => el("li", { text: t })));
}

function openTab(k, scroll = false) {
  state.tab = k;
  state.search = "";
  $("#search").value = "";
  renderTabs();
  renderTable();
  if (scroll) $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function tabCount(k) {
  if (state.result) {
    const c = state.result.counts[k];
    const n = c.onlyA + c.onlyB + c.differ;
    return { n, title: plural(n, "difference", "differences") };
  }
  const n = itemsOf(state.sides.a.access, k).length;
  return { n, title: plural(n, "item", "items") };
}

function renderTabs() {
  $("#tabs").replaceChildren(...TAB_ORDER.map((k) => {
    const { n, title } = k === "overview" ? { n: 0 } : tabCount(k);
    const attrs = { role: "tab", "aria-selected": String(state.tab === k), onclick: () => openTab(k) };
    if (k !== "overview") attrs["aria-label"] = `${SECTION_TITLES[k]}, ${title}`;
    return el("button", attrs,
      SECTION_TITLES[k], k === "overview" ? null : el("span", { class: `n${n ? "" : " zero"}`, title, text: String(n) }));
  }));
  $("#help").textContent = state.tab === "overview" && !state.result ? "A quick look at each area. Click a tab to see the list." : SECTION_HELP[state.tab] || "";
  if (state.result && state.tab !== "overview" && state.diffOnly) $("#help").textContent += " The list shows only differences. Choose “Everything” to see all.";
  $(".seg").hidden = state.tab === "overview" || !state.result;
}

// ---------- the list ----------

const YES = "✓";
const NO = "—";

function statusChip(r) {
  if (r.status === "same") return el("span", { class: "chip same", text: "Same" });
  const cls = { onlyA: "a", onlyB: "b", differ: "d", unreadA: "u", unreadB: "u" }[r.status];
  return el("span", { class: `chip ${cls}`, text: statusText(r.status, nameOf("a"), nameOf("b")) });
}

function itemCell(r) {
  return el("td", { class: "item" }, el("span", { text: r.label }), state.showApi && r.key !== r.label ? el("div", { class: "api", text: r.key }) : null);
}

/** On the email and calendar tab, "Show API names" adds the status's API name under the details. */
function withApi(item, detail) {
  if (!state.showApi || state.tab !== EAC_KEY || !item) return detail;
  return [detail, eacApiLine(item)].filter(Boolean).join("\n");
}

function presence(item, detail) {
  detail = withApi(item, detail);
  if (!item) return detail ? el("td", { class: "no" }, el("div", { class: "how", text: detail })) : el("td", { class: "no", text: NO });
  return el("td", {}, el("span", { class: "yes", text: YES }), detail ? el("div", { class: "how", text: detail }) : null);
}

/** Overview rows: one per area, with the user's profile/role name or an item count. */
function overviewValue(access, k) {
  const na = access.unavailable?.[k];
  if (na) return "Not available";
  const items = itemsOf(access, k);
  if (SINGLE_VALUE_KEYS.includes(k)) return items[0]?.label || `No ${SECTIONS.find((s) => s.key === k).one}`;
  const failed = k === "customSettings" ? customSettingsFailedNote(access) : "";
  return failed ? `${items.length} (${failed.replace(/\.$/, "")})` : String(items.length);
}

/** A custom setting value cell: the value first, then where it comes from. A user without the row is at the org default. */
function settingCell(item, detail) {
  if (!item) return el("td", { class: "no" }, el("div", { class: "how", text: detail || NO }));
  return el("td", {}, el("b", { text: item.valueText }), el("div", { class: "how", text: `${item.sourceText}\nOrg default: ${item.orgDefaultText}` }));
}

/** Setting label and field label, with the API names under them when "Show API names" is on. */
function settingNameCell(r, part) {
  const it = r.a || r.b || r.item;
  const x = it[part];
  return el("td", { class: "item" }, el("span", { text: x.label }), state.showApi ? el("div", { class: "api", text: x.api }) : null);
}

function currentRows() {
  if (state.tab === "overview") {
    return SECTIONS.map((s) => ({ key: s.key, label: s.title, a: overviewValue(state.sides.a.access, s.key), b: state.sides.b.access ? overviewValue(state.sides.b.access, s.key) : null, status: "overview" }));
  }
  return state.result ? state.result.sections[state.tab] : singleRows(state.sides.a.access, state.tab);
}

function columns() {
  const cmp = !!state.result;
  const A = nameOf("a");
  const B = nameOf("b");
  const headA = el("span", {}, el("span", { class: "dot a" }), A);
  const headB = el("span", {}, el("span", { class: "dot b" }), B);
  if (state.tab === "overview") {
    return cmp
      ? { head: ["", headA, headB], row: (r) => [el("td", { class: "item", text: r.label }), el("td", { text: r.a }), el("td", { text: r.b })] }
      : { head: ["", "Access"], row: (r) => [el("td", { class: "item", text: r.label }), el("td", { text: r.a })] };
  }
  if (state.tab === "customSettings") {
    return cmp
      ? { head: ["Setting", "Field", headA, headB, "Difference"], row: (r) => [settingNameCell(r, "setting"), settingNameCell(r, "field"), settingCell(r.a, r.detailA), settingCell(r.b, r.detailB), el("td", {}, statusChip(r))] }
      : { head: ["Setting", "Field", "Value for this user", "Comes from", "Org default"], row: (r) => [settingNameCell(r, "setting"), settingNameCell(r, "field"), el("td", {}, el("b", { text: r.item.valueText })), el("td", { text: r.item.sourceText }), el("td", { text: r.item.orgDefaultText })] };
  }
  if (cmp) {
    return { head: [SECTION_TITLES[state.tab], headA, headB, "Difference"], row: (r) => [itemCell(r), presence(r.a, r.detailA), presence(r.b, r.detailB), el("td", {}, statusChip(r))] };
  }
  if (!hasDetails(currentRows())) return { head: [SECTION_TITLES[state.tab]], row: (r) => [itemCell(r)] };
  return { head: [SECTION_TITLES[state.tab], "Details"], row: (r) => [itemCell(r), el("td", { class: "how", text: withApi(r.item, r.detail) })] };
}

function visibleRows() {
  const rows = currentRows();
  const words = state.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (state.diffOnly && state.result && state.tab !== "overview" && r.status === "same") return false;
    if (!words.length) return true;
    const hay = [r.key, r.label, r.detail, r.detailA, r.detailB].filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function renderTable() {
  if (!state.sides.a.access) return;
  const spec = columns();
  const rows = visibleRows();
  const wrap = $("#table");
  const parts = [];
  const na = state.tab === "overview" ? null : unavailableMsg(state.tab);
  if (na) parts.push(el("div", { class: "unavail", text: na }));
  if (state.tab === "customSettings") {
    const sides = state.result ? ["a", "b"] : ["a"];
    const who = (s) => (state.result ? el("b", { text: `${nameOf(s)}: ` }) : null);
    const lines = sides.flatMap((s) => [customSettingsLine(state.sides[s].access), customSettingsFailedNote(state.sides[s].access)]
      .map((text) => (text ? el("div", {}, who(s), text) : null)))
      .concat(customSettingsSkippedNote(...sides.map((s) => state.sides[s].access)) || null)
      .concat(customSettingsHiddenNote(...sides.map((s) => state.sides[s].access)) || null)
      .filter(Boolean).map((n) => (n instanceof Node ? n : el("div", { text: n })));
    if (lines.length) parts.push(el("div", { class: "cs-count" }, lines));
  }
  if (!rows.length) {
    const total = currentRows().length;
    let msg = na ? "" : state.tab === "customSettings" && !state.result ? "No custom setting has a value for this user or their profile that differs from the org default." : state.tab === EAC_KEY && !state.result ? NO_EAC_USER_TEXT : "Nothing here.";
    if (!na && state.search) msg = "Nothing matches your search.";
    else if (!na && total && state.diffOnly && state.result) msg = `No differences: ${total === 1 ? "the 1 item is" : `all ${total} items are`} the same for both users. Choose “Everything” to see them.`;
    wrap.replaceChildren(...parts, msg ? el("div", { class: "empty", text: msg }) : "");
    return;
  }
  const body = rows.slice(0, MAX_ROWS).map((r) => el("tr", { class: r.status }, spec.row(r)));
  parts.push(el("table", {}, el("thead", {}, el("tr", {}, spec.head.map((h) => el("th", {}, h)))), el("tbody", {}, body)));
  if (rows.length > MAX_ROWS) {
    parts.push(el("div", { class: "more", text: `Showing the first ${MAX_ROWS} of ${rows.length}. Search to narrow the list, or download it to see everything.` }));
  }
  wrap.replaceChildren(...parts);
}

$("#search").addEventListener("input", (e) => { state.search = e.target.value; renderTable(); });
$("#showApi").addEventListener("change", (e) => { state.showApi = e.target.checked; renderTable(); });
for (const [id, diffOnly] of [["#showDiff", true], ["#showAll", false]]) {
  $(id).addEventListener("click", () => {
    state.diffOnly = diffOnly;
    $("#showDiff").setAttribute("aria-pressed", String(diffOnly));
    $("#showAll").setAttribute("aria-pressed", String(!diffOnly));
    renderTabs();
    renderTable();
  });
}

// ---------- downloads (CSV only: nothing about users is saved as a file to load later) ----------

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $$(".menu").forEach((m) => { m.open = false; });
}

const safe = (s) => String(s || "").replace(/[^\w.-]+/g, "_").slice(0, 60);
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

function csv(onlySection) {
  return toCsv(state.result ? toRows(state.result, onlySection) : toRowsSingle(state.sides.a.access, onlySection));
}

function baseName() {
  const a = state.sides.a.access.user.username;
  const b = state.sides.b.access?.user.username;
  return b ? `access_${safe(a)}_vs_${safe(b)}_${stamp()}` : `access_${safe(a)}_${stamp()}`;
}

$("#csvTab").addEventListener("click", () => {
  const only = state.tab === "overview" ? null : state.tab;
  download(`${baseName()}${only ? "_" + safe(SECTION_TITLES[only]) : ""}.csv`, csv(only), "text/csv");
});
$("#csvAll").addEventListener("click", () => download(`${baseName()}.csv`, csv(null), "text/csv"));
document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) $$(".menu").forEach((m) => { m.open = false; }); });

// ---------- who is in each email and calendar configuration (Einstein Activity Capture) ----------

const eac = state.eac;
const EAC_PAGE = 200; // members drawn per configuration at first; "Show more" adds this many; downloads have everything
const NO_CONFIG_KEY = "\u0000noConfig";

async function loadEacRaw() {
  if (DEMO) {
    const raw = await (await fetch("../../samples/eac_all_demo.json")).json();
    eac.demoUsers = raw.users || [];
    eac.demoPermissions = raw.permissionAssignments || [];
    return raw;
  }
  return readEacRaw(state.api, { progress: (t) => { $("#eacProgress").textContent = t; } });
}

async function showEveryone() {
  $("#eacError").hidden = true;
  $("#eacLoad").disabled = true;
  $("#eacProgress").textContent = "Reading…";
  try {
    const raw = await loadEacRaw();
    const built = buildEacRows(raw);
    Object.assign(eac, {
      rows: built.rows, profileAssignments: built.profileAssignments, profileRows: built.profileRows, noConfig: built.noConfig,
      accessNote: raw.accessNote || "", loaded: true, note: raw.partial || "", limits: new Map(),
    });
    // A fresh read: the old picks may no longer be true, so start the change again.
    eac.sel = new Map(); eac.notFound = []; eac.plan = null;
    $("#eacPreviewBox").hidden = true; $("#eacPasteResult").replaceChildren(); $("#eacPasteStatus").textContent = "";
    renderEac();
  } catch (e) {
    $("#eacResult").hidden = true;
    const box = $("#eacError");
    box.replaceChildren(e?.featureOff ? EAC_OFF_TEXT : plainError(e, "Einstein Activity Capture could not be read. Your user may not have permission to see it. Ask an admin to check."));
    if (!e?.featureOff && rawOf(e)) box.append(el("details", { class: "tech" }, el("summary", { text: "Technical details" }), el("div", { text: rawOf(e) })));
    box.hidden = false;
  } finally {
    $("#eacLoad").disabled = false;
    $("#eacLoad").textContent = eac.loaded ? "Read again" : "Show everyone";
    $("#eacProgress").textContent = "";
  }
}

const eacShown = () => filterEacRows(eac.rows, { show: eac.show, search: eac.search });
const noConfigShown = () => filterNoConfig(eac.noConfig, { search: eac.search });
const slug = (s) => safe(s).toLowerCase();
const num = (n) => n.toLocaleString("en-US");

function countList(title, items, text) {
  return el("div", {}, el("h3", { text: title }), el("ul", {}, items.map((i) => el("li", {}, el("span", { class: "n", text: String(i.count) }), ` ${text(i)}`))));
}

function renderEac() {
  $("#eacResult").hidden = false;
  const c = eacCounts(eac.rows);
  $("#eacConfigNote").textContent = EMPTY_CONFIG_NOTE;
  $("#eacSummary").textContent = eac.rows.length ? eacSummaryLine(c) : "No one has an email and calendar connection or assignment.";
  const extra = [
    `${num(c.inactive)} inactive ${c.inactive === 1 ? "user" : "users"} still assigned`,
    `${num(c.nothingSynced)} connected with nothing synced yet`,
    eac.noConfig ? `${num(eac.noConfig.length)} with access but in no configuration` : "",
  ].filter(Boolean);
  $("#eacExtra").textContent = `${extra.join(". ")}.`;
  $("#eacCounts").replaceChildren(
    countList("By configuration", c.byConfig, (i) => `${i.name}${i.notConnected ? ` (${i.notConnected} not connected)` : ""}`),
    countList("By status", c.byStatus, (i) => i.text),
  );
  const note = [profileNote(eac.profileAssignments), eac.accessNote, eac.note].filter(Boolean).join(" ");
  $("#eacNote").hidden = !note;
  $("#eacNote").textContent = note;
  $("#eacCsvNoConfig").hidden = !eac.noConfig?.length;
  renderChangeControls();
  renderEacGroups();
}

/** A tick box for one picked row. It changes the selection in place (no redraw), and a shown preview is dropped. */
function pickBox(entry) {
  return el("input", {
    type: "checkbox", "aria-label": `Pick ${entry.name}`, checked: eac.sel.has(entryKey(entry)),
    onchange: (ev) => { if (ev.target.checked) addSel(entry); else eac.sel.delete(entryKey(entry)); selectionChanged(); },
  });
}
const addSel = (entry) => { eac.sel.set(entryKey(entry), entry); selectionChanged(); };

function memberTable(rows, limit) {
  const head = ["", "Name", "Username", "Email", "Active", "How assigned", "Connection status", "Contacts synced", "Events synced"];
  const body = rows.slice(0, limit).map((r) => el("tr", {},
    el("td", { class: "eac-pick" }, pickBox(entryFromRow(r))),
    el("td", { class: "item", text: r.name }),
    el("td", { class: "how", text: r.username }),
    el("td", { class: "how", text: r.email }),
    el("td", {}, r.isActive ? "Yes" : el("span", { class: "eac-bad", text: INACTIVE_TEXT })),
    el("td", { text: assignedText(r) }),
    el("td", {},
      el("span", { class: r.connected ? "eac-ok" : "eac-bad", text: r.statusText }),
      r.nothingSynced ? el("div", { class: "eac-flag", text: flagText({ isActive: true, nothingSynced: true }) }) : null,
      r.recommendedTitle ? el("div", { class: "how", text: r.recommendedTitle }) : null,
      eac.showApi && r.hasRow ? el("div", { class: "api", text: r.status || "(blank)" }) : null),
    el("td", { text: syncCell(r, r.contactsSynced) }),
    el("td", { text: syncCell(r, r.eventsSynced) })));
  return el("div", { class: "tablewrap" }, el("table", {}, el("thead", {}, el("tr", {}, head.map((h) => el("th", {}, h)))), el("tbody", {}, body)));
}

function moreButton(key, total, limit) {
  if (total <= limit) return null;
  return el("div", { class: "more" },
    `Showing ${num(limit)} of ${num(total)}. `,
    el("button", { onclick: () => { eac.limits.set(key, limit + EAC_PAGE); renderEacGroups(); }, text: `Show ${EAC_PAGE} more` }),
    " Or search to narrow the list, or download it to get everyone.");
}

function configSection(group, total) {
  const limit = eac.limits.get(group.name) || EAC_PAGE;
  const csvRows = eac.rows.filter((r) => r.configuration === group.name);
  return el("div", { class: "eac-group" },
    el("div", { class: "eac-group-head" },
      el("h3", { text: group.name }),
      el("span", { class: "count", text: `${num(total)} ${total === 1 ? "member" : "members"}${group.rows.length !== total ? `, ${num(group.rows.length)} shown` : ""}` }),
      el("button", { text: `Select all ${num(group.rows.length)} shown`, onclick: () => { for (const r of group.rows) addSel(entryFromRow(r)); renderEacGroups(); } }),
      el("button", { text: "This configuration (CSV for Excel)", onclick: () => download(`email_calendar_${slug(group.name)}_${stamp()}.csv`, toCsv(eacCsvRows(csvRows)), "text/csv") })),
    memberTable(group.rows, limit),
    moreButton(group.name, group.rows.length, limit));
}

function noConfigSection(list) {
  const limit = eac.limits.get(NO_CONFIG_KEY) || EAC_PAGE;
  const head = ["", "Name", "Username", "Email", "Active"];
  const body = list.slice(0, limit).map((u) => el("tr", {}, el("td", { class: "eac-pick" }, pickBox(entryFromUser(u))), el("td", { class: "item", text: u.name }), el("td", { class: "how", text: u.username }), el("td", { class: "how", text: u.email }), el("td", { text: u.isActive ? "Yes" : "No" })));
  const total = eac.noConfig.length;
  return el("div", { class: "eac-group" },
    el("div", { class: "eac-group-head" },
      el("h3", { text: NO_CONFIG_TITLE }),
      el("span", { class: "count", text: `${num(total)} ${total === 1 ? "user" : "users"}${list.length !== total ? `, ${num(list.length)} shown` : ""}` }),
      el("button", { text: `Select all ${num(list.length)} shown`, onclick: () => { for (const u of list) addSel(entryFromUser(u)); renderEacGroups(); } }),
      el("button", { text: "These users (CSV for Excel)", onclick: () => download(`email_calendar_no_configuration_${stamp()}.csv`, toCsv(noConfigCsvRows(eac.noConfig)), "text/csv") })),
    el("div", { class: "tablewrap" }, el("table", {}, el("thead", {}, el("tr", {}, head.map((h) => el("th", {}, h)))), el("tbody", {}, body))),
    moreButton(NO_CONFIG_KEY, list.length, limit));
}

function renderEacGroups() {
  const parts = [];
  if (eac.show === "noConfig") {
    const list = noConfigShown();
    if (!eac.noConfig) parts.push(el("div", { class: "empty", text: eac.accessNote || "Who has Einstein Activity Capture access could not be read." }));
    else if (!eac.noConfig.length) parts.push(el("div", { class: "empty", text: "Everyone with Einstein Activity Capture access is in a configuration." }));
    else if (!list.length) parts.push(el("div", { class: "empty", text: "Nothing matches your search." }));
    else parts.push(noConfigSection(list));
  } else {
    const totals = new Map(groupByConfig(eac.rows).map((g) => [g.name, g.rows.length]));
    for (const g of groupByConfig(eacShown())) parts.push(configSection(g, totals.get(g.name)));
    if (eac.show === "all" && eac.noConfig?.length && noConfigShown().length) parts.push(noConfigSection(noConfigShown()));
    if (!parts.length) {
      parts.push(el("div", { class: "empty", text: !eac.rows.length ? "Nothing to show." : eac.search ? "Nothing matches your search."
        : eac.show === "notConnected" ? "Everyone is connected." : eac.show === "inactive" ? "No inactive user is still assigned." : "Nothing to show here." }));
    }
  }
  $("#eacGroups").replaceChildren(...parts);
}

$("#eacShow").replaceChildren(...SHOW_CHOICES.map((c) => el("option", { value: c.value, text: c.label })));
$("#eacLoad").addEventListener("click", showEveryone);
$("#eacShow").addEventListener("change", (e) => { eac.show = e.target.value; eac.limits = new Map(); renderEacGroups(); });
$("#eacSearch").addEventListener("input", (e) => { eac.search = e.target.value; eac.limits = new Map(); renderEacGroups(); });
$("#eacShowApi").addEventListener("change", (e) => { eac.showApi = e.target.checked; renderEacGroups(); });
$("#eacCsvShown").addEventListener("click", () => {
  if (eac.show === "noConfig") download(`email_calendar_no_configuration_${stamp()}.csv`, toCsv(noConfigCsvRows(noConfigShown())), "text/csv");
  else download(`email_calendar_${eac.show}_${stamp()}.csv`, toCsv(eacCsvRows(eacShown())), "text/csv");
});
$("#eacCsvAll").addEventListener("click", () => download(`email_calendar_everyone_${stamp()}.csv`, toCsv(eacCsvRows(eac.rows)), "text/csv"));
$("#eacCsvNoConfig").addEventListener("click", () => download(`email_calendar_no_configuration_${stamp()}.csv`, toCsv(noConfigCsvRows(eac.noConfig || [])), "text/csv"));

// ---------- prepare a change (text to load with Salesforce Inspector or Data Loader; this page never writes) ----------

const TYPED = "__typed";

function selectionChanged() {
  eac.plan = null;
  $("#eacPreviewBox").hidden = true;
  const n = eac.sel.size;
  $("#eacSelCount").textContent = `${num(n)} ${n === 1 ? "row" : "rows"} picked`;
}

const chosenAction = () => $("#eacAction").value;
const chosenTarget = () => ($("#eacTarget").value === TYPED ? $("#eacTargetId").value.trim() : $("#eacTarget").value);

function renderTargetHelp() {
  const typed = $("#eacTarget").value === TYPED;
  $("#eacTargetId").hidden = !typed;
  const box = $("#eacTargetHelp");
  box.replaceChildren();
  if (!ACTIONS[chosenAction()]?.needsTarget) return;
  if (typed) {
    box.append(CONFIG_ID_HELP);
    const t = $("#eacTargetId").value.trim();
    if (t && !validConfigId(t)) box.append(el("div", { class: "eac-bad-text", text: CONFIG_ID_BAD }));
  } else {
    box.append("Configurations with no users are not in this list. To use one, choose “A configuration Id I type” and paste its Id.");
  }
}

/** Profile assignments cannot be removed here: for Remove and Move, list them with the way to change them in Setup. */
function renderProfileList() {
  const box = $("#eacProfileList");
  const show = chosenAction() !== "add" && eac.profileRows.length > 0;
  box.hidden = !show;
  box.replaceChildren();
  if (!show) return;
  box.append(el("h4", { text: "Profile assignments" }),
    el("p", { class: "help", text: `${PROFILE_ASSIGNMENT_NOTE} These profiles are assigned to a configuration:` }),
    el("ul", { class: "eac-names" }, eac.profileRows.map((p) => el("li", {
      text: `Profile ${p.profileName} in ${p.configuration}${p.members !== null ? ` (${num(p.members)} ${p.members === 1 ? "user" : "users"})` : ""}`,
    }))));
}

/** Rebuild the action and configuration lists after a read. Keeps what was chosen when it is still there. */
function renderChangeControls() {
  $("#eacChangeNote").textContent = READ_ONLY_NOTE;
  const known = knownConfigs(eac.rows, eac.profileRows);
  const keep = $("#eacTarget").value;
  $("#eacTarget").replaceChildren(
    el("option", { value: "", text: "Pick a configuration…" }),
    ...known.map((c) => el("option", { value: c.id, text: `${c.name} (${num(c.count)} ${c.count === 1 ? "user" : "users"})` })),
    el("option", { value: TYPED, text: "A configuration Id I type…" }));
  if ([...$("#eacTarget").options].some((o) => o.value === keep)) $("#eacTarget").value = keep;
  $("#eacTargetWrap").hidden = !ACTIONS[chosenAction()]?.needsTarget;
  renderTargetHelp();
  renderProfileList();
  selectionChanged();
}

function onActionChange() {
  $("#eacTargetWrap").hidden = !ACTIONS[chosenAction()]?.needsTarget;
  renderTargetHelp();
  renderProfileList();
  selectionChanged();
}

async function findPasted() {
  const { tokens, tooMany } = parsePasted($("#eacPaste").value);
  const status = $("#eacPasteStatus");
  const out = $("#eacPasteResult");
  out.replaceChildren();
  if (!tokens.length) { status.textContent = "Paste at least one username or email first."; return; }
  $("#eacPasteGo").disabled = true;
  status.textContent = "Looking them up…";
  try {
    const users = DEMO
      ? eac.demoUsers.filter((u) => tokens.some((t) => [u.Username, u.Email].some((v) => String(v || "").toLowerCase() === t.toLowerCase())))
      : await readPastedUsers(state.api, tokens);
    const m = matchPasted(tokens, users);
    for (const f of m.found) eac.sel.set(entryKey(entryFromRecord(f.user)), entryFromRecord(f.user));
    eac.notFound = m.notFound;
    selectionChanged();
    renderEacGroups();
    status.textContent = "";
    // Element.append prints a null argument as the word "null", so only real nodes go in.
    out.append(...[
      el("p", { text: `${num(m.found.length)} of ${num(tokens.length)} found and picked.${tooMany ? " Only the first 500 lines were used." : ""}` }),
      m.notFound.length ? el("div", {}, el("strong", { text: `Not found (${num(m.notFound.length)})` }), el("ul", { class: "eac-names" }, m.notFound.map((t) => el("li", { text: t })))) : null,
      m.ambiguous.length ? el("div", {}, el("strong", { text: "Matches more than one user, so none was picked. Paste the username instead" }),
        el("ul", { class: "eac-names" }, m.ambiguous.map((x) => el("li", { text: `${x.token} (${x.count} users)` })))) : null,
    ].filter(Boolean));
  } catch (e) {
    status.textContent = "";
    out.append(el("p", { class: "eac-bad-text", text: plainError(e, "The names could not be looked up. Your user may not have permission to read users.") }));
  } finally {
    $("#eacPasteGo").disabled = false;
  }
}

/** The text to copy by hand when the browser does not allow copying. Set through .value, never as HTML. */
function fallbackBox(text) {
  const ta = el("textarea", { rows: "8", readonly: true, "aria-label": "Text to copy", spellcheck: "false" });
  ta.value = text;
  return el("div", { class: "eac-fallback" },
    el("p", { class: "eac-bad-text", text: "Your browser did not allow copying. Select all and copy the text below." }),
    ta,
    el("button", { text: "Select all and copy", onclick: () => { ta.focus(); ta.select(); try { document.execCommand("copy"); } catch { /* the text stays selected for Ctrl+C */ } } }));
}

async function copyOut(text, label, holder, status) {
  holder.replaceChildren();
  const r = await copyWithFallback(text, navigator.clipboard);
  if (r.copied) status.textContent = `Copied ${label}. Now paste it in Salesforce Inspector.`;
  else { status.textContent = ""; holder.append(fallbackBox(text)); }
}

function nameList(items) {
  return el("ul", { class: "eac-names" }, items.map((i) => el("li", { text: i })));
}

/** One table to load: copy, download, and its own steps in Salesforce Inspector. */
function renderLoad(plan, load, part) {
  const status = el("span", { role: "status" });
  const holder = el("div", {});
  const n = load.rows.length;
  return el("div", { class: "eac-load" },
    el("h5", { text: `${load.label} (${num(n)} ${n === 1 ? "row" : "rows"})` }),
    el("div", { class: "eac-out" },
      el("button", { class: "primary", text: `Copy for Salesforce Inspector: ${load.label}`, onclick: () => copyOut(load.text, "text", holder, status) }),
      el("button", { text: `Download CSV (Data Loader): ${load.label}`, onclick: () => download(changeFileName(plan.action, stamp(), part), load.csv, "text/csv") }),
      status),
    holder,
    el("ol", { class: "eac-steps" }, inspectorSteps(load).map((t) => el("li", { text: t }))));
}

function renderSteps(plan, steps, prefix) {
  const out = [];
  for (const s of steps) {
    out.push(el("h4", { text: s.title }));
    if (s.note) out.push(el("p", { class: "help", text: s.note }));
    if (!s.loads.length) { out.push(el("p", { class: "help", text: "Nothing to load in this step." })); continue; }
    for (const l of s.loads) out.push(renderLoad(plan, l, `${prefix}${l.key}`));
  }
  return out;
}

function renderPreview(plan) {
  const box = $("#eacPreviewBox");
  box.hidden = false;
  box.replaceChildren();
  box.className = "eac-preview";
  if (plan.error) { box.append(el("p", { class: "eac-bad-text", text: plan.error })); return; }
  const parts = [el("h4", { text: "Preview" }), el("p", { class: "eac-summary", text: previewSummary(plan) })];
  if (plan.action !== "add") parts.push(el("div", { class: "eac-warn", text: CHANGE_WARNING }), el("p", { class: "help", text: NOT_VERIFIED_NOTE }));
  const users = [...plan.items].sort((x, y) => x.name.localeCompare(y.name));
  if (users.length) {
    parts.push(el("h4", { text: `${num(planUserCount(plan))} ${planUserCount(plan) === 1 ? "user" : "users"} will be changed${plan.action === "add" ? "" : `, ${num(planRemovalCount(plan))} permission ${planRemovalCount(plan) === 1 ? "assignment" : "assignments"} deleted`}` }),
      nameList(users.map((i) => {
        const n = i.removals?.length || 0;
        const how = n > 1 ? ` (${n} assignments, and they lose Einstein Activity Capture only when all are deleted)` : "";
        return `${i.name}${i.fromName ? ` (now in ${i.fromName})` : ""}${how}${i.note ? ` ${i.note}` : ""}`;
      })));
  }
  const involved = involvedPermissions(plan);
  if (involved.length) {
    parts.push(el("h4", { text: "Permission sets and groups involved" }),
      el("ul", { class: "eac-names" }, involved.map((p) => el("li", {},
        el("strong", { text: p.label }),
        ` (${p.kind === "group" ? "permission set group" : "permission set"}${p.apiName ? `, ${p.apiName}` : ""}): ${num(p.users)} ${p.users === 1 ? "user" : "users"}. `,
        el("span", { class: "eac-warn-text", text: permissionWarning(p.kind) })))));
  }
  if (plan.action === "move" && users.length) parts.push(el("p", { class: "help", text: MOVE_ORDER_NOTE }));
  for (const g of skipGroups(plan)) {
    parts.push(el("div", { class: "eac-skip" }, el("h4", { text: `${g.title} (${num(g.entries.length)})` }), el("p", { class: "help", text: skipHelp(plan.action, g.code) }),
      nameList(g.entries.map((e) => (e.detail ? `${e.name} (${e.detail})` : e.name)))));
  }
  if (plan.notFound.length) parts.push(el("div", { class: "eac-skip" }, el("h4", { text: `Not found (${num(plan.notFound.length)})` }), el("p", { class: "help", text: "These pasted names matched no user." }), nameList(plan.notFound)));
  if (duplicatesText(plan)) parts.push(el("p", { class: "help", text: duplicatesText(plan) }));
  box.append(...parts);

  plan.previewed = true; // only now may any text be built
  let out = null;
  try { out = outputFor(plan); } catch (e) { box.append(el("p", { class: "eac-bad-text", text: e.message })); return; }
  if (!out) { box.append(el("p", { text: "Nothing to load: every pick was skipped." })); return; }
  box.append(el("h4", { text: "Load it" }),
    el("p", { class: "help", text: `Steps in Salesforce Inspector. ${INSPECTOR_UNVERIFIED}` }),
    ...renderSteps(plan, out.steps, ""),
    el("p", { class: "help", text: AFTER_STEP }));
  if (out.undoSteps.length) {
    box.append(el("h4", { text: "Undo the Remove" }),
      el("p", { class: "help", text: `Two steps, in this order. ${GIVE_BACK_NOTE} Keep these texts until you have checked the result.` }),
      ...renderSteps(plan, out.undoSteps, "undo_"));
  } else if (plan.action === "move") {
    box.append(el("p", { class: "help", text: MOVE_UNDO_NOTE }));
  } else {
    box.append(el("p", { class: "help", text: NO_UNDO_ADD }));
  }
}

/** The permission assignments that give the picked users Einstein Activity Capture (read only; the demo reads its sample). */
async function readPermissions(userIds) {
  if (DEMO) {
    const ids = new Set(userIds.map((i) => String(i).slice(0, 15)));
    return eac.demoPermissions.filter((r) => ids.has(String(r.AssigneeId).slice(0, 15))).map(permissionRowFrom);
  }
  return readEacPermissionAssignments(state.api, userIds);
}

async function runPreview() {
  const action = chosenAction();
  const entries = [...eac.sel.values()];
  let permissions = null;
  if (ACTIONS[action]?.needsPermissions && entries.length) {
    const status = $("#eacPreviewStatus");
    $("#eacPreview").disabled = true;
    status.textContent = "Reading their permission assignments…";
    try {
      permissions = await readPermissions(entries.map((e) => e.userId));
    } catch (e) {
      const box = $("#eacPreviewBox");
      box.hidden = false;
      box.className = "eac-preview";
      box.replaceChildren(el("p", { class: "eac-bad-text", text: plainError(e, e?.raw !== undefined ? e.message : "The permission assignments could not be read.") }));
      if (rawOf(e)) box.append(el("details", { class: "tech" }, el("summary", { text: "Technical details" }), el("div", { text: e.raw || rawOf(e) })));
      return;
    } finally {
      status.textContent = "";
      $("#eacPreview").disabled = false;
    }
  }
  const plan = planChange({ action, targetId: chosenTarget(), entries, rows: eac.rows, notFound: eac.notFound, permissions: permissions || (ACTIONS[action]?.needsPermissions ? [] : null) });
  if (!plan.error && !eac.sel.size) plan.error = "Pick at least one user first.";
  eac.plan = plan;
  renderPreview(plan);
}

function selectEverythingShown() {
  if (eac.show === "noConfig") for (const u of noConfigShown()) eac.sel.set(entryKey(entryFromUser(u)), entryFromUser(u));
  else {
    for (const r of eacShown()) eac.sel.set(entryKey(entryFromRow(r)), entryFromRow(r));
    if (eac.show === "all") for (const u of noConfigShown()) eac.sel.set(entryKey(entryFromUser(u)), entryFromUser(u));
  }
  selectionChanged();
  renderEacGroups();
}

$("#eacAction").replaceChildren(...ACTION_LIST.map((x) => el("option", { value: x.value, text: x.label })));
$("#eacAction").addEventListener("change", onActionChange);
$("#eacTarget").addEventListener("change", () => { renderTargetHelp(); selectionChanged(); });
$("#eacTargetId").addEventListener("input", () => { renderTargetHelp(); selectionChanged(); });
$("#eacSelShown").addEventListener("click", selectEverythingShown);
$("#eacSelClear").addEventListener("click", () => { eac.sel = new Map(); selectionChanged(); renderEacGroups(); });
$("#eacPasteGo").addEventListener("click", findPasted);
$("#eacPreview").addEventListener("click", runPreview);
selectionChanged();

connect();
startLiveReload();

// Header links to GitHub's new-issue form. Only tool, extension version and browser go in the link.
{
  let manifestVersion = "";
  try { manifestVersion = chrome.runtime.getManifest().version; } catch { /* dev server */ }
  const version = versionText(manifestVersion, navigator);
  const link = (text, kind) => el("a", {
    href: issueUrl({ kind, tool: FEEDBACK_TOOLS.access, version }), target: "_blank", rel: "noopener noreferrer", text,
  });
  $("#feedback").replaceChildren(link("Report a bug", "bug"), " · ", link("Suggest an improvement", "enhancement"));
}
