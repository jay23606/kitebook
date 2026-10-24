import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { codexReadOnlyConfig, codexConfigArgv, configMounts, AGENT_CONFIG, readTool } from "./execution-policy.ts";

test("read-only disables every configured external tool, including explicit connector overrides", () => {
  const c = { mcp_servers: { write: { command: "writer" }, "a.b": { url: "https://example.invalid" } }, apps: { _default: { enabled: true }, gh: { enabled: true } }, plugins: { "p@m": { enabled: true } } };
  const o = codexReadOnlyConfig(c); expect(o.mcp_servers).toEqual({ write: { enabled: false }, "a.b": { enabled: false } });
  expect(o.apps).toEqual({ _default: { enabled: false }, gh: { enabled: false } }); expect(o.plugins["p@m"].enabled).toBe(false);
  expect(c.apps.gh.enabled).toBe(true); expect(o.web_search).toBe("disabled");
  expect(codexConfigArgv(o).join(" ")).toContain('"a.b" = { "enabled" = false }');
  expect(() => codexReadOnlyConfig(null)).toThrow(); expect(readTool("Read")).toBe(true);
  for (const t of ["Bash", "Write", "Edit", "mcp__github__create_issue"]) expect(readTool(t)).toBe(false);
});
test("Linux seals the parent of absent configuration paths, while instruction directories are always protected", () => {
  const t = mkdtempSync(join(tmpdir(), "kb-ro-policy-")); mkdirSync(join(t, ".codex/skills"), { recursive: true });
  writeFileSync(join(t, ".codex/config.toml"), "");
  const mounts = configMounts([join(t, "missing"), join(t, ".codex/config.toml"), join(t, ".codex/skills"), join(t, ".codex/plugins")]);
  expect(mounts).toContain(realpathSync(t)); expect(mounts).toContain(realpathSync(join(t, ".codex")));
  for (const p of [".codex/skills", ".claude/skills", ".claude.json", ".codex/plugins"]) expect(AGENT_CONFIG).toContain(p);
});
test.skipIf(process.platform !== "darwin")("the real macOS read-only profile blocks both existing and new skills", () => {
  const home = mkdtempSync(join(tmpdir(), "kb-ro-home-")); mkdirSync(join(home, ".codex/skills/existing"), { recursive: true }); mkdirSync(join(home, "repo"));
  const external = mkdtempSync(join(tmpdir(), "kb-ro-linked-")); mkdirSync(join(home, ".claude")); symlinkSync(external, join(home, ".claude/skills"), "dir");
  const code = `import {wrap} from ${JSON.stringify(join(import.meta.dir, "runner-ask.ts"))}; const root=process.env.HOME+'/repo'; for (const file of ['.codex/skills/existing/SKILL.md','.claude/skills/new/SKILL.md','.claude.json']) { const dst=process.env.HOME+'/'+file; const p=Bun.spawnSync(wrap(['/bin/sh','-c','mkdir -p "$(dirname "$1")"; printf audit > "$1"','sh',dst],root,'sandbox-exec'),{cwd:root,stdout:'pipe',stderr:'pipe'}); if(p.exitCode===0)process.exit(1); }`;
  const p = Bun.spawnSync([process.execPath, "-e", code], { env: { HOME: home, PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" });
  expect(p.stderr.toString()).not.toContain("sandbox_apply"); expect(p.exitCode).toBe(0);
  expect(existsSync(join(home, ".codex/skills/existing/SKILL.md"))).toBe(false);
});
