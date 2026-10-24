// Local CI (an Experimental feature, owner 2026-10-23): the runner runs a project's own test command (kitebook.json "ci", else package.json
// "test"; none = skip) on new commits of its watched branches, on task branches when their task ends, and on Run tests / ci_run, in a
// throwaway worktree of that exact commit, nice'd, with a timeout, one run per machine; a newer commit cancels the older run of that branch.
// Only the project's own origin, never a fork. Results go to the server (ci_report); a GitHub commit status only when the owner asks.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { stopProcessTree } from "./execution-process.ts";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { homedir, tmpdir } from "os";

export function parseTests(log: string): { passed: number | null; failed: number | null } {
  const n = (x?: string) => (x ? Number(x) : 0);
  const bp = log.match(/^\s*(\d+) pass\b/m), bf = log.match(/^\s*(\d+) fail\b/m);                 // bun test
  if (bp || bf) return { passed: n(bp?.[1]), failed: n(bf?.[1]) };
  const cr = [...log.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];                  // cargo (one line per crate)
  if (cr.length) return { passed: cr.reduce((a, m) => a + n(m[1]), 0), failed: cr.reduce((a, m) => a + n(m[2]), 0) };
  const jf = log.match(/Tests?:?\s+(?:(\d+) failed[,|\s]+)?(\d+) passed/);                          // jest / vitest
  if (jf) return { passed: n(jf[2]), failed: n(jf[1]) };
  const pp = log.match(/(\d+) passed/), pf = log.match(/(\d+) failed/);                             // pytest and friends
  if (pp || pf) return { passed: n(pp?.[1]), failed: n(pf?.[1]) };
  const gp = (log.match(/^--- PASS/gm) ?? []).length, gf = (log.match(/^--- FAIL/gm) ?? []).length;  // go test -v
  return gp || gf ? { passed: gp, failed: gf } : { passed: null, failed: null };
}

// the repo's configured test command, read from the commit being tested; null = none (skip)
export function ciCommand(dir: string): string | null {
  const has = (f: string) => existsSync(join(dir, f));
  try { const k = JSON.parse(readFileSync(join(dir, "kitebook.json"), "utf8")); if (typeof k?.ci === "string" && k.ci.trim()) return k.ci.trim(); } catch {}
  try { const s = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts?.test;
    if (typeof s === "string" && s.trim() && !/no test specified/.test(s)) return has("bun.lock") || has("bun.lockb") ? "bun run test" : has("pnpm-lock.yaml") ? "pnpm test" : has("yarn.lock") ? "yarn test" : "npm test"; } catch {}
  return null;
}

// null when `branch` may be tested: never a fork (pull-request refs, another remote) or anything but a plain branch name
export function forkWhy(branch: string | null | undefined, remote = "origin"): string | null {
  const b = String(branch ?? "");
  if (!b) return "no branch";
  if (remote !== "origin") return `only the project's own origin is tested, not ${remote}`;
  if (/^(refs\/)?(pull|merge-requests|remotes)\//.test(b) || /^pr[-/]\d+/.test(b)) return `${b} is a pull-request ref: forks are never run`;
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(b) || b.includes("..") || b.startsWith("-") || b.startsWith("/") || b.endsWith("/") || b.includes(":")) return `${b} isn't a plain branch name`;
  return null;
}

export type Reason = "push" | "task" | "manual";
export type Job = { id: string; project: string; branch: string; sha: string | null; reason: Reason; task?: string | null; ask?: string | null };
export type Run = Job & { state: "queued" | "running" | "passed" | "failed" | "error" | "cancelled" | "skipped"; passed: number | null; failed: number | null;
  secs: number | null; tail: string[]; cmd: string | null; why: string | null; at: number };
type Outcome = Partial<Pick<Run, "state" | "passed" | "failed" | "secs" | "tail" | "cmd" | "why" | "sha">>;
let seq = 0; export const jobId = () => `cr_${Date.now().toString(36)}${(seq++).toString(36)}`;

