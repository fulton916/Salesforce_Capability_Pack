// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

import { SfApi, findSession } from "../../shared/sfconn.js";
import { readOrg } from "../../shared/sfread.js";
import { searchUsers } from "../../shared/users-read.js";
import { matchUsers } from "../../shared/users-logic.js";
import { recordIdFromUrl } from "../../shared/recordid.js";
import { explain, toPlainText, owdText, exactFirst, givesText, LEVEL_PHRASE } from "./record-access-logic.js";
import { readRecordContext, readRecordAccess, searchUsersExactFirst, readUserById, withRetry, createReadCache, clearRecordFacts } from "./record-access-read.js";
import { startLiveReload } from "../../shared/livereload.js";
import { issueUrl, FEEDBACK_TOOLS, versionText } from "../../shared/feedback.js";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const DEV = params.has("dev"); // served by dev/dev_server.py, which forwards API calls to the org
const HOST = params.get("host");
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
  demo: null, // demo mode: the sample facts
  ctx: null, // the record, its object and org-wide default
  sides: { a: { user: null }, b: { user: null } },
  cache: createReadCache(), // what was read for this page: roles and territories, and the facts of the record being explained (page memory only)
  result: null,
  keptAt: null, // when the record facts used by the shown result were first read, if they were kept from an earlier Explain
  busy: false,
  run: 0,
};

function showError(msg, raw) {
  const box = $("#error");
  box.hidden = !msg;
  box.replaceChildren();
  if (!msg) return;
  box.append(msg);
  if (raw) box.append(el("details", { class: "tech" }, el("summary", { text: "Technical details" }), el("div", { text: raw })));
}
const plainError = (e, fallback) => (e?.status === 401 ? e.message : fallback);
const rawOf = (e) => (e?.status === 401 ? "" : e?.message || String(e || ""));
const setProgress = (t) => { $("#progress").textContent = t || ""; };

// ---------- connecting ----------

function orgKind(o) {
  if (o.isSandbox) return ["Sandbox", "sbx"];
  if (/developer|trial/i.test(o.edition || "")) return [o.edition, "sbx"];
  return ["Production", "prod"];
}

function showOrg(o, host, via) {
  const [kind, cls] = orgKind(o);
  const parts = [el("strong", { text: o.name || o.id }), " ", el("span", { class: `badge ${cls}`, text: kind })];
  if (via) parts.push(el("span", { class: "badge demo", text: via }));
  parts.push(el("span", { class: "host", text: host }));
  $("#org").replaceChildren(...parts);
  document.title = `Why can a user see this record? – ${o.name || host}`;
}

async function connect() {
  if (DEMO) {
    $("#org").replaceChildren(el("span", { class: "badge demo", text: "DEMO" }), " Made-up sample record and users, no org connected");
    state.demo = await (await fetch("../../samples/record_access_demo.json")).json();
    await useRecord(state.demo.record.id);
    await restoreUsers();
    return;
  }
  try {
    let session;
    if (DEV) {
      session = { apiHost: location.host, sessionId: "dev", base: `${location.origin}/sf` };
    } else if (HOST && typeof chrome !== "undefined" && chrome.cookies) {
      $("#org").textContent = `Connecting to ${HOST}…`;
      session = await findSession(HOST, chrome.cookies);
    } else {
      $("#org").textContent = "No org connected. Open this page from the extension button on a Salesforce tab.";
      $$(".org-only").forEach((n) => (n.hidden = true));
      return;
    }
    state.api = withRetry(new SfApi(session));
    const org = await readOrg(state.api, DEV ? "local dev server" : session.apiHost);
    showOrg(org, DEV ? "" : session.apiHost, DEV ? "DEV SERVER" : null);
  } catch (e) {
    $("#org").textContent = `Could not connect${HOST ? " to " + HOST : ""}.`;
    showError(plainError(e, "Could not connect to the org. If you have been away a while, reload the Salesforce tab and try again."), rawOf(e));
    return;
  }
  const id = recordIdFromUrl(params.get("record") || "");
  if (id) { await useRecord(id); await restoreUsers(); }
  else $("#recordInput").focus();
}

