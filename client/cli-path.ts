// The `kitebook` command on the owner's PATH, for every way Kitebook got onto this machine. scripts/get.sh and install.sh put it there,
// but an older git install (a clone + the old cf dev server, set up before the command existed) that is updated by `git pull` + a runner
// restart (client/git-pull.ts, client/host-upgrade.ts) never ran either, so the new runner worked and `kitebook` said "command not found".
// The runner's start-up and the post-update step (host-upgrade.ts post-update) now call ensureCli():
//   1. the wrapper ~/.local/bin/kitebook (KITEBOOK_BIN_DIR) is written when it is missing or stale (ours, '# Kitebook CLI', but its bun or
//      cli.ts is gone); a `kitebook` that isn't ours is left alone. An install from before the rename also gets the `relay` shim.
//   2. when a new login shell wouldn't find it, one marked block goes into the shell's rc files (zsh: ~/.zprofile + ~/.zshrc; bash:
//      ~/.bashrc + ~/.bash_profile or ~/.profile; anything else: ~/.profile), idempotently, and the log says to open a new Terminal window.
// "Would a new login shell find it": an rc file already puts the folder on PATH (our block, get.sh's line, the owner's own), else the
// login shell itself is asked (`$SHELL -l -i -c`, a clean environment like a fresh Terminal window, 8 s cap). Windows: get.ps1 does both.
// Not for a task's process (an agent never edits the owner's shell files) and not when KITEBOOK_CLI_PATH=off (the smoke's runners).
// `bun client/cli-path.ts [install|check] [runner.json]`: doctor's one fix (install) and a look (check, changes nothing); prints JSON.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, realpathSync, lstatSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { homedir as osHome, userInfo } from "os";
import * as PL from "./platform.ts";

type Log = (...a: any[]) => void;
// $HOME as this process sees it now (os.homedir() is read once at start in bun; the tests and a HOME=... caller set it)
const homedir = () => process.env.HOME || osHome();
export const START = "# >>> kitebook: the kitebook command on PATH (added by Kitebook) >>>", END = "# <<< kitebook <<<";
const tilde = (p: string, home = homedir()) => p === home ? "~" : p.startsWith(home + "/") ? "~/" + p.slice(home.length + 1) : p;
export const binDir = () => process.env.KITEBOOK_BIN_DIR || PL.binDir(PL.plat(), process.env, homedir());

// the owner's login shell: $SHELL, else the account's, else the OS default (launchd jobs often have no SHELL)
export function loginShell(env: Record<string, string | undefined> = process.env, p = PL.plat()): string {
  if (env.KITEBOOK_LOGIN_SHELL) return env.KITEBOOK_LOGIN_SHELL;
  let s = env.SHELL; if (!s) try { s = userInfo().shell ?? undefined; } catch {}
  return s && s !== "/bin/false" && !/nologin$/.test(s) ? s : p === "darwin" ? "/bin/zsh" : "/bin/bash";
}
// the files a new Terminal window reads, for that shell. zsh: .zprofile (login, what Terminal.app opens) and .zshrc (every interactive
// shell). bash: .bashrc (most Linux terminals) and the login file bash actually reads (.bash_profile when it exists, which hides .profile).
export function rcFiles(shell: string, home = homedir()): string[] {
  const n = basename(shell);
  if (n === "zsh") return [join(home, ".zprofile"), join(home, ".zshrc")];
  if (n === "bash") return [join(home, ".bashrc"), existsSync(join(home, ".bash_profile")) ? join(home, ".bash_profile") : join(home, ".profile")];
  if (n === "fish") return []; // not sh syntax: the log / doctor say fish_add_path instead
  return [join(home, ".profile")];
}
// $HOME/... in the block, so a renamed home folder keeps working; POSIX sh, and the case keeps it from stacking up in nested shells
export function block(bin: string, home = homedir()): string {
  const b = bin === home || bin.startsWith(home + "/") ? "$HOME" + bin.slice(home.length) : bin;
  return `${START}\ncase ":$PATH:" in *":${b}:"*) ;; *) export PATH="${b}:$PATH" ;; esac\n${END}\n`;
}
// already puts bin on PATH: our block, or any uncommented line that sets PATH and names the folder (get.sh's '# added by Kitebook', the owner's own)
export function hasPathLine(text: string, bin: string, home = homedir()): boolean {
  if (text.includes(START)) return true;
  const forms = [bin, "$HOME" + bin.slice(home.length), "${HOME}" + bin.slice(home.length), "~" + bin.slice(home.length)].filter((f, i) => i === 0 || bin.startsWith(home + "/"));
  return text.split("\n").some(l => !/^\s*#/.test(l) && /PATH/.test(l) && forms.some(f => l.includes(f)));
}
const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return null; } };
export const rcHasPath = (bin: string, home = homedir(), files = [".zprofile", ".zshrc", ".bashrc", ".bash_profile", ".profile"].map(f => join(home, f))) =>
  files.filter(f => { const t = read(f); return t !== null && hasPathLine(t, bin, home); });
