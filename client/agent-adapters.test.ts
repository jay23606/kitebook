// The more-agents adapters against fake CLIs (scripts/fake-agents.ts) whose --help lists exactly the documented flags and which refuse any
// other flag: every argv the runner would build (task run, later turn with resume, quick ask, with and without a model) must be accepted.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, delimiter } from "path";
import { tmpdir } from "os";
import { spawnSync } from "./platform.ts";
import { ADAPTERS, build, probeHelp, listed, parseEvent, taskUuid } from "./agent-adapters.ts";

const T = mkdtempSync(join(tmpdir(), "adapters-")), NEW = join(T, "new"), OLD = join(T, "old"), LOG = join(T, "argv.jsonl");
const FAKE = join(import.meta.dir, "..", "scripts", "fake-agents.ts");
const sh = (argv: string[], dir: string, env: Record<string, string> = {}) => Bun.spawnSync(["bun", FAKE, "install", dir, ...argv]);
const pathWith = (d: string) => `${d}${delimiter}${process.env.PATH}`; // ; on Windows
const whichIn = (d: string) => (b: string) => Bun.which(b, { PATH: d });
let HELP: Record<string, string> = {}, HELP_OLD: Record<string, string> = {};
beforeAll(async () => { sh([], NEW); sh(["--old"], OLD);
  const env = { PATH: pathWith(NEW), HOME: T } as Record<string, string>;
  HELP = await probeHelp(whichIn(NEW), env); HELP_OLD = await probeHelp(whichIn(OLD), { ...env, PATH: pathWith(OLD) }); });
// run one argv (placeholders filled the way the runner fills them) through its fake CLI in a scratch worktree
// {resume} becomes `ins` (the first-turn flags or a later turn's resume flags, already filled), like buildArgv in runner-agents.ts
function run(dir: string, argv: string[], model: string | null, prompt: string, extra: Record<string, string> = {}, ins: string[] = []) {
  let a = [...argv]; const mi = a.indexOf("{model}"); if (mi >= 0) { if (model) a[mi] = model; else a.splice(mi - 1, 2); }
  const ri = a.indexOf("{resume}"); if (ri >= 0) a.splice(ri, 1, ...ins); a = a.map(x => x === "{prompt}" ? prompt : x);
  const wt = mkdtempSync(join(T, "wt-")); const p = spawnSync(a, { cwd: wt, env: { ...(process.platform === "win32" ? process.env : {}), PATH: pathWith(dir), HOME: T, FAKE_AGENT_LOG: LOG, ...extra } as any }); // as the runner starts it (Windows: the .cmd through cmd.exe)
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), wt };
}
const flagsOf = (argv: string[]) => argv.filter(x => /^-/.test(x));

