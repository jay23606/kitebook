// Coding agents with checked adapters: Codex, Claude Code (G8 fix-agents), Gemini CLI, Cursor (cursor-agent), GitHub Copilot CLI, opencode
// and Grok CLI, next to Pi (its own preset in setup.ts). Each adapter says how its CLI runs headless in the task's worktree. CLI flags drift
// between versions (Codex dropped --full-auto and every task exited 2), so the runner reads each installed CLI's --help once at startup
// (probeHelp) and builds the argv only from flags that help lists:
//   need     flags the task run can't do without; missing -> the agent isn't offered for tasks, and `issue` says why and how to fix it
//   opt      extras (trust a fresh worktree, always-approve, no questions) added only when listed
//   events   a JSON event stream (live tool lines + the agent's session id) when listed; else plain text (stdout is the answer).
//            eventsWhen: a CLI that always prints JSON lines (the community grok-cli), recognised by its --help
//   first    flags for a task's FIRST turn only (a session id Kitebook picks: {tasksid}, a UUID derived from the task id, stable across restarts)
//   resume   later turns of ONE task (the sender's answer, a steering note, a self-repair round) continue the same agent session when
//            listed; {sid} is the session id captured from the event stream, {tasksid} the one `first` set. Without it the agent gets the
//            original prompt again.
//   ask      a read-only mode for quick asks when listed (ask.opt: extra lock-down flags when listed); else the agent still answers,
//            behind the before/after git check (and the OS read-only sandbox where there is one, client/runner-ask.ts)
// Flags come from each CLI's own documentation and were checked against the real binaries' --help (2026-10, links in docs/agents.md;
// scripts/agents-help-check.ts runs build() on the real --help in CI). Smoke checks the argv against fake CLIs whose --help prints exactly
// those flags and which refuse any other (scripts/fake-agents.ts). Pure: no runner state, so tests and agents-connect.ts import it directly.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import * as PL from "./platform.ts";

export type Ev = { line?: string; text?: string; delta?: string; sid?: string; err?: string };
export type Adapter = {
  label: string; bin: string; helpArgv?: string[];      // helpArgv: where the run flags are listed (opencode: `opencode run --help`, codex: `codex exec --help`)
  task: string[]; promptFlag?: string; need: string[]; opt?: string[][]; modelFlag: string;
  events?: { flags: string[]; parse: (e: any) => Ev }; eventsWhen?: RegExp; first?: string[]; resume?: string[]; askBase?: string[];
  ask?: { flags: string[]; need: string[]; opt?: string[][] }; install: string;
};
const s = (x: any, n = 160) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const txt = (c: any): string => typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";
const argsOf = (a: any) => s(a?.command ?? a?.path ?? a?.file_path ?? a?.filePath ?? a?.pattern ?? a?.query ?? (a ? JSON.stringify(a) : ""));
const jsonArgs = (a: any) => { if (typeof a !== "string") return argsOf(a); try { return argsOf(JSON.parse(a)); } catch { return s(a); } };

