// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// User matching shared by the user-access and record-access pages. Pure: no browser, no network.

/** Users whose name or username contains every typed word (demo mode searches the samples with this). */
export function matchUsers(users, text, limit = 50) {
  const words = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
  const hits = users.filter((u) => {
    const hay = `${u.name} ${u.username}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return { users: hits.slice(0, limit), more: hits.length > limit };
}
