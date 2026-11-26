// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

import { SfApi, findSession } from "../../shared/sfconn.js";
import { readOrg } from "../../shared/sfread.js";
import { searchUsers } from "../../shared/users-read.js";
import { matchUsers, pastedUserId } from "../../shared/users-logic.js";
import { toCsv } from "../../shared/csv.js";
import { readAuditTrail, plainProblem, plainUserSearchProblem } from "./audit-trail-read.js";
import {
  PERIODS, DEFAULT_PERIOD, PAGE_ROWS, FACETS, FACET_TITLES, SEARCH_HINT, NO_SECTION, NO_USER, CHOICES, CHOICE_LABELS, PERSON_FACET_HINT, searchLimitNote, STALE_TEXT,
  READ_STEP, MAX_HELD, OLDER_STALE_TEXT, buildCoverage, olderLabel, olderProgressText, coverageWords, continuationStart,
  coverageFits, readFor, personView, personWords, whoLabel, id15,
  periodBounds, timeZoneName, formatLocal, formatUtc, parseSearch, highlightParts, emptyFilters, buildPeople, runFilters, facetOptions,
  toggleChoice, hasFilters, filterChips, removeChip, clearFilters, sortEntries, timeSpan, partialNote, statusLine, emptyText, progressText,
  ticketText, shownText, csvRows, matchCounts, readingStatusLine, matchBreakdown, chooseFocus, copyWithFallback, demoRecords, demoApi,
} from "./audit-trail-logic.js";
import { startLiveReload } from "../../shared/livereload.js";
import { issueUrl, FEEDBACK_TOOLS, versionText } from "../../shared/feedback.js";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const DEV = params.has("dev"); // served by dev/dev_server.py, which forwards API calls to the org
const HOST = params.get("host");
const TZ = timeZoneName();
const DEBOUNCE_MS = 150;
const REFRESH_MS = 250; // while entries arrive, redraw at most this often
const CLIP_OVER = 200; // a "What changed" text longer than this is clipped, with "Show all"
const FACET_ROWS = 100;
// One read keeps READ_STEP entries; "Read older entries" adds more, up to MAX_HELD in memory. In demo mode only, ?cap=200
// makes the step 200 and the limit three steps (600), so the button, the limit and the end can be tried with 480 made-up entries.
const capParam = DEMO ? Number(params.get("cap")) : 0;
const STEP = Number.isInteger(capParam) && capParam >= 1 ? capParam : READ_STEP;
const HELD_MAX = STEP === READ_STEP ? MAX_HELD : STEP * 3;
const LIMITS = { step: STEP, maxHeld: HELD_MAX };
const LIMIT_NOTE = searchLimitNote(STEP, HELD_MAX);
const COLUMNS = [["when", "When"], ["who", "Who"], ["section", "Section"], ["what", "What changed"], ["kind", "Kind of change"]];

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
  api: null, demo: null, orgName: "",
  choice: "by", // what to find for the picked person (the person itself is `filters.who.person`)
  entries: [], total: null, cov: null, ctx: null, cover: null, // what was read, and what it was asked for
  control: null, run: 0, reading: false, continuing: false, readQuery: null, readSig: "", // readQuery and readSig: what the entries held were asked for

  filters: emptyFilters(), base: [], baseKey: "", people: new Map(), counts: null, parsed: parseSearch(""),
  view: [], sort: { key: "when", dir: "desc" }, drawn: PAGE_ROWS, openSeq: null,
  facetFind: { section: "", kind: "", person: "" }, facetShow: { section: FACET_ROWS, kind: FACET_ROWS, person: FACET_ROWS },
};

function showError(msg, raw, boxSel = "#error") {
  const box = $(boxSel);
  box.hidden = !msg;
  box.replaceChildren();
  if (!msg) return;
  box.append(msg);
  if (raw) box.append(el("details", { class: "tech" }, el("summary", { text: "Technical details" }), el("div", { text: raw })));
}

const nf = (n) => Number(n).toLocaleString("en-US");
const hl = (text) => highlightParts(text, state.parsed).map((p) => (p.hit ? el("mark", { text: p.text }) : document.createTextNode(p.text)));
const focusKeys = (container) => [...container.querySelectorAll("[data-fk]")];

/**
 * Rebuild a part of the page and keep the keyboard on the same control (found by its data-fk), or on a sensible neighbour
 * (see chooseFocus), else on `fallback`. Does nothing special when the focus was not inside `container`.
 */
