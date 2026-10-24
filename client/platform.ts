// One place for what differs between macOS, Linux and Windows, so the runner, the `kitebook` command and the installers behave the same on
// each: which OS this is, PATH lists, starting a program (Windows .cmd shims), the shell for verify commands, killing a process tree,
// opening the browser, the approval dialog, the OS secret store, and where agent CLIs usually install themselves.
// Every helper takes the platform (and a `which`) as optional arguments, so client/platform.test.ts checks each OS's behaviour on any
// machine; the CI matrix (ubuntu, macos, windows) then runs the same tests and scripts/selftest.ts for real on each OS.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, existsSync } from "fs";
import { join, dirname, extname, delimiter } from "path";
import { homedir } from "os";

export type Plat = "darwin" | "linux" | "win32";
// KITEBOOK_PLATFORM (tests only, with KITEBOOK_TEST) makes this Linux box act as another OS for the parts that only pick text or files
export const plat = (): Plat => { const f = process.env.KITEBOOK_TEST ? process.env.KITEBOOK_PLATFORM : ""; if (f === "darwin" || f === "linux" || f === "win32") return f;
  return process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"; };
export const osName = (p: Plat = plat()) => p === "darwin" ? "macOS" : p === "win32" ? "Windows" : "Linux";
export const machine = (p: Plat = plat()) => p === "darwin" ? "Mac" : "computer"; // "Connect your Mac" reads oddly on a PC
type Which = (bin: string, o?: { PATH?: string }) => string | null;
const W: Which = (b, o) => Bun.which(b, o as any);
export const pathSep = (p: Plat = plat()) => p === "win32" ? ";" : ":";
export const splitPath = (s: string | undefined, p: Plat = plat()) => String(s ?? "").split(pathSep(p)).filter(Boolean);
export const joinPath = (dirs: (string | undefined | null)[], p: Plat = plat()) => [...new Set(dirs.filter(Boolean) as string[])].join(pathSep(p));
// Windows keeps PATH as "Path" in some environments; read whichever is there
export const envPath = (env: Record<string, string | undefined> = process.env) => env.PATH ?? env.Path ?? "";

// Where agent CLIs install themselves when the shell that installed them isn't the one the runner sees (launchd, systemd, a logon task):
// npm's global bin, bun's, ~/.local/bin (claude, cursor-agent, pi), ~/.grok/bin, Homebrew. Added after the PATH the runner already has.
export function agentDirs(p: Plat = plat(), env: Record<string, string | undefined> = process.env, home = homedir()): string[] {
  if (p === "win32") { const ad = env.APPDATA ?? join(home, "AppData", "Roaming"), la = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [join(ad, "npm"), join(home, ".bun", "bin"), join(home, ".local", "bin"), join(la, "Programs", "cursor-agent"), join(home, ".grok", "bin"), join(la, "Microsoft", "WinGet", "Links")]; }
  return [join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, ".npm-global", "bin"), join(home, ".grok", "bin"), join(home, ".opencode", "bin"),
    ...(p === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : ["/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"])];
}
export const withAgentDirs = (path: string, p: Plat = plat(), env = process.env, home = homedir()) => joinPath([...splitPath(path, p), ...agentDirs(p, env, home)], p);

