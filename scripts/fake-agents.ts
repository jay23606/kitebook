// Fake coding-agent CLIs for tests (client/agent-adapters.test.ts and smoke.sh "more agents"). Each one prints a --help listing exactly the
// flags its real CLI documents (client/agent-adapters.ts has the links), REFUSES any other flag (exit 2, like the real CLIs), logs its argv to
// $FAKE_AGENT_LOG (default ~/.fake-agents.log; one JSON line per run) and behaves like a headless run: plain text, or the CLI's own JSON event stream when asked for it.
//   bun scripts/fake-agents.ts install <dir> [--old]   write executables codex, claude, gemini, cursor-agent, copilot, opencode, grok into <dir>
//   bun scripts/fake-agents.ts install <dir> --live    write only a codex that always has the live app-server (FAKE_CODEX_LIVE=1)
//   --old: a Gemini CLI from before --skip-trust / plan mode / --resume, and a Cursor without --mode (optional flags must then be left out)
//   FAKE_GROK=superagent: the community grok-cli (its -p/--prompt, no --always-approve, no `mcp add --header`, one OpenAI-style JSON message
//   per line on stdout, "powered by Grok" in its --help); default: xAI's Grok Build
// Codex is codex-cli 0.163's `exec` (and its app-server with FAKE_CODEX_LIVE=1 or $HOME/.fake-codex-live) (no --full-auto: exit 2, like the real one); Claude Code refuses stream-json without --verbose, like the real one.
// Sessions Kitebook names (Copilot --session-id, Grok Build --session-id then --resume) are kept as marker files in $HOME/.fake-sessions.
// A run writes <bin>.txt in its working directory (FAKE-SLOW in the prompt: after 5 s). A prompt with FAKE-ASK asks a question first ([relay-question: ...]); the answer turn
// continues the same session only if the resume flag came back (resumed.txt records which session). Quick asks (READ-ONLY in the
// prompt) answer "readonly=<did the read-only flags come>" and try a write when the question says QA-WRITE (denied in read-only mode).
import "../client/brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { writeFileSync, appendFileSync, chmodSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