function keepFocus(container, rebuild, { prefer = null, fallback = null } = {}) {
  const a = document.activeElement;
  const had = a && a !== container && container.contains(a) && a.hasAttribute("data-fk");
  const before = had ? focusKeys(container).map((n) => n.getAttribute("data-fk")) : [];
  const key = had ? a.getAttribute("data-fk") : null;
  rebuild();
  if (!had) return;
  const nodes = focusKeys(container);
  const want = chooseFocus(before, nodes.map((n) => n.getAttribute("data-fk")), key, prefer);
  const target = (want !== null && nodes.find((n) => n.getAttribute("data-fk") === want)) || fallback;
  if (target && !target.hidden) target.focus({ preventScroll: true });
}

const searchedInMemory = () => !!state.filters.who && state.filters.who.choice !== "by";
const periodSig = () => `${$("#period").value}|${$("#period").value === "dates" ? `${$("#dateFrom").value}|${$("#dateTo").value}` : ""}`;

// ---------- the read ----------

function periodNow() {
  return periodBounds($("#period").value, new Date(), { from: $("#dateFrom").value, to: $("#dateTo").value });
}

function setBusy(on) {
  state.reading = on;
  $("#stop").hidden = !on;
  $("#stop").disabled = false;
}

async function readNow() {
  const bounds = periodNow();
  if (!bounds.ok) { showError(bounds.error); return; }
  if (!state.api) return;
  showError("");
  showError("", "", "#personError");
  if (state.control) state.control.cancel = true; // an older read still running is dropped: its pages never mix in
  const token = ++state.run;
  const control = { stop: false, cancel: false };
  state.control = control;
  state.entries = [];
  state.total = null;
  state.cov = null;
  state.openSeq = null;
  state.drawn = PAGE_ROWS;
  state.baseKey = "";
  state.continuing = false;
  state.readSig = periodSig();
  const asked = readFor(state.filters.who);
  state.cover = asked.cover;
  state.ctx = { periodDetail: bounds.detail, tz: TZ };
  $("#results").hidden = false;
  $("#readLine").textContent = `${bounds.detail}. ${asked.cover.kind === "by" ? `Read: entries made by ${personWords(state.filters.who.person)}, and entries that have them as the delegate user.` : "Read: every entry in the period."} Times are in ${TZ}.`;
  setBusy(true);
  $("#progress").textContent = "Counting the entries...";
  refilter();
  const query = { from: bounds.from, to: bounds.to, userId: asked.userId, delegateUser: asked.delegateUser };
  state.readQuery = query;
  let result;
  try {
    result = await readAuditTrail(state.api, query, {
      control, max: STEP,
      onTotal: (t) => { if (token === state.run) { state.total = t; $("#progress").textContent = progressText(0, t); } },
      onPage: (batch, n) => {
        if (token !== state.run) return;
        for (let i = 0; i < batch.length; i++) state.entries.push(batch[i]);
        $("#progress").textContent = progressText(n, state.total);
        scheduleRefilter();
      },
    });
  } catch (e) {
    if (token !== state.run) return;
    result = { status: "failed", read: state.entries.length, total: state.total, problem: plainProblem(e) };
  }
  if (token !== state.run || result.status === "cancelled") return;
  const hadStop = document.activeElement === $("#stop");
  setBusy(false);
  $("#progress").textContent = "";
  clearTimeout(refreshTimer);
  refreshTimer = null;
  state.cov = buildCoverage({ status: result.status, read: state.entries.length, total: result.total, oldestMs: timeSpan(state.entries).min }, LIMITS);
  if (result.problem) showError(result.problem.message, result.problem.raw);
  if (result.status === "failed" && state.entries.length === 0) { // nothing was read: only the error shows, and no older list stays on screen
    state.cov = null;
    state.cover = null;
    $("#results").hidden = true;
    return;
  }
  refilter();
  if (hadStop) focusAfterStop();
}

/** Stop went away with the keyboard on it: go to the button that reads older entries, else to the status line. */
function focusAfterStop() {
  const older = $("#readOlder");
  (!older.closest("[hidden]") && !$("#older").hidden ? older : $("#status")).focus({ preventScroll: true });
}

/**
 * "Read older entries": continues the SAME read (the period, person and choice it was asked with, kept in `state.readQuery`)
 * with the same WHERE plus CreatedDate <= the oldest second held. Entries already held from that second are dropped by Id.
 * It is refused when the period shown in the boxes is no longer the one that was read.
 */
