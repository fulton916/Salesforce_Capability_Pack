# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

"""Merge a translation component that more than one retrieve batch returned.

A CustomObjectTranslation can come back from two batches: from its object batch WITH layout
sections (the Layout members were in that request), and from a quick-action batch WITHOUT layouts
but WITH quickActions (the QuickAction members were in that request). Keeping only one copy
silently drops the other copy's blocks, and every target in them looks "not retrievable".

component_files() merges every copy block by block, keeping the fuller version of each block (the
one with the most non-empty leaves). Merged files are written under `cache`, which must be outside
the retrieve dir, so the retrieve itself is never changed.

The merge decides only WHERE blocks come from. Every safety check (the build proof, the checks
before and after the deploy) reads the RAW retrieved copies, never this cache, so a fault in the
merge cannot hide a value the target holds.
"""
import collections
import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crsafe  # noqa: E402
import translib as L  # noqa: E402


def _score(e):
    return sum(1 for x in e.iter() if len(x) == 0 and (x.text or "").strip())


def merge_roots(roots):
    best, order = {}, []
    for r in roots:
        seen = collections.Counter()
        for child in r:
            if not isinstance(child.tag, str):
                continue
            tag = L.local(child.tag)
            base = (tag, L.ident(child)) if len(child) else (tag,)
            seen[base] += 1
            key = base + (seen[base],)
            if key not in best:
                order.append(key)
                best[key] = child
            elif _score(child) > _score(best[key]):
                best[key] = child
    m = ET.Element(roots[0].tag)
    for key in order:
        m.append(best[key])
    return m


def component_files(root, cache, quiet=False):
    """{(folder, component): path to read}: the single retrieved copy, or a merged copy under cache."""
    root, cache = os.path.abspath(root), os.path.abspath(cache)
    if cache == root or cache.startswith(root + os.sep):
        raise SystemExit(f"merge cache {cache} must not be inside the retrieve dir {root}")
    out, merged = {}, 0
    for k, ps in L.component_sources(root).items():
        if len(ps) == 1:
            out[k] = ps[0]
            continue
        m = merge_roots([crsafe.parse(p).getroot() for p in ps])
        dst = os.path.join(cache, k[0], f"{k[1]}.{L.FOLDER_EXT[k[0]]}")
        crsafe.write_xml(m, dst)
        out[k] = dst
        merged += 1
    if merged and not quiet:
        print(f"  merged {merged} component(s) returned by more than one retrieve batch ({os.path.basename(root)})")
    return out


if __name__ == "__main__":
    print(__doc__)
