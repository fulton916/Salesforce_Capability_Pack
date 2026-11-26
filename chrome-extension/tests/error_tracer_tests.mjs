// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Offline tests for Error Tracer. Called from run_tests.mjs with its shared `test` function.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SfApi, API_VERSION } from "../shared/sfconn.js";
import { TOOLS } from "../shared/tool-list.js";
import { FEEDBACK_TOOLS } from "../shared/feedback.js";
import {
  analyzeLog, CATEGORIES, explainSaveError, frameWords, isLogId, rawAround, summaryText, flowPointer,
  whatRan, statusWords, filterLogs, userChoices, humanSize, elapsedWords, whenText,
} from "../tools/error-tracer/error-tracer-logic.js";
import { readLogList, readLogBody, ReadProblem, listNote, LIST_LIMIT, REQUEST_LIMIT_TEXT } from "../tools/error-tracer/error-tracer-read.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = (...p) => path.join(here, "..", ...p);
const read = (f) => readFileSync(f, "utf-8");

const HEADER = "62.0 APEX_CODE,FINEST;APEX_PROFILING,INFO;CALLOUT,INFO;DB,INFO;NBA,INFO;SYSTEM,DEBUG;VALIDATION,INFO;VISUALFORCE,INFO;WAVE,INFO;WORKFLOW,INFO";
const USER = "00:00:00.0 (1)|USER_INFO|[EXTERNAL]|005000000000001AAA|alex@example.com|(GMT-08:00) Pacific Standard Time (America/Los_Angeles)|GMT-08:00";
/** A made-up log: header, then lines. */
const mk = (...lines) => [HEADER, ...lines].join("\n");
const t = (n, rest) => `10:00:00.0 (${n})|${rest}`;
const TRIGGER_START = t(10, "CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001|AccountTrigger on Account trigger event BeforeUpdate|__sfdc_trigger/AccountTrigger");
const demo = () => JSON.parse(read(ext("samples", "error_tracer_demo.json")));

/** A fake fetch that records every call and refuses anything but GET. */
function recordingFetch(handler) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, opts });
    assert.ok(opts.method === undefined || opts.method === "GET", `non-GET call: ${opts.method} ${url}`);
    assert.equal(opts.body, undefined, "a body was sent");
    return handler(new URL(url), opts);
  };
  f.calls = calls;
  return f;
}
const textRes = (body, status = 200) => ({ ok: status < 400, status, text: async () => body });