/** Put back the users named in the page address (a=, b=), read the same way as a normal pick. A user who cannot be found is skipped. */
async function restoreUsers() {
  if (!state.ctx) return;
  for (const side of ["a", "b"]) {
    const id = params.get(side);
    if (!id || state.sides[side].user) continue;
    try {
      const u = DEMO ? state.demo.users.map(summaryOf).find((x) => x.id === id) : await readUserById(state.api, id);
      if (u) pick(side, u, { quiet: true });
    } catch { /* the person can pick the user again */ }
  }
}

// ---------- the record ----------

async function useRecord(input) {
  const id = recordIdFromUrl(input);
  if (!id) {
    showError("That does not look like a record link or Id. Paste the address of a record page (it has a long code in it), or the Id itself.");
    return;
  }
  showError("");
  clearResult();
  clearRecordFacts(state.cache); // a new look at a record reads its facts again
  state.ctx = null;
  $("#explain").disabled = true;
  $("#recordCard").textContent = "Reading the record…";
  try {
    if (DEMO) {
      const f = state.demo;
      state.ctx = { record: f.record, owd: f.owd, object: f.object, notes: [], warnings: [] };
    } else {
      state.ctx = await readRecordContext(state.api, id);
    }
  } catch (e) {
    $("#recordCard").textContent = "The record could not be read.";
    // A plain Error from the reader already has plain words; a Salesforce error (it has a status) goes under Technical details.
    showError(e?.status === 401 ? e.message : e?.status ? "The record could not be read. Check the link, or reload the Salesforce tab and try again." : e?.message, e?.status ? rawOf(e) : "");
    return;
  }
  $("#recordInput").value = "";
  renderRecord();
  updateExplain();
  // Do not pull the cursor away if the person has already clicked into a box and started typing: moving focus
  // would run that box's blur handler and wipe what they typed.
  const busyTyping = document.activeElement && document.activeElement.tagName === "INPUT" && document.activeElement.id !== "recordInput";
  if (!state.sides.a.user && !busyTyping) combos.a.input.focus();
}

function renderRecord() {
  const { record, owd, object } = state.ctx;
  const nodes = [
    el("div", {}, el("span", { class: "rec-name", text: record.name }), " ", el("span", { class: "rec-kind", text: `(${object.label})` })),
    el("div", { text: record.ownerName ? `Owner: ${record.ownerName}${record.ownerKind === "queue" ? " (a queue)" : ""}` : "Owner: not shown" }),
    el("div", { class: "rec-owd", text: owdText(owd.internal, object.plural) }),
  ];
  if (owd.internal === "ControlledByParent" && record.parentId) {
    nodes.push(el("div", { text: `Its parent: ${record.parentObjectLabel || "record"} '${record.parentName || record.parentId}'` }));
    nodes.push(el("button", {
      text: "Explain the parent record",
      onclick: () => {
        const p = new URLSearchParams(location.search);
        p.set("record", record.parentId);
        for (const side of ["a", "b"]) { // keep the chosen users
          const u = state.sides[side].user;
          if (u) p.set(side, u.id); else p.delete(side);
        }
        location.search = p.toString();
      },
    }));
  }
  $("#recordCard").replaceChildren(...nodes);
}

$("#recordUse").addEventListener("click", () => useRecord($("#recordInput").value));
$("#recordInput").addEventListener("keydown", (e) => { if (e.key === "Enter") useRecord($("#recordInput").value); });

// ---------- user pickers ----------

const combos = {};