// ---- starting programs ----
// Windows can't start an npm .cmd shim (codex.cmd, claude.cmd, gemini.cmd...) directly, and running it through cmd.exe re-parses the
// prompt (& | % ^ "...). So an npm shim runs as `node <its script>` (the shim's own target, read from the file), a .ps1 through
// powershell -File, and only any other .cmd/.bat goes through cmd.exe with every argument escaped the way cross-spawn does (twice:
// once for cmd's parser, once for the batch file's %* expansion). macOS / Linux: unchanged.
const META = /([()\][%!^"`<>&|;, *?])/g;
export function cmdEscape(arg: string, twice = true): string {
  let a = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1"); a = `"${a}"`.replace(META, "^$1");
  return twice ? a.replace(META, "^$1") : a;
}
export type Spawnable = { argv: string[]; verbatim: boolean };
export function resolveArgv(argv: string[], env: Record<string, string | undefined> = process.env, p: Plat = plat(), which: Which = W, read = (f: string) => readFileSync(f, "utf8")): Spawnable {
  if (p !== "win32" || !argv.length) return { argv, verbatim: false };
  const exe = which(argv[0], { PATH: envPath(env) }) ?? argv[0], ext = extname(exe).toLowerCase(), rest = argv.slice(1);
  if (ext === ".ps1") return { argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", exe, ...rest], verbatim: false };
  if (ext !== ".cmd" && ext !== ".bat") return { argv: [exe, ...rest], verbatim: false };
  let body = ""; try { body = read(exe); } catch {}
  const m = body.match(/"%(?:~?dp0)%\\?([^"%]+?\.(?:c?js|mjs))"/i); // npm cmd-shim: "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
  if (m) { const dir = dirname(exe), local = join(dir, "node.exe"), script = join(dir, m[1].replace(/\\/g, "/"));
    const node = /node\.exe/i.test(body) && existsSync(local) ? local : which("node", { PATH: envPath(env) }) ?? "node";
    return { argv: [node, script, ...rest], verbatim: false }; }
  return { argv: ["cmd.exe", "/d", "/s", "/c", `"${[cmdEscape(exe, false), ...rest.map(a => cmdEscape(a))].join(" ")}"`], verbatim: true };
}
// Bun.spawn with the argv resolved for this OS (and no console window flashing up on Windows)
export function spawn(argv: string[], o: any = {}) {
  const r = resolveArgv(argv, o.env ?? process.env); return Bun.spawn(r.argv, { ...o, windowsHide: true, ...(r.verbatim ? { windowsVerbatimArguments: true } : {}) });
}
export function spawnSync(argv: string[], o: any = {}) {
  const r = resolveArgv(argv, o.env ?? process.env); return Bun.spawnSync(r.argv, { ...o, windowsHide: true, ...(r.verbatim ? { windowsVerbatimArguments: true } : {}) });
}
// A project's verify / acceptance command line (written by the owner): sh -c on macOS/Linux; on Windows Git's sh when there is one (Git
// for Windows ships it, and most verify lines are POSIX), else cmd.exe.
export function shellArgv(cmd: string, p: Plat = plat(), which: Which = W, env = process.env): string[] {
  if (p !== "win32") return ["sh", "-c", cmd];
  const pf = env.ProgramFiles ?? "C:\\Program Files", git = [join(pf, "Git", "bin", "sh.exe"), join(pf, "Git", "usr", "bin", "sh.exe")].find(f => existsSync(f));
  const sh = which("sh", { PATH: envPath(env) }) ?? git; return sh ? [sh, "-c", cmd] : ["cmd.exe", "/d", "/s", "/c", cmd];
}
// Kill a process and everything it started: taskkill /T on Windows (no process groups there), else the caller's signal walk.
export function killTreeWin(pid: number) { try { Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true } as any); } catch {} }

// ---- the browser ----
// open on macOS, xdg-open on a Linux desktop (null with no display: the caller prints the link), the URL handler on Windows (no cmd.exe:
// `start` would re-parse the &s and #s in a sign-in link)
export function opener(url: string, p: Plat = plat(), env = process.env): string[] | null {
  if (p === "darwin") return ["open", url];
  if (p === "win32") return ["rundll32.exe", "url.dll,FileProtocolHandler", url];
  return env.DISPLAY || env.WAYLAND_DISPLAY ? ["xdg-open", url] : null;
}

