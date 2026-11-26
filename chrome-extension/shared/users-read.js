// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// User search shared by the user-access and record-access pages. Read-only: one SOQL query.

import { soqlLike, soqlString } from "./sfconn.js";
import { pastedUserId } from "./users-logic.js";

const MAX_WORDS = 6;

/** Find users by name or username, in the org. Every typed word must match one of the two.
 * Returns {users, more}; `more` is true when there are more matches than `limit`.
 * Opt-in `{emailAndId: true}` (the audit trail page): every word may also match the email, a pasted user Id (15 or
 * checksummed 18 characters) is found by Id, and each user carries `email`. Without it the query is exactly as before. */
export async function searchUsers(api, text, limit = 50, opts = {}) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  if (!words.length) return { users: [], more: false };
  const extra = opts.emailAndId === true;
  const one = (w) => (extra
    ? `(Name LIKE '%${soqlLike(w)}%' OR Username LIKE '%${soqlLike(w)}%' OR Email LIKE '%${soqlLike(w)}%')`
    : `(Name LIKE '%${soqlLike(w)}%' OR Username LIKE '%${soqlLike(w)}%')`);
  let where = words.map(one).join(" AND ");
  const pasted = extra ? pastedUserId(String(text).trim()) : "";
  if (pasted) where = `(${where}) OR Id = ${soqlString(pasted)}`;
  const fields = extra ? "Id, Name, Username, Email, IsActive, Profile.Name" : "Id, Name, Username, IsActive, Profile.Name";
  const soql = `SELECT ${fields} FROM User WHERE ${where} ORDER BY IsActive DESC, Name LIMIT ${limit + 1}`;
  const { records } = await api.query(soql);
  const users = records.slice(0, limit).map((r) => ({
    id: r.Id, name: r.Name, username: r.Username, ...(extra ? { email: r.Email || "" } : {}), isActive: r.IsActive === true, profile: r.Profile?.Name || "",
  }));
  return { users, more: records.length > limit };
}
