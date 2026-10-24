// Kitebook's own small service manager, for the machines that have no launchd or systemd --user: Windows (started at logon by a per-user
// Scheduled Task, no admin; else a Startup-folder launcher) and Linux without systemd (WSL without systemd, containers; started at desktop
// login by an XDG autostart entry). It does what launchd's KeepAlive does for the Mac: starts the job, restarts it 10 s after it stops
// (the runner exits on purpose to restart after an update), appends its output to a log file, and stays stopped after `kitebook stop`.
//   bun client/supervise.ts run <name>      the supervisor itself (what the logon task starts; one per job, a second one exits)
// service.ts drives it through install / start / stop / kick / running; nobody types these.
// State per job in ~/.kitebook/svc/<name>/: job.json {argv, cwd, env, log}, sup.pid, child.pid, stop (kitebook stop), kick (restart now).
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, openSync, closeSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import * as P from "./platform.ts";

export type Job = { argv: string[]; cwd?: string; env?: Record<string, string>; log: string };
export const svcDir = (name: string) => join(process.env.KITEBOOK_SVC_DIR || join(homedir(), ".kitebook", "svc"), name); // KITEBOOK_SVC_DIR: tests
const f = (name: string, x: string) => join(svcDir(name), x);
const readPid = (file: string) => { try { const n = Number(readFileSync(file, "utf8").trim()); return n > 0 ? n : null; } catch { return null; } };
export const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };
export const job = (name: string): Job | null => { try { return JSON.parse(readFileSync(f(name, "job.json"), "utf8")); } catch { return null; } };
export const installed = (name: string) => existsSync(f(name, "job.json"));
export const supPid = (name: string) => { const p = readPid(f(name, "sup.pid")); return alive(p) ? p : null; };
export const childPid = (name: string) => { const p = readPid(f(name, "child.pid")); return alive(p) ? p : null; };
export const running = (name: string) => !!supPid(name) && !!childPid(name);
// stopped on purpose (kitebook stop) and still down: what launchd shows as unloaded, so status says "start it", not "DOWN"
export const stopped = (name: string) => existsSync(f(name, "stop")) && !supPid(name);
const killTree = (pid: number) => { if (P.plat() === "win32") return P.killTreeWin(pid); try { process.kill(-pid, "SIGTERM"); } catch {} try { process.kill(pid, "SIGTERM"); } catch {} };
const self = () => join(dirname(import.meta.path), "supervise.ts");
// the command a logon hook runs: bun supervise.ts run <name>
export const runArgv = (name: string) => [process.execPath, self(), "run", name];

// ---- control (service.ts) ----
export function start(name: string): { code: number; out: string; err: string } {
  if (!installed(name)) return { code: 1, out: "", err: `not installed (no ${f(name, "job.json")})` };
  rmSync(f(name, "stop"), { force: true });
  if (supPid(name)) return { code: 0, out: "already running", err: "" };
  const p = Bun.spawn(runArgv(name), { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true, windowsHide: true, env: process.env } as any); p.unref();
  return { code: 0, out: "started", err: "" };
}
export async function stop(name: string, waitMs = 5000): Promise<{ code: number; out: string; err: string }> {
  if (!installed(name)) return { code: 1, out: "", err: "not installed" };
  writeFileSync(f(name, "stop"), new Date().toISOString());
  const s = supPid(name), c = childPid(name); if (c) killTree(c); if (s) killTree(s);
  for (let i = 0; i < waitMs / 100 && (alive(s) || alive(c)); i++) await Bun.sleep(100);
  return { code: 0, out: "stopped", err: "" };
}
// restart now: the supervisor starts the job again at once (no 10 s pause); a stopped job is started
export function kick(name: string): { code: number; out: string; err: string } {
  if (!installed(name)) return { code: 1, out: "", err: "not installed" };
  if (!supPid(name)) return start(name);
  writeFileSync(f(name, "kick"), new Date().toISOString()); const c = childPid(name); if (c) killTree(c);
  return { code: 0, out: "restarting", err: "" };
}

