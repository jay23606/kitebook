// The live Codex driver (client/live-codex.ts) against a fake `codex app-server` (scripts/fake-codex-app-server.ts): a turn streams lines,
// a steer reaches the running turn, interrupt stops it, approvals come out as events and the answer goes back, a crash ends the turn,
// externalSandbox only when Kitebook wraps the process, fork never writes to the source thread, and the selector falls back to the CLI.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setCfg } from "./runner-ctx.ts";
import { driver, mapNote, sandboxFor, codexReadOnlyArgv, parseVersion, activeWriter, RpcError } from "./live-codex.ts";
import { liveFor, liveBroken, registerLive, liveOff, type LiveEvent, type LiveSession } from "./live-driver.ts";
import { codexAskArgv } from "./runner-ask.ts";

const T = mkdtempSync(join(tmpdir(), "live-codex-")), BIN = join(T, "bin"), LOG = join(T, "rpc.jsonl"), WT = join(T, "wt");
const FAKE = join(import.meta.dir, "..", "scripts", "fake-codex-app-server.ts");
const PATH0 = process.env.PATH;
beforeAll(() => {
  Bun.spawnSync(["mkdir", "-p", BIN, WT]);
  writeFileSync(join(BIN, "codex"), `#!/bin/sh\ncase "$1" in\n --version) echo "codex-cli \${FAKE_CODEX_VERSION:-0.163.0}";;\n app-server) [ "$2" = "--help" ] && { echo "[experimental] Run the app server or related tooling"; exit 0; }; exec ${process.execPath} ${FAKE};;\n *) exit 2;;\nesac\n`);
  chmodSync(join(BIN, "codex"), 0o755);
  process.env.PATH = `${BIN}:${PATH0}`; process.env.FAKE_CODEX_LOG = LOG; setCfg({});
});
const env = () => ({ PATH: `${BIN}:${PATH0}`, HOME: process.env.HOME ?? T, FAKE_CODEX_LOG: LOG });
const sent = (method: string) => existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(x => x.method === method) : [];
async function collect(it: AsyncIterable<LiveEvent>, on?: (e: LiveEvent) => void) { const evs: LiveEvent[] = []; for await (const e of it) { evs.push(e); on?.(e); } return evs; }
const said = (evs: LiveEvent[]) => evs.map(e => e.text ?? "").filter(Boolean).join("\n");

