// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// The org reads behind "Page details for a ticket". GET / SELECT / describe only.
// Every area fails softly: it returns {data: null, problem: "plain words", raw: "..."} instead of throwing.

import { soqlString } from "../../shared/sfconn.js";
import { parsePageUrl, looksLikeId, sandboxNameFromHost, localeLabel, setupDisplayName } from "./page-details-logic.js";

const RECONNECT = "Check your connection, reload the Salesforce tab and try again.";
const rawOf = (e) => (e?.status === 401 ? "" : e?.message || String(e || ""));

/** Org name, Id, production or sandbox, instance. `host` is the My Domain host the person was on. */
export async function readOrgDetails(api, host) {
  try {
    const { records } = await api.query("SELECT Id, Name, IsSandbox, InstanceName, OrganizationType FROM Organization");
    const o = records[0];
    if (!o) throw new Error("No Organization row returned");
    return {
      data: {
        name: o.Name, id: o.Id, kind: o.IsSandbox === true ? "Sandbox" : "Production",
        edition: o.OrganizationType, sandboxName: sandboxNameFromHost(host), instance: o.InstanceName, host: host || null,
      },
    };
  } catch (e) {
    return { data: null, problem: orgProblem(e), raw: rawOf(e) };
  }
}

export const REQUEST_LIMIT_TEXT = "Salesforce turned this request away because the org has used up its daily API request limit. This is not a missing permission. Try again later, or ask your Salesforce admin to check API usage.";
/** True when Salesforce refused because the org's daily API request limit is used up (it answers 403 for this). */
export function isRequestLimit(e) {
  return /REQUEST_LIMIT_EXCEEDED/i.test(`${e?.errorCode || ""} ${e?.message || ""} ${e?.detail || ""}`);
}

/** Why a read failed: "limit" (daily API limit), "session" (401), "denied" (permission), "unreachable" (connection, timeout, 502/503/504) or "other". */
export function failureCause(e) {
  if (e?.status === 401) return "session";
  const text = `${e?.errorCode || ""} ${e?.message || ""}`;
  const status = e?.status;
  if (isRequestLimit(e)) return "limit";
  if (status === 403 || /INSUFFICIENT_ACCESS|INVALID_TYPE|FORBIDDEN|not supported|insufficient access|permission|not allowed/i.test(text)) return "denied";
  if (status === 0 || status === 502 || status === 503 || status === 504 || e?.name === "TypeError" ||
      /INVALID_SESSION_ID|failed to fetch|network|timed? ?out|ECONN|ENOTFOUND|session|connection/i.test(text)) return "unreachable";
  return "other";
}

/** Plain words for a failure by cause. `what` is what could not be reached ("the org details"). */
function causeProblem(e, { denied, other, what }) {
  switch (failureCause(e)) {
    case "session": return e.message;
    case "limit": return REQUEST_LIMIT_TEXT;
    case "unreachable": return `Salesforce could not be reached to read ${what}. ${RECONNECT}`;
    case "denied": return denied;
    default: return other;
  }
}

/** Plain words for why the Organization read failed, by cause. */
export function orgProblem(e) {
  return causeProblem(e, {
    denied: "Your user may not be allowed to read the organization record.",
    other: "The organization record could not be read.", what: "the org details",
  });
}

/** Id of the current user. Tries the Chatter "me" resource, then the OAuth userinfo address; both are GET only. */
async function currentUserId(api) {
  const tries = [], errors = [];
  try {
    const me = await api.get(`/services/data/v${api.apiVersion}/chatter/users/me`);
    if (me?.id) return { id: me.id, chatter: me };
    tries.push("chatter/users/me returned no id");
  } catch (e) { errors.push(e); tries.push(`chatter/users/me: ${rawOf(e)}`); }
  try {
    const info = await api.get("/services/oauth2/userinfo");
    if (info?.user_id) return { id: info.user_id, chatter: null };
    tries.push("userinfo returned no user_id");
  } catch (e) { errors.push(e); tries.push(`userinfo: ${rawOf(e)}`); }
  throw Object.assign(new Error(tries.join("; ")), { tries, errors });
}

/** Words for the who-are-you step, from the causes of both tries: a session problem wins, then a dropped connection. */
function whoProblem(errors) {
  const causes = errors.map(failureCause);
  const session = errors[causes.indexOf("session")];
  if (session) return session.message;
  if (causes.includes("limit")) return REQUEST_LIMIT_TEXT;
  if (causes.includes("unreachable")) return `Salesforce could not be reached to find out who you are. ${RECONNECT}`;
  if (causes.includes("denied")) return "Salesforce would not say who you are from this page.";
  return "Who you are could not be read from this page.";
}