// ---- the approval dialog ----
// macOS: osascript's dialog. Linux desktop: zenity (Approve / Reject buttons), else notify-send with action buttons (libnotify 0.7.12+).
// Windows: a PowerShell message box (Yes = Approve, No = Reject; on top, times out like the others). No desktop (a headless Linux box, an
// SSH session): null, and the runner asks on the server's review page instead (/start Status, or kitebook approve).
export type DialogKind = "osascript" | "zenity" | "notify-send" | "powershell";
let nsActions: boolean | null = null;
export function dialogKind(p: Plat = plat(), env = process.env, which: Which = W, notifyHelp?: string): DialogKind | null {
  if (p === "darwin") return which("osascript") || existsSync("/usr/bin/osascript") ? "osascript" : null;
  if (p === "win32") return "powershell";
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  if (which("zenity")) return "zenity";
  if (which("notify-send")) { if (notifyHelp !== undefined) return /--action/.test(notifyHelp) ? "notify-send" : null;
    if (nsActions === null) { try { nsActions = /--action/.test(Bun.spawnSync(["notify-send", "--help"], { stdout: "pipe", stderr: "pipe" }).stdout.toString()); } catch { nsActions = false; } }
    return nsActions ? "notify-send" : null; }
  return null;
}
export type Dialog = { argv: string[]; env?: Record<string, string>; answer(out: string, code: number | null): "approve" | "reject" | null };
export function dialog(kind: DialogKind, text: string, title: string, secs: number): Dialog {
  if (kind === "osascript") { const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return { argv: ["osascript", "-e", `display dialog "${esc(text)}" with title "${esc(title)}" buttons {"Reject", "Approve"} default button "Reject" giving up after ${secs}`],
      answer: (o, c) => o.includes("gave up:true") ? null : c === 0 && o.includes("button returned:Approve") ? "approve" : "reject" }; }
  if (kind === "zenity") return { argv: ["zenity", "--question", "--no-markup", "--title", title, "--text", text, "--ok-label", "Approve", "--cancel-label", "Reject", "--default-cancel", "--timeout", String(secs)],
    answer: (_o, c) => c === 0 ? "approve" : c === 5 || c === null ? null : "reject" }; // 5: timed out
  if (kind === "notify-send") return { argv: ["notify-send", "--app-name=Kitebook", "--urgency=critical", "--wait", "--expire-time", String(secs * 1000), "--action=approve=Approve", "--action=reject=Reject", title, text],
    answer: o => { const w = o.trim().split("\n").pop(); return w === "approve" ? "approve" : w === "reject" ? "reject" : null; } }; // dismissed / expired: no answer
  // Windows: the text goes in through the environment, never the command line (no quoting to get wrong); 4 = Yes/No, 0x20 = question,
  // 0x100 = No is the default, 0x1000 = on top of other windows. Popup returns 6 (Yes), 7 (No) or -1 (timed out).
  return { argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "(New-Object -ComObject WScript.Shell).Popup($env:KITEBOOK_DIALOG_TEXT, [int]$env:KITEBOOK_DIALOG_SECS, $env:KITEBOOK_DIALOG_TITLE, 0x1124)"],
    env: { KITEBOOK_DIALOG_TEXT: `${text}\n\nYes = Approve, No = Reject`, KITEBOOK_DIALOG_TITLE: title, KITEBOOK_DIALOG_SECS: String(secs) },
    answer: o => { const n = o.trim(); return n === "6" ? "approve" : n === "7" ? "reject" : null; } };
}

