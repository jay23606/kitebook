// live-claude against the fake Agent SDK (scripts/fake-claude-sdk.ts): a turn streams, steering mid-turn (next and now), interrupt,
// approvals (answered, and denied by Kitebook's own timeout), forks never touch the source session, the API key is stripped unless
// opted in, and a missing SDK or an old claude says "not available" so the runner keeps the CLI adapter.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync, mkdirSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { claudeDriver, childEnv, newer, askPaths, type ClaudeDeps } from "./live-claude.ts";
import { insideDir } from "./inside.ts"; // the runner's "edit inside the worktree passes unasked" rule (client/runner.ts liveApprove)
import type { LiveEvent } from "./live-driver.ts";

const T = mkdtempSync(join(tmpdir(), "live-claude-")), LOG = join(T, "sdk.jsonl"), CLAUDE = join(T, "claude"); // the "owner's claude": a process that just lives
writeFileSync(CLAUDE, "#!/bin/sh\nwhile IFS= read -r line; do :; done\n"); chmodSync(CLAUDE, 0o755);
let F: any;
beforeAll(async () => { process.env.FAKE_CLAUDE_SDK_DIR = join(T, "sessions"); process.env.FAKE_CLAUDE_SDK_LOG = LOG; F = await import("../scripts/fake-claude-sdk.ts"); });
const deps = (x: Partial<ClaudeDeps> = {}): ClaudeDeps => ({ claude: () => CLAUDE, version: async () => "2.1.309 (Claude Code)", sdk: async () => F, agents: async () => [], ...x });
const drain = async (it: AsyncIterable<LiveEvent>, each?: (e: LiveEvent) => void | Promise<void>) => { const all: LiveEvent[] = []; for await (const e of it) { all.push(e); await each?.(e); } return all; };
const texts = (es: LiveEvent[]) => es.filter(e => e.text).map(e => e.text);
const logged = () => readFileSync(LOG, "utf8").trim().split("\n").map(l => JSON.parse(l));

test("available: SDK + owner's claude + new enough; else the CLI adapter", async () => {
  expect(await claudeDriver(deps()).available()).toBe(true);
  expect(await claudeDriver(deps({ sdk: async () => null })).available()).toBe(false);          // SDK not installed
  expect(await claudeDriver(deps({ claude: () => null })).available()).toBe(false);             // no claude on PATH
  expect(await claudeDriver(deps({ version: async () => "2.0.77" })).available()).toBe(false);  // too old
  expect(newer("2.1.199")).toBe(true); expect(newer("2.1.198")).toBe(false); expect(newer("3.0.0")).toBe(true); expect(newer(null)).toBe(false);
});

test("a turn streams lines and ends with done; the session stays up for the next turn", async () => {
  const s = await claudeDriver(deps()).start({ cwd: T, env: { PATH: "/usr/bin", HOME: T, ANTHROPIC_API_KEY: "sk-x" } });
  const a = await drain(s.prompt("hello")); expect(texts(a)).toEqual(["echo: hello"]); expect(a.at(-1)?.done).toBe(true); expect(a.some(e => e.sid === s.id)).toBe(true);
  expect(texts(await drain(s.prompt("again")))).toEqual(["echo: again"]);
  const q = logged().filter(x => x.query).at(-1).query;
  expect(q.pathToClaudeCodeExecutable).toBe(CLAUDE); expect(q.permissionMode).toBe("acceptEdits"); expect(q.sessionId).toBe(s.id);
  expect(q.env.ANTHROPIC_API_KEY).toBeNull(); expect(q.env.keys).toContain("PATH"); // stripped: the owner stays on their plan
  await s.close();
});

test("ANTHROPIC_API_KEY stays only when runner.json opts in; read-only runs in plan mode", async () => {
  expect(childEnv({ ANTHROPIC_API_KEY: "k", PATH: "/b" }, false).ANTHROPIC_API_KEY).toBeUndefined();
  expect(childEnv({ ANTHROPIC_API_KEY: "k" }, true).ANTHROPIC_API_KEY).toBe("k");
  const s = await claudeDriver(deps({ apiKey: () => true })).start({ cwd: T, readOnly: true, env: { ANTHROPIC_API_KEY: "sk-y" } });
  await drain(s.prompt("x")); const q = logged().filter(x => x.query).at(-1).query;
  expect(q.env.ANTHROPIC_API_KEY).toBe("sk-y"); expect(q.permissionMode).toBe("plan"); await s.close();
});

test("read-only sessions deny commands, edits and MCP without asking the owner", async () => {
  const s = await claudeDriver(deps()).start({ cwd: T, readOnly: true });
  try { for (const tool of ["Bash", "Edit", "mcp__github__create_issue"]) {
    const a = await drain(s.prompt(`tool ${tool} blocked`)); expect(a.some(e => e.approval)).toBe(false); expect(texts(a)[0]).toContain("Read-only questions"); }
    const q = logged().filter(x => x.query).at(-1).query; expect(q.tools).toEqual(["Read", "Glob", "Grep", "LS"]); expect(q.strictMcpConfig).toBe(true); expect(q.mcpServers).toEqual({});
  } finally { await s.close(); }
});

