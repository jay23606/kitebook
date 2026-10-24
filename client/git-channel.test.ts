// relay_update with Experimental on (client/git-channel.ts devCheck / devUpdate): a git install moves only by a fast-forward to origin's dev (or
// main), from a clean tree whose HEAD is itself on origin; a local commit, another remote, a changed origin, a dirty tree and going back
// are refused. devUpdate moves to exactly the sha the owner approved (never newer, never one origin doesn't have). It runs in a child
// process with its own HOME (updates.json, audit log) and a launchctl stand-in (no services here).
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const G = await import("./git-channel.ts");
const T = mkdtempSync(join(tmpdir(), "kitebook-devupd-"));
const git = (d: string, ...a: string[]) => { const p = Bun.spawnSync(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdout: "pipe", stderr: "pipe" }); if (p.exitCode) throw new Error(`git ${a.join(" ")}: ${p.stderr}`); return p.stdout.toString().trim(); };
const commit = (d: string, msg: string) => { appendFileSync(join(d, "f"), msg + "\n"); git(d, "add", "-A"); git(d, "commit", "-qm", msg); return git(d, "rev-parse", "HEAD"); };
let n = 0;
// origin with main = A and dev = A + B; the Mac's checkout on main (A)
function setup() { const d = join(T, `r${n++}`), up = join(d, "up"), mac = join(d, "mac");
  Bun.spawnSync(["git", "init", "-q", "--bare", join(d, "origin.git")]); Bun.spawnSync(["git", "clone", "-q", join(d, "origin.git"), up], { stderr: "pipe" });
  const A = commit(up, "a"); git(up, "push", "-q", "origin", "HEAD:main"); const B = commit(up, "b"); git(up, "push", "-q", "origin", "HEAD:dev");
  Bun.spawnSync(["git", "clone", "-q", "-b", "main", join(d, "origin.git"), mac], { stderr: "pipe" });
  return { d, up, mac, A, B, origin: join(d, "origin.git") }; }

test("devCheck: a fast-forward to origin/dev; up to date on dev", () => {
  const r = setup(), c = G.devCheck(r.mac);
  expect(c.state).toBe("updated"); expect(c.ref).toBe("dev"); expect(c.from).toBe(r.A.slice(0, 7)); expect(c.to).toBe(r.B.slice(0, 7)); expect(c.want).toBe(r.B);
  git(r.mac, "merge", "-q", "--ff-only", r.B); expect(G.devCheck(r.mac).state).toBe("up_to_date");
});