async function readOlder() {
  if (state.reading || !state.cov || !state.cov.canMore || !state.api || !state.readQuery) return;
  const room = Math.min(STEP, HELD_MAX - state.entries.length);
  if (room <= 0) { drawOlder(); return; }
  if (periodSig() !== state.readSig || !coverageFits(state.cover, state.filters.who)) { drawOlder(); return; } // never continue a read that is not the one on screen
  const start = continuationStart(state.entries);
  if (!start) return;
  showError("");
  const hadFocus = document.activeElement === $("#readOlder");
  const token = ++state.run;
  const control = { stop: false, cancel: false };
  state.control = control;
  state.continuing = true;
  setBusy(true);
  $("#progress").textContent = olderProgressText(state.entries.length, state.total);
  refilter();
  if (hadFocus) $("#stop").focus({ preventScroll: true }); // the button is hidden while it reads
  let result;
  try {
    result = await readAuditTrail(state.api, { ...state.readQuery, olderOrEqualMs: start.oldestMs }, {
      control, max: room,
      continuation: { total: state.total, held: state.entries.length, skipIds: start.skipIds, seqStart: state.entries.length },
      onPage: (batch) => {
        if (token !== state.run) return;
        for (let i = 0; i < batch.length; i++) state.entries.push(batch[i]);
        $("#progress").textContent = olderProgressText(state.entries.length, state.total);
        scheduleRefilter();
      },
    });
  } catch (e) {
    if (token !== state.run) return;
    result = { status: "failed", read: 0, total: state.total, problem: plainProblem(e) };
  }
  if (token !== state.run || result.status === "cancelled") return;
  const hadStop = document.activeElement === $("#stop");
  state.continuing = false;
  setBusy(false);
  $("#progress").textContent = "";
  clearTimeout(refreshTimer);
  refreshTimer = null;
  // What was read before stays; the coverage is the whole of it: everything held, back to the oldest entry now held.
  state.cov = buildCoverage({ status: result.status, read: state.entries.length, total: state.total, oldestMs: timeSpan(state.entries).min }, LIMITS);
  if (result.problem) showError(result.problem.message, result.problem.raw);
  refilter();
  if (hadStop) focusAfterStop();
}

/** The button that reads older entries, or the words that say why not. Shown only for a read that can continue. */
function drawOlder() {
  const box = $("#older");
  const cov = state.cov;
  const can = !state.reading && !!cov && cov.canMore;
  const same = periodSig() === state.readSig;
  box.hidden = !can;
  $("#readOlder").hidden = !can || !same;
  $("#olderNote").textContent = can && !same ? OLDER_STALE_TEXT : "";
  if (can && same) $("#readOlder").textContent = olderLabel(cov);
}

let refreshTimer = null;
let lastRefilterMs = 0;
function scheduleRefilter() {
  if (refreshTimer) return;
  // With many entries a redraw takes longer: wait a few times as long, so typing and clicking stay responsive while entries arrive.
  refreshTimer = setTimeout(() => { refreshTimer = null; refilter(); }, Math.max(REFRESH_MS, lastRefilterMs * 3));
}

// ---------- filtering and drawing ----------

const whoKey = (w) => (w ? `${w.choice}|${w.person.id}|${w.person.username || ""}|${w.person.email || ""}|${w.person.name || ""}` : "");

/** Run the person, the search and the lists over what was read, sort, and draw. Nothing is asked of the org. */
function refilter() {
  const who = state.filters.who;
  const fits = coverageFits(state.cover, who);
  $("#stale").hidden = fits;
  $("#stale").textContent = fits ? "" : STALE_TEXT;
  $("#resultBody").hidden = !fits;
  if (!fits) { drawChips(); return; } // never show the old list under a label it does not match
  const t0 = performance.now();
  const key = `${state.entries.length}|${whoKey(who)}`;
  if (state.baseKey !== key) {
    state.base = personView(state.entries, who);
    state.baseKey = key;
    state.people = buildPeople(state.base);
  }
  state.parsed = parseSearch(state.filters.search);
  const res = runFilters(state.base, state.filters);
  state.counts = res.counts;
  state.view = state.sort.key === "when" && state.sort.dir === "desc" ? res.shown : sortEntries(res.shown, state.sort.key, state.sort.dir);
  drawAll();
  lastRefilterMs = performance.now() - t0;
}

function drawAll() {
  drawPartial();
  drawChips();
  drawFacets();
  drawStatus();
  drawTable();
}

/** The coverage with "more can be read" taken away when the period in the boxes is no longer the one that was read (the button is not offered then). */
function coverageShown() {
  const c = state.cov;
  return c && c.canMore && periodSig() !== state.readSig ? { ...c, canMore: false } : c;
}

function drawPartial() {
  const mem = $("#memNote");
  mem.hidden = !searchedInMemory();
  mem.textContent = searchedInMemory() ? LIMIT_NOTE : "";
  // While older entries are read the list is still only part of the period: say so with the numbers so far.
  let cov = state.cov && state.continuing ? { ...state.cov, status: "continuing", read: state.entries.length, total: state.total, oldestMs: timeSpan(state.entries).min } : state.cov;
  if (cov && cov.canMore && periodSig() !== state.readSig) cov = { ...cov, canMore: false };
  const note = cov ? partialNote({ ...cov, searched: searchedInMemory() }, TZ, { onPage: true }) : null;
  const box = $("#partial");
  box.hidden = !note;
  box.textContent = note || "";
  drawOlder();
}

