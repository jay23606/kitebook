// Kitebook's own services, as a CLI: `bun runner.ts service <runner.json> status|restart <server|runner|all>|update|stop|start|logs`
// The owner gets it as the one `kitebook` command install.sh puts on PATH (kitebook status / restart / update / logs / stop / start, plain
// words, client/cli.ts); agents get it as `kitebook-svc <status|restart ...|update>` (JSON, no config arg; stop/start/logs are owner-only).
// It only ever touches Kitebook's own jobs: launchd on macOS (dev.kitebook.server, dev.kitebook.runner, and dev.kitebook.tunnel when the server runs
// with no server/domain, client/tunnel.ts), systemd --user units on Linux (kitebook-server, kitebook-runner, kitebook-tunnel; runner.json
// "server": {"unit"}, "runnerUnit", "tunnelUnit"), and Kitebook's own supervisor (client/supervise.ts, the same names) on Windows (started at
// logon by a per-user Scheduled Task) and on Linux without systemd. Raw launchctl stays blocked by the guard, and no
// user-facing text tells anyone to run it: the `kitebook` command wraps it.
//   runner.json (optional): "server": { "dir": "/Users/you/relay-cf", "label": "dev.kitebook.server", "health": "http://127.0.0.1:7820/health" },
//                           "source": "~/code/relay"   // git checkout that `update` pulls (default: the checkout this runner runs from)
// restart runner from inside a task is deferred: the runner exits once its current tasks finish and launchd starts the new code.
// update (pinned install, see integrity.ts + updater.ts): with a release key pinned, the newest release signed with it and numbered higher
//         installs with no prompt (owner and agents alike: nobody picks the code); an unsigned, tampered, wrongly signed or older release is
//         refused. Without a key: one click in Settings -> Updates (or the version must equal "runnerPin"); no terminal y. Every file is sha256-checked before `current` switches, the new runner must start (else it goes back), the
//         kitebook command and the agents' Kitebook entries are refreshed, then a deferred runner restart.
// update (git checkout): git fetch, then fast-forward ONLY to a commit the owner approved: "updatePin" in runner.json (set with `service <cfg> pin <sha>`,
//         owner CLI only), or, from the owner's terminal, a y/N prompt showing the incoming commits. A push to main alone no longer
//         reaches this machine (that push would otherwise be code execution here). Then copy src/ client/ config into server.dir
//         without backup folders, restart the server, health check, restore the previous commit if it fails, then a deferred runner restart.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, chmodSync, realpathSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import { auditAppend, stampOwnerEdit } from "./guard.ts";
import * as I from "./integrity.ts";
import * as SV from "./supervise.ts";
import * as PL from "./platform.ts";
import { LABEL, LEGACY_LABEL, UNIT, LEGACY_UNIT } from "./brand.ts";

const STATE = join(homedir(), ".kitebook");
export const restartFlag = (name: string) => join(STATE, `restart-${name}`);
let LAUNCHCTL = "/bin/launchctl"; // absolute: the agent's PATH has guard shims (runner.json "launchctl" overrides, for tests)
let SYSTEMCTL = "systemctl", JOURNALCTL = "journalctl"; // Linux (runner.json "systemctl" / "journalctl" override, for tests)
const COPY = ["src", "client", "cloudflare.config.ts", "package.json"];
const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

function run(cmd: string[], cwd = homedir()) {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}
const uid = () => process.getuid?.() ?? 0;
// One backend per OS, same verbs: kick (restart), loaded, running, stop, start, logs. The label is the launchd label; on systemd it
// maps to a unit (dev.kitebook.server -> kitebook-server unless runner.json names one).
type R = ReturnType<typeof run>;
type Backend = { kind: "launchd" | "systemd" | "supervise"; kick(l: string): R; loaded(l: string): boolean; running(l: string): boolean;
  stop(l: string): R | Promise<R>; start(l: string): R; logs(l: string, n: number, follow: boolean): string[]; stopped?(l: string): boolean };
const launchd: Backend = { kind: "launchd",
  kick: l => run([LAUNCHCTL, "kickstart", "-k", `gui/${uid()}/${l}`]),
  loaded: l => run([LAUNCHCTL, "print", `gui/${uid()}/${l}`]).code === 0,
  running: l => { const p = run([LAUNCHCTL, "print", `gui/${uid()}/${l}`]); return !p.code && /state = running/.test(p.out); },
  stop: l => run([LAUNCHCTL, "bootout", `gui/${uid()}/${l}`]), // KeepAlive would bring a killed job back; bootout unloads it until start
  start: l => { const pl = join(homedir(), "Library/LaunchAgents", `${l}.plist`);
    return existsSync(pl) ? run([LAUNCHCTL, "bootstrap", `gui/${uid()}`, pl]) : { code: 1, out: "", err: `not installed (no ${pl})` }; },
  logs: (l, n, f) => ["tail", "-n", String(n), ...(f ? ["-F"] : []), join(homedir(), "Library/Logs", `${l.startsWith("dev.relay.") ? "relay" : "kitebook"}-${keyOf(l)}.log`)] };
