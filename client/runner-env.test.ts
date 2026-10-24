import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { agentEnv } from "./runner-agents.ts";
import { cfg, setCfg } from "./runner-ctx.ts";

const names = ["LANG", "LC_ALL", "TMPDIR", "KB_TEST_AGENT_KEY", "KB_TEST_UNLISTED"];
function isolated(run: () => void) {
  const prior = cfg, saved = Object.fromEntries(names.map(k => [k, process.env[k]]));
  try { for (const k of names) delete process.env[k]; setCfg({}); run(); }
  finally { setCfg(prior); for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test("agent process receives the runner locale and temp folder without unrelated credentials", () => isolated(() => {
  const dir = mkdtempSync(join(tmpdir(), "kb-agent-env-"));
  try {
    process.env.LANG = "ja_JP.UTF-8"; process.env.LC_ALL = "C.UTF-8"; process.env.TMPDIR = dir;
    process.env.KB_TEST_UNLISTED = "synthetic-private-value";
    const env = agentEnv("selected-model");
    const p = Bun.spawnSync([process.execPath, "-e", 'console.log(JSON.stringify({lang:process.env.LANG,locale:process.env.LC_ALL,temp:process.env.TMPDIR,secret:process.env.KB_TEST_UNLISTED??null,model:process.env.KITEBOOK_MODEL,term:process.env.TERM}))'], { env });
    expect(p.exitCode).toBe(0);
    expect(JSON.parse(p.stdout.toString())).toEqual({ lang: "ja_JP.UTF-8", locale: "C.UTF-8", temp: dir, secret: null, model: "selected-model", term: "dumb" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

test("agent environment does not invent unset locale or temp values", () => isolated(() => {
  const env = agentEnv();
  for (const k of ["LANG", "LC_ALL", "TMPDIR", "KITEBOOK_MODEL"]) expect(Object.hasOwn(env, k)).toBe(false);
}));

test("envFile supplies only allowed names and process values take precedence", () => isolated(() => {
  const dir = mkdtempSync(join(tmpdir(), "kb-agent-file-")), file = join(dir, "agent.env");
  try {
    writeFileSync(file, 'LANG="en_US.UTF-8"\nTMPDIR="/synthetic/temp"\nKB_TEST_AGENT_KEY=file-key\nKB_TEST_UNLISTED=hidden\n', { mode: 0o600 });
    process.env.KB_TEST_AGENT_KEY = "process-key";
    setCfg({ envFile: file, env: ["LANG", "TMPDIR", "KB_TEST_AGENT_KEY"] });
    expect(agentEnv()).toMatchObject({ LANG: "en_US.UTF-8", TMPDIR: "/synthetic/temp", KB_TEST_AGENT_KEY: "process-key" });
    expect(agentEnv().KB_TEST_UNLISTED).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));
