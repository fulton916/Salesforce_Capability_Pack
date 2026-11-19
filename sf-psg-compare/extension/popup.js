import { isSalesforceHost } from "./lib/sfconn.js";

const state = document.getElementById("state");
const hostEl = document.getElementById("host");
const btn = document.getElementById("open");

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let host = null;
try { host = new URL(tab?.url || "").hostname; } catch { /* not a URL */ }

if (isSalesforceHost(host)) {
  state.textContent = "Salesforce org in this tab:";
  hostEl.textContent = host;
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`psg-compare.html?host=${encodeURIComponent(host)}`) });
    window.close();
  });
} else {
  state.textContent = "Open a Salesforce org in this tab, then click the extension again.";
}
