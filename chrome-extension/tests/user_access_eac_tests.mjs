// Offline tests for Einstein Activity Capture inside the User access page. Called from run_tests.mjs.
// Synthetic data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SfApi } from "../shared/sfconn.js";
import { readUserAccess } from "../tools/user-access/user-access-read.js";
import { readEacRaw, readEacAccessUserIds, readPastedUsers, EAC_PERMISSION_FIELDS } from "../tools/user-access/user-access-eac-read.js";
import {
  STATUS_WORDS, NO_STATUS_TEXT, ASSIGNED_ONLY_TEXT, EAC_OFF_TEXT, NO_CONFIG_TITLE, NOTHING_SYNCED_TEXT, INACTIVE_TEXT, SHOW_CHOICES,
  statusWords, isConnected, buildEacRows, eacCounts, filterEacRows, filterNoConfig, groupByConfig,
  eacCsvRows, noConfigCsvRows, eacDetailText, eacItem, profileNote, assignedText, toCsv, eacSummaryLine, EMPTY_CONFIG_NOTE, NO_EAC_USER_TEXT,
} from "../tools/user-access/user-access-eac.js";
import {
  ACTIONS, validConfigId, inspectorSteps, parsePasted, userLookupQueries, matchPasted, knownConfigs, entryFromRow, entryFromUser, entryFromRecord,
  planChange, skipGroups, previewSummary, usableId, profileKey, allNoRealId, duplicatesText, skipHelp, changeTable, undoTable, tabText, csvText, outputFor, changeFileName, copyWithFallback,
  CHANGE_WARNING, NO_UNDO_ADD, AFTER_STEP, CONFIG_ID_HELP,
} from "../tools/user-access/user-access-eac-changes.js";
import { compareUsers, validateAccess, toRows, toRowsSingle, SECTION_KEYS } from "../tools/user-access/user-access-logic.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = (n) => JSON.parse(readFileSync(path.join(here, "..", "samples", n), "utf-8"));

const resp = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

