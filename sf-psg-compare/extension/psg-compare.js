import { SfApi, findSession } from "./lib/sfconn.js";
import { listPsgs, readOrg, takeSnapshot, validateSnapshot } from "./lib/snapshot.js";
import { compareSnapshots, toRows, toCsv, filterRows, cardLines, tabDiffCount, sortRows, sortGrouped, statusText, groupStatus, tabDiffText, SECTION_TITLES, SECTION_HELP, FLAG_LABELS, PART_SETS, PART_SETS_HELP, PART_MUTED } from "./lib/compare.js";
import { matchPsgs } from "./lib/pick.js";
import { startLiveReload } from "./lib/livereload.js";
import { issueUrl, FEEDBACK_TOOLS, versionText } from "./lib/feedback.js";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const DEV = params.has("dev"); // served by tools/dev_server.py, which forwards API calls to the org
const HOST = params.get("host");
const MAX_ROWS = 2000; // rows drawn per list; downloads have everything
const RISKS_SHOWN = 5; // system-permission lines shown before "Show more"
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
  allRisks: { a: false, b: false }, // per group: all system permission lines shown?
  fieldMode: "auto", // grouped Fields list: auto (by length), all open, all closed
  toggled: new Set(), // objects the user flipped from that default
  sort: {}, // per list: { col, dir } where dir is "asc" or "desc"; no entry = the default order
};

const nameOf = (side) => {
  const s = state.result?.[side] || state.sides[side].snapshot;
  return s ? s.psg.label || s.psg.developerName : side.toUpperCase();
};

/** Show a plain message in the error box. Raw text (from Salesforce, a file, the browser) goes in a folded "Technical details". */
function showError(msg, raw) {
  const box = $("#error");
  box.hidden = !msg;
  box.replaceChildren();
  if (!msg) return;
  box.append(msg);
  if (raw && raw !== msg) box.append(el("details", { class: "tech" }, el("summary", { text: "Technical details" }), el("div", { text: raw })));
}

/** Show a failure: messages already in plain words (marked `plain`, or a 401 from sfconn.js) as they are, anything else under a plain sentence. */
function showFailure(e) {
  if (e?.plain) showError(e.message);
  else if (e?.status === 401) showError(e.message, e.detail);
  else showError("Something went wrong while reading from the org. Try again. If it keeps happening, check that your user can see permission sets in Setup.", e?.message);
}

// snapshot.js reports these texts before each step; the page turns them into "Step n of 5".
const STEPS = [
  ["Reading the group", "reading the group"],
  ["Reading component permission sets", "reading the permission sets inside it"],
  ["Reading permissions", "reading its permissions"],
  ["Checking what muting takes away", "checking what muting takes away"],
  ["Putting it together", "comparing the two groups"],
];

/** Show or hide the progress area. `fraction` is 0..1 for the bar. */
function setProgress(text, fraction = 0) {
  $("#progressBox").hidden = !text;
  $("#progress").textContent = text || "";
  $("#pfill").style.width = `${Math.round(Math.max(0.04, Math.min(1, fraction)) * 100)}%`;
}

// ---------- connecting ----------

function orgKind(o) {
  if (o.isSandbox) return ["Sandbox", "sbx"]; // "sbx" is only the CSS class
  if (/developer|trial/i.test(o.edition || "")) return [o.edition, "sbx"]; // e.g. "Developer Edition"
  return ["Production", "prod"];
}

function showOrg(o, host, via) {
  const [kind, cls] = orgKind(o);
  $("#org").replaceChildren(...[
    el("strong", { text: o.name || o.id }), " ",
    el("span", { class: `badge ${cls}`, text: kind }),
    via ? el("span", { class: "badge demo", text: via }) : null,
    host ? el("span", { class: "host", text: host }) : null
  ].filter(Boolean));
  document.title = `Compare permission set groups – ${o.name || host}`;
}

