#!/usr/bin/env python3
"""Detect and repair mojibake: UTF-8 text that was read as Windows-1252 (or Latin-1).

The classic damage: a UTF-8 file is opened as cp1252, every multi-byte character turns
into two to four Latin-1 / cp1252 characters, and the result is saved again as UTF-8.

    'é'  (C3 A9)     -> 'Ã©'
    '–'  (E2 80 93)  -> 'â€“'
    '‑'  (E2 80 91)  -> 'â€‘'
    ' '  (C2 A0)     -> 'Â '

Three levels of damage are handled:

  repairable  The bytes are intact. Re-encoding the run as cp1252 and decoding it as UTF-8
              gives the original character. Exact, no guessing. Repeated passes undo
              double encoding.
  damaged     Something touched the text after the damage (spell-check, autocorrect,
              re-typing). A byte was changed or replaced, so no decode recovers it:
              'â€'' with a straight quote, 'â € “' with spaces, 'ã§' with a lower-cased
              lead. Detected, and repaired only when a clean reference text (the English
              source) pins the missing character down.
  clean       Nothing found.

A repair is accepted only when the result is fully clean. A half-repair is worse than
none, because it looks fixed.

Detection is pattern based and works on any text. False positives are rare but possible:
a Latin-1 letter written directly before a symbol such as « » ° ± (for example 'Â°' in a
real sentence) looks exactly like damage. Review findings before deploying a repair.

CLI (for a quick check):
    python mojibake.py "CafÃ©"               -> prints the verdict and the repair
    python mojibake.py --file notes.txt      -> checks every line of a file
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass

# ── Byte <-> character tables ────────────────────────────────────────────────


def _byte_char(b: int) -> str:
    """How a cp1252 reader shows byte b. Bytes cp1252 leaves undefined (0x81, 0x8D,
    0x8F, 0x90, 0x9D) come out as the C1 control of the same value, as Latin-1 does."""
    try:
        return bytes([b]).decode("cp1252")
    except UnicodeDecodeError:
        return chr(b)


CHAR_TO_BYTE: dict[str, int] = {}
for _b in range(256):
    CHAR_TO_BYTE.setdefault(_byte_char(_b), _b)
for _b in range(0x80, 0xA0):          # Latin-1 readers show 0x80-0x9F as C1 controls
    CHAR_TO_BYTE.setdefault(chr(_b), _b)


def _cls(chars: set[str]) -> str:
    return "[" + "".join(re.escape(c) for c in sorted(chars)) + "]"


_CONT = {_byte_char(b) for b in range(0x80, 0xC0)} | {chr(b) for b in range(0x80, 0xA0)}
_LEAD2 = {_byte_char(b) for b in range(0xC2, 0xE0)}
_LEAD3 = {_byte_char(b) for b in range(0xE0, 0xF0)}
_LEAD4 = {_byte_char(b) for b in range(0xF0, 0xF5)}

C, L2, L3, L4 = _cls(_CONT), _cls(_LEAD2), _cls(_LEAD3), _cls(_LEAD4)
RUN_RE = re.compile(f"{L4}{C}{C}{C}|{L3}{C}{C}|{L2}{C}")

# Damage left behind after autocorrect touched a run. The euro sign is byte 0x80, the
# second byte of most 3-byte sequences (dashes, quotes, hyphens), so it is the anchor that
# survives when the bytes around it were changed.
_LEADLIKE = "ÂÃâãàāáä”“"
_DAMAGED_EURO_RE = re.compile(f"[{_LEADLIKE}]\\s?€|€\\s?[‘’“”„'\"–—]")
_LOWER_LEAD_RE = re.compile("ã[ -¿]")   # 'ã§' is 'Ã§' with a lower-cased lead
_C1_RE = re.compile("[\u0080-\u009f]")


@dataclass
class Finding:
    status: str            # "clean" | "repairable" | "damaged"
    runs: list[str]        # the suspicious substrings found
    repaired: str          # the repaired text, or "" when no safe repair exists


# ── Detection ────────────────────────────────────────────────────────────────


def find_runs(s: str) -> list[str]:
    """Substrings that are cp1252 renderings of a valid UTF-8 multi-byte character."""
    out = []
    for m in RUN_RE.finditer(s or ""):
        if _decode_run(m.group(0)) is not None:
            out.append(m.group(0))
    return out


def damage_marks(s: str, euro_is_suspect: bool = False) -> list[str]:
    """Traces of damage that no longer decode: a stray euro sign next to a lead-like
    character, a lower-cased lead, C1 control characters, U+FFFD replacement characters.

    euro_is_suspect=True flags every euro sign. Use it only for data that never contains
    a real one (picklist labels, field names) - it catches damage the patterns miss.
    """
    # Intact runs are reported by find_runs; blank them out first so an intact 'â€“'
    # is not also counted as damage.
    s = RUN_RE.sub(lambda m: "\x00" if _decode_run(m.group(0)) is not None else m.group(0),
                   s or "")
    marks = [m.group(0) for m in _DAMAGED_EURO_RE.finditer(s)]
    marks += [m.group(0) for m in _LOWER_LEAD_RE.finditer(s)]
    marks += [m.group(0) for m in _C1_RE.finditer(s)]
    if "�" in s:
        marks.append("�")
    if euro_is_suspect and "€" in s and not marks:
        marks.append("€")
    return marks


def is_mojibake(s: str, euro_is_suspect: bool = False) -> bool:
    """True if s carries any trace of UTF-8-read-as-cp1252 damage."""
    return bool(find_runs(s) or damage_marks(s, euro_is_suspect))


def is_clean(s: str, euro_is_suspect: bool = False) -> bool:
    """Non-empty, no mojibake, and no control characters other than tab/newline/CR."""
    return bool(s) and not is_mojibake(s, euro_is_suspect) and not any(
        ord(c) < 0x20 and c not in "\t\n\r" for c in s)


# ── Repair ───────────────────────────────────────────────────────────────────


def _decode_run(run: str) -> str | None:
    try:
        return bytes(CHAR_TO_BYTE[c] for c in run).decode("utf-8", "strict")
    except (KeyError, UnicodeDecodeError):
        return None


def roundtrip(s: str, max_passes: int = 3) -> str:
    """Undo cp1252 mis-reads run by run. Legitimate non-ASCII text around a run is left
    alone, so 'Café â€“ Ã©' works where a whole-string re-encode would fail.
    Up to max_passes passes undo double or triple encoding."""
    out = s or ""
    for _ in range(max_passes):
        new = RUN_RE.sub(lambda m: _decode_run(m.group(0)) or m.group(0), out)
        if new == out:
            break
        out = new
    return out


def _special(reference: str) -> str:
    """The single non-ASCII, non-alphanumeric character in a clean reference, or ''."""
    found = {c for c in reference or "" if ord(c) > 127 and not c.isalnum() and not c.isspace()}
    return found.pop() if len(found) == 1 else ""


# Characters a damaged run is built from. '«' and '»' are excluded: French and Russian use
# guillemets as real quotation marks.
_JUNK = set("ÂÃâãàāáä€ '‘’‚‛“”„–—ˆ˜ŒœŠšŸŽžƒ†‡•…‰‹›™") | {chr(b) for b in range(0x80, 0xA0)}


def repair_with_reference(bad: str, reference: str) -> str:
    """Rebuild a damaged run using the one special character of a clean reference text.

    Use case: a translation echoed a corrupted English source, then autocorrect changed a
    byte so the round-trip fails ('Vorâ€'montiert'). The clean English source ('Pre‑Assembled')
    holds exactly one special character, so putting that character back is exact, not a
    guess. Returns '' whenever the answer is not pinned down:
      - the reference has zero or several special characters;
      - the run is not between two words ('Crème brûlée €', '«€»'), so there is no way to
        know where the character belonged.
    """
    ch = _special(reference)
    if not ch or "€" not in (bad or ""):
        return ""
    i = bad.index("€")
    j = i + 1
    while i > 0 and bad[i - 1] in _JUNK:
        i -= 1
    while j < len(bad) and bad[j] in _JUNK:
        j += 1
    if not (any(c.isalnum() for c in bad[:i]) and any(c.isalnum() for c in bad[j:])):
        return ""
    lead = " " if re.search(r"\s" + re.escape(ch), reference) else ""
    trail = " " if re.search(re.escape(ch) + r"\s", reference) else ""
    out = (bad[:i].rstrip() + lead + ch + trail + bad[j:].lstrip()).strip()
    return out if is_clean(out) else ""


def repair(s: str, reference: str = "", euro_is_suspect: bool = False) -> str:
    """Best safe repair of s, or '' if s is clean or cannot be repaired cleanly.

    Escalates in three steps, accepting the first fully clean result:
      1. round-trip the runs (exact);
      2. restore a lower-cased lead 'ã' -> 'Ã' and round-trip again. ONLY 'ã': upper-casing
         'â' gives 'Â', and 'Â€' decodes to the invisible control U+0080;
      3. substitute the special character of a clean reference text (see
         repair_with_reference).
    """
    if not is_mojibake(s, euro_is_suspect):
        return ""
    cands = [roundtrip(s), roundtrip(_LOWER_LEAD_RE.sub(lambda m: "Ã" + m.group(0)[1], s))]
    if reference:
        cands.append(repair_with_reference(s, reference))
        cands.append(repair_with_reference(roundtrip(s), reference))
    for cand in cands:
        if cand and cand != s and is_clean(cand, euro_is_suspect):
            return cand
    return ""


def inspect(s: str, reference: str = "", euro_is_suspect: bool = False) -> Finding:
    """Classify s and give the safe repair, if any."""
    runs = find_runs(s)
    marks = damage_marks(s, euro_is_suspect)
    if not runs and not marks:
        return Finding("clean", [], "")
    fixed = repair(s, reference, euro_is_suspect)
    exact = bool(runs) and not marks and fixed == roundtrip(s)
    return Finding("repairable" if exact else "damaged", runs + marks, fixed)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("text", nargs="?", help="text to check")
    ap.add_argument("--file", help="check every line of this UTF-8 file instead")
    ap.add_argument("--reference", default="", help="clean reference text (e.g. the English source)")
    ap.add_argument("--euro-is-suspect", action="store_true",
                    help="treat every euro sign as damage (only for data with no real ones)")
    for _s in (sys.stdout, sys.stderr):
        if hasattr(_s, "reconfigure"):
            _s.reconfigure(encoding="utf-8", errors="replace")
    a = ap.parse_args(argv)
    lines = (open(a.file, encoding="utf-8-sig").read().splitlines() if a.file
             else [a.text] if a.text is not None else [])
    if not lines:
        ap.error("give TEXT or --file")
    bad = 0
    for n, line in enumerate(lines, 1):
        f = inspect(line, a.reference, a.euro_is_suspect)
        if f.status == "clean":
            if not a.file:
                print("clean")
            continue
        bad += 1
        where = f"line {n}: " if a.file else ""
        fix = repr(f.repaired) if f.repaired else "(no safe repair)"
        print(f"{where}{f.status}: {line!r} -> {fix}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
