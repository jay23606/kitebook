// Safe updates: moving this Mac to the newest OFFICIAL release needs nobody's y, because nobody picks the code. The only release that
// installs on its own is one signed with the release key this Mac already pinned (runner.json "releaseKey" or client/release-key.ts,
// never a key the new release brings along) and numbered higher than what runs now (integrity.ts v2 signatures), so a Kitebook server, a network
// in between or an agent can't hand it other code or an older release with a known bug. Used by:
//   kitebook update            (the owner's terminal: signed -> no prompt; the y/N stays only for unsigned updates, client/service.ts)
//   kitebook-svc update        (an agent inside a task: signed newer release only, else refused with the reason)
//   relay_update            (the op any connected agent can call, no arguments; the runner does it here, client/settings-sync.ts; on a git
//                           install with Experimental on it moves the checkout to origin/dev instead: client/git-channel.ts devUpdate)
//   Settings -> Updates     Update now (an owner-signed click: also approves an unsigned release on an install with no key pinned)
//                           and "Install signed updates automatically" (runner.json "autoUpdate", ON unless the owner turns it off;
//                           applied when idle)
// Every install: check -> download + verify every file (integrity.ts installVersion keeps the previous version) -> health check (the new
// runner.ts must load: `runner.ts --help`) -> on failure switch `current` back to the previous version. Then the kitebook command
// (~/.local/bin/kitebook) and the agents' MCP entries are brought in line, and the runner restarts once its tasks are done (the caller).
// What happened goes to ~/.kitebook/updates.json (the newest 20, shown in Settings) and the audit log.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { migrateCommands } from "./rebrand.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, renameSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import * as PL from "./platform.ts";
import * as I from "./integrity.ts";
import * as G from "./git-channel.ts";
import * as CP from "./cli-path.ts"; // the kitebook command on PATH, checked at the end of every update (client/cli-path.ts)
import * as B from "./binary.ts"; // the compiled kitebook binary updates from GitHub Releases instead (same Check/Outcome shapes)

export type State = "newer" | "up_to_date" | "older" | "unsigned" | "bad" | "no_key" | "no_number" | "not_installed" | "unreachable";
export type Check = { state: State; why: string | null; kind?: string; channel?: string; notes?: string | null; current: string | null; current_release: number; latest: string | null; latest_release: number | null; key_pinned: boolean; checked_at: string };
export type Outcome = { result: "installed" | "up to date" | "refused" | "rolled back"; why: string | null; from: string | null; to: string | null; release: number | null; by: string; at: string; wrapper?: string | null; agents?: string[]; cli?: string | null };

// where releases come from: the server itself, or runner.json "releaseUrl" (owner-only; any mirror is fine, the signature decides)
export const sourceOf = (cfg: any) => String(cfg.releaseUrl || cfg.url || "").replace(/\/+$/, "");
const logFile = (h: string) => join(h, "updates.json");
export const history = (h = I.home()): Outcome[] => { try { const j = JSON.parse(readFileSync(logFile(h), "utf8")); return Array.isArray(j) ? j : []; } catch { return []; } };
export const recordOutcome = (o: Outcome, h = I.home()) => record(o, h); // client/git-pull.ts: a git pull's outcome in the same history
export const note = recordOutcome; // a git update (service.ts) goes into the same history
function record(o: Outcome, h: string) { try { mkdirSync(h, { recursive: true, mode: 0o700 }); writeFileSync(logFile(h), JSON.stringify([...history(h), o].slice(-20)), { mode: 0o600 }); } catch {} }

