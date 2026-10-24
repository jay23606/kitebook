// kitebook uninstall: take Kitebook off this Mac in one go (what the README's Uninstall used to list as four commands).
//   the runner: stopped, its token revoked while the server still answers, ~/.kitebook and ~/.kitebook-kb deleted (runner-service.ts uninstall)
//   the server and the tunnel helper (if this Mac hosts the server): stopped and their start-at-login jobs removed
//   the kitebook command and the PATH line scripts/get.sh added; the coding agents' Kitebook entries are named for the owner to remove
//   --all: also the code (~/.kitebook-app, from the one-step install) and the server's data (~/.kitebook-server). Without it the data stays.
// The owner's terminal only: a task's process is refused, and without a terminal it needs --yes.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { CLI } from "./brand.ts";

export async function uninstallCli(cfgPath: string, argv: string[]): Promise<number> {
  if (process.env.KITEBOOK_TASK_ID) { console.error(`${CLI} uninstall: only the machine owner can remove Kitebook (from their own terminal)`); return 1; }
  const all = argv.includes("--all"), H = process.env.HOME || homedir();
  if (!argv.includes("--yes")) {
    if (!process.stdin.isTTY) { console.error(`${CLI} uninstall: add --yes to remove Kitebook from this Mac without a question`); return 2; }
    process.stdout.write(`Remove Kitebook from this Mac${all ? ", including its code and all its data" : " (your data stays in ~/.kitebook-server)"}? [y/N] `);
    let ok = false; for await (const l of console) { ok = l.trim().toLowerCase() === "y"; break; } if (!ok) { console.log("Nothing changed."); return 1; }
  }
  let cfg: any = {}; try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch {}
  const app = cfg.server?.dir ?? cfg.source ?? null, la = join(H, "Library", "LaunchAgents");
  const { service } = await import("./service.ts"), quiet = async (a: string[]) => { const l = console.log; console.log = () => {}; try { await service(cfgPath, a, { plain: true }); } catch {} finally { console.log = l; } };
  // the runner and the tunnel helper first, then the runner's token is revoked while the server still answers, then the server
  for (const what of ["runner", "tunnel"]) await quiet(["stop", what]);
  try { (await import("./password.ts")).stopLinks(); } catch {} // a one-time setup link's server (client/password.ts mintLink) too
  // Windows and Linux: the server's and the tunnel helper's jobs (Kitebook's supervisor + its Scheduled Task / autostart entry, or systemd
  // units) go too. The supervisor keeps its state under ~/.kitebook, which the purge below deletes, so the tunnel goes now and the server's
  // processes are noted to stop after the token is revoked (the server must still answer for that).
  const PL = await import("./platform.ts"), SV = await import("./supervise.ts"), { UNIT, LEGACY_UNIT } = await import("./brand.ts");
  const offMac = PL.plat() !== "darwin" && !process.env.KITEBOOK_FAKE_MAC, R0 = await import("./runner-service.ts");
  if (offMac) for (const u of [UNIT.tunnel, LEGACY_UNIT.tunnel]) try { if (await R0.hasJob(u, cfg)) { await R0.removeJob(u, cfg); console.log(`removed ${u} (it no longer starts when you sign in)`); } } catch {}
  const srv = offMac ? [UNIT.server, LEGACY_UNIT.server].flatMap(u => [SV.supPid(u), SV.childPid(u)]).filter((p): p is number => !!p) : [];
  const keep = join(tmpdir(), `kitebook-uninstall-${process.pid}.json`); writeFileSync(keep, JSON.stringify(cfg), { mode: 0o600 }); // runner.json goes with ~/.kitebook
  const R = await import("./runner-service.ts"); let rc = 0; const purged = existsSync(cfgPath);
  try { if (purged) rc = await R.uninstall(cfgPath, true);
    const q = async (a: string[]) => { const l = console.log; console.log = () => {}; try { await service(keep, a, { plain: true }); } catch {} finally { console.log = l; } }; await q(["stop", "server"]);
    if (purged) for (const d of [".kitebook", ".relay-runner"]) rmSync(join(H, d), { recursive: true, force: true }); } // (the pre-rename name is a link to it) // stopping the server writes an audit line, which would re-create the folder the purge just removed
  finally { rmSync(keep, { force: true }); }
  if (offMac) { for (const u of [UNIT.server, LEGACY_UNIT.server]) try { const had = (await R0.hasJob(u, cfg)) || (u === UNIT.server && srv.length > 0); await R0.removeJob(u, cfg); if (had) console.log(`removed ${u} (it no longer starts when you sign in)`); } catch {} // (the logon hook even when the purge took its state)
    for (const p of srv) { if (PL.plat() === "win32") PL.killTreeWin(p); else { try { process.kill(-p, "SIGTERM"); } catch {} try { process.kill(p, "SIGTERM"); } catch {} } } }
  for (const l of ["dev.kitebook.server", "dev.kitebook.tunnel", "dev.kitebook.ngrok", "dev.kitebook.runner", "dev.relay.server", "dev.relay.tunnel", "dev.relay.ngrok", "dev.relay.runner"]) { const f = join(la, `${l}.plist`); if (existsSync(f)) { rmSync(f); console.log(`removed ${l} (it no longer starts at login)`); } }
  // the command and its PATH line (only ours: '# Kitebook CLI', '# added by Kitebook')
  // and the old name: the relay shim (or a pre-rename relay wrapper) and its PATH line ('# added by Relay')
  for (const name of [CLI, "relay"]) { const bin = join(process.env.KITEBOOK_BIN_DIR || join(H, ".local", "bin"), name);
    try { if (/^# (Kitebook|Relay) CLI/m.test(readFileSync(bin, "utf8"))) { rmSync(bin); console.log(`removed the ${name} command`); } } catch {} }
  const { removeBlock } = await import("./cli-path.ts"); // and the marked block the runner adds for a git install (client/cli-path.ts)
  for (const rcf of [".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile"].map(f => join(H, f))) { try { const t = readFileSync(rcf, "utf8"), n = removeBlock(t.split("\n").filter(l => !/# added by (Kitebook|Relay)$/.test(l)).join("\n")); if (n !== t) writeFileSync(rcf, n); } catch {} }
  if (all) for (const d of [app && existsSync(join(app, "scripts", "get.sh")) && /\.kitebook-app$/.test(app) ? app : null, join(H, ".kitebook-server"), join(H, ".kitebook-node"), join(H, ".relay-server"), join(H, ".relay-node"), join(H, ".relay-app")]) if (d && existsSync(d)) { rmSync(d, { recursive: true, force: true }); console.log(`deleted ${d.replace(H, "~")}`); }
  console.log(`Kitebook is off this Mac.${all ? "" : " Your data is still in ~/.kitebook-server (kitebook uninstall --all deletes it)."}`);
  console.log("Last steps, by hand: remove Kitebook's connector in Claude.ai or ChatGPT, and its entry in your coding agents (claude mcp remove kitebook -s user; codex mcp remove kitebook).");
  return rc;
}