export async function run(test) {
  // ---------- sfconn.getText ----------

  await test("errors: getText returns the plain text, sends the login, sets no method and parses nothing", async () => {
    const f = recordingFetch(() => textRes('{"not":"parsed"}\nsecond line'));
    const api = new SfApi({ apiHost: "x.my.salesforce.com", sessionId: "S", fetchImpl: f });
    const body = await api.getText(`/services/data/v${API_VERSION}/sobjects/ApexLog/07L000000000001AAA/Body`);
    assert.equal(body, '{"not":"parsed"}\nsecond line');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, `https://x.my.salesforce.com/services/data/v${API_VERSION}/sobjects/ApexLog/07L000000000001AAA/Body`);
    assert.equal(f.calls[0].opts.headers.Authorization, "Bearer S");
    assert.match(f.calls[0].opts.headers.Accept, /text\/plain/);
    assert.ok(!("method" in f.calls[0].opts));
    assert.equal(api.calls, 1);
  });

  await test("errors: getText fails the way get does (401 wording, Salesforce message, plain-text errors)", async () => {
    const mkApi = (res) => new SfApi({ apiHost: "x", sessionId: "S", fetchImpl: async () => res });
    await assert.rejects(mkApi({ ok: false, status: 401, text: async () => JSON.stringify([{ message: "Session expired", errorCode: "INVALID_SESSION_ID" }]) }).getText("/x"),
      (e) => /Reload the Salesforce tab/.test(e.message) && e.status === 401 && e.detail === "Session expired");
    await assert.rejects(mkApi({ ok: false, status: 404, text: async () => JSON.stringify([{ message: "The requested resource does not exist", errorCode: "NOT_FOUND" }]) }).getText("/x"),
      (e) => e.status === 404 && e.errorCode === "NOT_FOUND" && /does not exist/.test(e.message));
    await assert.rejects(mkApi({ ok: false, status: 503, text: async () => "Service down" }).getText("/x"), (e) => e.status === 503 && e.message === "Service down");
    // get is unchanged
    const j = new SfApi({ apiHost: "x", sessionId: "S", fetchImpl: async () => textRes('{"a":1}') });
    assert.deepEqual(await j.get("/y"), { a: 1 });
  });

  // ---------- reading ----------

  await test("errors: isLogId accepts 07L Ids only", () => {
    for (const ok of ["07L000000000001AAA", "07L000000000001", "07LabcDEF123456"]) assert.ok(isLogId(ok), ok);
    for (const bad of ["", null, undefined, 5, "07L00000000000", "07L0000000000011AA1X", "001000000000001AAA", "07L000000000001AAA/../x", "07L000000000001AAA?q=1", " 07L000000000001AAA", "07L00000000000-AAA"]) assert.ok(!isLogId(bad), String(bad));
  });

  await test("errors: the list is one SELECT on ApexLog, newest first, GET only", async () => {
    const f = recordingFetch((u) => {
      assert.match(u.pathname, /\/query\/$/);
      const q = u.searchParams.get("q");
      assert.match(q, /FROM ApexLog ORDER BY StartTime DESC LIMIT 100$/);
      for (const field of ["Id", "LogUserId", "LogUser.Name", "Operation", "Request", "Application", "Status", "Location", "StartTime", "DurationMilliseconds", "LogLength"]) assert.ok(q.includes(field), field);
      return textRes(JSON.stringify({ done: true, totalSize: 1, records: [{ Id: "07L000000000001AAA", LogUserId: "005000000000001AAA", LogUser: { Name: "Alex Example" }, Operation: "/aura", Request: "Application", Application: "Browser", Status: "Success", Location: "SystemLog", StartTime: "2026-11-20T09:15:02.000+0000", DurationMilliseconds: 200, LogLength: 1500 }] }));
    });
    const rows = await readLogList(new SfApi({ apiHost: "x", sessionId: "S", fetchImpl: f }));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(rows[0], { id: "07L000000000001AAA", userId: "005000000000001AAA", userName: "Alex Example", operation: "/aura", request: "Application", application: "Browser", status: "Success", location: "SystemLog", startTime: "2026-11-20T09:15:02.000+0000", durationMs: 200, length: 1500 });
  });

  await test("errors: the body is one GET of /sobjects/ApexLog/<id>/Body, and a bad Id makes no call", async () => {
    const f = recordingFetch((u) => {
      assert.equal(u.pathname, `/services/data/v${API_VERSION}/sobjects/ApexLog/07L000000000001AAA/Body`);
      return textRes(mk("x"));
    });
    const api = new SfApi({ apiHost: "x", sessionId: "S", fetchImpl: f });
    assert.equal(await readLogBody(api, "07L000000000001AAA"), mk("x"));
    for (const bad of ["../../query", "07L1", "", undefined, "001000000000001AAA"]) {
      await assert.rejects(readLogBody(api, bad), (e) => e instanceof ReadProblem && /not a debug log Id/.test(e.message));
    }
    assert.equal(f.calls.length, 1, "only the good Id made a call");
  });

  await test("errors: the list says when it may be cut at the newest 100 logs", () => {
    assert.equal(LIST_LIMIT, 100);
    assert.equal(listNote(100), "Showing the newest 100 logs. Older ones are not listed.");
    assert.equal(listNote(99), "");
    assert.equal(listNote(0), "");
  });

  await test("errors: a daily API limit answer (403) is not shown as a missing permission", async () => {
    const api = new SfApi({ apiHost: "x", sessionId: "S", fetchImpl: async () => ({ ok: false, status: 403, text: async () => JSON.stringify([{ message: "TotalRequests Limit exceeded.", errorCode: "REQUEST_LIMIT_EXCEEDED" }]) }) });
    await assert.rejects(readLogList(api), (e) => e instanceof ReadProblem && e.message === REQUEST_LIMIT_TEXT && /not a missing permission/.test(e.message) && /Limit exceeded/.test(e.raw));
    await assert.rejects(readLogBody(api, "07L000000000001AAA"), (e) => e.message === REQUEST_LIMIT_TEXT);
  });

  await test("errors: the headline is green only for a complete log; unrecorded or cut-off logs get a neutral one", () => {
    const complete = analyzeLog(mk(TRIGGER_START));
    assert.equal(complete.tone, "good");
    assert.equal(complete.headline, "No errors found in this log");
    const noFlows = analyzeLog([HEADER.replace("WORKFLOW,INFO", "WORKFLOW,NONE"), TRIGGER_START].join("\n"));
    assert.equal(noFlows.tone, "neutral");
    assert.equal(noFlows.headline, "No errors found in the parts of this log that were recorded");
    const cut = analyzeLog(mk(TRIGGER_START), { length: 20000000 });
    assert.equal(cut.tone, "neutral");
    assert.equal(cut.headline, "No errors found in the parts of this log that were recorded");
    assert.match(cut.subline, /cut off/);
    const bare = analyzeLog(TRIGGER_START);
    assert.equal(bare.levels, null, "no levels line");
    assert.equal(bare.tone, "neutral");
    assert.equal(bare.headline, "No errors found in this log");
    assert.match(bare.subline, /does not say what it recorded/);
    assert.equal(analyzeLog([HEADER.replace("APEX_CODE,FINEST", "APEX_CODE,DEBUG"), TRIGGER_START].join("\n")).tone, "good", "Debug is enough for Apex code");
    assert.equal(analyzeLog([HEADER.replace("APEX_CODE,FINEST", "APEX_CODE,WARN"), TRIGGER_START].join("\n")).tone, "neutral", "Apex code below Info is not enough");
  });

  await test("errors: page steps and README say Apex Code at Info or finer, like the analyser", () => {
    assert.equal(CATEGORIES.find((c) => c.key === "APEX_CODE").needs, "INFO");
    const html = read(ext("tools", "error-tracer", "error-tracer.html"));
    assert.ok(/Apex Code, Database, Validation and Workflow each to Info or finer/.test(html));
    assert.ok(!/Apex Code at Debug or finer/.test(html + read(ext("README.md"))));
  });

  await test("errors: each read failure is plain words, with the raw text kept for Technical details", async () => {
    const failing = (status, body) => new SfApi({ apiHost: "x", sessionId: "S", fetchImpl: async () => ({ ok: false, status, text: async () => JSON.stringify(body) }) });
    const list = (status, body) => readLogList(failing(status, body));
    await assert.rejects(list(400, [{ message: "No such column 'Location' on entity 'ApexLog'", errorCode: "INVALID_FIELD" }]),
      (e) => e instanceof ReadProblem && /did not accept the request for the list of logs/.test(e.message) && /No such column/.test(e.raw) && !/INVALID_FIELD|column/.test(e.message));
    await assert.rejects(list(403, [{ message: "insufficient access rights on object id", errorCode: "INSUFFICIENT_ACCESS" }]),
      (e) => /extra permission/.test(e.message) && /insufficient access/.test(e.raw) && !/ViewAllData|View All Data|Manage Users/.test(e.message));
    await assert.rejects(list(401, [{ message: "Session expired", errorCode: "INVALID_SESSION_ID" }]), (e) => /Reload the Salesforce tab/.test(e.message));
    await assert.rejects(readLogBody(failing(404, [{ message: "The requested resource does not exist", errorCode: "NOT_FOUND" }]), "07L000000000001AAA"),
      (e) => /This log was not found/.test(e.message) && /does not exist/.test(e.raw));
    await assert.rejects(list(500, [{ message: "boom", errorCode: "UNKNOWN_EXCEPTION" }]), (e) => /Could not read the list of logs/.test(e.message) && e.raw === "boom");
  });

  await test("errors: GET-only guard (a) every call the reader makes is a GET with no body", async () => {
    const f = recordingFetch((u) => u.pathname.includes("/query")
      ? textRes(JSON.stringify({ done: true, totalSize: 0, records: [] }))
      : textRes(mk()));
    const api = new SfApi({ apiHost: "x", sessionId: "S", fetchImpl: f });
    await readLogList(api);
    await readLogBody(api, "07L000000000001AAA");
    await api.getText(`/services/data/v${API_VERSION}/sobjects/ApexLog/07L000000000001AAA/Body`);
    assert.equal(f.calls.length, 3);
    for (const c of f.calls) assert.ok(!c.opts.method && !c.opts.body);
  });

  await test("errors: GET-only guard (b) no file in the tool can write, set a trace flag or touch a debug level", () => {
    // Case-sensitive on the API names (TraceFlag, DebugLevel); the help text may say "debug log" and "User Trace Flags".
    const banned = ["TraceFlag", "DebugLevel", "method:", "method =", "\"POST\"", "'POST'", "\"PATCH\"", "'PATCH'", "\"PUT\"", "'PUT'", "\"DELETE\"", "'DELETE'", "composite", "/tooling", "XMLHttpRequest", "sendBeacon", "chrome.storage", "localStorage", "innerHTML", "insertAdjacentHTML", "outerHTML"];
    const dir = ext("tools", "error-tracer");
    const files = readdirSync(dir);
    assert.deepEqual(files.sort(), ["error-tracer-logic.js", "error-tracer-read.js", "error-tracer.css", "error-tracer.html", "error-tracer.js"]);
    for (const f of files) {
      const text = read(path.join(dir, f));
      for (const b of banned) assert.ok(!text.includes(b), `${f} contains ${b}`);
      assert.ok(!/\bfetch\s*\([^)]*,/.test(text), `${f} calls fetch with options`);
    }
    assert.ok(!/\.(post|put|patch|delete)\s*\(/i.test(read(path.join(dir, "error-tracer.js"))));
    assert.ok(!/\bsf\.|SalesforceError\(.*POST/.test(read(path.join(dir, "error-tracer-read.js"))));
  });

  // ---------- understanding a log ----------

  await test("errors: an unhandled null pointer in a trigger gives where, what and who", () => {
    const a = analyzeLog(mk(USER, TRIGGER_START,
      t(20, "EXCEPTION_THROWN|[3]|System.NullPointerException: Attempt to de-reference a null object"),
      t(30, "FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object"),
      "", "Trigger.AccountTrigger: line 3, column 1",
      t(40, "CODE_UNIT_FINISHED|AccountTrigger on Account trigger event BeforeUpdate|__sfdc_trigger/AccountTrigger")));
    assert.equal(a.problemCount, 1);
    assert.equal(a.findings.length, 1, "the thrown and the fatal error are one problem");
    const f = a.findings[0];
    assert.equal(f.kind, "apex");
    assert.equal(f.handled, false);
    assert.equal(f.where, "Apex trigger AccountTrigger, line 3");
    assert.match(f.message, /something that was empty/);
    assert.match(f.message, /Attempt to de-reference a null object/);
    assert.deepEqual(f.steps, ["Apex trigger AccountTrigger (before update of Account)"]);
    assert.equal(f.time, "10:00:00.0");
    assert.equal(a.headline, "1 problem found in this log");
    assert.deepEqual(a.user, { id: "005000000000001AAA", username: "alex@example.com", timeZone: "(GMT-08:00) Pacific Standard Time (America/Los_Angeles)" });
    assert.equal(a.version, "62.0");
  });

  await test("errors: a thrown error with no fatal error is 'may have been handled', not the cause, and repeats are counted once", () => {
    const a = analyzeLog(mk(TRIGGER_START,
      ...[1, 2, 3].map((i) => t(20 + i, "EXCEPTION_THROWN|[7]|System.QueryException: List has no rows for assignment to SObject")),
      t(40, "CODE_UNIT_FINISHED|x")));
    assert.equal(a.findings.length, 1);
    assert.equal(a.findings[0].handled, true);
    assert.equal(a.findings[0].count, 3);
    assert.match(a.findings[0].title, /^An error was raised in Apex$/);
    assert.equal(a.problemCount, 0);
    assert.equal(a.handledCount, 1);
    assert.equal(a.headline, "No unhandled errors found in this log");
    assert.equal(a.findings[0].where, "Apex trigger AccountTrigger (before update of Account), line 7");
  });

  await test("errors: Apex class stack traces become plain words", () => {
    assert.equal(frameWords("Class.OpportunityService.createFollowUp: line 12, column 1"), "Apex class OpportunityService, method createFollowUp, line 12");
    assert.equal(frameWords("Class.Outer.Inner.run: line 5, column 9"), "Apex class Outer.Inner, method run, line 5");
    assert.equal(frameWords("Class.Helper: line 2, column 1"), "Apex class Helper, line 2");
    assert.equal(frameWords("Trigger.AccountTrigger: line 3, column 1"), "Apex trigger AccountTrigger, line 3");
    assert.equal(frameWords("AnonymousBlock: line 1, column 1"), "anonymous Apex, line 1");
    assert.equal(frameWords("not a frame"), "");
    assert.equal(frameWords(null), "");
  });

  await test("errors: a save stopped by a validation rule is one finding with the rule, the object and the message", () => {
    const msg = "System.DmlException: Insert failed. First exception on row 0; first error: FIELD_CUSTOM_VALIDATION_EXCEPTION, Enter a close date before saving: [CloseDate]";
    const a = analyzeLog(mk(
      t(5, "CODE_UNIT_STARTED|[EXTERNAL]|01p000000000002|OpportunityService.createFollowUp(Opportunity)"),
      t(6, "DML_BEGIN|[12]|Op:Insert|Type:Opportunity|Rows:1"),
      t(7, "CODE_UNIT_STARTED|[EXTERNAL]|Validation:Opportunity:006000000000001AAA"),
      t(8, "VALIDATION_RULE|03d000000000001AAA|Close_Date_Required"),
      t(9, "VALIDATION_FORMULA|ISBLANK(CloseDate)|CloseDate=null"),
      t(10, "VALIDATION_FAIL"),
      t(11, "CODE_UNIT_FINISHED|Validation:Opportunity:006000000000001AAA"),
      t(12, `EXCEPTION_THROWN|[12]|${msg}`),
      t(13, `FATAL_ERROR|${msg}`), "", "Class.OpportunityService.createFollowUp: line 12, column 1", "Class.OpportunityController.save: line 40, column 1"));
    assert.equal(a.findings.length, 1, "rule + exception + fatal error are one problem");
    const f = a.findings[0];
    assert.equal(f.kind, "validation");
    assert.equal(f.rule, "Close_Date_Required");
    assert.equal(f.object, "Opportunity");
    assert.match(f.message, /Close_Date_Required/);
    assert.match(f.message, /Enter a close date before saving/);
    assert.match(f.message, /CloseDate/);
    assert.equal(f.where, "Apex class OpportunityService, method createFollowUp, line 12");
    assert.deepEqual(f.callers, ["Apex class OpportunityController, method save, line 40"]);
    assert.equal(f.handled, false);
  });

  await test("errors: a validation rule that fails with no exception (and its VALIDATION_ERROR message) stands alone", () => {
    const a = analyzeLog(mk(
      t(7, "CODE_UNIT_STARTED|[EXTERNAL]|Validation:Account:001000000000001AAA"),
      t(8, "VALIDATION_RULE|03d000000000002AAA|Phone_Format"),
      t(9, "VALIDATION_PASS"),
      t(10, "VALIDATION_RULE|03d000000000003AAA|Name_Required"),
      t(11, "VALIDATION_FAIL"),
      t(12, "VALIDATION_ERROR|Please enter an account name"),
      t(13, "CODE_UNIT_FINISHED|Validation:Account:001000000000001AAA")));
    assert.equal(a.findings.length, 1);
    const f = a.findings[0];
    assert.equal(f.kind, "validation");
    assert.equal(f.rule, "Name_Required");
    assert.equal(f.object, "Account");
    assert.equal(f.recordId, "001000000000001AAA");
    assert.match(f.message, /Please enter an account name/);
    assert.equal(f.where, "Validation rule Name_Required on Account");
    // message first, then the failure
    const b = analyzeLog(mk(t(8, "VALIDATION_RULE|03d000000000003AAA|Name_Required"), t(9, "VALIDATION_ERROR|Please enter a name"), t(10, "VALIDATION_FAIL")));
    assert.match(b.findings[0].message, /Please enter a name/);
  });

  await test("errors: save error codes are put in plain words, unknown codes are shown plainly", () => {
    const e = (code, msg, extra = "") => explainSaveError(`System.DmlException: Update failed. First exception on row 0 with id 001000000000001AAA; first error: ${code}, ${msg}${extra}`);
    assert.match(e("REQUIRED_FIELD_MISSING", "Required fields are missing", ": [Name]").plain, /required field was left empty \(Name\)/);
    assert.match(e("DUPLICATE_VALUE", "duplicate value found").plain, /must be unique/);
    assert.match(e("CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY", "MyTrigger: execution of BeforeUpdate").plain, /trigger, flow or other automation\) failed: MyTrigger/);
    assert.match(e("UNABLE_TO_LOCK_ROW", "unable to obtain exclusive access to this record").plain, /locked by another process/);
    assert.match(e("INSUFFICIENT_ACCESS_OR_READONLY", "insufficient access rights on object id").plain, /does not have the access needed/);
    assert.match(e("INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY", "x").plain, /does not have the access needed/);
    assert.match(e("DUPLICATES_DETECTED", "Use one of these records?").plain, /duplicate rule/);
    const unknown = e("SOMETHING_NEW_EXCEPTION", "odd thing", ": [Field__c]");
    assert.equal(unknown.code, "SOMETHING_NEW_EXCEPTION");
    assert.match(unknown.plain, /SOMETHING_NEW_EXCEPTION: odd thing/);
    assert.equal(unknown.recordId, "001000000000001AAA");
    assert.equal(unknown.op, "Update");
    assert.equal(explainSaveError("System.NullPointerException: x"), null);
    assert.equal(explainSaveError(""), null);
  });

  await test("errors: a failed save names the kind of record from DML_BEGIN", () => {
    const msg = "System.DmlException: Insert failed. First exception on row 0; first error: REQUIRED_FIELD_MISSING, Required fields are missing: [LastName]";
    const a = analyzeLog(mk(t(1, "DML_BEGIN|[4]|Op:Insert|Type:Contact|Rows:2"), t(2, `FATAL_ERROR|${msg}`), "", "Class.ImportJob.run: line 9, column 1"));
    const f = a.findings[0];
    assert.equal(f.kind, "save");
    assert.match(f.message, /Saving a Contact \(insert, 2 rows\) failed\./);
    assert.match(f.message, /required field was left empty \(LastName\)/);
    assert.equal(f.where, "Apex class ImportJob, method run, line 9");
  });

  await test("errors: a failing flow names the flow, the step and points to the flow-usage tool in words only", () => {
    const iv = "a1b2c3d4-0000-4000-8000-000000000001";
    const a = analyzeLog(mk(
      t(1, "CODE_UNIT_STARTED|[EXTERNAL]|Flow:Case"),
      t(2, `FLOW_START_INTERVIEW_BEGIN|00D000000000001AAA|Case_Escalation_Flow`),
      t(3, `FLOW_ELEMENT_BEGIN|${iv}|FlowRecordUpdate|Update_Related_Cases`),
      t(4, "FLOW_ELEMENT_ERROR|The flow failed to access the value for x because it hasn't been set.|FlowRecordUpdate|Update_Related_Cases"),
      t(5, `FLOW_START_INTERVIEWS_ERROR|An unhandled fault has occurred in this flow|${iv}`),
      t(6, `FLOW_START_INTERVIEW_END|${iv}|Case_Escalation_Flow`)));
    assert.equal(a.findings.length, 1, "the step error and the interview error are one failure");
    const f = a.findings[0];
    assert.equal(f.kind, "flow");
    assert.equal(f.flow, "Case_Escalation_Flow");
    assert.equal(f.element, "Update_Related_Cases");
    assert.equal(f.where, "Flow Case_Escalation_Flow, step Update_Related_Cases");
    assert.match(f.message, /The flow “Case_Escalation_Flow” failed at the step “Update_Related_Cases” \(record update\)/);
    assert.equal(f.flowPointer, flowPointer("Case_Escalation_Flow"));
    assert.match(f.flowPointer, /open “Where is it used in flows\?” from the Salesforce Capability Pack button and search for Case_Escalation_Flow/);
    assert.equal(f.handled, false);
  });

  await test("errors: a flow fault path is shown as handled; a later hard error wins; the flow name can come from the interview map", () => {
    const iv = "a1b2c3d4-0000-4000-8000-000000000002";
    const a = analyzeLog(mk(
      t(1, `FLOW_CREATE_INTERVIEW_END|${iv}|Order_Flow`),
      t(2, `FLOW_ELEMENT_BEGIN|${iv}|FlowRecordCreate|Make_Task`),
      t(3, "FLOW_ELEMENT_FAULT|Bad value|FlowRecordCreate|Make_Task")));
    assert.equal(a.findings[0].handled, true);
    assert.equal(a.findings[0].flow, "Order_Flow");
    const b = analyzeLog(mk(
      t(2, "FLOW_START_INTERVIEW_BEGIN|00D000000000001AAA|Order_Flow"),
      t(3, "FLOW_ELEMENT_FAULT|Bad value|FlowRecordCreate|Make_Task"),
      t(4, "FLOW_ELEMENT_ERROR|Bad value|FlowRecordCreate|Make_Task")));
    assert.equal(b.findings.length, 1);
    assert.equal(b.findings[0].handled, false);
    const c = analyzeLog(mk(t(2, "FLOW_CREATE_INTERVIEW_ERROR|Could not start|Some_Flow")));
    assert.equal(c.findings[0].flow, "Some_Flow");
  });

  await test("errors: a Salesforce limit is explained and counted once", () => {
    const a = analyzeLog(mk(TRIGGER_START,
      t(2, "EXCEPTION_THROWN|[14]|System.LimitException: Too many SOQL queries: 101"),
      t(3, "FATAL_ERROR|System.LimitException: Too many SOQL queries: 101"), "", "Class.Loader.loop: line 14, column 1"));
    assert.equal(a.findings.length, 1);
    assert.equal(a.findings[0].kind, "limit");
    assert.match(a.findings[0].message, /more database queries \(SOQL\)/);
    assert.match(a.findings[0].message, /Too many SOQL queries: 101/);
    const cpu = analyzeLog(mk(t(3, "FATAL_ERROR|System.LimitException: Apex CPU time limit exceeded")));
    assert.match(cpu.findings[0].message, /processing time/);
  });

  await test("errors: a multi-line message and its stack trace continue the event before them", () => {
    const a = analyzeLog(mk(
      t(3, "FATAL_ERROR|System.DmlException: Update failed. First exception on row 0 with id 001000000000001AAA; first error: CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY, AccountTrigger: execution of BeforeUpdate"),
      "", "caused by: System.NullPointerException: Attempt to de-reference a null object", "",
      "Trigger.AccountTrigger: line 3, column 1: []", "External entry point",
      t(4, "CODE_UNIT_FINISHED|x")));
    assert.equal(a.findings.length, 1);
    const f = a.findings[0];
    assert.equal(f.kind, "save");
    assert.equal(f.where, "Apex trigger AccountTrigger, line 3");
    assert.match(f.message, /caused by: System\.NullPointerException/);
    const raw = rawAround(a, f).map((l) => l.text);
    assert.ok(raw.includes("Trigger.AccountTrigger: line 3, column 1: []"));
    assert.ok(rawAround(a, f).some((l) => l.hit));
  });

  await test("errors: unknown events, malformed lines and odd input never throw", () => {
    const nasty = [
      "", "   ", "garbage with | pipes", "10:00:00.0 (", "10:00:00.0 (5)|", "10:00:00.0 (5)|FATAL_ERROR", "10:00:00.0 (5)|EXCEPTION_THROWN",
      "10:00:00.0 (6)|EXCEPTION_THROWN|[x]|", "10:00:00.0 (7)|CODE_UNIT_FINISHED", "10:00:00.0 (8)|CODE_UNIT_FINISHED", "10:00:00.0 (9)|DML_BEGIN",
      "10:00:00.0 (10)|VALIDATION_FAIL", "10:00:00.0 (11)|FLOW_ELEMENT_ERROR", "10:00:00.0 (12)|FLOW_SOMETHING_NEW|a|b", "10:00:00.0 (13)|BRAND_NEW_EVENT|x|y",
      "10:00:00.0 (14)|USER_INFO", "10:00:00.0 (15)|CODE_UNIT_STARTED", "10:00:00.0 (16)|VALIDATION_RULE", "10:00:00.0 (17)|VALIDATION_ERROR", "\u0000\u0001", "\r",
    ];
    for (const input of [mk(...nasty), nasty.join("\n"), "", null, undefined, 42, {}, "\n\n\n", "62.0 ", "10:00:00.0 (1)|FATAL_ERROR|" + "x".repeat(100000)]) {
      const a = analyzeLog(input);
      assert.ok(Array.isArray(a.findings));
      assert.ok(typeof a.headline === "string" && a.headline.length > 0);
      summaryText(a, {});
      for (const f of a.findings) rawAround(a, f);
    }
    const a = analyzeLog("not a log at all");
    assert.equal(a.problemCount, 0);
    assert.ok(a.notes.some((n) => /empty or is not a debug log/.test(n)));
    assert.equal(a.headline, "This does not look like a debug log");
  });

  await test("errors: a cut-off log is reported, by its marker or by the size from the list", () => {
    const a = analyzeLog(mk(TRIGGER_START, t(2, "USER_DEBUG|[1]|DEBUG|x"), "*********** MAXIMUM DEBUG LOG SIZE REACHED ***********"));
    assert.equal(a.cutOff, true);
    assert.ok(a.notes.some((n) => /turn the debug level down/.test(n)));
    assert.match(a.subline, /cut off/);
    const b = analyzeLog(mk(TRIGGER_START), { length: 20000000 });
    assert.equal(b.cutOff, true);
    const c = analyzeLog(mk("*** Skipped 4233 bytes of detailed log"));
    assert.equal(c.cutOff, true);
    assert.equal(analyzeLog(mk(TRIGGER_START), { length: 1500 }).cutOff, false);
  });

  await test("errors: the levels line decides what 'no errors' may claim (Workflow off means flows are not covered)", () => {
    const noFlows = HEADER.replace("WORKFLOW,INFO", "WORKFLOW,NONE");
    const a = analyzeLog([noFlows, TRIGGER_START].join("\n"));
    assert.equal(a.problemCount, 0);
    assert.equal(a.headline, "No errors found in the parts of this log that were recorded");
    assert.match(a.subline, /Not recorded: Flows and workflow/);
    assert.ok(!/Recorded:[^.]*Flows and workflow/.test(a.subline), "flows are not listed as recorded");
    assert.equal(a.notes.filter((n) => /debug level in Setup/.test(n)).length, 1);
    assert.ok(a.notes.some((n) => /^To record what is missing, edit the debug level in Setup and set the categories named above \(Workflow\) to Info or finer, then repeat the action\.$/.test(n)), a.notes.join(" | "));
    assert.equal(a.coverage.find((c) => c.key === "WORKFLOW").ok, false);
    assert.equal(a.coverage.find((c) => c.key === "APEX_CODE").ok, true);
    // everything recorded: the claim names what was covered
    const all = analyzeLog(mk(TRIGGER_START));
    assert.match(all.subline, /Recorded: .*Flows and workflow \(info\)/);
    assert.ok(!/Not recorded/.test(all.subline));
    // a category missing from the line is "not recorded"
    const lean = analyzeLog(["62.0 APEX_CODE,DEBUG", TRIGGER_START].join("\n"));
    assert.match(lean.subline, /Not recorded: Saves to the database, Validation rules, Flows and workflow/);
    // low Apex level
    const low = analyzeLog([HEADER.replace("APEX_CODE,FINEST", "APEX_CODE,ERROR"), TRIGGER_START].join("\n"));
    assert.ok(low.notes.some((n) => /categories named above \(Apex Code\) to Info or finer/.test(n)));
    // problems found while a category was missing still say there may be more
    const some = analyzeLog([noFlows, t(3, "FATAL_ERROR|System.MathException: Divide by 0"), "", "Class.Calc.run: line 4, column 1"].join("\n"));
    assert.match(some.subline, /Not recorded well enough to show errors: Flows and workflow/);
    assert.equal(analyzeLog("62.0 APEX_CODE,FINEST;WORKFLOW,INFO\n").levels.WORKFLOW, "INFO");
  });

  await test("errors: a 20 MB log is read in one quick pass", () => {
    const filler = "USER_DEBUG|[1]|DEBUG|" + "x".repeat(60);
    const lines = [HEADER, USER];
    let size = 0;
    let i = 0;
    while (size < 20_000_000) {
      const l = `10:00:00.0 (${1000 + i}) |${filler}`.replace(") |", ")|");
      lines.push(l);
      size += l.length + 1;
      if (i % 5000 === 0) {
        lines.push(t(i, "CODE_UNIT_STARTED|[EXTERNAL]|01p000000000009|Busy.work()"), t(i, "EXCEPTION_THROWN|[2]|System.QueryException: List has no rows"), t(i, "CODE_UNIT_FINISHED|Busy.work()"));
      }
      i++;
    }
    lines.splice(Math.floor(lines.length / 2), 0, t(7, "FATAL_ERROR|System.MathException: Divide by 0"), "", "Class.Calc.run: line 4, column 1");
    const text = lines.join("\n");
    assert.ok(text.length >= 20_000_000);
    const t0 = Date.now();
    const a = analyzeLog(text, { length: text.length });
    const ms = Date.now() - t0;
    assert.ok(ms < 8000, `took ${ms} ms`);
    assert.equal(a.problemCount, 1);
    assert.equal(a.findings.filter((f) => f.handled).length, 1, "the same handled error, repeated, is one finding");
    assert.ok(a.findings.find((f) => f.handled).count > 10);
    assert.equal(a.findings.find((f) => !f.handled).where, "Apex class Calc, method run, line 4");
    assert.ok(a.cutOff);
    assert.ok(rawAround(a, a.findings.find((f) => !f.handled)).length <= 50);
  });

  await test("errors: a flood of different errors is capped", () => {
    const lines = [];
    for (let i = 0; i < 500; i++) lines.push(t(i, `EXCEPTION_THROWN|[1]|System.CalloutException: Unique failure number ${i}`));
    const a = analyzeLog(mk(...lines));
    assert.equal(a.findings.length, 200);
    assert.equal(a.moreFindings, 300);
    assert.ok(a.notes.some((n) => /300 more problems were left out/.test(n)));
  });

  await test("errors: raw lines are short, flagged where they matter, and plain text for Copy has what, where, who and when", () => {
    const long = "y".repeat(5000);
    const a = analyzeLog(mk(USER, TRIGGER_START, t(15, `USER_DEBUG|[1]|DEBUG|${long}`),
      t(30, "FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object"), "", "Trigger.AccountTrigger: line 3, column 1"));
    const lines = rawAround(a, a.findings[0]);
    assert.ok(lines.every((l) => l.text.length <= 401));
    assert.ok(lines.some((l) => l.hit && /FATAL_ERROR/.test(l.text)));
    assert.ok(lines.some((l) => !l.hit));
    const txt = summaryText(a, { userName: "Alex Example", startTime: "2026-11-20T09:15:02.000+0000", startTimeText: "20/11/2026, 09:15:02", what: "/aura (a page in Salesforce)", status: "Success" });
    assert.match(txt, /^1 problem found in this log/);
    assert.match(txt, /Who: Alex Example \(alex@example\.com\)/);
    assert.match(txt, /When: 20\/11\/2026, 09:15:02/);
    assert.match(txt, /Where: Apex trigger AccountTrigger, line 3/);
    assert.match(txt, /What ran: \/aura/);
    assert.ok(!txt.includes("yyyy"), "raw log lines are not in the copied text");
  });

  await test("errors: list helpers (plain what-ran, result, size, filters, people)", () => {
    const rows = [
      { id: "1", userId: "U1", userName: "Zed Sample", operation: "/aura", request: "Application", status: "Success", length: 900 },
      { id: "2", userId: "U2", userName: "Alex Example", operation: "ApexTrigger", request: "Api", status: "System.NullPointerException: x", length: 2048 },
      { id: "3", userId: "U2", userName: "Alex Example", operation: "", request: "", status: "", length: null },
    ];
    assert.equal(whatRan(rows[0]), "/aura (a page in Salesforce)");
    assert.equal(whatRan(rows[1]), "ApexTrigger (an API call)");
    assert.equal(whatRan(rows[2]), "Not stated");
    assert.deepEqual(statusWords(rows[0]), { ok: true, text: "Success" });
    assert.equal(statusWords(rows[1]).ok, false);
    assert.equal(statusWords(rows[2]).ok, null);
    assert.deepEqual(filterLogs(rows, { problemsOnly: true }).map((r) => r.id), ["2"]);
    assert.deepEqual(filterLogs(rows, { userId: "U2" }).map((r) => r.id), ["2", "3"]);
    assert.deepEqual(filterLogs(rows, { problemsOnly: true, userId: "U1" }), []);
    assert.equal(filterLogs(rows, {}).length, 3);
    assert.deepEqual(userChoices(rows).map((u) => [u.name, u.count]), [["Alex Example", 2], ["Zed Sample", 1]]);
    assert.equal(humanSize(900), "900 B");
    assert.equal(humanSize(2048), "2 KB");
    assert.equal(humanSize(20000000), "19.1 MB");
    assert.equal(humanSize(null), "");
    assert.equal(elapsedWords(9), "9 ms after the log started");
    assert.equal(elapsedWords(400), "0.4 seconds after the log started");
    assert.equal(elapsedWords(1000), "1 second after the log started");
    assert.equal(elapsedWords(1500), "1.5 seconds after the log started");
  });

  // ---------- sample, registration ----------

  await test("errors: the demo sample stays synthetic", () => {
    const raw = read(ext("samples", "error_tracer_demo.json"));
    const d = JSON.parse(raw);
    assert.ok(d.logs.length >= 4);
    for (const l of d.logs) {
      assert.match(l.id, /^07L0{9}\d+AAA$/);
      assert.match(l.userId, /^0050{9}\d+AAA$/);
      assert.ok(isLogId(l.id));
    }
    for (const em of raw.match(/[\w.+-]+@[\w.-]+/g) || []) assert.ok(/@example\.com$/.test(em), em);
    assert.ok(!/AQEAQ|sid=|token|password|secret/i.test(raw));
    assert.ok(!/\.my\.salesforce\.com|force\.com/.test(raw));
    for (const id of raw.match(/\b00[0-9A-Za-z]{13,16}\b/g) || []) assert.match(id, /^00[0-9A-Z]0{8,}\d*[0-9A-Z]*$/, id);
  });

  await test("errors: the demo logs read as intended (trigger crash, rule, flow, success, cut-off)", () => {
    const d = demo();
    const byId = (n) => d.logs.find((l) => l.id.endsWith(`${n}AAA`));
    const run1 = (n) => analyzeLog(byId(n).body.join("\n"), { userName: byId(n).userName, length: byId(n).length });
    const a1 = run1("000000000001"), a2 = run1("000000000002"), a3 = run1("000000000003"), a4 = run1("000000000004"), a5 = run1("000000000005");
    assert.equal(a1.findings[0].where, "Apex trigger AccountTrigger, line 3");
    assert.equal(a2.findings.length, 1);
    assert.equal(a2.findings[0].rule, "Close_Date_Required");
    assert.equal(a3.findings[0].flow, "Case_Escalation_Flow");
    assert.equal(a3.findings[0].element, "Update_Related_Cases");
    assert.equal(a4.headline, "No errors found in this log");
    assert.equal(a5.cutOff, true);
    assert.equal(a5.problemCount, 0);
    assert.equal(a5.handledCount, 1);
    for (const a of [a1, a2, a3, a4, a5]) assert.equal(a.version, "62.0");
  });

  await test("errors: the tool is registered after Page details, with the exact feedback label in the code and in both issue forms", () => {
    const last = TOOLS.find((t) => t.id === "error-tracer");
    assert.equal(TOOLS[TOOLS.findIndex((t) => t.id === "page-details") + 1], last);
    assert.equal(last.page, "tools/error-tracer/error-tracer.html");
    assert.equal(last.title, "Error Tracer: read a debug log");
    assert.match(last.description, /what failed, where and for which user/i);
    assert.equal(FEEDBACK_TOOLS.errors, "Error Tracer: read a debug log (extension)");
    for (const f of ["bug.yml", "enhancement.yml"]) {
      const y = read(path.join(here, "../..", ".github/ISSUE_TEMPLATE", f)).replace(/\r\n/g, "\n");
      const i = y.indexOf("- Page details for a ticket (extension)\n");
      assert.ok(i > 0, f);
      assert.ok(y.slice(i).startsWith("- Page details for a ticket (extension)\n        - Error Tracer: read a debug log (extension)\n"), `${f}: the new option comes right after Page details`);
    }
    const js = read(ext("tools/error-tracer/error-tracer.js"));
    assert.ok(js.includes("FEEDBACK_TOOLS.errors"));
    const html = read(ext("tools/error-tracer/error-tracer.html"));
    assert.ok(html.includes("<title>Error Tracer: read a debug log</title>"));
    assert.ok(html.includes('id="feedback"') && html.includes("../../shared/pack.css"));
    assert.match(JSON.parse(read(ext("manifest.json"))).version, /^\d+\.\d+\.\d+$/);
    assert.match(JSON.parse(read(ext("manifest.json"))).description, /debug logs/);
  });

  await test("errors: the page has the steps, the list controls and says it never turns logging on", () => {
    const html = read(ext("tools/error-tracer/error-tracer.html"));
    for (const s of ["Before you start: turn on a debug log", "Debug Logs", "User Trace Flags", "Workflow", "Refresh the list", "limited time", "never turns logging on"]) assert.ok(html.includes(s), s);
    const js = read(ext("tools/error-tracer/error-tracer.js"));
    for (const s of ["Copy what failed", "Technical details", "Log lines", "samples/error_tracer_demo.json"]) assert.ok(js.includes(s), s);
    assert.ok(!/tools\/flow-usage/.test(js + html + read(ext("tools/error-tracer/error-tracer-logic.js"))), "no link to another tool");
  });

  await test("errors: empty or non-log text is not called 'no errors'", () => {
    for (const x of ["", null, "hello\nworld"]) {
      const a = analyzeLog(x);
      assert.equal(a.headline, "This does not look like a debug log");
      assert.ok(!/no errors/i.test(a.headline) || /not a result/.test(a.subline));
      assert.equal(a.problemCount, 0);
      assert.equal(a.notLog, true);
      assert.match(a.subline, /empty or is not debug log text/);
    }
    assert.equal(analyzeLog(mk(TRIGGER_START)).notLog, false);
  });

  await test("errors: cards use one clock (time into the log), not the log's own clock", () => {
    const a = analyzeLog(mk(USER, "20:02:59.35 (400000000)|FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object"));
    const f = a.findings[0];
    assert.equal(elapsedWords(f.elapsedMs), "0.4 seconds after the log started");
    const txt = summaryText(a, {});
    assert.match(txt, /When: 0\.4 seconds after the log started/);
    assert.ok(!txt.includes("20:02:59"), "the raw clock stays out of the copied text");
    const js = read(ext("tools/error-tracer/error-tracer.js"));
    assert.ok(!/\$\{f\.time\}/.test(js), "the card does not print the raw clock");
    const d = demo();
    for (const l of d.logs) {
      const m = /USER_INFO\|.*\|GMT([+-]\d\d):(\d\d)\s*$/m.exec(l.body.join("\n"));
      const clock = /^(\d\d):(\d\d):(\d\d)/.exec(l.body[1]);
      const utc = /T(\d\d):(\d\d):(\d\d)/.exec(l.startTime);
      const off = Number(m[1]) + Math.sign(Number(m[1]) || 1) * Number(m[2]) / 60;
      const mins = (h, mi) => Number(h) * 60 + Number(mi);
      assert.equal((mins(utc[1], utc[2]) + off * 60 + 1440) % 1440, mins(clock[1], clock[2]), `${l.id}: log clock matches StartTime and time zone`);
    }
  });

  await test("errors: a flow code unit that names only the object is not called a flow with that name", () => {
    const err = t(30, "FLOW_ELEMENT_ERROR|Something failed|FlowRecordUpdate|Update_Cases");
    const only = analyzeLog(mk(t(10, "CODE_UNIT_STARTED|[EXTERNAL]|Flow:Case"), err));
    assert.deepEqual(only.findings[0].steps, ["a flow on Case records"]);
    const named = analyzeLog(mk(t(10, "CODE_UNIT_STARTED|[EXTERNAL]|Flow:Case"),
      t(20, "FLOW_START_INTERVIEW_BEGIN|a1b2|Case_Escalation_Flow"), err));
    assert.deepEqual(named.findings[0].steps, ["flow Case_Escalation_Flow"]);
    assert.ok(!JSON.stringify([only, named].map((x) => x.findings[0].steps)).includes("flow Case\""));
  });

  await test("errors: the page never hands null to a native append or replaceChildren, and the page text has the new wording", () => {
    const js = read(ext("tools/error-tracer/error-tracer.js"));
    assert.ok(!/(replaceChildren|append|prepend)\([^;]*:\s*null/.test(js), "no ': null' inside a native call");
    assert.ok(js.includes("filter((x) => x)"));
    const html = read(ext("tools/error-tracer/error-tracer.html"));
    for (const s of ["Start Date", "Expiration Date", "search icon", "New Debug Level", "Traced Entity Type", "Traced Entity Name", "the person who will do the failing action",
      "Apex Code, Database, Validation and Workflow each to Info or finer", "Developer Console or the command line", "up to 24 hours", "Hide logs whose result is Success"]) assert.ok(html.includes(s), s);
    assert.ok(!html.includes("untick the box") && !html.includes("not the name Setup fills in"));
  });

  await test("final fixes: times name their zone, in the list, the card facts and the copied text", () => {
    const w = whenText("2026-11-21T04:02:59.000Z", "America/New_York");
    assert.match(w, /11:02:59 PM/);
    assert.match(w, /\(your time, America\/New_York\)$/);
    assert.match(whenText("2026-11-21T04:02:59.000Z"), /\(your time(, [\w/+-]+)?\)$/);
    assert.equal(whenText("not a date"), "not a date");
    const js = read(ext("tools/error-tracer/error-tracer.js"));
    assert.ok(js.includes("fact(\"User's time zone\"") && !js.includes('fact("Time zone"'));
    assert.ok(js.includes("whenText(r.startTime)") && js.includes("startTimeText: whenText(row.startTime)"));
    const a = analyzeLog(mk(USER, t(30, "FATAL_ERROR|System.MathException: Divide by 0")));
    const txt = summaryText(a, { startTime: "2026-11-21T04:02:59.000Z", startTimeText: w });
    assert.match(txt, /When: .*\(your time, America\/New_York\)/);
    assert.match(txt, /User's time zone: \(GMT-08:00\) Pacific Standard Time/);
  });

  await test("final fixes: validation seen in the log is not called \"not recorded\"", () => {
    const low = HEADER.replace("VALIDATION,INFO", "VALIDATION,NONE");
    const a = analyzeLog([low,
      t(5, "CODE_UNIT_STARTED|[EXTERNAL]|Validation:SFTL_Widget:new"),
      t(6, "CODE_UNIT_FINISHED|Validation:SFTL_Widget:new")].join("\n"));
    const v = a.coverage.find((c) => c.key === "VALIDATION");
    assert.equal(v.ok, false);
    assert.equal(v.partial, true);
    assert.ok(!/Not recorded:[^.]*Validation rules/.test(a.subline), a.subline);
    assert.match(a.subline, /Recorded only in part: Validation rules/);
    assert.ok(a.notes.some((n) => /categories named above \(Validation\) to Info or finer/.test(n)), a.notes.join(" | "));
    assert.ok(!a.notes.some((n) => /not recorded|only in part|though this log/.test(n)));
    // nothing of it in the log: still "not recorded"
    const none = analyzeLog([low, TRIGGER_START].join("\n"));
    assert.equal(none.coverage.find((c) => c.key === "VALIDATION").partial, false);
    assert.match(none.subline, /Not recorded: Validation rules/);
    // with a problem found, the same words
    const bad = analyzeLog([low, t(5, "CODE_UNIT_STARTED|[EXTERNAL]|Validation:SFTL_Widget:new"), t(9, "FATAL_ERROR|System.MathException: x")].join("\n"));
    assert.ok(!/Not recorded well enough[^.]*Validation rules/.test(bad.subline), bad.subline);
    assert.match(bad.subline, /Recorded only in part: Validation rules/);
  });

  await test("final fixes: command-line log names the record type from the finished Validation code unit", () => {
    const msg = "System.DmlException: Insert failed. First exception on row 0; first error: FIELD_CUSTOM_VALIDATION_EXCEPTION, Shipped widgets need a paint color.: [SFTL_Color__c]";
    const body = (unit) => [
      t(5, `CODE_UNIT_STARTED|[EXTERNAL]|${unit}`),
      t(6, `CODE_UNIT_FINISHED|${unit}`),
      t(7, `EXCEPTION_THROWN|[1]|${msg}`),
      t(8, `FATAL_ERROR|${msg}`)];
    const shapes = {
      "no levels line": body("Validation:SFTL_Widget:new").join("\n"),
      "full levels": mk(...body("Validation:SFTL_Widget:new")),
      "VALIDATION,INFO;DB,NONE": ["62.0 VALIDATION,INFO;DB,NONE", ...body("Validation:SFTL_Widget:new")].join("\n"),
    };
    for (const [name, log] of Object.entries(shapes)) {
      const a = analyzeLog(log);
      assert.equal(a.findings.length, 1, name);
      assert.match(a.findings[0].message, /Shipped widgets need a paint color/, name);
      assert.match(a.findings[0].message, /Saving a SFTL_Widget record failed/, name);
      assert.ok(!a.notes.some((n) => /kind of record being saved may be missing/.test(n)), `${name}: ${a.notes}`);
    }
    // namespace and __c object names
    const ns = analyzeLog(["62.0 VALIDATION,INFO", ...body("Validation:ns__Thing__c:a0B000000000001AAA")].join("\n"));
    assert.match(ns.findings[0].message, /Saving a ns__Thing__c record failed/);
    // no unit and no DML_BEGIN: wording unchanged
    const none = analyzeLog(["62.0 VALIDATION,INFO", t(7, `EXCEPTION_THROWN|[1]|${msg}`), t(8, `FATAL_ERROR|${msg}`)].join("\n"));
    assert.ok(!/ of an? \w+ record/.test(none.findings[0].message), none.findings[0].message);
  });

  await test("final fixes: notes say each thing once", () => {
    const a = analyzeLog(["62.0 APEX_CODE,FINEST;DB,NONE;WORKFLOW,INFO", t(9, "FATAL_ERROR|System.MathException: x")].join("\n"));
    for (const n of a.notes) {
      const sentences = n.split(/(?<=\.)\s+/).map((x) => x.toLowerCase());
      assert.equal(new Set(sentences).size, sentences.length, n);
      assert.ok(!/not recorded\.[^.]*were not recorded/i.test(n), n);
    }
    const v = analyzeLog(["62.0 APEX_CODE,FINEST;VALIDATION,NONE", t(9, "FATAL_ERROR|System.MathException: x")].join("\n"));
    const note = v.notes.find((n) => /debug level in Setup/.test(n));
    assert.ok(note && !/were not recorded/.test(note), String(note));
  });

  await test("wording: coverage and cut-off warnings are said once (headline line), never again in Notes", () => {
    const logs = [
      ["62.0 APEX_CODE,FINEST;DB,NONE;VALIDATION,NONE;WORKFLOW,NONE", t(5, "CODE_UNIT_STARTED|[EXTERNAL]|Validation:SFTL_Widget:new"), t(6, "CODE_UNIT_FINISHED|Validation:SFTL_Widget:new"), t(9, "FATAL_ERROR|System.MathException: x"), "*********** MAXIMUM DEBUG LOG SIZE REACHED ***********"].join("\n"),
      ["62.0 APEX_CODE,FINEST;DB,NONE;VALIDATION,NONE;WORKFLOW,NONE", t(5, "CODE_UNIT_STARTED|[EXTERNAL]|Validation:SFTL_Widget:new"), "*********** MAXIMUM DEBUG LOG SIZE REACHED ***********"].join("\n"),
    ];
    for (const log of logs) {
      const a = analyzeLog(log);
      assert.match(a.subline, /cut off/);
      assert.ok(a.notes.length > 0);
      // exactly one coverage note, and no per-area "X: the log level for it ..." notes
      assert.equal(a.notes.filter((n) => /debug level in Setup/.test(n)).length, 1, a.notes.join(" | "));
      assert.ok(!a.notes.some((n) => /^(Apex Code|Database|Validation|Workflow):|log level for it/.test(n)), a.notes.join(" | "));
      for (const n of a.notes) {
        for (const c of a.coverage) assert.ok(!n.includes(c.label), `${c.label} repeated in: ${n}`);
        assert.ok(!/cut off|recorded/i.test(n), `repeated in: ${n}`);
      }
    }
  });

  await test("wording: no full stop after a closing quote when the quoted message already ends in one", () => {
    const withEnd = analyzeLog(mk(t(5, "FATAL_ERROR|System.CalloutException: The user was not assigned.")));
    const m1 = withEnd.findings[0].message;
    assert.ok(/not assigned\.”$/.test(m1), m1);
    assert.ok(!/”\./.test(m1), m1);
    const without = analyzeLog(mk(t(5, "FATAL_ERROR|System.CalloutException: The user was not assigned")));
    assert.ok(/not assigned”\.$/.test(without.findings[0].message), without.findings[0].message);
    let seen = 0;
    for (const l of demo().logs) {
      for (const f of analyzeLog(Array.isArray(l.body) ? l.body.join("\n") : l.body).findings) { seen++; assert.ok(!/[.!?]”\./.test(f.message), f.message); }
    }
    assert.ok(seen >= 4, "demo findings were read");
  });

  await test("wording: handled-error note is right for one and for many; one label for handled cards", () => {
    const one = (n) => analyzeLog(["62.0 APEX_CODE,FINEST", ...Array.from({ length: n }, (_, i) => t(5 + i, `EXCEPTION_THROWN|[${i + 1}]|System.MathException: Divide by 0 ${i}`))].join("\n"));
    const a = one(1), b = one(2);
    assert.ok(a.notes.includes("1 error was raised but may have been handled by the code. It is listed after the problems and is usually not the cause."), a.notes.join("|"));
    assert.ok(b.notes.some((n) => /^2 errors were raised but may have been handled by the code\. They are listed /.test(n)), b.notes.join("|"));
    const js = readFileSync(new URL("../tools/error-tracer/error-tracer.js", import.meta.url), "utf8");
    assert.ok(!/possibly handled|MAY HAVE BEEN|\(it may have been handled\)/.test(js));
    for (const f of [...a.findings, ...b.findings]) assert.ok(!/handled/.test(f.title), f.title);
  });

  await test("wording: the clock note has no doubled brackets", () => {
    const a = analyzeLog(["62.0 APEX_CODE,FINEST", t(1, "USER_INFO|[EXTERNAL]|005000000000001|a@b.test|(GMT-08:00) Pacific Standard Time|GMT-08:00"), t(9, "FATAL_ERROR|System.MathException: x")].join("\n"));
    const n = a.notes.find((x) => /clock/.test(x));
    assert.ok(n, a.notes.join("|"));
    assert.ok(!/\(\(/.test(n) && !/\)\)/.test(n), n);
    assert.match(n, /Pacific Standard Time/);
  });

  await test("wording: a validation object comes from an earlier unit only when nothing ran in between", () => {
    const msg = "System.DmlException: Insert failed. First exception on row 0; first error: FIELD_CUSTOM_VALIDATION_EXCEPTION, Stop.: []";
    const real = analyzeLog(["62.0 VALIDATION,INFO", t(5, "CODE_UNIT_STARTED|[EXTERNAL]|Validation:SFTL_Widget:new"), t(6, "CODE_UNIT_FINISHED|Validation:SFTL_Widget:new"), t(7, `EXCEPTION_THROWN|[1]|${msg}`), t(8, `FATAL_ERROR|${msg}`)].join("\n"));
    assert.match(real.findings[0].message, /SFTL_Widget/);
    for (const between of [t(6, "CODE_UNIT_STARTED|[EXTERNAL]|01p000000000001|Other.run()"), t(6, "DML_BEGIN|[2]|Op:Insert|Type:Contact|Rows:1")]) {
      const wrong = analyzeLog(["62.0 VALIDATION,INFO", t(4, "CODE_UNIT_STARTED|[EXTERNAL]|Validation:Account:new"), t(5, "CODE_UNIT_FINISHED|Validation:Account:new"), between, t(7, `EXCEPTION_THROWN|[1]|${msg}`), t(8, `FATAL_ERROR|${msg}`)].join("\n"));
      assert.ok(!/Account/.test(wrong.findings[0].message), wrong.findings[0].message);
      assert.ok(!wrong.findings[0].object || wrong.findings[0].object === "Contact", String(wrong.findings[0].object));
    }
  });

  await test("final fixes: a validation card says which kind of record was being saved", () => {
    const a = analyzeLog(mk(
      t(5, "DML_BEGIN|[3]|Op:Insert|Type:SFTL_Widget|Rows:1"),
      t(6, "VALIDATION_RULE|03d000000000001AAA|Name_Required"),
      t(7, "VALIDATION_FAIL")));
    assert.equal(a.findings[0].object, "SFTL_Widget", "from the save when no validation code unit is open");
    assert.match(a.findings[0].message, /refused the save of a SFTL_Widget record/);
    const b = analyzeLog(mk(
      t(5, "CODE_UNIT_STARTED|[EXTERNAL]|Validation:SFTL_Widget:new"),
      t(6, "VALIDATION_RULE|03d000000000001AAA|Name_Required"),
      t(7, "VALIDATION_FAIL"), t(8, "CODE_UNIT_FINISHED|Validation:SFTL_Widget:new")));
    assert.match(b.findings[0].message, /refused the save of a SFTL_Widget record/);
    assert.equal(b.findings[0].recordId, null, "\"new\" is not a record Id");
    const msg = "System.DmlException: Insert failed. First exception on row 0; first error: FIELD_CUSTOM_VALIDATION_EXCEPTION, Name needed: [Name]";
    const c = analyzeLog(mk(t(5, "DML_BEGIN|[3]|Op:Insert|Type:Contact|Rows:1"), t(6, `FATAL_ERROR|${msg}`), "", "Class.X.run: line 1, column 1"));
    assert.match(c.findings[0].message, /Saving a Contact \(insert\) failed\. A validation rule stopped the save/);
  });

  await test("final fixes: a step error and the interview error of one flow are one card, in either order", () => {
    const iv = "a1b2c3d4-0000-4000-8000-000000000009";
    const step = t(4, "FLOW_ELEMENT_ERROR|Field x was never set.|FlowRecordUpdate|Update_Cases");
    const intv = t(5, `FLOW_START_INTERVIEWS_ERROR|An unhandled fault has occurred in this flow|${iv}`);
    for (const lines of [[step, intv], [intv, step],
      [t(1, "FLOW_START_INTERVIEW_BEGIN|00D000000000001AAA|Case_Flow"), step, t(4, "FLOW_START_INTERVIEW_END|" + iv + "|Case_Flow"), intv]]) {
      const a = analyzeLog(mk(...lines));
      assert.equal(a.findings.length, 1, JSON.stringify(a.findings.map((f) => f.title)));
      assert.equal(a.findings[0].element, "Update_Cases");
      assert.match(a.findings[0].message, /Update_Cases/);
      assert.match(a.findings[0].message, /Field x was never set/);
      assert.equal(a.findings[0].handled, false);
    }
    // two different steps failing stay two cards
    const two = analyzeLog(mk(step, t(6, "FLOW_ELEMENT_ERROR|Other trouble|FlowRecordCreate|Make_Task")));
    assert.equal(two.findings.length, 2);
  });

  await test("final fixes: zero elapsed time says the start of the log", () => {
    assert.equal(elapsedWords(0), "At the start of the log");
    assert.equal(elapsedWords(0.4), "At the start of the log");
    assert.equal(elapsedWords(1), "1 ms after the log started");
  });

  await test("final fixes: on a narrow screen the log list stacks, and Result comes right after When", () => {
    const css = read(ext("tools/error-tracer/error-tracer.css"));
    assert.match(css, /@media \(max-width: 640px\)[\s\S]*#logTable td \{ display: block/);
    assert.ok(css.includes("attr(data-label)"));
    const html = read(ext("tools/error-tracer/error-tracer.html"));
    assert.match(html, /<th>When \(your time\)<\/th><th>Result<\/th><th>Whose log<\/th>/);
    const js = read(ext("tools/error-tracer/error-tracer.js"));
    assert.ok(js.indexOf('"data-label": "Result"') < js.indexOf('"data-label": "Whose log"'));
  });
}
