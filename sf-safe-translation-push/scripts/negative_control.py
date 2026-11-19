"""Negative controls for the builder (lock 1): plant disguised overwrites in COPIES of the data and
prove build_push.py refuses every one. Run it after a real build, with the same inputs; it writes
only *_negctl* paths and never touches the real run's outputs.

  A. disguised overwrite in the plan: one slot per payload folder type that the target ALREADY
     holds (a held or already-live row) is relabelled NEW in a copy of plan.json, as if the
     classification had gone wrong. The builder's proof must flag each one as an overwrite risk.
  B. value planted in the retrieve: one slot per payload folder type that the payload FILLS gets a
     value in a copy of before/, as if the org held one. Built from the real plan, the proof must
     flag each one (it reads the raw retrieve, not the plan).
  C. stale named overwrite (only with --named and at least one named overwrite in the build): the
     first name's "was" is changed; the builder must hold that slot and fail.

CAUGHT only if the builder exits 2 and every plant is flagged. A folder type with no candidate is
reported as NOT exercised.

    python negative_control.py --work <dir> [--named named_overwrites.json] [--exclude-langs en_US]
Exit 0 = every control CAUGHT.
"""
import argparse
import copy
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crsafe  # noqa: E402
import translib as L  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PLANT = "PLANTED EXISTING VALUE"