type Spec = { help: string; flags: Record<string, number>; prompt?: string; sub?: string };
const OLD = process.env.FAKE_AGENTS_OLD === "1", SUPER = process.env.FAKE_GROK === "superagent";
const specs = (): Record<string, Spec> => ({
  codex: { sub: "exec", flags: { "-c": 1, "--config": 1, "-m": 1, "--model": 1, "-s": 1, "--sandbox": 1, "--skip-git-repo-check": 0, "--json": 0, "-C": 1, "--cd": 1, "--ephemeral": 0, "-o": 1, "--output-last-message": 1,
      "--dangerously-bypass-approvals-and-sandbox": 0, "--last": 0 },
    help: `Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]

Commands:
  resume  Resume a previous session by id or pick the most recent with --last
  review  Run a code review against the current repository

Options:
  -c, --config <key=value>  Override a configuration value
  -m, --model <MODEL>  Model the agent should use
  -s, --sandbox <SANDBOX_MODE>  Select the sandbox policy [possible values: read-only, workspace-write, danger-full-access]
      --dangerously-bypass-approvals-and-sandbox  Skip all confirmation prompts
  -C, --cd <DIR>  Tell the agent to use the specified directory as its working root
      --skip-git-repo-check  Allow running Codex outside a Git repository
      --ephemeral  Run without persisting session files to disk
      --json  Print events to stdout as JSONL
  -o, --output-last-message <FILE>  Specifies file where the last message from the agent should be written` },
  claude: { flags: { "-p": 0, "--print": 0, "--permission-mode": 1, "--output-format": 1, "--input-format": 1, "--verbose": 0, "-r": 1, "--resume": 1, "-c": 0, "--continue": 0, "--model": 1,
      "--session-id": 1, "--strict-mcp-config": 0, "--mcp-config": 1, "--tools": 1, "--disallowedTools": 1, "--allowedTools": 1, "--dangerously-skip-permissions": 0 },
    help: `Usage: claude [options] [command] [prompt]
  --allowedTools, --allowed-tools <tools...>  Comma or space-separated list of tool names to allow
  -c, --continue                        Continue the most recent conversation in the current directory
  --dangerously-skip-permissions        Bypass all permission checks.
  --disallowedTools, --disallowed-tools <tools...>  Comma or space-separated list of tool names to deny
  --input-format <format>               Input format (only works with --print): "text" (default), or "stream-json"
  --model <model>                       Model for the current session
  --output-format <format>              Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming)
  --permission-mode <mode>              Permission mode to use for the session (choices: "acceptEdits", "bypassPermissions", "default", "plan")
  -p, --print                           Print response and exit (useful for pipes)
  -r, --resume [value]                  Resume a conversation by session ID
  --session-id <uuid>                   Use a specific session ID for the conversation (must be a valid UUID)
  --strict-mcp-config                  Only use MCP servers from --mcp-config
  --mcp-config <configs...>            Load MCP servers from JSON files or strings
  --tools <tools...>                    Specify the list of available tools from the built-in set
  --verbose                             Override verbose mode setting from config` },
  gemini: { prompt: "--prompt", flags: { "-m": 1, "--model": 1, "-p": 1, "--prompt": 1, "-s": 0, "--sandbox": 0, "--approval-mode": 1, "-y": 0, "--yolo": 0, "-o": 1, "--output-format": 1,
      ...(OLD ? {} : { "--skip-trust": 0, "-r": 1, "--resume": 1 }) },
    help: `Usage: gemini [options] [query]
  -m, --model             Model                                                     [string]
  -p, --prompt            Run in non-interactive (headless) mode with the given prompt  [string]
  -s, --sandbox           Run in a sandboxed environment for safer execution         [boolean]
      --approval-mode     Approval mode for tool execution [string] [choices: "default", "auto_edit", "yolo"${OLD ? "" : `, "plan"`}]
  -y, --yolo              Deprecated. Use --approval-mode=yolo instead.            [boolean]
${OLD ? "" : `      --skip-trust        Trust the current workspace for this session.            [boolean]
  -r, --resume            Resume a previous session ("latest" or a session id)     [string]
`}  -o, --output-format     The format of the CLI output. [string] [choices: "text", "json"${OLD ? "" : `, "stream-json"`}]` },
  "cursor-agent": { flags: { "-p": 0, "--print": 0, "-f": 0, "--force": 0, "--yolo": 0, "--trust": 0, "--output-format": 1, "--resume": 1, "--continue": 0, "--model": 1, ...(OLD ? {} : { "--mode": 1, "--plan": 0 }), "--list-models": 0 },
    help: `Usage: agent [options] [command] [prompt...]
  -p, --print                 Print responses to console (for scripts or non-interactive use). Has access to all tools, including write and shell.
  --output-format <format>    Output format (only works with --print): text, json, or stream-json (default: text)
  --resume [chatId]           Resume a chat session
  --continue                  Continue the previous session
  --model <model>             Model to use
${OLD ? "" : `  --mode <mode>               Set agent mode: plan or ask
  --plan                      Start in plan mode
`}  -f, --force                 Force allow commands unless explicitly denied
  --yolo                      Alias for --force
  --trust                     Trust the workspace without prompting (headless mode only)
  --list-models               List all available models` },
  copilot: { prompt: "--prompt", flags: { "-p": 1, "--prompt": 1, "--allow-all-tools": 0, "--allow-tool": 1, "--deny-tool": 1, "--model": 1, "--continue": 0, "--resume": 1, "--yolo": 0,
      ...(OLD ? {} : { "-s": 0, "--silent": 0, "--session-id": 1, "--no-ask-user": 0, "--disable-builtin-mcps": 0, "--no-auto-update": 0 }) },
    help: `Usage: copilot [options] [command]
  -p, --prompt <text>        Execute a prompt in non-interactive mode (exits after completion)
${OLD ? "" : `  -s, --silent               Output only the agent response (no stats), useful for scripting with -p
  --session-id <id>          Resume an existing session or task by ID, or set the UUID for a new session
  --no-ask-user              Disable the ask_user tool (agent works autonomously without asking questions)
  --disable-builtin-mcps     Disable all built-in MCP servers (currently: github-mcp-server)
  --no-auto-update           Disable downloading CLI update automatically
`}  --allow-all-tools          Allow all tools to run automatically without confirmation
  --allow-tool [tools...]    Tools the CLI has permission to use; will not prompt for permission
  --deny-tool [tools...]     Tools the CLI does not have permission to use; will not prompt for permission
  --model <model>            Set the AI model to use
  --continue                 Resume the most recent session
  --resume [sessionId]       Resume from a previous session
  --yolo                     Allow all permissions` },
  opencode: { sub: "run", flags: { "-m": 1, "--model": 1, "-c": 0, "--continue": 0, "-s": 1, "--session": 1, "--agent": 1, "--format": 1, "-f": 1, "--file": 1, "--fork": 0 },
    help: `opencode run [message..]
run opencode with a message
Options:
  -c, --continue  continue the last session                                  [boolean]
  -s, --session   session id to continue                                      [string]
      --fork      fork the session when continuing                           [boolean]
  -m, --model     model to use in the format of provider/model                [string]
      --agent     agent to use                                                [string]
      --format    format: default (formatted) or json (raw JSON events) [string] [choices: "default", "json"]
  -f, --file      file(s) to attach to message                                 [array]` },
  grok: SUPER
    ? { prompt: "--prompt", flags: { "-p": 1, "--prompt": 1, "-m": 1, "--model": 1, "-d": 1, "--directory": 1, "-k": 1, "--api-key": 1, "-u": 1, "--base-url": 1, "--max-tool-rounds": 1 },
      help: `Usage: grok [options] [command] [message...]

A conversational AI CLI tool powered by Grok with text editor capabilities

Options:
  -V, --version               output the version number
  -d, --directory <dir>       set working directory
  -k, --api-key <key>         Grok API key (or set GROK_API_KEY env var)
  -u, --base-url <url>        Grok API base URL (or set GROK_BASE_URL env var)
  -m, --model <model>         AI model to use (e.g., grok-code-fast-1, grok-4-latest) (or set GROK_MODEL env var)
  -p, --prompt <prompt>       process a single prompt and exit (headless mode)
  --max-tool-rounds <rounds>  maximum number of tool execution rounds (default: 400)
  -h, --help                  display help for command` }
    : { prompt: "-p", flags: { "-p": 1, "--single": 1, "-m": 1, "--model": 1, "--always-approve": 0, "--cwd": 1, "-r": 1, "--resume": 1, "-c": 0, "--continue": 0, "--output-format": 1,
        "--permission-mode": 1, "-s": 1, "--session-id": 1 },
      help: `Grok Build TUI

Usage: grok [OPTIONS] [PROMPT] [COMMAND]
      --always-approve
          Auto-approve all tool executions
  -c, --continue
          Continue the most recent session for the current working directory
      --cwd <CWD>
          Working directory
  -m, --model <MODEL>
          Model ID to use
      --output-format <OUTPUT_FORMAT>
          Output format for headless mode [default: plain]
  -p, --single <PROMPT>
          Single-turn prompt. Prints the response to stdout and exits
      --permission-mode <MODE>
          Permission mode [possible values: default, acceptEdits, auto, dontAsk, bypassPermissions, plan]
  -r, --resume [<SESSION_ID_OR_TITLE>]
          Resume a session by ID or title, or the most recent if omitted
  -s, --session-id <SESSION_ID>
          Use a specific session UUID for a **new** conversation (must not already exist). Does not resume existing sessions` },
});

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "install") {
  const dir = rest[0]; mkdirSync(dir, { recursive: true });
  if (rest.includes("--live")) { // live-codex: a codex alone that always has app-server, for a dir pinned first on PATH (order-independent sections)
    writeFileSync(join(dir, "codex"), `#!/bin/sh\nFAKE_CODEX_LIVE=1 exec "${process.execPath}" "${import.meta.path}" run codex "$@"\n`), chmodSync(join(dir, "codex"), 0o755); process.exit(0); }
  for (const b of ["codex", "claude", "gemini", "cursor-agent", "copilot", "opencode", "grok"])
    if (process.platform === "win32") // Windows: a .cmd like the npm shims real CLIs install (the runner starts it through cmd.exe, escaped)
      writeFileSync(join(dir, `${b}.cmd`), `@echo off\r\n${rest.includes("--old") ? "set FAKE_AGENTS_OLD=1\r\n" : ""}"${process.execPath}" "${import.meta.path}" run ${b} %*\r\n`);
    else writeFileSync(join(dir, b), `#!/bin/sh\n${rest.includes("--old") ? "FAKE_AGENTS_OLD=1 " : ""}exec "${process.execPath}" "${import.meta.path}" run ${b} "$@"\n`), chmodSync(join(dir, b), 0o755);
  process.exit(0);
}
const bin = rest[0], argv = rest.slice(1), S = specs()[bin];
if (!S) { console.error("unknown fake " + bin); process.exit(2); }
const say = (o: any) => console.log(typeof o === "string" ? o : JSON.stringify(o));
// subcommands the runner / installer use besides a run
if (bin === "opencode" && argv[0] === "models") { say("fakeprov/fast-1"); say("fakeprov/smart-2"); process.exit(0); }
if (bin === "opencode" && (argv[0] === "--help" || (argv[0] === "run" && argv[1] === "--help"))) { say(argv[0] === "--help" ? "Commands:\n  opencode run [message..]  run opencode with a message\n  opencode models" : S.help); process.exit(0); }
if (bin === "codex" && argv[0] === "exec" && (argv[1] === "--help" || argv[1] === "-h")) { say(S.help); process.exit(0); }
// live-codex: with FAKE_CODEX_LIVE=1 (baked into the wrapper `install <dir> --live` writes, so it holds whatever HOME or env the runner gives
// the agent) or $HOME/.fake-codex-live present, the fake Codex also has `--version` (0.163.0) and `app-server` (scripts/fake-codex-app-server.ts),
// so the runner's live driver picks it up; without either Codex stays exec-only, like a Codex older than the app-server
if (bin === "codex" && (process.env.FAKE_CODEX_LIVE === "1" || existsSync(join(process.env.HOME || "/tmp", ".fake-codex-live")))) {
  if (argv[0] === "--version") { say("codex-cli 0.163.0"); process.exit(0); }
  if (argv[0] === "app-server") { if (argv[1] === "--help") { say("[experimental] Run the app server or related tooling"); process.exit(0); } await import("./fake-codex-app-server.ts"); await new Promise(() => {}); } // it serves stdin until it closes
}
if (argv[0] === "--help" || argv[0] === "-h") { say(bin === "codex" ? "Codex CLI\n\nCommands:\n  exec  Run Codex non-interactively\n  mcp   Manage external MCP servers" : S.help); process.exit(0); }
const LOGF = process.env.FAKE_AGENT_LOG || join(process.env.HOME || "/tmp", ".fake-agents.log");
if (argv[0] === "mcp") { const log = LOGF; if (log) appendFileSync(log, JSON.stringify({ bin, mcp: argv.slice(1) }) + "\n");
  if (bin === "grok" && argv[1] === "add" && SUPER && argv.includes("--header")) { console.error("error: unknown option '--header'"); process.exit(1); }
  process.exit(0); }
