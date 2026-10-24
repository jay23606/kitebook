// Runner service management: the per-user service install (launchd / systemd --user / Kitebook's supervisor; starts at login, restarts if it
// dies) and the clean uninstall.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import * as KB from "./kb.ts";
import { sh } from "./runner-ctx.ts";
import * as PL from "./platform.ts";
import * as SV from "./supervise.ts";

// Clean uninstall. The token is revoked first (while we still have it), so a copy left anywhere (an old runner.json, a backup) is dead.
// Local cleanup still runs if the server can't be reached, and the exit code says the revoke didn't happen.
export async function uninstall(cfgFile: string, purge: boolean): Promise<number> {
  const label = "dev.kitebook.runner", plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`), fs = require("fs");
  let rc = 0, c: any = null; try { c = JSON.parse(readFileSync(cfgFile, "utf8")); } catch {}
  if (!macOs()) { try { await otherOs("uninstall", cfgFile); } catch (e: any) { console.error(e.message); } } // systemd unit / supervisor job + logon task
  else { // the same launchctl as service.ts (runner.json "launchctl" for the fake Mac; /bin/launchctl on a Mac, where `kitebook` may run with a bare PATH)
    const lc = c?.launchctl ?? (process.platform === "darwin" ? "/bin/launchctl" : "launchctl");
    for (const l of [label, "dev.relay.runner"]) await sh([lc, "bootout", `gui/${process.getuid!()}/${l}`], homedir()).catch(() => {}); } // ignore "not loaded"; the pre-rename job too
  try { require("fs").unlinkSync(join(homedir(), "Library/LaunchAgents", "dev.relay.runner.plist")); } catch {}
  if (macOs()) await removeWatchdog(c?.launchctl ?? (process.platform === "darwin" ? "/bin/launchctl" : "launchctl")); // its watchdog goes with it
  // the plist goes on any OS (a home folder copied from a Mac, a test's fake Mac); "none installed" is only news on macOS
  if (existsSync(plist)) { fs.unlinkSync(plist); console.log("removed launchd job", label); } else if (macOs()) console.log("no launchd job installed");
  if (!purge) return 0;
  if (c?.url && c?.token) {
    try {
      const r = await fetch(`${String(c.url).replace(/\/+$/, "")}/v1/revoke_self`, { method: "POST", headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) });
      const j: any = await r.json().catch(() => ({}));
      if (j.ok) console.log(`revoked this runner's token on ${c.url} (connected as ${j.result?.peer ?? j.result?.revoked ?? "?"})`);
      else if (r.status === 401) console.log(`token was already invalid on ${c.url}; nothing to revoke`);
      else { rc = 1; console.error(`could not revoke the token (${j.error ?? r.status}); revoke it yourself: open ${c.url}/start -> Status -> Revoke next to this runner`); }
    } catch (e: any) { rc = 1; console.error(`could not reach ${c.url} to revoke the token (${e?.message ?? e}); revoke it yourself: open ${c.url}/start -> Status -> Revoke next to this runner`); }
  } else console.log(`no url/token in ${cfgFile}; skipped token revocation`);
  const { rmTree } = await import("./integrity.ts"); // the pinned install is read-only
  // ~/.kitebook-kb holds the KB read cache (~/.kitebook-kb/kb: the owner's notes as text), so a purge removes it too. A kb.cache set elsewhere is named, not deleted.
  for (const p of [join(homedir(), ".kitebook"), join(homedir(), ".kitebook-kb"), join(homedir(), "Library/Logs/kitebook-runner.log")]) if (existsSync(p)) { rmTree(p); console.log("deleted", p); }
  for (const p of [".relay-runner", ".relay"].map(d => join(homedir(), d))) try { if (require("fs").lstatSync(p).isSymbolicLink()) require("fs").unlinkSync(p); } catch {} // the pre-rename names (links to the folders above)
  const kc = c?.kb?.cache ? KB.expand(c.kb.cache) : null; if (kc && existsSync(kc) && !kc.startsWith(join(homedir(), ".kitebook-kb") + "/")) console.log(`left the KB cache at ${kc} (kb.cache in ${cfgFile}); delete it if you don't want those notes on disk`);
  if (existsSync(cfgFile)) console.log(`left ${cfgFile} in place (its token is ${rc ? "NOT yet" : "now"} revoked); delete it if you don't need its settings`);
  return rc;
}