test("a mid-turn steer (now) is read in the same turn; other steers wait for the next prompt", async () => {
  const s = await claudeDriver(deps()).start({ cwd: T });
  const a = await drain(s.prompt("slow"), e => { if (e.text === "working") s.steer("use the blue one", "now"); });
  expect(texts(a)).toEqual(["working", "steered: use the blue one"]); expect(a.filter(e => e.done).length).toBe(1);
  const sent = logged().filter(x => x.query).length; expect(sent).toBeGreaterThan(0);
  await expect(s.steer("too late", "now")).rejects.toThrow();                    // no turn: the runner keeps it for the next turn
  await s.steer("between turns"); expect(texts(await drain(s.prompt("next")))).toEqual(["echo: between turns\n\nnext"]);
  await s.close();
});

test("interrupt stops the turn", async () => {
  const s = await claudeDriver(deps()).start({ cwd: T });
  const a = await drain(s.prompt("slow"), e => { if (e.text === "working") s.interrupt(); });
  expect(a.at(-1)).toEqual({ done: true, interrupted: true }); expect(a.find(e => e.err)?.err).toContain("interrupted"); await s.close();
});

test("approvals: a PreToolUse line, the ask as an event, the answer goes back; Kitebook's timeout denies", async () => {
  const s = await claudeDriver(deps()).start({ cwd: T });
  const a = await drain(s.prompt("tool Bash npm publish"), e => { if (e.approval) s.answer(e.approval.id, true); });
  expect(a.find(e => e.line)?.line).toBe("→ Bash npm publish"); expect(a.find(e => e.approval)?.approval).toMatchObject({ tool: "command", summary: "Claude wants to run npm publish", input: { tool: "Bash", command: "npm publish" } });
  expect(texts(a)).toEqual(["allowed npm publish"]);
  expect(logged().filter(x => x.permission).at(-1).permission).toEqual({ tool: "Bash", behavior: "allow", updatedInput: { command: "npm publish" } }); // Claude's own input back, unchanged
  const b = await drain(s.prompt("tool Bash rm -rf x"), e => { if (e.approval) s.answer(e.approval.id, false, "not today"); });
  expect(texts(b)).toEqual(["denied: not today"]); await s.close();
  const t = await claudeDriver(deps({ approvalTimeoutMs: () => 150 })).start({ cwd: T });
  const c = await drain(t.prompt("tool Bash curl x"));                                       // nobody answers
  expect(texts(c)[0]).toContain("denied: Kitebook approval timed out"); expect(c.some(e => e.line?.includes("denied"))).toBe(true); await t.close();
});

test("a fork never writes to the source session; a held session is forked, never resumed in place", async () => {
  const src = "11111111-2222-4333-8444-555555555555", f = join(process.env.FAKE_CLAUDE_SDK_DIR!, `${src}.jsonl`);
  F.fakeSession(src, [{ type: "user", text: "owner's own work" }]); const before = readFileSync(f, "utf8");
  const d = claudeDriver(deps());
  expect((await d.listSessions!({ cwd: T })).some(x => x.id === src && x.title === "owner's own work")).toBe(true);
  expect(d.forks).toBe(true); // live-sessions routes session_send forks through start({ fork }) (client/runner-sessions.ts liveForks)
  const s = await d.start({ cwd: T, fork: { from: src } }); expect(s.id).not.toBe(src);
  expect(texts(await drain(s.prompt("continue")))).toEqual(["echo: continue"]); await s.close();
  expect(readFileSync(f, "utf8")).toBe(before); expect(existsSync(join(process.env.FAKE_CLAUDE_SDK_DIR!, `${s.id}.jsonl`))).toBe(true);
  // resume: held by a live claude -> fork; claude agents --json can't tell -> fork; free -> in place
  const held = await claudeDriver(deps({ agents: async () => [{ sessionId: src, pid: 4242, status: "running" }] })).start({ cwd: T, resume: src });
  expect(held.id).not.toBe(src); await held.close();
  const unknown = await claudeDriver(deps({ agents: async () => null })).start({ cwd: T, resume: src }); expect(unknown.id).not.toBe(src); await unknown.close();
  expect(readFileSync(f, "utf8")).toBe(before);
  const free = await claudeDriver(deps({ agents: async () => [{ sessionId: src, pid: 0, status: "stopped" }] })).start({ cwd: T, resume: src }); expect(free.id).toBe(src); await free.close();
});

