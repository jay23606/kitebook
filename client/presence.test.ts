// Presence (G5) and live-steering rules (G4), server side, without a Durable Object: the presence ops run on a fake Space backed by
// bun:sqlite (same SQL), and checkSteer is the rule SpaceTasks.steerTask applies before it stores a note. Run: bun test client/presence.test.ts
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { PRESENCE_SCHEMA, presenceOps, presenceView, shortDur } from "../src/space/presence.ts";
import { checkSteer, STEER_MAX } from "../src/space/steer.ts";

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
function fakeSpace() {
  const db = new Database(":memory:"), tasks = new Map<string, any>(), live = new Map<string, any>();
  db.run(PRESENCE_SCHEMA);
  db.run("create table members(peer_id text primary key, name text, kind text, revoked integer default 0, last_seen text)");
  db.run("create table tasks(id text primary key, from_peer text, target_peer text, state text, created text)");
  const sp: any = {
    spaceId: "main",
    sql: { exec: (q: string, ...a: any[]) => { const st = db.query(q), rows = /^\s*select/i.test(q) ? st.all(...a) : (st.run(...a), []); return { toArray: () => rows }; } }, // runs at once, like the DO's
    member: (id: string) => db.query("select * from members where peer_id=?").get(id),
    need: () => {}, seen: (id: string) => db.query("update members set last_seen=? where peer_id=?").run(iso(), id),
    loadTask: (id: string) => { const t = tasks.get(id); if (!t) throw new Error("no task"); return t; },
    liveFor: (t: any) => live.get(t.id) ?? { phase: null, agent: null, started_at: null },
    presence: (m: any) => ({ online: false, last_seen: m?.last_seen ?? null }),
  };
  const ops = presenceOps.call(sp);
  return {
    sp, db, ops,
    member: (peer_id: string, name: string, kind = "runner") => db.query("insert into members(peer_id, name, kind) values(?,?,?)").run(peer_id, name, kind),
    task: (t: any, l?: any) => { tasks.set(t.id, t); db.query("insert or replace into tasks values(?,?,?,?,?)").run(t.id, t.from_peer, t.target_peer, t.state, iso()); if (l) live.set(t.id, l); },
    report: (id: string, a: any) => ops.presence_report({ id, name: id, kind: "runner" } as any, a),
  };
}

test("a heartbeat reads as one plain line: agent, repo, branch, what it's doing, how long", async () => {
  const f = fakeSpace(); f.member("r1", "macbook");
  const r = await f.report("r1", { every: 30, sessions: [{ session: "s1", agent: "pi", repo: "relay-cf", branch: "hark/x", phase: "verifying", busy: true, since: iso(125_000) }] });
  expect(r).toEqual({ ok: true, sessions: 1, every: 30, offline_after_s: 60 });
  const v = presenceView(f.sp, null), s = v.sessions[0];
  expect(s.state).toBe("busy");
  expect(s.line).toBe("Pi on relay-cf · branch hark/x · running tests · 2m");
  expect(v.summary).toBe("1 working");
});

test("a runner with nothing to do reads idle; one that misses its heartbeat (2 x every) reads offline", async () => {
  const f = fakeSpace(); f.member("r1", "macbook");
  await f.report("r1", { every: 30, sessions: [{ session: "s1", agent: "pi" }] });
  expect(presenceView(f.sp, null).sessions[0]).toMatchObject({ state: "idle", line: "Pi (macbook) · idle" });
  f.db.query("update presence set last_seen=?").run(iso(59_000)); // one missed beat is still fine
  expect(presenceView(f.sp, null).sessions[0].state).toBe("idle");
  f.db.query("update presence set last_seen=?").run(iso(61_000));
  const s = presenceView(f.sp, null).sessions[0];
  expect(s.state).toBe("offline"); expect(s.line).toBe("Pi (macbook) · offline · last seen 1m ago");
  expect(presenceView(f.sp, null).summary).toBe("1 offline");
});

test("a full report replaces earlier sessions; merge adds one; end removes one; bad input is refused", async () => {
  const f = fakeSpace(); f.member("a1", "claude-code", "agent");
  await f.report("a1", { sessions: [{ session: "w1", agent: "claude", repo: "a", busy: true }, { session: "w2", agent: "claude", repo: "b", busy: true }] });
  expect(presenceView(f.sp, null).sessions.length).toBe(2);
  await f.report("a1", { sessions: [{ session: "w3", agent: "claude", repo: "c", busy: true }] });
  expect(presenceView(f.sp, null).sessions.map((s: any) => s.repo)).toEqual(["c"]);
  await f.report("a1", { merge: true, sessions: [{ session: "w4", agent: "claude", repo: "d", busy: true }] });
  expect(presenceView(f.sp, null).sessions.length).toBe(2);
  await f.report("a1", { merge: true, sessions: [{ session: "w3", end: true }] });
  expect(presenceView(f.sp, null).sessions.map((s: any) => s.repo)).toEqual(["d"]);
  await expect(f.report("a1", { sessions: "nope" })).rejects.toThrow(/sessions: a list/);
  await expect(f.report("nobody", {})).rejects.toThrow(/no access/);
  expect((await f.report("a1", { every: 1, sessions: [] })).every).toBe(2); // clamped: nobody heartbeats faster than every 2 s
});

