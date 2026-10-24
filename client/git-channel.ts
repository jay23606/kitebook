// Updates for a Mac that runs Kitebook from a git checkout (scripts/get.sh, the one-step install, and older mac-host.sh hosts): the stable
// channel is the `main` branch (it moves only by scripts/promote.sh: green CI + a real Mac run); Experimental adds the `dev` channel (Settings
// -> Update to dev now, settings-sync.ts). What this module adds to service.ts's git update:
//   info()   where the checkout stands against origin/main (fetched at most every few minutes), for Settings -> Updates and the Status card
//   auto()   "Install updates automatically": runner.json "autoUpdate": true (the one-step installer writes it; older git installs keep it off
//            until the owner ticks the box in Settings, so a push to main never reaches a Mac whose owner didn't choose that). Only while the
//            runner is idle, only a fast-forward to origin/main, and a commit that was rolled back once is not tried again by itself.
// Nobody but the owner can turn it on: runner.json is the owner's file (an agent's edit is caught by the guard's owner-edit stamp), the
// Settings toggle is an owner-signed command checked on this Mac, and an agent's relay_update / kitebook-svc update never picks a ref.
// The update itself is service.ts's (the owner's approval of this exact commit = updatePin, as a Settings click does), so the new runner
// must load (`runner.ts --help`) before anything restarts, the server must pass its health check, else the checkout goes back.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import * as I from "./integrity.ts";

export const STABLE = "main";
export type GitInfo = { head: string; stable: string | null; behind: number; ahead: number; channel: string; checked_at: string; error: string | null; dev?: string | null; dev_behind?: number };
export const gitMode = (cfg: any) => !!cfg.source || !I.isInstalledPath(import.meta.path);
export const sourceDir = (cfg: any) => resolve(String(cfg.source ?? join(dirname(import.meta.path), "..")).replace(/^~(?=\/|$)/, homedir()));
export const autoOn = (cfg: any) => cfg.autoUpdate === true; // git: off unless the owner (or the one-step installer) turned it on
const git = (src: string, ...a: string[]) => { const p = Bun.spawnSync(["git", "-C", src, ...a], { stdout: "pipe", stderr: "pipe", stdin: "ignore" }); return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }; };

let last: GitInfo | null = null, lastFetch = 0;
export const lastInfo = () => last;
export function info(cfg: any, fetchEveryMs = 5 * 60_000): GitInfo {
  const src = sourceDir(cfg), at = new Date().toISOString();
  let error: string | null = null;
  if (Date.now() - lastFetch >= fetchEveryMs) { const f = git(src, "fetch", "-q", "origin"); lastFetch = Date.now(); if (f.code) error = `couldn't check for updates (${f.err.split("\n").pop()?.slice(0, 160)})`; }
  const head = git(src, "rev-parse", "HEAD").out, st = git(src, "rev-parse", "--verify", "-q", `origin/${STABLE}^{commit}`);
  const stable = st.code ? null : st.out, count = (r: string) => Number(git(src, "rev-list", "--count", r).out) || 0;
  const behind = stable ? count(`HEAD..${stable}`) : 0, ahead = stable ? count(`${stable}..HEAD`) : 0;
  const dv = git(src, "rev-parse", "--verify", "-q", "origin/dev^{commit}"), dev = dv.code ? null : dv.out; // what relay_update moves to with Experimental on
  return last = { head: head.slice(0, 12), stable: stable?.slice(0, 12) ?? null, behind, ahead, channel: ahead && !behind ? "dev" : STABLE, checked_at: at, error: error ?? (stable ? null : `no ${STABLE} branch on origin`),
    dev: dev?.slice(0, 12) ?? null, dev_behind: dev ? count(`HEAD..${dev}`) : 0 };
}