// ---- install: the job file + the logon hook, then start it ----
// o.schtasks: the schtasks program (runner.json "schtasks" overrides it for tests); o.autostartDir: ~/.config/autostart (Linux)
export function install(name: string, j: Job, o: { schtasks?: string; autostartDir?: string; startupDir?: string } = {}): { code: number; hook: string; err: string } {
  mkdirSync(svcDir(name), { recursive: true, mode: 0o700 }); mkdirSync(dirname(j.log), { recursive: true });
  writeFileSync(f(name, "job.json"), JSON.stringify(j, null, 1), { mode: 0o600 });
  const p = P.plat(), launch = runArgv(name); let hook = "none";
  if (p === "win32") {
    // A per-user Scheduled Task at logon, least privilege (no admin, no password stored). PowerShell starts the supervisor with no window.
    const ps = `Start-Process -WindowStyle Hidden -FilePath '${launch[0].replace(/'/g, "''")}' -ArgumentList ${launch.slice(1).map(a => `'"${a.replace(/'/g, "''")}"'`).join(",")}`;
    const tr = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "${ps}"`;
    const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME ?? "";
    const sp = (argv: string[]) => { try { return Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", windowsHide: true } as any); } catch (e: any) { return { exitCode: 1, stderr: Buffer.from(String(e?.message ?? e)) } as any; } };
    const r = sp([o.schtasks ?? "schtasks", "/Create", "/F", "/TN", `Kitebook\\${name}`, "/SC", "ONLOGON", ...(user ? ["/RU", user, "/IT"] : []), "/RL", "LIMITED", "/TR", tr]);
    if (r.exitCode === 0) hook = "scheduled task";
    else { // some machines refuse a logon task without admin: a launcher in the user's Startup folder does the same at sign-in
      const dir = o.startupDir ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
      try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `Kitebook ${name}.cmd`), `@echo off\r\nrem Kitebook: starts ${name} at sign-in (bun client/supervise.ts)\r\n${tr}\r\n`); hook = "startup folder"; }
      catch (e: any) { return { code: 1, hook, err: `couldn't register a logon task (${r.stderr.toString().trim()}) or a Startup launcher (${e.message})` }; }
    }
  } else {
    const dir = o.autostartDir ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "autostart");
    try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `kitebook-${name}.desktop`), `[Desktop Entry]\nType=Application\nName=Kitebook ${name}\nComment=Kitebook keeps ${name} running (client/supervise.ts)\nExec=${launch.map(a => /[\s"\\]/.test(a) ? `"${a.replace(/(["\\$`])/g, "\\$1")}"` : a).join(" ")}\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n`); hook = "desktop autostart"; } catch {}
  }
  const s = supPid(name); if (s) { kick(name); return { code: 0, hook, err: "" }; } // already supervised: run the new job definition
  const st = start(name); return { code: st.code, hook, err: st.err };
}
export async function uninstall(name: string, o: { schtasks?: string; autostartDir?: string; startupDir?: string } = {}) {
  if (installed(name)) await stop(name);
  // the logon hook under its own name and under the pre-rename one (Relay\\<name>, "Relay <name>.cmd", relay-<name>.desktop)
  if (P.plat() === "win32") { for (const tn of [`Kitebook\\${name}`, `Relay\\${name}`]) try { Bun.spawnSync([o.schtasks ?? "schtasks", "/Delete", "/F", "/TN", tn], { stdout: "ignore", stderr: "ignore", windowsHide: true } as any); } catch {}
    for (const b of ["Kitebook", "Relay"]) rmSync(join(o.startupDir ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup"), `${b} ${name}.cmd`), { force: true }); }
  else for (const b of ["kitebook", "relay"]) rmSync(join(o.autostartDir ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "autostart"), `${b}-${name}.desktop`), { force: true });
  rmSync(svcDir(name), { recursive: true, force: true });
}
// the last n lines of a log file (no `tail` on Windows); follow: keep printing what's appended
export async function tail(file: string, n: number, follow: boolean): Promise<number> {
  if (!existsSync(file)) { console.error(`kitebook: no log yet at ${file} (is it installed? kitebook status)`); return 1; }
  let text = readFileSync(file, "utf8"); process.stdout.write(text.split("\n").slice(-n - 1).join("\n"));
  if (!follow) return 0;
  for (let at = Buffer.byteLength(text); ; await Bun.sleep(500)) { const b = readFileSync(file); if (b.length > at) { process.stdout.write(b.subarray(at)); at = b.length; } else if (b.length < at) at = 0; }
}

// ---- the supervisor ----
async function supervise(name: string) {
  const j = job(name); if (!j) { console.error(`supervise: no job ${name}`); process.exit(2); }
  const other = supPid(name); if (other && other !== process.pid) process.exit(0); // one supervisor per job
  writeFileSync(f(name, "sup.pid"), String(process.pid)); rmSync(f(name, "stop"), { force: true });
  const pause = Number(process.env.KITEBOOK_TEST && process.env.KITEBOOK_SUP_PAUSE_MS) || 10_000;
  for (;;) {
    if (existsSync(f(name, "stop"))) break;
    const cur = job(name) ?? j; mkdirSync(dirname(cur.log), { recursive: true }); const fd = openSync(cur.log, "a");
    const c = Bun.spawn(P.resolveArgv(cur.argv, { ...process.env, ...(cur.env ?? {}) }).argv, { cwd: cur.cwd ?? homedir(), env: { ...process.env, ...(cur.env ?? {}), KITEBOOK_SERVICE: "supervise" }, stdin: "ignore", stdout: fd, stderr: fd, detached: true, windowsHide: true } as any);
    writeFileSync(f(name, "child.pid"), String(c.pid)); const code = await c.exited; closeSync(fd);
    rmSync(f(name, "child.pid"), { force: true });
    if (existsSync(f(name, "stop"))) break;
    if (existsSync(f(name, "kick"))) { rmSync(f(name, "kick"), { force: true }); continue; }
    try { writeFileSync(cur.log, `${new Date().toISOString()} supervise: ${name} exited (${code}); starting it again in ${pause / 1000}s\n`, { flag: "a" }); } catch {}
    await Bun.sleep(pause);
  }
  rmSync(f(name, "sup.pid"), { force: true });
}
if (import.meta.main) (await import("./rebrand.ts")).migrateDirs(); // an install from before the rename: its folders take the new names first (client/rebrand.ts)
if (import.meta.main && process.argv[2] === "run" && process.argv[3]) await supervise(process.argv[3]);