function drawStatus() {
  const n = state.entries.length;
  const status = $("#status");
  const who = state.filters.who;
  const about = who ? matchCounts(state.base) : null;
  if (state.reading) status.textContent = readingStatusLine(state.view.length, who ? 0 : n, about);
  else if (state.cov) status.textContent = statusLine(state.view.length, n, coverageShown(), about, TZ);
  else status.textContent = "";
  $("#clear").hidden = !hasFilters(state.filters);
  const empty = $("#empty");
  const none = !state.reading && state.cov && state.view.length === 0;
  empty.hidden = !none;
  if (none) empty.textContent = emptyText({ read: n, partial: state.cov.status !== "complete", filtered: hasFilters(state.filters), person: who ? personWords(who.person) : "", baseCount: state.base.length, baseSplit: who ? matchBreakdown(matchCounts(state.base)) : "", cover: coverageWords(coverageShown(), TZ) });
}

function drawChips() {
  const chips = filterChips(state.filters, state.people);
  const box = $("#chips");
  box.hidden = chips.length === 0;
  keepFocus(box, () => box.replaceChildren(...chips.map((c) => el("button", { type: "button", "data-fk": `chip:${c.text}`, title: "Remove this filter", "aria-label": `Remove filter: ${c.text}`, text: c.text, onclick: () => { removeChip(state.filters, c.remove); syncControls(); state.drawn = PAGE_ROWS; refilter(); } }))), { fallback: $("#search") });
}

/** The boxes follow `state.filters` (after a chip or Clear filters changed it). */
function syncControls() {
  $("#search").value = state.filters.search;
  $("#delegateOnly").checked = state.filters.delegateOnly;
  $("#packageOnly").checked = state.filters.packageOnly;
  syncWho(true);
}

// ----- the three lists -----

const facetBox = (name) => $(`details.facet[data-facet="${name}"]`);

function initFacets() {
  for (const name of FACETS) {
    const box = facetBox(name);
    const body = $(".fbody", box);
    const find = el("input", { type: "search", placeholder: `Search ${FACET_TITLES[name].toLowerCase()}`, "aria-label": `Search the ${FACET_TITLES[name].toLowerCase()} list`, autocomplete: "off" });
    find.addEventListener("input", () => { state.facetFind[name] = find.value; state.facetShow[name] = FACET_ROWS; drawFacet(name); });
    body.append(find, el("ul", { class: "opts" }), el("div", { class: "foot" }));
    if (name === "person") body.prepend(el("p", { class: "hint", text: PERSON_FACET_HINT }));
    box.addEventListener("toggle", () => { if (box.open) drawFacet(name); });
  }
}

function drawFacets() {
  for (const name of FACETS) {
    const n = state.counts ? state.counts[name].size : 0;
    const f = state.filters[name];
    const chosen = f.inc.size + f.exc.size;
    $(`#fn-${name}`).textContent = state.entries.length ? `${nf(n)} ${n === 1 ? "choice" : "choices"}${chosen ? `, ${chosen} chosen` : ""}` : "";
    if (facetBox(name).open) drawFacet(name);
  }
}

function drawFacet(name, firstNew = -1) {
  if (!state.counts) return;
  const body = $(".fbody", facetBox(name));
  const ul = $("ul.opts", body);
  const keep = ul.scrollTop;
  const all = facetOptions(name, state.counts, state.filters, state.people, state.facetFind[name]);
  const shown = all.slice(0, state.facetShow[name]);
  const optKey = (o) => `f:${name}:c:${o.key}`;
  const lis = shown.map((o) => {
    const code = name === "kind" ? o.key : name === "person" ? state.people.get(o.key)?.username || o.key : "";
    const hidden = o.state === "exclude";
    return el("li", { class: o.state },
      el("label", {},
        el("input", { type: "checkbox", "data-fk": optKey(o), checked: o.state === "include", "aria-label": `Only show ${o.label}`, onchange: () => { toggleChoice(state.filters, name, "include", o.key); refilter(); } }),
        el("span", { class: "lab", text: o.label }),
        code && code !== o.label ? el("span", { class: "code", text: code }) : null),
      el("span", { class: "cnt", text: nf(o.count) }),
      el("button", { type: "button", "data-fk": `f:${name}:h:${o.key}`, "aria-label": `${hidden ? "Show again" : "Hide"}: ${o.label}`, text: hidden ? "Show again" : "Hide", onclick: () => { toggleChoice(state.filters, name, "exclude", o.key); refilter(); } }));
  });
  if (!lis.length) lis.push(el("li", {}, el("span", { class: "none", text: state.entries.length ? "Nothing matches." : "Nothing read yet." })));
  const foot = $(".foot", body);
  const prefer = firstNew >= 0 && all[firstNew] ? optKey(all[firstNew]) : null; // after "Show more", the first option it added
  keepFocus(body, () => {
    ul.replaceChildren(...lis);
    ul.scrollTop = keep;
    foot.replaceChildren(...(all.length > shown.length
      ? [el("button", { type: "button", "data-fk": `f:${name}:more`, text: `Show ${FACET_ROWS} more (${nf(all.length - shown.length)} left)`, onclick: () => { const was = state.facetShow[name]; state.facetShow[name] += FACET_ROWS; drawFacet(name, was); } })]
      : []));
  }, { prefer, fallback: $("input[type=search]", body) });
}

