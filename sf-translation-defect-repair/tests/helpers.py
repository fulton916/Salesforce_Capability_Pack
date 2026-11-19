"""Shared test helpers: paths, synthetic fixtures, running a script as a subprocess."""
from __future__ import annotations

import csv
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

COLS = ["file", "type", "component", "field", "masterLabel", "source", "translation", "gender"]


def _b2c(b: int) -> str:
    try:
        return bytes([b]).decode("cp1252")
    except UnicodeDecodeError:
        return chr(b)        # bytes cp1252 leaves undefined come out as C1 controls


def moji(s: str) -> str:
    """Make mojibake the classic way: UTF-8 bytes read as cp1252."""
    return "".join(_b2c(b) for b in s.encode("utf-8"))


def run(script: str, *args: str) -> subprocess.CompletedProcess:
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


def gv(lang: str, vs: str, label: str, tr: str) -> dict:
    return {"file": f"globalValueSetTranslations/{vs}-{lang}.globalValueSetTranslation-meta.xml",
            "type": "global-value", "component": vs, "field": "", "masterLabel": label,
            "source": label, "translation": tr}


def pick(lang: str, obj: str, fld: str, label: str, tr: str) -> dict:
    return {"file": f"objectTranslations/{obj}-{lang}/{fld}.fieldTranslation-meta.xml",
            "type": "field-picklist", "component": obj, "field": fld, "masterLabel": label,
            "source": label, "translation": tr}


STF_HEADER = ("# Bilingual export (synthetic)\n# Lines that begin with the # symbol are ignored.\n\n"
              "Language code: {lang}\nType: Bilingual\nTranslation type: Metadata\n\n")


def write_bilingual(path: Path, lang: str, translated: list[tuple[str, str, str]],
                    untranslated: list[tuple[str, str]] = ()) -> Path:
    lines = [STF_HEADER.format(lang=lang), "------------------TRANSLATED-------------------\n\n",
             "# KEY\tLABEL\tTRANSLATION\tOUT OF DATE\n\n"]
    lines += [f"{k}\t{lab}\t{tr}\t-\n" for k, lab, tr in translated]
    lines += ["\n------------------OUTDATED AND UNTRANSLATED-----------------\n\n",
              "# KEY\tLABEL\n\n"]
    lines += [f"{k}\t{lab}\n" for k, lab in untranslated]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes("".join(lines).encode("utf-8"))
    return path
