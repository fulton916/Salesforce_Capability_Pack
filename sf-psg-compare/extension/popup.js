import { isSalesforceHost } from "./lib/sfconn.js";
import { issueUrl, FEEDBACK_TOOLS, versionText } from "./lib/feedback.js";

// One entry per tool. To add a tool, add a line here and ship its page.
const TOOLS = [
  {
    page: "psg-compare.html",
    title: "Compare permission set groups",
    description: "Find out how two permission set groups differ",
  },
  {
    page: "user-access.html",
    title: "Look up user access",
    description: "See what a user can access, or compare two users",
  },
  {
    page: "hierarchy.html",
    title: "Territory & role hierarchy",
    description: "See the whole territory or role tree; export it for Excel",
  },
];

const state = document.getElementById("state");
const hostEl = document.getElementById("host");
const menu = document.getElementById("menu");

// chrome.tabs is missing when the popup is served outside the extension.
let tab = null;
try {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
} catch { /* not running as an extension */ }
let host = null;
try { host = new URL(tab?.url || "").hostname; } catch { /* not a URL */ }

const inOrg = isSalesforceHost(host);

if (inOrg) {
  state.textContent = "Connected to this org:";
  hostEl.textContent = host;
} else {
  state.textContent = "These tools work on a Salesforce page. Go to a Salesforce tab (any page in your org), then click the Salesforce Capability Pack icon again.";
}

for (const tool of TOOLS) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.disabled = !inOrg;
  const title = document.createElement("span");
  title.className = "tool-title";
  title.textContent = tool.title;
  const desc = document.createElement("span");
  desc.className = "tool-desc";
  desc.textContent = tool.description;
  btn.append(title, desc);
  if (inOrg) {
    btn.addEventListener("click", async () => {
      await chrome.tabs.create({ url: chrome.runtime.getURL(`${tool.page}?host=${encodeURIComponent(host)}`) });
      window.close();
    });
  }
  menu.append(btn);
}

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
