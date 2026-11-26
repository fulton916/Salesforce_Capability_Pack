// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Offline tests for "Search the Setup Audit Trail". Called from run_tests.mjs with its shared `test` function.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SfApi } from "../shared/sfconn.js";
import { sfId18, isSalesforceId, pastedUserId, matchUsers } from "../shared/users-logic.js";
import { toCsv } from "../shared/csv.js";
import { TOOLS } from "../shared/tool-list.js";
import { FEEDBACK_TOOLS } from "../shared/feedback.js";
import {
  PERIODS, DEFAULT_PERIOD, COPY_LIMIT, NO_SECTION, NO_USER, CSV_HEADER,
  HIDDEN_USER, CSV_HEADER_WITH_HOW, CHOICE_LABELS, STALE_TEXT, SEARCH_LIMIT_NOTE, HOW_MAKER, HOW_DELEGATE, HOW_NAME_ONLY, HOW_NAME_ALSO,
  idAlternates, hiddenLabel, whoLabel, personWords, id15, coverageFits, readFor, personMatcher, matchMadeTo, madeBy, personView, contextLines,
  isUserId, periodBounds, soqlDate, formatLocal, formatUtc, parseSfDate, kindLabel, entryFromRecord,
  parseSearch, searchMatches, highlightParts, emptyFilters, buildPeople, runFilters, facetOptions, toggleChoice, hasFilters, filterChips, removeChip, clearFilters,
  sortEntries, timeSpan, partialNote, statusLine, emptyText, progressText, ticketText, shownText, csvRows, copyWithFallback, demoRecords, demoApi, matchCounts, matchBreakdown, readingStatusLine, chooseFocus,
  continuationStart, buildCoverage, olderLabel, olderProgressText, coverageWords, OLDER_STALE_TEXT,
} from "../tools/audit-trail/audit-trail-logic.js";
import { readAuditTrail, buildQuery, buildCountQuery, buildWhere, plainProblem, plainUserSearchProblem, MAX_ENTRIES, MAX_HELD } from "../tools/audit-trail/audit-trail-read.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = (...p) => path.join(here, "..", ...p);
const read = (f) => readFileSync(f, "utf-8");
const demo = () => JSON.parse(read(ext("samples", "audit_trail_demo.json")));

const U1 = "005000000000001AAA";
const U2 = "005000000000002AAA";
const U3 = "005000000000003AAA";

/** One API-shaped record. `at` is an ISO moment in UTC. */
const rec = (n, at, o = {}) => ({
  Id: `0Ym${String(n).padStart(12, "0")}AAA`, Action: "PermSetFlsChanged", Section: "Permission Sets", Display: `Changed thing ${n}`,
  CreatedDate: at.replace("Z", ".000+0000"), CreatedById: U1, CreatedBy: { Name: "Alex Example", Username: "alex@example.com" },
  DelegateUser: null, ResponsibleNamespacePrefix: null, ...o,
});
/** `count` records, newest first, one a minute apart, ending at 2026-11-25T12:00:00Z. */
function records(count, over = () => ({})) {
  const base = Date.parse("2026-11-25T12:00:00Z");
  return Array.from({ length: count }, (_, i) => rec(i + 1, new Date(base - i * 60000).toISOString().replace(/\.\d{3}Z$/, "Z"), over(i)));
}
const entriesOf = (recs) => recs.map((r, i) => entryFromRecord(r, i));

/** A fake REST client over a record list: counts, then pages of `pageSize` through nextRecordsUrl. Everything it is asked is noted. */
function fakeApi(recs, { pageSize = 2000, failCount = false, failPage = 0, failWith, hold } = {}) {
  const log = [];
  let pages = 0;
  const api = {
    apiVersion: "67.0", log,
    async get(p) {
      log.push(p);
      if (hold) await hold(p);
      const u = new URL(p, "https://x.invalid");
      const q = u.searchParams.get("q");
      if (q && /^SELECT COUNT\(\)/.test(q)) {
        if (failCount) throw Object.assign(new Error("count refused"), { status: 400 });
        return { done: true, totalSize: recs.length, records: [] };
      }
      pages++;
      if (failPage && pages === failPage) throw failWith || Object.assign(new Error("Unable to connect"), { status: 503 });
      const offset = q ? 0 : Number(/-(\d+)$/.exec(u.pathname)[1]);
      const next = offset + pageSize;
      return { done: next >= recs.length, totalSize: recs.length, records: recs.slice(offset, next), ...(next < recs.length ? { nextRecordsUrl: `/services/data/v67.0/query/01g-${next}` } : {}) };
    },
  };
  return api;
}