// What an update would do right now, in words the owner (and an agent) can act on. Only "newer" installs without the owner.
export async function check(cfg: any, h = I.home()): Promise<Check> {
  if (B.active()) return await B.check(cfg) as Check;
  const inst = I.verifyInstall(h), key = I.releaseKey(cfg), cur = inst.installed ? inst.version : null, curRel = inst.installed ? I.installedRelease(h) : 0;
  const base = { current: cur, current_release: curRel, latest: null as string | null, latest_release: null as number | null, key_pinned: !!key, checked_at: new Date().toISOString() };
  if (!inst.installed) return { ...base, state: "not_installed", why: "This runner runs from a Kitebook checkout, so it updates with git, not from a release." };
  let m; try { m = await I.fetchManifest(sourceOf(cfg)); } catch (e: any) { return { ...base, state: "unreachable", why: `couldn't read the latest release (${e.message})` }; }
  const x = { ...base, latest: m.version, latest_release: I.sigRelease(m.sig) };
  if (m.version === cur) return { ...x, state: "up_to_date", why: null };
  if (!key) return { ...x, state: "no_key", why: "This Mac has no release key pinned, so it can't tell an official release from any other code by itself." };
  const c = I.checkSig(m.text, m.sig, key);
  if (!c.ok) return { ...x, state: m.sig ? "bad" : "unsigned", latest_release: null, why: `release signature refused: ${c.error}` };
  if (c.release == null) return { ...x, state: "no_number", why: "The latest release is signed but has no release number (signed before numbers existed), so it can't be told apart from an older one." };
  if (c.release <= curRel) return { ...x, state: "older", why: `release ${c.release} is not newer than the installed release ${curRel} (going back to an older release is refused)` };
  return { ...x, state: "newer", why: null };
}

// The new code has to load before it counts: `bun runner.ts --help` imports every runner module and prints the usage.
export function health(h = I.home()): { ok: boolean; why: string | null } {
  try { const p = Bun.spawnSync([process.execPath, join(h, "current", "runner.ts"), "--help"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000, env: { ...process.env, KITEBOOK_TASK_ID: "" } as any });
    if (p.exitCode === 0 && p.stdout.toString().includes("usage (bun")) return { ok: true, why: null };
    return { ok: false, why: (p.stderr.toString().trim().split("\n").filter(Boolean).slice(-2).join(" ") || `exit ${p.exitCode}`).slice(0, 300) }; }
  catch (e: any) { return { ok: false, why: e.message }; }
}

