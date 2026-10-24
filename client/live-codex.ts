// Live Codex (live-agents): one `codex app-server` process per task (or warm quick-ask session), JSON-RPC over stdio, instead of one
// `codex exec ... resume <id>` per turn. A turn is turn/start; a steering note reaches the RUNNING turn (turn/steer); a cancel is
// turn/interrupt; approvals arrive as server requests and go through Kitebook's approval flow (runner.ts liveApprove). Protocol slice:
// client/live-codex-types.ts (generated from codex 0.163.0's stable bindings). The CLI adapter (client/agent-adapters.ts) stays the
// fallback: not installed / no app-server subcommand / handshake fails -> the runner runs `codex exec` as before (client/live-driver.ts).
//
// Sandbox (the BRAINSTORM bug "Codex quick asks fail on the Mac: sandbox_apply: Operation not permitted"): macOS Seatbelt profiles don't
// nest, so a Codex that applies its own sandbox inside Kitebook's sandbox-exec wrapper dies before running anything. So:
//   wrapped (quick asks: Kitebook's read-only OS sandbox already wraps the process)  sandboxPolicy externalSandbox: Codex applies none,
//            Kitebook's profile is the boundary (openai/codex#45657; app-server docs: "if you already sandbox the server process")
//   readOnly, not wrapped (no OS sandbox on this computer)                          sandboxPolicy readOnly (Codex's own)
//   task (worktree)                                                                  sandboxPolicy workspaceWrite, writable root = the worktree
// approvalPolicy: "never" (exactly what `codex exec` does today) unless runner.json "codexApprovals": "on-request" | "untrusted", which
// lets Codex ask before leaving its sandbox; those asks go to the owner (never auto-allowed), and no answer in time is a no.
// Owner sessions are never written to: continuing one is thread/fork (fork option); a resume that hits "active writer" (-32600, the
// thread is open in another Codex) forks instead.
// Edge cases follow Paseo's production Codex app-server client (getpaseo/paseo, Apache-2.0; ideas only, no code copied): split stdout on
// "\n" only (Codex writes raw U+2028/2029 inside JSON strings), answer every server request (unknown ones with an error so Codex never
// waits), wait for the turn id before an early interrupt, treat "no active turn to interrupt" as done, cancel pending approvals when
// the session closes or the server resolves them itself (serverRequest/resolved), and respawn + thread/resume when the app-server
// exited between turns.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import * as PL from "./platform.ts";
import { codexReadOnlyConfig, codexConfigArgv } from "./execution-policy.ts";
import { cfg } from "./runner-ctx.ts";
import { EventQueue, type LiveDriver, type LiveSession, type LiveStart, type LiveEvent } from "./live-driver.ts";
import type * as T from "./live-codex-types.ts";

// CLI fallback and the live driver resolve the same effective config, including project layers. Failure refuses the question.
export async function codexReadOnlyArgv(argv: string[], cwd: string, env: Record<string, string>): Promise<string[]> {
  const rpc = new Rpc([argv[0], "app-server"], cwd, env);
  try { await rpc.request("initialize", { clientInfo: { name: "kitebook_readonly", title: "Kitebook", version: "1" }, capabilities: { experimentalApi: false } }); rpc.notify("initialized");
    const r = await rpc.request<any>("config/read", { cwd, includeLayers: false });
    return [...argv.slice(0, 2), ...codexConfigArgv(codexReadOnlyConfig(r.config)), ...argv.slice(2)];
  } finally { rpc.close(); }
}
const s1 = (x: any, n = 160) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const VERSION_MIN = [0, 146, 0]; // thread writer locks (an open owner thread can't be resumed by a second writer) + stable thread/fork
export const parseVersion = (s: string) => { const m = s.match(/(\d+)\.(\d+)\.(\d+)/); return m ? [+m[1], +m[2], +m[3]] : null; };
const vGte = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };

