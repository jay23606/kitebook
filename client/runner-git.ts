// Runner git-first helpers: tasks name code by git (repo + base); results carry branch/base/commit/diff stat/compare URL.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { sh, cfg } from "./runner-ctx.ts";

// ---- git-first: tasks name code by git (repo + base); results carry branch/base/commit/diff stat/compare URL ----
// The project's push remote as configured (insteadOf not expanded), without credentials, so dispatchers can match `repo` against it.
export async function originOf(proj: any): Promise<string | null> {
  if (!proj?.path || !existsSync(proj.path)) return null;
  // advertise asks every minute: re-run git only when the repo's .git/config (or ~/.gitconfig) changed since the last answer
  const sig = (() => { try { const a = statSync(join(proj.path, ".git", "config")); let g = ""; try { g = String(statSync(join(homedir(), ".gitconfig")).mtimeMs); } catch {} return `${proj.remote ?? "origin"}:${a.mtimeMs}:${a.size}:${g}`; } catch { return null; } })();
  const memo = originMemo.get(proj.path); if (sig && memo?.sig === sig) return memo.url;
  const u = (await sh(["git", "config", "--get", `remote.${proj.remote ?? "origin"}.url`], proj.path)).out.trim();
  const url = u ? u.replace(/^(https?:\/\/)[^@/]+@/, "$1") : null; if (sig) originMemo.set(proj.path, { sig, url }); return url;
}
export const originMemo = new Map<string, { sig: string; url: string | null }>();
export const normRemote = (u: string) => String(u ?? "").toLowerCase().replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@/, "https://").replace(/\.git$/, "").replace(/\/+$/, "");
export async function projectForRepo(repo: string): Promise<string | null> { // the server maps repo -> project when we've advertised; this covers the rest
  if (cfg.projects?.[repo]) return repo;
  for (const [k, v] of Object.entries<any>(cfg.projects ?? {})) { const o = await originOf(v); if (o && normRemote(o) === normRemote(repo)) return k; }
  return null;
}
// base = branch, tag or sha. Local first, else fetched from the remote (a branch someone just pushed). Returns a commit sha or null.
export async function resolveBase(dir: string, base: string, remote: string): Promise<string | null> {
  const rev = async (r: string) => { const x = await sh(["git", "rev-parse", "--verify", "-q", `${r}^{commit}`], dir); return x.code === 0 ? x.out.trim() : null; };
  const local = await rev(base) ?? await rev(`${remote}/${base}`); if (local) return local;
  if ((await sh(["git", "fetch", "-q", remote, base], dir)).code === 0) return rev("FETCH_HEAD");
  return null;
}
// https://github.com/o/r/compare/<base>...<branch> for GitHub remotes (https, ssh, git@), else null.
export function compareUrl(remote: string | null, base: string | null, branch: string) {
  const m = String(remote ?? "").match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m && base ? `https://github.com/${m[1]}/${m[2]}/compare/${base}...${branch.split("/").map(encodeURIComponent).join("/")}` : null;
}
export async function diffStat(dir: string, base: string | null) {
  if (!base) return { files: 0, insertions: 0, deletions: 0 };
  const o = (await sh(["git", "diff", "--shortstat", base, "HEAD"], dir)).out, n = (re: RegExp) => Number(o.match(re)?.[1] ?? 0);
  return { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?/), deletions: n(/(\d+) deletions?/) };
}
