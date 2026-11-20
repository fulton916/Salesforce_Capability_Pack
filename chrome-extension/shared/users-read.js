// User search shared by the user-access and record-access pages. Read-only: one SOQL query.

import { soqlLike } from "./sfconn.js";

const MAX_WORDS = 6;

/** Find users by name or username, in the org. Every typed word must match one of the two.
 * Returns {users, more}; `more` is true when there are more matches than `limit`. */
export async function searchUsers(api, text, limit = 50) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  if (!words.length) return { users: [], more: false };
  const where = words.map((w) => `(Name LIKE '%${soqlLike(w)}%' OR Username LIKE '%${soqlLike(w)}%')`).join(" AND ");
  const soql = `SELECT Id, Name, Username, IsActive, Profile.Name FROM User WHERE ${where} ORDER BY IsActive DESC, Name LIMIT ${limit + 1}`;
  const { records } = await api.query(soql);
  const users = records.slice(0, limit).map((r) => ({
    id: r.Id, name: r.Name, username: r.Username, isActive: r.IsActive === true, profile: r.Profile?.Name || "",
  }));
  return { users, more: records.length > limit };
}