// a run: check every flag against this CLI's own list, like the real one would
let a = argv; if (S.sub) { if (a[0] !== S.sub) { console.error(`error: unknown command ${a[0] ?? ""}`); process.exit(2); } a = a.slice(1); }
const got: Record<string, string | true> = {}, pos: string[] = [];
for (let i = 0; i < a.length; i++) { const x = a[i];
  if (x.startsWith("-") && x.length > 1) { const [k, v] = x.includes("=") ? [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)] : [x, null];
    if (!(k in S.flags)) { console.error(`error: unknown option '${k}'`); process.exit(2); }
    if (S.flags[k]) { const val = v ?? a[++i]; if (val == null) { console.error(`error: option '${k}' needs a value`); process.exit(2); } got[k] = got[k] && k === "--deny-tool" ? `${got[k]},${val}` : val; } else got[k] = true; }
  else pos.push(x); }
let codexResume: string | undefined; if (bin === "codex" && pos[0] === "resume") { codexResume = pos[1]; pos.splice(0, 2); }
if (bin === "claude" && got["--output-format"] === "stream-json" && !got["--verbose"]) { console.error("Error: When using --print, --output-format=stream-json requires --verbose"); process.exit(1); }
const prompt = String((S.prompt ? got[S.prompt] ?? got[S.prompt === "-p" ? "--single" : "-p"] : null) ?? pos.join(" "));
// sessions Kitebook names: --session-id creates (Grok Build refuses an existing one), --resume needs one (Copilot's --session-id does either)
const SD = join(process.env.HOME || "/tmp", ".fake-sessions"), sess = (id: string) => join(SD, `${bin}-${id}`); let named: string | undefined, existed = false;
if ((bin === "copilot" || bin === "grok") && (got["--session-id"] || (bin === "grok" && got["-s"]))) { named = String(got["--session-id"] ?? got["-s"]); existed = existsSync(sess(named));
  if (bin === "grok" && existed) { console.error(`error: session ${named} already exists; use --resume`); process.exit(1); } mkdirSync(SD, { recursive: true }); writeFileSync(sess(named), "x"); }
