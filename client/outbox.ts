// Offline-first KB writes from the agent side (Pi, Codex, Claude Code on the user's machine):
//   ~/.kitebook-kb/outbox/*.json  a `kitebook kb add` that couldn't reach the server is queued here (one file per note, named so `ls` order is
//                           queue order) and sent later, in order, by the runner (every kb tick + on reconnect) or the next CLI kb call.
//   ~/.kitebook-kb/kb-inbox/*.md  any local agent can drop a markdown note here to publish it: front matter gives kind/scope/key/title/origin,
//                           the redactor + personal-info denylist apply, and the file moves to kb-inbox/sent/ once the server accepted it.
// Idempotent by a client-generated key (outbox:<uuid>, inbox:<file>:<text hash>): a replay after a lost response finds its own entry
// and sends nothing. Conflict = the server already holds that key with different text: the server wins, the note goes to conflicts/ and
// the log. A note the server refuses (denied, a secret, bad kind) goes to rejected/ with the reason, so one bad note never blocks the queue.
// Notes the runner sends are authored by the runner's peer: the same trust as its kb.sync memory files (anything that can write
// ~/.kitebook-kb can edit those too), which is why both dirs are 0700 and inbox notes carry origin kb-inbox unless front matter says otherwise.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { redact, hashOf, DEFAULT_DENY } from "./kb.ts";
import { Glob } from "bun";
type Call = (op: string, args?: any) => Promise<any>;
type Log = (...a: any[]) => void;

export const outboxDir = () => join(homedir(), ".kitebook-kb", "outbox");
export const inboxDir = () => join(homedir(), ".kitebook-kb", "kb-inbox");
const norm = (u: string) => String(u ?? "").replace(/\/+$/, "");
const mk = (d: string) => { mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
// "the server isn't there" (queue and retry) vs "the server said no" (a real error: never queued, never retried)
export const isOffline = (e: any) => /can't reach the server|answered HTTP (5\d\d|0)\b|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Unable to connect|fetch failed|socket connection was closed|timed? ?out|aborted|JSON Parse error|is not valid JSON|Unexpected token/i.test(String(e?.message ?? e));

export type Note = { text: string; kind?: string; scope?: string; key?: string; origin?: string; title?: string };
export function enqueue(n: Note, url: string, space?: string) {
  const id = crypto.randomUUID(), at = new Date().toISOString(), dir = mk(outboxDir());
  const item = { id, queued_at: at, url: norm(url), space: space ?? null, entry: { ...n, text: String(n.text ?? "").trim(), key: n.key ?? `outbox:${id}` } };
  const f = join(dir, `${String(Date.now()).padStart(15, "0")}-${id}.json`);
  writeFileSync(f + ".tmp", JSON.stringify(item, null, 1), { mode: 0o600 }); renameSync(f + ".tmp", f); // never a half-written note
  return { queued: true, id, key: item.entry.key, file: f, note: `the server at ${item.url} isn't reachable; the note is queued and is sent when it is (the runner retries every kb tick, or run: kitebook kb flush)` };
}
const queued = () => existsSync(outboxDir()) ? readdirSync(outboxDir()).filter(n => n.endsWith(".json")).sort() : [];
export function depth() {
  const n = (d: string, re: RegExp) => { try { return readdirSync(d).filter(x => re.test(x)).length; } catch { return 0; } };
  const q = queued(); let oldest: string | null = null; try { if (q.length) oldest = JSON.parse(readFileSync(join(outboxDir(), q[0]), "utf8")).queued_at ?? null; } catch {}
  return { outbox: q.length, oldest, conflicts: n(join(outboxDir(), "conflicts"), /\.json$/) + n(join(inboxDir(), "conflicts"), /\.md$/),
    rejected: n(join(outboxDir(), "rejected"), /\.json$/) + n(join(inboxDir(), "rejected"), /\.md$/), inbox: n(inboxDir(), /\.(md|markdown)$/i) };
}
const park = (f: string, sub: string, why?: string) => { const d = mk(join(f.slice(0, f.lastIndexOf("/")), sub)); let to = join(d, basename(f));
  if (existsSync(to)) to = join(d, `${Date.now()}-${basename(f)}`); renameSync(f, to); if (why) writeFileSync(to + ".why", why + "\n"); return to; };

// One note, idempotently: already there with the same text -> nothing to do; there with other text -> the server wins; else kb_add.
async function sendOne(call: Call, e: Note, message: string): Promise<{ state: "sent" | "duplicate" | "conflict"; id?: string; theirs?: string }> {
  const scope = e.scope ?? "global", text = String(e.text).trim();
  const r = await call("kb_list", { scope, key_prefix: e.key, limit: 100, include_superseded: true }), have = r.entries.find((x: any) => x.key === e.key);
  if (have) return have.hash === hashOf(text) ? { state: "duplicate", id: have.id } : { state: "conflict", id: have.id, theirs: have.hash };
  const a = await call("kb_add", { text, kind: e.kind, scope: e.scope, key: e.key, origin: e.origin, title: e.title, message });
  return { state: "sent", id: a.entries?.[0]?.id };
}

// Drain the outbox for this Kitebook (other Kitebook servers' notes wait for their own client), oldest first. Stops at the first offline error so
// order holds; a refused note is set aside and the rest go on.
export async function drainOutbox(call: Call, url: string, space: string | undefined, log: Log = () => {}) {
  const out = { sent: 0, duplicate: 0, conflict: 0, rejected: 0, left: 0, offline: false };
  const files = queued();
  for (const [i, n] of files.entries()) {
    const f = join(outboxDir(), n); let item: any;
    try { item = JSON.parse(readFileSync(f, "utf8")); } catch { park(f, "rejected", "unreadable JSON"); out.rejected++; log("kb outbox: unreadable note set aside", n); continue; }
    if (norm(item.url) !== norm(url) || (item.space && space && item.space !== space)) { out.left++; continue; }
    try {
      const r = await sendOne(call, item.entry, `kb outbox: ${item.entry.key} (queued ${item.queued_at})`); out[r.state]++;
      if (r.state === "conflict") { park(f, "conflicts", `server already holds ${item.entry.key} with other text (${r.id}); the server wins`); log("kb outbox conflict:", item.entry.key, "->", r.id, "already holds other text; the server wins (kept in", join(outboxDir(), "conflicts") + ")"); }
      else rmSync(f, { force: true });
    } catch (err: any) {
      if (isOffline(err)) { out.offline = true; out.left += files.length - i; break; }
      park(f, "rejected", err.message); out.rejected++; log("kb outbox: refused", item.entry.key, "-", err.message);
    }
  }
  if (out.sent || out.duplicate || out.conflict || out.rejected) log(`kb outbox: ${out.sent} sent, ${out.duplicate} already there, ${out.conflict} conflict(s), ${out.rejected} refused, ${out.left} left`);
  return out;
}

// Front matter: `key: value` lines between --- fences (only the fields a note needs; anything else is ignored).
export function parseNote(raw: string): { fm: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/); if (!m) return { fm: {}, body: raw };
  const fm: Record<string, string> = {};
  for (const l of m[1].split(/\r?\n/)) { const kv = l.match(/^\s*([A-Za-z_]+)\s*:\s*(.*?)\s*$/); if (kv) fm[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, ""); }
  return { fm, body: m[2] };
}
const denied = (name: string) => DEFAULT_DENY.some(g => new Glob(g).match(name) || (g.startsWith("**/") && new Glob(g.slice(3)).match(name)));

