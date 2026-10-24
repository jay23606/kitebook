// Each OS's behaviour from client/platform.ts, checked on any machine with the platform passed in (the CI matrix runs these on ubuntu,
// macos and windows too, where the "real" cases below also run against the OS itself).
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as P from "./platform.ts";

const which = (map: Record<string, string>) => (b: string) => map[b] ?? null;

test("PATH lists: ; on Windows, : elsewhere; agent folders are added after the runner's own PATH", () => {
  expect(P.splitPath("C:\\a;C:\\b;", "win32")).toEqual(["C:\\a", "C:\\b"]);
  expect(P.splitPath("/a:/b", "linux")).toEqual(["/a", "/b"]);
  expect(P.joinPath(["/a", null, "/b", "/a"], "darwin")).toBe("/a:/b");
  const w = P.withAgentDirs("C:\\Windows", "win32", { APPDATA: "C:\\U\\AppData\\Roaming", LOCALAPPDATA: "C:\\U\\AppData\\Local" } as any, "C:\\U");
  expect(w.split(";")[0]).toBe("C:\\Windows"); expect(w).toContain(join("C:\\U\\AppData\\Roaming", "npm"));
  expect(P.agentDirs("darwin", {}, "/Users/x")).toContain("/opt/homebrew/bin");
  expect(P.agentDirs("linux", {}, "/home/x")).toContain(join("/home/x", ".local", "bin"));
});