if (bin === "grok" && !SUPER && (got["--resume"] || got["-r"])) { named = String(got["--resume"] ?? got["-r"]); existed = existsSync(sess(named)); if (!existed) { console.error(`error: no session ${named}`); process.exit(1); } }
try { appendFileSync(LOGF, JSON.stringify({ bin, argv, cwd: process.cwd(), env_model: process.env.KITEBOOK_MODEL ?? null }) + "\n"); } catch {}
if (prompt.includes("FAKE-SLOW")) await Bun.sleep(5000); // long enough to be seen working (presence)
const fmt = String(got["--output-format"] ?? got["--format"] ?? "text"), events = (["stream-json", "json"].includes(fmt) && bin !== "grok") || (bin === "codex" && !!got["--json"]) || (bin === "grok" && SUPER);
const resumeId = (bin === "codex" ? codexResume : bin === "copilot" || bin === "grok" ? (existed ? named : undefined) : (got["--resume"] ?? got["--session"])) as string | undefined, cont = !!got["--continue"];
const sid = typeof resumeId === "string" ? resumeId : `${bin}-sess-${Math.random().toString(36).slice(2, 8)}`;
const readOnly = !!(got["--approval-mode"] === "plan" || got["--mode"] === "ask" || String(got["--deny-tool"] ?? "").includes("write") || got["--agent"] === "plan"
  || got["--permission-mode"] === "plan" || got["--sandbox"] === "read-only" || got["-s"] === "read-only");