export class RpcError extends Error { constructor(msg: string, public code?: number, public data?: unknown) { super(msg); } }
type Pending = { res: (v: any) => void; rej: (e: Error) => void; tm: any };
// One app-server process: requests with ids, notifications, and server requests (answered by `onRequest`; unknown ones get an error).
export class Rpc {
  proc: any; dead = false; err = ""; private id = 1; private pending = new Map<number | string, Pending>();
  onNote: (m: string, p: any) => void = () => {}; onRequest: (id: number | string, m: string, p: any) => boolean = () => false; onExit: (why: string) => void = () => {};
  constructor(argv: string[], cwd: string, env: Record<string, string>) {
    try { this.proc = PL.spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true } as any); }
    catch (e: any) { throw new Error(`can't start ${argv[0] === "codex" ? "codex app-server" : argv.join(" ").slice(0, 80)}: ${e?.message ?? e}`); }
    this.proc.exited.then((code: number) => this.die(`codex app-server exited (code ${code})${this.err.trim() ? ": " + this.err.trim().split("\n").slice(-3).join(" ").slice(-400) : ""}`));
    (async () => { const dec = new TextDecoder(); let buf = ""; // "\n" only: JSON strings may hold raw U+2028/2029
      for await (const c of this.proc.stdout as any) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); if (l.trim()) this.line(l); } } })().catch(() => {});
    (async () => { const dec = new TextDecoder(); for await (const c of this.proc.stderr as any) this.err = (this.err + dec.decode(c, { stream: true })).slice(-4000); })().catch(() => {});
  }
  get pid(): number | undefined { return this.proc?.pid; }
  private line(l: string) {
    let m: any; try { m = JSON.parse(l); } catch { return; } if (!m || typeof m !== "object") return;
    if (m.id != null && m.method == null) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.tm);
      return m.error ? p.rej(new RpcError(String(m.error.message ?? "app-server error"), m.error.code, m.error.data)) : p.res(m.result); }
    if (m.id != null && typeof m.method === "string") { let handled = false; try { handled = this.onRequest(m.id, m.method, m.params ?? {}); } catch {}
      if (!handled) this.respondError(m.id, -32601, `${m.method} is not supported by Kitebook`); return; }
    if (typeof m.method === "string") try { this.onNote(m.method, m.params ?? {}); } catch {}
  }
  private write(o: any) { if (this.dead) throw new Error("codex app-server is not running"); this.proc.stdin.write(JSON.stringify(o) + "\n"); this.proc.stdin.flush?.(); }
  request<R = any>(method: string, params: any, ms = 30_000): Promise<R> {
    if (this.dead) return Promise.reject(new Error("codex app-server is not running"));
    const id = this.id++;
    return new Promise((res, rej) => { const tm = setTimeout(() => { this.pending.delete(id); rej(new Error(`codex app-server didn't answer ${method} in ${Math.round(ms / 1000)} s`)); }, ms);
      this.pending.set(id, { res, rej, tm }); try { this.write({ id, method, params }); } catch (e: any) { this.pending.delete(id); clearTimeout(tm); rej(e); } });
  }
  notify(method: string, params?: any) { try { this.write(params === undefined ? { method } : { method, params }); } catch {} }
  respond(id: number | string, result: any) { try { this.write({ id, result }); } catch {} }
  respondError(id: number | string, code: number, message: string) { try { this.write({ id, error: { code, message } }); } catch {} }
  private die(why: string) { if (this.dead) return; this.dead = true; for (const p of this.pending.values()) { clearTimeout(p.tm); p.rej(new Error(why)); } this.pending.clear(); this.onExit(why); }
  close() { if (this.dead && !this.proc) return; const pid = this.proc?.pid; this.die("closed by Kitebook"); try { this.proc.stdin.end(); } catch {}
    const k = (sig: NodeJS.Signals) => { try { process.kill(-pid, sig); } catch {} try { process.kill(pid, sig); } catch {} }; if (pid) { k("SIGTERM"); setTimeout(() => k("SIGKILL"), 2000).unref?.(); } }
}

