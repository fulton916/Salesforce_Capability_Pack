#!/usr/bin/env python3
# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Export a Salesforce org's State and Country/Territory picklists to Excel.

The script retrieves the org's Address settings (metadata type Settings, member
Address) with the Salesforce CLI, parses Address.settings-meta.xml, and writes one
row per state (or one row per country that has no states) to a formatted workbook.

Columns: country label, ISO code, integration value, active, visible, Salesforce
standard, org default; then the same for the state.

Retrieval is read-only. By default it runs in a throwaway temporary project, so a
local force-app folder is never overwritten.

Examples:
    python export_country_state_codes.py --target-org my-sandbox
    python export_country_state_codes.py                      # uses the sf default org
    python export_country_state_codes.py --skip-retrieve --xml-path Address.settings-meta.xml
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

DEFAULT_XML = Path("force-app/main/default/settings/Address.settings-meta.xml")
DEFAULT_OUTPUT = "Country_State_Codes.xlsx"

COUNTRY_FIELDS = [
    ("Country", "label"),
    ("Country Code", "isoCode"),
    ("Country Integration Value", "integrationValue"),
    ("Country Active", "active"),
    ("Country Visible", "visible"),
    ("Country Salesforce Standard", "standard"),
    ("Country Org Default", "orgDefault"),
]
STATE_FIELDS = [
    ("State", "label"),
    ("State Code", "isoCode"),
    ("State Integration Value", "integrationValue"),
    ("State Active", "active"),
    ("State Visible", "visible"),
    ("State Salesforce Standard", "standard"),
]
HEADERS = [h for h, _ in COUNTRY_FIELDS] + [h for h, _ in STATE_FIELDS]

MAX_WIDTHS = {
    "Country": 30, "Country Code": 14, "Country Integration Value": 30,
    "Country Active": 16, "Country Visible": 16, "Country Salesforce Standard": 24,
    "Country Org Default": 20, "State": 34, "State Code": 14,
    "State Integration Value": 34, "State Active": 14, "State Visible": 14,
    "State Salesforce Standard": 24,
}

MINIMAL_PROJECT = {
    "packageDirectories": [{"path": "force-app", "default": True}],
    "name": "address-settings-retrieve",
    "namespace": "",
}