// the built-in tunnel (client/tunnel.ts, "No server / domain" in scripts/mac-host.sh): its supervisor is a third job, dev.kitebook.tunnel / kitebook-tunnel
// A job from before the rename (Relay -> Kitebook) keeps its old name (dev.relay.<x>, relay-<x>) until client/rebrand.ts moves it, so every
// verb below is asked of whichever of the two is installed (the new one when both or neither are).
const TUNNEL = LABEL.tunnel, keyOf = (l: string) => /\.runner$/.test(l) ? "runner" : /\.tunnel$/.test(l) ? "tunnel" : "server";
const unitOf = (l: string, cfg: any) => { const k = keyOf(l), u = (l.startsWith("dev.relay.") ? LEGACY_UNIT : UNIT)[k];
  return k === "runner" ? (cfg.runnerUnit ?? u) : k === "tunnel" ? (cfg.tunnelUnit ?? u) : (cfg.server?.unit ?? u); };
const legacyOf = (l: string) => l === LABEL.server ? LEGACY_LABEL.server : l === LABEL.runner ? LEGACY_LABEL.runner : l === LABEL.tunnel ? LEGACY_LABEL.tunnel : null;
const newOf = (l: string) => l === LEGACY_LABEL.server ? LABEL.server : l === LEGACY_LABEL.runner ? LABEL.runner : l === LEGACY_LABEL.tunnel ? LABEL.tunnel : null;
function has(b: Backend, l: string, cfg: any): boolean {
  if (b.kind === "launchd") return existsSync(join(homedir(), "Library/LaunchAgents", `${l}.plist`));
  if (b.kind === "systemd") return existsSync(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", `${unitOf(l, cfg)}.service`));
  return SV.installed(unitOf(l, cfg));
}
export const installedLabel = (b: Backend, l: string, cfg: any) => { const o = legacyOf(l), n = newOf(l);
  if (o) return !has(b, l, cfg) && has(b, o, cfg) ? o : l; if (n) return !has(b, l, cfg) && has(b, n, cfg) ? n : l; return l; };
const either = (b: Backend, cfg: any): Backend => { const r = (l: string) => installedLabel(b, l, cfg);
  return { ...b, kick: l => b.kick(r(l)), loaded: l => b.loaded(r(l)), running: l => b.running(r(l)), stop: l => b.stop(r(l)), start: l => b.start(r(l)), logs: (l, n, f) => b.logs(r(l), n, f), ...(b.stopped ? { stopped: (l: string) => b.stopped!(r(l)) } : {}) }; };
const systemd = (cfg: any): Backend => { const sc = (...a: string[]) => run([SYSTEMCTL, "--user", ...a]), u = (l: string) => unitOf(l, cfg); return { kind: "systemd",
  kick: l => sc("restart", u(l)), loaded: l => sc("show", "-p", "LoadState", "--value", u(l)).out === "loaded",
  running: l => sc("is-active", "--quiet", u(l)).code === 0, stop: l => sc("stop", u(l)), start: l => sc("start", u(l)),
  logs: (l, n, f) => [JOURNALCTL, "--user", "-u", u(l), "-n", String(n), "--no-pager", ...(f ? ["-f"] : [])] }; };
// Windows, and Linux with no systemd --user: Kitebook's supervisor (client/supervise.ts), one job per unit name, logs in the OS's log folder
const supervise = (cfg: any): Backend => { const u = (l: string) => unitOf(l, cfg); return { kind: "supervise",
  kick: l => SV.kick(u(l)), loaded: l => SV.installed(u(l)), running: l => SV.running(u(l)), stop: l => SV.stop(u(l)), start: l => SV.start(u(l)), stopped: l => SV.stopped(u(l)),
  logs: (l, n, f) => ["__tail", String(n), f ? "1" : "", SV.job(u(l))?.log ?? join(PL.logDir(), `${u(l)}.log`)] }; };
let B: Backend = launchd;
const kick = (label: string) => B.kick(label), loaded = (label: string) => B.loaded(label);
// Which service manager this machine has: launchd on macOS (or a test's fake launchctl), else systemd --user if it answers, else (Windows,
// Linux without systemd) Kitebook's own supervisor. runner.json "supervise": true picks the supervisor anywhere (tests, a box whose systemd
// user session is unusable).
export function pickBackend(cfg: any): Backend {
  if (cfg.launchctl) LAUNCHCTL = cfg.launchctl; if (cfg.systemctl) SYSTEMCTL = cfg.systemctl; if (cfg.journalctl) JOURNALCTL = cfg.journalctl;
  if (cfg.supervise === true) return supervise(cfg);
  if ((PL.plat() === "darwin" && !cfg.systemctl) || cfg.launchctl) return launchd;
  if (PL.plat() !== "win32" || cfg.systemctl) try { const p = Bun.spawnSync([SYSTEMCTL, "--user", "--version"], { stdout: "pipe", stderr: "pipe" }); if (p.exitCode === 0) return systemd(cfg); } catch {}
  return supervise(cfg);
}
export const backendWords = (b: Backend) => b.kind === "launchd" ? "launchd (starts at login, restarts if it stops)" : b.kind === "systemd" ? "systemd --user (restarts if it stops)"
  : PL.plat() === "win32" ? "Kitebook's supervisor (a Scheduled Task starts it when you sign in to Windows; restarts if it stops)" : "Kitebook's supervisor (starts at desktop login; restarts if it stops)";

async function healthy(url: string, sec = 30) {
  for (let i = 0; i < sec * 2; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch {}
    await Bun.sleep(500);
  }
  return false;
}

// The watchdog's restart (client/watchdog.ts): the runner job the owner's way, by this process (nobody types launchctl). A loaded job is
// kickstarted (-k: a wedged runner is killed first), an unloaded one (booted out by a failed reinstall) is bootstrapped from its plist /
// started. Never a runner the owner stopped (kitebook stop leaves the flag). Audited by the caller.
export async function healRunner(cfg: any): Promise<{ ok: boolean; how: string }> {
  if (existsSync((await import("./watchdog.ts")).stoppedFlag())) return { ok: false, how: "not restarted: the owner stopped it (kitebook start runner)" };
  const b = either(pickBackend(cfg), cfg);
  if (b.loaded(LABEL.runner)) { const r = b.kick(LABEL.runner); return r.code ? { ok: false, how: `restart failed: ${(r.err || r.out || `exit ${r.code}`).slice(0, 200)}` } : { ok: true, how: `${b.kind} restart` }; }
  const r = b.start(LABEL.runner); return r.code ? { ok: false, how: `the runner job isn't loaded and didn't start: ${(r.err || r.out || `exit ${r.code}`).slice(0, 200)}` } : { ok: true, how: `${b.kind} start (the job wasn't loaded)` };
}

// plain = the owner's `kitebook` command: plain-words lines instead of JSON (agents' kitebook-svc keeps JSON)
// agent: the update was asked for by an assistant or agent (relay_update with Experimental on, client/git-channel.ts devUpdate): its audit lines
// name that app instead of "owner cli", so they never count as the owner's approval (host-upgrade.ts approval: no cf dev server upgrade).
// noRestart: the caller restarts the runner itself after its own checks (devUpdate's self-check runs inside the runner)
export async function service(cfgPath: string, argv: string[], o: { plain?: boolean; inRunner?: boolean; by?: string; agent?: boolean; noRestart?: boolean } = {}): Promise<number> {
  const cfg = existsSync(cfgPath) || !o.plain ? JSON.parse(readFileSync(cfgPath, "utf8")) : {}; // `kitebook status` works before a runner is set up (server only)
  const sv = { label: LABEL.server as string, health: cfg.url ? `${String(cfg.url).replace(/\/$/, "")}/health` : "http://127.0.0.1:7820/health", ...(cfg.server ?? {}) };
  const source = resolve(expand(cfg.source ?? join(dirname(import.meta.path), "..")));
  const fromTask = !!process.env.KITEBOOK_TASK_ID, name = cfg.name ?? "runner";
  const out = (r: any) => { if (!o.plain) return console.log(JSON.stringify(r, null, 2));
    for (const [k, v] of Object.entries(r)) if (v != null) console.log(`${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join("\n  ") : typeof v === "object" ? JSON.stringify(v) : v}`); };
  const audit = (e: any) => { try { auditAppend({ type: "service", by: fromTask ? `task ${process.env.KITEBOOK_TASK_ID}` : o.agent && o.by ? o.by : "owner cli", ...e }); } catch {} };
  const [cmd, what = "all"] = argv;
  B = either(pickBackend(cfg), cfg);
  const which = (w: string) => w === "all" ? [sv.label, LABEL.runner] : w === "server" ? [sv.label] : w === "runner" ? [LABEL.runner] : w === "tunnel" ? [TUNNEL] : null;
  const T = await import("./tunnel.ts");
  const owner = (verb: string) => { if (!fromTask) return true; out({ [verb]: "refused", error: `only the machine owner can ${verb} Kitebook's services (from their own terminal: kitebook ${verb})` }); return false; };

  const restartServer = async () => {
    if (!loaded(sv.label)) return { server: "not installed", hint: B.kind === "launchd" ? "scripts/mac-host.sh install (from the server checkout)" : "run the one-step install again (scripts/get.sh, or scripts/get.ps1 on Windows)" };
    const r = kick(sv.label); if (r.code) return { server: "restart failed", error: r.err };
    return { server: (await healthy(sv.health)) ? "restarted, healthy" : "restarted, NOT healthy", health: sv.health };
  };
  const restartRunner = () => {
    // inRunner: the runner itself (Settings -> Update to dev now) exits once idle instead of being killed mid-click
    // a checkout this runner doesn't run from (an installed release with runner.json "source" pointing at a server checkout): its code
    // didn't change, so nothing restarts it
    if (o.noRestart) return { runner: "restart left to the caller" };
    if (o.inRunner && (I.isInstalledPath(import.meta.path) || real(resolve(dirname(import.meta.path), "..")) !== real(source))) return { runner: "not restarted (it doesn't run from this checkout)" };
    if (fromTask || o.inRunner) { mkdirSync(STATE, { recursive: true }); writeFileSync(restartFlag("runner"), new Date().toISOString()); return { runner: "restart scheduled: after current tasks finish" }; }
    if (!loaded(LABEL.runner)) return { runner: "not running as a service (start it: kitebook start runner)" };
    const r = kick(LABEL.runner); return { runner: r.code ? `restart failed: ${r.err}` : "restarted" };
  };
  // a running tunnel helper restarts cloudflared itself (seconds, no service manager); a dead one is restarted as a service
  const restartTunnel = () => {
    if (T.supervisorUp()) { mkdirSync(T.home(), { recursive: true, mode: 0o700 }); writeFileSync(join(T.home(), "tunnel-restart"), new Date().toISOString()); return { tunnel: "restarting (quick tunnel: it gets a new address; kitebook tunnel shows it)" }; }
    if (!loaded(TUNNEL)) return { tunnel: "not installed", hint: B.kind === "launchd" ? "scripts/mac-host.sh install, and choose No server / domain" : "kitebook tunnel on (sets up the tunnel helper and turns public access on)" };
    const r = kick(TUNNEL); return { tunnel: r.code ? `restart failed: ${r.err}` : "restarted" };
  };

  if (cmd === "status" && o.plain) { // plain words for the owner: up/down, version, what to run next
    // a job the owner stopped (kitebook stop) counts as not running as a service, like launchd's bootout: "start it", not "DOWN", and status exits 0
    const off = (l: string) => !!B.stopped?.(l), up = await healthy(sv.health, 2), sl = loaded(sv.label) && (up || !off(sv.label)), rl = loaded(LABEL.runner) && !off(LABEL.runner), rr = rl && B.running(LABEL.runner), inst = I.verifyInstall();
    const git = inst.installed ? null : run(["git", "-C", source, "log", "-1", "--format=%h, committed %cs"]);
    const line = (k: string, v: string) => console.log(`${k.padEnd(8)} ${v}`);
    line("server", up ? `up (${sv.health})` : off(sv.label) && loaded(sv.label) ? `not running: stopped with kitebook stop. Start it: kitebook start server` : sl ? `DOWN: installed but not answering at ${sv.health}. Try: kitebook restart server` : `not on this machine (nothing answers at ${sv.health})`);
    line("runner", !rl ? (off(LABEL.runner) ? `not running: stopped with kitebook stop. Start it: kitebook start runner` : `not running as a service. Start it: kitebook start runner`) : rr ? `up${existsSync(restartFlag("runner")) ? " (restart pending after current tasks)" : ""}` : `DOWN: installed but not running. Try: kitebook restart runner (then kitebook logs runner)`);
    { const hu = (await import("./host-upgrade.ts")).statusLine(cfg, cfgPath); if (hu) line("server upgrade", hu); }
    const ch = inst.installed ? null : (await import("./channel.ts")).channelOf(source), chw = ch === "dev" ? ", dev channel" : ch === "main" ? ", stable channel" : ch ? ", local commits" : "";
    line("version", inst.installed ? `runner ${inst.version}${inst.ok ? "" : ` (DOESN'T match its manifest: ${inst.problems.join(", ")}; reinstall from your Kitebook's /start)`}` : `${git!.out || "unknown"} (runs from ${source}${chw})`);
    const ts = T.readState(), tl = loaded(TUNNEL), td = T.describe(ts); if (ts || tl) line("tunnel", ts ? td.line : "installed, no address yet. Try: kitebook restart tunnel");
    line("service", backendWords(B));
    // the server's own view (op status, src/space/health.ts): "Working", or what died and the next step; the watchdog's restarts included
    if (cfg.url && cfg.token && up) try { const r: any = await (await fetch(`${String(cfg.url).replace(/\/+$/, "")}/v1/status`, { method: "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: JSON.stringify({ space: cfg.space }), signal: AbortSignal.timeout(5000) })).json();
      if (r?.ok) line("health", `${r.result.verdict}${r.result.next ? `. Next: ${r.result.next}` : ""}`); } catch {}
    return (up || !sl) && (rr || !rl) && (!ts || td.ok) ? 0 : 1;
  }
  if (cmd === "stop" || cmd === "start") {
    const labels = which(what); if (!labels) { console.error(`usage: kitebook ${cmd} [server|runner|tunnel|all]`); return 2; }
    if (!owner(cmd)) return 1;
    const res: any = {}; let bad = 0;
    // launchd: stop unloads the job, so loaded = on; systemd and the supervisor keep it installed when stopped, so ask whether it runs
    for (const l of labels) { const k = keyOf(l), was = B.kind === "launchd" ? loaded(l) : B.running(l);
      if (cmd === "stop" && !was) { res[k] = "already stopped"; continue; }
      if (cmd === "start" && was) { res[k] = "already running"; continue; }
      const r = cmd === "stop" ? await B.stop(l) : B.start(l); if (r.code) bad++;
      res[k] = r.code ? `${cmd} failed: ${r.err || r.out}` : cmd === "stop" ? "stopped (stays stopped until kitebook start)" : "started"; }
    if (cmd === "start" && labels.includes(sv.label) && !String(res.server).includes("failed") && res.server !== "already running") res.server += (await healthy(sv.health)) ? ", healthy" : `, NOT healthy yet (kitebook logs server)`;
    // the watchdog (client/watchdog.ts) leaves a runner the owner stopped alone: the flag says so until kitebook start
    if (labels.includes(LABEL.runner) && !String(res.runner).includes("failed")) try { const W = await import("./watchdog.ts"); if (cmd === "stop") { mkdirSync(STATE, { recursive: true }); writeFileSync(W.stoppedFlag(), new Date().toISOString()); } else rmSync(W.stoppedFlag(), { force: true }); } catch {}
    audit({ action: cmd, what, result: res }); out(res); return bad ? 1 : 0;
  }
  if (cmd === "logs" && (argv.includes("--errors") || argv.includes("--recent"))) { if (!owner("logs")) return 1; return await (await import("./devlog.ts")).logsCli(cfg, argv); } // Experimental's ring (client/devlog.ts)
  if (cmd === "logs") {
    const t = argv.slice(1).find((a, i) => !a.startsWith("-") && argv[i] !== "-n") ?? "runner", l = t === "runner" ? LABEL.runner : t === "server" ? sv.label : t === "tunnel" ? TUNNEL : null;
    if (!l) { console.error("usage: kitebook logs [server|runner|tunnel] [-n lines] [-f] | kitebook logs --errors [--source server|auth|runner|updates] [--since 2h] [--level warn] [-n 50] [--json]"); return 2; }
    if (!owner("logs")) return 1;
    const n = Number(argv[argv.indexOf("-n") + 1]) || 60, follow = argv.includes("-f") || argv.includes("--follow"), c = B.logs(l, n, follow);
    if (c[0] === "__tail") return SV.tail(c[3], Number(c[1]), !!c[2]); // the supervisor's log file (no tail on Windows)
    if (c[0] === "tail" && !existsSync(c[c.length - 1])) { console.error(`kitebook: no log yet at ${c[c.length - 1]} (is it installed? kitebook status)`); return 1; }
    const p = Bun.spawn(c, { stdout: "inherit", stderr: "inherit" }); return await p.exited;
  }
  if (cmd === "status") {
    const git = run(["git", "-C", source, "log", "-1", "--format=%h %s"]);
    const inst = I.verifyInstall();
    out({ source, rev: git.out || git.err, update_pin: cfg.updatePin ?? null, runner_install: inst.installed ? { version: inst.version, intact: inst.ok, problems: inst.problems, pin: cfg.runnerPin ?? null } : null, server: { label: sv.label, loaded: loaded(sv.label), healthy: await healthy(sv.health, 2), dir: sv.dir ?? null }, runner: { loaded: loaded(LABEL.runner), restart_pending: existsSync(restartFlag("runner")) },
      tunnel: (() => { const s = T.readState(); return s || loaded(TUNNEL) ? { loaded: loaded(TUNNEL), state: s?.state ?? null, url: s?.url ?? null, mode: s?.mode ?? null, healthy: T.describe(s).ok } : null; })() });
    return 0;
  }
  if (cmd === "restart") {
    if (!which(what)) { console.error("usage: kitebook restart [server|runner|tunnel|all]"); return 2; }
    const res: any = {};
    if (what === "tunnel") Object.assign(res, restartTunnel());
    else { if (what !== "runner") Object.assign(res, await restartServer());
      if (what !== "server") Object.assign(res, restartRunner()); }
    audit({ action: "restart", what, result: res }); out(res);
    return String(res.server ?? "").includes("NOT") || /failed/.test(String(res.server ?? "") + String(res.tunnel ?? "")) || res.tunnel === "not installed" ? 1 : 0;
  }
  const git = (...a: string[]) => run(["git", "-C", source, ...a]);

  const confirm = async (q: string) => { process.stdout.write(q); for await (const line of console) return line.trim().toLowerCase() === "y"; return false; };
  async function gitUpdate(): Promise<{ res: any; code: number }> {
    const before = git("rev-parse", "--short", "HEAD").out, head = git("rev-parse", "HEAD").out;
    if (cfg.updatePin && cfg.updatePin === head) delete cfg.updatePin; // a pin this checkout already runs is done (an older Settings click can leave one behind)
    const f = git("fetch", "-q"); if (f.code) return { res: { update: "fetch failed", error: f.err }, code: 1 };
    // kitebook update --channel dev (the owner's terminal, y/N below): origin/dev instead of the branch's upstream; afterwards the checkout
    // sits on a dev branch tracking origin/dev (client/channel.ts followChannel), so a plain `kitebook update` or `git pull` keeps following dev
    const ci = argv.findIndex(a => a === "--channel" || a.startsWith("--channel=")), chan = ci < 0 ? null : argv[ci].includes("=") ? argv[ci].split("=")[1] : argv[ci + 1];
    if (chan && !["dev", "main", "stable"].includes(chan)) return { res: { update: "refused", error: `--channel ${chan}: use dev (or main, the stable channel)` }, code: 2 };
    const want = cfg.updatePin ? git("rev-parse", "--verify", "-q", `${cfg.updatePin}^{commit}`) : chan ? git("rev-parse", "--verify", "-q", `origin/${chan === "dev" ? "dev" : "main"}^{commit}`) : git("rev-parse", "--verify", "-q", "@{u}");
    if (want.code) return { res: { update: "refused", error: cfg.updatePin ? `pinned commit ${cfg.updatePin} not found` : chan ? `there's no ${chan === "dev" ? "dev" : "main"} branch on origin` : "no upstream branch to update from" }, code: 1 };
    if (want.out === head) { // up to date, but a server still on cf dev is part of the owner's update: the owner's kitebook update (re)tries it
      const res: any = { update: "up to date", at: before, pinned: !!cfg.updatePin };
      if (!fromTask && (await import("./host-upgrade.ts")).oldHost(cfg, cfgPath)) { audit({ action: "host_upgrade", to: head }); const h = postUpdate(); if (h) Object.assign(res, h.res); return { res, code: h?.code ?? 0 }; }
      // a workerd server folder still on older code than this checkout (the U1 case: an update before this step existed): bring it up to HEAD
      if (!fromTask && (await import("./host-upgrade.ts")).workerdHost(cfg, cfgPath)) { const h = postUpdate(); if (h?.server) { Object.assign(res, h.res); return { res, code: h.code }; } }
      return { res, code: 0 }; }
    if (!cfg.updatePin && !git("merge-base", "--is-ancestor", want.out, "HEAD").code) // on dev (Update to dev now), ahead of main: main catches up by a promote, nothing to do
      return { res: { update: "up to date", at: before, ahead_of: git("rev-parse", "--abbrev-ref", "@{u}").out || "upstream", note: "this checkout runs a newer commit (dev) than its upstream; it follows again once that branch reaches it" }, code: 0 };
    if (git("merge-base", "--is-ancestor", "HEAD", want.out).code) { audit({ action: "update_refused", why: "not fast-forward", to: want.out }); return { res: { update: "refused", error: `${want.out.slice(0, 12)} is not a fast-forward of ${before} (history was rewritten?)` }, code: 1 }; }
    if (!cfg.updatePin) { // no pin: only the owner, at a terminal, can approve what they see
      const incoming = git("log", "--oneline", `HEAD..${want.out}`).out;
      if (fromTask || !process.stdin.isTTY) { audit({ action: "update_refused", why: "not pinned", to: want.out }); return { res: { update: "refused", error: "updates need the owner's approval: pin the commit first (kitebook pin <sha>) or run kitebook update from your own terminal", incoming: incoming.split("\n").slice(0, 20) }, code: 1 }; }
      if (!(await confirm(`Update ${source} ${before} -> ${want.out.slice(0, 12)}:\n${incoming}\nApply? [y/N] `))) return { res: { update: "declined" }, code: 1 };
    }
    const GP = await import("./git-pull.ts"); GP.ownUpdate(source, "start"); // the runner's git-pull watcher leaves this move to the updater
    try { return await applyFF(); } finally { GP.ownUpdate(source, "done"); }
    async function applyFF(): Promise<{ res: any; code: number }> {
    const pull = git("merge", "--ff-only", "-q", want.out);
    if (pull.code) return { res: { update: "fast-forward failed", error: pull.err }, code: 1 };
    const after = git("rev-parse", "--short", "HEAD").out;
    const res: any = { from: before, to: after };
    // what happened goes into the Updates history (Settings, and "Updated to X" on the Status card), like a release install
    const note = async (result: "installed" | "rolled back", why: string | null = null) => { try { (await import("./updater.ts")).note({ result, why, from: before, to: after, release: null, by: o.by ?? (fromTask ? `task ${process.env.KITEBOOK_TASK_ID}` : o.inRunner ? "you, in Settings" : "you, in Terminal"), at: new Date().toISOString() }); } catch {} };
    // back to the commit this update started from (a fast-forward, so nothing of the owner's is lost; --keep refuses to touch local edits)
    const back = async (why: string) => { const r = git("reset", "-q", "--keep", head); audit({ action: "update_rolled_back", from: head, to: want.out, why });
      res.rolled_back = r.code ? `couldn't go back to ${before}: ${r.err}` : `went back to ${before}: ${why}`; await note("rolled back", why); };
    // the new code has to load before anything restarts on it (the runner imports every module for --help, like a release's health check)
    // (only when the checkout has the runner: a server-only checkout has nothing to load here)
    if (existsSync(join(source, "client", "runner.ts"))) { const hp = Bun.spawnSync([process.execPath, join(source, "client", "runner.ts"), "--help"], { cwd: source, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000, env: { ...process.env, KITEBOOK_TASK_ID: "" } as any });
      if (hp.exitCode !== 0 || !hp.stdout.toString().includes("usage (bun")) { await back(`the new runner didn't start (${(hp.stderr.toString().trim().split("\n").pop() || `exit ${hp.exitCode}`).slice(0, 200)})`); audit({ action: "update", result: res }); return { res, code: 1 }; } }
    audit({ action: "fast_forward", from: head, to: git("rev-parse", "HEAD").out }); // the owner's approval of this exact commit, for its post-update step
    // the NEW code's own update step (client/host-upgrade.ts post-update): today, upgrading a server still on cf dev; it restarts the
    // server and the runner itself, so the copy + restarts below are skipped when it handled the server
    const h = fromTask ? null : postUpdate(head);
    if (h?.server && h.runnerRestarts) { Object.assign(res, h.res); audit({ action: "update", result: res }); return { res, code: h.code }; } // the old cf dev host's upgrade restarts everything itself
    if (h?.server) { // a workerd host: the new code updated the server folder and restarted it (or put the previous server back): no copy here
      Object.assign(res, h.res);
      if (h.code) { await back(`server_update_failed: ${h.res.server_update_error ?? "the server didn't take the new code"} (log: ~/Library/Logs/kitebook-upgrade.log)`); res.server = "server_update_failed"; audit({ action: "update", result: res }); return { res, code: 1 }; }
      res.server = `updated, serves ${after}`;
    } else {
    if (sv.dir && resolve(expand(sv.dir)) !== source) {
      const dir = resolve(expand(sv.dir));
      for (const f of COPY) if (existsSync(join(source, f))) cpSync(join(source, f), join(dir, f), { recursive: true, force: true });
      res.copied = `${COPY.join(", ")} -> ${dir}`;
    }
    Object.assign(res, await restartServer());
    const sick = /NOT|failed/.test(String(res.server));
    if (sick && sv.dir && resolve(expand(sv.dir)) !== source) {
      // Git already holds the previous code. Restore it directly; never copy the server or its data into a backup folder.
      const dir = resolve(expand(sv.dir)), files = git("ls-tree", "--name-only", head, "--", ...COPY);
      const archive = files.code || !files.out ? null : Bun.spawnSync(["git", "-C", source, "archive", head, "--", ...files.out.split("\n").filter(Boolean)], { stdout: "pipe", stderr: "pipe" });
      if (!archive || archive.exitCode) { // the checkout still goes back; say plainly that the server folder couldn't
        await back(`the new server didn't pass its health check (${sv.health})`);
        res.rolled_back = `failed: the checkout went back to ${before}, but the previous server code couldn't be read from git, so ${dir} still has the new code and its server isn't healthy; run kitebook update again`;
      } else {
        for (const f of COPY) rmSync(join(dir, f), { recursive: true, force: true });
        const restore = Bun.spawnSync(["tar", "-xf", "-", "-C", dir], { stdin: archive.stdout, stdout: "pipe", stderr: "pipe" });
        await back(`the new server didn't pass its health check (${sv.health})`);
        if (restore.exitCode) res.rolled_back = `failed: the checkout went back to ${before}, but ${dir} couldn't be given the previous code back (${restore.stderr.toString().trim().slice(0, 200)}); run kitebook update again`;
        else { const rb = await restartServer(); res.rolled_back = rb.server; }
      }
    } else if (sick && res.server !== "not installed") { // the server runs from this checkout itself (scripts/get.sh, mac-host.sh): put the commit back, restart, check again
      await back(`the new server didn't pass its health check (${sv.health})`); const rb = await restartServer(); res.server_after_rollback = rb.server;
    }
    }
    if (!res.rolled_back) { try { const f = (await import("./channel.ts")).followChannel(source, { audit }); if (f.switched) res.channel = f.why; } catch {} // a dev commit: onto the dev branch, not main
      Object.assign(res, restartRunner()); await note("installed"); }
    audit({ action: "update", result: res });
    return { res, code: res.rolled_back || String(res.server).includes("failed") ? 1 : 0 };
  }
  }
  // bun <source>/client/host-upgrade.ts post-update: run from the checkout just moved (new code), so every version brings its own update
  // step. null: that checkout has none (older), or it said nothing usable; the update carries on as before.
  function postUpdate(from?: string): { res: any; code: number; server: boolean; runnerRestarts: boolean } | null {
    const f = join(source, "client", "host-upgrade.ts"); if (!existsSync(f)) return null;
    const env = { ...process.env } as any; delete env.KITEBOOK_TASK_ID;
    const p = Bun.spawnSync([process.execPath, f, "post-update", resolve(cfgPath), ...(o.inRunner ? ["--in-runner"] : []), "--caller-rolls-back", ...(from ? ["--from", from] : [])], { cwd: source, env, stdin: "ignore", stdout: "pipe", stderr: "inherit" }); // progress on stderr: the terminal, or the runner log
    let j: any = null; try { j = JSON.parse(p.stdout.toString().trim().split("\n").pop() || ""); } catch { return null; }
    if (!j?.post_update || j.post_update === "nothing to do") return null;
    if (j.server_handled && !j.runner_restarts) return { res: { server_update: j.post_update, ...(j.server_sha ? { server_sha: j.server_sha } : {}), ...(j.error ? { server_update_error: j.error, log: j.log ?? "~/Library/Logs/kitebook-upgrade.log" } : {}) }, code: p.exitCode ? 1 : 0, server: true, runnerRestarts: false };
    const res: any = { server_upgrade: j.post_update, ...(j.error ? { server_upgrade_error: j.error } : {}), ...(j.runner_restarts ? { runner: o.inRunner ? "restarts when the server upgrade is done" : "restarted by the server upgrade" } : {}),
      log: "~/Library/Logs/kitebook-upgrade.log" };
    return { res, code: p.exitCode ? 1 : 0, server: !!j.server_handled, runnerRestarts: !!j.server_handled };
  }
  async function runnerUpdate(cur: string): Promise<{ res: any; code: number; installed?: boolean }> {
    const base: any = { runner_version: cur }, U = await import("./updater.ts"), by = fromTask ? `task ${process.env.KITEBOOK_TASK_ID}` : "owner cli";
    const done = (r: any) => { if (r.result !== "up to date") audit({ action: r.result === "installed" ? "runner_update" : "runner_update_refused", by: r.by, from: r.from, to: r.to, release: r.release, why: r.why, signed: !!I.releaseKey(cfg) });
      if (r.result === "up to date") return { res: { ...base, runner_update: "up to date" }, code: 0 };
      if (r.result === "installed") return { res: { ...base, runner_update: "installed", runner_version: r.to, runner_previous: r.from, runner_release: r.release ?? null, relay_command: r.wrapper ?? null, agent_configs: r.agents?.length ? r.agents : null }, code: 0, installed: true };
      return { res: { ...base, runner_update: r.result, runner_available: r.to, runner_error: r.why }, code: 1 }; };
    // signed releases (a release key is pinned): the newest release signed with it and numbered higher installs with no prompt, from the
    // owner's terminal and from an agent's task alike, because nobody picks the code; anything else is refused with the reason.
    const c = await U.check(cfg);
    if (c.state === "up_to_date" || c.state === "newer" || (c.key_pinned && c.state !== "no_number") || c.state === "unreachable") return done(await U.apply(cfg, { by, cfgPath }));
    // unsigned (no key pinned on this Mac) or a signed release with no number: only the owner approves it, at the terminal or with one click in Settings
    if (cfg.runnerPin !== c.latest) {
      // no terminal y here: the owner's one click in Settings is the approval (only a git ref still asks at the terminal)
      audit({ action: "runner_update_refused", why: "not approved", to: c.latest });
      return { res: { ...base, runner_update: "refused", runner_available: c.latest, runner_error: `Runner ${c.latest} can't be checked by itself (${c.state === "no_key" ? "this Mac has no release key pinned" : "its signature has no release number"}), so it waits for your OK: press Update now in Settings -> Updates.` }, code: 1 };
    }
    return done(await U.apply(cfg, { by, cfgPath, approved: c.latest! }));
  }
  if (cmd === "pin") { // owner approves one exact commit (git checkout) or runner version (pinned install) for the next update ("-" clears both)
    if (fromTask) { out({ pin: "refused", error: "only the machine owner can pin an update (from their own terminal)" }); return 1; }
    if (!what || what === "all") { out({ pin: cfg.updatePin ?? null, runner_pin: cfg.runnerPin ?? null }); return 0; }
    const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
    if (what === "-") { delete raw.updatePin; delete raw.runnerPin; }
    else if (I.isVersion(what)) raw.runnerPin = what; // 16 hex = a runner manifest version (doctor / status print it)
    else { git("fetch", "-q"); const sha = git("rev-parse", "--verify", "-q", `${what}^{commit}`); if (sha.code) { out({ pin: "unknown commit", error: what }); return 1; } raw.updatePin = sha.out; }
    writeFileSync(cfgPath, JSON.stringify(raw, null, 2), { mode: 0o600 }); chmodSync(cfgPath, 0o600); stampOwnerEdit(cfgPath);
    out({ pin: raw.updatePin ?? null, runner_pin: raw.runnerPin ?? null }); audit({ action: "pin", pin: raw.updatePin ?? null, runner_pin: raw.runnerPin ?? null }); return 0;
  }
  if (cmd === "update") {
    // Two parts, each gated on the owner: the git checkout (fast-forward to the pinned commit) when the runner or server runs
    // from one, then the pinned runner install (kitebook manifest version == runnerPin, or y/N at the owner's terminal; every
    // file is sha256-checked against the manifest before `current` switches).
    if ((await import("./binary.ts")).active()) { // the kitebook binary (client/binary.ts): GitHub Releases, same signed/numbered rules as below
      const r = await runnerUpdate(String((await import("./binary.ts")).current()?.version ?? "unknown"));
      if (r.installed) { mkdirSync(STATE, { recursive: true }); writeFileSync(restartFlag("runner"), new Date().toISOString()); r.res.runner = "restarts by itself once its tasks finish"; }
      out(r.res); return r.code; }
    const inst = I.verifyInstall(), gitMode = !!cfg.source || !I.isInstalledPath(import.meta.path);
    let res: any = {}, code = 0;
    if (gitMode) ({ res, code } = await gitUpdate());
    if (!code && inst.installed) { const r = await runnerUpdate(inst.version!); Object.assign(res, r.res); code = r.code;
      if (r.installed && !res.runner) { mkdirSync(STATE, { recursive: true }); writeFileSync(restartFlag("runner"), new Date().toISOString()); res.runner = "restarts by itself once its tasks finish"; } } // no prompt, never mid-task
    if (!gitMode && !inst.installed) { res = { update: "nothing to update", error: "no git checkout (source) and no pinned install in ~/.kitebook" }; code = 1; }
    out(res); return code;
  }
  console.error(o.plain ? "usage (kitebook help for more): kitebook status | restart [server|runner|tunnel|all] | update | logs [server|runner|tunnel] [-n N] [-f] | stop [server|runner|tunnel|all] | start [server|runner|tunnel|all] | pin <sha|runner-version|-> | tunnel [status|restart|token|quick]"
    : "usage: service <runner.json> status | restart server|runner|all | update | pin <sha|runner-version|-> | stop|start [server|runner|all] | logs [server|runner]"); return 2;
}
