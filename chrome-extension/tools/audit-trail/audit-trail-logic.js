// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Search the Setup Audit Trail: pure logic (no browser, no network). The period bounds, the entries, the search
// words, the three pick lists with their counts, sorting, the honest "this is only part of it" wording, the copy
// text, the CSV rows and a fake org for demo mode. Every loop is a plain loop: 50,000 entries must stay quick.

import { isSalesforceId } from "../../shared/users-logic.js";

export const PERIODS = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "Everything Salesforce keeps (about 180 days)" },
  { value: "dates", label: "Choose dates" },
];
export const DEFAULT_PERIOD = "7d";
export const NO_SECTION = "No section recorded";
export const NO_KIND = "No kind recorded";
export const NO_USER = "No user recorded";
export const HIDDEN_USER = "A user you can't see";
export const PAGE_ROWS = 200;
export const COPY_LIMIT = 100;
export const READ_STEP = 50000; // one read keeps at most this many entries (the newest); "Read older entries" reads the next ones
export const MAX_HELD = 250000; // the most entries the page holds in memory, all reads together
export const SEARCH_HINT = 'Type words in any order. Use "quotes" for an exact phrase and a minus sign to leave something out, for example -login.';

const pad = (n, w = 2) => String(n).padStart(w, "0");
const nf = (n) => Number(n).toLocaleString("en-US");

/** A 15 or 18 character Salesforce Id (letters and digits only): the only kind of value that goes into a query. */
export const isUserId = (id) => typeof id === "string" && /^[A-Za-z0-9]{15,18}$/.test(id);

// ---------- time ----------

/** The browser's time zone name, for example "America/New_York". */
export function timeZoneName() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"; } catch { return "local time"; }
}

/** "2026-11-25T19:03:07Z": the form a SOQL date-time literal takes (no quotes, no milliseconds). */
export function soqlDate(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const formatters = new Map();
/** "2026-11-25 14:03:07" in time zone `tz` (the browser's own when omitted). */
export function formatLocal(ms, tz) {
  if (!Number.isFinite(ms)) return "Not recorded";
  const key = tz || "";
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { ...(tz ? { timeZone: tz } : {}), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(key, f);
  }
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** "2026-11-25 19:03:07 UTC". */
export function formatUtc(ms) {
  if (!Number.isFinite(ms)) return "Not recorded";
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/** Salesforce writes "2026-11-25T19:03:07.000+0000". Returns milliseconds, or null when it cannot be read. */
export function parseSfDate(s) {
  if (typeof s !== "string" || !s) return null;
  const ms = Date.parse(s.replace(/([+-])(\d{2})(\d{2})$/, "$1$2:$3"));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The period as dates. `now` is a Date; `range` is {from, to} as "YYYY-MM-DD" (local days, "to" included) for "dates".
 * Returns {ok, from, to, label, detail, error}: `from` is the first moment included, `to` the first moment NOT included
 * (null = up to now); null `from` = no start. The days are the person's own days (local midnight), so across a
 * daylight-saving change a day can be 23 or 25 hours long; the query carries the exact UTC moments.
 */
export function periodBounds(period, now, range = {}) {
  const known = PERIODS.find((p) => p.value === period);
  if (!known) return { ok: false, error: "Choose a period." };
  const label = known.label;
  if (period === "all") return { ok: true, from: null, to: null, label, detail: "Everything Salesforce keeps (about 180 days)" };
  if (period === "dates") {
    const day = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "")); return m ? [Number(m[1]), Number(m[2]) - 1, Number(m[3])] : null; };
    const a = day(range.from);
    const b = day(range.to);
    if (!a || !b) return { ok: false, error: "Choose both a first and a last day." };
    const from = new Date(a[0], a[1], a[2]);
    const to = new Date(b[0], b[1], b[2] + 1);
    if (!(from.getTime() < to.getTime())) return { ok: false, error: "The last day must not be before the first day." };
    return { ok: true, from, to, label, detail: `From ${range.from} to ${range.to}, whole days in your time zone` };
  }
  const from = new Date(now.getTime());
  if (period === "24h") from.setTime(from.getTime() - 24 * 3600 * 1000);
  else from.setDate(from.getDate() - { "7d": 7, "30d": 30, "90d": 90 }[period]);
  return { ok: true, from, to: null, label, detail: `${label}, from ${formatLocal(from.getTime())} until now` };
}

// ---------- kinds ----------

/** "PermSetFlsChanged" -> "Perm Set Fls Changed". Only splits and capitalises; it explains nothing. */
export function kindLabel(code) {
  const s = String(code ?? "").trim();
  if (!s) return NO_KIND;
  return s
    .replace(/_+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // changedUser -> changed User, Oauth2App -> Oauth2 App
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // SSOLogin -> SSO Login
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(^| )([a-z])/g, (m, sp, c) => sp + c.toUpperCase());
}

// ---------- entries ----------

/** One SetupAuditTrail record as the page keeps it. `seq` is its place in Salesforce's own order (newest first). */
export function entryFromRecord(r, seq) {
  const userId = r.CreatedById || "";
  const userName = r.CreatedBy?.Name || "";
  const username = r.CreatedBy?.Username || "";
  const action = r.Action || "";
  const section = r.Section || "";
  const display = r.Display || "";
  const delegate = r.DelegateUser || "";
  const namespace = r.ResponsibleNamespacePrefix || "";
  const kind = kindLabel(action);
  return {
    seq, id: r.Id || "", action, kind, section, display, ms: parseSfDate(r.CreatedDate), userId, userName, username, delegate, namespace,
    hay: [display, section, action, kind, userName, username, userId, delegate, namespace].join("\n").toLowerCase(),
  };
}

// ---------- search ----------

/**
 * An Id typed in the search box also finds its other length. Only for Id-shaped text (an 18 character Id with at least
 * one digit and the right Salesforce checksum), so an ordinary word is left alone. Returns the lower-case other forms
 * to look for, or null. (A 15 character Id needs none: it is the start of its own 18 character form, and the search is
 * a plain substring search.)
 */
export function idAlternates(raw) {
  const s = String(raw || "");
  if (s.length === 18 && /\d/.test(s) && isSalesforceId(s)) return [s.slice(0, 15).toLowerCase()];
  return null;
}

/** Words and "quoted phrases" to find (`include`) and to leave out (`exclude`, a leading minus). All lower case.
 * `alts` (only present when an Id was typed) maps a term to the other forms of that Id. */
export function parseSearch(text) {
  let s = String(text ?? "");
  if ((s.match(/"/g) || []).length % 2 === 1) s += '"'; // an unfinished quote runs to the end
  const include = [];
  const exclude = [];
  let alts = null;
  const re = /(-?)"([^"]*)"|(-?)([^\s"]+)/g;
  let m;
  while ((m = re.exec(s))) {
    const neg = (m[1] ?? m[3]) === "-";
    const raw = (m[1] !== undefined && m[2] !== undefined ? m[2] : m[4]).trim();
    const term = raw.toLowerCase();
    if (!term || (term === "-" && !neg)) continue; // a lone minus sign is still being typed
    (neg ? exclude : include).push(term);
    const alt = idAlternates(raw);
    if (alt) { if (!alts) alts = new Map(); alts.set(term, alt); }
  }
  return alts ? { include, exclude, alts } : { include, exclude };
}

