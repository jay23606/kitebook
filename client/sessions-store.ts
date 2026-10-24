// The owner's OWN local agent sessions, read-only (live-sessions: MCP sessions_search / session_get). Runs on the runner's computer only:
// the server never stores a transcript (src/space/sessions.ts holds a result in memory until the caller reads it). Every reader opens files
// read-only, never takes a lock, never touches a WAL, never migrates or rewrites anything (Pi rewrites old sessions on LOAD, so we parse its
// JSONL ourselves instead of loading it; opencode's SQLite is opened mode=ro + query_only). Every string that leaves here is redacted
// (client/redact.ts redactLog: tokens, keys, credential assignments, auth headers) and capped.
//
// Where each agent keeps its sessions (overrides in parentheses), and what we read:
//   codex     $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl[.zst] (+ archived_sessions/), first line session_meta {id, cwd},
//             then response_item {type: message, role, content[]}; names in session_index.jsonl. Live: a fresh write or a writer lock file.
//   claude    $CLAUDE_CONFIG_DIR/projects/<cwd, non-alphanumerics -> '-'>/<session-id>.jsonl, lines {type: user|assistant, cwd, message}
//             plus {type: summary} / {type: custom-title}. Live: `claude agents --json` (the supported way to read session state).
//   pi        $PI_CODING_AGENT_DIR/sessions (default ~/.pi/agent/sessions)/--<cwd>--/<ts>_<uuid>.jsonl: header {type: session, id, cwd},
//             {type: message, message: {role, content}}, {type: session_info, name}.
//   gemini    ~/.gemini/tmp/<sha256(cwd)>/chats/session-*.json: ONE JSON object {sessionId, projectHash, lastUpdated, messages[]}.
//   copilot   $COPILOT_HOME/session-state/<id>/events.jsonl: {type: session.start|user.message|assistant.message, data}.
//   opencode  $OPENCODE_DB or $XDG_DATA_HOME/opencode/opencode.db (SQLite: session, message, part), read-only.
//   cursor    ~/.cursor/chats/<md5(cwd)>/<id>/meta.json (title, cwd) and ~/.cursor/projects/*/agent-transcripts/<id>/<id>.jsonl when present.
// Formats are the agents' internal ones and change between releases: every reader is best-effort and skips what it can't parse.
// The Claude project-folder encoding is adapted from Paseo (Apache-2.0, packages/server/src/server/agent/providers/claude/project-dir.ts,
// Copyright (c) 2025-present Mohamed Boudra); see NOTICE.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { redactLog } from "./redact.ts";

export const SESSION_AGENTS = ["codex", "claude", "pi", "gemini", "copilot", "opencode", "cursor"] as const;
export type Agent = typeof SESSION_AGENTS[number];
export type Msg = { role: "user" | "assistant" | "tool" | "system"; text: string; at?: number | null };
// file: the transcript path (internal: never sent to the server)
export type Meta = { id: string; agent: Agent; title: string; cwd: string; updatedAt: number; file: string; size: number; forkedFrom?: string | null };
export type Row = Omit<Meta, "file" | "size"> & { snippet: string; live: boolean | null; live_why: string | null; match?: string };
export type Opts = { home?: string; env?: Record<string, string | undefined>; now?: number; agentsJson?: () => Promise<any[] | null>; index?: string | false };

