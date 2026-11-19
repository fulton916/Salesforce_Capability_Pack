#!/usr/bin/env python3
"""Local dev server for sf-psg-compare.

Two jobs, both for development only:

1. Run the compare page against a real org with no extension reloads.
   Open http://127.0.0.1:8765/psg-compare.html?dev=1 . The page sends its API calls to /sf/...,
   and this server forwards them to the org with the login the Salesforce CLI already holds
   (`sf org display`). The access token stays in this process; the page never sees it.
   Only GET requests are forwarded, so the page can read the org but cannot change it.

2. Live reload. /__version changes whenever a file under extension/ changes. The page polls it
   and reloads itself, both here and in an unpacked copy of the extension loaded in Chrome
   (unpacked extensions read their pages from disk, so no "Reload" click is needed for
   page/JS/CSS edits; manifest.json changes still need one).

Usage:
    python tools/dev_server.py                      # sf default org
    python tools/dev_server.py --target-org my-sbx  # a specific org alias
    python tools/dev_server.py --no-org             # pages and demo only, no org

Listens on 127.0.0.1 only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

EXT = Path(__file__).resolve().parent.parent / "extension"
SF = shutil.which("sf") or shutil.which("sf.cmd") or "sf"
ANSI = re.compile(r"\x1b\[[0-9;]*m")


class OrgLogin:
    """Access token and instance URL from the Salesforce CLI. Refreshed on a 401."""

    def __init__(self, alias: str | None):
        self.alias = alias
        self.lock = threading.Lock()
        self.token = None
        self.instance = None
        self.refresh()

    def _sf(self, *args: str) -> dict:
        cmd = [SF, *args, "--json"]
        if self.alias:
            cmd += ["--target-org", self.alias]
        env = {**os.environ, "NO_COLOR": "1", "FORCE_COLOR": "0", "SF_DISABLE_LOG_FILE": "true"}
        out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", env=env, shell=sys.platform == "win32")
        try:
            data = json.loads(ANSI.sub("", out.stdout))
        except json.JSONDecodeError:
            # Never echo the output: it may hold a token.
            sys.exit(f"`sf {' '.join(args)}` did not return JSON (exit {out.returncode}).")
        if data.get("status") != 0:
            sys.exit(f"`sf {' '.join(args)}` failed: {data.get('message')}\nLog in first: sf org login web --alias <alias>")
        return data["result"]

    def refresh(self) -> None:
        info = self._sf("org", "display")
        token = info.get("accessToken", "")
        # Newer CLI versions redact the token in `org display`; ask for it explicitly.
        if not token or " " in token or "REDACTED" in token:
            token = self._sf("org", "auth", "show-access-token")["accessToken"]
        with self.lock:
            self.token = token
            self.instance = info["instanceUrl"].rstrip("/")
        print(f"Org: {info.get('username')} at {self.instance}")


def tree_version() -> str:
    h = hashlib.sha1()
    for p in sorted(EXT.rglob("*")):
        if p.is_file():
            st = p.stat()
            h.update(f"{p.relative_to(EXT)}:{st.st_mtime_ns}:{st.st_size}".encode())
    return h.hexdigest()[:12]


def make_handler(login: OrgLogin | None, port: int):
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(BaseHTTPRequestHandler):
        server_version = "psg-compare-dev"

        def log_message(self, fmt, *args):  # quieter: one line per API call only
            if self.path.startswith("/sf/"):
                sys.stderr.write(f"  {self.command} {urlsplit(self.path).path[3:80]}\n")

        def send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def refuse(self, code: int, msg: str):
            self.send(code, json.dumps([{"message": msg, "errorCode": "DEV_SERVER"}]).encode(), "application/json")

        def do_GET(self):
            # Block DNS-rebinding: only answer requests addressed to this machine.
            if self.headers.get("Host") not in allowed_hosts:
                return self.refuse(403, "Host not allowed")
            path = urlsplit(self.path).path
            if path == "/__version":
                return self.send(200, json.dumps({"v": tree_version()}).encode(), "application/json",
                                 {"Access-Control-Allow-Origin": "*"})
            if path.startswith("/sf/"):
                return self.proxy(self.path[3:])
            return self.static(path)

        def do_POST(self):
            self.refuse(405, "Read-only dev server: only GET is forwarded")

        do_PUT = do_PATCH = do_DELETE = do_POST

        def static(self, path: str):
            rel = path.lstrip("/") or "psg-compare.html"
            target = (EXT / rel).resolve()
            if EXT not in target.parents and target != EXT or not target.is_file():
                return self.send(404, b"Not found", "text/plain")
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if target.suffix == ".js":
                ctype = "text/javascript"
            self.send(200, target.read_bytes(), ctype)

        def proxy(self, api_path: str):
            if login is None:
                return self.refuse(503, "Dev server started with --no-org")
            if not api_path.startswith("/services/data/"):
                return self.refuse(403, "Only /services/data/ is forwarded")
            for attempt in (1, 2):
                req = urllib.request.Request(login.instance + api_path, headers={
                    "Authorization": f"Bearer {login.token}", "Accept": "application/json"})
                try:
                    with urllib.request.urlopen(req, timeout=120) as res:
                        return self.send(res.status, res.read(), res.headers.get("Content-Type", "application/json"))
                except urllib.error.HTTPError as e:
                    if e.code == 401 and attempt == 1:
                        login.refresh()  # the CLI renews an expired token
                        continue
                    return self.send(e.code, e.read(), e.headers.get("Content-Type", "application/json"))
                except urllib.error.URLError as e:
                    return self.refuse(502, f"Could not reach the org: {e.reason}")

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-o", "--target-org", help="sf org alias or username (default: the sf default org)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-org", action="store_true", help="serve pages only; no org connection")
    a = ap.parse_args()

    login = None if a.no_org else OrgLogin(a.target_org)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(login, a.port))
    print(f"Live org:  http://127.0.0.1:{a.port}/psg-compare.html?dev=1")
    print(f"Demo:      http://127.0.0.1:{a.port}/psg-compare.html?demo=1")
    print("Read-only: only GET requests are forwarded. Ctrl+C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
