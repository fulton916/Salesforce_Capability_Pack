#!/usr/bin/env python3
"""Run every offline test: python tests/run_tests.py

No org is contacted. Every `sf` call is replaced by a stub or a saved snapshot.
"""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.discover(str(HERE), pattern="test_*.py", top_level_dir=str(HERE))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print(f"\nRan {result.testsRun} tests: {len(result.failures)} failures, "
          f"{len(result.errors)} errors, {len(result.skipped)} skipped")
    sys.exit(0 if result.wasSuccessful() else 1)
