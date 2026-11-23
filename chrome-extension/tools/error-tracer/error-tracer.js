import { SfApi, findSession } from "../../shared/sfconn.js";
import { readOrg } from "../../shared/sfread.js";
import { readLogList, readLogBody, ReadProblem } from "./error-tracer-read.js";
import { analyzeLog, rawAround, elapsedWords, humanSize, whatRan, statusWords, filterLogs, userChoices, summaryText, whenText } from "./error-tracer-logic.js";
import { startLiveReload } from "../../shared/livereload.js";
import { issueUrl, FEEDBACK_TOOLS, versionText } from "../../shared/feedback.js";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const DEV = params.has("dev"); // served by dev/dev_server.py, which forwards API calls to the org
const HOST = params.get("host");

const $ = (sel, root = document) => root.querySelector(sel);

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

let manifestVersion = "";
try { manifestVersion = chrome.runtime.getManifest().version; } catch { /* dev server */ }

// Kept in memory for this page only: the list, the picked log and what was understood from it.
const state = { source: null, rows: [], pickedId: null, analysis: null, meta: null, token: 0 };

function showError(msg, raw) {
  const box = $("#error");
  box.hidden = !msg;
  box.replaceChildren();
  if (!msg) return;
  box.append(msg);
  if (raw) box.append(el("details", { class: "tech" }, el("summary", { text: "Technical details" }), el("div", { text: raw })));
}

// ---------- the list ----------

function drawFilter() {
  const sel = $("#whoFilter");
  const keep = sel.value;
  sel.replaceChildren(el("option", { value: "", text: "Everyone" }),
    ...userChoices(state.rows).map((u) => el("option", { value: u.id, text: `${u.name} (${u.count})` })));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
}

function drawList() {
  const rows = filterLogs(state.rows, { problemsOnly: $("#onlyProblems").checked, userId: $("#whoFilter").value });
  const body = $("#logRows");
  body.replaceChildren();
  $("#logTable").hidden = rows.length === 0;
  $("#listStatus").textContent = state.rows.length
    ? `${rows.length} of ${state.rows.length} logs shown (newest first).`
    : "No debug logs were found. Turn one on with the steps above, repeat the action, then refresh.";
  for (const r of rows) {
    const s = statusWords(r);
    // Result comes right after When, and each cell has a label for the stacked layout on a narrow screen.
    body.append(el("tr", { class: "logrow", "aria-selected": r.id === state.pickedId ? "true" : "false", onclick: () => pick(r) },
      el("td", { "data-label": "When" }, el("button", { type: "button", class: "pick", text: whenText(r.startTime), onclick: (e) => { e.stopPropagation(); pick(r); } })),
      el("td", { "data-label": "Result", class: s.ok === false ? "bad" : s.ok ? "good" : "", text: s.text }),
      el("td", { "data-label": "Whose log", text: r.userName || "Not stated" }),
      el("td", { "data-label": "What ran", text: whatRan(r) }),
      el("td", { "data-label": "Size", text: humanSize(r.length) })));
  }
}

async function refresh() {
  showError("");
  $("#refresh").disabled = true;
  $("#listStatus").textContent = "Reading the list of logs…";
  try {
    state.rows = await state.source.list();
    drawFilter();
    drawList();
    $("#steps").open = state.rows.length === 0; // fold the steps once there are logs
  } catch (e) {
    $("#listStatus").textContent = "";
    showError(e instanceof ReadProblem ? e.message : "Could not read the list of logs.", e instanceof ReadProblem ? e.raw : e?.message);
  } finally {
    $("#refresh").disabled = false;
  }
}

// ---------- one log ----------

async function pick(row) {
  const token = ++state.token;
  state.pickedId = row.id;
  state.analysis = null;
  drawList();
  $("#result").hidden = false;
  $("#resultBody").replaceChildren(el("p", { class: "hint", text: "Reading the log…" }));
  showError("");
  try {
    const text = await state.source.body(row.id);
    if (token !== state.token) return; // another log was picked meanwhile
    const meta = {
      userName: row.userName, length: row.length, startTime: row.startTime, startTimeText: whenText(row.startTime),
      what: whatRan(row), status: statusWords(row).text,
    };
    state.analysis = analyzeLog(text, meta);
    state.meta = meta;
    renderResult(row, state.analysis, meta);
  } catch (e) {
    if (token !== state.token) return;
    $("#result").hidden = true;
    showError(e instanceof ReadProblem ? e.message : "Could not read this log.", e instanceof ReadProblem ? e.raw : e?.message);
  }
}

function fact(label, value) {
  return value ? [el("dt", { text: label }), el("dd", { text: value })] : [];
}

function findingCard(analysis, f) {
  const card = el("div", { class: `finding${f.handled ? " soft" : ""}` },
    el("div", { class: "kind", text: f.handled ? "May have been handled" : "Problem" }),
    el("h3", { text: f.title }),
    el("p", { text: f.message }));
  if (f.where) card.append(el("p", { class: "where", text: `Where: ${f.where}` }));
  if (f.callers && f.callers.length) card.append(el("p", { class: "steps", text: `Called from: ${f.callers.join(" ← ")}` }));
  if (f.steps.length) card.append(el("p", { class: "steps", text: `Running at the time: ${f.steps.join(" › ")}` }));
  const when = [Number.isFinite(f.elapsedMs) ? `When: ${elapsedWords(f.elapsedMs)}` : "", f.count > 1 ? `Raised ${f.count} times.` : ""].filter(Boolean).join(". ");
  if (when) card.append(el("p", { class: "steps", text: when }));
  if (f.flowPointer) card.append(el("p", { class: "pointer", text: f.flowPointer }));
  const pre = el("pre", { class: "raw" });
  const det = el("details", { class: "rawlines" }, el("summary", { text: "Log lines" }), pre);
  det.addEventListener("toggle", () => { // built on first open: a long log has many cards
    if (!det.open || pre.childNodes.length) return;
    for (const l of rawAround(analysis, f)) pre.append(el("span", { class: l.hit ? "hit" : "", text: l.text || " " }));
  });
  card.append(det);
  return card;
}

