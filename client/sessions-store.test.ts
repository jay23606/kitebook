// live-sessions: the owner's local agent sessions, read-only (client/sessions-store.ts). Every store here is a FAKE written into a temp home
// (synthetic transcripts, never a real agent's files). Run: bun test client/sessions-store.test.ts
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, statSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import * as SS from "./sessions-store.ts";

const H = mkdtempSync(join(tmpdir(), "kb-sessions-")), REPO = "/work/acme-app", OLD = Date.now() - 3600_000;
const SECRET = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", KEY = "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123";
const jl = (...xs: any[]) => xs.map(x => JSON.stringify(x)).join("\n") + "\n";
const put = (p: string, s: string, mtime = OLD) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); utimesSync(p, mtime / 1000, mtime / 1000); return p; };
const O: SS.Opts = { home: H, env: {}, index: join(H, "ix.json"), agentsJson: async () => [] };
const files: Record<string, string> = {};

beforeAll(() => {
  const cx = "019a0000-0000-7000-8000-00000000c0de";
  files.codex = put(join(H, ".codex/sessions/2026/10/20", `rollout-2026-10-20T10-00-00-${cx}.jsonl`), jl(
    { timestamp: "2026-10-20T10:00:00Z", type: "session_meta", payload: { id: cx, cwd: REPO, source: "cli" } },
    { timestamp: "2026-10-20T10:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
    { timestamp: "2026-10-20T10:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the flaky retry test in uploads" }] } },
    { timestamp: "2026-10-20T10:00:03Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `Done. I used token ${SECRET} from your env.` }] } }));
  put(join(H, ".codex/session_index.jsonl"), jl({ id: cx, thread_name: "Uploads retry fix" }));
  files.claude = put(join(H, ".claude/projects", SS.claudeDirName(REPO), "c1a0de00-1111-4222-8333-444455556666.jsonl"), jl(
    { type: "user", sessionId: "c1a0de00-1111-4222-8333-444455556666", cwd: REPO, timestamp: "2026-10-21T09:00:00Z", message: { role: "user", content: "add dark mode to the settings page" } },
    { type: "assistant", sessionId: "c1a0de00-1111-4222-8333-444455556666", cwd: REPO, message: { role: "assistant", content: [{ type: "text", text: `Set ANTHROPIC_API_KEY=${KEY} first.` }, { type: "tool_use", name: "Edit" }] } },
    { type: "summary", summary: "Dark mode for settings" }));
  files.pi = put(join(H, ".pi/agent/sessions", "--work-acme-app--", "2026-10-22T08-00-00_p1.jsonl"), jl(
    { type: "session", version: 3, id: "pi-session-1", cwd: REPO, timestamp: "2026-10-22T08:00:00Z" },
    { type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "explain the billing webhook" }] } },
    { type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "The webhook verifies a signature, then queues the invoice." }] } },
    { type: "session_info", name: "Billing webhook" }));
  const gh = createHash("sha256").update(REPO).digest("hex");
  files.gemini = put(join(H, ".gemini/tmp", gh, "chats", "session-2026-10-19.json"), JSON.stringify({ sessionId: "gem-1", projectHash: gh, lastUpdated: new Date(OLD).toISOString(),
    messages: [{ type: "user", content: "rename the cli flags", timestamp: "2026-10-19T00:00:00Z" }, { type: "gemini", content: "Renamed --out to --output." }] }));
  files.copilot = put(join(H, ".copilot/session-state/cop-1/events.jsonl"), jl(
    { type: "session.start", data: { sessionId: "cop-1", context: { cwd: REPO } } }, { type: "user.message", data: { content: "write a changelog entry" } }, { type: "assistant.message", data: { content: "Added to CHANGELOG.md" } }));
  mkdirSync(join(H, ".local/share/opencode"), { recursive: true });
  const db = new Database(join(H, ".local/share/opencode/opencode.db"));
  db.run("create table session(id text, project_id text, directory text, title text, time_created integer, time_updated integer)");
  db.run("create table message(id text, session_id text, time_created integer, data text)"); db.run("create table part(id text, message_id text, session_id text, data text)");
  db.run("insert into session values('oc-1','p',?, 'Migrate to sqlite', ?, ?)", [REPO, OLD, OLD]);
  db.run("insert into message values('m1','oc-1',?,?)", [OLD, JSON.stringify({ role: "user" })]); db.run("insert into part values('p1','m1','oc-1',?)", [JSON.stringify({ type: "text", text: "migrate the storage layer to sqlite" })]);
  db.run("insert into message values('m2','oc-1',?,?)", [OLD + 1, JSON.stringify({ role: "assistant" })]); db.run("insert into part values('p2','m2','oc-1',?)", [JSON.stringify({ type: "text", text: "Migrated." })]);
  db.close(); utimesSync(join(H, ".local/share/opencode/opencode.db"), OLD / 1000, OLD / 1000);
  put(join(H, ".cursor/chats/abc/cur-1/meta.json"), JSON.stringify({ agentId: "cur-1", name: "Refactor auth", cwd: REPO }));
  files.cursor = put(join(H, ".cursor/projects/acme/agent-transcripts/cur-1/cur-1.jsonl"), jl({ role: "user", message: { content: [{ type: "text", text: "refactor the auth middleware" }] } }, { role: "assistant", message: { content: [{ type: "text", text: "Split it in two." }] } }));
});

