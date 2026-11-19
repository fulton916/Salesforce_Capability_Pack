"""Shared helpers for the territory scripts in this package.

- running a SOQL query through the Salesforce CLI (`sf data query --json`)
- saving / loading query results as JSON files (the same shape `sf data query --json` prints)
- choosing a territory model and walking the territory hierarchy
- small Excel helpers
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from collections import defaultdict
from pathlib import Path

# File keys used in a JSON folder. Each file is `<key>.json` holding sf's --json output.
KEY_MODELS = "models"
KEY_TERRITORIES = "territories"
KEY_RULES = "rules"
KEY_RULE_ITEMS = "rule_items"
KEY_RULE_TERRITORIES = "rule_territories"
KEY_USER_TERRITORIES = "user_territories"
KEY_OBJECT_COUNTS = "object_territory_counts"
KEY_OBJECT_DETAIL = "object_territories"

# Access level codes -> what Setup shows.
ACCOUNT_ACCESS = {"Read": "Read Only", "Edit": "Read/Write", "All": "Owner"}
OTHER_ACCESS = {"None": "Private", "Read": "Read Only", "Edit": "Read/Write"}


class TerritoryError(Exception):
    """A problem the user can fix: bad argument, missing file, failed query."""


# ---------------------------------------------------------------- sf CLI

def sf_executable() -> str:
    exe = shutil.which("sf")
    if not exe:
        raise TerritoryError("Salesforce CLI 'sf' was not found on PATH.")
    return exe


def run_query(org: str | None, soql: str) -> dict:
    """Run one SOQL query; return sf's parsed --json output (status 0) or raise."""
    cmd = [sf_executable(), "data", "query", "--query", soql, "--json"]
    if org:
        cmd += ["--target-org", org]
    proc = subprocess.run(cmd, capture_output=True)
    out = proc.stdout.decode("utf-8-sig", "replace")
    if "{" not in out:
        raise TerritoryError(f"sf returned no JSON: {proc.stderr.decode('utf-8', 'replace')[:300]}")
    data = json.loads(out[out.index("{"):])
    if data.get("status") != 0:
        raise TerritoryError(data.get("message") or out[:300])
    return data


def records_of(payload: dict) -> list[dict]:
    return payload.get("result", {}).get("records", []) or []


def truncation_note(payload: dict) -> str:
    r = payload.get("result", {})
    got, total = len(r.get("records") or []), r.get("totalSize", 0)
    if total and got < total:
        return f"TRUNCATED: {got} of {total} (raise the limit: sf config set org-max-query-limit=<n>)"
    return ""


def soql_literal(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


# ---------------------------------------------------------------- JSON folders

def save_payload(folder: Path, key: str, payload: dict) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{key}.json").write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")


def load_payload(folder: Path, key: str, required: bool = True) -> dict | None:
    path = folder / f"{key}.json"
    if not path.is_file():
        if required:
            raise TerritoryError(f"{path} not found. Run territory_export.py with --save-json first.")
        return None
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if data.get("status") not in (0, None):
        raise TerritoryError(f"{path} holds a failed query: {data.get('message')}")
    return data


def load_records(folder: Path, key: str, required: bool = True) -> list[dict]:
    payload = load_payload(folder, key, required)
    return records_of(payload) if payload else []


# ---------------------------------------------------------------- flattening

ILLEGAL_XLSX = re.compile(r"[\000-\010]|[\013-\014]|[\016-\037]")


def flatten(rec: dict, prefix: str = "") -> dict:
    """Drop `attributes`; turn relationship objects into dotted columns (UserRole.Name)."""
    row = {}
    for k, v in rec.items():
        if k == "attributes":
            continue
        if isinstance(v, dict) and "attributes" in v:
            row.update(flatten(v, f"{prefix}{k}."))
        else:
            row[f"{prefix}{k}"] = v
    return row


def cell_value(v):
    """Make a value safe for an Excel cell. Strings stay strings (leading zeros survive)."""
    if isinstance(v, (dict, list)):
        v = json.dumps(v, ensure_ascii=False)
    if isinstance(v, str):
        v = ILLEGAL_XLSX.sub("", v)[:32000]
    return v


def nested(rec: dict, dotted: str, default=""):
    cur = rec
    for part in dotted.split("."):
        if not isinstance(cur, dict):
            return default
        cur = cur.get(part)
    return default if cur is None else cur


