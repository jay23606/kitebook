// `kitebook connect` (and the installer's one question): let the coding agents on this Mac use Kitebook over MCP, with no browser sign-in,
// no token to copy and no key. The install itself was the owner's approval (the invite came from their signed-in Settings/Get started),
// so this Mac's runner asks the server for one connection per agent (op agent_connect) with the safe default: its own folder kb/<name>,
// read and edit, no task sending. The token goes straight into that agent's own config and is never printed:
//   Pi, Codex     `<agent> mcp add kitebook --url <kitebook>/mcp --bearer-token-env-var KITEBOOK_<AGENT>_TOKEN`, the token in
//                 ~/.kitebook/agent-tokens.env (0600), which your shell loads (one line added to ~/.zshrc / ~/.bashrc / fish conf.d)
//   Claude Code   `claude mcp add --transport http kitebook <kitebook>/mcp --header "Authorization: Bearer ..." -s user` (its own ~/.claude.json)
//   Cursor, Gemini CLI, opencode, GitHub Copilot CLI   their JSON config (~/.cursor/mcp.json, ~/.gemini/settings.json,
//                 ~/.config/opencode/opencode.json, ~/.copilot/mcp-config.json or $COPILOT_HOME/mcp-config.json), merged: only the "kitebook"
//                 entry is added or replaced, anything else is kept; a file that isn't valid JSON is left alone
//   Grok CLI      `grok mcp add --transport http kitebook <kitebook>/mcp --header "Authorization: Bearer ..."` (xAI's Grok Build; a grok whose
//                 `mcp add` has no --header, like the community grok-cli, is reported, not half-configured)
// Each success is noted in ~/.kitebook/agents-connected.json (agent -> connection name, when), which Settings -> Coding agents shows.
// Re-runnable: the same agent gets the same connection back (a fresh token; its access as the owner left it in Settings) and its "kitebook"
// entry is replaced, never duplicated. A missing or failing agent is reported and skipped; it never stops the others or the install.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import * as PL from "./platform.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