// one automatic update to origin/main, if everything says yes. Returns what happened (null: nothing to do).
export async function auto(cfg: any, cfgPath: string, x: { idle: () => boolean; log: (...a: any[]) => void; audit: (e: any) => void }): Promise<string | null> {
  if (!autoOn(cfg) || !gitMode(cfg) || !x.idle()) return null;
  const g = info(cfg); if (!g.stable || !g.behind) return null;
  const src = sourceDir(cfg), want = git(src, "rev-parse", `origin/${STABLE}`).out;
  if (git(src, "merge-base", "--is-ancestor", "HEAD", want).code) return null; // not a fast-forward (a dev checkout ahead, rewritten history): leave it to the owner
  const U = await import("./updater.ts"); // a commit that already failed here isn't retried by itself (Update now still can)
  if (U.history().some(h => h.result === "rolled back" && h.to && want.startsWith(h.to))) return null;
  const raw = JSON.parse(readFileSync(cfgPath, "utf8")); raw.updatePin = want; writeFileSync(cfgPath, JSON.stringify(raw, null, 2), { mode: 0o600 });
  const G = await import("./guard.ts"); G.stampOwnerEdit(cfgPath); // the owner's standing choice ("autoUpdate") is the approval; recorded as such
  x.audit({ type: "update_ref", ref: STABLE, to: want, from: git(src, "rev-parse", "HEAD").out, how: "automatic update (runner.json autoUpdate)" });
  x.log(`automatic update: ${g.head.slice(0, 7)} -> ${want.slice(0, 7)} (${g.behind} new commit${g.behind === 1 ? "" : "s"} on ${STABLE})`);
  const { service } = await import("./service.ts"); let code = 1;
  try { code = await service(cfgPath, ["update"], { inRunner: true, by: "automatic update" }); }
  finally { const now = JSON.parse(readFileSync(cfgPath, "utf8")); delete now.updatePin; writeFileSync(cfgPath, JSON.stringify(now, null, 2), { mode: 0o600 }); G.stampOwnerEdit(cfgPath); }
  lastFetch = 0; info(cfg);
  return code ? "not updated (see Settings -> Updates)" : `updated to ${want.slice(0, 7)}`;
}

