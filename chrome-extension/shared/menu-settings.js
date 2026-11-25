// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Which tools show in the toolbar menu. This is the ONLY file in the extension that uses browser
// storage. It keeps one thing: `hiddenTools`, the ids of the tools the person turned off, in
// Chrome's local storage on this computer only (never synced, never sent anywhere). Nothing else is ever stored (no session id, host, org data or user names).
// Hidden tools are stored (not shown ones) so a tool added later is on by default.
// Outside the extension (the dev server) every tool shows and changes are kept in memory for the
// page session only. If a read fails, getHidden gives the last list read in this page session (or
// every tool on if none), and a switch change fails instead of saving over what could not be read.

export const HIDDEN_KEY = "hiddenTools";

// Keep only known tool ids, once each, in the tool list's order.
export function cleanHidden(list, tools) {
  const asked = new Set(Array.isArray(list) ? list.filter((x) => typeof x === "string") : []);
  return tools.map((t) => t.id).filter((id) => asked.has(id));
}

// The tools to draw in the menu: everything not hidden, same order. Unknown ids in `hidden` are ignored.
export function visibleTools(tools, hidden) {
  const off = new Set(cleanHidden(hidden, tools));
  return tools.filter((t) => !off.has(t.id));
}

function browserStorage() {
  try { return globalThis.chrome?.storage?.local || null; } catch { return null; }
}

// `storage` can be a fake for tests: { get(key) -> {key: value}, set({key: value}) }, promise based.
// Pass null for "no storage". Leave it out to use the browser's.
export function createSettingsStore(tools, storage = browserStorage()) {
  let memory = [];
  // Every read and save runs one after another, so quick changes each build on the one before.
  // A failed job rejects for its own caller only; the queue carries on.
  let tail = Promise.resolve();
  const queued = (job) => {
    const run = tail.then(job);
    tail = run.catch(() => {});
    return run;
  };
  // Strict read: throws if the browser cannot be read. Saves use this, so a list is never built
  // from a failed read.
  async function readStrict() {
    if (!storage) return cleanHidden(memory, tools);
    const got = await storage.get(HIDDEN_KEY);
    memory = cleanHidden(got?.[HIDDEN_KEY], tools);
    return [...memory];
  }
  // Never throws. On a failed read it gives the last list read or saved in this page session,
  // or [] (every tool shows) if there is none.
  async function read() {
    try { return await readStrict(); } catch { return [...memory]; }
  }
  async function write(ids) {
    const clean = cleanHidden(ids, tools);
    if (storage) await storage.set({ [HIDDEN_KEY]: clean });
    memory = clean;
    return [...clean];
  }
  const store = {
    persistent: !!storage,
    getHidden() { return queued(read); },
    // Saves the list. Throws if the browser refuses; the stored value then stays as it was.
    setHidden(ids) { return queued(() => write(ids)); },
    // Throws (and stores nothing) if the current list cannot be read.
    setToolOn(id, on) {
      return queued(async () => {
        const hidden = new Set(await readStrict());
        if (on) hidden.delete(id); else hidden.add(id);
        return write([...hidden]);
      });
    },
    showAll() { return queued(() => write([])); },
  };
  return store;
}