test("every adapter is found and needs nothing its --help doesn't list", () => {
  expect(Object.keys(HELP).sort()).toEqual(Object.keys(ADAPTERS).sort());
  for (const n of Object.keys(ADAPTERS)) { const b = build(n, HELP[n]); expect(b.issue).toBeNull();
    for (const f of [...flagsOf(b.argv), ...flagsOf(b.ask ?? []), ...flagsOf(b.first ?? []), ...flagsOf(b.resume ?? [])].filter(f => f !== "--")) expect(listed(HELP[n], f)).toBe(true); }
});
test("task argv runs headless in the fake CLI (with and without a model), writes in the worktree, streams events where listed", () => {
  for (const n of Object.keys(ADAPTERS)) { const b = build(n, HELP[n]);
    for (const m of [null, n === "opencode" ? "fakeprov/smart-2" : "m1"]) { const r = run(NEW, b.argv, m, "add a file");
      expect({ n, code: r.code, err: r.err }).toEqual({ n, code: 0, err: "" }); expect(existsSync(join(r.wt, `${ADAPTERS[n].bin}.txt`))).toBe(true);
      if (b.events) { const evs = r.out.trim().split("\n").map(l => parseEvent(n, l)!); expect(evs.every(Boolean)).toBe(true);
        expect(evs.some(e => e.sid)).toBe(true); expect(evs.map(e => (e.text ?? "") + (e.delta ?? "")).join("")).toContain(`all done by ${ADAPTERS[n].bin}`); }
      else expect(r.out).toContain(`all done by ${ADAPTERS[n].bin}`); } }
  expect(build("gemini", HELP.gemini).events).toBe("gemini"); expect(build("cursor", HELP.cursor).events).toBe("cursor"); expect(build("opencode", HELP.opencode).events).toBe("opencode");
  expect(build("codex", HELP.codex).events).toBe("codex"); expect(build("claude", HELP.claude).events).toBe("claude");
  expect(build("copilot", HELP.copilot).events).toBeNull(); expect(build("grok", HELP.grok).events).toBeNull();
});
test("opencode and Cursor pass dash-leading prompts after --", () => {
  for (const n of ["opencode", "cursor"]) {
    const b = build(n, HELP[n]), prompt = "-start with a dash";
    expect(b.argv.slice(-2)).toEqual(["--", "{prompt}"]);
    const r = run(NEW, b.argv, "m1", prompt);
    expect(r.code).toBe(0);
    expect(readFileSync(join(r.wt, "positional-prompt.txt"), "utf8")).toBe(prompt);
    expect(readFileSync(join(r.wt, "received-prompt.txt"), "utf8")).toBe(prompt);
  }
});
test("Codex: exec --sandbox workspace-write (never the removed --full-auto, which codex 0.163 refuses with exit 2)", () => {
  const b = build("codex", HELP.codex); expect(b.argv.slice(0, 4)).toEqual(["codex", "exec", "--sandbox", "workspace-write"]); expect(b.argv).not.toContain("--full-auto");
  expect(b.argv).toContain("--json"); expect(build("codex", null).argv).not.toContain("--full-auto");
  const r = run(NEW, ["codex", "exec", "--full-auto", "{prompt}"], null, "x"); expect(r.code).toBe(2); expect(r.err).toContain("unknown option '--full-auto'");
  expect(build("codex", "Usage: codex exec [OPTIONS] [PROMPT]\n  --full-auto  old\n").issue).toContain("doesn't list --sandbox");
});
test("resume flags: a later turn passes the captured session id (codex, claude, gemini, cursor, opencode) or the session Kitebook named on the first turn (copilot, grok)", () => {
  expect(build("codex", HELP.codex).resume).toEqual(["resume", "{sid}"]); expect(build("claude", HELP.claude).resume).toEqual(["--resume", "{sid}"]);
  expect(build("gemini", HELP.gemini).resume).toEqual(["--resume", "{sid}"]); expect(build("cursor", HELP.cursor).resume).toEqual(["--resume", "{sid}"]);
  expect(build("opencode", HELP.opencode).resume).toEqual(["--session", "{sid}"]);
  expect(build("copilot", HELP.copilot).first).toEqual(["--session-id", "{tasksid}"]); expect(build("copilot", HELP.copilot).resume).toEqual(["--session-id", "{tasksid}"]);
  expect(build("grok", HELP.grok).first).toEqual(["--session-id", "{tasksid}"]); expect(build("grok", HELP.grok).resume).toEqual(["--resume", "{tasksid}"]);
  for (const b of Object.values(Object.fromEntries(Object.keys(ADAPTERS).map(n => [n, build(n, HELP[n])])))) expect(b.argv).not.toContain("--continue"); // never "the newest session on this Mac"
  for (const n of ["codex", "claude", "gemini", "cursor", "opencode"]) { const b = build(n, HELP[n]);
    const r = run(NEW, b.argv, null, "Answer from hark to your question: name=blue", {}, b.resume!.map(x => x.replace("{sid}", "sess-42")));
    expect({ n, code: r.code, err: r.err }).toEqual({ n, code: 0, err: "" }); expect(readFileSync(join(r.wt, "resumed.txt"), "utf8")).toContain("resumed=sess-42"); }
  const u = taskUuid("t_" + Math.random().toString(36).slice(2));
  for (const n of ["copilot", "grok"]) { const b = build(n, HELP[n]), fill = (a: string[]) => a.map(x => x.replace("{tasksid}", u));
    const r1 = run(NEW, b.argv, null, "FAKE-ASK name it", {}, fill(b.first!)); expect({ n, code: r1.code, err: r1.err }).toEqual({ n, code: 0, err: "" });
    const r2 = run(NEW, b.argv, null, "Answer from hark to your question: name=blue", {}, fill(b.resume!)); expect({ n, code: r2.code, err: r2.err }).toEqual({ n, code: 0, err: "" });
    expect(readFileSync(join(r2.wt, "resumed.txt"), "utf8")).toContain(`resumed=${u}`); }
  expect(taskUuid("t_1")).toBe(taskUuid("t_1")); expect(taskUuid("t_1")).not.toBe(taskUuid("t_2")); expect(taskUuid("t_1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
test("quick asks: read-only flags where the CLI has them (Grok Build: --permission-mode plan; Copilot locked down)", () => {
  for (const n of Object.keys(ADAPTERS)) { const b = build(n, HELP[n]); expect(b.askReadOnly).toBe(true);
    const r = run(NEW, b.ask!, null, "READ-ONLY rules. Question: what is here?");
    expect({ n, code: r.code, err: r.err }).toEqual({ n, code: 0, err: "" }); expect(r.out).toContain("readonly=yes");
    expect(b.ask).not.toContain("--force"); expect(b.ask).not.toContain("yolo"); expect(b.ask).not.toContain("--always-approve"); expect(b.ask).not.toContain("workspace-write");
    if (n !== "copilot") expect(b.ask).not.toContain("--allow-all-tools"); }
  const c = build("copilot", HELP.copilot).ask!; // --allow-all-tools is required headless; the deny rules win over it, and its built-in GitHub MCP server is off
  for (const t of ["write", "shell", "url", "memory"]) expect(c[c.indexOf(t) - 1]).toBe("--deny-tool");
  expect(c).toContain("--disable-builtin-mcps"); expect(c).toContain("--no-ask-user");
  expect(build("grok", HELP.grok).ask).toContain("plan");
});
test("Copilot: headless flags (no questions, no stats footer, no self-update) where listed; an older Copilot keeps working without them", () => {
  const b = build("copilot", HELP.copilot); for (const f of ["--no-ask-user", "--silent", "--no-auto-update"]) expect(b.argv).toContain(f);
  const o = build("copilot", HELP_OLD.copilot); expect(o.issue).toBeNull(); expect(o.argv).not.toContain("--silent"); expect(o.first).toBeNull(); expect(o.resume).toBeNull();
  expect(o.ask).not.toContain("--disable-builtin-mcps"); expect(run(OLD, o.argv, null, "x").code).toBe(0); expect(run(OLD, o.ask!, null, "READ-ONLY q").code).toBe(0);
});
test("an older CLI: optional flags it doesn't list are left out, and the run still works", () => {
  const g = build("gemini", HELP_OLD.gemini), c = build("cursor", HELP_OLD.cursor);
  expect(g.issue).toBeNull(); expect(g.argv).not.toContain("--skip-trust"); expect(g.events).toBeNull(); expect(g.resume).toBeNull(); expect(g.askReadOnly).toBe(false);
  expect(c.askReadOnly).toBe(false); expect(c.ask).not.toContain("--mode");
  for (const [n, b] of [["gemini", g], ["cursor", c]] as const) { expect(run(OLD, b.argv, null, "x").code).toBe(0); expect(run(OLD, b.ask!, null, "READ-ONLY q").code).toBe(0); }
});
test("a needed flag missing from --help: not offered for tasks, with the reason and the update command", () => {
  const b = build("copilot", "Usage: copilot\n  -p, --prompt <text>  run once\n");
  expect(b.issue).toContain("doesn't list --allow-all-tools"); expect(b.issue).toContain("npm i -g @github/copilot");
});
test("two CLIs called grok: --always-approve only for the one that lists it", async () => {
  const sup = join(T, "super"); mkdirSync(sup); sh([], sup);
  const h = await probeHelp(whichIn(sup), { PATH: pathWith(sup), HOME: T, FAKE_GROK: "superagent" } as any);
  const b = build("grok", h.grok); expect(b.issue).toBeNull(); expect(b.argv).not.toContain("--always-approve"); expect(build("grok", HELP.grok).argv).toContain("--always-approve");
  // the community CLI prints one JSON message per line: parsed (events "grok"), no resume, quick asks behind the git check and parsed too
  expect(b.events).toBe("grok"); expect(b.askEvents).toBe("grok"); expect(b.resume).toBeNull(); expect(b.first).toBeNull(); expect(b.askReadOnly).toBe(false);
  expect(build("grok", HELP.grok).events).toBeNull(); expect(build("grok", HELP.grok).askEvents).toBeNull();
  const r = run(sup, b.argv, "grok-4", "add a file", { FAKE_GROK: "superagent" }); expect(r.code).toBe(0);
  const evs = r.out.trim().split("\n").map(l => parseEvent("grok", l)!); expect(evs.every(Boolean)).toBe(true);
  expect(evs.map(e => e.text ?? "").join("\n")).toContain("all done by grok"); expect(evs.map(e => e.text ?? "").join("\n")).not.toContain("add a file"); // the echoed user message is dropped
  expect(evs.some(e => e.line === "→ create_file grok.txt")).toBe(true);
});
test("event parsers: session ids, tool lines and the final text", () => {
  expect(parseEvent("gemini", '{"type":"init","session_id":"g1"}')).toEqual({ sid: "g1" });
  expect(parseEvent("gemini", '{"type":"tool_use","tool_name":"run_shell_command","parameters":{"command":"npm test"}}')!.line).toBe("→ run_shell_command npm test");
  expect(parseEvent("cursor", '{"type":"result","is_error":true,"result":"boom","session_id":"c1"}')).toEqual({ err: "boom", sid: "c1" });
  expect(parseEvent("opencode", '{"type":"text","sessionID":"ses_1","part":{"text":"hi"}}')).toEqual({ text: "hi", sid: "ses_1" });
  expect(parseEvent("opencode", "not json")).toBeNull();
  expect(parseEvent("codex", '{"type":"thread.started","thread_id":"019a-th"}')).toEqual({ sid: "019a-th" });
  expect(parseEvent("codex", '{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}')!.line).toBe("→ $ npm test");
  expect(parseEvent("codex", '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}')).toEqual({ text: "done" });
  expect(parseEvent("codex", '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}')).toEqual({ err: "401 Unauthorized" });
  expect(parseEvent("claude", '{"type":"system","subtype":"init","session_id":"cl-1"}')).toEqual({ sid: "cl-1" });
  expect(parseEvent("claude", '{"type":"assistant","session_id":"cl-1","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}},{"type":"text","text":"hi"}]}}')).toEqual({ text: "hi", line: "→ Bash ls", sid: "cl-1" });
  expect(parseEvent("claude", '{"type":"result","is_error":true,"result":"Not logged in","session_id":"cl-1"}')).toEqual({ err: "Not logged in", sid: "cl-1" });
  expect(parseEvent("grok", '{"role":"user","content":"[relay-question: not mine]"}')).toEqual({});
  expect(parseEvent("grok", '{"role":"assistant","content":"looking\\n[relay-question: Which name?]"}')!.text).toContain("[relay-question: Which name?]");
  expect(parseEvent("cursor", '{"type":"tool_call","subtype":"started","tool_call":{"function":{"name":"grep","arguments":"x"}}}')!.line).toBe("→ grep x");
});