export const AGENTS: Record<string, { label: string; bin: string; kind: "cli-env" | "claude" | "json" | "grok" }> = {
  pi: { label: "Pi", bin: "pi", kind: "cli-env" }, codex: { label: "Codex", bin: "codex", kind: "cli-env" }, claude: { label: "Claude Code", bin: "claude", kind: "claude" },
  cursor: { label: "Cursor", bin: "cursor-agent", kind: "json" }, gemini: { label: "Gemini CLI", bin: "gemini", kind: "json" }, opencode: { label: "opencode", bin: "opencode", kind: "json" },
  copilot: { label: "GitHub Copilot CLI", bin: "copilot", kind: "json" }, grok: { label: "Grok CLI", bin: "grok", kind: "grok" },
};
const H = () => process.env.HOME || homedir();
const JSON_CFG: Record<string, (o: string, t: string) => { file: string; set: (j: any) => void }> = {
  cursor: (o, t) => ({ file: join(H(), ".cursor", "mcp.json"), set: j => { j.mcpServers ??= {}; j.mcpServers.kitebook = { url: `${o}/mcp`, headers: { Authorization: `Bearer ${t}` } }; } }),
  gemini: (o, t) => ({ file: join(H(), ".gemini", "settings.json"), set: j => { j.mcpServers ??= {}; j.mcpServers.kitebook = { httpUrl: `${o}/mcp`, headers: { Authorization: `Bearer ${t}` } }; } }),
  opencode: (o, t) => ({ file: join(H(), ".config", "opencode", "opencode.json"), set: j => { j.mcp ??= {}; j.mcp.kitebook = { type: "remote", url: `${o}/mcp`, enabled: true, headers: { Authorization: `Bearer ${t}` } }; } }),
  copilot: (o, t) => ({ file: join(process.env.COPILOT_HOME || join(H(), ".copilot"), "mcp-config.json"), set: j => { j.mcpServers ??= {}; j.mcpServers.kitebook = { type: "http", url: `${o}/mcp`, headers: { Authorization: `Bearer ${t}` }, tools: ["*"] }; } }),
};
// After an update (client/updater.ts): agents whose JSON config already has Kitebook's "kitebook" entry get its address brought in line with this
// kitebook (same sign-in, nothing else touched). Pi, Codex and Claude Code keep theirs in their own CLI config, which has no address to drift.
export function refreshConfigs(url: string): string[] {
  const o = url.replace(/\/+$/, ""), out: string[] = [];
  for (const a of Object.keys(JSON_CFG)) { const c = JSON_CFG[a](o, ""); let j: any;
    try { j = JSON.parse(readFileSync(c.file, "utf8")); } catch { continue; }
    const box = a === "opencode" ? j?.mcp : j?.mcpServers; if (!box || typeof box !== "object") continue;
    // a "relay" entry from before the rename (Relay -> Kitebook) becomes "kitebook", same sign-in: the agent shows Kitebook's name
    let moved = false; if (box.relay && typeof box.relay === "object" && !box.kitebook) { box.kitebook = box.relay; delete box.relay; moved = true; }
    const e = box.kitebook; if (!e || typeof e !== "object") continue;
    const k = a === "gemini" ? "httpUrl" : "url"; if (e[k] === `${o}/mcp` && !moved) continue;
    e[k] = `${o}/mcp`; writeFileSync(c.file, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 }); out.push(a); }
  return out;
}
const which = (b: string) => Bun.which(b, { PATH: PL.withAgentDirs(PL.envPath()) }); // + where agent CLIs install themselves on this OS
// Cursor: its agent CLI (cursor-agent), the editor's `cursor` command, or its config folder
const present = (a: string) => !!which(AGENTS[a].bin) || (a === "cursor" && (!!which("cursor") || existsSync(join(H(), ".cursor"))));
export function detect(): string[] { return Object.keys(AGENTS).filter(present); }
const CONN = () => join(H(), ".kitebook", "agents-connected.json");
export function connectedAgents(): Record<string, { peer: string; at: string }> { try { const j = JSON.parse(readFileSync(CONN(), "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; } }
function noteConnected(agent: string, peer: string) { const all = connectedAgents(); all[agent] = { peer, at: new Date().toISOString() };
  try { mkdirSync(dirname(CONN()), { recursive: true, mode: 0o700 }); writeFileSync(CONN(), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 }); } catch {} }
export const names = (as: string[]) => { const l = as.map(a => AGENTS[a]?.label ?? a); return l.length <= 1 ? l.join("") : l.slice(0, -1).join(", ") + " and " + l[l.length - 1]; };
// 20 s cap: an agent CLI that reads our words as a prompt (or waits on a terminal) must never hang the installer
const run = (argv: string[]) => { try { const p = PL.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000, env: process.env as any }); return { ok: p.exitCode === 0, err: (p.stderr.toString() || p.stdout.toString()).trim().split("\n").pop() ?? "" }; } catch (e: any) { return { ok: false, err: e.message }; } };
// the env file and the one line that loads it, for each shell the owner uses (idempotent)
const ENV = () => join(H(), ".kitebook", "agent-tokens.env");
function setEnv(name: string, value: string) {
  const f = ENV(); mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  const lines = (existsSync(f) ? readFileSync(f, "utf8") : "# Kitebook: tokens your coding agents use to reach Kitebook (kitebook connect). Keep private.\n").split("\n").filter(l => l && !l.startsWith(`export ${name}=`));
  writeFileSync(f, [...lines, `export ${name}=${value}`].join("\n") + "\n", { mode: 0o600 }); chmodSync(f, 0o600); process.env[name] = value;
  const src = `[ -f "${f}" ] && . "${f}"  # Kitebook: agent tokens (kitebook connect)`, sh = process.env.SHELL ?? "";
  const rcs = [join(H(), ".zshrc"), join(H(), ".bashrc")].filter(r => existsSync(r) || (r.endsWith(".zshrc") ? /zsh/.test(sh) || (!sh && process.platform === "darwin") : /bash/.test(sh)));
  if (!rcs.length) rcs.push(join(H(), ".profile"));
  for (const rc of rcs) { const t = existsSync(rc) ? readFileSync(rc, "utf8") : ""; if (!t.includes("# Kitebook: agent tokens") && !t.includes("# Relay: agent tokens")) appendFileSync(rc, (t && !t.endsWith("\n") ? "\n" : "") + src + "\n"); }
  if (/fish/.test(sh)) { const ff = join(H(), ".config", "fish", "conf.d", "kitebook.fish"); mkdirSync(dirname(ff), { recursive: true });
    const body = readFileSync(f, "utf8").split("\n").filter(l => l.startsWith("export ")).map(l => l.replace(/^export ([A-Z_]+)=(.*)$/, "set -gx $1 $2")).join("\n"); writeFileSync(ff, body + "\n", { mode: 0o600 }); }
}
// Pi before 0.99 has no `pi mcp` command: it reads `pi mcp remove kitebook` as a PROMPT and runs a real agent turn (with tools, in the
// installer's cwd). So Pi gets an `mcp` command only when its --help lists one.
export const PI_MCP_HINT = "npm i -g @earendil-works/pi-coding-agent";
export const piHasMcp = (help: string) => /^\s*pi mcp\b/m.test(help);
// Checked before Kitebook is even asked for a connection (so nothing is minted or rotated for an agent that can't take it)
function precheck(agent: string): string | null {
  if (agent !== "pi") return null; let h = "";
  try { const p = PL.spawnSync([AGENTS.pi.bin, "--help"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000, env: process.env as any }); h = p.stdout.toString() + "\n" + p.stderr.toString(); } catch {}
  return piHasMcp(h) ? null : `this Pi is too old for MCP (needs 0.99 or newer, with \`pi mcp\`); update it: ${PI_MCP_HINT}`;
}
function wire(agent: string, o: string, token: string): string | null {
  const a = AGENTS[agent];
  if (a.kind === "cli-env") { const v = `KITEBOOK_${agent.toUpperCase()}_TOKEN`; setEnv(v, token); run([a.bin, "mcp", "remove", "kitebook"]); run([a.bin, "mcp", "remove", "relay"]); // replace (and the pre-rename "relay" entry), never fail on a name clash
    const r = run([a.bin, "mcp", "add", "kitebook", "--url", `${o}/mcp`, "--bearer-token-env-var", v]); return r.ok ? null : r.err || `${a.bin} mcp add failed`; }
  if (a.kind === "grok") { run([a.bin, "mcp", "remove", "kitebook"]); run([a.bin, "mcp", "remove", "relay"]);
    const r = run([a.bin, "mcp", "add", "--transport", "http", "kitebook", `${o}/mcp`, "--header", `Authorization: Bearer ${token}`]);
    return r.ok ? null : `this grok's \`mcp add\` didn't take a sign-in header (${r.err || "failed"}); add Kitebook to it by hand from Settings -> Connected apps`; }
  if (a.kind === "claude") { run([a.bin, "mcp", "remove", "kitebook", "-s", "user"]); run([a.bin, "mcp", "remove", "relay", "-s", "user"]);
    const r = run([a.bin, "mcp", "add", "--transport", "http", "kitebook", `${o}/mcp`, "--header", `Authorization: Bearer ${token}`, "-s", "user"]); return r.ok ? null : r.err || "claude mcp add failed"; }
  const c = JSON_CFG[agent](o, token); let j: any = {};
  if (existsSync(c.file)) { try { j = JSON.parse(readFileSync(c.file, "utf8") || "{}"); } catch { return `${c.file.replace(H(), "~")} isn't plain JSON, so it was left alone`; } }
  if (!j || typeof j !== "object" || Array.isArray(j)) return `${c.file.replace(H(), "~")} isn't a JSON object, so it was left alone`;
  for (const box of [j.mcpServers, j.mcp]) if (box && typeof box === "object") delete box.relay; // the pre-rename entry
  c.set(j); mkdirSync(dirname(c.file), { recursive: true }); writeFileSync(c.file, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 }); return null;
}
export async function connect(cfg: { url: string; token: string; space: string }, agents: string[]): Promise<{ ok: { agent: string; peer: string }[]; failed: { agent: string; why: string }[] }> {
  const ok: { agent: string; peer: string }[] = [], failed: { agent: string; why: string }[] = [];
  for (const agent of agents) {
    if (!AGENTS[agent]) { failed.push({ agent, why: `unknown agent (use ${Object.keys(AGENTS).join(", ")})` }); continue; }
    if (!present(agent)) { failed.push({ agent, why: `${AGENTS[agent].bin} isn't installed here` }); continue; }
    const pre = precheck(agent); if (pre) { failed.push({ agent, why: pre }); continue; }
    // a new agent token widens access: an enrolled device confirms it with its presence key (Touch ID / Windows Hello / password; client/device.ts)
    const DV = await import("./device.ts"), st = await DV.mine(cfg).catch(() => null); let presence: string | null = null;
    if (st?.state === "active") { presence = await DV.presenceAssert(st, `agent_connect:${agent}`, `connect ${agent}`); if (!presence) { failed.push({ agent, why: "not confirmed (your master password, or its Touch ID / Windows Hello shortcut, is needed to connect an agent)" }); continue; } }
    let r: any; try { r = await (await fetch(`${cfg.url}/v1/agent_connect`, { method: "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: JSON.stringify({ space: cfg.space, agent, ...(presence ? { presence } : {}) }) })).json(); }
    catch (e: any) { failed.push({ agent, why: `can't reach Kitebook (${e.message})` }); continue; }
    if (!r?.ok) { failed.push({ agent, why: r?.error ?? "Kitebook said no" }); continue; }
    const err = wire(agent, cfg.url.replace(/\/+$/, ""), r.result.token); if (err) failed.push({ agent, why: err }); else { ok.push({ agent, peer: r.result.peer }); noteConnected(agent, r.result.peer); }
  }
  return { ok, failed };
}
// kitebook connect [runner.json] [pi codex ...|--all] [--detect] [--json]
export async function connectCli(argv: string[]): Promise<number> {
  const f = argv.find(a => a.endsWith(".json")) ?? process.env.KITEBOOK_RUNNER_CONFIG ?? join(H(), ".kitebook", "runner.json"), json = argv.includes("--json");
  if (argv.includes("--detect")) { const d = detect(); console.log(json ? JSON.stringify(d) : d.join(" ")); return 0; }
  let cfg: any; try { cfg = JSON.parse(readFileSync(f, "utf8")); } catch { console.error(`This Mac isn't connected to Kitebook yet (no ${f.replace(H(), "~")}). Run the Connect your Mac line from Get started first.`); return 1; }
  const want = argv.filter(a => !a.startsWith("-") && !a.endsWith(".json")).map(a => a === "claude-code" ? "claude" : a), agents = want.length && !argv.includes("--all") ? want : detect();
  if (!agents.length) { console.log("No coding agent found on this Mac (Pi, Codex, Claude Code, Cursor, Gemini CLI, opencode, GitHub Copilot CLI or Grok CLI). Install one, then run: kitebook connect"); return 0; }
  const r = await connect(cfg, agents);
  if (json) { console.log(JSON.stringify(r)); return r.ok.length || !r.failed.length ? 0 : 1; }
  if (argv.includes("--installer")) { // install.sh: one summary line
    const bad = r.failed.map(x => `${AGENTS[x.agent]?.label ?? x.agent}: ${x.why}`).join("; ");
    console.log(r.ok.length ? `✓ Connected ${names(r.ok.map(x => x.agent))} to Kitebook: each uses only its own folder and can't send tasks (change it in Settings)${bad ? `. Not connected: ${bad}` : ""}` : `Coding agents not connected: ${bad}. Try again later with: kitebook connect`);
    return 0; }
  const settings = `${String(cfg.url).replace(/\/+$/, "")}/settings`;
  if (r.ok.length) console.log(`✓ Connected ${names(r.ok.map(x => x.agent))} to Kitebook: each reads and edits only its own folder (${r.ok.map(x => "kb/" + x.peer).join(", ")}) and can't send tasks. Change that in Settings: ${settings}`);
  for (const x of r.failed) console.log(`  ${AGENTS[x.agent]?.label ?? x.agent} not connected: ${x.why}`);
  if (r.ok.some(x => AGENTS[x.agent]?.kind === "cli-env")) console.log(`  Open a new terminal (or restart ${names(r.ok.filter(x => AGENTS[x.agent]?.kind === "cli-env").map(x => x.agent))}) so it picks up its Kitebook sign-in.`);
  return r.ok.length || !r.failed.length ? 0 : 1;
}
