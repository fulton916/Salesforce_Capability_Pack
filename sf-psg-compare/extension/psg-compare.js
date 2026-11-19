import { SfApi, findSession } from "./lib/sfconn.js";
import { listPsgs, readOrg, takeSnapshot, validateSnapshot } from "./lib/snapshot.js";
import { compareSnapshots, toRows, toCsv, SECTION_TITLES, FLAG_LABELS } from "./lib/compare.js";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const HOST = params.get("host");
const MAX_ROWS = 2000; // rows rendered per tab; export has everything

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
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
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
  search: "",
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

async function connect() {
  const orgEl = $("#org");
  if (DEMO) {
    orgEl.replaceChildren(el("span", { class: "badge demo", text: "DEMO" }), " Sample data, no org connected");
    $$(".org-only").forEach((n) => (n.hidden = true));
    await loadDemo();
    return;
  }
  if (!HOST || typeof chrome === "undefined" || !chrome.cookies) {
    orgEl.textContent = "No org connected: open this page from the extension button on a Salesforce tab, or load two snapshot files.";
    $$(".org-only").forEach((n) => (n.hidden = true));
    return;
  }
  try {
    orgEl.textContent = `Connecting to ${HOST}…`;
    const session = await findSession(HOST, chrome.cookies);
    state.api = new SfApi(session);
    state.org = await readOrg(state.api, session.apiHost);
    const o = state.org;
    orgEl.replaceChildren(
      el("strong", { text: o.name || o.id }), " ",
      el("span", { class: `badge ${o.isSandbox ? "sbx" : "prod"}`, text: o.isSandbox ? "Sandbox" : "Production" }), " ",
      el("span", { class: "mono", text: session.apiHost })
    );
    document.title = `PSG Compare – ${o.name || session.apiHost}`;
    state.psgs = await listPsgs(state.api);
    for (const side of ["a", "b"]) fillSelect(side, "");
    if (!state.psgs.length) showError("This org has no permission set groups (or your user cannot read them).");
  } catch (e) {
    orgEl.textContent = `Could not connect to ${HOST}`;
    showError(e.message);
  }
}

function fillSelect(side, filter) {
  const sel = $(`.picker[data-side="${side}"] select`);
  const f = filter.trim().toLowerCase();
  const keep = state.sides[side].psgId;
  const opts = state.psgs
    .filter((p) => !f || p.label.toLowerCase().includes(f) || p.developerName.toLowerCase().includes(f) || p.id === keep)
    .map((p) => el("option", { value: p.id, selected: p.id === keep, text: `${p.label} (${p.developerName})${p.status !== "Updated" ? " – " + p.status : ""}` }));
  sel.replaceChildren(el("option", { value: "", text: f ? `${opts.length} match(es)…` : `Choose a group (${state.psgs.length})…` }), ...opts);
}

async function loadDemo() {
  for (const side of ["a", "b"]) {
    const res = await fetch(`samples/sample_${side}.json`);
    state.sides[side].snapshot = validateSnapshot(await res.json());
    state.sides[side].fileName = `samples/sample_${side}.json`;
    renderChosen(side);
  }
  updateCompareButton();
  await runCompare();
}

// ---------- pickers ----------

function renderChosen(side) {
  const s = state.sides[side];
  const box = $(`.picker[data-side="${side}"] .chosen`);
  if (s.snapshot && s.fileName) {
    const o = s.snapshot.org;
    box.replaceChildren(
      "Snapshot: ", el("strong", { text: s.snapshot.psg.label }), " ", el("code", { text: s.snapshot.psg.developerName }),
      el("br"), `${o ? o.name || o.id : "unknown org"} · taken ${s.snapshot.takenAt?.slice(0, 16).replace("T", " ") || "?"} UTC `,
      el("button", { class: "link", text: "clear", onclick: () => clearSide(side) })
    );
  } else if (s.psgId) {
    const p = state.psgs.find((x) => x.id === s.psgId);
    box.replaceChildren("From this org: ", el("strong", { text: p?.label || s.psgId }), " ", el("code", { text: p?.developerName || "" }));
  } else {
    box.replaceChildren();
  }
}

