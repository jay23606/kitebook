// Client side of the live knowledge base (server: src/kb.ts). Shared by the runner (memory sync + local read cache) and the CLI
// (kb import / export / search). Local memory is READ here and published; nothing from the KB is ever written back into it.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, rmSync, renameSync } from "fs";
import { join, dirname, relative, resolve, isAbsolute } from "path";
import { homedir } from "os";
import { Glob } from "bun";
type Call = (op: string, args?: any) => Promise<any>;

// Same token patterns the server refuses, plus written-out passwords/keys and URL credentials (client/redact.ts, shared with the server).
// Local memory is redacted before it leaves the machine, so one stray key in a note never blocks the whole file.
export { redact } from "./redact.ts";
import { redact } from "./redact.ts";

// Personal-info files are skipped unless a sync entry names them in `include`.
export const DEFAULT_DENY = ["**/USER.md", "**/people/**", "**/contacts/**", "**/*address*", "**/*personal*", "**/*private*", "**/.env*", "**/*.pem", "**/*.key",
  "**/id_rsa*", "**/id_ed25519*", "**/secrets/**", "**/*credential*", "**/*password*", "**/sessions/**", "**/*session*.json*", "**/transcripts/**", "**/*transcript*",
  "**/auth.json", "**/history.jsonl"]; // agent homes (~/.pi/agent, ~/.codex) keep conversations and logins next to their instructions
const TEXT_EXT = /\.(md|markdown|mdx|mdc|txt)$/i, SKIP_DIRS = new Set([".git", "node_modules", ".venv", "dist", "build", ".cache"]);
const gm = (g: string, p: string) => new Glob(g).match(p) || (g.startsWith("**/") && new Glob(g.slice(3)).match(p));
export const expand = (p: string) => p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(p);
const tilde = (abs: string) => abs.startsWith(homedir() + "/") ? "~/" + abs.slice(homedir().length + 1) : abs; // keys never carry the user name
export const hashOf = (t: string) => new Bun.CryptoHasher("sha256").update(t).digest("hex").slice(0, 32); // = server's hash of the entry text