// One notification -> what Kitebook shows. Pure (unit-tested); `paths` remembers each fileChange item's files for its approval.
export function mapNote(method: string, p: any, paths?: Map<string, string[]>): LiveEvent | null {
  const it = p?.item ?? {};
  if (method === "thread/started") return p?.thread?.id ? { sid: String(p.thread.id) } : null;
  if (method === "item/started" && it.type === "commandExecution") return { line: `→ $ ${s1(it.command)}` };
  if (method === "item/started" && it.type === "fileChange") { paths?.set(it.id, (it.changes ?? []).map((c: any) => String(c.path))); return null; }
  if (method === "item/completed" && it.type === "agentMessage") return it.text ? { text: String(it.text) } : null;
  if (method === "item/completed" && it.type === "fileChange") { const ps = (it.changes ?? []).map((c: any) => String(c.path)); paths?.set(it.id, ps);
    return { line: `${it.status === "failed" || it.status === "declined" ? "✗" : "→"} edit ${s1(ps.join(" "))}` }; }
  if (method === "item/completed" && it.type === "commandExecution" && it.exitCode) return { line: `✗ exit ${it.exitCode}: ${s1(it.command)}` };
  if (method === "item/started" && it.type === "mcpToolCall") return { line: `→ ${s1(it.server)}.${s1(it.tool)}` };
  if (method === "item/started" && it.type === "webSearch") return { line: `→ web search` };
  if (method === "error" && p?.willRetry) return { line: `retrying: ${s1(p.error?.message)}` };
  return null;
}
// a resume refused because the thread is open in another Codex (thread-writer-locks, codex >= 0.146)
export const activeWriter = (e: any) => e instanceof RpcError && e.code === -32600 && /active writer/i.test(e.message);
const idleInterrupt = (e: any) => e instanceof RpcError && /no active turn/i.test(e.message);
const textIn = (text: string): T.UserInput[] => [{ type: "text", text, text_elements: [] }];

export function sandboxFor(o: LiveStart): T.SandboxPolicy {
  if (o.wrapped) return { type: "externalSandbox", networkAccess: "enabled" }; // Kitebook's OS sandbox wraps the process: no second Seatbelt
  if (o.readOnly) return { type: "readOnly", networkAccess: false };
  return { type: "workspaceWrite", writableRoots: [o.cwd, ...(o.writableRoots ?? [])], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }; // = codex exec --sandbox workspace-write
}
const approvalsFor = (o: LiveStart): T.AskForApproval => { const a = cfg?.codexApprovals; return !o.readOnly && (a === "on-request" || a === "untrusted") ? a : "never"; };