function clearSide(side) {
  const s = state.sides[side];
  s.snapshot = null;
  s.fileName = null;
  s.psgId = "";
  $(`.picker[data-side="${side}"] .snap`).value = "";
  if (state.psgs.length) fillSelect(side, $(`.picker[data-side="${side}"] .filter`).value);
  renderChosen(side);
  updateCompareButton();
}

function updateCompareButton() {
  const ready = ["a", "b"].every((k) => state.sides[k].snapshot || state.sides[k].psgId);
  $("#compare").disabled = !ready;
}

for (const side of ["a", "b"]) {
  const root = $(`.picker[data-side="${side}"]`);
  $(".filter", root).addEventListener("input", (e) => fillSelect(side, e.target.value));
  $("select", root).addEventListener("change", (e) => {
    const s = state.sides[side];
    s.psgId = e.target.value;
    s.snapshot = null; // a new pick means a fresh read
    s.fileName = null;
    $(".snap", root).value = "";
    renderChosen(side);
    updateCompareButton();
  });
  $(".snap", root).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const snap = validateSnapshot(JSON.parse(await file.text()));
      Object.assign(state.sides[side], { snapshot: snap, fileName: file.name, psgId: "" });
      $("select", root).value = "";
      showError("");
    } catch (err) {
      showError(`${file.name}: ${err.message}`);
      e.target.value = "";
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
    for (const side of ["a", "b"]) {
      const s = state.sides[side];
      if (s.fileName) continue; // loaded from a file
      if (!s.psgId) throw new Error(`Choose group ${side.toUpperCase()}.`);
      // Re-read every time Compare is pressed, so the result reflects the org now.
      const label = state.psgs.find((p) => p.id === s.psgId)?.label || s.psgId;
      s.snapshot = await takeSnapshot(state.api, s.psgId, {
        org: state.org,
        progress: (t) => setProgress(`${side.toUpperCase()} · ${label}: ${t}…`),
      });
    }
    state.result = compareSnapshots(state.sides.a.snapshot, state.sides.b.snapshot);
    setProgress(state.api ? `Done (${state.api.calls} API calls).` : "Done.");
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

const TAB_ORDER = ["overview", "components", "userPermissions", "objectPermissions", "fieldPermissions", "setupAccess", "tabs"];

function renderResult() {
  const r = state.result;
  $("#results").hidden = false;
  $("#detail").hidden = false;
  $("#highlights").replaceChildren(...r.highlights.map((h) => el("li", { class: h.level, text: h.text })));
  renderTabs();
  renderTable();
}

function renderTabs() {
  const r = state.result;
  $("#tabs").replaceChildren(...TAB_ORDER.map((k) => {
    const c = r.counts[k];
    const diffs = c.onlyA + c.onlyB + c.differ;
    return el("button", {
      role: "tab",
      "aria-selected": String(state.tab === k),
      onclick: () => { state.tab = k; renderTabs(); renderTable(); },
    }, SECTION_TITLES[k], k === "overview" ? null : el("span", { class: `n${diffs ? "" : " zero"}`, title: "Differences", text: String(diffs) }));
  }));
}

const YES = "✓";
const NONE = "—";

function boolCell(v) {
  return el("td", { class: v ? "yes" : "no", text: v ? YES : NONE });
}

function flagCell(flags) {
  return el("td", { text: flags === null || !flags.length ? NONE : flags.map((f) => FLAG_LABELS[f] || f).join(", ") });
}

function extraCell(r) {
  const parts = [];
  if (r.aExtra?.length) parts.push(el("span", { class: "extra-a", text: `A only: ${r.aExtra.map((f) => FLAG_LABELS[f] || f).join(", ")}` }));
  if (r.bExtra?.length) {
    if (parts.length) parts.push(el("br"));
    parts.push(el("span", { class: "extra-b", text: `B only: ${r.bExtra.map((f) => FLAG_LABELS[f] || f).join(", ")}` }));
  }
  return el("td", {}, parts);
}

const COLUMNS = {
  overview: { head: ["", "A", "B"], row: (r) => [el("td", { text: r.label }), el("td", { text: String(r.a) }), el("td", { text: String(r.b) })] },
  components: {
    head: ["Item", "Kind", "In A", "In B"],
    row: (r) => [
      el("td", {}, el("div", { text: r.label }), r.key.startsWith("muted|") ? null : el("div", { class: "mono", text: r.key })),
      el("td", { text: r.kind }),
      el("td", { class: r.a === null ? "no" : "yes", text: r.a === null ? NONE : `${YES} ${r.a}` }),
      el("td", { class: r.b === null ? "no" : "yes", text: r.b === null ? NONE : `${YES} ${r.b}` }),
    ],
  },
  userPermissions: {
    head: ["System permission", "A", "B"],
    row: (r) => [
      el("td", {}, r.label, r.highRisk ? el("span", { class: "risk-tag", text: "HIGH RISK" }) : null, el("div", { class: "mono", text: r.key })),
      boolCell(r.a), boolCell(r.b),
    ],
  },
  objectPermissions: { head: ["Object", "A", "B", "Difference"], row: (r) => [el("td", { class: "mono", text: r.key }), flagCell(r.a), flagCell(r.b), extraCell(r)] },
  fieldPermissions: {
    head: ["Field", "A", "B"],
    row: (r) => [el("td", { class: "mono", text: r.key }), el("td", { class: r.a === "None" ? "no" : "", text: r.a }), el("td", { class: r.b === "None" ? "no" : "", text: r.b })],
  },
  setupAccess: { head: ["Type", "Name", "A", "B"], row: (r) => [el("td", { text: r.group }), el("td", { class: "mono", text: r.label }), boolCell(r.a), boolCell(r.b)] },
  tabs: { head: ["Tab", "A", "B"], row: (r) => [el("td", { class: "mono", text: r.key }), el("td", { text: r.a ?? NONE }), el("td", { text: r.b ?? NONE })] },
};

function visibleRows() {
  const rows = state.result.sections[state.tab];
  const q = state.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (state.diffOnly && state.tab !== "overview" && r.status === "same") return false;
    if (!q) return true;
    return [r.key, r.label, r.group, r.kind].some((v) => v && String(v).toLowerCase().includes(q));
  });
}

