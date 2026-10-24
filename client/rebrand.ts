// Relay -> Kitebook on a machine that ran Relay before the rename (2026-10). Idempotent: each step looks for what an old install left and
// does nothing when it finds nothing, so it runs on every runner start (client/runner.ts, before it connects), from the installers
// (scripts/get.sh, scripts/get.ps1, scripts/mac-host.sh: `bun client/rebrand.ts [runner.json]`) and from `kitebook` itself (folders only).
//   1. folders   ~/.relay-runner -> ~/.kitebook, ~/.relay-server -> ~/.kitebook-server, ~/.relay-app -> ~/.kitebook-app, ~/.relay-node ->
//                ~/.kitebook-node, ~/.relay -> ~/.kitebook-kb, ~/.config/relay -> ~/.config/kitebook, the Linux / Windows log folder:
//                renamed, and the old name left as a link to the new one (a junction on Windows), so a path an older process or file
//                still holds keeps working. A folder that can't be linked is put back as it was.
//   2. runner.json  paths into those folders and the old default service names rewritten (and stamped as the owner's edit)
//   3. services  launchd dev.relay.{server,tunnel,ngrok,runner} -> dev.kitebook.*, systemd --user relay-{server,tunnel,runner} ->
//                kitebook-*, Kitebook's supervisor jobs (Windows logon task, Linux without systemd) the same: the job text is carried over
//                (paths, env names, log files renamed). server/tunnel: the old job stops, the new one starts (the old one comes back if
//                the new one doesn't start). runner: the new job starts first and the old one is stopped last, which ends this process
//                when it is the old job's runner (it hasn't connected yet, so nothing is cut short).
//   4. commands  ~/.local/bin/relay (or relay.cmd) -> kitebook, and `relay` becomes a shim that prints one line and runs kitebook; the
//                release binary's bin/relay -> bin/kitebook (bin/relay stays as a link).
// KITEBOOK_NO_REBRAND=1 skips all of it.
import "./brand.ts";
import { existsSync, lstatSync, renameSync, symlinkSync, readdirSync, rmdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync, linkSync, copyFileSync, mkdirSync } from "fs";
import { join, dirname, sep } from "path";
import { homedir } from "os";
import { CLI, LABEL, LEGACY_LABEL, UNIT, LEGACY_UNIT, DEPRECATION } from "./brand.ts";
import * as PL from "./platform.ts";

type Log = (...a: any[]) => void;
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const there = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
const isDir = (p: string) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };

// [old, new] folder pairs, longest old name first (".relay" is a prefix of the others)
export function dirPairs(home = homedir(), env: Record<string, string | undefined> = process.env, p = PL.plat()): [string, string][] {
  const out: [string, string][] = [[".relay-runner", ".kitebook"], [".relay-server", ".kitebook-server"], [".relay-app", ".kitebook-app"], [".relay-node", ".kitebook-node"]]
    .map(([a, b]) => [join(home, a), join(home, b)] as [string, string]);
  out.push([join(home, ".config", "relay"), join(home, ".config", "kitebook")]);
  if (p === "linux") { const st = env.XDG_STATE_HOME ?? join(home, ".local", "state"); out.push([join(st, "relay"), join(st, "kitebook")]); }
  if (p === "win32") { const la = env.LOCALAPPDATA ?? join(home, "AppData", "Local"); out.push([join(la, "Relay"), join(la, "Kitebook")]); }
  out.push([join(home, ".relay"), join(home, ".kitebook-kb")]);
  return out;
}

