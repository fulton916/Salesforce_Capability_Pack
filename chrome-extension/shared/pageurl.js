// Cleaning a page address, shared by the toolbar menu and the page-details tool. Pure: no browser, no network.
// Only the path and the filterName parameter are ever kept.

const BASE = "https://example.invalid";
const MAX_PATH = 300;

/** Path plus the filterName parameter of an address (full URL or path). Everything else is dropped:
 * other query parameters (sid, token, access_token, code, frontdoor...), the hash and `;params`.
 * "" when there is nothing usable. */
export function cleanUrl(input) {
  if (typeof input !== "string" || !input.trim()) return "";
  let u;
  try { u = new URL(input.trim(), BASE); } catch { return ""; }
  let path = u.pathname.replace(/;[^/]*/g, "");
  if (path.length > MAX_PATH) path = path.slice(0, MAX_PATH);
  const filter = u.searchParams.get("filterName");
  return path + (filter && /^[\w.-]{1,80}$/.test(filter) ? `?filterName=${filter}` : "");
}
