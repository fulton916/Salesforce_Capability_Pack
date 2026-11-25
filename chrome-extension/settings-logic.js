// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// What the Settings page does when a switch or "Show all tools" is used. Pure: no DOM, no storage of its own.
// `store` is a settings store (shared/menu-settings.js); `ui` is { draw(hiddenIds), say(text, bad) }.
//
// Rule: while saves are in flight the boxes show what the person clicked. When the LAST in-flight save
// finishes (worked or failed), every box is redrawn from store.getHidden() (queued behind the saves, so it
// is what is stored) and only then one status is shown: "Saved" if every save in that burst worked,
// otherwise the plain error. Nothing says "Saved" while a save is still running.

export const SAVE_ERROR = "Could not save this change. Try again.";

export function createSettingsPage(store, ui) {
  let inFlight = 0;   // saves started and not finished
  let failed = false; // a save failed since the last status was said
  let latest = 0;     // the newest settle(); older ones say nothing

  const savedText = () => (store.persistent ? "Saved" : "Changed (not kept: this page is not in the extension)");

  async function settle() {
    const mine = ++latest;
    let hidden = null;
    try { hidden = await store.getHidden(); } catch { /* keep what is shown */ }
    if (inFlight > 0 || mine !== latest) return; // the person clicked again meanwhile; a later burst will redraw and say its status
    // `failed` is cleared only here, once a status is actually said, so an error is never lost.
    const bad = failed;
    failed = false;
    if (hidden) ui.draw(hidden);
    if (bad) ui.say(SAVE_ERROR, true); else ui.say(savedText());
  }

  async function save(job) {
    inFlight++;
    try { await job(); } catch { failed = true; }
    inFlight--;
    if (inFlight === 0) await settle();
  }

  return {
    // Show the stored state (first draw).
    async load() { ui.draw(await store.getHidden()); },
    toggle(id, on) { return save(() => store.setToolOn(id, on)); },
    showAll() { return save(() => store.showAll()); },
  };
}