/** A fake org. `eac` is {status: [...], sync: [...], failStatus, failSync} ; `log` collects every request. */
function fakeOrg(eac = {}, log = []) {
  const stash = new Map();
  let counter = 0;
  const pageSize = eac.pageSize || 0; // with a page size, long results come in pages with nextRecordsUrl
  const serve = (records, from, id) => {
    const end = pageSize ? from + pageSize : records.length;
    const body = { done: end >= records.length, totalSize: records.length, records: records.slice(from, end) };
    if (!body.done) body.nextRecordsUrl = `/services/data/v62.0/query/01g${id}-${end}`;
    return resp(200, body);
  };
  const page = (records) => { const id = String(++counter); stash.set(id, records); return serve(records, 0, id); };
  const idList = (q, re) => { const m = re.exec(q); return m ? m[1].split(",").map((x) => x.trim().replace(/'/g, "")) : null; };
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    log.push({ method: opts.method || "GET", path: u.pathname, q: u.searchParams.get("q") });
    const nextPage = /\/query\/01g(\d+)-(\d+)$/.exec(u.pathname);
    if (nextPage) return serve(stash.get(nextPage[1]), Number(nextPage[2]), nextPage[1]);
    if (/\/sobjects\/$/.test(u.pathname)) {
      return resp(200, { sobjects: [{ name: "User", keyPrefix: "005" }, { name: "UserTerritory2Association", keyPrefix: "0A2" }, ...(eac.noConfigObject ? [] : [{ name: "EacConfigDemo__x", keyPrefix: "063" }])] });
    }
    const q = u.searchParams.get("q") || "";
    const off = (n) => resp(400, [{ message: `sObject type '${n}' is not supported.`, errorCode: "INVALID_TYPE" }]);
    const bad = (m) => resp(400, [{ message: m, errorCode: "TEST" }]);
    if (/COUNT\(\)/i.test(q)) return resp(200, { done: true, totalSize: 0, records: [] }); // the real quirk: always 0
    // The real quirk: a WHERE on either EAC object gives a generic server error, so the reader must never send one.
    if (/FROM (ActivityUsrConnectionStatus|UserEmailCalendarSync)\b[\s\S]*\bWHERE\b/.test(q)) {
      return resp(500, [{ message: "An unexpected error occurred. Please include this ErrorId if you contact support: 1234-5678", errorCode: "APEX_ERROR" }]);
    }
    if (/FROM ActivityUsrConnectionStatus/.test(q)) {
      if (eac.off) return off("ActivityUsrConnectionStatus");
      if (eac.failStatus) return bad(eac.failStatus);
      return page(eac.status || []);
    }
    if (/FROM UserEmailCalendarSync/.test(q)) {
      if (eac.off) return off("UserEmailCalendarSync");
      if (eac.failSync) return bad(eac.failSync);
      return page(eac.sync || []);
    }
    if (/FROM EacConfigDemo__x/.test(q)) return page(eac.configs || []);
    if (/FROM User WHERE Id IN/.test(q)) {
      const ids = new Set(idList(q, /Id IN \(([^)]*)\)/));
      return page((eac.users || []).filter((x) => ids.has(x.Id)));
    }
    const prof = /FROM User WHERE ProfileId = '(\w+)'/.exec(q);
    if (prof) return page((eac.profileUsers || {})[prof[1]] || []);
    if (/FROM Profile WHERE Id IN/.test(q)) return page(eac.profiles || []);
    if (/SELECT AssigneeId FROM PermissionSetAssignment/.test(q)) {
      const a = eac.access;
      if (!a) return page([]);
      const fields = EAC_PERMISSION_FIELDS.filter((f) => q.includes(f));
      const gone = fields.find((f) => (a.missing || []).includes(f));
      if (a.failAll || gone) return resp(400, [{ message: `No such column '${gone || fields[0]}' on entity 'PermissionSet'.`, errorCode: "INVALID_FIELD" }]);
      return page([...new Set(fields.flatMap((f) => (a.byField || {})[f] || []))].map((AssigneeId) => ({ AssigneeId })));
    }
    if (/FROM User WHERE Id =/.test(q)) {
      return page([{ Id: "005USER00000001", Name: "Avery Example", Username: "avery@example.com", IsActive: true, ProfileId: "00ePROF00000001",
        Profile: { Name: "Sales Standard", UserLicense: { Name: "Salesforce" } }, UserRole: null }]);
    }
    if (/FROM EntityDefinition/.test(q)) return page([]);
    if (/FROM Organization/.test(q)) return page([{ Id: "00DORG" }]);
    if (/SELECT CallCenterId/.test(q)) return page([{ CallCenterId: null }]);
    if (/FROM UserTerritory2Association|FROM PermissionSetLicenseAssign|FROM GroupMember|FROM PermissionSetAssignment/.test(q)) return page([]);
    return bad(`no route for ${q}`);
  };
  return new SfApi({ apiHost: "test.example.com", sessionId: "sid", fetchImpl });
}

const st = (UserId, ConfigurationName, ConnectivityStatus, over = {}) => ({
  UserId, UserName: "Name " + UserId, ConfigurationName, ConnectivityStatus, ContactsSynced: true, EventsSynced: false,
  IsTermsOfServiceAccepted: true, RecommendedActionTitle: null, RecommendedActionDescription: null, ...over,
});

export async function run(test) {
  console.log("user access: Einstein Activity Capture");

  await test("eac: every picklist value and blank has plain words", () => {
    const values = ["ACTIVE", "PENDING", "INITIALIZING", "PROCESSING", "NEEDSATTENTION", "IDLE_STREAMING", "DISABLED", "NEEDSATTENTIONGLOBAL", "NEEDSATTENTIONHYBRID"];
    assert.deepEqual(Object.keys(STATUS_WORDS).sort(), [...values].sort());
    const seen = new Set();
    for (const v of values) {
      const t = statusWords(v);
      assert.ok(t && !/[A-Z_]{5,}/.test(t), `${v} -> ${t}`);
      seen.add(t);
    }
    assert.equal(seen.size, values.length, "each value has its own words");
    assert.equal(statusWords("ACTIVE"), "Connected");
    assert.equal(statusWords(null), NO_STATUS_TEXT);
    assert.equal(statusWords(""), NO_STATUS_TEXT);
    assert.equal(statusWords(undefined), NO_STATUS_TEXT);
    assert.match(NO_STATUS_TEXT, /Not connected yet/);
    assert.equal(statusWords(null, false), ASSIGNED_ONLY_TEXT);
    assert.equal(statusWords("SOME_NEW_VALUE"), "Some new value", "an unknown value is still readable");
  });

  await test("eac: only ACTIVE is connected (blank, assigned-only and every other value are not)", () => {
    assert.equal(isConnected("ACTIVE"), true);
    for (const v of [null, "", undefined, "PENDING", "IDLE_STREAMING", "DISABLED", "NEEDSATTENTION"]) assert.equal(isConnected(v), false, String(v));
  });

  await test("eac: assigned with no status row reads 'Assigned, not connected yet'", () => {
    const { rows } = buildEacRows({
      statuses: [st("005A", "Sales", "ACTIVE")],
      assignments: [{ AssignedId: "005A", ConfigurationId: "063X" }, { AssignedId: "005B", ConfigurationId: "063X" }],
      configs: { "063X": "Sales" },
      users: [{ Id: "005A", Name: "Avery Example", Username: "a@example.com" }, { Id: "005B", Name: "Blake Sample", Username: "b@example.com" }],
    });
    assert.equal(rows.length, 2, "A's assignment joins A's status row; B has a row of their own");
    const b = rows.find((r) => r.name === "Blake Sample");
    assert.equal(b.statusText, ASSIGNED_ONLY_TEXT);
    assert.equal(b.hasRow, false);
    assert.equal(b.connected, false);
    assert.equal(b.configuration, "Sales");
    assert.equal(rows.find((r) => r.name === "Avery Example").statusText, "Connected");
  });

  await test("eac: an assignment with an unknown configuration name joins the user's status row instead of adding a second line", () => {
    const { rows } = buildEacRows({ statuses: [st("005A", "Sales", null)], assignments: [{ AssignedId: "005A", ConfigurationId: "063?" }] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].configuration, "Sales");
    assert.equal(rows[0].statusText, NO_STATUS_TEXT);
  });

  await test("eac: a profile assignment (00e) is 'through profile X' for that user, and not expanded in the everyone list", () => {
    const input = { assignments: [{ AssignedId: "00ePROF00000001", ConfigurationId: "063X" }], configs: { "063X": "Service Reps" } };
    const one = buildEacRows({ ...input, single: { userId: "005U", profileId: "00ePROF00000001", profileName: "Service Standard" } });
    assert.equal(one.rows.length, 1);
    assert.equal(one.rows[0].via, "profile");
    assert.match(eacDetailText(eacItem(one.rows[0])), /Through the profile Service Standard/);
    assert.equal(one.rows[0].statusText, ASSIGNED_ONLY_TEXT);
    // Everyone read: with no member list for the profile, only a note remains (members could not be listed).
    const all = buildEacRows({ ...input, profiles: { "00ePROF00000001": "Service Standard" } });
    assert.equal(all.rows.length, 0);
    assert.deepEqual(all.profileAssignments.map((p) => [p.profileName, p.configuration]), [["Service Standard", "Service Reps"]]);
    assert.match(profileNote(all.profileAssignments), /Service Reps for everyone on the profile Service Standard/);
    assert.match(profileNote(all.profileAssignments), /could not be listed/);
    const other = buildEacRows({ ...input, single: { userId: "005U", profileId: "00eOTHER0000001", profileName: "Other" } });
    assert.equal(other.rows.length, 0, "another profile does not apply to this user");
  });

  const mixed = () => buildEacRows({
    statuses: [st("005A", "Sales", "ACTIVE"), st("005B", "Sales", null), st("005C", "Assistants", "PENDING"), st("005D", "Assistants", "NEEDSATTENTION"), st("005E", "Sales", "ACTIVE")],
    assignments: [{ AssignedId: "005F", ConfigurationId: "063A" }],
    configs: { "063A": "Assistants" },
    users: ["A", "B", "C", "D", "E", "F"].map((x) => ({ Id: `005${x}`, Name: `User ${x}`, Username: `${x.toLowerCase()}@example.com` })),
  }).rows;

  await test("eac: counts come from the rows, never from COUNT()", () => {
    const rows = mixed();
    const c = eacCounts(rows);
    assert.deepEqual([c.rows, c.users, c.connected, c.notConnected], [6, 6, 2, 4]);
    assert.deepEqual(c.byConfig.map((x) => [x.name, x.count, x.notConnected]), [["Assistants", 3, 3], ["Sales", 3, 1]]);
    const byStatus = Object.fromEntries(c.byStatus.map((x) => [x.text, x.count]));
    assert.deepEqual(byStatus, { Connected: 2, [NO_STATUS_TEXT]: 1, "Waiting to connect": 1, "Needs attention": 1, [ASSIGNED_ONLY_TEXT]: 1 });
    assert.equal(c.byStatus.reduce((n, x) => n + x.count, 0), rows.length, "status counts add up to the rows");
    assert.equal(c.byConfig.reduce((n, x) => n + x.count, 0), rows.length, "configuration counts add up to the rows");
  });

  await test("eac: 'Only users not connected' keeps blank, assigned-only and every non-ACTIVE status; search needs every word", () => {
    const rows = mixed();
    const not = filterEacRows(rows, { onlyNotConnected: true });
    assert.deepEqual(not.map((r) => r.name).sort(), ["User B", "User C", "User D", "User F"]);
    assert.ok(not.every((r) => !r.connected));
    assert.equal(filterEacRows(rows, {}).length, 6);
    assert.deepEqual(filterEacRows(rows, { search: "assistants waiting" }).map((r) => r.name), ["User C"]);
    assert.deepEqual(filterEacRows(rows, { search: "d@example.com" }).map((r) => r.name), ["User D"]);
    assert.deepEqual(filterEacRows(rows, { onlyNotConnected: true, search: "sales" }).map((r) => r.name), ["User B"]);
  });

  await test("eac: CSV rows (as shown and everyone), with plain status, API name and formula guard", () => {
    const rows = mixed();
    const shown = eacCsvRows(filterEacRows(rows, { onlyNotConnected: true }));
    assert.deepEqual(shown[0], ["Configuration", "Name", "Username", "Email", "Active", "How assigned", "Connection status", "Connected", "Contacts synced", "Events synced", "Note", "Status (API name)", "Recommended action", "About the action", "Terms accepted"]);
    assert.equal(shown.length, 1 + 4);
    assert.equal(eacCsvRows(rows).length, 1 + 6);
    const b = shown.find((r) => r[1] === "User B");
    assert.deepEqual([b[6], b[7], b[11]], [NO_STATUS_TEXT, "No", ""]);
    const f = shown.find((r) => r[1] === "User F");
    assert.deepEqual([f[6], f[7], f[11], f[8], f[5]], [ASSIGNED_ONLY_TEXT, "No", "", "", "Directly"], "assigned-only has no API status and no sync answers");
    const text = toCsv(eacCsvRows([{ ...rows[0], name: "=HYPERLINK(\"x\")" }]));
    assert.ok(text.startsWith("﻿"));
    assert.ok(text.includes("\"'=HYPERLINK") || text.includes("'=HYPERLINK"), "leading = is guarded");
    assert.ok(!/\r\n$/.test(text.trimEnd()) || text.endsWith("\r\n"));
  });

  await test("eac: one user's read gives configuration, status words, action, syncs and terms", async () => {
    const org = fakeOrg({
      status: [st("005USER00000001", "Sales Team Standard", "NEEDSATTENTION", { RecommendedActionTitle: "Reconnect your account", RecommendedActionDescription: "The connection was lost.", ContactsSynced: true, EventsSynced: false, IsTermsOfServiceAccepted: true })],
      sync: [{ AssignedId: "005USER00000001", ConfigurationId: "063A" }],
      configs: [{ Id: "063A", Name: "Sales Team Standard" }],
    });
    const a = await readUserAccess(org, "005USER00000001");
    assert.deepEqual(a.unavailable, {});
    assert.deepEqual(a.warnings, []);
    assert.equal(a.sections.eac.length, 1);
    const it = a.sections.eac[0];
    assert.equal(it.key, "Sales Team Standard");
    assert.equal(it.statusText, "Needs attention");
    const d = eacDetailText(it);
    for (const want of ["Status: Needs attention", "Recommended action: Reconnect your account", "The connection was lost.", "Contacts synced: Yes", "Events synced: No", "Terms accepted: Yes", "Assigned: Directly"]) {
      assert.ok(d.includes(want), `${want} in\n${d}`);
    }
    assert.ok(!d.includes("NEEDSATTENTION"), "no API name in the plain text");
    validateAccess(a);
    const csv = toRowsSingle(a, "eac");
    assert.equal(csv.length, 2);
    assert.equal(csv[1][2], "Email and calendar (Einstein Activity Capture)");
    assert.match(csv[1][5], /Status: Needs attention; Recommended action/, "included in the user's CSV, one line per cell");
  });

  await test("eac: a user assigned with no status row, and one on their profile, in a real read", async () => {
    const org = fakeOrg({ sync: [{ AssignedId: "005USER00000001", ConfigurationId: "063A" }, { AssignedId: "00ePROF00000001", ConfigurationId: "063B" }, { AssignedId: "00eOTHER0000001", ConfigurationId: "063A" }],
      configs: [{ Id: "063A", Name: "Sales Team Standard" }, { Id: "063B", Name: "Service Reps" }] });
    const a = await readUserAccess(org, "005USER00000001");
    const by = Object.fromEntries(a.sections.eac.map((i) => [i.key, i]));
    assert.deepEqual(Object.keys(by).sort(), ["Sales Team Standard", "Service Reps"], "another profile's assignment is not shown");
    assert.equal(by["Sales Team Standard"].statusText, ASSIGNED_ONLY_TEXT);
    assert.equal(by["Service Reps"].via, "profile");
    assert.match(eacDetailText(by["Service Reps"]), /Through the profile Sales Standard/);
  });

  await test("eac: neither EAC object is ever filtered with a WHERE (one user or everyone); rows are filtered in memory", async () => {
    const log = [];
    // The fake org answers any WHERE on these two objects with the generic server error a real org gives.
    const org = fakeOrg({
      status: [st("005USER00000001", "Sales", "ACTIVE"), st("005OTHER0000001", "Sales", "ACTIVE")],
      sync: [{ AssignedId: "005USER00000001", ConfigurationId: "063A" }, { AssignedId: "005OTHER0000001", ConfigurationId: "063A" }, { AssignedId: "00eOTHERPROF001", ConfigurationId: "063B" }],
      configs: [{ Id: "063A", Name: "Sales" }],
    }, log);
    const a = await readUserAccess(org, "005USER00000001");
    assert.deepEqual(a.warnings, []);
    assert.deepEqual(a.sections.eac.map((i) => i.key), ["Sales"], "only this user's rows, and another profile's assignment is dropped");
    assert.equal(a.sections.eac[0].statusText, "Connected");
    const raw = await readEacRaw(org, { forUser: { userId: "005USER00000001", profileId: "00ePROF00000001" } });
    assert.equal(raw.statuses.length, 1);
    assert.equal(raw.assignments.length, 1);
    await readEacRaw(org);
    const eacQueries = log.filter((c) => /FROM (ActivityUsrConnectionStatus|UserEmailCalendarSync)/.test(c.q || ""));
    assert.ok(eacQueries.length >= 6);
    for (const c of eacQueries) assert.ok(!/\bWHERE\b|\bIN\s*\(/i.test(c.q), `no WHERE: ${c.q}`);
  });

  await test("eac: objects missing -> plain 'not turned on' text, no warning, and the rest of the page still reads", async () => {
    const a = await readUserAccess(fakeOrg({ off: true }), "005USER00000001");
    assert.equal(a.unavailable.eac, EAC_OFF_TEXT);
    assert.match(EAC_OFF_TEXT, /not turned on in this org, or you can't see it/);
    assert.deepEqual(a.sections.eac, []);
    assert.deepEqual(a.warnings, [], "an org without EAC is not a problem");
    assert.equal(a.sections.profile[0].label, "Sales Standard", "other areas are unaffected");
    assert.deepEqual(Object.keys(a.unavailable), ["eac"]);
    await assert.rejects(() => readEacRaw(fakeOrg({ off: true })), (e) => e.featureOff === true && e.message === EAC_OFF_TEXT);
  });

  await test("eac: one object failing keeps the other and says the list may be incomplete", async () => {
    const raw = await readEacRaw(fakeOrg({ failSync: "boom", status: [st("005A", "Sales", "ACTIVE")] }));
    assert.equal(raw.statuses.length, 1);
    assert.match(raw.partial, /may be incomplete/);
    assert.ok(raw.warnings.some((w) => /boom/.test(w)));
    const a = await readUserAccess(fakeOrg({ failStatus: "boom", sync: [{ AssignedId: "005USER00000001", ConfigurationId: "063A" }], configs: [{ Id: "063A", Name: "Sales" }] }), "005USER00000001");
    assert.equal(a.sections.eac.length, 1);
    assert.ok(a.warnings.some((w) => /may be incomplete/.test(w)));
    const both = await readUserAccess(fakeOrg({ failStatus: "nope", failSync: "nope" }), "005USER00000001");
    assert.match(both.unavailable.eac, /could not be read/);
    assert.equal(both.sections.profile.length, 1);
  });

  await test("eac: everyone read counts the rows it reads (COUNT() says 0), pages through, and reads user names in batches", async () => {
    const log = [];
    const status = Array.from({ length: 450 }, (_, i) => st(`005DEMO0000${String(i).padStart(4, "0")}`, i % 2 ? "Sales" : "Assistants", i % 3 ? null : "ACTIVE"));
    const users = status.map((s, i) => ({ Id: s.UserId, Name: `User ${i}`, Username: `u${i}@example.com`, IsActive: true }));
    const raw = await readEacRaw(fakeOrg({ status, users, sync: [] }, log));
    assert.equal(raw.statuses.length, 450);
    const { rows } = buildEacRows(raw);
    assert.equal(eacCounts(rows).rows, 450);
    assert.ok(!log.some((c) => /COUNT\(\)/i.test(c.q || "")), "no COUNT() on the EAC objects");
    const userQueries = log.filter((c) => /FROM User WHERE Id IN/.test(c.q || ""));
    assert.equal(userQueries.length, 3, "450 users in batches of 200");
    assert.ok(userQueries.every((c) => (c.q.match(/'/g) || []).length <= 400));
    assert.equal(rows.find((r) => r.userId === "005DEMO00000007").name, "User 7");
  });

  await test("eac: user Ids that do not look like Ids never reach a query", async () => {
    const log = [];
    await readEacRaw(fakeOrg({ status: [st("005A' OR Name != '", "Sales", "ACTIVE"), st("005GOOD0000000001", "Sales", "ACTIVE")], sync: [] }, log));
    const q = log.find((c) => /FROM User WHERE Id IN/.test(c.q || "")).q;
    assert.ok(!q.includes("OR Name"), q);
    assert.ok(q.includes("005GOOD0000000001"));
  });

  await test("eac: the read only issues GET requests", async () => {
    const log = [];
    const org = fakeOrg({ status: [st("005USER00000001", "Sales", null)], sync: [{ AssignedId: "005USER00000001", ConfigurationId: "063A" }], configs: [{ Id: "063A", Name: "Sales" }], users: [] }, log);
    await readUserAccess(org, "005USER00000001");
    await readEacRaw(org);
    await readEacRaw(fakeOrg({ off: true }, log)).catch(() => {});
    assert.ok(log.some((c) => /ActivityUsrConnectionStatus/.test(c.q || "")));
    assert.ok(log.some((c) => /UserEmailCalendarSync/.test(c.q || "")));
    for (const c of log) assert.equal(c.method, "GET");
    assert.ok(log.every((c) => c.path.startsWith("/services/data/")));
  });

  await test("eac: compare matches by configuration NAME, not Id, and flags a different status", () => {
    const mk = (name, built) => {
      const a = { schema: "sf-user-access/1", user: { id: "005" + name, name, username: `${name}@example.com`, isActive: true }, sections: Object.fromEntries(SECTION_KEYS.map((k) => [k, []])) };
      a.sections.eac = built.rows.map(eacItem);
      return validateAccess(a);
    };
    const a = mk("Avery", buildEacRows({ statuses: [st("005A", "Sales", "ACTIVE"), st("005A", "Only A", "ACTIVE")], assignments: [{ AssignedId: "005A", ConfigurationId: "063-ORG1-ID" }], configs: { "063-ORG1-ID": "Sales" } }));
    const b = mk("Blake", buildEacRows({ statuses: [st("005B", "Sales", null)], assignments: [{ AssignedId: "005B", ConfigurationId: "063-ORG2-ID" }], configs: { "063-ORG2-ID": "Sales" } }));
    const r = compareUsers(a, b);
    const rows = Object.fromEntries(r.sections.eac.map((x) => [x.key, x.status]));
    assert.deepEqual(rows, { Sales: "differ", "Only A": "onlyA" });
    assert.deepEqual([r.counts.eac.differ, r.counts.eac.onlyA, r.counts.eac.onlyB], [1, 1, 0]);
    const same = compareUsers(a, mk("Casey", buildEacRows({ statuses: [st("005C", "Sales", "ACTIVE"), st("005C", "Only A", "ACTIVE")], assignments: [{ AssignedId: "005C", ConfigurationId: "063-ORG3-ID" }], configs: { "063-ORG3-ID": "Sales" } })));
    assert.deepEqual(same.sections.eac.map((x) => x.status), ["same", "same"], "same names and facts -> same, whatever the Ids");
    const csv = toRows(r, "eac");
    assert.equal(csv.length, 1 + 2);
    assert.ok(csv.some((row) => row[1] === "Sales" && row[3] === "Different" && /Not connected yet/.test(row[5])));
    assert.ok(csv.some((row) => row[1] === "Only A" && row[3] === "Only Avery" && row[5] === "No"));
  });

  await test("eac: names come from users who have both rows; a name that cannot be found shows the full Id", () => {
    const users = ["A", "B", "C", "D"].map((x) => ({ Id: `005${x}`, Name: `User ${x}`, Username: `${x}@example.com`, Email: `${x}@mail.example.com`, IsActive: true }));
    const { rows } = buildEacRows({
      // A and B each have one status row and one assignment: that names configuration 063X. C has only an assignment to 063YYYYYYYYYYYY.
      statuses: [st("005A", "Sales Team", "ACTIVE"), st("005B", "Sales Team", null), st("005D", "Other", "ACTIVE")],
      assignments: [{ AssignedId: "005A", ConfigurationId: "063X" }, { AssignedId: "005B", ConfigurationId: "063X" }, { AssignedId: "005C", ConfigurationId: "063YYYYYYYYYYYY" }],
      users,
    });
    const by = (n) => rows.find((r) => r.name === n);
    assert.equal(by("User A").configuration, "Sales Team");
    assert.equal(by("User B").configuration, "Sales Team");
    assert.equal(by("User C").configuration, "Unnamed configuration (Id 063YYYYYYYYYYYY)", "the full Id is shown so Setup's Configurations tab can be matched");
    assert.equal(by("User D").configuration, "Other");
    assert.equal(by("User A").email, "A@mail.example.com");
    // The status row's UserName is a display name: it is the fallback for a person the User read did not return.
    const fb = buildEacRows({ statuses: [st("005Z", "Sales Team", "ACTIVE", { UserName: "Zed Display" })] }).rows[0];
    assert.equal(fb.name, "Zed Display");
    assert.equal(fb.username, "");
    assert.equal(groupByConfig(rows).length, 3);
  });

  await test("eac: a profile assignment lists every member, once, and says both ways when a user has both", () => {
    const users = [
      { Id: "005A", Name: "Avery", Username: "a@example.com", IsActive: true },
      { Id: "005B", Name: "Blake", Username: "b@example.com", IsActive: true },
      { Id: "005C", Name: "Casey", Username: "c@example.com", IsActive: false },
    ];
    const built = buildEacRows({
      statuses: [st("005A", "Service Reps", "ACTIVE")],
      assignments: [{ AssignedId: "005A", ConfigurationId: "063X" }, { AssignedId: "00ePROF00000001", ConfigurationId: "063X" }, { AssignedId: "00ePROF00000001", ConfigurationId: "063X" }],
      configs: { "063X": "Service Reps" },
      profiles: { "00ePROF00000001": "Service Standard" },
      profileMembers: { "00ePROF00000001": ["005A", "005B", "005C", "005B"] },
      users,
    });
    assert.equal(built.rows.length, 3, "A direct and through the profile is one row; B listed twice and assigned twice is one row");
    assert.deepEqual(built.profileAssignments, []);
    const by = Object.fromEntries(built.rows.map((r) => [r.name, r]));
    assert.equal(assignedText(by.Avery), "Directly and through the profile Service Standard");
    assert.equal(assignedText(by.Blake), "Through the profile Service Standard");
    assert.equal(by.Avery.statusText, "Connected", "A keeps their status row");
    assert.equal(by.Blake.statusText, ASSIGNED_ONLY_TEXT);
    const csv = eacCsvRows(built.rows);
    assert.equal(csv.find((r) => r[1] === "Avery")[5], "Directly and through the profile Service Standard");
    assert.equal(csv.find((r) => r[1] === "Blake")[5], "Through the profile Service Standard");
  });

  await test("eac: inactive users who are still assigned are flagged, filtered and listed in the CSV", () => {
    const users = [{ Id: "005A", Name: "Avery", Username: "a@example.com", IsActive: true }, { Id: "005B", Name: "Blake", Username: "b@example.com", IsActive: false }, { Id: "005C", Name: "Casey", Username: "c@example.com", IsActive: false }];
    const { rows } = buildEacRows({
      statuses: [st("005A", "Sales", "ACTIVE")], configs: { "063X": "Sales" }, users,
      assignments: [{ AssignedId: "005A", ConfigurationId: "063X" }, { AssignedId: "005B", ConfigurationId: "063X" }, { AssignedId: "00ePROF00000001", ConfigurationId: "063X" }],
      profileMembers: { "00ePROF00000001": ["005C"] },
    });
    const only = filterEacRows(rows, { show: "inactive" });
    assert.deepEqual(only.map((r) => r.name).sort(), ["Blake", "Casey"], "direct and through-profile inactive users");
    assert.ok(only.every((r) => !r.isActive));
    assert.equal(eacCounts(rows).inactive, 2);
    const csv = eacCsvRows(only);
    assert.ok(csv.slice(1).every((r) => r[4] === "No" && r[10].includes(INACTIVE_TEXT)));
    assert.deepEqual(filterEacRows(rows, { show: "inactive", search: "casey" }).map((r) => r.name), ["Casey"]);
    assert.ok(SHOW_CHOICES.some((c) => c.value === "inactive" && /Inactive users still assigned/.test(c.label)));
  });

  await test("eac: connected with nothing synced yet is flagged only for ACTIVE with both syncs KNOWN and 0 or false (blank is unknown, not flagged)", () => {
    const mk = (id, status, c, e) => st(id, "Sales", status, { ContactsSynced: c, EventsSynced: e });
    const { rows } = buildEacRows({
      statuses: [mk("005A", "ACTIVE", false, false), mk("005B", "ACTIVE", null, null), mk("005C", "ACTIVE", 0, 0), mk("005D", "ACTIVE", true, false), mk("005E", "ACTIVE", 5, 0), mk("005F", "PENDING", false, false), mk("005G", "ACTIVE", null, 0), mk("005H", "ACTIVE", false, null)],
      users: ["A", "B", "C", "D", "E", "F", "G", "H"].map((x) => ({ Id: `005${x}`, Name: `User ${x}`, Username: `${x}@example.com`, IsActive: true })),
    });
    const flagged = filterEacRows(rows, { show: "nothingSynced" }).map((r) => r.name).sort();
    assert.deepEqual(flagged, ["User A", "User C"], "both null, or one null and one 0, is unknown and not flagged");
    assert.equal(eacCounts(rows).nothingSynced, 2);
    const csv = eacCsvRows(rows);
    assert.equal(csv.find((r) => r[1] === "User A")[10], NOTHING_SYNCED_TEXT);
    assert.equal(csv.find((r) => r[1] === "User D")[10], "");
    assert.equal(csv.find((r) => r[1] === "User E")[8], "5", "a count is shown as the count");
  });

  await test("eac: users with access but in no configuration come from the permission query, and one missing field is not a problem", async () => {
    const [fA, fB] = EAC_PERMISSION_FIELDS;
    assert.deepEqual(EAC_PERMISSION_FIELDS, ["PermissionsAutomaticActivityCapture", "PermissionsStdAutomaticActivityCapture"]);
    const mk = (access, log = []) => fakeOrg({
      status: [st("005AAAA00000001", "Sales", "ACTIVE")],
      sync: [{ AssignedId: "005AAAA00000001", ConfigurationId: "063A" }, { AssignedId: "005BBBB00000002", ConfigurationId: "063A" }],
      users: [
        { Id: "005AAAA00000001", Name: "Avery Example", Username: "a@example.com", Email: "a@example.com", IsActive: true },
        { Id: "005BBBB00000002", Name: "Blake Sample", Username: "b@example.com", Email: "b@example.com", IsActive: true },
        { Id: "005CCCC00000003", Name: "Casey Demo", Username: "c@example.com", Email: "c@example.com", IsActive: true },
        { Id: "005DDDD00000004", Name: "Drew Placeholder", Username: "d@example.com", Email: "d@example.com", IsActive: true },
      ],
      access,
    }, log);
    const byField = { [fA]: ["005AAAA00000001", "005CCCC00000003"], [fB]: ["005DDDD00000004", "005BBBB00000002"] };
    const none = (raw) => buildEacRows(raw).noConfig.map((u) => u.name);

    const log = [];
    const both = await readEacRaw(mk({ byField }, log));
    assert.deepEqual(none(both), ["Casey Demo", "Drew Placeholder"], "A and B are in a configuration; C and D have access but are in none");
    const q = log.find((c) => /SELECT AssigneeId FROM PermissionSetAssignment/.test(c.q || "")).q;
    assert.equal(q, `SELECT AssigneeId FROM PermissionSetAssignment WHERE Assignee.IsActive = true AND (PermissionSet.${fA} = true OR PermissionSet.${fB} = true)`);
    assert.equal(both.accessNote, "");

    const noStd = await readEacRaw(mk({ byField, missing: [fB] }));
    assert.deepEqual(none(noStd), ["Casey Demo"], "the Standard field is missing: the other one is used");
    const noMain = await readEacRaw(mk({ byField, missing: [fA] }));
    assert.deepEqual(none(noMain), ["Drew Placeholder"], "the other way round");
    assert.equal(noStd.accessNote, "");

    const failed = await readEacRaw(mk({ byField, failAll: true }));
    assert.equal(failed.accessUserIds, null);
    assert.match(failed.accessNote, /could not be read/);
    const built = buildEacRows(failed);
    assert.equal(built.noConfig, null);
    assert.equal(built.rows.length, 2, "everything else is kept");
    assert.equal(failed.warnings.length, 0, "one plain note, not a pile of warnings");

    const direct = await readEacAccessUserIds(mk({ byField, failAll: true }));
    assert.deepEqual([direct.ids, typeof direct.note], [null, "string"]);

    const csv = noConfigCsvRows(buildEacRows(both).noConfig);
    assert.deepEqual(csv[0], ["Name", "Username", "Email", "Active", "Note"]);
    assert.deepEqual(csv.slice(1).map((r) => [r[0], r[3], r[4]]), [["Casey Demo", "Yes", NO_CONFIG_TITLE], ["Drew Placeholder", "Yes", NO_CONFIG_TITLE]]);
    assert.deepEqual(filterNoConfig(buildEacRows(both).noConfig, { search: "drew" }).map((u) => u.name), ["Drew Placeholder"]);
  });

  await test("eac: 1,200+ members across configurations and a profile: paged, counted, complete, per-configuration CSV", async () => {
    const log = [];
    const progress = [];
    const U = (i) => `005BULK${String(i).padStart(8, "0")}AAA`;
    const names = ["Sales Team Standard", "Executive Assistants", "Service Reps"];
    const cfgId = (k) => `063CFG${String(k).padStart(9, "0")}`;
    const users = [];
    const status = [];
    const sync = [];
    for (let i = 0; i < 1200; i++) {
      users.push({ Id: U(i), Name: `Person ${i}`, Username: `p${i}@example.com`, Email: `p${i}@example.com`, IsActive: i % 50 !== 0 });
      status.push(st(U(i), names[i % 3], i % 4 === 0 ? "ACTIVE" : null, { ContactsSynced: i % 8 === 0, EventsSynced: i % 8 === 0 }));
      sync.push({ AssignedId: U(i), ConfigurationId: cfgId(i % 3) });
    }
    // A profile assignment to a fourth configuration that no status row names: 100 of the 1,200 plus 200 more people.
    const profileUsers = [];
    for (let i = 0; i < 100; i++) profileUsers.push(users[i * 11]);
    for (let i = 1200; i < 1400; i++) profileUsers.push({ Id: U(i), Name: `Person ${i}`, Username: `p${i}@example.com`, Email: `p${i}@example.com`, IsActive: i % 2 === 0 });
    sync.push({ AssignedId: "00ePROFBULK00001", ConfigurationId: cfgId(9) });
    // Five people with access and no configuration.
    const extra = Array.from({ length: 5 }, (_, i) => ({ Id: U(2000 + i), Name: `Spare ${i}`, Username: `s${i}@example.com`, Email: `s${i}@example.com`, IsActive: true }));
    const org = fakeOrg({
      noConfigObject: true, pageSize: 500, status, sync, users: [...users, ...extra], profiles: [{ Id: "00ePROFBULK00001", Name: "Field Staff" }],
      profileUsers: { "00ePROFBULK00001": profileUsers },
      access: { byField: { PermissionsAutomaticActivityCapture: [...users, ...profileUsers, ...extra].map((x) => x.Id) } },
    }, log);
    const raw = await readEacRaw(org, { progress: (t) => progress.push(t) });
    assert.equal(raw.statuses.length, 1200);
    assert.equal(raw.profileMembers["00ePROFBULK00001"].length, 300);
    assert.ok(log.some((c) => /\/query\/01g/.test(c.path)), "results came in pages");
    assert.ok(progress.some((t) => /1,200 connections/.test(t)), progress.join(" | "));
    assert.ok(progress.some((t) => /users/.test(t)));
    assert.ok(!log.some((c) => /FROM (ActivityUsrConnectionStatus|UserEmailCalendarSync)\b[\s\S]*\bWHERE\b/.test(c.q || "")));

    const { rows, noConfig, profileAssignments } = buildEacRows(raw);
    assert.deepEqual(profileAssignments, []);
    assert.equal(rows.length, 1500, "1,200 rows with a status and a direct assignment, plus 300 profile members");
    assert.equal(eacCounts(rows).users, 1400, "the profile members that are also assigned directly are not counted twice as people");
    const groups = groupByConfig(rows);
    const sizes = Object.fromEntries(groups.map((g) => [g.name, g.rows.length]));
    const unnamed = `Unnamed configuration (Id ${cfgId(9)})`;
    assert.deepEqual(sizes, { "Executive Assistants": 400, [unnamed]: 300, "Sales Team Standard": 400, "Service Reps": 400 });
    assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), rows.length, "the member counts add up to the rows read");
    // Every profile member appears, in the profile's configuration.
    const inProfile = new Set(groups.find((g) => g.name === unnamed).rows.map((r) => r.userId));
    for (const u of profileUsers) assert.ok(inProfile.has(u.Id), `${u.Name} is a member`);
    assert.ok(groups.find((g) => g.name === unnamed).rows.every((r) => assignedText(r).includes("Through the profile Field Staff")));
    // Per-configuration CSV: one line per member, plus the header.
    for (const g of groups) assert.equal(eacCsvRows(g.rows).length, g.rows.length + 1, g.name);
    assert.equal(eacCsvRows(rows).length, 1501);
    assert.equal(noConfig.length, 5);
    assert.deepEqual(noConfig.map((u) => u.name), ["Spare 0", "Spare 1", "Spare 2", "Spare 3", "Spare 4"]);
    assert.equal(filterEacRows(rows, { show: "inactive" }).length, eacCounts(rows).inactive);
    for (const c of log) assert.equal(c.method, "GET");
  });

  await test("eac: the summary line counts distinct users, a user in two configurations once", () => {
    const st = (uid, cfg, status) => ({ UserId: uid, UserName: uid, ConfigurationName: cfg, ConnectivityStatus: status });
    const { rows } = buildEacRows({ statuses: [st("005A00000000001", "Sales", "ACTIVE"), st("005A00000000001", "Service", null), st("005B00000000002", "Sales", null)] });
    const c = eacCounts(rows);
    assert.equal(c.rows, 3);
    assert.deepEqual([c.users, c.connectedUsers, c.notConnectedUsers], [2, 1, 1]);
    assert.equal(eacSummaryLine(c), "2 users: 1 connected, 1 not connected.");
  });

  await test("eac: plain notes for empty configurations and a user with no setup; the demo users agree", () => {
    assert.match(EMPTY_CONFIG_NOTE, /Configurations with no users are not shown/);
    assert.match(NO_EAC_USER_TEXT, /Not in any Einstein Activity Capture configuration/);
    const html = readFileSync(path.join(here, "..", "tools", "user-access", "user-access.html"), "utf-8");
    assert.ok(html.includes("Everyone in a configuration (CSV for Excel)"));
    assert.ok(!html.includes(">Everyone (CSV"));
    const b = sample("user_b.json").sections.eac[0];
    const demo = buildEacRows(sample("eac_all_demo.json")).rows.find((r) => r.name === "Blake Sample");
    assert.equal(b.statusText, demo.statusText, "Blake is the same in both demo files");
  });

  await test("eac: older files without the area still load and compare", () => {
    const old = sample("user_a.json");
    delete old.sections.eac;
    const v = validateAccess(old);
    assert.deepEqual(v.sections.eac, []);
  });

  await test("eac demo files: users compare, everyone view covers statuses, blank, assigned-only and a profile, and all is synthetic", () => {
    const a = validateAccess(sample("user_a.json"));
    const b = validateAccess(sample("user_b.json"));
    const r = compareUsers(a, b);
    assert.deepEqual(r.sections.eac.map((x) => x.status), ["differ"]);
    const raw = sample("eac_all_demo.json");
    const { rows, profileAssignments, noConfig } = buildEacRows(raw);
    const c = eacCounts(rows);
    assert.ok(c.byConfig.length >= 3);
    for (const v of Object.keys(STATUS_WORDS)) assert.ok(rows.some((x) => x.status === v), `demo has ${v}`);
    assert.ok(rows.some((x) => x.hasRow && x.status === null), "a blank status");
    assert.ok(rows.some((x) => !x.hasRow), "assigned, no status row");
    assert.equal(profileAssignments.length, 0, "the profile members are listed as rows");
    assert.ok(rows.some((x) => x.profiles.length), "a member through a profile");
    assert.ok(rows.some((x) => x.direct && x.profiles.length), "a user both direct and through the profile");
    assert.ok(rows.some((x) => !x.isActive), "an inactive user");
    assert.ok(rows.some((x) => x.nothingSynced), "connected, nothing synced");
    assert.ok(rows.some((x) => /^Unnamed configuration \(Id 063DEMO/.test(x.configuration)), "a configuration with no name");
    assert.ok(noConfig.length >= 2, "users with access in no configuration");
    assert.ok(rows.every((x) => x.name && x.username.endsWith("@example.com")), "names and example.com usernames");
    assert.ok(rows.some((x) => x.name === "Avery Example"));
    const text = readFileSync(path.join(here, "..", "samples", "eac_all_demo.json"), "utf-8");
    assert.ok(!/[\w.]+@(?!example\.com)[\w.-]+/.test(text), "only example.com addresses");
    for (const id of text.match(/"(?:Id|UserId|AssignedId|ConfigurationId)": "(\w+)"/g) || []) assert.match(id, /DEMO/, "made-up Ids only");
    assert.ok(!/00D[A-Za-z0-9]{12}/.test(text), "no real-looking org Id");
  });

  await test("eac: new files never use innerHTML, localStorage or chrome.storage, and send no write verbs", () => {
    for (const f of ["user-access-eac.js", "user-access-eac-read.js", "user-access-eac-changes.js"]) {
      const text = readFileSync(path.join(here, "..", "tools", "user-access", f), "utf-8");
      for (const bad of ["innerHTML", "insertAdjacentHTML", "outerHTML", "localStorage", "chrome.storage", "POST", "PATCH", "DELETE", "method:"]) assert.ok(!text.includes(bad), `${f} contains ${bad}`);
      assert.ok(!/\bCOUNT\s*\(/i.test(text.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")), `${f} has no COUNT() call`);
      assert.ok(!/from\s+["']\.\.\/(?!\.\.\/shared)[a-z-]+\//.test(text), "no imports from another tool");
    }
    const page = readFileSync(path.join(here, "..", "tools", "user-access", "user-access.js"), "utf-8");
    assert.ok(!page.includes("innerHTML"));
  });

  // ----- changes as text (issue #42) -----
  const pad = (n) => String(n).padStart(12, "0");
  const U = (n) => `005${pad(n)}AAA`;
  const CF = (n) => `063${pad(n)}AAA`;
  const AS = (n) => `0M0${pad(n)}AAA`;
  const PROF = `00e${pad(1)}AAA`;
  const [A, B, C] = [CF(1), CF(2), CF(3)];
  const person = (n, name, active = true) => ({ Id: U(n), Name: name, Username: `u${n}@example.com`, Email: `person${n}@example.org`, IsActive: active });
  const world = () => buildEacRows({
    statuses: [],
    assignments: [
      { Id: AS(1), AssignedId: U(1), ConfigurationId: A }, { Id: AS(2), AssignedId: U(2), ConfigurationId: A },
      { Id: AS(3), AssignedId: U(3), ConfigurationId: B }, { Id: AS(4), AssignedId: PROF, ConfigurationId: A },
      { Id: AS(6), AssignedId: U(6), ConfigurationId: A }, { Id: AS(7), AssignedId: U(6), ConfigurationId: C },
    ],
    configs: { [A]: "Config A", [B]: "Config B", [C]: "Config C" },
    users: [person(1, "Uma One"), person(2, "Ivan Inactive", false), person(3, "Bea Three"), person(4, "Pia Profile"), person(6, "Dee Double"), person(7, "Nora None"), person(8, "Ned Off", false)],
    profiles: { [PROF]: "Service Standard" }, profileMembers: { [PROF]: [U(4)] },
  });
  const rowOf = (rows, n, cfg) => rows.find((r) => r.userId === U(n) && (!cfg || r.configId === cfg));
  const asEntries = (rows, ...ns) => ns.map((n) => (n === 7 ? entryFromRecord(person(7, "Nora None")) : n === 8 ? entryFromRecord(person(8, "Ned Off", false)) : n === 6 ? entryFromUser({ userId: U(6), name: "Dee Double", isActive: true }) : entryFromRow(rowOf(rows, n))));
  const skippedBy = (plan) => Object.fromEntries(plan.skipped.map((s) => [s.name, s.code]));
  const shown = (plan) => ({ ...plan, previewed: true });

  await test("changes: rows carry the assignment row Id; every profile assignment is a row of its own", () => {
    const { rows, profileRows } = world();
    assert.deepEqual(rowOf(rows, 1).assignmentIds, [AS(1)]);
    assert.deepEqual(rowOf(rows, 4).assignmentIds, [], "through a profile only: no row of their own");
    assert.deepEqual(profileRows.map((p) => [p.id, p.profileId, p.profileName, p.configId, p.configuration, p.members]), [[AS(4), PROF, "Service Standard", A, "Config A", 1]]);
    assert.deepEqual(knownConfigs(rows, profileRows).map((c) => [c.name, c.count]), [["Config A", 4], ["Config B", 1], ["Config C", 1]]);
  });

  await test("changes: Add gives the exact header and rows, and applies every skip rule", () => {
    const { rows } = world();
    const plan = planChange({ action: "add", targetId: B, entries: asEntries(rows, 1, 2, 3, 4, 6, 7, 8), rows });
    assert.equal(plan.error, "");
    assert.deepEqual(plan.items.map((i) => i.userId), [U(7)]);
    assert.deepEqual(skippedBy(plan), {
      "Uma One": "useMove", "Ivan Inactive": "inactive", "Bea Three": "alreadyThere", "Pia Profile": "profileOnly", "Dee Double": "useMove", "Ned Off": "inactive",
    });
    const t = changeTable(plan);
    assert.deepEqual(t.header, ["AssignedId", "ConfigurationId"]);
    assert.equal(t.op, "Insert");
    assert.equal(tabText(t), `AssignedId\tConfigurationId\n${U(7)}\t${B}`);
    assert.equal(csvText(t), `AssignedId,ConfigurationId\r\n${U(7)},${B}\r\n`);
    assert.equal(undoTable(plan), null, "an add cannot be undone from here");
    assert.match(NO_UNDO_ADD, /read again and use Remove/);
    assert.ok(skipGroups(plan).some((g) => g.code === "useMove" && g.entries.length === 2));
  });

  await test("changes: Add skips a user already in the target through a profile, and counts a user picked twice once", () => {
    const { rows } = world();
    const plan = planChange({ action: "add", targetId: A, entries: [...asEntries(rows, 4), ...asEntries(rows, 7, 7)], rows });
    assert.deepEqual(skippedBy(plan), { "Pia Profile": "alreadyThere" });
    assert.deepEqual(plan.items.map((i) => i.userId), [U(7)]);
  });

  await test("changes: Move gives Id and ConfigurationId, the undo goes back to the old configuration, and every skip rule applies", () => {
    const { rows } = world();
    const plan = planChange({ action: "move", targetId: B, entries: asEntries(rows, 1, 2, 3, 4, 6, 7), rows });
    assert.deepEqual(plan.items.map((i) => [i.assignmentId, i.fromConfigId]), [[AS(1), A], [AS(2), A]], "an inactive user can be moved");
    assert.deepEqual(skippedBy(plan), { "Bea Three": "alreadyThere", "Pia Profile": "profileOnly", "Dee Double": "severalRows", "Nora None": "notIn" });
    const t = changeTable(plan);
    assert.equal(tabText(t), `Id\tConfigurationId\n${AS(1)}\t${B}\n${AS(2)}\t${B}`);
    assert.equal(t.op, "Update");
    const u = undoTable(plan);
    assert.equal(u.op, "Update");
    assert.equal(tabText(u), `Id\tConfigurationId\n${AS(1)}\t${A}\n${AS(2)}\t${A}`);
    assert.equal(csvText(t), `Id,ConfigurationId\r\n${AS(1)},${B}\r\n${AS(2)},${B}\r\n`);
    // Ticking the row of one configuration says which assignment to move.
    const one = planChange({ action: "move", targetId: B, entries: [entryFromRow(rowOf(rows, 6, A))], rows });
    assert.deepEqual(one.items.map((i) => i.assignmentId), [AS(6)]);
    assert.equal(one.skipped.length, 0);
  });

  await test("changes: Remove gives Id only, skips profile-only users, offers whole profile assignments, and the undo inserts them back", () => {
    const { rows, profileRows } = world();
    const plan = planChange({ action: "remove", entries: asEntries(rows, 1, 2, 4, 6, 7), profileItems: profileRows, rows });
    assert.deepEqual(plan.items.map((i) => i.assignmentId), [AS(1), AS(2)]);
    assert.deepEqual(skippedBy(plan), { "Pia Profile": "profileOnly", "Dee Double": "severalRows", "Nora None": "notIn" });
    assert.deepEqual(plan.profileItems.map((p) => p.id), [AS(4)]);
    const t = changeTable(plan);
    assert.equal(t.op, "Delete");
    assert.equal(tabText(t), `Id\n${AS(1)}\n${AS(2)}\n${AS(4)}`);
    assert.equal(csvText(t), `Id\r\n${AS(1)}\r\n${AS(2)}\r\n${AS(4)}\r\n`);
    const u = undoTable(plan);
    assert.equal(u.op, "Insert");
    assert.equal(tabText(u), `AssignedId\tConfigurationId\n${U(1)}\t${A}\n${U(2)}\t${A}\n${PROF}\t${A}`);
    assert.match(previewSummary(plan), /Remove 2 users from their configuration and remove 1 whole profile assignment\./);
    const row = planChange({ action: "remove", entries: [entryFromRow(rowOf(rows, 6, C))], rows });
    assert.deepEqual(row.items.map((i) => [i.assignmentId, i.fromConfigId]), [[AS(7), C]]);
  });

  await test("changes: a user in a configuration directly and through a profile keeps the profile note on Remove", () => {
    const rows = buildEacRows({
      assignments: [{ Id: AS(1), AssignedId: U(1), ConfigurationId: A }, { Id: AS(4), AssignedId: PROF, ConfigurationId: A }],
      configs: { [A]: "Config A" }, users: [person(1, "Uma One")], profiles: { [PROF]: "Service Standard" }, profileMembers: { [PROF]: [U(1)] },
    }).rows;
    const plan = planChange({ action: "remove", entries: [entryFromRow(rows[0])], rows });
    assert.deepEqual(plan.items.map((i) => i.assignmentId), [AS(1)]);
    assert.match(plan.items[0].note, /Still in Config A through the profile Service Standard/);
  });

  await test("changes: a typed configuration Id is 063 plus 12 or 15 letters or digits", () => {
        assert.equal(validConfigId(` ${CF(9)} `), CF(9), "18 characters, spaces trimmed");
    assert.equal(validConfigId("063A1b2C3d4E5f6"), "063A1b2C3d4E5f6", "15 characters");
    for (const bad of ["", "063", "063A1b2C3d4E5f", "063A1b2C3d4E5f67", "063A1b2C3d4E5f6789A0", "003A1b2C3d4E5f6", "063A1b2C3d4E5f-", "063A1b2C3d4E 5f6", null, undefined]) {
      assert.equal(validConfigId(bad), null, String(bad));
    }
    const { rows } = world();
    const typed = planChange({ action: "add", targetId: "063ZZZZZZZZZZZZ", entries: asEntries(rows, 7), rows });
    assert.equal(typed.error, "");
    assert.equal(typed.targetId, "063ZZZZZZZZZZZZ");
    assert.match(typed.targetName, /Unnamed configuration \(Id 063ZZZZZZZZZZZZ\)/);
    assert.equal(tabText(changeTable(typed)), "AssignedId\tConfigurationId\n" + U(7) + "\t063ZZZZZZZZZZZZ");
    for (const bad of ["", "063short", "0x3" + pad(1) + "AAA", "063'; DROP"]) {
      const p = planChange({ action: "move", targetId: bad, entries: asEntries(rows, 1), rows });
      assert.ok(p.error, `error for ${bad}`);
      assert.equal(p.items.length, 0);
    }
    assert.equal(planChange({ action: "remove", entries: asEntries(rows, 1), rows }).error, "", "Remove needs no target");
    assert.match(CONFIG_ID_HELP, /Setup > Einstein Activity Capture > Configurations/);
    assert.match(CONFIG_ID_HELP, /063/);
  });

  await test("changes: pasted names (one per line or commas, any case, usernames or emails): found, not found, repeated, ambiguous", () => {
    const { tokens, tooMany } = parsePasted("U1@Example.com, person2@example.org\n\n  ghost@example.com ;u1@example.com\r\nU3@example.com");
    assert.deepEqual(tokens, ["U1@Example.com", "person2@example.org", "ghost@example.com", "U3@example.com"], "repeats in another case are dropped");
    assert.equal(tooMany, false);
    assert.equal(parsePasted(Array.from({ length: 600 }, (_, i) => `x${i}@example.com`).join("\n")).tooMany, true);
    const users = [person(1, "Uma One"), person(2, "Ivan Inactive", false), { Id: U(3), Name: "Cy Three", Username: "cy@example.com", Email: "shared@example.org", IsActive: true }, { Id: U(4), Name: "Di Four", Username: "di@example.com", Email: "shared@example.org", IsActive: true }];
    const m = matchPasted(["U1@Example.COM", "PERSON2@example.org", "ghost@example.com", "shared@example.org", "cy@example.com"], users);
    assert.deepEqual(m.found.map((f) => [f.token, f.user.Id]), [["U1@Example.COM", U(1)], ["PERSON2@example.org", U(2)], ["cy@example.com", U(3)]]);
    assert.deepEqual(m.notFound, ["ghost@example.com"]);
    assert.deepEqual(m.ambiguous, [{ token: "shared@example.org", count: 2 }], "an email on two users picks nobody");
    const p = planChange({ action: "add", targetId: B, entries: m.found.map((f) => entryFromRecord(f.user)), rows: [], notFound: m.notFound });
    assert.deepEqual(p.notFound, ["ghost@example.com"]);
    assert.deepEqual(p.items.map((i) => i.userId), [U(1), U(3)]);
    assert.deepEqual(skippedBy(p), { "Ivan Inactive": "inactive" });
  });

  await test("changes: the lookup is a read-only SELECT on User, in batches, with every pasted value escaped", async () => {
    const tokens = ["o'brien@example.com", "back\\slash@example.com", ...Array.from({ length: 120 }, (_, i) => `n${i}@example.com`)];
    const qs = userLookupQueries(tokens);
    assert.equal(qs.length, 3, "50 per batch");
    assert.ok(qs.every((q) => q.startsWith("SELECT Id, Name, Username, Email, IsActive FROM User WHERE Username IN (") && q.includes(") OR Email IN (")));
    assert.ok(qs[0].includes("'o\\'brien@example.com'"));
    assert.ok(qs[0].includes("'back\\\\slash@example.com'"));
    assert.ok(!/UserEmailCalendarSync|ActivityUsrConnectionStatus/.test(qs.join()), "no WHERE on the EAC objects");
    const log = [];
    const fetchImpl = async (url, opts = {}) => {
      const u = new URL(url);
      log.push({ method: opts.method || "GET", q: u.searchParams.get("q") });
      const found = /n1@example\.com/.test(u.searchParams.get("q")) ? [{ Id: U(5), Name: "Eve Five", Username: "n1@example.com", Email: "n1@example.com", IsActive: true }] : [];
      return resp(200, { done: true, totalSize: found.length, records: found });
    };
    const api = new SfApi({ apiHost: "test.example.com", sessionId: "sid", fetchImpl });
    const users = await readPastedUsers(api, tokens);
    assert.deepEqual(users.map((x) => x.Id), [U(5)]);
    assert.equal(log.length, 3);
    assert.ok(log.every((l) => l.method === "GET"), "only GET requests");
  });

  await test("changes: the output holds only API columns and Ids: no names, usernames or emails", () => {
    const { rows, profileRows } = world();
    const cases = [
      planChange({ action: "add", targetId: B, entries: asEntries(rows, 7), rows }),
      planChange({ action: "move", targetId: B, entries: asEntries(rows, 1, 2), rows }),
      planChange({ action: "remove", entries: asEntries(rows, 1, 2), profileItems: profileRows, rows }),
    ];
    for (const plan of cases) {
      const out = outputFor(shown(plan));
      const all = [out.text, out.csv, out.undoText].join("\n");
      for (const bad of ["Uma", "Ivan", "Nora", "Pia", "Config A", "Service", "@", "example"]) assert.ok(!all.includes(bad), `${plan.action} output has ${bad}`);
      for (const line of all.replace(/﻿/g, "").split(/\r?\n/).filter(Boolean)) for (const cell of line.split(/[\t,]/)) assert.match(cell, /^[A-Za-z0-9]+$/);
      assert.deepEqual(changeTable(plan).header, ACTIONS[plan.action].header);
    }
    assert.equal(changeFileName("move", "202611221030"), "eac_move_202611221030.csv");
  });

  await test("changes: nothing is built until the preview has been shown, and a bad Id never reaches the text", () => {
    const { rows } = world();
    const plan = planChange({ action: "add", targetId: B, entries: asEntries(rows, 7), rows });
    assert.throws(() => outputFor(plan), /preview first/i);
    assert.ok(outputFor(shown(plan)).text.includes(U(7)));
    const bad = planChange({ action: "add", targetId: B, entries: [{ userId: "005\tx", name: "Bad Id", isActive: true, configId: null }], rows });
    assert.deepEqual(skippedBy(bad), { "Bad Id": "badId" });
    assert.equal(outputFor(shown(bad)), null, "nothing to load");
    assert.throws(() => changeTable({ action: "remove", items: [{ assignmentId: "x y" }], profileItems: [] }), /Id does not look right/);
    assert.throws(() => outputFor(shown(planChange({ action: "move", targetId: "nope", entries: [], rows }))), /configuration|Pick/i);
  });

  await test("changes: building and previewing make no request at all; the lookup makes only GET", async () => {
    const log = [];
    const api = fakeOrg({ status: [], sync: [{ Id: AS(1), AssignedId: U(1), ConfigurationId: A }], users: [person(1, "Uma One")] }, log);
    const raw = await readEacRaw(api);
    const before = log.length;
    assert.ok(before > 0);
    const { rows, profileRows } = buildEacRows(raw);
    for (const action of ["add", "move", "remove"]) {
      const plan = planChange({ action, targetId: B, entries: rows.map(entryFromRow), profileItems: profileRows, rows });
      outputFor(shown(plan));
    }
    assert.equal(log.length, before, "no request while building changes");
    assert.ok(log.every((l) => l.method === "GET"), "only GET requests");
  });

  await test("changes: copy falls back when the clipboard is missing, blocked or rejects", async () => {
    let got = null;
    assert.deepEqual(await copyWithFallback("a\tb", { writeText: async (t) => { got = t; } }), { copied: true });
    assert.equal(got, "a\tb");
    assert.deepEqual(await copyWithFallback("x", { writeText: async () => { throw new Error("NotAllowedError"); } }), { copied: false });
    assert.deepEqual(await copyWithFallback("x", { writeText: () => { throw new Error("sync throw"); } }), { copied: false });
    assert.deepEqual(await copyWithFallback("x", undefined), { copied: false });
    assert.deepEqual(await copyWithFallback("x", {}), { copied: false });
    const page = readFileSync(path.join(here, "..", "tools", "user-access", "user-access.js"), "utf-8");
    assert.ok(page.includes("fallbackBox(text)") && page.includes("ta.value = text") && page.includes("Select all and copy"));
    assert.ok(page.includes("navigator.clipboard"), "uses the clipboard API");
  });

  await test("changes: steps, warnings and button labels use the action names; the selection survives a change of the Show filter", () => {
    assert.deepEqual(inspectorSteps("move"), ["Open Salesforce Inspector, then Data Import.", "Action: Update.", "Object: UserEmailCalendarSync.", "Format: Excel.", "Paste the copied text.", "Import."]);
    assert.ok(inspectorSteps("add")[1].includes("Insert") && inspectorSteps("remove")[1].includes("Delete"));
    assert.equal(AFTER_STEP, "Then click Show everyone again here to check the result.");
    assert.equal(CHANGE_WARNING, "This changes who captures email and calendar activity. Check the preview first.");
    const page = readFileSync(path.join(here, "..", "tools", "user-access", "user-access.js"), "utf-8");
    for (const t of ["Copy for Salesforce Inspector: ${a.word}", "Download CSV (Data Loader): ${a.word}", "Copy undo text for the ${a.word}", "Select all ${num("]) assert.ok(page.includes(t), t);
    const showLine = page.split("\n").find((l) => l.includes('$("#eacShow").addEventListener("change"'));
    assert.ok(showLine && !/\bsel\b|plan/.test(showLine), "the Show filter does not touch the picks");
    const html = readFileSync(path.join(here, "..", "tools", "user-access", "user-access.html"), "utf-8");
    for (const id of ["eacPaste", "eacAction", "eacTarget", "eacTargetId", "eacPreview", "eacPreviewBox", "eacSelShown"]) assert.ok(html.includes(`id="${id}"`), id);
    assert.ok(!/localStorage|chrome\.storage|innerHTML/.test(page));
  });

  const PLACEHOLDER = "000000000000000AAA";
  const orgLike = () => buildEacRows({
    statuses: [],
    assignments: [
      { Id: PLACEHOLDER, AssignedId: U(1), ConfigurationId: A }, { Id: PLACEHOLDER, AssignedId: U(2), ConfigurationId: A },
      { Id: PLACEHOLDER, AssignedId: U(3), ConfigurationId: B }, { Id: PLACEHOLDER, AssignedId: PROF, ConfigurationId: A },
      { Id: PLACEHOLDER, AssignedId: `00e${pad(2)}AAA`, ConfigurationId: B },
    ],
    configs: { [A]: "Config A", [B]: "Config B" },
    users: [person(1, "Uma One"), person(2, "Ivan Inactive", false), person(3, "Bea Three"), person(7, "Nora None")],
    profiles: { [PROF]: "Service Standard" }, profileMembers: { [PROF]: [U(4)], [`00e${pad(2)}AAA`]: [U(5)] },
  });

  await test("changes: org-like data where every row has the placeholder Id: Move and Remove build nothing and say why, Add still works", () => {
    assert.equal(usableId(PLACEHOLDER), false);
    assert.equal(usableId("000000000000000"), false);
    assert.equal(usableId(AS(1)), true);
    const { rows, profileRows } = orgLike();
    assert.ok(profileRows.length === 2 && profileRows.every((p) => p.id === PLACEHOLDER));
    assert.equal(new Set(profileRows.map(profileKey)).size, 2, "profile rows are told apart without their Id");
    const users = rows.filter((r) => r.direct);
    for (const action of ["move", "remove"]) {
      const plan = planChange({ action, targetId: C, entries: users.map(entryFromRow), profileItems: profileRows, rows });
      assert.equal(plan.items.length, 0, action);
      assert.equal(plan.profileItems.length, 0, action);
      assert.ok(plan.skipped.length >= 3 && plan.skipped.every((s) => s.code === "noRealId"), `${action}: ${JSON.stringify(plan.skipped)}`);
      assert.match(skipHelp(action, "noRealId"), /no real Id \(every row shows 000000000000000AAA\), so it can't be moved or removed with Inspector\. Use Setup for now\./);
      assert.ok(allNoRealId(plan));
      assert.match(previewSummary(plan), /no real Id/);
      assert.equal(outputFor(shown(plan)), null, "no text, so no copy buttons and no undo");
    }
    const add = planChange({ action: "add", targetId: C, entries: [entryFromRecord(person(7, "Nora None")), entryFromRecord(person(8, "Eli Eight"))], rows });
    assert.deepEqual(changeTable(add).rows, [[U(7), C], [U(8), C]], "one row per user");
    const page = readFileSync(path.join(here, "..", "tools", "user-access", "user-access.js"), "utf-8");
    assert.ok(page.includes("allNoRealId(plan)"), "the page shows no copy buttons for it");
  });

  await test("changes: a placeholder Id never reaches any output, not even built by hand", () => {
    for (const t of [
      () => changeTable({ action: "remove", items: [{ assignmentId: PLACEHOLDER }], profileItems: [] }),
      () => changeTable({ action: "move", targetId: B, items: [{ assignmentId: PLACEHOLDER }], profileItems: [] }),
      () => changeTable({ action: "remove", items: [], profileItems: [{ id: PLACEHOLDER }] }),
      () => undoTable({ action: "remove", items: [{ userId: U(1), fromConfigId: A }], profileItems: [{ profileId: PROF, configId: "000000000000000AAA" }] }),
    ]) assert.throws(t, /Id does not look right/);
    const { rows, profileRows } = orgLike();
    const plan = planChange({ action: "remove", entries: [], profileItems: profileRows, rows });
    assert.equal(plan.profileItems.length, 0);
    assert.ok(plan.skipped.every((s) => s.code === "noRealId"));
  });

  await test("changes: the same assignment picked twice is listed once, and the preview says so", () => {
    const { rows } = world();
    const r1 = rowOf(rows, 1);
    const plan = planChange({ action: "remove", entries: [entryFromRow(r1), entryFromUser({ userId: U(1), name: "Uma One" }), entryFromRecord(person(1, "Uma One"))], rows });
    assert.deepEqual(plan.items.map((i) => i.assignmentId), [AS(1)]);
    assert.equal(plan.skipped.length, 0, "no contradicting skip");
    assert.equal(plan.duplicates, 2);
    assert.equal(duplicatesText(plan), "2 picks were the same assignment and are listed once.");
    assert.equal(changeTable(plan).rows.length, 1);
    const dup = { action: "remove", items: [{ assignmentId: AS(1), userId: U(1), fromConfigId: A }, { assignmentId: AS(1), userId: U(1), fromConfigId: A }], profileItems: [] };
    assert.equal(changeTable(dup).rows.length, 1);
    assert.equal(undoTable(dup).rows.length, 1);
    const pr = world().profileRows[0];
    const twice = planChange({ action: "remove", entries: [], profileItems: [pr, pr], rows });
    assert.equal(twice.profileItems.length, 1);
    assert.equal(twice.duplicates, 1);
    assert.equal(duplicatesText({ duplicates: 1 }), "1 pick was the same assignment and is listed once.");
    assert.equal(duplicatesText({ duplicates: 0 }), "");
  });

  await test("changes: a tick plus a paste of one user gives one result, with no more-than-one-assignment skip; Move sends one row per user", () => {
    const { rows } = world();
    const tick = entryFromRow(rowOf(rows, 6, C));
    const pasted = entryFromRecord(person(6, "Dee Double"));
    const rm = planChange({ action: "remove", entries: [tick, pasted], rows });
    assert.deepEqual(rm.items.map((i) => i.assignmentId), [AS(7)]);
    assert.equal(rm.skipped.length, 0);
    assert.equal(rm.duplicates, 1);
    const rm2 = planChange({ action: "remove", entries: [pasted, tick], rows });
    assert.deepEqual([rm2.items.length, rm2.skipped.length], [1, 0], "the order does not matter");
    assert.deepEqual(skippedBy(planChange({ action: "remove", entries: [pasted], rows })), { "Dee Double": "severalRows" });
    const both = planChange({ action: "move", targetId: B, entries: [entryFromRow(rowOf(rows, 6, A)), entryFromRow(rowOf(rows, 6, C))], rows });
    assert.deepEqual(both.items.map((i) => i.assignmentId), [AS(6)]);
    assert.deepEqual(both.skipped.map((s) => s.code), ["sameTarget"]);
    assert.equal(changeTable(both).rows.length, 1);
    assert.match(skipHelp("move", "sameTarget"), /Only one assignment per user/);
    const rmBoth = planChange({ action: "remove", entries: [entryFromRow(rowOf(rows, 6, A)), entryFromRow(rowOf(rows, 6, C))], rows });
    assert.deepEqual(rmBoth.items.map((i) => i.assignmentId), [AS(6), AS(7)]);
  });

  await test("changes: numbers in the preview use thousands separators, and the change files have no BOM", () => {
    const entries = Array.from({ length: 2558 }, (_, i) => entryFromRecord({ Id: `005${String(i + 1000).padStart(12, "0")}AAA`, Name: `User ${i}`, IsActive: true }));
    const plan = planChange({ action: "add", targetId: B, entries, rows: [] });
    assert.match(previewSummary(plan), /^Add 2,558 users to /);
    for (const action of ["add", "move", "remove"]) {
      const { rows, profileRows } = world();
      const p = planChange({ action, targetId: B, entries: asEntries(rows, 1, 2, 7), profileItems: action === "remove" ? profileRows : [], rows });
      const out = outputFor(shown(p));
      assert.ok(out && !out.csv.includes("﻿") && out.csv.startsWith(ACTIONS[action].header[0]), action);
      if (out.undo) assert.ok(!out.undoCsv.includes("﻿"));
    }
    assert.ok(toCsv([["a"]]).startsWith("﻿"), "shared toCsv is unchanged");
  });

  await test("changes: the page adds no null text to the pasted-name result, and keys profile picks without the assignment Id", () => {
    const page = readFileSync(path.join(here, "..", "tools", "user-access", "user-access.js"), "utf-8");
    const fn = page.slice(page.indexOf("async function findPasted"), page.indexOf("/** The text to copy by hand"));
    assert.ok(fn.includes(".filter(Boolean)"), "null entries are dropped before append");
    assert.ok(!/profileSel\.(has|add|delete)\(p\.id\)/.test(page), "the profile picks are not keyed by the placeholder Id");
    assert.ok(/profileSel\.has\(profileKey\(p\)\)/.test(page));
  });

  await test("changes: the demo works with every action", () => {
    const { rows, profileRows, noConfig } = buildEacRows(sample("eac_all_demo.json"));
    assert.ok(profileRows.length && profileRows.every((p) => p.id && /DEMO/.test(p.id)), "a profile assignment row with its Id");
    const known = knownConfigs(rows, profileRows);
    assert.ok(known.length >= 3);
    const [from, to] = [known[0], known[1]];
    const members = rows.filter((r) => r.configId === from.id);
    const add = planChange({ action: "add", targetId: to.id, entries: noConfig.map(entryFromUser), rows });
    assert.ok(add.items.length >= 1, "users with access in no configuration can be added");
    const move = planChange({ action: "move", targetId: to.id, entries: members.map(entryFromRow), rows });
    assert.ok(move.items.length >= 1);
    const remove = planChange({ action: "remove", entries: rows.filter((r) => !r.isActive).map(entryFromRow), profileItems: profileRows, rows });
    assert.ok(remove.items.length + remove.profileItems.length >= 1);
    for (const plan of [add, move, remove]) {
      const out = outputFor(shown(plan));
      assert.ok(out.text.split("\n").length >= 2 && !out.csv.startsWith("﻿"));
      assert.equal(!!out.undo, plan.action !== "add");
    }
    assert.ok(validConfigId(known[0].id), "demo configuration Ids are valid 063 Ids");
  });

}