const termIn = (parsed, term, hay) => {
  if (hay.includes(term)) return true;
  const alt = parsed.alts?.get(term);
  if (alt) for (let i = 0; i < alt.length; i++) if (hay.includes(alt[i])) return true;
  return false;
};

/** True when the lower-case text has every word and none of the left-out ones. */
export function searchMatches(parsed, hay) {
  for (let i = 0; i < parsed.include.length; i++) if (!termIn(parsed, parsed.include[i], hay)) return false;
  for (let i = 0; i < parsed.exclude.length; i++) if (termIn(parsed, parsed.exclude[i], hay)) return false;
  return true;
}

/** Cut `text` into [{text, hit}] so the page can mark what was searched for (it builds nodes; never HTML). */
export function highlightParts(text, parsed) {
  const s = String(text ?? "");
  if (!parsed || !parsed.include.length || !s) return [{ text: s, hit: false }];
  const lower = s.toLowerCase();
  if (lower.length !== s.length) return [{ text: s, hit: false }]; // some letters change length in lower case: skip marking
  const ranges = [];
  const terms = [];
  for (const t of parsed.include) { terms.push(t); const a = parsed.alts?.get(t); if (a) for (const x of a) terms.push(x); }
  for (const term of terms) {
    let at = lower.indexOf(term);
    while (at !== -1 && ranges.length < 500) {
      ranges.push([at, at + term.length]);
      at = lower.indexOf(term, at + term.length);
    }
  }
  if (!ranges.length) return [{ text: s, hit: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0].slice()];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1]) { if (ranges[i][1] > last[1]) last[1] = ranges[i][1]; } else merged.push(ranges[i].slice());
  }
  const out = [];
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out.push({ text: s.slice(pos, a), hit: false });
    out.push({ text: s.slice(a, b), hit: true });
    pos = b;
  }
  if (pos < s.length) out.push({ text: s.slice(pos), hit: false });
  return out;
}

// ---------- the three pick lists ----------

export const FACETS = ["section", "kind", "person"];
export const FACET_TITLES = { section: "Section", kind: "Kind of change", person: "Person" };

export function emptyFilters() {
  const facet = () => ({ inc: new Set(), exc: new Set() });
  return { search: "", section: facet(), kind: facet(), person: facet(), delegateOnly: false, packageOnly: false, who: null };
}

/** "A user you can't see (005...)": the Id is recorded but Salesforce does not return that user to this page. */
export const hiddenLabel = (id) => `${HIDDEN_USER} (${id})`;

/** Who made the entry, as recorded: the name, else the Id with plain words, else "No user recorded" (only when there is no Id at all). */
export const whoLabel = (e) => e.userName || (e.userId ? hiddenLabel(e.userId) : NO_USER);

/** The people in these entries by Id: {id -> {id, name, username, label}}. Two people with one name are told apart by username. */
export function buildPeople(entries) {
  const people = new Map();
  const byName = new Map();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (people.has(e.userId)) continue;
    people.set(e.userId, { id: e.userId, name: e.userName, username: e.username, label: "" });
    const n = (e.userName || "").toLowerCase();
    byName.set(n, (byName.get(n) || 0) + 1);
  }
  for (const p of people.values()) {
    if (!p.id) p.label = NO_USER;
    else if (!p.name) p.label = hiddenLabel(p.id);
    else p.label = byName.get(p.name.toLowerCase()) > 1 && p.username ? `${p.name} (${p.username})` : p.name;
  }
  return people;
}

const keyOf = { section: (e) => e.section, kind: (e) => e.action, person: (e) => e.userId };
export const facetKey = (facet, e) => keyOf[facet](e);

/** The label of one pick-list option. */
export function optionLabel(facet, key, people) {
  if (facet === "section") return key || NO_SECTION;
  if (facet === "kind") return kindLabel(key);
  return people?.get(key)?.label || (key ? hiddenLabel(key) : NO_USER);
}

const passes = (f, key) => (f.inc.size === 0 || f.inc.has(key)) && !f.exc.has(key);

