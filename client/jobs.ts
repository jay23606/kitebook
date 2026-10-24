// The installers' way to set up Kitebook's server (and other jobs) as a per-user service off macOS (macOS: scripts/mac-host.sh, launchd):
//   bun client/jobs.ts install <name> [--cwd <dir>] [--env K=V]... -- <argv...>     e.g. kitebook-server -- bun scripts/serve.ts
//   (--run works as the separator too: PowerShell drops a bare -- before it reaches a program)
//   bun client/jobs.ts remove <name>
// Linux: a systemd --user unit where systemd answers, else Kitebook's supervisor; Windows: the supervisor started at logon by a Scheduled Task
// (client/supervise.ts). KITEBOOK_RUNNER_CONFIG's runner.json overrides (systemctl / schtasks / supervise) apply, for tests.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, existsSync } from "fs";
import { installJob, removeJob } from "./runner-service.ts";

(await import("./rebrand.ts")).migrateDirs(); // an install from before the rename: its folders take the new names first (client/rebrand.ts)
const [cmd, name, ...rest] = process.argv.slice(2), cfgF = process.env.KITEBOOK_RUNNER_CONFIG;
const cfg = cfgF && existsSync(cfgF) ? JSON.parse(readFileSync(cfgF, "utf8")) : {};
// before a runner.json exists (the installer sets up the server first): the same overrides from the environment (smoke.sh: no systemd / a fake)
if (process.env.KITEBOOK_SUPERVISE === "1") cfg.supervise = true; if (process.env.KITEBOOK_SYSTEMCTL) cfg.systemctl = process.env.KITEBOOK_SYSTEMCTL;
const sep = rest.findIndex(a => a === "--" || a === "--run");
if (cmd === "install" && name && sep >= 0) {
  const opts = rest.slice(0, sep), argv = rest.slice(sep + 1), env: Record<string, string> = {}; let cwd: string | undefined;
  for (let i = 0; i < opts.length; i++) { if (opts[i] === "--cwd") cwd = opts[++i]; else if (opts[i] === "--env") { const [k, ...v] = opts[++i].split("="); env[k] = v.join("="); } }
  try { console.log(`installed ${name}: ${await installJob(name, `Kitebook ${name.replace(/^kitebook-/, "")}`, argv, env, cfg, cwd)}`); process.exit(0); } catch (e: any) { console.error(e.message); process.exit(1); }
}
if (cmd === "remove" && name) { await removeJob(name, cfg); console.log("removed", name); process.exit(0); }
console.error("usage: bun client/jobs.ts install <name> [--cwd <dir>] [--env K=V]... -- <argv...> | remove <name>"); process.exit(2);
