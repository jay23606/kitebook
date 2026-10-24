#!/usr/bin/env bun
// The compiled `kitebook` binary (bun build --compile, scripts/release-build.ts): one file with the CLI, the runner and the self-updater, so an
// install needs no git clone, bun or node. It dispatches to the same modules a checkout runs:
//   kitebook version [--json]              which release this is (the updater's health check reads the JSON)
//   kitebook install [--sums f --sig f] [--channel dev]   put this binary at ~/.kitebook-app/bin/kitebook (get.sh runs it after the download)
//   kitebook update [--check] [--channel stable|dev] [--rollback]   update from GitHub Releases (client/binary.ts; signed, numbered, rolled back on failure)
//   kitebook runner <runner.json> | kitebook runner <args>   the runner (client/runner.ts), e.g. what launchd/systemd start
//   kitebook <anything else>               the server CLI (client/cli.ts): status, restart, logs, ops, kb, ask...
// The server (workerd + the built Worker) is not in here: it runs from the Docker image (Dockerfile) or a checkout (scripts/serve.sh),
// since workerd is its own ~100 MB native binary per platform.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import * as B from "./binary.ts";

const a = process.argv.slice(2), cmd = a[0] ?? "";
const run = async (rest: string[], mod: () => Promise<unknown>) => { process.argv.splice(2, process.argv.length - 2, ...rest); await mod(); };
const cfgPath = () => process.env.KITEBOOK_RUNNER_CONFIG || require("path").join(process.env.KITEBOOK_HOME || require("path").join(require("os").homedir(), ".kitebook"), "runner.json");
const cfg = () => { try { return JSON.parse(require("fs").readFileSync(cfgPath(), "utf8")); } catch { return {}; } };

// an install from before the rename (relay in ~/.relay-app/bin): the first command this binary runs moves it to the new names (the old ones
// link there). Not for version / __selftest: the updater that just swapped this file in (maybe a pre-rename one) runs those.
if (!["version", "--version", "-v", "__selftest"].includes(cmd)) { const RB = await import("./rebrand.ts"); RB.migrateDirs(); RB.migrateBinary(B.appHome()); }
if (cmd === "version" || cmd === "--version" || cmd === "-v") {
  const v = { version: B.BUILD?.version ?? "source", release: B.BUILD?.release ?? 0, channel: B.BUILD?.channel ?? null, target: B.target(), installed: B.state() };
  console.log(a.includes("--json") ? JSON.stringify(v) : `kitebook ${v.version} (release ${v.release}, ${v.channel ?? "source"}, ${v.target})`); process.exit(0);
} else if (cmd === "__selftest") { // after a swap: the binary loads its modules from where it now lives and knows who it is
  if (B.BUILD?.selftestFail) { console.error("self-test failed (test build)"); process.exit(1); }
  await import("./integrity.ts"); await import("./updater.ts"); await import("./sign.ts"); await import("./guard.ts");
  if (!B.BUILD?.version) { console.error("no build info"); process.exit(1); } console.log("ok"); process.exit(0);
} else if (cmd === "install") process.exit(B.install(a.slice(1)));
else if (cmd === "update") {
  const c = cfg(), f = (k: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
  if (f("channel")) { const ch = f("channel") === "dev" ? "dev" : "stable"; c.updateChannel = ch; process.env.KITEBOOK_UPDATE_CHANNEL = ch;
    try { const fs = require("fs"); if (fs.existsSync(cfgPath())) { const raw = JSON.parse(fs.readFileSync(cfgPath(), "utf8")); raw.updateChannel = ch; fs.writeFileSync(cfgPath(), JSON.stringify(raw, null, 2), { mode: 0o600 }); } } catch {} }
  if (a.includes("--rollback")) { const r = B.rollback(); console.log(r.ok ? `✓ Went back to ${r.to}. The runner restarts on it once its tasks finish.` : `Can't roll back: ${r.why}`); if (r.ok) flagRestart(); process.exit(r.ok ? 0 : 1); }
  if (a.includes("--check")) { const c2 = await B.check(c); console.log(JSON.stringify(c2, null, 1)); process.exit(c2.state === "unreachable" || c2.state === "bad" ? 1 : 0); }
  const U = await import("./updater.ts"), r = await U.apply(c, { by: process.env.KITEBOOK_TASK_ID ? `task ${process.env.KITEBOOK_TASK_ID}` : "owner cli", cfgPath: cfgPath() });
  const words = r.result === "installed" ? `✓ Updated ${r.from ?? "kitebook"} -> ${r.to} (release ${r.release}). The runner restarts on it once its tasks finish.` : r.result === "up to date" ? `✓ Up to date (${r.to}).` : `${r.result === "rolled back" ? "✗ Rolled back" : "Not updated"}: ${r.why}`;
  if (r.result === "installed") flagRestart();
  console.log(a.includes("--json") ? JSON.stringify(r) : words); process.exit(r.result === "installed" || r.result === "up to date" ? 0 : 1);
} else if (cmd === "runner") await run(a.slice(1), () => import("./runner.ts"));
else if (cmd === "__guard") { const G = await import("./guard.ts"); G.shimCheck(a[1], a[2], a.slice(3)); } // the guard shims inside a task (guard.ts __check)
else { (globalThis as any).__relayEntry = "cli"; await import("./cli.ts"); }

// the runner restarts itself on the new binary once idle (client/runner.ts watches ~/.kitebook/restart-runner)
function flagRestart() { if (!require("fs").existsSync(cfgPath())) return; try { const p = require("path"), d = p.join(require("os").homedir(), ".kitebook"); require("fs").mkdirSync(d, { recursive: true }); require("fs").writeFileSync(p.join(d, "restart-runner"), new Date().toISOString()); } catch {} }
