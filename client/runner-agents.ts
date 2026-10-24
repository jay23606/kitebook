// Runner agents: agent definitions and presets, model discovery, the owner's agent/model preferences (prefs) and how a pick is
// resolved, the agent argv/env, and ready-to-run worktree dependencies.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, existsSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { PRESETS } from "./setup.ts";
import { ADAPTERS, isAdapter, build, probeHelp, listed, taskUuid, type Built } from "./agent-adapters.ts";
import { log, sh, cfg, me } from "./runner-ctx.ts";
import { ModelDiscovery, parseModels, type Catalog } from "./agent-models.ts";
import * as PL from "./platform.ts";

// Owner preferences for agent/model choice: bun runner.ts set runner.json prefs.<key> <value>   ("-" removes a key)
//   prefs.defaultAgent pi | prefs.defaultModel sonnet | prefs.byKind.<plan|code|review|test|quick>.<agent|model> X
//   prefs.byProject.<name>.<agent|model> X | prefs.allow "codex/*,claude" | prefs.deny "claude/opus*" | prefs.askWhenUnsure true|false
export const PREF_KINDS = ["plan", "code", "review", "test", "quick"];
// ---- agents + models ----
// Built-in agent presets. {session} is a session file kept per task branch, so follow-ups resume the same conversation.
// Custom agents: "mine": ["my-agent", "--prompt", "{prompt}"] or { "argv": [...], "models": [...] | "listModels": [...], "modelFlag": "-m" }; "{model}" in argv also works.
// (PRESETS live in setup.ts so init/doctor see the same list)
// JSONL event mode, used when the installed CLI supports it (probed at startup): richer live status (tool calls, retries).
// The final answer is pulled back out of the events, so summaries stay plain text. Custom agents opt in with { "argv": [...], "json": true } (pi-style events).
export const JSON_PRESETS: Record<string, string[]> = { pi: ["pi", "--mode", "json", "--session", "{session}", "{prompt}"] };
export const JSON_PROBE: Record<string, string[]> = { pi: ["pi", "--help"] };
export const JSON_OK = new Set<string>();
export let PI_HELP = ""; // `pi --help` as probed at startup: Pi 1.x lists --no-mcp (quick asks keep MCP tools out; --tools alone keeps them)
export const piHas = (flag: string) => !!PI_HELP && listed(PI_HELP, flag);
export const MODEL_FLAG: Record<string, string> = { pi: "--model" }; // inserted right before the prompt (adapters carry their own modelFlag)
export const PROBE: Record<string, string[]> = { pi: ["pi", "--list-models"], opencode: ["opencode", "models"] }; // asked non-interactively at startup
// Unverified aliases/legacy ids when native discovery is unavailable. Never use these as dispatch restrictions.
export const STATIC_MODELS: Record<string, string[]> = { claude: ["sonnet", "opus", "haiku"], codex: ["gpt-5.5", "gpt-5.2-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5"],
  gemini: ["auto", "pro", "flash", "flash-lite"] }; // gemini: its documented --model aliases
// The more-agents adapters (client/agent-adapters.ts), built from each installed CLI's --help at startup (probeModels). Not installed or
// not probed yet: the documented flags only. `issue`: a flag the run needs isn't in its --help, so it isn't offered for tasks.
export const BUILT: Record<string, Built> = {};
export const builtOf = (name: string) => BUILT[name] ?? build(name, null);
export type AgentDef = { argv: string[]; models?: string[]; listModels?: string[]; modelFlag?: string; json?: boolean; events?: string | null; first?: string[] | null; resume?: string[] | null; issue?: string | null };
export const agentDef = (name: string): AgentDef | null => {
  if (!cfg.agents?.[name] && isAdapter(name)) { const b = builtOf(name); return { argv: b.argv, events: b.events, first: b.first, resume: b.resume, issue: b.issue }; }
  const a = cfg.agents?.[name] ?? (JSON_OK.has(name) ? { argv: JSON_PRESETS[name], json: true } : PRESETS[name]); return !a ? null : Array.isArray(a) ? { argv: a } : a; };
