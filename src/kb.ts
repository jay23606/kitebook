// Live knowledge base (KB). The source of truth is plain markdown in the space under kb/ (kb/global/*.md, kb/<project>/*.md), so
// every entry is versioned, diffable and written with the same commit / if_match / history machinery as any file. Search is DERIVED
// data: every commit that touches kb/ re-indexes those paths in the same SQLite transaction (FTS5 keyword index always; vectors when
// an embedder exists, cached by content hash). Borrowed model: server-side versioned text + a derived index, always online.
//
// File shapes: a file with front matter is ONE entry (what kb_add writes); a plain markdown file is one entry per heading
// (id = path#n), so an agent can also just `write` notes into kb/ and have them searchable.
import { BRIEF_PATH } from "./brief.ts";
import { RelayError, globMatch, sha256, type Peer } from "./ops.ts";
import { hasAssignment } from "../client/redact.ts";

export const KB_KINDS = ["fact", "decision", "gotcha", "pref", "learned", "memory"];
export const KB_SCHEMA = `
create table if not exists kb_entries(id text primary key, path text, scope text, kind text, key text, title text, text text, source text, origin text,
  created text, updated text, seq integer, superseded_by text, hash text, author text, author_kind text);
create index if not exists kb_by_path on kb_entries(path);
create index if not exists kb_by_key on kb_entries(scope, key);
create index if not exists kb_by_seq on kb_entries(seq);
create virtual table if not exists kb_fts using fts5(id unindexed, title, text, tokenize='porter unicode61');
create table if not exists kb_vec(hash text, model text, vec text, primary key(hash, model));
create table if not exists kb_gone(id text primary key, path text, scope text, seq integer);`;
// Passwords and keys written out as assignments (password=..., FOO_API_KEY=...), on top of the space-wide token patterns, only for kb/:
// client/redact.ts hasAssignment (a value must look like a credential: "password: stored in the keychain" is fine; "[REDACTED]" is what clients send)
const TEXT_MAX = 20_000, now = () => new Date().toISOString();
const one = (s: any) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();
const SCOPE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// scope <-> directory: "global" <-> kb/global, "project:<name>" <-> kb/<name>. A bare project name is accepted as input.
export function scopeDir(scope?: string | null) {
  const s = String(scope ?? "global").trim(), name = s.startsWith("project:") ? s.slice(8) : s;
  if (name === "global") return "global";
  if (!SCOPE_RE.test(name)) throw new RelayError(400, `scope must be "global" or "project:<name>" (letters, digits, . _ -)`);
  return name;
}
export const scopeName = (dir: string) => dir === "global" ? "global" : `project:${dir}`;
// context/<project>.md (the handoff-context pack, where agents' .relay-learnings.md land) is indexed too, as project:<project>.
export const scopeOfPath = (path: string) => { const p = path.split("/");
  if (p[0] === "context") return p.length === 2 ? scopeName(p[1].replace(/\.(md|markdown|txt)$/i, "")) : "global";
  return p.length <= 2 ? "global" : scopeName(p[1]); };
export const isKbPath = (p: string) => (p.startsWith("kb/") || p.startsWith("context/")) && p !== BRIEF_PATH && /\.(md|markdown|txt)$/i.test(p); // the assistant brief is delivered whole (src/brief.ts), not searched
const LEARNED_RE = /^Learned in (t_[0-9a-f]+)\b/; // "## Learned in <task> (agent, date)" sections that appendLearnings writes

