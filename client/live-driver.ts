// Live agent drivers (live-agents): ONE long-lived connection per task (or warm quick-ask session) instead of one CLI process per turn,
// so steering, approvals and interrupts reach the agent mid-turn. Each driver speaks its agent's own protocol (Codex: `codex app-server`
// JSON-RPC over stdio, client/live-codex.ts; Claude: the Agent SDK, client/live-claude.ts). The one-shot CLI argv in
// client/agent-adapters.ts stays the automatic FALLBACK: a driver that isn't registered, isn't available() on this computer (old CLI,
// missing package), fails its handshake, or is switched off in runner.json makes the runner use the CLI path exactly as before.
// Files stay flat in client/ (live-*.ts): the runner manifest only carries client/*.ts (client/integrity.ts NAME, src/start.ts glob).
//
// Who picks: liveFor(agent, purpose) below, called from ONE place per purpose (runner.ts drive() for tasks, runner-ask.ts ask() for quick
// asks). Drivers never touch runner state; the runner maps their events onto the task's live lines, its approval flow and its cancel.
// runner.json: "live": false (all drivers off) | "live": { "codex": false } (one off). A custom "agents"/"askAgents" entry for the same
// name always wins (it's the owner's own argv). KITEBOOK_LIVE=0 in the runner's environment turns them all off too.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { cfg, log } from "./runner-ctx.ts";

// What a live session reports while a turn runs. line: a live status line (tool call, command, file edit); text: what the agent said
// (whole message); sid: the agent's own session/thread id (resume key); err: the turn failed; done: the turn ended (always last);
// approval: the agent asks before doing something (answer it with LiveSession.answer, or it waits).
export type LiveEvent = { line?: string; text?: string; sid?: string; err?: string; done?: boolean; approval?: ApprovalAsk; interrupted?: boolean };
// tool: "command" | "file_change" | "permissions" | "question" | an agent's own tool name; summary: one line for the owner;
// input: the agent's raw request (command, cwd, paths, reason), kept for the approval payload. paths: files it would write, when known.
export type ApprovalAsk = { id: string; tool: string; summary: string; input: unknown; paths?: string[] };
export type LiveStart = {
  cwd: string; model?: string | null; resume?: string | null; fork?: { from: string; upTo?: string }; readOnly?: boolean; env?: Record<string, string>;
  // wrapped: Kitebook already runs the agent process inside its own OS sandbox (quick asks: sandbox-exec / user namespaces), so the agent
  // must not apply a second one: macOS Seatbelt profiles don't nest ("sandbox_apply: Operation not permitted"). wrap: how to wrap the
  // spawn argv (runner-ask.ts wrap); writableRoots: extra roots a task may write (the worktree is cwd).
  wrapped?: boolean; wrap?: (argv: string[]) => string[]; writableRoots?: string[];
};
export interface LiveDriver {
  agent: string;                        // "codex" | "claude" | "pi" | acp ids
  available(): Promise<boolean>;        // probe the binary/package/version; never throws
  start(o: LiveStart): Promise<LiveSession>;
  forks?: boolean;                      // start({ fork }) makes the agent's own copy of a session (the source is never written); live-sessions
                                        // uses it for session_send forks, else it seeds a new session with a summary (client/runner-sessions.ts)
  listSessions?(o: { cwd?: string; limit?: number }): Promise<{ id: string; title: string; cwd: string; updatedAt: number }[]>;
  why?(): string | null;                // why available() said no (doctor / the runner log), when known
}
export interface LiveSession {
  id: string;                                       // the agent's session/thread id (also sent as a LiveEvent sid)
  pid?: number;                                     // the agent process, when there is one: the guard's kill switch kills its tree
  prompt(text: string): AsyncIterable<LiveEvent>;   // one turn; ends with { done: true }
  steer(text: string, how?: "next" | "now"): Promise<void>; // add to the running turn ("now"), or queue for the next one; throws if it can't
  interrupt(): Promise<void>;                       // stop the running turn (it then ends with done + interrupted)
  answer(approvalId: string, allow: boolean, note?: string): Promise<void>;
  close(): Promise<void>;
}