async function connect() {
  if (DEMO) {
    $("#org").replaceChildren(el("span", { class: "badge demo", text: "Demo" }), " Made-up sample groups, no org connected");
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
      $("#org").textContent = "No org connected. Open this page from the Salesforce Capability Pack button on a Salesforce tab, or compare two saved group files.";
      $$(".org-only").forEach((n) => (n.hidden = true));
      $(".files").open = true;
      return;
    }
    state.api = new SfApi(session);
    state.org = await readOrg(state.api, DEV ? "local test server" : session.apiHost);
    showOrg(state.org, DEV ? "" : session.apiHost, DEV ? "Local test server" : null);
    state.psgs = await listPsgs(state.api);
    if (!state.psgs.length) showError("This org has no permission set groups, or your user cannot see them.");
    combos.a.skipOpen = true;
    $("#input-a").focus();
  } catch (e) {
    $("#org").textContent = "Not connected";
    showError("Could not connect to the org. If you have been away a while, reload the Salesforce tab and try again.", e.message);
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
       p.status !== "Updated" ? el("span", { class: "st", text: "Not up to date" }) : null,
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
      "From saved group file: ", el("strong", { text: s.snapshot.psg.label }),
      el("div", { class: "sub", text: `${o ? o.name || o.id : "unknown org"} · saved ${s.snapshot.takenAt?.slice(0, 10) || "?"}` }),
      el("button", { class: "link", text: "Remove saved group file", onclick: () => clearSide(side) })
    );
  } else if (s.psgId) {
    const p = state.psgs.find((x) => x.id === s.psgId);
    box.replaceChildren(p && p.status !== "Updated" ? el("span", { class: "warn-text", text: groupStatus(p.status) }) : "");
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
  const ready = ["a", "b"].every((k) => state.sides[k].snapshot || state.sides[k].psgId);
  $("#compare").disabled = !ready;
  $("#compareHint").hidden = ready;
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
      showError(`${file.name} is not a group file saved by this tool. Pick a file made with Download → Save … to a file.`, err.message);
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
      if (!s.psgId) throw Object.assign(new Error("Choose both groups first."), { plain: true });
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
    state.allRisks = { a: false, b: false };
    state.fieldMode = "auto";
    state.toggled = new Set();
    state.sort = {};
    if (reading.length) {
      // Show the last step with a full bar for a moment before the result replaces it.
      setProgress(`Step ${STEPS.length} of ${STEPS.length}: ${STEPS[STEPS.length - 1][1]}…`, 1);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    setProgress("");
    renderResult();
  } catch (e) {
    setProgress("");
    showFailure(e);
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
  $("#verdictNote").textContent = verdict?.detail || "";
  $("#saveA").textContent = `Save ${r.a.psg.label || "first group"} to a file`;
  $("#saveB").textContent = `Save ${r.b.psg.label || "second group"} to a file`;

  // One card per area: a small muted totals line, then one line per kind of difference "{number} {words}".
  const num = (n) => n.toLocaleString("en-US");
  $("#cards").replaceChildren(...CARD_TABS.map((k) => {
    const { totals, lines, same } = cardLines(r, k);
    const head = el("div", { class: "card-totals" }, `Total ${totals.noun}: `,
      el("span", { class: "who-a", text: nameOf("a") }), ` ${num(totals.a)} · `,
      el("span", { class: "who-b", text: nameOf("b") }), ` ${num(totals.b)}`);
    const rows = lines.map((l) => el("div", { class: "card-line" },
      el("b", { text: num(l.n) }),
      el("span", {}, l.before, l.side ? [" ", el("span", { class: `who-${l.side}`, text: nameOf(l.side) })] : null, l.after ? ` ${l.after}` : "")));
    if (same) rows.push(el("div", { class: "same", text: "✓ Same in both" }));
    return el("button", { class: `card${same ? " ok" : ""}`, onclick: () => openTab(k, true) },
      el("div", { class: "card-title", text: SECTION_TITLES[k] }), head, ...rows);
  }));

  renderRisks();

  const notes = r.highlights.filter((h) => h.kind === "note");
  $("#notesPanel").hidden = !notes.length;
  $("#notesTitle").textContent = `Notes (${notes.length})`;
  $("#warnAlert").hidden = !notes.some((h) => h.level === "warn");
  $("#notes").replaceChildren(...notes.map((h) => el("li", { class: h.level, text: h.text })));

  renderTabs();
  renderTable();
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderRisks() {
  const risks = state.result.highlights.filter((h) => h.kind === "risk");
  $("#riskPanel").hidden = !risks.length;
  // One block per group: a heading, its system permissions, its object line, then its own
  // "Show more / Show fewer" link as the last thing in the block.
  const blocks = ["a", "b"].map((side) => {
    const mine = risks.filter((h) => h.side === side);
    if (!mine.length) return null;
    const general = mine.filter((h) => h.area === "general");
    const rest = mine.filter((h) => h.area !== "general");
    const open = state.allRisks[side];
    const shown = open ? general : general.slice(0, RISKS_SHOWN);
    const hidden = general.length - RISKS_SHOWN;
    const items = [...shown, ...rest].map((h) => el("li", { text: h.short }));
    return el("section", { class: "risk-group" },
      el("h3", { class: `risk-head who-${side}`, text: `Only ${nameOf(side)} has:` }),
      el("ul", { class: "risks" }, ...items),
      hidden > 0 ? el("button", {
        class: "link more-risks", "data-side": side,
        text: open ? "Show fewer" : `Show ${hidden} more system ${hidden === 1 ? "permission" : "permissions"}`,
        onclick: () => {
          state.allRisks[side] = !open;
          renderRisks();
          $$("button.more-risks").find((b) => b.dataset.side === side)?.focus();
        },
      }) : null);
  });
  $("#riskGroups").replaceChildren(...blocks.filter(Boolean));
}

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
    const diffs = k === "overview" ? 0 : tabDiffCount(r, k);
    const word = `${diffs.toLocaleString("en-US")} ${diffs === 1 ? "difference" : "differences"}`;
    return el("button", { role: "tab", "aria-selected": String(state.tab === k), "aria-label": k === "overview" ? null : `${SECTION_TITLES[k]}, ${word}`, onclick: () => openTab(k) },
      SECTION_TITLES[k], k === "overview" ? null : el("span", { class: `n${diffs ? "" : " zero"}`, title: word, text: String(diffs) }));
  }));
  $("#help").textContent = SECTION_HELP[state.tab] || "";
  $(".seg").hidden = state.tab === "overview";
}