export class CiQueue {
  private q: Run[] = []; private cur: { run: Run; ctl: AbortController } | null = null; private hist: Run[] = []; private idleW: (() => void)[] = [];
  constructor(private o: { run: (r: Run, signal: AbortSignal) => Promise<Outcome>; changed?: (r: Run) => void; keep?: number }) {}
  push(j: Job): Run {
    const r: Run = { ...j, state: "queued", passed: null, failed: null, secs: null, tail: [], cmd: null, why: null, at: Date.now() }, same = (x: Run) => x.project === j.project && x.branch === j.branch;
    for (const old of this.q.filter(same)) { this.q.splice(this.q.indexOf(old), 1); this.done(old, { state: "cancelled", why: `superseded by ${j.sha?.slice(0, 7) ?? "a newer run"}` }); }
    if (this.cur && same(this.cur.run) && (!j.sha || this.cur.run.sha !== j.sha)) { this.cur.run.why = `superseded by ${j.sha?.slice(0, 7) ?? "a newer run"}`; this.cur.ctl.abort(); }
    else if (this.cur && same(this.cur.run) && this.cur.run.sha === j.sha) { this.done(r, { state: "cancelled", why: "already running" }); return r; } // the same commit: nothing new
    this.q.push(r); this.o.changed?.(r); this.next(); return r;
  }
  runs(): Run[] { return [...(this.cur ? [this.cur.run] : []), ...this.q, ...this.hist]; }
  busy() { return !!this.cur || this.q.length > 0; }
  idle(): Promise<void> { return this.busy() ? new Promise(ok => this.idleW.push(ok)) : Promise.resolve(); }
  private done(r: Run, o: Outcome) { Object.assign(r, o, { at: Date.now() }); this.hist.unshift(r); this.hist.length = Math.min(this.hist.length, this.o.keep ?? 40); this.o.changed?.(r); }
  private async next() {
    if (this.cur) return; const r = this.q.shift(); if (!r) { const w = this.idleW; this.idleW = []; w.forEach(f => f()); return; }
    const ctl = new AbortController(); this.cur = { run: r, ctl }; r.state = "running"; r.at = Date.now(); this.o.changed?.(r);
    let o: Outcome; try { o = await this.o.run(r, ctl.signal); } catch (e: any) { o = { state: "error", why: String(e?.message ?? e).slice(0, 300) }; }
    if (ctl.signal.aborted) o = { ...o, state: "cancelled", why: r.why ?? "cancelled" };
    this.cur = null; this.done(r, o); this.next();
  }
}