// ---- relay_update on a git install (owner, 2026-10-21: "in dev mode, an assistant or agent should be able to update the Mac's Kitebook to the
// latest code"; 2026-10-22: "never through Pi or any coding-agent task"; 19:16: "it must not require dev mode" (dev mode is Experimental since 2026-10-23); 22:00: "update is fine, just
// remove those barriers except it could only pull from latest": no owner approval any more, only ever the newest commit of the channel).
// client/settings-sync.ts handles an app's relay_update ask in the RUNNER process itself (no task, no agent) only when the server marked
// the asker as allowed to send tasks here and confirms (op policy, from) it is still one of the owner's own connected apps; Experimental on or
// off (Experimental only picks the channel, channels()). The ask has no arguments, so the app never picks the code: devCheck resolves whatever
// the channel's branch (origin's dev or main) is, fetched here into private refs (refs/relay-verify/*, like git-pull.ts), right before the
// move (settings-sync.ts devPending), and devUpdate moves to exactly that newest sha, only
//   - a clean tree, origin the same remote this Mac recorded (git-pull.ts state), no other remote ever,
//   - HEAD itself on origin's dev or main (not a local commit), the target sha on origin's dev or main too,
//   - a fast-forward, never back (no downgrade, no rewritten history).
// The move itself is service.ts's update, pinned to that sha (updatePin: the owner's choice to let apps update counts as an owner pin, as the
// Settings click does): the new runner must load, the server must pass its health check, else the checkout goes back. Then a self-check (load + reach the
// server, git-pull.ts selfcheck) and the runner restarts once idle; its start-up is watched like a git pull's (three starts that never
// reach the server roll it back, git-pull.ts expectStart).
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
export const ownCheckout = (src: string) => !I.isInstalledPath(import.meta.path) && real(resolve(dirname(import.meta.path), "..")) === real(src); // this runner's code is that checkout
export type DevResult = { state: "updated" | "up_to_date" | "refused" | "rolled_back" | "server_update_failed"; from: string | null; to: string | null; ref: string | null; why: string | null; sha?: string | null; health?: string | null };
const anc = (src: string, a: string, b: string) => git(src, "merge-base", "--is-ancestor", a, b).code === 0;
// Which origin branches an app's relay_update may move this checkout to (owner, 2026-10-22: the approval flow works with Experimental off too,
// but the channel stays what it was). Experimental on: dev, else main (as before). Experimental off: the branch the checkout already tracks (its
// upstream): origin/dev for an explicit dev checkout, origin/main otherwise (no upstream, e.g. a detached HEAD, counts as main, the stable
// channel). Another upstream (a feature branch) isn't a channel: the owner updates it.
export function channels(src: string, experimental: boolean): { refs: string[] } | { why: string } {
  if (experimental) return { refs: ["dev", "main"] };
  const u = git(src, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  if (u.code || !u.out) return { refs: ["main"] };
  const m = u.out.match(/^origin\/(.+)$/); if (m && (m[1] === "dev" || m[1] === "main")) return { refs: [m[1]] };
  return { why: `this checkout follows ${u.out}, not origin's main or dev, so it updates only when you do it (git pull or kitebook update)` };
}
// target: the sha the owner approved (devUpdate); without it, whatever the first of refs (origin's dev, else main, with Experimental on) is now
// (the ask, settings-sync.ts devAsk). refs: the channel (channels() above); a target must be on one of them.
export function devCheck(src: string, recordedOrigin?: string | null, target?: string | null, refs: string[] = ["dev", "main"]): DevResult & { want?: string; head?: string } {
  const r = (state: DevResult["state"], why: string | null, x: Partial<DevResult> = {}): any => ({ state, why, from: null, to: null, ref: null, ...x });
  const head = git(src, "rev-parse", "HEAD").out; if (!head) return r("refused", "this Mac doesn't run Kitebook from a git checkout, so there is no branch to update to");
  const from = head.slice(0, 7);
  if (git(src, "status", "--porcelain", "--untracked-files=no").out) return r("refused", "the Kitebook checkout has local changes; only a clean checkout is updated", { from });
  const origin = git(src, "remote", "get-url", "origin").out; if (!origin) return r("refused", "the Kitebook checkout has no origin remote", { from });
  if (recordedOrigin && recordedOrigin !== origin) return r("refused", `origin changed (${recordedOrigin} -> ${origin}); only the owner approves another remote (kitebook update in Terminal)`, { from });
  const got: Record<string, string> = {};
  for (const b of ["dev", "main"]) { git(src, "update-ref", "-d", `refs/relay-verify/${b}`);
    if (!git(src, "fetch", "-q", "--no-tags", "origin", `+refs/heads/${b}:refs/relay-verify/${b}`).code) got[b] = git(src, "rev-parse", `refs/relay-verify/${b}`).out; }
  if (!Object.keys(got).length) return r("refused", "couldn't reach origin to fetch dev or main", { from });
  if (!Object.values(got).some(w => anc(src, head, w))) return r("refused", `${from} isn't on origin's dev or main (a local commit, or one from another remote or branch); the owner updates it`, { from });
  if (target != null) { // exactly the approved commit: on origin's dev or main, a fast-forward of what runs, never back
    if (!/^[0-9a-f]{40}$/.test(target)) return r("refused", "the approved commit isn't a full sha", { from });
    const ref = refs.find(b => got[b] && anc(src, target, got[b])), to = target.slice(0, 7);
    if (!ref) return r("refused", refs.length > 1 ? `the approved commit ${to} is on neither origin's dev nor main any more` : `the approved commit ${to} isn't on origin/${refs[0]} (the branch this Mac follows)`, { from, to, sha: target });
    if (target === head) return r("up_to_date", null, { from, to, ref, sha: target });
    if (!anc(src, head, target)) return r("refused", anc(src, target, head) ? `the approved commit ${to} is older than what this Mac runs (${from}); going back is refused` : `the approved commit ${to} isn't a fast-forward of ${from}`, { from, to, ref, sha: target });
    return { ...r("updated", null, { from, to, ref, sha: target }), want: target, head }; }
  for (const ref of refs) { const want = got[ref]; if (!want) continue;
    if (want === head) return r("up_to_date", null, { from, to: from, ref });
    if (anc(src, head, want)) return { ...r("updated", null, { from, to: want.slice(0, 7), ref, sha: want }), want, head }; }
  const ref = refs.find(b => got[b]); if (!ref) return r("refused", `there's no ${refs.join(" or ")} branch on origin`, { from });
  const d = got[ref];
  return r("refused", anc(src, d, head) ? `origin/${ref} (${d.slice(0, 7)}) is older than what this Mac runs (${from}); going back is refused` : `origin/${ref} (${d.slice(0, 7)}) isn't a fast-forward of ${from} (rewritten history)`, { from, to: d.slice(0, 7), ref });
}
// check, then move to exactly the approved sha: pin it for this one update (service.ts gitUpdate), clear the pin whatever happens.
// approved: {sha, how}: the newest sha settings-sync.ts devPending just resolved (how "app": an app's relay_update, no approval needed).
// refs: the channel the ask was resolved on (an ask on main stays on main: a commit only dev has isn't approved through it).
export async function devUpdate(cfg: any, cfgPath: string, by: string, approved: { sha: string; how: string; refs?: string[] }, x: { audit: (e: any) => void; log: (...a: any[]) => void; stamp: (f: string) => void }): Promise<DevResult> {
  const src = sourceDir(cfg), GP = await import("./git-pull.ts"), U = await import("./updater.ts"), who = approved.how === "app" ? `${by} (relay_update)` : approved.how === "standing" ? `${by} (relay_update, without asking)` : `${by} (relay_update, approved by you)`;
  const c = devCheck(src, GP.state().origin ?? null, approved.sha, approved.refs), { want, head, ...res } = c;
  const record = (o: DevResult) => { if (o.state === "refused") U.recordOutcome({ result: "refused", why: o.why, from: o.from, to: o.to, release: null, by: who, at: new Date().toISOString() }); return o; };
  if (c.state !== "updated" || !want || !head) return record(res);
  const pin = (v: string | null) => { const raw = JSON.parse(readFileSync(cfgPath, "utf8")); if (v) raw.updatePin = v; else delete raw.updatePin; writeFileSync(cfgPath, JSON.stringify(raw, null, 2), { mode: 0o600 }); x.stamp(cfgPath); };
  x.audit({ type: "update_dev", by, ref: c.ref, from: head, to: want, how: approved.how === "app" ? "relay_update, the newest commit, no approval needed" : "relay_update, approved on the Mac", approved_by: approved.how === "app" ? "app (Let apps update Kitebook)" : approved.how === "standing" ? "owner (standing: Install updates without asking me)" : `owner (${approved.how === "shortcut" ? "fingerprint / face unlock" : "master password"}, kitebook confirm)` });
  x.log(`update asked by ${by}${approved.how === "app" ? "" : approved.how === "standing" ? ", approved by your standing setting" : ", approved by you"}: ${c.from} -> ${c.to} (origin/${c.ref}, exactly ${want})`);
  pin(want); const { service } = await import("./service.ts"); let code = 1;
  try { code = await service(cfgPath, ["update"], { inRunner: true, by: who, agent: true, noRestart: true }); } finally { pin(null); }
  const now = git(src, "rev-parse", "HEAD").out; lastFetch = 0; try { info(cfg, 0); } catch {}
  if (code || now !== want) { const h = U.history().slice(-1)[0], back = now === head;
    const sw = (h && h.to === c.to && h.why) || ""; // the server folder didn't take the new code (client/host-upgrade.ts serverSync): its own state, with the log
    if (back && /^server_update_failed/.test(sw)) return record({ state: "server_update_failed", from: c.from, to: c.to, ref: c.ref, sha: want, health: "failed", why: sw.replace(/^server_update_failed: /, "") + (/kitebook-upgrade\.log/.test(sw) ? "" : " (log: ~/Library/Logs/kitebook-upgrade.log)") });
    return record({ state: back ? "rolled_back" : "refused", from: c.from, to: c.to, ref: c.ref, sha: want, health: back ? "failed" : null, why: (h && h.to === c.to && h.why) || (back ? "the new code didn't pass its checks; went back" : `the update didn't finish (the checkout is at ${now.slice(0, 7)})`) }); }
  // self-check: the new runner must load AND reach the server (git-pull.ts selfcheck), else back to where it was, server included
  if (existsSync(join(src, "client", "runner.ts"))) { const sc = GP.selfcheck(src, cfgPath);
    if (!sc.ok) { const r = git(src, "reset", "-q", "--keep", head); try { await service(cfgPath, ["restart", "server"], { inRunner: true, by: who, agent: true }); } catch {}
      const why = `the new code failed its self-check (${sc.out || "no output"}); ${r.code ? `couldn't go back to ${c.from} (${r.err})` : `went back to ${c.from}`}`;
      x.audit({ type: "service", by, action: "update_rolled_back", from: head, to: want, why }); U.recordOutcome({ result: "rolled back", why, from: c.from, to: c.to, release: null, by: who, at: new Date().toISOString() });
      lastFetch = 0; try { info(cfg, 0); } catch {} return { state: "rolled_back", from: c.from, to: c.to, ref: c.ref, sha: want, health: "failed", why }; } }
  // the runner's own checkout: restart into it once idle (the restart-runner flag runner.ts watches); its next start is watched like a git pull's, and the kitebook command is brought in line (cli-on-path)
  if (ownCheckout(src)) { GP.expectStart(src, head, want, c.ref!);
    try { const f = (await import("./service.ts")).restartFlag("runner"); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, new Date().toISOString()); } catch {}
    try { const spec = "./cli-path" + ".ts", CP: any = await import(spec); CP.ensureCli?.(cfg, cfgPath, x.log); } catch {} }
  return { ...res, sha: want, health: "ok" };
}