class ExportError(Exception):
    """A problem the user can fix (missing file, bad XML, CLI failure)."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Retrieve the org's State and Country/Territory picklists (Address settings) "
            "and export them to a formatted Excel workbook."
        ),
        epilog=__doc__.split("Examples:", 1)[1] if "Examples:" in __doc__ else None,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "-o", "--target-org",
        help="sf org alias or username. If omitted, the sf CLI default target org is used.",
    )
    parser.add_argument(
        "--project-dir", type=Path,
        help=(
            "Existing Salesforce DX project to retrieve into (must hold sfdx-project.json). "
            "If omitted, a temporary project is used and deleted afterwards."
        ),
    )
    parser.add_argument(
        "--output", type=Path, default=Path(DEFAULT_OUTPUT),
        help=f"Output workbook path (default: {DEFAULT_OUTPUT} in the current folder).",
    )
    parser.add_argument(
        "--xml-path", type=Path,
        help="Path to an Address.settings-meta.xml to read (skips the search).",
    )
    parser.add_argument(
        "--skip-retrieve", action="store_true",
        help="Do not call the Salesforce CLI; read an already-retrieved XML (needs --xml-path or --project-dir).",
    )
    parser.add_argument(
        "--api-version",
        help="Optional API version for the retrieve (e.g. 67.0). Default: the CLI's choice.",
    )
    return parser.parse_args(argv)


# ---------------------------------------------------------------- retrieve

def make_temp_project() -> Path:
    project = Path(tempfile.mkdtemp(prefix="address-settings-"))
    (project / "force-app").mkdir()
    (project / "sfdx-project.json").write_text(json.dumps(MINIMAL_PROJECT, indent=2), encoding="utf-8")
    return project


def build_retrieve_command(sf_command: str, org: str | None, api_version: str | None) -> list[str]:
    command = [sf_command, "project", "retrieve", "start", "--metadata", "Settings:Address", "--json"]
    if org:
        command += ["--target-org", org]
    if api_version:
        command += ["--api-version", api_version]
    return command


def retrieve_address_settings(project_dir: Path, org: str | None, api_version: str | None) -> None:
    if not (project_dir / "sfdx-project.json").is_file():
        raise ExportError(
            f"{project_dir} is not a Salesforce DX project (sfdx-project.json not found). "
            "Leave out --project-dir to use a temporary project."
        )
    sf_command = shutil.which("sf")
    if not sf_command:
        raise ExportError("Salesforce CLI command 'sf' was not found on PATH.")

    print(f'Retrieving Address settings from {org and repr(org) or "the sf default org"}...')
    result = subprocess.run(
        build_retrieve_command(sf_command, org, api_version),
        cwd=project_dir, capture_output=True, text=True,
        encoding="utf-8", errors="replace", check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        try:
            payload = json.loads(result.stdout[result.stdout.index("{"):])
            detail = payload.get("message") or payload.get("name") or detail
        except (ValueError, TypeError):
            pass
        raise ExportError(f"Salesforce metadata retrieval failed.\n{detail}")
    print("Retrieve completed.")


def resolve_xml_path(project_dir: Path | None, requested: Path | None) -> Path:
    if requested:
        path = requested if requested.is_absolute() or project_dir is None else project_dir / requested
        if not path.is_file():
            raise ExportError(f"Address settings XML not found at {path}.")
        return path
    if project_dir is None:
        raise ExportError("Give --xml-path (or --project-dir) when using --skip-retrieve.")
    expected = project_dir / DEFAULT_XML
    if expected.is_file():
        return expected
    matches = sorted(project_dir.glob("**/settings/Address.settings-meta.xml"))
    if not matches:
        raise ExportError(
            "Address.settings-meta.xml was not found. Use --xml-path if it is stored elsewhere."
        )
    if len(matches) > 1:
        print(f"Several Address settings files found; using {matches[0]}.")
    return matches[0]


# ---------------------------------------------------------------- parse

def parse_address_settings(xml_path: Path) -> list[dict[str, str]]:
    """Return one dict per state (or per state-less country), sorted by country then state."""
    try:
        root = ET.parse(xml_path).getroot()
    except ET.ParseError as exc:
        raise ExportError(f"The Address settings XML could not be parsed: {exc}") from exc

    namespace = root.tag[1:].partition("}")[0] if root.tag.startswith("{") else ""

    def q(name: str) -> str:
        return f"{{{namespace}}}{name}" if namespace else name

    def text(element: ET.Element, name: str) -> str:
        child = element.find(q(name))
        return "" if child is None or child.text is None else child.text.strip()

    container = root.find(q("countriesAndStates"))
    if container is None:
        raise ExportError("The XML has no countriesAndStates section.")

    rows: list[dict[str, str]] = []
    for country in container.findall(q("countries")):
        base = {header: text(country, tag) for header, tag in COUNTRY_FIELDS}
        states = country.findall(q("states"))
        if not states:
            rows.append({**base, **{header: "" for header, _ in STATE_FIELDS}})
            continue
        for state in states:
            rows.append({**base, **{header: text(state, tag) for header, tag in STATE_FIELDS}})

    if not rows:
        raise ExportError("No countries were found in the Address settings XML.")
    rows.sort(key=lambda r: (r["Country"].casefold(), r["State"].casefold()))
    return rows


def summarize(rows: list[dict[str, str]]) -> dict[str, int]:
    countries = {r["Country Code"] for r in rows}
    active = {r["Country Code"] for r in rows if r["Country Active"] == "true"}
    return {
        "countries": len(countries),
        "active_countries": len(active),
        "states": sum(1 for r in rows if r["State"]),
        "active_states": sum(1 for r in rows if r["State"] and r["State Active"] == "true"),
    }


# ---------------------------------------------------------------- workbook

def export_workbook(rows: list[dict[str, str]], output_path: Path) -> None:
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.worksheet.table import Table, TableStyleInfo
    except ImportError as exc:
        raise ExportError("openpyxl is not installed. Run: python -m pip install -r requirements.txt") from exc

    output_path.parent.mkdir(parents=True, exist_ok=True)
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Country_State_Codes"
    sheet.append(HEADERS)
    for row in rows:
        sheet.append([row[h] for h in HEADERS])

    fill = PatternFill("solid", fgColor="1F4E78")
    for cell in sheet[1]:
        cell.fill = fill
        cell.font = Font(color="FFFFFF", bold=True)
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    sheet.freeze_panes = "A2"
    sheet.row_dimensions[1].height = 32

    for col, header in enumerate(HEADERS, start=1):
        width = max(len(str(sheet.cell(r, col).value or "")) for r in range(1, sheet.max_row + 1))
        sheet.column_dimensions[sheet.cell(1, col).column_letter].width = min(
            max(width + 2, 12), MAX_WIDTHS.get(header, 30)
        )

    table = Table(displayName="CountryStateCodes", ref=sheet.dimensions)
    table.tableStyleInfo = TableStyleInfo(
        name="TableStyleMedium2", showFirstColumn=False, showLastColumn=False,
        showRowStripes=True, showColumnStripes=False,
    )
    sheet.add_table(table)

    try:
        workbook.save(output_path)
    except PermissionError as exc:
        raise ExportError(f"Could not save {output_path}. Close it in Excel and try again.") from exc


# ---------------------------------------------------------------- main

def run(args: argparse.Namespace) -> Path:
    project_dir = args.project_dir.expanduser().resolve() if args.project_dir else None
    temp_project = None
    try:
        if not args.skip_retrieve:
            if project_dir is None:
                temp_project = project_dir = make_temp_project()
            retrieve_address_settings(project_dir, args.target_org, args.api_version)
        xml_path = resolve_xml_path(project_dir, args.xml_path)
        rows = parse_address_settings(xml_path)
        output_path = args.output.expanduser().resolve()
        export_workbook(rows, output_path)
    finally:
        if temp_project is not None:
            shutil.rmtree(temp_project, ignore_errors=True)

    s = summarize(rows)
    print(f"Created: {output_path}")
    print(
        f"Exported {s['countries']} countries ({s['active_countries']} active) and "
        f"{s['states']} states/territories ({s['active_states']} active)."
    )
    return output_path


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        run(args)
    except ExportError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
