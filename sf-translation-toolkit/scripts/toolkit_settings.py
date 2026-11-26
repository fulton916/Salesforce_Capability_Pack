# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Project settings and shared helpers for the translation toolkit.

Settings live in settings.json, one folder above this script. Every key is optional;
missing keys fall back to the defaults below.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

SETTINGS_PATH = Path(__file__).resolve().parent.parent / "settings.json"

_DEFAULTS = {
    "api_version": "67.0",
    "probe_language": "ja",
    "banner_to_populate": "To Populate",
    "standard_object_labels": {},
    "standard_value_sets": {},
    "extra_languages": {},
}


def _load() -> dict:
    out = dict(_DEFAULTS)
    if SETTINGS_PATH.is_file():
        try:
            raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8-sig"))
        except ValueError as exc:
            sys.exit(f"error: {SETTINGS_PATH} is not valid JSON: {exc}")
        out.update({k: v for k, v in raw.items() if not k.startswith("_")})
    return out


SETTINGS = _load()

API_VERSION = str(SETTINGS["api_version"])          # "67.0" (one version for all orgs; settings.json can change it)
API_PATH = f"v{API_VERSION}"                         # "v67.0", for REST URLs
PROBE_LANG = str(SETTINGS["probe_language"])
BANNER_TO_POPULATE = str(SETTINGS["banner_to_populate"])
STANDARD_OBJECT_LABELS = {k: tuple(v) for k, v in SETTINGS["standard_object_labels"].items()}
STANDARD_VALUE_SETS = dict(SETTINGS["standard_value_sets"])

# Banner text every reader recognises: the fixed banners, the configured one, and the
# default wording (so a workbook built before the setting was changed still reads).
BANNER_TEXTS = {"do not edit", "required", BANNER_TO_POPULATE.lower(), "to populate"}


def sf_executable() -> str:
    """Full path of the Salesforce CLI. On Windows it is sf.cmd, which a plain "sf" in
    subprocess (without a shell) cannot find."""
    return shutil.which("sf") or shutil.which("sf.cmd") or "sf"