function setupCombo(side) {
  const root = $(`.picker[data-side="${side}"]`);
  const input = $(".psg-input", root);
  const list = $(".psg-list", root);
  const c = (combos[side] = { input, list, items: [], active: -1, timer: null, seq: 0 });

  c.open = () => {
    clearTimeout(c.timer);
    const chosen = state.sides[side].user;
    const text = (chosen && input.value === chosen.name ? "" : input.value).trim();
    c.seq++;
    if (DEMO) { const r = matchUsers(state.demo.users.map(summaryOf), text); draw({ ...r, users: exactFirst(r.users, text) }); return; }
    if (text.length < MIN_CHARS) { drawMessage(`Type at least ${MIN_CHARS} letters of a name or username.`); return; }
    drawMessage("Searching…");
    const mine = c.seq;
    c.timer = setTimeout(async () => {
      try {
        const res = await searchUsersExactFirst(state.api, text, searchUsers);
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
  input.addEventListener("blur", () => { c.close(); input.value = state.sides[side].user?.name || ""; });
  input.addEventListener("keydown", (e) => {
    if (list.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) { c.open(); e.preventDefault(); return; }
    if (e.key === "ArrowDown") { highlight(side, Math.min(c.active + 1, c.items.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { highlight(side, Math.max(c.active - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter" && !list.hidden && c.active >= 0) { pick(side, c.items[c.active]); e.preventDefault(); }
    else if (e.key === "Enter" && list.hidden && !$("#explain").disabled) { run(); e.preventDefault(); }
    else if (e.key === "Escape") c.close();
  });
}

const summaryOf = (u) => ({ id: u.id, name: u.name, username: u.username, isActive: u.isActive, profile: u.profile || "" });

function highlight(side, i) {
  const c = combos[side];
  if (i < 0) return;
  c.active = i;
  $$("li[role=option]", c.list).forEach((li, j) => li.setAttribute("aria-selected", String(j === i)));
  const li = document.getElementById(`${side}-opt-${i}`);
  if (li) { li.scrollIntoView({ block: "nearest" }); c.input.setAttribute("aria-activedescendant", li.id); }
}

function pick(side, u, opts = {}) {
  state.sides[side].user = u;
  combos[side].input.value = u.name;
  combos[side].close();
  showError("");
  renderChosen(side);
  updateExplain();
  if (!opts.quiet && side === "a" && !state.sides.b.user) combos.b.input.focus();
}

function removeSide(side) {
  state.sides[side].user = null;
  combos[side].input.value = "";
  renderChosen(side);
  updateExplain();
}

function renderChosen(side) {
  const u = state.sides[side].user;
  const box = $(`.picker[data-side="${side}"] .chosen`);
  if (!u) { box.replaceChildren(); return; }
  box.replaceChildren(el("button", { class: "link", text: side === "b" ? "Stop comparing" : "Clear", onclick: () => removeSide(side) }));
}

function updateExplain() {
  $("#explain").disabled = !(state.ctx && state.sides.a.user) || state.busy;
}

for (const side of ["a", "b"]) setupCombo(side);

// ---------- explain ----------

function clearResult() {
  state.result = null;
  state.keptAt = null;
  $("#results").hidden = true;
}

async function run() {
  if ($("#explain").disabled) return;
  const picks = [state.sides.a.user, state.sides.b.user].filter(Boolean);
  const token = ++state.run;
  state.busy = true;
  updateExplain();
  showError("");
  try {
    // Progress counts only from this run while it is still busy (a late call after the run ended is ignored).
    const progress = (t) => { if (token === state.run && state.busy) setProgress(t); };
    const facts = DEMO ? state.demo : await readRecordAccess(state.api, state.ctx, picks, { progress, cache: state.cache });
    if (token !== state.run) return;
    state.result = explain(facts, picks.map((p) => p.id));
    state.keptAt = facts.kept?.at ?? null;
    renderResult();
  } catch (e) {
    // A run that failed must not leave an older answer on screen: it could be read as the new one. Take it away
    // (this also hides "Copy explanation" and the "read at" line) and say so next to the error.
    const hadResult = state.result !== null;
    clearResult();
    // No status and a browser fetch network-failure message (Chrome/Edge "Failed to fetch", Firefox "NetworkError when attempting
    // to fetch resource.", Safari "Load failed") means the request never reached the org. Any other TypeError is a bug in our own
    // code and is not called a connection problem. A plain Error thrown by the reader on purpose already has plain words and is shown as it is.
    const unreached = !e?.status && /failed to fetch|networkerror|load failed/i.test(e?.message || "");
    const plain = unreached
      ? "Could not reach the org. Check your connection, or reload the Salesforce tab and try again."
      : e?.status ? plainError(e, "Could not read from the org. If you have been away a while, reload the Salesforce tab and try again.") : e?.message || "Something went wrong.";
    const joined = hadResult ? `${plain.replace(/\s*$/, "").replace(/([^.!?])$/, "$1.")} The earlier result was taken away, so it cannot be mistaken for a new one. Click Explain to try again.` : plain;
    showError(joined, unreached ? e?.message || String(e) : e?.status ? rawOf(e) : "");
    $("#error").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } finally {
    state.busy = false;
    setProgress("");
    updateExplain();
  }
}

$("#explain").addEventListener("click", run);

// ---------- results ----------

/** Salesforce's own word for the reason (as the View Sharing Hierarchy page words it), small and quiet. */
const sfLabelNode = (label) => (label ? el("span", { class: "sf-label", title: "The reason as Salesforce words it on its View Sharing Hierarchy page", text: `Salesforce: ${label}` }) : null);

function routeNode(r, inactive) {
  let gives;
  if (!r.access) gives = el("span", { class: "gives unknown", text: "Gives access (how much is not known)" });
  else if (r.limited) gives = el("span", { class: "gives limited", text: `Would give ${r.access} access, limited to ${r.effective} by object permissions` });
  else gives = el("span", { class: "gives", text: `${inactive ? "Would give" : "Gives"} ${r.access} access` });
  return el("li", { class: "route" },
    el("div", { class: "route-head" }, gives, sfLabelNode(r.sfLabel), r.summary === r.steps[0] ? null : el("span", { text: r.summary })),
    el("ol", { class: "chain" }, r.steps.map((s) => el("li", { text: s }))));
}

function personNode(u) {
  const nodes = [
    el("h2", { text: u.name }),
    el("div", { class: "who-sub", text: [u.username, u.profile, u.roleName ? `Role: ${u.roleName}` : "No role"].filter(Boolean).join(" · ") }),
  ];
  if (u.inactiveText) nodes.push(el("div", { class: "gate", text: u.inactiveText }));
  nodes.push(el("p", { class: `answer ${u.sfLevel === "none" ? "none" : ""}`, text: u.inactive ? "Salesforce gives no answer for an inactive user." : u.sfLevel === null ? "Salesforce's answer could not be read" : `Salesforce says: ${u.name} ${LEVEL_PHRASE[u.sfLevel]}.` }));
  if (u.limitText) nodes.push(el("p", { class: "hint", text: u.limitText }));
  if (u.gateText) nodes.push(el("div", { class: "gate", text: u.gateText }));
  else if (!u.routes.length) nodes.push(el("div", { class: "noroute", text: "We found no route that gives this user access." }));
  else nodes.push(el("ol", { class: "routes" }, u.routes.map((r) => routeNode(r, u.inactive))));
  if (u.parentLine) nodes.push(el("p", { class: "hint", text: u.parentLine }));
  if (u.rules && u.rules.state !== "unread") {
    nodes.push(el("h3", { text: "Restriction and scoping rules" }));
    nodes.push(el("p", { class: u.rules.state === "failed" ? "noroute" : "hint", text: u.rules.header }));
    if (u.rules.lines.length) nodes.push(el("ul", { class: "rules" }, u.rules.lines.map((l) => el("li", { class: l.outcome === "hides" ? "rule-hides" : "", text: l.text }))));
    if (u.rules.closing) nodes.push(el("p", { class: "noroute", text: u.rules.closing }));
  }
  if (u.ruleSfNote) nodes.push(el("p", { class: "gate", text: u.ruleSfNote }));
  return el("div", { class: `panel person ${u.key}` }, nodes);
}

/** The quiet line shown when the record's sharing facts were kept from an earlier Explain (not read just now). */
function renderKept() {
  const box = $("#kept");
  box.replaceChildren();
  box.hidden = state.keptAt === null || state.keptAt === undefined;
  if (box.hidden) return;
  const time = new Date(state.keptAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  box.append(
    `Who this record is shared with was read at ${time}, the first time you explained it on this page. `,
    el("button", { class: "link", text: "Read it again", onclick: readAgain }),
  );
}

/** Forget the kept facts of the record and explain again with the same users. */
function readAgain() {
  clearRecordFacts(state.cache);
  run();
}

function renderResult() {
  const res = state.result;
  $("#results").hidden = false;
  renderKept();
  $("#verdict").textContent = res.verdict;
  $("#copied").textContent = "";
  $("#mismatches").replaceChildren(...res.users.filter((u) => u.mismatch).map((u) => el("div", { class: "mismatch" },
    el("strong", { text: "This does not match what Salesforce says. " }), u.mismatch.text,
    el("div", { text: "Possible reasons:" }),
    el("ul", {}, u.mismatch.causes.map((c) => el("li", { text: c }))))));
  $("#people").replaceChildren(...res.users.map(personNode));

  const d = res.difference;
  $("#diffPanel").hidden = !d;
  if (d) {
    const parts = [el("p", { text: d.text })];
    if (d.gate) parts.push(el("div", { class: "gate", text: d.gate }));
    if (d.levelNote) parts.push(el("p", { class: "hint", text: d.levelNote }));
    if (d.items.length) parts.push(el("p", { class: "hint", text: `The routes ${d.more} has that ${d.less} is missing:` }));
    for (const it of d.items) {
      parts.push(el("div", { class: "diffitem" },
        el("div", { class: "route-head" }, it.gives ? el("span", { class: it.limited ? "gives limited" : "gives", text: givesText(it) }) : null, sfLabelNode(it.sfLabel), el("span", { text: it.route })),
        ...it.missing.map((m) => el("p", { class: "miss", text: m })),
        ...it.change.map((m) => el("p", { class: "change", text: `What would change it: ${m}` }))));
    }
    for (const v of d.via || []) parts.push(el("p", { class: "hint", text: v }));
    for (const t of d.rules || []) parts.push(el("p", { class: "miss", text: t }));
    if (d.unexplained) parts.push(el("p", { class: "hint", text: d.unexplained }));
    $("#diff").replaceChildren(...parts);
  }

  $("#notesTitle").textContent = `Notes (${res.notes.length})`;
  $("#notes").replaceChildren(...res.notes.map((t) => el("li", { text: t })));
  $("#techPanel").hidden = !res.warnings.length;
  $("#tech").textContent = res.warnings.join("\n");
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("#copy").addEventListener("click", async () => {
  if (!state.result) return;
  try {
    await navigator.clipboard.writeText(toPlainText(state.result));
    $("#copied").textContent = "Copied. Paste it into your ticket.";
    setTimeout(() => { $("#copied").textContent = ""; }, 3000);
  } catch (e) {
    showError("Copying did not work in this window. Click on the page and try again.", rawOf(e));
  }
});

connect();
startLiveReload();

// Header links to GitHub's new-issue form. Only tool, extension version and browser go in the link.
{
  let manifestVersion = "";
  try { manifestVersion = chrome.runtime.getManifest().version; } catch { /* dev server */ }
  const version = versionText(manifestVersion, navigator);
  const link = (text, kind) => el("a", {
    href: issueUrl({ kind, tool: FEEDBACK_TOOLS.record, version }), target: "_blank", rel: "noopener noreferrer", text,
  });
  $("#feedback").replaceChildren(link("Report a bug", "bug"), " · ", link("Suggest an improvement", "enhancement"));
}
