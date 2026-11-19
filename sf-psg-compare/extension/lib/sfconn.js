// Salesforce connection for extension pages.
//
// Reuses the session the user already has in the browser (the `sid` cookie), the same way
// Salesforce Inspector does. No connected app, no OAuth, no server: requests go straight from
// this page to the org's REST API. The extension's host permissions let it skip CORS.

export const API_VERSION = "62.0";

// Hosts a Salesforce UI or API can be served from.
const SF_HOST = /(^|\.)(salesforce|force|salesforce-setup|cloudforce|visualforce)\.(com|mil)$|(^|\.)sfcrmproducts\.cn$/i;

// Cookie domains to search, in order, for the API-capable session of an org.
const SESSION_DOMAINS = ["salesforce.com", "salesforce-setup.com", "cloudforce.com", "salesforce.mil", "cloudforce.mil", "sfcrmproducts.cn", "force.com"];

export function isSalesforceHost(host) {
  return typeof host === "string" && SF_HOST.test(host);
}

// Lightning, Visualforce and help-site sessions are not valid for the REST API.
function isApiCookieDomain(domain) {
  const d = domain.replace(/^\./, "");
  return d !== "help.salesforce.com" && !/lightning\.force\.com$|\.vf\.force\.com$|visual\.force\.com$|visualforce\.com$/i.test(d);
}

/** Pick the API host and session for the org open on `uiHost`.
 *
 * `cookies` is the chrome.cookies API (passed in so tests can fake it).
 * The `sid` cookie on a Lightning host is not valid for the API, but its value starts with the
 * org Id ("00D...!"). The org's my.salesforce.com cookie carries the same prefix, so we find that.
 */
export async function findSession(uiHost, cookies) {
  if (!isSalesforceHost(uiHost)) throw new Error(`Not a Salesforce host: ${uiHost}`);
  const first = await cookies.get({ url: `https://${uiHost}`, name: "sid" });
  if (!first) {
    throw new Error(`No Salesforce session found for ${uiHost}. Log in to the org in this browser, then try again.`);
  }
  const orgId = first.value.split("!")[0];
  for (const domain of SESSION_DOMAINS) {
    const all = await cookies.getAll({ name: "sid", domain, secure: true });
    const hit = all.find((c) => c.value.startsWith(orgId + "!") && isApiCookieDomain(c.domain));
    if (hit) return { apiHost: hit.domain.replace(/^\./, ""), sessionId: hit.value, orgId };
  }
  // Classic or non-enhanced-domain orgs: the UI host is the API host.
  return { apiHost: uiHost, sessionId: first.value, orgId };
}

export class SalesforceError extends Error {
  constructor(message, { status, errorCode, url } = {}) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
    this.url = url;
  }
}

/** Minimal REST client. `fetchImpl` is injectable for tests. */
export class SfApi {
  constructor({ apiHost, sessionId, apiVersion = API_VERSION, fetchImpl }) {
    this.base = `https://${apiHost}`;
    this.sessionId = sessionId;
    this.apiVersion = apiVersion;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.calls = 0;
  }

  async get(path) {
    const url = path.startsWith("http") ? path : this.base + path;
    this.calls++;
    const res = await this.fetch(url, {
      headers: { Authorization: `Bearer ${this.sessionId}`, Accept: "application/json" },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const err = Array.isArray(body) ? body[0] : body;
      const msg = err?.message || text || `HTTP ${res.status}`;
      if (res.status === 401) {
        throw new SalesforceError(`Session expired or not valid for the API (${msg}). Reload the Salesforce tab and try again.`, { status: 401, errorCode: err?.errorCode, url });
      }
      throw new SalesforceError(msg, { status: res.status, errorCode: err?.errorCode, url });
    }
    return body;
  }

  /** Run SOQL and follow nextRecordsUrl until every record is read. */
  async query(soql, { tooling = false } = {}) {
    const svc = tooling ? "tooling/query" : "query";
    let page = await this.get(`/services/data/v${this.apiVersion}/${svc}/?q=${encodeURIComponent(soql)}`);
    const records = [...(page.records || [])];
    while (!page.done && page.nextRecordsUrl) {
      page = await this.get(page.nextRecordsUrl);
      records.push(...(page.records || []));
    }
    return { records, totalSize: page.totalSize ?? records.length };
  }

  async count(soql) {
    const page = await this.get(`/services/data/v${this.apiVersion}/query/?q=${encodeURIComponent(soql)}`);
    return page.totalSize;
  }

  async describe(sobject) {
    return this.get(`/services/data/v${this.apiVersion}/sobjects/${sobject}/describe/`);
  }
}

/** Escape a value for a SOQL string literal. */
export function soqlString(v) {
  return "'" + String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/** Split an array into chunks of `n`. */
export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
