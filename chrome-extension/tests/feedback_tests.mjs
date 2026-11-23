// Offline tests for the report-a-bug links. Called from run_tests.mjs with its shared `test` function.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { TOOLS } from "../shared/tool-list.js";
import { issueUrl, REPO_URL, FEEDBACK_TOOLS, browserName, versionText } from "../shared/feedback.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = (...p) => path.join(here, "..", ...p);
const root = (...p) => path.join(here, "../..", ...p);
const read = (f) => readFileSync(f, "utf-8");

export async function run(test) {
  await test("feedback: bug link uses bug.yml with tool and version", () => {
    const u = new URL(issueUrl({ kind: "bug", tool: FEEDBACK_TOOLS.psg, version: "Extension 0.8.0, Chrome 131" }));
    assert.equal(`${u.origin}${u.pathname}`, `${REPO_URL}/issues/new`);
    assert.equal(u.searchParams.get("template"), "bug.yml");
    assert.equal(u.searchParams.get("tool"), "Compare permission set groups (extension)");
    assert.equal(u.searchParams.get("version"), "Extension 0.8.0, Chrome 131");
  });

  await test("feedback: enhancement link uses enhancement.yml", () => {
    const u = new URL(issueUrl({ kind: "enhancement", tool: FEEDBACK_TOOLS.access, version: "v" }));
    assert.equal(u.searchParams.get("template"), "enhancement.yml");
    assert.equal(u.searchParams.get("tool"), "User access summary and comparison (extension)");
  });

  await test("feedback: output is encoded and unknown kinds are refused", () => {
    const url = issueUrl({ kind: "bug", tool: FEEDBACK_TOOLS.menu, version: "a&b=c #1" });
    assert.ok(!/ |#1/.test(url));
    assert.equal(new URL(url).searchParams.get("version"), "a&b=c #1");
    assert.equal(new URL(url).searchParams.get("tool"), "Extension menu / other");
    assert.throws(() => issueUrl({ kind: "other" }));
  });

  await test("feedback: only whitelisted keys go in, never a host or org", () => {
    const url = issueUrl({ kind: "bug", tool: FEEDBACK_TOOLS.psg, version: "v", host: "acme.my.salesforce.com", org: "Acme", url: "https://acme.lightning.force.com/x", user: "a@b.c" });
    const keys = [...new URL(url).searchParams.keys()].sort();
    assert.deepEqual(keys, ["template", "tool", "version"]);
    assert.ok(!/acme|salesforce\.com|force\.com/i.test(url));
  });

  await test("feedback: browser and version text are short", () => {
    assert.equal(browserName({ userAgentData: { brands: [{ brand: "Not A Brand", version: "8" }, { brand: "Google Chrome", version: "131.0.1" }] } }), "Chrome 131");
    const chromeFirst = [{ brand: "Chromium", version: "131" }, { brand: "Not A Brand", version: "8" }, { brand: "Google Chrome", version: "131.0.1" }];
    assert.equal(browserName({ userAgentData: { brands: chromeFirst } }), "Chrome 131");
    const edgeLast = [{ brand: "Chromium", version: "130" }, { brand: "Google Chrome", version: "130" }, { brand: "Microsoft Edge", version: "130.0.2" }];
    assert.equal(browserName({ userAgentData: { brands: edgeLast } }), "Edge 130");
    assert.equal(browserName({ userAgentData: { brands: [{ brand: "Chromium", version: "129" }] } }), "Chromium 129");
    assert.equal(browserName({ userAgent: "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0" }), "Edge 130");
    assert.equal(browserName({ userAgent: "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36" }), "Chrome 130");
    assert.equal(browserName({}), "unknown browser");
    assert.equal(versionText("0.8.0", { userAgent: "Chrome/131.0" }), "Extension 0.8.0, Chrome 131");
    assert.equal(versionText("", { userAgent: "Chrome/131.0" }), "Extension dev server, Chrome 131");
  });

  await test("feedback: the files use no innerHTML, localStorage, chrome.storage or fetch", () => {
    for (const f of ["shared/feedback.js", "menu.js", "menu.html", "tools/compare-groups/compare-groups.js", "tools/user-access/user-access.js", "tools/hierarchy/hierarchy.js", "tools/record-access/record-access.js", "tools/flow-usage/flow-usage.js", "tools/compare-groups/compare-groups.html", "tools/user-access/user-access.html", "tools/hierarchy/hierarchy.html", "tools/record-access/record-access.html", "tools/flow-usage/flow-usage.html"]) {
      const text = read(ext(f));
      for (const bad of ["innerHTML", "insertAdjacentHTML", "outerHTML", "localStorage", "chrome.storage"]) assert.ok(!text.includes(bad), `${f} uses ${bad}`);
    }
    assert.ok(!/\bfetch\s*\(/.test(read(ext("shared/feedback.js"))));
    assert.ok(!/\bfetch\s*\(/.test(read(ext("menu.js"))));
  });

  await test("feedback: popup footer has two real links and a version taken from the manifest", () => {
    const html = read(ext("menu.html"));
    const js = read(ext("menu.js"));
    assert.ok(/<a id="report-bug" href=/.test(html) && /<a id="suggest" href=/.test(html));
    assert.ok(!html.includes("Found a problem"));
    assert.ok(html.includes('id="version"'));
    assert.ok(js.includes("chrome.runtime.getManifest().version"));
    assert.ok(js.includes('getElementById("version").textContent = manifestVersion ? `v${manifestVersion}` : "dev"'));
    assert.ok(js.includes("event.preventDefault()"));
    assert.ok(/^\d+\.\d+\.\d+/.test(JSON.parse(read(ext("manifest.json"))).version));
  });

  await test("feedback: manifest has no github host permission", () => {
    const m = JSON.parse(read(ext("manifest.json")));
    assert.ok(!JSON.stringify(m.host_permissions).includes("github"));
  });

  await test("feedback: labels match the tool names in the toolbar menu", () => {
    const keyToId = { psg: "compare-groups", access: "user-access", hierarchy: "hierarchy", record: "record-access", flows: "flow-usage", snapshot: "page-details" };
    for (const [key, id] of Object.entries(keyToId)) {
      const tool = TOOLS.find((t) => t.id === id);
      assert.ok(tool, `no tool ${id}`);
      assert.equal(FEEDBACK_TOOLS[key], `${tool.title} (extension)`, key);
    }
    const labels = Object.values(FEEDBACK_TOOLS);
    for (const t of TOOLS) assert.ok(labels.includes(`${t.title} (extension)`), `no feedback label for tool ${t.id}`);
  });

  await test("feedback: issue forms carry the field ids and dropdown labels the link sends", () => {
    for (const f of ["bug.yml", "enhancement.yml"]) {
      const y = read(root(".github/ISSUE_TEMPLATE", f));
      assert.ok(/^ {4}id: tool\r?$/m.test(y) && /^ {4}id: version\r?$/m.test(y), `${f} ids`);
      for (const label of Object.values(FEEDBACK_TOOLS)) assert.ok(y.replace(/\r\n/g, "\n").includes(`- ${label}\n`), `${f} option ${label}`);
    }
    assert.ok(/^ {4}id: what-happened\r?$/m.test(read(root(".github/ISSUE_TEMPLATE/bug.yml"))));
    assert.ok(/^ {4}id: idea\r?$/m.test(read(root(".github/ISSUE_TEMPLATE/enhancement.yml"))));
  });

  await test("feedback: every extension script parses and imports do not clash with own declarations", () => {
    const files = ["menu.js", "tools/compare-groups/compare-groups.js", "tools/user-access/user-access.js", "tools/hierarchy/hierarchy.js", "tools/record-access/record-access.js", "tools/flow-usage/flow-usage.js"].map((f) => ext(f));
    for (const f of readdirSync(ext("shared"))) if (f.endsWith(".js")) files.push(ext("shared", f));
    for (const t of readdirSync(ext("tools"))) for (const f of readdirSync(ext("tools", t))) if (f.endsWith(".js")) files.push(ext("tools", t, f));
    for (const f of files) {
      // --check parses ES modules too; a name both imported and declared fails here.
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    }
    for (const f of ["menu.js", "tools/compare-groups/compare-groups.js", "tools/user-access/user-access.js", "tools/hierarchy/hierarchy.js", "tools/record-access/record-access.js", "tools/flow-usage/flow-usage.js"]) {
      const text = read(ext(f));
      const imported = [];
      for (const m of text.matchAll(/^import\s*\{([^}]*)\}/gm)) {
        for (const part of m[1].split(",")) {
          const n = part.trim().split(/\s+as\s+/).pop();
          if (n) imported.push(n);
        }
      }
      for (const n of imported) {
        assert.ok(!new RegExp(`^(?:const|let|var|function|class)\\s+${n}\\b`, "m").test(text), `${f}: imported ${n} is also declared`);
      }
    }
  });
  await test("start-up: every tool page script still starts itself, live-reloads and wires its feedback links", () => {
    const tools = readdirSync(ext("tools"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    assert.ok(tools.length >= 6);
    for (const t of tools) {
      const f = ext("tools", t, `${t}.js`);
      const text = read(f);
      // A top-level (unindented) start-up call: connect(); or start()... (the page's own entry point).
      assert.ok(/^(?:connect|start)\(.*\);\s*$/m.test(text), `${t}.js has no top-level connect() or start() call`);
      assert.ok(/^startLiveReload\(\);\s*$/m.test(text), `${t}.js has no top-level startLiveReload() call`);
      assert.ok(/\$\("#feedback"\)\.replaceChildren\(/.test(text), `${t}.js does not wire the feedback links`);
    }
  });
}
