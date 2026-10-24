// A stand-in for @anthropic-ai/claude-agent-sdk (client/live/claude.ts loads it through KITEBOOK_CLAUDE_SDK in unit tests and smoke).
// Same surface the driver uses: query() in streaming-input mode (system/init, assistant, result; interrupt; priority next/now), canUseTool,
// PreToolUse hooks, listSessions/forkSession. Sessions are files FAKE_CLAUDE_SDK_DIR/<id>.jsonl, one line per message the session saw,
// so a test can prove a fork never wrote to its source. Every query's options (minus callbacks) go to FAKE_CLAUDE_SDK_LOG.
// What a user message does:
//   "tool <name> <arg>"  PreToolUse hook, then canUseTool(name, {command: arg}); says "allowed <arg>" or "denied: <message>"
//   "slow"               says "working", then waits: a steer (next) is read in this turn ("steered: <text>"); a "now" steer restarts it
//                        (a result with queued_turn_count 1, then the new turn); interrupt() ends it with error_during_execution
//   "deaf"               says "working" and ignores steers until interrupt()
//   "LIVE_QUESTION <q>"  answers "[relay-question: <q>]" (the runner's needs_input marker)
//   anything else        "echo: <text>" (a steer that arrived first comes along in the same text)
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

const dir = () => { const d = process.env.FAKE_CLAUDE_SDK_DIR || join(process.env.TMPDIR || "/tmp", "fake-claude-sdk"); mkdirSync(d, { recursive: true }); return d; };
const file = (id: string) => join(dir(), `${id}.jsonl`);
const note = (x: any) => { const l = process.env.FAKE_CLAUDE_SDK_LOG; if (l) appendFileSync(l, JSON.stringify(x) + "\n"); };
const textOf = (m: any) => typeof m?.message?.content === "string" ? m.message.content : JSON.stringify(m?.message?.content ?? "");