// ----- the table -----

function drawHead() {
  $("#headRow").replaceChildren(...COLUMNS.map(([key, label]) => {
    const on = state.sort.key === key;
    return el("th", { "aria-sort": on ? (state.sort.dir === "desc" ? "descending" : "ascending") : "none" },
      el("button", {
        type: "button", class: "sorthead", "data-key": key, title: "Click to sort; click again to reverse",
        onclick: () => {
          state.sort = on ? { key, dir: state.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "when" ? "desc" : "asc" };
          drawHead();
          refilter();
          $(`button.sorthead[data-key="${key}"]`)?.focus();
        },
      }, label, on
        ? el("span", { class: "sortarrow", "aria-hidden": "true", text: state.sort.dir === "desc" ? "▼" : "▲" })
        : el("span", { class: "sortarrow neutral", "aria-hidden": "true" }, el("span", { text: "▲" }), el("span", { text: "▼" }))));
  }));
}

const personLabel = (e) => (e.userId ? state.people.get(e.userId)?.label || whoLabel(e) : NO_USER);

function drawTable(firstNew = -1) {
  const table = $("#table");
  const list = state.view;
  table.hidden = list.length === 0;
  const body = $("#rows");
  const n = Math.min(list.length, state.drawn);
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const e = list[i];
    nodes.push(entryRow(e));
    if (e.seq === state.openSeq) nodes.push(detailRow(e));
  }
  const more = $("#more");
  const moreHadFocus = document.activeElement === more;
  const prefer = firstNew >= 0 && list[firstNew] ? `r:${list[firstNew].seq}:when` : null; // after "Show more", the first row it added
  keepFocus(body, () => body.replaceChildren(...nodes), { prefer, fallback: $("#status") });
  more.hidden = list.length <= n;
  more.textContent = `Show ${PAGE_ROWS} more (${nf(list.length - n)} left)`;
  if (moreHadFocus && more.hidden && prefer) $(`#rows [data-fk="${prefer}"]`)?.focus({ preventScroll: true }); // the button went away: go to the first new row
}

function entryRow(e) {
  const long = e.display.length > CLIP_OVER;
  const what = el("td", { class: `what${long ? " clip" : ""}`, "data-label": "What changed" }, el("span", { class: "txt" }, hl(e.display)),
    e.how && e.nameOnly ? el("span", { class: "sub how", text: e.how }) : null);
  if (long) {
    const b = el("button", { type: "button", class: "link", text: "Show all", "data-fk": `r:${e.seq}:all`, onclick: (ev) => { ev.stopPropagation(); const c = what.classList.toggle("clip"); b.textContent = c ? "Show all" : "Show less"; } });
    what.append(b);
  }
  const open = () => { state.openSeq = state.openSeq === e.seq ? null : e.seq; drawTable(); };
  return el("tr", { class: `entry${e.seq === state.openSeq ? " open" : ""}`, onclick: open },
    el("td", { class: "when", "data-label": "When" }, el("button", { type: "button", class: "link", "data-fk": `r:${e.seq}:when`, "aria-expanded": String(e.seq === state.openSeq), text: formatLocal(e.ms), onclick: (ev) => { ev.stopPropagation(); open(); } })),
    el("td", { "data-label": "Who" },
      hl(personLabel(e)),
      e.delegate ? el("span", { class: "sub delegate", text: `Delegate user: ${e.delegate}` }) : null,
      e.viaDelegate ? el("span", { class: "tag-delegate", text: "As delegate (for example through Login-As)" }) : null),
    el("td", { "data-label": "Section" }, e.section ? hl(e.section) : el("span", { class: "sub", text: NO_SECTION })),
    what,
    el("td", { class: "kind", "data-label": "Kind of change" },
      el("span", { class: "kname" }, hl(e.kind)),
      e.action ? el("span", { class: "code", text: e.action }) : null,
      el("button", { type: "button", "data-fk": `r:${e.seq}:hide`, text: "Hide this kind", "aria-label": `Hide this kind: ${e.kind}`, onclick: (ev) => { ev.stopPropagation(); toggleChoice(state.filters, "kind", "exclude", e.action); refilter(); } })));
}

