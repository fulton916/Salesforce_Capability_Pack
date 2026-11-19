#!/usr/bin/env python3
"""Keep the carriage returns that are part of a translation when reading or writing XML.

A retrieve writes metadata files with LF line endings, so a raw CR inside a retrieved file
is TEXT: for example a help text stored with a CRLF line break. Two standard behaviours
lose it without any error:

  - The XML parser normalises every CR and CRLF to LF (XML spec, end-of-line handling),
    so the value is read without its CR.
  - ElementTree's file writer opens the file in text mode, so on Windows it writes CRLF
    line endings everywhere, which Salesforce folds back to LF.

Any check that compares parsed XML on both sides cannot see the loss, because both sides
were parsed the same lossy way.

This module:
  parse(path)          reads a file so a raw CR survives (it is turned into &#13;, which the
                       parser keeps). The file is REFUSED (ValueError) unless every CR in it,
                       raw or written as &#13; / &#xD;, ends up inside a leaf value. So CRLF
                       line endings, or a CR between elements, stop the run instead of being
                       guessed at.
  write_xml(el, path)  writes UTF-8 with LF line endings only, every CR in text as &#13;.
  install()            optional: patch xml.etree.ElementTree.parse(<path>) process-wide,
                       for code you cannot change. ET.parse(<file object>), ET.iterparse and
                       ET.ElementTree(file=...) are NOT covered.

CLI:
  python crsafe.py check <dir-or-file> [...]
      Lists every .xml / metadata file whose carriage returns are not all inside values
      (it would be refused) and counts the CRs that are text. Exit 1 if any is refused.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

NS = "http://soap.sforce.com/2006/04/metadata"
ET.register_namespace("", NS)

_orig_parse = ET.parse
_CR_REF = re.compile(rb"&#(?:13|x0*[dD]);")


def parse(source, parser=None) -> ET.ElementTree:
    """Parse a file path keeping every CR that is part of a value. See module docstring."""
    if not isinstance(source, (str, bytes, os.PathLike)):
        return _orig_parse(source, parser)
    data = Path(os.fsdecode(source)).read_bytes()
    crs = data.count(b"\r") + len(_CR_REF.findall(data))
    try:
        root = ET.fromstring(data.replace(b"\r", b"&#13;"), parser)
    except ET.ParseError as e:
        if b"\r" not in data:
            raise
        raise ValueError(f"{os.fsdecode(source)}: carriage return(s) outside the document's "
                         f"values (CRLF line endings around the declaration or root?) - {e}") from e
    in_values = sum((e.text or "").count("\r") for e in root.iter() if len(e) == 0)
    if in_values != crs:
        raise ValueError(f"{os.fsdecode(source)}: {crs} carriage return(s) in the file but "
                         f"{in_values} inside values - CRLF line endings or a CR between "
                         "elements; a CR that is text cannot be told apart. Fix the line "
                         "endings (or re-retrieve) before going on.")
    return ET.ElementTree(root)


def write_xml(root, path, indent: str | None = None) -> None:
    """Write an element or tree as UTF-8, LF line endings, every CR in text as &#13;.

    indent: optional ElementTree.indent() spacing (e.g. '    '). Indenting only touches
    whitespace between elements, never a value.
    """
    root = root.getroot() if hasattr(root, "getroot") else root
    if indent is not None:
        ET.indent(root, space=indent)
    body = ET.tostring(root, encoding="unicode").replace("\r", "&#13;")
    with open(path, "wb") as f:
        f.write(b'<?xml version="1.0" encoding="UTF-8"?>\n' + body.encode("utf-8") + b"\n")


def install() -> None:
    """Patch ET.parse process-wide so every ET.parse(<path>) is CR-safe."""
    ET.parse = parse


def content_crs(root: ET.Element) -> int:
    return sum((e.text or "").count("\r") for e in root.iter())


_METADATA_SUFFIXES = (".xml", "Translation", ".translation", ".labels", ".stf")


def check(paths: list[str]) -> int:
    files: list[Path] = []
    for p in map(Path, paths):
        if p.is_dir():
            files += [f for f in p.rglob("*") if f.is_file()
                      and f.name.endswith(_METADATA_SUFFIXES) and not f.name.endswith(".stf")]
        elif p.is_file():
            files.append(p)
    refused = with_cr = total_cr = 0
    for f in sorted(files):
        try:
            n = content_crs(parse(f).getroot())
        except ValueError as e:
            refused += 1
            print(f"REFUSED  {e}")
            continue
        except ET.ParseError as e:
            refused += 1
            print(f"BAD XML  {f}: {e}")
            continue
        if n:
            with_cr += 1
            total_cr += n
            print(f"keeps {n:3} CR(s) in values  {f}")
    print(f"\n{len(files)} file(s) checked: {with_cr} carry {total_cr} carriage return(s) "
          f"as text, {refused} refused")
    return 1 if refused else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check", help="report files whose CRs are not all inside values")
    c.add_argument("paths", nargs="+")
    for _s in (sys.stdout, sys.stderr):
        if hasattr(_s, "reconfigure"):
            _s.reconfigure(encoding="utf-8", errors="replace")
    a = ap.parse_args(argv)
    return check(a.paths)


if __name__ == "__main__":
    sys.exit(main())
