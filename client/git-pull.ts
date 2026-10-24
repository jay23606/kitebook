// `git pull` in the Kitebook checkout IS the update (owner, 2026-10-20). The runner watches its checkout's HEAD (fs watch on .git + a
// periodic check); when HEAD moves it decides by itself whether that is an update it may apply, never trusting the working tree alone:
//   - the tree is clean (no local edits to tracked files),
//   - origin is the same remote as last time, and the runner fetches origin's main and dev itself into private refs
//     (refs/relay-verify/*, so a hand-written refs/remotes/origin/main can't vouch for anything),
//   - HEAD is contained in one of them (not a local commit, not another remote's or branch's),
//   - HEAD is a fast-forward of the commit it last ran (not a downgrade, not rewritten history).
// That is the approval for this path (a fast-forward to a verified origin commit), so nobody has to press anything and Pi or the owner
// can just pull. Anything else is refused and never restarted into: a local commit, another remote or branch, a downgrade, a dirty tree.
// Applying: the old runner first installs deps when the lockfile changed, then runs the new code's `runner.ts selfcheck` (it must load and reach the server), else it puts the
// checkout back (git reset --keep) and says so; then it restarts once idle. The new runner's start-up (onStart) runs the post-update
// steps once: deps install when the lockfile changed (unless the watcher already did), the host upgrade (client/host-upgrade.ts: a server still on cf dev), and the
// health check (it must reach the server; started() marks it good). A runner that keeps failing to get there before marking good is
// rolled back to the previous commit on its next start. Outcomes go to Settings -> Updates' history ("updated to <sha>", by git pull).
// First time on an old host (a runner from before this file, with no watcher): `git pull`, then restart the runner once
// (bun client/runner.ts service <runner.json> restart runner); this start-up does the same check, with the reflog's previous HEAD.
// State: ~/.kitebook/git-update.json { head (last good), origin, pending {head, prev, tries, steps}, rejected {head, why} }.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, mkdirSync, existsSync, watch } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

const HOME = () => join(homedir(), ".kitebook"), stateFile = () => join(HOME(), "git-update.json");
export const state = (): any => { try { return JSON.parse(readFileSync(stateFile(), "utf8")); } catch { return {}; } };
const save = (s: any) => { mkdirSync(HOME(), { recursive: true, mode: 0o700 }); writeFileSync(stateFile(), JSON.stringify(s, null, 1), { mode: 0o600 }); };
const git = (src: string, ...a: string[]) => { const p = Bun.spawnSync(["git", "-C", src, ...a], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }; };
const anc = (src: string, a: string, b: string) => git(src, "merge-base", "--is-ancestor", a, b).code === 0;
export const short = (s: string | null | undefined) => String(s ?? "").slice(0, 7);
// off: runner.json "gitWatch": false, or KITEBOOK_GIT_WATCH=off (the smoke's many throwaway runners on a dev checkout)
export const isCheckout = (src: string, cfg?: any) => process.env.KITEBOOK_GIT_WATCH !== "off" && cfg?.gitWatch !== false && existsSync(join(src, ".git")) && git(src, "rev-parse", "HEAD").code === 0;

export type Verdict = { ok: true; head: string; prev: string | null; ref: string; origin: string } | { ok: false; head: string; why: string; retry?: boolean };
// prev: the commit this runner last ran (state), else the reflog's (the first start after an older runner, which kept no state)
export function verify(src: string, prev?: string | null): Verdict {
  const head = git(src, "rev-parse", "HEAD").out, st = state();
  if (git(src, "status", "--porcelain", "--untracked-files=no").out) return { ok: false, head, why: "the Kitebook checkout has local changes (commit or discard them; only a clean git pull is applied)" };
  const origin = git(src, "remote", "get-url", "origin").out;
  if (!origin) return { ok: false, head, why: "the Kitebook checkout has no origin remote" };
  if (st.origin && st.origin !== origin) return { ok: false, head, why: `origin changed (${st.origin} -> ${origin}); kitebook update from your own terminal approves it` };
  const got: string[] = [];
  for (const b of ["main", "dev"]) { git(src, "update-ref", "-d", `refs/relay-verify/${b}`);
    if (!git(src, "fetch", "-q", "--no-tags", "origin", `+refs/heads/${b}:refs/relay-verify/${b}`).code) got.push(b); }
  if (!got.length) return { ok: false, head, why: "couldn't reach origin to check the new commit; trying again later", retry: true };
  const ref = got.find(b => anc(src, head, `refs/relay-verify/${b}`));
  if (!ref) return { ok: false, head, why: `${short(head)} isn't on origin's main or dev (a local commit, or one from another remote or branch)` };
  if (prev === undefined) prev = st.head ?? (git(src, "rev-parse", "-q", "--verify", "HEAD@{1}").out || null);
  if (prev && prev !== head && !anc(src, prev, head)) return { ok: false, head, why: `${short(head)} isn't a fast-forward of ${short(prev)} (a downgrade or rewritten history)` };
  return { ok: true, head, prev: prev || null, ref, origin };
}