function fact(label, value) {
  return value ? [el("dt", { text: label }), el("dd", { text: value })] : [];
}

function detailRow(e) {
  const status = el("span", { class: "copied-row", role: "status" });
  const fb = el("div", { hidden: true });
  const copy = async () => {
    const text = ticketText(e, { orgName: state.orgName, tz: TZ });
    const { copied } = await copyWithFallback(text, navigator.clipboard);
    status.textContent = copied ? "Copied. Paste it into your ticket." : "";
    showFallback(fb, text, !copied);
  };
  return el("tr", { class: "detailrow" }, el("td", { colspan: "5", class: "detail" },
    el("dl", { class: "facts" },
      fact("When (your time)", `${formatLocal(e.ms)} (${TZ})`), fact("When (UTC)", formatUtc(e.ms)),
      fact(e.delegate ? "Recorded maker" : "Who", whoLabel(e)), fact("Maker's username", e.username), fact("Maker's user Id", e.userId),
      fact("Section", e.section || NO_SECTION), fact("Kind of change", e.kind), fact("Kind code", e.action),
      fact("What changed", e.display), fact("Delegate user", e.delegate), fact("How it matched", e.how), fact("Source namespace prefix", e.namespace)),
    el("div", { class: "btns" },
      el("button", { type: "button", "data-fk": `r:${e.seq}:d:copy`, class: "primary", text: "Copy for a ticket", onclick: copy }),
      e.action ? el("button", { type: "button", "data-fk": `r:${e.seq}:d:only`, text: "Only this kind", onclick: () => { toggleChoice(state.filters, "kind", "only", e.action); refilter(); } }) : null,
      e.action ? el("button", { type: "button", "data-fk": `r:${e.seq}:d:hide`, text: "Hide this kind", onclick: () => { toggleChoice(state.filters, "kind", "exclude", e.action); refilter(); } }) : null,
      el("button", { type: "button", "data-fk": `r:${e.seq}:d:person`, text: "Only this person", onclick: () => { toggleChoice(state.filters, "person", "only", e.userId); refilter(); } }),
      status),
    fb));
}

// ---------- copy and download ----------

function showFallback(box, text, on) {
  box.hidden = !on;
  box.replaceChildren();
  if (!on) return;
  const ta = el("textarea", { rows: "8", readonly: true, spellcheck: "false", "aria-label": "Text to copy" });
  ta.value = text;
  ta.style.width = "100%";
  box.append(el("p", { class: "hint", text: "Your browser did not allow copying. Select all and copy it yourself." }), ta);
  ta.focus();
  ta.select();
}

/** What an export says about how much was read. A read still running is "reading" (partial), never "complete"; no coverage at all and no read running means there is nothing to export. */
function coverageNow() {
  if (state.reading) return { status: "reading", read: state.entries.length, total: state.total, oldestMs: timeSpan(state.entries).min, cap: STEP, maxHeld: HELD_MAX };
  return state.cov;
}

const context = () => ({ ...state.ctx, who: state.filters.who, filters: state.filters, people: state.people, cov: { ...coverageNow(), searched: searchedInMemory() } });

/** An export is made from what is on screen right now: while entries still arrive the list is brought up to date first, so the file and its counts agree. */
function exportReady() {
  if (!state.ctx || (!state.reading && !state.cov)) return false;
  if (state.reading) { clearTimeout(refreshTimer); refreshTimer = null; refilter(); }
  return coverageFits(state.cover, state.filters.who);
}

$("#copyShown").addEventListener("click", async () => {
  if (!exportReady()) return;
  const text = shownText(state.view, context());
  const { copied } = await copyWithFallback(text, navigator.clipboard);
  $("#copied").textContent = copied ? "Copied. Paste it into your ticket." : "";
  showFallback($("#copyFallback"), text, !copied);
});

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("#csv").addEventListener("click", () => {
  if (!exportReady()) return;
  download(`setup_audit_trail_${stamp()}.csv`, toCsv(csvRows(state.view, context())), "text/csv");
});

// ---------- the boxes ----------

