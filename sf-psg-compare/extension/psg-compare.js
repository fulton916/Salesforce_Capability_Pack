import { SfApi, findSession } from "./lib/sfconn.js";
import { listPsgs, readOrg, takeSnapshot, validateSnapshot } from "./lib/snapshot.js";
import { compareSnapshots, toRows, toCsv, statusText, SECTION_TITLES, SECTION_HELP, FLAG_LABELS } from "./lib/compare.js";
import { matchPsgs } from "./lib/pick.js";
import { startLiveReload } from "./lib/livereload.js";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const DEV = params.has("dev"); // served by tools/dev_server.py, which forwards API calls to the org
const HOST = params.get("host");
const MAX_ROWS = 2000; // rows drawn per list; downloads have everything
const RISKS_SHOWN = 5;

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
  org: null,
  psgs: [],
  sides: { a: { psgId: "", snapshot: null, fileName: null }, b: { psgId: "", snapshot: null, fileName: null } },
  result: null,
  tab: "overview",
  diffOnly: true,
  showApi: false,
  search: "",
  allRisks: false,
};

const nameOf = (side) => {
  const s = state.result?.[side] || state.sides[side].snapshot;
  return s ? s.psg.label || s.psg.developerName : side.toUpperCase();
};

function showError(msg) {
  const box = $("#error");
  box.hidden = !msg;
  box.textContent = msg || "";
}

function setProgress(text) {
  $("#progress").textContent = text || "";
}

// ---------- connecting ----------

function orgKind(o) {
  if (o.isSandbox) return ["Sandbox", "sbx"];
  if (/developer|trial/i.test(o.edition || "")) return [o.edition, "sbx"]; // e.g. "Developer Edition"
  return ["Production", "prod"];
}

function showOrg(o, host, via) {
  const [kind, cls] = orgKind(o);
  $("#org").replaceChildren(
    el("strong", { text: o.name || o.id }), " ",
    el("span", { class: `badge ${cls}`, text: kind }),
    via ? el("span", { class: "badge demo", text: via }) : null,
    el("span", { class: "host", text: host })
  );
  document.title = `PSG Compare – ${o.name || host}`;
}

async function connect() {
  if (DEMO) {
    $("#org").replaceChildren(el("span", { class: "badge demo", text: "DEMO" }), " Made-up sample groups, no org connected");
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
      $("#org").textContent = "No org connected. Open this page from the extension button on a Salesforce tab, or compare two saved files.";
      $$(".org-only").forEach((n) => (n.hidden = true));
      $(".files").open = true;
      return;
    }
    state.api = new SfApi(session);
    state.org = await readOrg(state.api, DEV ? "local dev server" : session.apiHost);
    showOrg(state.org, DEV ? "" : session.apiHost, DEV ? "DEV SERVER" : null);
    state.psgs = await listPsgs(state.api);
    if (!state.psgs.length) showError("This org has no permission set groups, or your user cannot see them.");
    $("#input-a").focus();
  } catch (e) {
    $("#org").textContent = `Could not connect${HOST ? " to " + HOST : ""}.`;
    showError(e.message);
  }
}

async function loadDemo() {
  const snaps = {};
  for (const side of ["a", "b"]) {
    const res = await fetch(`samples/sample_${side}.json`);
    snaps[side] = validateSnapshot(await res.json());
  }
  // The demo list lets the search box be tried; every pick loads one of the two samples.
  state.psgs = [snaps.a, snaps.b].map((s) => ({ id: s.psg.id, developerName: s.psg.developerName, label: s.psg.label, status: s.psg.status, demo: s }));
  for (const side of ["a", "b"]) pick(side, state.psgs[side === "a" ? 0 : 1], { quiet: true });
  await runCompare();
}

// ---------- group search box (one input, list opens under it) ----------

const combos = {};

