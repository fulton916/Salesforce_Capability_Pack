import { SfApi, findSession } from "./lib/sfconn.js";
import { listPsgs, readOrg, takeSnapshot, validateSnapshot } from "./lib/snapshot.js";
import { compareSnapshots, toRows, toCsv, filterRows, statusText, SECTION_TITLES, SECTION_HELP, FLAG_LABELS, PART_SETS, PART_SETS_HELP, PART_MUTED } from "./lib/compare.js";
import { matchPsgs } from "./lib/pick.js";
import { startLiveReload } from "./lib/livereload.js";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const DEV = params.has("dev"); // served by tools/dev_server.py, which forwards API calls to the org
const HOST = params.get("host");
const MAX_ROWS = 2000; // rows drawn per list; downloads have everything
const RISKS_SHOWN = 5; // general-permission lines shown before "Show more"
const OPEN_BELOW = 60; // a grouped list with this many rows or fewer starts expanded

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
  fieldMode: "auto", // grouped Fields list: auto (by length), all open, all closed
  toggled: new Set(), // objects the user flipped from that default
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

// snapshot.js reports these texts before each step; the page turns them into "Step n of 5".
const STEPS = [
  ["Reading the group", "reading the group"],
  ["Reading component permission sets", "reading the permission sets inside it"],
  ["Reading permissions", "reading its permissions"],
  ["Checking what muting takes away", "checking what muting takes away"],
  ["Putting it together", "putting it together"],
];

