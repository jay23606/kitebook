// Local CI (client/ci.ts; an Experimental feature): the queue (one run at a time, a newer commit for the same branch supersedes the
// queued one and cancels the running one), fork refusal, the repo's own test command, a real run in a throwaway worktree (pass, fail,
// skip, cleaned up), and the runner side following the owner-signed Experimental state. Run: bun test client/ci.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CiQueue, forkWhy, ciCommand, runJob, resolveSha, watched, startCi, parseTests, type Run } from "./ci.ts";

const T = mkdtempSync(join(tmpdir(), "kitebook-ci-test-"));
const git = (d: string, ...a: string[]) => { const p = Bun.spawnSync(["git", "-C", d, ...a], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); return p.stdout.toString().trim(); };
const tick = () => new Promise(ok => setTimeout(ok, 5));
const job = (branch: string, sha: string) => ({ id: `${branch}-${sha}`, project: "app", branch, sha, reason: "push" as const });

test("queue: one at a time; a newer commit supersedes the queued one and cancels the running one; other branches wait their turn", async () => {
  const started: string[] = [], release = new Map<string, () => void>(), seen: Run[] = [];
  const q = new CiQueue({ changed: r => seen.push({ ...r }), run: (r, signal) => new Promise(ok => { started.push(r.id);
    release.set(r.id, () => ok({ state: "passed", passed: 1, failed: 0 })); signal.addEventListener("abort", () => ok({ state: "failed" })); }) });
  q.push(job("dev", "a1")); await tick(); expect(started).toEqual(["dev-a1"]);
  q.push(job("feat", "f1")); q.push(job("dev", "a2")); await tick(); // dev a1 running: a2 cancels it; feat f1 was queued first
  expect(q.runs().find(r => r.id === "dev-a1")?.state).toBe("cancelled"); expect(q.runs().find(r => r.id === "dev-a1")?.why).toMatch(/superseded by a2/);
  expect(started).toEqual(["dev-a1", "feat-f1"]); // one at a time: feat runs next, dev a2 waits
  q.push(job("dev", "a3")); await tick(); // a2 never started: replaced in the queue
  expect(q.runs().find(r => r.id === "dev-a2")?.state).toBe("cancelled");
  release.get("feat-f1")!(); await tick(); expect(started).toEqual(["dev-a1", "feat-f1", "dev-a3"]);
  q.push(job("dev", "a3")); await tick(); expect(started.length).toBe(3); // the same commit again: nothing new
  release.get("dev-a3")!(); await q.idle();
  expect(q.runs().find(r => r.id === "dev-a3")?.state).toBe("passed"); expect(q.busy()).toBe(false);
  expect(seen.some(r => r.id === "dev-a3" && r.state === "running")).toBe(true);
});

test("forks never run: pull-request refs, other remotes, ref specs and ranges are refused", () => {
  expect(forkWhy("dev")).toBeNull(); expect(forkWhy("kitebook/t_abc")).toBeNull(); expect(forkWhy("hark/local-ci")).toBeNull();
  for (const b of ["pull/12/head", "refs/pull/3/merge", "merge-requests/4/head", "pr-7", "remotes/fork/dev", "a..b", "-x", "dev:main", "", "a b"]) expect(forkWhy(b)).toBeTruthy();
  expect(forkWhy("dev", "fork")).toMatch(/only the project's own origin/);
});

test("the repo's own test command: kitebook.json ci, else package.json test by lockfile, else none (skip)", () => {
  const d = mkdtempSync(join(T, "cmd-"));
  expect(ciCommand(d)).toBeNull();
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } })); expect(ciCommand(d)).toBeNull();
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "vitest" } })); expect(ciCommand(d)).toBe("npm test");
  writeFileSync(join(d, "bun.lock"), ""); expect(ciCommand(d)).toBe("bun run test");
  writeFileSync(join(d, "kitebook.json"), JSON.stringify({ ci: "make check" })); expect(ciCommand(d)).toBe("make check");
  expect(parseTests("12 pass\n 1 fail\n")).toEqual({ passed: 12, failed: 1 }); // the capture task results use
});

// origin with dev; the project's checkout cloned from it
function repo() {
  const d = mkdtempSync(join(T, "repo-")), up = join(d, "up"), origin = join(d, "origin.git"), work = join(d, "work");
  mkdirSync(up); git(up, "init", "-q", "-b", "main"); writeFileSync(join(up, "kitebook.json"), JSON.stringify({ ci: "echo '3 pass'; echo ' 0 fail'; test ! -e FAIL" }));
  git(up, "add", "."); git(up, "commit", "-qm", "a"); Bun.spawnSync(["git", "clone", "-q", "--bare", up, origin]); git(up, "remote", "add", "origin", origin); git(up, "push", "-q", "origin", "HEAD:dev");
  Bun.spawnSync(["git", "clone", "-q", origin, work]);
  return { d, up, work, home: join(d, "home") };
}

