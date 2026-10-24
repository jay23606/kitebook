// Is path p (absolute, or relative to root) really inside root? The live drivers' file-change approvals (client/runner.ts liveApprove)
// allow an edit inside the task's worktree without asking, so this must follow the FILESYSTEM, not the spelling: a lexical check lets
// wt/link/x through when wt/link is a symlink the agent made to ~/.ssh. So: the realpath of the deepest part of p that exists, plus the
// rest (not created yet, so it can't be a link); a dangling symlink on the way, or a ".." anywhere in what was asked, is never "inside"
// (the OS resolves the link first, then the "..", which no spelling check gets right): those go to the owner's approval instead.
import { realpathSync, lstatSync } from "fs";
import { resolve, isAbsolute, dirname, basename, join, sep } from "path";

export function realish(p: string): string | null {
  let x = resolve(p); const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync(x), ...rest.reverse()); }
    catch { try { lstatSync(x); return null; } catch {} } // it exists but won't resolve: a dangling (or looping) symlink, where a write lands elsewhere
    const d = dirname(x); if (d === x) return resolve(p);
    rest.push(basename(x)); x = d;
  }
}
export function insideDir(p: string, root: string): boolean {
  const raw = isAbsolute(p) ? p : root + sep + p; if (raw.split(/[\\/]+/).includes("..")) return false;
  const r = realish(root), x = realish(raw); if (!r || !x) return false;
  return x === r || x.startsWith(r.endsWith(sep) ? r : r + sep);
}
