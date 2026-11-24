import { SfApi, findSession, isSalesforceHost } from "../../shared/sfconn.js";
import { readOrg } from "../../shared/sfread.js";
import { searchUsers } from "../../shared/users-read.js";
import { matchUsers } from "../../shared/users-logic.js";
import {
  analyze, sectionsOf, copyText, copyWithFallback, matchItems, objectItems, fieldItems, factsFromModel, whenStamp,
  OBJECT_LEVELS, FIELD_LEVELS, UNLISTED_FIELD_HINT, setupUrl, systemApiShort, fieldApiShort,
} from "./who-grants-logic.js";
import { readGrants, readSystemList, readObjectList, readFieldDescribe, useNewestVersion } from "./who-grants-read.js";
import { startLiveReload } from "../../shared/livereload.js";
import { issueUrl, FEEDBACK_TOOLS, versionText } from "../../shared/feedback.js";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const DEV = params.has("dev"); // served by dev/dev_server.py, which forwards API calls to the org
const HOST = params.get("host");
// The host the "Open in Setup" links go to: only a Salesforce host from ?host= (setupUrl checks it again). No links in demo mode.
const LINK_HOST = !DEMO && HOST && isSalesforceHost(HOST) ? HOST : null;
const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;
const LIST_CAP = 100;

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

