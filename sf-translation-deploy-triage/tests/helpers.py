"""Shared test helpers: synthetic deploy results, translation CSVs, describes."""
from __future__ import annotations

import csv
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

COLS = ["file", "type", "component", "field", "masterLabel", "source", "translation",
        "gender", "startsWith"]


def _b2c(b: int) -> str:
    try:
        return bytes([b]).decode("cp1252")
    except UnicodeDecodeError:
        return chr(b)


def moji(s: str) -> str:
    """UTF-8 bytes read as cp1252: the classic mojibake."""
    return "".join(_b2c(b) for b in s.encode("utf-8"))


def run(script: str, *args) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPTS / script), *map(str, args)],
                          capture_output=True, text=True, encoding="utf-8")


def write_csv(path: Path, rows: list[dict], cols: list[str] = COLS) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in cols})
    return path


def read_csv(path: Path) -> list[dict]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def pick(lang, obj, fld, label, tr, src=None):
    return {"file": f"objectTranslations/{obj}-{lang}/{fld}.fieldTranslation-meta.xml",
            "type": "field-picklist", "component": obj, "field": fld, "masterLabel": label,
            "source": src or label, "translation": tr}


def flabel(lang, obj, fld, src, tr, typ="field-label"):
    return {"file": f"objectTranslations/{obj}-{lang}/{fld}.fieldTranslation-meta.xml",
            "type": typ, "component": obj, "field": fld, "source": src, "translation": tr}


def rtype(lang, obj, name, src, tr):
    return {"file": f"objectTranslations/{obj}-{lang}/{obj}-{lang}.objectTranslation-meta.xml",
            "type": "record-type", "component": obj, "field": name, "source": src, "translation": tr}


def fail(full, problem, ctype="CustomObjectTranslation"):
    return {"fullName": full, "componentType": ctype, "problem": problem, "problemType": "Error"}


def deploy_json(path: Path, failures: list[dict], successes: list[str] = (),
                status: str = "SucceededPartial", bom: bool = True, warning: bool = False) -> Path:
    doc = {"status": 0 if status == "Succeeded" else 1, "result": {
        "status": status, "numberComponentsTotal": len(failures) + len(successes),
        "numberComponentsDeployed": len(successes),
        "details": {"componentFailures": failures,
                    "componentSuccesses": [{"fullName": s, "componentType": "CustomObjectTranslation"}
                                           for s in successes]}}}
    text = json.dumps(doc, ensure_ascii=False)
    if warning:
        text = json.dumps({"warning": "a newer CLI version is available"}) + "\n" + text
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8"))
    return path


def describe(path: Path, obj: str, fields: dict[str, tuple[str, list[tuple[str, str]]]]) -> Path:
    """fields: {api name: (label, [(value, label), ...])}"""
    res = {"name": obj, "fields": [
        {"name": n, "label": lab, "picklistValues": [{"value": v, "label": l} for v, l in pv]}
        for n, (lab, pv) in fields.items()]}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"status": 0, "result": res}), encoding="utf-8")
    return path


def sheet(path: Path, name: str) -> list[dict]:
    import openpyxl
    from triage_common import sheet_rows
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    return sheet_rows(wb[name])[1]