/**
 * Apply the search, the three lists and the two ticks. Returns {shown, counts}. `shown` keeps the order of `entries`.
 * `counts[facet]` is a Map key -> number of entries that pass everything EXCEPT that list, so each list shows what
 * choosing one of its options would give.
 */
export function runFilters(entries, filters) {
  const parsed = parseSearch(filters.search);
  const { section, kind, person } = filters;
  const counts = { section: new Map(), kind: new Map(), person: new Map() };
  const shown = [];
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!searchMatches(parsed, e.hay)) continue;
    if (filters.delegateOnly && !e.delegate) continue;
    if (filters.packageOnly && !e.namespace) continue;
    const a = passes(section, e.section);
    const b = passes(kind, e.action);
    const c = passes(person, e.userId);
    if (b && c) bump(counts.section, e.section);
    if (a && c) bump(counts.kind, e.action);
    if (a && b) bump(counts.person, e.userId);
    if (a && b && c) shown.push(e);
  }
  return { shown, counts };
}

/**
 * The options of one list: every key counted, plus every chosen key even at 0, with its label and state
 * ("include", "exclude" or ""). Newest-biggest first. `find` narrows by label (and code or username).
 */
export function facetOptions(facet, counts, filters, people, find = "") {
  const keys = new Set(counts[facet].keys());
  for (const k of filters[facet].inc) keys.add(k);
  for (const k of filters[facet].exc) keys.add(k);
  const words = String(find || "").toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const key of keys) {
    const label = optionLabel(facet, key, people);
    if (words.length) {
      const extra = facet === "kind" ? key : facet === "person" ? `${people?.get(key)?.username || ""} ${key}` : "";
      const hay = `${label} ${extra}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
    }
    out.push({ key, label, count: counts[facet].get(key) || 0, state: filters[facet].inc.has(key) ? "include" : filters[facet].exc.has(key) ? "exclude" : "" });
  }
  out.sort((x, y) => y.count - x.count || (x.label < y.label ? -1 : x.label > y.label ? 1 : 0));
  return out;
}

/** Change one option: mode "include", "exclude" (hide), or "only" (just this one). Choosing it again clears it. */
export function toggleChoice(filters, facet, mode, key) {
  const f = filters[facet];
  if (mode === "only") { f.inc = new Set([key]); f.exc.delete(key); return; }
  if (mode === "include") {
    if (f.inc.has(key)) f.inc.delete(key); else { f.inc.add(key); f.exc.delete(key); }
    return;
  }
  if (f.exc.has(key)) f.exc.delete(key); else { f.exc.add(key); f.inc.delete(key); }
}

export function hasFilters(filters) {
  return !!(filters.who || String(filters.search || "").trim() || filters.delegateOnly || filters.packageOnly || FACETS.some((x) => filters[x].inc.size || filters[x].exc.size));
}

/** The filters in use as short pieces for removable chips: [{text, remove: {type, facet?, mode?, key?}}]. */
export function filterChips(filters, people) {
  const chips = [];
  if (filters.who) chips.push({ text: `${CHOICE_LABELS[filters.who.choice]}: ${personWords(filters.who.person)}`, remove: { type: "who" } });
  if (String(filters.search || "").trim()) chips.push({ text: `Search: ${filters.search.trim()}`, remove: { type: "search" } });
  for (const facet of FACETS) {
    for (const key of filters[facet].inc) chips.push({ text: `${FACET_TITLES[facet]}: ${optionLabel(facet, key, people)}`, remove: { type: "choice", facet, mode: "include", key } });
    for (const key of filters[facet].exc) chips.push({ text: `Hiding ${FACET_TITLES[facet].toLowerCase()}: ${optionLabel(facet, key, people)}`, remove: { type: "choice", facet, mode: "exclude", key } });
  }
  if (filters.delegateOnly) chips.push({ text: "Only entries that have a delegate user", remove: { type: "delegate" } });
  if (filters.packageOnly) chips.push({ text: "Only changes from a managed package", remove: { type: "package" } });
  return chips;
}

export function removeChip(filters, remove) {
  if (remove.type === "who") filters.who = null;
  else if (remove.type === "search") filters.search = "";
  else if (remove.type === "delegate") filters.delegateOnly = false;
  else if (remove.type === "package") filters.packageOnly = false;
  else if (remove.type === "choice") toggleChoice(filters, remove.facet, remove.mode, remove.key);
}

export function clearFilters(filters) {
  const fresh = emptyFilters();
  for (const k of Object.keys(fresh)) filters[k] = fresh[k];
}

// ---------- the person: made by them, made to them ----------

export const CHOICES = ["by", "to", "either"];
export const CHOICE_LABELS = { by: "Changes made by them", to: "Changes made to them", either: "Either" };
export const HOW_MAKER = "Made by them";
export const HOW_DELEGATE = "As delegate (for example through Login-As)";
export const HOW_NAME_ONLY = "Matched by name only: may be another person with this name";
export const HOW_NAME_ALSO = "their name is also in the text";
const HOW_TO = { id: "Matched by their Id", username: "Matched by their username", email: "Matched by their email", name: HOW_NAME_ONLY };
export const STALE_TEXT = "The entries read do not answer this choice. Press Show the audit trail to read again.";
/** Words for "Changes made to them" / "Either": only the entries read are searched, and how many that can be. */
export const searchLimitNote = (step = READ_STEP, maxHeld = MAX_HELD) => `Salesforce cannot narrow by who was changed, so this searches only the entries read (the newest ${nf(step)} of the period at first; older ones can be read ${nf(step)} at a time, up to ${nf(maxHeld)} on this page). It finds entries whose text mentions them by Id, username, email or full name.`;
export const SEARCH_LIMIT_NOTE = searchLimitNote();
export const PERSON_FACET_HINT = "This is the person Salesforce recorded as making the change. A delegate user is shown on the entry, not here.";

/** The person as one line: "Name (username)", the name alone, or the Id when nothing else is known. */
export function personWords(p) {
  if (!p) return "Everyone";
  if (p.name) return p.username ? `${p.name} (${p.username})` : p.name;
  return p.username || (p.id ? `User Id ${p.id}` : "Everyone");
}

/** Salesforce Ids differ in capitals, so only the first 15 characters are compared, exactly. */
export const id15 = (id) => String(id || "").slice(0, 15);

/**
 * Can a read that covered `cover` answer for `who` ({person, choice} or null)? `cover` is {kind: "all"} (the whole period,
 * nobody picked: any person and choice can be worked out from it) or {kind: "by", id15, username} (Salesforce was asked
 * for one person's entries as maker or delegate: it answers only "made by" for that same person).
 */
export function coverageFits(cover, who) {
  if (!cover) return false;
  if (!who) return cover.kind === "all";
  if (cover.kind === "all") return true;
  return who.choice === "by" && id15(who.person.id) === cover.id15 && String(who.person.username || "").toLowerCase() === cover.username;
}

/** What a read for `who` must ask Salesforce: only "made by" can be narrowed there. */
export function readFor(who) {
  if (who && who.choice === "by") return { userId: who.person.id, delegateUser: who.person.username || "", cover: { kind: "by", id15: id15(who.person.id), username: String(who.person.username || "").toLowerCase() } };
  return { userId: "", delegateUser: "", cover: { kind: "all" } };
}

const WORD = "\\p{L}\\p{N}_";
const escapeRe = (c) => c.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
const APOS = /['‘’ʼ´`]/;
const DASH = /[-‐‑‒–]/;

/** The regular expression for a full name as whole words: spaces collapse, apostrophes and hyphens come in several shapes. */
function nameRegex(name) {
  let body = "";
  for (const ch of name) {
    if (/\s/.test(ch)) body += "\\s+";
    else if (APOS.test(ch)) body += "['‘’ʼ´`]";
    else if (DASH.test(ch)) body += "[-‐‑‒–]";
    else body += escapeRe(ch);
  }
  return new RegExp(`(?<![${WORD}]|[\\p{L}\\p{N}]-)${body}(?![${WORD}]|-[\\p{L}\\p{N}])`, "giu");
}

/** What is needed to recognise one person in an entry: the Id, their usernames and emails, and their name. */
export function personMatcher(person) {
  const id = String(person?.id || "");
  const cands = [];
  const add = (text, kind) => {
    const t = String(text || "").trim().toLowerCase();
    if (!t || cands.some((c) => c.text === t)) return;
    cands.push({ text: t, kind });
  };
  for (const [text, kind] of [[person?.username, "username"], [person?.email, "email"]]) {
    add(text, kind);
    const t = String(text || "").trim().toLowerCase();
    if (t) add(t.endsWith(".invalid") ? t.slice(0, -8) : `${t}.invalid`, kind); // a sandbox may add or drop ".invalid"
  }
  const name = String(person?.name || "").normalize("NFC").trim().replace(/\s+/g, " ");
  const nameOk = !!name && (name.includes(" ") || [...name].length >= 4);
  return { id15: id15(id), usernameLower: String(person?.username || "").trim().toLowerCase(), cands, name, nameRe: nameOk ? nameRegex(name) : null };
}

const ID_TOKEN = /(?<![A-Za-z0-9_])[A-Za-z0-9]{15,18}(?![A-Za-z0-9_])/g;
const ADDRESS_BEFORE = /[a-z0-9._%+\-@]/;
const ADDRESS_AFTER = /[a-z0-9_@%+\-]/;
const OTHER_ID_AFTER = /^\s*\((?:UserID:\s*\[|User,\s*)([A-Za-z0-9]{15,18})(?![A-Za-z0-9])/;

/**
 * Does this entry's text mention the person? Strongest first: their Id (a whole 15 or 18 character token, the first 15
 * characters equal exactly), their username or email (a whole address, not part of a longer one), their full name as whole
 * words. A name that is directly followed by "(UserID: [<other Id>])" or "(User, <other Id>)" is somebody else and is
 * ignored. Returns null, or {how: "id" | "username" | "email" | "name"}. This looks only at the text, never at who made
 * the entry (`madeBy` does that); `personView` combines the two per choice: "made to" alone ignores the maker, so an entry
 * the person made whose text has only their name is still name-only; "either" counts a made-by entry as certain.
 */
export function matchMadeTo(display, m) {
  if (!display || !m) return null;
  if (m.id15 && display.includes(m.id15)) {
    ID_TOKEN.lastIndex = 0;
    let t;
    while ((t = ID_TOKEN.exec(display))) {
      if ((t[0].length === 15 || t[0].length === 18) && t[0].startsWith(m.id15)) return { how: "id" };
    }
  }
  if (m.cands.length) {
    const lower = display.toLowerCase();
    for (const c of m.cands) {
      let at = lower.indexOf(c.text);
      while (at !== -1) {
        const end = at + c.text.length;
        const before = at === 0 ? "" : lower[at - 1];
        const after = lower[end] || "";
        let ok = !(before && ADDRESS_BEFORE.test(before)) && !(after && ADDRESS_AFTER.test(after));
        if (ok && after === "." && /[a-z0-9]/.test(lower[end + 1] || "")) ok = false; // ".uat" and other longer endings
        if (ok) return { how: c.kind };
        at = lower.indexOf(c.text, at + 1);
      }
    }
  }
  if (m.nameRe) {
    let text = display;
    if (/[̀-ͯ]/.test(text)) text = text.normalize("NFC");
    m.nameRe.lastIndex = 0;
    let x;
    while ((x = m.nameRe.exec(text))) {
      const rest = text.slice(x.index + x[0].length, x.index + x[0].length + 60);
      const other = OTHER_ID_AFTER.exec(rest);
      if (other && other[1].slice(0, 15) !== m.id15) continue; // another person with this name
      return { how: "name" };
    }
  }
  return null;
}

/** "maker" when the recorded maker is the person, "delegate" when the delegate user is their username, else null. */
export function madeBy(e, m) {
  if (m.id15 && e.userId && e.userId.startsWith(m.id15)) return "maker";
  if (m.usernameLower && e.delegate && e.delegate.toLowerCase() === m.usernameLower) return "delegate";
  return null;
}

/**
 * The entries that are about `who` ({person, choice}), each as a copy with `how` (plain words: why it is here) and
 * `viaDelegate`. With nobody picked the entries are returned as they are. Pure; one pass.
 */
export function personView(entries, who) {
  if (!who) return entries;
  const m = personMatcher(who.person);
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const parts = [];
    let via = false;
    let sure = false; // made by them (only for "by" and "either"), or found by Id, username or email: certain
    if (who.choice !== "to") { // "Changes made to them" never looks at the maker: being the maker does not prove the name in the text is them
      const b = madeBy(e, m);
      if (b === "maker") { parts.push(HOW_MAKER); sure = true; }
      else if (b === "delegate") { parts.push(HOW_DELEGATE); via = true; sure = true; }
    }
    if (who.choice !== "by") {
      const t = matchMadeTo(e.display, m);
      if (t) {
        // A name in the text of an entry already certain (made by them) is a plain extra fact, with no warning.
        parts.push(t.how === "name" && sure ? HOW_NAME_ALSO : HOW_TO[t.how]);
        if (t.how !== "name") sure = true;
      }
    }
    if (parts.length) out.push({ ...e, how: parts.join("; "), viaDelegate: via, nameOnly: !sure });
  }
  return out;
}

// ---------- sorting ----------

export const SORT_COLUMNS = ["when", "who", "section", "what", "kind"];

/** A sorted copy. Ties keep Salesforce's own order (`seq`), whichever way the column goes. Default: newest first. */
export function sortEntries(list, key = "when", dir = "desc") {
  const sign = dir === "asc" ? 1 : -1;
  const n = list.length;
  const keys = new Array(n);
  const idx = new Array(n);
  for (let i = 0; i < n; i++) {
    const e = list[i];
    idx[i] = i;
    keys[i] = key === "when" ? (e.ms ?? 0) : key === "who" ? (e.userName || e.username || "").toLowerCase() : key === "section" ? e.section.toLowerCase()
      : key === "what" ? e.display.toLowerCase() : e.kind.toLowerCase();
  }
  idx.sort((x, y) => {
    const a = keys[x];
    const b = keys[y];
    if (a !== b) {
      if (a === "") return 1; // nothing recorded sorts last, whichever way the column goes
      if (b === "") return -1;
      return (a < b ? -1 : 1) * sign;
    }
    return list[x].seq - list[y].seq;
  });
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = list[idx[i]];
  return out;
}

/** The oldest and newest moment among the entries (loops, no spread). */
export function timeSpan(entries) {
  let min = null;
  let max = null;
  for (let i = 0; i < entries.length; i++) {
    const ms = entries[i].ms;
    if (!Number.isFinite(ms)) continue;
    if (min === null || ms < min) min = ms;
    if (max === null || ms > max) max = ms;
  }
  return { min, max };
}

/**
 * Where "Read older entries" continues from: the oldest second held, and the Ids held from that second (the continuation
 * reads that second again, so those entries are dropped, and none is lost or doubled). null when no entry has a time.
 */
export function continuationStart(entries) {
  const { min } = timeSpan(entries);
  if (!Number.isFinite(min)) return null;
  const sec = Math.floor(min / 1000);
  const skipIds = new Set();
  for (let i = 0; i < entries.length; i++) if (entries[i].id && Math.floor(entries[i].ms / 1000) === sec) skipIds.add(entries[i].id);
  return { oldestMs: min, skipIds };
}

// ---------- keyboard focus after a redraw ----------

/**
 * Which control gets the keyboard focus after a list was rebuilt. `before` and `after` are the control keys in order, `key` is
 * the one that had focus. The same control when it still exists; else `prefer` (for example the first row a "Show more" added);
 * else the next control that survived, then the nearest one before it; else null (the caller falls back to the search box).
 */
export function chooseFocus(before, after, key, prefer = null) {
  if (key === null || key === undefined) return null;
  const has = new Set(after);
  if (has.has(key)) return key;
  if (prefer !== null && prefer !== undefined && has.has(prefer)) return prefer;
  const at = before.indexOf(key);
  if (at === -1) return after.length ? after[0] : null;
  for (let i = at + 1; i < before.length; i++) if (has.has(before[i])) return before[i];
  for (let i = at - 1; i >= 0; i--) if (has.has(before[i])) return before[i];
  return null;
}

// ---------- honest wording ----------

/**
 * `cov`: {status: "complete"|"capped"|"stopped"|"failed"|"short", read, total (number or null), oldestMs, cap}.
 * Returns the sentence that stays above the results whenever the list is not the whole period, or null when it is.
 */
export function partialNote(cov, tz, { onPage = false } = {}) {
  const note = partialNoteBase(cov, tz, onPage);
  return note && cov.searched ? `${note} Entries about this person in the part that was not read are not in this list.` : note;
}

// `onPage`: the note sits above the real button, so it can name it. In exported text (CSV, copy) there is no button to press.
function partialNoteBase(cov, tz, onPage) {
  if (!cov || cov.status === "complete") return null;
  const have = Number.isFinite(cov.total) ? `${nf(cov.read)} of ${nf(cov.total)} entries` : `${nf(cov.read)} entries (the total is not known)`;
  const back = Number.isFinite(cov.oldestMs) ? `, going back to ${formatLocal(cov.oldestMs, tz)}` : "";
  const atLimit = Number.isFinite(cov.maxHeld) && cov.read >= cov.maxHeld;
  // What can be done about the rest: read older entries with the button, or (page full, or no button) choose less.
  const fix = cov.canMore
    ? `Entries older than that are not in this list yet. ${onPage ? `More can be read: press the "${olderLabel(cov)}" button below.` : "More entries can be read on the Search the Setup Audit Trail page."} Or choose a shorter period, or only one person's changes.`
    : atLimit
      ? `Entries older than that are not in this list. ${OLDER_LIMIT_WORDS(cov.maxHeld)}`
      : "Entries older than that are not in this list. Choose a shorter period, or only one person's changes, to see them all.";
  const step = Number.isFinite(cov.cap) ? cov.cap : READ_STEP;
  if (cov.status === "reading") return `The read was still running when this was made, so only part of this period is here: ${have}${back}. Entries older than that are not in this list. Wait until the read has finished and make this again to get them all.`;
  if (cov.status === "continuing") return `Still reading older entries: ${have} so far${back}. Entries older than that are not in this list yet.`;
  if (cov.status === "capped") {
    // After "Read older entries" more than one read's worth is held: no "newest" and no per-read limit beside the bigger number.
    return cov.read > step
      ? `Only part of this period is shown: ${have} were read${back}. ${fix}`
      : `Only part of this period is shown: the newest ${have} were read${back} (one read takes at most ${nf(step)}). ${fix}`;
  }
  if (cov.status === "stopped") return `You stopped the read. Only part of this period is shown: ${have}${back}. ${fix}`;
  if (cov.status === "short") return `Only part of this period is shown: Salesforce counted more entries than it returned (${have}${back}). Read it again, or choose a shorter period.`;
  return `The read stopped part way, so only part of this period is shown: ${have}${back}. ${fix}${cov.canMore && onPage ? " The button also tries again." : " Or try again."}`;
}

/** How many of these entries are certain (made by them, or found by Id, username or email) and how many only match their name. */
export function matchCounts(entries) {
  let nameOnly = 0;
  for (let i = 0; i < entries.length; i++) if (entries[i].nameOnly) nameOnly++;
  return { certain: entries.length - nameOnly, nameOnly };
}

/** "7 certain (made by them, or their Id, username or email is in the text), 11 by name only (may be another person)"; "" when none is name-only. */
export function matchBreakdown(c) {
  if (!c || !c.nameOnly) return "";
  return `${nf(c.certain)} certain (made by them, or their Id, username or email is in the text), ${nf(c.nameOnly)} by name only (may be another person)`;
}

/** "Showing 37 of 18,125 entries read". With a person picked, `about` is how many of the entries read are about them: a number, or {certain, nameOnly}. */
export function statusLine(shown, read, cov, about = null, tz) {
  const total = about !== null && typeof about === "object" ? about.certain + about.nameOnly : about;
  const split = about !== null && typeof about === "object" ? matchBreakdown(about) : "";
  const s = about === null
    ? `Showing ${nf(shown)} of ${nf(read)} ${read === 1 ? "entry" : "entries"} read`
    : `Showing ${nf(shown)} of ${nf(total)} ${total === 1 ? "entry" : "entries"} ${split ? "that may be " : ""}about them${split ? ` (${split})` : ""}, from ${nf(read)} ${read === 1 ? "entry" : "entries"} read`;
  if (!cov || cov.status === "complete") return s;
  const words = coverageWords(cov, tz);
  return words ? `${s} (not the whole period: ${words}; see above)` : `${s} (not the whole period, see above)`;
}

/** The "so far" line while entries still arrive. */
export function readingStatusLine(shown, read, about = null) {
  if (about === null) return `Showing ${nf(shown)} of ${nf(read)} entries read so far`;
  const split = matchBreakdown(about);
  return `Showing ${nf(shown)} of ${nf(about.certain + about.nameOnly)} entries ${split ? "that may be " : ""}about them so far${split ? ` (${split})` : ""}`;
}

/** What to say when nothing is shown. `baseCount` (with a person picked) is how many entries were about them before the search and lists. */
export function emptyText({ read, partial, filtered, person = "", baseCount = null, baseSplit = "", cover = "" }) {
  const hid = `${nf(baseCount ?? read)} entries read${baseSplit ? ` (${baseSplit})` : ""}`;
  const c = cover ? ` (${cover})` : ""; // the combined coverage: how much was read, back to when, whether more can be read
  if (read === 0) return partial ? `0 found. Only part of the period was read${c}, so there may be entries in the part that was not read.` : (person ? `No entries about ${person} in this period.` : "No entries in this period.");
  if (person && baseCount === 0) return partial
    ? `0 found for ${person} among the ${nf(read)} entries read. Only part of the period was read${c}, so there may be entries in the part that was not read.`
    : `0 found for ${person} among the ${nf(read)} entries read.`;
  if (filtered) return partial
    ? `0 found. The search and filters hide all ${hid}, and only part of the period was read${c}, so there may be matches in the part that was not read. Clear the filters to see what was read.`
    : `0 found. The search and filters hide all ${hid}. Clear the filters to see them.`;
  return "No entries.";
}

export const progressText = (read, total) => `Reading... ${nf(read)}${Number.isFinite(total) ? ` of ${nf(total)}` : ""} entries`;
/** While older entries are read: `held` is everything held so far, counted against the whole period's total. */
export const olderProgressText = (held, total) => `Reading older entries... ${nf(held)}${Number.isFinite(total) ? ` of ${nf(total)}` : ""}`;
export const OLDER_STALE_TEXT = "The period was changed after this was read, so older entries of this read are not offered. Press Show the audit trail to read again.";
export const OLDER_LIMIT_WORDS = (maxHeld) => `This page holds at most ${nf(maxHeld)} entries, so no more can be read here. Choose a shorter period, or only one person's changes, to see them all.`;

/**
 * The coverage the page keeps after a read (first read or continuation): what was held, going back to when, and whether
 * "Read older entries" can still continue it. Only a capped, stopped or failed read with entries can continue, and only
 * while the page holds fewer than `maxHeld`.
 */
export function buildCoverage({ status, read, total, oldestMs }, { step = READ_STEP, maxHeld = MAX_HELD } = {}) {
  const canMore = (status === "capped" || status === "stopped" || status === "failed") && read > 0 && read < maxHeld && Number.isFinite(oldestMs);
  return { status, read, total, oldestMs, cap: step, maxHeld, canMore };
}

/** The label of the button that reads older entries: how many, and how many are left when the total is known. */
export function olderLabel({ read, total, cap = READ_STEP, maxHeld = MAX_HELD }) {
  const room = Math.max(0, Math.min(cap, maxHeld - read));
  const left = Number.isFinite(total) ? total - read : null;
  if (left !== null && left > 0 && left <= room) return `Read the remaining ${nf(left)}`;
  if (left !== null && left > 0) return `Read the next ${nf(room)} older entries (${nf(left)} left)`;
  return `Read ${nf(room)} older entries`;
}

/** "62,000 of 626,000 entries read, going back to 2026-...; more can be read": the combined coverage in one phrase. */
export function coverageWords(cov, tz) {
  if (!cov || !Number.isFinite(cov.read)) return "";
  const have = Number.isFinite(cov.total) ? `${nf(cov.read)} of ${nf(cov.total)} entries read` : `${nf(cov.read)} entries read, the total is not known`;
  const back = Number.isFinite(cov.oldestMs) ? `, going back to ${formatLocal(cov.oldestMs, tz)}` : "";
  const atLimit = Number.isFinite(cov.maxHeld) && cov.read >= cov.maxHeld;
  return `${have}${back}${cov.canMore ? "; more can be read" : atLimit ? "; the page cannot hold more" : ""}`;
}

// ---------- copy and download ----------

const whoText = (e) => (e.userName ? (e.username ? `${e.userName} (${e.username})` : e.userName) : whoLabel(e));

/** One entry as plain text for a ticket. */
export function ticketText(e, { orgName = "", tz } = {}) {
  const lines = ["Setup Audit Trail entry"];
  if (orgName) lines.push(`Org: ${orgName}`);
  lines.push(
    `When: ${formatLocal(e.ms, tz)} (${tz || timeZoneName()}), ${formatUtc(e.ms)}`,
    `Who: ${whoText(e)}`,
    `Section: ${e.section || NO_SECTION}`,
    `Kind of change: ${e.kind} (${e.action || "no code"})`,
    `What changed: ${e.display}`);
  if (e.delegate) lines.push(`Delegate user: ${e.delegate}`);
  if (e.how) lines.push(`How it matched: ${e.how}`);
  if (e.namespace) lines.push(`Source namespace prefix: ${e.namespace}`);
  return lines.join("\n");
}

/** Lines that say what the list is: period, person, filters, how much was read. Used by the copy text and the CSV. */
export function contextLines({ periodDetail, who, filters, people, cov, tz }) {
  const lines = [`Period: ${periodDetail}`, `Time zone: ${tz || timeZoneName()}`, `Person searched for: ${personWords(who?.person)}`];
  if (who) {
    lines.push(`What to find: ${CHOICE_LABELS[who.choice]}`);
    if (who.choice !== "by") lines.push(`How it was searched: ${searchLimitNote(cov?.cap, cov?.maxHeld)}`);
  }
  const chips = filters ? filterChips(filters, people).map((c) => c.text) : [];
  lines.push(`Search and filters: ${chips.length ? chips.join("; ") : "none"}`);
  if (cov) lines.push(`Entries read: ${nf(cov.read)}${Number.isFinite(cov.total) ? ` of ${nf(cov.total)}` : " (total not known)"}`);
  return lines;
}

/** " (7 certain (...), 11 by name only (may be another person))" for these entries, or "" . */
function splitOf(entries, ctx) {
  const b = ctx.who ? matchBreakdown(matchCounts(entries)) : "";
  return b ? ` (${b})` : "";
}

/** "Copy what is shown": at most COPY_LIMIT entries, and it says so when there are more. */
export function shownText(entries, ctx) {
  const tz = ctx.tz;
  const lines = ["Setup Audit Trail", ...contextLines(ctx)];
  const note = partialNote(ctx.cov, tz);
  if (note) lines.push(`NOTE: ${note}`);
  lines.push("", entries.length > COPY_LIMIT
    ? `${nf(entries.length)} entries match${splitOf(entries, ctx)}. This text has the first ${COPY_LIMIT}; use the CSV download for all of them.`
    : `${nf(entries.length)} ${entries.length === 1 ? "entry matches" : "entries match"}${splitOf(entries, ctx)}.`, "");
  const n = Math.min(entries.length, COPY_LIMIT);
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    const extra = [e.delegate ? `delegate user ${e.delegate}` : "", e.how ? e.how : "", e.namespace ? `package ${e.namespace}` : ""].filter(Boolean).join(", ");
    lines.push(`${formatLocal(e.ms, tz)} | ${whoText(e)} | ${e.section || NO_SECTION} | ${e.kind} | ${e.display}${extra ? ` (${extra})` : ""}`);
  }
  return lines.join("\n");
}

export const CSV_HEADER = ["When (your time)", "When (UTC)", "Who", "Username", "Section", "Kind of change", "Kind code", "What changed", "Delegate user", "Source namespace prefix"];
export const CSV_HEADER_WITH_HOW = [...CSV_HEADER.slice(0, 8), "How it matched", ...CSV_HEADER.slice(8)];

/** Rows for toCsv: the notes first (period, time zone, person, filters, and the partial warning), then every entry given. */
export function csvRows(entries, ctx) {
  const tz = ctx.tz;
  const rows = [["Setup Audit Trail export"]];
  for (const l of contextLines(ctx)) { const i = l.indexOf(": "); rows.push([l.slice(0, i), l.slice(i + 2)]); }
  rows.push(["Entries in this file", String(entries.length)]);
  const split = ctx.who ? matchBreakdown(matchCounts(entries)) : "";
  if (split) rows.push(["Entries in this file by how they matched", split]);
  const note = partialNote(ctx.cov, tz);
  if (note) rows.push(["Note", note]);
  rows.push([]);
  rows.push(ctx.who ? CSV_HEADER_WITH_HOW : CSV_HEADER);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const row = [formatLocal(e.ms, tz), formatUtc(e.ms), whoLabel(e), e.username, e.section || NO_SECTION, e.kind, e.action, e.display];
    if (ctx.who) row.push(e.how || "");
    row.push(e.delegate, e.namespace);
    rows.push(row);
  }
  return rows;
}