# ---------------------------------------------------------------- model + hierarchy

def choose_model(models: list[dict], wanted: str | None) -> dict:
    """Pick a model by Id / DeveloperName / Name, or the Active one when `wanted` is None."""
    if wanted:
        hits = [m for m in models if wanted in (m.get("Id"), m.get("DeveloperName"), m.get("Name"))]
        if len(hits) != 1:
            names = ", ".join(f"{m.get('Name')} ({m.get('DeveloperName')}, {m.get('State')})" for m in models)
            raise TerritoryError(f"Model {wanted!r} matched {len(hits)} models. Models in the org: {names or 'none'}")
        return hits[0]
    active = [m for m in models if m.get("State") == "Active"]
    if len(active) != 1:
        names = ", ".join(f"{m.get('Name')} ({m.get('State')})" for m in models)
        raise TerritoryError(
            f"{len(active)} active territory models found; pass --model or --all-models. Models: {names or 'none'}"
        )
    return active[0]


def find_territory(territories: list[dict], wanted: str) -> dict:
    hits = [t for t in territories if t.get("Id") == wanted or t.get("DeveloperName") == wanted]
    if not hits:
        hits = [t for t in territories if t.get("Name") == wanted]
    if len(hits) != 1:
        detail = ", ".join(t.get("DeveloperName", "?") for t in hits)
        raise TerritoryError(
            f"Territory {wanted!r} matched {len(hits)} territories{': ' + detail if detail else ''}. "
            "Use the DeveloperName to pick one."
        )
    return hits[0]


def hierarchy(territories: list[dict], root: str | None = None) -> list[tuple[dict, int]]:
    """Depth-first [(territory, level)], children sorted by Name then DeveloperName.

    With `root`, only that territory and everything below it (root is level 0).
    Without it, every top-level territory is a level-0 start point.
    """
    by_id = {t["Id"]: t for t in territories}
    kids = defaultdict(list)
    for t in territories:
        parent = t.get("ParentTerritory2Id")
        kids[parent if parent in by_id else None].append(t)
    for v in kids.values():
        v.sort(key=lambda t: (t.get("Name") or "", t.get("DeveloperName") or ""))

    starts = [find_territory(territories, root)] if root else kids[None]
    out: list[tuple[dict, int]] = []
    stack = [(t, 0) for t in reversed(starts)]
    while stack:
        t, lvl = stack.pop()
        out.append((t, lvl))
        stack.extend((k, lvl + 1) for k in reversed(kids[t["Id"]]))
    return out


def ancestors(territory: dict, by_id: dict) -> list[dict]:
    """[top, ..., parent, territory]."""
    chain, cur, seen = [], territory, set()
    while cur and cur["Id"] not in seen:
        seen.add(cur["Id"])
        chain.append(cur)
        cur = by_id.get(cur.get("ParentTerritory2Id"))
    return list(reversed(chain))


def path_of(territory: dict, by_id: dict, stop_id: str | None = None) -> str:
    chain = ancestors(territory, by_id)
    if stop_id:
        ids = [t["Id"] for t in chain]
        if stop_id in ids:
            chain = chain[ids.index(stop_id):]
    return " > ".join(t.get("Name", "") for t in chain)


def parse_labeled_dirs(values: list[str] | None) -> list[tuple[str, Path]]:
    """`LABEL=DIR` pairs from --compare."""
    out = []
    for v in values or []:
        if "=" not in v:
            raise TerritoryError(f"--compare expects LABEL=FOLDER, got {v!r}")
        label, folder = v.split("=", 1)
        path = Path(folder).expanduser()
        if not path.is_dir():
            raise TerritoryError(f"--compare folder not found: {path}")
        out.append((label.strip(), path))
    return out


# ---------------------------------------------------------------- Excel helpers

def style_header(ws, row: int = 1, fill_hex: str = "1F4E78"):
    from openpyxl.styles import Alignment, Font, PatternFill
    fill = PatternFill("solid", fgColor=fill_hex)
    for cell in ws[row]:
        cell.fill = fill
        cell.font = Font(bold=True, color="FFFFFF")
        cell.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")


def set_widths(ws, widths: list[int]):
    from openpyxl.utils import get_column_letter
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
