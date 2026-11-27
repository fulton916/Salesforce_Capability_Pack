// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Which other orgs can the page compare with? Pure: no browser or network APIs of its own. The browser's
// tab list and the session finder are passed in, so tests can fake them.
//
// The other org is reached live from a Salesforce tab that is open and logged in, in this browser.
// Nothing is saved: the session objects live in memory for the page session only and are never shown.

import { isSalesforceHost } from "../../shared/sfconn.js";

export const NO_OTHER_ORG_TEXT = "No other org is open. Open the other org in another tab and log in, then click Refresh.";
export const SAME_ORG_TEXT = "You picked the same org on both sides, so there is nothing to compare across orgs. Pick the other org.";
export const NO_SECOND_DEV_ORG_TEXT = "There is no second org on this dev server. Start it with --second-org <alias>.";
export const SAME_DEV_ORG_TEXT = "The second dev server org is the same org as this one, so there is nothing to compare across orgs. Start the dev server with a different --second-org.";
export const CROSS_ORG_NOTE = "Items are matched by API name, not Id. If the same item has a different name (label) in each org, it is flagged as named differently. A custom setting only shows when its value differs from that org's own default.";

/** First 15 characters of an Id (15 and 18 character forms of one Id are equal). */
export const id15 = (v) => (v ? String(v).slice(0, 15) : "");

/** True when both Ids name the same org. A missing Id is never "the same". */
export function sameOrg(idA, idB) {
  return !!idA && !!idB && id15(idA) === id15(idB);
}

/** The host name of a tab's address, or null when it has none or is not a web address. */
export function hostOfTab(tab) {
  try {
    const u = new URL(tab?.url || "");
    return u.protocol === "https:" ? u.hostname : null;
  } catch {
    return null;
  }
}

/**
 * From the browser's tabs to the orgs that can be compared with.
 * - keeps tabs whose host is a Salesforce host (`isSf`), looks each distinct host up once with `finder(host)`
 *   (shared/sfconn.js `findSession` with chrome.cookies bound in),
 * - groups by org Id (several tabs of one org are one choice), drops the org already open (`skipOrgId`),
 * - a tab whose session cannot be found is skipped; its reason goes to `skipped` (for the folded Technical details).
 * Returns {orgs: [{orgId, apiHost, uiHosts, session}], skipped: [{host, reason}]}, orgs sorted by apiHost.
 */
export async function groupTabsByOrg(tabs, finder, { skipOrgId = null, isSf = isSalesforceHost } = {}) {
  const hosts = [];
  for (const t of tabs || []) {
    const h = hostOfTab(t);
    if (h && isSf(h) && !hosts.includes(h)) hosts.push(h);
  }
  const found = await Promise.all(hosts.map(async (host) => {
    try {
      return { host, session: await finder(host) };
    } catch (e) {
      return { host, error: e };
    }
  }));
  const skipped = [];
  const byOrg = new Map();
  for (const f of found) {
    if (f.error || !f.session?.orgId) {
      skipped.push({ host: f.host, reason: f.error?.message || "No organization Id in the session." });
      continue;
    }
    const key = id15(f.session.orgId);
    if (sameOrg(key, skipOrgId)) continue;
    if (!byOrg.has(key)) byOrg.set(key, { orgId: key, apiHost: f.session.apiHost, uiHosts: [], session: f.session });
    byOrg.get(key).uiHosts.push(f.host);
  }
  const orgs = [...byOrg.values()].sort((x, y) => String(x.apiHost).localeCompare(String(y.apiHost)));
  return { orgs, skipped };
}

/** What a choice is called in the list: the org's name and its My Domain host. Never includes the session. */
export function choiceLabel(c) {
  return [c.name || c.id || c.orgId, c.host ? `(${c.host})` : ""].filter(Boolean).join(" ");
}

/** One plain sentence for an org whose tab is open and whose session was found, but which could not be read. */
export function unreadableOrgText(host) {
  return `${host} is open, but its session has expired or could not be read. Reload that tab (log in again if asked), then click Refresh.`;
}

/**
 * The text under the org list. One sentence per org that was found but could not be read (`skipped` entries with
 * `unreadable: true`); tabs with no session at all stay quiet. With nothing to say and no choices: `message` or the
 * generic "No other org is open". With choices and nothing unreadable: "".
 */
export function orgListMessage(choiceCount, skipped, message = "") {
  const lines = [];
  for (const s of skipped || []) if (s?.unreadable && !lines.includes(unreadableOrgText(s.host))) lines.push(unreadableOrgText(s.host));
  if (lines.length) return lines.join("\n");
  return choiceCount ? "" : message || NO_OTHER_ORG_TEXT;
}

/** The two picker labels in cross-org mode; same-named orgs are told apart exactly as in the results. */
export function crossPickerLabels(orgA, chosen) {
  if (!chosen) return { a: `Person in ${orgA?.name || "this org"}`, b: "The same person in the other org" };
  const n = orgSideNames(orgA || { name: "this org" }, chosen);
  return { a: `Person in ${n.a}`, b: `The same person in ${n.b}` };
}

/** The two side names for a cross-org compare: the org names, told apart by host when they match. */
export function orgSideNames(orgA, orgB) {
  const nm = (o) => o.name || o.host || o.id;
  let a = nm(orgA);
  let b = nm(orgB);
  if (a.toLowerCase() === b.toLowerCase()) {
    a = orgA.host ? `${a} (${orgA.host})` : `${a} (A)`;
    b = orgB.host ? `${b} (${orgB.host})` : `${b} (B)`;
    if (a === b) { a = `${nm(orgA)} (A)`; b = `${nm(orgB)} (B)`; }
  }
  return { a, b };
}
