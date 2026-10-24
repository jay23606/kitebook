// live-claude: Claude Code held open for a whole task through the Claude Agent SDK (@anthropic-ai/claude-agent-sdk), instead of one
// `claude -p` process per turn. One query() per task in streaming-input mode: turns, steering (priority next/now), interrupt and
// approvals all flow over the same child. Research and sources: docs/agents.md "Live Claude Code" (code.claude.com/docs/en/agent-sdk/*).
//   - The SDK is an OPTIONAL dependency, loaded with a dynamic import. Not installed (or too old a `claude`, or a failed handshake) ->
//     available()/start() say no and the runner keeps today's CLI adapter (client/agent-adapters.ts), so the owner sees no difference.
//   - It drives the OWNER's own `claude` (pathToClaudeCodeExecutable): one version, one login, one config. Kitebook never sees or keeps
//     a Claude credential. ANTHROPIC_API_KEY is stripped from the child env unless runner.json "claudeApiKey": true, because a stray key
//     silently moves the owner from their plan to API billing.
//   - permissionMode acceptEdits (as today; plan for read-only). canUseTool fires only for what Claude Code would prompt for; each ask
//     becomes a LiveEvent {approval} the runner routes through Kitebook's approval policy, and Kitebook's own timeout denies (Claude Code's
//     prompts never time out). A PreToolUse hook gives the live log a line per tool call, including calls that never prompt.
//   - Sessions: an owner's session is always FORKED (forkSession), never written to. An in-place resume happens only when
//     `claude agents --json` answers and no live process holds that session; anything else (held, unknown, older CLI) forks.
//   - Lessons from Paseo (getpaseo/paseo, Apache-2.0, which drives the same SDK in production; ideas only, no code copied): spawn the child
//     ourselves (spawnClaudeCodeProcess) so the runner has its pid for the guard's kill switch and sees it die BETWEEN turns too; tag every
//     user message with a uuid so a late result from an interrupted request can't end the next turn; withdraw queued steers
//     (cancelAsyncMessage, when the SDK has it) before interrupting so a steer can't revive the stopped turn.
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { LiveDriver, LiveSession, LiveEvent, ApprovalAsk, LiveStart } from "./live-driver.ts";
import { cfg, log as rlog } from "./runner-ctx.ts";
import * as PL from "./platform.ts";

export const CLAUDE_MIN = [2, 1, 199]; // canUseTool requestId + async answers (research: claude-live.md); older -> the CLI adapter
export const SDK_PKG = "@anthropic-ai/claude-agent-sdk";
export const APPROVAL_TIMEOUT_MS = 10 * 60_000; // a backstop only: the runner's own liveApprovalSec answers first (runner.ts liveApprove)
const HANDSHAKE_MS = 60_000;

export type ClaudeDeps = {
  claude: () => string | null;                       // the owner's `claude` (Bun.which on the agents' PATH); null -> not available
  version?: (bin: string) => Promise<string | null>; // `claude --version`
  agents?: (bin: string) => Promise<any[] | null>;   // `claude agents --json`; null = couldn't tell (old CLI, error)
  sdk?: () => Promise<any>;                          // the SDK module; default: dynamic import (KITEBOOK_CLAUDE_SDK names a module path, for tests)
  apiKey?: () => boolean;                            // runner.json "claudeApiKey": true keeps ANTHROPIC_API_KEY in the child env
  approvalTimeoutMs?: () => number;
  log?: (...a: any[]) => void;
};

const s = (x: any, n = 160) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const argsOf = (a: any) => s(a?.command ?? a?.file_path ?? a?.path ?? a?.pattern ?? a?.url ?? a?.query ?? (a ? JSON.stringify(a) : ""));
const textOf = (c: any): string => typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";
export const newer = (v: string | null, min = CLAUDE_MIN) => { const m = v?.match(/(\d+)\.(\d+)\.(\d+)/); if (!m) return false;
  for (let i = 0; i < 3; i++) { const d = Number(m[i + 1]) - min[i]; if (d) return d > 0; } return true; };