test("a run: a throwaway worktree of exactly that commit, its own command, pass / fail / skip, always cleaned up", async () => {
  const r = repo(), ac = new AbortController(), base = { id: "x", project: "app", reason: "manual" as const, state: "queued" as const, passed: null, failed: null, secs: null, tail: [], cmd: null, why: null, at: 0 };
  expect(watched(r.work, {})).toEqual(["dev"]); expect(watched(r.work, { ciBranches: ["main", "pull/1/head"] })).toEqual(["main"]);
  const ok = await runJob({ ...base, branch: "dev", sha: null }, ac.signal, { dir: r.work, timeoutMs: 60_000, home: r.home });
  expect(ok.state).toBe("passed"); expect(ok.passed).toBe(3); expect(ok.sha).toBe((resolveSha(r.work, "dev") as any).sha); expect(ok.tail?.join("\n")).toContain("3 pass");
  writeFileSync(join(r.up, "FAIL"), "x"); git(r.up, "add", "."); git(r.up, "commit", "-qm", "b"); git(r.up, "push", "-q", "origin", "HEAD:dev"); git(r.work, "fetch", "-q", "origin");
  const bad = await runJob({ ...base, branch: "dev", sha: null }, ac.signal, { dir: r.work, timeoutMs: 60_000, home: r.home });
  expect(bad.state).toBe("failed"); expect(bad.why).toBe("exit 1");
  expect((await runJob({ ...base, branch: "pull/1/head", sha: null }, ac.signal, { dir: r.work, timeoutMs: 60_000, home: r.home })).state).toBe("skipped");
  expect((await runJob({ ...base, branch: "nope", sha: null }, ac.signal, { dir: r.work, timeoutMs: 60_000, home: r.home })).why).toMatch(/no branch nope/);
  git(r.up, "rm", "-q", "kitebook.json"); git(r.up, "commit", "-qm", "c"); git(r.up, "push", "-q", "origin", "HEAD:dev"); git(r.work, "fetch", "-q", "origin");
  const none = await runJob({ ...base, branch: "dev", sha: null }, ac.signal, { dir: r.work, timeoutMs: 60_000, home: r.home });
  expect(none.state).toBe("skipped"); expect(none.why).toMatch(/no test command/);
  expect(git(r.work, "worktree", "list").split("\n").length).toBe(1); // every throwaway worktree is gone
  expect(existsSync(join(r.home, ".kitebook", "ci.lockdir"))).toBe(false); // the machine slot is free again
});

test("the runner side: nothing runs with Experimental off; on, a push to the watched branch is tested and reported; asks are taken", async () => {
  const r = repo(), calls: any[] = [], audits: any[] = []; let asks: any[] = [];
  const ci = startCi({ cfg: () => ({ space: "main", ciPollMs: 15_000, projects: { app: { path: r.work } } }), home: r.home, log: () => {}, audit: e => audits.push(e),
    call: async (op, a) => { calls.push({ op, ...a }); const out = { asks }; asks = []; return out; } });
  ci.task({ id: "t1", project: "app" }, "dev"); expect(ci.queue.runs().length).toBe(0); // Experimental off: no task run either
  ci.experimental({ ci: true, gh_status: false }); await new Promise(ok => setTimeout(ok, 1300)); // first sight of dev: remembered, not run
  expect(ci.queue.runs().length).toBe(0);
  writeFileSync(join(r.up, "x"), "1"); git(r.up, "add", "."); git(r.up, "commit", "-qm", "push"); git(r.up, "push", "-q", "origin", "HEAD:dev");
  ci.experimental(null); ci.experimental({ ci: true, gh_status: false }); await new Promise(ok => setTimeout(ok, 1300)); await ci.queue.idle();
  const run = ci.queue.runs()[0]; expect(run.reason).toBe("push"); expect(run.state).toBe("passed");
  expect(calls.some(c => c.op === "ci_report" && c.runs?.some((x: any) => x.state === "passed"))).toBe(true);
  expect(audits.some(e => e.type === "ci_run" && e.state === "passed")).toBe(true);
  asks = [{ id: "ci_1", project: "app", branch: null }]; ci.task({ id: "t2", project: "app" }, "pull/9/head"); // a fork's ref: refused
  ci.task({ id: "t3", project: "app" }, "dev"); await ci.queue.idle(); await tick(); await ci.queue.idle();
  expect(ci.queue.runs().some(x => x.task === "t3")).toBe(true); expect(ci.queue.runs().some(x => x.task === "t2")).toBe(false);
  expect(ci.queue.runs().some(x => x.ask === "ci_1" && x.reason === "manual")).toBe(true); // the waiting ask became a run
  expect(calls.some(c => c.op === "ci_report" && (c.took ?? []).includes("ci_1"))).toBe(true);
  ci.stop(); expect(readdirSync(r.home).length).toBeGreaterThan(0);
}, 30_000);
