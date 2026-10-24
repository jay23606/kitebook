// frictions (2026-10-21): which code runs where (client/channel.ts build), the dev channel made explicit (followChannel), code_status
// wording for dev commits and merged assistant branches (src/space/util.ts codeNotes, client/runner-mirror.ts gitState), the audit line
// when an app's change gives it task sending (client/payload.ts summarize), and kitebook approve's words (client/local-approve.ts).
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { build, channelOf, followChannel } from "./channel.ts";
import { codeNotes } from "../src/space/util.ts";
import { summarize } from "./payload.ts";
import { answerWords } from "./local-approve.ts";

const T = mkdtempSync(join(tmpdir(), "frictions-"));
const sh = (cwd: string, ...a: string[]) => { const p = Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (p.exitCode) throw new Error(`git ${a.join(" ")}: ${p.stderr}`); return p.stdout.toString().trim(); };
const commit = (cwd: string, msg: string) => { writeFileSync(join(cwd, "f.txt"), msg + "\n", { flag: "a" }); sh(cwd, "add", "-A"); sh(cwd, "commit", "-qm", msg); return sh(cwd, "rev-parse", "HEAD"); };
let ORIGIN = "", UP = "", MAIN0 = "", DEV2 = "";
// origin: main at MAIN0, dev two commits ahead (DEV2)
beforeAll(() => {
  ORIGIN = join(T, "origin.git"); UP = join(T, "up"); sh(T, "init", "-q", "--bare", ORIGIN); sh(T, "init", "-q", "-b", "main", UP);
  MAIN0 = commit(UP, "one"); sh(UP, "remote", "add", "origin", ORIGIN); sh(UP, "push", "-q", "origin", "main");
  sh(UP, "switch", "-q", "-c", "dev"); commit(UP, "two"); DEV2 = commit(UP, "three"); sh(UP, "push", "-q", "origin", "dev");
});
const clone = (name: string) => { const d = join(T, name); sh(T, "clone", "-q", "-b", "main", ORIGIN, d); return d; };

test("build/channelOf: main on origin/main, dev once it holds origin/dev commits, local for a commit on neither", () => {
  const d = clone("c1");
  expect(channelOf(d)).toBe("main");
  const b = build(d)!; expect(b.commit).toBe(MAIN0); expect(b.channel).toBe("main"); expect(b.branch).toBe("main"); expect(b.version).toMatch(/^main-\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7}$/);
  sh(d, "pull", "-q", "--ff-only", "origin", "dev"); // the owner's live mistake: origin dev pulled into local main
  expect(channelOf(d)).toBe("dev"); expect(build(d)!.version.startsWith("dev-")).toBe(true);
  commit(d, "mine"); expect(channelOf(d)).toBe("local");
  sh(d, "tag", "v1.2.0", MAIN0); expect(build(d)!.version).toMatch(/^v1\.2\.0-3-g[0-9a-f]{7}$/);
  expect(build(join(T, "nope"))).toBeNull();
});

test("followChannel: main holding dev commits -> a dev branch tracking origin/dev at the same commit, main back to origin/main", () => {
  const d = clone("c2"); sh(d, "pull", "-q", "--ff-only", "origin", "dev"); writeFileSync(join(d, "bun.lock"), "untracked\n"); // untracked never blocks
  const audit: any[] = [], f = followChannel(d, { audit: e => audit.push(e) });
  expect(f.switched).toBe(true); expect(sh(d, "symbolic-ref", "--short", "HEAD")).toBe("dev"); expect(sh(d, "rev-parse", "HEAD")).toBe(DEV2);
  expect(sh(d, "rev-parse", "--abbrev-ref", "dev@{u}")).toBe("origin/dev"); expect(sh(d, "rev-parse", "main")).toBe(MAIN0);
  expect(audit[0]).toMatchObject({ action: "channel_dev", from_branch: "main", head: DEV2 }); expect(f.why).toContain("main back to origin/main");
  expect(followChannel(d).switched).toBe(false); // idempotent: already on dev
  expect(channelOf(d)).toBe("dev");
});