class CodexSession implements LiveSession {
  id = ""; rpc!: Rpc; turnId: string | null = null; q: EventQueue | null = null; closed = false; next: string[] = [];
  private turnIdWait: ((id: string | null) => void)[] = []; private asks = new Map<string, { rid: number | string; method: string; params: any }>(); private paths = new Map<string, string[]>();
  constructor(public o: LiveStart, public bin: string) {}
  get pid() { return this.rpc?.pid; }
  async connect() {
    const argv = [this.bin, "app-server"], rpc = this.rpc = new Rpc(this.o.wrap ? this.o.wrap(argv) : argv, this.o.cwd, this.o.env ?? { PATH: PL.envPath() });
    rpc.onNote = (m, p) => this.note(m, p); rpc.onRequest = (id, m, p) => this.request(id, m, p);
    rpc.onExit = why => { this.endTurn({ err: this.closed ? undefined : why }); };
    await rpc.request<T.InitializeResponse>("initialize", { clientInfo: { name: "kitebook", title: "Kitebook", version: "1" }, capabilities: { experimentalApi: false, requestAttestation: false,
      optOutNotificationMethods: ["item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/commandExecution/outputDelta", "item/fileChange/outputDelta", "command/exec/outputDelta"] } } satisfies T.InitializeParams, 20_000);
    rpc.notify("initialized");
  }
  async open() { // a new thread, a resume of Kitebook's own thread, or a fork (owner sessions)
    const o = this.o, config = o.readOnly ? codexReadOnlyConfig((await this.rpc.request<any>("config/read", { cwd: o.cwd, includeLayers: false })).config) : null;
    const common = { cwd: o.cwd, model: o.model ?? null, approvalPolicy: approvalsFor(o), ...(config ? { config } : {}) };
    const fork = (threadId: string, lastTurnId?: string) => this.rpc.request<T.ThreadResponse>("thread/fork", { threadId, lastTurnId: lastTurnId ?? null, ...common, excludeTurns: true } satisfies T.ThreadForkParams);
    let r: T.ThreadResponse;
    if (o.fork) r = await fork(o.fork.from, o.fork.upTo);
    else if (o.resume) { try { r = await this.rpc.request<T.ThreadResponse>("thread/resume", { threadId: o.resume, ...common, excludeTurns: true } satisfies T.ThreadResumeParams); }
      catch (e) { if (!activeWriter(e)) throw e; r = await fork(o.resume); } } // open in another Codex: never a second writer
    else r = await this.rpc.request<T.ThreadResponse>("thread/start", { ...common, serviceName: "kitebook" } satisfies T.ThreadStartParams);
    this.id = String(r.thread.id);
  }
  private note(m: string, p: any) {
    if (p?.threadId && this.id && p.threadId !== this.id) return; // another thread (sub-agents): not this session's turn
    if (m === "turn/started" && p?.turn?.id) { this.setTurn(String(p.turn.id)); return; }
    if (m === "turn/completed") { const t = p?.turn ?? {}; if (this.turnId && t.id && t.id !== this.turnId) return;
      return this.endTurn(t.status === "failed" ? { err: s1(t.error?.message ?? "the turn failed", 400) + (t.error?.additionalDetails ? ` (${s1(t.error.additionalDetails, 200)})` : "") } : t.status === "interrupted" ? { interrupted: true } : {}); }
    if (m === "serverRequest/resolved") { for (const [k, a] of this.asks) if (a.rid === p?.requestId) this.asks.delete(k); return; } // Codex settled it itself (turn ended)
    const ev = mapNote(m, p, this.paths); if (ev) this.q?.push(ev);
  }
  private request(rid: number | string, m: string, p: any): boolean {
    if (this.closed) return false;
    const id = `${rid}`, push = (tool: string, summary: string, paths?: string[]) => { this.asks.set(id, { rid, method: m, params: p }); this.q ? this.q.push({ approval: { id, tool, summary, input: p, ...(paths ? { paths } : {}) } }) : this.decide(id, false); return true; };
    const why = p?.reason ? ` (${s1(p.reason, 200)})` : "";
    if (m === "item/commandExecution/requestApproval") return push("command", `run \`${s1(p?.command ?? "a command", 300)}\`${p?.cwd ? ` in ${s1(p.cwd)}` : ""}${why}`);
    if (m === "item/fileChange/requestApproval") { const ps = this.paths.get(p?.itemId) ?? []; return push("file_change", `edit ${s1(ps.join(" ") || "files", 300)}${p?.grantRoot ? `, and write anywhere under ${s1(p.grantRoot)}` : ""}${why}`, p?.grantRoot ? [...ps, String(p.grantRoot)] : ps); }
    if (m === "item/permissions/requestApproval") return push("permissions", `extra permissions: ${s1(JSON.stringify(p?.permissions ?? {}), 300)}${why}`);
    // no person can answer a form mid-turn: an empty answer / decline (the agent can still end with [relay-question: ...], which parks the task)
    if (m === "item/tool/requestUserInput") { this.rpc.respond(rid, { answers: {} }); return true; }
    if (m === "mcpServer/elicitation/request") { this.rpc.respond(rid, { action: "decline", content: null, _meta: null }); return true; }
    return false; // anything else: an error answer (Rpc), so Codex never waits on Kitebook
  }
  private decide(id: string, allow: boolean) {
    const a = this.asks.get(id); if (!a) return; this.asks.delete(id);
    if (a.method === "item/permissions/requestApproval") this.rpc.respond(a.rid, allow ? { permissions: a.params?.permissions ?? {}, scope: "turn" } : { permissions: {}, scope: "turn" });
    else this.rpc.respond(a.rid, { decision: allow ? "accept" : (this.closed ? "cancel" : "decline") satisfies T.ApprovalDecision });
  }
  private setTurn(id: string | null) { this.turnId = id; const w = this.turnIdWait; this.turnIdWait = []; w.forEach(f => f(id)); }
  private waitTurn(ms: number): Promise<string | null> { if (this.turnId || !this.q) return Promise.resolve(this.turnId); return new Promise(r => { this.turnIdWait.push(r); setTimeout(() => r(this.turnId), ms); }); }
  private endTurn(x: { err?: string; interrupted?: boolean }) {
    for (const k of [...this.asks.keys()]) this.decide(k, false); // nobody can act on them now
    const q = this.q; this.q = null; this.setTurn(null); if (!q) return;
    if (x.err) q.push({ err: x.err }); q.push({ done: true, ...(x.interrupted ? { interrupted: true } : {}) });
  }
  prompt(text: string): AsyncIterable<LiveEvent> {
    const q = this.q = new EventQueue();
    const pre = this.next.splice(0); if (pre.length) text = `${pre.join("\n\n")}\n\n${text}`; // steers queued with how "next"
    (async () => {
      if (this.rpc.dead) { await this.connect(); this.o = { ...this.o, resume: this.id, fork: undefined }; await this.open(); } // the app-server exited between turns
      q.push({ sid: this.id });
      const r = await this.rpc.request<{ turn: T.Turn }>("turn/start", { threadId: this.id, input: textIn(text), sandboxPolicy: sandboxFor(this.o), approvalPolicy: approvalsFor(this.o), ...(this.o.model ? { model: this.o.model } : {}) } satisfies T.TurnStartParams);
      if (this.q === q && r?.turn?.id && !this.turnId) this.setTurn(String(r.turn.id));
    })().catch((e: any) => { if (this.q === q) this.endTurn({ err: `codex app-server: ${e?.message ?? e}` }); });
    return q;
  }
  async steer(text: string, how: "next" | "now" = "now") {
    if (how === "next" || !this.q) { if (!this.q && how === "now") throw new Error("no turn is running"); this.next.push(text); return; }
    const tid = await this.waitTurn(10_000); if (!tid || !this.q) throw new Error("no turn is running");
    await this.rpc.request("turn/steer", { threadId: this.id, input: textIn(text), expectedTurnId: tid } satisfies T.TurnSteerParams, 30_000);
    this.q?.push({ line: `→ steer: ${s1(text, 120)}` });
  }
  async interrupt() {
    if (!this.q || this.rpc.dead) return; const tid = await this.waitTurn(10_000); if (!tid) return;
    try { await this.rpc.request("turn/interrupt", { threadId: this.id, turnId: tid } satisfies T.TurnInterruptParams, 15_000); } catch (e) { if (!idleInterrupt(e)) throw e; }
  }
  async answer(approvalId: string, allow: boolean) { this.decide(approvalId, allow); }
  async close() { if (this.closed) return; this.closed = true; this.endTurn({ err: undefined }); this.rpc?.close(); }
}

