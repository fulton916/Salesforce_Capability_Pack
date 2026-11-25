// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

import { isSalesforceHost } from "./shared/sfconn.js";
import { recordIdFromUrl } from "./shared/recordid.js";
import { parseUrlContext, contextQuery } from "./shared/urlcontext.js";
import { cleanUrl } from "./shared/pageurl.js";
import { TOOLS } from "./shared/tool-list.js";
import { createSettingsStore, visibleTools } from "./shared/menu-settings.js";
import { issueUrl, FEEDBACK_TOOLS, versionText } from "./shared/feedback.js";

const state = document.getElementById("state");
const hostEl = document.getElementById("host");
const menu = document.getElementById("menu");

// chrome.tabs is missing when the popup is served outside the extension.
let tab = null;
try {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
} catch { /* not running as an extension */ }
const recordId = recordIdFromUrl(tab?.url || "");
let host = null;
try { host = new URL(tab?.url || "").hostname; } catch { /* not a URL */ }

const inOrg = isSalesforceHost(host);

if (inOrg) {
  state.textContent = "Connected to this org:";
  hostEl.textContent = host;
} else {
  state.textContent = "These tools work on a Salesforce page. Go to a Salesforce tab (any page in your org), then click the Salesforce Capability Pack icon again.";
}

// Wait for the setting before drawing, so the menu never shows a tool and then hides it.
const shown = visibleTools(TOOLS, await createSettingsStore(TOOLS).getHidden());

// Opens the Settings page (works with or without a Salesforce tab), then closes the menu.
async function openSettings() {
  try {
    await chrome.runtime.openOptionsPage();
  } catch {
    try { await chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") }); } catch { window.open("settings.html", "_blank"); }
  }
  window.close();
}

if (!shown.length) {
  const none = document.createElement("p");
  none.className = "hint";
  none.append("All tools are hidden. ");
  const open = document.createElement("a");
  open.href = "settings.html";
  open.textContent = "Open Settings to show them again";
  open.addEventListener("click", (event) => { event.preventDefault(); openSettings(); });
  none.append(open, ".");
  menu.append(none);
}

for (const tool of shown) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.disabled = !inOrg;
  const title = document.createElement("span");
  title.className = "tool-title";
  title.textContent = tool.title;
  const desc = document.createElement("span");
  desc.className = "tool-desc";
  desc.textContent = tool.needsRecord && !recordId ? tool.noRecordDescription : tool.description;
  btn.append(title, desc);
  if (inOrg) {
    btn.addEventListener("click", async () => {
      const record = tool.needsRecord && recordId ? `&record=${encodeURIComponent(recordId)}` : "";
      let extra = "";
      if (tool.context) extra = contextQuery(parseUrlContext(tab?.url)); // object and field only; never the address itself
      // Only the path and filterName of the address go along; sid, tokens and the hash never do.
      if (tool.withPageAddress) extra = `url=${encodeURIComponent(cleanUrl(tab?.url || ""))}`;
      await chrome.tabs.create({ url: chrome.runtime.getURL(`${tool.page}?host=${encodeURIComponent(host)}${record}${extra ? "&" + extra : ""}`) });
      window.close();
    });
  }
  menu.append(btn);
}

document.getElementById("settings").addEventListener("click", (event) => { event.preventDefault(); openSettings(); });

// Report a bug / suggest an improvement. Works without a Salesforce tab. Only the tool name,
// extension version and browser go into the link; the person submits on GitHub themselves.
let manifestVersion = "";
try { manifestVersion = chrome.runtime.getManifest().version; } catch { /* not an extension */ }
document.getElementById("version").textContent = manifestVersion ? `v${manifestVersion}` : "dev";
for (const [id, kind] of [["report-bug", "bug"], ["suggest", "enhancement"]]) {
  const link = document.getElementById(id);
  const urlFor = () => issueUrl({ kind, tool: FEEDBACK_TOOLS.menu, version: versionText(manifestVersion, navigator) });
  link.href = urlFor(); // so hovering shows where it goes
  link.addEventListener("click", async (event) => {
    event.preventDefault();
    const url = urlFor();
    try { await chrome.tabs.create({ url }); } catch { window.open(url, "_blank", "noopener,noreferrer"); }
    window.close();
  });
}
