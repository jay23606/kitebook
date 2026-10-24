// live-sessions: the grant (owner-signed policy entry `sessions`), what the tools list shows, the approval payload, and the runner's rules
// for session tasks (fork reads only; in place refused while open). Fake session stores in a temp home only. Run: bun test client/sessions.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateKeyPairSync, sign as csign } from "crypto";
import { checkEnvelope } from "../src/policy.ts";
import { summarize, describeEntry, payloadOf, policyMsg, POLICY_TYPE, sessionsOf } from "./payload.ts";
import { toolsFor, SESSION_TOOLS } from "../src/mcpx.ts";
import { OPS } from "../src/ops.ts";

const H = mkdtempSync(join(tmpdir(), "kb-sess-")), OLD = Date.now() - 3600_000;
process.env.KITEBOOK_SESSIONS_HOME = H;
const put = (p: string, s: string, m = OLD) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); utimesSync(p, m / 1000, m / 1000); return p; };
const PI = put(join(H, ".pi/agent/sessions/--r--/a_pi1.jsonl"), [{ type: "session", version: 3, id: "pi1", cwd: "/r" }, { type: "message", message: { role: "user", content: "hello from the owner" } }].map(x => JSON.stringify(x)).join("\n") + "\n");

// an owner key + signed policy, as the browser makes them (P-256, ieee-p1363 signature over relay-policy:v1|canon)
const kp = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), pub = "p256:" + kp.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
const signed = (apps: any, seq = 1) => { const policy = { v: 1, type: POLICY_TYPE, space: "main", seq, at: Date.now(), apps };
  return { policy, key: pub, sig: csign("sha256", Buffer.from(policyMsg(policy)), { key: kp.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") }; };

test("the policy entry: sessions off | read | write, anything else refused", async () => {
  expect(await checkEnvelope(signed({ hark: { tasks: "ask", projects: [], sessions: "read" } }), [pub], "main")).toBe(null);
  expect(await checkEnvelope(signed({ hark: { tasks: "ask", projects: [], sessions: "write" } }), [pub], "main")).toBe(null);
  expect(await checkEnvelope(signed({ hark: { tasks: "ask", projects: [], sessions: "all" } }), [pub], "main")).toMatch(/sessions must be off \| read \| write/);
  expect(sessionsOf({ tasks: "ask", projects: [] })).toBe("off"); expect(sessionsOf({ sessions: "bogus" })).toBe("off");
});

test("the owner's audit line says the change in plain words", () => {
  expect(summarize("hark", null, { tasks: "ask", projects: [], sessions: "read" })).toBe("hark can search and read your agent sessions on your computers");
  expect(summarize("hark", { tasks: "ask", projects: [], sessions: "read" }, { tasks: "ask", projects: [], sessions: "off" })).toBe("hark can't see your agent sessions");
  expect(summarize("hark", { tasks: "auto", projects: ["kb"], keys: [] }, { tasks: "auto", projects: ["kb"], keys: [], sessions: "write" })).toMatch(/^hark can search, read and continue your agent sessions/);
  expect(describeEntry("hark", { tasks: "ask", projects: [], sessions: "read" })).toBe("hark asks you before every task; it can search and read your agent sessions on your computers");
  expect(summarize("hark", null, { tasks: "auto", projects: ["kitebook"], until: Date.UTC(2026, 9, 25), push: false })).toBe("hark can now run tasks in kitebook on its own until Oct 25"); // unchanged without sessions
});

test("tools/list: the session tools only once the owner allowed them, never for a runner", () => {
  const names = (o: any) => toolsFor("assistant", o).map(t => t.name);
  expect(names({}).filter(n => n.startsWith("session"))).toEqual([]);
  expect(names({ sessions: "read" }).filter(n => n.startsWith("session")).sort()).toEqual(["session_get", "session_status", "sessions_search"]);
  expect(names({ sessions: "write" }).filter(n => n.startsWith("session")).sort()).toEqual([...SESSION_TOOLS.write].sort());
  expect(toolsFor("runner").map(t => t.name).filter(n => SESSION_TOOLS.write.includes(n))).toEqual([]);
  for (const n of SESSION_TOOLS.write) expect(OPS[n].desc.length).toBeGreaterThan(80);
});

test("the approval payload covers the session (fork vs in place), and older payloads are unchanged", () => {
  const t = { id: "t_1", from: "hark", title: "x", instructions: "y" };
  expect(payloadOf(t, {})).not.toHaveProperty("session");
  expect(payloadOf({ ...t, session: { mode: "continue", agent: "pi", from: "pi1" } }, {}).session.mode).toBe("continue");
});

test("runner: fork seeds a copy and never writes the source; in place is refused while open, else resumes that session", async () => {
  const C = await import("./runner-ctx.ts"); C.setCfg({ space: "main", url: "http://127.0.0.1:9", ownerKeys: [pub] }); C.setMe({ name: "mac" });
  const RS = await import("./runner-sessions.ts"), before = readFileSync(PI, "utf8"); RS.hooks.allowed = async () => ({ level: "write" });
  const fork = await RS.sessionPrep({ id: "t_f", from: "hark", agent: "pi", session: { mode: "fork", agent: "pi", from: "pi1" } });
  expect(fork.preamble).toContain("hello from the owner"); expect(fork.preamble).toContain("not changed"); expect(fork.resume).toBeUndefined();
  expect((await RS.sessionPrep({ id: "t_f", agent: "pi", session: { mode: "fork", agent: "pi", from: "pi1" } }, a => a === "pi")).fork).toEqual({ from: "pi1" }); // a live driver's own fork
  expect((await RS.sessionPrep({ id: "t_x", agent: "pi", session: { mode: "fork", agent: "pi", from: "nope" } })).error).toMatch(/no pi session nope/);
  expect((await RS.sessionPrep({ id: "t_c", agent: "pi", session: { mode: "continue", agent: "pi", from: "pi1" } }, undefined, true)).error).toBeUndefined();
  // an idle Pi session isn't a closed one (Pi keeps no writer record): it's forked, never continued in place
  const idle = await RS.sessionPrep({ id: "t_c", agent: "pi", session: { mode: "continue", agent: "pi", from: "pi1" } });
  expect(idle.resume).toBeUndefined(); expect(idle.preamble).toContain("hello from the owner"); expect(idle.note).toMatch(/can't tell/);
  utimesSync(PI, Date.now() / 1000, Date.now() / 1000); // written just now: open somewhere
  expect((await RS.sessionPrep({ id: "t_c", agent: "pi", session: { mode: "continue", agent: "pi", from: "pi1" } })).error).toMatch(/open right now/);
  expect((await RS.sessionPrep({ id: "t_c", agent: "codex", session: { mode: "continue", agent: "pi", from: "pi1" } })).error).toMatch(/belongs to pi/);
  expect(readFileSync(PI, "utf8")).toBe(before);
});

test("runner: a session task reads nothing without the owner's signed write grant, checked before asking AND when it runs", async () => {
  const RS = await import("./runner-sessions.ts"), fk = { id: "t_g", from: "hark", agent: "pi", session: { mode: "fork", agent: "pi", from: "pi1" } };
  utimesSync(PI, OLD / 1000, OLD / 1000); let grant: any = { level: "write" }, asked: string[] = []; RS.hooks.allowed = async (app: string) => { asked.push(app); return grant; };
  expect((await RS.sessionPrep(fk, undefined, true)).error).toBeUndefined(); // before the approval
  grant = { level: "off", why: "you haven't let hark see your agent sessions" }; // revoked while it waited (queued / awaiting approval)
  const r = await RS.sessionPrep(fk); expect(r.error).toMatch(/^refused: you haven't let hark/); expect(r.preamble).toBeUndefined();
  grant = { level: "read" }; expect((await RS.sessionPrep({ ...fk, session: { mode: "continue", agent: "pi", from: "pi1" } })).error).toMatch(/^refused: .*not continue/);
  expect(asked.every(a => a === "hark")).toBe(true); expect((await RS.sessionPrep({ ...fk, session: { mode: "new", agent: "pi" } }))).toEqual({}); // new: no transcript read
  RS.hooks.allowed = async () => ({ level: "write" });
});

test("runner: in place only where the session is known closed and the agent resumes it by id; else a fork", async () => {
  const C = await import("./runner-ctx.ts"), RS = await import("./runner-sessions.ts"); RS.hooks.allowed = async () => ({ level: "write" });
  const cx = "019a0000-0000-7000-8000-0000000c0ffe", CX = put(join(H, ".codex/sessions/2026/10/20", `rollout-2026-10-20T10-00-00-${cx}.jsonl`), [{ type: "session_meta", payload: { id: cx, cwd: "/r" } }, { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex owner turn" }] } }].map(x => JSON.stringify(x)).join("\n") + "\n");
  const ct = { id: "t_cx", from: "hark", agent: "codex", session: { mode: "continue", agent: "codex", from: cx } };
  C.cfg.agents = { codex: { argv: ["codex", "exec", "{resume}", "{prompt}"], resume: ["resume", "{sid}"] } };
  expect((await RS.sessionPrep(ct)).note).toMatch(/can't tell/); // no writer-lock folder: Codex here keeps no record, so unknown
  mkdirSync(join(H, ".codex/thread-writer-locks"), { recursive: true });
  expect(await RS.sessionPrep(ct)).toEqual({ resume: cx }); // Codex keeps writer locks and this thread has none: closed, continue by id
  writeFileSync(join(H, ".codex/thread-writer-locks", `${cx}.lock`), ""); expect((await RS.sessionPrep(ct)).note).toMatch(/can't tell/); // an idle writer lock: unknown, a fork
  rmSync(join(H, ".codex/thread-writer-locks", `${cx}.lock`));
  C.cfg.agents = { codex: { argv: ["codex", "exec", "{resume}", "{prompt}"], resume: ["--session-id", "{tasksid}"] } }; // resumes only the task's own session (Copilot's shape)
  const cp = await RS.sessionPrep(ct); expect(cp.resume).toBeUndefined(); expect(cp.note).toMatch(/can't resume a session it didn't start/); expect(cp.preamble).toContain("codex owner turn");
  expect(RS.resumesById("copilot")).toBe(false); expect(RS.resumesById("grok")).toBe(false); expect(RS.resumesById("pi")).toBe(true);
  delete C.cfg.agents; expect(readFileSync(CX, "utf8")).toContain("codex owner turn");
});

test("live forks: the agent's own fork when its live driver forks here, else a seeded copy; the driver's start gets fork, later turns resume", async () => {
  const RS = await import("./runner-sessions.ts"), L = await import("./live-driver.ts"), before = readFileSync(PI, "utf8");
  utimesSync(PI, OLD / 1000, OLD / 1000);
  const started: any[] = [];
  const fake = (forks: boolean) => ({ agent: "pi", forks, available: async () => true,
    start: async (o: any) => { started.push(o); return { id: o.fork ? "pi1-copy" : o.resume ?? "new", prompt: async function* () { yield { done: true }; }, steer: async () => {}, interrupt: async () => {}, answer: async () => {}, close: async () => {} }; } });
  const fk = { id: "t_lf", from: "hark", agent: "pi", session: { mode: "fork", agent: "pi", from: "pi1" } };
  L.registerLive("pi", async () => fake(true) as any); expect(await RS.liveForks("pi")).toBe(true);
  const sp = await RS.sessionPrep(fk, a => a === "pi" && RS.liveForks(a)); expect(sp).toEqual({ fork: { from: "pi1" } }); // async check, no transplant needed
  L.registerLive("pi", async () => fake(false) as any); expect(await RS.liveForks("pi")).toBe(false); // a driver that can't fork: the seeded copy
  expect((await RS.sessionPrep(fk, a => a === "pi" && RS.liveForks(a))).preamble).toContain("hello from the owner");
  expect((await RS.sessionPrep({ ...fk, agent: "codex" }, () => { throw new Error("not asked for another agent"); })).preamble).toContain("hello from the owner");
  expect(await RS.liveForks("nobody")).toBe(false);
  // the start options the runner passes (runLiveTurn): fork on the first turn only, then resume the copy; an in-place continue resumes
  const run: any = { turns: 0, sid: null, fork: sp.fork };
  expect(RS.liveStartOf(run)).toEqual({ resume: null, fork: { from: "pi1" } });
  const d = fake(true); const s = await d.start({ cwd: "/r", ...RS.liveStartOf(run) }); run.sid = s.id; run.turns = 1;
  expect(started.at(-1).fork).toEqual({ from: "pi1" }); expect(RS.liveStartOf(run)).toEqual({ resume: "pi1-copy" }); // never the owner's id again
  expect(RS.liveStartOf({ turns: 1, sid: "pi1", fork: null })).toEqual({ resume: "pi1" }); // in place (owner approved, not open)
  expect(RS.liveStartOf({ turns: 0, sid: null, fork: null })).toEqual({ resume: null });
  L.registerLive("pi", async () => ({ agent: "pi", available: async () => false, why: () => "test over" }) as any); // no fake left for other files
  expect(readFileSync(PI, "utf8")).toBe(before);
});

test("a live fork that falls back to the CLI carries the summary just before the task text", async () => {
  const RS = await import("./runner-sessions.ts");
  expect(RS.withPreamble("You are working…\n\nTask: fix it\n\ndo x", "SEED")).toBe("You are working…\n\nSEED\n\nTask: fix it\n\ndo x");
  expect(RS.withPreamble("no task line", "SEED $& $1")).toBe("SEED $& $1\n\nno task line");
  expect(await RS.forkPreamble("pi", "pi1")).toContain("hello from the owner");
});

test("runner withholds metadata if the signed session grant ends before delivery", async () => {
  const C = await import("./runner-ctx.ts"), RS = await import("./runner-sessions.ts"), prior = C.cfg, allowed = RS.hooks.allowed, fetch0 = globalThis.fetch;
  let checks = 0, reply: any;
  try { C.setCfg({ url: "http://session-fixture.invalid", space: "main" }); RS.hooks.allowed = async () => ({ level: ++checks === 1 ? "read" : "off" });
    globalThis.fetch = (async (_url: any, init: any) => { const a = JSON.parse(init.body);
      if (String(_url).endsWith("/sessions_take")) return Response.json({ok:true,result:{op:"status",from:"hark",args:{agent:"pi",id:"pi1"}}});
      reply = a; return Response.json({ok:true,result:{ok:true}}); }) as typeof fetch;
    await RS.onRequest("fixture-grant-ended"); expect(checks).toBe(2); expect(reply.ok).toBe(false); expect(reply.error).toMatch(/session access ended/); expect(reply.result).toBeUndefined();
  } finally { globalThis.fetch = fetch0; C.setCfg(prior); RS.hooks.allowed = allowed; }
});