// A push queue read as the query's prompt iterable: the SDK pulls the next user message whenever Claude Code is ready for it.
class Inbox<T> implements AsyncIterable<T> {
  private q: T[] = []; private wait: ((r: IteratorResult<T>) => void) | null = null; private ended = false;
  push(x: T) { if (this.ended) return; if (this.wait) { const w = this.wait; this.wait = null; w({ value: x, done: false }); } else this.q.push(x); }
  end() { this.ended = true; if (this.wait) { const w = this.wait; this.wait = null; w({ value: undefined as any, done: true }); } }
  [Symbol.asyncIterator](): AsyncIterator<T> { return { next: () => this.q.length ? Promise.resolve({ value: this.q.shift()!, done: false })
    : this.ended ? Promise.resolve({ value: undefined as any, done: true }) : new Promise(r => { this.wait = r; }) }; }
}

// the child env: the runner's (already an allowlist: agentEnv + the guard's shims), minus the API key unless the owner opted in
export function childEnv(env: Record<string, string> | undefined, keepKey: boolean): Record<string, string> {
  const e: Record<string, string> = { ...(env ?? (process.env as Record<string, string>)) };
  if (!keepKey) delete e.ANTHROPIC_API_KEY;
  e.CLAUDE_AGENT_SDK_CLIENT_APP = "kitebook"; return e;
}

// Where the SDK may be: KITEBOOK_CLAUDE_SDK (tests), next to Kitebook (node_modules), or ~/.kitebook/live, where docs/agents.md installs it:
// `npm i --prefix ~/.kitebook/live --omit=optional @anthropic-ai/claude-agent-sdk` (outside the checkout, so updates and npm installs
// don't touch it; --omit=optional skips the SDK's bundled Claude Code binary, since the owner's own `claude` is used). It is not in
// package.json on purpose: proprietary terms, and most owners don't need it.
export const SDK_HOME = join(homedir(), ".kitebook", "live", "node_modules", ...SDK_PKG.split("/"), "sdk.mjs");
let sdkMod: Promise<any> | null = null;
const loadSdk = () => sdkMod ??= (async () => { for (const s of [process.env.KITEBOOK_CLAUDE_SDK, SDK_PKG, existsSync(SDK_HOME) ? SDK_HOME : null]) if (s) { // variable specifiers: bundles don't require it
  try { const m = await import(s); if (typeof m?.query === "function") return m; } catch {} } return null; })();

export function claudeDriver(d: ClaudeDeps): LiveDriver {
  const sdk = d.sdk ?? loadSdk, log = d.log ?? (() => {});
  let ok: Promise<boolean> | null = null, why: string | null = null;
  const driver: LiveDriver & { held(id: string): Promise<boolean | null> } = {
    agent: "claude", forks: true, // forkSession: session_send forks of the owner's Claude sessions go through it (an SDK without it throws at
                                  // start, and the runner seeds the copy instead, client/runner.ts)
    available() { return ok ??= (async () => { const bin = d.claude(); if (!bin) { why = "claude isn't on the agents' PATH"; return false; }
      const m = await sdk(); if (typeof m?.query !== "function") { why = `${SDK_PKG} isn't installed (docs/agents.md, Live Claude Code)`; return false; }
      const v = d.version ? await d.version(bin) : null; if (d.version && !newer(v)) { why = `claude ${v ?? "?"} is older than ${CLAUDE_MIN.join(".")}`; return false; }
      return true; })().catch((e: any) => { why = String(e?.message ?? e); return false; }); },
    why: () => why,
    // true = a live process holds it, false = free, null = couldn't tell
    async held(id: string) { const bin = d.claude(); const a = bin && d.agents ? await d.agents(bin).catch(() => null) : null;
      if (!Array.isArray(a)) return null; return a.some(x => x?.sessionId === id && Number(x.pid) > 0 && !/stop|exit|dead|done|fail/i.test(`${x.status ?? ""}`)); },
    async listSessions(o) { const m = await sdk(); if (typeof m?.listSessions !== "function") return [];
      const r: any[] = await m.listSessions({ ...(o.cwd ? { dir: o.cwd } : {}), limit: o.limit ?? 50 });
      return r.map(x => ({ id: x.sessionId, title: s(x.customTitle || x.summary || x.firstPrompt || x.sessionId, 200), cwd: x.cwd ?? o.cwd ?? "", updatedAt: Number(x.lastModified) || 0 })); },
    async start(o: LiveStart) {
      const m = await sdk(), bin = d.claude(); if (typeof m?.query !== "function" || !bin) throw new Error("live claude unavailable");
      // which session: a fork of someone's session (never written to), an in-place resume only when nobody holds it, else a fresh one
      let sid: string, resume: string | undefined;
      const forkOf = async (from: string, upTo?: string) => { if (typeof m.forkSession !== "function") throw new Error("this Agent SDK can't fork sessions");
        const f = await m.forkSession(from, { dir: o.cwd, ...(upTo ? { upToMessageId: upTo } : {}), title: "Kitebook task (fork)" }); return String(f.sessionId); };
      if (o.fork) { sid = resume = await forkOf(o.fork.from, o.fork.upTo); log("live claude: forked", o.fork.from, "->", sid); }
      else if (o.resume) { const h = await driver.held(o.resume);
        if (h === false) sid = resume = o.resume;
        else { sid = resume = await forkOf(o.resume); log(`live claude: session ${o.resume} ${h ? "is open in another claude" : "may be open (claude agents --json didn't answer)"}; forked to`, sid); } }
      else sid = randomUUID();
      const ss = session(m, { bin, sid, resume, o, keepKey: !!d.apiKey?.(), timeout: d.approvalTimeoutMs?.() ?? APPROVAL_TIMEOUT_MS, log });
      // the handshake now, not at the first prompt: a claude that can't start (old, logged out, broken install) throws here, and the runner
      // runs this very turn with claude -p instead (liveBroken)
      try { await Promise.race([ss.ready, Bun.sleep(HANDSHAKE_MS).then(() => { throw new Error("claude didn't finish its handshake in 60 s"); })]); }
      catch (e) { await ss.close().catch(() => {}); throw e; }
      return ss;
    },
  };
  return driver;
}

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// The paths a tool ask touches, for the runner's "inside the worktree" rule. Claude's blockedPath (the path its own permission check
// flagged, e.g. where a symlink or a "../" really leads) always counts, next to the input's path: every one must be inside to pass unasked.
export const askPaths = (tool: string, input: any, opt: any): string[] | undefined => {
  const fp = input?.file_path ?? input?.notebook_path, ps = [...(opt?.blockedPath ? [String(opt.blockedPath)] : []), ...(EDITS.has(tool) && fp ? [String(fp)] : [])];
  return ps.length ? [...new Set(ps)] : undefined; };