test("every agent's store is listed with id, title and cwd", () => {
  const all = SS.listAll(O), by = Object.fromEntries(all.map(m => [m.agent, m]));
  expect(Object.keys(by).sort()).toEqual([...SS.SESSION_AGENTS].sort());
  expect(by.codex.title).toBe("Uploads retry fix"); expect(by.codex.cwd).toBe(REPO);
  expect(by.claude.title).toBe("Dark mode for settings"); expect(by.pi.title).toBe("Billing webhook"); expect(by.pi.id).toBe("pi-session-1");
  expect(by.gemini.id).toBe("gem-1"); expect(by.copilot.cwd).toBe(REPO); expect(by.opencode.title).toBe("Migrate to sqlite"); expect(by.cursor.title).toBe("Refactor auth");
  expect(SS.listAll({ ...O, cwd: REPO }).length).toBe(7); // gemini matches by sha256(cwd)
  expect(SS.listAll({ ...O, cwd: "/elsewhere" }).length).toBe(0);
});

test("search finds words in the transcript, filters by agent, returns redacted snippets and never a file path", async () => {
  const r = await SS.search({ query: "retry uploads" }, O);
  expect(r.sessions.map(s => s.agent)).toEqual(["codex"]); expect(r.sessions[0].title).toBe("Uploads retry fix");
  const t = await SS.search({ query: "token", agent: "codex" }, O);
  expect(t.sessions[0].snippet).not.toContain(SECRET); expect(t.sessions[0].snippet).toContain("[REDACTED]");
  expect(JSON.stringify(t)).not.toContain(".codex/sessions");
  expect((await SS.search({ query: "webhook", agent: "pi" }, O)).sessions[0].id).toBe("pi-session-1");
  expect((await SS.search({ query: "sqlite" }, O)).sessions.map(s => s.agent)).toEqual(["opencode"]);
  expect((await SS.search({ query: "nothing-matches-this" }, O)).sessions).toEqual([]);
  expect(() => SS.listAll({ ...O, agent: "notepad" })).toThrow(/agent: one of/);
});

test("the local index holds only redacted, capped text and is private (0600)", async () => {
  await SS.search({ query: "" , limit: 50 }, O);
  const ix = readFileSync(join(H, "ix.json"), "utf8");
  expect(ix).not.toContain(SECRET); expect(ix).not.toContain(KEY); expect(ix).toContain("[REDACTED]");
  expect(statSync(join(H, "ix.json")).mode & 0o777).toBe(0o600);
  for (const r of Object.values<any>(JSON.parse(ix))) expect(r.text.length).toBeLessThanOrEqual(SS.LIMITS.indexText + 10);
});

test("session_get returns the last N messages, redacted, and skips the agent's own preamble", async () => {
  const g = await SS.get({ agent: "codex", id: "019a0000-0000-7000-8000-00000000c0de", last: 5 }, O);
  expect(g.messages.map(m => m.role)).toEqual(["user", "assistant"]); expect(g.messages[1].text).not.toContain(SECRET);
  const c = await SS.get({ agent: "claude", id: "c1a0de00-1111-4222-8333-444455556666" }, O);
  expect(c.messages[1].text).toContain("[REDACTED]"); expect(c.messages[1].text).not.toContain(KEY);
  expect((await SS.get({ agent: "opencode", id: "oc-1" }, O)).messages.map(m => m.text)).toEqual(["migrate the storage layer to sqlite", "Migrated."]);
  expect((await SS.get({ agent: "pi", id: "pi-session-1", last: 1 }, O)).messages.length).toBe(1);
  await expect(SS.get({ agent: "pi", id: "nope" }, O)).rejects.toThrow(/no pi session nope/);
});

