// Shared execution boundary for quick asks and live sessions. Read-only covers persistent instructions and external tools too.
import { existsSync, realpathSync } from "fs";
import { dirname } from "path";
export const READ_TOOLS = ["Read", "Glob", "Grep", "LS"];
export const readTool = (name: string) => READ_TOOLS.includes(name);
export const READ_ONLY_DENIAL = "Read-only questions cannot edit files, run commands or call external tools; send an approved task instead.";
// A writable state directory is never permission to install instructions, hooks or external tools for a future session.
export const AGENT_CONFIG = [".claude.json", ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks", ".claude/commands", ".claude/agents", ".claude/CLAUDE.md", ".claude/plugins", ".claude/skills",
  ".codex/config.toml", ".codex/AGENTS.md", ".codex/skills", ".codex/prompts", ".codex/plugins", ".codex/rules", ".pi/agent/settings.json", ".pi/agent/extensions", ".pi/agent/AGENTS.md", ".pi/agent/skills", ".pi/agent/prompts", ".gemini/settings.json", ".gemini/GEMINI.md", ".gemini/extensions", ".gemini/skills", ".cursor/mcp.json", ".cursor/rules", ".cursor/skills", ".copilot/mcp-config.json", ".copilot/skills", ".config/opencode/opencode.json", ".config/opencode/plugins", ".config/opencode/skills"];
// Linux cannot mount a missing file. Seal its nearest existing parent so creating a previously absent config cannot escape the policy.
export function configMounts(paths: string[]): string[] {
  const roots: string[] = [];
  for (let p of paths) { while (!existsSync(p) && dirname(p) !== p) p = dirname(p); p = realpathSync(p); if (!roots.includes(p)) roots.push(p); }
  // Keep child mounts: a read-only home mount can still contain a separately writable agent-state mount.
  return roots.sort((a, b) => a.split("/").length - b.split("/").length);
}
export function codexReadOnlyConfig(config: any): Record<string, any> {
  if (!config || typeof config !== "object") throw new Error("cannot read Codex's effective config for a read-only question");
  return { mcp_servers: Object.fromEntries(Object.keys(config.mcp_servers ?? {}).map(n => [n, { enabled: false }])),
    apps: { _default: { enabled: false }, ...Object.fromEntries(Object.keys(config.apps ?? {}).filter(n => n !== "_default").map(n => [n, { enabled: false }])) },
    plugins: Object.fromEntries(Object.keys(config.plugins ?? {}).map(n => [n, { enabled: false }])),
    features: { connectors: false, plugins: false, browser_use: false, computer_use: false }, web_search: "disabled" };
}
export const codexConfigArgv = (config: Record<string, any>) => Object.entries(config).flatMap(([k, v]) => ["-c", `${k}=${toml(v)}`]);
function toml(x: any): string { return typeof x !== "object" || x == null ? JSON.stringify(x) : `{ ${Object.entries(x).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(", ")} }`; }