// 1. one folder: rename + link back; when both exist (something made the new one first), what only the old one has moves over
export function moveDir(from: string, to: string, log: Log = () => {}): "moved" | "merged" | "linked" | "kept" | null {
  if (!isDir(from) || isLink(from)) return null; // nothing there, or already a link
  const link = () => { try { symlinkSync(to, from, PL.plat() === "win32" ? "junction" : "dir"); return true; } catch (e: any) { log(`rename: couldn't link ${from} -> ${to} (${e.message})`); return false; } };
  if (!there(to)) {
    try { mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); }
    catch (e: any) { // a folder a running program holds (Windows): it stays, and the new name links to it instead, so new paths find the same files
      try { symlinkSync(from, to, PL.plat() === "win32" ? "junction" : "dir"); log(`rename: ${from} is in use, so ${to} links to it for now`); return "linked"; }
      catch { log(`rename: couldn't move ${from} to ${to} (${e.message}); it stays where it is`); return "kept"; } }
    if (link()) return "moved";
    try { renameSync(to, from); } catch {} return "kept"; // no link possible: put it back, so nothing that names the old path breaks
  }
  if (!isDir(to) || isLink(to)) return "kept"; // the new name already links somewhere (an earlier "linked")
  for (const e of readdirSync(from)) if (!there(join(to, e))) try { renameSync(join(from, e), join(to, e)); } catch {}
  if (readdirSync(from).length) { log(`rename: ${from} and ${to} both exist; the parts only ${from} had were moved over, the rest of it stays there`); return "kept"; }
  try { rmdirSync(from); } catch { return "kept"; }
  return link() ? "merged" : (mkdirSync(from), "kept");
}
export function migrateDirs(log: Log = () => {}, home = homedir()): string[] {
  if (process.env.KITEBOOK_NO_REBRAND === "1") return [];
  const done: string[] = [];
  for (const [a, b] of dirPairs(home)) { const r = moveDir(a, b, log); if (r === "moved" || r === "merged") done.push(`${a} -> ${b}`); }
  return done;
}

// paths into an old folder that now lives under its new name (only those: a folder that stayed put keeps its old path)
export function rewritePaths(t: string, home = homedir()): string {
  for (const [a, b] of dirPairs(home)) {
    if (!(isLink(a) || !there(a)) || !there(b)) continue;
    const end = "(?=[\\\\/\"'\\s<:;}),]|$)";
    t = t.replace(new RegExp(esc(a) + end, "g"), b);
    if (a.startsWith(home + sep)) t = t.replace(new RegExp("~/" + esc(a.slice(home.length + 1).split(sep).join("/")) + end, "g"), "~/" + b.slice(home.length + 1).split(sep).join("/"));
  }
  return t;
}
const EXE = () => PL.plat() === "win32" ? ".exe" : "", esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// a supervisor job (job.json) carried over field by field (Windows paths would be escaped inside JSON text)
export function jobObj(j: any, home = homedir(), appBin?: string): any {
  const x = (v: any) => typeof v === "string" ? jobText(v, home, appBin) : v;
  return { ...j, argv: (j.argv ?? []).map(x), cwd: x(j.cwd), log: x(j.log), env: Object.fromEntries(Object.entries(j.env ?? {}).map(([k, v]) => [k.replace(/^RELAY_/, "KITEBOOK_"), x(v)])) };
}
// a service definition (plist, systemd unit, supervisor job.json) carried over to its new name
export function jobText(t: string, home = homedir(), appBin?: string): string {
  t = rewritePaths(t, home).replace(/\bdev\.relay\.(server|runner|tunnel|ngrok)\b/g, "dev.kitebook.$1")
    .replace(/\brelay-(server|runner|tunnel|ngrok)\.log\b/g, "kitebook-$1.log").replace(/(<key>|Environment="|")RELAY_/g, "$1KITEBOOK_")
    .replace(/\bRelay (server|runner|tunnel)\b/g, "Kitebook $1").replace(/^Description=Relay\b/m, "Description=Kitebook");
  if (appBin && existsSync(join(appBin, "kitebook" + EXE()))) t = t.replace(new RegExp(esc(join(appBin, "relay")) + "(\\.exe)?(?=[<\"'\\s]|$)", "g"), join(appBin, "kitebook") + "$1"); // bin/relay -> bin/kitebook
  return t;
}

// 2. runner.json
export function migrateConfig(cfgPath: string, log: Log = () => {}): boolean {
  let t: string; try { t = readFileSync(cfgPath, "utf8"); } catch { return false; }
  let j: any; try { j = JSON.parse(rewritePaths(t)); } catch { return false; }
  if (j.server?.label === LEGACY_LABEL.server && !existsSync(plist(LEGACY_LABEL.server))) j.server.label = LABEL.server;
  for (const [k, u] of [["runnerUnit", "runner"], ["tunnelUnit", "tunnel"]] as const) if (j[k] === (LEGACY_UNIT as any)[u]) delete j[k];
  if (j.server?.unit === LEGACY_UNIT.server) delete j.server.unit;
  const n = JSON.stringify(j, null, 2); if (n === JSON.stringify(JSON.parse(t), null, 2)) return false;
  writeFileSync(cfgPath, n, { mode: 0o600 }); try { chmodSync(cfgPath, 0o600); } catch {}
  import("./guard.ts").then(G => G.stampOwnerEdit(cfgPath)).catch(() => {});
  log(`rename: ${cfgPath} now names the new folders`); return true;
}