test("followChannel leaves alone: the stable channel, a dirty tree, a local dev branch with its own commits, a local commit", () => {
  const a = clone("c3"); expect(followChannel(a)).toMatchObject({ switched: false, why: "HEAD is on origin/main (the stable channel)" });
  const b = clone("c4"); sh(b, "pull", "-q", "--ff-only", "origin", "dev"); writeFileSync(join(b, "f.txt"), "edit\n", { flag: "a" });
  expect(followChannel(b)).toMatchObject({ switched: false, why: "the checkout has local changes to tracked files" }); expect(sh(b, "symbolic-ref", "--short", "HEAD")).toBe("main");
  const c = clone("c5"); sh(c, "branch", "dev", MAIN0); sh(c, "switch", "-q", "dev"); commit(c, "own"); sh(c, "switch", "-q", "main"); sh(c, "pull", "-q", "--ff-only", "origin", "dev");
  expect(followChannel(c)).toMatchObject({ switched: false, why: "a local dev branch has commits of its own (left alone)" });
  const e = clone("c6"); commit(e, "local"); expect(followChannel(e).switched).toBe(false);
});

test("codeNotes: dev commits on main are the dev channel, not unpushed work; plain local commits still are", () => {
  const n = codeNotes({ branch: "main", upstream: "origin/main", ahead: 29, behind: 0, dirty: 0, contained_in: "origin/dev", assistant_branches: [] });
  expect(n).toEqual(["main is on the dev channel: 29 commit(s) from origin/dev that origin/main doesn't have yet (nothing unpushed)"]);
  expect(codeNotes({ branch: "main", upstream: "origin/main", ahead: 2, behind: 0, dirty: 0, contained_in: "origin/feature" })[0]).toBe("main has 2 commit(s) not on origin/main, all already on origin/feature (nothing unpushed)");
  expect(codeNotes({ branch: "main", upstream: "origin/main", ahead: 1, behind: 0, dirty: 0 })[0]).toBe("main has 1 local commit(s) not pushed to origin/main");
});

test("summarize: a change that gives an app task sending says so (newuser #17)", () => {
  expect(summarize("claude-code", null, null, { mode: "folders", folders: ["kb/claude-code"], send: true })).toBe("claude-code can read and edit only kb/claude-code and send tasks to your Mac (you approve each one)");
  expect(summarize("claude-code", null, null, { mode: "folders", folders: ["kb/claude-code"], send: false })).toBe("claude-code can read and edit only kb/claude-code; it can't send tasks");
  expect(summarize("claude-code", null, null, { mode: "folders", folders: ["kb/claude-code"] })).toBe("claude-code can read and edit only kb/claude-code");
  expect(summarize("codex", null, { tasks: "off", projects: [] }, { mode: "read", send: false })).toBe("codex can't send tasks or push; it can read every folder and change nothing");
});

test("answerWords: kitebook approve says what happened in words, not cr_…: approved (newuser #19)", () => {
  expect(answerWords({ gate: "connect", login: true, app: "Linux · Chrome", task: "cr_feaaefbd" }, true)).toBe("Signed in: Linux · Chrome. It stays signed in for 30 days.");
  expect(answerWords({ gate: "connect", title: "A browser wants to sign in to your Kitebook (Mac · Safari)", app: "Mac · Safari", task: "cr_1" }, false)).toBe("Sign-in refused for Mac · Safari. That browser is not signed in.");
  expect(answerWords({ gate: "connect", app: "Pi", name: "pi-mac", task: "cr_2" }, true)).toBe("Connected: pi-mac (Pi). It finishes connecting on its own.");
  expect(answerWords({ gate: "run", title: "fix the tests", project: "relay", runner: "mac", task: "t_1" }, true)).toBe("Approved: fix the tests (relay). It starts now on mac.");
  expect(answerWords({ gate: "run", task: "t_2" }, false)).toBe("Rejected: t_2. It won't run.");
  expect(answerWords({ gate: "push", title: "ship it", task: "t_3" }, true)).toBe("Push approved: ship it.");
});