// install / uninstall the runner as this OS's per-user service: launchd on macOS, a systemd --user unit on Linux, Kitebook's supervisor on
// Windows (a Scheduled Task at logon, no admin) and on Linux without systemd. kitebook status / restart / logs / stop / start then manage it.
// KITEBOOK_FAKE_MAC=1: smoke.sh's fake Mac on Linux (a launchctl stand-in first on PATH) stays on the launchd path, so the one-step install is tested end to end
const macOs = () => PL.plat() === "darwin" || !!process.env.KITEBOOK_FAKE_MAC;
export async function launchd(cmd: string, cfgFile: string) {
  if (!macOs()) return otherOs(cmd, cfgFile);
  const label = "dev.kitebook.runner", plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`), uid = process.getuid!();
  await sh(["launchctl", "bootout", `gui/${uid}/${label}`], homedir()); // ignore "not loaded"
  // the job under its pre-rename name (Relay -> Kitebook) goes too, so a reinstall never leaves two runners
  { const old = join(homedir(), "Library/LaunchAgents", "dev.relay.runner.plist"); if (existsSync(old)) { await sh(["launchctl", "bootout", `gui/${uid}/dev.relay.runner`], homedir()); try { require("fs").unlinkSync(old); } catch {} } }
  if (cmd === "uninstall") { try { require("fs").unlinkSync(plist); } catch {} await removeWatchdog("launchctl"); console.log("removed", label); return; }
  const c = JSON.parse(readFileSync(cfgFile, "utf8")), abs = require("path").resolve(cfgFile), self = (await import("./integrity.ts")).launchPath(require("path").join(require("path").dirname(require("path").resolve(import.meta.path)), "runner.ts")); // runner.ts next to this module (not this module itself); a pinned install: start `current`, so updates take effect on restart
  const argv = [...(c.keepAwake ? ["/usr/bin/caffeinate", "-i"] : []), process.execPath, self, abs];
  const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const logf = join(homedir(), "Library/Logs/kitebook-runner.log");
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${argv.map(a => `<string>${x(a)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${x(process.env.PATH ?? "/usr/bin:/bin")}</string><key>KITEBOOK_LAUNCHD</key><string>1</string></dict>
  <key>StandardOutPath</key><string>${x(logf)}</string>
  <key>StandardErrorPath</key><string>${x(logf)}</string>
</dict></plist>
`);
  const r = await sh(["launchctl", "bootstrap", `gui/${uid}`, plist], homedir());
  if (r.code) throw new Error(`launchd couldn't start ${label}: ${r.err}. Check it with: kitebook status (logs: kitebook logs runner)`);
  console.log(`installed ${label}: starts at login, restarts if it stops. Logs: ${logf}`);
  try { const w = await ensureWatchdog(abs, { launchctl: "launchctl", force: true }); if (w) console.log(w); } catch (e: any) { console.error(`watchdog not installed: ${e.message}`); }
  if (c.env?.length) console.log(`note: launchd doesn't see your shell env. Put ${c.env.join(", ")} in a file and set "envFile" in runner.json.`);
}

// systemd unit text: ExecStart's words quoted for systemd (\ " escaped, % and $ doubled so nothing expands), the runner's PATH saved
export function systemdUnit(desc: string, argv: string[], env: Record<string, string>, log?: string) { // log: a file instead of the journal
  const q = (a: string) => `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
  return `[Unit]\nDescription=${desc}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart=${argv.map(q).join(" ")}\n` +
    Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}\n`).join("") +
    `Restart=always\nRestartSec=10\n${log ? `StandardOutput=append:${log}\nStandardError=append:${log}\n` : ""}\n[Install]\nWantedBy=default.target\n`;
}
// Install (or replace) one of Kitebook's jobs (kitebook-server, kitebook-runner, kitebook-tunnel) as this OS's per-user service, off macOS: a systemd
// --user unit where systemd answers, else Kitebook's supervisor with its logon hook. cfg: runner.json's overrides (systemctl, schtasks, supervise).
export async function installJob(name: string, desc: string, argv: string[], env: Record<string, string>, cfg: any = {}, cwd?: string): Promise<string> {
  const { pickBackend } = await import("./service.ts"), be = pickBackend(cfg);
  const sc = (...a: string[]) => sh([cfg.systemctl ?? "systemctl", "--user", ...a], homedir()), unitFile = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", `${name}.service`);
  if (be.kind === "systemd") {
    require("fs").mkdirSync(require("path").dirname(unitFile), { recursive: true });
    writeFileSync(unitFile, systemdUnit(desc, argv, env).replace("[Service]\n", `[Service]\n${cwd ? `WorkingDirectory=${cwd}\n` : ""}`)); // output: the journal (kitebook logs)
    for (const a of [["daemon-reload"], ["enable", name], ["restart", name]]) { const r = await sc(...a); if (r.code) throw new Error(`${name} didn't start (${r.err.trim() || r.out.trim()}). Check it with: kitebook status`); }
    // a user service stops when the owner logs out unless lingering is on (a desktop that stays signed in doesn't need it)
    const lg = await sh(["loginctl", "show-user", process.env.USER ?? "", "--property=Linger", "--value"], homedir()).catch(() => ({ code: 1, out: "" }));
    return `a systemd user service, restarts if it stops${!lg.code && lg.out.trim() === "no" ? `. It runs while you're signed in; to keep it running after you log out (a server, an SSH box): loginctl enable-linger ${process.env.USER ?? "$USER"}` : ""}`;
  }
  require("fs").mkdirSync(PL.logDir(), { recursive: true });
  const r = SV.install(name, { argv, env, cwd, log: join(PL.logDir(), `${name}.log`) }, { schtasks: cfg.schtasks });
  if (r.code) throw new Error(`${name} didn't start: ${r.err}. Check it with: kitebook status`);
  return `${r.hook === "scheduled task" ? "starts when you sign in to Windows (a Scheduled Task, no admin)" : r.hook === "startup folder" ? "starts when you sign in (Startup folder)" : r.hook === "desktop autostart" ? "starts at desktop login" : "running now"}, restarts if it stops`;
}
export async function hasJob(name: string, cfg: any = {}) {
  const { pickBackend } = await import("./service.ts"), be = pickBackend(cfg);
  return be.kind === "systemd" ? existsSync(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", `${name}.service`)) : SV.installed(name);
}
export async function removeJob(name: string, cfg: any = {}) {
  const { pickBackend } = await import("./service.ts"), be = pickBackend(cfg);
  if (be.kind === "systemd") { const sc = (...a: string[]) => sh([cfg.systemctl ?? "systemctl", "--user", ...a], homedir()); await sc("disable", "--now", name);
    try { require("fs").unlinkSync(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", `${name}.service`)); } catch {} await sc("daemon-reload"); }
  else await SV.uninstall(name, { schtasks: cfg.schtasks });
}
async function otherOs(cmd: string, cfgFile: string) {
  const c = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : {}, abs = require("path").resolve(cfgFile), unit = c.runnerUnit ?? "kitebook-runner";
  const { LEGACY_UNIT } = await import("./brand.ts"), legacy = async () => { if (unit !== LEGACY_UNIT.runner && (await hasJob(LEGACY_UNIT.runner, c))) await removeJob(LEGACY_UNIT.runner, c); }; // the pre-rename job
  if (cmd === "uninstall") { await removeJob(unit, c); await legacy(); console.log("removed", unit); return; }
  await legacy();
  const self = (await import("./integrity.ts")).launchPath(join(require("path").dirname(require("path").resolve(import.meta.path)), "runner.ts")); // runner.ts, not this module
  const { pickBackend } = await import("./service.ts"), kind = pickBackend(c).kind;
  const how = await installJob(unit, "Kitebook runner (coding tasks from your assistants)", [process.execPath, self, abs], { PATH: PL.withAgentDirs(PL.envPath()), KITEBOOK_SERVICE: kind }, c);
  console.log(`installed ${unit}: ${how}. Logs: kitebook logs runner`);
  if (c.env?.length) console.log(`note: the service doesn't see your shell env. Put ${c.env.join(", ")} in a file and set "envFile" in runner.json.`);
}

// The runner's watchdog (client/watchdog.ts) as its own launchd job: run once a minute (StartInterval), so there's no long-lived process
// to die with the runner. KeepAlive on the runner job restarts a runner that exits; the watchdog restarts one that's alive but gone from
// the server (never reconnected) or a job that was unloaded, with backoff, and tells the owner's phone when that fails (runner.json ntfy).
// Installed by `install` above and, for a Mac set up before this, by the runner itself at start under launchd (client/runner.ts).
// Not on the smoke's fake Mac unless KITEBOOK_WATCHDOG=1 (its launchctl stand-in starts every bootstrapped job); runner.json
// "watchdog": {"off": true} keeps it off.
export const WATCHDOG_LABEL = "dev.kitebook.watchdog";
export function watchdogPlist(argv: string[], logf: string, path: string) {
  const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${WATCHDOG_LABEL}</string>
  <key>ProgramArguments</key><array>${argv.map(a => `<string>${x(a)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${x(path)}</string></dict>
  <key>StandardOutPath</key><string>${x(logf)}</string>
  <key>StandardErrorPath</key><string>${x(logf)}</string>
</dict></plist>
`;
}
// write + load the watchdog job when it's missing or different (a moved checkout, a new bun); null = nothing to do / not here
export async function ensureWatchdog(cfgFile: string, o: { launchctl?: string; force?: boolean } = {}): Promise<string | null> {
  if (!macOs() || (process.env.KITEBOOK_FAKE_MAC && process.env.KITEBOOK_WATCHDOG !== "1")) return null;
  let c: any = {}; try { c = JSON.parse(readFileSync(cfgFile, "utf8")); } catch {}
  if (c.watchdog?.off === true) return null;
  const plist = join(homedir(), "Library/LaunchAgents", `${WATCHDOG_LABEL}.plist`), logf = join(homedir(), "Library/Logs/kitebook-watchdog.log");
  const self = (await import("./integrity.ts")).launchPath(join(require("path").dirname(require("path").resolve(import.meta.path)), "watchdog.ts"));
  const want = watchdogPlist([process.execPath, self, require("path").resolve(cfgFile)], logf, process.env.PATH ?? "/usr/bin:/bin");
  // the runner job itself must restart on exit: launchd KeepAlive (every plist launchd() wrote has it; an older hand-made one may not, and
  // then the watchdog's kickstart is what brings it back)
  try { const rp = readFileSync(join(homedir(), "Library/LaunchAgents", "dev.kitebook.runner.plist"), "utf8"); if (!/<key>KeepAlive<\/key>\s*<true\/>/.test(rp)) console.error("watchdog: the runner's launchd job has no KeepAlive; the watchdog restarts it when it stops (bun client/runner.ts install <runner.json> writes the job with it)"); } catch {}
  let cur = ""; try { cur = readFileSync(plist, "utf8"); } catch {}
  if (cur === want && !o.force) return null;
  const lc = o.launchctl ?? c.launchctl ?? (process.platform === "darwin" ? "/bin/launchctl" : "launchctl"), uid = process.getuid!();
  require("fs").mkdirSync(require("path").dirname(plist), { recursive: true }); require("fs").mkdirSync(require("path").dirname(logf), { recursive: true });
  if (cur) await sh([lc, "bootout", `gui/${uid}/${WATCHDOG_LABEL}`], homedir()).catch(() => {});
  writeFileSync(plist, want);
  const r = await sh([lc, "bootstrap", `gui/${uid}`, plist], homedir());
  if (r.code) throw new Error(`launchd couldn't load ${WATCHDOG_LABEL}: ${r.err}`);
  return `installed ${WATCHDOG_LABEL}: checks the runner every minute and restarts it if it's gone from the server (at most 3 times an hour). Logs: ${logf}`;
}
async function removeWatchdog(lc: string) {
  const plist = join(homedir(), "Library/LaunchAgents", `${WATCHDOG_LABEL}.plist`); if (!existsSync(plist)) return;
  await sh([lc, "bootout", `gui/${process.getuid!()}/${WATCHDOG_LABEL}`], homedir()).catch(() => {}); try { require("fs").unlinkSync(plist); } catch {}
}