/** Clipboard write with a plain "not copied" answer instead of an error (`clipboard` is navigator.clipboard). */
export async function copyWithFallback(text, clipboard) {
  try {
    if (!clipboard || typeof clipboard.writeText !== "function") return { copied: false };
    await clipboard.writeText(text);
    return { copied: true };
  } catch {
    return { copied: false };
  }
}

// ---------- demo: a made-up org served through the same reads ----------

/** The demo file's entries as API records, dated `secondsAgo` before `now` (a Date). */
export function demoRecords(demo, now) {
  const users = new Map(demo.users.map((u) => [u.id, u]));
  const base = Math.floor(now.getTime() / 1000) * 1000;
  const recs = demo.entries.map((e) => {
    const u = e.userId ? users.get(e.userId) : null;
    return {
      Id: e.id, Action: e.action, Section: e.section, Display: e.display,
      CreatedDate: new Date(base - e.secondsAgo * 1000).toISOString().replace("Z", "+0000"),
      CreatedById: e.userId, CreatedBy: u ? { Name: u.name, Username: u.username } : null,
      DelegateUser: e.delegate, ResponsibleNamespacePrefix: e.namespace,
    };
  });
  recs.sort((a, b) => (a.CreatedDate < b.CreatedDate ? 1 : a.CreatedDate > b.CreatedDate ? -1 : a.Id < b.Id ? 1 : -1));
  return recs;
}