test("reading never writes the source sessions (fork-never-writes-source)", async () => {
  const before = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, [readFileSync(f, "utf8"), statSync(f).mtimeMs]]));
  for (const m of SS.listAll(O)) await SS.get({ agent: m.agent, id: m.id }, O);
  await SS.transplant("pi", "pi-session-1", O); await SS.search({ query: "a" }, O);
  for (const [k, f] of Object.entries(files)) { expect(readFileSync(f, "utf8")).toBe(before[k][0] as string); expect(statSync(f).mtimeMs).toBe(before[k][1] as number); }
});

test("live: claude agents --json, codex writer lock, a fresh write", async () => {
  const claude = SS.listAll({ ...O, agent: "claude" })[0];
  expect((await SS.liveOf(claude, O)).live).toBe(false);
  expect((await SS.liveOf(claude, { ...O, agentsJson: async () => [{ sessionId: claude.id, pid: process.pid, status: "running" }] })).live).toBe(true);
  expect((await SS.liveOf(claude, { ...O, agentsJson: async () => null })).live).toBe(null); // can't tell: callers treat it as live
  const cx = SS.listAll({ ...O, agent: "codex" })[0];
  put(join(H, ".codex/thread-writer-locks", `${cx.id}.lock`), "");
  expect((await SS.liveOf(cx, { ...O, now: cx.updatedAt + 60_000 })).live).toBe(true);
  expect((await SS.liveOf(cx, { ...O, now: cx.updatedAt + 3600_000 })).live).toBe(null); // an idle writer lock isn't a closed thread: can't tell
  rmSync(join(H, ".codex/thread-writer-locks", `${cx.id}.lock`));
  expect((await SS.liveOf(cx, { ...O, now: cx.updatedAt + 3600_000 })).live).toBe(false); // Codex keeps locks and this thread has none: closed
  const pi = SS.listAll({ ...O, agent: "pi" })[0];
  expect((await SS.liveOf(pi, { ...O, now: pi.updatedAt + 10_000 })).live).toBe(true);
  expect((await SS.liveOf(pi, { ...O, now: pi.updatedAt + 3600_000 })).live).toBe(null); // idle: Pi keeps no writer record, so unknown, never "closed"
});

test("transplant: a capped, redacted copy of the owner's session to seed a NEW one", async () => {
  const t = await SS.transplant("claude", "c1a0de00-1111-4222-8333-444455556666", O);
  expect(t.text).toContain("Continued from the owner's claude session"); expect(t.text).toContain("not changed"); expect(t.text).not.toContain(KEY);
});

test("since filters by age", async () => {
  expect((await SS.search({ since: "5m" }, O)).sessions.length).toBe(0);
  expect((await SS.search({ since: "2d", limit: 50 }, O)).sessions.length).toBe(7);
});

test("memory: a .zst rollout is decompressed only when small (its head read from the start); a big one lists by file name, unread", async () => {
  const Z = mkdtempSync(join(tmpdir(), "kb-zst-")), d = join(Z, ".codex/archived_sessions"), small = "019a0000-0000-7000-8000-00000000a001", big = "019a0000-0000-7000-8000-00000000a002";
  mkdirSync(d, { recursive: true }); const o: SS.Opts = { home: Z, env: {}, index: false, agentsJson: async () => [] };
  writeFileSync(join(d, `rollout-x-${small}.jsonl.zst`), (Bun as any).zstdCompressSync(Buffer.from(jl({ type: "session_meta", payload: { id: small, cwd: REPO } },
    ...Array.from({ length: 2000 }, (_, i) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `turn ${i} ${"x".repeat(60)}` }] } }))))));
  writeFileSync(join(d, `rollout-x-${big}.jsonl.zst`), require("crypto").randomBytes(SS.LIMITS.zstBytes + 1024)); // past the cap: never decompressed
  const l = SS.listAll({ ...o, agent: "codex" }), s = l.find(m => m.id === small)!, b = l.find(m => m.id === big)!;
  expect(s.cwd).toBe(REPO); expect(b.cwd).toBe(""); // the small one's session_meta is its FIRST line (past the 64 KB tail it'd be lost)
  expect((await SS.get({ agent: "codex", id: small, last: 1 }, o)).messages[0].text).toContain("turn 1999"); expect((await SS.get({ agent: "codex", id: big }, o)).total).toBe(0);
});