function session(m: any, x: { bin: string; sid: string; resume?: string; o: LiveStart; keepKey: boolean; timeout: number; log: (...a: any[]) => void }): LiveSession & { ready: Promise<unknown> } {
  const inbox = new Inbox<any>();
  let turn: Inbox<LiveEvent> | null = null, mine = new Set<string>(), dead: string | null = null, stopping = false, stderr = "", early: string[] = [], pid: number | null = null, child: any = null;
  const asks = new Map<string, { ask: ApprovalAsk; raw: any; done: (r: any) => void; p: Promise<any> }>();
  const emit = (e: LiveEvent) => { turn?.push(e); };
  const endTurn = (e?: LiveEvent) => { const t = turn; if (!t) return; turn = null; mine = new Set(); if (e) t.push(e); t.push({ done: true, ...(stopping ? { interrupted: true } : {}) }); stopping = false; t.end();
    for (const [id, a] of asks) { a.done({ behavior: "deny", message: "the turn ended before Kitebook got an answer" }); asks.delete(id); } };
  const die = (why: string) => { if (dead) return; dead = why + (stderr.trim() ? ` (${s(stderr, 300)})` : ""); x.log("live claude:", dead); endTurn({ err: dead }); inbox.end(); };
  const user = (text: string, priority?: "next" | "now") => { const uuid = randomUUID(); mine.add(uuid);
    return { type: "user", uuid, message: { role: "user", content: text }, parent_tool_use_id: null, client_composed: true,
      ...(priority ? { priority } : {}), ...(priority === "now" ? { origin: { kind: "human" } } : {}) }; };
  // canUseTool: Claude Code would prompt -> one Kitebook approval; idempotent per request id (reinitialize() re-sends pending asks)
  const canUseTool = (tool: string, input: any, opt: any) => {
    // Claude's own clarifying question has no answer channel mid-turn here: Kitebook's is the needs_input marker (the task parks, the sender answers)
    if (tool === "AskUserQuestion") return Promise.resolve({ behavior: "deny", message: "Questions go through Kitebook: if you can't continue without an answer, end your turn with one line [relay-question: <your question>]. Otherwise make a sensible choice and say so." });
    const id = String(opt?.requestId ?? opt?.toolUseID ?? randomUUID()), have = asks.get(id); if (have) return have.p;
    if (!turn) return Promise.resolve({ behavior: "deny", message: "no Kitebook turn is running" });
    let done!: (r: any) => void; const p = new Promise<any>(r => { done = r; });
    // in the runner's words: file edits are "file_change" with their paths (inside the worktree they're allowed), Bash is "command"
    const paths = askPaths(tool, input, opt);
    const ask: ApprovalAsk = { id, tool: EDITS.has(tool) ? "file_change" : tool === "Bash" ? "command" : tool, summary: s(opt?.title || `${tool} ${argsOf(input)}`, 400) + (opt?.blockedPath ? ` (outside the folder: ${s(opt.blockedPath, 200)})` : ""),
      input: { tool, ...input }, ...(paths ? { paths } : {}) };
    const timer = setTimeout(() => { if (asks.delete(id)) { emit({ line: `✗ ${tool}: no answer in ${Math.max(1, Math.round(x.timeout / 60000))} min, denied` }); done({ behavior: "deny", message: "Kitebook approval timed out: the owner didn't answer, so this is denied. Continue without it, or say in your summary that it was needed." }); } }, x.timeout);
    const fin = (r: any) => { clearTimeout(timer); asks.delete(id); done(r); };
    opt?.signal?.addEventListener?.("abort", () => fin({ behavior: "deny", message: "cancelled" }));
    asks.set(id, { ask, raw: input, done: fin, p }); emit({ approval: ask }); return p;
  };
  const hooks = { PreToolUse: [{ hooks: [async (i: any) => { if (i?.hook_event_name === "PreToolUse") emit({ line: `→ ${i.tool_name} ${argsOf(i.tool_input)}` }); return {}; }] }] };
  // our own spawn: its own process group (the runner's kill switch takes the tree), stderr kept for errors, and an exit between turns is seen
  const spawnClaudeCodeProcess = (o: any) => {
    const argv = x.o.wrap ? x.o.wrap([o.command, ...o.args]) : [o.command, ...o.args]; // quick asks: inside Kitebook's OS sandbox
    child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", signal: o.signal, windowsHide: true });
    pid = child.pid ?? null; child.stderr?.on("data", (b: any) => { stderr = (stderr + String(b)).slice(-2000); });
    child.on("exit", (code: number | null, sig: string | null) => setTimeout(() => die(`claude exited (${sig ?? `code ${code}`})`), 200)); // let the reader report it first
    child.on("error", (e: any) => die(`claude didn't start: ${s(e?.message ?? e, 200)}`));
    return child; };
  const q = m.query({ prompt: inbox, options: {
    cwd: x.o.cwd, pathToClaudeCodeExecutable: x.bin, env: childEnv(x.o.env, x.keepKey), permissionMode: x.o.readOnly ? "plan" : "acceptEdits",
    settingSources: ["user", "project", "local"], ...(x.o.writableRoots?.length ? { additionalDirectories: x.o.writableRoots } : {}), ...(x.o.model ? { model: x.o.model } : {}), ...(x.resume ? { resume: x.resume } : { sessionId: x.sid }),
    canUseTool, hooks, spawnClaudeCodeProcess, stderr: (t: string) => { stderr = (stderr + t).slice(-2000); } } });
  // one reader for the whole task: messages go to the open turn; a result for one of ITS messages, with nothing queued behind it, ends it
  (async () => { try { for await (const msg of q) {
      if (msg?.type === "system" && msg.subtype === "init") { if (msg.session_id) x.sid = String(msg.session_id); emit({ sid: x.sid }); continue; }
      if (msg?.type === "assistant") { if (!msg.parent_tool_use_id) { const t = textOf(msg.message?.content).trim(); if (t) emit({ text: t }); } continue; } // a subagent's chatter stays out of the summary
      if (msg?.type === "result") { if (msg.session_id) x.sid = String(msg.session_id);
        const ids: string[] = [msg.user_message_uuid, ...(msg.user_message_uuids ?? [])].filter(Boolean);
        if (ids.length && !ids.some(u => mine.has(u))) continue;         // a late result from an interrupted request, or a turn Claude woke into by itself
        if (Number(msg.queued_turn_count) > 0) continue;                // a "now" steer restarted the turn: the task's turn goes on
        endTurn(msg.is_error ? { sid: x.sid, err: s(msg.errors?.join("; ") || msg.result || msg.subtype, 400) } : { sid: x.sid }); } }
      die("claude ended the session"); }
    catch (e: any) { die(s(e?.message ?? e, 300)); } })();
  const kill = () => { if (pid && child?.exitCode === null && child?.signalCode === null) try { process.platform === "win32" ? child.kill() : process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } };
  let steers: string[] = [];
  // the handshake, or claude dying first; the watcher interval ends either way (left running, it ticked every 100 ms for the session's life)
  let w: any = null;
  const ready = typeof q.initializationResult === "function" ? Promise.race([q.initializationResult(), new Promise((_, no) => { w = setInterval(() => { if (dead) no(new Error(dead)); }, 100); })]).finally(() => clearInterval(w)) : Promise.resolve();
  ready.catch(() => {});
  return {
    ready, get id() { return x.sid; }, get pid() { return pid ?? undefined; },
    prompt(text: string): AsyncIterable<LiveEvent> {
      if (dead) { const t = new Inbox<LiveEvent>(); t.push({ err: dead }); t.push({ done: true }); t.end(); return t; }
      if (turn) throw new Error("a turn is already running");
      turn = new Inbox<LiveEvent>(); steers = []; const pre = early.length ? early.join("\n\n") + "\n\n" : ""; early = [];
      inbox.push(user(pre + text)); return turn; },
    // "now" (the runner's mid-turn steer): into the running turn with Claude's priority "next", read after the current tool calls finish,
    // so nothing in flight is killed. No turn running -> throws, the runner keeps it for the next turn. "next": waits for the next prompt.
    async steer(text: string, how?: "next" | "now") { if (dead) throw new Error(dead);
      if (how !== "now") { early.push(text); return; } if (!turn) throw new Error("no turn is running");
      const u = user(text, "next"); steers.push(u.uuid); inbox.push(u); },
    async interrupt() { if (!turn || dead) return; const t = turn; stopping = true;
      for (const u of steers.splice(0)) await q.cancelAsyncMessage?.(u).catch(() => {}); // a queued steer must not restart the stopped turn
      await q.interrupt?.().catch(() => {});
      setTimeout(() => { if (turn === t) endTurn({ err: "interrupted" }); }, 10_000); }, // the result normally ends it; never hang on it
    async answer(id: string, allow: boolean, note?: string) { const a = asks.get(id); if (!a) return;
      a.done(allow ? { behavior: "allow", updatedInput: a.raw } : { behavior: "deny", message: note || "The owner said no through Kitebook." }); },
    // interrupt first (SIGTERM alone loses the turn's record), then end input; the process tree goes if it lingers
    async close() { if (turn && !dead) { stopping = true; await q.interrupt?.().catch(() => {}); } dead ??= "closed"; endTurn(); inbox.end(); try { q.close?.(); } catch {}
      try { child?.stdin?.end(); } catch {} // claude exits on end of input; the tree is killed if it lingers
      for (let i = 0; i < 30 && child && child.exitCode === null && child.signalCode === null; i++) await Bun.sleep(100); kill(); },
  };
}

