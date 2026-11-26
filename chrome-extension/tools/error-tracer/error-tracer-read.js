// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Error Tracer: the org reads. Read-only: a list of debug logs (one SELECT on ApexLog) and one log's
// text (a GET). Nothing here creates or changes anything in the org; the page only reads logs that
// already exist, and the steps for turning one on are done by the person in Setup.
import { isLogId } from "./error-tracer-logic.js";

export const LIST_LIMIT = 100;

/** The line to show under the list when it may be cut at LIST_LIMIT (exactly that many logs came back), else "". */
export function listNote(count) {
  return count >= LIST_LIMIT ? `Showing the newest ${LIST_LIMIT} logs. Older ones are not listed.` : "";
}

const LIST_SOQL = "SELECT Id, LogUserId, LogUser.Name, Operation, Request, Application, Status, Location, StartTime, DurationMilliseconds, LogLength " +
  `FROM ApexLog ORDER BY StartTime DESC LIMIT ${LIST_LIMIT}`;

/** An error with a plain message for the page and the raw Salesforce text for "Technical details". */
export class ReadProblem extends Error {
  constructor(message, raw) {
    super(message);
    this.raw = raw || "";
  }
}

export const REQUEST_LIMIT_TEXT = "Salesforce turned this request away because the org has used up its daily API request limit. This is not a missing permission. Try again later, or ask your Salesforce admin to check API usage.";
/** True when Salesforce refused because the org's daily API request limit is used up (it answers 403 for this). */
export function isRequestLimit(e) {
  return /REQUEST_LIMIT_EXCEEDED/i.test(`${e?.errorCode || ""} ${e?.message || ""} ${e?.detail || ""}`);
}

/** Turn a failed read into a ReadProblem with plain words. `what` is "the list of logs" or "this log". */
export function plainProblem(e, what) {
  const raw = String(e?.detail || e?.message || e || "");
  const status = e?.status;
  if (status === 401) return new ReadProblem(e.message, raw);
  if (isRequestLimit(e)) return new ReadProblem(REQUEST_LIMIT_TEXT, raw);
  if (status === 403 || /INSUFFICIENT_ACCESS|NO_ACCESS/i.test(e?.errorCode || "")) {
    return new ReadProblem(`Salesforce did not let you read ${what}. Seeing logs may need extra permission in this org, and seeing other people's logs may need more. Ask your Salesforce administrator.`, raw);
  }
  if (status === 404) return new ReadProblem(`${what[0].toUpperCase()}${what.slice(1)} was not found. Salesforce keeps debug logs only for a limited time, so it may have been removed. Refresh the list.`, raw);
  if (status === 400 && /INVALID_FIELD|No such column|INVALID_TYPE|sObject type/i.test(raw)) {
    return new ReadProblem(`This org did not accept the request for ${what}. It may not offer debug logs the way this page asks.`, raw);
  }
  return new ReadProblem(`Could not read ${what}. Try again; if it keeps happening, open Technical details and share them.`, raw);
}

/** The newest logs, newest first. Rows: `{id, userId, userName, operation, request, application, status, location, startTime, durationMs, length}`. */
export async function readLogList(api) {
  let records;
  try {
    ({ records } = await api.query(LIST_SOQL));
  } catch (e) {
    throw plainProblem(e, "the list of logs");
  }
  return records.map((r) => ({
    id: r.Id, userId: r.LogUserId, userName: r.LogUser?.Name || "", operation: r.Operation || "", request: r.Request || "",
    application: r.Application || "", status: r.Status || "", location: r.Location || "", startTime: r.StartTime || "",
    durationMs: r.DurationMilliseconds ?? null, length: r.LogLength ?? null,
  }));
}

/** One log's text. The Id is checked before it goes into the address. */
export async function readLogBody(api, id) {
  if (!isLogId(id)) throw new ReadProblem("That is not a debug log Id. Pick a log from the list.", String(id));
  try {
    return await api.getText(`/services/data/v${api.apiVersion}/sobjects/ApexLog/${id}/Body`);
  } catch (e) {
    throw plainProblem(e, "this log");
  }
}
