// The update path's server step: an update the owner approved (kitebook update in Terminal, Settings -> Updates "Update to dev now")
// also upgrades a Mac host whose server is still the old `cf dev` one (Vite: it serves runner.json, .dev.vars and the data through
// /@fs) with scripts/upgrade-mac-host.sh (stop cf dev, copy code + data, workerd on the tunnel's port, health + leak check (a failed upgrade stays stopped), new admin token, new runner token, runner restarted). Nobody pastes a command: the owner's own service processes run it.
// Two ways in, both reached only through an owner-approved update of THIS checkout to the commit it runs now (its HEAD):
//   1. runner start-up (onStart): an older updater (afa48a4 and before) fast-forwards the checkout, copies src/ into the server folder,
//      restarts cf dev and then restarts the runner, which is the first time new code runs. The new runner looks for the owner's
//      approval of exactly this HEAD (runner.json "updatePin" == HEAD: `kitebook pin` or the Settings click, both owner-only; or an audit
//      entry from the owner's own `kitebook update` / Settings click that moved the checkout to HEAD) and starts the upgrade before it
//      connects. One try per approval: a failed upgrade (stopped, it says so) waits for the next owner update or `kitebook update`.
//   2. post-update (every update from this version on): service.ts gitUpdate runs the NEW checkout's
//      `bun client/host-upgrade.ts post-update <runner.json>` right after the fast-forward, so the code that was just approved decides
//      what its own update needs (today: this server step). Same approval check.
// Agents can't start it: no op, MCP tool or kitebook-svc verb reaches it, a task's process (KITEBOOK_TASK_ID) is refused, a runner restart
// alone (kitebook-svc restart runner) finds no fresh approval, and an agent's own update is refused unless the owner pinned the commit.
// The script runs detached (its own session) so it outlives the runner restart it does at the end; its output goes to
// ~/.kitebook/host-upgrade.out and ~/Library/Logs/kitebook-upgrade.log (never a token). State: ~/.kitebook/host-upgrade.json.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, statSync, readSync, appendFileSync, realpathSync, rmSync, renameSync, utimesSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { homedir } from "os";
import { spawn } from "child_process";

const STATE = () => join(homedir(), ".kitebook");
const stateFile = () => join(STATE(), "host-upgrade.json"), outFile = () => join(STATE(), "host-upgrade.out");
const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
// the job under its pre-rename name (dev.relay.server) until client/rebrand.ts or the upgrade itself gives it the new one
const plistOf = () => { const d = join(homedir(), "Library", "LaunchAgents"), n = join(d, "dev.kitebook.server.plist"), o = join(d, "dev.relay.server.plist"); return !existsSync(n) && existsSync(o) ? o : n; };
const pval = (x: string, k: string) => x.replace(/\s+/g, " ").match(new RegExp(`<key>${k}</key> ?<string>([^<]*)</string>`))?.[1] ?? null;
export type Host = { plist: string; dir: string; path: string | null };