test("version gate and pure helpers", () => {
  expect(parseVersion("codex-cli 0.163.0")).toEqual([0, 163, 0]);
  expect(mapNote("item/started", { item: { type: "commandExecution", command: "npm   test" } })).toEqual({ line: "→ $ npm test" });
  expect(mapNote("item/completed", { item: { type: "agentMessage", text: "hi" } })).toEqual({ text: "hi" });
  expect(mapNote("item/completed", { item: { type: "commandExecution", command: "false", exitCode: 1 } })).toEqual({ line: "✗ exit 1: false" });
  expect(mapNote("thread/started", { thread: { id: "t1" } })).toEqual({ sid: "t1" });
  expect(mapNote("item/agentMessage/delta", { delta: "x" })).toBeNull();
  expect(activeWriter(new RpcError("thread x already has an active writer", -32600))).toBe(true);
  // the nested-Seatbelt fix: Codex applies no sandbox of its own only when Kitebook's OS sandbox wraps it
  expect(sandboxFor({ cwd: WT, readOnly: true, wrapped: true })).toEqual({ type: "externalSandbox", networkAccess: "enabled" });
  expect(sandboxFor({ cwd: WT, readOnly: true })).toEqual({ type: "readOnly", networkAccess: false });
  expect(sandboxFor({ cwd: WT })).toMatchObject({ type: "workspaceWrite", writableRoots: [WT], networkAccess: false });
  // the exec fallback: danger-full-access only inside the wrapper; Codex's own read-only sandbox where Kitebook has none
  const a = ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "{prompt}"];
  expect(codexAskArgv(a, "sandbox-exec")).toEqual(["codex", "exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "{prompt}"]);
  expect(codexAskArgv(a, "userns")[3]).toBe("danger-full-access");
  expect(codexAskArgv(a, "none")).toEqual(a);
});

test("available(): app-server present and new enough; too old says why", async () => {
  expect(await driver.available()).toBe(true);
  process.env.FAKE_CODEX_VERSION = "0.120.0"; expect(await driver.available()).toBe(false); expect(driver.why?.()).toMatch(/older than 0\.146/);
  delete process.env.FAKE_CODEX_VERSION;
});

test("a turn streams lines and text, sid first; a raw U+2028 doesn't split the message", async () => {
  const s = await driver.start({ cwd: WT, env: env() });
  try { const evs = await collect(s.prompt("hello there"));
    expect(evs[0].sid).toBe(s.id); expect(evs.some(e => e.line === "→ $ ls")).toBe(true);
    expect(said(evs)).toContain("echo: hello there \u2028end"); expect(evs.at(-1)).toEqual({ done: true });
    const ts = sent("turn/start").at(-1).params; expect(ts.sandboxPolicy.type).toBe("workspaceWrite"); expect(ts.approvalPolicy).toBe("never");
    expect(sent("thread/start").at(-1).params.serviceName).toBe("kitebook");
    // a second turn on the same live session (no new process)
    const evs2 = await collect(s.prompt("again")); expect(said(evs2)).toContain("echo: again");
  } finally { await s.close(); }
});

test("a steer reaches the running turn; interrupt stops one", async () => {
  const s = await driver.start({ cwd: WT, env: env() });
  try {
    const evs = await collect(s.prompt("SLOW work"), e => { if (e.line?.startsWith("→ $ sleep")) s.steer("use the other file", "now"); });
    expect(said(evs)).toContain("steered: use the other file"); expect(sent("turn/steer").at(-1).params.expectedTurnId).toBeTruthy();
    const t0 = Date.now(), evs2 = await collect(s.prompt("SLOW again"), e => { if (e.line?.startsWith("→ $ sleep")) s.interrupt(); });
    expect(evs2.at(-1)).toEqual({ done: true, interrupted: true }); expect(Date.now() - t0).toBeLessThan(6000);
    await expect(s.steer("too late", "now")).rejects.toThrow(/no turn/); // between turns: the runner keeps it for the next turn
    await s.steer("queued for next", "next"); const evs3 = await collect(s.prompt("third")); expect(said(evs3)).toContain("queued for next");
  } finally { await s.close(); }
});

test("approvals come out as events and the answer goes back (allow and deny)", async () => {
  const s = await driver.start({ cwd: WT, env: env() });
  try {
    let a: any = null; const evs = await collect(s.prompt("APPROVE please"), e => { if (e.approval) { a = e.approval; s.answer(e.approval.id, false); } });
    expect(a.tool).toBe("command"); expect(a.summary).toContain("curl example.com"); expect(said(evs)).toContain("decision: decline");
    const evs2 = await collect(s.prompt(`FILEAPPROVE ${join(WT, "src/a.ts")}`), e => { if (e.approval) { a = e.approval; s.answer(e.approval.id, true); } });
    expect(a.tool).toBe("file_change"); expect(a.paths).toEqual([join(WT, "src/a.ts")]); expect(said(evs2)).toContain("decision: accept");
  } finally { await s.close(); }
});

test("the app-server crashing mid-turn ends the turn with an error; the next turn respawns and resumes the thread", async () => {
  const s = await driver.start({ cwd: WT, env: env() }), id = s.id;
  try {
    const evs = await collect(s.prompt("CRASH now")); expect(evs.some(e => /exited \(code 17\)/.test(e.err ?? ""))).toBe(true); expect(evs.at(-1)?.done).toBe(true);
    const evs2 = await collect(s.prompt("after the crash")); expect(said(evs2)).toContain("echo: after the crash");
    expect(sent("thread/resume").at(-1).params.threadId).toBe(id);
  } finally { await s.close(); }
});

test("under Kitebook's wrapper the sandbox is external: a fake nested Seatbelt fails any other policy", async () => {
  const wrapped = await driver.start({ cwd: WT, env: { ...env(), FAKE_SEATBELT: "1" }, readOnly: true, wrapped: true, wrap: argv => argv });
  try { const evs = await collect(wrapped.prompt("read only question")); expect(evs.some(e => e.err)).toBe(false); expect(said(evs)).toContain("echo:"); } finally { await wrapped.close(); }
  const own = await driver.start({ cwd: WT, env: { ...env(), FAKE_SEATBELT: "1" }, readOnly: true }); // Codex's own sandbox under a Seatbelt: the bug
  try { const evs = await collect(own.prompt("read only question")); expect(evs.find(e => e.err)?.err).toMatch(/sandbox_apply/); } finally { await own.close(); }
});

test("the CLI fallback uses the same external-tool restrictions and refuses unsupported config probes", async () => {
  const argv = await codexReadOnlyArgv([join(BIN, "codex"), "exec", "--sandbox", "read-only", "{prompt}"], WT, env());
  expect(argv).toContain("exec"); expect(argv.join(" ")).toContain('"write_test" = { "enabled" = false }');
  await expect(codexReadOnlyArgv(["no-such-codex", "exec"], WT, { PATH: "/nonexistent" })).rejects.toThrow();
});

test("a read-only live session disables MCP and app tools in the effective config", async () => {
  const s = await driver.start({ cwd: WT, env: env(), readOnly: true });
  try { expect(sent("thread/start").at(-1).params.config).toMatchObject({ mcp_servers: { write_test: { enabled: false } }, apps: { app_test: { enabled: false } } });
    await collect(s.prompt("read only")); expect(sent("turn/start").at(-1).params.approvalPolicy).toBe("never");
  } finally { await s.close(); }
});

test("resume of a thread open elsewhere forks; fork never touches the source; listSessions filters by cwd", async () => {
  const s = await driver.start({ cwd: WT, env: env(), resume: "owner-open-2" });
  try { expect(s.id).toMatch(/^fork_/); expect(sent("thread/fork").at(-1).params.threadId).toBe("owner-open-2"); } finally { await s.close(); }
  const f = await driver.start({ cwd: WT, env: env(), fork: { from: "owner-1", upTo: "turn_9" } });
  try { expect(f.id).toMatch(/^fork_/); const p = sent("thread/fork").at(-1).params; expect(p).toMatchObject({ threadId: "owner-1", lastTurnId: "turn_9" });
    await collect(f.prompt("continue")); expect(sent("turn/start").at(-1).params.threadId).toBe(f.id); } finally { await f.close(); }
  const list = await driver.listSessions!({ cwd: process.cwd(), limit: 5 }); expect(list.map(x => x.id)).toEqual(["owner-1", "owner-open-2"]); expect(list[0].title).toBe("fix the login bug");
});

test("selector: live when available, CLI when off, broken, or missing", async () => {
  setCfg({}); expect((await liveFor("codex"))?.agent).toBe("codex");
  setCfg({ live: { codex: false } }); expect(await liveFor("codex")).toBeNull(); expect(liveOff("codex")).toMatch(/"codex": false/);
  setCfg({ agents: { codex: ["my-codex", "{prompt}"] } }); expect(await liveFor("codex")).toBeNull(); // the owner's own argv wins
  setCfg({}); liveBroken("codex", "handshake failed"); expect(await liveFor("codex")).toBeNull();
  registerLive("codex", async () => driver); expect((await liveFor("codex"))?.agent).toBe("codex"); // re-registered: broken cleared
  registerLive("nothere", async () => ({ ...driver, agent: "nothere", available: async () => false, why: () => "not installed" })); expect(await liveFor("nothere")).toBeNull();
  expect(await liveFor("gemini")).toBeNull(); // no driver: CLI adapter
  const bad = { ...driver, start: async () => { throw new Error("spawn ENOENT"); } }; registerLive("codex", async () => bad);
  const d = await liveFor("codex"); await expect(d!.start({ cwd: WT })).rejects.toThrow(/ENOENT/);
  registerLive("codex", async () => driver);
});

test("start() fails cleanly when codex can't be spawned", async () => {
  const s: Promise<LiveSession> = driver.start({ cwd: WT, env: { PATH: "/nonexistent", HOME: T } }); // falls back to "codex" on a PATH without it
  await expect(s).rejects.toThrow();
});