// ---- the OS secret store ----
// macOS Keychain (security), the Linux login keyring (secret-tool, libsecret), the Windows Credential Manager (PasswordVault through
// Windows PowerShell 5.1, which every Windows 10/11 has), else none and the caller keeps a 0600 file. The secret goes in on stdin, never argv.
export type Store = "keychain" | "libsecret" | "wincred" | "file";
export function secretStore(p: Plat = plat(), env = process.env, which: Which = W): Store {
  if (env.KITEBOOK_KEYCHAIN === "file") return "file";
  if (p === "darwin" && which("security")) return "keychain";
  if (p === "linux" && which("secret-tool") && (env.DBUS_SESSION_BUS_ADDRESS || env.XDG_RUNTIME_DIR)) return "libsecret";
  if (p === "win32" && which("powershell.exe")) return "wincred";
  return "file";
}
export const storeName = (s: Store) => s === "keychain" ? "your macOS Keychain" : s === "libsecret" ? "your login keyring" : s === "wincred" ? "Windows Credential Manager" : "a file only you can read";
const VAULT = "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v = New-Object Windows.Security.Credentials.PasswordVault; ";
// argv + stdin for each operation (exported for the tests; secretSet/Get/Del run them)
export function secretArgv(s: Store, op: "set" | "get" | "del", svc: string, acc: string, label = "Kitebook"): string[] | null {
  const ps = (cmd: string) => ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; $svc=$env:KITEBOOK_SECRET_SVC; $acc=$env:KITEBOOK_SECRET_ACC; ${VAULT}${cmd}`];
  if (s === "keychain") return op === "set" ? ["security", "add-generic-password", "-U", "-s", svc, "-a", acc, "-w"] : op === "get" ? ["security", "find-generic-password", "-s", svc, "-a", acc, "-w"] : ["security", "delete-generic-password", "-s", svc, "-a", acc];
  if (s === "libsecret") return op === "set" ? ["secret-tool", "store", `--label=${label}`, "service", svc, "account", acc] : op === "get" ? ["secret-tool", "lookup", "service", svc, "account", acc] : ["secret-tool", "clear", "service", svc, "account", acc];
  if (s === "wincred") return op === "set" ? ps("try { $v.Remove($v.Retrieve($svc, $acc)) } catch {}; $v.Add((New-Object Windows.Security.Credentials.PasswordCredential($svc, $acc, [Console]::In.ReadToEnd())))")
    : op === "get" ? ps("$c = $v.Retrieve($svc, $acc); $c.RetrievePassword(); [Console]::Out.Write($c.Password)") : ps("try { $v.Remove($v.Retrieve($svc, $acc)) } catch {}");
  return null;
}
const runSecret = (s: Store, op: "set" | "get" | "del", svc: string, acc: string, stdin?: string, label?: string) => {
  let argv = secretArgv(s, op, svc, acc, label); if (!argv) return { ok: false, out: "" };
  // `security add-generic-password -w` with no value prompts on the terminal; it reads the value as the last argument instead (Keychain has no stdin mode)
  if (s === "keychain" && op === "set") argv = [...argv, stdin ?? ""];
  try { const p = Bun.spawnSync(argv, { stdin: stdin !== undefined && s !== "keychain" ? Buffer.from(stdin) : "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, KITEBOOK_SECRET_SVC: svc, KITEBOOK_SECRET_ACC: acc }, windowsHide: true } as any);
    return { ok: p.exitCode === 0, out: p.stdout.toString().replace(/\r?\n$/, "") }; } catch { return { ok: false, out: "" }; }
};
export const secretSet = (s: Store, svc: string, acc: string, value: string, label?: string) => runSecret(s, "set", svc, acc, value, label).ok;
export const secretGet = (s: Store, svc: string, acc: string) => { const r = runSecret(s, "get", svc, acc); return r.ok && r.out ? r.out : null; };
export const secretDel = (s: Store, svc: string, acc: string) => runSecret(s, "del", svc, acc).ok;

// ---- logs and per-user folders ----
// macOS: ~/Library/Logs; Linux: $XDG_STATE_HOME/kitebook (~/.local/state/kitebook); Windows: %LOCALAPPDATA%\Kitebook\logs
export function logDir(p: Plat = plat(), env = process.env, home = homedir()) {
  return p === "darwin" ? join(home, "Library", "Logs") : p === "win32" ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Kitebook", "logs") : join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "kitebook");
}
// where the `kitebook` command goes: ~/.local/bin (macOS, Linux), %LOCALAPPDATA%\Kitebook\bin (Windows; the installer adds it to the user's PATH)
export function binDir(p: Plat = plat(), env = process.env, home = homedir()) {
  return p === "win32" ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Kitebook", "bin") : join(home, ".local", "bin");
}
// The `kitebook` command's launcher text: a sh script, or a .cmd on Windows (%* passes the arguments through as typed)
export function cliWrapper(bun: string, cli: string, cfg: string, by: string, p: Plat = plat()): { file: string; text: string } {
  if (p === "win32") return { file: "kitebook.cmd", text: `@echo off\r\nrem Kitebook CLI, installed by ${by}: kitebook help\r\nif not defined KITEBOOK_RUNNER_CONFIG set "KITEBOOK_RUNNER_CONFIG=${cfg}"\r\n"${bun}" "${cli}" %*\r\n` };
  const q = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
  return { file: "kitebook", text: `#!/bin/sh\n# Kitebook CLI, installed by ${by}: kitebook help\nexport KITEBOOK_RUNNER_CONFIG="\${KITEBOOK_RUNNER_CONFIG:-${cfg.replace(/(["\\$`])/g, "\\$1")}}"\nexec ${q(bun)} ${q(cli)} "$@"\n` };
}
export { delimiter };