export function query({ prompt, options = {} as any }: { prompt: AsyncIterable<any>; options?: any }) {
  const { canUseTool, hooks, stderr, spawnClaudeCodeProcess, ...plain } = options;
  const sid = options.resume ?? options.sessionId ?? randomUUID();
  note({ query: { ...plain, env: plain.env ? { keys: Object.keys(plain.env).sort(), ANTHROPIC_API_KEY: plain.env.ANTHROPIC_API_KEY ?? null } : null }, sid });
  if (options.resume && !existsSync(file(sid))) throw new Error(`No conversation found with session ID: ${sid}`);
  const save = (m: any) => appendFileSync(file(sid), JSON.stringify(m) + "\n");
  const out: any[] = []; let wake = null as (() => void) | null, closed = false;
  const say = (m: any) => { out.push(m); wake?.(); };
  let interrupted = false, pendingSteer: any[] = [], steerWake = null as (() => void) | null;
  const it = prompt[Symbol.asyncIterator]();
  // like the SDK: the host may spawn "claude" itself; when that process dies the stream fails with the exit code
  let failed: string | null = null, spawned = false;
  if (spawnClaudeCodeProcess) { const c = spawnClaudeCodeProcess({ command: options.pathToClaudeCodeExecutable ?? "claude", args: ["--output-format", "stream-json", "--input-format", "stream-json"], cwd: options.cwd, env: options.env ?? {}, signal: new AbortController().signal });
    c.on?.("exit", (code: number | null) => { failed = `Claude Code process exited with code ${code ?? 1}`; wake?.(); });
    c.on?.("error", (e: any) => { failed = `Failed to spawn Claude Code process: ${e?.message ?? e}`; wake?.(); }); c.on?.("spawn", () => { spawned = true; }); } else spawned = true;
  let cur: string | undefined, n0 = false;
  const result = (extra: any = {}) => say({ type: "result", subtype: "success", is_error: false, session_id: sid, result: "", num_turns: 1, ...(cur ? { user_message_uuid: cur } : {}), ...extra });
  // the "CLI": reads user messages; one in flight at a time, steers that arrive during a turn go to pendingSteer
  (async () => {
    n0 = true; say({ type: "system", subtype: "init", session_id: sid, cwd: options.cwd, permissionMode: options.permissionMode, capabilities: ["interrupt_receipt_v1"] });
    let busy = false; const queue: any[] = [];
    const turn = async (m: any) => {
      busy = true; cur = m.uuid; save({ type: "user", text: textOf(m) }); let text = textOf(m).trim();
      const pre = pendingSteer.splice(0).map(textOf).join(" | ");
      // smoke: the runner's whole prompt carries one directive (LIVE-WRITE | LIVE-SLOW | LIVE-TOOL <cmd> | LIVE-QUESTION <q>), or the sender's answer
      const ans = text.match(/Answer from [^\n]*:\n([^\n]*)/), L = ans ? null : text.match(/LIVE-(WRITE|SLOW|TOOL|QUESTION)(?: ([^\n]*))?/);
      const put = (s: string) => { if (options.cwd) writeFileSync(join(options.cwd, "live-claude.txt"), s + "\n"); };
      const hook = async (name: string, input: any) => { for (const h of hooks?.PreToolUse ?? []) for (const f of h.hooks) await f({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: "tu_" + randomUUID() }, undefined, { signal: new AbortController().signal }); };
      const reply = (s: string) => say({ type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "text", text: s }] } });
      if (ans) { await hook("Write", { file_path: "live-claude.txt" }); put(`name=${ans[1].trim()} resumed=${sid} turns=${readFileSync(file(sid), "utf8").split("\n").filter(l => l.includes('"user"')).length}`); reply("all done by live claude (answer)"); result(); save({ type: "assistant" }); busy = false; return; }
      if (L?.[1] === "WRITE") { await hook("Write", { file_path: "live-claude.txt" }); put(`made by live claude session=${sid}`); reply("all done by live claude"); result(); save({ type: "assistant" }); busy = false; return; }
      if (L?.[1] === "QUESTION") text = `LIVE_QUESTION ${L[2] ?? "?"}`;
      if (L?.[1] === "SLOW") text = "slow";
      if (L?.[1] === "TOOL") text = `tool Bash ${L[2] ?? ""}`;
      if (text.startsWith("tool ")) { const [, name, ...arg] = text.split(" "), input: any = name === "Edit" ? { file_path: arg.join(" "), old_string: "a", new_string: "b" } : { command: arg.join(" ") };
        for (const h of hooks?.PreToolUse ?? []) for (const f of h.hooks) await f({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: "tu_" + randomUUID() }, undefined, { signal: new AbortController().signal });
        const r = canUseTool ? await canUseTool(name, input, { signal: new AbortController().signal, requestId: "req_" + randomUUID(), toolUseID: "tu1", title: `Claude wants to ${input.command ? "run " + input.command : "edit " + input.file_path}` }) : { behavior: "allow" };
        note({ permission: { tool: name, ...r } }); if (L) put(`tool=${r.behavior}`);
        say({ type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "text", text: r.behavior === "allow" ? `allowed ${input.command ?? input.file_path}` : `denied: ${r.message}` }] } }); result(); }
      else if (text === "deaf") { // works until interrupted and never reads steers (they stay queued: interrupt must withdraw them)
        say({ type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "text", text: "working" }] } });
        while (!interrupted) await new Promise(r => setTimeout(r, 20)); interrupted = false;
        say({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sid, user_message_uuid: cur, errors: ["interrupted by the user"], ...(pendingSteer.length ? { queued_turn_count: pendingSteer.length } : {}) }); }
      else if (text === "slow") { say({ type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "text", text: "working" }] } });
        while (!interrupted && !pendingSteer.length) await new Promise<void>(r => { steerWake = r; setTimeout(r, 50); });
        if (interrupted) { interrupted = false; say({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sid, user_message_uuid: cur, errors: ["interrupted by the user"] }); }
        else { const st = pendingSteer.shift(); const now = st.priority === "now";
          if (now) { result({ queued_turn_count: 1 }); say({ type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "text", text: `redirected: ${textOf(st)}` }] } }); }
          else { say({ type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "text", text: `steered: ${textOf(st)}` }] } }); if (L) put(`steer=${textOf(st).replace(/\s+/g, " ").slice(0, 300)}`); }
          save({ type: "user", text: textOf(st) }); result(); } }
      else if (text.startsWith("LIVE_QUESTION ")) { say({ type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "text", text: `[relay-question: ${text.slice(14)}]` }] } }); result(); }
      else { say({ type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "text", text: `echo: ${pre ? pre + " | " : ""}${text}` }] } }); result(); }
      save({ type: "assistant" }); busy = false; if (queue.length) turn(queue.shift());
    };
    while (true) { const n = await it.next(); if (n.done) break; const m = n.value;
      if (busy && (m.priority === "next" || m.priority === "now")) { pendingSteer.push(m); steerWake?.(); continue; }
      if (busy) queue.push(m); else turn(m); }
    while (busy) await new Promise(r => setTimeout(r, 20));
    closed = true; wake?.();
  })().catch(e => { stderr?.(String(e)); closed = true; wake?.(); });
  const gen = (async function* () { while (true) { if (out.length) { yield out.shift(); continue; } if (failed) throw new Error(failed); if (closed) return; await new Promise<void>(r => { wake = r; }); wake = null; } })() as any;
  const init = new Promise<any>((ok, no) => { const w = setInterval(() => { if (failed) { clearInterval(w); no(new Error(failed)); return; } if (spawned && n0) { clearInterval(w); ok({ commands: [] }); } if (failed) { clearInterval(w); no(new Error(failed)); } }, 10); });
  gen.initializationResult = () => init;
  gen.cancelAsyncMessage = async (uuid: string) => { const i = pendingSteer.findIndex(x => x.uuid === uuid); if (i < 0) return false; pendingSteer.splice(i, 1); note({ withdrawn: uuid }); return true; };
  gen.interrupt = async () => { interrupted = true; steerWake?.(); return { pending: [] }; };
  gen.close = () => { closed = true; wake?.(); };
  return gen;
}
export async function listSessions(o: { dir?: string; limit?: number } = {}) {
  return readdirSync(dir()).filter(f => f.endsWith(".jsonl")).map(f => { const id = f.slice(0, -6), first = readFileSync(file(id), "utf8").split("\n")[0];
    return { sessionId: id, summary: first ? (JSON.parse(first).text ?? id) : id, lastModified: statSync(file(id)).mtimeMs, cwd: o.dir }; }).slice(0, o.limit ?? 50);
}
export async function forkSession(id: string, o: { upToMessageId?: string; title?: string } = {}) {
  if (!existsSync(file(id))) throw new Error(`no session ${id}`); const n = randomUUID(); copyFileSync(file(id), file(n)); note({ fork: { from: id, to: n, upTo: o.upToMessageId ?? null } }); return { sessionId: n };
}
export const fakeSession = (id: string, lines: any[]) => writeFileSync(file(id), lines.map(l => JSON.stringify(l)).join("\n") + "\n"); // tests: an owner's session

// `bun scripts/fake-claude-sdk.ts install <dir>`: a stand-in `claude` for the live driver (KITEBOOK_CLAUDE_BIN): --version, `agents --json`
// (nobody holds a session), and otherwise a process that lives until its input ends (the fake SDK does the talking)
if (import.meta.main && process.argv[2] === "install") { const d = process.argv[3]; mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "claude"), `#!/bin/sh\ncase "$1" in --version) echo "2.1.309 (Claude Code)";; agents) echo '[]';; *) exec cat >/dev/null;; esac\n`, { mode: 0o755 }); }
