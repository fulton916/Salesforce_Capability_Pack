// Offline tests for "Page details for a ticket". Called from run_tests.mjs with its shared `test` function.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { cleanUrl } from "../shared/pageurl.js";
import { parsePageUrl, setupDisplayName, setupTitleFromTabs, cleanTabTitle, snapshotText, fileName, sandboxNameFromHost, whenText, scrub, scrubNote, objectText, NOTE_REMOVED_TEXT } from "../tools/page-details/page-details-logic.js";
import { readIssueSnapshot, readCurrentUser, readPageDetails, orgProblem, failureCause } from "../tools/page-details/page-details-read.js";
import { SfApi } from "../shared/sfconn.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = (...p) => path.join(here, "..", ...p);
const read = (f) => readFileSync(f, "utf-8");
const demo = () => JSON.parse(read(ext("samples", "page_details_demo.json")));

/** A route handler may throw (a TypeError acts as a dropped connection) or return failure(...) for a non-OK answer. */
const failure = (status, errorCode, message) => ({ __status: status, __body: [{ errorCode, message }] });
const dropped = () => { throw new TypeError("Failed to fetch"); };
const denied = () => failure(403, "INSUFFICIENT_ACCESS", "insufficient access rights on object id");
const ACCOUNT_URL = "/lightning/r/Account/001000000000001AAA/view";
const ACCOUNT_DESCRIBE = ["/sobjects/Account/describe", () => ({ name: "Account", label: "Account", queryable: true, fields: [{ name: "Id" }, { name: "Name", nameField: true }] })];

/** Fake REST API: `routes` is a list of [matcher, handler]. */
function fakeApi(routes) {
  const seen = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname + u.search);
    seen.push(key);
    for (const [m, h] of routes) {
      if (key.includes(m)) {
        const body = await h(key);
        if (body && body.__status) return { ok: false, status: body.__status, text: async () => JSON.stringify(body.__body || []) };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }
    }
    return { ok: false, status: 404, text: async () => JSON.stringify([{ errorCode: "NOT_FOUND", message: "no route " + key }]) };
  };
  const api = new SfApi({ apiHost: "x.example.com", sessionId: "SESSION", fetchImpl });
  api.seen = seen;
  return api;
}

