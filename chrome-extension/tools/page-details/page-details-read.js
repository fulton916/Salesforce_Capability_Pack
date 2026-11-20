// The org reads behind "Page details for a ticket". GET / SELECT / describe only.
// Every area fails softly: it returns {data: null, problem: "plain words", raw: "..."} instead of throwing.

import { soqlString } from "../../shared/sfconn.js";
import { parsePageUrl, looksLikeId, sandboxNameFromHost, localeLabel, setupPageName } from "./page-details-logic.js";

const plainReason = (e, fallback) => (e?.status === 401 ? e.message : fallback);
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

/** Plain words for why the Organization read failed, by cause. */
export function orgProblem(e) {
  if (e?.status === 401) return e.message;
  const text = `${e?.errorCode || ""} ${e?.message || ""}`;
  const status = e?.status;
  if (status === 403 || /INSUFFICIENT_ACCESS|INVALID_TYPE|FORBIDDEN|not supported|insufficient access|permission|not allowed/i.test(text)) {
    return "Your user may not be allowed to read the organization record.";
  }
  if (status === 0 || status === 502 || status === 503 || status === 504 || e?.name === "TypeError" ||
      /INVALID_SESSION_ID|failed to fetch|network|timed? ?out|ECONN|ENOTFOUND|session|connection/i.test(text)) {
    return "Salesforce could not be reached to read the org details. Check your connection, reload the Salesforce tab and try again.";
  }
  return "The organization record could not be read.";
}

/** Id of the current user. Tries the Chatter "me" resource, then the OAuth userinfo address; both are GET only. */
async function currentUserId(api) {
  const tries = [];
  try {
    const me = await api.get(`/services/data/v${api.apiVersion}/chatter/users/me`);
    if (me?.id) return { id: me.id, chatter: me };
    tries.push("chatter/users/me returned no id");
  } catch (e) { tries.push(`chatter/users/me: ${rawOf(e)}`); }
  try {
    const info = await api.get("/services/oauth2/userinfo");
    if (info?.user_id) return { id: info.user_id, chatter: null };
    tries.push("userinfo returned no user_id");
  } catch (e) { tries.push(`userinfo: ${rawOf(e)}`); }
  throw Object.assign(new Error(tries.join("; ")), { tries });
}

/** The person's own user details. Falls back to what the Chatter resource said when the User query is refused. */
export async function readCurrentUser(api) {
  let who;
  try {
    who = await currentUserId(api);
  } catch (e) {
    return { data: null, problem: "Salesforce would not say who you are from this page.", raw: rawOf(e) };
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
    if (!c) return { data: null, problem: "Your user details could not be read.", raw: rawOf(e) };
    return {
      data: { id: who.id, name: c.name, username: c.username, profile: null, role: null, language: c.language || null, locale: c.locale || null, timeZone: c.timeZone || null, userType: c.userType || null },
      problem: "Only part of your user details could be read (profile and role are missing).",
      raw: rawOf(e),
    };
  }
}

const formatDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
};

/** What the address says, plus (for records) one SELECT. Always returns the address facts; `problem` explains what is missing. */
export async function readPageDetails(api, url) {
  const p = parsePageUrl(url);
  const page = {
    kind: p.kind, url: p.path || null, objectApi: p.objectApi, objectLabel: null, recordId: p.recordId, recordName: null, recordType: null,
    owner: null, modifiedBy: null, modifiedAt: null, setupPage: setupPageName(p.setupPage), filterName: p.filterName, listView: null,
    hashAddress: p.hashAddress === true,
  };
  const raws = [];
  let problem = null;

  // A classic /<Id> address has no object: find it by the first three characters of the Id.
  if (page.kind === "record" && !page.objectApi && page.recordId) {
    try {
      const g = await api.describeGlobal();
      page.objectApi = (g.sobjects || []).find((s) => s.keyPrefix === page.recordId.slice(0, 3))?.name || null;
    } catch (e) { raws.push(`Object lookup: ${rawOf(e)}`); }
    if (!page.objectApi) problem = "The kind of record could not be worked out from the address.";
  }

  let describe = null;
  if (page.objectApi) {
    try {
      describe = await api.describe(page.objectApi);
      page.objectLabel = describe.label || null;
      page.objectApi = describe.name || page.objectApi;
    } catch (e) {
      raws.push(`Object ${page.objectApi}: ${rawOf(e)}`);
      if (page.kind === "record") problem = plainReason(e, "This kind of record could not be read. Your user may not be allowed to see it.");
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
        problem = plainReason(e, "The record could not be read. Your user may not be allowed to see it, or it may have been deleted.");
      }
    }
  }
  return { data: page, problem, raw: raws.join("\n") };
}

/** Everything the page shows, each area read on its own. Never throws. */
export async function readIssueSnapshot(api, { host, url }) {
  const [org, user, page] = await Promise.all([readOrgDetails(api, host), readCurrentUser(api), readPageDetails(api, url)]);
  return { org, user, page };
}
