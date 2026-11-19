import { isSalesforceHost } from "./lib/sfconn.js";

// One entry per tool. To add a tool, add a line here and ship its page.
const TOOLS = [
  {
    page: "psg-compare.html",
    title: "Compare permission set groups",
    description: "Find out how two permission set groups differ",
  },
  {
    page: "user-access.html",
    title: "User access summary and comparison",
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