// add the block to each file that doesn't put bin on PATH yet; returns the files changed
export function addBlock(files: string[], bin: string, home = homedir()): string[] {
  const changed: string[] = [];
  for (const f of files) { const t = read(f) ?? ""; if (hasPathLine(t, bin, home)) continue;
    writeFileSync(f, `${t}${t && !t.endsWith("\n") ? "\n" : ""}${t ? "\n" : ""}${block(bin, home)}`); changed.push(f); }
  return changed;
}
// uninstall: the block out again (only ours, between the markers)
export function removeBlock(text: string): string {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), n = text.replace(new RegExp(`\\n*${esc(START)}\\n[\\s\\S]*?${esc(END)}\\n?`, "g"), "\n");
  return n === "\n" ? "" : n;
}

// Does a new login shell find `kitebook`? true / false, or null when it couldn't tell (no shell, it hung, it printed nothing).
// A clean environment, like a fresh Terminal window: the runner's own PATH (launchd's, or one that already has the folder) must not count.
export function probe(shell = loginShell(), home = homedir(), timeoutMs = 8000): boolean | null {
  if (!existsSync(shell)) return null;
  const env: Record<string, string> = { HOME: home, USER: process.env.USER ?? "", LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "", SHELL: shell, TERM: "dumb", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  try { const p = Bun.spawnSync([shell, "-l", "-i", "-c", `printf '\\n__kb_path__%s\\n' "$(command -v ${"kitebook"} 2>/dev/null)"`], { env, cwd: home, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs });
    const m = p.stdout.toString().match(/__kb_path__(.*)/); if (!m) return null; return !!m[1].trim(); } catch { return null; }
}

// ---- the wrapper ----
const unq = (s: string) => s.replace(/\\(["\\$`])/g, "$1");
// the paths a Kitebook wrapper execs ('exec "<bun>" "<cli.ts>" "$@"'; the compiled binary's: 'exec "<kitebook>" "$@"')
export function targets(text: string): string[] { const m = text.match(/^exec ((?:"(?:[^"\\]|\\.)*"\s*)+)/m); if (!m) return [];
  return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => unq(x[1])).filter(x => x !== "$@"); }
export type WState = "missing" | "ok" | "stale" | "foreign";
export function wrapperState(f: string): WState {
  const t = read(f); if (t === null) { try { lstatSync(f); return "stale"; } catch { return "missing"; } } // a dangling link of ours is stale too
  if (!/^(# |rem )Kitebook CLI/m.test(t)) return "foreign";
  const ts = targets(t); return ts.length && ts.every(x => existsSync(x)) ? "ok" : "stale";
}
// bun as the PATH names it (a Homebrew link survives brew upgrade; process.execPath is the versioned Cellar file) when it is the same bun
export function bunPath(): string { const w = Bun.which("bun", { PATH: PL.joinPath([PL.envPath(), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".bun", "bin")]) });
  try { if (w && realpathSync(w) === realpathSync(process.execPath)) return w; } catch {} return process.execPath; }
// what the wrapper should say, for the code running now: an installed runner (~/.kitebook/versions/<v>) -> ~/.kitebook/current/cli.ts
// (it follows updates; the same text client/updater.ts refreshWrapper writes), a checkout -> <checkout>/client/cli.ts
export function wantWrapper(cfg: any, cfgPath: string, here = import.meta.path): string {
  const I = require("./integrity.ts"), conf = resolve(cfgPath);
  if (I.isInstalledPath(here)) { const url = String(cfg?.url ?? "").replace(/\/+$/, "");
    return `#!/bin/sh\n# Kitebook CLI, installed by ${url}/install.sh: kitebook status | restart | update | logs | stop | start | doctor, and every kitebook op\nexport KITEBOOK_RUNNER_CONFIG="\${KITEBOOK_RUNNER_CONFIG:-${conf}}"\nexec "${process.execPath}" "${I.home()}/current/cli.ts" "$@"\n`; }
  return PL.cliWrapper(bunPath(), join(dirname(here), "cli.ts"), conf, `the runner from ${tilde(resolve(dirname(here), ".."))}`, "linux").text;
}
const write = (f: string, text: string) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f + ".tmp", text, { mode: 0o755 }); renameSync(f + ".tmp", f); };
// a machine that ran Relay before the rename: its folders were moved and left as links (client/rebrand.ts), or its jobs still have the old name
const preRename = (home = homedir()) => [".relay-runner", ".relay-app", ".relay-server", ".relay", "Library/LaunchAgents/dev.relay.runner.plist", "Library/LaunchAgents/dev.relay.server.plist", "Library/Logs/relay-runner.log"].some(p => { try { lstatSync(join(home, p)); return true; } catch { return false; } });

export type CliResult = { skipped?: string; wrapper: WState | "written"; file: string; relay: "written" | null; on_path: boolean | null; rc: string[]; hint: string | null; fix: string | null };
// Windows: the user's PATH (HKCU\Environment), read and written through PowerShell; tests pass their own
export type WinPath = { get: () => string | null; set: (v: string) => boolean };
const ps = (cmd: string, env: Record<string, string> = {}) => { try { const p = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], { env: { ...process.env, ...env } as any, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 15_000, windowsHide: true } as any);
  return p.exitCode === 0 ? p.stdout.toString().trim() : null; } catch { return null; } };
export const winUserPath: WinPath = { get: () => ps("[Environment]::GetEnvironmentVariable('Path','User')"), set: v => ps("[Environment]::SetEnvironmentVariable('Path', $env:KB_NEWPATH, 'User')", { KB_NEWPATH: v }) !== null };
const winHas = (path: string | null, bin: string) => String(path ?? "").split(";").some(d => d.trim().replace(/[\\/]+$/, "").toLowerCase() === bin.replace(/[\\/]+$/, "").toLowerCase());
// the one plain line when a new shell still wouldn't find it: the exact fix for this shell
export function fixLine(shell: string, bin: string, home = homedir(), p = PL.plat()): string {
  if (p === "win32") return `kitebook isn't on your PATH yet. Fix, in PowerShell: [Environment]::SetEnvironmentVariable('Path', '${bin};' + [Environment]::GetEnvironmentVariable('Path','User'), 'User'), then open a new terminal window`;
  const b = bin.startsWith(home + "/") ? "$HOME" + bin.slice(home.length) : bin, f = rcFiles(shell, home)[0];
  if (!f) return `kitebook isn't on your PATH yet. Fix: ${basename(shell) === "fish" ? `fish_add_path ${tilde(bin, home)}` : `add ${tilde(bin, home)} to your shell's PATH`}, then open a new Terminal window`;
  return `kitebook isn't on your PATH yet. Fix: echo 'export PATH="${b}:$PATH"' >> ${tilde(f, home)}, then open a new Terminal window`;
}
// What the last check found (Settings -> Updates and doctor show a failure): { ok, fix, at }
export const lastVerify = (): { ok: boolean; fix: string | null; at: string } | null => state().verify ?? null;
const recordVerify = (ok: boolean | null, fix: string | null, found?: string) => { if (ok === null) return; const st = state(); saveState({ ...st, ...(found ? { found } : { found: undefined }), verify: { ok, fix, at: new Date().toISOString() } }); };

// o.verify: an install or update path: ask a fresh login shell even when an rc file looks right, repair the block once, ask again.
// Without it (every runner start) a PATH line already in an rc file (or a shell that found it before) is enough, so no shell is spawned.
export function ensureCli(cfg: any, cfgPath: string, log: Log = () => {}, o: { probe?: typeof probe; dryRun?: boolean; verify?: boolean; win?: WinPath } = {}): CliResult {
  const compiled = import.meta.path.startsWith("/$bunfs") || !/bun/i.test(basename(process.execPath));
  const bin = compiled ? dirname(process.execPath) : binDir(), home = homedir(), f = join(bin, PL.plat() === "win32" ? "kitebook.cmd" : "kitebook");
  const none: CliResult = { wrapper: "missing", file: f, relay: null, on_path: null, rc: [], hint: null, fix: null };
  if (process.env.KITEBOOK_TASK_ID) return { ...none, skipped: "task" };
  if (process.env.KITEBOOK_CLI_PATH === "off") return { ...none, skipped: "off" };
  if (PL.plat() === "win32") return winVerify(bin, compiled ? join(bin, "kitebook.exe") : f, log, o);
  const r: CliResult = { ...none, wrapper: compiled ? "ok" : wrapperState(f) };
  if (!compiled) {
    try { require("./rebrand.ts").migrateCommands(log, [bin]); } catch {} // a relay wrapper from before the rename: kitebook from now on
    r.wrapper = wrapperState(f);
    if (r.wrapper === "foreign") { log(`kitebook command: left ${tilde(f)} alone (it isn't Kitebook's); Kitebook's commands: bun ${join(dirname(import.meta.path), "cli.ts")} status`); return r; }
    if (r.wrapper !== "ok" && !o.dryRun) { try { write(f, wantWrapper(cfg, cfgPath)); r.wrapper = "written"; } catch (e: any) { log(`kitebook command: couldn't write ${tilde(f)} (${e.message})`); return r; } }
    if (!o.dryRun && preRename(home)) { const rf = join(bin, "relay");
      if (!existsSync(rf)) try { write(rf, require("./rebrand.ts").shimText(f, "linux").text); r.relay = "written"; } catch {} }
  }
  // on PATH in a new Terminal window?
  const shell = loginShell(), files = rcFiles(shell, home), P = o.probe ?? probe, staticOk = rcHasPath(bin, home).length > 0;
  if (o.dryRun) { r.on_path = staticOk || state().found === bin ? true : P(shell, home); return r; }
  if (!o.verify && r.wrapper === "ok" && (staticOk || state().found === bin)) { r.on_path = true; return r; }
  let found = P(shell, home);
  if (found !== true && files.length) { // repair once: the block into the files this shell reads that don't have it yet, then ask again
    try { r.rc = addBlock(files, bin, home); } catch (e: any) { log(`kitebook command: couldn't add ${tilde(bin)} to PATH in ${files.map(x => tilde(x)).join(", ")} (${e.message})`); }
    if (r.rc.length) found = P(shell, home); } // (null: couldn't ask the shell; the rc line is the best we know, no warning)
  r.on_path = found;
  const did = [r.wrapper === "written" ? `put the command at ${tilde(f)}${r.relay ? " (and the old relay name, which forwards to it)" : ""}` : "", r.rc.length ? `added ${tilde(bin)} to your PATH in ${r.rc.map(x => tilde(x)).join(" and ")}` : ""].filter(Boolean);
  if (did.length && found !== false) log(`kitebook command: ${did.join("; ")}. Open a new Terminal window, then type: kitebook status`);
  if (found === false) { r.fix = fixLine(shell, bin, home); if (!files.length) r.hint = r.fix; log(r.fix); }
  recordVerify(found, r.fix, found ? bin : undefined);
  return r;
}
// Windows: the installer (get.ps1) adds the folder to the user's PATH; check it is there, add it once if not, check again
function winVerify(bin: string, f: string, log: Log, o: { win?: WinPath; dryRun?: boolean }): CliResult {
  const r: CliResult = { wrapper: existsSync(f) ? "ok" : "missing", file: f, relay: null, on_path: null, rc: [], hint: null, fix: null };
  if (r.wrapper === "missing") return { ...r, skipped: "no kitebook command here (get.ps1 installs it)" };
  const W = o.win ?? winUserPath; let cur = W.get(); if (cur === null) return r;
  let has = winHas(cur, bin);
  if (!has && !o.dryRun) { if (W.set([bin, cur].filter(Boolean).join(";"))) { cur = W.get(); has = winHas(cur, bin); r.rc = has ? ["user PATH"] : []; } }
  r.on_path = has;
  if (r.rc.length) log(`kitebook command: added ${bin} to your user PATH. Open a new terminal window, then type: kitebook status`);
  if (!has) { r.fix = fixLine("", bin, homedir(), "win32"); log(r.fix); }
  if (!o.dryRun) recordVerify(has, r.fix);
  return r;
}
const stateFile = () => join(homedir(), ".kitebook", "cli-path.json");
const state = (): any => { try { return JSON.parse(readFileSync(stateFile(), "utf8")); } catch { return {}; } };
const saveState = (s: any) => { try { mkdirSync(dirname(stateFile()), { recursive: true, mode: 0o700 }); writeFileSync(stateFile(), JSON.stringify(s), { mode: 0o600 }); } catch {} };

// doctor (client/setup.ts): "kitebook command on PATH", with the one fix. Doctor runs in the owner's Terminal, so this window's PATH counts.
export function doctorCheck(cfgPath: string): { ok: boolean; line: string; fix: string | null } | null {
  const lv = lastVerify(), failed = lv && !lv.ok && lv.fix ? lv.fix.replace(/^.*?Fix(, in PowerShell)?: /, "") : null;
  if (PL.plat() === "win32" || import.meta.path.startsWith("/$bunfs")) { if (Bun.which("kitebook", { PATH: PL.envPath() })) return { ok: true, line: "kitebook command on PATH", fix: null };
    return failed ? { ok: false, line: "kitebook command on PATH: no (the last install or update couldn't add it)", fix: failed } : null; }
  const bin = binDir(), f = join(bin, "kitebook"), ws = wrapperState(f), found = Bun.which("kitebook", { PATH: PL.envPath() });
  const fix = `bun ${join(dirname(import.meta.path), "cli-path.ts")} install ${resolve(cfgPath)}   (then open a new Terminal window)`;
  if (ws === "foreign") return found ? { ok: true, line: `kitebook command on PATH (${tilde(found)}, not Kitebook's)`, fix: null } : { ok: false, line: `kitebook command on PATH: no (${tilde(f)} isn't Kitebook's)`, fix: `rename or remove it, then: ${fix}` };
  if (ws !== "ok") return { ok: false, line: `kitebook command on PATH: no (${ws === "stale" ? `${tilde(f)} points at files that are gone` : "it isn't installed"})`, fix };
  if (found) return { ok: true, line: "kitebook command on PATH", fix: null };
  if (failed) return { ok: false, line: `kitebook command on PATH: no (a new login shell doesn't find it)`, fix: failed };
  const rc = rcHasPath(bin);
  if (rc.length) return { ok: false, line: `kitebook command on PATH: not in this window yet (installed at ${tilde(f)})`, fix: `open a new Terminal window (${rc.map(x => tilde(x)).join(" and ")} put ${tilde(bin)} on PATH)` };
  return { ok: false, line: `kitebook command on PATH: no (${tilde(bin)} isn't on your PATH)`, fix };
}

// install: doctor's fix (the owner asked: runs even with KITEBOOK_CLI_PATH=off); verify: the end of an install or update (scripts/get.sh,
// install.sh, get.ps1); check: only look. JSON on stdout; the one plain line (still not on PATH: the exact fix) on stderr.
if (import.meta.main) {
  const [cmd = "check", cfgArg] = process.argv.slice(2), cfgPath = resolve(cfgArg ?? process.env.KITEBOOK_RUNNER_CONFIG ?? join(homedir(), ".kitebook", "runner.json"));
  if (!["install", "verify", "check"].includes(cmd)) { console.error("usage: bun client/cli-path.ts install|verify|check [runner.json]"); process.exit(2); }
  let cfg: any = {}; try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch {}
  if (cmd === "install") delete process.env.KITEBOOK_CLI_PATH;
  const r = ensureCli(cfg, cfgPath, (...a) => console.error(a.join(" ")), { dryRun: cmd === "check", verify: cmd !== "check" });
  console.log(JSON.stringify(r)); process.exit(r.skipped && cmd === "install" || r.wrapper === "foreign" || r.on_path === false ? 1 : 0);
}