// Chunk by heading, then split long sections at paragraph (then line, then hard) boundaries to about `max` chars.
export function chunk(text: string, max = 800): { title: string | null; text: string }[] {
  const secs: { title: string | null; body: string[] }[] = [{ title: null, body: [] }];
  for (const l of text.split(/\r?\n/)) { const h = l.match(/^#{1,6}\s+(.*)$/); if (h) secs.push({ title: h[1].trim(), body: [l] }); else secs[secs.length - 1].body.push(l); }
  const out: { title: string | null; text: string }[] = [];
  for (const s of secs) {
    const body = s.body.join("\n").trim(); if (!body) continue;
    let buf = "";
    const flush = () => { if (buf.trim()) out.push({ title: s.title, text: buf.trim() }); buf = ""; };
    for (const para of body.split(/\n\s*\n/)) {
      const pieces = para.length <= max ? [para] : para.split("\n").flatMap(l => l.length <= max ? [l] : l.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")) ?? []);
      for (const p of pieces) { if (buf && buf.length + p.length + 2 > max) flush(); buf += (buf ? "\n\n" : "") + p; }
    }
    flush();
  }
  return out;
}

export type SyncEntry = { path: string; scope?: string; kind?: string; origin?: string; exclude?: string[]; include?: string[]; only?: string[]; max?: number };
// Files a sync entry covers (a file, or text files under a dir), minus the default personal-info denylist and `exclude`.
export function filesOf(e: SyncEntry): { abs: string; rel: string }[] {
  const root = expand(e.path); let st; try { st = statSync(root); } catch { return []; }
  const all: { abs: string; rel: string }[] = [];
  if (st.isFile()) all.push({ abs: root, rel: root.split("/").pop()! });
  else { const walk = (d: string) => { for (const n of readdirSync(d, { withFileTypes: true })) {
    const abs = join(d, n.name); if (n.isDirectory()) { if (!SKIP_DIRS.has(n.name)) walk(abs); } else if (n.isFile() && TEXT_EXT.test(n.name)) all.push({ abs, rel: relative(root, abs) }); } };
    walk(root); }
  return all.filter(f => !e.only?.length || e.only.some(g => gm(g, f.rel))).filter(f => (e.include ?? []).some(g => gm(g, f.rel)) || (!DEFAULT_DENY.some(g => gm(g, f.rel)) && !(e.exclude ?? []).some(g => gm(g, f.rel)))).slice(0, 2000);
}
// Coding-agent instruction sources that `runner.ts init` / `kb detect` propose for kb.sync, so conventions the user taught Pi, Codex,
// Claude Code or a repo flow into the KB without hand-written config. Exact files and narrow globs only: never a whole agent home
// (~/.pi/agent also holds sessions and auth.json). Only sources that exist (and survive the denylist) are proposed.
export const AGENT_ORIGINS = ["pi-memory", "codex-memory", "claude-memory", "repo-agents"];
export function agentSources(projects: Record<string, { path?: string }> = {}): SyncEntry[] {
  const g = (path: string, origin: string, only?: string[]): SyncEntry => ({ path, scope: "global", kind: "memory", origin, ...(only ? { only } : {}) });
  const out = [g("~/.pi/agent/AGENTS.md", "pi-memory"), g("~/.pi/agent/SYSTEM.md", "pi-memory"), g("~/.pi/agent/APPEND_SYSTEM.md", "pi-memory"),
    g("~/.pi/agent/skills", "pi-memory", ["**/SKILL.md"]), g("~/.pi/agent/prompts", "pi-memory", ["*.md"]),
    g("~/.codex/AGENTS.md", "codex-memory"), g("~/.claude/CLAUDE.md", "claude-memory"), g("~/AGENTS.md", "repo-agents")]; // ~/AGENTS.md: every agent walking up from a repo reads it
  for (const [name, p] of Object.entries(projects)) if (p?.path) for (const f of ["AGENTS.md", "CLAUDE.md", "CONTEXT.md", ".cursor/rules"])
    out.push({ path: tilde(join(expand(p.path), f)), scope: `project:${name}`, kind: "memory", origin: "repo-agents" });
  return out.filter(e => filesOf(e).length);
}
// Add proposed sources that aren't synced yet; existing entries are kept as they are (an entry whose file was deleted stays, so the
// next sync forgets its chunks instead of leaving them behind).
export function mergeSync(have: SyncEntry[] = [], proposed: SyncEntry[]) {
  const seen = new Set(have.map(e => expand(e.path))), added = proposed.filter(e => !seen.has(expand(e.path)));
  return { sync: [...have, ...added], added };
}
export const syncStateFile = (name: string, space: string) => join(homedir(), ".kitebook", `${name}.${space}.kb-sync.json`); // written by the runner, read by doctor

// key = <file path, ~-relative>#<chunk>; key_prefix = the sync root, so one kb_list finds every chunk this entry published.
// Stat cache: a file whose (size, mtime, ctime, inode) is unchanged since the last tick is not read or re-hashed again; its chunks
// are reused. `io` counts real reads and KB calls so the runner (and smoke) can prove an idle tick costs nothing.
export const io = { reads: 0, calls: {} as Record<string, number> };
const statCache = new Map<string, { sig: string; chunks: { title: string | null; text: string; hash: string }[] }>();
const statSig = (abs: string) => { try { const s = statSync(abs); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`; } catch { return null; } };
export function chunksOf(e: SyncEntry) {
  const root = tilde(expand(e.path)), out: { key: string; title: string | null; text: string; hash: string }[] = [], max = e.max ?? 800;
  for (const f of filesOf(e)) {
    const ck = `${max}\0${f.rel}\0${f.abs}`, sig = statSig(f.abs), hit = sig && statCache.get(ck);
    let cs = hit && hit.sig === sig ? hit.chunks : null;
    if (!cs) {
      let raw: string; try { const b = readFileSync(f.abs); io.reads++; if (b.length > 2_000_000 || b.includes(0)) { statCache.delete(ck); continue; } raw = b.toString("utf8"); } catch { continue; }
      cs = chunk(redact(raw), max).map(c => ({ title: c.title ?? f.rel, text: c.text, hash: hashOf(c.text) }));
      if (sig) statCache.set(ck, { sig, chunks: cs });
    }
    cs.forEach((c, i) => out.push({ key: `${tilde(f.abs)}#${i}`, ...c }));
  }
  return { prefix: root, chunks: out };
}

// Local manifest of what this runner last published per source (key -> hash), so a change sends only the changed chunks and a
// restart doesn't page kb_list over every entry. The server stays the source of truth: the manifest is rebuilt from a full kb_list
// on first run, when the file is lost/unreadable, for another Kitebook URL, and every `reconcileMs` (default 6 h) as a cheap check.
export const manifestFile = (name: string, space: string) => join(homedir(), ".kitebook", `${name}.${space}.kb-manifest.json`);
export type Manifest = { url?: string; sources: Record<string, { keys: Record<string, string>; listed_at: number }> };
export function loadManifest(file: string, url: string): Manifest {
  try { const m = JSON.parse(readFileSync(file, "utf8")); if (m?.url === url && m.sources && typeof m.sources === "object") return m; } catch {}
  return { url, sources: {} };
}
export function saveManifest(file: string, m: Manifest) { try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file + ".tmp", JSON.stringify(m)); renameSync(file + ".tmp", file); } catch {} }
async function ollamaEmbed(o: { url?: string; model: string }, texts: string[]): Promise<number[][] | null> {
  try { const r = await fetch(`${(o.url ?? "http://127.0.0.1:11434").replace(/\/$/, "")}/api/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: o.model, input: texts }), signal: AbortSignal.timeout(60_000) });
    if (!r.ok) return null; return ((await r.json()) as any).embeddings ?? null; } catch { return null; }
}
export const ollamaModel = (o: any) => o?.model ? `ollama:${o.model}` : null;
export async function embedQuery(o: any, q: string) { const v = o?.model ? await ollamaEmbed(o, [q]) : null; return v?.[0] ?? null; }

// Diff local chunks against what this origin already published under the prefix: upsert changed, forget gone. Idempotent, so a
// failed run (offline) is simply retried on the next poll; the server stays the source of truth. With a manifest the diff is local
// (no kb_list); it is refreshed from the server only when missing or older than reconcileMs.
export const sourceKey = (e: SyncEntry, defOrigin: string) => `${e.scope ?? "global"}\0${e.origin ?? defOrigin}\0${tilde(expand(e.path))}`;
export async function publish(call: Call, e: SyncEntry, defOrigin: string, ollama?: any, man?: Manifest, reconcileMs = 6 * 3600_000) {
  const { prefix, chunks } = chunksOf(e), scope = e.scope ?? "global", origin = e.origin ?? defOrigin, mk = sourceKey(e, defOrigin);
  const cnt = (op: string) => { io.calls[op] = (io.calls[op] ?? 0) + 1; };
  let have = new Map<string, string>(), listed = false; const known = man?.sources[mk];
  if (known && Date.now() - known.listed_at < reconcileMs) have = new Map(Object.entries(known.keys));
  else { let since = 0; listed = true;
    for (let i = 0; i < 100; i++) { cnt("sync_list"); const r = await call("kb_list", { scope, origin, key_prefix: prefix, since, limit: 1000, include_superseded: true });
      for (const x of r.entries) if (x.key) have.set(x.key, x.hash); since = r.cursor; if (!r.more) break; } }
  const want = new Set(chunks.map(c => c.key)), changed = chunks.filter(c => have.get(c.key) !== c.hash), gone = [...have.keys()].filter(k => !want.has(k));
  let added = 0, rejected = 0; const refused = new Set<string>();
  for (let i = 0; i < changed.length; i += 100) {
    const part = changed.slice(i, i + 100), vecs = ollama?.model ? await ollamaEmbed(ollama, part.map(c => c.text)) : null;
    cnt("kb_add"); const r = await call("kb_add", { skip_rejected: true, message: `kb sync ${origin}: ${prefix}`, entries: part.map((c, j) => ({ text: c.text, key: c.key, title: c.title, scope, kind: e.kind ?? "memory", origin,
      ...(vecs?.[j] ? { embedding: vecs[j], embed_model: ollamaModel(ollama) } : {}) })) });
    added += r.entries.filter((x: any) => !x.unchanged).length; rejected += r.rejected?.length ?? 0; for (const x of r.rejected ?? []) if (x.key) refused.add(x.key);
  }
  for (let i = 0; i < gone.length; i += 200) { cnt("kb_forget"); await call("kb_forget", { scope, keys: gone.slice(i, i + 200) }); }
  // what the server now holds for this source; refused chunks stay out, so they are offered again next change (as before)
  if (man) man.sources[mk] = { keys: Object.fromEntries(chunks.filter(c => !refused.has(c.key)).map(c => [c.key, c.hash])), listed_at: listed ? Date.now() : known!.listed_at };
  return { prefix, chunks: chunks.length, added, removed: gone.length, rejected, listed };
}

// Where a server path lands under a local folder (the read cache, kb export): a plain relative path inside that folder, else null (skipped).
// The server refuses ".." (src/space/util.ts normPath) but splits on "/" only, so "kb/a\..\..\x" passes it and Windows reads "\" as a
// separator; and a relay that misbehaves could send anything. resolve/relative are the platform's own (the old startsWith(dir + "/")
// never matched a Windows path, so the cache stayed empty there).
export function localPath(dir: string, p: string): string | null {
  const rel = String(p).replace(/^kb\//, "");
  if (!rel || /[\\\0]/.test(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith("/") || rel.split("/").some(s => s === ".." || s === ".")) return null;
  const root = resolve(dir), out = resolve(root, rel), r = relative(root, out);
  return r && r !== ".." && !r.startsWith(".." + "/") && !r.startsWith("..\\") && !isAbsolute(r) ? out : null;
}

// Local read cache: the kb/ files mirrored to disk (default ~/.kitebook-kb/kb) so local agents can grep them offline. Pulled with the
// kb_list version cursor; the server wins (local edits to the cache are overwritten on the next change).
export async function pullCache(call: Call, dir: string, stateFile: string) {
  let st: any = {}; try { st = JSON.parse(readFileSync(stateFile, "utf8")); } catch {}
  let since = Number(st.cursor ?? 0) || 0; const touched = new Set<string>();
  for (let i = 0; i < 100; i++) { io.calls.pull_list = (io.calls.pull_list ?? 0) + 1; const r = await call("kb_list", { since, limit: 1000 });
    for (const x of r.entries) touched.add(x.path); for (const x of r.removed ?? []) touched.add(x.path); since = r.cursor; if (!r.more) break; }
  let wrote = 0, removed = 0;
  for (const p of touched) {
    const local = localPath(dir, p); if (!local) continue;
    try { io.calls.pull_read = (io.calls.pull_read ?? 0) + 1; const f = await call("read", { path: p }); mkdirSync(dirname(local), { recursive: true }); writeFileSync(local, f.content ?? ""); wrote++; }
    catch (e: any) { if (/not found/.test(e.message)) { rmSync(local, { force: true }); removed++; } else throw e; }
  }
  mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, JSON.stringify({ cursor: since, at: new Date().toISOString() }));
  return { cursor: since, wrote, removed };
}

// Markdown export for git backup: every kb/ file (and the context/ packs, under context/) as it is on the server.
export async function exportTo(call: Call, dir: string) {
  const g = await call("glob", { pattern: "kb/**" }), c = await call("glob", { pattern: "context/**" }).catch(() => ({ files: [] })); let n = 0;
  for (const p of [...g.files, ...c.files]) { const f = await call("read", { path: p }); if (f.binary) continue; const out = localPath(dir, p); if (!out) continue; mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, f.content); n++; }
  return { files: n, dir, truncated: g.truncated };
}
export const exists = existsSync;