function setupCombo(side) {
  const root = $(`.picker[data-side="${side}"]`);
  const input = $(".psg-input", root);
  const list = $(".psg-list", root);
  const c = (combos[side] = { input, list, items: [], active: -1 });

  c.open = () => {
    const chosen = state.psgs.find((p) => p.id === state.sides[side].psgId);
    // Text still equal to the chosen group: show the full list so another one can be picked.
    const text = chosen && input.value === chosen.label ? "" : input.value;
    const { items, total } = matchPsgs(state.psgs, text);
    c.items = items;
    c.active = items.length ? 0 : -1;
    const lis = items.map((p, i) => el("li", {
      role: "option", id: `${side}-opt-${i}`, "aria-selected": String(i === c.active),
      onmousedown: (e) => { e.preventDefault(); pick(side, p); },
      onmousemove: () => highlight(side, i),
    }, el("span", { class: "nm", text: p.label }),
       p.status !== "Updated" ? el("span", { class: "st", text: `needs recalculation (${p.status})` }) : null,
       el("span", { class: "dev", text: p.developerName })));
    if (!items.length) lis.push(el("li", { class: "none", text: state.psgs.length ? "No group matches that name." : "No groups loaded yet." }));
    if (total > items.length) lis.push(el("li", { class: "none", text: `${total - items.length} more. Keep typing to narrow the list.` }));
    list.replaceChildren(...lis);
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (c.active >= 0) input.setAttribute("aria-activedescendant", `${side}-opt-0`);
  };
  c.close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  input.addEventListener("focus", () => { input.select(); c.open(); });
  input.addEventListener("click", () => { if (list.hidden) c.open(); });
  input.addEventListener("input", c.open);
  input.addEventListener("blur", () => {
    c.close();
    // Leaving the box without picking puts the chosen group's name back.
    const chosen = state.psgs.find((p) => p.id === state.sides[side].psgId);
    input.value = chosen ? chosen.label : "";
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

function pick(side, p, { quiet = false } = {}) {
  const s = state.sides[side];
  s.psgId = p.id;
  s.snapshot = p.demo || null; // a new pick means a fresh read (demo: the sample)
  s.fileName = null;
  $(`.snap[data-side="${side}"]`).value = "";
  combos[side].input.value = p.label;
  combos[side].close();
  renderChosen(side);
  updateCompareButton();
  if (quiet) return;
  // Move on to the next empty box, or to Compare.
  if (side === "a" && !state.sides.b.psgId && !state.sides.b.fileName) combos.b.input.focus();
  else if (!$("#compare").disabled) $("#compare").focus();
}

function renderChosen(side) {
  const s = state.sides[side];
  const box = $(`.picker[data-side="${side}"] .chosen`);
  if (s.fileName && s.snapshot) {
    const o = s.snapshot.org;
    box.replaceChildren(
      "From file: ", el("strong", { text: s.snapshot.psg.label }),
      el("div", { class: "sub", text: `${o ? o.name || o.id : "unknown org"} · saved ${s.snapshot.takenAt?.slice(0, 10) || "?"}` }),
      el("button", { class: "link", text: "Remove file", onclick: () => clearSide(side) })
    );
  } else if (s.psgId) {
    const p = state.psgs.find((x) => x.id === s.psgId);
    box.replaceChildren(p && p.status !== "Updated" ? el("span", { class: "warn-text", text: `Salesforce has not finished recalculating this group (${p.status}). Results may be out of date.` }) : "");
  } else {
    box.replaceChildren();
  }
}

function clearSide(side) {
  Object.assign(state.sides[side], { snapshot: null, fileName: null, psgId: "" });
  $(`.snap[data-side="${side}"]`).value = "";
  combos[side].input.value = "";
  renderChosen(side);
  updateCompareButton();
}

function updateCompareButton() {
  $("#compare").disabled = !["a", "b"].every((k) => state.sides[k].snapshot || state.sides[k].psgId);
}

for (const side of ["a", "b"]) setupCombo(side);

for (const input of $$(".snap")) {
  input.addEventListener("change", async (e) => {
    const side = input.dataset.side;
    const file = e.target.files[0];
    if (!file) return;
    try {
      const snap = validateSnapshot(JSON.parse(await file.text()));
      Object.assign(state.sides[side], { snapshot: snap, fileName: file.name, psgId: "" });
      combos[side].input.value = "";
      showError("");
    } catch (err) {
      showError(`${file.name} is not a saved group file from this tool. (${err.message})`);
      input.value = "";
    }
    renderChosen(side);
    updateCompareButton();
  });
}

// ---------- comparing ----------

async function runCompare() {
  showError("");
  $("#compare").disabled = true;
  try {
    // Read both groups at the same time, again on every Compare, so the result reflects the org now.
    const steps = {};
    const show = () => setProgress(Object.entries(steps).map(([l, t]) => `${l}: ${t.toLowerCase()}…`).join("   ·   "));
    await Promise.all(["a", "b"].map(async (side) => {
      const s = state.sides[side];
      if (s.fileName || DEMO) return; // from a file or a sample
      if (!s.psgId) throw new Error(`Choose group ${side.toUpperCase()} first.`);
      const label = state.psgs.find((p) => p.id === s.psgId)?.label || s.psgId;
      s.snapshot = await takeSnapshot(state.api, s.psgId, {
        org: state.org,
        progress: (t) => { steps[label] = t; show(); },
      });
    }));
    state.result = compareSnapshots(state.sides.a.snapshot, state.sides.b.snapshot);
    state.tab = "overview";
    state.allRisks = false;
    setProgress("");
    renderResult();
  } catch (e) {
    setProgress("");
    showError(e.message);
  } finally {
    updateCompareButton();
  }
}

$("#compare").addEventListener("click", runCompare);

// ---------- results ----------

const TAB_ORDER = ["overview", "userPermissions", "objectPermissions", "fieldPermissions", "setupAccess", "tabs", "components"];
const CARD_TABS = ["userPermissions", "objectPermissions", "fieldPermissions", "setupAccess", "tabs", "components"];

function who(side) {
  const s = state.result[side];
  const a = s.assignments;
  return [
    el("div", { class: "who-name", text: s.psg.label || s.psg.developerName }),
    el("div", { class: "who-sub", text: a ? `${a.active} active user${a.active === 1 ? "" : "s"} assigned` : "" }),
  ];
}

function renderResult() {
  const r = state.result;
  $("#results").hidden = false;
  $("#whoA").replaceChildren(...who("a"));
  $("#whoB").replaceChildren(...who("b"));
  const verdict = r.highlights.find((h) => h.kind === "verdict");
  $("#verdict").textContent = verdict?.text || "";
  $("#verdict").className = `verdict ${verdict?.level || ""}`;

  // One card per area: how many differences, in plain words.
  $("#cards").replaceChildren(...CARD_TABS.map((k) => {
    const c = r.counts[k];
    const diffs = c.onlyA + c.onlyB + c.differ;
    const lines = [];
    if (c.onlyA) lines.push(el("div", { class: "ca" }, el("b", { text: c.onlyA }), ` only in ${nameOf("a")}`));
    if (c.onlyB) lines.push(el("div", { class: "cb" }, el("b", { text: c.onlyB }), ` only in ${nameOf("b")}`));
    if (c.differ) lines.push(el("div", {}, el("b", { text: c.differ }), " set up differently"));
    if (!diffs) lines.push(el("div", { class: "same", text: c.total ? "✓ Same in both" : "Neither group has any" }));
    return el("button", { class: `card${diffs ? "" : " ok"}`, onclick: () => openTab(k, true) },
      el("div", { class: "card-title", text: SECTION_TITLES[k] }), ...lines);
  }));

  renderRisks();

  const notes = r.highlights.filter((h) => h.kind === "note");
  $("#notesPanel").hidden = !notes.length;
  $("#notesTitle").textContent = `Technical notes (${notes.length})`;
  $("#notes").replaceChildren(...notes.map((h) => el("li", { class: h.level, text: h.text })));

  renderTabs();
  renderTable();
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderRisks() {
  const risks = state.result.highlights.filter((h) => h.kind === "risk");
  $("#riskPanel").hidden = !risks.length;
  const shown = state.allRisks ? risks : risks.slice(0, RISKS_SHOWN);
  $("#risks").replaceChildren(...shown.map((h) => el("li", { text: h.text })));
  const more = $("#moreRisks");
  more.hidden = risks.length <= RISKS_SHOWN;
  more.textContent = state.allRisks ? "Show fewer" : `Show all ${risks.length}`;
}

$("#moreRisks").addEventListener("click", () => { state.allRisks = !state.allRisks; renderRisks(); });

function openTab(k, scroll = false) {
  state.tab = k;
  state.search = "";
  $("#search").value = "";
  renderTabs();
  renderTable();
  if (scroll) $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderTabs() {
  const r = state.result;
  $("#tabs").replaceChildren(...TAB_ORDER.map((k) => {
    const c = r.counts[k];
    const diffs = c.onlyA + c.onlyB + c.differ;
    return el("button", { role: "tab", "aria-selected": String(state.tab === k), onclick: () => openTab(k) },
      SECTION_TITLES[k], k === "overview" ? null : el("span", { class: `n${diffs ? "" : " zero"}`, title: "Differences", text: String(diffs) }));
  }));
  $("#help").textContent = SECTION_HELP[state.tab] || "";
  $(".seg").hidden = state.tab === "overview";
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
  return el("td", { class: "item" },
    el("span", { text: r.label }),
    r.highRisk ? el("span", { class: "risk-tag", text: "Powerful" }) : null,
    state.showApi && r.key !== r.label ? el("div", { class: "api", text: r.key }) : null);
}

function access(v) {
  if (v === null || v === false || v === undefined || (Array.isArray(v) && !v.length) || v === "No access") {
    return el("td", { class: "no", text: v === "No access" ? "No access" : NO });
  }
  if (v === true) return el("td", { class: "yes", text: YES });
  if (Array.isArray(v)) return el("td", { text: v.map((f) => FLAG_LABELS[f] || f).join(", ") });
  return el("td", { text: String(v) });
}

function diffCell(r) {
  const parts = [];
  const words = (list) => list.map((f) => FLAG_LABELS[f] || f).join(", ");
  if (r.aExtra?.length) parts.push(el("div", { class: "extra-a", text: `Only ${nameOf("a")}: ${words(r.aExtra)}` }));
  if (r.bExtra?.length) parts.push(el("div", { class: "extra-b", text: `Only ${nameOf("b")}: ${words(r.bExtra)}` }));
  return el("td", {}, parts.length ? parts : statusChip(r));
}

function columns() {
  const A = nameOf("a");
  const B = nameOf("b");
  const headA = el("span", {}, el("span", { class: "dot a" }), A);
  const headB = el("span", {}, el("span", { class: "dot b" }), B);
  switch (state.tab) {
    case "overview":
      return { head: ["", headA, headB], row: (r) => [el("td", { class: "item", text: r.label }), el("td", { text: String(r.a) }), el("td", { text: String(r.b) })] };
    case "objectPermissions":
      return { head: ["Object", headA, headB, "Difference"], row: (r) => [itemCell(r), access(r.a), access(r.b), diffCell(r)] };
    case "fieldPermissions":
      return { head: ["Object", "Field", headA, headB, "Difference"], row: (r) => [el("td", { class: "grp", text: r.group }), itemCell(r), access(r.a), access(r.b), el("td", {}, statusChip(r))] };
    case "setupAccess":
    case "components":
      return { head: ["Type", "Name", headA, headB, "Difference"], row: (r) => [el("td", { class: "grp", text: r.group }), itemCell(r), access(r.a), access(r.b), el("td", {}, statusChip(r))] };
    default:
      return { head: [state.tab === "tabs" ? "Tab" : "Permission", headA, headB, "Difference"], row: (r) => [itemCell(r), access(r.a), access(r.b), el("td", {}, statusChip(r))] };
  }
}

function visibleRows() {
  const rows = state.result.sections[state.tab];
  const words = state.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (state.diffOnly && state.tab !== "overview" && r.status === "same") return false;
    if (!words.length) return true;
    const hay = [r.key, r.label, r.group].filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function renderTable() {
  const spec = columns();
  const rows = visibleRows();
  const wrap = $("#table");
  if (!rows.length) {
    const total = state.result.sections[state.tab].length;
    let msg = "Nothing here.";
    if (state.search) msg = "Nothing matches your search.";
    else if (total && state.diffOnly) msg = `No differences: all ${total} items are the same in both groups. Choose “Everything” to see them.`;
    wrap.replaceChildren(el("div", { class: "empty", text: msg }));
    return;
  }
  const body = rows.slice(0, MAX_ROWS).map((r) => el("tr", { class: r.status }, spec.row(r)));
  const parts = [el("table", {}, el("thead", {}, el("tr", {}, spec.head.map((h) => el("th", {}, h)))), el("tbody", {}, body))];
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
    renderTable();
  });
}

// ---------- downloads ----------

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

function baseName() {
  const { a, b } = state.result;
  return `compare_${safe(a.psg.developerName)}_vs_${safe(b.psg.developerName)}_${stamp()}`;
}

$("#csvTab").addEventListener("click", () => download(`${baseName()}_${safe(SECTION_TITLES[state.tab])}.csv`, toCsv(toRows(state.result, state.tab)), "text/csv"));
$("#csvAll").addEventListener("click", () => download(`${baseName()}.csv`, toCsv(toRows(state.result)), "text/csv"));
for (const side of ["a", "b"]) {
  $(`#save${side.toUpperCase()}`).addEventListener("click", () => {
    const s = state.result[side];
    download(`psg_${safe(s.psg.developerName)}_${safe(s.org?.name)}_${stamp()}.json`, JSON.stringify(s, null, 2), "application/json");
  });
}
document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) $(".menu").open = false; });

connect();
startLiveReload();
