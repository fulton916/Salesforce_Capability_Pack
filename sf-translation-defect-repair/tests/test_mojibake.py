# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

import unittest

from helpers import moji

import mojibake as M


class Detection(unittest.TestCase):
    def test_classic_patterns_are_found(self):
        for clean in ("Crème", "Open – pending review", "Pre‑Assembled", "naïve café",
                      "Grüße", "Zürich", "“quoted”", "Ελληνικά", "日本語", "emoji 😀"):
            with self.subTest(clean=clean):
                bad = moji(clean)
                self.assertTrue(M.is_mojibake(bad), bad)
                self.assertEqual(M.inspect(bad).status, "repairable")
                self.assertEqual(M.repair(bad), clean)

    def test_clean_text_is_not_flagged(self):
        for s in ("Crème", "Prix 10 €", "« Bonjour »", "São Paulo", "Größe 5°C",
                  "Café ½ prix", "Ångström", "Łódź", "Привет", "plain ascii", "",
                  "¿Qué tal?", "naïve — déjà vu"):
            with self.subTest(s=s):
                self.assertFalse(M.is_mojibake(s), s)
                self.assertEqual(M.inspect(s).status, "clean")
                self.assertEqual(M.repair(s), "")

    def test_double_encoding_is_undone(self):
        self.assertEqual(M.repair(moji(moji("Crème"))), "Crème")

    def test_mixed_clean_and_damaged_text(self):
        # A whole-string re-encode fails here; the run-by-run repair does not.
        s = "Café " + moji("– é")
        self.assertEqual(M.repair(s), "Café – é")

    def test_c1_control_from_latin1_reader(self):
        # 'Á' is C3 81; 0x81 is undefined in cp1252 and shows as U+0081.
        bad = moji("Árvore")
        self.assertIn("\x81", bad)
        self.assertEqual(M.repair(bad), "Árvore")

    def test_euro_is_suspect_option(self):
        self.assertFalse(M.is_mojibake("Price 5 €"))
        self.assertTrue(M.is_mojibake("Price 5 €", euro_is_suspect=True))


class DamagedRuns(unittest.TestCase):
    def test_lower_cased_lead_is_restored(self):
        bad = moji("Crème").replace("Ã", "ã")
        f = M.inspect(bad)
        self.assertEqual(f.status, "damaged")
        self.assertEqual(f.repaired, "Crème")

    def test_autocorrected_byte_needs_reference(self):
        # The third byte of the non-breaking hyphen was turned into a straight quote.
        bad = "Vorâ€'montiert"
        self.assertEqual(M.inspect(bad).status, "damaged")
        self.assertEqual(M.repair(bad), "")                      # no reference: no guess
        self.assertEqual(M.repair(bad, reference="Pre‑Assembled"), "Vor‑montiert")

    def test_spaced_damage_uses_reference_spacing(self):
        self.assertEqual(M.repair("Open â € “ pending", reference="Open – pending review"),
                         "Open – pending")

    def test_refuses_when_position_unknown(self):
        # The run is at the end: no way to know where the dash belonged.
        self.assertEqual(M.repair("Crème brûlée â€", reference="Open – pending"), "")

    def test_refuses_when_reference_is_ambiguous(self):
        self.assertEqual(M.repair("Aâ€'B", reference="A – B — C"), "")


class Cli(unittest.TestCase):
    def test_exit_codes(self):
        self.assertEqual(M.main(["clean text"]), 0)
        self.assertEqual(M.main([moji("Crème")]), 1)


if __name__ == "__main__":
    unittest.main()
