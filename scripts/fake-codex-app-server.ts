// A fake `codex app-server` for tests (client/live-codex.test.ts, smoke.sh "live codex"): the JSON-RPC slice Kitebook uses
// (client/live-codex-types.ts), on stdio, one JSON object per line, no "jsonrpc" field, like codex 0.163.0. Every request it gets is
// appended to $FAKE_CODEX_LOG (one JSON line: method + params) so tests can check what Kitebook sent (sandboxPolicy, approvalPolicy, fork).
// Turn behavior by prompt text:
//   CRASH                 exit 17 in the middle of the turn
//   SLOW                  a command starts, then the turn waits up to 8 s: a turn/steer ends it with "steered: <text>", turn/interrupt
//                         ends it as interrupted
//   APPROVE               asks item/commandExecution/requestApproval (curl example.com) and says "decision: <decision>"
//   FILEAPPROVE <path>    a fileChange item for <path>, then item/fileChange/requestApproval; says "decision: <decision>"
//   "add a file" (a task: workspaceWrite)  writes codex-live.txt in its cwd first
//   anything else         a command (ls), then "echo: <prompt>" (with a raw U+2028 inside, which must not split the line)
// Under the fake Seatbelt (FAKE_SEATBELT=1, set by the smoke's fake sandbox-exec) a turn whose sandboxPolicy is NOT externalSandbox (or
// dangerFullAccess) fails like the real one: "sandbox-exec: sandbox_apply: Operation not permitted".
// Threads: thread/resume of an id starting "owner-open" fails -32600 "active writer"; thread/list returns two owner threads in $PWD.
import { appendFileSync, writeFileSync } from "fs";

const LOG = process.env.FAKE_CODEX_LOG ?? (process.env.FAKE_AGENT_LOG ? process.env.FAKE_AGENT_LOG + ".rpc" : undefined), nested = process.env.FAKE_SEATBELT === "1";
const out = (o: any) => process.stdout.write(JSON.stringify(o) + "\n");
const rec = (method: string, params: any) => { if (LOG) try { appendFileSync(LOG, JSON.stringify({ method, params, pid: process.pid }) + "\n"); } catch {} };
let n = 0, thread: string | null = null, active: { id: string; steer?: (t: string) => void; interrupt?: () => void } | null = null;
const waiting = new Map<number, (r: any) => void>(); let sid = 1000;
const ask = (method: string, params: any) => new Promise<any>(res => { const id = sid++; waiting.set(id, res); out({ id, method, params }); });
const note = (method: string, params: any) => out({ method, params });
const threadObj = (id: string, extra: any = {}) => ({ id, sessionId: id, forkedFromId: null, preview: "", name: null, cwd: process.cwd(), createdAt: 1, updatedAt: 2, status: { type: "idle" }, ...extra });
const thr = (id: string, extra: any = {}) => ({ thread: threadObj(id, extra), model: "gpt-fake", modelProvider: "openai", cwd: process.cwd(), sandbox: { type: "readOnly" }, approvalPolicy: "never" });
const item = (turnId: string, it: any, kind: "started" | "completed") => note(`item/${kind}`, { threadId: thread, turnId, item: it });
const done = (turnId: string, status: string, error: any = null) => { if (active?.id === turnId) active = null; note("turn/completed", { threadId: thread, turn: { id: turnId, status, error, items: [] } }); };