const git = (dir: string, ...a: string[]) => { const p = Bun.spawnSync(["git", "-C", dir, ...a], { stdout: "pipe", stderr: "pipe" }); return { code: p.exitCode ?? 1, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }; };
// origin/<branch>, or the runner's own local task branch
export function resolveSha(dir: string, branch: string): { sha: string } | { why: string } {
  const f = forkWhy(branch); if (f) return { why: f };
  const r = git(dir, "rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}^{commit}`); if (!r.code && r.out) return { sha: r.out };
  const l = git(dir, "rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`); if (!l.code && l.out) return { sha: l.out };
  return { why: `no branch ${branch} in the project's repo` };
}

// one run per machine across runner processes: a lock dir with its holder's pid (a dead holder's is taken over)
async function machineSlot(home: string, signal: AbortSignal): Promise<() => void> {
  const d = join(home, ".kitebook", "ci.lockdir"), pidf = join(d, "pid"); mkdirSync(dirname(d), { recursive: true });
  for (;;) { if (signal.aborted) throw new Error("cancelled");
    try { mkdirSync(d); writeFileSync(pidf, String(process.pid)); return () => { try { rmSync(d, { recursive: true, force: true }); } catch {} }; }
    catch { let alive = false; try { const p = Number(readFileSync(pidf, "utf8")); if (p && p !== process.pid) { process.kill(p, 0); alive = true; } } catch {} /* our own pid: a leftover */ if (!alive) { try { rmSync(d, { recursive: true, force: true }); } catch {} continue; } }
    await new Promise(ok => setTimeout(ok, 5000)); }
}

export async function runJob(r: Run, signal: AbortSignal, o: { dir: string; timeoutMs: number; home?: string }): Promise<Outcome> {
  const t0 = Date.now(), secs = () => Math.round((Date.now() - t0) / 100) / 10;
  const got = r.sha ? (forkWhy(r.branch) ? { why: forkWhy(r.branch)! } : { sha: r.sha }) : resolveSha(o.dir, r.branch); if ("why" in got) return { state: "skipped", why: got.why };
  if (git(o.dir, "cat-file", "-e", `${got.sha}^{commit}`).code) return { state: "skipped", sha: got.sha, why: "that commit isn't in the project's repo" };
  const free = await machineSlot(o.home ?? homedir(), signal), wt = join(mkdtempSync(join(tmpdir(), "kitebook-ci-")), "wt");
  try {
    const add = git(o.dir, "worktree", "add", "-q", "--detach", wt, got.sha); if (add.code) return { state: "error", sha: got.sha, why: `git worktree add: ${add.err.slice(0, 200)}` };
    const cmd = ciCommand(wt); if (!cmd) return { state: "skipped", sha: got.sha, why: "no test command (kitebook.json ci or package.json test)" };
    if (existsSync(join(o.dir, "node_modules")) && !existsSync(join(wt, "node_modules"))) try { symlinkSync(join(o.dir, "node_modules"), join(wt, "node_modules"), "dir"); } catch {}
    const argv = process.platform === "win32" ? ["cmd", "/d", "/s", "/c", cmd] : ["nice", "-n", "10", "sh", "-c", cmd];
    const p = Bun.spawn(argv, { cwd: wt, detached: process.platform !== "win32", stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1", KITEBOOK_CI: "1" } });
    let timedOut = false; const kill = () => { stopProcessTree(p.pid, "SIGTERM", true); setTimeout(() => stopProcessTree(p.pid, "SIGKILL", true), 5000); };
    const tm = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs); signal.addEventListener("abort", kill, { once: true });
    const cap = async (s: ReadableStream) => { let out = ""; for await (const c of s as any) { out += new TextDecoder().decode(c); if (out.length > 400_000) out = out.slice(-200_000); } return out; };
    const [so, se] = await Promise.all([cap(p.stdout as any), cap(p.stderr as any)]); const code = await p.exited; clearTimeout(tm); signal.removeEventListener("abort", kill);
    const log = (so + "\n" + se).replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""), tp = parseTests(log), tail = log.split("\n").map(l => l.trimEnd()).filter(Boolean).slice(-20);
    if (signal.aborted) return { state: "cancelled", sha: got.sha, cmd, secs: secs(), tail };
    if (timedOut) return { state: "error", sha: got.sha, cmd, secs: secs(), tail, ...tp, why: `timed out after ${Math.round(o.timeoutMs / 60000)} min` };
    return { state: code === 0 ? "passed" : "failed", sha: got.sha, cmd, secs: secs(), tail, ...tp, ...(code ? { why: `exit ${code}` } : {}) };
  } finally {
    git(o.dir, "worktree", "remove", "--force", wt); try { rmSync(dirname(wt), { recursive: true, force: true }); } catch {} git(o.dir, "worktree", "prune"); free();
  }
}

// watched: project ciBranches, else origin's dev, else origin's default branch
export function watched(dir: string, proj: any): string[] {
  if (Array.isArray(proj?.ciBranches)) return proj.ciBranches.map(String).filter((b: string) => !forkWhy(b));
  if (!git(dir, "rev-parse", "--verify", "-q", "refs/remotes/origin/dev").code) return ["dev"];
  const h = git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"); return !h.code && h.out.startsWith("origin/") ? [h.out.slice(7)] : [];
}

// GitHub commit status (off by default): a token already on this Mac only; a status never starts a workflow
export function ghToken(): string | null {
  const e = process.env.GH_TOKEN || process.env.GITHUB_TOKEN; if (e) return e;
  try { const p = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" }); const t = p.stdout.toString().trim(); return p.exitCode === 0 && t ? t : null; } catch { return null; }
}
export async function ghStatus(dir: string, r: Run, token: string | null): Promise<string | null> {
  if (!token || !r.sha || !["passed", "failed", "error", "running"].includes(r.state)) return null;
  const m = git(dir, "remote", "get-url", "origin").out.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(\.git)?$/); if (!m) return null;
  const state = r.state === "passed" ? "success" : r.state === "failed" ? "failure" : r.state === "running" ? "pending" : "error";
  const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/statuses/${r.sha}`, { method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "kitebook" },
    body: JSON.stringify({ state, context: "kitebook/tests", description: (r.state === "running" ? "running on the owner's machine" : `${r.passed ?? "?"} passed${r.failed ? `, ${r.failed} failed` : ""} in ${r.secs ?? "?"} s`).slice(0, 140) }), signal: AbortSignal.timeout(15_000) }).catch(() => null);
  return res?.ok ? state : null;
}

export function startCi(o: { cfg: () => any; call: (op: string, a?: any) => Promise<any>; log: (...a: any[]) => void; audit: (e: any) => void; home?: string }) {
  const home = o.home ?? homedir(), seenFile = join(home, ".kitebook", `ci-seen-${String(o.cfg().space ?? "main").replace(/[^\w.-]/g, "_")}.json`);
  let x: { ci: boolean; gh_status: boolean } | null = null, timer: any = null, pending: Run[] = [], took: string[] = [];
  const seen: Record<string, string> = (() => { try { return JSON.parse(readFileSync(seenFile, "utf8")); } catch { return {}; } })();
  const proj = (name: string) => (o.cfg().projects ?? {})[name] ?? null;
  const report = async () => { const runs = pending.splice(0), t = took.splice(0);
    try { const r = await o.call("ci_report", { runs, took: t }); for (const a of r?.asks ?? []) ask(a); } catch (e: any) { pending.unshift(...runs); took.unshift(...t); } };
  const queue = new CiQueue({ changed: r => { pending = pending.filter(p => p.id !== r.id); pending.push({ ...r, tail: [...r.tail] }); report();
      if (["passed", "failed", "error"].includes(r.state)) { o.audit({ type: "ci_run", project: r.project, branch: r.branch, sha: r.sha, reason: r.reason, state: r.state, passed: r.passed, failed: r.failed, secs: r.secs });
        o.log(`tests ${r.state}: ${r.project} ${r.branch}${r.sha ? " " + r.sha.slice(0, 7) : ""}${r.passed != null ? ` (${r.passed} passed, ${r.failed ?? 0} failed)` : ""}${r.why ? " - " + r.why : ""}`); }
      if (x?.gh_status && r.state !== "queued") { const p = proj(r.project); if (p?.path) ghStatus(p.path, r, ghToken()).catch(() => {}); } },
    run: (r, signal) => { const p = proj(r.project); if (!p?.path) return Promise.resolve({ state: "skipped", why: `no project ${r.project} on this Mac` } as Outcome);
      return runJob(r, signal, { dir: p.path, home, timeoutMs: Math.max(1, Number(p.ciTimeoutMin ?? o.cfg().ciTimeoutMin ?? 20) || 20) * 60_000 }); } });
  // two ci_report calls in flight (a run's change + a settings pass) both get the same waiting ask back before either "took" lands:
  // without this one ci_run became two runs and the second cancelled the first (seen in the smoke on hark/runner-health)
  const asked = new Set<string>();
  function ask(a: any) { const id = String(a.id); took.push(id); if (asked.has(id)) return; asked.add(id); if (asked.size > 500) asked.delete(asked.values().next().value!); if (!x) return; const p = proj(String(a.project)); if (!p?.path) return;
    const branch = a.branch ? String(a.branch) : watched(p.path, p)[0]; if (!branch || forkWhy(branch)) return;
    queue.push({ id: jobId(), project: String(a.project), branch, sha: null, reason: "manual", ask: id }); }
  // a new commit on a watched branch (not the first one seen) is a push to test
  function tick() { if (!x) return;
    if (x.ci) for (const [name, p] of Object.entries<any>(o.cfg().projects ?? {})) { if (!p?.path || !existsSync(join(p.path, ".git")) && !existsSync(join(p.path, "HEAD"))) continue;
      for (const b of watched(p.path, p)) { git(p.path, "fetch", "-q", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`);
        const s = resolveSha(p.path, b); if (!("sha" in s)) continue; const k = `${name}:${b}`;
        if (seen[k] && seen[k] !== s.sha) queue.push({ id: jobId(), project: name, branch: b, sha: s.sha, reason: "push" });
        if (seen[k] !== s.sha) { seen[k] = s.sha; try { mkdirSync(dirname(seenFile), { recursive: true }); writeFileSync(seenFile, JSON.stringify(seen)); } catch {} } } }
    report(); }
  return { queue,
    experimental(now: { ci: boolean; gh_status: boolean } | null) { const was = x; x = now;
      if (now && !was) { o.log(`Experimental is on: local CI ${now.ci ? "tests every push to the watched branches" : "runs when asked (Test every push is off)"}`); clearInterval(timer); timer = setInterval(tick, Math.max(15_000, Number(o.cfg().ciPollMs ?? 120_000) || 120_000)); setTimeout(tick, 1000); }
      if (!now && was) { o.log("Experimental is off: no local test runs"); clearInterval(timer); timer = null; }
      if (now && was) report(); }, // every settings pass (15 s): Run tests asks wait at most that long
    task(t: any, branch: string | null) { if (!x?.ci || !branch || !t?.project || forkWhy(branch)) return; queue.push({ id: jobId(), project: String(t.project), branch, sha: null, reason: "task", task: String(t.id) }); },
    stop() { clearInterval(timer); } };
}