test("nobody can claim someone else's task; titles show only to the task's own parties", async () => {
  const f = fakeSpace(); f.member("r1", "macbook"); f.member("hark", "hark", "assistant"); f.member("other", "chatgpt", "assistant");
  f.task({ id: "t1", from_peer: "hark", target_peer: "r1", state: "running", title: "Fix the login bug", project: "relay-cf", kind: "code" }, { phase: "agent_running", agent: "codex", started_at: iso(30_000) });
  await f.report("other", { sessions: [{ session: "x", agent: "gpt", task: "t1" }] });
  expect(f.db.query("select data from presence where peer_id='other'").get()).toMatchObject({ data: expect.stringContaining('"task":null') });
  await f.report("r1", { sessions: [{ session: "s1", task: "t1" }] });
  const mine = presenceView(f.sp, { id: "hark" } as any).sessions.find((s: any) => s.who === "macbook");
  expect(mine).toMatchObject({ state: "busy", title: "Fix the login bug", agent: "codex", repo: "relay-cf", line: "Codex on relay-cf · working · 30s" });
  expect(presenceView(f.sp, { id: "other" } as any).sessions.find((s: any) => s.who === "macbook").title).toBeUndefined();
});

test("an older runner that never reports still shows from the tasks it holds", () => {
  const f = fakeSpace(); f.member("r1", "old-mac"); f.db.query("update members set last_seen=?").run(iso(5_000));
  f.task({ id: "t2", from_peer: "hark", target_peer: "r1", state: "running", title: "t", project: "web", kind: "code" }, { phase: "verifying", agent: "pi", started_at: iso(3_700_000) });
  expect(presenceView(f.sp, null).sessions[0]).toMatchObject({ source: "task", state: "busy", line: "Pi on web · running tests · 1h 1m" });
});

test("shortDur", () => { expect([shortDur(5), shortDur(61), shortDur(7260)]).toEqual(["5s", "1m", "2h 1m"]); });

const run = (e: any = {}) => ({ id: "t1", from_peer: "hark", target_peer: "r1", state: "running", kind: "code", steers: [], ...e });
test("steering: the sender and the owner may; the agent holding the task and other apps may not", () => {
  expect(checkSteer(run(), { id: "hark" }, "  use the existing helper ")).toBe("use the existing helper");
  expect(checkSteer(run(), { owner: true }, "skip the docs")).toBe("skip the docs");
  expect(() => checkSteer(run(), { id: "r1" }, "x")).toThrow(/the agent working on a task can't steer it/);
  expect(() => checkSteer(run(), { id: "chatgpt" }, "x")).toThrow(/only the task's sender or the account owner/);
});

test("steering is refused for finished tasks, quick asks, a parked question, empty/long notes, secrets and past the cap", () => {
  for (const state of ["done", "failed", "cancelled"]) expect(() => checkSteer(run({ state }), { id: "hark" }, "x")).toThrow(new RegExp(`task is ${state}`));
  expect(() => checkSteer(run({ kind: "ask" }), { id: "hark" }, "x")).toThrow(/quick ask can't be steered/);
  expect(() => checkSteer(run({ state: "needs_input" }), { owner: true }, "x")).toThrow(/waiting for an answer/);
  expect(() => checkSteer(run(), { id: "hark" }, "   ")).toThrow(/1-4000 chars/);
  expect(() => checkSteer(run(), { id: "hark" }, "x".repeat(4001))).toThrow(/1-4000 chars/);
  expect(() => checkSteer(run(), { id: "hark" }, "use token ghp_" + "a".repeat(36))).toThrow(/looks like it contains a secret/);
  expect(() => checkSteer(run({ steers: Array.from({ length: STEER_MAX }, (_, i) => ({ n: i + 1 })) }), { id: "hark" }, "x")).toThrow(/already has 20/);
  expect(checkSteer(run({ state: "queued" }), { id: "hark" }, "before it starts")).toBe("before it starts"); // comes with the first turn
});
