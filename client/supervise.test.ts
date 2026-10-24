// Kitebook's supervisor (client/supervise.ts), for real on whichever OS runs this (the CI matrix: ubuntu, macos, windows): install a job,
// it runs; the job exiting brings it back; restart (kick), stop (stays stopped), start, logs, uninstall. The logon hook is pointed at temp
// folders (and, on Windows, at a schtasks that doesn't exist, so the Startup-folder fallback is what gets written).
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const H = mkdtempSync(join(tmpdir(), "kitebook-sup-")); process.env.KITEBOOK_SVC_DIR = join(H, "svc"); process.env.KITEBOOK_TEST = "1"; process.env.KITEBOOK_SUP_PAUSE_MS = "300";
const SV = await import("./supervise.ts");
const until = async (f: () => boolean, ms = 8000) => { for (let i = 0; i < ms / 50; i++) { if (f()) return true; await Bun.sleep(50); } return f(); };

test("supervisor: runs a job, restarts it when it exits, restart / stop / start, log file, uninstall", async () => {
  const log = join(H, "logs", "kitebook-test.log"), hooks = { schtasks: "kitebook-no-such-schtasks", autostartDir: join(H, "autostart"), startupDir: join(H, "startup") };
  // the job prints its pid and exits after 1.5 s, like a runner restarting itself after an update
  const r = SV.install("kitebook-test", { argv: [process.execPath, "-e", "console.log('job pid', process.pid, process.env.KITEBOOK_SERVICE); setTimeout(() => process.exit(0), 1500)"], log, env: { X: "1" } }, hooks);
  expect(r.code).toBe(0); expect(r.hook).toBe(process.platform === "win32" ? "startup folder" : "desktop autostart");
  expect(readdirSync(process.platform === "win32" ? hooks.startupDir : hooks.autostartDir).length).toBe(1);
  expect(await until(() => SV.running("kitebook-test"))).toBe(true);
  const first = SV.childPid("kitebook-test");
  expect(await until(() => !!SV.childPid("kitebook-test") && SV.childPid("kitebook-test") !== first)).toBe(true); // it exited and came back
  expect(readFileSync(log, "utf8")).toMatch(/job pid \d+ supervise/); expect(readFileSync(log, "utf8")).toContain("starting it again");
  const before = SV.childPid("kitebook-test"); expect(SV.kick("kitebook-test").code).toBe(0);
  expect(await until(() => !!SV.childPid("kitebook-test") && SV.childPid("kitebook-test") !== before)).toBe(true);
  await SV.stop("kitebook-test"); expect(SV.running("kitebook-test")).toBe(false); expect(SV.supPid("kitebook-test")).toBeNull();
  await Bun.sleep(700); expect(SV.running("kitebook-test")).toBe(false); // stopped stays stopped
  expect(SV.start("kitebook-test").code).toBe(0); expect(await until(() => SV.running("kitebook-test"))).toBe(true);
  expect(SV.start("kitebook-test").out).toBe("already running"); // one supervisor per job
  await SV.uninstall("kitebook-test", hooks); expect(SV.installed("kitebook-test")).toBe(false); expect(SV.supPid("kitebook-test")).toBeNull();
  expect(existsSync(join(hooks.autostartDir, "kitebook-kitebook-test.desktop")) || existsSync(join(hooks.startupDir, "Kitebook kitebook-test.cmd"))).toBe(false);
}, 30_000);