/** The person's own user details. Falls back to what the Chatter resource said when the User query is refused. */
export async function readCurrentUser(api) {
  let who;
  try {
    who = await currentUserId(api);
  } catch (e) {
    return { data: null, problem: whoProblem(e.errors || []), raw: rawOf(e) };
  }
  try {
    const { records } = await api.query(
      `SELECT Id, Name, Username, Profile.Name, UserRole.Name, LanguageLocaleKey, LocaleSidKey, TimeZoneSidKey, UserType FROM User WHERE Id = ${soqlString(who.id)}`
    );
    const u = records[0];
    if (!u) throw new Error("No User row returned");
    return {
      data: {
        id: u.Id, name: u.Name, username: u.Username, profile: u.Profile?.Name || null, role: u.UserRole?.Name || null,
        language: localeLabel(u.LanguageLocaleKey), locale: localeLabel(u.LocaleSidKey), timeZone: u.TimeZoneSidKey, userType: u.UserType,
      },
    };
  } catch (e) {
    const c = who.chatter;
    if (!c) {
      return { data: null, problem: causeProblem(e, { denied: "Your user may not be allowed to read your own user record.", other: "The user record could not be read.", what: "your user details" }), raw: rawOf(e) };
    }
    const part = "Only part of your user details could be read (profile and role are missing).";
    const cause = failureCause(e);
    return {
      data: { id: who.id, name: c.name, username: c.username, profile: null, role: null, language: c.language || null, locale: c.locale || null, timeZone: c.timeZone || null, userType: c.userType || null },
      problem: cause === "session" ? e.message
        : cause === "limit" ? REQUEST_LIMIT_TEXT
        : cause === "unreachable" ? `${part} Salesforce could not be reached for the rest. ${RECONNECT}`
        : cause === "denied" ? `${part} Your user may not be allowed to read the user record.` : part,
      raw: rawOf(e),
    };
  }
}

const formatDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
};

/** What the address says, plus (for records) one SELECT. Always returns the address facts; `problem` explains what is missing. */
export async function readPageDetails(api, url, setupTitle = "") {
  const p = parsePageUrl(url);
  const page = {
    kind: p.kind, url: p.path || null, objectApi: p.objectApi, objectLabel: null, recordId: p.recordId, recordName: null, recordType: null,
    owner: null, modifiedBy: null, modifiedAt: null, setupPage: setupDisplayName(p, setupTitle), filterName: p.filterName, listView: null,
    hashAddress: p.hashAddress === true,
  };
  const raws = [];
  let problem = null;
  const recordWords = (e, denied, other) => causeProblem(e, { denied, other, what: "the record" });

  // A classic /<Id> address has no object: find it by the first three characters of the Id.
  if (page.kind === "record" && !page.objectApi && page.recordId) {
    let lookupError = null;
    try {
      const g = await api.describeGlobal();
      page.objectApi = (g.sobjects || []).find((s) => s.keyPrefix === page.recordId.slice(0, 3))?.name || null;
    } catch (e) { lookupError = e; raws.push(`Object lookup: ${rawOf(e)}`); }
    if (!page.objectApi) {
      const base = "The kind of record could not be worked out from the address.";
      problem = lookupError && failureCause(lookupError) !== "other"
        ? recordWords(lookupError, `${base} Your user may not be allowed to look up object types.`, base) : base;
    }
  }

  let describe = null;
  if (page.objectApi) {
    try {
      describe = await api.describe(page.objectApi);
      page.objectLabel = describe.label || null;
      page.objectApi = describe.name || page.objectApi;
    } catch (e) {
      raws.push(`Object ${page.objectApi}: ${rawOf(e)}`);
      if (page.kind === "record") problem = recordWords(e, "This kind of record could not be read. Your user may not be allowed to see it.", "This kind of record could not be read.");
    }
  }

  if (page.kind === "list" && page.filterName && page.objectApi) {
    try {
      const f = page.filterName;
      const where = /^00B/.test(f) && looksLikeId(f) ? `Id = ${soqlString(f)}` : `DeveloperName = ${soqlString(f)}`;
      const { records } = await api.query(`SELECT Name FROM ListView WHERE SobjectType = ${soqlString(page.objectApi)} AND ${where} LIMIT 1`);
      page.listView = records[0]?.Name || null;
    } catch (e) { raws.push(`List view: ${rawOf(e)}`); }
  }

  if (page.kind === "record" && describe && page.recordId) {
    if (describe.queryable === false) {
      problem = "Salesforce does not let this kind of record be looked up, so only the address details are shown.";
    } else {
      const has = new Set((describe.fields || []).map((f) => f.name));
      const nameField = (describe.fields || []).find((f) => f.nameField)?.name;
      const sel = ["Id"];
      if (nameField) sel.push(nameField);
      if (has.has("RecordTypeId")) sel.push("RecordType.Name");
      if (has.has("OwnerId")) sel.push("Owner.Name");
      if (has.has("LastModifiedById")) sel.push("LastModifiedBy.Name");
      if (has.has("LastModifiedDate")) sel.push("LastModifiedDate");
      try {
        const { records } = await api.query(`SELECT ${sel.join(", ")} FROM ${page.objectApi} WHERE Id = ${soqlString(page.recordId)} LIMIT 1`);
        const r = records[0];
        if (!r) {
          problem = "This record could not be found. It may have been deleted, or your user may not be allowed to see it.";
        } else {
          page.recordName = nameField ? r[nameField] ?? null : null;
          page.recordType = r.RecordType?.Name ?? null;
          page.owner = r.Owner?.Name ?? null;
          page.modifiedBy = r.LastModifiedBy?.Name ?? null;
          page.modifiedAt = r.LastModifiedDate ? formatDate(r.LastModifiedDate) : null;
        }
      } catch (e) {
        raws.push(`Record: ${rawOf(e)}`);
        problem = recordWords(e, "The record could not be read. Your user may not be allowed to see it, or it may have been deleted.", "The record could not be read.");
      }
    }
  }
  return { data: page, problem, raw: raws.join("\n") };
}

/** Everything the page shows, each area read on its own. Never throws. */
export async function readIssueSnapshot(api, { host, url, setupTitle }) {
  const [org, user, page] = await Promise.all([readOrgDetails(api, host), readCurrentUser(api), readPageDetails(api, url, setupTitle)]);
  return { org, user, page };
}