// 3. services
const LA = () => join(homedir(), "Library", "LaunchAgents"), plist = (l: string) => join(LA(), `${l}.plist`);
const run = (argv: string[]) => { try { const p = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 }); return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString().trim() }; } catch (e: any) { return { code: 1, out: "", err: e.message }; } };
async function healthy(url: string, sec = 30) { for (let i = 0; i < sec * 2; i++) { try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch {} await Bun.sleep(500); } return false; }
// the runner's own job is the old one: launchd's env for the job (XPC_SERVICE_NAME), or the marker every service puts in its env
const underOld = (kind: string) => process.env.XPC_SERVICE_NAME === (LEGACY_LABEL as any)[kind] || process.env.KITEBOOK_LAUNCHD === "1" || !!process.env.KITEBOOK_SERVICE;
export type SvcResult = { moved: string[]; failed: string[]; selfMoved: boolean };

export async function migrateServices(cfg: any = {}, o: { self?: boolean; log?: Log; appBin?: string } = {}): Promise<SvcResult> {
  const log = o.log ?? (() => {}), res: SvcResult = { moved: [], failed: [], selfMoved: false };
  if (process.env.KITEBOOK_NO_REBRAND === "1") return res;
  const health = cfg.server?.health ?? (cfg.url ? `${String(cfg.url).replace(/\/+$/, "")}/health` : "http://127.0.0.1:7820/health");
  const kinds = ["server", "tunnel", "ngrok", "runner"] as const;
  const mac = PL.plat() === "darwin" || !!cfg.launchctl || !!process.env.KITEBOOK_FAKE_MAC;
  if (mac) {
    const lc = cfg.launchctl ?? (PL.plat() === "darwin" ? "/bin/launchctl" : "launchctl"), uid = process.getuid?.() ?? 0, L = (...a: string[]) => run([lc, ...a]);
    for (const k of kinds) {
      const ol = LEGACY_LABEL[k], nl = LABEL[k], of = plist(ol), nf = plist(nl); if (!existsSync(of)) continue;
      if (k === "runner" && o.self === false) continue;
      const otext = readFileSync(of, "utf8"), loaded = L("print", `gui/${uid}/${ol}`).code === 0;
      if (existsSync(nf)) { // both: the new one wins; the old one goes (a reinstall already wrote the new one)
        if (loaded) L("bootout", `gui/${uid}/${ol}`); unlinkSync(of); res.moved.push(`${ol} (removed; ${nl} was already there)`); continue; }
      writeFileSync(nf, jobText(otext, homedir(), o.appBin));
      const back = (why: string) => { try { if (!existsSync(of)) writeFileSync(of, otext); } catch {} try { L("bootout", `gui/${uid}/${nl}`); unlinkSync(nf); } catch {} if (loaded && k !== "runner") L("bootstrap", `gui/${uid}`, of); res.failed.push(`${ol}: ${why}`); log(`rename: kept ${ol} (${why})`); };
      if (k !== "runner") {
        if (loaded) L("bootout", `gui/${uid}/${ol}`); unlinkSync(of);
        if (loaded) { const r = L("bootstrap", `gui/${uid}`, nf); if (r.code) { back(`launchd didn't start ${nl}: ${r.err}`); continue; }
          if (k === "server" && !(await healthy(health))) { back(`${nl} didn't answer at ${health}`); continue; } }
        res.moved.push(`${ol} -> ${nl}`); log(`rename: ${ol} -> ${nl}`); continue;
      }
      unlinkSync(of);
      if (loaded) { const r = L("bootstrap", `gui/${uid}`, nf); if (r.code) { back(`launchd didn't start ${nl}: ${r.err}`); continue; } }
      res.moved.push(`${ol} -> ${nl}`); log(`rename: ${ol} -> ${nl}${loaded ? " (the new job runs the runner from here on)" : ""}`);
      if (loaded) { if (o.self && underOld("runner")) res.selfMoved = true; L("bootout", `gui/${uid}/${ol}`); } // last: ends this process when it's the old job's runner
    }
    return res;
  }
  const { pickBackend } = await import("./service.ts"), be = pickBackend(cfg);
  if (be.kind === "systemd") {
    const sc = (...a: string[]) => run([cfg.systemctl ?? "systemctl", "--user", ...a]), dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");
    for (const k of ["server", "tunnel", "runner"] as const) {
      if (k === "runner" && o.self === false) continue;
      if ((k === "server" && cfg.server?.unit && cfg.server.unit !== LEGACY_UNIT.server) || (k === "runner" && cfg.runnerUnit && cfg.runnerUnit !== LEGACY_UNIT.runner) || (k === "tunnel" && cfg.tunnelUnit && cfg.tunnelUnit !== LEGACY_UNIT.tunnel)) continue; // the owner's own unit name
      const ou = LEGACY_UNIT[k], nu = UNIT[k], of = join(dir, `${ou}.service`), nf = join(dir, `${nu}.service`); if (!existsSync(of)) continue;
      const otext = readFileSync(of, "utf8"), active = sc("is-active", "--quiet", ou).code === 0;
      if (!existsSync(nf)) writeFileSync(nf, jobText(otext, homedir(), o.appBin));
      sc("disable", ou); if (k !== "runner") sc("stop", ou); unlinkSync(of); sc("daemon-reload");
      const r1 = sc("enable", nu), r2 = active ? sc("restart", nu) : { code: 0, err: "" };
      if (r1.code || r2.code || (k === "server" && active && !(await healthy(health)))) { // put the old unit back
        sc("disable", "--now", nu); try { unlinkSync(nf); } catch {} writeFileSync(of, otext); sc("daemon-reload"); sc("enable", ou); if (active) sc("start", ou);
        res.failed.push(`${ou}: ${(r1.err || r2.err || `${nu} didn't come up`).slice(0, 200)}`); log(`rename: kept ${ou}`); continue; }
      res.moved.push(`${ou} -> ${nu}`); log(`rename: ${ou} -> ${nu}`);
      if (k === "runner" && active) { if (o.self && underOld("runner")) res.selfMoved = true; sc("stop", ou); } // last: ends this process when it's the old unit's runner
    }
    return res;
  }
  // Kitebook's supervisor (Windows logon task, Linux without systemd): job.json in ~/.kitebook/svc/<name>
  const SV = await import("./supervise.ts"), so = { schtasks: cfg.schtasks };
  for (const k of ["server", "tunnel", "runner"] as const) {
    if (k === "runner" && o.self === false) continue;
    const ou = LEGACY_UNIT[k], nu = UNIT[k]; if (!SV.installed(ou)) continue;
    if (SV.installed(nu)) { await SV.uninstall(ou, so); res.moved.push(`${ou} (removed; ${nu} was already there)`); continue; }
    const oj = SV.job(ou)!, nj = jobObj(oj, homedir(), o.appBin), was = !!SV.supPid(ou);
    if (k !== "runner") {
      await SV.uninstall(ou, so); const r = SV.install(nu, nj, so);
      if (r.code || (k === "server" && was && !(await healthy(health)))) { await SV.uninstall(nu, so); SV.install(ou, oj, so); res.failed.push(`${ou}: ${r.err || `${nu} didn't come up`}`); continue; }
      if (!was) await SV.stop(nu);
      res.moved.push(`${ou} -> ${nu}`); log(`rename: ${ou} -> ${nu}`); continue;
    }
    const r = SV.install(nu, nj, so); if (r.code) { await SV.uninstall(nu, so); res.failed.push(`${ou}: ${r.err}`); continue; }
    if (!was) await SV.stop(nu);
    res.moved.push(`${ou} -> ${nu}`); log(`rename: ${ou} -> ${nu}`);
    if (o.self && underOld("runner") && was) res.selfMoved = true;
    await SV.uninstall(ou, so); // last: ends this process when it's the old job's runner
  }
  return res;
}

// 4. the commands: the wrapper under its new name, `relay` as a shim; the release binary's file name
export function shimText(target: string, p = PL.plat()): { file: string; text: string } {
  if (p === "win32") return { file: "relay.cmd", text: `@echo off\r\nrem Kitebook CLI (old name): relay is now ${CLI}; this forwards to it\r\necho ${DEPRECATION} 1>&2\r\n"${target}" %*\r\n` };
  return { file: "relay", text: `#!/bin/sh\n# Kitebook CLI (old name): relay is now ${CLI}; this forwards to it\necho "${DEPRECATION}" >&2\nexec "${target}" "$@"\n` };
}
export function migrateCommands(log: Log = () => {}, binDirs = [process.env.KITEBOOK_BIN_DIR || PL.binDir(), join(homedir(), ".local", "bin")], platform = PL.plat()): string[] {
  const done: string[] = [], win = platform === "win32";
  for (const dir of [...new Set(binDirs)]) {
    const of = join(dir, win ? "relay.cmd" : "relay"), nf = join(dir, win ? "kitebook.cmd" : CLI); let t = "";
    try { t = readFileSync(of, "utf8"); } catch { continue; }
    if (/Kitebook CLI \(old name\)/.test(t) || !/^(# |rem )Relay CLI/m.test(t)) continue; // already a shim, or not ours
    if (!existsSync(nf)) {
      const n = rewritePaths(t).replace(/^(# |rem )Relay CLI/m, "$1Kitebook CLI").replace(/RELAY_RUNNER_CONFIG/g, "KITEBOOK_RUNNER_CONFIG").replace(/\brelay help\b/, `${CLI} help`)
        .replace(/\brelay (status|op)\b/g, `${CLI} $1`).replace(/every relay op/, `every ${CLI} op`);
      writeFileSync(nf + ".tmp", n, { mode: 0o755 }); renameSync(nf + ".tmp", nf); }
    const s = shimText(nf, platform); writeFileSync(of + ".tmp", s.text, { mode: 0o755 }); renameSync(of + ".tmp", of);
    done.push(`${of} -> ${nf}`); log(`rename: the relay command is now ${nf} (relay still works and says so)`);
  }
  return done;
}
// the release binary (client/binary.ts): bin/relay[.exe] -> bin/kitebook[.exe], the old name kept as a link (a hard link on Windows)
export function migrateBinary(appHome: string, log: Log = () => {}): boolean {
  const exe = PL.plat() === "win32" ? ".exe" : "", d = join(appHome, "bin"), of = join(d, "relay" + exe), nf = join(d, "kitebook" + exe);
  if (!existsSync(of) || isLink(of) || existsSync(nf)) return false;
  try { renameSync(of, nf); } catch (e: any) { log(`rename: couldn't rename ${of} (${e.message})`); return false; }
  try { if (exe) linkSync(nf, of); else symlinkSync("kitebook", of); } catch { try { copyFileSync(nf, of); chmodSync(of, 0o755); } catch {} }
  const op = join(d, "relay.prev" + exe), np = join(d, "kitebook.prev" + exe); if (existsSync(op) && !existsSync(np)) try { renameSync(op, np); } catch {}
  log(`rename: ${of} -> ${nf}`); return true;
}

// everything, in order (the runner calls this before it connects; the installers through the CLI below)
export async function rebrand(cfgPath: string | null, o: { self?: boolean; log?: Log } = {}): Promise<SvcResult & { dirs: string[]; commands: string[] }> {
  const log = o.log ?? (() => {}), empty = { moved: [], failed: [], selfMoved: false, dirs: [], commands: [] };
  if (process.env.KITEBOOK_NO_REBRAND === "1") return empty;
  const dirs = migrateDirs(log), app = process.env.KITEBOOK_APP_HOME || join(homedir(), ".kitebook-app"); migrateBinary(app, log);
  let cfg: any = {}; if (cfgPath) { migrateConfig(cfgPath, log); try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch {} }
  // a host upgrade in flight rewrites the server's job itself (client/host-upgrade.ts); the services wait for the next start
  let busy = false; try { busy = JSON.parse(readFileSync(join(homedir(), ".kitebook", "host-upgrade.json"), "utf8")).state === "running"; } catch {}
  const commands = migrateCommands(log); // before the jobs: moving the runner's own job ends this process
  const s = busy ? { moved: [], failed: [], selfMoved: false } : await migrateServices(cfg, { ...o, log, appBin: join(app, "bin") });
  if (cfgPath && s.moved.length) migrateConfig(cfgPath, log); // server.label etc. now that the jobs have their new names
  return { ...s, dirs, commands };
}

// no top-level await: client/cli-path.ts require()s this file, and bun build --compile refuses a require of a module with one
if (import.meta.main) (async () => { // bun client/rebrand.ts [runner.json]   (installers; prints what moved, never fails the install)
  const f = process.argv[2] ?? process.env.KITEBOOK_RUNNER_CONFIG ?? join(homedir(), ".kitebook", "runner.json");
  const r = await rebrand(f, { self: true, log: (...a) => console.error(...a) });
  console.log(JSON.stringify({ dirs: r.dirs, services: r.moved, failed: r.failed, commands: r.commands }));
})().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