function renderResult(row, analysis, meta) {
  const bad = analysis.problemCount > 0;
  const box = $("#resultBody");
  const parts = [
    el("p", { class: `headline ${bad ? "bad" : analysis.notLog ? "" : "good"}`, text: analysis.headline }),
    analysis.subline ? el("p", { class: "subline", text: analysis.subline }) : null,
    el("dl", { class: "facts" },
      fact("Who", [meta.userName, analysis.user.username && `(${analysis.user.username})`].filter(Boolean).join(" ") || "Not stated"),
      fact("User's time zone", analysis.user.timeZone),
      fact("When", meta.startTimeText),
      fact("What ran", meta.what),
      fact("Result", meta.status),
      fact("Size", humanSize(row.length))),
    el("div", { class: "actions" },
      el("button", { id: "copy", class: "primary", type: "button", text: "Copy what failed", onclick: copyText }),
      el("span", { id: "copyStatus", role: "status", class: "hint" }))];
  // The native replaceChildren turns a null into the text "null", so leave those out.
  box.replaceChildren(...parts.filter((x) => x));
  const real = analysis.findings.filter((f) => !f.handled);
  const soft = analysis.findings.filter((f) => f.handled);
  for (const f of real) box.append(findingCard(analysis, f));
  if (soft.length) {
    box.append(el("h2", { text: real.length ? "Also raised, and possibly handled" : "Raised, and possibly handled" }));
    for (const f of soft) box.append(findingCard(analysis, f));
  }
  if (analysis.notes.length) {
    box.append(el("details", { class: "notes" }, el("summary", { text: `Notes (${analysis.notes.length})` }),
      el("ul", {}, analysis.notes.map((n) => el("li", { text: n })))));
  }
}

async function copyText() {
  const status = $("#copyStatus");
  if (!state.analysis) return;
  try {
    await navigator.clipboard.writeText(summaryText(state.analysis, state.meta));
    status.textContent = "Copied. Paste it into your ticket.";
  } catch {
    status.textContent = "Copying was blocked by the browser.";
  }
}

// ---------- connecting ----------

async function demoSource() {
  const d = await (await fetch("../../samples/error_tracer_demo.json")).json();
  return {
    list: async () => d.logs.map(({ body, ...row }) => ({ ...row })),
    body: async (id) => {
      const l = d.logs.find((x) => x.id === id);
      if (!l) throw new ReadProblem("That demo log was not found.", id);
      return l.body.join("\n");
    },
  };
}

async function start() {
  if (DEMO) {
    $("#org").replaceChildren(el("span", { class: "badge demo", text: "DEMO" }), " Made-up sample logs, no org connected");
    state.source = await demoSource();
    return refresh();
  }
  let session;
  try {
    if (DEV) {
      session = { apiHost: location.host, sessionId: "dev", base: `${location.origin}/sf` };
    } else if (HOST && typeof chrome !== "undefined" && chrome.cookies) {
      $("#org").textContent = `Connecting to ${HOST}…`;
      session = await findSession(HOST, chrome.cookies);
    } else {
      $("#org").textContent = "No org connected. Open this page from the extension button on a Salesforce tab.";
      $("#refresh").disabled = true;
      return;
    }
  } catch (e) {
    $("#org").textContent = `Could not connect${HOST ? " to " + HOST : ""}.`;
    showError(e?.status === 401 || /session/i.test(e?.message || "") ? e.message : "Could not connect to the org. If you have been away a while, reload the Salesforce tab and try again.", e?.message);
    return;
  }
  const api = new SfApi(session);
  state.source = { list: () => readLogList(api), body: (id) => readLogBody(api, id) };
  const host = DEV ? (HOST || "") : (HOST || session.apiHost);
  $("#org").textContent = DEV ? "Dev server" : host;
  try {
    const org = await readOrg(api, host);
    $("#org").replaceChildren(el("strong", { text: org.name || host }), " ", el("span", { class: `badge ${org.isSandbox ? "sbx" : "prod"}`, text: org.isSandbox ? "Sandbox" : "Production" }));
  } catch { /* the header keeps the host */ }
  return refresh();
}

$("#refresh").addEventListener("click", refresh);
$("#onlyProblems").addEventListener("change", drawList);
$("#whoFilter").addEventListener("change", drawList);

start().catch((e) => showError("Something went wrong while starting.", e?.message || String(e)));
startLiveReload();

// Header links to GitHub's new-issue form. Only tool, extension version and browser go in the link.
{
  const version = versionText(manifestVersion, navigator);
  const link = (text, kind) => el("a", {
    href: issueUrl({ kind, tool: FEEDBACK_TOOLS.errors, version }), target: "_blank", rel: "noopener noreferrer", text,
  });
  $("#feedback").replaceChildren(link("Report a bug", "bug"), " · ", link("Suggest an improvement", "enhancement"));
}
