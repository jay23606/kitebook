// The adapters against the REAL coding-agent CLIs, no login needed (CI job "agents-cli", and by hand: bun scripts/agents-help-check.ts).
// For every adapter CLI on PATH: read its real --help, build() the argv the runner would run, and fail when a flag the run needs is missing
// (`issue`) or when any flag Kitebook would pass (task, quick ask, first turn, resume) isn't listed. That is exactly the check that would have
// caught Codex dropping --full-auto. Also: Pi's quick-ask --no-mcp and its `pi mcp` command, and Codex's `exec resume` argument parsing.
// --require a,b,c: those CLIs must be installed (CI installs them with npm), otherwise a missing CLI is just skipped.
import "../client/brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { ADAPTERS, build, listed } from "../client/agent-adapters.ts";
import { piHasMcp } from "../client/agents-connect.ts";

const req = (process.argv.find(a => a.startsWith("--require="))?.slice(10) ?? (process.argv.includes("--require") ? process.argv[process.argv.indexOf("--require") + 1] : "")).split(",").filter(Boolean);
const help = (argv: string[]) => { const p = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30000, env: { ...process.env, NO_COLOR: "1", CI: "1" } as any });
  return (p.stdout.toString() + "\n" + p.stderr.toString()).trim(); };
let bad = 0; const say = (ok: boolean, l: string) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${l}`); };
for (const [n, a] of Object.entries(ADAPTERS)) {
  if (!Bun.which(a.bin)) { if (req.includes(n)) say(false, `${n}: ${a.bin} not installed (${a.install})`); else console.log(`skip ${n}: ${a.bin} not installed`); continue; }
  const h = help(a.helpArgv ?? [a.bin, "--help"]), b = build(n, h);
  const used = [...b.argv, ...(b.ask ?? []), ...(b.first ?? []), ...(b.resume ?? [])].filter(x => /^-/.test(x));
  const unlisted = [...new Set(used)].filter(f => !listed(h, f));
  say(!b.issue && !unlisted.length, `${n}: ${b.issue ?? (unlisted.length ? `flags not in --help: ${unlisted.join(" ")}` : `${b.argv.filter(x => x !== "{resume}").join(" ")} | ${b.events ? "events" : "plain"}, ${b.resume ? "resumes" : "no resume"}, ask ${b.askReadOnly ? "read-only" : "git check"}`)}`);
  if (n === "codex") { // the resume argv must parse: a made-up thread id gets "no rollout found"/auth errors, never "unexpected argument" (exit 2)
    const p = Bun.spawnSync(["codex", "exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--json", "resume", "00000000-0000-4000-8000-000000000000", "hi"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30000, env: { ...process.env, CODEX_HOME: `${process.env.TMPDIR ?? "/tmp"}/kitebook-codex-check` } as any });
    const out = p.stdout.toString() + p.stderr.toString(); say(p.exitCode !== 2 && !/unexpected argument|unrecognized/i.test(out), `codex exec ... resume <id> parses (exit ${p.exitCode})`); }
}
if (Bun.which("pi")) { const h = help(["pi", "--help"]); const v = help(["pi", "--version"]).split("\n")[0];
  console.log(`info pi ${v}: ${piHasMcp(h) ? "has `pi mcp`" : "no `pi mcp` (kitebook connect reports it too old)"}, ${listed(h, "--no-mcp") ? "--no-mcp for quick asks" : "no --no-mcp"}`);
  if (req.includes("pi")) say(piHasMcp(h) && listed(h, "--no-mcp"), "pi: current Pi has `pi mcp` and --no-mcp"); }
else if (req.includes("pi")) say(false, "pi not installed (npm i -g @earendil-works/pi-coding-agent)");
console.log(bad ? `${bad} problem(s)` : "all adapter flags check out against the installed CLIs"); process.exit(bad ? 1 : 0);
