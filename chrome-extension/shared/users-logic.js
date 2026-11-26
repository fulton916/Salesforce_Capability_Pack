// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// User matching shared by the user-access and record-access pages. Pure: no browser, no network.

const CHECK = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

/** The 18 character form of a 15 character Salesforce Id (the checksum depends on which letters are capitals). */
export function sfId18(id15) {
  const s = String(id15 || "");
  if (!/^[A-Za-z0-9]{15}$/.test(s)) return "";
  let suffix = "";
  for (let c = 0; c < 3; c++) {
    let n = 0;
    for (let i = 0; i < 5; i++) {
      const ch = s[c * 5 + i];
      if (ch >= "A" && ch <= "Z") n |= 1 << i;
    }
    suffix += CHECK[n];
  }
  return s + suffix;
}

/** True for a 15 character Id, or an 18 character Id whose last three characters are the right checksum. */
export function isSalesforceId(text) {
  const s = String(text || "");
  if (/^[A-Za-z0-9]{15}$/.test(s)) return true;
  return /^[A-Za-z0-9]{18}$/.test(s) && sfId18(s.slice(0, 15)) === s;
}

/** The text as a user Id (prefix 005, 15 or checksummed 18 characters), or "" when it is not one. */
export function pastedUserId(text) {
  const s = String(text || "").trim();
  return s.startsWith("005") && isSalesforceId(s) ? s : "";
}

/** Users whose name or username contains every typed word (demo mode searches the samples with this).
 * Opt-in `{emailAndId: true}` also looks at `email` and finds a pasted user Id (15 or 18 characters, first 15 compared exactly). */
export function matchUsers(users, text, limit = 50, opts = {}) {
  const words = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
  const pasted = opts.emailAndId ? pastedUserId(text) : "";
  const hits = users.filter((u) => {
    if (pasted && String(u.id || "").slice(0, 15) === pasted.slice(0, 15)) return true;
    const hay = `${u.name} ${u.username}${opts.emailAndId ? ` ${u.email || ""}` : ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return { users: hits.slice(0, limit), more: hits.length > limit };
}