async function turn(turnId: string, text: string, p: any) {
  note("turn/started", { threadId: thread, turn: { id: turnId, status: "inProgress", items: [] } });
  const pol = p.sandboxPolicy?.type;
  if (nested && pol !== "externalSandbox" && pol !== "dangerFullAccess") return done(turnId, "failed", { message: "sandbox-exec: sandbox_apply: Operation not permitted", additionalDetails: null });
  if (/CRASH/.test(text)) { item(turnId, { type: "commandExecution", id: "c1", command: "make crash", cwd: process.cwd(), exitCode: null, status: "inProgress" }, "started"); setTimeout(() => process.exit(17), 100); return; }
  if (/SLOW/.test(text)) { item(turnId, { type: "commandExecution", id: "c1", command: "sleep 8", cwd: process.cwd(), exitCode: null, status: "inProgress" }, "started");
    await new Promise<void>(res => { const tm = setTimeout(res, 8000);
      active!.steer = t => { clearTimeout(tm); item(turnId, { type: "agentMessage", id: "m1", text: `steered: ${t}` }, "completed"); done(turnId, "completed"); res(); };
      active!.interrupt = () => { clearTimeout(tm); done(turnId, "interrupted"); res(); }; });
    if (active?.id === turnId) { item(turnId, { type: "agentMessage", id: "m1", text: "slow turn finished" }, "completed"); done(turnId, "completed"); } return; }
  if (/FILEAPPROVE/.test(text)) { const path = text.match(/FILEAPPROVE (\S+)/)?.[1] ?? "x.txt";
    item(turnId, { type: "fileChange", id: "f1", changes: [{ path, kind: { type: "update" }, diff: "+x" }], status: "inProgress" }, "started");
    const r = await ask("item/fileChange/requestApproval", { threadId: thread, turnId, itemId: "f1", startedAtMs: Date.now(), reason: "outside the sandbox" });
    item(turnId, { type: "agentMessage", id: "m1", text: `decision: ${r?.decision}` }, "completed"); return done(turnId, "completed"); }
  if (/APPROVE/.test(text)) {
    const r = await ask("item/commandExecution/requestApproval", { threadId: thread, turnId, itemId: "c2", startedAtMs: Date.now(), command: "curl example.com", cwd: process.cwd(), reason: "needs the network", kind: "command", environmentId: null });
    item(turnId, { type: "agentMessage", id: "m1", text: `decision: ${r?.decision}` }, "completed"); return done(turnId, "completed"); }
  if (pol === "workspaceWrite" && /add a file/.test(text)) { writeFileSync("codex-live.txt", "made by codex app-server\n"); // a task: an edit in the worktree
    item(turnId, { type: "fileChange", id: "f0", changes: [{ path: "codex-live.txt", kind: { type: "add" }, diff: "+made" }], status: "completed" }, "completed"); }
  item(turnId, { type: "commandExecution", id: "c1", command: "ls", cwd: process.cwd(), exitCode: null, status: "inProgress" }, "started");
  item(turnId, { type: "commandExecution", id: "c1", command: "ls", cwd: process.cwd(), exitCode: 0, status: "completed" }, "completed");
  item(turnId, { type: "agentMessage", id: "m1", text: `echo: ${text.slice(-300)} \u2028end`, phase: "final_answer" }, "completed");
  done(turnId, "completed");
}

function handle(m: any) {
  if (m.id != null && m.method == null) { const w = waiting.get(m.id); waiting.delete(m.id); w?.(m.result ?? { error: m.error }); return; }
  const { id, method, params: p = {} } = m; rec(method, p);
  const ok = (result: any) => id != null && out({ id, result }), err = (code: number, message: string) => id != null && out({ error: { code, message }, id });
  switch (method) {
    case "initialize": return ok({ userAgent: "kitebook/0.163.0 (fake)", codexHome: "/tmp/fake-codex", platformFamily: "unix", platformOs: "linux" });
    case "initialized": return;
    case "thread/start": thread = `th_${process.pid}_${++n}`; ok(thr(thread)); return note("thread/started", { thread: threadObj(thread) });
    case "thread/resume": if (String(p.threadId).startsWith("owner-open")) return err(-32600, `thread ${p.threadId} already has an active writer`);
      thread = p.threadId; return ok(thr(thread!));
    case "thread/fork": thread = `fork_${process.pid}_${++n}`; return ok(thr(thread, { forkedFromId: p.threadId }));
    case "thread/list": return ok({ data: [threadObj("owner-1", { preview: "fix the login bug", updatedAt: 20 }), threadObj("owner-open-2", { name: "refactor", updatedAt: 10 })].filter(t => !p.cwd || t.cwd === p.cwd), nextCursor: null });
    case "turn/start": { if (!thread || p.threadId !== thread) return err(-32600, "unknown thread"); const t = `turn_${++n}`; active = { id: t }; ok({ turn: { id: t, status: "inProgress", items: [], error: null } });
      const text = (p.input ?? []).map((x: any) => x.text).join("\n"); turn(t, text, p).catch(() => {}); return; }
    case "turn/steer": if (!active) return err(-32600, "no active turn to steer"); if (p.expectedTurnId !== active.id) return err(-32600, "expected turn mismatch");
      ok({ turnId: active.id }); setTimeout(() => active?.steer?.((p.input ?? []).map((x: any) => x.text).join("\n")), 50); return;
    case "turn/interrupt": if (!active) return err(-32600, "no active turn to interrupt"); ok({}); setTimeout(() => active?.interrupt?.(), 50); return;
    default: return err(-32601, `unknown method ${method}`);
  }
}
let buf = "";
process.stdin.on("data", (c: Buffer) => { buf += c.toString("utf8"); let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) try { handle(JSON.parse(l)); } catch {} } });
process.stdin.on("end", () => process.exit(0));
