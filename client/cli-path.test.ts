// The kitebook command on PATH for a git install updated by git pull (client/cli-path.ts): which rc files per shell, the marked block
// (added once, recognised next to get.sh's line, removed by uninstall), the wrapper (missing / stale -> written, foreign kept), and
// ensureCli end to end in a throwaway HOME with the login-shell probe stubbed.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, symlinkSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as C from "./cli-path.ts";

const win = process.platform === "win32";
let H = "", saved: Record<string, string | undefined> = {};
const KEYS = ["HOME", "KITEBOOK_BIN_DIR", "KITEBOOK_CLI_PATH", "KITEBOOK_TASK_ID", "KITEBOOK_LOGIN_SHELL", "SHELL"];
beforeEach(() => { H = mkdtempSync(join(tmpdir(), "kb-clipath-")); for (const k of KEYS) saved[k] = process.env[k];
  process.env.HOME = H; delete process.env.KITEBOOK_BIN_DIR; delete process.env.KITEBOOK_CLI_PATH; delete process.env.KITEBOOK_TASK_ID; process.env.KITEBOOK_LOGIN_SHELL = "/bin/zsh"; });
afterEach(() => { for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; rmSync(H, { recursive: true, force: true }); });

test("rc files: zsh -> .zprofile + .zshrc; bash -> .bashrc + .profile (or .bash_profile when it exists); fish none; sh .profile", () => {
  expect(C.rcFiles("/bin/zsh", "/h")).toEqual(["/h/.zprofile", "/h/.zshrc"]);
  expect(C.rcFiles("/usr/local/bin/bash", H)).toEqual([join(H, ".bashrc"), join(H, ".profile")]);
  writeFileSync(join(H, ".bash_profile"), ""); expect(C.rcFiles("/bin/bash", H)).toEqual([join(H, ".bashrc"), join(H, ".bash_profile")]);
  expect(C.rcFiles("/opt/homebrew/bin/fish", H)).toEqual([]); expect(C.rcFiles("/bin/dash", H)).toEqual([join(H, ".profile")]);
  expect(C.loginShell({ SHELL: "/bin/zsh" }, "linux")).toBe("/bin/zsh"); expect(C.loginShell({ SHELL: "/usr/bin/nologin" }, "darwin")).toBe("/bin/zsh");
});

test("the block: $HOME form, added once per file, get.sh's line and the owner's own count, comments don't, uninstall takes it out", () => {
  const bin = join(H, ".local", "bin"), b = C.block(bin, H);
  expect(b).toContain(`*":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH"`); expect(b.startsWith(C.START)).toBe(true);
  const zp = join(H, ".zprofile"), zr = join(H, ".zshrc"); writeFileSync(zp, "export FOO=1"); // no trailing newline
  expect(C.addBlock([zp, zr], bin, H)).toEqual([zp, zr]); expect(C.addBlock([zp, zr], bin, H)).toEqual([]); // idempotent
  expect(readFileSync(zp, "utf8")).toBe(`export FOO=1\n\n${b}`); expect(readFileSync(zr, "utf8")).toBe(b);
  expect(C.hasPathLine(`export PATH="${bin}:$PATH" # added by Kitebook\n`, bin, H)).toBe(true);
  expect(C.hasPathLine(`path+=(~/.local/bin)\nexport PATH\n`, bin, H)).toBe(false); // PATH and the folder on different lines: not ours to judge, probe decides
  expect(C.hasPathLine(`export PATH="$HOME/.local/bin:$PATH"\n`, bin, H)).toBe(true);
  expect(C.hasPathLine(`# export PATH="$HOME/.local/bin:$PATH"\n`, bin, H)).toBe(false);
  expect(C.removeBlock(readFileSync(zp, "utf8"))).toBe("export FOO=1\n"); expect(C.removeBlock(b).trim()).toBe("");
  expect(C.rcHasPath(bin, H)).toEqual([zp, zr]);
});

test("wrapper state: missing, ours and working, stale (its bun or cli.ts gone, or a dangling link), foreign", () => {
  if (win) return;
  const f = join(H, "kitebook"); expect(C.wrapperState(f)).toBe("missing");
  const cli = join(H, "cli.ts"); writeFileSync(cli, "");
  writeFileSync(f, `#!/bin/sh\n# Kitebook CLI, installed by x: kitebook help\nexec "${process.execPath}" "${cli}" "$@"\n`); expect(C.wrapperState(f)).toBe("ok");
  expect(C.targets(readFileSync(f, "utf8"))).toEqual([process.execPath, cli]);
  rmSync(cli); expect(C.wrapperState(f)).toBe("stale");
  writeFileSync(f, "#!/bin/sh\necho mine\n"); expect(C.wrapperState(f)).toBe("foreign");
  rmSync(f); symlinkSync(join(H, "gone"), f); expect(C.wrapperState(f)).toBe("stale");
});

