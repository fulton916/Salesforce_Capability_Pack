// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

import { SfApi, findSession, isSalesforceHost } from "../../shared/sfconn.js";
import { readOrg } from "../../shared/sfread.js";
import { searchWords, matchesWords } from "../../shared/pick.js";
import { readFlowList, versionsToRead, readFlowVersion, readVersions, whyUnreadable, resolveContext } from "./flow-usage-read.js";
import { scanFlow, startInfo, stepName, buildResults, summaryLine, plainFlowType, versionWords, nameWithApi, uniqueSteps, looksLikeId, csvText, csvFileName, localStamp, startSearchNotes } from "./flow-usage-scan.js";
import { buildObjectView, RUN_ORDER_RULE, noOrderBlockText, metaWords, objectSummary, objectCsvText, objectCsvFileName } from "./flow-usage-object.js";
import { contextFromParams } from "../../shared/urlcontext.js";
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

const state = {
  api: null,
  objects: null, // [{name, label}], once read
  object: null, // the object picked in step one: {name, label}
  fields: null, // fields of that object: [{name, label}]
  defs: null, // every flow of the org (FlowDefinitionView), once read
  cache: new Map(), // flow version Id -> {metadata} | {error}; in memory only, for this page session
  readCalls: 0, // flow contents read so far
  target: null, // what was last searched for
  results: null,
  pending: [], // notes found while getting ready for the next search
  tech: [], // raw messages for Notes
  chain: Promise.resolve(), // reads and searches run one after the other
  seq: 0,
  describes: new Map(), // object API name -> describe (promise); one describe call per object for the whole page session
  scans: new Map(), // flow version Id -> {start, records}, what the object view needs from a flow's contents
  objectView: null, // what the object view shows now
};

// ---------- where the data comes from: the org, or the made-up sample in demo mode ----------

let sampleData = null;
async function sample() {
  if (!sampleData) {
    const res = await fetch("../../samples/flow_usage.json");
    if (!res.ok) throw new Error("Could not load samples/flow_usage.json");
    sampleData = await res.json();
  }
  return sampleData;
}

const source = {
  async objects() {
    if (DEMO) return Object.entries((await sample()).objects).map(([name, o]) => ({ name, label: o.label }));
    const g = await state.api.describeGlobal();
    return g.sobjects.filter((s) => s.queryable !== false).map((s) => ({ name: s.name, label: s.label || s.name }));
  },
  describe(name) {
    const k = String(name).toLowerCase();
    if (!state.describes.has(k)) {
      state.describes.set(k, (async () => {
        if (DEMO) return (await sample()).objects[name] || null;
        return state.api.describe(name);
      })().catch((e) => { state.describes.delete(k); throw e; }));
    }
    return state.describes.get(k);
  },
  async flows() {
    if (DEMO) return (await sample()).flows.map((f) => f.def);
    return readFlowList(state.api);
  },
  async version(id) {
    if (DEMO) {
      for (const f of (await sample()).flows) if (id in f.versions) return f.versions[id];
      return { error: { message: "Not in the sample" } };
    }
    return readFlowVersion(state.api, id);
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
  $("#org").replaceChildren(
    el("strong", { text: o.name || o.id }), " ",
    el("span", { class: `badge ${cls}`, text: kind }),
    via ? el("span", { class: "badge demo", text: via }) : "",
    el("span", { class: "host", text: host })
  );
  document.title = `Where is it used in flows? – ${o.name || host}`;
}

async function connect() {
  if (DEMO) {
    $("#org").replaceChildren(el("span", { class: "badge demo", text: "DEMO" }), " Made-up sample flows, no org connected");
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
      $("#org").textContent = "No org connected. Open this page from the Salesforce Capability Pack button on a Salesforce tab.";
      return false;
    }
    state.api = new SfApi(session);
    const org = await readOrg(state.api, DEV ? "local dev server" : session.apiHost);
    showOrg(org, DEV ? "" : session.apiHost, DEV ? "Local dev server" : null);
    return true;
  } catch (e) {
    $("#org").textContent = `Could not connect${HOST ? " to " + HOST : ""}.`;
    showError(plainError(e, "Could not connect to the org. If you have been away a while, reload the Salesforce tab and try again."), rawOf(e));
    return false;
  }
}