// The runner's driver (registered in client/live-driver.ts): the owner's `claude` on the agents' PATH, runner.json "claudeApiKey" for the
// key, and an approval backstop a minute past the runner's own liveApprovalSec. KITEBOOK_CLAUDE_BIN: tests point it at a fake claude.
const run = async (argv: string[], ms = 15_000): Promise<string | null> => { try {
  const p = PL.spawn(argv, { stdout: "pipe", stderr: "ignore", env: process.env as any }); const k = setTimeout(() => p.kill(), ms);
  const out = await new Response(p.stdout as any).text(); await p.exited; clearTimeout(k); return p.exitCode === 0 ? out : null; } catch { return null; } };
export const driver: LiveDriver = claudeDriver({
  claude: () => process.env.KITEBOOK_CLAUDE_BIN || Bun.which("claude", { PATH: PL.envPath() }),
  version: bin => run([bin, "--version"]),
  agents: async bin => { const o = await run([bin, "agents", "--json"]); if (o == null) return null; try { const j = JSON.parse(o); return Array.isArray(j) ? j : Array.isArray(j?.agents) ? j.agents : Array.isArray(j?.sessions) ? j.sessions : null; } catch { return null; } },
  apiKey: () => cfg?.claudeApiKey === true,
  approvalTimeoutMs: () => (Math.max(10, Number(cfg?.liveApprovalSec ?? 300) || 300) + 60) * 1000,
  log: rlog,
});
