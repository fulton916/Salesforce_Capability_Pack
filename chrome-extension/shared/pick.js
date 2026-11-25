// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Matching for the group search box and the lists. Pure, no DOM.

/** Words to search for: lower case, any punctuation (such as "›", "_", "-") counts as a space. */
export function searchWords(text) {
  return String(text || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** True when `text` contains every word (the words come from searchWords). */
export function matchesWords(text, words) {
  const hay = searchWords(text).join(" ");
  return words.every((w) => hay.includes(w));
}

/** Groups whose label or API name contains every word typed, in any order.
 * Label prefix matches sort first, then alphabetical. Empty text returns everything. */
export function matchPsgs(psgs, text, limit = 100) {
  const words = searchWords(text);
  const hits = psgs.filter((p) => matchesWords(`${p.label} ${p.developerName}`, words));
  const q = words.join(" ");
  const starts = (p) => (q && searchWords(p.label).join(" ").startsWith(q) ? 0 : 1);
  hits.sort((x, y) => starts(x) - starts(y) || x.label.localeCompare(y.label));
  return { items: hits.slice(0, limit), total: hits.length };
}