// ---------- the search box: object first, then field (or text) ----------

const find = { items: [], active: -1, seq: 0 };

function closeFind() {
  $("#findList").hidden = true;
  $("#find").setAttribute("aria-expanded", "false");
  $("#find").removeAttribute("aria-activedescendant");
}

function rankedMatches(list, text, limit) {
  const words = searchWords(text);
  const hits = list.filter((x) => matchesWords(`${x.label} ${x.name}`, words));
  const q = words.join(" ");
  const starts = (x) => (q && searchWords(x.label).join(" ").startsWith(q) ? 0 : 1);
  hits.sort((x, y) => starts(x) - starts(y) || x.label.localeCompare(y.label));
  return { items: hits.slice(0, limit), total: hits.length };
}

async function openFind() {
  const my = ++find.seq;
  const input = $("#find");
  const text = input.value.trim();
  let items = [];
  let more = 0;
  try {
    if (!looksLikeId(text)) {
      if (!state.object) {
        if (!state.objects) { setProgress("Reading the list of objects…"); state.objects = await source.objects(); setProgress(""); }
        const m = rankedMatches(state.objects, text, 50);
        items = m.items.map((o) => ({ kind: "object", o }));
        more = m.total - m.items.length;
      } else {
        if (!state.fields) {
          setProgress(`Reading the fields of ${state.object.label}…`);
          const d = await source.describe(state.object.name);
          state.fields = (d?.fields || []).map((f) => ({ name: f.name, label: f.label || f.name }));
          setProgress("");
        }
        const m = rankedMatches(state.fields, text, 50);
        items = m.items.map((f) => ({ kind: "field", f }));
        more = m.total - m.items.length;
      }
    }
  } catch (e) {
    setProgress("");
    showError(plainError(e, "Could not read the list from the org."), rawOf(e));
  }
  if (my !== find.seq) return; // a newer keystroke took over
  if (text) items.unshift(...(looksLikeId(text) ? [{ kind: "text", text }] : []));
  if (text && !looksLikeId(text)) items.push({ kind: "text", text });
  find.items = items;
  find.active = items.length ? 0 : -1;
  const lis = items.map((it, i) => {
    const attrs = { role: "option", id: `find-opt-${i}`, "aria-selected": String(i === 0), onmousedown: (e) => { e.preventDefault(); choose(it); }, onmousemove: () => highlight(i) };
    if (it.kind === "text") return el("li", { ...attrs, class: "text" }, el("span", { class: "nm", text: `Find this text in flows: “${it.text}”` }));
    const x = it.kind === "object" ? it.o : it.f;
    return el("li", attrs, el("span", { class: "nm", text: x.label }), el("span", { class: "api", text: x.name }));
  });
  if (!looksLikeId(text) && !items.some((i) => i.kind !== "text")) lis.unshift(el("li", { class: "none", text: text ? (state.object ? `No field of ${state.object.label} matches that.` : "No object matches that.") : "Nothing to show." }));
  if (more > 0) lis.push(el("li", { class: "none", text: `Showing the first 50 of ${(50 + more).toLocaleString("en-US")} matches. Keep typing to narrow the list.` }));
  $("#findList").replaceChildren(...lis);
  $("#findList").hidden = false;
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

function setObject(obj) {
  state.object = obj;
  state.fields = null;
  $("#objectChip").hidden = !obj;
  $("#objectChipText").textContent = obj ? obj.label : "";
  const input = $("#find");
  input.value = "";
  input.placeholder = obj ? `Type a field of ${obj.label}` : "Type an object, for example Account";
  setFindLabel();
}

/** The heading over the box fits what is on screen: nothing picked, an object, or a field of the object. */
function setFindLabel(field) {
  const obj = state.object;
  $("#findLabel").textContent = !obj ? "Find the flows that use an object, a field or a record Id"
    : field ? `Showing the flows that use ${field.label} of ${obj.label}. Type another field to change it`
    : `Showing the flows on ${obj.label}. Pick a field of ${obj.label} to see only the flows that use it`;
}

/** Back to "no object": the object view (if it is what is on screen) goes away. */
function clearObject() {
  setObject(null);
  if (state.target?.kind === "object") {
    state.seq++;
    state.target = null;
    state.objectView = null;
    $("#results").hidden = true;
    setProgress("");
  }
}

const runObject = (o) => run({ kind: "object", object: o.name, objectLabel: o.label });

function choose(it) {
  closeFind();
  if (it.kind === "object") { setObject(it.o); runObject(it.o); $("#find").focus(); openFind(); return; }
  if (it.kind === "field") {
    $("#find").value = it.f.label;
    setFindLabel(it.f);
    run({ kind: "field", object: state.object.name, field: it.f.name, objectLabel: state.object.label, fieldLabel: it.f.label });
    return;
  }
  run({ kind: "text", text: it.text });
}

{
  const input = $("#find");
  input.addEventListener("input", openFind);
  input.addEventListener("focus", () => { input.select(); openFind(); });
  input.addEventListener("click", () => { if ($("#findList").hidden) openFind(); });
  input.addEventListener("blur", () => closeFind());
  input.addEventListener("keydown", (e) => {
    const open = !$("#findList").hidden;
    if (e.key === "ArrowDown" && open) { highlight(Math.min(find.active + 1, find.items.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp" && open) { highlight(Math.max(find.active - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter" && open && find.active >= 0) { choose(find.items[find.active]); e.preventDefault(); }
    else if (e.key === "Escape") closeFind();
    else if (e.key === "Backspace" && !input.value && state.object) { clearObject(); openFind(); }
  });
  $("#objectChipClear").addEventListener("click", () => { clearObject(); input.focus(); });
  $("#inactive").addEventListener("change", () => { if (state.target) run(state.target); });
}

// ---------- reading the flows ----------

/** Make sure the flow list and the contents of the needed versions are in memory. Returns the jobs. */
async function ensureFlows(includeInactive) {
  if (!state.defs) {
    setProgress("Reading the list of flows…");
    state.defs = await source.flows();
  }
  const jobs = versionsToRead(state.defs, { includeInactive });
  const before = state.cache.size;
  await readVersions((id) => source.version(id), jobs, state.cache, {
    onProgress: (done, total) => setProgress(total ? `Reading flows: ${done} of ${total}` : ""),
  });
  state.readCalls += state.cache.size - before;
  return jobs;
}

// ---------- running a search ----------

function run(target) {
  const my = ++state.seq;
  Object.assign(state, startSearchNotes(state.pending));
  state.target = target;
  // One at a time: a second search waits for the first read, then finds everything already in memory.
  state.chain = state.chain.then(() => (target.kind === "object" ? doRunObject(target, my) : doRun(target, my))).catch(() => {});
  return state.chain;
}

async function doRun(target, my) {
  if (my !== state.seq) return; // a newer search is already queued
  showError("");
  $("#find").disabled = true;
  try {
    const jobs = await ensureFlows($("#inactive").checked);
    setProgress("Searching…");
    const scans = [];
    for (const job of jobs) {
      const entry = job.versionId ? state.cache.get(job.versionId) : null;
      const why = whyUnreadable(job, entry);
      const base = { def: job.def, versionId: job.versionId, versionKind: job.versionKind };
      if (why) { scans.push({ ...base, error: why }); continue; } // the raw reason is shown under that flow's Technical details
      const r = await scanFlow(entry.metadata, target, { describe: (o) => source.describe(o) });
      scans.push({ ...base, ...r });
    }
    if (my !== state.seq) return;
    state.results = buildResults(scans);
    setProgress("");
    render();
  } catch (e) {
    setProgress("");
    showError(plainError(e, "The flows could not be read. Your user may not be allowed to see them."), rawOf(e));
    state.tech.push(`Flows: ${rawOf(e)}`);
  } finally {
    $("#find").disabled = false;
  }
}

// ---------- the object view ----------

/** One job per flow: its active version, or (with the tick box) its newest one. */
function onePerFlow(jobs) {
  const seen = new Map();
  for (const j of jobs) if (!seen.has(j.def.id) || j.versionKind === "active") seen.set(j.def.id, j);
  return [...seen.values()];
}

/** What the object view needs from one flow: its start element and its record steps (kept for the page session). */
async function entryOf(job) {
  const base = { def: job.def, versionId: job.versionId, versionKind: job.versionKind };
  if (job.versionId && !state.cache.has(job.versionId)) return base; // not read yet
  const cached = job.versionId ? state.cache.get(job.versionId) : null;
  const why = whyUnreadable(job, cached);
  if (why) return { ...base, error: why };
  let sc = state.scans.get(job.versionId);
  if (!sc) {
    const r = await scanFlow(cached.metadata, null, { describe: (o) => source.describe(o) });
    sc = { start: startInfo(cached.metadata), records: r.records };
    state.scans.set(job.versionId, sc);
  }
  return { ...base, ...sc };
}

async function fieldLabeler(objectName) {
  try {
    const d = await source.describe(objectName);
    const m = new Map((d?.fields || []).map((f) => [f.name.toLowerCase(), f.label || f.name]));
    return (api) => m.get(String(api).toLowerCase()) || api;
  } catch { return (api) => api; }
}

async function doRunObject(target, my) {
  if (my !== state.seq) return;
  showError("");
  try {
    if (!state.defs) { setProgress("Reading the list of flows…"); state.defs = await source.flows(); }
    const jobs = onePerFlow(versionsToRead(state.defs, { includeInactive: $("#inactive").checked }));
    const labelOf = await fieldLabeler(target.object);
    const show = async (partial) => {
      const entries = [];
      for (const j of jobs) entries.push(await entryOf(j));
      if (my !== state.seq) return;
      state.objectView = buildObjectView(target.object, entries, { labelOf, objectLabel: target.objectLabel, partial });
      state.objectView.unknownSteps = entries.reduce((n, e) => n + (e.records || []).filter((r) => !r.objectKnown).length, 0);
      renderObject(target);
    };
    // First what the list of flows already says (the trigger object's API name), then the contents.
    const mine = jobs.filter((j) => j.def.triggerObjectName && j.def.triggerObjectName.toLowerCase() === target.object.toLowerCase());
    const rest = jobs.filter((j) => !mine.includes(j));
    const reader = (list) => readVersions((id) => source.version(id), list, state.cache, {
      onProgress: (done, total) => setProgress(total ? `Reading flows: ${done} of ${total}` : ""),
    });
    await show(true);
    let before = state.cache.size;
    await reader(mine);
    state.readCalls += state.cache.size - before;
    await show(true);
    before = state.cache.size;
    await reader(rest);
    state.readCalls += state.cache.size - before;
    await show(false);
    setProgress("");
  } catch (e) {
    setProgress("");
    showError(plainError(e, "The flows could not be read. Your user may not be allowed to see them."), rawOf(e));
    state.tech.push(`Flows: ${rawOf(e)}`);
  }
}

// ---------- showing the results ----------

const builderLink = (versionId) => (HOST && isSalesforceHost(HOST) && versionId
  ? `https://${HOST}/builder_platform_interaction/flowBuilder.app?flowId=${encodeURIComponent(versionId)}` : null);

const openLink = (versionId) => {
  const link = builderLink(versionId);
  return link ? el("a", { class: "open", href: link, target: "_blank", rel: "noopener noreferrer", text: "Open in Flow Builder" }) : null;
};

const activeBadge = (d) => el("span", { class: `badge ${d.isActive ? "on" : "off"}`, text: d.isActive ? "Active" : "Not active" });

function stepItem(h, target) {
  if (target.kind === "text") {
    return el("li", {}, el("span", { class: "kind", text: stepName(h) }), h.part ? ` (in ${h.part})` : "", ": found ",
      el("span", { class: "snip", text: `“${h.ref}”` }));
  }
  if (h.detail) return el("li", {}, el("span", { class: "kind", text: stepName(h) }), ": ", h.detail);
  const written = (h.refs || [h.ref]).filter((r) => lcRef(r) !== lcRef(h.field));
  const via = written.length ? el("span", { class: "via", text: ` (written as ${written.join(", ")})` }) : null;
  return el("li", {}, el("span", { class: "kind", text: stepName(h) }), h.part ? ` (in ${h.part})` : "", ": ",
    el("span", { class: `does ${h.action}`, text: h.action }), " ", h.field, via);
}
const lcRef = (s) => String(s).toLowerCase();

function flowItem(scan, list, target, extra) {
  const d = scan.def;
  return el("li", {},
    el("div", { class: "flowhead" },
      el("span", { class: "nm", text: d.label || d.apiName }),
      el("span", { class: "api", text: d.apiName }),
      activeBadge(d),
      openLink(scan.versionId)),
    el("div", { class: "flowmeta", text: `${plainFlowType(d)}. Read: ${versionWords(scan.versionKind, d.isActive).toLowerCase()}.` }),
    extra || null,
    el("ul", { class: "steps" }, uniqueSteps(list, target).map((h) => stepItem(h, target))));
}

/** A flow the page could not look inside: why, in plain words, the raw text folded away, and a link where there is a version to open. */
function unreadableItem(s) {
  return el("li", { class: "unread" },
    el("div", { class: "flowhead" },
      el("span", { class: "nm", text: s.def.label || s.def.apiName }),
      el("span", { class: "api", text: s.def.apiName }),
      activeBadge(s.def),
      openLink(s.versionId)),
    el("p", { class: "why", text: (s.error || s.unreadable).plain }),
    (s.error || s.unreadable).raw ? el("details", { class: "tech" }, el("summary", { text: "Technical details" }), el("div", { text: (s.error || s.unreadable).raw })) : null);
}

const unreadableHelp = (list) => (list.some((s) => builderLink(s.versionId))
  ? "These flows were not searched, so they may use it. Where there is an “Open in Flow Builder” link, open that flow and check; for the others, look in Setup."
  : "These flows were not searched, so they may use it. Look at them in Setup.");

function targetText(t) {
  if (t.kind === "text") return looksLikeId(t.text) ? `Searched for the record Id ${t.text} (15 and 18 character forms)` : `Searched for the text “${t.text}”`;
  return `Searched for ${nameWithApi(t.fieldLabel, t.field)} on ${nameWithApi(t.objectLabel, t.object)}`;
}

function renderNotes(extra) {
  const notes = [
    `Read ${state.readCalls.toLocaleString("en-US")} flow ${state.readCalls === 1 ? "version" : "versions"}, one call to Salesforce each${state.api ? `; ${state.api.calls.toLocaleString("en-US")} calls to Salesforce so far on this page` : ""}. They are kept in memory until you close this page, so the next search is quick.`,
    $("#inactive").checked ? "Inactive flows and the newest draft of each flow were included." : "Only the active version of each active flow was read. Tick “Also look in inactive flows and drafts” to include the rest.",
    ...extra,
    HOST && isSalesforceHost(HOST) ? null : "The “Open in Flow Builder” links need this page to be opened from the Salesforce Capability Pack button on a Salesforce tab.",
    ...state.tech,
  ].filter(Boolean);
  $("#notesPanel").hidden = false;
  $("#notesTitle").textContent = `Notes (${notes.length})`;
  $("#notes").replaceChildren(...notes.map((n) => el("li", { text: n })));
}

function render() {
  const r = state.results;
  const t = state.target;
  $("#results").hidden = false;
  $("#fieldView").hidden = false;
  $("#objectView").hidden = true;
  $("#summary").textContent = summaryLine(r, t);
  $("#searched").textContent = targetText(t);
  $("#flows").replaceChildren(...r.sure.map((s) => flowItem(s, s.hits, t)));
  $("#empty").hidden = r.sure.length > 0;
  $("#empty").textContent = r.sure.length ? "" : t.kind === "text" ? "No flow that could be read contains that text." : "No flow that could be read uses this field.";
  $("#download").disabled = !r.sure.length && !r.possible.length && !r.unreadable.length;

  $("#possiblePanel").hidden = !r.possible.length;
  $("#possiblePanel").open = r.possible.length > 0 && r.sure.length === 0;
  $("#possibleTitle").textContent = `Possible matches (${r.flowsPossible})`;
  $("#possibleHelp").textContent = "A field with this name appears in these steps, but the flow does not say which object it belongs to, the link to it could not be followed, or the step saves a whole record at once.";
  $("#possible").replaceChildren(...r.possible.map((s) => flowItem(s, s.possible, t)));

  $("#unreadablePanel").hidden = !r.unreadable.length;
  $("#unreadableTitle").textContent = `Could not look inside (${r.unreadable.length})`;
  $("#unreadableHelp").textContent = unreadableHelp(r.unreadable);
  $("#unreadable").replaceChildren(...r.unreadable.map(unreadableItem));

  renderNotes(["Steps that save a whole record from a variable do not name their fields, so they are listed under Possible matches."]);
}

// ---------- showing the object view ----------

/** One flow in the object view: label, when it runs, active or not, how it starts, its paths and its steps. */
function objectItem(it, { numbered }) {
  const d = it.def;
  const lines = [];
  if (it.unreadable) lines.push(el("p", { class: "why", text: `We could not look inside this flow, so its entry conditions are not shown. ${it.unreadable.plain}` }));
  else if (!it.detailsKnown) lines.push(el("p", { class: "flowmeta", text: "Reading the details of this flow…" }));
  else if (it.conditions) {
    lines.push(el("p", { class: "flowmeta", text: it.conditions.has
      ? `Starts only when: ${it.conditions.text}${it.conditions.changeOnly ? " (and only when the record changes to meet them)" : ""}.`
      : "No entry conditions: it starts for every record." }));
  }
  if (it.paths.length) lines.push(el("p", { class: "flowmeta" }, "Also: ", it.paths.join("; "), it.pathsPartial ? " (details are still being read)" : "", "."));
  return el("li", {},
    el("div", { class: "flowhead" },
      it.band === "low" || it.band === "high" ? el("span", { class: "pos", text: `Trigger order ${it.order}` }) : null,
      el("span", { class: "nm", text: it.label }),
      el("span", { class: "api", text: it.apiName }),
      it.isProcess ? el("span", { class: "tag", text: "Process Builder" }) : null,
      activeBadge(d),
      openLink(it.versionId)),
    el("div", { class: "flowmeta", text: `${metaWords(it)}.` }),
    ...lines,
    it.steps.length ? el("ul", { class: "steps" }, it.steps.map((s) => el("li", {}, s.text))) : null);
}

function objectSection(title, help, items, opts = {}) {
  // Inside a group, a note stands above the flows that have no trigger order (when there are two or more of them).
  const rows = [];
  // The note only mentions flows above when flows with a trigger order of 1 to 1000 are above, and below for 1001 to 2000.
  const above = items.some((x) => x.band === "low");
  const below = items.some((x) => x.band === "high");
  items.forEach((it, i) => {
    if (it.band === "none" && !it.orderKnown && items[i - 1]?.band !== "none") {
      rows.push(el("li", { class: "orderblock" }, el("strong", { text: "No trigger order set. " }), noOrderBlockText({ above, below }).replace(/^No trigger order set\. /, "")));
    }
    rows.push(objectItem(it, opts));
  });
  const body = items.length
    ? el("ul", { class: "flows" }, rows)
    : el("p", { class: "none", text: opts.none || "None." });
  return el("section", { class: "objsec" }, el("h2", { text: `${title} (${items.length})` }), help ? el("p", { class: "hint", text: help }) : null, body);
}

function renderObject(t) {
  const v = state.objectView;
  if (!v) return;
  $("#results").hidden = false;
  $("#fieldView").hidden = true;
  $("#objectView").hidden = false;
  $("#objSummary").textContent = objectSummary(v);
  $("#objSearched").textContent = `Flows for ${nameWithApi(t.objectLabel, t.object)}. Flows are matched to the object by its API name.`;
  $("#objDownload").disabled = v.partial;
  const sec = (g) => objectSection(g.title, g.help, g.items, { numbered: true, none: "No flow runs here." });
  const processSec = objectSection(v.process.title, v.process.help, v.process.items, { numbered: false, none: v.partial ? "Still reading the other flows." : "None." });
  const sections = [sec(v.groups[0]), processSec, ...v.groups.slice(1).map(sec)];
  sections.push(objectSection("Runs on a schedule over these records", "Scheduled flows whose start names this object.", v.scheduled, { numbered: false, none: v.partial ? "Still reading the other flows." : "None." }));
  sections.push(objectSection("Other flows that change these records", "They create, update or delete these records in a step.", v.changes, { numbered: false, none: v.partial ? "Still reading the other flows." : "None." }));
  sections.push(objectSection("Other flows that only read these records", "They look these records up (Get Records) and change nothing here.", v.reads, { numbered: false, none: v.partial ? "Still reading the other flows." : "None." }));
  if (v.unreadable.length) {
    sections.push(el("details", { class: "panel notes objsec" },
      el("summary", { text: `Could not look inside (${v.unreadable.length})` }),
      el("p", { class: "hint", text: `These flows do not say which object they are about and could not be read, so they may also use ${t.objectLabel} records. ${unreadableHelp(v.unreadable).replace(/^These flows were not searched, so they may use it\. /, "")}` }),
      el("ul", { class: "flows" }, v.unreadable.map(unreadableItem))));
  }
  $("#objSections").replaceChildren(...sections);
  renderNotes([
    `${RUN_ORDER_RULE} This page can't see when a flow was activated, so flows with no trigger order are listed by name. Give each flow a trigger order if the order matters.`,
    v.unknownSteps ? `${v.unknownSteps} record ${v.unknownSteps === 1 ? "step" : "steps"} in the flows could not be tied to an object (a record variable with no known type), so they are not listed.` : null,
  ]);
}

// ---------- download ----------

const stamp = () => localStamp();

function downloadCsv(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("#download").addEventListener("click", () => {
  if (!state.results) return;
  downloadCsv(csvText(state.results), csvFileName(state.target, stamp()));
});

$("#objDownload").addEventListener("click", () => {
  if (!state.objectView || state.objectView.partial) return;
  downloadCsv(objectCsvText(state.objectView), objectCsvFileName(state.target?.object, stamp()));
});

// ---------- start ----------

/** Fill the box from the Setup or record page the person came from (the `object` and `field` in the address). */
async function applyContext() {
  const ctx = contextFromParams(params);
  if (!ctx.object) return;
  try {
    let { object, field } = ctx;
    if (!DEMO) {
      const r = await resolveContext(state.api, ctx);
      object = r.object;
      field = r.field;
      state.pending.push(...r.notes);
    }
    state.objects = await source.objects();
    const obj = state.objects.find((o) => o.name.toLowerCase() === String(object).toLowerCase());
    if (!obj) return;
    setObject(obj);
    if (!field) { runObject(obj); $("#find").focus(); return; } // an object only: the object view runs at once
    const d = await source.describe(obj.name);
    state.fields = (d?.fields || []).map((f) => ({ name: f.name, label: f.label || f.name }));
    const f = state.fields.find((x) => x.name.toLowerCase() === field.toLowerCase());
    if (!f) { runObject(obj); $("#find").focus(); return; }
    $("#find").value = f.label;
    setFindLabel(f);
    run({ kind: "field", object: obj.name, field: f.name, objectLabel: obj.label, fieldLabel: f.label });
  } catch (e) {
    state.pending.push(`Starting values: ${rawOf(e)}`);
  }
}

async function start() {
  if (!(await connect())) { $("#findRow").hidden = true; return; }
  await applyContext();
}

start();
startLiveReload();

// Header links to GitHub's new-issue form. Only tool, extension version and browser go in the link.
{
  let manifestVersion = "";
  try { manifestVersion = chrome.runtime.getManifest().version; } catch { /* dev server */ }
  const version = versionText(manifestVersion, navigator);
  const link = (text, kind) => el("a", {
    href: issueUrl({ kind, tool: FEEDBACK_TOOLS.flows, version }), target: "_blank", rel: "noopener noreferrer", text,
  });
  $("#feedback").replaceChildren(link("Report a bug", "bug"), " · ", link("Suggest an improvement", "enhancement"));
}
