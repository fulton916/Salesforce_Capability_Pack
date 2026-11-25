// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Record Ids in Salesforce page addresses, shared by the toolbar menu and the record-access page.
// Pure: no browser, no network.

const ID_RE = /^(?:[a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})$/;

/** A Salesforce Id: 15 or 18 letters and digits, with at least one digit (so "ProductConsumed" is not an Id). */
export function looksLikeId(s) {
  return typeof s === "string" && ID_RE.test(s) && /\d/.test(s);
}

/** The record Id in a Salesforce page address, or null. Also accepts a bare Id.
 *  Lightning (/lightning/r/<Object>/<Id>/view, /lightning/r/<Id>/view), Classic (/<Id>), console and
 *  older Lightning addresses (Id in the # part). Setup pages and list pages give null. */
export function recordIdFromUrl(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (looksLikeId(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const path = u.pathname.split("/").filter(Boolean);
  const first = (path[0] || "").toLowerCase();
  if (first === "lightning") {
    if ((path[1] || "").toLowerCase() !== "r") return null; // lists (o), Setup, pages, apps
    const rest = path.slice(2);
    if (looksLikeId(rest[1])) return rest[1]; // /r/<Object>/<Id>/...
    if (looksLikeId(rest[0])) return rest[0]; // /r/<Id>/...
    return null;
  }
  if (first === "setup") return null;
  if (first === "console" || first === "one") { // classic console, older Lightning: the Id is after the #
    let hash = u.hash;
    try { hash = decodeURIComponent(hash); } catch { /* keep as is */ }
    const hit = hash.split("/").find((p) => looksLikeId(p));
    return hit || null;
  }
  if (path.length >= 1 && path.length <= 2 && looksLikeId(path[0])) return path[0]; // Classic: /001..., /001.../e
  return null;
}