let typing = null;
$("#search").addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(() => { state.filters.search = $("#search").value; state.drawn = PAGE_ROWS; refilter(); }, DEBOUNCE_MS);
});
$("#delegateOnly").addEventListener("change", () => { state.filters.delegateOnly = $("#delegateOnly").checked; state.drawn = PAGE_ROWS; refilter(); });
$("#packageOnly").addEventListener("change", () => { state.filters.packageOnly = $("#packageOnly").checked; state.drawn = PAGE_ROWS; refilter(); });
$("#showApi").addEventListener("change", () => $("#results").classList.toggle("showapi", $("#showApi").checked));
$("#clear").addEventListener("click", () => { clearFilters(state.filters); syncControls(); state.drawn = PAGE_ROWS; refilter(); $("#search").focus({ preventScroll: true }); }); // the button hides itself, so the keyboard goes to the search box
$("#more").addEventListener("click", () => { const was = Math.min(state.view.length, state.drawn); state.drawn += PAGE_ROWS; drawTable(was); });
$("#status").setAttribute("tabindex", "-1"); // the place the keyboard lands when the control it was on is gone
$("#read").addEventListener("click", readNow);
$("#readOlder").addEventListener("click", readOlder);
for (const id of ["period", "dateFrom", "dateTo"]) $(`#${id}`).addEventListener("change", () => { if (state.cov && !state.reading && coverageFits(state.cover, state.filters.who)) { drawPartial(); drawStatus(); } });
$("#stop").addEventListener("click", () => { if (state.control) state.control.stop = true; $("#stop").disabled = true; $("#progress").textContent = "Stopping after this page..."; });

$("#period").replaceChildren(...PERIODS.map((p) => el("option", { value: p.value, text: p.label })));
$("#period").value = DEFAULT_PERIOD;
$("#period").addEventListener("change", () => {
  const dates = $("#period").value === "dates";
  $("#datesBox").hidden = !dates;
  $("#datesBox2").hidden = !dates;
  if (dates && !$("#dateTo").value) {
    const d = new Date();
    const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
    $("#dateTo").value = iso(d);
    d.setDate(d.getDate() - 7);
    $("#dateFrom").value = iso(d);
  }
});
$("#tzName").textContent = TZ;
$("#searchHint").textContent = SEARCH_HINT;
initFacets();
drawHead();

// ---------- the person picker ----------

/** Show or hide "What to find", and (when `text`) put the picked person's words back in the box. */
function syncWho(text) {
  const who = state.filters.who;
  $("#choiceBox").hidden = !who;
  $("#choiceHint").hidden = !who;
  if (who) {
    state.choice = who.choice;
    $("#choice").value = who.choice;
    $("#choiceHint").textContent = who.choice === "by"
      ? "Salesforce looks for them in the whole period. It also finds entries where they are the delegate user (for example an administrator using Login-As), and marks those. An entry counts as a delegate entry when its Delegate User field holds their username."
      : LIMIT_NOTE;
  }
  if (text) $("#personInput").value = who ? personWords(who.person) : "";
}

function setPerson(p) {
  state.filters.who = p ? { person: p, choice: state.choice } : null;
  state.drawn = PAGE_ROWS;
  syncWho(true);
  if (state.cov || state.reading) refilter();
}

$("#choice").replaceChildren(...CHOICES.map((c) => el("option", { value: c, text: CHOICE_LABELS[c] })));
$("#choice").addEventListener("change", () => {
  state.choice = $("#choice").value;
  if (state.filters.who) state.filters.who = { person: state.filters.who.person, choice: state.choice };
  state.drawn = PAGE_ROWS;
  syncWho(false);
  if (state.cov || state.reading) refilter();
});

