// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// The dev server only forwards /services/data/ paths (GitHub issue 72). This starts the real server with
// --no-org on a free port and sends raw requests: a bad path must get 403 before the "no org" 503.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(here, "..");

function findPython() {
  for (const cmd of ["python3", "python"]) {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf-8" });
    if (!r.error && r.status === 0) return cmd;
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Sends the path exactly as given (no normalising), with a Host header the server accepts. */
function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET", headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function waitUntilUp(port, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`The dev server stopped at start (exit ${child.exitCode}).`);
    try {
      if ((await get(port, "/__version")) === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("The dev server did not answer within 10 seconds.");
}

export async function run(test) {
  console.log("dev server");

  await test("the dev server refuses paths outside /services/data/ (dot segments, encoded or not) before forwarding", async () => {
    const py = findPython();
    assert.ok(py, "No working Python found (tried python3 and python). This test needs one to start dev/dev_server.py.");
    const port = await freePort();
    const child = spawn(py, [path.join(ext, "dev", "dev_server.py"), "--no-org", "--port", String(port)], {
      stdio: "ignore",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    try {
      await waitUntilUp(port, child);
      const bad = [
        "/sf/services/data/../../secur/x",
        "/sf2/services/data/../../secur/x",
        "/sf/services/data/%2e%2e/%2e%2e/secur/x",
        "/sf/services/data/%2E%2e/x",
        "/sf/services/data/.%2e/x",
        "/sf/services/data/%2e./x",
        "/sf/services/data/v67.0/./x",
        "/sf/services/data/..%2fsecur",
        "/sf/services/data/..%2Fsecur",
        "/sf/services/data/v67.0%5c..%5cx",
        "/sf/services/data/v67.0\\x",
        "/sf/services/data/%252e%252e/x",
        "/sf/services/data/../../secur/x?q=1",
        "/sf/secur/x",
        "/sf2/secur/x",
        "/sf/services/data/%2e%2e;/x",
        "/sf/services/data/..;/x",
        "/sf/services/data/v67.0;a=b/x",
        "/sf/services/data/%u002e%u002e/x",
      ];
      for (const p of bad) assert.equal(await get(port, p), 403, p);
      const good = [
        "/sf/services/data/v67.0/query?q=SELECT+Id+FROM+Account+WHERE+Name+%3D+%27..%27",
        "/sf/services/data/v67.0/query?q=..%2f..",
        "/sf/services/data/v67.0/query?q=SELECT+Id+FROM+Account+WHERE+Name+%3D+%27a%3Bb%27",
        "/sf/services/data/v67.0/query?q=a;b",
        "/sf2/services/data/",
        "/sf/services/data/v67.0/sobjects/Account/describe/",
      ];
      for (const p of good) assert.equal(await get(port, p), 503, p); // passes the path check; no org
      assert.equal(await get(port, "/tools/compare-groups/compare-groups.html"), 200);
    } finally {
      child.kill();
    }
    assert.ok(!existsSync(path.join(ext, "dev", "__pycache__")), "dev/__pycache__ was created");
  });
}