test("a session claude can't open fails start, so the runner falls back", async () => {
  await expect(claudeDriver(deps({ agents: async () => [] })).start({ cwd: T, resume: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow();
});

test("Claude's own AskUserQuestion is pointed at Kitebook's question marker, not the approval path", async () => {
  const s = await claudeDriver(deps()).start({ cwd: T });
  const a = await drain(s.prompt("tool AskUserQuestion which-db"));
  expect(a.some(e => e.approval)).toBe(false); expect(texts(a)[0]).toContain("[relay-question:"); await s.close();
});

test("interrupt withdraws a steer Claude hasn't read, so it can't restart the stopped turn", async () => {
  const s = await claudeDriver(deps()).start({ cwd: T });
  const a = await drain(s.prompt("deaf"), async e => { if (e.text === "working") { await s.steer("queued note", "now"); await s.interrupt(); } });
  expect(a.at(-1)?.done).toBe(true); expect(a.find(e => e.err)?.err).toContain("interrupted"); expect(logged().some(x => x.withdrawn)).toBe(true);
  expect(texts(await drain(s.prompt("after")))).toEqual(["echo: after"]); await s.close();
});

test("the runner gets claude's pid; claude dying between turns ends the session with an error, never a hang", async () => {
  const s: any = await claudeDriver(deps()).start({ cwd: T });
  expect(texts(await drain(s.prompt("one")))).toEqual(["echo: one"]); expect(s.pid).toBeGreaterThan(0);
  process.kill(s.pid, "SIGKILL"); await Bun.sleep(400);
  const b = await drain(s.prompt("two")); expect(b.find(e => e.err)?.err).toMatch(/exited/); expect(b.at(-1)?.done).toBe(true); await s.close();
});

test("an edit outside the folder asks as a file_change with its path; the wrap and extra roots reach the spawn", async () => {
  const W = join(T, "wrap.log"), wrap = (argv: string[]) => { writeFileSync(W, JSON.stringify(argv)); return argv; };
  const s = await claudeDriver(deps()).start({ cwd: T, wrap, writableRoots: ["/tmp/extra"] });
  const a = await drain(s.prompt("tool Edit /etc/hosts"), e => { if (e.approval) s.answer(e.approval.id, false); });
  expect(a.find(e => e.approval)?.approval).toMatchObject({ tool: "file_change", paths: ["/etc/hosts"] });
  expect(JSON.parse(readFileSync(W, "utf8"))[0]).toBe(CLAUDE); expect(logged().filter(x => x.query).at(-1).query.additionalDirectories).toEqual(["/tmp/extra"]); await s.close();
});

test("a claude that can't start fails start() (the runner then runs claude -p for that turn)", async () => {
  await expect(claudeDriver(deps({ claude: () => join(T, "no-such-claude") })).start({ cwd: T })).rejects.toThrow();
});

test("the runner's driver: KITEBOOK_CLAUDE_BIN + the SDK module, why() when it can't", async () => {
  process.env.KITEBOOK_CLAUDE_BIN = join(T, "no-claude-here"); const { driver } = await import("./live-claude.ts");
  expect(driver.agent).toBe("claude"); expect(typeof driver.why).toBe("function");
  expect(await driver.available()).toBe(false); expect(driver.why!()).toBeTruthy(); delete process.env.KITEBOOK_CLAUDE_BIN;
});

test("a symlink, a dangling link or a '..' can't carry an 'inside' edit out of the worktree", () => {
  const T = mkdtempSync(join(tmpdir(), "kb-inside-")), wt = join(T, "wt"), out = join(T, "secret"); mkdirSync(join(wt, "src"), { recursive: true }); mkdirSync(out);
  symlinkSync(out, join(wt, "link")); symlinkSync(join(out, "new.txt"), join(wt, "dangling")); writeFileSync(join(out, "f"), "x"); symlinkSync(join(out, "f"), join(wt, "filelink"));
  symlinkSync(join(wt, "src"), join(T, "wtsrc")); // a link INTO the worktree is fine
  for (const p of ["src/a.ts", join(wt, "src/new/deep.ts"), wt, join(T, "wtsrc/a.ts")]) expect(insideDir(p, wt)).toBe(true);
  for (const p of ["link/x", join(wt, "link/new/deep.ts"), "dangling", "filelink", "src/../link/x", "src/../a.ts", join(T, "x"), "/etc/hosts"]) expect(insideDir(p, wt)).toBe(false);
});

test("live claude: the path Claude's own check flagged (blockedPath) counts next to the input's", () => {
  expect(askPaths("Edit", { file_path: "/wt/a" }, { blockedPath: "/home/me/.ssh/config" })).toEqual(["/home/me/.ssh/config", "/wt/a"]);
  expect(askPaths("Edit", { file_path: "/wt/a" }, {})).toEqual(["/wt/a"]);
  expect(askPaths("Bash", { command: "ls" }, { blockedPath: "/etc" })).toEqual(["/etc"]); expect(askPaths("Bash", { command: "ls" }, {})).toBeUndefined();
});
