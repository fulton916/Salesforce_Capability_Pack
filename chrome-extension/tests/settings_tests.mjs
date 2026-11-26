// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Offline tests for the Settings page and the tool list. Called from run_tests.mjs with its shared `test` function.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { TOOLS } from "../shared/tool-list.js";
import { HIDDEN_KEY, cleanHidden, visibleTools, createSettingsStore } from "../shared/menu-settings.js";
import { createSettingsPage } from "../settings-logic.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = (...p) => path.join(here, "..", ...p);
const read = (f) => readFileSync(ext(f), "utf-8");

const IDS = ["compare-groups", "user-access", "hierarchy", "record-access", "flow-usage", "page-details", "error-tracer", "who-grants", "audit-trail"];

// A fake chrome.storage.local that records what it was asked.
function fakeStorage(initial = {}, { failGet = false, failSet = false } = {}) {
  const data = { ...initial };
  const calls = { get: [], set: [] };
  return {
    data, calls,
    async get(key) { calls.get.push(key); if (failGet) throw new Error("no"); return key in data ? { [key]: data[key] } : {}; },
    async set(obj) { calls.set.push(obj); if (failSet) throw new Error("no"); Object.assign(data, obj); },
  };
}

function walkJs(dir, rel = "") {
  const out = [];
  for (const name of readdirSync(path.join(dir, rel))) {
    const r = rel ? `${rel}/${name}` : name;
    if (["tests", "node_modules", "dev", "samples"].includes(name) && !rel) continue;
    if (statSync(path.join(dir, r)).isDirectory()) out.push(...walkJs(dir, r));
    else if (/\.(js|mjs|html)$/.test(name)) out.push(r);
  }
  return out;
}

