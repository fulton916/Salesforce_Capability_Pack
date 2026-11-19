// Offline tests for the report-a-bug links. Called from run_tests.mjs with its shared `test` function.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { issueUrl, REPO_URL, FEEDBACK_TOOLS, browserName, versionText } from "../extension/lib/feedback.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = (...p) => path.join(here, "../extension", ...p);
const root = (...p) => path.join(here, "../..", ...p);
const read = (f) => readFileSync(f, "utf-8");

export async function run(test) {
  await test("feedback: bug link uses bug.yml with tool and version", () => {
    const u = new URL(issueUrl({ kind: "bug", tool: FEEDBACK_TOOLS.psg, version: "Extension 0.2.0, Chrome 131" }));
    assert.equal(`${u.origin}${u.pathname}`, `${REPO_URL}/issues/new`);
    assert.equal(u.searchParams.get("template"), "bug.yml");
    assert.equal(u.searchParams.get("tool"), "PSG Compare (extension)");
    assert.equal(u.searchParams.get("version"), "Extension 0.2.0, Chrome 131");
  });

  await test("feedback: enhancement link uses enhancement.yml", () => {
    const u = new URL(issueUrl({ kind: "enhancement", tool: FEEDBACK_TOOLS.access, version: "v" }));
    assert.equal(u.searchParams.get("template"), "enhancement.yml");
    assert.equal(u.searchParams.get("tool"), "User access (extension)");
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
    assert.equal(versionText("0.2.0", { userAgent: "Chrome/131.0" }), "Extension 0.2.0, Chrome 131");
    assert.equal(versionText("", { userAgent: "Chrome/131.0" }), "Extension dev server, Chrome 131");
  });

  await test("feedback: the files use no innerHTML, localStorage, chrome.storage or fetch", () => {
    for (const f of ["lib/feedback.js", "popup.js", "popup.html", "psg-compare.js", "user-access.js", "psg-compare.html", "user-access.html"]) {
      const text = read(ext(f));
      for (const bad of ["innerHTML", "insertAdjacentHTML", "outerHTML", "localStorage", "chrome.storage"]) assert.ok(!text.includes(bad), `${f} uses ${bad}`);
    }
    assert.ok(!/\bfetch\s*\(/.test(read(ext("lib/feedback.js"))));
    assert.ok(!/\bfetch\s*\(/.test(read(ext("popup.js"))));
  });

  await test("feedback: manifest has no github host permission", () => {
    const m = JSON.parse(read(ext("manifest.json")));
    assert.ok(!JSON.stringify(m.host_permissions).includes("github"));
  });

  await test("feedback: issue forms carry the field ids and dropdown labels the link sends", () => {
    for (const f of ["bug.yml", "enhancement.yml"]) {
      const y = read(root(".github/ISSUE_TEMPLATE", f));
      assert.ok(/^ {4}id: tool\r?$/m.test(y) && /^ {4}id: version\r?$/m.test(y), `${f} ids`);
      for (const label of Object.values(FEEDBACK_TOOLS)) assert.ok(y.includes(`- ${label}\n`), `${f} option ${label}`);
    }
    assert.ok(/^ {4}id: what-happened\r?$/m.test(read(root(".github/ISSUE_TEMPLATE/bug.yml"))));
    assert.ok(/^ {4}id: idea\r?$/m.test(read(root(".github/ISSUE_TEMPLATE/enhancement.yml"))));
  });

  await test("feedback: every extension script parses and imports do not clash with own declarations", () => {
    const files = ["popup.js", "psg-compare.js", "user-access.js"].map((f) => ext(f));
    for (const f of readdirSync(ext("lib"))) if (f.endsWith(".js")) files.push(ext("lib", f));
    for (const f of files) {
      // --check parses ES modules too; a name both imported and declared fails here.
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    }
    for (const f of ["popup.js", "psg-compare.js", "user-access.js"]) {
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
}
