// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Builds the link that opens GitHub's "new issue" page with a few fields filled in.
// Pure: no browser APIs, no network. Nothing is sent anywhere by this code; the person
// reviews the page on GitHub and presses Submit themselves.
//
// Only the tool name, the extension version and the browser may go in. Never the org host,
// org name, user names, the address of the current page, or anything read from the org.

export const REPO_URL = "https://github.com/fulton916/Salesforce_Capability_Pack";

/** Exact option labels of the "tool" dropdown in .github/ISSUE_TEMPLATE/*.yml. */
export const FEEDBACK_TOOLS = {
  psg: "Compare permission set groups (extension)",
  access: "User access summary and comparison (extension)",
  hierarchy: "Territory & role hierarchy (extension)",
  record: "Why can a user see this record? (extension)",
  flows: "Where is it used in flows? (extension)",
  snapshot: "Page details for a ticket (extension)",
  errors: "Error Tracer: read a debug log (extension)",
  grants: "Where does a user get this permission? (extension)",
  menu: "Extension menu / other",
};

const TEMPLATES = { bug: "bug.yml", enhancement: "enhancement.yml" };

/** URL of the new-issue form for `kind` ("bug" or "enhancement"). Other keys in `opts` are ignored. */
export function issueUrl({ kind, tool, version } = {}) {
  const template = TEMPLATES[kind];
  if (!template) throw new Error(`Unknown kind: ${kind}`);
  const q = new URLSearchParams({ template });
  if (tool) q.set("tool", String(tool));
  if (version) q.set("version", String(version));
  return `${REPO_URL}/issues/new?${q}`;
}

/** Short browser name and major version, e.g. "Chrome 131" or "Edge 131". `nav` is `navigator`. */
export function browserName(nav) {
  const ua = String((nav && nav.userAgent) || "");
  const brands = (nav && nav.userAgentData && nav.userAgentData.brands) || [];
  // Chrome also lists "Chromium" and the order is not fixed, so pick by preference.
  let known;
  for (const name of ["Microsoft Edge", "Google Chrome", "Chromium"]) {
    known = brands.find((b) => b.brand === name);
    if (known) break;
  }
  if (known) return `${known.brand.replace("Microsoft ", "").replace("Google ", "")} ${String(known.version).split(".")[0]}`;
  const e = /Edg\/(\d+)/.exec(ua);
  if (e) return `Edge ${e[1]}`;
  const m = /(Chrome|Chromium)\/(\d+)/.exec(ua);
  if (m) return `${m[1]} ${m[2]}`;
  return "unknown browser";
}

/** "Extension 0.10.1, Chrome 131" (or "Extension dev server, ..." when there is no manifest). */
export function versionText(manifestVersion, nav) {
  return `Extension ${manifestVersion || "dev server"}, ${browserName(nav)}`;
}