// pi-style JSONL (pi --mode json, or a custom agent with "json": true) is "pi"; an adapter's own stream is its name
export const eventsOf = (d: AgentDef | null) => d?.events ?? (d?.json ? "pi" : null);
// Do later turns of one task continue the agent's own session? Pi: its session file; adapters: their resume flag (with the captured id,
// or the {tasksid} session Kitebook named on the first turn).
export const resumes = (name: string, sid?: string | null) => { const d = agentDef(name); if (!d) return false;
  return d.argv.some(a => a.includes("{session}")) || (!!d.resume && (!d.resume.some(x => x.includes("{sid}")) || !!sid)); };
// An adapter without a model list (Cursor, Copilot, Grok: no list command that works without a login) takes an explicit model as given;
// the CLI itself says if it doesn't know it. Only an explicitly configured catalog or successful owner listModels command imposes a membership check.
export const modelPassThrough = (agent: string) => isAdapter(agent) && !cfg.agents?.[agent] && !(MODELS[agent] ?? []).length;
export const agentArgv = (name: string) => agentDef(name)?.argv ?? null;
export const agentNames = () => [...new Set([...Object.keys(PRESETS), ...Object.keys(cfg.agents ?? {})])];
export let MODELS: Record<string, string[]> = {};
// pi prints a table "provider  model  context ..." -> "provider/model"; a plain list prints one id per line.
export const parseModelList = parseModels;
export const MODEL_CATALOGS: Record<string, Catalog> = {};
const discovery = new ModelDiscovery();
export async function discoverModels(agent?: string, refresh = false) {
  const names = agentNames(); if (agent && !names.includes(agent)) throw new Error(`unknown agent ${agent}`);
  await Promise.all((agent ? [agent] : names).map(async n => { const d = agentDef(n), extra = Array.isArray(cfg.models) ? (n === (cfg.defaultAgent ?? "pi") ? cfg.models : []) : cfg.models?.[n] ?? [];
    const c = await discovery.get({ agent: n, command: d?.listModels ?? PROBE[n], restrict: !!d?.listModels, configured: d?.models, extra, fallback: STATIC_MODELS[n], codex: n === "codex" && !cfg.agents?.[n], env: agentEnv(), cwd: process.cwd() }, refresh);
    MODEL_CATALOGS[n] = c; MODELS[n] = c.models.map(x => x.id);
  }));
  return { catalogs: (agent ? [agent] : names).map(n => ({ ...MODEL_CATALOGS[n], configured_default: n === (cfg.prefs?.defaultAgent ?? cfg.defaultAgent ?? "pi") ? cfg.prefs?.defaultModel ?? null : null })), checked_at: new Date().toISOString(), note: "Catalog discovery does not verify account entitlement. Session model evidence is separate (session_status)." };
}
export async function probeModels() {
  const help = await probeHelp(b => Bun.which(b, { PATH: agentEnv().PATH }), agentEnv()); // the adapters' --help: which flags this install has
  for (const n of Object.keys(ADAPTERS)) { if (help[n] == null) { delete BUILT[n]; continue; } BUILT[n] = build(n, help[n]);
    const b = BUILT[n]; log(`agent ${n}:`, b.issue ? b.issue : [b.events ? "events" : "plain text", b.resume ? "resumes its session" : "no resume", b.askReadOnly ? "read-only quick asks" : "quick asks behind the git check"].join(", ")); }
  await discoverModels();
  await Promise.all(Object.keys(JSON_PROBE).filter(n => !cfg.agents?.[n] && Bun.which(JSON_PROBE[n][0])).map(async n => { try {
    const p = PL.spawn(JSON_PROBE[n], { stdout: "pipe", stderr: "pipe", env: agentEnv() }); const kill = setTimeout(() => p.kill(), 15000);
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); clearTimeout(kill);
    if (n === "pi") PI_HELP = o + "\n" + e;
    if (/--mode\b[^\n]*json/.test(o + e)) JSON_OK.add(n); } catch {} }));
  if (JSON_OK.size) log("json event mode:", [...JSON_OK].join(" "));
  log("models:", Object.entries(MODELS).map(([k, v]) => `${k}=${v.length}`).join(" "));
}
// "claude-sonnet-4-5" matches an advertised "anthropic/claude-sonnet-4-5"; a ":high" thinking suffix is allowed.
export const modelOk = (list: string[], m: string) => { const base = m.replace(/:[a-z]+$/, ""); return list.some(x => x === m || x === base || x.endsWith("/" + base)); };
// ---- owner preferences: the dispatcher picks, the owner's rules bound the pick ----
// Order: explicit task agent/model (if allowed) > prefs.byProject > prefs.byKind (task.kind) > defaults. allow/deny are globs over "agent/model".
export const pickRe = (g: string) => new RegExp("^" + g.split("*").map(x => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
export const pickMatch = (pat: string, agent: string, model: string | null) => { const i = pat.indexOf("/"); return i < 0 ? pickRe(pat).test(agent) : pickRe(pat.slice(0, i)).test(agent) && pickRe(pat.slice(i + 1)).test(model ?? "default"); };
export const pickAllowed = (agent: string, model: string | null) => { const P = cfg.prefs ?? {};
  return !(P.deny ?? []).some((p: string) => pickMatch(p, agent, model)) && (!(P.allow ?? []).length || P.allow.some((p: string) => pickMatch(p, agent, model))); };
export const allowedNote = () => { const P = cfg.prefs ?? {}; return `allowed: ${(P.allow ?? []).join(", ") || "any advertised agent/model"}${P.deny?.length ? `; denied: ${P.deny.join(", ")}` : ""}`; };
export const prefsView = () => { const P = cfg.prefs ?? {}; return { defaultAgent: P.defaultAgent ?? cfg.defaultAgent ?? "pi", defaultModel: P.defaultModel ?? null, byKind: P.byKind ?? {}, byProject: P.byProject ?? {},
  allow: P.allow ?? [], deny: P.deny ?? [], askWhenUnsure: !!P.askWhenUnsure, kinds: PREF_KINDS, order: ["task", "project", "kind", "default"] }; };
export type Pick = { agent: string; model: string | null; reason: "task" | "project" | "kind" | "default" };
export function checkPick(agent: string, model: string | null): string | null {
  const d = agentDef(agent);
  if (!d) return `agent "${agent}" is not available on ${me.name}; agents: ${agentNames().join(", ")}`;
  if (d.issue) return `agent "${agent}" can't run tasks on ${me.name}: ${d.issue}`;
  if (model && modelPassThrough(agent)) log(`model "${model}" for ${agent}: it advertises no model list here, so the model is passed through unchecked`);
  else if (model && MODEL_CATALOGS[agent]?.authoritative) { const list = MODELS[agent] ?? [];
    if (!list.length) return `model "${model}" can't be used: ${agent} advertises no models on ${me.name}; omit model to use its default`;
    if (!modelOk(list, model)) return `model "${model}" is not available for ${agent} on ${me.name}; models: ${list.join(", ")}`; }
  if (!pickAllowed(agent, model)) return `${agent}${model ? "/" + model : ""} is not allowed by the owner of ${me.name}; ${allowedNote()}`;
  return null;
}
export function resolvePick(t: any, proj: any): Pick | string {
  const P = cfg.prefs ?? {};
  const base = (!proj.auto && !proj.scratch ? proj.agent : undefined) ?? P.defaultAgent ?? proj.agent; // an explicit project entry's agent beats the global default
  const rules: [Pick["reason"], any][] = [["project", t.project ? P.byProject?.[t.project] : undefined], ["kind", t.kind ? P.byKind?.[t.kind] : undefined]];
  if (t.agent || t.model) { // the dispatcher chose: honor it if the owner allows it, else refuse with the allowed list
    const agent = t.agent ?? rules.map(r => r[1]?.agent).find(Boolean) ?? base, model = t.model ?? null;
    const bad = checkPick(agent, model); return bad ?? { agent, model, reason: "task" };
  }
  for (const [reason, r] of rules) { if (!r || (!r.agent && !r.model)) continue;
    const agent = r.agent ?? base, model = r.model ?? null, bad = checkPick(agent, model);
    if (!bad) return { agent, model, reason }; log(`prefs.${reason === "project" ? "byProject" : "byKind"} skipped:`, bad); }
  const dm = P.defaultModel && (!MODEL_CATALOGS[base]?.authoritative || modelOk(MODELS[base] ?? [], P.defaultModel) || modelPassThrough(base)) ? P.defaultModel : null;
  for (const model of dm ? [dm, null] : [null]) if (!checkPick(base, model)) return { agent: base, model, reason: "default" };
  return checkPick(base, null) ?? `no allowed agent for this task on ${me.name}; ${allowedNote()}`;
}
// later: a later turn of the same task (answer, steering note, self-repair); sid: the agent's session id from its event stream.
// task: the task id, for {tasksid} (the session Kitebook names for agents that take one: Copilot, Grok Build)
export function buildArgv(name: string, model: string | null, prompt: string, session: string, later?: { sid?: string | null } | null, task?: string) {
  const d = agentDef(name); if (!d) return null;
  let argv = [...d.argv];
  const ri = argv.indexOf("{resume}"), fill = (x: string) => x.replace("{sid}", () => later?.sid ?? "").replace("{tasksid}", () => taskUuid(task ?? session));
  if (ri >= 0) argv.splice(ri, 1, ...(later ? (d.resume && resumes(name, later.sid) ? d.resume.map(fill) : []) : (d.first ?? []).map(fill)));
  if (argv.some(s => s.includes("{model}"))) {
    const i = argv.indexOf("{model}");
    if (!model && i >= 0) argv.splice(i > 0 && argv[i - 1].startsWith("-") ? i - 1 : i, i > 0 && argv[i - 1].startsWith("-") ? 2 : 1); // drop "--model {model}"
    argv = argv.map(s => s.replace("{model}", () => model ?? ""));
  } else if (model) { const flag = d.modelFlag ?? MODEL_FLAG[name]; if (flag) { const i = argv.indexOf("{prompt}"); argv.splice(i < 0 ? argv.length : i, 0, flag, model); } }
  return argv.map(s => s.replace("{prompt}", () => prompt).replace("{session}", () => session)); // function replacers: "$&" in a prompt stays literal
}
export function agentEnv(model?: string | null) {
  const env: Record<string, string> = { PATH: PL.envPath(), HOME: process.env.HOME ?? homedir(), TERM: "dumb" };
  // Preserve the runner's locale and temp location without inheriting unrelated shell credentials.
  for (const k of ["LANG", "LC_ALL", "TMPDIR"]) { const v = process.env[k]; if (v) env[k] = v; }
  // Windows programs need these to start at all (system folder, temp, the user's profile and app data, how commands resolve)
  if (PL.plat() === "win32") for (const k of ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"]) { const v = process.env[k]; if (v) env[k] = v; }
  const ef = cfg.envFile?.replace(/^~/, homedir());
  const fileEnv: Record<string, string> = ef && existsSync(ef) ? Object.fromEntries(readFileSync(ef, "utf8").split("\n").map((l: string) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)).filter(Boolean).map((m: any) => [m[1], m[2].replace(/^["']|["']$/g, "")])) : {};
  for (const k of cfg.env ?? []) { const v = process.env[k] ?? fileEnv[k]; if (v) env[k] = v; }
  if (model) env.KITEBOOK_MODEL = model;
  return env;
}

// ---- ready-to-run worktrees ----
export const DEP_DIRS = ["node_modules", ".venv", "vendor", "Pods", "target"];
// Copy-on-write clone of gitignored dependency dirs from the main checkout (APFS clonefile / Linux reflink), else a symlink.
export async function cloneDeps(src: string, wt: string): Promise<string[]> {
  const done: string[] = [];
  for (const d of DEP_DIRS) {
    const from = join(src, d), to = join(wt, d);
    if (!existsSync(from) || existsSync(to)) continue;
    if ((await sh(["git", "check-ignore", "-q", d + "/"], src)).code !== 0) continue; // tracked (e.g. a committed vendor/) comes with the checkout
    const mac = PL.plat() === "darwin", win = PL.plat() === "win32";
    let how = mac ? "cow-clone" : "reflink-copy";
    // Windows: a directory junction (no copy, no admin needed, unlike a symlink)
    if (win || (await sh(mac ? ["cp", "-c", "-R", from, to] : ["cp", "--reflink=auto", "-R", from, to], wt)).code !== 0) {
      try { rmSync(to, { recursive: true, force: true }); symlinkSync(from, to, win ? "junction" : undefined); how = win ? "junction" : "symlink"; } catch { continue; }
    }
    done.push(`${d} (${how})`);
  }
  return done;
}
export const LEARN = ".relay-learnings.md"; // an agent's durable notes for the project; read after the run, never committed
export const noDeps = (dirs: string[]) => [...dirs.map(d => `:(exclude)${d.split(" ")[0]}`), `:(exclude)${LEARN}`]; // never commit the cloned deps
