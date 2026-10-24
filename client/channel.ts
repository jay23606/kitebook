// Which Kitebook code runs, and on which channel (frictions, 2026-10-21: nobody could tell remotely which version a server or runner ran,
// and a Mac that pulled origin dev while its checkout sat on local main showed "29 commits ahead of origin/main, not pushed").
//   build(src)        { version, commit, channel, branch } of a git checkout: what the runner advertises (describe, Settings -> Updates);
//                     vite.config.ts bakes the same thing into the server bundle (__KITEBOOK_BUILD__, describe.server / Settings).
//   channelOf(src)    "main" (the stable channel), "dev" (where tested builds land before main) or "local" (on neither origin branch):
//                     a checkout on branch dev counts as dev; otherwise main when origin/main has HEAD, else dev when origin/dev has it.
//   followChannel()   keeps a checkout whose HEAD is on origin/dev but not origin/main on a `dev` branch tracking origin/dev, so `git pull`,
//                     `kitebook update` and code_status follow dev instead of calling dev commits unpushed local work on main. Only a clean
//                     tree (tracked files; untracked files like bun.lock never block), only to a branch at the very same commit (no file
//                     changes), and the old branch goes back to origin/main only when nothing on it is lost (all of it is on origin/dev).
// Plain node:child_process so vite.config.ts (node) and the runner (bun) share it. Never fetches: it reads the refs the checkout has.
import { execFileSync } from "node:child_process";

export type Build = { version: string; commit: string | null; channel: "main" | "dev" | "local" | "release" | "unknown"; branch: string | null; dirty?: boolean };
const git = (src: string, ...a: string[]): { ok: boolean; out: string } => {
  try { return { ok: true, out: execFileSync("git", ["-C", src, ...a], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim() }; }
  catch { return { ok: false, out: "" }; } };
const has = (src: string, ref: string) => git(src, "rev-parse", "--verify", "-q", `${ref}^{commit}`).ok;
const anc = (src: string, a: string, b: string) => git(src, "merge-base", "--is-ancestor", a, b).ok;
const onRef = (src: string, ref: string) => has(src, ref) && anc(src, "HEAD", ref);

export function channelOf(src: string, remote = "origin"): "main" | "dev" | "local" {
  const br = git(src, "symbolic-ref", "-q", "--short", "HEAD").out;
  if (br === "dev" && onRef(src, `${remote}/dev`)) return "dev";
  if (onRef(src, `${remote}/main`)) return "main";
  if (onRef(src, `${remote}/dev`)) return "dev";
  return "local";
}

// version: the newest v* tag when there is one (v1.2.0-3-gabc1234), else <channel>-<commit date>-<short sha>, like the dev prereleases' names
export function build(src: string): Build | null {
  const head = git(src, "rev-parse", "HEAD"); if (!head.ok || !head.out) return null;
  const channel = channelOf(src), short = head.out.slice(0, 7), tag = git(src, "describe", "--tags", "--abbrev=7", "--match", "v[0-9]*");
  const date = git(src, "log", "-1", "--format=%cs").out.replace(/-/g, ".");
  const dirty = !!git(src, "status", "--porcelain", "--untracked-files=no").out;
  return { version: tag.ok && tag.out ? tag.out : `${channel}-${date || "unknown"}-${short}`, commit: head.out, channel, branch: git(src, "symbolic-ref", "-q", "--short", "HEAD").out || null, ...(dirty ? { dirty } : {}) };
}

export type Follow = { switched: boolean; branch: string | null; why: string; reset?: string };
export function followChannel(src: string, o: { log?: (...a: any[]) => void; audit?: (e: any) => void; remote?: string } = {}): Follow {
  const r = o.remote ?? "origin", dev = `${r}/dev`, main = `${r}/main`, cur = git(src, "symbolic-ref", "-q", "--short", "HEAD").out || null;
  const done = (switched: boolean, why: string, x: Partial<Follow> = {}): Follow => ({ switched, branch: cur, why, ...x });
  if (!git(src, "rev-parse", "HEAD").ok) return done(false, "not a git checkout");
  if (cur === "dev") { // already on dev: make sure it tracks origin/dev, so a plain git pull / kitebook update follows it
    if (has(src, dev) && git(src, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").out !== dev) git(src, "branch", "-q", "--set-upstream-to", dev, "dev");
    return done(false, "on the dev branch"); }
  if (!has(src, dev) || !onRef(src, dev)) return done(false, "HEAD isn't on origin/dev");
  if (onRef(src, main)) return done(false, "HEAD is on origin/main (the stable channel)");
  if (git(src, "status", "--porcelain", "--untracked-files=no").out) return done(false, "the checkout has local changes to tracked files");
  const head = git(src, "rev-parse", "HEAD").out, local = git(src, "rev-parse", "--verify", "-q", "refs/heads/dev");
  if (local.ok && local.out !== head) { if (!anc(src, local.out, head)) return done(false, "a local dev branch has commits of its own (left alone)");
    if (!git(src, "update-ref", "refs/heads/dev", head, local.out).ok) return done(false, "couldn't move the local dev branch"); }
  if (!local.ok && !git(src, "branch", "-q", "dev", head).ok) return done(false, "couldn't create a dev branch");
  git(src, "branch", "-q", "--set-upstream-to", dev, "dev");
  if (!git(src, "switch", "-q", "dev").ok) return done(false, "git switch dev failed");
  // the branch it left (usually main, fast-forwarded onto dev commits): back to origin/main when every commit on it is on origin/dev
  let reset: string | undefined;
  if (cur && cur !== "dev" && has(src, main)) { const tip = git(src, "rev-parse", `refs/heads/${cur}`).out, to = git(src, "rev-parse", main).out;
    if (tip && to && tip !== to && anc(src, to, tip) && anc(src, tip, dev) && git(src, "update-ref", `refs/heads/${cur}`, to, tip).ok) reset = `${cur} back to ${main} (${to.slice(0, 7)})`; }
  const why = `HEAD ${head.slice(0, 7)} is on ${dev}, not ${main}: now on the dev branch (tracking ${dev})${reset ? `; ${reset}` : ""}`;
  o.log?.(`channel: ${why}`); o.audit?.({ type: "service", action: "channel_dev", from_branch: cur, head, ...(reset ? { reset } : {}) });
  return { switched: true, branch: "dev", why, ...(reset ? { reset } : {}) };
}