// The old host: launchd's dev.kitebook.server job still runs cf dev (not scripts/serve.sh), and it is THIS runner's server: runner.json
// "server.dir", or the job's folder when runner.json lives in it (as on hosts set up before server.dir existed). Anything else
// (another config on the same Mac, a test's HOME) is left alone.
export function oldHost(cfg: any, cfgPath: string): Host | null {
  if (process.platform !== "darwin" && !cfg.launchctl) return null;
  let x = ""; try { x = readFileSync(plistOf(), "utf8"); } catch { return null; }
  if (/scripts\/serve\.sh/.test(x)) return null;
  const wd = pval(x, "WorkingDirectory"), dir = cfg.server?.dir ? resolve(expand(String(cfg.server.dir))) : wd && resolve(cfgPath).startsWith(resolve(wd) + "/") ? resolve(wd) : null;
  return dir ? { plist: plistOf(), dir, path: pval(x, "PATH") } : null;
}
export const headOf = (src: string) => { const p = Bun.spawnSync(["git", "-C", src, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" }); return p.exitCode ? null : p.stdout.toString().trim(); };
export const sourceOf = (cfg: any, here = import.meta.path) => resolve(expand(String(cfg.source ?? join(dirname(here), ".."))));
export const lastRun = (): any => { try { return JSON.parse(readFileSync(stateFile(), "utf8")); } catch { return null; } };
const save = (s: any) => { mkdirSync(STATE(), { recursive: true, mode: 0o700 }); writeFileSync(stateFile(), JSON.stringify(s, null, 1), { mode: 0o600 }); };

function auditTail(): any[] { const f = join(STATE(), "audit.jsonl"); let fd = -1;
  try { fd = openSync(f, "r"); const size = statSync(f).size, n = Math.min(size, 1 << 20), b = Buffer.alloc(n); readSync(fd, b, 0, n, size - n);
    return b.toString("utf8").split("\n").flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }); }
  catch { return []; } finally { if (fd >= 0) closeSync(fd); } }
// The owner's approval of exactly this HEAD, newer than the last try. What counts (each written only by the owner's own act):
// "Newer" is by position in the hash-chained audit log: a try records the audit line it started after.
//   runner.json updatePin == HEAD   kitebook pin <sha> (owner terminal only) or the Settings click (owner-signed, Experimental); no time, so
//                                   it counts once per HEAD
//   audit: service update / fast_forward / host_upgrade by "owner cli" to HEAD (kitebook update; refused for tasks without the owner's pin),
//          update_ref to HEAD (the Settings click, after the Mac checked the owner's signature and Experimental)
export function approval(cfg: any, head: string): { why: string; at: string } | null {
  const last = lastRun(), tried = last?.head === head;
  for (const e of auditTail().reverse()) { if (last?.after && e.hash === last.after) break; // "newer than the last try": after the audit line it was started at (no clocks)
    const to = String(e.result?.to ?? e.to ?? ""); if (to.length < 7 || !head.startsWith(to)) continue;
    if (e.type === "service" && e.by === "owner cli" && ["update", "fast_forward", "host_upgrade"].includes(e.action)) return { why: e.action === "host_upgrade" ? "kitebook update" : "your update", at: e.ts };
    if (e.type === "update_ref") return { why: `Update to ${e.ref ?? "main"} now (Settings)`, at: e.ts }; }
  if (!tried && cfg.updatePin && cfg.updatePin === head) return { why: "your approved update (pinned commit)", at: new Date().toISOString() };
  return null;
}

// Start scripts/upgrade-mac-host.sh from this checkout, detached. wait: resolve when it ends (the runner restart at its end may end
// the caller first, which is fine). The PATH carries the old server job's (node lives there) plus the usual Homebrew places.
export function start(o: { cfgPath: string; source: string; host: Host; head: string; by: string; log: (...a: any[]) => void; stdout?: "file" | "inherit" }): Promise<number> {
  const script = join(o.source, "scripts", "upgrade-mac-host.sh"); if (!existsSync(script)) { o.log(`host upgrade: ${script} is missing`); return Promise.resolve(127); }
  save({ head: o.head, at: new Date().toISOString(), by: o.by, state: "running", after: auditTail().pop()?.hash ?? null });
  const env: Record<string, string> = { ...process.env as any, KITEBOOK_SERVER_DIR: o.host.dir, KITEBOOK_RUNNER_CONFIG: resolve(o.cfgPath),
    PATH: [o.host.path, dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].filter(Boolean).join(":") };
  delete env.KITEBOOK_TASK_ID;
  mkdirSync(STATE(), { recursive: true, mode: 0o700 }); const fd = o.stdout === "inherit" ? 2 : openSync(outFile(), "w", 0o600);
  // a detached supervisor (this file, _run) runs the script and records how it ended, so the state is right even when the runner that
  // started it is restarted by the script itself
  const p = spawn(process.execPath, [import.meta.path, "_run", script], { cwd: o.source, env, detached: true, stdio: ["ignore", fd, fd] }); if (typeof fd === "number" && fd > 2) closeSync(fd);
  save({ ...lastRun(), pid: p.pid ?? null });
  o.log(`host upgrade: the server is still the old cf dev one; upgrading it now (${o.by}). Progress: ~/Library/Logs/kitebook-upgrade.log`);
  return new Promise(res => { p.on("exit", code => { const c = code ?? 1;
      o.log(`host upgrade: ${c === 0 ? "finished" : `didn't finish (exit ${c}); the server stays stopped if its upgrade failed. See ~/Library/Logs/kitebook-upgrade.log; kitebook update tries again`}`); res(c); });
    p.on("error", e => { o.log("host upgrade:", e.message); res(1); }); });
}

// ---- a workerd host (scripts/serve.sh, the production server since upgrade-mac-host.sh) ----
// U1 (owner, 2026-10-23 04:06): relay_update moved the checkout and restarted the runner, but the server folder kept its old src/ and
// bundle, so new routes (/connect, /device) stayed 404 while the update said "updated, health ok". This is the NEW code's own post-update
// step for such a host: when the server doesn't run this checkout's HEAD (it says which commit on /health?build=1, local listener only),
// copy the committed code into the server folder (git archive: tracked files only, so .dev.vars, runner.json, node_modules and the data are
// never touched; the same files upgrade-mac-host.sh's copy keeps), npm install when the lockfile changed, build with the commit baked in,
// restart the server job (launchd kickstart, by this process: nobody runs launchctl), then wait until /health?build=1 names HEAD. Anything
// else puts the previous bundle and sources back, restarts, and says so (~/Library/Logs/kitebook-upgrade.log). It runs in a detached
// supervisor (_sync) so a runner restart can't cut it off halfway.
export type WHost = { plist: string; label: string; dir: string; path: string | null; port: number };
export function workerdHost(cfg: any, cfgPath: string): WHost | null {
  if (process.platform !== "darwin" && !cfg.launchctl) return null;
  const plist = plistOf(); let x = ""; try { x = readFileSync(plist, "utf8"); } catch { return null; }
  if (!/scripts\/serve\.sh/.test(x)) return null;
  const wd = pval(x, "WorkingDirectory"), dir = cfg.server?.dir ? resolve(expand(String(cfg.server.dir))) : wd ? resolve(expand(wd)) : null;
  return dir ? { plist, label: basename(plist, ".plist"), dir, path: pval(x, "PATH"), port: Number(pval(x, "PORT")) || 7820 } : null;
}
// the commit the server says it runs: a sha, null (it answers but doesn't say: code from before /health?build=1), undefined (no answer)
export async function servedCommit(h: { port: number }, ms = 3000): Promise<string | null | undefined> {
  try { const r = await fetch(`http://127.0.0.1:${h.port}/health?build=1`, { signal: AbortSignal.timeout(ms) }); if (!r.ok) return undefined;
    const j: any = await r.json().catch(() => ({})); return typeof j.commit === "string" && j.commit ? j.commit : null; } catch { return undefined; }
}
const fileSum = (f: string) => { try { return new Bun.CryptoHasher("sha256").update(readFileSync(f)).digest("hex"); } catch { return null; } };
const realp = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
export type SyncPlan = { action: "none" | "sync"; why: string; copy: boolean; npm: boolean };
export function syncPlan(h: WHost, source: string, head: string, served: string | null | undefined): SyncPlan {
  if (served === head) return { action: "none", why: `the server already runs ${head.slice(0, 7)}`, copy: false, npm: false };
  // a server that runs from this checkout itself (get.sh, mac-host.sh): the update's own restart rebuilds it (serve.sh: sources newer than
  // the bundle) and its health check + rollback already cover it (service.ts gitUpdate); only a separate server folder is left behind (U1)
  if (realp(h.dir) === realp(source)) return { action: "none", why: "the server runs from this checkout (its restart rebuilds it)", copy: false, npm: false };
  const copy = true;
  const npm = copy && (!existsSync(join(h.dir, "node_modules")) || fileSum(join(h.dir, "package-lock.json")) !== fileSum(join(source, "package-lock.json")));
  return { action: "sync", copy, npm, why: served === undefined ? `the server doesn't answer on 127.0.0.1:${h.port}` : served ? `the server runs ${served.slice(0, 7)}, not ${head.slice(0, 7)}` : "the server doesn't say which commit it runs (older code)" };
}
const syncFile = () => join(STATE(), "server-sync.json");
export const lastSync = (): any => { try { return JSON.parse(readFileSync(syncFile(), "utf8")); } catch { return null; } };
const saveSync = (s: any) => { mkdirSync(STATE(), { recursive: true, mode: 0o700 }); writeFileSync(syncFile(), JSON.stringify(s, null, 1), { mode: 0o600 }); };
const ulog = (...a: any[]) => { const l = `${new Date().toISOString().replace("T", " ").slice(0, 19)} server update: ${a.join(" ")}`; console.error(l);
  try { const d = join(homedir(), "Library", "Logs"); mkdirSync(d, { recursive: true }); appendFileSync(join(d, "kitebook-upgrade.log"), l + "\n"); } catch {} };
const BUNDLE_DIR = join(".cloudflare", "output"), BUNDLE = join(BUNDLE_DIR, "v0", "workers", "default", "bundle", "index.js");
const sh = (cmd: string[], o: { cwd?: string; env?: any; stdin?: any } = {}) => { const p = Bun.spawnSync(cmd, { cwd: o.cwd, env: o.env, stdin: o.stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString().trim() }; };
// git archive <rev> | tar -x into dir: the committed tree only (never .git, .dev.vars, runner.json, data, node_modules)
const extract = (source: string, rev: string, dir: string) => { const a = Bun.spawnSync(["git", "-C", source, "archive", rev], { stdout: "pipe", stderr: "pipe" });
  if (a.exitCode) return `git archive ${rev.slice(0, 7)}: ${a.stderr.toString().trim().slice(0, 200)}`;
  const t = Bun.spawnSync(["tar", "-xf", "-", "-C", dir], { stdin: a.stdout, stdout: "pipe", stderr: "pipe" }); return t.exitCode ? `tar: ${t.stderr.toString().trim().slice(0, 200)}` : null; };
// the server job's restart, by this process (launchd kickstart -k; runner.json "launchctl" for tests)
export const kickServer = (cfg: any, h: WHost) => sh([cfg.launchctl ?? "/bin/launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${h.label}`]);
async function waitFor(h: WHost, ok: (c: string | null | undefined) => boolean, sec: number) {
  let c: string | null | undefined; for (let i = 0; i < sec; i++) { c = await servedCommit(h, 2000); if (ok(c)) return { ok: true, c }; await Bun.sleep(1000); } return { ok: false, c }; }

// the sync itself (in the detached _sync supervisor). from: the commit the checkout came from (its sources go back on failure)
export async function serverSync(o: { cfg: any; cfgPath: string; source: string; head: string; from: string | null; host: WHost; plan: SyncPlan; served: string | null | undefined }): Promise<{ ok: boolean; why: string | null; rolled_back?: string }> {
  const { cfg, source, head, from, host: h, plan } = o, dir = h.dir, out = join(dir, BUNDLE_DIR), prev = join(dir, ".cloudflare", "output.prev");
  const env: any = { ...process.env, PATH: [h.path, dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].filter(Boolean).join(":") }; delete env.KITEBOOK_TASK_ID;
  const lock = join(STATE(), "server-sync.lock");
  try { mkdirSync(lock); } catch { let pid = 0; try { pid = Number(readFileSync(join(lock, "pid"), "utf8")); } catch {}
    if (pid && alive(pid)) return { ok: false, why: `another server update is running (pid ${pid})` }; rmSync(lock, { recursive: true, force: true }); mkdirSync(lock); }
  writeFileSync(join(lock, "pid"), String(process.pid));
  saveSync({ head, from, state: "running", why: plan.why, served_before: o.served ?? null, at: new Date().toISOString(), pid: process.pid });
  ulog(`${dir}: ${plan.why}; updating it to ${head.slice(0, 7)}${plan.copy ? ` from ${source}` : ""}`);
  let npmRan = false;
  const fail = async (why: string) => {
    ulog(`FAILED: ${why}; putting the previous server back`); const notes: string[] = [];
    if (plan.copy && from) { const e = extract(source, from, dir); if (e) notes.push(`sources: ${e}`); } else if (plan.copy) notes.push("sources: no previous commit known, the new sources stay (the previous bundle runs)");
    if (npmRan) { const n = sh(["bash", "-c", process.env.KITEBOOK_UPGRADE_NPM || "npm install --no-audit --no-fund"], { cwd: dir, env }); if (n.code) notes.push("npm install (previous lockfile) failed"); }
    if (existsSync(prev)) { rmSync(out, { recursive: true, force: true }); try { renameSync(prev, out); } catch (e: any) { notes.push(`bundle: ${e.message}`); } }
    const b = join(dir, BUNDLE); if (existsSync(b)) { const t = new Date(); try { utimesSync(b, t, t); } catch {} } // newer than every source: serve.sh serves it as is, no rebuild
    if (o.served) writeFileSync(join(dir, ".kitebook-commit"), o.served + "\n"); else rmSync(join(dir, ".kitebook-commit"), { force: true });
    const k = kickServer(cfg, h); if (k.code) notes.push(`restart: ${k.err.slice(0, 120)}`);
    const back = await waitFor(h, c => c !== undefined, Number(process.env.KITEBOOK_SYNC_HEALTH_SEC) || 120);
    const rb = notes.length || !back.ok ? `previous server back${back.ok ? " and answering" : " but NOT answering"}${notes.length ? ` (${notes.join("; ")})` : ""}` : "previous server back and answering";
    ulog(rb); saveSync({ ...lastSync(), state: "failed", why, rolled_back: rb, ended: new Date().toISOString() }); return { ok: false, why, rolled_back: rb };
  };
  try {
    rmSync(prev, { recursive: true, force: true }); if (existsSync(out)) renameSync(out, prev); // the bundle that runs now: the rollback (one file, not a backup of data)
    if (plan.copy) { const e = extract(source, head, dir); if (e) return await fail(`couldn't copy the code (${e})`); ulog(`copied ${head.slice(0, 7)} into ${dir}`); }
    if (plan.npm) { npmRan = true; const n = sh(["bash", "-c", process.env.KITEBOOK_UPGRADE_NPM || "npm install --no-audit --no-fund"], { cwd: dir, env }); if (n.code || process.env.KITEBOOK_UPGRADE_FAIL === "npm") return await fail(`npm install failed (${n.err.split("\n").pop()?.slice(0, 160) ?? n.code})`); ulog("npm install done"); }
    const B = (await import("./channel.ts")).build(source);
    const benv = { ...env, KITEBOOK_BUILD_COMMIT: head, KITEBOOK_BUILD_VERSION: B?.version ?? "", KITEBOOK_BUILD_CHANNEL: B?.channel ?? "" };
    const bc = process.env.KITEBOOK_SYNC_BUILD ? ["bash", "-c", process.env.KITEBOOK_SYNC_BUILD] : ["bash", join(dir, "scripts", "serve.sh"), "build"];
    const bl = sh(bc, { cwd: dir, env: benv }); if (bl.code || !existsSync(join(dir, BUNDLE))) return await fail(`the server didn't build (${(bl.err || bl.out).trim().split("\n").pop()?.slice(0, 160) ?? `exit ${bl.code}`})`);
    writeFileSync(join(dir, ".kitebook-commit"), head + "\n"); ulog("built");
    const k = kickServer(cfg, h); if (k.code) return await fail(`couldn't restart the server job ${h.label} (${k.err.slice(0, 160)})`);
    const w = await waitFor(h, c => c === head, Number(process.env.KITEBOOK_SYNC_HEALTH_SEC) || 120);
    if (!w.ok || process.env.KITEBOOK_UPGRADE_FAIL === "health") return await fail(`the restarted server ${w.c === undefined ? "didn't answer" : `runs ${w.c ? w.c.slice(0, 7) : "an unnamed commit"}, not ${head.slice(0, 7)}`} on 127.0.0.1:${h.port}/health`);
    rmSync(prev, { recursive: true, force: true });
    ulog(`done: the server runs ${head.slice(0, 7)}`); saveSync({ ...lastSync(), state: "done", why: null, ended: new Date().toISOString() }); return { ok: true, why: null };
  } catch (e: any) { return await fail(String(e?.message ?? e).slice(0, 200)); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}
// run serverSync in a detached supervisor (its own session: it outlives a runner restart) and wait for it
export function startSync(a: { cfgPath: string; source: string; head: string; from: string | null }): Promise<number> {
  const env: any = { ...process.env }; delete env.KITEBOOK_TASK_ID;
  for (const k of ["NO_PROXY", "no_proxy"]) env[k] = [env[k], "127.0.0.1", "localhost"].filter(Boolean).join(","); // the server's own /health is on loopback: never through a proxy
  mkdirSync(STATE(), { recursive: true, mode: 0o700 }); const fd = openSync(join(STATE(), "server-sync.out"), "w", 0o600); // its output: a file, never a pipe that dies with the runner
  const p = spawn(process.execPath, [import.meta.path, "_sync", a.cfgPath, a.head, a.from ?? "-"], { cwd: a.source, env, detached: true, stdio: ["ignore", fd, fd] }); closeSync(fd);
  return new Promise(res => { p.on("exit", c => res(c ?? 1)); p.on("error", () => res(1)); });
}

const alive = (pid: any) => { try { return !!pid && process.kill(Number(pid), 0); } catch { return false; } };
// What `kitebook status` says about it (null: nothing to say)
export function statusLine(cfg: any, cfgPath: string): string | null {
  const h = oldHost(cfg, cfgPath), l = lastRun();
  if (!h) return null;
  if (l?.state === "running" && alive(l.pid)) return "upgrading the old cf dev server now (log: ~/Library/Logs/kitebook-upgrade.log)";
  return `the server is the old cf dev one, which serves your files to anyone with its address${l?.state && l.state !== "done" ? ` (the last upgrade didn't finish: ~/Library/Logs/kitebook-upgrade.log)` : ""}. Fix: kitebook update`;
}

// runner start-up: the first run of new code after an older updater moved the checkout here
// pulled: a git pull client/git-pull.ts verified (a fast-forward to a commit on origin main/dev) is the approval; once per commit
export async function onStart(cfg: any, cfgPath: string, log: (...a: any[]) => void, pulled?: { why: string } | null): Promise<void> {
  if (process.env.KITEBOOK_TASK_ID) return;
  const host = oldHost(cfg, cfgPath); if (!host) return;
  const source = sourceOf(cfg), head = headOf(source); if (!head) return;
  let ok = approval(cfg, head) ?? (pulled && lastRun()?.head !== head ? { why: pulled.why, at: new Date().toISOString() } : null);
  // the owner's kitebook update writes its audit entry just after it restarts the runner: give it a moment
  for (let i = 0; !ok && i < 20; i++) { await Bun.sleep(1500); ok = approval(cfg, head); }
  if (!ok) { log("host upgrade: the server is still the old cf dev one (it leaks); it's upgraded by your next update (git pull in the Kitebook checkout, kitebook update, or Update to dev now in Settings)"); return; }
  clearPin(cfgPath, head);
  await start({ cfgPath, source, host, head, by: ok.why, log });
}
// an applied pin (== HEAD) is done; left in runner.json it would hold every later update at this commit (the Settings click's own
// cleanup never runs when the update restarts the runner under it)
function clearPin(cfgPath: string, head: string) { try { const c = JSON.parse(readFileSync(cfgPath, "utf8")); if (c.updatePin !== head) return; delete c.updatePin;
  writeFileSync(cfgPath, JSON.stringify(c, null, 2), { mode: 0o600 }); import("./guard.ts").then(G => G.stampOwnerEdit(cfgPath)).catch(() => {}); } catch {} }

// `bun client/host-upgrade.ts post-update <runner.json> [--in-runner]`: run by gitUpdate (service.ts) from the checkout it just moved,
// so new code decides its own update step. Prints one JSON line: { post_update, server_handled, runner_restarts }.
//   check <runner.json>: what it would do (old host? approval?), changes nothing
if (import.meta.main) for (const k of ["NO_PROXY", "no_proxy"]) process.env[k] = [process.env[k], "127.0.0.1", "localhost"].filter(Boolean).join(","); // the server's /health?build=1 is loopback: never via a proxy
if (import.meta.main) (await import("./rebrand.ts")).migrateDirs(); // an install from before the rename: its folders take the new names first (client/rebrand.ts)
if (import.meta.main && process.argv[2] === "_sync") { // the supervisor startSync spawns: <runner.json> <head> <from|->
  if (process.env.KITEBOOK_TASK_ID) process.exit(1);
  const [, , , cp, head, from0] = process.argv, from = from0 && from0 !== "-" ? from0 : null; let cfg: any = {}; try { cfg = JSON.parse(readFileSync(cp, "utf8")); } catch { process.exit(1); }
  const h = workerdHost(cfg, cp), source = sourceOf(cfg); if (!h) process.exit(1);
  const served = await servedCommit(h), plan = syncPlan(h, source, head, served);
  if (plan.action === "none") { saveSync({ head, from, state: "done", why: null, served_before: served, at: new Date().toISOString(), ended: new Date().toISOString() }); process.exit(0); }
  const r = await serverSync({ cfg, cfgPath: cp, source, head, from, host: h, plan, served }); process.exit(r.ok ? 0 : 1);
}
if (import.meta.main && process.argv[2] === "_run") { // the supervisor start() spawns: run the script, record the outcome
  if (process.env.KITEBOOK_TASK_ID) process.exit(1);
  const p = Bun.spawn(["bash", process.argv[3]], { stdin: "ignore", stdout: "inherit", stderr: "inherit" }), c = await p.exited;
  save({ ...lastRun(), state: c === 0 ? "done" : "failed", code: c, ended: new Date().toISOString() }); process.exit(c);
}
if (import.meta.main) {
  const [cmd, cfgPath = "runner.json", ...rest] = process.argv.slice(2), inRunner = rest.includes("--in-runner");
  const say = (r: any) => console.log(JSON.stringify(r));
  let cfg: any = {}; try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch (e: any) { say({ post_update: "error", error: `can't read ${cfgPath}` }); process.exit(1); }
  const host = oldHost(cfg, cfgPath), source = sourceOf(cfg), head = headOf(source);
  if (cmd === "check") { const wh = workerdHost(cfg, cfgPath), served = wh ? await servedCommit(wh) : undefined;
    say({ old_host: !!host, workerd_host: wh ? { dir: wh.dir, port: wh.port, served: served ?? null, plan: head ? syncPlan(wh, source, head, served) : null } : null, last_sync: lastSync(), server_dir: host?.dir ?? null, head, approval: head ? approval(cfg, head) : null, last: lastRun() }); process.exit(0); }
  if (cmd !== "post-update") { console.error("usage: bun client/host-upgrade.ts post-update|check <runner.json> [--in-runner]"); process.exit(2); }
  if (process.env.KITEBOOK_TASK_ID) { say({ post_update: "refused", error: "only the machine owner's update runs this (not a task)" }); process.exit(1); }
  // the new code's own post-update step: the kitebook command and its PATH line (client/cli-path.ts), on every update, old host or not
  try { (await import("./cli-path.ts")).ensureCli(cfg, cfgPath, (...a: any[]) => console.error(a.join(" ")), { verify: true }); } catch {}
  // a workerd host: its server folder gets this commit's code and restarts on it (serverSync above). The caller (service.ts gitUpdate) runs
  // the runner's own restart afterwards as usual (runner_restarts: false). --caller-rolls-back: a gitUpdate that knows this step puts the
  // checkout back itself on failure; an older one (1f96351 and before) doesn't, so this step does (git reset --keep to where it came from)
  const wh = workerdHost(cfg, cfgPath);
  if (wh && head) {
    const fi = rest.indexOf("--from"), from0 = fi >= 0 ? rest[fi + 1] : Bun.spawnSync(["git", "-C", source, "rev-parse", "-q", "--verify", "ORIG_HEAD"], { stdout: "pipe" }).stdout.toString().trim();
    const from = from0 && from0 !== head && !Bun.spawnSync(["git", "-C", source, "merge-base", "--is-ancestor", from0, head]).exitCode ? from0 : null;
    const served = await servedCommit(wh), plan = syncPlan(wh, source, head, served);
    if (plan.action === "none") { say({ post_update: "nothing to do", server_handled: false, server_sha: head }); process.exit(0); }
    console.error(`server update: ${plan.why}; updating the server in ${wh.dir} (log: ~/Library/Logs/kitebook-upgrade.log)`);
    const c = await startSync({ cfgPath: resolve(cfgPath), source, head, from }), st = lastSync();
    if (c === 0) { say({ post_update: "server updated", server_handled: true, runner_restarts: false, server_sha: head }); process.exit(0); }
    const why = st?.head === head && st?.why ? st.why : `the server update didn't finish (exit ${c})`;
    let back: string | null = null;
    if (!rest.includes("--caller-rolls-back") && from) { const r = Bun.spawnSync(["git", "-C", source, "reset", "-q", "--keep", from], { stdout: "pipe", stderr: "pipe" });
      back = r.exitCode ? `couldn't put the checkout back to ${from.slice(0, 7)}` : `the checkout went back to ${from.slice(0, 7)}`;
      try { (await import("./updater.ts")).note({ result: "rolled back", why: `server_update_failed: ${why}`, from: from.slice(0, 7), to: head.slice(0, 7), release: null, by: "server update", at: new Date().toISOString() }); } catch {} }
    say({ post_update: "server_update_failed", server_handled: true, runner_restarts: false, error: `${why}${st?.rolled_back ? `; ${st.rolled_back}` : ""}${back ? `; ${back}` : ""}`, log: "~/Library/Logs/kitebook-upgrade.log" }); process.exit(1);
  }
  if (!host || !head) { say({ post_update: "nothing to do", server_handled: false }); process.exit(0); }
  const ok = approval(cfg, head);
  if (!ok) { say({ post_update: "refused", server_handled: false, error: "no owner-approved update to this commit" }); process.exit(1); }
  clearPin(cfgPath, head);
  const log = (...a: any[]) => console.error(a.join(" "));
  if (inRunner) { start({ cfgPath, source, host, head, by: ok.why, log }); say({ post_update: "server upgrade started", server_handled: true, runner_restarts: true }); process.exit(0); } // detached: lives on after this
  const c = await start({ cfgPath, source, host, head, by: ok.why, log, stdout: "inherit" });
  say({ post_update: c === 0 ? "server upgraded" : "server upgrade failed", server_handled: true, runner_restarts: true, code: c }); process.exit(c ? 1 : 0);
}