let why: string | null = null;
export const driver: LiveDriver & { bin: string } = {
  agent: "codex", bin: "codex", forks: true, // thread/fork
  why: () => why,
  // the app-server subcommand exists and the version has writer locks + stable fork; never throws
  async available() {
    const path = PL.envPath(), bin = Bun.which(this.bin, { PATH: path }); if (!bin) { why = "codex isn't installed"; return false; }
    try { const run = async (a: string[]) => { const p = PL.spawn([bin, ...a], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: path } as any }); const k = setTimeout(() => p.kill(), 15_000);
        const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); clearTimeout(k); return { code: p.exitCode, text: o + "\n" + e }; };
      const v = parseVersion((await run(["--version"])).text); if (!v || !vGte(v, VERSION_MIN)) { why = `codex ${v ? v.join(".") : "(unknown version)"} is older than ${VERSION_MIN.join(".")} (app-server writer locks)`; return false; }
      const h = await run(["app-server", "--help"]); if (h.code !== 0 || !/app.server/i.test(h.text)) { why = "this codex has no app-server subcommand"; return false; }
      why = null; return true; } catch (e: any) { why = `codex probe failed: ${e?.message ?? e}`; return false; }
  },
  async start(o) { const s = new CodexSession(o, Bun.which(this.bin, { PATH: o.env?.PATH ?? PL.envPath() }) ?? this.bin);
    try { await s.connect(); await s.open(); return s; } catch (e) { await s.close(); throw e; } },
  // the owner's own recent sessions in a folder (Codex lists interactive sources by default: cli, vscode); read-only
  async listSessions(o) { const s = new CodexSession({ cwd: o.cwd ?? process.cwd(), readOnly: true }, Bun.which(this.bin, { PATH: PL.envPath() }) ?? this.bin);
    try { await s.connect(); const r = await s.rpc.request<T.ThreadListResponse>("thread/list", { limit: o.limit ?? 20, sortKey: "updated_at", ...(o.cwd ? { cwd: o.cwd } : {}) } satisfies T.ThreadListParams);
      return (r.data ?? []).map(t => ({ id: t.id, title: s1(t.name || t.preview || "(untitled)", 120), cwd: t.cwd, updatedAt: t.updatedAt })); } finally { await s.close(); } },
};