/** Show or hide the progress area. `fraction` is 0..1 for the bar. */
function setProgress(text, fraction = 0) {
  $("#progressBox").hidden = !text;
  $("#progress").textContent = text || "";
  $("#pfill").style.width = `${Math.round(Math.max(0.04, Math.min(1, fraction)) * 100)}%`;
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
    combos.a.skipOpen = true;
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

  input.addEventListener("focus", () => {
    input.select();
    if (c.skipOpen) { c.skipOpen = false; return; } // automatic focus on load: leave the list closed
    c.open();
  });
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
    const reading = ["a", "b"].filter((side) => !(state.sides[side].fileName || DEMO));
    const at = Object.fromEntries(reading.map((side) => [side, 0])); // step each group is on (0 = not started)
    const show = () => {
      const n = Math.max(1, Math.min(...Object.values(at)));
      const done = Object.values(at).reduce((x, y) => x + Math.max(0, y - 1), 0) / (reading.length * STEPS.length);
      setProgress(`Step ${Math.min(n, STEPS.length)} of ${STEPS.length}: ${STEPS[Math.min(n, STEPS.length) - 1][1]}…`, done);
    };
    if (reading.length) { setProgress("Starting…", 0); }
    await Promise.all(reading.map(async (side) => {
      const s = state.sides[side];
      if (!s.psgId) throw new Error(`Choose group ${side.toUpperCase()} first.`);
      s.snapshot = await takeSnapshot(state.api, s.psgId, {
        org: state.org,
        progress: (t) => {
          const i = STEPS.findIndex(([text]) => text === t);
          if (i >= 0) at[side] = i + 1;
          show();
        },
      });
      at[side] = STEPS.length + 1;
    }));
    state.result = compareSnapshots(state.sides.a.snapshot, state.sides.b.snapshot);
    state.tab = "overview";
    state.allRisks = false;
    state.fieldMode = "auto";
    state.toggled = new Set();
    if (reading.length) {
      // Show the last step with a full bar for a moment before the result replaces it.
      setProgress(`Step ${STEPS.length} of ${STEPS.length}: comparing the two groups…`, 1);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
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
  const plural = (n, one, many) => (n === 1 ? one : many);
  $("#cards").replaceChildren(...CARD_TABS.map((k) => {
    // "What's inside" holds permission sets and muted items; the card counts them separately.
    // The muting permission set itself is not counted (each group's is normally different).
    const parts = k === "components"
      ? [[r.counts.componentSets, "Permission sets in one group but not the other"], [r.counts.componentMuted, "Things muting takes away in one group but not the other"]]
      : [[r.counts[k], ""]];
    const lines = [];
    let diffs = 0;
    for (const [c, label] of parts) {
      const d = c.onlyA + c.onlyB + c.differ;
      diffs += d;
      // The group name says who has it; the sub-label says what is being counted.
      if (d && label) lines.push(el("div", { class: "card-kind", text: label }));
      if (c.onlyA) lines.push(el("div", { class: "ca" }, el("b", { text: c.onlyA }), el("span", { text: nameOf("a") })));
      if (c.onlyB) lines.push(el("div", { class: "cb" }, el("b", { text: c.onlyB }), el("span", { text: nameOf("b") })));
      if (c.differ) lines.push(el("div", {}, el("b", { text: c.differ }), el("span", { text: "set up differently" })));
    }
    if (!diffs) lines.push(el("div", { class: "same", text: r.counts[k].total ? "✓ Same in both" : "Neither group has any" }));
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
  // General permissions first; the object lines (at most one per group) are always shown.
  const general = risks.filter((h) => h.area === "general");
  const rest = risks.filter((h) => h.area !== "general");
  const shown = state.allRisks ? general : general.slice(0, RISKS_SHOWN);
  $("#risks").replaceChildren(...shown.map((h) => el("li", { text: h.text })));
  $("#riskObjects").replaceChildren(...rest.map((h) => el("li", { text: h.text })));
  const hidden = general.length - RISKS_SHOWN;
  const more = $("#moreRisks");
  more.hidden = hidden <= 0;
  more.textContent = state.allRisks ? "Show fewer" : `Show ${hidden} more general ${hidden === 1 ? "permission" : "permissions"}`;
}

$("#moreRisks").addEventListener("click", () => { state.allRisks = !state.allRisks; renderRisks(); });

function openTab(k, scroll = false) {
  state.tab = k;
  state.search = "";
  state.fieldMode = "auto";
  state.toggled = new Set();
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
    const word = `${diffs.toLocaleString("en-US")} ${diffs === 1 ? "difference" : "differences"}`;
    return el("button", { role: "tab", "aria-selected": String(state.tab === k), "aria-label": k === "overview" ? null : `${SECTION_TITLES[k]}, ${word}`, onclick: () => openTab(k) },
      SECTION_TITLES[k], k === "overview" ? null : el("span", { class: `n${diffs ? "" : " zero"}`, title: word, text: String(diffs) }));
  }));
  $("#help").textContent = (SECTION_HELP[state.tab] || "") + (state.tab === "overview" ? "" : " The number on each tab is how many differences it has.");
  $(".seg").hidden = state.tab === "overview";
}

// ---------- the list ----------

const YES = "✓";
const NO = "—";

function statusChip(r) {
  if (r.status === "same") return el("span", { class: "chip same", text: "Same" });
  if (r.status === "differ" && r.more) {
    return el("span", { class: `chip d more-${r.more}`, text: `Different: ${nameOf(r.more)} has more` });
  }
  const cls = { onlyA: "a", onlyB: "b", differ: "d" }[r.status];
  return el("span", { class: `chip ${cls}`, text: statusText(r.status, nameOf("a"), nameOf("b")) });
}

function itemCell(r) {
  return el("td", { class: "item" },
    el("span", { text: r.label }),
    r.highRisk ? el("span", { class: "risk-tag", text: "Powerful" }) : null,
    state.showApi && r.key !== r.label ? el("div", { class: "api", text: r.key }) : null);
}

/** One value cell. `sub` is secondary text such as "Salesforce licence". */
function access(v, sub = "") {
  const extra = sub ? el("span", { class: "sub", text: ` · ${sub}` }) : null;
  if (v === null || v === false || v === undefined || (Array.isArray(v) && !v.length) || v === "No access") {
    return el("td", { class: "no", text: v === "No access" ? "No access" : NO });
  }
  if (v === true) return el("td", { class: "yes", text: YES });
  if (Array.isArray(v)) return el("td", { text: v.map((f) => FLAG_LABELS[f] || f).join(", ") });
  return el("td", { class: /^Removed/.test(v) ? "removed" : "" }, String(v), extra);
}

function diffCell(r) {
  const parts = [];
  const words = (list) => list.map((f) => FLAG_LABELS[f] || f).join(", ");
  if (r.aExtra?.length) parts.push(el("div", { class: "extra-a", text: `Only ${nameOf("a")}: ${words(r.aExtra)}` }));
  if (r.bExtra?.length) parts.push(el("div", { class: "extra-b", text: `Only ${nameOf("b")}: ${words(r.bExtra)}` }));
  return el("td", { class: "diff" }, parts.length ? parts : statusChip(r));
}

const diffTd = (r) => el("td", { class: "diff" }, statusChip(r));
const blank = (v) => (v === "" || v === null || v === undefined ? "—" : String(v));

/** Column heads and a row builder for the list on screen. `part` is "sets" or "muted" for What's inside. */
function columns(part) {
  const A = nameOf("a");
  const B = nameOf("b");
  const headA = el("span", {}, el("span", { class: "dot a" }), A);
  const headB = el("span", {}, el("span", { class: "dot b" }), B);
  const legacy = state.result.mutedLegacy;
  switch (state.tab) {
    case "overview":
      return { head: ["", headA, headB], row: (r) => [el("td", { class: "item", text: r.label }), el("td", { text: blank(r.a) }), el("td", { text: blank(r.b) })] };
    case "objectPermissions":
      return { head: ["Object", headA, headB, "Difference"], row: (r) => [itemCell(r), access(r.a), access(r.b), diffCell(r)] };
    case "fieldPermissions": // grouped under object headers, so no Object column
      return { head: ["Field", headA, headB, "Difference"], row: (r) => [itemCell(r), access(r.a), access(r.b), diffTd(r)] };
    case "setupAccess":
      return { head: ["Type", "Name", headA, headB, "Difference"], row: (r) => [el("td", { class: "grp", text: r.group }), itemCell(r), access(r.a), access(r.b), diffTd(r)] };
    case "components":
      if (part === "muted") {
        const may = (side) => (legacy[side] ? "may not have been given" : "");
        return { head: ["Kind of item", "Name", headA, headB, "Difference"], row: (r) => [el("td", { class: "grp", text: r.kind }), itemCell(r), access(r.a, may("a")), access(r.b, may("b")), diffTd(r)] };
      }
      return { head: ["Type", "Permission set", headA, headB, "Difference"], row: (r) => [el("td", { class: "grp", text: r.group }), itemCell(r), access(r.a, r.aSub), access(r.b, r.bSub), diffTd(r)] };
    default:
      return { head: [state.tab === "tabs" ? "Tab" : "Permission", headA, headB, "Difference"], row: (r) => [itemCell(r), access(r.a), access(r.b), diffTd(r)] };
  }
}

/** Rows of a list as shown: differences-only and search applied. */
function visibleRows(rows = state.result.sections[state.tab]) {
  return filterRows(rows, { section: state.tab, diffOnly: state.diffOnly, search: state.search });
}

function emptyMessage(total) {
  if (state.search) return "Nothing matches your search.";
  if (total && state.diffOnly) return `No differences: all ${total} items are the same in both groups. Choose “Everything” to see them.`;
  return "Nothing here.";
}

function plainTable(spec, rows) {
  const body = rows.slice(0, MAX_ROWS).map((r) => el("tr", { class: r.status }, spec.row(r)));
  const parts = [el("table", {}, el("thead", {}, el("tr", {}, spec.head.map((h) => el("th", {}, h)))), el("tbody", {}, body))];
  if (rows.length > MAX_ROWS) {
    parts.push(el("div", { class: "more", text: `Showing the first ${MAX_ROWS.toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")}. Search to narrow the list, or download it to see everything.` }));
  }
  return parts;
}

/** Fields: one collapsible block per object, with a count of differences in its header. */
function groupedTable(spec, rows) {
  const groups = [];
  for (const r of rows) {
    const name = r.group || "Other";
    if (!groups.length || groups.at(-1).name !== name) groups.push({ name, rows: [] });
    groups.at(-1).rows.push(r);
  }
  // Searching opens every object so matches are visible; otherwise the default depends on length.
  const base = state.search.trim() ? true : state.fieldMode === "all" ? true : state.fieldMode === "none" ? false : rows.length <= OPEN_BELOW;
  let budget = MAX_ROWS;
  let cut = false;
  const num = (n) => n.toLocaleString("en-US");
  const bodies = groups.map((g) => {
    const open = base !== state.toggled.has(g.name);
    const diffs = g.rows.filter((x) => x.status !== "same").length;
    const d = `${num(diffs)} ${diffs === 1 ? "difference" : "differences"}`;
    const text = !diffs ? `${g.name} — ${num(g.rows.length)} ${g.rows.length === 1 ? "field" : "fields"}, all the same`
      : state.diffOnly ? `${g.name} — ${d}` : `${g.name} — ${d} (of ${num(g.rows.length)} fields)`;
    const head = el("tr", { class: "objhead" }, el("td", { colspan: spec.head.length },
      el("button", {
        class: "grouphead", "aria-expanded": String(open), title: open ? "Collapse" : "Expand",
        onclick: () => { const y = window.scrollY; state.toggled.has(g.name) ? state.toggled.delete(g.name) : state.toggled.add(g.name); renderTable(); window.scrollTo(0, y); },
      }, el("span", { class: "arrow", text: open ? "▾" : "▸" }), text)));
    const shown = open ? g.rows.slice(0, Math.max(0, budget)) : [];
    budget -= shown.length;
    if (open && shown.length < g.rows.length) cut = true;
    return el("tbody", {}, head, shown.map((r) => el("tr", { class: r.status }, spec.row(r))));
  });
  const parts = [el("table", { class: "grouped" }, el("thead", {}, el("tr", {}, spec.head.map((h) => el("th", {}, h)))), bodies)];
  if (cut) parts.push(el("div", { class: "more", text: `Showing the first ${num(MAX_ROWS)} rows. Collapse some objects, search, or download the list to see everything.` }));
  return parts;
}

function renderTable() {
  const wrap = $("#table");
  const all = state.result.sections[state.tab];
  $("#listTools").hidden = true;
  if (state.tab === "components") {
    const sets = all.filter((r) => r.part === "sets");
    const muted = all.filter((r) => r.part === "muted");
    const lg = state.result.mutedLegacy;
    const part = (title, intro, list, which) => {
      const rows = visibleRows(list);
      return [
        el("h3", { class: "parttitle", text: title }),
        intro ? el("p", { class: "hint", text: intro }) : null,
        ...(rows.length ? plainTable(columns(which), rows) : [el("div", { class: "empty small", text: emptyMessage(list.length) })]),
      ].filter(Boolean);
    };
    const old = ["a", "b"].filter((k) => lg[k]).map((k) => nameOf(k));
    const intro = "People in this group do not get these, even though a permission set in the group gives them."
      + (old.length ? ` For ${old.join(" and ")} (an older saved file) it is not known whether a permission set in the group really gave them, so those items say “may not have been given”.` : "");
    wrap.replaceChildren(...part(PART_SETS, PART_SETS_HELP, sets, "sets"), ...(muted.length ? part(PART_MUTED, intro, muted, "muted") : []));
    return;
  }
  const rows = visibleRows();
  if (!rows.length) {
    wrap.replaceChildren(el("div", { class: "empty", text: emptyMessage(all.length) }));
    return;
  }
  if (state.tab === "fieldPermissions") {
    $("#listTools").hidden = false;
    wrap.replaceChildren(...groupedTable(columns(), rows));
  } else {
    wrap.replaceChildren(...plainTable(columns(), rows));
  }
}

$("#expandAll").addEventListener("click", () => { state.fieldMode = "all"; state.toggled = new Set(); renderTable(); });
$("#collapseAll").addEventListener("click", () => { state.fieldMode = "none"; state.toggled = new Set(); renderTable(); });
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

// "This list" is exactly what is on screen (differences-only and search applied; collapsed objects included).
$("#csvTab").addEventListener("click", () => download(`${baseName()}_${safe(SECTION_TITLES[state.tab])}.csv`,
  toCsv(toRows(state.result, state.tab, { diffOnly: state.diffOnly, search: state.search })), "text/csv"));
$("#csvDiff").addEventListener("click", () => download(`${baseName()}_differences.csv`, toCsv(toRows(state.result, null, { diffOnly: true })), "text/csv"));
$("#csvAll").addEventListener("click", () => download(`${baseName()}_everything.csv`, toCsv(toRows(state.result)), "text/csv"));
for (const side of ["a", "b"]) {
  $(`#save${side.toUpperCase()}`).addEventListener("click", () => {
    const s = state.result[side];
    download(`psg_${safe(s.psg.developerName)}_${safe(s.org?.name)}_${stamp()}.json`, JSON.stringify(s, null, 2), "application/json");
  });
}
document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) $(".menu").open = false; });

connect();
startLiveReload();