test("devCheck refuses a dirty tree, a local commit, a commit from another remote, a changed origin", () => {
  const r = setup();
  writeFileSync(join(r.mac, "bun.lock"), "{}\n"); writeFileSync(join(r.mac, "notes.txt"), "x\n"); // untracked files (bun install's lockfile) never block it
  expect(G.devCheck(r.mac).state).toBe("updated"); rmSync(join(r.mac, "notes.txt"));
  appendFileSync(join(r.mac, "f"), "edit\n"); let c = G.devCheck(r.mac); expect(c.state).toBe("refused"); expect(c.why).toMatch(/local changes/); git(r.mac, "checkout", "-q", "f");
  commit(r.mac, "local"); c = G.devCheck(r.mac); expect(c.state).toBe("refused"); expect(c.why).toMatch(/isn't on origin's dev or main \(a local commit/); git(r.mac, "reset", "-q", "--hard", r.A);
  const evil = join(r.d, "evil"); Bun.spawnSync(["git", "clone", "-q", r.origin, evil], { stderr: "pipe" }); git(evil, "checkout", "-q", "dev"); const E = commit(evil, "evil");
  git(r.mac, "fetch", "-q", evil, "dev"); git(r.mac, "merge", "-q", "--ff-only", E); c = G.devCheck(r.mac); expect(c.state).toBe("refused"); expect(c.why).toMatch(/isn't on origin's dev or main/);
  git(r.mac, "reset", "-q", "--hard", r.A);
  c = G.devCheck(r.mac, "https://github.com/someone-else/kitebook.git"); expect(c.state).toBe("refused"); expect(c.why).toMatch(/origin changed/);
  expect(G.devCheck(r.mac, r.origin).state).toBe("updated"); // the recorded origin: fine
});

test("devCheck never goes back: origin/dev rewound behind what runs, or rewritten", () => {
  const r = setup(); git(r.mac, "merge", "-q", "--ff-only", r.B); git(r.mac, "push", "-q", "origin", "HEAD:main"); // main = dev = B
  git(r.up, "push", "-q", "-f", "origin", `${r.A}:refs/heads/dev`); // dev rewound to A: B is still on main, so nothing moves
  let c = G.devCheck(r.mac); expect(c.state).not.toBe("updated"); expect(git(r.mac, "rev-parse", "HEAD")).toBe(r.B);
  git(r.up, "push", "-q", "-f", "origin", `${r.A}:refs/heads/main`); // both rewound: B is on no origin branch any more
  c = G.devCheck(r.mac); expect(c.state).toBe("refused");
  const r2 = setup(); git(r2.up, "reset", "-q", "--hard", r2.A); const X = commit(r2.up, "rewritten"); git(r2.up, "push", "-q", "-f", "origin", "HEAD:dev");
  git(r2.mac, "merge", "-q", "--ff-only", r2.A); commit(r2.up, "main moves"); git(r2.up, "push", "-q", "-f", "origin", `${X}:refs/heads/main`); git(r2.up, "push", "-q", "-f", "origin", `${r2.B}:refs/heads/dev`);
  git(r2.mac, "fetch", "-q", "origin"); git(r2.mac, "merge", "-q", "--ff-only", X); // HEAD on main (X); dev (B) went another way
  c = G.devCheck(r2.mac); expect(c.state).toBe("up_to_date"); expect(c.ref).toBe("main"); // stays put: B isn't a fast-forward of X
});

test("devCheck with the approved sha: exactly that commit, on origin, a fast-forward; else refused", () => {
  const r = setup(); const C = commit(r.up, "c"); git(r.up, "push", "-q", "origin", "HEAD:dev"); // origin/dev moved on to C after B was approved
  let c = G.devCheck(r.mac, null, r.B); expect(c.state).toBe("updated"); expect(c.want).toBe(r.B); expect(c.sha).toBe(r.B); expect(c.ref).toBe("dev"); // B, not the newer C
  c = G.devCheck(r.mac, null, "f".repeat(40)); expect(c.state).toBe("refused"); expect(c.why).toMatch(/on neither origin's dev nor main/);
  c = G.devCheck(r.mac, null, r.B.slice(0, 12)); expect(c.state).toBe("refused"); expect(c.why).toMatch(/full sha/);
  git(r.mac, "fetch", "-q", "origin"); git(r.mac, "merge", "-q", "--ff-only", C); c = G.devCheck(r.mac, null, r.B); expect(c.state).toBe("refused"); expect(c.why).toMatch(/older than what this Mac runs/);
  expect(G.devCheck(r.mac, null, C).state).toBe("up_to_date");
});

test("devUpdate: moves the checkout to exactly the approved sha, records who asked and who approved (from -> to), audits it, clears the pin; refusals recorded too", () => {
  const r = setup(), H = join(r.d, "home"), lc = join(r.d, "launchctl"), cfg = join(r.d, "runner.json");
  writeFileSync(lc, "#!/bin/sh\nexit 1\n"); chmodSync(lc, 0o755); // nothing loaded: no server or runner job to restart
  writeFileSync(cfg, JSON.stringify({ url: "http://127.0.0.1:9", token: "rk.x", space: "main", source: r.mac, launchctl: lc }), { mode: 0o600 });
  const run = (sha: string) => { const p = Bun.spawnSync([process.execPath, "-e", `const G = await import(${JSON.stringify(import.meta.dir + "/git-channel.ts")}); const c = JSON.parse(require("fs").readFileSync(${JSON.stringify(cfg)}, "utf8"));
    console.log("RESULT " + JSON.stringify(await G.devUpdate(c, ${JSON.stringify(cfg)}, "hark", { sha: ${JSON.stringify(sha)}, how: "password" }, { audit: e => (async () => (await import(${JSON.stringify(import.meta.dir + "/guard.ts")})).auditAppend(e))(), log: () => {}, stamp: () => {} })));`],
    { env: { ...process.env, HOME: H, KITEBOOK_TEST: "1", KITEBOOK_TASK_ID: "", KITEBOOK_GIT_WATCH: "off" }, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const l = p.stdout.toString().split("\n").find(x => x.startsWith("RESULT ")); if (!l) throw new Error(p.stdout.toString() + p.stderr.toString()); return JSON.parse(l.slice(7)); };
  writeFileSync(join(r.mac, "bun.lock"), "{}\n"); // the owner's `bun install` left one (origin tracks only package-lock.json)
  const C = commit(r.up, "c"); git(r.up, "push", "-q", "origin", "HEAD:dev"); // dev moved on after the owner approved B
  const o = run(r.B); expect(o.state).toBe("updated"); expect(o.from).toBe(r.A.slice(0, 7)); expect(o.to).toBe(r.B.slice(0, 7)); expect(o.sha).toBe(r.B); expect(o.health).toBe("ok");
  expect(git(r.mac, "rev-parse", "HEAD")).toBe(r.B); expect(JSON.parse(readFileSync(cfg, "utf8")).updatePin).toBeUndefined();
  const hist = JSON.parse(readFileSync(join(H, ".kitebook", "updates.json"), "utf8")), last = hist[hist.length - 1];
  expect(last.result).toBe("installed"); expect(last.by).toBe("hark (relay_update, approved by you)"); expect(last.from).toBe(r.A.slice(0, 7)); expect(last.to).toBe(r.B.slice(0, 7));
  const audit = readFileSync(join(H, ".kitebook", "audit.jsonl"), "utf8");
  expect(audit).toMatch(/"type":"update_dev".*"by":"hark".*"approved_by":"owner \(master password, kitebook confirm\)"/); expect(audit).toMatch(/"action":"fast_forward"/);
  expect(run(r.B).state).toBe("up_to_date");
  expect(run(r.A).state).toBe("refused"); expect(git(r.mac, "rev-parse", "HEAD")).toBe(r.B); // going back to an old approval: refused
  commit(r.mac, "local"); const x = run(C); expect(x.state).toBe("refused"); expect(x.why).toMatch(/local commit/);
  const h2 = JSON.parse(readFileSync(join(H, ".kitebook", "updates.json"), "utf8")); expect(h2[h2.length - 1]).toMatchObject({ result: "refused", by: "hark (relay_update, approved by you)" });
  rmSync(r.d, { recursive: true, force: true });
});

test("channels: Experimental on -> dev, else main; off -> the branch the checkout follows (main; dev only for an explicit dev checkout; another branch is the owner's)", () => {
  const r = setup();
  expect(G.channels(r.mac, true)).toEqual({ refs: ["dev", "main"] }); expect(G.channels(r.mac, false)).toEqual({ refs: ["main"] });
  git(r.mac, "checkout", "-q", "-b", "dev", "--track", "origin/dev"); expect(G.channels(r.mac, false)).toEqual({ refs: ["dev"] });
  git(r.mac, "checkout", "-q", "--detach"); expect(G.channels(r.mac, false)).toEqual({ refs: ["main"] }); // no upstream: the stable channel
  git(r.up, "push", "-q", "origin", "HEAD:feature"); git(r.mac, "fetch", "-q", "origin"); git(r.mac, "checkout", "-q", "-b", "feature", "--track", "origin/feature");
  const f = G.channels(r.mac, false); expect("why" in f && f.why).toMatch(/follows origin\/feature, not origin's main or dev/);
  // Experimental off on main: devCheck takes main's newest commit, never dev's; an approved sha only dev has is refused on that channel
  const r2 = setup(); let c = G.devCheck(r2.mac, null, null, ["main"]); expect(c.state).toBe("up_to_date"); expect(c.ref).toBe("main");
  git(r2.up, "checkout", "-q", "-B", "m", r2.A); const M = commit(r2.up, "m2"); git(r2.up, "push", "-q", "origin", "HEAD:main");
  c = G.devCheck(r2.mac, null, null, ["main"]); expect(c.state).toBe("updated"); expect(c.want).toBe(M); expect(c.ref).toBe("main");
  c = G.devCheck(r2.mac, null, r2.B, ["main"]); expect(c.state).toBe("refused"); expect(c.why).toMatch(/isn't on origin\/main \(the branch this Mac follows\)/);
  expect(G.devCheck(r2.mac, null, r2.B).state).toBe("updated"); // the dev channel (Experimental on) still takes it
});
