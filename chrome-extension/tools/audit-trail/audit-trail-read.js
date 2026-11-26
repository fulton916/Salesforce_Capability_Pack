// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Search the Setup Audit Trail: the org reads. Read-only: one SELECT COUNT() and then SELECT pages on SetupAuditTrail,
// followed with nextRecordsUrl by this file's own pager (so entries can show as they arrive and the person can stop).
// Only CreatedDate, CreatedById, Action, DelegateUser and ResponsibleNamespacePrefix may be in a WHERE; Section and
// Display may not (Salesforce refuses), so words are searched in memory by the page, never in the query.
import { soqlString } from "../../shared/sfconn.js";
import { isUserId, soqlDate, entryFromRecord, READ_STEP, MAX_HELD } from "./audit-trail-logic.js";

export const MAX_ENTRIES = READ_STEP; // the most one read keeps (the newest); "Read older entries" adds the next ones
export { MAX_HELD }; // the most the page holds in memory, all reads together

const FIELDS = "Id, Action, Section, Display, CreatedDate, CreatedById, CreatedBy.Name, CreatedBy.Username, DelegateUser, ResponsibleNamespacePrefix";

/** The WHERE text (or "") for a period's bounds ({from, to} as Dates or null), one person's Id (or empty) and, with it,
 * that person's username as `delegateUser` (or empty): entries they made, or entries where they are the delegate user
 * (for example an administrator using Login-As). Both values go through soqlString; the Id only after the shape check.
 * `olderOrEqualMs` (a continuation, "Read older entries"): the same WHERE plus `CreatedDate <= <that second>` (UTC literal),
 * so the second the last read ended in is read again and the caller drops the entries it already holds. */
export function buildWhere({ from, to, userId, delegateUser, olderOrEqualMs } = {}) {
  const parts = [];
  if (from) parts.push(`CreatedDate >= ${soqlDate(from)}`);
  if (to) parts.push(`CreatedDate < ${soqlDate(to)}`);
  if (olderOrEqualMs !== undefined && olderOrEqualMs !== null) {
    if (!Number.isFinite(olderOrEqualMs)) throw new Error("That is not a moment in time.");
    parts.push(`CreatedDate <= ${soqlDate(new Date(Math.floor(olderOrEqualMs / 1000) * 1000))}`);
  }
  if (userId) {
    if (!isUserId(userId)) throw new Error("That is not a user Id.");
    parts.push(delegateUser ? `(CreatedById = ${soqlString(userId)} OR DelegateUser = ${soqlString(delegateUser)})` : `CreatedById = ${soqlString(userId)}`);
  } else if (delegateUser) {
    parts.push(`DelegateUser = ${soqlString(delegateUser)}`);
  }
  return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
}

export const buildQuery = (q) => `SELECT ${FIELDS} FROM SetupAuditTrail${buildWhere(q)} ORDER BY CreatedDate DESC, Id DESC`;
export const buildCountQuery = (q) => `SELECT COUNT() FROM SetupAuditTrail${buildWhere(q)}`;

/** A failed read in plain words, with the raw Salesforce text kept for "Technical details": {message, raw}. */
export function plainProblem(e) {
  const raw = String(e?.detail || e?.message || e || "");
  const status = e?.status;
  const code = String(e?.errorCode || "");
  if (status === 401) return { message: e.message, raw };
  if (status === 403 || /INSUFFICIENT_ACCESS|NO_ACCESS/i.test(code)) {
    return { message: "Salesforce did not let you read the Setup Audit Trail. You need the permission \"View Setup and Configuration\". Ask your Salesforce administrator.", raw };
  }
  if (status === 404 || (status === 400 && /INVALID_TYPE|sObject type|not supported|INVALID_FIELD|No such column/i.test(`${code} ${raw}`))) {
    return { message: "This org does not offer the Setup Audit Trail to this page (the object is not available). It needs the permission \"View Setup and Configuration\".", raw };
  }
  if (status === undefined && (e instanceof TypeError || /fetch|network|Failed to fetch/i.test(raw))) {
    return { message: "The connection to Salesforce was lost. Check your network, then try again.", raw };
  }
  return { message: "Could not read the Setup Audit Trail. Try again; if it keeps happening, open Technical details and share them.", raw };
}

