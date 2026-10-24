#!/usr/bin/env python3
"""Plan scripts/smoke-par.sh's concurrent runs: which sections each run executes.
Sections lean on what earlier ones leave behind (shell variables, helper functions). This reads smoke.sh, finds for each section the
earlier sections that first define a variable or function it uses, or first touch a file under $T it touches (core and the setup above it run in every run anyway), and has each
run also execute those prerequisites (transitively). A prerequisite's checks are counted only in the run that owns the section.
  smoke-plan.py <smoke.sh> <jobs> [<times.tsv>]   -> one line per run: "<owned keys,>\t<all keys to run, file order,>"
  smoke-plan.py <smoke.sh> --deps                 -> each section's prerequisites (to read or debug the scan)
Runs are consecutive slices of the file-order section list, cut so the slowest run (its sections plus the prerequisites they drag in) is as
fast as it can be; a section's weight is its seconds from the last green split run (times.tsv: key<TAB>seconds), else 0.25 s per line."""
import re, sys

def sections(path):
    lines = open(path).read().split("\n"); out = []; cur = ("", 0)
    for i, l in enumerate(lines):
        if l.startswith("# ---- "):
            out.append((cur[0], cur[1], i)); k = re.sub(r"[:(].*", "", l[7:]).lower(); cur = (re.sub(r"[^a-z0-9]+", "-", k).strip("-"), i)
    out.append((cur[0], cur[1], len(lines)))
    return [(k, "\n".join(lines[a:b]), b - a) for k, a, b in out]

VAR_DEF = re.compile(r"(?:^|[\s;&|(!])(?:local |export )?([A-Z][A-Z0-9_]+)=|\bfor ([A-Z][A-Z0-9_]+) in|\bread (?:-r )?([A-Z][A-Z0-9_]+)")
FN_DEF = re.compile(r"(?:^|[\s;&|{(])([a-z_][a-z0-9_]*)\(\)\s*\{", re.M)
VAR_USE = re.compile(r"\$\{?([A-Z][A-Z0-9_]+)")
# files and dirs in the run's temp dir: a section that touches $T/<name> leans on the earlier section that first touched it (the fake agent
# CLIs in $T/fakeagents, a runner config, a key...); first mention counts as making it, which over-includes a reused scratch name at worst
T_PATH = re.compile(r"\$\{?T\}?/([A-Za-z0-9_][A-Za-z0-9_.-]*)")

def deps(path):
    secs = sections(path); base = {"", "core"}
    vdef, fdef, tdef = {}, {}, {}
    for k, txt, _ in secs:
        for m in VAR_DEF.finditer(txt):
            v = next(g for g in m.groups() if g); vdef.setdefault(v, k)
        for m in FN_DEF.finditer(txt): fdef.setdefault(m.group(1), k)
        for t in T_PATH.findall(txt): tdef.setdefault(t, k)
    order = [k for k, _, _ in secs]; pos = {k: i for i, k in enumerate(order)}; need = {}
    for k, txt, _ in secs:
        if k in base: continue
        own_v = {next(g for g in m.groups() if g) for m in VAR_DEF.finditer(txt)}; own_f = {m.group(1) for m in FN_DEF.finditer(txt)}; d = set()
        for v in set(VAR_USE.findall(txt)) - own_v:
            s = vdef.get(v)
            if s is not None and s not in base and pos[s] < pos[k]: d.add(s)
        for t in set(T_PATH.findall(txt)):
            s = tdef.get(t)
            if s is not None and s not in base and pos[s] < pos[k]: d.add(s)
        for f, s in fdef.items():
            if s in base or f in own_f or pos[s] >= pos[k]: continue
            if re.search(r"(?:^|[\s;&|({`]|\$\()" + re.escape(f) + r"(?=[\s;)|&]|$)", txt, re.M): d.add(s)
        need[k] = d
    def closure(k, seen=None):
        seen = set() if seen is None else seen
        for s in need.get(k, ()):
            if s not in seen: seen.add(s); closure(s, seen)
        return seen
    return secs, order, {k: closure(k) for k in need}

def main():
    path = sys.argv[1]; secs, order, cl = deps(path)
    if sys.argv[2] == "--deps":
        for k in order:
            if k in cl: print(k + "\t" + ",".join(sorted(cl[k], key=order.index)))
        return
    if sys.argv[2] == "--select":
        wanted = sys.argv[3].split(","); chosen = {k for k in cl if any(k == w.lstrip("=") or not w.startswith("=") and w in k for w in wanted)}
        if any(not any(k == w.lstrip("=") or not w.startswith("=") and w in k for k in cl) for w in wanted):
            raise SystemExit("unknown smoke section in selection")
        run = set(chosen)
        for k in chosen: run |= cl[k]
        print(",".join("=" + k for k in order if k in run)); return
    jobs = max(1, int(sys.argv[2])); times = {}
    if len(sys.argv) > 3:
        try:
            for l in open(sys.argv[3]):
                p = l.rstrip("\n").split("\t")
                if len(p) == 2: times[p[0]] = float(p[1])
        except OSError: pass
    keys = [k for k in order if k in cl]; w = {k: times.get(k, n * 0.25) for k, _, n in secs}
    def cost(r):
        allk = set(r)
        for k in r: allk |= cl[k]
        return sum(w[k] for k in allk), allk
    # contiguous cuts that minimise the slowest run (its own sections plus the prerequisites it drags in): every cut for up to 4 runs
    # (33 sections: a few thousand tries), else equal-weight cuts
    from itertools import combinations
    n = len(keys); jobs = min(jobs, n); best = None
    cands = combinations(range(1, n), jobs - 1) if jobs <= 4 else [tuple(round(n * i / jobs) for i in range(1, jobs))]
    for cuts in cands:
        b = (0,) + cuts + (n,); runs = [keys[b[i]:b[i + 1]] for i in range(jobs)]; m = max(cost(r)[0] for r in runs)
        if best is None or m < best[0]: best = (m, runs)
    for r in best[1]: print(",".join(r) + "\t" + ",".join(sorted(cost(r)[1], key=order.index)))

main()
