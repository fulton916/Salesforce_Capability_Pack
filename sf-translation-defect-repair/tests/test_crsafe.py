# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Planted-CR tests: the plain ElementTree path loses a CR that is text; crsafe keeps it."""
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

import helpers  # noqa: F401  (puts scripts/ on sys.path)
import crsafe

CR, LF = b"\r", b"\n"
FIELD = (b'<?xml version="1.0" encoding="UTF-8"?>\n'
         b'<CustomObjectTranslation xmlns="http://soap.sforce.com/2006/04/metadata">\n'
         b'    <fields>\n        <help>line one' + CR + LF + b'line two</help>\n'
         b'        <name>Color__c</name>\n    </fields>\n</CustomObjectTranslation>\n')


class CrSafe(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.src = self.tmp / "Widget__c-xx.objectTranslation"
        self.src.write_bytes(FIELD)

    def test_plain_elementtree_loses_the_cr(self):
        # Run in a fresh process so nothing from crsafe is loaded.
        code = textwrap.dedent(r'''
            import sys, xml.etree.ElementTree as ET
            t = ET.parse(sys.argv[1])
            print(sum((e.text or "").count("\r") for e in t.iter()))
        ''')
        r = subprocess.run([sys.executable, "-I", "-c", code, str(self.src)],
                           capture_output=True, text=True)
        self.assertEqual(r.stdout.strip(), "0", "the defect must be real for the test to mean anything")

    def test_parse_and_write_keep_the_cr(self):
        root = crsafe.parse(self.src).getroot()
        self.assertEqual(crsafe.content_crs(root), 1)
        out = self.tmp / "out.xml"
        crsafe.write_xml(root, out)
        data = out.read_bytes()
        self.assertNotIn(CR, data, "output must be LF-only")
        self.assertEqual(data.count(b"&#13;"), 1)
        again = crsafe.parse(out).getroot()
        self.assertEqual([e.text for e in again.iter() if e.text and "\r" in e.text],
                         ["line one\r\nline two"])
        self.assertIn(b'xmlns="http://soap.sforce.com/2006/04/metadata"', data)

    def test_indent_does_not_touch_values(self):
        root = crsafe.parse(self.src).getroot()
        out = self.tmp / "ind.xml"
        crsafe.write_xml(root, out, indent="  ")
        self.assertEqual(crsafe.content_crs(crsafe.parse(out).getroot()), 1)

    def _refused(self, data: bytes) -> bool:
        p = self.tmp / "x.xml"
        p.write_bytes(data)
        try:
            crsafe.parse(p)
            return False
        except ValueError:
            return True

    def test_crlf_line_endings_are_refused(self):
        self.assertTrue(self._refused(b'<?xml version="1.0"?>' + CR + LF + b"<a>" + CR + LF +
                                      b"  <b>x</b>" + CR + LF + b"</a>" + CR + LF))

    def test_two_line_crlf_file_is_refused(self):
        self.assertTrue(self._refused(b'<?xml version="1.0"?>' + CR + LF + b"<a><b>x</b></a>" + CR + LF))

    def test_cr_between_elements_is_refused(self):
        self.assertTrue(self._refused(b'<?xml version="1.0"?>\n<a>\n  <b>x</b>' + CR + LF +
                                      b"  <c>y</c>\n</a>\n"))

    def test_cr_reference_is_accepted(self):
        p = self.tmp / "ref.xml"
        p.write_bytes(b'<?xml version="1.0"?>\n<a>\n  <b>one&#13;\ntwo</b>\n</a>\n')
        self.assertEqual([e.text for e in crsafe.parse(p).iter() if e.text and "\r" in e.text],
                         ["one\r\ntwo"])

    def test_check_cli(self):
        self.assertEqual(crsafe.main(["check", str(self.tmp)]), 0)
        (self.tmp / "bad.xml").write_bytes(b"<a>" + CR + LF + b"<b>x</b>" + CR + LF + b"</a>")
        self.assertEqual(crsafe.main(["check", str(self.tmp)]), 1)


if __name__ == "__main__":
    unittest.main()