export const ADAPTERS: Record<string, Adapter> = {
  // https://developers.openai.com/codex/noninteractive: `codex exec` runs with approvals off; --full-auto "is no longer supported" (codex 0.163
  // exits 2 on it), --sandbox workspace-write is its replacement. --json: JSONL events (thread.started carries the thread id that
  // `codex exec ... resume <id> "<prompt>"` continues). --skip-git-repo-check: machine tasks run outside a git checkout.
  codex: { label: "Codex", bin: "codex", helpArgv: ["codex", "exec", "--help"], task: ["exec", "--sandbox", "workspace-write"], need: ["--sandbox"], opt: [["--skip-git-repo-check"]], modelFlag: "-m",
    events: { flags: ["--json"], parse: e => {
      if (e.type === "thread.started") return { sid: e.thread_id };
      const it = e.item ?? {};
      if (e.type === "item.started" && it.type === "command_execution") return { line: `→ $ ${s(it.command)}` };
      if (e.type === "item.completed" && it.type === "agent_message") return { text: String(it.text ?? "") };
      if (e.type === "item.completed" && it.type === "file_change") return { line: `→ edit ${s((it.changes ?? []).map((c: any) => c.path).join(" "))}` };
      if (e.type === "item.completed" && it.type === "command_execution" && it.exit_code) return { line: `✗ exit ${it.exit_code}: ${s(it.command)}` };
      if (e.type === "turn.failed") return { err: s(e.error?.message ?? "turn failed", 400) };
      if (e.type === "error") return { line: `error: ${s(e.message)}` };
      return {}; } },
    resume: ["resume", "{sid}"], askBase: ["exec"], ask: { flags: ["--sandbox", "read-only"], need: ["--sandbox"] }, install: "npm i -g @openai/codex" },
  // https://docs.claude.com/en/docs/claude-code/cli-reference: -p with --output-format stream-json needs --verbose; system/init carries the
  // session id that --resume continues. Quick asks use the warm stream-json preset in client/runner-ask.ts.
  claude: { label: "Claude Code", bin: "claude", task: ["-p", "--permission-mode", "acceptEdits"], need: ["-p", "--permission-mode"], modelFlag: "--model",
    events: { flags: ["--output-format", "stream-json", "--verbose"], parse: e => {
      if (e.type === "system" && e.subtype === "init") return { sid: e.session_id };
      if (e.type === "assistant") { const c = Array.isArray(e.message?.content) ? e.message.content : [], tools = c.filter((b: any) => b?.type === "tool_use");
        return { text: txt(c), ...(tools.length ? { line: tools.map((b: any) => `→ ${b.name} ${argsOf(b.input)}`).join("\n") } : {}), sid: e.session_id }; }
      if (e.type === "result") return e.is_error ? { err: s(e.result ?? e.subtype, 400), sid: e.session_id } : { sid: e.session_id };
      return {}; } },
    resume: ["--resume", "{sid}"], askBase: ["-p"], ask: { flags: ["--permission-mode", "plan"], need: ["--permission-mode"] }, install: "npm i -g @anthropic-ai/claude-code" },
  // https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md + headless.md
  gemini: { label: "Gemini CLI", bin: "gemini", task: ["--approval-mode", "yolo"], promptFlag: "--prompt", need: ["--approval-mode", "--prompt"], opt: [["--skip-trust"]], modelFlag: "--model",
    events: { flags: ["--output-format", "stream-json"], parse: e => {
      if (e.type === "init") return { sid: e.session_id };
      if (e.type === "message" && e.role === "assistant") return e.delta ? { delta: String(e.content ?? "") } : { text: String(e.content ?? "") };
      if (e.type === "tool_use") return { line: `→ ${e.tool_name} ${argsOf(e.parameters)}` };
      if (e.type === "tool_result" && e.status && e.status !== "success") return { line: `✗ tool failed: ${s(e.error?.message ?? e.output)}` };
      if (e.type === "error") return { line: `error: ${s(e.message)}` };
      if (e.type === "result" && e.status && e.status !== "success") return { err: s(e.error?.message ?? e.status, 400) };
      return {}; } },
    resume: ["--resume", "{sid}"], ask: { flags: ["--approval-mode", "plan"], need: ["plan"] }, install: "npm i -g @google/gemini-cli" },
  // https://cursor.com/docs/cli/reference/parameters.md + output-format.md. Never fall back to a bare `agent` binary: Grok installs one too.
  cursor: { label: "Cursor", bin: "cursor-agent", task: ["--print", "--force"], need: ["--print", "--force"], opt: [["--trust"]], modelFlag: "--model",
    events: { flags: ["--output-format", "stream-json"], parse: e => {
      if (e.type === "system" && e.subtype === "init") return { sid: e.session_id };
      if (e.type === "assistant") return { text: txt(e.message?.content), sid: e.session_id };
      if (e.type === "tool_call" && e.subtype === "started") { const k = Object.keys(e.tool_call ?? {})[0] ?? "tool", c = e.tool_call?.[k] ?? {};
        return { line: `→ ${k === "function" && c.name ? c.name : k.replace(/ToolCall$/, "")} ${argsOf(c.args ?? (c.arguments ? { command: c.arguments } : null))}` }; }
      if (e.type === "result") return e.is_error ? { err: s(e.result, 400), sid: e.session_id } : { sid: e.session_id };
      return {}; } },
    resume: ["--resume", "{sid}"], askBase: ["--print"], ask: { flags: ["--mode", "ask"], need: ["--mode"] }, install: "curl https://cursor.com/install -fsS | bash" },
  // https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference. Plain text, kept clean with --silent (no stats
  // footer or resume hint). --continue was dropped: it falls back to the Mac's globally newest session (another task, the owner's own chat)
  // when the worktree has none. Every turn passes --session-id {tasksid} instead ("resume an existing session by ID, or set the UUID for a
  // new session"), so a later turn can only ever continue this task's own session. --no-ask-user: a -p run never blocks on a question.
  copilot: { label: "GitHub Copilot CLI", bin: "copilot", task: ["--allow-all-tools"], promptFlag: "--prompt", need: ["--allow-all-tools", "--prompt"],
    opt: [["--no-ask-user"], ["--silent"], ["--no-auto-update"]], modelFlag: "--model", first: ["--session-id", "{tasksid}"], resume: ["--session-id", "{tasksid}"],
    // read-only ask: --allow-all-tools is required headless, and deny rules win over it; --disable-builtin-mcps keeps its github server out
    ask: { flags: ["--allow-all-tools", "--deny-tool", "write", "--deny-tool", "shell", "--deny-tool", "url", "--deny-tool", "memory"], need: ["--deny-tool", "--allow-all-tools"], opt: [["--disable-builtin-mcps"]] },
    install: "npm i -g @github/copilot" },
  // https://opencode.ai/docs/cli/ (run: --format json events carry sessionID; --session continues it)
  opencode: { label: "opencode", bin: "opencode", helpArgv: ["opencode", "run", "--help"], task: ["run"], need: ["--model"], modelFlag: "--model",
    events: { flags: ["--format", "json"], parse: e => {
      const sid = e.sessionID;
      if (e.type === "text") return { text: String(e.part?.text ?? ""), sid };
      if (e.type === "tool_use") return { line: `${e.part?.state?.status === "error" ? "✗" : "→"} ${e.part?.tool ?? "tool"} ${argsOf(e.part?.state?.input)}`, sid };
      if (e.type === "error") return { line: `error: ${s(e.error?.data?.message ?? e.error?.name ?? e.error)}`, sid };
      return { sid }; } },
    resume: ["--session", "{sid}"], askBase: ["run"], ask: { flags: ["--agent", "plan"], need: ["--agent"] }, install: "npm i -g opencode-ai" },
  // Two CLIs answer to `grok`. xAI's Grok Build (https://docs.x.ai/build/cli/headless-scripting): -p, --always-approve, read-only
  // --permission-mode plan, -s/--session-id <uuid> names a NEW session (first turn) and -r/--resume <uuid> continues it (later turns).
  // The community grok-cli ("powered by Grok" in its --help): -p runs tools by itself and prints one OpenAI-style JSON message per line
  // (user, assistant with tool_calls, tool), which is parsed so the answer and [relay-question: ...] lines come out as text; no read-only
  // mode or resume, so its quick asks go through the git check and later turns get the prompt again.
  grok: { label: "Grok CLI", bin: "grok", task: [], promptFlag: "-p", need: ["-p"], opt: [["--always-approve"]], modelFlag: "-m",
    events: { flags: [], parse: e => {
      if (e.role !== "assistant") return {};
      const tools = (e.tool_calls ?? []).map((t: any) => `→ ${t.function?.name ?? "tool"} ${jsonArgs(t.function?.arguments)}`);
      return { text: typeof e.content === "string" ? e.content : txt(e.content), ...(tools.length ? { line: tools.join("\n") } : {}) }; } },
    eventsWhen: /powered by Grok/i, first: ["--session-id", "{tasksid}"], resume: ["--resume", "{tasksid}"],
    ask: { flags: ["--permission-mode", "plan"], need: ["--permission-mode"] }, install: "curl -fsSL https://x.ai/cli/install.sh | bash" },
};
export const isAdapter = (n: string) => Object.hasOwn(ADAPTERS, n);