test("ensureCli: an old git install with no command gets the wrapper (runs this checkout's cli.ts), the relay shim and the PATH block; a second run changes nothing", () => {
  if (win) return;
  mkdirSync(join(H, ".relay-server")); // a machine that ran Relay before the rename
  const cfg = join(H, "runner.json"); writeFileSync(cfg, JSON.stringify({ url: "http://x", token: "t", space: "main" }));
  const answers = [false, true], logs: string[] = [], r = C.ensureCli({}, cfg, (...a) => logs.push(a.join(" ")), { probe: () => answers.shift()! }); // not found, block added, found
  const f = join(H, ".local", "bin", "kitebook"), w = readFileSync(f, "utf8"); expect(r.on_path).toBe(true); expect(r.fix).toBe(null); expect(C.lastVerify()?.ok).toBe(true);
  expect(r.wrapper).toBe("written"); expect(r.relay).toBe("written"); expect(r.rc).toEqual([join(H, ".zprofile"), join(H, ".zshrc")]);
  expect(w).toMatch(/^# Kitebook CLI, installed by the runner from /m); expect(w).toContain(join(import.meta.dir, "cli.ts")); expect(w).toContain(`KITEBOOK_RUNNER_CONFIG:-${cfg}`);
  expect(C.wrapperState(f)).toBe("ok"); expect(readFileSync(join(H, ".local", "bin", "relay"), "utf8")).toContain(`exec "${f}"`);
  expect(logs.join("\n")).toContain("Open a new Terminal window");
  const logs2: string[] = [], r2 = C.ensureCli({}, cfg, (...a) => logs2.push(a.join(" ")), { probe: () => { throw new Error("no probe: the block is there"); } });
  expect(r2.wrapper).toBe("ok"); expect(r2.rc).toEqual([]); expect(r2.on_path).toBe(true); expect(logs2).toEqual([]);
});

test("ensureCli: already on a new shell's PATH (probe) -> no rc edit; foreign kitebook kept; off for tasks and KITEBOOK_CLI_PATH=off", () => {
  if (win) return;
  const cfg = join(H, "runner.json"); writeFileSync(cfg, "{}");
  const r = C.ensureCli({}, cfg, () => {}, { probe: () => true }); expect(r.on_path).toBe(true); expect(r.rc).toEqual([]); expect(existsSync(join(H, ".zshrc"))).toBe(false); expect(r.relay).toBe(null);
  const f = join(H, ".local", "bin", "kitebook"); writeFileSync(f, "#!/bin/sh\necho mine\n"); chmodSync(f, 0o755);
  expect(C.ensureCli({}, cfg, () => {}, { probe: () => false }).wrapper).toBe("foreign"); expect(readFileSync(f, "utf8")).toBe("#!/bin/sh\necho mine\n"); expect(existsSync(join(H, ".zshrc"))).toBe(false);
  process.env.KITEBOOK_TASK_ID = "t_1"; expect(C.ensureCli({}, cfg).skipped).toBe("task"); delete process.env.KITEBOOK_TASK_ID;
  process.env.KITEBOOK_CLI_PATH = "off"; expect(C.ensureCli({}, cfg).skipped).toBe("off");
});

test("ensureCli: a stale wrapper (the clone it ran moved) is rewritten; fish gets a hint, no file edits", () => {
  if (win) return;
  const cfg = join(H, "runner.json"); writeFileSync(cfg, "{}"); const f = join(H, ".local", "bin", "kitebook"); mkdirSync(join(H, ".local", "bin"), { recursive: true });
  writeFileSync(f, `#!/bin/sh\n# Kitebook CLI, installed by old: kitebook help\nexec "${process.execPath}" "${H}/old-clone/client/cli.ts" "$@"\n`);
  process.env.KITEBOOK_LOGIN_SHELL = "/usr/bin/fish"; const logs: string[] = [];
  const r = C.ensureCli({}, cfg, (...a) => logs.push(a.join(" ")), { probe: () => false });
  expect(r.wrapper).toBe("written"); expect(C.wrapperState(f)).toBe("ok"); expect(r.rc).toEqual([]); expect(r.hint).toContain("fish_add_path"); expect(logs.join("\n")).toContain("fish_add_path");
});

test("doctor check: not installed -> the one fix (cli-path.ts install, then a new Terminal window); installed + block but not this window -> open a new window", () => {
  if (win) return;
  const cfg = join(H, "runner.json"); writeFileSync(cfg, "{}"); const oldPath = process.env.PATH; process.env.PATH = "/usr/bin:/bin";
  try { const d1 = C.doctorCheck(cfg)!; expect(d1.ok).toBe(false); expect(d1.line).toMatch(/^kitebook command on PATH: no/); expect(d1.fix).toContain("cli-path.ts install"); expect(d1.fix).toContain("new Terminal window");
    const answers = [false, true]; C.ensureCli({}, cfg, () => {}, { probe: () => answers.shift()! }); const d2 = C.doctorCheck(cfg)!; expect(d2.ok).toBe(false); expect(d2.fix).toMatch(/^open a new Terminal window/);
    process.env.PATH = `${join(H, ".local", "bin")}:/usr/bin:/bin`; expect(C.doctorCheck(cfg)).toEqual({ ok: true, line: "kitebook command on PATH", fix: null }); }
  finally { process.env.PATH = oldPath; }
});

test("probe: a real bash login shell (clean env, like a new Terminal window) doesn't find kitebook until the block is in its rc files", () => {
  if (win || !existsSync("/bin/bash")) return;
  const bin = join(H, ".local", "bin"); mkdirSync(bin, { recursive: true }); writeFileSync(join(bin, "kitebook"), "#!/bin/sh\n"); chmodSync(join(bin, "kitebook"), 0o755);
  expect(C.probe("/bin/bash", H)).toBe(false);
  expect(C.addBlock(C.rcFiles("/bin/bash", H), bin, H).length).toBe(2); expect(C.probe("/bin/bash", H)).toBe(true);
  expect(C.probe(join(H, "no-such-shell"), H)).toBe(null);
});

test("verify (install / update paths): PATH missing -> repaired once and re-checked; already there -> no second block; still missing -> one line with the exact fix, kept for Settings and doctor", () => {
  if (win) return;
  const cfg = join(H, "runner.json"); writeFileSync(cfg, "{}"); const zp = join(H, ".zprofile"), zr = join(H, ".zshrc");
  const a1 = [false, true], r1 = C.ensureCli({}, cfg, () => {}, { verify: true, probe: () => a1.shift()! });
  expect(r1.rc).toEqual([zp, zr]); expect(r1.on_path).toBe(true); expect(a1).toEqual([]);
  let probes = 0; const r2 = C.ensureCli({}, cfg, () => {}, { verify: true, probe: () => (probes++, true) }); // an update with it already there: asked, nothing added
  expect(probes).toBe(1); expect(r2.rc).toEqual([]); expect(readFileSync(zp, "utf8").split(C.START).length).toBe(2); expect(readFileSync(zr, "utf8").split(C.START).length).toBe(2);
  const logs: string[] = [], r3 = C.ensureCli({}, cfg, (...a) => logs.push(a.join(" ")), { verify: true, probe: () => false }); // the shell still doesn't find it (it ignores those files)
  expect(r3.rc).toEqual([]); expect(readFileSync(zp, "utf8").split(C.START).length).toBe(2); expect(r3.on_path).toBe(false);
  expect(r3.fix).toBe(`kitebook isn't on your PATH yet. Fix: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile, then open a new Terminal window`); expect(logs).toEqual([r3.fix!]);
  expect(C.lastVerify()).toMatchObject({ ok: false, fix: r3.fix }); const oldPath = process.env.PATH; process.env.PATH = "/usr/bin:/bin";
  try { expect(C.doctorCheck(cfg)).toEqual({ ok: false, line: "kitebook command on PATH: no (a new login shell doesn't find it)", fix: `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile, then open a new Terminal window` }); } finally { process.env.PATH = oldPath; }
  C.ensureCli({}, cfg, () => {}, { verify: true, probe: () => true }); expect(C.lastVerify()?.ok).toBe(true); // fixed by hand: the warning goes away
});

test("Windows: the user PATH is checked; missing -> added once and re-read; still missing -> the PowerShell fix", () => {
  const was = { t: process.env.KITEBOOK_TEST, p: process.env.KITEBOOK_PLATFORM }; process.env.KITEBOOK_TEST = "1"; process.env.KITEBOOK_PLATFORM = "win32";
  const bin = join(H, "Kitebook", "bin"); process.env.KITEBOOK_BIN_DIR = bin; mkdirSync(bin, { recursive: true }); writeFileSync(join(bin, "kitebook.cmd"), "@echo off\r\nrem Kitebook CLI\r\n");
  try { let up = "C:\\Windows"; const sets: string[] = [], W = { get: () => up, set: (v: string) => { sets.push(v); up = v; return true; } };
    const r1 = C.ensureCli({}, "r.json", () => {}, { verify: true, win: W }); expect(r1.on_path).toBe(true); expect(sets).toEqual([`${bin};C:\\Windows`]);
    const r2 = C.ensureCli({}, "r.json", () => {}, { verify: true, win: W }); expect(r2.rc).toEqual([]); expect(sets.length).toBe(1); // already there: not added twice
    const W2 = { get: () => "C:\\Windows", set: () => true }, r3 = C.ensureCli({}, "r.json", () => {}, { verify: true, win: W2 });
    expect(r3.on_path).toBe(false); expect(r3.fix).toContain("Fix, in PowerShell: [Environment]::SetEnvironmentVariable('Path', '" + bin + ";'"); expect(C.lastVerify()?.ok).toBe(false); }
  finally { if (was.t === undefined) delete process.env.KITEBOOK_TEST; else process.env.KITEBOOK_TEST = was.t; if (was.p === undefined) delete process.env.KITEBOOK_PLATFORM; else process.env.KITEBOOK_PLATFORM = was.p; }
});