// ---------- file format ----------
const FM_KEYS = ["kind", "key", "title", "origin", "source", "created", "supersedes", "superseded_by"];
export function fmt(meta: Record<string, any>, text: string) {
  const lines = FM_KEYS.filter(k => meta[k] != null && meta[k] !== "").map(k => `${k}: ${one(meta[k])}`);
  return `---\n${lines.join("\n")}\n---\n${text.trim()}\n`;
}
type Parsed = { id: string; fm: Record<string, string>; title: string | null; text: string };
export function parse(path: string, content: string): Parsed[] {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) { // one entry per file
    const fm: Record<string, string> = {};
    for (const l of m[1].split(/\r?\n/)) { const i = l.indexOf(":"); if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
    const text = m[2].trim(); return text ? [{ id: path, fm, title: fm.title || null, text }] : [];
  }
  // plain markdown: one entry per heading (text before the first heading is its own entry)
  const out: Parsed[] = []; let cur: { title: string | null; lines: string[] } = { title: null, lines: [] };
  const push = () => { const text = cur.lines.join("\n").trim(); if (text) out.push({ id: `${path}#${out.length}`, fm: {}, title: cur.title, text }); };
  for (const l of content.split(/\r?\n/)) { const h = l.match(/^#{1,6}\s+(.*)$/); if (h) { push(); cur = { title: h[1].trim(), lines: [l] }; } else cur.lines.push(l); }
  push();
  if (out.length === 1) out[0].id = path; // a single-section file is just the file
  return out;
}

// ---------- embedders: Workers AI binding, the test fake, or none (keyword-only, semantic:false) ----------
export interface Embedder { model: string; embed(texts: string[]): Promise<number[][]> }
const toks = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
// Deterministic, offline stand-in for a real model (smoke tests only, KB_EMBED=fake): a few synonym groups share a dimension,
// so "car" finds "automobile" with no shared keyword; everything else hashes into its own bucket.
const SYN = [["car", "cars", "automobile", "automobiles", "vehicle", "vehicles"], ["deploy", "deploys", "deployment", "ship", "release", "publish"],
  ["database", "db", "sqlite", "postgres", "datastore"], ["bug", "defect", "glitch"], ["fast", "quick", "speedy", "latency"]];
const STOP = new Set(["the", "a", "an", "is", "in", "of", "to", "and", "or", "on", "at", "it", "for", "we", "our", "be", "with", "by", "this", "that"]);
function fakeVec(s: string) {
  const v = new Array(64).fill(0);
  for (const t of toks(s)) { if (STOP.has(t)) continue; const g = SYN.findIndex(x => x.includes(t));
    let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[g >= 0 ? g : SYN.length + (h % (64 - SYN.length))] += 1; }
  const n = Math.hypot(...v) || 1; return v.map(x => x / n);
}
export function embedderFor(env: any): Embedder | null {
  if (env?.KB_EMBED === "off") return null;
  if (env?.KB_EMBED === "fake") return { model: "fake-64", embed: async ts => ts.map(fakeVec) };
  if (env?.AI?.run) { const model = env.KB_EMBED_MODEL || "@cf/baai/bge-small-en-v1.5";
    return { model, embed: async ts => { const out: number[][] = []; for (let i = 0; i < ts.length; i += 50) out.push(...((await env.AI.run(model, { text: ts.slice(i, i + 50) })) as any).data); return out; } }; }
  return null;
}
const cos = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length && i < b.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? d / Math.sqrt(x * y) : 0; };

// ---------- the Space side: index maintenance + ops. `sp` is the Space DO (sql, need, pathOk, commit, member, env, ...). ----------
export function kbVersion(sp: any): number { return Number(sp.sql.exec("select v from meta where k='kb_version'").toArray()[0]?.v ?? 0); }
function bump(sp: any, seq: number) { if (seq > kbVersion(sp)) sp.sql.exec("insert or replace into meta values('kb_version',?)", String(seq)); }
const hashOf = async (t: string) => (await sha256(t)).slice(0, 32);
// hashes are computed before the sync transaction (sha256 is async), then passed in: path -> parsed entries with hashes
export async function prepare(path: string, content: string | null) {
  if (content === null || !isKbPath(path)) return null;
  const es = parse(path, content); return Promise.all(es.map(async e => ({ ...e, hash: await hashOf(e.text) })));
}
// Called inside commit()'s transaction for every kb/ path it changes, so the index never disagrees with the files.
// Provenance (R8): `author` is the peer that committed the entry's text and `author_kind` that peer's kind (assistant, coding_agent,
// runner, human), both taken from the authenticated actor, never from front matter (`source:` is whatever the writer claims). Text this
// commit didn't change (same hash already in this file) keeps its earlier author, so appending learnings to a context pack, or marking
// a note superseded, doesn't launder the older sections into the committer's name. Signed dispatch filters on it (client/sign.ts).
// `who` overrides the actor's name for text that is new to the index (rebuild: the path's committer from history, null when unknown).
export function reindex(sp: any, path: string, entries: (Parsed & { hash: string })[] | null, seq: number, actor: Peer, who?: { name: string | null; kind: string | null }) {
  const old = sp.sql.exec("select id, created, hash, author, author_kind from kb_entries where path=?", path).toArray() as any[];
  const created = new Map(old.map(o => [o.id, o.created])), by = new Map(old.filter(o => o.author).map(o => [o.hash, o]));
  const me = who ?? { name: actor.name, kind: actor.kind };
  for (const o of old) sp.sql.exec("delete from kb_fts where id=?", o.id);
  sp.sql.exec("delete from kb_entries where path=?", path);
  const scope = scopeOfPath(path), ts = now(), keep = new Set<string>();
  for (const e of entries ?? []) {
    const lt = e.title?.match(LEARNED_RE)?.[1] ?? null, kind = KB_KINDS.includes(e.fm.kind) ? e.fm.kind : lt ? "learned" : path.startsWith("context/") ? "memory" : "fact";
    const au = by.get(e.hash) ?? { author: me.name, author_kind: me.kind };
    sp.sql.exec("insert or replace into kb_entries values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", e.id, path, scope, kind, e.fm.key || null, e.title, e.text,
      e.fm.source || actor.name, e.fm.origin || (lt ? `task:${lt}` : path.startsWith("context/") ? "context-pack" : null), e.fm.created || created.get(e.id) || ts, ts, seq, e.fm.superseded_by || null, e.hash,
      au.author ?? null, au.author_kind ?? null);
    sp.sql.exec("insert into kb_fts(id, title, text) values(?,?,?)", e.id, e.title ?? "", e.text);
    sp.sql.exec("delete from kb_gone where id=?", e.id); keep.add(e.id);
  }
  for (const o of old) if (!keep.has(o.id)) sp.sql.exec("insert or replace into kb_gone values(?,?,?,?)", o.id, path, scope, seq);
  bump(sp, seq);
}
// After an import (or a schema change): rebuild the whole index from the kb/ files.
export async function rebuild(sp: any) {
  const rows = sp.sql.exec("select t.path, t.seq, b.content from tree t join blobs b on b.sha=t.sha where (t.path like 'kb/%' or t.path like 'context/%') and b.loc='inline' and b.enc='utf8'").toArray() as any[];
  const prepped = await Promise.all(rows.map(async r => ({ r, es: await prepare(r.path, r.content) })));
  // author from history: the one peer that ever committed this path, else unknown (null = untrusted for signed runs; a mixed file
  // can't be split back into who wrote which section). kind = that peer's member kind here, if it is still a member.
  const whoOf = (path: string) => { const a = sp.sql.exec("select distinct c.author from changes ch join commits c on c.seq=ch.seq where ch.path=? limit 2", path).toArray() as any[];
    if (a.length !== 1) return { name: null, kind: null }; const m = sp.sql.exec("select kind from members where name=? limit 1", a[0].author).toArray()[0] as any;
    return { name: String(a[0].author), kind: m?.kind ?? null }; };
  sp.ctx.storage.transactionSync(() => { for (const { r, es } of prepped) if (es) reindex(sp, r.path, es, r.seq, { id: "relay", name: "relay", kind: "system" }, whoOf(r.path)); });
  return { entries: Number(sp.sql.exec("select count(*) n from kb_entries").one().n) };
}

// Embeddings, cached by content hash: unchanged text is never embedded twice. Vectorize (KB_VECTORS) mirrors them when bound.
async function embedMissing(sp: any, hashes: { hash: string; text: string }[]) {
  const emb = embedderFor(sp.env); if (!emb || !hashes.length) return;
  const need = hashes.filter(h => !sp.sql.exec("select 1 from kb_vec where hash=? and model=?", h.hash, emb.model).toArray().length);
  const uniq = [...new Map(need.map(h => [h.hash, h])).values()]; if (!uniq.length) return;
  let vs: number[][]; try { vs = await emb.embed(uniq.map(u => u.text.slice(0, 4000))); } catch (e) { console.error("kb embed", e); return; }
  uniq.forEach((u, i) => vs[i] && sp.sql.exec("insert or replace into kb_vec values(?,?,?)", u.hash, emb.model, JSON.stringify(vs[i])));
  const vz = sp.env?.KB_VECTORS; if (vz?.upsert) await vz.upsert(uniq.map((u, i) => ({ id: u.hash, values: vs[i], namespace: nsOf(sp) }))).catch((e: any) => console.error("vectorize upsert", e));
}
const nsOf = (sp: any) => String(sp.ctx.id).slice(0, 64); // one namespace per space DO (unique across accounts)
export async function embedPending(sp: any, limit = 200) { // entries indexed by a plain write: embed lazily (search, kb_add)
  const emb = embedderFor(sp.env); if (!emb) return;
  const rows = sp.sql.exec("select distinct e.hash, e.text from kb_entries e left join kb_vec v on v.hash=e.hash and v.model=? where v.hash is null limit ?", emb.model, limit).toArray() as any[];
  await embedMissing(sp, rows);
}

// ---------- visibility ----------
function reader(sp: any, peer: Peer) { const m = sp.need(peer, "read"); return (path: string) => sp.pathOk(m, path); }
const view = (r: any, full = false) => ({ id: r.id, scope: r.scope, kind: r.kind, key: r.key ?? null, title: r.title ?? null,
  text: full || r.text.length <= 1200 ? r.text : r.text.slice(0, 1200) + "…", origin: r.origin ?? null, source: r.source, author: r.author ?? null, author_kind: r.author_kind ?? null, created: r.created, updated: r.updated,
  version: r.seq, hash: r.hash, superseded_by: r.superseded_by ?? null, path: r.path });
function scopeFilter(a: any): { sql: string; args: any[] } {
  const parts: string[] = [], args: any[] = [];
  const scopes = a.scope == null || a.scope === "all" || a.scope === "" ? null : (Array.isArray(a.scope) ? a.scope : [a.scope]).map((s: string) => scopeName(scopeDir(s)));
  if (scopes) { parts.push(`scope in (${scopes.map(() => "?").join(",")})`); args.push(...scopes); }
  const kinds = a.kinds == null ? null : (Array.isArray(a.kinds) ? a.kinds : String(a.kinds).split(",")).map((k: string) => k.trim()).filter(Boolean);
  if (kinds?.length) { const bad = kinds.filter((k: string) => !KB_KINDS.includes(k)); if (bad.length) throw new RelayError(400, `kinds: ${KB_KINDS.join(", ")}`);
    parts.push(`kind in (${kinds.map(() => "?").join(",")})`); args.push(...kinds); }
  if (a.origin != null) { parts.push("origin=?"); args.push(String(a.origin)); }
  if (a.key_prefix != null) { parts.push("substr(key,1,?)=?"); args.push(String(a.key_prefix).length, String(a.key_prefix)); }
  if (a.since != null) { parts.push("seq>?"); args.push(Number(a.since) || 0); }
  if (!a.include_superseded) parts.push("superseded_by is null");
  return { sql: parts.length ? parts.join(" and ") : "1", args };
}

// ---------- search: FTS5 (bm25) + vector cosine, fused with reciprocal rank fusion ----------
export async function search(sp: any, peer: Peer, a: any) {
  const can = reader(sp, peer), q = String(a.query ?? "").trim(); if (!q) throw new RelayError(400, "missing query");
  const k = Math.min(Math.max(Number(a.k ?? 8) || 8, 1), 50), f = scopeFilter(a), ranks = new Map<string, { s: number; m: string[] }>();
  const add = (id: string, rank: number, how: string) => { const x = ranks.get(id) ?? { s: 0, m: [] }; x.s += 1 / (60 + rank); x.m.push(how); ranks.set(id, x); };
  const words = toks(q).slice(0, 32);
  if (words.length) {
    const match = words.map(w => `"${w.replace(/"/g, "")}"`).join(" OR ");
    const rows = sp.sql.exec(`select e.id, e.path from kb_fts join kb_entries e on e.id=kb_fts.id where kb_fts match ? and ${f.sql} order by bm25(kb_fts) limit 200`, match, ...f.args).toArray() as any[];
    rows.filter(r => can(r.path)).forEach((r, i) => add(r.id, i, "keyword"));
  }
  // semantic: the server's embedder, or a query vector the caller computed with the same model the entries were embedded with
  const emb = embedderFor(sp.env); let qv: number[] | null = null, model: string | null = null;
  if (Array.isArray(a.query_vector) && a.embed_model) { qv = a.query_vector.map(Number); model = String(a.embed_model); }
  else if (emb) { await embedPending(sp); try { qv = (await emb.embed([q]))[0]; model = emb.model; } catch (e) { console.error("kb embed query", e); } }
  let semantic = false;
  if (qv && model) {
    const rows = sp.sql.exec(`select e.id, e.path, v.vec from kb_entries e join kb_vec v on v.hash=e.hash and v.model=? where ${f.sql}`, model, ...f.args).toArray() as any[];
    semantic = true;
    rows.map(r => ({ id: r.id, path: r.path, sim: cos(qv!, JSON.parse(r.vec)) })).filter(r => r.sim > 0.2 && can(r.path)).sort((x, y) => y.sim - x.sim).slice(0, 200).forEach((r, i) => add(r.id, i, "vector"));
  }
  const top = [...ranks.entries()].sort((x, y) => y[1].s - x[1].s).slice(0, k);
  const results = top.map(([id, r]) => { const row = sp.sql.exec("select * from kb_entries where id=?", id).one(); return { ...view(row), score: Number(r.s.toFixed(5)), match: r.m }; });
  return { query: q, results, semantic, ...(semantic ? { embed_model: model } : { semantic_note: "keyword-only: no embedder on this Kitebook (KB_EMBED / Workers AI binding), and no query_vector given" }), kb_version: kbVersion(sp) };
}

export async function list(sp: any, peer: Peer, a: any) {
  const can = reader(sp, peer), f = scopeFilter({ ...a, include_superseded: a.include_superseded ?? a.since != null });
  const lim = Math.min(Math.max(Number(a.limit ?? 100) || 100, 1), 1000);
  const rows = (sp.sql.exec(`select * from kb_entries where ${f.sql} order by seq, id limit ?`, ...f.args, lim + 1).toArray() as any[]);
  const more = rows.length > lim, page = rows.slice(0, lim).filter(r => can(r.path));
  const removed = a.since != null ? (sp.sql.exec("select id, path, seq from kb_gone where seq>? order by seq limit 1000", Number(a.since) || 0).toArray() as any[]).filter(r => can(r.path)).map(r => ({ id: r.id, path: r.path, version: r.seq })) : undefined;
  const v = kbVersion(sp), since = Number(a.since ?? 0) || 0;
  let last = more ? Number(rows[lim - 1].seq) - 1 : v; // a cursor never skips past a page boundary (entries of one commit share its seq)
  if (more && last <= since) last = Number(rows[lim - 1].seq); // one commit wider than a page: move on rather than loop
  return { entries: page.map(r => view(r, !!a.full)), ...(removed ? { removed } : {}), more, cursor: Math.max(since, last), kb_version: v };
}

export async function get(sp: any, peer: Peer, a: any) {
  const can = reader(sp, peer), r = sp.sql.exec("select * from kb_entries where id=?", String(a.id)).toArray()[0] as any;
  if (!r || !can(r.path)) throw new RelayError(404, "no such kb entry");
  return { ...view(r, true), sha: sp.blobAt(r.path), kb_version: kbVersion(sp) };
}

// One kb_add call = one commit. Entries with a key upsert in place (same file, newer replaces older, history keeps the old text).
export function secretIn(text: string) { return hasAssignment(text); } // client/redact.ts: the same rules the Mac redacts with
export async function add(sp: any, peer: Peer, a: any, guard: (p: string, c?: string) => void) {
  const list = Array.isArray(a.entries) ? a.entries : [a];
  if (!list.length || list.length > 200) throw new RelayError(400, "entries: 1-200");
  const changes: any[] = [], out: any[] = [], rejected: any[] = [], embeds: any[] = [], given: any[] = [], paths = new Set<string>();
  for (const [i, e] of list.entries()) try {
    const text = String(e.text ?? "").trim(); if (!text) throw new RelayError(400, `entry ${i}: missing text`);
    if (text.length > TEXT_MAX) throw new RelayError(413, `entry ${i}: text over ${TEXT_MAX} chars; split it`);
    const kind = e.kind ?? a.kind ?? "fact"; if (!KB_KINDS.includes(kind)) throw new RelayError(400, `kind must be one of ${KB_KINDS.join(", ")}`);
    const dir = scopeDir(e.scope ?? a.scope), scope = scopeName(dir), key = e.key != null ? one(e.key).slice(0, 300) : null;
    const origin = one(e.origin ?? a.origin ?? "") || null;
    if (secretIn(text)) throw new RelayError(422, `refused: entry ${i} looks like it contains a password or key`);
    let path: string, cur: any = null;
    if (key) cur = sp.sql.exec("select * from kb_entries where scope=? and key=? and id=path and path like 'kb/%' limit 1", scope, key).toArray()[0] ?? null;
    if (cur) path = cur.path;
    else if (key) path = `kb/${dir}/${(key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "k")}-${(await sha256(scope + "\n" + key)).slice(0, 10)}.md`;
    else path = `kb/${dir}/${kind}-${[...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("")}.md`;
    sp.need(peer, "write", path);
    if (paths.has(path)) throw new RelayError(400, `entry ${i}: same key twice in one call`); paths.add(path);
    const meta = { kind, key, title: e.title ?? null, origin, source: peer.name, created: cur?.created ?? now(), supersedes: e.supersedes ?? null };
    const content = fmt(meta, text); guard(path, content);
    const hash = await hashOf(text);
    if (Array.isArray(e.embedding) && (e.embed_model ?? a.embed_model)) given.push({ hash, model: String(e.embed_model ?? a.embed_model), vec: e.embedding.map(Number) });
    if (cur && cur.hash === hash && cur.kind === kind && (cur.origin ?? null) === origin && (cur.title ?? null) === (e.title ?? null) && !e.supersedes) { out.push({ id: path, key, unchanged: true }); continue; }
    changes.push({ path, content, if_match: cur ? sp.blobAt(path) ?? "none" : "none" }); embeds.push({ hash, text });
    out.push({ id: path, key, scope, kind, ...(cur ? { replaced: true } : { created: true }) });
    if (e.supersedes) { // mark the older entry (a front-matter file) as replaced by this one
      const old = sp.sql.exec("select * from kb_entries where id=? and id=path and path like 'kb/%'", String(e.supersedes)).toArray()[0] as any;
      if (!old) throw new RelayError(404, `entry ${i}: supersedes ${e.supersedes}: no such file entry`);
      sp.need(peer, "write", old.path); paths.add(old.path);
      changes.push({ path: old.path, content: fmt({ kind: old.kind, key: old.key, title: old.title, origin: old.origin, source: old.source, created: old.created, superseded_by: path }, old.text), if_match: sp.blobAt(old.path) });
    }
  } catch (err: any) {
    if (a.skip_rejected && err instanceof RelayError && [400, 413, 422].includes(err.status)) { rejected.push({ index: i, key: e.key ?? null, reason: err.message }); continue; }
    throw err;
  }
  const c = changes.length ? await sp.commit(peer, changes, a.message ?? `kb: ${changes.length} entr${changes.length === 1 ? "y" : "ies"}${a.origin ? ` from ${one(a.origin)}` : ""}`) : null;
  for (const g of given) sp.sql.exec("insert or replace into kb_vec values(?,?,?)", g.hash, g.model, JSON.stringify(g.vec));
  await embedMissing(sp, embeds);
  return { entries: out, ...(rejected.length ? { rejected } : {}), commit: c?.commit ?? null, kb_version: kbVersion(sp) };
}

// Forget = delete the entry's file (one commit; `log`/`read ref=` still has the old text). By id, ids, or scope+key(s).
export async function forget(sp: any, peer: Peer, a: any) {
  const ids: string[] = [];
  if (a.id != null) ids.push(String(a.id));
  for (const x of Array.isArray(a.ids) ? a.ids : []) ids.push(String(x));
  const keys: string[] = [...(a.key != null ? [String(a.key)] : []), ...(Array.isArray(a.keys) ? a.keys.map(String) : [])];
  if (keys.length) { const scope = scopeName(scopeDir(a.scope));
    for (const k of keys) { const r = sp.sql.exec("select id from kb_entries where scope=? and key=? and id=path", scope, k).toArray()[0] as any; if (r) ids.push(r.id); } }
  if (!ids.length && !keys.length) throw new RelayError(400, "give id, ids, or scope + key/keys");
  const changes: any[] = [], forgotten: string[] = [], missing: string[] = [];
  for (const id of [...new Set(ids)]) {
    const r = sp.sql.exec("select id, path from kb_entries where id=?", id).toArray()[0] as any;
    if (!r) { missing.push(id); continue; }
    if (!r.path.startsWith("kb/") || r.id !== r.path) throw new RelayError(409, `${id} is ${r.path.startsWith("kb/") ? "a section" : "part"} of ${r.path}; edit that file (patch) to remove it`);
    sp.need(peer, "write", r.path); changes.push({ path: r.path, delete: true }); forgotten.push(id);
  }
  const c = changes.length ? await sp.commit(peer, changes, `kb: forget ${changes.length}`) : null;
  return { forgotten, ...(missing.length ? { missing } : {}), commit: c?.commit ?? null, kb_version: kbVersion(sp) };
}

// Task integration: the top-k entries for a task's goal (global + its project), attached at create time as task.kb_context.
export async function contextFor(sp: any, peer: Peer, t: { title: string; goal: string; project?: string | null }, k: number) {
  if (!(k > 0) || !sp.sql.exec("select 1 from kb_entries limit 1").toArray().length) return [];
  const m = sp.member(peer.id); if (!m?.verbs.includes("read")) return [];
  const scope = ["global", ...(t.project && t.project !== "home" && SCOPE_RE.test(t.project) && t.project !== "global" ? [`project:${t.project}`] : [])];
  const r = await search(sp, peer, { query: `${t.title}\n${t.goal}`.slice(0, 2000), scope, k: Math.min(k + 5, 25), kinds: undefined });
  const own = t.project ? `context/${t.project}.md` : null; // delivered whole in the context pack on claim: don't repeat it
  return r.results.filter((x: any) => x.path !== own).slice(0, k).map(ctxOf);
}
// author / author_kind ride along so the runner can drop (signed auto-run) or label (approved run) notes from peers it doesn't trust
const ctxOf = (x: any) => ({ id: x.id, scope: x.scope, kind: x.kind, title: x.title, text: x.text.slice(0, 1200), updated: x.updated, origin: x.origin, author: x.author ?? null, author_kind: x.author_kind ?? null }); // 1200 = client/sign.ts KB_TEXT
// Signed dispatch: the sender picked (and signed) these entries itself (client/sign.ts pickKb), so attach exactly them, in its order,
// skipping ids that are gone or that the dispatcher can't read. The runner re-checks each one against the signed hashes anyway.
export function contextByIds(sp: any, peer: Peer, ids: any) {
  if (!Array.isArray(ids) || ids.length > 25 || ids.some(i => typeof i !== "string" || i.length > 500)) throw new RelayError(400, "kb_ids must be up to 25 kb entry ids");
  const can = reader(sp, peer), out: any[] = [];
  for (const id of new Set(ids as string[])) { const r = sp.sql.exec("select * from kb_entries where id=?", id).toArray()[0] as any; if (r && can(r.path)) out.push(ctxOf(view(r, true))); }
  return out;
}
export { globMatch };
