import { SfApi, findSession } from "./lib/sfconn.js";
import { readIssueSnapshot } from "./lib/issuesnapshotread.js";
import { snapshotText, fileName, cleanUrl, whenText, scrubNote, objectText, NOTE_REMOVED_TEXT, HASH_HINT, KIND_TEXT } from "./lib/issuesnapshot.js";
import { startLiveReload } from "./lib/livereload.js";
import { issueUrl, FEEDBACK_TOOLS, versionText } from "./lib/feedback.js";

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const DEV = params.has("dev"); // served by tools/dev_server.py, which forwards API calls to the org
const HOST = params.get("host");

const $ = (sel, root = document) => root.querySelector(sel);

/** Build an element. Text is always set with textContent (org data is never parsed as HTML). */
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

let manifestVersion = "";
try { manifestVersion = chrome.runtime.getManifest().version; } catch { /* dev server */ }
const browser = versionText("", navigator).replace(/^Extension [^,]*, /, "");
const extensionVersion = manifestVersion || "dev server";

// What was read; kept in memory only. The note is read from the box when needed and never kept.
const model = {
  when: new Date(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  org: null, user: null, page: null, host: "",
  problems: {}, tech: {},
};

// One plain line near the buttons when something session-like was taken out of the note.
const updateNoteNotice = () => { $("#note-notice").textContent = scrubNote($("#note").value).removed ? NOTE_REMOVED_TEXT : ""; };

const textNow = () => snapshotText({
  note: $("#note").value, when: model.when, timeZone: model.timeZone, host: model.host,
  org: model.org, user: model.user, page: model.page,
  browser, extensionVersion, problems: model.problems,
});

function showError(msg, raw) {
  const box = $("#error");
  box.hidden = !msg;
  box.replaceChildren();
  if (!msg) return;
  box.append(msg);
  if (raw) box.append(el("details", { class: "tech" }, el("summary", { text: "Technical details" }), el("div", { text: raw })));
}

const NONE = "Not available";
const v = (x) => (x === null || x === undefined || x === "" ? NONE : String(x));

function area(title, rows, problem, raw) {
  return el("div", { class: "panel area" },
    el("h2", { text: title }),
    rows.length ? el("dl", {}, rows.flatMap(([l, val]) => [el("dt", { text: l }), el("dd", { text: v(val) })])) : null,
    problem ? el("div", { class: "missing", text: problem }) : null,
    raw ? el("details", { class: "tech" }, el("summary", { text: "Technical details" }), el("div", { text: raw })) : null
  );
}

function render() {
  const { org, user, page, problems, tech } = model;
  const w = whenText(model.when, model.timeZone);
  const blocks = [area("When", [["Local time", w.local], ["UTC", w.utc]])];

  blocks.push(org
    ? area("Org", [["Org name", org.name], ["Org Id", org.id], ["Type", org.kind], org.kind === "Sandbox" ? ["Sandbox name", org.sandboxName] : null,
      ["Instance", org.instance], ["My Domain host", org.host]].filter(Boolean))
    : area("Org", model.host ? [["My Domain host", model.host]] : [], `The org details could not be read. ${problems.org || ""}`.trim(), tech.org));

  blocks.push(user
    ? area("You", [["Name", user.name], ["Username", user.username], ["User Id", user.id], ["Profile", user.profile], ["Role", user.role || "No role"],
      ["Language", user.language], ["Locale", user.locale], ["Time zone", user.timeZone], ["User type", user.userType]], problems.user, tech.user)
    : area("You", [], `Your user details could not be read. ${problems.user || ""}`.trim(), tech.user));

  const pg = page || {};
  const prow = [["Kind", KIND_TEXT[pg.kind] || KIND_TEXT.other], ["Address", pg.url]];
  if (pg.kind === "setup") prow.push(["Setup page", pg.setupPage]);
  if (pg.objectApi || pg.objectLabel) prow.push(["Object", objectText(pg)]);
  if (pg.kind === "list") prow.push(["List view", pg.listView || pg.filterName]);
  if (pg.kind === "record") {
    prow.push(["Record Id", pg.recordId], ["Record name", pg.recordName], ["Record type", pg.recordType], ["Owner", pg.owner],
      ["Last modified by", pg.modifiedBy], ["Last modified", pg.modifiedAt]);
  }
  blocks.push(area("Page", prow, [pg.hashAddress ? HASH_HINT : "", problems.record || ""].filter(Boolean).join(" "), tech.page));
  blocks.push(area("Browser and extension", [["Browser", browser], ["Extension version", extensionVersion]]));

  $("#areas").replaceChildren(...blocks);
  $("#results").hidden = false;
  $("#copy").disabled = false;
  $("#download").disabled = false;
}

function applyReads(r, rawUrl) {
  model.org = r.org.data;
  model.user = r.user.data;
  model.page = r.page.data || { kind: "other", url: cleanUrl(rawUrl) };
  model.problems = { org: r.org.problem, user: r.user.problem, record: r.page.problem };
  model.tech = { org: r.org.raw, user: r.user.raw, page: r.page.raw };
}

async function start() {
  const rawUrl = cleanUrl(params.get("url") || ""); // cleaned again here, whatever the opener passed
  if (DEMO) {
    $("#org").replaceChildren(el("span", { class: "badge demo", text: "DEMO" }), " Made-up sample details, no org connected");
    const res = await fetch("samples/issue_snapshot_demo.json");
    const d = await res.json();
    model.host = d.host || "";
    applyReads({ org: { data: d.org }, user: { data: d.user }, page: { data: d.page } }, d.url);
    render();
    return;
  }
  let session;
  try {
    if (DEV) {
      session = { apiHost: location.host, sessionId: "dev", base: `${location.origin}/sf` };
    } else if (HOST && typeof chrome !== "undefined" && chrome.cookies) {
      $("#org").textContent = `Connecting to ${HOST}…`;
      session = await findSession(HOST, chrome.cookies);
    } else {
      $("#org").textContent = "No org connected. Open this page from the extension button on a Salesforce tab.";
      return;
    }
  } catch (e) {
    $("#org").textContent = `Could not connect${HOST ? " to " + HOST : ""}.`;
    showError(e?.status === 401 || /session/i.test(e?.message || "") ? e.message : "Could not connect to the org. If you have been away a while, reload the Salesforce tab and try again.", e?.message);
    return;
  }
  const api = new SfApi(session);
  const host = DEV ? (HOST || "") : (HOST || session.apiHost);
  model.host = host;
  $("#org").textContent = DEV ? "Dev server" : host;
  applyReads(await readIssueSnapshot(api, { host, url: rawUrl }), rawUrl);
  if (model.org) $("#org").textContent = `${model.org.name} (${model.org.kind})`;
  render();
}

// ---------- Copy and Download ----------

const setStatus = (t) => { $("#status").textContent = t; };

$("#note").addEventListener("input", updateNoteNotice);

$("#copy").addEventListener("click", async () => {
  updateNoteNotice();
  try {
    await navigator.clipboard.writeText(textNow());
    setStatus("Copied. Paste it into your ticket.");
  } catch {
    setStatus("Copying was blocked by the browser. Use Download instead.");
  }
});

$("#download").addEventListener("click", () => {
  updateNoteNotice();
  const blob = new Blob([textNow()], { type: "text/plain;charset=utf-8" });
  const a = el("a", { href: URL.createObjectURL(blob), download: fileName(new Date()) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  setStatus("Downloaded.");
});

start().catch((e) => showError("Something went wrong while reading the details.", e?.message || String(e)));
startLiveReload();

// Header links to GitHub's new-issue form. Only tool, extension version and browser go in the link.
{
  const version = versionText(manifestVersion, navigator);
  const link = (text, kind) => el("a", {
    href: issueUrl({ kind, tool: FEEDBACK_TOOLS.snapshot, version }), target: "_blank", rel: "noopener noreferrer", text,
  });
  $("#feedback").replaceChildren(link("Report a bug", "bug"), " · ", link("Suggest an improvement", "enhancement"));
}