function renderTable() {
  const spec = COLUMNS[state.tab];
  const rows = visibleRows();
  const wrap = $("#table");
  if (!rows.length) {
    const total = state.result.sections[state.tab].length;
    wrap.replaceChildren(el("div", { class: "empty", text: total && state.diffOnly ? `No differences here (${total} item(s) are the same). Choose “Everything” to see them.` : "Nothing to show." }));
    return;
  }
  const body = rows.slice(0, MAX_ROWS).map((r) => el("tr", { class: r.status }, spec.row(r)));
  const parts = [el("table", {}, el("thead", {}, el("tr", {}, spec.head.map((h) => el("th", { text: h })))), el("tbody", {}, body))];
  if (rows.length > MAX_ROWS) {
    parts.push(el("div", { class: "more", text: `Showing ${MAX_ROWS} of ${rows.length} rows. Search to narrow it down, or export to CSV for all of them.` }));
  }
  wrap.replaceChildren(...parts);
}

$("#search").addEventListener("input", (e) => { state.search = e.target.value; renderTable(); });
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
}

const safe = (s) => String(s || "").replace(/[^\w.-]+/g, "_").slice(0, 60);
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

function baseName() {
  const { a, b } = state.result;
  return `psg_compare_${safe(a.psg.developerName)}_vs_${safe(b.psg.developerName)}_${stamp()}`;
}

$("#csvTab").addEventListener("click", () => download(`${baseName()}_${state.tab}.csv`, toCsv(toRows(state.result, state.tab)), "text/csv"));
$("#csvAll").addEventListener("click", () => download(`${baseName()}.csv`, toCsv(toRows(state.result)), "text/csv"));
for (const side of ["a", "b"]) {
  $(`#save${side.toUpperCase()}`).addEventListener("click", () => {
    const s = state.sides[side].snapshot;
    download(`psg_${safe(s.psg.developerName)}_${safe(s.org?.name)}_${stamp()}.json`, JSON.stringify(s, null, 2), "application/json");
  });
}

connect();