let text: string;
if (prompt.includes("READ-ONLY")) { // a quick ask
  // the CLI's own read-only mode denies the write (like plan mode); without it the fake really writes, so the git check / sandbox must catch it
  let wrote = "no"; if (prompt.includes("QA-WRITE")) { if (readOnly) wrote = "denied"; else try { writeFileSync("hack.txt", "x"); wrote = "yes"; } catch (e: any) { wrote = "refused " + e.code; } }
  text = `fake ${bin} answer readonly=${readOnly ? "yes" : "no"} wrote=${wrote}`;
} else if (prompt.includes("FAKE-ASK") && !prompt.includes("Answer from") && !prompt.includes("Earlier rounds:")) text = `looking around\n[relay-question: Which name should the file get? Reply name=<x>]`;
else if (prompt.includes("Answer from") || prompt.includes("Earlier rounds:")) { const name = (prompt.match(/name=(\w+)/) ?? [])[1] ?? "none";
  writeFileSync("resumed.txt", `name=${name} resumed=${resumeId ?? (cont ? "continue" : "no")} original_prompt_again=${prompt.includes("FAKE-ASK") ? "yes" : "no"}\n`); text = `named it ${name}`; }
else { writeFileSync(`${bin}.txt`, `made by ${bin}\n`); text = `Wrote ${bin}.txt\nall done by ${bin}`; }
if (!events) { say(text); process.exit(0); }
if (bin === "codex") { say({ type: "thread.started", thread_id: sid }); say({ type: "turn.started" });
  say({ type: "item.started", item: { id: "i0", type: "command_execution", command: `bash -lc 'echo > ${bin}.txt'`, status: "in_progress" } });
  say({ type: "item.completed", item: { id: "i1", type: "agent_message", text } }); say({ type: "turn.completed", usage: {} }); }
else if (bin === "claude") { say({ type: "system", subtype: "init", session_id: sid, tools: [] });
  say({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: `${bin}.txt` } }] }, session_id: sid });
  say({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: sid }); say({ type: "result", subtype: "success", is_error: false, result: text, session_id: sid }); }
else if (bin === "grok") { say({ role: "user", content: prompt }); say({ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "create_file", arguments: JSON.stringify({ path: `${bin}.txt` }) } }] });
  say({ role: "tool", tool_call_id: "c1", content: "ok" }); say({ role: "assistant", content: text }); }
if (bin === "gemini") { say({ type: "init", session_id: sid, model: "fake" }); say({ type: "tool_use", tool_name: "write_file", tool_id: "t1", parameters: { file_path: `${bin}.txt` } });
  const h = Math.ceil(text.length / 2); say({ type: "message", role: "assistant", content: text.slice(0, h), delta: true }); say({ type: "message", role: "assistant", content: text.slice(h), delta: true });
  say({ type: "result", status: "success", stats: {} }); }
else if (bin === "cursor-agent") { say({ type: "system", subtype: "init", session_id: sid, model: "fake" }); say({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { writeToolCall: { args: { path: `${bin}.txt` } } }, session_id: sid });
  say({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: sid }); say({ type: "result", subtype: "success", is_error: false, result: text, session_id: sid }); }
else if (bin === "opencode") { say({ type: "step_start", timestamp: 1, sessionID: sid, part: { type: "step-start" } }); say({ type: "tool_use", timestamp: 2, sessionID: sid, part: { tool: "write", state: { status: "completed", input: { filePath: `${bin}.txt` } } } });
  say({ type: "text", timestamp: 3, sessionID: sid, part: { type: "text", text } }); say({ type: "step_finish", timestamp: 4, sessionID: sid, part: { type: "step-finish" } }); }