/**
 * The words for a failed person search in the top panel (the user search, not the audit trail read). A 401 and a lost
 * connection keep the wording of `plainProblem`; every other failure says the user search failed.
 */
export function plainUserSearchProblem(e) {
  const p = plainProblem(e);
  const raw = String(e?.detail || e?.message || e || "");
  const status = e?.status;
  if (status === 401 || (status === undefined && (e instanceof TypeError || /fetch|network|Failed to fetch/i.test(raw)))) return p;
  const denied = status === 403 || /INSUFFICIENT_ACCESS|NO_ACCESS/i.test(String(e?.errorCode || ""));
  return {
    message: `Could not search for users.${denied ? " Salesforce did not let you read the list of users." : ""} Try again; if it keeps happening, open Technical details and share them. Entries already on the page are not affected.`,
    raw,
  };
}

/**
 * Read the audit trail newest first. `query` is {from, to, userId, delegateUser} and, for a continuation, `olderOrEqualMs`.
 * `control` is {stop, cancel}: set `stop` to keep what was read and stop; set `cancel` (a newer read started) and nothing
 * more is delivered. Callbacks: `onTotal(total|null)`, `onPage(entries, readSoFar)`. Never throws for a failed read: returns
 * `{status, read, total, problem?}` with status "complete", "capped", "stopped", "failed" (part way or at the start),
 * "short" (fewer than counted) or "cancelled". Rows already delivered are kept whatever the status.
 *
 * A continuation ("Read older entries") passes `continuation: {total, held, skipIds, seqStart}`: the period's total from the
 * first read (no new COUNT), how many entries the page already holds, the Ids it holds from the boundary second (dropped here,
 * so that second is neither lost nor doubled) and the `seq` to continue from. `read` then counts only the NEW entries
 * delivered; `max` is how many new ones this read may deliver.
 */
export async function readAuditTrail(api, query, { control = {}, onTotal, onPage, max = MAX_ENTRIES, continuation = null } = {}) {
  const base = `/services/data/v${api.apiVersion}/query/?q=`;
  const result = { status: "complete", read: 0, total: null };
  if (control.cancel) return { ...result, status: "cancelled" };
  const soql = buildQuery(query); // throws for a bad Id before anything is sent
  if (continuation) {
    result.total = Number.isFinite(continuation.total) ? continuation.total : null;
  } else {
    const countSoql = buildCountQuery(query);
    try {
      const c = await api.get(base + encodeURIComponent(countSoql));
      result.total = Number.isFinite(c?.totalSize) ? c.totalSize : null;
    } catch {
      result.total = null; // reading may still work: show without a total
    }
  }
  if (control.cancel) return { ...result, status: "cancelled" };
  onTotal?.(result.total);
  const skip = continuation?.skipIds || null;
  const held = continuation?.held || 0;
  let url = base + encodeURIComponent(soql);
  let seq = continuation?.seqStart || 0;
  while (url) {
    if (control.stop) { result.status = "stopped"; return result; }
    let page;
    try {
      page = await api.get(url);
    } catch (e) {
      if (control.cancel) return { ...result, status: "cancelled" };
      result.status = "failed";
      result.problem = plainProblem(e);
      return result;
    }
    if (control.cancel) return { ...result, status: "cancelled" };
    const records = page?.records || [];
    const batch = [];
    let i = 0;
    for (; i < records.length && result.read + batch.length < max; i++) {
      const r = records[i];
      if (skip && r.Id && skip.has(r.Id)) continue; // already held: not read twice
      batch.push(entryFromRecord(r, seq++));
    }
    result.read += batch.length;
    if (batch.length) onPage?.(batch, result.read);
    const more = !page?.done && !!page?.nextRecordsUrl;
    if (i < records.length || (result.read >= max && more)) { result.status = "capped"; return result; }
    url = more ? page.nextRecordsUrl : null;
  }
  if (Number.isFinite(result.total) && held + result.read < result.total) result.status = "short";
  return result;
}