export async function run(test) {
  // ===== the query =====

  await test("audit: the query asks for the right fields, newest first, and only filterable fields in WHERE", () => {
    const from = new Date("2026-11-18T05:00:00Z");
    const to = new Date("2026-11-26T05:00:00Z");
    const q = buildQuery({ from, to, userId: U1 });
    assert.match(q, /^SELECT Id, Action, Section, Display, CreatedDate, CreatedById, CreatedBy\.Name, CreatedBy\.Username, DelegateUser, ResponsibleNamespacePrefix FROM SetupAuditTrail WHERE /);
    assert.ok(q.endsWith(" ORDER BY CreatedDate DESC, Id DESC"));
    assert.ok(q.includes("CreatedDate >= 2026-11-18T05:00:00Z AND CreatedDate < 2026-11-26T05:00:00Z AND CreatedById = '005000000000001AAA'"), q);
    const where = q.slice(q.indexOf(" WHERE "), q.indexOf(" ORDER BY"));
    assert.ok(!/Section|Display/.test(where), "Section and Display are not filterable");
    assert.ok(!/CreatedByContext|CreatedByIssuer/.test(q), "the two fields that are always empty are not read");
    assert.equal(buildQuery({}), q.replace(/ WHERE .* ORDER BY/, " ORDER BY"));
    assert.ok(!buildQuery({}).includes("WHERE"));
    assert.equal(buildCountQuery({ from }), "SELECT COUNT() FROM SetupAuditTrail WHERE CreatedDate >= 2026-11-18T05:00:00Z");
    assert.equal(buildWhere({ from, to: null, userId: "" }), " WHERE CreatedDate >= 2026-11-18T05:00:00Z");
    assert.ok(!/ LIMIT | OFFSET /.test(q));
  });

  await test("audit: a person is put in the query only as a checked Id", () => {
    for (const bad of ["005' OR Id != '", "abc", "005000000000001AAA'", "005 000000000001AAA", "<img>"]) {
      assert.ok(!isUserId(bad), bad);
      assert.throws(() => buildWhere({ userId: bad }), /not a user Id/, bad);
    }
    assert.ok(isUserId("005000000000001") && isUserId(U1));
  });

  await test("audit: soqlDate has no milliseconds and no quotes", () => {
    assert.equal(soqlDate(new Date("2026-11-25T19:03:07.456Z")), "2026-11-25T19:03:07Z");
  });

  // ===== period bounds =====

  await test("audit: periods are the six the page offers, 7 days is the default, nothing is read until asked", () => {
    assert.deepEqual(PERIODS.map((p) => p.label), ["Last 24 hours", "Last 7 days", "Last 30 days", "Last 90 days", "Everything Salesforce keeps (about 180 days)", "Choose dates"]);
    assert.equal(DEFAULT_PERIOD, "7d");
    const page = read(ext("tools/audit-trail/audit-trail.js"));
    assert.ok(!/^\s*readNow\(\);?\s*$/m.test(page) && !/start\(\)\s*\.then\(readNow/.test(page), "the page does not read on its own");
  });

  await test("audit: rolling periods and 'everything'", () => {
    const now = new Date("2026-11-25T12:00:00Z");
    const h = periodBounds("24h", now);
    assert.equal(h.from.toISOString(), "2026-11-24T12:00:00.000Z");
    assert.equal(h.to, null);
    assert.equal(periodBounds("all", now).from, null);
    assert.equal(periodBounds("nope", now).ok, false);
    for (const [p, d] of [["7d", 7], ["30d", 30], ["90d", 90]]) {
      const b = periodBounds(p, now);
      const back = new Date(now);
      back.setDate(back.getDate() - d);
      assert.equal(b.from.getTime(), back.getTime(), p);
    }
  });

  await test("audit: chosen days are local days, the last day is included, and a daylight-saving change is exact", () => {
    const old = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      assert.equal(new Date(2026, 2, 8, 12).getTimezoneOffset(), 240, "the time zone could not be set for this test");
      assert.equal(new Date(2026, 2, 7, 12).getTimezoneOffset(), 300);
      const now = new Date("2026-03-10T12:00:00Z");
      // Spring forward on 2026-03-08: the days 7 and 8 together are 47 hours.
      const spring = periodBounds("dates", now, { from: "2026-03-07", to: "2026-03-08" });
      assert.equal(soqlDate(spring.from), "2026-03-07T05:00:00Z");
      assert.equal(soqlDate(spring.to), "2026-03-09T04:00:00Z");
      assert.equal((spring.to - spring.from) / 3600000, 47);
      // Fall back on 2026-11-01: that one day is 25 hours, and the query says "before the next day starts".
      const fall = periodBounds("dates", now, { from: "2026-11-01", to: "2026-11-01" });
      assert.equal(soqlDate(fall.from), "2026-11-01T04:00:00Z");
      assert.equal(soqlDate(fall.to), "2026-11-02T05:00:00Z");
      assert.equal((fall.to - fall.from) / 3600000, 25);
      assert.equal(buildWhere({ from: fall.from, to: fall.to }), " WHERE CreatedDate >= 2026-11-01T04:00:00Z AND CreatedDate < 2026-11-02T05:00:00Z");
      // "Last 7 days" keeps the wall-clock time across the change.
      const week = periodBounds("7d", new Date("2026-03-10T16:00:00Z"));
      assert.equal(soqlDate(week.from), "2026-03-03T17:00:00Z");
      // Another zone, on the other side of UTC.
      process.env.TZ = "Australia/Sydney";
      const syd = periodBounds("dates", now, { from: "2026-03-07", to: "2026-03-07" });
      assert.equal(soqlDate(syd.from), "2026-03-06T13:00:00Z");
      assert.equal(soqlDate(syd.to), "2026-03-07T13:00:00Z");
    } finally {
      if (old === undefined) delete process.env.TZ; else process.env.TZ = old;
    }
  });

  await test("audit: bad dates are refused in plain words", () => {
    const now = new Date();
    assert.match(periodBounds("dates", now, { from: "", to: "2026-03-08" }).error, /both a first and a last day/);
    assert.match(periodBounds("dates", now, { from: "2026-03-09", to: "2026-03-08" }).error, /last day must not be before/);
    assert.equal(periodBounds("dates", now, { from: "2026-03-08", to: "2026-03-08" }).ok, true);
  });

  await test("audit: times are shown in a named zone and in UTC", () => {
    const ms = Date.parse("2026-11-25T19:03:07Z");
    assert.equal(formatLocal(ms, "America/New_York"), "2026-11-25 14:03:07");
    assert.equal(formatLocal(ms, "Asia/Tokyo"), "2026-11-26 04:03:07");
    assert.equal(formatLocal(Date.parse("2026-11-25T00:00:00Z"), "UTC"), "2026-11-25 00:00:00");
    assert.equal(formatUtc(ms), "2026-11-25 19:03:07 UTC");
    assert.equal(formatLocal(null), "Not recorded");
    assert.equal(parseSfDate("2026-11-25T19:03:07.000+0000"), ms);
    assert.equal(parseSfDate("2026-11-25T14:03:07.000-0500"), ms);
    assert.equal(parseSfDate(null), null);
    assert.equal(parseSfDate("soon"), null);
  });

  // ===== kinds and entries =====

  await test("audit: kind labels split the code into words and invent nothing", () => {
    assert.equal(kindLabel("PermSetFlsChanged"), "Perm Set Fls Changed");
    assert.equal(kindLabel("changedUserEmail"), "Changed User Email");
    assert.equal(kindLabel("SSOLoginAttempt"), "SSO Login Attempt");
    assert.equal(kindLabel("HTTPServerError"), "HTTP Server Error");
    assert.equal(kindLabel("Oauth2AppCreated"), "Oauth2 App Created");
    assert.equal(kindLabel("changed2FAMethod"), "Changed2 FA Method");
    assert.equal(kindLabel("my_custom_kind"), "My Custom Kind");
    assert.equal(kindLabel("loginasgrantedtopartnersupport"), "Loginasgrantedtopartnersupport");
    assert.equal(kindLabel("A"), "A");
    assert.equal(kindLabel(""), "No kind recorded");
    assert.equal(kindLabel(null), "No kind recorded");
  });

  await test("audit: an entry keeps nulls as empty and builds its search text once", () => {
    const e = entryFromRecord({ Id: "x", Action: "createdCustomField", Section: null, Display: "Made Region__c", CreatedDate: "2026-11-25T19:03:07.000+0000", CreatedById: null, CreatedBy: null, DelegateUser: null, ResponsibleNamespacePrefix: null }, 7);
    assert.deepEqual([e.section, e.userId, e.userName, e.delegate, e.namespace, e.seq, e.ms], ["", "", "", "", "", 7, Date.parse("2026-11-25T19:03:07Z")]);
    assert.ok(e.hay.includes("made region__c") && e.hay.includes("created custom field") && e.hay.includes("createdcustomfield"));
    const full = entryFromRecord(rec(1, "2026-11-25T19:03:07Z", { DelegateUser: "boss@example.com", ResponsibleNamespacePrefix: "acme" }), 0);
    for (const w of ["alex example", "alex@example.com", "boss@example.com", "acme", "permission sets", "perm set fls changed"]) assert.ok(full.hay.includes(w), w);
    assert.equal(entryFromRecord({}, 0).ms, null);
  });

  // ===== search =====

  const find = (text, hay) => searchMatches(parseSearch(text), hay.toLowerCase());

  await test("audit: search words match in any order, in any case", () => {
    assert.ok(find("region my_set", "Changed Region__c on permission set My_Set"));
    assert.ok(find("MY_SET REGION__C", "Changed Region__c on permission set My_Set"));
    assert.ok(!find("region other", "Changed Region__c on permission set My_Set"));
    assert.ok(find("", "anything"));
    assert.ok(find("   ", "anything"));
  });

  await test("audit: API names with underscores and double underscores are found as typed", () => {
    assert.ok(find("Region__c", "Changed field Account.Region__c"));
    assert.ok(find("My_Set", "permission set My_Set"));
    assert.ok(!find("My_Set", "permission set My Set"), "typed as is, not loosened");
    assert.deepEqual(parseSearch("Region__c").include, ["region__c"]);
  });

  await test("audit: a quoted phrase is exact, keeps punctuation and ignores case", () => {
    assert.ok(find('"permission set"', "Changed Permission Set X"));
    assert.ok(!find('"permission set"', "set permission"));
    assert.ok(find('"a, b (c)"', "text A, B (C) end"));
    assert.ok(!find('"a, b (c)"', "text a b c end"));
    assert.deepEqual(parseSearch('one "two three" four').include, ["one", "two three", "four"]);
    assert.deepEqual(parseSearch('"unfinished phrase').include, ["unfinished phrase"]);
  });

  await test("audit: a leading minus leaves out a word or a phrase; a hyphen inside a word does not", () => {
    assert.ok(!find("-login", "a login event"));
    assert.ok(find("-login", "a logout event"));
    assert.ok(!find('-"set up"', "to set up now"));
    assert.ok(find('-"set up"', "to set it up"));
    assert.ok(find("perm -login", "perm change"));
    assert.deepEqual(parseSearch("-login perm"), { include: ["perm"], exclude: ["login"] });
    // a hyphen inside a word is part of the word
    assert.deepEqual(parseSearch("sales-cloud"), { include: ["sales-cloud"], exclude: [] });
    assert.ok(find("sales-cloud", "profile sales-cloud users"));
    assert.ok(!find("sales-cloud", "profile sales cloud users"));
    assert.deepEqual(parseSearch("a -b-c"), { include: ["a"], exclude: ["b-c"] });
    // a minus sign still being typed matches everything
    assert.deepEqual(parseSearch("-"), { include: [], exclude: [] });
    assert.deepEqual(parseSearch('- ""'), { include: [], exclude: [] });
  });

  await test("audit: marking what matched uses text pieces, merges overlaps and skips excluded words", () => {
    const parts = highlightParts("Changed Region__c on My_Set and region", parseSearch("region__c -zzz my_set"));
    assert.deepEqual(parts.filter((p) => p.hit).map((p) => p.text), ["Region__c", "My_Set"]);
    assert.equal(parts.map((p) => p.text).join(""), "Changed Region__c on My_Set and region");
    assert.deepEqual(highlightParts("abcabc", parseSearch("ab abc")).filter((p) => p.hit).map((p) => p.text), ["abcabc"], "overlapping and touching matches become one mark");
    assert.deepEqual(highlightParts("ab-cd ab", parseSearch("ab")).map((p) => p.hit), [true, false, true]);
    assert.deepEqual(highlightParts("plain", parseSearch("-plain")), [{ text: "plain", hit: false }]);
    assert.deepEqual(highlightParts("", parseSearch("x")), [{ text: "", hit: false }]);
  });

  // ===== the pick lists =====

  const mix = () => {
    const d = [
      ["PermSetFlsChanged", "Permission Sets", U1, "alex"], ["PermSetFlsChanged", "Permission Sets", U1, "alex"], ["PermSetFlsChanged", "Permission Sets", U2, "sam"],
      ["changedUserEmail", "Manage Users", U2, "sam"], ["changedUserEmail", "Manage Users", U3, "sam"], ["createdCustomField", null, U1, "alex"],
      ["changedHolidayName", null, null, ""],
    ];
    return entriesOf(d.map(([a, s, u, n], i) => rec(i + 1, "2026-11-25T10:00:00Z", {
      Action: a, Section: s, Display: `${a} ${i}`, CreatedById: u,
      CreatedBy: u ? { Name: u === U1 ? "Alex Example" : "Sam Rivera", Username: u === U2 ? "sam.rivera@example.com" : u === U3 ? "sam.rivera2@example.com" : "alex@example.com" } : null,
      DelegateUser: i === 3 ? "boss@example.com" : null, ResponsibleNamespacePrefix: i === 5 ? "acme" : null,
    })));
  };
  const countsOf = (res, facet) => Object.fromEntries(res.counts[facet]);

  await test("audit: lists count what is left after the search and the OTHER lists", () => {
    const list = mix();
    const f = emptyFilters();
    let res = runFilters(list, f);
    assert.equal(res.shown.length, 7);
    assert.deepEqual(countsOf(res, "section"), { "Permission Sets": 3, "Manage Users": 2, "": 2 });
    assert.deepEqual(countsOf(res, "kind"), { PermSetFlsChanged: 3, changedUserEmail: 2, createdCustomField: 1, changedHolidayName: 1 });
    // choose a kind: the kind list still shows all kinds (its own choice is ignored), the others narrow
    toggleChoice(f, "kind", "include", "changedUserEmail");
    res = runFilters(list, f);
    assert.equal(res.shown.length, 2);
    assert.deepEqual(countsOf(res, "kind"), { PermSetFlsChanged: 3, changedUserEmail: 2, createdCustomField: 1, changedHolidayName: 1 });
    assert.deepEqual(countsOf(res, "section"), { "Manage Users": 2 });
    assert.deepEqual(countsOf(res, "person"), { [U2]: 1, [U3]: 1 });
    // the search narrows every list
    f.search = "perm";
    toggleChoice(f, "kind", "include", "changedUserEmail"); // off again
    res = runFilters(list, f);
    assert.equal(res.shown.length, 3);
    assert.deepEqual(countsOf(res, "kind"), { PermSetFlsChanged: 3 });
  });

  await test("audit: an option can be hidden, and a chosen option stays listed at 0", () => {
    const list = mix();
    const f = emptyFilters();
    toggleChoice(f, "kind", "exclude", "PermSetFlsChanged");
    let res = runFilters(list, f);
    assert.equal(res.shown.length, 4);
    assert.ok(res.shown.every((e) => e.action !== "PermSetFlsChanged"));
    const opts = facetOptions("kind", res.counts, f, buildPeople(list));
    const hidden = opts.find((o) => o.key === "PermSetFlsChanged");
    assert.deepEqual([hidden.state, hidden.count], ["exclude", 3], "a hidden option still shows what hiding it removed");
    // include one that the search then rules out: it stays, with 0
    toggleChoice(f, "kind", "exclude", "PermSetFlsChanged"); // clear
    toggleChoice(f, "section", "include", "Manage Users");
    f.search = "holiday";
    res = runFilters(list, f);
    assert.equal(res.shown.length, 0);
    const sec = facetOptions("section", res.counts, f, buildPeople(list));
    assert.deepEqual(sec.map((o) => [o.label, o.count, o.state]), [[NO_SECTION, 1, ""], ["Manage Users", 0, "include"]]);
    // include and hide are exclusive; "only" replaces the choice; choosing twice clears
    const g = emptyFilters();
    toggleChoice(g, "kind", "include", "a");
    toggleChoice(g, "kind", "exclude", "a");
    assert.deepEqual([[...g.kind.inc], [...g.kind.exc]], [[], ["a"]]);
    toggleChoice(g, "kind", "include", "b");
    toggleChoice(g, "kind", "only", "c");
    assert.deepEqual([[...g.kind.inc], [...g.kind.exc]], [["c"], ["a"]]);
    toggleChoice(g, "kind", "include", "c");
    assert.equal(g.kind.inc.size, 0);
  });

  await test("audit: no section and no user are real choices with plain names", () => {
    const list = mix();
    const people = buildPeople(list);
    const res = runFilters(list, emptyFilters());
    assert.equal(facetOptions("section", res.counts, emptyFilters(), people).find((o) => o.key === "").label, NO_SECTION);
    assert.equal(facetOptions("person", res.counts, emptyFilters(), people).find((o) => o.key === "").label, NO_USER);
    assert.ok(!/automat/i.test(NO_USER), "it does not claim the change was automated");
    const f = emptyFilters();
    toggleChoice(f, "person", "include", "");
    assert.equal(runFilters(list, f).shown.length, 1);
    toggleChoice(f, "person", "include", "");
    toggleChoice(f, "section", "include", "");
    assert.equal(runFilters(list, f).shown.length, 2);
  });

  await test("audit: two people with one name are told apart by username, one person is not", () => {
    const people = buildPeople(mix());
    assert.equal(people.get(U1).label, "Alex Example");
    assert.equal(people.get(U2).label, "Sam Rivera (sam.rivera@example.com)");
    assert.equal(people.get(U3).label, "Sam Rivera (sam.rivera2@example.com)");
    assert.equal(people.get("").label, NO_USER);
    const lone = buildPeople(entriesOf([rec(1, "2026-11-25T10:00:00Z", { CreatedById: U2, CreatedBy: null })]));
    assert.equal(lone.get(U2).label, `A user you can't see (${U2})`);
  });

  await test("audit: the delegate and managed package ticks narrow the list", () => {
    const list = mix();
    const f = emptyFilters();
    f.delegateOnly = true;
    assert.deepEqual(runFilters(list, f).shown.map((e) => e.delegate), ["boss@example.com"]);
    f.delegateOnly = false;
    f.packageOnly = true;
    assert.deepEqual(runFilters(list, f).shown.map((e) => e.namespace), ["acme"]);
    f.delegateOnly = true;
    assert.equal(runFilters(list, f).shown.length, 0);
  });

  await test("audit: facet search narrows the options by label, code or username", () => {
    const list = mix();
    const people = buildPeople(list);
    const f = emptyFilters();
    const res = runFilters(list, f);
    assert.deepEqual(facetOptions("kind", res.counts, f, people, "fls").map((o) => o.key), ["PermSetFlsChanged"]);
    assert.deepEqual(facetOptions("kind", res.counts, f, people, "changeduser").map((o) => o.key), ["changedUserEmail"]);
    assert.equal(facetOptions("person", res.counts, f, people, "rivera2").length, 1);
    assert.equal(facetOptions("person", res.counts, f, people, "sam").length, 2);
  });

  await test("audit: filters show as chips, each chip removes its own filter, Clear filters removes all", () => {
    const list = mix();
    const people = buildPeople(list);
    const f = emptyFilters();
    assert.equal(hasFilters(f), false);
    f.search = " perm ";
    toggleChoice(f, "kind", "exclude", "changedUserEmail");
    toggleChoice(f, "person", "include", U2);
    f.delegateOnly = true;
    f.packageOnly = true;
    const chips = filterChips(f, people);
    assert.deepEqual(chips.map((c) => c.text), [
      "Search: perm", "Hiding kind of change: Changed User Email", "Person: Sam Rivera (sam.rivera@example.com)",
      "Only entries that have a delegate user", "Only changes from a managed package"]);
    for (const c of chips) removeChip(f, c.remove);
    assert.equal(hasFilters(f), false);
    f.search = "x";
    toggleChoice(f, "section", "include", "Manage Users");
    clearFilters(f);
    assert.equal(hasFilters(f), false);
    assert.ok(f.section.inc instanceof Set);
  });

  // ===== sorting =====

  await test("audit: sorting is stable, newest first by default, and ties keep Salesforce's order", () => {
    const same = "2026-11-25T10:00:00Z";
    const list = entriesOf([rec(1, same, { Display: "b" }), rec(2, same, { Display: "a" }), rec(3, "2026-11-25T09:00:00Z", { Display: "c" }), rec(4, same, { Display: "a" })]);
    const seqs = (l) => l.map((e) => e.seq);
    assert.deepEqual(seqs(sortEntries(list)), [0, 1, 3, 2]);
    assert.deepEqual(seqs(sortEntries(list, "when", "asc")), [2, 0, 1, 3], "oldest first, the same second still in Salesforce's order");
    assert.deepEqual(seqs(sortEntries(list, "what", "asc")), [1, 3, 0, 2]);
    assert.deepEqual(seqs(sortEntries(list, "what", "desc")), [2, 0, 1, 3]);
    assert.equal(list[0].seq, 0, "the list given is not changed");
    const people = entriesOf([rec(1, same, { CreatedBy: { Name: "zed", Username: "z" } }), rec(2, same, { CreatedBy: { Name: "Amy", Username: "a" } }), rec(3, same, { CreatedBy: null, CreatedById: null })]);
    assert.deepEqual(seqs(sortEntries(people, "who", "asc")), [1, 0, 2], "no user recorded sorts last");
    assert.deepEqual(seqs(sortEntries(people, "who", "desc")), [0, 1, 2]);
    assert.deepEqual(seqs(sortEntries(people, "section", "asc")), [0, 1, 2]);
    assert.deepEqual(seqs(sortEntries(people, "kind", "desc")), [0, 1, 2]);
  });

  await test("audit: the time span uses loops, ignores unknown times", () => {
    const span = timeSpan(entriesOf([rec(1, "2026-11-25T10:00:00Z"), rec(2, "2026-11-20T10:00:00Z", { CreatedDate: "bad" }), rec(3, "2026-11-22T10:00:00Z")]));
    assert.deepEqual(span, { min: Date.parse("2026-11-22T10:00:00Z"), max: Date.parse("2026-11-25T10:00:00Z") });
    assert.deepEqual(timeSpan([]), { min: null, max: null });
  });

  // ===== honest wording =====

  await test("audit: a list that is not the whole period always says so, with the counts, the date it goes back to and what to do", () => {
    const oldest = Date.parse("2026-11-02T14:03:00Z");
    const capped = partialNote({ status: "capped", read: 50000, total: 287988, oldestMs: oldest, cap: 50000 }, "UTC");
    assert.match(capped, /50,000 of 287,988 entries/);
    assert.match(capped, /going back to 2026-11-02 14:03:00/);
    assert.match(capped, /at most 50,000/);
    assert.match(capped, /shorter period, or only one person/);
    const stopped = partialNote({ status: "stopped", read: 4000, total: 18125, oldestMs: oldest, cap: 50000 }, "UTC");
    assert.match(stopped, /You stopped the read/);
    assert.match(stopped, /4,000 of 18,125 entries/);
    const failed = partialNote({ status: "failed", read: 6000, total: 18125, oldestMs: oldest, cap: 50000 }, "UTC");
    assert.match(failed, /stopped part way/);
    assert.match(failed, /6,000 of 18,125/);
    const noTotal = partialNote({ status: "failed", read: 6000, total: null, oldestMs: oldest, cap: 50000 }, "UTC");
    assert.match(noTotal, /6,000 entries \(the total is not known\)/);
    assert.match(partialNote({ status: "short", read: 90, total: 100, oldestMs: oldest, cap: 50000 }, "UTC"), /counted more entries than it returned/);
    assert.equal(partialNote({ status: "complete", read: 5, total: 5 }), null);
    assert.equal(partialNote(null), null);
    for (const s of ["capped", "stopped", "failed", "short"]) assert.ok(!/\bcomplete\b|\bwhole period\b|\ball entries\b/i.test(partialNote({ status: s, read: 1, total: 9, oldestMs: oldest, cap: 5 }, "UTC").replace("not the whole period", "")), s);
  });

  await test("audit: the status line, the empty texts and the progress text", () => {
    assert.equal(statusLine(37, 18125, { status: "complete" }), "Showing 37 of 18,125 entries read");
    assert.equal(statusLine(1, 1, { status: "complete" }), "Showing 1 of 1 entry read");
    assert.match(statusLine(37, 18125, { status: "capped" }), /^Showing 37 of 18,125 entries read \(not the whole period/);
    assert.equal(emptyText({ read: 0, partial: false, filtered: false }), "No entries in this period.");
    assert.match(emptyText({ read: 0, partial: true, filtered: false }), /Only part of the period was read/);
    assert.match(emptyText({ read: 40, partial: false, filtered: true }), /hide all 40 entries read.*Clear the filters/);
    const p = emptyText({ read: 40, partial: true, filtered: true });
    assert.match(p, /0 found/);
    assert.match(p, /only part of the period was read/);
    assert.equal(progressText(4000, 18125), "Reading... 4,000 of 18,125 entries");
    assert.equal(progressText(4000, null), "Reading... 4,000 entries");
  });

  // ===== the reader =====

  await test("audit: the reader counts, then pages in order, reporting progress as rows arrive", async () => {
    const recs = records(25);
    const api = fakeApi(recs, { pageSize: 10 });
    const progress = [];
    const totals = [];
    const batches = [];
    const res = await readAuditTrail(api, {}, { onTotal: (t) => totals.push(t), onPage: (b, n) => { progress.push(n); batches.push(b.length); } });
    assert.deepEqual([res.status, res.read, res.total], ["complete", 25, 25]);
    assert.deepEqual(totals, [25]);
    assert.deepEqual(progress, [10, 20, 25]);
    assert.deepEqual(batches, [10, 10, 5]);
    assert.ok(decodeURIComponent(api.log[0]).includes("SELECT COUNT() FROM SetupAuditTrail"));
    assert.ok(decodeURIComponent(api.log[1]).includes("ORDER BY CreatedDate DESC, Id DESC"));
    assert.ok(api.log[2].includes("/query/01g-10") && api.log[3].includes("/query/01g-20"));
    const got = [];
    await readAuditTrail(fakeApi(recs, { pageSize: 10 }), {}, { onPage: (b) => b.forEach((e) => got.push(e.seq)) });
    assert.deepEqual(got, Array.from({ length: 25 }, (_, i) => i), "entries carry Salesforce's order");
  });

  await test("audit: stopping keeps what was read and says it was stopped", async () => {
    const control = {};
    const kept = [];
    const res = await readAuditTrail(fakeApi(records(100), { pageSize: 10 }), {}, { control, onPage: (b, n) => { kept.push(...b); if (n === 30) control.stop = true; } });
    assert.deepEqual([res.status, res.read, kept.length], ["stopped", 30, 30]);
  });

  await test("audit: the cap keeps the newest entries and says the list is capped", async () => {
    assert.equal(MAX_ENTRIES, 50000);
    const recs = records(95);
    const kept = [];
    const res = await readAuditTrail(fakeApi(recs, { pageSize: 40 }), {}, { max: 50, onPage: (b) => kept.push(...b) });
    assert.deepEqual([res.status, res.read, res.total, kept.length], ["capped", 50, 95, 50]);
    assert.deepEqual(kept.map((e) => e.id), recs.slice(0, 50).map((r) => r.Id), "the newest 50, in order");
    const exact = await readAuditTrail(fakeApi(records(50), { pageSize: 25 }), {}, { max: 50 });
    assert.deepEqual([exact.status, exact.read], ["complete", 50], "exactly the cap and nothing more is complete");
    const onEdge = await readAuditTrail(fakeApi(records(80), { pageSize: 50 }), {}, { max: 50 });
    assert.deepEqual([onEdge.status, onEdge.read], ["capped", 50], "a page that ends on the cap with more behind it is capped");
  });

  await test("audit: a page that fails part way keeps the rows already read and says why in plain words", async () => {
    const kept = [];
    const res = await readAuditTrail(fakeApi(records(100), { pageSize: 10, failPage: 4, failWith: Object.assign(new TypeError("Failed to fetch")) }), {}, { onPage: (b) => kept.push(...b) });
    assert.deepEqual([res.status, res.read, kept.length], ["failed", 30, 30]);
    assert.match(res.problem.message, /connection to Salesforce was lost/);
    assert.equal(res.problem.raw, "Failed to fetch");
    const first = await readAuditTrail(fakeApi(records(10), { failPage: 1, failWith: Object.assign(new Error("denied"), { status: 403, errorCode: "INSUFFICIENT_ACCESS" }) }), {});
    assert.deepEqual([first.status, first.read], ["failed", 0]);
    assert.match(first.problem.message, /View Setup and Configuration/);
  });

  await test("audit: a failed COUNT still lets the read work, without a total", async () => {
    const res = await readAuditTrail(fakeApi(records(15), { pageSize: 10, failCount: true }), {});
    assert.deepEqual([res.status, res.read, res.total], ["complete", 15, null]);
    const progress = [];
    await readAuditTrail(fakeApi(records(15), { pageSize: 10, failCount: true }), {}, { onPage: (b, n) => progress.push(progressText(n, null)) });
    assert.deepEqual(progress, ["Reading... 10 entries", "Reading... 15 entries"]);
  });

  await test("audit: a read that gets fewer entries than were counted is 'short', never complete", async () => {
    const api = fakeApi(records(10), { pageSize: 10 });
    const orig = api.get;
    api.get = async (p) => { const r = await orig.call(api, p); return /COUNT/.test(decodeURIComponent(p)) ? { ...r, totalSize: 12 } : r; };
    const res = await readAuditTrail(api, {}, {});
    assert.deepEqual([res.status, res.read, res.total], ["short", 10, 12]);
  });

  await test("audit: a newer read cancels an older one still running: stale pages never arrive", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const oldCtl = {};
    const seen = [];
    const oldApi = fakeApi(records(100), { pageSize: 10, hold: async (p) => { if (p.includes("01g-10")) await gate; } });
    const oldRead = readAuditTrail(oldApi, {}, { control: oldCtl, onPage: (b, n) => seen.push(["old", n]) });
    await new Promise((r) => setTimeout(r, 20));
    oldCtl.cancel = true; // what the page does when a new read starts
    const newRead = await readAuditTrail(fakeApi(records(20), { pageSize: 10 }), {}, { control: {}, onPage: (b, n) => seen.push(["new", n]) });
    release();
    const old = await oldRead;
    assert.equal(old.status, "cancelled");
    assert.equal(newRead.status, "complete");
    assert.deepEqual(seen.filter((s) => s[0] === "old"), [["old", 10]], "nothing from the old read after it was cancelled");
    const before = await readAuditTrail(fakeApi(records(5)), {}, { control: { cancel: true } });
    assert.equal(before.status, "cancelled");
  });

  await test("audit: a bad person Id is refused before anything is sent", async () => {
    const api = fakeApi(records(5));
    await assert.rejects(readAuditTrail(api, { userId: "x' OR 1=1" }, {}), /not a user Id/);
    assert.equal(api.log.length, 0);
  });

  await test("audit: errors are put in plain words with the raw text kept apart", () => {
    const sess = plainProblem(Object.assign(new Error("Your Salesforce session has expired. Reload the Salesforce tab, then try again."), { status: 401, detail: "Session expired or invalid" }));
    assert.match(sess.message, /session has expired/);
    assert.equal(sess.raw, "Session expired or invalid");
    assert.match(plainProblem(Object.assign(new Error("x"), { status: 403 })).message, /View Setup and Configuration/);
    const gone = plainProblem(Object.assign(new Error("sObject type 'SetupAuditTrail' is not supported."), { status: 400, errorCode: "INVALID_TYPE" }));
    assert.match(gone.message, /not available/);
    assert.match(gone.raw, /SetupAuditTrail/);
    assert.match(plainProblem(new TypeError("Failed to fetch")).message, /connection to Salesforce was lost/);
    const other = plainProblem(Object.assign(new Error("UNKNOWN_EXCEPTION: boom"), { status: 500 }));
    assert.match(other.message, /Could not read the Setup Audit Trail/);
    assert.ok(!other.message.includes("boom"));
  });

  await test("audit: the real client sends only GET requests and never a body", async () => {
    const calls = [];
    const api = new SfApi({ apiHost: "acme.my.salesforce.com", sessionId: "S", fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      const q = new URL(url).searchParams.get("q") || "";
      const body = /COUNT\(\)/.test(q) ? { done: true, totalSize: 1, records: [] } : { done: true, totalSize: 1, records: [rec(1, "2026-11-25T10:00:00Z")] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    } });
    const res = await readAuditTrail(api, { from: new Date("2026-11-18T00:00:00Z"), userId: U1 });
    assert.equal(res.read, 1);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.ok(c.opts.method === undefined || c.opts.method === "GET");
      assert.equal(c.opts.body, undefined);
      assert.ok(c.url.startsWith("https://acme.my.salesforce.com/services/data/v67.0/query/?q="));
      assert.ok(/^SELECT /.test(decodeURIComponent(new URL(c.url).searchParams.get("q"))));
    }
  });

  // ===== copy and CSV =====

  const ctxOf = (o = {}) => ({ periodDetail: "Last 7 days, from 2026-11-18 09:00:00 until now", who: null, tz: "UTC", filters: emptyFilters(), people: new Map(), cov: { status: "complete", read: 3, total: 3 }, ...o });

  await test("audit: copy for a ticket has the time in both zones, who, what, and the extra facts only when present", () => {
    const e = entryFromRecord(rec(1, "2026-11-25T19:03:07Z", { Display: "Changed Region__c", DelegateUser: "boss@example.com", ResponsibleNamespacePrefix: "acme" }), 0);
    const t = ticketText(e, { orgName: "Demo org", tz: "America/New_York" });
    assert.equal(t, [
      "Setup Audit Trail entry", "Org: Demo org", "When: 2026-11-25 14:03:07 (America/New_York), 2026-11-25 19:03:07 UTC",
      "Who: Alex Example (alex@example.com)", "Section: Permission Sets", "Kind of change: Perm Set Fls Changed (PermSetFlsChanged)",
      "What changed: Changed Region__c", "Delegate user: boss@example.com", "Source namespace prefix: acme"].join("\n"));
    const bare = ticketText(entryFromRecord(rec(2, "2026-11-25T19:03:07Z", { Section: null, CreatedById: null, CreatedBy: null }), 0), { tz: "UTC" });
    assert.ok(bare.includes(`Section: ${NO_SECTION}`) && bare.includes(`Who: ${NO_USER}`));
    assert.ok(!/Made on behalf|namespace|Org:/.test(bare));
  });

  await test("audit: copy what is shown gives at most 100 entries and says so when there are more", () => {
    const many = entriesOf(records(250));
    const t = shownText(many, ctxOf({ cov: { status: "complete", read: 250, total: 250 } }));
    assert.equal(COPY_LIMIT, 100);
    assert.match(t, /250 entries match\. This text has the first 100; use the CSV download for all of them\./);
    assert.equal(t.split("\n").filter((l) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \| /.test(l)).length, 100);
    const few = shownText(many.slice(0, 3), ctxOf());
    assert.match(few, /3 entries match\./);
    assert.ok(!/first 100/.test(few));
    assert.ok(few.includes("Period: Last 7 days") && few.includes("Time zone: UTC") && few.includes("Person searched for: Everyone") && few.includes("Search and filters: none"));
    const part = shownText(many.slice(0, 3), ctxOf({ cov: { status: "capped", read: 3, total: 9, oldestMs: Date.parse("2026-11-25T10:00:00Z"), cap: 3 } }));
    assert.match(part, /NOTE: Only part of this period is shown: the newest 3 of 9 entries/);
  });

  await test("audit: the CSV states the period, zone, person and filters, carries the partial warning as a note row, and every row given", () => {
    const f = emptyFilters();
    f.search = "region";
    toggleChoice(f, "kind", "exclude", "changedUserEmail");
    const list = entriesOf(records(400, (i) => (i === 3 ? { Display: "=HYPERLINK(\"http://example.com\")" } : i === 4 ? { Display: "<img src=x onerror=alert(1)>" } : i === 5 ? { Section: null, CreatedById: null, CreatedBy: null } : {})));
    const cov = { status: "capped", read: 400, total: 900, oldestMs: Date.parse("2026-11-25T05:00:00Z"), cap: 400 };
    const rows = csvRows(list, ctxOf({ filters: f, people: buildPeople(list), who: { person: { id: U1, name: "Alex Example", username: "alex@example.com", email: "" }, choice: "by" }, cov, tz: "America/New_York" }));
    const flat = rows.map((r) => r.join(" | "));
    assert.ok(flat.some((l) => l.startsWith("Period | Last 7 days")));
    assert.ok(flat.includes("Time zone | America/New_York"));
    assert.ok(flat.includes("Person searched for | Alex Example (alex@example.com)"));
    assert.ok(flat.includes("What to find | Changes made by them"));
    assert.ok(flat.some((l) => l.startsWith("Search and filters | Search: region; Hiding kind of change: Changed User Email")));
    assert.ok(flat.includes("Entries read | 400 of 900"));
    assert.ok(flat.some((l) => l.startsWith("Note | Only part of this period is shown: the newest 400 of 900 entries")));
    const head = rows.findIndex((r) => r[0] === CSV_HEADER[0]);
    assert.deepEqual(rows[head], CSV_HEADER_WITH_HOW, "a person is picked, so there is a How it matched column");
    assert.equal(rows.length - head - 1, 400, "every row given, not only the drawn 200");
    assert.equal(rows[head + 1][0], "2026-11-25 07:00:00");
    assert.equal(rows[head + 1][1], "2026-11-25 12:00:00 UTC");
    const csv = toCsv(rows);
    assert.ok(csv.startsWith("\uFEFF"));
    assert.ok(csv.includes("'=HYPERLINK("), "a text that starts with = is guarded");
    assert.ok(csv.includes("<img src=x onerror=alert(1)>"), "markup is only text");
    assert.ok(csv.includes(NO_SECTION) && csv.includes(NO_USER));
    const whole = csvRows(list.slice(0, 2), ctxOf());
    assert.ok(!whole.some((r) => r[0] === "Note"), "no note when the whole period was read");
  });

  // ===== speed =====

  await test("audit: 50,000 entries filter, count and sort within a reasonable time", () => {
    const base = Date.parse("2026-11-25T12:00:00Z");
    const kinds = ["PermSetFlsChanged", "changedUserEmail", "createdCustomField", "changedProfilePerm", "insertedApexClass"];
    const recs = Array.from({ length: 50000 }, (_, i) => rec(i + 1, new Date(base - i * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), {
      Action: i % 2 ? "PermSetFlsChanged" : kinds[i % 5], Display: `Changed field Field_${i % 977}__c on set Set_${i % 31} (${i})`, CreatedById: `005${String(i % 40).padStart(12, "0")}AAA`,
      CreatedBy: { Name: `User ${i % 40}`, Username: `u${i % 40}@example.com` }, Section: i % 7 ? `Section ${i % 9}` : null,
    }));
    const t0 = Date.now();
    const list = entriesOf(recs);
    const tBuild = Date.now() - t0;
    const f = emptyFilters();
    f.search = 'field_5__c "set_3" -"user 7"';
    let res;
    const t1 = Date.now();
    for (let i = 0; i < 5; i++) res = runFilters(list, f);
    const tFilter = (Date.now() - t1) / 5;
    assert.ok(res.shown.length > 0);
    f.search = "";
    toggleChoice(f, "kind", "exclude", "PermSetFlsChanged");
    const t2 = Date.now();
    const all = runFilters(list, f);
    const sorted = sortEntries(all.shown, "what", "asc");
    const tSort = Date.now() - t2;
    assert.equal(sorted.length, all.shown.length);
    const t3 = Date.now();
    const csv = toCsv(csvRows(sorted, ctxOf()));
    const tCsv = Date.now() - t3;
    assert.ok(csv.length > 1000);
    console.log(`       (50,000 entries: build ${tBuild} ms, one filter ${Math.round(tFilter)} ms, filter and sort ${tSort} ms, CSV of ${sorted.length} ${tCsv} ms)`);
    assert.ok(tFilter < 1000, `a filter took ${tFilter} ms`);
    assert.ok(tBuild < 5000 && tSort < 5000 && tCsv < 10000, `${tBuild} ${tSort} ${tCsv}`);
  });

  // ===== the demo =====

  await test("audit: the demo file is synthetic and has what the brief asks for", () => {
    const d = demo();
    assert.ok(d.entries.length >= 450, `${d.entries.length} entries`);
    const days = (Math.max(...d.entries.map((e) => e.secondsAgo)) - Math.min(...d.entries.map((e) => e.secondsAgo))) / 86400;
    assert.ok(days >= 30, `${days} days`);
    const e = d.entries;
    assert.ok(e.some((x) => x.section === null) && e.some((x) => x.userId === null) && e.some((x) => x.delegate) && e.some((x) => x.namespace));
    const counts = {};
    for (const x of e) counts[x.action] = (counts[x.action] || 0) + 1;
    assert.ok(Math.max(...Object.values(counts)) / e.length >= 0.4, "one noisy kind");
    assert.ok(e.some((x) => x.display.length > 1600), "a very long sentence");
    assert.ok(e.some((x) => x.display.startsWith("=")) && e.some((x) => /<img src=x onerror=/.test(x.display)));
    const secs = new Map();
    for (const x of e) secs.set(x.secondsAgo, (secs.get(x.secondsAgo) || 0) + 1);
    assert.ok([...secs.values()].some((n) => n >= 3), "several entries in one second");
    const names = d.users.map((u) => u.name);
    assert.ok(names.some((n, i) => names.indexOf(n) !== i), "two users share a name");
    assert.ok(new Set(d.users.map((u) => u.id.slice(0, 15))).size === d.users.length);
    assert.ok(new Set(e.map((x) => x.id)).size === e.length, "entry Ids are unique");
    const text = read(ext("samples", "audit_trail_demo.json"));
    assert.ok(!/@(?!example\.com)[a-z0-9-]+\.[a-z]{2,}/i.test(text.replace(/<img src=x onerror=alert\(1\)>/g, "")), "only example.com addresses");
    assert.ok(!/00D[A-Za-z0-9]{12}|sessionId|access_token/.test(text));
  });

  await test("audit: the demo is dated from the moment it is opened, deterministically, and flows through the same reader", async () => {
    const d = demo();
    const now = new Date("2026-11-25T12:00:30.789Z");
    const a = demoRecords(d, now);
    assert.deepEqual(a, demoRecords(d, now));
    assert.ok(a[0].CreatedDate >= a[a.length - 1].CreatedDate, "newest first");
    const sevenDays = periodBounds("7d", now);
    const api = demoApi(a, { pageSize: 100 });
    const pages = [];
    const res = await readAuditTrail(api, { from: sevenDays.from, to: null, userId: "" }, { onPage: (b, n) => pages.push(n) });
    assert.equal(res.status, "complete");
    assert.ok(res.read > 50 && res.read < d.entries.length, `${res.read} entries in 7 days`);
    assert.equal(res.total, res.read);
    assert.ok(pages.length >= 1);
    const all = await readAuditTrail(demoApi(a, { pageSize: 100 }), {}, {});
    assert.equal(all.read, d.entries.length);
    const alex = d.users[0];
    const one = await readAuditTrail(demoApi(a), { userId: alex.id }, {});
    assert.equal(one.read, d.entries.filter((x) => x.userId === alex.id).length);
    // the search the brief asks for: every change about one set, with who and when
    const got = [];
    await readAuditTrail(demoApi(a), {}, { onPage: (b) => got.push(...b) });
    const f = emptyFilters();
    f.search = "My_Set Region__c";
    const hits = runFilters(got, f).shown;
    assert.ok(hits.length >= 7 && hits.every((x) => /my_set/i.test(x.display) && /region__c/i.test(x.display)));
  });

  await test("audit: copyWithFallback answers plainly when copying is blocked", async () => {
    assert.deepEqual(await copyWithFallback("x", { writeText: async () => {} }), { copied: true });
    assert.deepEqual(await copyWithFallback("x", { writeText: async () => { throw new Error("blocked"); } }), { copied: false });
    assert.deepEqual(await copyWithFallback("x", undefined), { copied: false });
  });

  // ===== the person: query, matching, what to find =====

  // Ids that differ inside their first 15 characters (and use capitals, so the checksum matters).
  const R15 = "005Dm000003Kq1v";
  const R18 = sfId18(R15);
  const R2_15 = "005Dm000003Kq9z";
  const H15 = "005Dm000003Hd8q";
  const riley = { id: R18, name: "Riley Quinn", username: "riley.quinn@example.com.uat", email: "riley.quinn@example.com" };
  const how = (display, person = riley) => matchMadeTo(display, personMatcher(person))?.how ?? null;

  await test("audit: the Id checksum goes both ways, and an ordinary word is not an Id", () => {
    assert.equal(sfId18("000000000000001"), "000000000000001AAA");
    assert.equal(sfId18("Aa0000000000000"), "Aa0000000000000BAA", "a capital at place 1 of the first five sets bit 0");
    assert.equal(sfId18("00000000000000A"), "00000000000000AAAQ", "a capital at place 5 of the third five sets bit 4");
    assert.equal(sfId18("short"), "");
    assert.ok(isSalesforceId(R15) && isSalesforceId(R18) && isSalesforceId("0PSDm000000AbCd") && !isSalesforceId(R18.slice(0, 15) + "AAA") && !isSalesforceId("abc"));
    assert.equal(pastedUserId(R18), R18);
    assert.equal(pastedUserId(R15), R15);
    assert.equal(pastedUserId("001Dm000003Kq1v"), "", "not a user Id");
    assert.equal(pastedUserId(`${R15}AAA`), "", "wrong checksum");
    // the search box: an 18 character Id also finds its 15 character form, for any object
    const other18 = sfId18("0PSDm000000AbCd");
    assert.deepEqual(idAlternates(R18), [R15.toLowerCase()]);
    assert.deepEqual(idAlternates(other18), ["0psdm000000abcd"]);
    assert.equal(idAlternates("0PSDm000000AbCdXYZ"), null, "wrong checksum: left alone");
    assert.equal(idAlternates("abcdefghijklmnopqr"), null, "18 letters, no digit");
    assert.equal(idAlternates("abcdefghijklmno"), null, "an ordinary 15-letter word");
    assert.equal(parseSearch("administration").alts, undefined);
    const hay15 = `assigned (userid: [${R15}])`.toLowerCase();
    const hay18 = `changed from ${R18} to x`.toLowerCase();
    assert.ok(searchMatches(parseSearch(R18), hay15), "18 finds 15");
    assert.ok(searchMatches(parseSearch(R15), hay18), "15 finds 18");
    assert.ok(searchMatches(parseSearch(other18), "object 0psdm000000abcd here"));
    assert.ok(!searchMatches(parseSearch(R18), "nothing about it"));
    assert.ok(!searchMatches(parseSearch(`-${R18}`), hay15), "leaving an Id out leaves out its other form too");
    assert.ok(searchMatches(parseSearch(`-${R18}`), "unrelated"));
    assert.deepEqual(highlightParts(`id ${R15} end`, parseSearch(R18)).filter((p) => p.hit).map((p) => p.text), [R15]);
    // the maker's Id is searchable
    const e = entryFromRecord(rec(1, "2026-11-25T10:00:00Z", { CreatedById: R18, CreatedBy: null }), 0);
    assert.ok(searchMatches(parseSearch(R15), e.hay) && searchMatches(parseSearch(R18), e.hay));
  });

  await test("audit: the query for each choice: made by uses the Id and the username, everything else reads without a person", () => {
    const from = new Date("2026-11-18T05:00:00Z");
    const by = readFor({ person: { id: R18, username: "o'brien\\x@example.com" }, choice: "by" });
    assert.deepEqual([by.userId, by.delegateUser, by.cover.kind], [R18, "o'brien\\x@example.com", "by"]);
    const q = buildQuery({ from, userId: by.userId, delegateUser: by.delegateUser });
    assert.ok(q.includes(`AND (CreatedById = '${R18}' OR DelegateUser = 'o\\'brien\\\\x@example.com')`), q);
    assert.equal(buildCountQuery({ from, userId: R18, delegateUser: "a@example.com" }), `SELECT COUNT() FROM SetupAuditTrail WHERE CreatedDate >= 2026-11-18T05:00:00Z AND (CreatedById = '${R18}' OR DelegateUser = 'a@example.com')`);
    assert.equal(buildWhere({ userId: U1 }), ` WHERE CreatedById = '${U1}'`, "no username known: just the maker, as before");
    assert.equal(buildWhere({ userId: U1, delegateUser: "" }), ` WHERE CreatedById = '${U1}'`);
    assert.throws(() => buildWhere({ userId: "x' OR 1=1", delegateUser: "a@example.com" }), /not a user Id/);
    assert.ok(!/Section|Display/.test(q.slice(q.indexOf(" WHERE "), q.indexOf(" ORDER BY"))));
    for (const choice of ["to", "either"]) {
      const r = readFor({ person: { id: R18, username: "a@example.com" }, choice });
      assert.deepEqual([r.userId, r.delegateUser, r.cover], ["", "", { kind: "all" }], choice);
    }
    assert.deepEqual(readFor(null).cover, { kind: "all" });
  });

  await test("audit: the read follows the Id and the delegate username (demo org), case does not matter for the username", async () => {
    const d = demo();
    const recs = demoRecords(d, new Date("2026-11-25T12:00:00Z"));
    const casey = d.users[0];
    const got = [];
    await readAuditTrail(demoApi(recs), { userId: casey.id, delegateUser: casey.username.toUpperCase() }, { onPage: (b) => got.push(...b) });
    const asMaker = got.filter((e) => e.userId === casey.id);
    const asDelegate = got.filter((e) => e.userId !== casey.id);
    assert.equal(asMaker.length, d.entries.filter((x) => x.userId === casey.id).length);
    assert.ok(asDelegate.length >= 3 && asDelegate.every((e) => e.delegate.toLowerCase() === casey.username), "entries made while logged in as someone");
    const onlyId = [];
    await readAuditTrail(demoApi(recs), { userId: casey.id }, { onPage: (b) => onlyId.push(...b) });
    assert.equal(onlyId.length, asMaker.length);
  });

  await test("audit: made to them matches by Id, in a whole token, first 15 characters exactly", () => {
    assert.equal(how(`assigned to user Someone (UserID: [${R15}])`), "id");
    assert.equal(how(`Changed owner from ${R18} to 005Dm000003Lm2aIAC`), "id", "18 characters, no name");
    assert.equal(how(`Changed owner from ${R15}AAA to x`), "id", "the first 15 are what is compared");
    assert.equal(how(`Riley Quinn (User, ${R15}) added to group`), "id");
    assert.equal(how("owner 005dm000003kq1v"), null, "Ids are case-sensitive in the first 15");
    assert.equal(how(`x${R15}`), null, "not a whole token");
    assert.equal(how(`${R15}x`), null);
    assert.equal(how(`${R15}AB`), null, "17 characters is not an Id");
    assert.equal(how(`${R18}_x`), null);
    assert.equal(how(`from ${R2_15} to ${H15}`), null, "other people's Ids");
    assert.equal(how(`Changed owner to ${R15}`, { id: R15, name: "", username: "" }), "id", "the Id itself as the person");
    assert.equal(how("Riley Quinn", { id: R15, name: "", username: "" }), null, "an Id-only person has no name to match");
  });

  await test("audit: made to them matches a username or an email as a whole address, and the near misses stay out", () => {
    const ann = { id: "", name: "", username: "ann@x.com", email: "" };
    assert.equal(how("Changed username for ann@x.com to ann2@x.com", ann), "username");
    assert.equal(how("Changed ANN@X.COM again", ann), "username");
    assert.equal(how("(ann@x.com)", ann), "username");
    assert.equal(how("Changed email to ann@x.com.", ann), "username", "a full stop that ends the sentence");
    assert.equal(how("sent to ann@x.com, then", ann), "username");
    assert.equal(how("joann@x.com", ann), null);
    assert.equal(how("x.ann@x.com", ann), null);
    assert.equal(how("ann@x.com.uat", ann), null);
    assert.equal(how("ann@x.comx", ann), null);
    assert.equal(how("ann@x.com_old", ann), null);
    assert.equal(how("ann@x.com.invalid", ann), "username", "a sandbox may add .invalid");
    assert.equal(how("ann@x.com", { ...ann, username: "ann@x.com.invalid" }), "username", "or drop it");
    assert.equal(how("ann@x.com.uat", { ...ann, username: "ann@x.com.invalid" }), null);
    assert.equal(how("to riley.quinn@example.com now"), "email");
    assert.equal(how("to riley.quinn@example.com.uat now"), "username");
    assert.equal(how("to riley.quinn@example.com.invalid now"), "email");
    assert.equal(how("to briley.quinn@example.com.uat now"), null);
    assert.equal(how("to riley.quinn@example.com.uat.old now"), null);
    assert.equal(how("a@b.com", { id: "", name: "", username: "", email: "" }), null);
  });

  await test("audit: made to them matches a full name as whole words, in Unicode, with apostrophes and hyphens", () => {
    assert.equal(how("Changed title for Riley Quinn to Analyst"), "name");
    assert.equal(how("changed title for RILEY   QUINN."), "name", "any case, collapsed spaces");
    assert.equal(how("Changed title for Riley Quinn's team"), "name");
    assert.equal(how("Rileys Quinn"), null);
    assert.equal(how("Riley Quinnton"), null);
    assert.equal(how("xRiley Quinn"), null);
    assert.equal(how("Riley Quinn-Smith"), null, "a longer hyphenated name is somebody else");
    assert.equal(how("Mary-Riley Quinn"), null);
    assert.equal(how("Riley"), null, "first name only is not the full name");
    const zoe = { id: sfId18("005Dm000003Nz4b"), name: "Zoë O'Brien-Núñez", username: "", email: "" };
    assert.equal(how("Role for Zoë O'Brien-Núñez changed", zoe), "name");
    assert.equal(how("Role for Zoë O’Brien-Núñez changed", zoe), "name", "a curly apostrophe");
    assert.equal(how("Role for ZOË o'brien‐nÚÑez changed", zoe), "name", "capitals and another hyphen");
    assert.equal(how("Role for Zoe\u0308 O'Brien-Nu\u0301n\u0303ez changed", zoe), "name", "letters with separate accent marks");
    assert.equal(how("Role for Zoe OBrien-Nunez changed", zoe), null);
    assert.equal(how("Role for Émilie García", { id: "", name: "Émilie García", username: "", email: "" }), "name");
    assert.equal(how("Role for Émilie Garcías", { id: "", name: "Émilie García", username: "", email: "" }), null, "an accented letter counts as a letter at the edge");
    // short or empty names are never matched by name
    for (const name of ["", "   ", "Al", "Eve", "Bo"]) assert.equal(how("Changed Al and Eve and Bo", { id: "", name, username: "", email: "" }), null, `[${name}]`);
    assert.equal(how("Changed Cher today", { id: "", name: "Cher", username: "", email: "" }), "name", "four characters is enough for one word");
    assert.equal(how("Changed Al Li today", { id: "", name: "Al Li", username: "", email: "" }), "name", "two words are fine however short");
    // the strongest way wins
    assert.equal(how(`Riley Quinn riley.quinn@example.com ${R15}`), "id");
    assert.equal(how("Riley Quinn riley.quinn@example.com"), "email");
  });

  await test("audit: a name followed by another person's Id is not them; a second bare occurrence still counts", () => {
    assert.equal(how(`assigned to user Riley Quinn (UserID: [${R2_15}])`), null);
    assert.equal(how(`Riley Quinn (User, ${R2_15}) added to group Sales`), null);
    assert.equal(how(`assigned to user Riley Quinn   (UserID: [${sfId18(R2_15)}])`), null, "18 character other Id, extra spaces");
    assert.equal(how(`Moved Riley Quinn (UserID: [${R2_15}]) under manager Riley Quinn`), "name", "the second one has no Id after it");
    assert.equal(how(`Riley Quinn (UserID: [${R15}]) is the one`), "id", "their own Id after the name");
    assert.equal(how(`Riley Quinn (UserID: [${R2_15}]) and Riley Quinn (UserID: [${R15}])`), "id");
    assert.equal(how(`Riley Quinn (see note) and Riley Quinn (UserID: [${R2_15}])`), "name", "a bracket that is not an Id does not discard");
    assert.equal(how("assigned to user Riley Quinn (UserID: [not an id])"), "name");
  });

  await test("audit: made by them: the recorded maker, or the delegate user; the maker alone never makes an entry made to them", () => {
    const m = personMatcher(riley);
    const e = (o) => entryFromRecord(rec(1, "2026-11-25T10:00:00Z", { Display: "Changed something", ...o }), 0);
    assert.equal(madeBy(e({ CreatedById: R18 }), m), "maker");
    assert.equal(madeBy(e({ CreatedById: R15 }), m), "maker");
    assert.equal(madeBy(e({ CreatedById: "005dm000003kq1v" }), m), null);
    assert.equal(madeBy(e({ CreatedById: U2, DelegateUser: "RILEY.QUINN@EXAMPLE.COM.UAT" }), m), "delegate");
    assert.equal(madeBy(e({ CreatedById: U2, DelegateUser: "riley.quinn@example.com" }), m), null, "the delegate is the username, not the email");
    assert.equal(madeBy(e({ CreatedById: U2 }), personMatcher({ id: R18, name: "", username: "" })), null);
    const list = [
      e({ Id: "a", CreatedById: R18, Display: "Changed the org language" }),
      e({ Id: "b", CreatedById: U2, Display: `Permission set X assigned to user Pat (UserID: [${R15}])` }),
      e({ Id: "c", CreatedById: R18, Display: "Changed title for Riley Quinn" }),
      e({ Id: "d", CreatedById: U3, DelegateUser: "riley.quinn@example.com.uat", Display: "Changed profile Y" }),
      e({ Id: "e", CreatedById: U3, Display: "Nothing about them" }),
    ];
    const run = (choice) => personView(list, { person: riley, choice }).map((x) => [x.id, x.how, x.viaDelegate]);
    assert.deepEqual(run("by"), [["a", HOW_MAKER, false], ["c", HOW_MAKER, false], ["d", HOW_DELEGATE, true]]);
    assert.deepEqual(run("to"), [["b", "Matched by their Id", false], ["c", HOW_NAME_ONLY, false]]);
    assert.deepEqual(run("either"), [["a", HOW_MAKER, false], ["b", "Matched by their Id", false], ["c", `${HOW_MAKER}; ${HOW_NAME_ALSO}`, false], ["d", HOW_DELEGATE, true]]);
    assert.equal(personView(list, null), list, "nobody picked: the list as it is");
    assert.ok(!list[0].how, "the entries read are not changed");
    assert.match(HOW_NAME_ONLY, /^Matched by name only: may be another person with this name$/);
    assert.match(HOW_DELEGATE, /^As delegate \(for example through Login-As\)$/);
    for (const t of [HOW_DELEGATE, HOW_MAKER, HOW_NAME_ONLY]) assert.ok(!/really|actually/i.test(t), "neutral wording");
  });

  await test("audit: the demo org holds every way a person is recorded, and the match finds each one", () => {
    const d = demo();
    const recs = demoRecords(d, new Date("2026-11-25T12:00:00Z"));
    const all = entriesOf(recs);
    const u = (name) => d.users.filter((x) => x.name === name);
    const [riley1, riley2] = u("Riley Quinn");
    assert.notEqual(riley1.id.slice(0, 15), riley2.id.slice(0, 15));
    assert.ok(isSalesforceId(riley1.id) && isSalesforceId(riley2.id), "realistic Ids with a right checksum");
    const to1 = personView(all, { person: riley1, choice: "to" });
    const forms = new Set(to1.map((e) => e.how));
    for (const w of ["Matched by their Id", "Matched by their username", "Matched by their email", HOW_NAME_ONLY]) assert.ok(forms.has(w), `Riley: ${w}`);
    const text = to1.map((e) => e.display).join("\n");
    assert.ok(/UserID: \[005Dm000003Kq1v\]/.test(text) && /\(User, 005Dm000003Kq1v\)/.test(text) && text.includes(sfId18("005Dm000003Kq1v")), "15 with name, group form, 18 without name");
    assert.ok(!to1.some((e) => e.display.includes("Kq9z") && !e.display.includes("manager Riley Quinn")), "the other Riley's own entries stay out");
    assert.ok(to1.some((e) => e.display.includes("manager Riley Quinn") && e.how === HOW_NAME_ONLY), "second bare occurrence");
    assert.ok(!to1.some((e) => /briley\.quinn|joriley/.test(e.display)), "near-miss addresses stay out");
    assert.ok(to1.some((e) => e.display.endsWith(".invalid")));
    const to2 = personView(all, { person: riley2, choice: "to" });
    assert.ok(to2.length >= 3 && to2.every((e) => e.how === "Matched by their Id" || e.how === HOW_NAME_ONLY));
    // a maker Salesforce does not return: the Id is there, the name is not
    const hidden = all.filter((e) => e.userId.startsWith("005Dm000003Hd8q"));
    assert.ok(hidden.length >= 3 && hidden.every((e) => !e.userName));
    assert.ok(!d.users.some((x) => x.id.startsWith("005Dm000003Hd8q")));
    assert.equal(buildPeople(hidden).get(hidden[0].userId).label, `A user you can't see (${hidden[0].userId})`);
    assert.equal(personView(all, { person: { id: hidden[0].userId, name: "", username: "", email: "" }, choice: "by" }).length, hidden.length, "the Id itself as the person");
    assert.ok(personView(all, { person: { id: hidden[0].userId, name: "", username: "" , email: ""}, choice: "to" }).length >= 1, "named by Id in a field change");
    // Login-As: the login (maker and delegate are the administrator), then entries made while logged in as someone
    const casey = d.users[0];
    const byCasey = personView(all, { person: casey, choice: "by" });
    assert.ok(byCasey.some((e) => e.action === "suOrgAdminLogin" && e.how === HOW_MAKER && !e.viaDelegate));
    const viaDelegate = byCasey.filter((e) => e.viaDelegate);
    assert.ok(viaDelegate.length >= 3 && viaDelegate.every((e) => e.userId !== casey.id && e.how === HOW_DELEGATE));
    assert.ok(viaDelegate.some((e) => e.delegate !== casey.username), "the delegate's capitals do not matter");
    // an email two people share lists both; the Unicode name and its apostrophe forms
    assert.equal(d.users.filter((x) => x.email === "team.alerts@example.com").length, 2);
    const zoe = d.users.find((x) => x.name.startsWith("Zo"));
    const toZoe = personView(all, { person: zoe, choice: "to" });
    assert.ok(toZoe.length >= 4 && toZoe.some((e) => e.display.includes("’")) && !toZoe.some((e) => e.display.includes("Zoe OBrien")));
    assert.ok(matchUsers(d.users, "team.alerts@example.com", 50, { emailAndId: true }).users.length === 2 && matchUsers(d.users, "team.alerts@example.com").users.length === 0);
    assert.equal(matchUsers(d.users, sfId18("005Dm000003Hd8q"), 50, { emailAndId: true }).users.length, 0);
    assert.equal(matchUsers(d.users, riley2.id.slice(0, 15), 50, { emailAndId: true }).users[0].id, riley2.id);
  });

  await test("audit: 'which read covers which choice': refilter without asking, or say to read again", () => {
    const P = { id: R18, username: "Riley.Quinn@example.com.uat" };
    const by = (p = P) => ({ person: p, choice: "by" });
    const all = { kind: "all" };
    const byCover = readFor(by()).cover;
    // a whole-period read answers every person and every choice, and also "nobody"
    for (const choice of ["by", "to", "either"]) assert.equal(coverageFits(all, { person: P, choice }), true, choice);
    assert.equal(coverageFits(all, null), true);
    // a read for one person as maker answers only that person as maker
    assert.equal(coverageFits(byCover, by()), true);
    assert.equal(coverageFits(byCover, { person: P, choice: "to" }), false);
    assert.equal(coverageFits(byCover, { person: P, choice: "either" }), false);
    assert.equal(coverageFits(byCover, null), false, "clearing the person needs a read of everyone");
    assert.equal(coverageFits(byCover, by({ id: sfId18(R2_15), username: "other@example.com" })), false, "another person");
    assert.equal(coverageFits(byCover, by({ id: R15, username: "riley.quinn@example.com.uat" })), true, "15 or 18 characters, any case of the username");
    assert.equal(coverageFits(byCover, by({ id: R18, username: "" })), false, "the delegate part of the read was different");
    assert.equal(coverageFits(null, null), false, "nothing read yet");
    assert.match(STALE_TEXT, /Press Show the audit trail to read again/);
    // the page must say STALE_TEXT instead of the list (static check of the page's use)
    const page = read(ext("tools/audit-trail/audit-trail.js"));
    assert.ok(/coverageFits\(state\.cover, who\)/.test(page) && /if \(!fits\)/.test(page) && page.includes("STALE_TEXT"));
    assert.ok(/state\.baseKey = ""/.test(page), "a new read drops the kept person view");
    assert.deepEqual(CHOICE_LABELS, { by: "Changes made by them", to: "Changes made to them", either: "Either" });
  });

  await test("audit: the made-to partial wording keeps every honesty line and says that only the entries read were searched", () => {
    const oldest = Date.parse("2026-11-02T14:03:00Z");
    for (const status of ["capped", "stopped", "failed", "short"]) {
      const base = partialNote({ status, read: 50000, total: 90000, oldestMs: oldest, cap: 50000 }, "UTC");
      const mem = partialNote({ status, read: 50000, total: 90000, oldestMs: oldest, cap: 50000, searched: true }, "UTC");
      assert.ok(mem.startsWith(base), status);
      assert.match(mem, /Entries about this person in the part that was not read are not in this list\./);
    }
    assert.equal(partialNote({ status: "complete", read: 5, total: 5, searched: true }), null);
    assert.match(SEARCH_LIMIT_NOTE, /Salesforce cannot narrow by who was changed, so this searches only the entries read \(the newest 50,000 of the period at first/);
    assert.ok(/mentions them|mention them/.test(SEARCH_LIMIT_NOTE) || /mentions/.test(SEARCH_LIMIT_NOTE));
    assert.equal(statusLine(2, 900, { status: "complete" }, 5), "Showing 2 of 5 entries about them, from 900 entries read");
    assert.match(statusLine(2, 900, { status: "capped" }, 1), /^Showing 2 of 1 entry about them, from 900 entries read \(not the whole period, see above\)/);
    assert.match(emptyText({ read: 900, partial: true, filtered: true, person: "Riley Quinn", baseCount: 0 }), /^0 found for Riley Quinn among the 900 entries read\. Only part of the period was read, so there may be entries in the part that was not read\.$/);
    assert.equal(emptyText({ read: 900, partial: false, filtered: true, person: "Riley Quinn", baseCount: 0 }), "0 found for Riley Quinn among the 900 entries read.");
    assert.match(emptyText({ read: 900, partial: true, filtered: true, person: "Riley Quinn", baseCount: 12 }), /hide all 12 entries read, and only part of the period was read/);
    assert.match(emptyText({ read: 0, partial: true, filtered: true, person: "Riley Quinn", baseCount: 0 }), /Only part of the period was read/);
    assert.equal(emptyText({ read: 0, partial: false, filtered: true, person: "Riley Quinn", baseCount: 0 }), "No entries about Riley Quinn in this period.");
    // the copied text and the CSV say who was searched for, what, and how
    const who = { person: riley, choice: "either" };
    const ctx = ctxOf({ who, cov: { status: "capped", read: 50000, total: 90000, oldestMs: oldest, cap: 50000, searched: true } });
    const lines = contextLines(ctx);
    assert.ok(lines.includes("Person searched for: Riley Quinn (riley.quinn@example.com.uat)") && lines.includes("What to find: Either"));
    assert.ok(lines.some((l) => l.startsWith("How it was searched: Salesforce cannot narrow by who was changed")));
    assert.ok(!contextLines(ctxOf({ who: { person: riley, choice: "by" } })).some((l) => l.startsWith("How it was searched")));
    const shown = shownText(personView(entriesOf(records(3, () => ({ Display: "Changed title for Riley Quinn" }))), who), ctx);
    assert.match(shown, /NOTE: Only part of this period is shown: the newest 50,000 of 90,000 entries/);
    assert.match(shown, /Entries about this person in the part that was not read are not in this list/);
    assert.ok(shown.includes(HOW_NAME_ONLY) && shown.includes("What to find: Either"));
  });

  const personWordsHint = () => read(ext("tools/audit-trail/audit-trail-logic.js")).match(/PERSON_FACET_HINT = "([^"]+)"/)[1];

  await test("audit: hidden makers are named by their Id, 'No user recorded' only without an Id, in the list, the Who column, the CSV and the copy", () => {
    const hidden = entryFromRecord(rec(1, "2026-11-25T19:03:07Z", { CreatedById: R18, CreatedBy: null }), 0);
    const none = entryFromRecord(rec(2, "2026-11-25T19:03:07Z", { CreatedById: null, CreatedBy: null }), 1);
    const named = entryFromRecord(rec(3, "2026-11-25T19:03:07Z"), 2);
    assert.equal(HIDDEN_USER, "A user you can't see");
    assert.equal(hiddenLabel(R18), `A user you can't see (${R18})`);
    assert.deepEqual([whoLabel(hidden), whoLabel(none), whoLabel(named)], [`A user you can't see (${R18})`, NO_USER, "Alex Example"]);
    const people = buildPeople([hidden, none, named]);
    assert.equal(people.get(R18).label, `A user you can't see (${R18})`);
    assert.equal(people.get("").label, NO_USER);
    const res = runFilters([hidden, none, named], emptyFilters());
    assert.equal(facetOptions("person", res.counts, emptyFilters(), people).find((o) => o.key === R18).label, `A user you can't see (${R18})`);
    assert.deepEqual(facetOptions("person", res.counts, emptyFilters(), people, R15.toLowerCase()).map((o) => o.key), [R18], "the person list is searchable by the maker's Id");
    assert.equal(facetOptions("person", res.counts, emptyFilters(), people, R15.toLowerCase()).length, 1);
    assert.ok(ticketText(hidden, { tz: "UTC" }).includes(`Who: A user you can't see (${R18})`));
    assert.ok(ticketText(none, { tz: "UTC" }).includes(`Who: ${NO_USER}`));
    const rows = csvRows([hidden, none], ctxOf());
    const head = rows.findIndex((r) => r[0] === CSV_HEADER[0]);
    assert.equal(rows[head + 1][2], `A user you can't see (${R18})`);
    assert.equal(rows[head + 2][2], NO_USER);
    assert.ok(shownText([hidden], ctxOf()).includes(`| A user you can't see (${R18}) |`));
    // the hint says the Person list is the recorded maker only
    assert.match(read(ext("tools/audit-trail/audit-trail.js")), /PERSON_FACET_HINT/);
    assert.match(personWordsHint(), /recorded as making the change/);
  });

  await test("audit: the person shows as a chip with the choice, removing it clears the person, and Clear filters does too", () => {
    const f = emptyFilters();
    assert.equal(hasFilters(f), false);
    f.who = { person: riley, choice: "to" };
    assert.equal(hasFilters(f), true);
    f.search = "x";
    const chips = filterChips(f, new Map());
    assert.deepEqual(chips.map((c) => c.text), ["Changes made to them: Riley Quinn (riley.quinn@example.com.uat)", "Search: x"]);
    removeChip(f, chips[0].remove);
    assert.equal(f.who, null);
    f.who = { person: riley, choice: "either" };
    clearFilters(f);
    assert.equal(f.who, null);
    assert.equal(personWords(null), "Everyone");
    assert.equal(personWords({ id: R18, name: "", username: "" }), `User Id ${R18}`);
    assert.equal(personWords({ id: R18, name: "Riley", username: "" }), "Riley");
    assert.equal(id15(R18), R15);
  });

  await test("audit: the CSV and the copy carry the person, the choice, how each entry matched, the delegate and the hidden maker", () => {
    const d = demo();
    const all = entriesOf(demoRecords(d, new Date("2026-11-25T12:00:00Z")));
    const casey = d.users[0];
    const who = { person: casey, choice: "by" };
    const view = personView(all, who);
    const rows = csvRows(view, ctxOf({ who, people: buildPeople(view) }));
    const flat = rows.map((r) => r.join(" | "));
    assert.ok(flat.includes(`Person searched for | ${casey.name} (${casey.username})`) && flat.includes("What to find | Changes made by them"));
    const head = rows.findIndex((r) => r[0] === CSV_HEADER_WITH_HOW[0]);
    assert.deepEqual(rows[head], CSV_HEADER_WITH_HOW);
    assert.deepEqual(CSV_HEADER_WITH_HOW.filter((h) => !CSV_HEADER.includes(h)), ["How it matched"]);
    assert.ok(CSV_HEADER.includes("Delegate user") && CSV_HEADER.includes("Source namespace prefix") && CSV_HEADER.includes("Section") && CSV_HEADER.includes("Kind code"));
    const col = (name) => CSV_HEADER_WITH_HOW.indexOf(name);
    const delegateRows = rows.slice(head + 1).filter((r) => r[col("How it matched")] === HOW_DELEGATE);
    assert.ok(delegateRows.length >= 3 && delegateRows.every((r) => r[col("Delegate user")].toLowerCase() === casey.username));
    assert.ok(delegateRows.every((r) => r[col("Who")] !== casey.name), "both people: the recorded maker in Who, the delegate user in its own column");
    const csv = toCsv(rows);
    assert.ok(csv.includes(HOW_DELEGATE));
    const bare = csvRows(all.slice(0, 2), ctxOf());
    assert.ok(!bare.some((r) => r.includes("How it matched")), "no person picked: no extra column");
    const copied = ticketText(delegateRows.length ? view.find((e) => e.viaDelegate) : view[0], { tz: "UTC" });
    assert.ok(copied.includes("How it matched: As delegate") && copied.includes("Delegate user: ") && /Who: /.test(copied));
  });

  await test("audit: 50,000 entries are matched for made-to and either in reasonable time", () => {
    const base = Date.parse("2026-11-25T12:00:00Z");
    const recs = Array.from({ length: 50000 }, (_, i) => rec(i + 1, new Date(base - i * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), {
      Display: i % 5000 === 0 ? `Permission set X assigned to user Riley Quinn (UserID: [${R2_15}]) and Riley Quinn (UserID: [${R15}])`
        : i % 7 === 0 ? `Changed field Field_${i % 977}__c for Riley Quinn (UserID: [${R2_15}]) on set Set_${i % 31}` : i % 11 === 0 ? `Changed email to joriley.quinn@example.com.uat in ${i}` : `Changed field Field_${i % 977}__c on set Set_${i % 31} (${i})`,
      CreatedById: i % 3 === 0 ? R18 : `005${String(i % 40).padStart(12, "0")}AAA`, CreatedBy: { Name: `User ${i % 40}`, Username: `u${i % 40}@example.com` },
    }));
    const list = entriesOf(recs);
    for (const choice of ["to", "either"]) {
      const t0 = Date.now();
      const view = personView(list, { person: riley, choice });
      const ms = Date.now() - t0;
      assert.ok(view.length > 0, choice);
      console.log(`       (50,000 entries, made ${choice === "to" ? "to" : "by or to"} a person: ${view.length} found in ${ms} ms)`);
      assert.ok(ms < 8000, `${choice} took ${ms} ms`);
      if (choice === "to") assert.equal(view.length, 10, "only the ten entries with their own Id; the other Riley and the near-miss address stay out");
    }
  });

  await test("audit: the page offers the person's choices one at a time, reads for the right query, yields to Stop and shows an error with nothing left on screen", () => {
    const page = read(ext("tools/audit-trail/audit-trail.js"));
    const html = read(ext("tools/audit-trail/audit-trail.html"));
    assert.ok(html.includes('<select id="choice"></select>') && /id="choiceBox" hidden/.test(html), "one choice at a time, only once a person is picked");
    assert.ok(/\$\("#choiceBox"\)\.hidden = !who/.test(page));
    assert.ok(page.includes("emailAndId: true"), "the person search looks at email and Id");
    assert.ok(/delayMs: \d+/.test(page), "demo mode waits a little between pages so Stop can be tried");
    assert.ok(/userId: asked\.userId, delegateUser: asked\.delegateUser/.test(page));
    assert.ok(/state\.cov = null;\s*state\.cover = null;\s*\$\("#results"\)\.hidden = true;/.test(page), "a first-page failure leaves no older result on screen");
    assert.ok(/if \(pasted && !items\.some/.test(page), "a pasted user Id that no one can read can be used as it is");
    assert.ok(!/state\.person\b/.test(page), "the person lives in the filters only");
    assert.ok(/id="stale"/.test(html) && /id="resultBody"/.test(html));
  });

  await test("audit: the demo api can wait between pages, so a read can be stopped while it runs", async () => {
    const d = demo();
    const recs = demoRecords(d, new Date("2026-11-25T12:00:00Z"));
    const control = {};
    const t0 = Date.now();
    const res = await readAuditTrail(demoApi(recs, { pageSize: 25, delayMs: 30 }), {}, { control, onPage: (b, n) => { if (n >= 50) control.stop = true; } });
    assert.deepEqual([res.status, res.read], ["stopped", 50]);
    assert.ok(Date.now() - t0 >= 60, "each request waited");
    const quick = await readAuditTrail(demoApi(recs, { pageSize: 25 }), {}, {});
    assert.equal(quick.read, d.entries.length);
  });

  // ===== registration, files and guards =====

  await test("audit: registered in the tool list and the feedback list, with the exact words, in both issue forms", () => {
    const t = TOOLS.find((x) => x.id === "audit-trail");
    assert.equal(t.page, "tools/audit-trail/audit-trail.html");
    assert.equal(t.title, "Search the Setup Audit Trail");
    assert.equal(t.description, "Find who changed what in Setup, without downloading a file");
    assert.equal(FEEDBACK_TOOLS.audit, "Search the Setup Audit Trail (extension)");
    for (const f of ["bug.yml", "enhancement.yml"]) {
      const y = read(path.join(here, "../..", ".github/ISSUE_TEMPLATE", f)).replace(/\r\n/g, "\n");
      assert.ok(y.includes("- Search the Setup Audit Trail (extension)\n"), f);
      assert.ok(y.includes("Extension 0.11.0, Chrome 131"), f);
    }
    const manifest = JSON.parse(read(ext("manifest.json")));
    assert.equal(manifest.version, "0.11.0");
    assert.ok(manifest.description.length <= 132, `${manifest.description.length} characters`);
    assert.deepEqual(manifest.permissions, ["cookies", "activeTab", "tabs", "storage"], "no new permission");
    assert.match(read(ext("package.json")), /nine read-only tools/);
    const page = read(ext("tools/audit-trail/audit-trail.js"));
    assert.ok(page.includes("FEEDBACK_TOOLS.audit"));
    const html = read(ext("tools/audit-trail/audit-trail.html"));
    assert.ok(html.includes("<title>Search the Setup Audit Trail</title>") && html.includes('id="feedback"') && html.includes("../../shared/pack.css"));
  });

  await test("audit: an export taken while the read is running says it is partial, in the copied text and the CSV", () => {
    const list = entriesOf(records(3));
    const cov = { status: "reading", read: 3, total: 9, oldestMs: Date.parse("2026-11-25T10:00:00Z"), cap: 50000 };
    assert.match(partialNote(cov, "UTC"), /^The read was still running when this was made, so only part of this period is here: 3 of 9 entries, going back to 2026-11-25 10:00:00\./);
    assert.match(partialNote({ ...cov, total: null }, "UTC"), /3 entries \(the total is not known\)/);
    const text = shownText(list, ctxOf({ cov }));
    assert.match(text, /NOTE: The read was still running when this was made.*3 of 9 entries.*2026-11-25 10:00:00/);
    assert.ok(text.includes("Entries read: 3 of 9") && text.includes("3 entries match."));
    const rows = csvRows(list, ctxOf({ cov }));
    const note = rows.find((r) => r[0] === "Note");
    assert.ok(note && /still running/.test(note[1]));
    assert.deepEqual(rows.find((r) => r[0] === "Entries in this file"), ["Entries in this file", "3"]);
    assert.ok(rows.some((r) => r[0] === "Entries read" && r[1] === "3 of 9"));
    assert.match(statusLine(3, 3, cov), /not the whole period/);
    // the page: a missing coverage is never "complete"
    const page = read(ext("tools/audit-trail/audit-trail.js"));
    assert.ok(!/status:\s*"complete"/.test(page), "the page never invents a complete read");
    assert.ok(page.includes('status: "reading"') && page.includes("exportReady()"));
  });

  await test("audit: name-only matches are counted apart from certain ones, and made-by plus name counts as certain", () => {
    const riley = { id: U1, name: "Riley Quinn", username: "riley.quinn@example.com", email: "" };
    const recs = [
      rec(1, "2026-11-25T10:00:00Z", { Display: "Changed Riley Quinn's role", CreatedById: U2 }),
      rec(2, "2026-11-25T10:01:00Z", { Display: "Changed Riley Quinn's role", CreatedById: U2 }),
      rec(3, "2026-11-25T10:02:00Z", { Display: "Reset the password for riley.quinn@example.com", CreatedById: U2 }),
      rec(4, "2026-11-25T10:03:00Z", { Display: "Changed Riley Quinn's role", CreatedById: U1 }),
      rec(5, "2026-11-25T10:04:00Z", { Display: "Unrelated", CreatedById: U1 }),
    ];
    const view = personView(entriesOf(recs), { person: riley, choice: "either" });
    assert.deepEqual(view.map((e) => e.nameOnly), [true, true, false, false, false]);
    assert.deepEqual(matchCounts(view), { certain: 3, nameOnly: 2 });
    assert.equal(matchBreakdown(matchCounts(view)), "3 certain (made by them, or their Id, username or email is in the text), 2 by name only (may be another person)");
    assert.equal(matchBreakdown({ certain: 4, nameOnly: 0 }), "");
    assert.ok(personView(entriesOf(recs), { person: riley, choice: "by" }).every((e) => !e.nameOnly), "made by them is certain");
    const cov = { status: "complete", read: 5, total: 5 };
    assert.equal(statusLine(5, 5, cov, matchCounts(view)), "Showing 5 of 5 entries that may be about them (3 certain (made by them, or their Id, username or email is in the text), 2 by name only (may be another person)), from 5 entries read");
    assert.equal(statusLine(2, 900, cov, { certain: 5, nameOnly: 0 }), "Showing 2 of 5 entries about them, from 900 entries read");
    assert.equal(readingStatusLine(5, 0, matchCounts(view)), "Showing 5 of 5 entries that may be about them so far (3 certain (made by them, or their Id, username or email is in the text), 2 by name only (may be another person))");
    assert.equal(readingStatusLine(2, 40, null), "Showing 2 of 40 entries read so far");
    assert.equal(readingStatusLine(2, 0, { certain: 4, nameOnly: 0 }), "Showing 2 of 4 entries about them so far");
    const ctx = ctxOf({ who: { person: riley, choice: "either" }, cov });
    assert.match(shownText(view, ctx), /5 entries match \(3 certain \(made by them, or their Id, username or email is in the text\), 2 by name only \(may be another person\)\)\./);
    const rows = csvRows(view, ctx);
    assert.ok(rows.some((r) => r[0] === "Entries in this file by how they matched" && /2 by name only/.test(r[1])));
    assert.ok(!csvRows(view.slice(2), ctx).some((r) => r[0] === "Entries in this file by how they matched"));
    assert.match(emptyText({ read: 9, partial: false, filtered: true, person: "Riley Quinn", baseCount: 5, baseSplit: matchBreakdown(matchCounts(view)) }), /hide all 5 entries read \(3 certain.*2 by name only/);
    assert.ok(!shownText(entriesOf(recs), ctxOf({ cov })).includes("by name only"));
  });

  await test("audit: a failed person search says the user search failed, with 401 and network wording kept", () => {
    const f403 = plainUserSearchProblem(Object.assign(new Error("insufficient access"), { status: 403, detail: "INSUFFICIENT_ACCESS on User" }));
    assert.match(f403.message, /^Could not search for users\./);
    assert.ok(!/Audit Trail/i.test(f403.message), "not the audit trail wording");
    assert.match(f403.raw, /INSUFFICIENT_ACCESS/);
    assert.ok(!f403.message.includes("INSUFFICIENT_ACCESS"), "raw text stays folded");
    const f500 = plainUserSearchProblem(Object.assign(new Error("boom"), { status: 500 }));
    assert.match(f500.message, /^Could not search for users\./);
    assert.ok(!f500.message.includes("boom"));
    assert.match(plainUserSearchProblem(Object.assign(new Error("Your Salesforce session has expired."), { status: 401 })).message, /session has expired/);
    assert.match(plainUserSearchProblem(new TypeError("Failed to fetch")).message, /connection to Salesforce was lost/);
    const js = read(ext("tools/audit-trail/audit-trail.js"));
    assert.ok(/plainUserSearchProblem\(e\);\s*showError\(p\.message, p\.raw, "#personError"\)/.test(js), "the page shows it in its own box");
    assert.ok(/showError\(""\);\s*showError\("", "", "#personError"\)/.test(js), "a read clears it");
    assert.ok(/showError\("", "", "#personError"\);\s*items = r\.users/.test(js), "a good search clears it");
    assert.ok(read(ext("tools/audit-trail/audit-trail.html")).includes('id="personError"'));
  });

  await test("audit: made by them plus their name in the text is certain and says so without the warning; name only keeps it", () => {
    const riley = { id: U1, name: "Riley Quinn", username: "riley.quinn@example.com", email: "" };
    const recs = [
      rec(1, "2026-11-25T10:00:00Z", { Display: "Changed Riley Quinn's role", CreatedById: U1 }),
      rec(2, "2026-11-25T10:01:00Z", { Display: "Changed Riley Quinn's role", CreatedById: U2, DelegateUser: "riley.quinn@example.com" }),
      rec(3, "2026-11-25T10:02:00Z", { Display: "Changed Riley Quinn's role", CreatedById: U2 }),
    ];
    const view = personView(entriesOf(recs), { person: riley, choice: "either" });
    const [maker, delegate, nameOnly] = view;
    assert.equal(maker.how, "Made by them; their name is also in the text");
    assert.equal(maker.nameOnly, false);
    assert.equal(delegate.how, `${HOW_DELEGATE}; their name is also in the text`);
    assert.equal(delegate.nameOnly, false);
    assert.equal(nameOnly.how, HOW_NAME_ONLY);
    assert.equal(nameOnly.nameOnly, true);
    for (const e of [maker, delegate]) assert.ok(!/may be another person/.test(e.how));
    const ctx = ctxOf({ who: { person: riley, choice: "either" }, cov: { status: "complete", read: 3, total: 3 } });
    assert.ok(!shownText([maker, delegate], ctx).includes("may be another person"));
    const csv = csvRows([maker], ctx);
    assert.ok(csv.some((r) => r.includes("Made by them; their name is also in the text")));
    assert.ok(!JSON.stringify(csv).includes("may be another person"));
    assert.ok(ticketText(maker, {}).includes("How it matched: Made by them; their name is also in the text"));
    // the page decides the warning line from the flag, not from the words
    assert.ok(!/name only\/\.test\(e\.how\)/.test(read(ext("tools/audit-trail/audit-trail.js"))));
  });

  await test("audit: the headline calls name-only matches 'may be about them', and plain 'about them' when none is", () => {
    const some = { certain: 3, nameOnly: 4 };
    const cov = { status: "complete" };
    assert.equal(statusLine(7, 7, cov, some), "Showing 7 of 7 entries that may be about them (3 certain (made by them, or their Id, username or email is in the text), 4 by name only (may be another person)), from 7 entries read");
    assert.equal(statusLine(4, 4, cov, { certain: 0, nameOnly: 4 }), "Showing 4 of 4 entries that may be about them (0 certain (made by them, or their Id, username or email is in the text), 4 by name only (may be another person)), from 4 entries read");
    assert.match(readingStatusLine(7, 0, some), /^Showing 7 of 7 entries that may be about them so far \(/);
    assert.equal(statusLine(7, 7, cov, { certain: 7, nameOnly: 0 }), "Showing 7 of 7 entries about them, from 7 entries read");
    assert.equal(readingStatusLine(2, 0, { certain: 2, nameOnly: 0 }), "Showing 2 of 2 entries about them so far");
    assert.ok(/Delegate User field holds their username/.test(read(ext("tools/audit-trail/audit-trail.js"))));
  });

  await test("audit: the keyboard goes to the same control after a redraw, else the next one, else the nearest before it", () => {
    const before = ["a", "b", "c", "d"];
    assert.equal(chooseFocus(before, ["a", "b", "c", "d"], "c"), "c");
    assert.equal(chooseFocus(before, ["a", "c", "d"], "b"), "c", "the next one");
    assert.equal(chooseFocus(before, ["a", "b"], "c"), "b", "none after it: the nearest before");
    assert.equal(chooseFocus(before, ["a", "d"], "b", "a"), "a", "the preferred one when it exists");
    assert.equal(chooseFocus(before, ["a", "d"], "b", "zz"), "d", "an absent preferred one is ignored");
    assert.equal(chooseFocus(before, [], "b"), null);
    assert.equal(chooseFocus(before, ["x"], null), null);
    assert.equal(chooseFocus(["a"], ["x", "y"], "gone"), "x", "a key that was not in the old list: the first of the new");
    assert.equal(chooseFocus(["more"], ["o1", "o2", "o3"], "more", "o2"), "o2", "after Show more: the first new row");
    const page = read(ext("tools/audit-trail/audit-trail.js"));
    for (const k of ["f:${name}:c:", "f:${name}:h:", "f:${name}:more", "chip:", ":when`", ":hide`", ":d:only`", ":d:hide`", ":d:person`"]) assert.ok(page.includes(k), k);
    assert.ok(page.includes("preventScroll: true"));
  });

  await test("audit: the tool folder has exactly its files, a license line, no import from another tool, and a read-only, text-only page", () => {
    const dir = ext("tools", "audit-trail");
    assert.deepEqual(readdirSync(dir).sort(), ["audit-trail-logic.js", "audit-trail-read.js", "audit-trail.css", "audit-trail.html", "audit-trail.js"]);
    for (const f of readdirSync(dir)) {
      const text = read(path.join(dir, f));
      assert.match(text.slice(0, 400), /Copyright \(c\) 2026 Sean R Fulton\. All rights reserved/, f);
      assert.ok(!f.startsWith("_"));
      for (const bad of ["innerHTML", "insertAdjacentHTML", "outerHTML", "eval(", "new Function", "localStorage", "sessionStorage", "chrome.storage", "document.write"]) assert.ok(!text.includes(bad), `${f} uses ${bad}`);
      for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\bsrc=|\bhref=)["']([^"']+)["']/g)) {
        const ref = m[1];
        assert.ok(/^\.\/audit-trail|^\.\.\/\.\.\/shared\/|^\.\.\/\.\.\/samples\/|^audit-trail\.|^https:\/\/github/.test(ref) || ref === "audit-trail.css", `${f} reaches ${ref}`);
      }
    }
    assert.ok(!readdirSync(ext("samples")).some((n) => n.startsWith("_")));
    assert.match(read(ext("samples", "..", "tools/audit-trail/audit-trail-read.js")), /SELECT COUNT\(\)/);
    const readJs = read(path.join(dir, "audit-trail-read.js"));
    assert.ok(!/method\s*:|POST|PATCH|DELETE|\bPUT\b/.test(readJs.replace(/\/\/.*$/gm, "")), "the reader only reads");
    assert.ok(!/\.query\(/.test(readJs), "its own pager: SfApi.query is not used");
    const page = read(path.join(dir, "audit-trail.js"));
    assert.ok(/textContent = /.test(page) && !/\.html\s*=|\.outerText\s*=/.test(page));
    assert.ok(!/location\.(search|href)\s*=|history\.(push|replace)State/.test(page), "nothing is put in the page address");
    assert.ok(!/issueUrl\([^)]*(entries|state\.|person)/.test(page), "no org data in the feedback link");
  });

  await test("audit: visible text avoids PSG, snapshot and the British 'licence', and the sort headings are the five columns", () => {
    const html = read(ext("tools/audit-trail/audit-trail.html"));
    const visible = [html, read(ext("tools/audit-trail/audit-trail.js")), read(ext("tools/audit-trail/audit-trail-logic.js"))].join("\n").replace(/\/\/.*$/gm, "");
    assert.ok(!/\bPSGs?\b/.test(visible) && !/snapshot/i.test(visible) && !/licence/i.test(visible));
    assert.ok(read(ext("tools/audit-trail/audit-trail.js")).includes('["when", "When"], ["who", "Who"], ["section", "Section"], ["what", "What changed"], ["kind", "Kind of change"]'));
  });
  // ===== "made to": who made the entry does not prove the name in the text is them =====

  await test("audit: made-to wording per choice: the maker is ignored for 'to', counted as certain for 'by' and 'either'", () => {
    const riley = { id: U1, name: "Riley Quinn", username: "riley.quinn@example.com", email: "" };
    // Riley made this entry, and its text has only a name that may be another Riley Quinn.
    const entries = entriesOf([rec(1, "2026-11-25T10:00:00Z", { Display: "Changed the title of Riley Quinn", CreatedById: U1 })]);
    const by = personView(entries, { person: riley, choice: "by" });
    assert.deepEqual([by.length, by[0].how, by[0].nameOnly], [1, HOW_MAKER, false], "by: made by them, certain");
    const to = personView(entries, { person: riley, choice: "to" });
    assert.deepEqual([to.length, to[0].how, to[0].nameOnly], [1, HOW_NAME_ONLY, true], "to: the maker is not looked at, so a name alone is still name-only");
    assert.deepEqual(matchCounts(to), { certain: 0, nameOnly: 1 });
    const either = personView(entries, { person: riley, choice: "either" });
    assert.deepEqual([either.length, either[0].how, either[0].nameOnly], [1, `${HOW_MAKER}; ${HOW_NAME_ALSO}`, false], "either: made by them is certain; the name is an extra fact");
    assert.deepEqual(matchCounts(either), { certain: 1, nameOnly: 0 });
    // The docs say the same, per choice.
    const readme = read(ext("README.md"));
    assert.ok(readme.includes("does not look at who made the entry"), "README states the rule per choice");
    assert.ok(/per choice|for each choice/i.test(read(ext("CLAUDE.md"))), "CLAUDE.md states the rule per choice");
  });

  // ===== reading past 50,000: "Read older entries" =====

  /** A fake org that understands the audit trail WHERE (CreatedDate <, <=, >=), refusing to go on after `failAt` GETs. */
  function orgOf(recs, { pageSize = 7, failAt = 0 } = {}) {
    const inner = demoApi(recs, { pageSize });
    let n = 0;
    return { apiVersion: inner.apiVersion, log: [], async get(p) { this.log.push(p); n++; if (failAt && n === failAt) throw Object.assign(new Error("Unable to connect"), { status: 503 }); return inner.get(p); } };
  }
  /** What the page does for one press of the button: continue from the oldest second held, drop what is held, append. */
  async function more(api, query, held, { max = 50000, total, control = {} } = {}) {
    const start = continuationStart(held);
    const got = [];
    const res = await readAuditTrail(api, { ...query, olderOrEqualMs: start.oldestMs }, { control, max, continuation: { total, held: held.length, skipIds: start.skipIds, seqStart: held.length }, onPage: (b) => got.push(...b) });
    for (const e of got) held.push(e);
    return res;
  }
  /** 30 records, a minute apart, except records 15 to 24, which share one second. */
  function boundaryRecords() {
    const base = Date.parse("2026-11-25T12:00:00Z");
    return Array.from({ length: 30 }, (_, i) => {
      const t = i < 15 ? base - i * 60000 : i < 25 ? base - 15 * 60000 : base - (i - 9) * 60000;
      return rec(i + 1, new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z"));
    });
  }

  await test("audit: a continuation asks the same WHERE plus CreatedDate <= the oldest second read, newest first, and never Section or Display", () => {
    const from = new Date("2026-11-18T05:00:00Z");
    const ms = Date.parse("2026-11-25T11:58:07Z");
    const q = buildQuery({ from, userId: U1, delegateUser: "alex@example.com", olderOrEqualMs: ms });
    assert.ok(q.includes(" WHERE CreatedDate >= 2026-11-18T05:00:00Z AND CreatedDate <= 2026-11-25T11:58:07Z AND (CreatedById = '005000000000001AAA' OR DelegateUser = 'alex@example.com') ORDER BY CreatedDate DESC, Id DESC"), q);
    assert.ok(!/Section\s*[=<>L]|Display\s*[=<>L]/.test(q.split("WHERE")[1]), "only filterable fields in WHERE");
    assert.equal(buildQuery({ olderOrEqualMs: ms + 400 }), buildQuery({ olderOrEqualMs: ms }), "the literal is whole seconds");
    assert.ok(!buildQuery({ from }).includes("<="), "a first read has no upper-second bound");
    assert.throws(() => buildWhere({ olderOrEqualMs: NaN }));
    assert.equal(MAX_HELD, 250000);
  });

  await test("audit: entries in the boundary second are neither lost nor doubled when a read continues", async () => {
    const recs = boundaryRecords();
    const api = orgOf(recs, { pageSize: 7 });
    const held = [];
    const first = await readAuditTrail(api, {}, { max: 18, onPage: (b) => held.push(...b) });
    assert.deepEqual([first.status, first.read, first.total, held.length], ["capped", 18, 30, 18]);
    const sameSecond = new Set(recs.slice(14, 24).map((r) => r.Id));
    assert.ok(held.filter((e) => sameSecond.has(e.id)).length >= 3 && held.filter((e) => sameSecond.has(e.id)).length < 10, "the first read ended inside the second");
    const calls = api.log.length;
    const next = await more(api, {}, held, { total: 30 });
    assert.equal(next.status, "complete");
    assert.equal(next.read, 12, "only the entries not held yet");
    assert.ok(decodeURIComponent(api.log[calls]).includes("CreatedDate <= 2026-11-25T11:45:00Z"), decodeURIComponent(api.log[calls]));
    assert.ok(!api.log.slice(calls).some((p) => /COUNT\(\)/.test(decodeURIComponent(p))), "no new count: the total is the first read's");
    assert.deepEqual(held.map((e) => e.id).sort(), recs.map((r) => r.Id).sort(), "every entry once");
    assert.equal(new Set(held.map((e) => e.seq)).size, 30, "every seq is its own");
    assert.deepEqual(held.map((e) => e.seq), held.map((_, i) => i), "seq keeps counting up");
    // ties keep Salesforce's order when sorted, so the join is not visible
    assert.deepEqual(sortEntries(held, "when", "desc").map((e) => e.id), recs.map((r) => r.Id));
  });

  await test("audit: a continuation can itself be capped, stopped or fail; what it read is kept and the next press goes on from there", async () => {
    const recs = boundaryRecords();
    const held = [];
    await readAuditTrail(orgOf(recs), {}, { max: 10, onPage: (b) => held.push(...b) });
    const a = await more(orgOf(recs), {}, held, { total: 30, max: 5 });
    assert.deepEqual([a.status, a.read, held.length], ["capped", 5, 15]);
    // stopped: stop is set before the first page
    const b = await more(orgOf(recs), {}, held, { total: 30, control: { stop: true } });
    assert.deepEqual([b.status, b.read, held.length], ["stopped", 0, 15]);
    // failed part way: the first page of the continuation is kept, the second fails
    const c = await more(orgOf(recs, { pageSize: 4, failAt: 2 }), {}, held, { total: 30 });
    assert.equal(c.status, "failed");
    assert.ok(c.problem?.message);
    assert.ok(c.read > 0 && held.length === 15 + c.read, "what was read is kept");
    // the button retries: the same press again finishes it
    const d = await more(orgOf(recs), {}, held, { total: 30 });
    assert.equal(d.status, "complete");
    assert.deepEqual(held.map((e) => e.id).sort(), recs.map((r) => r.Id).sort(), "every entry once after a failed press and a retry");
  });

  await test("audit: a continuation that ends short of the first count is never called complete", async () => {
    const recs = boundaryRecords();
    const held = [];
    await readAuditTrail(orgOf(recs), {}, { max: 10, onPage: (b) => held.push(...b) });
    const res = await more(orgOf(recs), {}, held, { total: 99 });
    assert.equal(res.status, "short");
  });

  await test("audit: a new read cancels a continuation that is running, and nothing more of it is delivered", async () => {
    const recs = boundaryRecords();
    const held = [];
    await readAuditTrail(orgOf(recs), {}, { max: 10, onPage: (b) => held.push(...b) });
    const inner = demoApi(recs, { pageSize: 3, delayMs: 15 });
    const control = { stop: false, cancel: false };
    const start = continuationStart(held);
    const got = [];
    const run = readAuditTrail(inner, { olderOrEqualMs: start.oldestMs }, { control, continuation: { total: 30, held: 10, skipIds: start.skipIds, seqStart: 10 }, onPage: (b) => got.push(...b) });
    setTimeout(() => { control.cancel = true; }, 25);
    const res = await run;
    assert.equal(res.status, "cancelled");
    const at = got.length;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(got.length, at, "nothing arrives after the cancel");
    assert.ok(at < 20);
    // the page: a new read cancels the running one and a stale pass is dropped by its token
    const page = read(ext("tools/audit-trail/audit-trail.js"));
    assert.ok(/if \(state\.control\) state\.control\.cancel = true;/.test(page));
    assert.ok((page.match(/if \(token !== state\.run\)/g) || []).length >= 4, "every callback checks its token");
  });

  await test("audit: the page refuses to continue a read that is not the one shown, and keeps the held limit", () => {
    const page = read(ext("tools/audit-trail/audit-trail.js"));
    const fn = page.slice(page.indexOf("async function readOlder()"), page.indexOf("function drawOlder()"));
    assert.ok(fn.includes("periodSig() !== state.readSig"), "a changed period is refused");
    assert.ok(fn.includes("coverageFits(state.cover, state.filters.who)"), "a person or choice the read does not cover is refused");
    assert.ok(fn.includes("state.readQuery"), "it continues the query that was asked, not the boxes");
    assert.ok(fn.includes("HELD_MAX - state.entries.length"), "the limit caps how many it may add");
    assert.ok(page.includes("OLDER_STALE_TEXT") && /Press Show the audit trail to read again/.test(OLDER_STALE_TEXT));
    assert.ok(page.includes("DEMO ? Number(params.get(\"cap\")) : 0"), "?cap= works only in demo mode");
    // the limit in words, and no button at the limit
    const atLimit = buildCoverage({ status: "capped", read: 250000, total: 626000, oldestMs: Date.parse("2026-11-02T14:03:00Z") });
    assert.equal(atLimit.canMore, false);
    assert.match(partialNote(atLimit, "UTC"), /holds at most 250,000 entries.*Choose a shorter period, or only one person/);
    assert.ok(!/button/.test(partialNote(atLimit, "UTC")));
    assert.equal(buildCoverage({ status: "capped", read: 200000, total: 626000, oldestMs: 1 }).canMore, true);
    assert.equal(buildCoverage({ status: "complete", read: 200000, total: 200000, oldestMs: 1 }).canMore, false);
    assert.equal(buildCoverage({ status: "short", read: 900, total: 1000, oldestMs: 1 }).canMore, false, "a read that ended is not continued");
    assert.equal(buildCoverage({ status: "failed", read: 0, total: 5, oldestMs: null }).canMore, false);
  });

  await test("audit: the button says how many it reads and how many are left", () => {
    assert.equal(olderLabel({ read: 50000, total: 112060 }), "Read the next 50,000 older entries (62,060 left)");
    assert.equal(olderLabel({ read: 50000, total: 62060 }), "Read the remaining 12,060");
    assert.equal(olderLabel({ read: 50000, total: null }), "Read 50,000 older entries");
    assert.equal(olderLabel({ read: 240000, total: 600000 }), "Read the next 10,000 older entries (360,000 left)", "the limit shortens the step");
    assert.equal(olderLabel({ read: 100, total: 480, cap: 200, maxHeld: 600 }), "Read the next 200 older entries (380 left)");
    assert.equal(olderProgressText(62000, 626000), "Reading older entries... 62,000 of 626,000");
    assert.equal(olderProgressText(62000, null), "Reading older entries... 62,000");
  });

  await test("audit: after a continuation every note, status line, '0 found', CSV note and copy uses the combined coverage", () => {
    const oldest = Date.parse("2026-11-02T14:03:00Z");
    const list = entriesOf(records(3));
    const ctxOf = (o = {}) => ({ periodDetail: "Everything Salesforce keeps", who: null, tz: "UTC", filters: emptyFilters(), people: new Map(), ...o });
    const mk = (status, extra = {}) => buildCoverage({ status, read: 100000, total: 626000, oldestMs: oldest, ...extra });
    const capped = mk("capped");
    const label = olderLabel(capped);
    for (const [status, lead] of [["capped", /^Only part of this period is shown: 100,000 of 626,000 entries were read, going back to 2026-11-02 14:03:00\. /], ["stopped", /You stopped the read.*100,000 of 626,000 entries/], ["failed", /stopped part way.*100,000 of 626,000 entries/]]) {
      const note = partialNote(mk(status), "UTC", { onPage: true });
      assert.match(note, lead, status);
      assert.match(note, /going back to 2026-11-02 14:03:00/, status);
      assert.ok(note.includes(`press the "${label}" button below`), status);
      assert.ok(!note.includes("..."), status);
      assert.ok(!/\bcomplete\b|\ball entries\b|newest|at most 50,000/i.test(note), status);
      // exported text never tells the reader to press a button
      const out = partialNote(mk(status), "UTC");
      assert.match(out, /More entries can be read on the Search the Setup Audit Trail page\./, status);
      assert.match(out, /choose a shorter period, or only one person's changes/i, status);
      assert.ok(!/button|press|\.\.\./i.test(out), status);
      assert.ok(!/newest|at most 50,000/i.test(out), status);
    }
    // a single first read keeps its wording
    assert.match(partialNote({ status: "capped", read: 50000, total: 90000, oldestMs: oldest, cap: 50000 }, "UTC"), /the newest 50,000 of 90,000 entries were read.*one read takes at most 50,000/);
    assert.match(partialNote(mk("failed"), "UTC", { onPage: true }), /The button also tries again/);
    assert.match(partialNote(mk("failed"), "UTC"), /Or try again\./);
    assert.ok(!/button/.test(partialNote(mk("failed"), "UTC")));
    assert.match(partialNote({ ...capped, status: "continuing", read: 130000 }, "UTC"), /^Still reading older entries: 130,000 of 626,000 entries so far, going back to 2026-11-02 14:03:00/);
    // the status line
    assert.equal(statusLine(5, 100000, capped, null, "UTC"), "Showing 5 of 100,000 entries read (not the whole period: 100,000 of 626,000 entries read, going back to 2026-11-02 14:03:00; more can be read; see above)");
    // "0 found"
    const none = emptyText({ read: 100000, partial: true, filtered: true, cover: coverageWords(capped, "UTC") });
    assert.match(none, /^0 found\..*only part of the period was read \(100,000 of 626,000 entries read, going back to 2026-11-02 14:03:00; more can be read\)/);
    assert.match(emptyText({ read: 0, partial: true, filtered: false, cover: "9 of 99 entries read" }), /Only part of the period was read \(9 of 99 entries read\), so there may be entries/);
    // copy and CSV
    const text = shownText(list, ctxOf({ cov: capped }));
    assert.match(text, /NOTE: Only part of this period is shown: 100,000 of 626,000 entries were read, going back to 2026-11-02 14:03:00\./);
    assert.ok(!/newest|press|button/.test(text.split("\n").find((l) => l.startsWith("NOTE:"))));
    const rows = csvRows(list, ctxOf({ cov: capped }));
    assert.ok(/100,000 of 626,000.*going back to 2026-11-02 14:03:00.*More entries can be read on the Search the Setup Audit Trail page/.test(rows.find((r) => r[0] === "Note")[1]));
    assert.ok(rows.some((r) => r[0] === "Entries read" && r[1] === "100,000 of 626,000"));
    // an export taken while older entries are still being read
    const running = { ...capped, status: "reading", read: 130000 };
    assert.match(shownText(list, ctxOf({ cov: running })), /NOTE: The read was still running when this was made.*130,000 of 626,000 entries/);
    assert.match(csvRows(list, ctxOf({ cov: running })).find((r) => r[0] === "Note")[1], /still running/);
    // everything read: no partial wording anywhere
    const done = mk("complete", { read: 626000 });
    assert.equal(partialNote(done, "UTC"), null);
    assert.equal(statusLine(5, 626000, done, null, "UTC"), "Showing 5 of 626,000 entries read");
    assert.ok(!shownText(list, ctxOf({ cov: done })).includes("NOTE:"));
    assert.ok(!csvRows(list, ctxOf({ cov: done })).some((r) => r[0] === "Note"));
    assert.equal(emptyText({ read: 626000, partial: false, filtered: true }).includes("only part"), false);
    // the "made to" hint tells the new truth
    assert.match(SEARCH_LIMIT_NOTE, /the newest 50,000 of the period at first; older ones can be read 50,000 at a time, up to 250,000 on this page/);
    assert.ok(!/at most 50,000 entries at a time/.test(read(ext("tools/audit-trail/audit-trail.html"))));
  });

  await test("audit: the demo continues in steps with ?cap=, and reading all the steps gives every entry once", async () => {
    const d = demo();
    const recs = demoRecords(d, new Date("2026-11-25T12:00:00Z"));
    const api = demoApi(recs, { pageSize: 40 });
    const held = [];
    const first = await readAuditTrail(api, {}, { max: 200, onPage: (b) => held.push(...b) });
    assert.deepEqual([first.status, first.read, first.total], ["capped", 200, recs.length]);
    const lim = { step: 200, maxHeld: 600 };
    let cov = buildCoverage({ status: first.status, read: held.length, total: first.total, oldestMs: timeSpan(held).min }, lim);
    assert.equal(olderLabel(cov), `Read the next 200 older entries (${recs.length - 200} left)`);
    const second = await more(api, {}, held, { max: 200, total: first.total });
    assert.deepEqual([second.status, held.length], ["capped", 400]);
    cov = buildCoverage({ status: second.status, read: held.length, total: first.total, oldestMs: timeSpan(held).min }, lim);
    assert.equal(olderLabel(cov), `Read the remaining ${recs.length - 400}`);
    const third = await more(api, {}, held, { max: 200, total: first.total });
    assert.equal(third.status, "complete");
    assert.equal(held.length, recs.length);
    assert.deepEqual(held.map((e) => e.id), recs.map((r) => r.Id), "every entry once, in Salesforce's order");
    assert.equal(partialNote(buildCoverage({ status: third.status, read: held.length, total: first.total, oldestMs: timeSpan(held).min }, lim), "UTC"), null);
    assert.match(read(ext("README.md")), /cap=200/);
  });

  await test("audit: 250,000 entries are held, filtered and searched within a reasonable time", () => {
    const base = Date.parse("2026-11-25T12:00:00Z");
    const kinds = ["PermSetFlsChanged", "changedUserEmail", "createdCustomField", "changedProfilePerm", "insertedApexClass"];
    const before = process.memoryUsage().heapUsed;
    const t0 = Date.now();
    const list = [];
    for (let chunk = 0; chunk < 5; chunk++) { // five reads of 50,000, as the button does
      const recs = Array.from({ length: 50000 }, (_, j) => {
        const i = chunk * 50000 + j;
        return rec(i + 1, new Date(base - i * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), {
          Action: i % 2 ? "PermSetFlsChanged" : kinds[i % 5], Display: `Changed field Field_${i % 977}__c on set Set_${i % 31} (${i}) for Riley Quinn ${i % 13 ? "" : "(riley.quinn@example.com)"}`, CreatedById: `005${String(i % 40).padStart(12, "0")}AAA`,
          CreatedBy: { Name: `User ${i % 40}`, Username: `u${i % 40}@example.com` }, Section: i % 7 ? `Section ${i % 9}` : null,
        });
      });
      for (let j = 0; j < recs.length; j++) list.push(entryFromRecord(recs[j], list.length));
    }
    const tBuild = Date.now() - t0;
    assert.equal(list.length, 250000);
    const heapMb = Math.round((process.memoryUsage().heapUsed - before) / 1048576);
    const f = emptyFilters();
    f.search = 'field_5__c "set_3" -"user 7"';
    const t1 = Date.now();
    let res;
    for (let i = 0; i < 3; i++) res = runFilters(list, f);
    const tFilter = (Date.now() - t1) / 3;
    assert.ok(res.shown.length > 0);
    const riley = { id: U2, name: "Riley Quinn", username: "riley.quinn@example.com", email: "" };
    const t2 = Date.now();
    const view = personView(list, { person: riley, choice: "either" });
    const people = buildPeople(view);
    const tPerson = Date.now() - t2;
    assert.ok(view.length > 0 && people.size > 0);
    const t3 = Date.now();
    const sorted = sortEntries(runFilters(list, emptyFilters()).shown, "what", "asc");
    const tSort = Date.now() - t3;
    assert.equal(sorted.length, 250000);
    const t4 = Date.now();
    const start = continuationStart(list);
    const tStart = Date.now() - t4;
    assert.equal(start.skipIds.size, 1);
    console.log(`       (250,000 entries: build ${tBuild} ms, about ${heapMb} MB of heap, one filter ${Math.round(tFilter)} ms, person view ${tPerson} ms, filter and sort ${tSort} ms, continuation start ${tStart} ms)`);
    assert.ok(tFilter < 3000, `a filter took ${tFilter} ms`);
    assert.ok(tBuild < 20000 && tPerson < 10000 && tSort < 15000 && tStart < 1000, `${tBuild} ${tPerson} ${tSort} ${tStart}`);
  });
}
