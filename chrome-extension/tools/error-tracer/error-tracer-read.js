// Error Tracer: the org reads. Read-only: a list of debug logs (one SELECT on ApexLog) and one log's
// text (a GET). Nothing here creates or changes anything in the org; the page only reads logs that
// already exist, and the steps for turning one on are done by the person in Setup.
import { isLogId } from "./error-tracer-logic.js";

export const LIST_LIMIT = 100;

const LIST_SOQL = "SELECT Id, LogUserId, LogUser.Name, Operation, Request, Application, Status, Location, StartTime, DurationMilliseconds, LogLength " +
  `FROM ApexLog ORDER BY StartTime DESC LIMIT ${LIST_LIMIT}`;

/** An error with a plain message for the page and the raw Salesforce text for "Technical details". */
export class ReadProblem extends Error {
  constructor(message, raw) {
    super(message);
    this.raw = raw || "";
  }
}

/** Turn a failed read into a ReadProblem with plain words. `what` is "the list of logs" or "this log". */
export function plainProblem(e, what) {
  const raw = String(e?.detail || e?.message || e || "");
  const status = e?.status;
  if (status === 401) return new ReadProblem(e.message, raw);
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
