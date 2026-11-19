// Matching for the group search box. Pure, no DOM.

/** Groups whose label or API name contains every word typed, in any order.
 * Label prefix matches sort first, then alphabetical. Empty text returns everything. */
export function matchPsgs(psgs, text, limit = 100) {
  const words = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
  const hits = psgs.filter((p) => {
    const hay = `${p.label} ${p.developerName}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const q = words.join(" ");
  const starts = (p) => (q && p.label.toLowerCase().startsWith(q) ? 0 : 1);
  hits.sort((x, y) => starts(x) - starts(y) || x.label.localeCompare(y.label));
  return { items: hits.slice(0, limit), total: hits.length };
}
