// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

import { TOOLS } from "./shared/tool-list.js";
import { createSettingsStore } from "./shared/menu-settings.js";

import { createSettingsPage } from "./settings-logic.js";

const store = createSettingsStore(TOOLS);
const list = document.getElementById("tools");
const status = document.getElementById("status");
const boxes = new Map();

function say(text, bad) {
  status.textContent = text;
  status.className = bad ? "bad" : "";
}

function draw(hidden) {
  const off = new Set(hidden);
  for (const [id, box] of boxes) box.checked = !off.has(id);
}

const page = createSettingsPage(store, { draw, say });

if (!store.persistent) document.getElementById("notkept").hidden = false;

for (const tool of TOOLS) {
  const li = document.createElement("li");
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.addEventListener("change", () => { page.toggle(tool.id, box.checked); });
  const text = document.createElement("span");
  const title = document.createElement("span");
  title.className = "tool-title";
  title.textContent = tool.title;
  const desc = document.createElement("span");
  desc.className = "tool-desc";
  desc.textContent = tool.description;
  text.append(title, desc);
  label.append(box, text);
  li.append(label);
  list.append(li);
  boxes.set(tool.id, box);
}

await page.load();

document.getElementById("show-all").addEventListener("click", () => { page.showAll(); });