test("starting an agent on Windows: npm .cmd shims run as node <script>, .ps1 via powershell, other .cmd through cmd.exe escaped", () => {
  const d = mkdtempSync(join(tmpdir(), "kitebook-plat-")), shim = join(d, "codex.cmd"), ps1 = join(d, "pi.ps1"), bat = join(d, "mine.bat");
  writeFileSync(shim, '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  writeFileSync(bat, "@echo off\r\nmine-real %*\r\n");
  const wh = which({ codex: shim, pi: ps1, mine: bat, node: "C:\\node\\node.exe", git: "C:\\Git\\cmd\\git.exe" });
  const prompt = 'fix "it" & echo pwned %PATH% | more';
  const a = P.resolveArgv(["codex", "exec", prompt], {}, "win32", wh);
  expect(a.verbatim).toBe(false); expect(a.argv[0]).toBe("C:\\node\\node.exe");
  expect(a.argv[1]).toBe(join(d, "node_modules/@openai/codex/bin/codex.js")); expect(a.argv.slice(2)).toEqual(["exec", prompt]); // the prompt stays one argument, untouched
  expect(P.resolveArgv(["pi", "-p", "x"], {}, "win32", wh).argv.slice(0, 1)).toEqual(["powershell.exe"]);
  expect(P.resolveArgv(["git", "status"], {}, "win32", wh).argv).toEqual(["C:\\Git\\cmd\\git.exe", "status"]);
  const c = P.resolveArgv(["mine", prompt], {}, "win32", wh);
  expect(c.verbatim).toBe(true); expect(c.argv.slice(0, 4)).toEqual(["cmd.exe", "/d", "/s", "/c"]);
  for (const ch of ["&", "|", "%", '"']) expect(c.argv[4].slice(1, -1).replace(/\^./g, "")).not.toContain(ch); // every metacharacter is ^-escaped
  expect(P.resolveArgv(["codex", "exec", prompt], {}, "linux", wh).argv).toEqual(["codex", "exec", prompt]); // macOS/Linux: as given
});

test("verify commands: sh -c on macOS/Linux; Git's sh on Windows when there is one, else cmd.exe", () => {
  expect(P.shellArgv("npm test", "linux")).toEqual(["sh", "-c", "npm test"]);
  expect(P.shellArgv("npm test", "win32", which({ sh: "C:\\Git\\usr\\bin\\sh.exe" }))).toEqual(["C:\\Git\\usr\\bin\\sh.exe", "-c", "npm test"]);
  expect(P.shellArgv("npm test", "win32", which({}), { ProgramFiles: join(tmpdir(), "no-such-pf") } as any)).toEqual(["cmd.exe", "/d", "/s", "/c", "npm test"]);
});

test("opening the browser: open / xdg-open (only with a display) / the Windows URL handler (no cmd.exe re-parsing the link)", () => {
  const u = "http://127.0.0.1:7820/start#login=abc&x=1";
  expect(P.opener(u, "darwin")).toEqual(["open", u]);
  expect(P.opener(u, "linux", { DISPLAY: ":0" } as any)).toEqual(["xdg-open", u]);
  expect(P.opener(u, "linux", {} as any)).toBeNull();
  expect(P.opener(u, "win32")).toEqual(["rundll32.exe", "url.dll,FileProtocolHandler", u]);
});

test("approval dialog per OS: osascript, zenity, notify-send with buttons, a PowerShell message box; none on a headless Linux box", () => {
  expect(P.dialogKind("darwin", {} as any, which({ osascript: "/usr/bin/osascript" }))).toBe("osascript");
  expect(P.dialogKind("win32", {} as any, which({}))).toBe("powershell");
  expect(P.dialogKind("linux", {} as any, which({ zenity: "/usr/bin/zenity" }))).toBeNull(); // no display
  expect(P.dialogKind("linux", { DISPLAY: ":0" } as any, which({ zenity: "/usr/bin/zenity" }))).toBe("zenity");
  expect(P.dialogKind("linux", { WAYLAND_DISPLAY: "w" } as any, which({ "notify-send": "/usr/bin/notify-send" }), "  -A, --action=[NAME=]Text")).toBe("notify-send");
  expect(P.dialogKind("linux", { DISPLAY: ":0" } as any, which({ "notify-send": "/usr/bin/notify-send" }), "old libnotify")).toBeNull(); // can't answer: review page
  const t = 'Run "rm" task?\n$HOME `x`';
  const z = P.dialog("zenity", t, "Kitebook task", 30); expect(z.argv).toContain("--no-markup"); expect(z.argv[z.argv.indexOf("--text") + 1]).toBe(t);
  expect([z.answer("", 0), z.answer("", 1), z.answer("", 5)]).toEqual(["approve", "reject", null]);
  const n = P.dialog("notify-send", t, "Kitebook task", 30); expect(n.argv.slice(-2)).toEqual(["Kitebook task", t]);
  expect([n.answer("approve\n", 0), n.answer("reject", 0), n.answer("", 0)]).toEqual(["approve", "reject", null]);
  const w = P.dialog("powershell", t, "Kitebook task", 30); expect(w.argv.join(" ")).not.toContain(t); expect(w.env!.KITEBOOK_DIALOG_TEXT).toContain(t); // text only through the environment
  expect([w.answer("6\r\n", 0), w.answer("7", 0), w.answer("-1", 0)]).toEqual(["approve", "reject", null]);
  const o = P.dialog("osascript", t, "Kitebook task", 30); expect(o.argv[2]).toContain('Run \\"rm\\" task?');
  expect([o.answer("button returned:Approve", 0), o.answer("button returned:Reject", 0), o.answer("gave up:true", 0)]).toEqual(["approve", "reject", null]);
});

test("secret store per OS: Keychain, libsecret, Windows Credential Manager, else a 0600 file; the secret never in a Windows/Linux argv", () => {
  expect(P.secretStore("darwin", {} as any, which({ security: "/usr/bin/security" }))).toBe("keychain");
  expect(P.secretStore("linux", { DBUS_SESSION_BUS_ADDRESS: "x" } as any, which({ "secret-tool": "/usr/bin/secret-tool" }))).toBe("libsecret");
  expect(P.secretStore("linux", {} as any, which({ "secret-tool": "/usr/bin/secret-tool" }))).toBe("file"); // no session bus (a service, SSH)
  expect(P.secretStore("win32", {} as any, which({ "powershell.exe": "C:\\ps.exe" }))).toBe("wincred");
  expect(P.secretStore("win32", { KITEBOOK_KEYCHAIN: "file" } as any, which({ "powershell.exe": "C:\\ps.exe" }))).toBe("file");
  const set = P.secretArgv("wincred", "set", "dev.kitebook.release-key", "kitebook")!;
  expect(set[0]).toBe("powershell.exe"); expect(set.join(" ")).toContain("[Console]::In.ReadToEnd()"); expect(set.join(" ")).toContain("PasswordVault");
  expect(P.secretArgv("libsecret", "set", "s", "a")).toEqual(["secret-tool", "store", "--label=Kitebook", "service", "s", "account", "a"]);
  expect(P.secretArgv("file", "get", "s", "a")).toBeNull();
});

test("folders and the kitebook command per OS", () => {
  expect(P.logDir("darwin", {} as any, "/Users/x")).toBe(join("/Users/x", "Library", "Logs"));
  expect(P.logDir("linux", {} as any, "/home/x")).toBe(join("/home/x", ".local", "state", "kitebook"));
  expect(P.logDir("win32", { LOCALAPPDATA: "C:\\U\\L" } as any, "C:\\U")).toBe(join("C:\\U\\L", "Kitebook", "logs"));
  expect(P.binDir("win32", { LOCALAPPDATA: "C:\\U\\L" } as any)).toBe(join("C:\\U\\L", "Kitebook", "bin"));
  const w = P.cliWrapper("C:\\bun\\bun.exe", "C:\\app\\client\\cli.ts", "C:\\U\\.kitebook\\runner.json", "get.ps1", "win32");
  expect(w.file).toBe("kitebook.cmd"); expect(w.text).toContain('"C:\\bun\\bun.exe" "C:\\app\\client\\cli.ts" %*'); expect(w.text).toContain("\r\n");
  const s = P.cliWrapper("/b/bun", "/a/client/cli.ts", "/h/.kitebook/runner.json", "get.sh", "linux");
  expect(s.file).toBe("kitebook"); expect(s.text.startsWith("#!/bin/sh\n# Kitebook CLI")).toBe(true); expect(s.text).toContain('exec "/b/bun" "/a/client/cli.ts" "$@"');
});

test("this machine (real, per CI OS): plat() matches process.platform and the PATH separator is the OS's own", () => {
  expect(P.plat()).toBe(process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");
  expect(P.pathSep()).toBe(P.delimiter);
  if (process.platform === "win32") expect(P.dialogKind()).toBe("powershell");
});