// Kept in memory for this page only.
const state = {
  api: null,
  model: null, // demo mode: the made-up org
  orgName: "",
  kind: "system",
  user: null,
  system: null, // the picked item {api, label}
  object: null,
  field: null,
  level: "read",
  facts: null, // what was read for the shown answer (every level), so a new level needs no new read
  specBase: null, // the permission the facts belong to (without the level)
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
const plainError = (e, fallback) => (e?.status === 401 ? e.message : e?.status || e?.errorCode ? fallback : e?.message || fallback);
const rawOf = (e) => (e?.status === 401 ? "" : e?.status || e?.errorCode ? e?.message || String(e || "") : "");
const setProgress = (t) => { $("#progress").textContent = t || ""; };

// ---------- one combo box for every search box on the page ----------

/**
 * A search box with a list under it, usable with the keyboard (arrows, Enter, Escape).
 * `search(text)` returns {rows, total?, empty?} (or a promise of it); `render(row)` returns {main, small, tag, mono};
 * `text(row)` is what the box shows once a row is chosen. Only the newest search may draw (a late answer is dropped).
 */
function makeCombo({ input, list, search, render, text = (r) => r.label, onPick, onEnter, onClear, onDirty, minChars = 0, debounce = 0, onError }) {
  const c = { input, list, items: [], active: -1, seq: 0, timer: null, chosen: null };
  const optId = (i) => `${list.id}-opt-${i}`;

  function message(msg) {
    c.items = [];
    c.active = -1;
    list.replaceChildren(el("li", { class: "none", text: msg }));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.removeAttribute("aria-activedescendant");
  }

  function draw(res) {
    const rows = res.rows || [];
    c.items = rows;
    c.active = rows.length ? 0 : -1;
    const lis = rows.map((row, i) => {
      const r = render(row);
      return el("li", {
        role: "option", id: optId(i), "aria-selected": String(i === c.active),
        onmousedown: (e) => { e.preventDefault(); choose(row); },
        onmousemove: () => highlight(i),
      }, el("span", { class: "nm", text: r.main }), r.tag ? el("span", { class: "tag-inactive", text: r.tag }) : null,
         r.small ? el("span", { class: `dev ${r.mono ? "api" : "plain"}`, text: r.small }) : null);
    });
    if (!rows.length) lis.push(el("li", { class: "none", text: res.empty || "Nothing found. Try a different word." }));
    if (res.more) lis.push(el("li", { class: "none", text: `Showing the first ${rows.length}. Keep typing to narrow the list.` }));
    else if (res.total > rows.length) lis.push(el("li", { class: "none", text: `Showing the first ${rows.length} of ${res.total}. Keep typing to narrow the list.` }));
    list.replaceChildren(...lis);
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (c.active >= 0) input.setAttribute("aria-activedescendant", optId(0)); else input.removeAttribute("aria-activedescendant");
  }

  function highlight(i) {
    if (i < 0 || i >= c.items.length) return;
    c.active = i;
    [...list.querySelectorAll("li[role=option]")].forEach((li, j) => li.setAttribute("aria-selected", String(j === i)));
    const li = document.getElementById(optId(i));
    if (li) { li.scrollIntoView({ block: "nearest" }); input.setAttribute("aria-activedescendant", li.id); }
  }

  /** True while the box says something other than the chosen row (typed over it, or emptied) and nothing new is chosen yet. */
  c.isDirty = () => !!c.chosen && input.value !== text(c.chosen);

  function choose(row) {
    c.chosen = row;
    input.value = text(row);
    c.close();
    onPick(row);
    onDirty?.();
  }

  /** Leaving the box without choosing: the chosen text comes back (and with it the same answer); an emptied box clears the choice. */
  function leave() {
    c.close();
    if (c.chosen && input.value.trim() === "") {
      c.chosen = null;
      input.value = "";
      onClear?.();
    } else {
      input.value = c.chosen ? text(c.chosen) : "";
    }
    onDirty?.();
  }

  c.open = () => {
    clearTimeout(c.timer);
    const typed = (c.chosen && input.value === text(c.chosen) ? "" : input.value).trim();
    const mine = ++c.seq;
    if (typed.length < minChars) { message(`Type at least ${minChars} letters.`); return; }
    const run = () => {
      let r;
      try { r = search(typed); } catch (e) { if (mine === c.seq) { message("The search did not work."); onError?.(e); } return; }
      if (r && typeof r.then === "function") {
        message("Loading…");
        r.then((res) => { if (mine === c.seq) draw(res); }, (e) => { if (mine === c.seq) { message("The search did not work."); onError?.(e); } });
      } else draw(r);
    };
    if (debounce) { message("Searching…"); c.timer = setTimeout(run, debounce); } else run();
  };

  c.close = () => {
    clearTimeout(c.timer);
    c.seq++;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  /** Set or clear the chosen row from code (no onPick). */
  c.set = (row) => { c.chosen = row || null; input.value = row ? text(row) : ""; onDirty?.(); };
  c.disable = (off, placeholder) => { input.disabled = off; if (placeholder) input.placeholder = placeholder; if (off) c.close(); };

  input.addEventListener("focus", () => { input.select(); c.open(); });
  input.addEventListener("click", () => { if (list.hidden) c.open(); });
  input.addEventListener("input", () => { c.open(); onDirty?.(); });
  input.addEventListener("blur", leave);
  input.addEventListener("keydown", (e) => {
    if (list.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) { c.open(); e.preventDefault(); return; }
    if (e.key === "ArrowDown") { highlight(Math.min(c.active + 1, c.items.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { highlight(Math.max(c.active - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter" && !list.hidden && c.active >= 0) { choose(c.items[c.active]); e.preventDefault(); }
    else if (e.key === "Enter" && list.hidden && onEnter) { onEnter(); e.preventDefault(); }
    else if (e.key === "Escape") leave();
  });
  return c;
}

// ---------- the lists (loaded when needed; the org's describe is cached by SfApi) ----------

const listCache = new Map();
function cachedList(key, load) {
  if (!listCache.has(key)) {
    const p = load();
    p.catch(() => listCache.delete(key)); // a failure is not kept
    listCache.set(key, p);
  }
  return listCache.get(key);
}

const lists = {
  system: () => cachedList("system", async () => (DEMO ? state.model.systemPermissions : await readSystemList(state.api))),
  objects: () => cachedList("objects", async () => (DEMO ? state.model.objects : await readObjectList(state.api))),
  fieldObjects: () => cachedList("fieldObjects", async () => (DEMO ? state.model.objects : objectItems(await readFieldDescribe(state.api)))),
  fields: (objectApi) => cachedList(`fields:${objectApi}`, async () => (DEMO ? state.model.fields[objectApi] || [] : fieldItems(await readFieldDescribe(state.api), objectApi))),
};

const asRows = (items, text) => { const r = matchItems(items, text, LIST_CAP); return { rows: r.items, total: r.total }; };
const itemRender = (i) => ({ main: i.label, small: i.api, mono: true });
const systemRender = (i) => ({ main: i.label, small: systemApiShort(i.api), mono: true }); // "ExportReport", not "PermissionsExportReport"

// ---------- the combos ----------

const combos = {};

combos.user = makeCombo({
  input: $("#userInput"), list: $("#userList"), minChars: DEMO ? 0 : MIN_CHARS, debounce: DEMO ? 0 : DEBOUNCE_MS,
  text: (u) => u.name,
  search: async (typed) => {
    const r = DEMO ? matchUsers(state.model.users, typed) : await searchUsers(state.api, typed);
    return { rows: r.users, more: r.more, empty: "No user found. Try a different part of the name or username." };
  },
  render: (u) => ({ main: u.name, tag: u.isActive ? "" : "Inactive", small: [u.username, u.profile].filter(Boolean).join(" · ") }),
  onPick: (u) => { state.user = u; clearResult(); showError(""); updateFind(); },
  onClear: () => { state.user = null; clearResult(); updateFind(); },
  onDirty: () => syncView(),
  onEnter: () => run(),
  onError: (e) => showError(plainError(e, "The search did not work. If you have been away a while, reload the Salesforce tab and try again."), rawOf(e)),
});

combos.system = makeCombo({
  input: $("#systemInput"), list: $("#systemList"),
  search: async (typed) => asRows(await lists.system(), typed),
  render: systemRender,
  onPick: (i) => { state.system = i; clearResult(); updateFind(); },
  onClear: () => { state.system = null; clearResult(); updateFind(); },
  onDirty: () => syncView(),
  onEnter: () => run(),
  onError: (e) => showError(plainError(e, "The list of system permissions could not be read."), rawOf(e)),
});

combos.object = makeCombo({
  input: $("#objectInput"), list: $("#objectList"),
  search: async (typed) => asRows(await (state.kind === "field" ? lists.fieldObjects() : lists.objects()), typed),
  render: itemRender,
  onClear: () => {
    state.object = null;
    state.field = null;
    combos.field.set(null);
    combos.field.disable(true, "Pick the object first, then search for the field");
    clearResult();
    updateFind();
  },
  onDirty: () => syncView(),
  onPick: (i) => {
    state.object = i;
    state.field = null;
    combos.field.set(null);
    combos.field.disable(state.kind !== "field", "Search for a field of this object");
    clearResult();
    updateFind();
    if (state.kind === "field") combos.field.input.focus();
  },
  onEnter: () => run(),
  onError: (e) => showError(plainError(e, "The list of objects could not be read."), rawOf(e)),
});

combos.field = makeCombo({
  input: $("#fieldInput"), list: $("#fieldList"),
  search: async (typed) => {
    const items = await lists.fields(state.object.api);
    const r = asRows(items, typed);
    // Fields that are not listed are not controlled by field permissions.
    r.empty = typed ? UNLISTED_FIELD_HINT : "No field of this object is controlled by field permissions. Everyone with access to the object sees all of its fields.";
    return r;
  },
  render: (f) => ({ main: f.label, small: fieldApiShort(f.api, state.object?.api), mono: true }),
  onPick: (f) => { state.field = f; clearResult(); updateFind(); },
  onClear: () => { state.field = null; clearResult(); updateFind(); },
  onDirty: () => syncView(),
  onEnter: () => run(),
  onError: (e) => showError(plainError(e, "The list of fields could not be read."), rawOf(e)),
});
combos.field.disable(true);

// ---------- choices ----------

function showKind() {
  const k = state.kind;
  $("#systemBox").hidden = k !== "system";
  $("#objectBox").hidden = k === "system";
  $("#fieldBox").hidden = k !== "field";
  $("#levelBox").hidden = k === "system";
  const levels = k === "field" ? FIELD_LEVELS : OBJECT_LEVELS;
  $("#level").replaceChildren(...levels.map((l) => el("option", { value: l.key, text: l.label })));
  $("#level").value = state.level = "read";
}

for (const r of document.querySelectorAll('input[name="kind"]')) {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    state.kind = r.value;
    state.system = state.object = state.field = null;
    for (const k of ["system", "object", "field"]) combos[k].set(null);
    combos.field.disable(true, "Pick the object first, then search for the field");
    clearResult();
    showKind();
    updateFind();
  });
}

$("#level").addEventListener("change", () => {
  state.level = $("#level").value;
  if (state.facts && state.specBase) renderResult(); // same facts, a different level: no new read
});

function specNow() {
  if (state.kind === "system") return state.system ? { kind: "system", api: state.system.api, label: state.system.label } : null;
  if (!state.object) return null;
  const base = { kind: state.kind, object: state.object.api, objectLabel: state.object.label };
  if (state.kind === "object") return base;
  return state.field ? { ...base, field: state.field.api, fieldLabel: state.field.label } : null;
}

/** True while any search box says something other than what was chosen: the answer shown would not match the boxes. */
const anyDirty = () => Object.values(combos).some((c) => c.isDirty());

function updateFind() {
  $("#find").disabled = !(state.user && specNow()) || state.busy || anyDirty();
}

/** Show the answer only while the boxes match it; Find waits too. Nothing is read again: the facts stay. */
function syncView() {
  $("#results").hidden = !state.facts || anyDirty();
  updateFind();
}

// ---------- the answer ----------

function clearResult() {
  state.run++; // an answer still being read is dropped
  state.busy = false;
  state.facts = null;
  state.specBase = null;
  setProgress("");
  $("#results").hidden = true;
}

async function run() {
  if ($("#find").disabled) return;
  const spec = specNow();
  const user = state.user;
  const token = ++state.run;
  state.busy = true;
  updateFind();
  showError("");
  $("#results").hidden = true;
  try {
    setProgress("Reading…");
    const progress = (t) => { if (token === state.run) setProgress(t); };
    const facts = DEMO ? factsFromModel(state.model, user.id, spec) : await readGrants(state.api, user, spec, { progress });
    if (token !== state.run) return; // another user or permission was picked meanwhile
    state.facts = facts;
    state.specBase = spec;
    renderResult();
  } catch (e) {
    if (token !== state.run) return;
    showError(plainError(e, "Could not read this user's access. If you have been away a while, reload the Salesforce tab and try again."), rawOf(e));
  } finally {
    if (token === state.run) { state.busy = false; setProgress(""); updateFind(); }
  }
}

function currentResult() {
  return analyze(state.facts, { ...state.specBase, level: state.kind === "system" ? undefined : state.level });
}

/** A link to Setup for one named thing: null (no link at all) unless the host and the Id look right. Opens in a new tab. */
function setupLink(l) {
  const href = LINK_HOST && l ? setupUrl(LINK_HOST, l.kind, l.id, { groupId: l.groupId }) : null;
  return href ? el("a", { class: "setup-link", href, target: "_blank", rel: "noopener noreferrer", "aria-label": l.label, text: l.text }) : null;
}
/** One card: title, small API name, the card's own link on a line of its own, then the facts. Each named permission set appears once, in a list. */
function cardEl(it) {
  const own = setupLink((it.links || []).find((l) => l.own));
  return el("li", { class: "card" },
    el("div", { class: "title", text: it.title }),
    it.apiName ? el("span", { class: "api", text: it.apiName }) : null,
    own ? el("div", { class: "own-link" }, own) : null,
    it.body.map((b) => (typeof b === "string"
      ? el("p", { text: b })
      : el("div", { class: "named" },
        el("p", { class: "named-label", text: b.label }),
        el("ul", { class: "named-items" }, b.items.map((i) => { const a = setupLink(i.link); return el("li", {}, el("span", { text: i.text }), a ? " " : null, a); }))))));
}

function renderResult() {
  const r = currentResult();
  state.result = r;
  $("#results").hidden = anyDirty();
  const h = $("#headline");
  h.textContent = r.headline;
  h.className = `headline ${r.answer}`;
  const inactive = $("#inactiveNote");
  inactive.hidden = !r.inactiveNote;
  inactive.textContent = r.inactiveNote;
  $("#copied").textContent = "";
  $("#copyFallback").hidden = true;

  $("#sections").replaceChildren(...sectionsOf(r, { timeZone: undefined }).map((sec) =>
    el("section", { class: `panel section ${sec.key}` },
      el("h2", { text: sec.title }),
      sec.hint ? el("p", { class: "hint", text: sec.hint }) : null,
      el("ul", { class: "cards" }, sec.items.map(cardEl)))));

  $("#objectAccess").hidden = !r.objectAccess;
  if (r.objectAccess) $("#objectAccessText").textContent = r.objectAccess.text;

  $("#notesTitle").textContent = `Notes (${r.notes.length})`;
  $("#notes").replaceChildren(...r.notes.map((n) => el("li", { text: n })));
  const raws = r.problems.map((p) => p.raw).filter(Boolean);
  $("#techPanel").hidden = !raws.length;
  $("#tech").textContent = raws.join("\n");
}

$("#copy").addEventListener("click", async () => {
  if (!state.facts || anyDirty()) return;
  const text = copyText(currentResult(), { orgName: state.orgName, when: whenStamp(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const { copied } = await copyWithFallback(text, navigator.clipboard);
  $("#copied").textContent = copied ? "Copied. Paste it into your ticket." : "";
  $("#copyFallback").hidden = copied;
  if (!copied) {
    const ta = $("#copyText");
    ta.value = text;
    ta.focus();
    ta.select();
  }
});

$("#find").addEventListener("click", run);

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
  state.orgName = o.name || host || "";
  document.title = `Where does a user get this permission? – ${o.name || host}`;
}

async function connect() {
  if (DEMO) {
    state.model = await (await fetch("../../samples/who_grants_demo.json")).json();
    state.orgName = state.model.org?.name || "Demo org";
    $("#org").replaceChildren(el("span", { class: "badge demo", text: "DEMO" }), " Made-up org and users, no org connected");
    $("#demoHints").hidden = false;
    $("#demoHintList").replaceChildren(...state.model.hints.map((h) => el("li", { text: h })));
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
      document.querySelectorAll(".org-only").forEach((n) => (n.hidden = true));
      return;
    }
    state.api = new SfApi(session);
    await useNewestVersion(state.api); // this page asks for the org's newest API version (the shared default is unchanged)
    const org = await readOrg(state.api, DEV ? "local dev server" : session.apiHost);
    showOrg(org, DEV ? "" : session.apiHost, DEV ? "DEV SERVER" : null);
  } catch (e) {
    $("#org").textContent = `Could not connect${HOST ? " to " + HOST : ""}.`;
    showError(plainError(e, "Could not connect to the org. If you have been away a while, reload the Salesforce tab and try again."), rawOf(e));
  }
}

showKind();
connect().then(() => combos.user.input.focus()).catch((e) => showError("Something went wrong while starting.", e?.message || String(e)));
startLiveReload();

// Header links to GitHub's new-issue form. Only tool, extension version and browser go in the link.
{
  const version = versionText(manifestVersion, navigator);
  const link = (text, kind) => el("a", {
    href: issueUrl({ kind, tool: FEEDBACK_TOOLS.grants, version }), target: "_blank", rel: "noopener noreferrer", text,
  });
  $("#feedback").replaceChildren(link("Report a bug", "bug"), " · ", link("Suggest an improvement", "enhancement"));
}