// ---------- the list ----------

const YES = "✓";
const NO = "—";
const NONE = "No access";

function statusChip(r) {
  if (r.status === "same") return el("span", { class: "chip same", text: "Same" });
  const tabText = tabDiffText(r, nameOf("a"), nameOf("b"));
  if (tabText) return el("span", { class: "chip d", text: tabText });
  if (r.status === "differ" && r.more) {
    return el("span", { class: `chip d more-${r.more}`, text: `Different: ${nameOf(r.more)} has more` });
  }
  const cls = { onlyA: "a", onlyB: "b", differ: "d" }[r.status];
  return el("span", { class: `chip ${cls}`, text: statusText(r.status, nameOf("a"), nameOf("b")) });
}

function itemCell(r) {
  return el("td", { class: "item" },
    el("span", { text: r.label }),
    r.highRisk ? el("span", { class: "risk-tag", title: "Powerful: lets people see or change a lot of data or settings.", text: "Powerful" }) : null,
    state.showApi && r.key ? el("div", { class: "api", text: r.key }) : null);
}

/** One value cell. `sub` is secondary text such as "needs Salesforce license". `none` is the text for "not in this group": "—" for yes/no columns, "No access" where rights or settings are shown. */
function access(v, sub = "", none = NO) {
  const extra = sub ? el("span", { class: "sub", text: ` · ${sub}` }) : null;
  if (v === null || v === false || v === undefined || (Array.isArray(v) && !v.length) || v === "No access") {
    return el("td", { class: "no", text: none });
  }
  if (v === true) return el("td", { class: "yes", text: YES });
  if (Array.isArray(v)) return el("td", { text: v.map((f) => FLAG_LABELS[f] || f).join(", ") });
  return el("td", { class: /^Removed|removed$/.test(v) ? "removed" : "" }, String(v), extra);
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

/** Column heads ({ id, node }; no id = not sortable) and a row builder for the list on screen. `part` is "sets" or "muted" for What's inside. */
function columns(part) {
  const A = nameOf("a");
  const B = nameOf("b");
  const h = (id, node) => ({ id, node });
  const dotA = () => el("span", {}, el("span", { class: "dot a" }), A);
  const dotB = () => el("span", {}, el("span", { class: "dot b" }), B);
  const headA = h("a", dotA());
  const headB = h("b", dotB());
  const diff = h("diff", "Difference");
  const legacy = state.result.mutedLegacy;
  switch (state.tab) {
    case "overview":
      return { head: [h(null, ""), h(null, dotA()), h(null, dotB())], row: (r) => [el("td", { class: "item", text: r.label }), el("td", { text: blank(r.a) }), el("td", { text: blank(r.b) })] };
    case "objectPermissions":
      return { head: [h("item", "Object"), headA, headB, diff], row: (r) => [itemCell(r), access(r.a, "", NONE), access(r.b, "", NONE), diffCell(r)] };
    case "fieldPermissions": // grouped under object headers, so no Object column
      return { head: [h("item", "Field"), headA, headB, diff], row: (r) => [itemCell(r), access(r.a, "", NONE), access(r.b, "", NONE), diffTd(r)] };
    case "setupAccess":
      return { head: [h("type", "Type"), h("item", "Name"), headA, headB, diff], row: (r) => [el("td", { class: "grp", text: r.group }), itemCell(r), access(r.a), access(r.b), diffTd(r)] };
    case "components":
      if (part === "muted") {
        const may = (side) => (legacy[side] ? "not confirmed, older saved file" : "");
        return { part, head: [h("type", "Type"), h("item", "Name"), headA, headB, diff], row: (r) => [el("td", { class: "grp", text: r.kind }), itemCell(r), access(r.a, may("a")), access(r.b, may("b")), diffTd(r)] };
      }
      return { part, head: [h("type", "Type"), h("item", "Permission set"), headA, headB, diff], row: (r) => [el("td", { class: "grp", text: r.group }), itemCell(r), access(r.a, r.aSub), access(r.b, r.bSub), diffTd(r)] };
    default:
      return state.tab === "tabs"
        ? { head: [h("item", "Tab"), headA, headB, diff], row: (r) => [itemCell(r), access(r.a, "", NONE), access(r.b, "", NONE), diffTd(r)] }
        : { head: [h("item", "Permission"), headA, headB, diff], row: (r) => [itemCell(r), access(r.a), access(r.b), diffTd(r)] };
  }
}

/** Header row. Sortable heads are buttons: click for A to Z, click again for Z to A. */
function headRow(spec) {
  const cur = state.sort[state.tab];
  return el("tr", {}, spec.head.map((c) => {
    if (!c.id) return el("th", {}, c.node);
    const on = cur && cur.col === c.id;
    const key = `${spec.part || ""}:${c.id}`;
    return el("th", { "aria-sort": on ? (cur.dir === "desc" ? "descending" : "ascending") : "none" },
      el("button", {
        class: "sorthead", "data-key": key,
        title: on && cur.dir === "asc" ? "Sorted A to Z. Click to sort Z to A" : "Click to sort A to Z",
        onclick: () => {
          state.sort[state.tab] = { col: c.id, dir: on && cur.dir === "asc" ? "desc" : "asc" };
          renderTable();
          $$("button.sorthead").find((b) => b.dataset.key === key)?.focus();
        },
      }, c.node, on
        ? el("span", { class: "sortarrow", "aria-hidden": "true", text: cur.dir === "desc" ? "▼" : "▲" })
        // Not sorted yet: always show small up and down triangles so the heading looks sortable.
        : el("span", { class: "sortarrow neutral", "aria-hidden": "true" },
          el("span", { text: "▲" }), el("span", { text: "▼" }))));
  }));
}

/** Rows of a list as shown: differences-only and search applied. */
function visibleRows(rows = state.result.sections[state.tab]) {
  const found = filterRows(rows, { section: state.tab, diffOnly: state.diffOnly, search: state.search });
  const s = state.sort[state.tab];
  if (!s || state.tab === "overview") return found;
  const [A, B] = [nameOf("a"), nameOf("b")];
  return state.tab === "fieldPermissions" ? sortGrouped(found, s.col, s.dir, A, B) : sortRows(found, s.col, s.dir, A, B);
}

function emptyMessage(total) {
  if (state.search) return "Nothing matches your search.";
  if (total && state.diffOnly) return `No differences: all ${total} items are the same in both groups. Choose “Everything” to see them.`;
  return "Nothing here.";
}

function plainTable(spec, rows) {
  const body = rows.slice(0, MAX_ROWS).map((r) => el("tr", { class: r.status }, spec.row(r)));
  const parts = [el("table", {}, el("thead", {}, headRow(spec)), el("tbody", {}, body))];
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
      : state.diffOnly ? `${g.name} — ${d}` : `${g.name} — ${d} (of ${num(g.rows.length)} ${g.rows.length === 1 ? "field" : "fields"})`;
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
  const parts = [el("table", { class: "grouped" }, el("thead", {}, headRow(spec)), bodies)];
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
    const intro = "People in this group do not have these, even though a permission set in the group allows them."
      + (old.length ? ` For ${old.join(" and ")} (an older saved group file) it is not known whether a permission set in the group really allowed them, so those items say "not confirmed".` : "");
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

// "This list" is exactly what is on screen (differences-only, search and sort applied; collapsed objects included).
$("#csvTab").addEventListener("click", () => download(`${baseName()}_${safe(SECTION_TITLES[state.tab])}.csv`,
  toCsv(toRows(state.result, state.tab, { diffOnly: state.diffOnly, search: state.search, sort: state.sort[state.tab] })), "text/csv"));
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

// Header links to GitHub's new-issue form. Only tool, extension version and browser go in the link.
{
  let manifestVersion = "";
  try { manifestVersion = chrome.runtime.getManifest().version; } catch { /* dev server */ }
  const version = versionText(manifestVersion, navigator);
  const link = (text, kind) => el("a", {
    href: issueUrl({ kind, tool: FEEDBACK_TOOLS.psg, version }), target: "_blank", rel: "noopener noreferrer", text,
  });
  $("#feedback").replaceChildren(link("Report a bug", "bug"), " · ", link("Suggest an improvement", "enhancement"));
}
