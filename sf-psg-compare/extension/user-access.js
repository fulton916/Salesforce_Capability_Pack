import { SfApi, findSession } from "./lib/sfconn.js";
import { readOrg } from "./lib/snapshot.js";
import { searchUsers, readUserAccess } from "./lib/useraccess.js";
import {
  SECTIONS, SECTION_KEYS, SECTION_TITLES, SECTION_HELP, validateAccess, compareUsers, singleRows,
  matchUsers, statusText, plural, countText, toRows, toRowsSingle, toCsv, itemsOf, hasDetails,
  userCardLines, orgParts,
} from "./lib/usercompare.js";
import { startLiveReload } from "./lib/livereload.js";
import { issueUrl, FEEDBACK_TOOLS, versionText } from "./lib/feedback.js";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const DEV = params.has("dev"); // served by tools/dev_server.py, which forwards API calls to the org
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
  document.title = `Look up user access – ${o.name || host}`;
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
      $("#org").textContent = "No org connected. Open this page from the extension button on a Salesforce tab.";
      $$(".org-only").forEach((n) => (n.hidden = true));
      return;
    }
    state.api = new SfApi(session);
    const org = await readOrg(state.api, DEV ? "local dev server" : session.apiHost);
    showOrg(org, DEV ? "" : session.apiHost, DEV ? "DEV SERVER" : null);
    $("#input-a").focus();
  } catch (e) {
    $("#org").textContent = `Could not connect${HOST ? " to " + HOST : ""}.`;
    showError(plainError(e, "Could not connect to the org. If you have been away a while, reload the Salesforce tab and try again."), rawOf(e));
  }
}

async function loadDemo() {
  for (const side of ["a", "b"]) {
    const res = await fetch(`samples/user_${side}.json`);
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
      ok = !(c.onlyA + c.onlyB + c.differ);
    } else {
      const rows = singleRows(state.sides.a.access, k);
      if (k === "profile" || k === "role") lines.push(el("div", { class: "one", text: rows[0]?.label || `No ${s.one}` }));
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
  const cls = { onlyA: "a", onlyB: "b", differ: "d" }[r.status];
  return el("span", { class: `chip ${cls}`, text: statusText(r.status, nameOf("a"), nameOf("b")) });
}

function itemCell(r) {
  return el("td", { class: "item" }, el("span", { text: r.label }), state.showApi && r.key !== r.label ? el("div", { class: "api", text: r.key }) : null);
}

function presence(item, detail) {
  if (!item) return el("td", { class: "no", text: NO });
  return el("td", {}, el("span", { class: "yes", text: YES }), detail ? el("div", { class: "how", text: detail }) : null);
}

/** Overview rows: one per area, with the user's profile/role name or an item count. */
function overviewValue(access, k) {
  const na = access.unavailable?.[k];
  if (na) return "Not available";
  const items = itemsOf(access, k);
  return k === "profile" || k === "role" ? items[0]?.label || `No ${k}` : String(items.length);
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
  if (cmp) {
    return { head: [SECTION_TITLES[state.tab], headA, headB, "Difference"], row: (r) => [itemCell(r), presence(r.a, r.detailA), presence(r.b, r.detailB), el("td", {}, statusChip(r))] };
  }
  if (!hasDetails(currentRows())) return { head: [SECTION_TITLES[state.tab]], row: (r) => [itemCell(r)] };
  return { head: [SECTION_TITLES[state.tab], "Details"], row: (r) => [itemCell(r), el("td", { class: "how", text: r.detail })] };
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
  if (!rows.length) {
    const total = currentRows().length;
    let msg = na ? "" : "Nothing here.";
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
  $(".menu").open = false;
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
document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) $(".menu").open = false; });

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