export const LIMITS = { files: 2000, scan: 400, headBytes: 64 * 1024, tailBytes: 256 * 1024, fullBytes: 8 * 1024 * 1024, indexText: 8 * 1024, indexRows: 600, sampleBytes: 256 * 1024, msgChars: 4000, snippet: 240, freshMs: 90_000, zstBytes: 2 * 1024 * 1024, dbRows: 5000 };
export const clean = (s: string) => redactLog(String(s ?? ""), [], { emails: false });
const one = (s: string, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

// ---------- where things live ----------
export function roots(o: Opts = {}) {
  const h = o.home ?? homedir(), e = o.env ?? process.env;
  const xdg = e.XDG_DATA_HOME || join(h, ".local", "share");
  return {
    codex: e.CODEX_HOME || join(h, ".codex"),
    claude: e.CLAUDE_CONFIG_DIR || join(h, ".claude"),
    pi: e.PI_CODING_AGENT_SESSION_DIR || join(e.PI_CODING_AGENT_DIR || join(h, ".pi", "agent"), "sessions"),
    gemini: join(h, ".gemini", "tmp"),
    copilot: join(e.COPILOT_HOME || join(h, ".copilot"), "session-state"),
    opencode: e.OPENCODE_DB || join(xdg, "opencode", "opencode.db"),
    cursor: join(h, ".cursor"),
  };
}
// Claude's project folder name for a cwd (Paseo's port of the SDK's encoding: non-alphanumerics -> '-', capped at 200 + a hash suffix)
export function claudeDirName(cwd: string): string {
  const s = process.platform === "darwin" ? cwd.normalize("NFC") : cwd, r = s.replace(/[^a-zA-Z0-9]/g, "-");
  if (r.length <= 200) return r;
  let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `${r.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

// ---------- small file helpers (read-only, byte-capped) ----------
function walk(dir: string, test: (name: string) => boolean, depth = 4, out: string[] = []): string[] {
  if (out.length >= LIMITS.files * 4) return out;
  let ents: any[]; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of ents) { const p = join(dir, d.name);
    if (d.isDirectory()) { if (depth > 0) walk(p, test, depth - 1, out); } else if (d.isFile() && test(d.name)) out.push(p); }
  return out;
}
const st = (p: string) => { try { const s = statSync(p); return { mtime: s.mtimeMs, size: s.size }; } catch { return null; } };
// newest first, capped: a home folder with years of sessions stays a bounded scan
function newest(files: string[], n = LIMITS.files) { return files.map(f => ({ f, s: st(f) })).filter(x => x.s).sort((a, b) => b.s!.mtime - a.s!.mtime).slice(0, n); }
function readRange(p: string, start: number, len: number): string {
  let fd = -1; try { fd = openSync(p, "r"); const b = Buffer.alloc(len); const n = readSync(fd, b, 0, len, start); return b.subarray(0, n).toString("utf8"); } catch { return ""; } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
}
// whole text of a transcript, up to fullBytes (the newest part when it's bigger); .zst rollouts (Codex, after ~7 days) decompressed
const unzst = (p: string, size: number) => { if (size > LIMITS.zstBytes) return ""; try { const z = (Bun as any).zstdDecompressSync?.(readFileSync(p)); return z ? Buffer.from(z).toString("utf8") : ""; } catch { return ""; } };
let sampling = false; // index refresh: only the newest sampleBytes of each transcript (a first search over hundreds of big sessions stays cheap)
function readText(p: string, size: number, cap = LIMITS.fullBytes): string {
  if (sampling) cap = Math.min(cap, LIMITS.sampleBytes);
  // a .zst can't be read in part (one frame, no streaming decoder in Bun), so only a small one is decompressed at all: a 2 MB rollout
  // inflates to tens of MB; a bigger one lists by its file name only and isn't read (bounded memory over years of archived sessions)
  if (p.endsWith(".zst")) return unzst(p, size).slice(-cap);
  if (size <= cap) return readRange(p, 0, size);
  const t = readRange(p, size - cap, cap); return t.slice(t.indexOf("\n") + 1); // drop the cut line
}
const lines = (t: string) => { const out: any[] = []; for (const l of t.split("\n")) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} } return out; }; // LF only (Pi: U+2028 is data)
const ms = (v: any): number | null => { if (v == null) return null; if (typeof v === "number") return v < 1e12 ? v * 1000 : v; const n = Date.parse(String(v)); return Number.isFinite(n) ? n : null; };
// text of a message content in any of the shapes agents use: a string, [{type: text|input_text|output_text, text}], {parts: [...]}
export function textOf(c: any): string {
  if (c == null) return ""; if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(x => typeof x === "string" ? x : x && typeof x === "object" ? (typeof x.text === "string" && /text$|^text|^output|^input/.test(String(x.type ?? "text")) ? x.text : x.type === "tool_result" ? textOf(x.content) : "") : "").filter(Boolean).join("\n");
  if (typeof c === "object") return typeof c.text === "string" ? c.text : textOf(c.parts ?? c.content);
  return "";
}
const role = (r: any): Msg["role"] => r === "user" || r === "human" ? "user" : r === "assistant" || r === "model" || r === "gemini" || r === "agent" ? "assistant" : r === "tool" || r === "toolResult" ? "tool" : "system";

// ---------- one reader per agent: list() -> Meta[], read(meta) -> Msg[] ----------
type Reader = { list(o: Opts): Meta[]; read(m: Meta, o: Opts): Msg[] };
const R: Record<Agent, Reader> = {
  codex: {
    list(o) { const r = roots(o).codex, names = new Map<string, string>();
      for (const x of lines(readText(join(r, "session_index.jsonl"), st(join(r, "session_index.jsonl"))?.size ?? 0, 2 * 1024 * 1024))) if (x?.id && (x.thread_name || x.name)) names.set(String(x.id), String(x.thread_name ?? x.name));
      const files = newest([...walk(join(r, "sessions"), n => /^rollout-.*\.jsonl(\.zst)?$/.test(n)), ...walk(join(r, "archived_sessions"), n => /^rollout-.*\.jsonl(\.zst)?$/.test(n), 1)]);
      return files.map(({ f, s }) => { const head = f.endsWith(".zst") ? unzst(f, s!.size).slice(0, LIMITS.headBytes) : readRange(f, 0, Math.min(s!.size, LIMITS.headBytes));
        const all = lines(head), meta = all.find(x => x?.type === "session_meta")?.payload ?? {}, id = String(meta.id ?? basename(f).match(/([0-9a-f-]{36})\.jsonl/)?.[1] ?? "");
        if (!id) return null;
        const firstUser = all.map(x => x?.type === "response_item" && x.payload?.type === "message" && x.payload.role === "user" ? textOf(x.payload.content) : x?.type === "event_msg" && x.payload?.type === "user_message" ? String(x.payload.message ?? "") : "").find(t => t && !t.startsWith("<"));
        return { id, agent: "codex", title: names.get(id) ?? one(firstUser ?? "", 80), cwd: String(meta.cwd ?? ""), updatedAt: s!.mtime, file: f, size: s!.size, forkedFrom: meta.forked_from_id ?? null } as Meta; }).filter(Boolean) as Meta[]; },
    read(m) { const out: Msg[] = [];
      for (const x of lines(readText(m.file, m.size))) { const p = x?.payload; if (x?.type !== "response_item" || p?.type !== "message") continue;
        const t = textOf(p.content); if (!t || (p.role === "user" && /^<(environment_context|user_instructions|permissions)/.test(t))) continue; // Codex's own preamble
        out.push({ role: role(p.role), text: t, at: ms(x.timestamp) }); }
      return out; },
  },
  claude: {
    list(o) { const files = newest(walk(join(roots(o).claude, "projects"), n => n.endsWith(".jsonl"), 1));
      return files.map(({ f, s }) => { const head = lines(readRange(f, 0, Math.min(s!.size, LIMITS.headBytes))), tail = s!.size > LIMITS.headBytes ? lines(readRange(f, Math.max(0, s!.size - LIMITS.tailBytes), Math.min(s!.size, LIMITS.tailBytes))) : [];
        const all = [...head, ...tail], first = all.find(x => x?.sessionId), id = String(first?.sessionId ?? basename(f, ".jsonl"));
        const title = [...all].reverse().find(x => x?.type === "custom-title")?.customTitle ?? [...all].reverse().find(x => x?.type === "summary")?.summary
          ?? one(textOf(all.find(x => x?.type === "user" && !x.isMeta && typeof textOf(x.message?.content) === "string" && textOf(x.message?.content) && !textOf(x.message?.content).startsWith("<"))?.message?.content), 80);
        return { id, agent: "claude", title: String(title ?? ""), cwd: String(all.find(x => x?.cwd)?.cwd ?? ""), updatedAt: s!.mtime, file: f, size: s!.size } as Meta; }); },
    read(m) { return lines(readText(m.file, m.size)).filter(x => (x?.type === "user" || x?.type === "assistant") && !x.isMeta && !x.isSidechain)
      .map(x => ({ role: role(x.message?.role ?? x.type), text: textOf(x.message?.content), at: ms(x.timestamp) })).filter(x => x.text && !x.text.startsWith("<command-") && !x.text.startsWith("<local-command")); },
  },
  pi: {
    list(o) { const files = newest(walk(roots(o).pi, n => n.endsWith(".jsonl"), 2));
      return files.map(({ f, s }) => { const head = lines(readRange(f, 0, Math.min(s!.size, LIMITS.headBytes))), tail = s!.size > LIMITS.headBytes ? lines(readRange(f, Math.max(0, s!.size - LIMITS.tailBytes), Math.min(s!.size, LIMITS.tailBytes))) : [];
        const h = head.find(x => x?.type === "session"); if (!h?.id) return null;
        const name = [...head, ...tail].reverse().find(x => x?.type === "session_info" && x.name)?.name, fu = head.find(x => x?.type === "message" && x.message?.role === "user");
        return { id: String(h.id), agent: "pi", title: String(name ?? one(textOf(fu?.message?.content), 80)), cwd: String(h.cwd ?? ""), updatedAt: s!.mtime, file: f, size: s!.size, forkedFrom: h.parentSession ? basename(String(h.parentSession), ".jsonl") : null } as Meta; }).filter(Boolean) as Meta[]; },
    read(m) { return lines(readText(m.file, m.size)).filter(x => x?.type === "message" && x.message).map(x => ({ role: role(x.message.role), text: textOf(x.message.content), at: ms(x.timestamp) })).filter(x => x.text); },
  },
  gemini: {
    list(o) { const files = newest(walk(roots(o).gemini, n => /^session-.*\.json$/.test(n), 2));
      return files.map(({ f, s }) => { let j: any; try { j = JSON.parse(readText(f, s!.size, 4 * 1024 * 1024)); } catch { return null; } if (!j?.sessionId) return null;
        const fu = (j.messages ?? []).find((x: any) => x?.type === "user");
        return { id: String(j.sessionId), agent: "gemini", title: one(j.summary ?? textOf(fu?.content), 80), cwd: "", /* Gemini keeps only sha256(cwd), its folder name: cwd filters match on that */ updatedAt: ms(j.lastUpdated) ?? s!.mtime, file: f, size: s!.size } as Meta; }).filter(Boolean) as Meta[]; },
    read(m) { let j: any; try { j = JSON.parse(readText(m.file, m.size, 16 * 1024 * 1024)); } catch { return []; }
      return (j.messages ?? []).filter((x: any) => x?.type === "user" || x?.type === "gemini").map((x: any) => ({ role: role(x.type), text: textOf(x.content), at: ms(x.timestamp) })).filter((x: Msg) => x.text); },
  },
  copilot: {
    list(o) { const files = newest(walk(roots(o).copilot, n => n === "events.jsonl", 1));
      return files.map(({ f, s }) => { const ev = lines(readRange(f, 0, Math.min(s!.size, LIMITS.headBytes))), start = ev.find(x => x?.type === "session.start")?.data ?? {}, fu = ev.find(x => x?.type === "user.message");
        return { id: String(start.sessionId ?? basename(dirname(f))), agent: "copilot", title: one(String(fu?.data?.content ?? ""), 80), cwd: String(start.context?.cwd ?? start.cwd ?? ""), updatedAt: s!.mtime, file: f, size: s!.size } as Meta; }); },
    read(m) { return lines(readText(m.file, m.size)).filter(x => x?.type === "user.message" || x?.type === "assistant.message")
      .map(x => ({ role: x.type === "user.message" ? "user" as const : "assistant" as const, text: textOf(x.data?.content ?? x.data?.text), at: ms(x.timestamp) })).filter(x => x.text); },
  },
  opencode: {
    list(o) { const db = openRo(roots(o).opencode); if (!db) return [];
      try { const s = st(roots(o).opencode);
        return (db.query("select id, title, directory, time_updated from session order by time_updated desc limit ?").all(LIMITS.files) as any[])
          .map(r => ({ id: String(r.id), agent: "opencode", title: one(String(r.title ?? ""), 80), cwd: String(r.directory ?? ""), updatedAt: ms(r.time_updated) ?? s?.mtime ?? 0, file: roots(o).opencode, size: s?.size ?? 0 } as Meta)); }
      catch { return []; } finally { db.close(); } },
    read(m, o) { const db = openRo(roots(o).opencode); if (!db) return [];
      try { // the newest dbRows messages / parts only: a long session's rows never all land in memory
        const msgs = (db.query("select id, data, time_created from message where session_id=? order by time_created desc limit ?").all(m.id, LIMITS.dbRows) as any[]).reverse(), out: Msg[] = [];
        const parts = (db.query("select message_id, data from part where session_id=? order by id desc limit ?").all(m.id, LIMITS.dbRows * 4) as any[]).reverse(), by = new Map<string, string[]>();
        for (const p of parts) { let d: any = {}; try { d = JSON.parse(p.data); } catch {} if (d?.type === "text" && d.text) (by.get(p.message_id) ?? by.set(p.message_id, []).get(p.message_id)!).push(String(d.text)); }
        for (const x of msgs) { let d: any = {}; try { d = JSON.parse(x.data); } catch {} const t = (by.get(x.id) ?? []).join("\n"); if (t) out.push({ role: role(d.role), text: t, at: ms(x.time_created) }); }
        return out; } catch { return []; } finally { db.close(); } },
  },
  cursor: {
    list(o) { const r = roots(o).cursor, metas = newest(walk(join(r, "chats"), n => n === "meta.json", 2)), seen = new Set<string>(), out: Meta[] = [];
      const tx = new Map(walk(join(r, "projects"), n => n.endsWith(".jsonl"), 3).filter(f => f.includes("agent-transcripts")).map(f => [basename(f, ".jsonl"), f]));
      for (const { f, s } of metas) { let j: any = {}; try { j = JSON.parse(readFileSync(f, "utf8")); } catch {} const id = String(j.agentId ?? j.id ?? basename(dirname(f))); seen.add(id);
        const t = tx.get(id), ts = t ? st(t) : null;
        out.push({ id, agent: "cursor", title: one(String(j.name ?? j.title ?? ""), 80), cwd: String(j.cwd ?? j.workspace ?? ""), updatedAt: Math.max(ms(j.lastUpdatedAt ?? j.updatedAt) ?? 0, s!.mtime, ts?.mtime ?? 0), file: t ?? "", size: ts?.size ?? 0 }); }
      for (const [id, f] of tx) if (!seen.has(id)) { const s = st(f)!; out.push({ id, agent: "cursor", title: "", cwd: "", updatedAt: s.mtime, file: f, size: s.size }); }
      return out; },
    read(m) { if (!m.file) return []; return lines(readText(m.file, m.size)).map(x => ({ role: role(x.role ?? x.type), text: textOf(x.message?.content ?? x.content ?? x.text), at: ms(x.timestamp) })).filter(x => x.text && x.role !== "system"); },
  },
};
function openRo(p: string): any { if (!existsSync(p)) return null;
  try { const { Database } = require("bun:sqlite"); const db = new Database(p, { readonly: true }); try { db.exec("PRAGMA query_only = ON"); } catch {} return db; } catch { return null; } }

// ---------- live: is it open in another process right now? ----------
// true = open (claude agents lists it running, Codex holds its writer lock next to a recent write, or written in the last 90 s);
// false ONLY with an authoritative "nobody writes it": claude agents answered without it, or Codex keeps writer locks and this thread has none.
// null = can't tell: an idle session isn't a closed one (Pi, Gemini, Copilot, opencode, Cursor have no writer record we can read; a Codex
// lock left behind by an idle or crashed process), so anything that would write treats it as open and forks instead (runner-sessions.ts).
let agentsCache: { at: number; v: any[] | null } | null = null;
async function claudeAgents(o: Opts): Promise<any[] | null> {
  if (o.agentsJson) return o.agentsJson();
  if (agentsCache && Date.now() - agentsCache.at < 15_000) return agentsCache.v;
  let v: any[] | null = null;
  try { if (Bun.which("claude")) { const p = Bun.spawn(["claude", "agents", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, ...(o.home ? { HOME: o.home } : {}) } as any });
    const t = setTimeout(() => { try { p.kill(); } catch {} }, 5000); const out = await new Response(p.stdout).text(); clearTimeout(t);
    if ((await p.exited) === 0) { const j = JSON.parse(out); v = Array.isArray(j) ? j : Array.isArray(j?.agents) ? j.agents : Array.isArray(j?.sessions) ? j.sessions : null; } } } catch { v = null; }
  agentsCache = { at: Date.now(), v }; return v;
}
const alive = (pid: any) => { const n = Number(pid); if (!Number.isInteger(n) || n <= 0) return true; try { process.kill(n, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };
export async function liveOf(m: Meta, o: Opts = {}): Promise<{ live: boolean | null; why: string | null }> {
  const now = o.now ?? Date.now(); let closed = false; // closed: authoritative evidence that no process writes it
  if (m.agent === "claude") { const a = await claudeAgents(o);
    if (a) { const hit = a.find(x => String(x?.sessionId ?? x?.session_id ?? x?.id) === m.id && !/stopped|exited|done|dead/i.test(String(x?.status ?? x?.state ?? "")) && alive(x?.pid));
      if (hit) return { live: true, why: `open in Claude Code (pid ${hit.pid ?? "?"}, claude agents)` }; closed = true; } }
  let lockIdle = false;
  if (m.agent === "codex") { const dir = join(roots(o).codex, "thread-writer-locks"), lock = join(dir, `${m.id}.lock`);
    if (existsSync(lock)) { if (now - m.updatedAt < 10 * 60_000) return { live: true, why: "Codex holds this thread's writer lock" }; lockIdle = true; }
    else closed = existsSync(dir); }
  const ref = m.agent === "opencode" || m.agent === "gemini" ? m.updatedAt : (st(m.file)?.mtime ?? m.updatedAt);
  if (now - ref < LIMITS.freshMs) return { live: true, why: `written ${Math.round((now - ref) / 1000)} s ago (likely open)` };
  return closed ? { live: false, why: null } : { live: null, why: lockIdle ? "Codex still has this thread's writer lock (idle, or left by a crash)" : "idle; whether it's still open somewhere can't be told" };
}

// ---------- the small local index: per transcript file, its meta + a capped, REDACTED text sample (head + tail), refreshed by mtime ----------
// ~/.kitebook/sessions-index.json (0600). It never holds more than LIMITS.indexRows sessions x LIMITS.indexText chars, and only redacted text.
type IndexRow = { mtime: number; size: number; text: string };
const indexPath = (o: Opts) => o.index === false ? null : o.index ?? join(o.home ?? homedir(), ".kitebook", "sessions-index.json");
function loadIndex(o: Opts): Record<string, IndexRow> { const p = indexPath(o); if (!p) return {}; try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } }
function saveIndex(o: Opts, ix: Record<string, IndexRow>) { const p = indexPath(o); if (!p) return;
  const keep = Object.entries(ix).sort((a, b) => b[1].mtime - a[1].mtime).slice(0, LIMITS.indexRows);
  try { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p + ".tmp", JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 }); renameSync(p + ".tmp", p); } catch {} }
const key = (m: Meta) => `${m.agent}:${m.id}`;
function sample(m: Meta, o: Opts): string { sampling = true; let ms_: Msg[]; try { ms_ = safeRead(m, o); } finally { sampling = false; } const t = ms_.map(x => x.text).join("\n"); const half = LIMITS.indexText / 2;
  return clean(t.length > LIMITS.indexText ? t.slice(0, half) + "\n…\n" + t.slice(-half) : t); }
const safeRead = (m: Meta, o: Opts): Msg[] => { try { return R[m.agent].read(m, o); } catch { return []; } };

// ---------- public: list, search, get ----------
const want = (a?: string | null): Agent[] => { if (!a) return [...SESSION_AGENTS]; const x = String(a).toLowerCase(); if (!(SESSION_AGENTS as readonly string[]).includes(x)) throw new Error(`agent: one of ${SESSION_AGENTS.join(", ")}`); return [x as Agent]; };
const cwdOk = (m: Meta, cwd?: string | null) => !cwd || m.cwd === cwd || m.cwd.startsWith(cwd.replace(/\/$/, "") + "/") || (m.agent === "gemini" && basename(dirname(dirname(m.file))) === createHash("sha256").update(cwd).digest("hex"));
export function listAll(o: Opts & { agent?: string | null; cwd?: string | null; since?: number | null } = {}): Meta[] {
  const out: Meta[] = []; for (const a of want(o.agent)) { let l: Meta[] = []; try { l = R[a].list(o); } catch {} for (const m of l) if (cwdOk(m, o.cwd) && (!o.since || m.updatedAt >= o.since)) out.push(m); }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function search(q: { query?: string; agent?: string | null; cwd?: string | null; since?: number | string | null; limit?: number }, o: Opts = {}): Promise<{ sessions: Row[]; scanned: number; total: number; truncated: boolean }> {
  const since = q.since == null || q.since === "" ? null : typeof q.since === "number" ? q.since : ms(q.since) ?? ageMs(String(q.since), o.now);
  const all = listAll({ ...o, agent: q.agent, cwd: q.cwd, since }), terms = String(q.query ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
  const limit = Math.max(1, Math.min(50, Number(q.limit ?? 10) || 10)), ix = loadIndex(o), hits: Row[] = []; let scanned = 0, dirty = false;
  for (const m of all.slice(0, LIMITS.scan)) {
    scanned++; const k = key(m); let r = ix[k];
    if (!r || r.mtime !== m.updatedAt || r.size !== m.size) { r = { mtime: m.updatedAt, size: m.size, text: sample(m, o) }; ix[k] = r; dirty = true; }
    const hay = `${m.title}\n${m.cwd}\n${r.text}`.toLowerCase();
    if (terms.length && !terms.every(t => hay.includes(t))) continue;
    const at = terms.length ? r.text.toLowerCase().indexOf(terms[0]) : -1;
    const snip = at >= 0 ? one(r.text.slice(Math.max(0, at - 80), at + 160), LIMITS.snippet) : one(r.text.slice(-LIMITS.snippet), LIMITS.snippet);
    const lv = await liveOf(m, o);
    hits.push({ id: m.id, agent: m.agent, title: clean(m.title), cwd: m.cwd, updatedAt: m.updatedAt, forkedFrom: m.forkedFrom ?? null, snippet: snip, live: lv.live, live_why: lv.why, ...(terms.length ? { match: at >= 0 ? "text" : "title" } : {}) });
    if (hits.length >= limit) break;
  }
  if (dirty) saveIndex(o, ix);
  return { sessions: hits, scanned, total: all.length, truncated: all.length > scanned };
}
export function find(agent: string, id: string, o: Opts = {}): Meta | null { const [a] = want(agent); return listAll({ ...o, agent: a }).find(m => m.id === String(id)) ?? null; }
export async function get(q: { agent: string; id: string; last?: number }, o: Opts = {}) {
  const m = find(q.agent, q.id, o); if (!m) throw new Error(`no ${q.agent} session ${q.id} on this computer (sessions_search lists them)`);
  const n = Math.max(1, Math.min(100, Number(q.last ?? 20) || 20)), all = safeRead(m, o), lv = await liveOf(m, o);
  return { id: m.id, agent: m.agent, title: clean(m.title), cwd: m.cwd, updatedAt: m.updatedAt, forkedFrom: m.forkedFrom ?? null, live: lv.live, live_why: lv.why, total: all.length,
    messages: all.slice(-n).map(x => ({ role: x.role, text: clean(x.text.length > LIMITS.msgChars ? x.text.slice(0, LIMITS.msgChars) + "…" : x.text), at: x.at ?? null, ...(x.text.length > LIMITS.msgChars ? { truncated: true } : {}) })) };
}
// Status is separate from get(): bounded metadata only, no transcript or search-index writes.
export type SessionModel = { id: string; source: string; scope: string; at: number | null; verified_current: false };
export async function status(q: { agent: string; id: string }, o: Opts = {}) {
  const m = find(q.agent, q.id, o); if (!m) throw new Error(`no ${q.agent} session ${q.id} on this computer (sessions_search lists them)`);
  const lv = await liveOf(m, o), now = o.now ?? Date.now(); let model: SessionModel | null = null;
  const record = (id: any, source: string, at: any, scope = "last_recorded_turn") => { if (typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,199}$/.test(id) && clean(id) === id) model = { id, source, scope, at: ms(at), verified_current: false }; };
  try {
    if (m.agent === "opencode") { const db = openRo(roots(o).opencode); try { if (db) for (const row of (db.query("select data from message where session_id=? order by time_created desc limit 10").all(m.id) as any[]).reverse()) { const d = JSON.parse(row.data); record(d.modelID ? (d.providerID ? d.providerID + "/" : "") + d.modelID : null, "assistant_metadata", d.time?.created); } } finally { db?.close(); } }
    else if (m.file) { const text = m.file.endsWith(".zst") ? unzst(m.file, m.size).slice(-LIMITS.tailBytes) : readRange(m.file, Math.max(0, m.size - LIMITS.tailBytes), Math.min(m.size, LIMITS.tailBytes));
      if (m.agent === "gemini") { const d = JSON.parse(text); for (const x of d.messages ?? []) if (x.type === "gemini" || x.role === "model") record(x.model, "assistant_metadata", x.timestamp); }
      else for (const x of lines(text)) {
        if (m.agent === "codex" && x.type === "turn_context") record(x.payload?.model, "turn_context", x.timestamp, "recorded_turn_configuration");
        if (m.agent === "pi" && x.type === "model_change") record(x.modelId ? (x.provider ? x.provider + "/" : "") + x.modelId : null, "model_change", x.timestamp, "recorded_session_selection");
        if (m.agent === "claude" && x.type === "assistant") record(x.message?.model, "assistant_message", x.timestamp);
        if (m.agent === "copilot" && x.type === "assistant.message") record(x.data?.model, "assistant_message", x.timestamp);
        if (m.agent === "cursor" && (x.role === "assistant" || x.type === "assistant")) record(x.model ?? x.message?.model, "assistant_metadata", x.timestamp);
      }
    }
  } catch {} // formats without model metadata stay unknown; no inference from a default/catalog
  const state = lv.live === false ? "closed" : lv.live === null ? "unknown" : lv.why?.startsWith("written ") ? "recent_activity" : "open";
  return { id: m.id, agent: m.agent, cwd: clean(m.cwd), updated_at: new Date(m.updatedAt).toISOString(), checked_at: new Date(now).toISOString(), activity: { state, evidence: lv.why }, busy: null, model: model as SessionModel | null,
    note: "Observed local session metadata, not a running-task inventory. Recent writes do not establish that a turn is still running; recorded model metadata does not verify the current model." };
}
// A "context-transplant" fork for agents without a real fork (and the fallback for every agent): a summary of the owner's session seeded
// into a NEW session. Read-only: the source file is only read. Redacted, capped at ~12 KB.
export async function transplant(agent: string, id: string, o: Opts = {}, last = 12): Promise<{ text: string; meta: Meta }> {
  const g = await get({ agent, id, last }, o), m = find(agent, id, o)!;
  const body = g.messages.map(x => `[${x.role}] ${x.text.length > 1500 ? x.text.slice(0, 1500) + "…" : x.text}`).join("\n\n");
  return { meta: m, text: `## Continued from the owner's ${agent} session ${id}${g.title ? ` ("${g.title}")` : ""}\nA copy: the original session was not changed. Last ${g.messages.length} of ${g.total} messages${g.cwd ? `, in ${g.cwd}` : ""}:\n\n${body.slice(-12000)}\n\n---\n` };
}
function ageMs(s: string, now = Date.now()): number | null { const m = /^(\d+)\s*(m|h|d|w)$/.exec(s.trim()); if (!m) return null; return now - Number(m[1]) * ({ m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 } as any)[m[2]]; }