export async function run(test) {
  await test("settings: the tool list has the nine ids, in menu order, each with a page, title and description", () => {
    assert.deepEqual(TOOLS.map((t) => t.id), IDS);
    for (const t of TOOLS) {
      assert.ok(t.page === `tools/${t.id}/${t.id}.html`, t.id);
      assert.ok(t.title && t.description);
    }
  });

  await test("settings: visibleTools with none hidden, some hidden, all hidden", () => {
    assert.deepEqual(visibleTools(TOOLS, []).map((t) => t.id), IDS);
    assert.deepEqual(visibleTools(TOOLS, ["hierarchy", "page-details"]).map((t) => t.id), ["compare-groups", "user-access", "record-access", "flow-usage", "error-tracer", "who-grants", "audit-trail"]);
    assert.deepEqual(visibleTools(TOOLS, IDS), []);
  });

  await test("settings: visibleTools ignores unknown ids and bad input, and keeps the order", () => {
    assert.deepEqual(visibleTools(TOOLS, ["nope", 7, null, "user-access"]).map((t) => t.id), ["compare-groups", "hierarchy", "record-access", "flow-usage", "page-details", "error-tracer", "who-grants", "audit-trail"]);
    for (const bad of [undefined, null, "user-access", { a: 1 }, 5]) assert.equal(visibleTools(TOOLS, bad).length, 9);
    assert.deepEqual(cleanHidden(["page-details", "page-details", "x", "compare-groups"], TOOLS), ["compare-groups", "page-details"]);
    const copy = visibleTools(TOOLS, ["hierarchy"]);
    assert.equal(copy[2], TOOLS[3], "entries are the same objects, in the same order");
  });

  await test("settings store: reads and writes only hiddenTools; unknown ids are dropped both ways", async () => {
    const st = fakeStorage({ [HIDDEN_KEY]: ["flow-usage", "ghost", 3], other: "x" });
    const store = createSettingsStore(TOOLS, st);
    assert.equal(HIDDEN_KEY, "hiddenTools");
    assert.deepEqual(await store.getHidden(), ["flow-usage"]);
    assert.deepEqual(await store.setHidden(["page-details", "ghost", "flow-usage"]), ["flow-usage", "page-details"]);
    assert.deepEqual(st.data[HIDDEN_KEY], ["flow-usage", "page-details"]);
    assert.deepEqual(st.calls.get, ["hiddenTools", "hiddenTools"].slice(0, st.calls.get.length));
    for (const call of st.calls.set) assert.deepEqual(Object.keys(call), ["hiddenTools"]);
    assert.equal(st.data.other, "x", "other keys are untouched");
  });

  await test("settings store: turning one tool off and on, and Show all tools", async () => {
    const st = fakeStorage();
    const store = createSettingsStore(TOOLS, st);
    assert.deepEqual(await store.getHidden(), []);
    await store.setToolOn("hierarchy", false);
    await store.setToolOn("user-access", false);
    assert.deepEqual(st.data[HIDDEN_KEY], ["user-access", "hierarchy"]);
    await store.setToolOn("hierarchy", true);
    assert.deepEqual(st.data[HIDDEN_KEY], ["user-access"]);
    await store.setToolOn("user-access", false); // already off: no repeat
    assert.deepEqual(st.data[HIDDEN_KEY], ["user-access"]);
    await store.showAll();
    assert.deepEqual(st.data[HIDDEN_KEY], []);
    assert.deepEqual(Object.keys(st.data), ["hiddenTools"], "nothing else is stored");
  });

  await test("settings store: a stored value that is not a list counts as nothing hidden", async () => {
    for (const junk of ["page-details", 4, { a: 1 }, null]) {
      const store = createSettingsStore(TOOLS, fakeStorage({ [HIDDEN_KEY]: junk }));
      assert.deepEqual(await store.getHidden(), []);
    }
  });

  await test("settings store: a failed read shows every tool; a failed save throws and changes nothing", async () => {
    const bad = createSettingsStore(TOOLS, fakeStorage({ [HIDDEN_KEY]: ["hierarchy"] }, { failGet: true }));
    assert.deepEqual(await bad.getHidden(), []);
    assert.equal(visibleTools(TOOLS, await bad.getHidden()).length, 9);
    const st = fakeStorage({ [HIDDEN_KEY]: ["hierarchy"] }, { failSet: true });
    const store = createSettingsStore(TOOLS, st);
    await assert.rejects(() => store.setToolOn("user-access", false));
    assert.deepEqual(await store.getHidden(), ["hierarchy"], "the saved list stays as it was");
  });

  // A fake storage whose get fails on the listed call numbers (1-based) and otherwise works.
  const flakyGet = (initial, failOn) => {
    const data = { ...initial };
    let n = 0;
    return {
      data,
      async get(key) { if (failOn.includes(++n)) throw new Error("no"); return key in data ? { [key]: [...data[key]] } : {}; },
      async set(obj) { Object.assign(data, obj); },
    };
  };

  await test("settings store: a failed read before a switch change throws and leaves the stored list alone", async () => {
    const st = flakyGet({ [HIDDEN_KEY]: ["hierarchy", "flow-usage"] }, [1]);
    const store = createSettingsStore(TOOLS, st);
    await assert.rejects(() => store.setToolOn("user-access", false));
    assert.deepEqual(st.data[HIDDEN_KEY], ["hierarchy", "flow-usage"]);
    await store.setToolOn("user-access", false); // the next try reads fine and saves
    assert.deepEqual(st.data[HIDDEN_KEY], ["user-access", "hierarchy", "flow-usage"]);
  });

  await test("settings store: getHidden after a failed read gives the last good list; with none, an empty list", async () => {
    const st = flakyGet({ [HIDDEN_KEY]: ["hierarchy", "flow-usage"] }, [2]);
    const store = createSettingsStore(TOOLS, st);
    assert.deepEqual(await store.getHidden(), ["hierarchy", "flow-usage"]);
    assert.deepEqual(await store.getHidden(), ["hierarchy", "flow-usage"], "the read fails; the last good list comes back");
    const first = createSettingsStore(TOOLS, flakyGet({ [HIDDEN_KEY]: ["hierarchy"] }, [1]));
    assert.deepEqual(await first.getHidden(), [], "no earlier good read: every tool shows");
  });

  await test("settings page: a failed read during a switch change says the error and draws the last good list", async () => {
    const st = flakyGet({ [HIDDEN_KEY]: ["hierarchy", "flow-usage"] }, [2, 3]);
    const store = createSettingsStore(TOOLS, st);
    const draws = [], says = [];
    const page = createSettingsPage(store, { draw: (h) => draws.push([...h]), say: (text, bad) => says.push({ text, bad: !!bad }) });
    await page.load(); // read 1 works
    await page.toggle("user-access", false); // reads 2 and 3 fail
    assert.deepEqual(st.data[HIDDEN_KEY], ["hierarchy", "flow-usage"]);
    assert.deepEqual(draws.at(-1), ["hierarchy", "flow-usage"]);
    assert.deepEqual(says, [{ text: "Could not save this change. Try again.", bad: true }]);
  });

  // A fake storage whose get and set take a while (10-20 ms, varying), like the browser's.
  const slowStorage = (initial = {}, { failSetOn = [] } = {}) => {
    const data = { ...initial };
    let n = 0, sets = 0;
    const wait = () => new Promise((r) => setTimeout(r, 10 + (n++ % 3) * 5));
    return {
      data,
      async get(key) { await wait(); return key in data ? { [key]: [...data[key]] } : {}; },
      async set(obj) {
        const k = ++sets;
        await wait();
        if (failSetOn.includes(k)) throw new Error("no");
        Object.assign(data, obj);
      },
    };
  };

  await test("settings store: quick changes started together are all stored", async () => {
    const st = slowStorage();
    const store = createSettingsStore(TOOLS, st);
    const done = await Promise.all([
      store.setToolOn("user-access", false),
      store.setToolOn("hierarchy", false),
      store.setToolOn("flow-usage", false),
    ]);
    assert.deepEqual(st.data[HIDDEN_KEY], ["user-access", "hierarchy", "flow-usage"]);
    assert.deepEqual(done[2], ["user-access", "hierarchy", "flow-usage"], "each save builds on the one before");
    assert.deepEqual(await store.getHidden(), ["user-access", "hierarchy", "flow-usage"]);
    const all = store.showAll(); // goes through the same queue
    const again = store.setToolOn("page-details", false);
    await Promise.all([all, again]);
    assert.deepEqual(st.data[HIDDEN_KEY], ["page-details"], "Show all tools runs in click order");
  });

  await test("settings store: on and off for the same tool, started together, ends in the last asked state", async () => {
    const st = slowStorage({ [HIDDEN_KEY]: ["hierarchy"] });
    const store = createSettingsStore(TOOLS, st);
    await Promise.all([
      store.setToolOn("hierarchy", true),
      store.setToolOn("hierarchy", false),
      store.setToolOn("hierarchy", true),
      store.setToolOn("record-access", false),
      store.setToolOn("record-access", true),
      store.setToolOn("record-access", false),
    ]);
    assert.deepEqual(st.data[HIDDEN_KEY], ["record-access"]);
  });

  await test("settings store: one failed save in the middle throws to its caller and loses nothing else", async () => {
    const st = slowStorage({}, { failSetOn: [2] });
    const store = createSettingsStore(TOOLS, st);
    const results = await Promise.allSettled([
      store.setToolOn("compare-groups", false),
      store.setToolOn("user-access", false), // this save fails
      store.setToolOn("flow-usage", false),
    ]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
    assert.deepEqual(st.data[HIDDEN_KEY], ["compare-groups", "flow-usage"], "the failed one is not stored, the others are");
    assert.deepEqual(await store.getHidden(), ["compare-groups", "flow-usage"]);
    await store.setToolOn("user-access", false); // the queue still works afterwards
    assert.deepEqual(st.data[HIDDEN_KEY], ["compare-groups", "user-access", "flow-usage"]);
  });

  // The page's behaviour (settings-logic.js) run for real over the real store and a slow fake storage.
  // `boxes` is what the person sees: a click sets a box at once, draw() sets them from a list.
  function rig({ failSetOn = [], initial = {} } = {}) {
    const raw = slowStorage(initial, { failSetOn });
    const log = [];
    const storage = {
      data: raw.data,
      get: (k) => raw.get(k),
      async set(o) { try { await raw.set(o); } finally { log.push("set-done"); } },
    };
    const store = createSettingsStore(TOOLS, storage);
    const boxes = Object.fromEntries(IDS.map((id) => [id, true]));
    const draws = [], says = [];
    const page = createSettingsPage(store, {
      draw(hidden) { draws.push([...hidden]); for (const id of IDS) boxes[id] = !hidden.includes(id); log.push("draw"); },
      say(text, bad) { says.push({ text, bad: !!bad }); log.push("say"); },
    });
    const pending = [];
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    return {
      st: storage, boxes, draws, says, log, page,
      async toggle(id, on, wait = 3) { boxes[id] = on; pending.push(page.toggle(id, on)); await pause(wait); },
      async showAll(wait = 3) { pending.push(page.showAll()); await pause(wait); },
      done: async () => { await Promise.all(pending); await pause(80); },
      shownHidden: () => IDS.filter((id) => !boxes[id]),
    };
  }
  const stored = (r) => r.st.data[HIDDEN_KEY] ?? [];

  await test("settings page: Show all tools, then two quick switches off: the boxes end as stored", async () => {
    const r = rig({ initial: { [HIDDEN_KEY]: ["hierarchy", "record-access", "compare-groups"] } });
    await r.showAll();
    await r.toggle("flow-usage", false);
    await r.toggle("page-details", false);
    await r.done();
    assert.deepEqual(stored(r), ["flow-usage", "page-details"]);
    assert.deepEqual(r.draws.at(-1), ["flow-usage", "page-details"]);
    assert.deepEqual(r.shownHidden(), ["flow-usage", "page-details"]);
    assert.deepEqual(r.says, [{ text: "Saved", bad: false }]);
  });

  await test("settings page: a switch, Show all tools, then another switch", async () => {
    const r = rig();
    await r.toggle("user-access", false);
    await r.showAll();
    await r.toggle("hierarchy", false);
    await r.done();
    assert.deepEqual(stored(r), ["hierarchy"]);
    assert.deepEqual(r.draws.at(-1), ["hierarchy"]);
    assert.deepEqual(r.shownHidden(), ["hierarchy"]);
    assert.equal(r.says.length, 1);
  });

  await test("settings page: quick on, off, on, off on the same switch ends as the last click", async () => {
    const r = rig();
    for (const on of [false, true, false, true, false]) await r.toggle("flow-usage", on, 2);
    await r.done();
    assert.deepEqual(stored(r), ["flow-usage"]);
    assert.deepEqual(r.draws.at(-1), ["flow-usage"]);
    assert.deepEqual(r.shownHidden(), ["flow-usage"]);
    const r2 = rig({ initial: { [HIDDEN_KEY]: ["flow-usage"] } });
    for (const on of [true, false, true]) await r2.toggle("flow-usage", on, 2);
    await r2.done();
    assert.deepEqual(stored(r2), []);
    assert.deepEqual(r2.shownHidden(), []);
  });

  await test("settings page: one save failing in the middle of a burst: boxes match storage, only the error is shown", async () => {
    const r = rig({ failSetOn: [2] });
    await r.toggle("compare-groups", false);
    await r.toggle("user-access", false); // this save fails
    await r.toggle("flow-usage", false);
    await r.done();
    assert.deepEqual(stored(r), ["compare-groups", "flow-usage"]);
    assert.deepEqual(r.draws.at(-1), stored(r));
    assert.deepEqual(r.shownHidden(), stored(r), "the box that failed is ticked again");
    assert.deepEqual(r.says, [{ text: "Could not save this change. Try again.", bad: true }]);
    // the next burst starts clean
    await r.toggle("page-details", false);
    await r.done();
    assert.deepEqual(r.says.at(-1), { text: "Saved", bad: false });
    assert.equal(r.says.length, 2);
  });

  await test("settings page: a save fails, a click lands while the final read is pending: the error is still said", async () => {
    const data = {};
    let sets = 0, gate = null, reached = null;
    const storage = {
      data,
      async get(key) {
        if (gate && sets >= 1) { const g = gate; gate = null; reached(); await g; }
        return key in data ? { [key]: [...data[key]] } : {};
      },
      async set(obj) { if (++sets === 1) throw new Error("no"); Object.assign(data, obj); },
    };
    const store = createSettingsStore(TOOLS, storage);
    const draws = [], says = [];
    const page = createSettingsPage(store, { draw: (h) => draws.push([...h]), say: (text, bad) => says.push({ text, bad: !!bad }) });
    let open;
    gate = new Promise((r) => { open = r; }); // used by the first read after the failed save
    const atGate = new Promise((r) => { reached = r; });
    const first = page.toggle("hierarchy", false); // its save fails; its final read waits at the gate
    await atGate;
    const second = page.toggle("user-access", false); // lands while that read is pending
    open();
    await Promise.all([first, second]);
    assert.deepEqual(says, [{ text: "Could not save this change. Try again.", bad: true }]);
    assert.deepEqual(data[HIDDEN_KEY], ["user-access"]);
    assert.deepEqual(draws.at(-1), data[HIDDEN_KEY]);
  });

  await test("settings page: a failing Show all tools shows the error and the stored list", async () => {
    const r = rig({ failSetOn: [1], initial: { [HIDDEN_KEY]: ["hierarchy"] } });
    await r.showAll();
    await r.done();
    assert.deepEqual(r.says, [{ text: "Could not save this change. Try again.", bad: true }]);
    assert.deepEqual(r.shownHidden(), ["hierarchy"]);
  });

  await test("settings page: Saved is said once, after the last save and the redraw, never earlier", async () => {
    const r = rig();
    await r.toggle("user-access", false, 5);
    await r.toggle("hierarchy", false, 5);
    await r.showAll(5);
    await r.toggle("flow-usage", false, 5);
    assert.deepEqual(r.says, [], "nothing is said while saves are still running");
    await r.done();
    assert.equal(r.says.length, 1);
    const sets = r.log.filter((x) => x === "set-done").length;
    assert.equal(sets, 4);
    const lastSet = r.log.lastIndexOf("set-done");
    assert.ok(r.log.indexOf("say") > lastSet, "Saved comes after the last save");
    assert.ok(r.log.indexOf("draw") > lastSet && r.log.indexOf("draw") < r.log.indexOf("say"), "the redraw comes before Saved");
    assert.equal(r.log.filter((x) => x === "draw").length, 1, "one redraw for the burst");
  });

  await test("settings page: outside the extension the status says the change is not kept", async () => {
    const store = createSettingsStore(TOOLS, null);
    const says = [];
    const page = createSettingsPage(store, { draw() {}, say: (t) => says.push(t) });
    await page.toggle("hierarchy", false);
    assert.equal(says.length, 1);
    assert.ok(says[0].includes("not kept") && !says[0].startsWith("Saved"));
  });

  await test("settings page: settings-logic.js has no DOM, no storage of its own and no imports", () => {
    const js = read("settings-logic.js").replace(/\/\/.*$/gm, "");
    assert.ok(!/document|window|chrome|import\s/.test(js));
  });

  await test("settings store: with no chrome.storage, all tools show and changes live in memory only", async () => {
    const keep = globalThis.chrome;
    delete globalThis.chrome;
    try {
      const store = createSettingsStore(TOOLS); // looks for the browser's storage, finds none
      assert.equal(store.persistent, false);
      assert.deepEqual(await store.getHidden(), []);
      await store.setToolOn("hierarchy", false);
      assert.deepEqual(await store.getHidden(), ["hierarchy"]);
      assert.deepEqual(await createSettingsStore(TOOLS, null).getHidden(), [], "another store does not see it");
      await store.showAll();
      assert.deepEqual(await store.getHidden(), []);
      globalThis.chrome = { storage: {} }; // an extension context with no local area
      assert.equal(createSettingsStore(TOOLS).persistent, false);
    } finally {
      if (keep === undefined) delete globalThis.chrome; else globalThis.chrome = keep;
    }
  });

  await test("settings store: uses chrome.storage.local when it is there", async () => {
    const keep = globalThis.chrome;
    const st = fakeStorage();
    globalThis.chrome = { storage: { local: st, sync: { get() { throw new Error("sync is never used"); }, set() { throw new Error("sync is never used"); } } } };
    try {
      const store = createSettingsStore(TOOLS);
      assert.equal(store.persistent, true);
      await store.setToolOn("page-details", false);
      assert.deepEqual(st.data, { hiddenTools: ["page-details"] });
    } finally {
      if (keep === undefined) delete globalThis.chrome; else globalThis.chrome = keep;
    }
  });

  await test("settings guard: shared/menu-settings.js is the only file that uses browser storage", () => {
    const users = [];
    for (const f of walkJs(ext())) {
      const text = read(f);
      if (/chrome\s*\??\.\s*storage|localStorage|sessionStorage|indexedDB/.test(text)) users.push(f);
    }
    assert.deepEqual(users, ["shared/menu-settings.js"]);
    const store = read("shared/menu-settings.js");
    assert.ok(!/localStorage|sessionStorage|indexedDB|storage\.session|storage\.managed/.test(store), "only the local area");
    assert.ok(/storage\?*\.local/.test(store), "uses the local area");
    for (const f of walkJs(ext())) assert.ok(!/storage\s*\??\.\s*sync/.test(read(f)), `${f} uses the sync area`);
    for (const f of ["settings.html", "manifest.json"]) assert.ok(!/storage\s*\??\.\s*sync/.test(read(f)), `${f} uses the sync area`);
  });

  await test("settings guard: the settings page and menu never use innerHTML or tools/ imports, and the store has no session id", () => {
    for (const f of ["settings.js", "settings-logic.js", "settings.html", "menu.js", "shared/menu-settings.js", "shared/tool-list.js"]) {
      const text = read(f);
      for (const bad of ["innerHTML", "insertAdjacentHTML", "outerHTML", "eval(", "document.write"]) assert.ok(!text.includes(bad), `${f} uses ${bad}`);
      assert.ok(!/from\s*["'][^"']*tools\//.test(text), `${f} imports from tools/`);
    }
    assert.ok(!/cookie|\bsid\b|sessionId|host/i.test(read("shared/menu-settings.js").replace(/\/\/.*$/gm, "")), "the store never touches session or host");
    assert.ok(read("settings.html").includes('href="shared/pack.css"'));
  });

  await test("settings: the manifest has the options page, the storage permission and version 0.8.0 or later", () => {
    const manifest = JSON.parse(read("manifest.json"));
    assert.ok(manifest.permissions.includes("storage"));
    assert.equal(manifest.options_ui.page, "settings.html");
    assert.equal(manifest.options_ui.open_in_tab, true);
    assert.ok(statSync(ext(manifest.options_ui.page)).isFile());
    const [maj, min] = manifest.version.split(".").map(Number);
    assert.ok(maj > 0 || min >= 8, manifest.version);
  });

  await test("settings: the menu waits for the setting, filters the list and links to Settings", () => {
    const js = read("menu.js");
    const html = read("menu.html");
    assert.ok(js.includes('from "./shared/tool-list.js"') && js.includes("visibleTools"));
    assert.ok(js.indexOf("await createSettingsStore") < js.indexOf("for (const tool of shown)"), "settings are read before any button is drawn");
    assert.ok(js.includes("chrome.runtime.openOptionsPage()") && js.includes('getURL("settings.html")'));
    assert.ok(js.includes("All tools are hidden"));
    assert.ok(/<a id="settings" href="settings.html">Settings<\/a>/.test(html));
  });

  await test("settings: the page has one labelled checkbox per tool, a Show all button and the note", () => {
    const html = read("settings.html");
    const js = read("settings.js");
    assert.ok(html.includes("<h1>Settings</h1>") && html.includes("Choose which tools show in the Salesforce Capability Pack menu."));
    assert.ok(html.includes("Show all tools") && html.includes("changes nothing in Salesforce"));
    assert.ok(js.includes('createElement("label")') && js.includes('box.type = "checkbox"'));
    assert.ok(read("settings-logic.js").includes('"Saved"') && read("settings-logic.js").includes("not kept"));
    assert.ok(js.includes("createSettingsPage") && js.includes("page.toggle") && js.includes("page.showAll"));
    assert.ok(!/store\.(setToolOn|showAll|setHidden)/.test(js), "the page goes through settings-logic.js");
    assert.ok(js.includes("TOOLS") && js.includes("tool.title") && js.includes("tool.description"));
  });
}