def run_build(work, extra):
    r = subprocess.run([sys.executable, os.path.join(HERE, "build_push.py"), "--work", work] + extra,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r


def plant(path, sig, value):
    """Set the leaf at sig in one retrieved file; False if the file has no such leaf."""
    root = crsafe.parse(path).getroot()
    cur = root
    for part in sig[:-1]:
        cur = next((c for c, node in L.child_nodes(cur) if node == part), None)
        if cur is None:
            return False
    leaf = next((c for c in cur if isinstance(c.tag, str) and L.local(c.tag) == sig[-1] and len(c) == 0), None)
    if leaf is None:
        return False
    leaf.text = value
    crsafe.write_xml(root, path)
    return True


def main(argv=None):
    L.utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", default=".")
    ap.add_argument("--source", default="source.json")
    ap.add_argument("--before", default="before")
    ap.add_argument("--plan", default="plan.json")
    ap.add_argument("--report", default="push_report.json")
    ap.add_argument("--named", help="the named-overwrite file the real build used")
    ap.add_argument("--exclude-langs", default="en_US")
    ap.add_argument("--keep", action="store_true", help="keep the *_negctl* outputs for inspection")
    a = ap.parse_args(argv)
    W = os.path.abspath(a.work)
    P = lambda x: x if os.path.isabs(x) else os.path.join(W, x)
    plan = L.load_json(P(a.plan))
    rep = L.load_json(P(a.report))
    common = ["--exclude-langs", a.exclude_langs, "--allow-unplaced"] + (["--named", P(a.named)] if a.named else [])
    ok, scratch = True, []

    # ---- A: disguised overwrites in a copy of the plan ------------------------------------------------
    d = copy.deepcopy(plan)
    planted, seen = [], set()
    for r in d["rows"]:
        if r.get("decision") in ("HOLD", "LIVE") and r.get("folder") and r["folder"] not in seen and r.get("org_value"):
            seen.add(r["folder"])
            if r["decision"] == "LIVE":
                r["value"] = r["value"] + " (PLANTED)"
            r.update(bucket="NEW", org_value="")
            planted.append(r)
    for f in sorted(set(L.FOLDER_EXT) - seen):
        print(f"   A: no held/live slot in {f} - that path is NOT exercised")
    L.dump_json(d, P("plan_negctl.json"))
    scratch += ["plan_negctl.json", "payload_negctl_a", "push_report_negctl_a.json"]
    r = run_build(W, ["--before", a.before, "--plan-in", "plan_negctl.json", "--out", "payload_negctl_a",
                      "--report", "push_report_negctl_a.json"] + common)
    risk = L.load_json(P("push_report_negctl_a.json")).get("overwrite_risk", []) if os.path.isfile(P("push_report_negctl_a.json")) else []
    flagged = {(x[0], x[1]) for x in risk}
    miss = [p for p in planted if (p["component"], str(L.sig_tuple(p["sig"]))) not in flagged]
    caught = bool(planted) and r.returncode == 2 and not miss
    print(f"A. disguised overwrites planted in the plan: {len(planted)} ({', '.join(p['folder'] for p in planted)}); "
          f"builder exit {r.returncode}; flagged {len(risk)}")
    for p in miss:
        print("   NOT flagged:", p["lang"], p["key"])
    print("   ->", "CAUGHT" if caught else "NOT CAUGHT")
    ok &= caught

    # ---- B: values planted in a copy of the retrieve --------------------------------------------------
    nb = os.path.join(W, os.path.basename(os.path.abspath(P(a.before))) + "_negctl")     # inside the run folder
    shutil.rmtree(nb, ignore_errors=True)
    shutil.copytree(P(a.before), nb)
    scratch += [nb, "_merged_" + os.path.basename(nb), "payload_negctl_b", "push_report_negctl_b.json"]
    auth = {(x["folder"], x["component"], L.sig_tuple(x["sig"])) for x in rep.get("authorized", [])}
    sources = L.component_sources(nb)
    planted_b, seen = [], set()
    for x in rep["targets"]:
        k, s = (x["folder"], x["component"]), L.sig_tuple(x["sig"])
        if x["folder"] in seen or (k + (s,)) in auth:
            continue
        hits = sum(plant(p, s, PLANT) for p in sources.get(k, []))
        if hits:
            seen.add(x["folder"])
            planted_b.append((x["component"], str(s), x.get("key")))
    for f in sorted({x["folder"] for x in rep["targets"]} - seen):
        print(f"   B: could not plant in {f} - that path is NOT exercised")
    r = run_build(W, ["--before", nb, "--plan-in", a.plan, "--out", "payload_negctl_b",
                      "--report", "push_report_negctl_b.json"] + common)
    risk = L.load_json(P("push_report_negctl_b.json")).get("overwrite_risk", []) if os.path.isfile(P("push_report_negctl_b.json")) else []
    flagged = {(x[0], x[1]) for x in risk}
    miss = [p for p in planted_b if (p[0], p[1]) not in flagged]
    caught = bool(planted_b) and r.returncode == 2 and not miss
    print(f"B. values planted in a copy of the retrieve: {len(planted_b)}; builder exit {r.returncode}; flagged {len(risk)}")
    for p in miss:
        print("   NOT flagged:", p)
    print("   ->", "CAUGHT" if caught else "NOT CAUGHT")
    ok &= caught

    # ---- C: a stale named overwrite -----------------------------------------------------------------
    if a.named and rep.get("authorized"):
        names = L.load_json(P(a.named))
        x0 = rep["authorized"][0]
        bad = [dict(n, was=n["was"] + " (STALE)") if (n["lang"], L.norm_key(n["key"])) == (x0["lang"], L.norm_key(x0["key"])) else n
               for n in names]
        L.dump_json(bad, P("named_negctl.json"))
        scratch += ["named_negctl.json", "plan_negctl_c.json", "payload_negctl_c", "push_report_negctl_c.json"]
        r = run_build(W, ["--source", a.source, "--before", a.before, "--named", "named_negctl.json",
                          "--plan-out", "plan_negctl_c.json", "--out", "payload_negctl_c",
                          "--report", "push_report_negctl_c.json", "--exclude-langs", a.exclude_langs, "--allow-unplaced"])
        rc = L.load_json(P("push_report_negctl_c.json")) if os.path.isfile(P("push_report_negctl_c.json")) else {}
        still = any(y["key"] == x0["key"] and y["lang"] == x0["lang"] for y in rc.get("authorized", []))
        stale = any(y["key"] == x0["key"] and y["lang"] == x0["lang"] for y in rc.get("named_stale", []))
        caught = r.returncode == 2 and stale and not still
        print(f"C. stale 'was' on {x0['lang']} {x0['key']}: builder exit {r.returncode}; held as stale: {stale}; "
              f"still written: {still}")
        print("   ->", "CAUGHT" if caught else "NOT CAUGHT")
        ok &= caught
    elif a.named:
        print("C. no named overwrite in the build - NOT exercised")

    if not a.keep:
        for s in scratch:
            p = P(s)
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
            elif os.path.isfile(p):
                os.remove(p)
    print("RESULT:", "CAUGHT" if ok else "NOT CAUGHT")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