{
  const input = $("#personInput");
  const list = $("#personList");
  let seq = 0;
  let timer = null;
  let items = [];
  let active = -1;
  const message = (m) => { items = []; active = -1; list.replaceChildren(el("li", { class: "none", text: m })); list.hidden = false; input.setAttribute("aria-expanded", "true"); };
  const close = () => { clearTimeout(timer); seq++; list.hidden = true; input.setAttribute("aria-expanded", "false"); };
  const restore = () => { input.value = state.filters.who ? personWords(state.filters.who.person) : ""; };
  const choose = (u) => { setPerson({ id: u.id, name: u.name || "", username: u.username || "", email: u.email || "" }); close(); };
  const mark = (i) => { active = i; [...list.querySelectorAll("li[role=option]")].forEach((li, j) => li.setAttribute("aria-selected", String(j === i))); };
  async function search() {
    const text = input.value.trim();
    const mine = ++seq;
    if (text.length < (DEMO ? 1 : 2)) { message("Type at least 2 letters."); return; }
    message("Searching...");
    try {
      const r = DEMO ? matchUsers(state.demo.users, text, 50, { emailAndId: true }) : await searchUsers(state.api, text, 50, { emailAndId: true });
      if (mine !== seq) return;
      showError("", "", "#personError");
      items = r.users.slice();
      const pasted = pastedUserId(text);
      if (pasted && !items.some((u) => id15(u.id) === id15(pasted))) items.push({ id: pasted, name: "", username: "", email: "", idOnly: true });
      active = items.length ? 0 : -1;
      const lis = items.map((u, i) => el("li", { role: "option", "aria-selected": String(i === 0), onmousedown: (e) => { e.preventDefault(); choose(u); }, onmousemove: () => mark(i) },
        el("span", { class: "nm", text: u.idOnly ? `Use this Id as the person: ${u.id}` : u.name }),
        u.idOnly || u.isActive ? null : el("span", { class: "tag-inactive", text: "Inactive" }),
        el("span", { class: "dev plain", text: u.idOnly ? "No user with this Id can be read, but entries can still carry it" : [u.username, u.email && u.email !== u.username ? u.email : ""].filter(Boolean).join(" · ") })));
      if (!lis.length) lis.push(el("li", { class: "none", text: "No user found. Try a different part of the name, username or email, or paste a user Id." }));
      if (r.more) lis.push(el("li", { class: "none", text: "Showing the first matches. Keep typing to narrow the list." }));
      list.replaceChildren(...lis);
      list.hidden = false;
    } catch (e) {
      if (mine !== seq) return;
      message("The search did not work.");
      const p = plainUserSearchProblem(e);
      showError(p.message, p.raw, "#personError"); // results already on screen stay as they are
    }
  }
  // Typing over the box does not change the picked person until another one is chosen or the box is emptied and left.
  input.addEventListener("input", () => { clearTimeout(timer); if (!input.value.trim()) { close(); return; } message("Searching..."); timer = setTimeout(search, DEMO ? 0 : 300); });
  input.addEventListener("blur", () => { close(); if (!input.value.trim() && state.filters.who) setPerson(null); else restore(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && items.length) { mark(Math.min(active + 1, items.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp" && items.length) { mark(Math.max(active - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter" && !list.hidden && active >= 0) { choose(items[active]); e.preventDefault(); }
    else if (e.key === "Enter" && list.hidden) readNow();
    else if (e.key === "Escape") { close(); restore(); }
  });
}

// ---------- connecting ----------

async function start() {
  if (DEMO) {
    state.demo = await (await fetch("../../samples/audit_trail_demo.json")).json();
    state.orgName = state.demo.org?.name || "Demo org";
    state.api = demoApi(demoRecords(state.demo, new Date()), { pageSize: 40, delayMs: 150 }); // small pages and a short wait, so Stop can be tried
    $("#org").replaceChildren(el("span", { class: "badge demo", text: "DEMO" }), " Made-up audit trail, no org connected");
    $("#demoHints").hidden = false;
    $("#demoHintList").replaceChildren(...state.demo.hints.map((h) => el("li", { text: h })), ...(STEP !== READ_STEP ? [el("li", { text: `This demo reads ${STEP} entries at a time and holds at most ${HELD_MAX} (the address has cap=${STEP}), so you can try "Read older entries".` })] : []));
    return;
  }
  let session;
  try {
    if (DEV) {
      session = { apiHost: location.host, sessionId: "dev", base: `${location.origin}/sf` };
    } else if (HOST && typeof chrome !== "undefined" && chrome.cookies) {
      $("#org").textContent = `Connecting to ${HOST}...`;
      session = await findSession(HOST, chrome.cookies);
    } else {
      $("#org").textContent = "No org connected. Open this page from the Salesforce Capability Pack button on a Salesforce tab.";
      $("#read").disabled = true;
      return;
    }
  } catch (e) {
    $("#org").textContent = `Could not connect${HOST ? " to " + HOST : ""}.`;
    $("#read").disabled = true;
    showError(e?.status === 401 || /session/i.test(e?.message || "") ? e.message : "Could not connect to the org. If you have been away a while, reload the Salesforce tab and try again.", e?.message);
    return;
  }
  state.api = new SfApi(session);
  const host = DEV ? (HOST || "") : (HOST || session.apiHost);
  $("#org").textContent = DEV ? "Local dev server" : host;
  try {
    const org = await readOrg(state.api, host);
    state.orgName = org.name || host;
    $("#org").replaceChildren(el("strong", { text: org.name || host }), " ", el("span", { class: `badge ${org.isSandbox ? "sbx" : "prod"}`, text: org.isSandbox ? "Sandbox" : "Production" }));
  } catch { /* the header keeps the host */ }
}

start().catch((e) => showError("Something went wrong while starting.", e?.message || String(e)));
startLiveReload();

// Header links to GitHub's new-issue form. Only tool, extension version and browser go in the link.
{
  const version = versionText(manifestVersion, navigator);
  const link = (text, kind) => el("a", {
    href: issueUrl({ kind, tool: FEEDBACK_TOOLS.audit, version }), target: "_blank", rel: "noopener noreferrer", text,
  });
  $("#feedback").replaceChildren(link("Report a bug", "bug"), " · ", link("Suggest an improvement", "enhancement"));
}