// Publish every markdown file in the inbox, oldest first. Stays put while offline (the file is the queue).
export async function publishInbox(call: Call, log: Log = () => {}) {
  const dir = inboxDir(), out = { sent: 0, duplicate: 0, conflict: 0, rejected: 0, offline: false };
  if (!existsSync(dir)) return out;
  const files = readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && /\.(md|markdown)$/i.test(d.name)).map(d => d.name)
    .sort((a, b) => statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs || a.localeCompare(b));
  for (const n of files) {
    const f = join(dir, n);
    if (denied(n)) { park(f, "rejected", "personal-info denylist (USER.md, *personal*, *address*, ...): not published"); out.rejected++; log("kb inbox: denylisted, not published:", n); continue; }
    let raw: string; try { const b = readFileSync(f); if (b.length > 2_000_000 || b.includes(0)) throw new Error("not a text note"); raw = b.toString("utf8"); } catch (e: any) { park(f, "rejected", e.message); out.rejected++; continue; }
    const { fm, body } = parseNote(raw), text = redact(body).trim();
    if (!text) { park(f, "rejected", "empty note"); out.rejected++; continue; }
    const e: Note = { text, kind: fm.kind || "fact", scope: fm.scope || undefined, title: fm.title || undefined, origin: fm.origin || "kb-inbox",
      key: fm.key || `inbox:${n.replace(/\.(md|markdown)$/i, "")}:${hashOf(text).slice(0, 12)}` };
    try {
      const r = await sendOne(call, e, `kb inbox: ${n}`); out[r.state]++;
      if (r.state === "conflict") { park(f, "conflicts", `server already holds ${e.key} with other text (${r.id}); the server wins`); log("kb inbox conflict:", n, "key", e.key, "already holds other text; the server wins"); }
      else { park(f, "sent"); log(`kb inbox: ${n} -> ${r.id}${r.state === "duplicate" ? " (already there)" : ""}${text !== body.trim() ? " (secrets redacted)" : ""}`); }
    } catch (err: any) {
      if (isOffline(err)) { out.offline = true; break; }
      park(f, "rejected", err.message); out.rejected++; log("kb inbox: refused", n, "-", err.message);
    }
  }
  return out;
}