type Log = (...a: any[]) => void;
const note = async (o: any) => { try { (await import("./updater.ts")).recordOutcome({ release: null, by: "git pull", at: new Date().toISOString(), why: null, from: null, to: null, ...o }); } catch {} };
const audit = async (e: any) => { try { (await import("./guard.ts")).auditAppend({ type: "service", by: "git pull", ...e }); } catch {} };
const reject = (head: string, why: string, log: Log, dirty = false) => { const st = state(), was = st.rejected?.head === head && st.rejected?.why === why;
  save({ ...st, rejected: { head, why, dirty, at: new Date().toISOString() } }); if (was) return; log(`update: not applying ${short(head)}: ${why}`); note({ result: "refused", to: short(head), why }); audit({ action: "git_pull_refused", to: head, why }); };
// put the checkout back (clean tree, so --keep never loses work)
function rollback(src: string, to: string, head: string, why: string, log: Log) {
  const r = git(src, "reset", "-q", "--keep", to);
  const st = state(); delete st.pending; save({ ...st, head: to, rejected: { head, why, at: new Date().toISOString() } });
  log(`update: ${short(head)} ${why}; ${r.code ? `couldn't go back to ${short(to)} (${r.err})` : `went back to ${short(to)}`}`);
  note({ result: "rolled back", from: short(to), to: short(head), why }); audit({ action: "git_pull_rolled_back", from: to, to: head, why });
  return !r.code;
}

// the new code must load and reach the server before the runner restarts into it
export function selfcheck(src: string, cfgPath: string): { ok: boolean; out: string } {
  const env = { ...process.env } as any; delete env.KITEBOOK_TASK_ID;
  const p = Bun.spawnSync([process.execPath, join(src, "client", "runner.ts"), "selfcheck", resolve(cfgPath)], { cwd: src, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 90_000 });
  const out = (p.stdout.toString() + p.stderr.toString()).trim();
  return { ok: p.exitCode === 0 && /selfcheck ok/.test(out), out: out.split("\n").slice(-3).join(" | ").slice(0, 300) };
}

// deps: npm (or bun) install when package.json / a lockfile changed between the two commits. KITEBOOK_UPGRADE_NPM overrides npm (tests).
function deps(src: string, prev: string | null, head: string, log: Log): boolean {
  if (!prev || git(src, "diff", "--quiet", prev, head, "--", "package.json", "package-lock.json", "bun.lock", "bun.lockb").code === 0) return true;
  const PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":"); // launchd's PATH is short
  const npm = process.env.KITEBOOK_UPGRADE_NPM || Bun.which("npm", { PATH }), argv = npm ? [npm, "install", "--no-audit", "--no-fund"] : [process.execPath, "install"];
  log(`update: dependencies changed; ${argv.slice(0, 2).join(" ")}`);
  const p = Bun.spawnSync(argv, { cwd: src, env: { ...process.env, PATH }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10 * 60_000 });
  if (p.exitCode) log(`update: dependency install failed (${p.stderr.toString().trim().split("\n").pop()}); the runner carries on, kitebook doctor shows what's missing`);
  return p.exitCode === 0;
}

// Runner start-up, before it connects. Returns the host-upgrade approval for a verified pull (null: none).
export async function onStart(src: string, cfgPath: string, log: Log, cfg?: any): Promise<{ why: string } | null> {
  if (process.env.KITEBOOK_TASK_ID || !isCheckout(src, cfg)) return null;
  let st = state(); const head = git(src, "rev-parse", "HEAD").out;
  if (st.head === head && !st.pending) return null;
  if (st.pending?.head === head) { // restarted into a verified update: count the try; three starts that never reached the server = roll back
    st.pending.tries = (st.pending.tries ?? 0) + 1; save(st);
    if (st.pending.tries > 3 && st.pending.prev) { rollback(src, st.pending.prev, head, "didn't start (never reached the server after 3 starts)", log); process.exit(1); }
  } else {
    const v = verify(src, st.pending?.prev ?? undefined);
    if (!v.ok) { if (v.retry) log(`update: ${short(head)} not checked yet: ${v.why}`); else if (st.head) reject(head, v.why, log);
      else { log(`update: running ${short(head)} as found (${v.why}); a later git pull is checked against it`); save({ ...st, head, origin: git(src, "remote", "get-url", "origin").out || undefined }); }
      return null; }
    if (!v.prev || v.prev === head) { save({ ...st, head, origin: v.origin }); return null; } // first run with nothing to compare: this is the baseline
    st = { ...st, origin: v.origin, pending: { head, prev: v.prev, ref: v.ref, tries: 1, steps: false } }; delete st.rejected; save(st);
    log(`update: ${short(v.prev)} -> ${short(head)} (a fast-forward on origin/${v.ref}); applying`); audit({ action: "git_pull", from: v.prev, to: head, ref: v.ref });
  }
  if (st.pending.steps) return null; // post-update steps already ran for this commit
  if (!st.pending.deps) deps(src, st.pending.prev, head, log); // the watcher already installed them before its selfcheck
  save({ ...state(), pending: { ...state().pending, steps: true } });
  return { why: `git pull to ${short(head)}` };
}
// health check passed (the runner reached the server): this commit is the good one now
export function started(src: string, log: Log) {
  const st = state(); if (!st.pending || !existsSync(join(src, ".git"))) return; const head = git(src, "rev-parse", "HEAD").out; if (st.pending.head !== head) return;
  const from = st.pending.prev; delete st.pending; save({ ...st, head });
  log(`update: updated to ${short(head)} (from ${short(from)})`); note({ result: "installed", from: short(from), to: short(head) });
}