// the kitebook command install.sh put on PATH, rewritten to run the current install (only a file that is Kitebook's own: '# Kitebook CLI')
export function refreshWrapper(cfg: any, cfgPath: string, h = I.home()): string | null {
  try { migrateCommands(); } catch {} // a relay wrapper from before the rename: kitebook from now on, relay as a shim (client/rebrand.ts)
  const dir = process.env.KITEBOOK_TASK_ID ? join(homedir(), ".local", "bin") : process.env.KITEBOOK_BIN_DIR || join(homedir(), ".local", "bin"), f = join(dir, "kitebook");
  if (PL.plat() === "win32") { // kitebook.cmd in %LOCALAPPDATA%\Kitebook\bin (scripts/get.ps1 put it there and on the user's PATH)
    const wf = join(process.env.KITEBOOK_BIN_DIR || PL.binDir(), "kitebook.cmd"); let wc = ""; try { wc = readFileSync(wf, "utf8"); } catch { return null; } if (!/^rem Kitebook CLI/m.test(wc)) return null;
    const w = PL.cliWrapper(process.execPath, join(h, "current", "cli.ts"), wc.match(/KITEBOOK_RUNNER_CONFIG=([^"\r\n]+)"/)?.[1] ?? resolve(cfgPath), wc.match(/installed by ([^:\r\n]+):/)?.[1] ?? "get.ps1", "win32");
    if (wc === w.text) return "unchanged"; writeFileSync(wf, w.text); return wf; }
  let cur = ""; try { cur = readFileSync(f, "utf8"); } catch { return null; } if (!/^# Kitebook CLI/m.test(cur)) return null;
  const conf = cur.match(/KITEBOOK_RUNNER_CONFIG:-([^}"]+)\}/)?.[1] ?? resolve(cfgPath), url = cur.match(/installed by (\S+)\/install\.sh/)?.[1] ?? String(cfg.url).replace(/\/+$/, ""); // keep what install.sh said
  const want = `#!/bin/sh\n# Kitebook CLI, installed by ${url}/install.sh: kitebook status | restart | update | logs | stop | start | doctor, and every kitebook op\nexport KITEBOOK_RUNNER_CONFIG="\${KITEBOOK_RUNNER_CONFIG:-${conf}}"\nexec "${process.execPath}" "${h}/current/cli.ts" "$@"\n`;
  if (cur === want) return "unchanged"; writeFileSync(f + ".tmp", want, { mode: 0o755 }); renameSync(f + ".tmp", f); return f;
}

const lockDir = (h: string) => join(h, "update.lock");
function lock(h: string): boolean { const d = lockDir(h); mkdirSync(h, { recursive: true, mode: 0o700 });
  try { if (Date.now() - statSync(d).mtimeMs > 10 * 60_000) rmSync(d, { recursive: true, force: true }); } catch {}
  try { mkdirSync(d); return true; } catch { return false; } }

// Update to the latest release. Installs on its own only when check() says "newer" (signed with the pinned key, higher number).
// approved: the release version the owner approved with a signed click (Settings -> Update now) or at the terminal; that also lets an
// install with no key pinned, or a signed release with no number, update (still never a bad signature or an older numbered release).
export async function apply(cfg: any, o: { by: string; cfgPath: string; approved?: string; home?: string }): Promise<Outcome> {
  const h = o.home ?? I.home(), at = new Date().toISOString();
  if (B.active()) { const r = await B.apply(cfg, { by: o.by, approved: o.approved }) as Outcome; if (r.result === "installed") { const cli = pathCheck(cfg, o.cfgPath); if (cli) r.cli = cli; } if (r.result !== "up to date") record(r, h); return r; }
  const done = (x: Omit<Outcome, "by" | "at">): Outcome => { const r = { ...x, by: o.by, at }; if (r.result !== "up to date") record(r, h); return r; };
  const c = await check(cfg, h);
  if (c.state === "up_to_date") return done({ result: "up to date", why: null, from: c.current, to: c.current, release: c.current_release || null });
  const owner = !!o.approved && (c.state === "no_key" || c.state === "no_number");
  if (o.approved && o.approved !== c.latest && c.state !== "newer") return done({ result: "refused", why: `the latest release changed since it was approved (${o.approved} -> ${c.latest ?? "none"}); look again`, from: c.current, to: c.latest, release: c.latest_release });
  if (c.state !== "newer" && !owner) return done({ result: "refused", why: c.why, from: c.current, to: c.latest, release: c.latest_release });
  if (!lock(h)) return done({ result: "refused", why: "another update is running right now", from: c.current, to: c.latest, release: c.latest_release });
  try {
    const prev = c.current!;
    try { await I.installVersion(sourceOf(cfg), { expect: c.latest!, key: I.releaseKey(cfg), home: h, ...(c.state === "newer" ? { above: c.current_release } : {}) }); }
    catch (e: any) { return done({ result: "refused", why: e.message, from: prev, to: c.latest, release: c.latest_release }); }
    const hc = health(h);
    if (!hc.ok) { let back = prev; try { I.switchTo(prev, h); } catch (e: any) { back = `nothing (${e.message})`; } I.stampInstall(h);
      return done({ result: "rolled back", why: `release ${c.latest_release ?? c.latest} didn't start (${hc.why}); went back to ${back}`, from: prev, to: c.latest, release: c.latest_release }); }
    I.stampInstall(h); // the guard's baseline: an install made here is the owner's, not a task tampering with the runner
    let wrapper: string | null = null, agents: string[] = [];
    try { wrapper = refreshWrapper(cfg, o.cfgPath, h); } catch {}
    try { agents = (await import("./agents-connect.ts")).refreshConfigs(String(cfg.url)); } catch {}
    const cli = pathCheck(cfg, o.cfgPath); // after the wrapper: does a fresh login shell find kitebook? (repaired once; else the exact fix)
    return done({ result: "installed", why: null, from: prev, to: c.latest, release: c.latest_release, wrapper, agents, ...(cli ? { cli } : {}) });
  } finally { rmSync(lockDir(h), { recursive: true, force: true }); }
}

// the end of every update: the kitebook command on a new shell's PATH (repaired once); the exact fix when it still isn't, else null
const pathCheck = (cfg: any, cfgPath: string) => { try { return CP.ensureCli(cfg, cfgPath, () => {}, { verify: true }).fix; } catch { return null; } };
// What Settings -> Updates shows (through settings_report): the last check, the toggle, recent installs and asks.
let last: Check | null = null, lastAt = 0;
export const lastCheck = () => last;
export async function refresh(cfg: any, h = I.home()) { last = await check(cfg, h); lastAt = Date.now(); return last; }
export const autoOn = (cfg: any) => cfg.autoUpdate !== false; // on by default: a signed release is the official one, so nobody needs to look
// a git checkout (scripts/get.sh, mac-host.sh): "git" says where it stands against main, and its toggle is runner.json autoUpdate === true
export const report = (cfg: any, h = I.home(), pending: any = null) => { const g = last?.state === "not_installed" || G.gitMode(cfg) ? G.lastInfo() : null;
  const lv = CP.lastVerify(); // the kitebook command not on PATH after the last install / update: Settings shows the fix
  return { check: last, auto: g ? G.autoOn(cfg) : autoOn(cfg), history: history(h).slice(-10).reverse(), pending, ...(g ? { git: g } : {}), ...(lv && !lv.ok ? { cli: lv.fix } : {}) }; };
// Runner loop: check every KITEBOOK_UPDATE_CHECK_MS (default 6 h); unless "autoUpdate" is false, install a signed newer release when idle.
export function startUpdates(x: { cfg: () => any; cfgPath: string; idle: () => boolean; log: (...a: any[]) => void; audit: (e: any) => void; installed: (o: Outcome) => void; changed: () => void }) {
  const every = Math.max(1000, Number(process.env.KITEBOOK_UPDATE_CHECK_MS ?? 6 * 3600_000) || 6 * 3600_000); let busy = false;
  const mayAuto = !process.env.KITEBOOK_TEST || !!process.env.KITEBOOK_UPDATE_CHECK_MS; // test runners install by themselves only when the test asks
  const tick = async () => { if (busy) return; busy = true;
    try { const cfg = x.cfg(), before = JSON.stringify(last && { ...last, checked_at: 0 }); const c = await refresh(cfg);
      if (JSON.stringify({ ...c, checked_at: 0 }) !== before) x.changed();
      if (mayAuto && autoOn(cfg) && c.state === "newer" && x.idle()) { const r = await apply(cfg, { by: "automatic update", cfgPath: x.cfgPath });
        x.audit({ type: "update", by: r.by, result: r.result, from: r.from, to: r.to, release: r.release, why: r.why }); x.log(`update (automatic): ${r.result}${r.why ? ": " + r.why : ""}`);
        await refresh(cfg); x.changed(); if (r.result === "installed") x.installed(r); }
      if (c.state === "not_installed" && G.gitMode(cfg)) { const before = JSON.stringify(G.lastInfo() && { ...G.lastInfo(), checked_at: 0 }); const g = G.info(cfg, Math.min(every, 5 * 60_000));
        if (JSON.stringify({ ...g, checked_at: 0 }) !== before) x.changed();
        if (mayAuto) { const r = await G.auto(cfg, x.cfgPath, x); if (r) { x.log(`update (automatic): ${r}`); x.changed(); } } } }
    catch (e: any) { x.log("update check:", e.message); } finally { busy = false; } };
  setTimeout(tick, 2000); return setInterval(() => { if (Date.now() - lastAt >= every) tick(); }, Math.min(every, 60_000));
}
