# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Read and write Salesforce metadata XML without losing a carriage return that belongs to a value.

A retrieve writes its files with LF line endings, so a raw CR in a retrieved file is TEXT, for
example a help text stored with a CRLF line break. Two things lose it:
  - the XML parser folds every CR / CRLF into LF, so the value is read without its CR;
  - ElementTree's file writer opens the file in text mode, so on Windows it writes CRLF line
    endings everywhere, which Salesforce folds back to LF.
If every check compares parsed XML on both sides, the loss is invisible to all of them, and the
deploy silently rewrites the existing value without its CR.

This module:
  - parse(path): reads a raw CR as &#13;, which the parser keeps. A file is refused unless EVERY
    carriage return in it (raw, or written as &#13; / &#xD;) ends up inside a leaf value or inside
    an XML comment, so CRLF line endings, or a CR between elements, stop the run instead of being
    guessed at. The rule is: CRs in the file = CRs in leaf values + CRs in comments. Salesforce
    writes an untranslated item's English source as a comment; the parser drops comments and
    they are never written back, so a CR inside one is harmless. Comments are found by the XML
    parser itself (not by a text search), so a "<!--" inside a CDATA section or text cannot hide a CR;
  - write_xml(root, path): UTF-8, LF line endings only, every CR in the text written as &#13;.

Use these two functions for every read and write of a translation file.
"""
import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path

NS_URI = "http://soap.sforce.com/2006/04/metadata"
ET.register_namespace("", NS_URI)
_CR_REF = re.compile(rb"&#(?:13|x0*[dD]);")


class _CommentTarget(ET.TreeBuilder):
    """Normal tree builder that also records the text of every comment (the tree gets none)."""

    def __init__(self):
        super().__init__()
        self.comments = []

    def comment(self, text):
        self.comments.append(text)


class CRError(SystemExit):
    """A file whose carriage returns cannot be attributed to values."""


def parse(path):
    """ElementTree of `path`, with every carriage return inside a value kept."""
    data = Path(path).read_bytes()
    crs = data.count(b"\r") + len(_CR_REF.findall(data))
    try:
        target = _CommentTarget()
        parser = ET.XMLParser(target=target)
        parser.feed(data.replace(b"\r", b"&#13;"))
        root = parser.close()
    except ET.ParseError as e:
        if b"\r" not in data:
            raise
        raise CRError(f"{path}: carriage return(s) outside the document's values "
                      f"(CRLF line endings around the declaration or after the root?) - {e}. Stop.")
    in_values = sum((e.text or "").count("\r") for e in root.iter() if len(e) == 0)
    # A raw CR in a comment reads as the text "&#13;" (comments keep references unexpanded); a
    # reference written in the comment reads as itself. Both are counted like the file total.
    in_comments = sum(len(_CR_REF.findall(c.encode("utf-8"))) for c in target.comments)
    if in_values + in_comments != crs:
        raise CRError(f"{path}: {crs} carriage return(s) in the file but {in_values} inside values - "
                      f"CRLF line endings or a CR between elements; a CR in a value cannot be told apart. Stop.")
    return ET.ElementTree(root)


def write_xml(root, path):
    """Write an element (or tree) as UTF-8 with LF line endings; a CR in any text becomes &#13;."""
    root = root.getroot() if hasattr(root, "getroot") else root
    body = ET.tostring(root, encoding="unicode").replace("\r", "&#13;")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b'<?xml version="1.0" encoding="UTF-8"?>\n' + body.encode("utf-8") + b"\n")


if __name__ == "__main__":
    print(__doc__)