// Kitebook's own updater (service.ts gitUpdate: kitebook update, Settings -> Update now, the automatic update) moves this checkout too. It
// approves and health-checks its commit itself, so it marks the move as its own and the watcher stays out of it (no second check,
// restart or "installed by git pull"); when it ends, the commit it left (new, or rolled back) is the one later pulls are compared against.
export function ownUpdate(src: string, phase: "start" | "done") { try { if (!existsSync(join(src, ".git"))) return; const st = state();
  if (phase === "start") save({ ...st, updating: { at: Date.now() } });
  else { delete st.updating; delete st.pending; delete st.rejected; save({ ...st, head: git(src, "rev-parse", "HEAD").out || st.head, origin: git(src, "remote", "get-url", "origin").out || st.origin }); } } catch {} }
// relay_update with Experimental on moved the runner's own checkout (git-channel.ts devUpdate, through service.ts): the next start counts its tries
// like a verified pull's (onStart: three starts that never reach the server roll it back; started() marks it good)
export function expectStart(src: string, prev: string, head: string, ref: string) { try { const st = state(); delete st.rejected;
  save({ ...st, head: prev, pending: { head, prev, ref, tries: 0, steps: true, deps: true } }); } catch {} }
const updating = (st: any) => !!st.updating && Date.now() - Number(st.updating.at) < 15 * 60_000;

// The running runner: watch HEAD; a verified move = restart once idle (restart() sets the existing restart-runner flag)
export function watchHead(src: string, cfgPath: string, o: { log: Log; restart: (why: string) => void; every?: number; cfg?: any }) {
  if (process.env.KITEBOOK_TASK_ID || !isCheckout(src, o.cfg)) return;
  let running = git(src, "rev-parse", "HEAD").out, busy = false, timer: any = null, done = false;
  const tick = () => { if (busy || done) return; busy = true; try {
    const head = git(src, "rev-parse", "HEAD").out; if (!head || head === running) return;
    { const st = state(); if (updating(st)) return; if ((st.head === head && !st.pending) || st.pending?.head === head) { running = head; return; } } // ... or relay_update with Experimental on did (expectStart) // Kitebook's own updater moved it (ownUpdate)
    // a refused commit is looked at again only when the tree's state changed, or every 10 minutes (each check fetches origin)
    const st = state(), dirty = !!git(src, "status", "--porcelain", "--untracked-files=no").out;
    if (st.rejected?.head === head && !!st.rejected.dirty === dirty && Date.now() - Date.parse(st.rejected.at) < 10 * 60_000) return;
    const v = verify(src, running);
    if (!v.ok) { if (!v.retry) reject(head, v.why, o.log, dirty); return; }
    // deps first: a pull that adds a package would otherwise fail its selfcheck and be rolled back every time
    const dp = deps(src, running, head, o.log), sc = selfcheck(src, cfgPath);
    if (!sc.ok) { if (rollback(src, running, head, `failed its health check (${sc.out || "no output"})`, o.log)) running = git(src, "rev-parse", "HEAD").out; return; }
    const s2 = state(); delete s2.rejected; save({ ...s2, origin: v.origin, pending: { head, prev: running, ref: v.ref, tries: 0, steps: false, deps: dp } });
    audit({ action: "git_pull", from: running, to: head, ref: v.ref }); done = true;
    o.restart(`git pull: ${short(running)} -> ${short(head)} (origin/${v.ref}) checked; restarting into it once idle`);
  } finally { busy = false; } };
  const gd = git(src, "rev-parse", "--absolute-git-dir").out;
  try { watch(gd, { persistent: false }, () => { clearTimeout(timer); timer = setTimeout(tick, 1500); }); } catch {} // HEAD, ORIG_HEAD, packed-refs...
  setInterval(tick, Math.max(5, o.every ?? 30) * 1000);
}
// scripts/get.sh run again moves the checkout too (and puts it back when the newest server won't start): `bun client/git-pull.ts own start|done <checkout>`
if (import.meta.main) (await import("./rebrand.ts")).migrateDirs(); // an install from before the rename: its folders take the new names first (client/rebrand.ts)
if (import.meta.main && process.argv[2] === "own" && (process.argv[3] === "start" || process.argv[3] === "done") && process.argv[4]) ownUpdate(resolve(process.argv[4]), process.argv[3]);