// ---- registry: one lazy loader per agent. live-claude adds `claude: () => import("./live-claude.ts").then(m => m.driver)` ----
type Loader = () => Promise<LiveDriver>;
const DRIVERS: Record<string, Loader> = {
  codex: () => import("./live-codex.ts").then(m => m.driver), // codex app-server (live-codex)
  claude: () => import("./live-claude.ts").then(m => m.driver),   // Claude Agent SDK (optional package; missing -> claude -p)
};
export const registerLive = (agent: string, load: Loader) => { DRIVERS[agent] = load; avail.delete(agent); broken.delete(agent); }; // tests: fake drivers
export const liveAgents = () => Object.keys(DRIVERS);

const avail = new Map<string, { at: number; d: LiveDriver | null; why: string | null }>(); // available() is a process spawn: cached 10 min
const broken = new Map<string, { at: number; why: string }>(); // a handshake/start failure: CLI path for 30 min, then try live again
export const AVAIL_MS = 10 * 60_000, BROKEN_MS = 30 * 60_000;
// Off by the owner? (runner.json "live", KITEBOOK_LIVE=0, or their own agents/askAgents entry for that name)
export function liveOff(agent: string, purpose: "task" | "ask" = "task"): string | null {
  if (process.env.KITEBOOK_LIVE === "0") return "KITEBOOK_LIVE=0";
  const L = cfg?.live; if (L === false) return 'runner.json "live": false';
  if (L && typeof L === "object" && L[agent] === false) return `runner.json "live": { "${agent}": false }`;
  if (purpose === "task" ? cfg?.agents?.[agent] : cfg?.askAgents?.[agent]) return `runner.json has its own "${purpose === "task" ? "agents" : "askAgents"}" entry for ${agent}`;
  return null;
}
// The selector: the live driver for this agent when it's registered, not switched off, not broken lately and available() here; else null
// (the caller runs the CLI adapter). Never throws.
export async function liveFor(agent: string, purpose: "task" | "ask" = "task"): Promise<LiveDriver | null> {
  const load = DRIVERS[agent]; if (!load || liveOff(agent, purpose)) return null;
  const b = broken.get(agent); if (b && Date.now() - b.at < BROKEN_MS) return null;
  const c = avail.get(agent); if (c && Date.now() - c.at < AVAIL_MS) return c.d;
  let d: LiveDriver | null = null, why: string | null = null;
  try { const x = await load(); if (await x.available()) d = x; else why = x.why?.() ?? "not available"; } catch (e: any) { why = `driver failed to load: ${e?.message ?? e}`; }
  avail.set(agent, { at: Date.now(), d, why });
  if (!c || !!c.d !== !!d) log(`agent ${agent}:`, d ? "live connection (one session per task: mid-turn steering, interrupt, approvals)" : `one CLI run per turn (live driver: ${why})`);
  return d;
}
// A live start/handshake failed: use the CLI for this agent for a while (the owner sees no difference, the runner log says why).
export function liveBroken(agent: string, why: string) { broken.set(agent, { at: Date.now(), why: why.slice(0, 300) }); avail.delete(agent); log(`agent ${agent}: live connection failed (${why.slice(0, 300)}); using its CLI for the next ${BROKEN_MS / 60_000} min`); }
// Sync, for the runner's advert (agents_detail.live): what the last liveFor() found, without probing.
export const liveCached = (agent: string) => !liveOff(agent) && !!avail.get(agent)?.d && !(broken.has(agent) && Date.now() - broken.get(agent)!.at < BROKEN_MS);
// For status/doctor: per registered agent, live or why not.
export async function liveStatus(): Promise<Record<string, { live: boolean; why: string | null }>> {
  const out: Record<string, { live: boolean; why: string | null }> = {};
  for (const a of liveAgents()) { const d = await liveFor(a); const b = broken.get(a);
    out[a] = { live: !!d, why: d ? null : liveOff(a) ?? (b && Date.now() - b.at < BROKEN_MS ? `failed lately: ${b.why}` : avail.get(a)?.why ?? null) }; }
  return out;
}

// ---- helpers drivers share ----
// A push/pull queue: the driver pushes events as they arrive, prompt() hands out an AsyncIterable that ends after { done }.
export class EventQueue implements AsyncIterable<LiveEvent> {
  private q: LiveEvent[] = []; private wait: ((v: void) => void) | null = null; private ended = false;
  push(e: LiveEvent) { if (this.ended) return; this.q.push(e); if (e.done) this.ended = true; const w = this.wait; this.wait = null; w?.(); }
  get closed() { return this.ended; }
  async *[Symbol.asyncIterator]() { while (true) { if (this.q.length) { const e = this.q.shift()!; yield e; if (e.done) return; continue; } if (this.ended) return; await new Promise(r => this.wait = r); } }
}