/**
 * A fake `api` (just `get`) that answers this tool's two queries from `records` (newest first), a few at a time,
 * the way Salesforce does with nextRecordsUrl. Only for demo mode and tests; it understands only the queries made here.
 */
export function demoApi(records, { pageSize = 200, delayMs = 0 } = {}) {
  const lit = (q, op) => { const m = new RegExp(`CreatedDate ${op} (\\d{4}-\\d{2}-\\d{2}T[\\d:]+Z)`).exec(q); return m ? Date.parse(m[1]) : null; };
  const pick = (q) => {
    const from = lit(q, ">="); const to = lit(q, "<"); const upTo = lit(q, "<=");
    const unq = (v) => v.replace(/\\(.)/g, "$1");
    const both = /\(CreatedById = '((?:[^'\\]|\\.)*)' OR DelegateUser = '((?:[^'\\]|\\.)*)'\)/.exec(q);
    const one = /CreatedById = '((?:[^'\\]|\\.)*)'/.exec(q);
    const who = both ? unq(both[1]) : one ? unq(one[1]) : "";
    const delegate = both ? unq(both[2]).toLowerCase() : "";
    return records.filter((r) => {
      const t = Date.parse(r.CreatedDate.replace(/([+-])(\d{2})(\d{2})$/, "$1$2:$3"));
      if ((from !== null && t < from) || (to !== null && t >= to) || (upTo !== null && t > upTo)) return false;
      if (!who) return true;
      return (r.CreatedById || "").slice(0, 15) === who.slice(0, 15) || (!!delegate && (r.DelegateUser || "").toLowerCase() === delegate);
    });
  };
  const sets = new Map();
  const page = (id, offset) => {
    const list = sets.get(id);
    const next = offset + pageSize;
    return { done: next >= list.length, totalSize: list.length, records: list.slice(offset, next), ...(next < list.length ? { nextRecordsUrl: `/services/data/vDEMO/query/${id}-${next}` } : {}) };
  };
  return {
    calls: 0,
    apiVersion: "67.0",
    async get(path) {
      this.calls++;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs)); // demo only: gives the Stop button a moment to be clicked
      const u = new URL(path, "https://demo.invalid");
      const q = u.searchParams.get("q");
      if (q) {
        if (!/FROM SetupAuditTrail/.test(q)) throw new Error("The demo only knows the audit trail query.");
        const list = pick(q);
        if (/^SELECT COUNT\(\)/.test(q)) return { done: true, totalSize: list.length, records: [] };
        const id = `demo${sets.size + 1}`;
        sets.set(id, list);
        return page(id, 0);
      }
      const m = /\/query\/(demo\d+)-(\d+)$/.exec(u.pathname);
      if (!m || !sets.has(m[1])) throw new Error("Unknown demo page.");
      return page(m[1], Number(m[2]));
    },
  };
}