export async function run(test) {
  await test("snapshot: parsePageUrl reads the common page kinds", () => {
    assert.deepEqual(
      (({ kind, objectApi, recordId }) => ({ kind, objectApi, recordId }))(parsePageUrl("https://x.lightning.force.com/lightning/r/Account/001000000000001AAA/view")),
      { kind: "record", objectApi: "Account", recordId: "001000000000001AAA" });
    const l = parsePageUrl("/lightning/o/Contact/list?filterName=00B000000000001AAA&sid=abc");
    assert.equal(l.kind, "list");
    assert.equal(l.objectApi, "Contact");
    assert.equal(l.filterName, "00B000000000001AAA");
    const s = parsePageUrl("/lightning/setup/ManageUsers/home");
    assert.equal(s.kind, "setup");
    assert.equal(s.setupPage, "ManageUsers");
    assert.equal(parsePageUrl("/lightning/setup/ObjectManager/Account/FieldsAndRelationships/view").objectApi, "Account");
    assert.equal(parsePageUrl("/lightning/page/home").kind, "home");
    assert.equal(parsePageUrl("/").kind, "home");
    assert.equal(parsePageUrl("/setup/own/orgdetail.apexp").kind, "setup");
    // a 15-letter object name is not an Id
    const cd = parsePageUrl("/lightning/r/ContentDocument/069000000000001AAA/view");
    assert.equal(cd.objectApi, "ContentDocument");
    assert.equal(cd.recordId, "069000000000001AAA");
    // older address without the object
    assert.equal(parsePageUrl("/lightning/r/001000000000001AAA/view").recordId, "001000000000001AAA");
  });

  await test("snapshot: classic /<Id> addresses (15 and 18 characters) are record pages", () => {
    for (const id of ["001000000000001", "001000000000001AAA"]) {
      const p = parsePageUrl(`/${id}`);
      assert.equal(p.kind, "record");
      assert.equal(p.recordId, id);
      assert.equal(p.objectApi, null);
    }
    assert.equal(parsePageUrl("/001000").kind, "other");
  });

  await test("snapshot: Experience Cloud pages and garbage are 'other' and never throw", () => {
    assert.equal(parsePageUrl("https://acme.my.site.com/s/account/001000000000001AAA/x").kind, "other");
    for (const bad of ["", "   ", null, undefined, 42, {}, "http://", "::::", "%%%", "\u0000"]) {
      const p = parsePageUrl(bad);
      assert.ok(["other", "home"].includes(p.kind), String(bad));
    }
    assert.equal(parsePageUrl(null).kind, "other");
    assert.equal(parsePageUrl("").path, "");
  });

  await test("snapshot: cleanUrl keeps the path and filterName only", () => {
    const dirty = "https://acme.lightning.force.com/lightning/o/Account/list?filterName=Recent&sid=00D000000000001!AQEAQxxxxxxxxxxxxxxxxxxxxxxxxxxxx&token=t&access_token=a&code=c&retURL=/x&foo=bar#access_token=zzz";
    assert.equal(cleanUrl(dirty), "/lightning/o/Account/list?filterName=Recent");
    assert.equal(cleanUrl("/secur/frontdoor.jsp?sid=abc&retURL=%2Fhome"), "/secur/frontdoor.jsp");
    assert.equal(cleanUrl("/a;jsessionid=XYZ/b"), "/a/b");
    assert.equal(cleanUrl("/x?filterName=a<b>"), "/x");
    for (const out of [cleanUrl(dirty), cleanUrl("/p?sid=1&token=2&code=3#h")]) assert.ok(!/sid|token|code|access|#|foo/i.test(out), out);
    assert.equal(cleanUrl("not a url at all"), "/not%20a%20url%20at%20all");
    assert.equal(cleanUrl(undefined), "");
  });

  const full = () => {
    const d = demo();
    return {
      note: "Clicked Save and got an error", when: new Date("2026-11-19T03:03:09Z"), timeZone: "UTC",
      org: d.org, user: d.user, page: d.page, browser: "Chrome 131", extensionVersion: "0.3.0", problems: {},
    };
  };

  await test("snapshot: text has plain labels and the note comes first", () => {
    const t = snapshotText(full());
    assert.ok(t.startsWith("WHAT HAPPENED\nClicked Save and got an error"));
    for (const label of ["WHEN", "Local time:", "UTC:", "ORG", "Org Id:", "Sandbox name: uat", "Instance:", "My Domain host:", "YOU", "Username:", "Profile:", "Role:",
      "Language:", "Locale:", "Time zone:", "User type:", "PAGE", "Record Id:", "Record name:", "Record type:", "Owner:", "Last modified by:", "BROWSER AND EXTENSION", "Extension version: 0.3.0"]) {
      assert.ok(t.includes(label), label);
    }
    assert.ok(t.includes("2026-11-19 03:03:09 UTC"));
    assert.ok(t.indexOf("WHEN") < t.indexOf("ORG") && t.indexOf("ORG") < t.indexOf("YOU") && t.indexOf("YOU") < t.indexOf("PAGE"));
  });

  await test("snapshot: no note means no 'What happened' heading", () => {
    const s = full(); s.note = "  ";
    assert.ok(!snapshotText(s).includes("WHAT HAPPENED"));
  });

  await test("snapshot: missing areas are worded plainly", () => {
    const t = snapshotText({ when: new Date(0), timeZone: "UTC", org: null, user: null, page: { kind: "record", url: "/x", recordId: "001000000000001AAA" },
      problems: { org: "Your user may not be allowed to read it.", user: "Salesforce would not say who you are.", record: "This record could not be found." } });
    assert.ok(t.includes("The org details could not be read. Your user may not be allowed to read it."));
    assert.ok(t.includes("Your user details could not be read."));
    assert.ok(t.includes("This record could not be found."));
    assert.ok(t.includes("Record name: Not available"));
    assert.ok(!/undefined|null|\[object/.test(t));
  });

  await test("snapshot: text never carries session-like strings, even from the note", () => {
    const s = full();
    s.note = "see https://x/?sid=00D000000000001!AQEAQabcdefghijklmnopqrstuvwxyz and Bearer 00D000000000001!AQEAQabcdefghijklmnopqrstuvwxyz";
    s.page = { ...s.page, url: cleanUrl("/lightning/r/Account/001000000000001AAA/view?sid=abc&token=1") };
    const t = snapshotText(s);
    assert.ok(!/AQEAQ|sid=abc|token=1/.test(t), t);
    assert.ok(!/Bearer\s+00D/.test(t));
    assert.ok(t.includes("Org Id: 00D000000000001AAA")); // a plain Org Id is kept
    assert.equal(scrub("code=abc&x"), "code=[removed]&x");
  });

  await test("snapshot: the note keeps 'error code=5' and 'token=abc' unchanged", () => {
    const s = full();
    s.note = "I saw error code=5 and token=abc in the box";
    assert.ok(snapshotText(s).includes("I saw error code=5 and token=abc in the box"));
    assert.deepEqual(scrubNote("error code=5, token=abc"), { text: "error code=5, token=abc", removed: false });
  });

  await test("snapshot: the note loses a session id and sid=, and says so", () => {
    const r = scrubNote("tried 00D000000000001!AQEAQabcdefghijklmnopqrstuvwxyz and ?sid=abc123&x=1, Bearer abcdefghijklmnopqrstuvwxyz0123");
    assert.equal(r.removed, true);
    assert.ok(!/AQEAQ|abc123|abcdefghijklmnopqrstuvwxyz0123/.test(r.text), r.text);
    assert.ok(r.text.includes("sid=[removed]&x=1"));
    for (const k of ["access_token", "refresh_token", "id_token", "oauth_token"]) assert.ok(scrubNote(`${k}=zzz`).removed, k);
    const s = full();
    s.note = "sid=abc";
    assert.ok(snapshotText(s).startsWith("WHAT HAPPENED\nsid=[removed]\n"));
    assert.ok(NOTE_REMOVED_TEXT.includes("session id"));
  });

  await test("snapshot: the Org message is worded by cause", () => {
    const perm = orgProblem(Object.assign(new Error("sObject type 'Organization' is not supported"), { status: 400, errorCode: "INVALID_TYPE" }));
    assert.match(perm, /may not be allowed/);
    assert.match(orgProblem(Object.assign(new Error("denied"), { status: 403 })), /may not be allowed/);
    const net = orgProblem(new TypeError("Failed to fetch"));
    assert.match(net, /could not be reached/);
    assert.ok(!/allowed/.test(net));
    const other = orgProblem(new Error("No Organization row returned"));
    assert.match(other, /could not be read/);
    assert.ok(!/allowed|reached/.test(other));
  });

  await test("snapshot: the My Domain host stays when the org read fails", async () => {
    const t = snapshotText({ when: new Date(0), timeZone: "UTC", org: null, host: "acme.my.salesforce.com", problems: { org: "x" } });
    assert.ok(t.includes("My Domain host: acme.my.salesforce.com"), t);
    const api = fakeApi([["/chatter/users/me", () => ({ id: "005000000000001AAA" })]]);
    const r = await readIssueSnapshot(api, { host: "acme.my.salesforce.com", url: "/lightning/page/home" });
    assert.equal(r.org.data, null);
    assert.ok(r.org.problem);
  });

  await test("snapshot: an old hash address gets a plain hint; other 'other' pages do not", () => {
    const p = parsePageUrl("https://x.lightning.force.com/one/one.app#/sObject/001000000000001AAA/view");
    assert.equal(p.kind, "other");
    assert.equal(p.path, "/one/one.app");
    assert.equal(p.hashAddress, true);
    assert.equal(parsePageUrl("/s/account/x").hashAddress, false);
    assert.equal(parsePageUrl("/one/one.app/other").hashAddress, false);
    const t = snapshotText({ when: new Date(0), timeZone: "UTC", page: { kind: "other", url: p.path, hashAddress: true } });
    assert.ok(t.includes("doesn't show which record you were on"), t);
    assert.ok(!snapshotText({ when: new Date(0), timeZone: "UTC", page: { kind: "other", url: "/x" } }).includes("doesn't show which record"));
    assert.ok(read(ext("menu.js")).includes("cleanUrl(tab?.url")); // the popup still drops the hash
  });

  await test("snapshot: a bad object name in the address is refused and nothing is read", async () => {
    for (const bad of ["/lightning/r/Acc%2Fount/001000000000001AAA/view", "/lightning/o/1Bad/list", "/lightning/r/A..B/001000000000001AAA/view",
      `/lightning/r/${"A".repeat(81)}/001000000000001AAA/view`]) {
      const p = parsePageUrl(bad);
      assert.equal(p.kind, "other", bad);
      assert.equal(p.objectApi, null);
      assert.equal(p.recordId, null);
    }
    assert.equal(parsePageUrl("/lightning/r/ns__Obj__c/a00000000000001AAA/view").objectApi, "ns__Obj__c");
    const api = fakeApi([]);
    await readIssueSnapshot(api, { host: "h", url: "/lightning/r/Acc%2Fount/001000000000001AAA/view" });
    assert.ok(api.seen.every((s) => !/describe|FROM Acc/.test(s)), api.seen.join("|"));
  });

  await test("snapshot: the object shows its API name only when it differs from the label", () => {
    assert.equal(objectText({ objectLabel: "Account", objectApi: "Account" }), "Account");
    assert.equal(objectText({ objectLabel: "Project", objectApi: "Project__c" }), "Project (Project__c)");
    assert.equal(objectText({ objectApi: "Case" }), "Case");
    const t = snapshotText({ when: new Date(0), timeZone: "UTC", page: { kind: "list", url: "/x", objectLabel: "Account", objectApi: "Account" } });
    assert.ok(t.includes("Object: Account\n"), t);
  });

  await test("snapshot: whenText gives local and UTC", () => {
    const w = whenText(new Date("2026-11-19T03:03:09Z"), "America/Los_Angeles");
    assert.ok(w.local.startsWith("2026-11-18 19:03:09"), w.local);
    assert.ok(w.local.includes("America/Los_Angeles"));
    assert.equal(w.utc, "2026-11-19 03:03:09 UTC");
    assert.equal(whenText("garbage").utc, "Not available");
  });

  await test("snapshot: sandbox name comes from the host when it shows one", () => {
    assert.equal(sandboxNameFromHost("acme--uat.sandbox.my.salesforce.com"), "uat");
    assert.equal(sandboxNameFromHost("acme--uat.sandbox.lightning.force.com"), "uat");
    assert.equal(sandboxNameFromHost("acme.my.salesforce.com"), null);
    assert.equal(sandboxNameFromHost(null), null);
  });

  await test("snapshot: fileName is dated and safe", () => {
    assert.equal(fileName(new Date(2026, 10, 19, 14, 3)), "page-details-2026-11-19-1403.txt");
    assert.match(fileName(), /^page-details-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/);
    assert.match(fileName(new Date("nope")), /^[\w.-]+$/);
  });

  await test("snapshot: the sample stays synthetic", () => {
    const raw = read(ext("samples", "page_details_demo.json"));
    const d = JSON.parse(raw);
    assert.match(d.org.id, /^00D0{9}\d+AAA$/);
    assert.match(d.user.id, /^0050{9}\d+AAA$/);
    assert.match(d.page.recordId, /^0010{9}\d+AAA$/);
    assert.ok(d.user.username.endsWith("example.com.uat"));
    for (const em of raw.match(/[\w.+-]+@[\w.-]+/g) || []) assert.ok(/@example\.com/.test(em), em);
    assert.ok(!/AQEAQ|sid=|token|password/i.test(raw));
    assert.ok(/^example-co--uat\.sandbox\./.test(d.host));
  });

  await test("snapshot: reads fill every area and ask only for what exists on the object", async () => {
    const api = fakeApi([
      ["/chatter/users/me", () => ({ id: "005000000000001AAA", name: "Alex Example" })],
      ["FROM Organization", () => ({ done: true, totalSize: 1, records: [{ Id: "00D000000000001AAA", Name: "Example Co", IsSandbox: true, InstanceName: "CS99", OrganizationType: "Enterprise Edition" }] })],
      ["FROM User WHERE", () => ({ done: true, totalSize: 1, records: [{ Id: "005000000000001AAA", Name: "Alex Example", Username: "alex@example.com", Profile: { Name: "Standard User" }, UserRole: null, LanguageLocaleKey: "en_US", LocaleSidKey: "en_US", TimeZoneSidKey: "America/Los_Angeles", UserType: "Standard" }] })],
      ["/sobjects/Account/describe", () => ({ name: "Account", label: "Account", queryable: true, fields: [{ name: "Id" }, { name: "Name", nameField: true }, { name: "OwnerId" }, { name: "LastModifiedById" }, { name: "LastModifiedDate" }] })],
      ["FROM Account WHERE", () => ({ done: true, totalSize: 1, records: [{ Id: "001000000000001AAA", Name: "Sample Account Ltd", Owner: { Name: "Jordan Sample" }, LastModifiedBy: { Name: "Sam Demo" }, LastModifiedDate: "2026-11-18T09:12:30.000+0000" }] })],
    ]);
    const r = await readIssueSnapshot(api, { host: "example-co--uat.sandbox.my.salesforce.com", url: "/lightning/r/Account/001000000000001AAA/view" });
    assert.equal(r.org.data.kind, "Sandbox");
    assert.equal(r.org.data.sandboxName, "uat");
    assert.equal(r.user.data.profile, "Standard User");
    assert.equal(r.user.data.role, null);
    assert.equal(r.page.data.recordName, "Sample Account Ltd");
    assert.equal(r.page.data.owner, "Jordan Sample");
    assert.equal(r.page.data.modifiedAt, "2026-11-18 09:12:30 UTC");
    assert.equal(r.page.data.recordType, null);
    const recordQuery = api.seen.find((s) => s.includes("FROM Account WHERE"));
    assert.ok(!/RecordType/.test(recordQuery), recordQuery); // Account here has no RecordTypeId field
    assert.ok(api.seen.every((s) => !/DELETE|INSERT|UPDATE /.test(s)));
  });

  await test("snapshot: a record that cannot be read leaves the other areas intact, with plain words", async () => {
    const api = fakeApi([
      ["/chatter/users/me", () => ({ id: "005000000000001AAA" })],
      ["FROM Organization", () => ({ done: true, records: [{ Id: "00D000000000001AAA", Name: "Example Co", IsSandbox: false }] })],
      ["FROM User WHERE", () => ({ done: true, records: [{ Id: "005000000000001AAA", Name: "Alex Example", Username: "a@example.com" }] })],
      ["/sobjects/Case/describe", () => { throw new Error("boom"); }],
    ]);
    const r = await readIssueSnapshot(api, { host: "h.my.salesforce.com", url: "/lightning/r/Case/500000000000001AAA/view" });
    assert.ok(r.org.data && r.user.data);
    assert.equal(r.page.data.recordId, "500000000000001AAA");
    assert.ok(r.page.problem && !/boom/.test(r.page.problem));
    assert.ok(/boom|no route/.test(r.page.raw));
  });

  await test("snapshot: user falls back from Chatter to userinfo, and to Chatter text when User cannot be read", async () => {
    const viaInfo = fakeApi([
      ["/userinfo", () => ({ user_id: "005000000000001AAA" })],
      ["FROM User WHERE", () => ({ done: true, records: [{ Id: "005000000000001AAA", Name: "Alex" }] })],
    ]);
    assert.equal((await readCurrentUser(viaInfo)).data.name, "Alex");
    const partial = fakeApi([["/chatter/users/me", () => ({ id: "005000000000001AAA", name: "Alex", username: "a@example.com", timeZone: "UTC" })]]);
    const p = await readCurrentUser(partial);
    assert.equal(p.data.name, "Alex");
    assert.ok(p.problem);
    const none = await readCurrentUser(fakeApi([]));
    assert.equal(none.data, null);
    assert.ok(none.problem && none.raw);
  });

  await test("snapshot: failureCause sorts failures and orgProblem keeps its wording", () => {
    assert.equal(failureCause(Object.assign(new Error("expired"), { status: 401 })), "session");
    assert.equal(failureCause(Object.assign(new Error("x"), { status: 403 })), "denied");
    assert.equal(failureCause(Object.assign(new Error("x"), { status: 400, errorCode: "INSUFFICIENT_ACCESS" })), "denied");
    assert.equal(failureCause(new TypeError("Failed to fetch")), "unreachable");
    for (const st of [0, 502, 503, 504]) assert.equal(failureCause(Object.assign(new Error("x"), { status: st })), "unreachable", String(st));
    assert.equal(failureCause(new Error("The request timed out")), "unreachable");
    assert.equal(failureCause(Object.assign(new Error("bad"), { status: 400, errorCode: "MALFORMED_QUERY" })), "other");
    assert.equal(failureCause(null), "other");
    const e401 = Object.assign(new Error("Your Salesforce session has expired."), { status: 401 });
    assert.equal(orgProblem(e401), "Your Salesforce session has expired.");
    assert.equal(orgProblem(new TypeError("Failed to fetch")), "Salesforce could not be reached to read the org details. Check your connection, reload the Salesforce tab and try again.");
    assert.equal(orgProblem(new Error("x")), "The organization record could not be read.");
  });

  const NOT_ALLOWED = /not be allowed/, UNREACHED = /could not be reached.*Check your connection/;

  await test("snapshot: record SELECT failure is worded by cause", async () => {
    const run = async (h) => readPageDetails(fakeApi([ACCOUNT_DESCRIBE, ["FROM Account WHERE", h]]), ACCOUNT_URL);
    const net = await run(dropped);
    assert.match(net.problem, UNREACHED);
    assert.doesNotMatch(net.problem, NOT_ALLOWED);
    assert.match((await run(() => failure(503, "SERVER_UNAVAILABLE", "down"))).problem, UNREACHED);
    assert.match((await run(denied)).problem, NOT_ALLOWED);
    const other = await run(() => failure(400, "MALFORMED_QUERY", "unexpected token"));
    assert.match(other.problem, /could not be read/);
    assert.doesNotMatch(other.problem, NOT_ALLOWED);
    assert.doesNotMatch(other.problem, /reached/);
    assert.ok(net.data && net.raw); // the shape holds
    const gone = await run(() => ({ done: true, records: [] }));
    assert.match(gone.problem, /could not be found.*may not be allowed/);
  });

  await test("snapshot: record describe failure is worded by cause", async () => {
    const run = async (h) => readPageDetails(fakeApi([["/sobjects/Account/describe", h]]), ACCOUNT_URL);
    const net = await run(dropped);
    assert.match(net.problem, UNREACHED);
    assert.doesNotMatch(net.problem, NOT_ALLOWED);
    assert.match((await run(denied)).problem, NOT_ALLOWED);
    const other = await run(() => failure(400, "MALFORMED_QUERY", "weird"));
    assert.match(other.problem, /could not be read/);
    assert.doesNotMatch(other.problem, NOT_ALLOWED);
  });

  await test("snapshot: the object lookup for a classic /<Id> address is worded by cause", async () => {
    const run = async (h) => readPageDetails(fakeApi([["/sobjects/", h]]), "/001000000000001AAA");
    assert.match((await run(dropped)).problem, UNREACHED);
    const other = await run(() => failure(400, "X_ERR", "weird"));
    assert.match(other.problem, /could not be worked out/);
    assert.doesNotMatch(other.problem, NOT_ALLOWED);
  });

  await test("snapshot: user query failure is worded by cause, with and without the Chatter fallback", async () => {
    const chatter = ["/chatter/users/me", () => ({ id: "005000000000001AAA", name: "Alex", username: "a@example.com" })];
    const partial = await readCurrentUser(fakeApi([chatter, ["FROM User WHERE", dropped]]));
    assert.equal(partial.data.name, "Alex");
    assert.match(partial.problem, /Only part of your user details/);
    assert.match(partial.problem, UNREACHED);
    assert.doesNotMatch(partial.problem, NOT_ALLOWED);
    assert.match((await readCurrentUser(fakeApi([chatter, ["FROM User WHERE", denied]]))).problem, NOT_ALLOWED);
    const oth = await readCurrentUser(fakeApi([chatter, ["FROM User WHERE", () => failure(400, "MALFORMED_QUERY", "bad")]]));
    assert.match(oth.problem, /Only part of your user details/);
    assert.doesNotMatch(oth.problem, NOT_ALLOWED);
    // no Chatter fields (userinfo only): data is null
    const info = ["/userinfo", () => ({ user_id: "005000000000001AAA" })];
    const net = await readCurrentUser(fakeApi([info, ["FROM User WHERE", dropped]]));
    assert.equal(net.data, null);
    assert.match(net.problem, UNREACHED);
    assert.doesNotMatch(net.problem, NOT_ALLOWED);
    const den = await readCurrentUser(fakeApi([info, ["FROM User WHERE", denied]]));
    assert.match(den.problem, NOT_ALLOWED);
    const oth2 = await readCurrentUser(fakeApi([info, ["FROM User WHERE", () => failure(400, "MALFORMED_QUERY", "bad")]]));
    assert.match(oth2.problem, /could not be read/);
    assert.doesNotMatch(oth2.problem, NOT_ALLOWED);
  });

  await test("snapshot: the who-are-you step keeps the cause of both tries", async () => {
    const net = await readCurrentUser(fakeApi([["/chatter/users/me", dropped], ["/userinfo", dropped]]));
    assert.equal(net.data, null);
    assert.match(net.problem, /could not be reached.*Check your connection/);
    assert.doesNotMatch(net.problem, /would not say|not be allowed/);
    assert.ok(/Failed to fetch/.test(net.raw));
    // one try dropped, the other denied: say it could not be reached
    const mixed = await readCurrentUser(fakeApi([["/chatter/users/me", denied], ["/userinfo", dropped]]));
    assert.match(mixed.problem, /could not be reached/);
    const den = await readCurrentUser(fakeApi([["/chatter/users/me", denied], ["/userinfo", denied]]));
    assert.match(den.problem, /would not say who you are/);
    const sess = await readCurrentUser(fakeApi([["/chatter/users/me", () => failure(401, "INVALID_SESSION_ID", "expired")], ["/userinfo", dropped]]));
    assert.match(sess.problem, /session has expired/);
    const oth = await readCurrentUser(fakeApi([["/chatter/users/me", () => failure(400, "X", "weird")], ["/userinfo", () => failure(400, "X", "weird")]]));
    assert.match(oth.problem, /could not be read/);
    assert.doesNotMatch(oth.problem, /not be allowed|would not say|reached/);
  });

  await test("snapshot: Setup page names from the built-in list, Object Manager and the address", () => {
    const name = (u, t) => setupDisplayName(parsePageUrl(u), t);
    assert.equal(name("/lightning/setup/CompanyProfileInfo/home"), "Company Information");
    assert.equal(name("/lightning/setup/ManageUsers/home"), "Users");
    assert.equal(name("/lightning/setup/PermSetGroups/home"), "Permission Set Groups");
    assert.equal(name("/lightning/setup/ObjectManager/home"), "Object Manager");
    assert.equal(name("/lightning/setup/ObjectManager/Account/FieldsAndRelationships/view"), "Object Manager > Fields & Relationships");
    assert.equal(name("/lightning/setup/ObjectManager/Account/ButtonsLinksActions/view"), "Object Manager > Buttons, Links, and Actions");
    assert.equal(name("/lightning/setup/ObjectManager/Account/SomethingNew/view"), "Object Manager > Something New");
    assert.equal(name("/lightning/setup/ObjectManager/Account/view"), "Object Manager > Details");
    assert.equal(name("/lightning/setup/ObjectManager/Account/MySearchLayouts/view"), "Object Manager > Search Layouts");
    assert.equal(name("/lightning/setup/ObjectManager/Account/AlohaSearchLayouts/view"), "Object Manager > List View Button Layout");
    assert.equal(name("/lightning/setup/ObjectManager/Account/Limits/view"), "Object Manager > Object Limits");
    assert.equal(name("/lightning/setup/ObjectManager/Account/SearchLayouts/view"), "Object Manager > Search Layouts"); // made from the address
    assert.equal(parsePageUrl("/lightning/setup/ObjectManager/Account/PageLayouts/view").objectApi, "Account");
    assert.equal(name("/lightning/setup/ConnectedApplication/home"), "Manage Connected Apps");
    assert.equal(name("/lightning/setup/SecurityEvents/home"), "View Setup Audit Trail");
    assert.equal(name("/lightning/setup/HealthCheck/home"), "Health Check");
    assert.equal(name("/lightning/setup/AuditTrail/home"), "Audit Trail"); // removed segment: made from the address
    assert.equal(name("/lightning/setup/SecurityHealthCheck/home"), "Security Health Check");
    assert.equal(name("/lightning/setup/SomeNewThing/home"), "Some New Thing"); // unknown: made from the address
    assert.equal(name("/lightning/setup/constructor/home"), "constructor");
    assert.equal(name("/setup/own/orgdetail.apexp"), "own/orgdetail.apexp");
    assert.equal(name("/lightning/o/Account/list"), null);
  });

  await test("snapshot: tab titles are cleaned and generic ones rejected", () => {
    assert.equal(cleanTabTitle("Company Information | Salesforce"), "Company Information");
    assert.equal(cleanTabTitle("Company Information ~ Salesforce - Developer Edition"), "Company Information");
    assert.equal(cleanTabTitle("  Users ~ Salesforce  "), "Users");
    assert.equal(cleanTabTitle("Debug Logs | Salesforce"), "Debug Logs");
    for (const g of ["Salesforce", "Lightning Experience | Salesforce", "Setup", "Loading...", "Loading", "Loading…", "Page not found | Salesforce", "page NOT found", "Error", "Error ~ Salesforce - Developer Edition", "", "   ", " | Salesforce", null, undefined, 5]) {
      assert.equal(cleanTabTitle(g), "", String(g));
    }
    for (const g of ["Insufficient Privileges | Salesforce", "Error: Insufficient privileges", "insufficient privileges", "Something went wrong", "Sorry to interrupt | Salesforce", "Login", "login | Salesforce", "Verify Your Identity | Salesforce", "Error: something", "Errors"]) {
      assert.equal(cleanTabTitle(g), "", String(g));
    }
    assert.equal(cleanTabTitle("Login History | Salesforce"), "Login History");
    assert.ok(cleanTabTitle("A".repeat(300) + " | Salesforce").length <= 120);
  });

  await test("snapshot: the tab for this page is chosen by host and address, newest first", () => {
    const base = "https://acme.lightning.force.com/lightning/setup/CompanyProfileInfo/home";
    const tabs = [
      { url: base + "?sid=abc#frag", title: "Old title | Salesforce", lastAccessed: 100 },
      { url: base, title: "Company Information | Salesforce", lastAccessed: 200 },
      { url: "https://other.lightning.force.com/lightning/setup/CompanyProfileInfo/home", title: "Wrong Org | Salesforce", lastAccessed: 900 },
      { url: "https://acme.lightning.force.com/lightning/setup/ManageUsers/home", title: "Users | Salesforce", lastAccessed: 950 },
      { url: "not a url", title: "x" }, null,
    ];
    const clean = "/lightning/setup/CompanyProfileInfo/home";
    assert.equal(setupTitleFromTabs(tabs, "acme.lightning.force.com", clean), "Company Information");
    assert.equal(setupTitleFromTabs(tabs, "ACME.lightning.force.com", clean), "Company Information");
    assert.equal(setupTitleFromTabs(tabs, "nobody.lightning.force.com", clean), "");
    assert.equal(setupTitleFromTabs(tabs, "acme.lightning.force.com", "/lightning/setup/Roles/home"), "");
    // the newest tab is still loading: the next one with a real name is used
    assert.equal(setupTitleFromTabs([{ url: base, title: "Loading...", lastAccessed: 5 }, { url: base, title: "Company Information | Salesforce", lastAccessed: 1 }], "acme.lightning.force.com", clean), "Company Information");
    assert.equal(setupTitleFromTabs([{ url: base, title: "Salesforce" }], "acme.lightning.force.com", clean), "");
    assert.equal(setupTitleFromTabs(null, "h", clean), "");
    assert.equal(setupTitleFromTabs(tabs, "", clean), "");
  });

  await test("snapshot: the Setup page line uses the tab title first, then the list, then the address", async () => {
    const u = "/lightning/setup/CompanyProfileInfo/home";
    const line = async (url, setupTitle) => {
      const r = await readIssueSnapshot(fakeApi([]), { host: "h", url, setupTitle });
      return snapshotText({ when: new Date(0), timeZone: "UTC", page: r.page.data }).split("\n").find((l) => l.startsWith("Setup page:"));
    };
    assert.equal(await line(u, "Company Settings"), "Setup page: Company Settings");
    assert.equal(await line(u, ""), "Setup page: Company Information");
    assert.equal(await line(u), "Setup page: Company Information");
    assert.equal(await line("/lightning/setup/Mystery/home"), "Setup page: Mystery");
    assert.equal(await line("/lightning/setup/ObjectManager/Account/FieldsAndRelationships/view", "Account | Object Manager"), "Setup page: Object Manager > Fields & Relationships");
    // a title is org text: still scrubbed
    assert.ok(!(await line(u, "Users sid=abc123")).includes("abc123"));
    // the text does not say where the name came from
    assert.ok(!/tab|title/i.test(await line(u, "Company Settings")));
  });

  await test("snapshot: the new files use no innerHTML, storage or writes", () => {
    for (const f of ["tools/page-details/page-details-logic.js", "tools/page-details/page-details-read.js", "tools/page-details/page-details.js", "tools/page-details/page-details.html", "tools/page-details/page-details.css"]) {
      const text = read(ext(f));
      for (const bad of ["innerHTML", "insertAdjacentHTML", "outerHTML", "localStorage", "sessionStorage", "chrome.storage", "document.cookie"]) assert.ok(!text.includes(bad), `${f} uses ${bad}`);
    }
    for (const f of ["tools/page-details/page-details-logic.js", "tools/page-details/page-details-read.js"]) {
      const text = read(ext(f));
      assert.ok(!/\bfetch\s*\(|XMLHttpRequest|\.(post|patch|put|delete)\s*\(/.test(text), f);
    }
    assert.ok(!/sessionId/.test(read(ext("tools/page-details/page-details-logic.js"))));
  });

  await test("snapshot: the popup passes only the cleaned address", () => {
    const js = read(ext("menu.js"));
    assert.ok(read(ext("shared/tool-list.js")).includes('title: "Page details for a ticket"'));
    assert.ok(js.includes("cleanUrl(tab?.url"));
    assert.ok(!/tab\??\.url\)\}/.test(js));
  });
}