// A flag is listed when --help shows it as a whole word ("--mode <mode>", "-p, --prompt", "choices: ... plan").
export const listed = (help: string, flag: string) => new RegExp(`(^|[\\s,=\\[("'|])${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s,=\\])"'|<:.])`, "m").test(help);
export type Built = { argv: string[]; json: boolean; events: string | null; first: string[] | null; resume: string[] | null; ask: string[] | null; askReadOnly: boolean; askEvents: string | null;
  issue: string | null; missing: string[] };
// What the runner runs, from the adapter and the CLI's --help (null help = not probed: the documented flags, nothing optional).
// argv keeps {prompt}, {model} (dropped with its flag when no model), and {resume} (expanded by buildArgv: `first` on a task's first turn,
// `resume` on later ones; {sid} = captured session id, {tasksid} = the UUID Kitebook derived from the task id).
export function build(name: string, help: string | null): Built {
  const a = ADAPTERS[name], has = (f: string) => help == null ? false : listed(help, f);
  const missing = help == null ? [] : a.need.filter(f => !has(f));
  const opt = (a.opt ?? []).filter(o => has(o[0])).flat();
  // "--output-format" and its "stream-json" value both listed; a CLI that always prints JSON (no flag) only when its --help says which CLI it is
  const evOn = !!a.events && (a.events.flags.length ? a.events.flags.every(has) : !!help && !!a.eventsWhen?.test(help)), ev = evOn ? a.events!.flags : [];
  const pre = [a.bin, ...a.task, ...opt, ...ev, a.modelFlag, "{model}", "{resume}"];
  const argv = [...pre, ...(a.promptFlag ? [a.promptFlag] : []), "{prompt}"];
  const first = a.first && has(a.first[0]) ? a.first : null;
  // a {tasksid} resume continues the session `first` named, so it needs both flags; a {sid} resume needs the event stream that carries the id
  const resume = !a.resume || !has(a.resume[0]) ? null : a.resume.some(x => x.includes("{tasksid}")) ? (first ? a.resume : null) : a.resume.some(x => x.includes("{sid}")) && !evOn ? null : a.resume;
  const ro = !!a.ask && a.ask.need.every(has), askOpt = ro ? (a.ask!.opt ?? []).filter(o => has(o[0])).flat() : [];
  const ask = [a.bin, ...(a.askBase ?? []), ...opt.filter(f => f !== "--always-approve"), ...(ro ? [...a.ask!.flags, ...askOpt] : []), a.modelFlag, "{model}", ...(a.promptFlag ? [a.promptFlag] : []), "{prompt}"];
  return { argv, json: evOn, events: evOn ? name : null, first, resume, ask, askReadOnly: ro, askEvents: evOn && !ev.length ? name : null,
    issue: missing.length ? `${a.label} on this computer doesn't list ${missing.join(", ")} in \`${(a.helpArgv ?? [a.bin, "--help"]).join(" ")}\`, so Kitebook can't run it headless; update it (${a.install})` : null, missing };
}
// The session id Kitebook picks for a task ({tasksid}): a UUID (v5 layout) from a hash of the task id, so a restarted runner picks the same one.
export function taskUuid(id: string): string {
  const h = new Bun.CryptoHasher("sha256").update("kitebook-task:" + id).digest("hex").slice(0, 32).split("");
  h[12] = "5"; h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16); const x = h.join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
// Read each installed adapter CLI's --help (15 s cap each, in parallel). Returns name -> help text (stdout + stderr) for those found.
export async function probeHelp(which: (b: string) => string | null, env: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(Object.entries(ADAPTERS).filter(([, a]) => which(a.bin)).map(async ([n, a]) => { try {
    const p = PL.spawn(a.helpArgv ?? [a.bin, "--help"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env }); const kill = setTimeout(() => p.kill(), 15000);
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); clearTimeout(kill); out[n] = (o + "\n" + e).slice(0, 200_000); } catch {} }));
  return out;
}
// One event line from an adapter's stream: what to show live, what the agent said, and its session id.
export function parseEvent(name: string, line: string): Ev | null {
  let e: any; try { e = JSON.parse(line); } catch { return null; } if (!e || typeof e !== "object") return null;
  try { return ADAPTERS[name]?.events?.parse(e) ?? {}; } catch { return {}; }
}
